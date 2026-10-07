/**
 * Host half of the HelloAI skills manager.
 *
 * Responsibilities:
 *  - scan every local agent skill root (`$DSH_HOME/skills`, `~/.codex/skills`,
 *    `~/.trae-cn/skills`, …) and publish **all** of them through `ctx.skills`,
 *    so `/skill-name` and the model catalog work for every skill this plugin
 *    lists; the host loader does not register `$DSH_HOME/skills` in every
 *    profile, so that root is registered here as well instead of being assumed
 *    to be available already
 *  - keep a list of remote skill *repositories* and turn each one into an
 *    installable catalog (`SKILL.md` folders discovered in the repository)
 *  - download a catalog entry into a local skill root
 *
 * Everything is dependency free: the catalog is discovered over plain HTTPS
 * requests to GitHub (and jsDelivr as a fallback), so the plugin works in the
 * DSH host process without extra runtime packages.
 */
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

export const name = "helloai-skills";
export const inject = ["webServer", "skills"];
const base = () => process.env.DSH_HOME || join(homedir(), ".dsh");
const store = () => join(base(), "helloai-skills");
const repoFile = () => join(store(), "repositories.json");
const noteFile = () => join(store(), "notes.json");
const policyFile = () => join(store(), "policy.json");
const cacheRoot = () => join(store(), "cache");

/** Name of the skill provider this plugin registers on `ctx.skills`. */
const PROVIDER_NAME = "helloai-skills";

/**
 * 这份宿主代码的标记。宿主半边在 DSH 主进程里 import 一次后常驻，所以「改完代码
 * 到底有没有生效」只能靠落盘留痕来判断：每次 apply 往 `apply.log` 追加一行。
 */
const BUILD_TAG = "1.3.0-repo-presets";

type Root = { id: string; label: string; path: string; tone: string; rank: number; native: boolean; mutable: boolean };

/**
 * `native` now only describes the origin of a root for the settings UI: it no
 * longer excludes a root from the skill provider. Every root below is published
 * through the provider, which is what makes e.g. a CODEX skill callable as
 * `/gotoweb` — and what makes `$DSH_HOME/skills` callable as `/dengmi` in
 * profiles where the host loader registers nothing for that directory.
 */
const STATIC_ROOTS: Array<Omit<Root, "path"> & { dir: string[]; env?: string }> = [
  { id: "dsh", label: "DSH", dir: [], tone: "#7c9cff", rank: 400, native: true, mutable: true },
  { id: "agents", label: "公共 Agent", dir: [".agents"], env: "DSH_AGENTS_HOME", tone: "#8ab4f8", rank: 500, native: true, mutable: false },
  { id: "codex", label: "CODEX", dir: [".codex"], env: "DSH_CODEX_HOME", tone: "#4fd1a1", rank: 700, native: false, mutable: false },
  { id: "claude", label: "Claude", dir: [".claude"], env: "DSH_CLAUDE_HOME", tone: "#efaa63", rank: 710, native: false, mutable: false },
  { id: "gemini", label: "Gemini", dir: [".gemini"], env: "DSH_GEMINI_HOME", tone: "#a78bfa", rank: 720, native: false, mutable: false },
  { id: "opencode", label: "OpenCode", dir: [".config", "opencode"], env: "DSH_OPENCODE_HOME", tone: "#f472b6", rank: 730, native: false, mutable: false },
  { id: "cursor", label: "Cursor", dir: [".cursor"], env: "DSH_CURSOR_HOME", tone: "#60a5fa", rank: 740, native: false, mutable: false },
  { id: "copilot", label: "Copilot", dir: [".copilot"], env: "DSH_COPILOT_HOME", tone: "#93c5fd", rank: 750, native: false, mutable: false },
  { id: "windsurf", label: "Windsurf", dir: [".codeium", "windsurf"], env: "DSH_WINDSURF_HOME", tone: "#34d399", rank: 760, native: false, mutable: false },
  { id: "trae", label: "Trae", dir: [".trae"], env: "DSH_TRAE_HOME", tone: "#9c8cff", rank: 770, native: false, mutable: false },
  { id: "trae-cn", label: "Trae CN", dir: [".trae-cn"], env: "DSH_TRAE_CN_HOME", tone: "#a5b4fc", rank: 780, native: false, mutable: false },
  { id: "qoder", label: "Qoder", dir: [".qoder"], env: "DSH_QODER_HOME", tone: "#55b9ed", rank: 790, native: false, mutable: false },
  { id: "openclaw", label: "OpenClaw", dir: [".openclaw"], env: "DSH_OPENCLAW_HOME", tone: "#f0abfc", rank: 800, native: false, mutable: false },
  { id: "clawdbot", label: "OpenClaw 旧目录", dir: [".clawdbot"], env: "DSH_CLAWDBOT_HOME", tone: "#e879f9", rank: 810, native: false, mutable: false },
  { id: "roo", label: "Roo", dir: [".roo"], env: "DSH_ROO_HOME", tone: "#fbbf24", rank: 820, native: false, mutable: false },
  { id: "codebuddy", label: "CodeBuddy", dir: [".codebuddy"], env: "DSH_CODEBUDDY_HOME", tone: "#22d3ee", rank: 830, native: false, mutable: false },
  { id: "cc-switch", label: "CC Switch", dir: [".cc-switch"], tone: "#ed6f91", rank: 840, native: false, mutable: false }
];

/** Root directories relative to the home directory, for roots without an env override. */
function staticRootHome(root: (typeof STATIC_ROOTS)[number]) {
  if (root.env && process.env[root.env]) return process.env[root.env] as string;
  if (root.id === "dsh") return base();
  return join(homedir(), ...root.dir);
}

function knownRoots(): Root[] {
  return STATIC_ROOTS.map((root) => ({ id: root.id, label: root.label, tone: root.tone, rank: root.rank, native: root.native, mutable: root.mutable, path: join(staticRootHome(root), "skills") }));
}

const AUTO_TONES = ["#f59e0b", "#10b981", "#6366f1", "#ec4899", "#14b8a6", "#8b5cf6"];

/**
 * Roots that are not in the static list but obviously hold skills:
 * `<home>/<tool>/skills`, and Qoder's plugin cache layout. Only roots with at
 * least one skill are added, so empty directories never show up in the UI.
 */
let discovered: { at: number; roots: Root[] } = { at: 0, roots: [] };
async function discoveredRoots(): Promise<Root[]> {
  if (Date.now() - discovered.at < 30_000) return discovered.roots;
  const known = new Set(knownRoots().map((root) => resolve(root.path).toLowerCase()));
  const found: Root[] = [];
  const push = (id: string, label: string, path: string, tone: string) => {
    const key = resolve(path).toLowerCase();
    if (known.has(key) || found.some((root) => resolve(root.path).toLowerCase() === key)) return;
    found.push({ id, label, path, tone, rank: 900 + found.length * 10, native: false, mutable: false });
  };
  try {
    for (const entry of await readdir(homedir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink?.()) continue;
      const path = join(homedir(), entry.name, "skills");
      if (await hasSkills(path)) push(`auto-${slugSegment(entry.name)}`, entry.name.replace(/^\./, ""), path, AUTO_TONES[found.length % AUTO_TONES.length]);
    }
  } catch { /* an unreadable home directory simply yields no extra roots */ }
  try {
    const cache = join(homedir(), ".qoder", "plugins", "cache");
    for (const vendor of await readdir(cache, { withFileTypes: true })) {
      if (!vendor.isDirectory()) continue;
      for (const plugin of await readdir(join(cache, vendor.name), { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        const path = join(cache, vendor.name, plugin.name, "skills");
        if (await hasSkills(path)) push(`qoder-${slugSegment(plugin.name)}`, `Qoder · ${plugin.name}`, path, AUTO_TONES[found.length % AUTO_TONES.length]);
      }
    }
  } catch { /* Qoder is optional */ }
  discovered = { at: Date.now(), roots: found };
  return found;
}

async function allRoots(): Promise<Root[]> { return [...knownRoots(), ...(await discoveredRoots())]; }
async function hasSkills(path: string) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) { if (await exists(join(path, entry.name, "SKILL.md"))) return true; }
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) return true;
    }
  } catch { /* missing root */ }
  return false;
}
async function exists(path: string) { return Boolean(await stat(path).catch(() => null)); }

/** 目录缓存不再按时间过期：只有显式「刷新」才会回源。 */
const MAX_SKILLS = 400;
const MAX_FILES_PER_SKILL = 400;
const MAX_DESCRIPTIONS = 200;
const DESCRIPTION_BUDGET = 60_000;
const DESCRIPTION_WORKERS = 10;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_SKILL_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 6;
const USER_AGENT = "dsh-helloai-skills/0.3 (+https://github.com/hello-heyongping)";

async function jsonFile(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } }
async function save(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2), "utf8"); }

function stripBom(text: string) { return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; }
function decodeScalar(raw: string) {
  const value = String(raw ?? "").trim();
  if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) return value.slice(1, -1);
  return value;
}
/**
 * Parse `SKILL.md` frontmatter (including `>` / `|` block scalars), borrowing the
 * shape DSH's own filesystem provider accepts: `name` + `description`.
 */
function parseSkillDoc(text: string) {
  const source = stripBom(String(text ?? ""));
  const lines = source.split(/\r?\n/);
  const map: Record<string, string> = {};
  let body = source;
  if (lines.length && lines[0].trim() === "---") {
    let end = -1;
    for (let index = 1; index < lines.length; index += 1) if (lines[index].trim() === "---") { end = index; break; }
    if (end > 0) {
      for (let index = 1; index < end; index += 1) {
        const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[index]);
        if (!match) continue;
        const block = /^([>|])[-+]?\s*$/.exec(match[2].trim());
        if (block) {
          const collected: string[] = [];
          while (index + 1 < end && (/^\s/.test(lines[index + 1]) || lines[index + 1].trim() === "")) { index += 1; collected.push(lines[index]); }
          const indents = collected.filter((line) => line.trim() !== "").map((line) => (/^\s*/.exec(line) || [""])[0].length);
          const indent = indents.length ? Math.min(...indents) : 0;
          const normalized = collected.map((line) => line.slice(Math.min(indent, line.length)));
          map[match[1]] = block[1] === ">" ? normalized.join(" ").replace(/\s+/g, " ").trim() : normalized.join("\n").trim();
        } else map[match[1]] = decodeScalar(match[2]);
      }
      body = lines.slice(end + 1).join("\n");
    }
  }
  return { map, body };
}
/** DSH skill names are kebab-case; `TRAE-computer-use` and `web_search` both fold cleanly. */
function toKebab(value: unknown) {
  let text = String(value ?? "").trim();
  if (!text) return "";
  text = text.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  text = text.replace(/[\s_.]+/g, "-").replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(text) ? text.slice(0, 64).replace(/-+$/, "") : "";
}
function slugSegment(value: string) { return toKebab(value) || "root"; }
function firstMeaningfulLine(body: string) {
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const text = line.replace(/^#+\s*/, "").trim();
    if (text && !text.startsWith("<!--")) return text.slice(0, 200);
  }
  return "";
}
function skillDoc(text) {
  const { map, body } = parseSkillDoc(text);
  return {
    title: map.name || "",
    description: map.description || map.summary || "",
    whenToUse: map.whenToUse || map.when_to_use || "",
    body: body.trim(),
    hasFrontmatter: Object.keys(map).length > 0
  };
}

type ScannedSkill = {
  id: string; name: string; slug: string; description: string; whenToUse: string;
  path: string; docPath: string; root: string; source: string; tone: string;
  native: boolean; mutable: boolean; enabled: boolean; content: string;
};

async function scanRoot(root: Root): Promise<ScannedSkill[]> {
  let entries; try { entries = await readdir(root.path, { withFileTypes: true }); } catch { return []; }
  const notes = await jsonFile(noteFile(), {});
  const policy = await jsonFile(policyFile(), {});
  const result: ScannedSkill[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    let docPath = "";
    let directory = "";
    if (entry.isDirectory()) { directory = join(root.path, entry.name); docPath = join(directory, "SKILL.md"); }
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) docPath = join(root.path, entry.name);
    else continue;
    let text; try { text = await readFile(docPath, "utf8"); } catch { continue; }
    const doc = skillDoc(text);
    // A bare `.md` file only counts as a skill when it declares itself as one.
    if (!directory && !doc.hasFrontmatter) continue;
    const name = doc.title || entry.name.replace(/\.md$/i, "");
    const slug = toKebab(name) || toKebab(entry.name.replace(/\.md$/i, ""));
    if (!slug) continue;
    const id = `${root.id}:${entry.name}`;
    result.push({
      id,
      name,
      slug,
      description: notes[id] || doc.description || firstMeaningfulLine(doc.body) || `来自 ${root.label} 的技能`,
      whenToUse: doc.whenToUse,
      path: directory || docPath,
      docPath,
      root: root.id,
      source: root.label,
      tone: root.tone,
      native: root.native,
      mutable: root.mutable,
      enabled: policy[id] !== false,
      content: doc.body || text.trim()
    });
  }
  return result;
}

async function scanAll() {
  const roots = await allRoots();
  const groups = [];
  for (const root of roots) groups.push({ ...root, skills: await scanRoot(root) });
  return { roots, groups, skills: groups.flatMap((group) => group.skills) };
}

async function snapshot() {
  const { groups, skills } = await scanAll();
  return {
    /** 宿主能力位：老版本宿主没有上传导入接口，前端据此收起「浏览文件夹 / 选择 ZIP」。 */
    capabilities: { uploadImport: true },
    skills: skills.map((skill) => ({
      id: skill.id, name: skill.name, slug: skill.slug, root: skill.root, source: skill.source,
      path: skill.path, description: skill.description, enabled: skill.enabled,
      callable: true, native: skill.native, mutable: skill.mutable
    })),
    groups: groups.map((group) => ({
      id: group.id, label: group.label, path: group.path, tone: group.tone,
      native: group.native, mutable: group.mutable, callable: true, count: group.skills.length,
      skills: group.skills.map((skill) => ({
        id: skill.id, name: skill.name, slug: skill.slug, root: skill.root, source: skill.source,
        path: skill.path, description: skill.description, enabled: skill.enabled,
        callable: true, native: skill.native, mutable: skill.mutable
      }))
    }))
  };
}

/* ------------------------------------------------------------ skill provider */

let scanCache: { at: number; value: Awaited<ReturnType<typeof scanAll>> | null } = { at: 0, value: null };
async function cachedScan(maxAge = 1500) {
  if (scanCache.value && Date.now() - scanCache.at < maxAge) return scanCache.value;
  const value = await scanAll();
  scanCache = { at: Date.now(), value };
  return value;
}

/**
 * Publish every enabled skill of every scanned root through `ctx.skills`, so
 * skills from CODEX, Trae, Qoder … *and* from `$DSH_HOME/skills` behave like DSH
 * skills: they appear in the model catalog and can be invoked as `/<name>`.
 *
 * `native` is deliberately not filtered here: when the host loader also reads a
 * root, the two registrations describe the same `SKILL.md`, and the registry's
 * own rank rules pick the winner — a duplicate is harmless, a missing root is
 * the bug this provider exists to prevent.
 */
function externalSkillProvider(control) {
  return {
    name: PROVIDER_NAME,
    async list() {
      try {
        const { roots, skills } = await cachedScan();
        const rankByRoot = new Map(roots.map((root) => [root.id, root.rank]));
        const seen = new Set();
        const candidates = [];
        for (const skill of skills) {
          if (!skill.enabled || seen.has(skill.slug)) continue;
          seen.add(skill.slug);
          candidates.push({
            name: skill.slug,
            description: skill.description,
            ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
            invocation: { modelInvocable: true, userInvocable: true },
            provider: PROVIDER_NAME,
            source: `agent-${skill.root}`,
            rank: rankByRoot.get(skill.root) ?? 900,
            locator: { root: skill.root, entry: skill.id.slice(skill.root.length + 1), docPath: skill.docPath, displayName: skill.name },
            resourceBase: { kind: "directory", path: skill.path },
            path: skill.docPath,
            metadata: { helloai: { root: skill.root, source: skill.source, name: skill.name } }
          });
        }
        return candidates;
      } catch {
        // A single unreadable root must not take the whole catalog down.
        return [];
      }
    },
    async get(candidate) {
      const locator = candidate?.locator;
      if (!locator?.docPath) return undefined;
      let text; try { text = await readFile(locator.docPath, "utf8"); } catch { return undefined; }
      const doc = skillDoc(text);
      // 列表里的 slug 既可能来自 frontmatter 的 name，也可能来自文件夹名
      // （name 转不成 kebab 时，例如中文名）。两者都接受，避免「列表里看得到、
      // 调用时找不到」；只有一个都转不出来时才不校验。
      const accepted = [toKebab(doc.title), toKebab(locator.displayName), toKebab(locator.entry)].filter(Boolean);
      if (accepted.length && !accepted.includes(candidate.name)) return undefined;
      return {
        name: candidate.name,
        description: doc.description || firstMeaningfulLine(doc.body) || candidate.description,
        ...(doc.whenToUse ? { whenToUse: doc.whenToUse } : {}),
        invocation: candidate.invocation,
        provider: PROVIDER_NAME,
        source: candidate.source,
        resourceBase: candidate.resourceBase,
        path: locator.docPath,
        metadata: candidate.metadata,
        content: doc.body || text.trim()
      };
    }
  };
}

/** Invalidate the skill catalog and refresh the chat command list / preset catalog. */
function notifySkillsChanged(ctx, invalidate) {
  try { invalidate?.(); } catch { /* a disposed provider simply has nothing to invalidate */ }
  try { ctx.emit?.("commands/change"); } catch { /* the command surface is optional */ }
  try {
    const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
    for (const session of sessions?.list?.() ?? []) {
      const id = session?.id ?? session?.header?.id;
      const preset = typeof session?.header?.agentPreset === "string" ? session.header.agentPreset : "";
      if (id == null || !preset) continue;
      ctx.emit?.("agent-preset/selected", id, preset);
    }
  } catch { /* sessions may not be mounted */ }
}

/* ------------------------------------------------------------------ remote */

type GitHubSource = { kind: "github"; owner: string; repo: string; ref: string; subpath: string };

/** Parse `https://github.com/<owner>/<repo>[/tree/<ref>[/<subpath>]]`. */
function parseGitHubSource(value): GitHubSource | null {
  let url; try { url = new URL(String(value ?? "").trim()); } catch { return null; }
  if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  let ref = ""; let subpath = "";
  if (parts[2] === "tree" || parts[2] === "blob") { ref = parts[3] || ""; subpath = parts.slice(4).join("/"); }
  return { kind: "github", owner, repo: repo.replace(/\.git$/i, ""), ref, subpath };
}

function githubToken() { return process.env.DSH_HELLOAI_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ""; }

function sleep(ms) { return new Promise((done) => setTimeout(done, ms)); }

async function httpGet(url: string, options: { as?: "text" | "json" | "buffer"; timeout?: number; accept?: string; attempts?: number } = {}) {
  const { as = "text", timeout = 25_000, accept = "*/*", attempts = 4 } = options;
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept };
  if (githubToken() && /(^|\.)(github\.com|githubusercontent\.com)$/i.test(new URL(url).hostname)) headers.authorization = `Bearer ${githubToken()}`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeout), headers });
      if (!response.ok) {
        const error = new Error(`请求失败（HTTP ${response.status}）· ${new URL(url).host}`) as Error & { status?: number };
        error.status = response.status;
        if (response.status < 500 && response.status !== 429) throw error;
        lastError = error;
      } else {
        if (as === "json") return await response.json();
        if (as === "buffer") return Buffer.from(await response.arrayBuffer());
        return await response.text();
      }
    } catch (error) {
      lastError = error;
      if (typeof error?.status === "number" && error.status < 500 && error.status !== 429) throw error;
    }
    if (attempt < attempts) await sleep(600 * attempt);
  }
  throw lastError ?? new Error(`请求失败 · ${url}`);
}

function embeddedJson(html: string) {
  const match = html.match(/<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

/** Resolve the concrete commit for a repository so every later request is immutable. */
async function resolveGitHubRef(source: GitHubSource) {
  const candidates = [...new Set([source.ref, "main", "master"].filter(Boolean))];
  let lastError;
  for (const candidate of candidates) {
    const encoded = candidate.split("/").map(encodeURIComponent).join("/");
    try {
      const html = await httpGet(`https://github.com/${source.owner}/${source.repo}/tree/${encoded}`, { accept: "text/html", timeout: 20_000 });
      const payload = embeddedJson(html)?.payload;
      const info = payload?.codeViewTreeRoute?.refInfo || payload?.refInfo;
      if (info?.currentOid) return { ref: info.name || candidate, oid: info.currentOid };
      lastError = new Error("无法解析仓库引用信息");
    } catch (error) { lastError = error; }
    try {
      const atom = await httpGet(`https://github.com/${source.owner}/${source.repo}/commits/${encoded}.atom`, { accept: "application/atom+xml", timeout: 20_000 });
      const oid = atom.match(/Grit::Commit\/([0-9a-f]{7,40})/i)?.[1];
      if (oid) return { ref: candidate, oid };
    } catch (error) { lastError = error; }
    try {
      const api = await httpGet(`https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encoded}`, { as: "json", accept: "application/vnd.github+json", timeout: 20_000, attempts: 2 }) as { sha?: string };
      if (api?.sha) return { ref: candidate, oid: api.sha };
    } catch (error) { lastError = error; }
  }
  throw new Error(`无法读取仓库 ${source.owner}/${source.repo}：${String(lastError?.message || lastError)}`);
}

/**
 * Full recursive file list of a repository.
 *
 * `tree-list` is the endpoint GitHub's own file finder uses: one request, no API
 * rate limit, works for repositories that are too large for jsDelivr. The API
 * and jsDelivr are kept as fallbacks for restricted networks.
 */
async function listGitHubPaths(source: GitHubSource, oid: string, ref: string) {
  const attempts = [
    { strategy: "tree-list", run: async () => ((await httpGet(`https://github.com/${source.owner}/${source.repo}/tree-list/${oid}`, { as: "json", accept: "application/json" })) as { paths?: string[] })?.paths || [] },
    { strategy: "github-api", run: async () => (((await httpGet(`https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(oid || ref)}?recursive=1`, { as: "json", accept: "application/vnd.github+json" })) as { tree?: Array<{ type: string; path: string }> })?.tree || []).filter((item) => item.type === "blob").map((item) => item.path) },
    { strategy: "jsdelivr", run: async () => (((await httpGet(`https://data.jsdelivr.com/v1/packages/gh/${source.owner}/${source.repo}@${encodeURIComponent(oid || ref)}?structure=flat`, { as: "json", accept: "application/json" })) as { files?: Array<{ name: string }> })?.files || []).map((file) => file.name.replace(/^\//, "")) }
  ];
  let lastError;
  for (const attempt of attempts) {
    try {
      const paths = (await attempt.run()).filter((path) => typeof path === "string" && path);
      if (paths.length) return { paths, strategy: attempt.strategy };
      lastError = new Error("仓库文件列表为空");
    } catch (error) { lastError = error; }
  }
  throw new Error(`无法列出仓库文件：${String(lastError?.message || lastError)}`);
}

function encodeRepoPath(path: string) { return String(path).split("/").map(encodeURIComponent).join("/"); }

async function downloadRepoFile(source: GitHubSource, oid: string, ref: string, path: string) {
  const revision = oid || ref;
  const urls = [
    `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodeURIComponent(revision)}/${encodeRepoPath(path)}`,
    `https://cdn.jsdelivr.net/gh/${source.owner}/${source.repo}@${revision}/${encodeRepoPath(path)}`
  ];
  let lastError;
  for (const url of urls) {
    try { return (await httpGet(url, { as: "buffer", timeout: 30_000, attempts: 2 })) as Buffer; } catch (error) { lastError = error; }
  }
  throw new Error(`下载 ${path} 失败：${String(lastError?.message || lastError)}`);
}

/* ----------------------------------------------------------------- catalog */

type CatalogSkill = { name: string; folder: string; path: string; description: string; files: string[]; size: number };

/** Turn a repository path list into installable skills (every folder with a `SKILL.md`). */
function catalogFromPaths(paths: string[], repoName: string, subpath: string): { skills: CatalogSkill[]; truncated: boolean } {
  const scoped = subpath ? paths.filter((path) => path === subpath || path.startsWith(`${subpath}/`)) : paths;
  const clean = scoped.filter((path) => path && !/(^|\/)__MACOSX(\/|$)/.test(path) && !/(^|\/)\.DS_Store$/.test(path));
  const prefixes = new Set<string>();
  for (const path of clean) if (/(^|\/)SKILL\.md$/i.test(path)) prefixes.add(path.replace(/\/?SKILL\.md$/i, ""));
  const directories = [...prefixes].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  const truncated = directories.length > MAX_SKILLS;
  const skills: CatalogSkill[] = [];
  for (const directory of directories.slice(0, MAX_SKILLS)) {
    const files = clean.filter((path) => (directory ? path.startsWith(`${directory}/`) : true));
    if (!files.length || files.length > MAX_FILES_PER_SKILL) continue;
    const relative = directory ? files.map((path) => path.slice(directory.length + 1)) : files;
    if (relative.some((path) => !path || path.startsWith("..") || path.includes("\\"))) continue;
    skills.push({
      name: directory ? directory.split("/").pop() || repoName : repoName,
      folder: "",
      path: directory,
      description: "",
      files: relative,
      size: 0
    });
  }
  // Keep install folder names unique; nested catalogs often repeat a folder name.
  const used = new Set<string>();
  for (const skill of skills) {
    const segments = skill.path.split("/").filter(Boolean);
    const candidates = [...new Set([skill.name, segments.slice(-2).join("-"), segments.join("-")].filter(Boolean))];
    let folder = candidates.map(safeFolderName).find((candidate) => candidate && !used.has(candidate.toLowerCase())) || "";
    if (!folder) {
      const stem = safeFolderName(skill.name) || safeFolderName(segments.join("-")) || "skill";
      let suffix = 2;
      while (used.has(`${stem}-${suffix}`.toLowerCase())) suffix += 1;
      folder = `${stem}-${suffix}`;
    }
    used.add(folder.toLowerCase());
    skill.folder = folder;
  }
  return { skills, truncated };
}

/** SKILL.md frontmatter gives the catalog its descriptions; filled within a time budget. */
async function fillDescriptions(source: GitHubSource, oid: string, ref: string, skills: CatalogSkill[], onProgress?: () => Promise<void> | void) {
  const pending = skills.filter((skill) => !skill.description).slice(0, MAX_DESCRIPTIONS);
  const started = Date.now();
  let index = 0;
  let lastReport = Date.now();
  const worker = async () => {
    while (index < pending.length) {
      if (Date.now() - started > DESCRIPTION_BUDGET) return;
      const skill = pending[index];
      index += 1;
      try {
        const text = (await downloadRepoFile(source, oid, ref, skill.path ? `${skill.path}/SKILL.md` : "SKILL.md")).toString("utf8");
        skill.description = skillDoc(text).description;
      } catch { /* a missing or unreadable SKILL.md is not fatal */ }
      // 边抓边落盘：前端每 3 秒就能看到新补上的说明，而不是等整轮跑完。
      if (onProgress && Date.now() - lastReport > 1500) {
        lastReport = Date.now();
        await onProgress();
      }
    }
  };
  await Promise.all(Array.from({ length: DESCRIPTION_WORKERS }, worker));
  return skills;
}

function catalogCacheFile(repoId: string) { return join(cacheRoot(), `catalog-${String(repoId).replace(/[^a-zA-Z0-9._-]/g, "")}.json`); }

/**
 * Descriptions cost one request per skill, which can take a minute through a
 * slow proxy. They therefore never block the answer: the catalog is returned as
 * soon as the repository file list is known, and the missing descriptions are
 * filled in the background and merged back into the cache file.
 */
const descriptionJobs = new Map<string, Promise<void>>();

function pendingDescriptions(record) { return (record?.skills ?? []).filter((skill) => !skill.description).length; }

function startDescriptionFill(repo, record: { oid: string; ref: string; skills: CatalogSkill[] }) {
  if (descriptionJobs.has(repo.id)) return;
  const job = (async () => {
    const source = parseGitHubSource(repo.url);
    if (!source) return;
    // Re-read before writing: a refresh may have replaced the catalog meanwhile.
    const persist = async (final: boolean) => {
      const current = await jsonFile(catalogCacheFile(repo.id), null);
      if (!current || current.oid !== record.oid || current.url !== repo.url) return;
      const filled = new Map(record.skills.map((skill) => [skill.path, skill.description]));
      current.skills = current.skills.map((skill) => ({ ...skill, description: skill.description || filled.get(skill.path) || "" }));
      current.pending = pendingDescriptions(current);
      current.filled = final;
      current.filledAt = new Date().toISOString();
      await save(catalogCacheFile(repo.id), current);
    };
    await fillDescriptions(source, record.oid, record.ref, record.skills, () => persist(false));
    await persist(true);
  })().catch(() => undefined).finally(() => descriptionJobs.delete(repo.id));
  descriptionJobs.set(repo.id, job);
}

/**
 * 本地优先：仓库一旦添加就把技能清单落盘，之后打开页面只读本地文件，
 * 只有显式「刷新」才回源 GitHub。这样既不触发防刷/配额，列表也是秒开；
 * 网络不可用时旧清单照样能看、能安装。
 */
async function loadCatalog(repo, options: { refresh?: boolean; descriptions?: boolean; wait?: boolean } = {}) {
  const { refresh = false, descriptions = true, wait = false } = options;
  const cacheFile = catalogCacheFile(repo.id);
  const cached = await jsonFile(cacheFile, null);
  const usable = cached && cached.url === repo.url && Array.isArray(cached.skills) && cached.complete === true;
  if (usable && !refresh) {
    const pending = pendingDescriptions(cached);
    // 一轮没抓完（例如超时）的说明，下次访问时继续补（只读 raw，不占 API 配额）。
    if (descriptions !== false && pending > 0) startDescriptionFill(repo, cached);
    return { ...cached, pending, filled: cached.filled === true, cached: true };
  }

  const source = parseGitHubSource(repo.url);
  if (!source) throw new Error("目前只支持 github.com 仓库地址，例如 https://github.com/owner/repo");
  const { ref, oid } = await resolveGitHubRef(source);
  const { paths, strategy } = await listGitHubPaths(source, oid, ref);
  const { skills, truncated } = catalogFromPaths(paths, source.repo, source.subpath);
  if (!skills.length) throw new Error("这个仓库里没有找到包含 SKILL.md 的技能目录");
  const previousDescriptions = new Map<string, string>();
  if (cached?.oid === oid) for (const skill of cached.skills || []) if (skill?.description) previousDescriptions.set(`${skill.path}`, skill.description);
  for (const skill of skills) skill.description = previousDescriptions.get(skill.path) || "";
  const waiting = descriptions !== false && wait === true;
  if (waiting) await fillDescriptions(source, oid, ref, skills);
  const pending = skills.filter((skill) => !skill.description).length;
  const record = {
    version: 1,
    repoId: repo.id,
    url: repo.url,
    ref,
    oid,
    strategy,
    subpath: source.subpath,
    fetchedAt: new Date().toISOString(),
    total: paths.length,
    truncated,
    complete: true,
    filled: waiting,
    pending,
    skills
  };
  await save(cacheFile, record);
  // 把摘要写回仓库记录：列表页不打开卡片也能看到技能数与上次同步时间。
  await rememberRepoSummary(repo.id, { skillCount: skills.length, ref, oid, syncedAt: record.fetchedAt });
  if (descriptions !== false && !waiting) startDescriptionFill(repo, record);
  return { ...record, cached: false };
}

/** 把最近一次同步的摘要记进 repositories.json（失败不影响主流程）。 */
async function rememberRepoSummary(repoId: string, summary: { skillCount: number; ref: string; oid: string; syncedAt: string }) {
  try {
    const list = await jsonFile(repoFile(), []);
    const item = list.find((entry) => entry.id === repoId);
    if (!item || (item.skillCount === summary.skillCount && item.oid === summary.oid && item.syncedAt === summary.syncedAt)) return;
    Object.assign(item, summary);
    await save(repoFile(), list);
  } catch { /* 摘要只是显示用的，写不进去也无所谓 */ }
}

/** Which catalog entries already exist in the local DSH skill root. */
async function decorateInstalled(skills: CatalogSkill[]) {
  const installed = new Map<string, { path: string; marker: any }>();
  const root = knownRoots().find((item) => item.id === "dsh");
  let entries = [];
  try { entries = await readdir(root.path, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const marker = await jsonFile(join(root.path, entry.name, ".helloai-source.json"), null);
    installed.set(entry.name.toLowerCase(), { path: join(root.path, entry.name), marker });
  }
  return skills.map((skill) => {
    const local = installed.get(skill.folder.toLowerCase());
    return {
      name: skill.name,
      folder: skill.folder,
      path: skill.path,
      description: skill.description,
      fileCount: skill.files.length,
      installed: Boolean(local),
      installedPath: local?.path || "",
      installedFrom: local?.marker?.repoName || ""
    };
  });
}

async function installSkill(repo, input) {
  const source = parseGitHubSource(repo.url);
  if (!source) throw new Error("目前只支持 github.com 仓库地址");
  const record = await loadCatalog(repo, { descriptions: false });
  const wanted = String(input.path ?? "");
  const skill = record.skills.find((item) => item.path === wanted);
  if (!skill) throw new Error("这个技能不在当前仓库列表中，请先刷新仓库");
  const name = safeFolderName(input.name || skill.folder || skill.name);
  if (!name) throw new Error("无法为该技能生成合法的文件夹名称");
  const root = knownRoots().find((item) => item.id === String(input.root || "dsh"));
  if (!root) throw new Error("未知的技能来源");
  const target = join(root.path, name);
  if (resolve(target, "..").toLowerCase() !== resolve(root.path).toLowerCase()) throw new Error("安装路径非法");
  const existing = await stat(target).catch(() => null);
  if (existing && input.overwrite !== true) throw new Error(`技能目录 ${name} 已经存在，删除后重试或选择覆盖安装`);
  await mkdir(root.path, { recursive: true });
  const stage = join(root.path, `.helloai-install-${randomUUID()}`);
  await mkdir(stage, { recursive: true });
  let bytes = 0;
  let files = 0;
  try {
    let cursor = 0;
    const worker = async () => {
      while (cursor < skill.files.length) {
        const relative = skill.files[cursor];
        cursor += 1;
        const buffer = await downloadRepoFile(source, record.oid, record.ref, skill.path ? `${skill.path}/${relative}` : relative);
        if (buffer.length > MAX_FILE_BYTES) throw new Error(`文件 ${relative} 超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB 上限`);
        bytes += buffer.length;
        if (bytes > MAX_SKILL_BYTES) throw new Error(`技能总大小超过 ${Math.round(MAX_SKILL_BYTES / 1024 / 1024)}MB 上限`);
        const destination = resolve(stage, relative.split("/").join(sep));
        if (!destination.toLowerCase().startsWith(resolve(stage).toLowerCase() + sep)) throw new Error(`非法文件路径：${relative}`);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, buffer);
        files += 1;
      }
    };
    await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
    if (!files) throw new Error("该技能没有任何可下载的文件");
    await writeFile(join(stage, ".helloai-source.json"), JSON.stringify({ repoUrl: repo.url, repoId: repo.id, repoName: repo.name, ref: record.ref, oid: record.oid, catalogPath: skill.path, installedAt: new Date().toISOString() }, null, 2), "utf8");
    if (existing) await rm(target, { recursive: true, force: true });
    await rename(stage, target);
    return { name, folder: name, root: root.id, source: root.label, path: target, files, bytes };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/* -------------------------------------------------------------------- http */

function safeFolderName(value) {
  const raw = String(value ?? "").trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-");
  const name = raw.replace(/^[.\-]+/, "").replace(/[.\-]+$/, "").slice(0, 64);
  return name && !name.includes("..") ? name : "";
}
/** Only the DSH skill root is ours to modify; the other roots belong to their tools. */
function deletableSkillTarget(candidate) {
  const raw = String(candidate ?? "").trim();
  if (!raw) return { error: "拒绝删除：目标是空路径" };
  const target = resolve(raw);
  const parent = resolve(target, "..").toLowerCase();
  const owner = knownRoots().find((root) => resolve(root.path).toLowerCase() === parent);
  if (!owner) return { error: "拒绝删除：目标不是已登记技能目录下的技能文件夹" };
  if (owner.id !== "dsh") return { error: `${owner.label} 的技能由该工具自己维护，DSH 只能停用它，不能删除` };
  return { target };
}
function safeSkillName(value) {
  const name = String(value ?? "").trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) ? name : "";
}

function safeRepositoryUrl(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch { return ""; }
}

/* ------------------------------------------------- browser upload（浏览/拖入） */

/**
 * 浏览器里「浏览文件夹 / 选择 ZIP」的落点：浏览器拿不到服务端路径，只能把内容
 * 上传给宿主进程再落盘。两个上限都按「一个技能」的体量给足余量，超了就明确报错，
 * 而不是让整个请求悄悄占满内存。
 */
const MAX_UPLOAD_BYTES = 48 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5000;

/** 把请求体读成一个 Buffer，超过上限立刻中断。 */
async function readBody(req, limit = MAX_UPLOAD_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error(`上传内容超过 ${Math.round(limit / 1024 / 1024)}MB 上限`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * ZIP 成员名只在 bit 11 置位时才是 UTF-8；Windows 资源管理器压出来的中文名走
 * 本地代码页（简中即 GBK），所以先按 UTF-8 试，出现替换字符再退回 GBK。
 */
function zipEntryName(raw, flags) {
  if (flags & 0x0800) return raw.toString("utf8");
  const utf8 = raw.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try { return new TextDecoder("gbk").decode(raw); } catch { return utf8; }
}

/**
 * 极简 ZIP 读取器：中央目录定位 + 存储/Deflate 两种成员，不处理 ZIP64 与加密。
 * 技能包是这个体量里最小的公共格式，为此引一个解压依赖不值当。
 */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("不是有效的 ZIP 文件（没有找到中央目录）");
  const count = buffer.readUInt16LE(end + 10);
  const offset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error("暂不支持 ZIP64 格式的压缩包，请改用「浏览文件夹」");
  if (count > MAX_ARCHIVE_ENTRIES) throw new Error(`压缩包内文件过多（${count} 个），请一次只导入一个技能`);
  const files = [];
  let cursor = offset;
  let bytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("ZIP 目录项损坏，无法读取");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const path = zipEntryName(buffer.subarray(cursor + 46, cursor + 46 + nameLength), flags);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith("/")) continue; // 目录项：内容为空，路径由文件成员体现
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP 成员损坏：${path}`);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null;
    if (content === null) throw new Error(`不支持的压缩方式（成员 ${path}）`);
    if (content.length > MAX_FILE_BYTES) throw new Error(`文件 ${path} 超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB 上限`);
    bytes += content.length;
    if (bytes > MAX_SKILL_BYTES) throw new Error(`技能总大小超过 ${Math.round(MAX_SKILL_BYTES / 1024 / 1024)}MB 上限`);
    files.push({ path, content });
  }
  return files;
}

/** 归一化上传成员路径：拒绝穿越，丢掉 macOS/ZIP 工具的垃圾成员。 */
function cleanUploadPath(value) {
  const parts = String(value ?? "").replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === ".." || part.includes(":"))) return "";
  const relative = parts.join("/");
  if (relative.startsWith("__MACOSX/") || parts[parts.length - 1] === ".DS_Store") return "";
  return relative;
}

/**
 * 把一个上传的技能装进指定技能目录。
 *
 * 用户可能选的是技能文件夹本身，也可能是「装着技能文件夹的 ZIP」，所以先找最浅的
 * 那一层 SKILL.md 所在目录作为技能根；同一层同时出现多个技能时明确拒绝（一次一个），
 * 而不是替用户猜。落盘走同卷暂存目录 + rename，写入过程中失败不会留下半个技能。
 */
async function installUploaded(files, options) {
  const root = knownRoots().find((item) => item.id === String(options?.root || "dsh"));
  if (!root) throw new Error("未知的技能来源目录");

  const entries = [];
  for (const file of files) {
    const relative = cleanUploadPath(file?.path);
    if (!relative) continue;
    entries.push({ relative, content: Buffer.isBuffer(file?.content) ? file.content : Buffer.alloc(0) });
  }
  if (!entries.length) throw new Error("上传内容里没有可导入的文件");

  const depth = (value) => (value ? value.split("/").length : 0);
  const folders = [...new Set(entries.filter((entry) => entry.relative.split("/").pop().toLowerCase() === "skill.md").map((entry) => entry.relative.split("/").slice(0, -1).join("/")))];
  if (!folders.length) throw new Error("没有找到 SKILL.md：请选择技能文件夹本身，或包含该文件夹的 ZIP");
  const shallowest = Math.min(...folders.map(depth));
  const candidates = folders.filter((folder) => depth(folder) === shallowest);
  if (candidates.length > 1) throw new Error(`上传内容里包含 ${candidates.length} 个技能（${candidates.map((folder) => folder.split("/").pop()).join("、")}），请一次只导入一个`);
  const base = candidates[0];

  const folder = safeSkillName(options?.name || base.split("/").pop());
  if (!folder) throw new Error("技能名称只能使用英文、数字、点、下划线和短横线，请在「导入名称」里填写一个");
  const target = join(root.path, folder);
  if (await exists(target)) throw new Error(`${folder} 已存在：请换个名称，或先删除同名技能`);

  const prefix = base ? `${base}/` : "";
  const stage = join(root.path, `.helloai-upload-${randomUUID()}`);
  await mkdir(root.path, { recursive: true });
  await mkdir(stage, { recursive: true });
  let written = 0;
  let bytes = 0;
  try {
    for (const entry of entries) {
      if (!entry.relative.startsWith(prefix)) continue;
      const relative = entry.relative.slice(prefix.length);
      if (!relative) continue;
      const destination = resolve(stage, ...relative.split("/"));
      if (!destination.toLowerCase().startsWith(resolve(stage).toLowerCase() + sep)) throw new Error(`非法文件路径：${relative}`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, entry.content);
      written += 1;
      bytes += entry.content.length;
    }
    if (!written) throw new Error("技能文件夹里没有任何文件");
    await writeFile(join(stage, ".helloai-import.json"), JSON.stringify({
      source: String(options?.source || "upload"),
      filename: options?.filename ? String(options.filename) : undefined,
      importedAt: new Date().toISOString()
    }, null, 2), "utf8");
    await rename(stage, target);
    return { name: folder, folder, root: root.id, source: root.label, path: target, files: written, bytes };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function reply(res, status, value) { const body = JSON.stringify({ ok: status < 400, data: value }); res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) }); res.end(body); }
async function body(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }

/** 排障留痕：宿主半边常驻内存，`apply.log` 是判断「跑起来的到底是哪份代码」的唯一可靠依据。 */
function applyTrace(line: string) {
  void writeFile(join(store(), "apply.log"), `${new Date().toISOString()}  ${line}\n`, { flag: "a" }).catch(() => undefined);
}

export function apply(ctx) {
  applyTrace(`${BUILD_TAG} apply`);
  let mutation = Promise.resolve();
  const enqueue = (task) => { const next = mutation.then(task, task); mutation = next.catch(() => undefined); return next; };
  const findRepo = async (id) => (await jsonFile(repoFile(), [])).find((item) => item.id === id);

  const providerInvalidators = new Set();
  const invalidateSkills = () => { scanCache = { at: 0, value: null }; for (const invalidate of providerInvalidators) { try { invalidate(); } catch { /* stale registration */ } } };
  const afterWrite = () => notifySkillsChanged(ctx, invalidateSkills);

  if (typeof ctx.effect === "function" && ctx.skills && typeof ctx.skills.registerProvider === "function") {
    // 热重载时上一份注册可能还没释放，registerProvider 会因重名抛错；这时把原因写进
    // apply.log（而不是让整个插件静默失效），技能提供者本身保持原样。
    try {
      ctx.effect(() => ctx.skills.registerProvider((control) => {
        providerInvalidators.add(control.invalidate);
        control.signal?.addEventListener?.("abort", () => providerInvalidators.delete(control.invalidate), { once: true });
        return externalSkillProvider(control);
      }), "helloai-skills external skill provider");
      applyTrace(`${BUILD_TAG} registerProvider ok`);
    } catch (error) {
      applyTrace(`${BUILD_TAG} registerProvider 失败：${String(error?.message || error)}`);
      ctx.logger?.warn?.(`helloai-skills: 注册技能提供者失败：${String(error?.message || error)}`);
    }
  } else {
    applyTrace(`${BUILD_TAG} 缺少 ctx.skills`);
    ctx.logger?.warn?.("helloai-skills: 未找到 ctx.skills，外部技能目录只会在设置页展示");
  }

  const handler = async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname.endsWith("/state")) return reply(res, 200, await snapshot());
      if (req.method === "GET" && url.pathname.endsWith("/repositories")) return reply(res, 200, await jsonFile(repoFile(), []));
      if (req.method !== "POST") return reply(res, 405, { error: "method not allowed" });
      // 浏览器上传走原始字节 / 文件清单，不能按 JSON body 解析（见 installUploaded）。
      if (url.pathname.endsWith("/skills/import-upload")) {
        const buffer = await readBody(req);
        if (!buffer.length) throw new Error("没有收到上传内容");
        const entries = unzip(buffer);
        return reply(res, 200, await enqueue(async () => {
          const installed = await installUploaded(entries, { root: url.searchParams.get("root"), name: url.searchParams.get("name"), filename: url.searchParams.get("filename"), source: "zip" });
          afterWrite();
          return { installed, state: await snapshot() };
        }));
      }
      if (url.pathname.endsWith("/skills/import-files")) {
        const payload = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const raw = Array.isArray(payload?.files) ? payload.files : [];
        const files = raw.map((file) => ({ path: String(file?.path || ""), content: Buffer.from(String(file?.data || ""), "base64") }));
        return reply(res, 200, await enqueue(async () => {
          const installed = await installUploaded(files, { root: payload?.root, name: payload?.name, source: "folder" });
          afterWrite();
          return { installed, state: await snapshot() };
        }));
      }
      const input = await body(req);
      const runAction = async () => {
        if (url.pathname.endsWith("/note")) { const notes = await jsonFile(noteFile(), {}); notes[String(input.id)] = String(input.note || "").trim(); await save(noteFile(), notes); invalidateSkills(); return await snapshot(); }
        if (url.pathname.endsWith("/toggle")) { const policy = await jsonFile(policyFile(), {}); policy[String(input.id)] = input.enabled === true; await save(policyFile(), policy); afterWrite(); return await snapshot(); }
        if (url.pathname.endsWith("/delete")) {
          const guard = deletableSkillTarget(input.path);
          if (guard.error) throw new Error(guard.error);
          await rm(guard.target, { recursive: true, force: true });
          afterWrite();
          return await snapshot();
        }
        if (url.pathname.endsWith("/skills/create")) {
          const root = knownRoots().find((item) => item.id === String(input.root || "dsh"));
          const name = safeSkillName(input.name);
          if (!root || !name) throw new Error("技能名称只能使用英文、数字、点、下划线和短横线，且不超过 64 个字符");
          const target = join(root.path, name);
          await mkdir(root.path, { recursive: true });
          await mkdir(target, { recursive: false });
          const description = String(input.description || "").trim();
          const text = `---\nname: ${slugForName(name)}\ndescription: ${description || "待补充技能说明"}\n---\n\n# ${name}\n\n${description || "在这里填写技能的使用说明。"}\n`;
          await writeFile(join(target, "SKILL.md"), text, "utf8");
          afterWrite();
          return await snapshot();
        }
        if (url.pathname.endsWith("/skills/import")) {
          const source = resolve(String(input.path || ""));
          const sourceDoc = join(source, "SKILL.md");
          const sourceInfo = await stat(sourceDoc).catch(() => null);
          const root = knownRoots().find((item) => item.id === String(input.root || "dsh"));
          const name = safeSkillName(input.name || source.split(/[\\/]/).pop());
          if (!root || !name || !sourceInfo?.isFile()) throw new Error("请选择包含 SKILL.md 的技能文件夹，并填写有效名称");
          const target = join(root.path, name);
          await mkdir(root.path, { recursive: true });
          if (resolve(source).toLowerCase() === resolve(target).toLowerCase()) throw new Error("源目录和目标目录不能相同");
          await cp(source, target, { recursive: true, errorOnExist: true });
          afterWrite();
          return await snapshot();
        }
        if (url.pathname.endsWith("/repositories/add")) {
          const urlValue = safeRepositoryUrl(input.url);
          const name = String(input.name || "").trim();
          if (!urlValue || !name || name.length > 80) throw new Error("请填写有效的 HTTP/HTTPS 仓库地址和仓库名称");
          const list = await jsonFile(repoFile(), []);
          if (list.some((item) => item.url === urlValue)) throw new Error("这个仓库已经添加过了");
          const entry = { id: randomUUID(), name, url: urlValue, icon: String(input.icon || "◈"), updatedAt: new Date().toISOString() };
          list.push(entry);
          await save(repoFile(), list);
          // 登记后立刻解析一次，添加失败/网络不通时用户马上能看到原因。
          try {
            const catalog = await loadCatalog(entry);
            return { repositories: list, catalog: { id: entry.id, total: catalog.skills.length, ref: catalog.ref, oid: catalog.oid, cached: catalog.cached } };
          } catch (error) {
            return { repositories: list, warning: String(error?.message || error) };
          }
        }
        if (url.pathname.endsWith("/repositories/remove")) {
          const list = (await jsonFile(repoFile(), [])).filter((item) => item.id !== input.id);
          await save(repoFile(), list);
          await rm(catalogCacheFile(String(input.id)), { force: true }).catch(() => undefined);
          return list;
        }
        if (url.pathname.endsWith("/repositories/catalog") || url.pathname.endsWith("/repositories/skills")) {
          const repo = await findRepo(input.id);
          if (!repo) throw new Error("仓库不存在，请刷新列表");
          const record = await loadCatalog(repo, { refresh: input.refresh === true, descriptions: input.descriptions !== false, wait: input.wait === true });
          return {
            repository: repo,
            ref: record.ref,
            oid: record.oid,
            strategy: record.strategy,
            fetchedAt: record.fetchedAt,
            cached: record.cached,
            truncated: record.truncated,
            filled: record.filled === true,
            pending: record.pending ?? 0,
            subpath: record.subpath,
            skills: await decorateInstalled(record.skills)
          };
        }
        if (url.pathname.endsWith("/skills/install")) {
          const repo = await findRepo(input.id);
          if (!repo) throw new Error("仓库不存在，请刷新列表");
          const installed = await installSkill(repo, input);
          afterWrite();
          return { installed, state: await snapshot() };
        }
        if (url.pathname.endsWith("/repositories/update")) {
          // 「修改」只改登记信息（名称 / 地址）。地址变了必须丢掉旧的目录缓存，
          // 否则下一个请求还会拿上一个仓库的技能列表。
          const list = await jsonFile(repoFile(), []);
          const index = list.findIndex((item) => item.id === input.id);
          if (index < 0) throw new Error("仓库不存在，请刷新列表");
          const current = list[index];
          const nextUrl = safeRepositoryUrl(input.url ?? current.url);
          const nextName = String(input.name ?? current.name).trim();
          if (!nextUrl || !nextName || nextName.length > 80) throw new Error("请填写有效的 HTTP/HTTPS 仓库地址和仓库名称");
          if (list.some((item, at) => at !== index && item.url === nextUrl)) throw new Error("这个仓库地址已经登记过了");
          const urlChanged = nextUrl !== current.url;
          const next = { ...current, name: nextName, url: nextUrl, updatedAt: new Date().toISOString() };
          if (urlChanged) {
            // 地址换了：旧的技能数 / 分支 / 同步时间都属于上一个仓库，一并清掉，免得界面
            // 拿着旧摘要显示新仓库。这里只作废缓存，不主动回源 —— 重新下载由界面的「刷新」触发。
            delete next.skillCount;
            delete next.ref;
            delete next.oid;
            delete next.syncedAt;
            await rm(catalogCacheFile(String(current.id)), { force: true }).catch(() => undefined);
          }
          list[index] = next;
          await save(repoFile(), list);
          return { repositories: list, urlChanged };
        }
        if (url.pathname.endsWith("/repositories/refresh")) {
          const list = await jsonFile(repoFile(), []);
          const ids = input.id ? [input.id] : list.map((item) => item.id);
          for (const id of ids) await rm(catalogCacheFile(String(id)), { force: true }).catch(() => undefined);
          if (input.id) {
            const repo = list.find((item) => item.id === input.id);
            if (repo) {
              const record = await loadCatalog(repo, { refresh: true, descriptions: input.descriptions !== false, wait: input.wait === true });
              return { repositories: list, catalog: { id: repo.id, total: record.skills.length, ref: record.ref, oid: record.oid, cached: false, pending: record.pending ?? 0, skills: await decorateInstalled(record.skills) } };
            }
          }
          return { repositories: list };
        }
        return { error: "unknown action" };
      };
      // 命中本地缓存的读取不排队：一个慢速回源不该把别的仓库也堵在「读取中…」。
      const isCatalogRead = (url.pathname.endsWith("/repositories/catalog") || url.pathname.endsWith("/repositories/skills")) && input.refresh !== true;
      const result = isCatalogRead ? await runAction() : await enqueue(runAction);
      return reply(res, 200, result);
    } catch (error) { return reply(res, 500, { error: String(error?.message || error) }); }
  };
  const mountApi = () => {
    try {
      return ctx.webServer.register({ kind: "prefix", path: "/api/dsh-helloai-skills", handler });
    } catch (error) {
      const text = String(error?.message ?? error);
      if (!text.includes('duplicate prefix route "/api/dsh-helloai-skills"')) throw error;
      ctx.logger?.warn?.("helloai-skills: 复用已注册的 API 路由（热重载）");
      return () => {};
    }
  };
  if (typeof ctx.effect === "function") ctx.effect(mountApi, "helloai-skills api route");
  else mountApi();
}

function slugForName(name: string) { return toKebab(name) || name.toLowerCase(); }
