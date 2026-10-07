import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
const name = "helloai-skills";
const inject = ["webServer", "skills"];
const base = () => process.env.DSH_HOME || join(homedir(), ".dsh");
const store = () => join(base(), "helloai-skills");
const repoFile = () => join(store(), "repositories.json");
const noteFile = () => join(store(), "notes.json");
const policyFile = () => join(store(), "policy.json");
const cacheRoot = () => join(store(), "cache");
const PROVIDER_NAME = "helloai-skills";
const BUILD_TAG = "1.3.0-repo-presets";
const STATIC_ROOTS = [
  { id: "dsh", label: "DSH", dir: [], tone: "#7c9cff", rank: 400, native: true, mutable: true },
  { id: "agents", label: "\u516C\u5171 Agent", dir: [".agents"], env: "DSH_AGENTS_HOME", tone: "#8ab4f8", rank: 500, native: true, mutable: false },
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
  { id: "clawdbot", label: "OpenClaw \u65E7\u76EE\u5F55", dir: [".clawdbot"], env: "DSH_CLAWDBOT_HOME", tone: "#e879f9", rank: 810, native: false, mutable: false },
  { id: "roo", label: "Roo", dir: [".roo"], env: "DSH_ROO_HOME", tone: "#fbbf24", rank: 820, native: false, mutable: false },
  { id: "codebuddy", label: "CodeBuddy", dir: [".codebuddy"], env: "DSH_CODEBUDDY_HOME", tone: "#22d3ee", rank: 830, native: false, mutable: false },
  { id: "cc-switch", label: "CC Switch", dir: [".cc-switch"], tone: "#ed6f91", rank: 840, native: false, mutable: false }
];
function staticRootHome(root) {
  if (root.env && process.env[root.env]) return process.env[root.env];
  if (root.id === "dsh") return base();
  return join(homedir(), ...root.dir);
}
function knownRoots() {
  return STATIC_ROOTS.map((root) => ({ id: root.id, label: root.label, tone: root.tone, rank: root.rank, native: root.native, mutable: root.mutable, path: join(staticRootHome(root), "skills") }));
}
const AUTO_TONES = ["#f59e0b", "#10b981", "#6366f1", "#ec4899", "#14b8a6", "#8b5cf6"];
let discovered = { at: 0, roots: [] };
async function discoveredRoots() {
  if (Date.now() - discovered.at < 3e4) return discovered.roots;
  const known = new Set(knownRoots().map((root) => resolve(root.path).toLowerCase()));
  const found = [];
  const push = (id, label, path, tone) => {
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
  } catch {
  }
  try {
    const cache = join(homedir(), ".qoder", "plugins", "cache");
    for (const vendor of await readdir(cache, { withFileTypes: true })) {
      if (!vendor.isDirectory()) continue;
      for (const plugin of await readdir(join(cache, vendor.name), { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        const path = join(cache, vendor.name, plugin.name, "skills");
        if (await hasSkills(path)) push(`qoder-${slugSegment(plugin.name)}`, `Qoder \xB7 ${plugin.name}`, path, AUTO_TONES[found.length % AUTO_TONES.length]);
      }
    }
  } catch {
  }
  discovered = { at: Date.now(), roots: found };
  return found;
}
async function allRoots() {
  return [...knownRoots(), ...await discoveredRoots()];
}
async function hasSkills(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (await exists(join(path, entry.name, "SKILL.md"))) return true;
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) return true;
    }
  } catch {
  }
  return false;
}
async function exists(path) {
  return Boolean(await stat(path).catch(() => null));
}
const MAX_SKILLS = 400;
const MAX_FILES_PER_SKILL = 400;
const MAX_DESCRIPTIONS = 200;
const DESCRIPTION_BUDGET = 6e4;
const DESCRIPTION_WORKERS = 10;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_SKILL_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 6;
const USER_AGENT = "dsh-helloai-skills/0.3 (+https://github.com/hello-heyongping)";
async function jsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}
function stripBom(text) {
  return text.charCodeAt(0) === 65279 ? text.slice(1) : text;
}
function decodeScalar(raw) {
  const value = String(raw ?? "").trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length > 1 || value.startsWith("'") && value.endsWith("'") && value.length > 1) return value.slice(1, -1);
  return value;
}
function parseSkillDoc(text) {
  const source = stripBom(String(text ?? ""));
  const lines = source.split(/\r?\n/);
  const map = {};
  let body2 = source;
  if (lines.length && lines[0].trim() === "---") {
    let end = -1;
    for (let index = 1; index < lines.length; index += 1) if (lines[index].trim() === "---") {
      end = index;
      break;
    }
    if (end > 0) {
      for (let index = 1; index < end; index += 1) {
        const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[index]);
        if (!match) continue;
        const block = /^([>|])[-+]?\s*$/.exec(match[2].trim());
        if (block) {
          const collected = [];
          while (index + 1 < end && (/^\s/.test(lines[index + 1]) || lines[index + 1].trim() === "")) {
            index += 1;
            collected.push(lines[index]);
          }
          const indents = collected.filter((line) => line.trim() !== "").map((line) => (/^\s*/.exec(line) || [""])[0].length);
          const indent = indents.length ? Math.min(...indents) : 0;
          const normalized = collected.map((line) => line.slice(Math.min(indent, line.length)));
          map[match[1]] = block[1] === ">" ? normalized.join(" ").replace(/\s+/g, " ").trim() : normalized.join("\n").trim();
        } else map[match[1]] = decodeScalar(match[2]);
      }
      body2 = lines.slice(end + 1).join("\n");
    }
  }
  return { map, body: body2 };
}
function toKebab(value) {
  let text = String(value ?? "").trim();
  if (!text) return "";
  text = text.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  text = text.replace(/[\s_.]+/g, "-").replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(text) ? text.slice(0, 64).replace(/-+$/, "") : "";
}
function slugSegment(value) {
  return toKebab(value) || "root";
}
function firstMeaningfulLine(body2) {
  for (const line of String(body2 ?? "").split(/\r?\n/)) {
    const text = line.replace(/^#+\s*/, "").trim();
    if (text && !text.startsWith("<!--")) return text.slice(0, 200);
  }
  return "";
}
function skillDoc(text) {
  const { map, body: body2 } = parseSkillDoc(text);
  return {
    title: map.name || "",
    description: map.description || map.summary || "",
    whenToUse: map.whenToUse || map.when_to_use || "",
    body: body2.trim(),
    hasFrontmatter: Object.keys(map).length > 0
  };
}
async function scanRoot(root) {
  let entries;
  try {
    entries = await readdir(root.path, { withFileTypes: true });
  } catch {
    return [];
  }
  const notes = await jsonFile(noteFile(), {});
  const policy = await jsonFile(policyFile(), {});
  const result = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    let docPath = "";
    let directory = "";
    if (entry.isDirectory()) {
      directory = join(root.path, entry.name);
      docPath = join(directory, "SKILL.md");
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) docPath = join(root.path, entry.name);
    else continue;
    let text;
    try {
      text = await readFile(docPath, "utf8");
    } catch {
      continue;
    }
    const doc = skillDoc(text);
    if (!directory && !doc.hasFrontmatter) continue;
    const name2 = doc.title || entry.name.replace(/\.md$/i, "");
    const slug = toKebab(name2) || toKebab(entry.name.replace(/\.md$/i, ""));
    if (!slug) continue;
    const id = `${root.id}:${entry.name}`;
    result.push({
      id,
      name: name2,
      slug,
      description: notes[id] || doc.description || firstMeaningfulLine(doc.body) || `\u6765\u81EA ${root.label} \u7684\u6280\u80FD`,
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
      id: skill.id,
      name: skill.name,
      slug: skill.slug,
      root: skill.root,
      source: skill.source,
      path: skill.path,
      description: skill.description,
      enabled: skill.enabled,
      callable: true,
      native: skill.native,
      mutable: skill.mutable
    })),
    groups: groups.map((group) => ({
      id: group.id,
      label: group.label,
      path: group.path,
      tone: group.tone,
      native: group.native,
      mutable: group.mutable,
      callable: true,
      count: group.skills.length,
      skills: group.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        slug: skill.slug,
        root: skill.root,
        source: skill.source,
        path: skill.path,
        description: skill.description,
        enabled: skill.enabled,
        callable: true,
        native: skill.native,
        mutable: skill.mutable
      }))
    }))
  };
}
let scanCache = { at: 0, value: null };
async function cachedScan(maxAge = 1500) {
  if (scanCache.value && Date.now() - scanCache.at < maxAge) return scanCache.value;
  const value = await scanAll();
  scanCache = { at: Date.now(), value };
  return value;
}
function externalSkillProvider(control) {
  return {
    name: PROVIDER_NAME,
    async list() {
      try {
        const { roots, skills } = await cachedScan();
        const rankByRoot = new Map(roots.map((root) => [root.id, root.rank]));
        const seen = /* @__PURE__ */ new Set();
        const candidates = [];
        for (const skill of skills) {
          if (!skill.enabled || seen.has(skill.slug)) continue;
          seen.add(skill.slug);
          candidates.push({
            name: skill.slug,
            description: skill.description,
            ...skill.whenToUse ? { whenToUse: skill.whenToUse } : {},
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
        return [];
      }
    },
    async get(candidate) {
      const locator = candidate?.locator;
      if (!locator?.docPath) return void 0;
      let text;
      try {
        text = await readFile(locator.docPath, "utf8");
      } catch {
        return void 0;
      }
      const doc = skillDoc(text);
      const accepted = [toKebab(doc.title), toKebab(locator.displayName), toKebab(locator.entry)].filter(Boolean);
      if (accepted.length && !accepted.includes(candidate.name)) return void 0;
      return {
        name: candidate.name,
        description: doc.description || firstMeaningfulLine(doc.body) || candidate.description,
        ...doc.whenToUse ? { whenToUse: doc.whenToUse } : {},
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
function notifySkillsChanged(ctx, invalidate) {
  try {
    invalidate?.();
  } catch {
  }
  try {
    ctx.emit?.("commands/change");
  } catch {
  }
  try {
    const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : void 0;
    for (const session of sessions?.list?.() ?? []) {
      const id = session?.id ?? session?.header?.id;
      const preset = typeof session?.header?.agentPreset === "string" ? session.header.agentPreset : "";
      if (id == null || !preset) continue;
      ctx.emit?.("agent-preset/selected", id, preset);
    }
  } catch {
  }
}
function parseGitHubSource(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    return null;
  }
  if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  let ref = "";
  let subpath = "";
  if (parts[2] === "tree" || parts[2] === "blob") {
    ref = parts[3] || "";
    subpath = parts.slice(4).join("/");
  }
  return { kind: "github", owner, repo: repo.replace(/\.git$/i, ""), ref, subpath };
}
function githubToken() {
  return process.env.DSH_HELLOAI_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
}
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}
async function httpGet(url, options = {}) {
  const { as = "text", timeout = 25e3, accept = "*/*", attempts = 4 } = options;
  const headers = { "user-agent": USER_AGENT, accept };
  if (githubToken() && /(^|\.)(github\.com|githubusercontent\.com)$/i.test(new URL(url).hostname)) headers.authorization = `Bearer ${githubToken()}`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeout), headers });
      if (!response.ok) {
        const error = new Error(`\u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${response.status}\uFF09\xB7 ${new URL(url).host}`);
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
  throw lastError ?? new Error(`\u8BF7\u6C42\u5931\u8D25 \xB7 ${url}`);
}
function embeddedJson(html) {
  const match = html.match(/<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}
async function resolveGitHubRef(source) {
  const candidates = [...new Set([source.ref, "main", "master"].filter(Boolean))];
  let lastError;
  for (const candidate of candidates) {
    const encoded = candidate.split("/").map(encodeURIComponent).join("/");
    try {
      const html = await httpGet(`https://github.com/${source.owner}/${source.repo}/tree/${encoded}`, { accept: "text/html", timeout: 2e4 });
      const payload = embeddedJson(html)?.payload;
      const info = payload?.codeViewTreeRoute?.refInfo || payload?.refInfo;
      if (info?.currentOid) return { ref: info.name || candidate, oid: info.currentOid };
      lastError = new Error("\u65E0\u6CD5\u89E3\u6790\u4ED3\u5E93\u5F15\u7528\u4FE1\u606F");
    } catch (error) {
      lastError = error;
    }
    try {
      const atom = await httpGet(`https://github.com/${source.owner}/${source.repo}/commits/${encoded}.atom`, { accept: "application/atom+xml", timeout: 2e4 });
      const oid = atom.match(/Grit::Commit\/([0-9a-f]{7,40})/i)?.[1];
      if (oid) return { ref: candidate, oid };
    } catch (error) {
      lastError = error;
    }
    try {
      const api = await httpGet(`https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encoded}`, { as: "json", accept: "application/vnd.github+json", timeout: 2e4, attempts: 2 });
      if (api?.sha) return { ref: candidate, oid: api.sha };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u4ED3\u5E93 ${source.owner}/${source.repo}\uFF1A${String(lastError?.message || lastError)}`);
}
async function listGitHubPaths(source, oid, ref) {
  const attempts = [
    { strategy: "tree-list", run: async () => (await httpGet(`https://github.com/${source.owner}/${source.repo}/tree-list/${oid}`, { as: "json", accept: "application/json" }))?.paths || [] },
    { strategy: "github-api", run: async () => ((await httpGet(`https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(oid || ref)}?recursive=1`, { as: "json", accept: "application/vnd.github+json" }))?.tree || []).filter((item) => item.type === "blob").map((item) => item.path) },
    { strategy: "jsdelivr", run: async () => ((await httpGet(`https://data.jsdelivr.com/v1/packages/gh/${source.owner}/${source.repo}@${encodeURIComponent(oid || ref)}?structure=flat`, { as: "json", accept: "application/json" }))?.files || []).map((file) => file.name.replace(/^\//, "")) }
  ];
  let lastError;
  for (const attempt of attempts) {
    try {
      const paths = (await attempt.run()).filter((path) => typeof path === "string" && path);
      if (paths.length) return { paths, strategy: attempt.strategy };
      lastError = new Error("\u4ED3\u5E93\u6587\u4EF6\u5217\u8868\u4E3A\u7A7A");
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`\u65E0\u6CD5\u5217\u51FA\u4ED3\u5E93\u6587\u4EF6\uFF1A${String(lastError?.message || lastError)}`);
}
function encodeRepoPath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}
async function downloadRepoFile(source, oid, ref, path) {
  const revision = oid || ref;
  const urls = [
    `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodeURIComponent(revision)}/${encodeRepoPath(path)}`,
    `https://cdn.jsdelivr.net/gh/${source.owner}/${source.repo}@${revision}/${encodeRepoPath(path)}`
  ];
  let lastError;
  for (const url of urls) {
    try {
      return await httpGet(url, { as: "buffer", timeout: 3e4, attempts: 2 });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`\u4E0B\u8F7D ${path} \u5931\u8D25\uFF1A${String(lastError?.message || lastError)}`);
}
function catalogFromPaths(paths, repoName, subpath) {
  const scoped = subpath ? paths.filter((path) => path === subpath || path.startsWith(`${subpath}/`)) : paths;
  const clean = scoped.filter((path) => path && !/(^|\/)__MACOSX(\/|$)/.test(path) && !/(^|\/)\.DS_Store$/.test(path));
  const prefixes = /* @__PURE__ */ new Set();
  for (const path of clean) if (/(^|\/)SKILL\.md$/i.test(path)) prefixes.add(path.replace(/\/?SKILL\.md$/i, ""));
  const directories = [...prefixes].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  const truncated = directories.length > MAX_SKILLS;
  const skills = [];
  for (const directory of directories.slice(0, MAX_SKILLS)) {
    const files = clean.filter((path) => directory ? path.startsWith(`${directory}/`) : true);
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
  const used = /* @__PURE__ */ new Set();
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
async function fillDescriptions(source, oid, ref, skills, onProgress) {
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
      } catch {
      }
      if (onProgress && Date.now() - lastReport > 1500) {
        lastReport = Date.now();
        await onProgress();
      }
    }
  };
  await Promise.all(Array.from({ length: DESCRIPTION_WORKERS }, worker));
  return skills;
}
function catalogCacheFile(repoId) {
  return join(cacheRoot(), `catalog-${String(repoId).replace(/[^a-zA-Z0-9._-]/g, "")}.json`);
}
const descriptionJobs = /* @__PURE__ */ new Map();
function pendingDescriptions(record) {
  return (record?.skills ?? []).filter((skill) => !skill.description).length;
}
function startDescriptionFill(repo, record) {
  if (descriptionJobs.has(repo.id)) return;
  const job = (async () => {
    const source = parseGitHubSource(repo.url);
    if (!source) return;
    const persist = async (final) => {
      const current = await jsonFile(catalogCacheFile(repo.id), null);
      if (!current || current.oid !== record.oid || current.url !== repo.url) return;
      const filled = new Map(record.skills.map((skill) => [skill.path, skill.description]));
      current.skills = current.skills.map((skill) => ({ ...skill, description: skill.description || filled.get(skill.path) || "" }));
      current.pending = pendingDescriptions(current);
      current.filled = final;
      current.filledAt = (/* @__PURE__ */ new Date()).toISOString();
      await save(catalogCacheFile(repo.id), current);
    };
    await fillDescriptions(source, record.oid, record.ref, record.skills, () => persist(false));
    await persist(true);
  })().catch(() => void 0).finally(() => descriptionJobs.delete(repo.id));
  descriptionJobs.set(repo.id, job);
}
async function loadCatalog(repo, options = {}) {
  const { refresh = false, descriptions = true, wait = false } = options;
  const cacheFile = catalogCacheFile(repo.id);
  const cached = await jsonFile(cacheFile, null);
  const usable = cached && cached.url === repo.url && Array.isArray(cached.skills) && cached.complete === true;
  if (usable && !refresh) {
    const pending2 = pendingDescriptions(cached);
    if (descriptions !== false && pending2 > 0) startDescriptionFill(repo, cached);
    return { ...cached, pending: pending2, filled: cached.filled === true, cached: true };
  }
  const source = parseGitHubSource(repo.url);
  if (!source) throw new Error("\u76EE\u524D\u53EA\u652F\u6301 github.com \u4ED3\u5E93\u5730\u5740\uFF0C\u4F8B\u5982 https://github.com/owner/repo");
  const { ref, oid } = await resolveGitHubRef(source);
  const { paths, strategy } = await listGitHubPaths(source, oid, ref);
  const { skills, truncated } = catalogFromPaths(paths, source.repo, source.subpath);
  if (!skills.length) throw new Error("\u8FD9\u4E2A\u4ED3\u5E93\u91CC\u6CA1\u6709\u627E\u5230\u5305\u542B SKILL.md \u7684\u6280\u80FD\u76EE\u5F55");
  const previousDescriptions = /* @__PURE__ */ new Map();
  if (cached?.oid === oid) {
    for (const skill of cached.skills || []) if (skill?.description) previousDescriptions.set(`${skill.path}`, skill.description);
  }
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
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
    total: paths.length,
    truncated,
    complete: true,
    filled: waiting,
    pending,
    skills
  };
  await save(cacheFile, record);
  await rememberRepoSummary(repo.id, { skillCount: skills.length, ref, oid, syncedAt: record.fetchedAt });
  if (descriptions !== false && !waiting) startDescriptionFill(repo, record);
  return { ...record, cached: false };
}
async function rememberRepoSummary(repoId, summary) {
  try {
    const list = await jsonFile(repoFile(), []);
    const item = list.find((entry) => entry.id === repoId);
    if (!item || item.skillCount === summary.skillCount && item.oid === summary.oid && item.syncedAt === summary.syncedAt) return;
    Object.assign(item, summary);
    await save(repoFile(), list);
  } catch {
  }
}
async function decorateInstalled(skills) {
  const installed = /* @__PURE__ */ new Map();
  const root = knownRoots().find((item) => item.id === "dsh");
  let entries = [];
  try {
    entries = await readdir(root.path, { withFileTypes: true });
  } catch {
    entries = [];
  }
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
  if (!source) throw new Error("\u76EE\u524D\u53EA\u652F\u6301 github.com \u4ED3\u5E93\u5730\u5740");
  const record = await loadCatalog(repo, { descriptions: false });
  const wanted = String(input.path ?? "");
  const skill = record.skills.find((item) => item.path === wanted);
  if (!skill) throw new Error("\u8FD9\u4E2A\u6280\u80FD\u4E0D\u5728\u5F53\u524D\u4ED3\u5E93\u5217\u8868\u4E2D\uFF0C\u8BF7\u5148\u5237\u65B0\u4ED3\u5E93");
  const name2 = safeFolderName(input.name || skill.folder || skill.name);
  if (!name2) throw new Error("\u65E0\u6CD5\u4E3A\u8BE5\u6280\u80FD\u751F\u6210\u5408\u6CD5\u7684\u6587\u4EF6\u5939\u540D\u79F0");
  const root = knownRoots().find((item) => item.id === String(input.root || "dsh"));
  if (!root) throw new Error("\u672A\u77E5\u7684\u6280\u80FD\u6765\u6E90");
  const target = join(root.path, name2);
  if (resolve(target, "..").toLowerCase() !== resolve(root.path).toLowerCase()) throw new Error("\u5B89\u88C5\u8DEF\u5F84\u975E\u6CD5");
  const existing = await stat(target).catch(() => null);
  if (existing && input.overwrite !== true) throw new Error(`\u6280\u80FD\u76EE\u5F55 ${name2} \u5DF2\u7ECF\u5B58\u5728\uFF0C\u5220\u9664\u540E\u91CD\u8BD5\u6216\u9009\u62E9\u8986\u76D6\u5B89\u88C5`);
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
        if (buffer.length > MAX_FILE_BYTES) throw new Error(`\u6587\u4EF6 ${relative} \u8D85\u8FC7 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB \u4E0A\u9650`);
        bytes += buffer.length;
        if (bytes > MAX_SKILL_BYTES) throw new Error(`\u6280\u80FD\u603B\u5927\u5C0F\u8D85\u8FC7 ${Math.round(MAX_SKILL_BYTES / 1024 / 1024)}MB \u4E0A\u9650`);
        const destination = resolve(stage, relative.split("/").join(sep));
        if (!destination.toLowerCase().startsWith(resolve(stage).toLowerCase() + sep)) throw new Error(`\u975E\u6CD5\u6587\u4EF6\u8DEF\u5F84\uFF1A${relative}`);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, buffer);
        files += 1;
      }
    };
    await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
    if (!files) throw new Error("\u8BE5\u6280\u80FD\u6CA1\u6709\u4EFB\u4F55\u53EF\u4E0B\u8F7D\u7684\u6587\u4EF6");
    await writeFile(join(stage, ".helloai-source.json"), JSON.stringify({ repoUrl: repo.url, repoId: repo.id, repoName: repo.name, ref: record.ref, oid: record.oid, catalogPath: skill.path, installedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2), "utf8");
    if (existing) await rm(target, { recursive: true, force: true });
    await rename(stage, target);
    return { name: name2, folder: name2, root: root.id, source: root.label, path: target, files, bytes };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => void 0);
    throw error;
  }
}
function safeFolderName(value) {
  const raw = String(value ?? "").trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-");
  const name2 = raw.replace(/^[.\-]+/, "").replace(/[.\-]+$/, "").slice(0, 64);
  return name2 && !name2.includes("..") ? name2 : "";
}
function deletableSkillTarget(candidate) {
  const raw = String(candidate ?? "").trim();
  if (!raw) return { error: "\u62D2\u7EDD\u5220\u9664\uFF1A\u76EE\u6807\u662F\u7A7A\u8DEF\u5F84" };
  const target = resolve(raw);
  const parent = resolve(target, "..").toLowerCase();
  const owner = knownRoots().find((root) => resolve(root.path).toLowerCase() === parent);
  if (!owner) return { error: "\u62D2\u7EDD\u5220\u9664\uFF1A\u76EE\u6807\u4E0D\u662F\u5DF2\u767B\u8BB0\u6280\u80FD\u76EE\u5F55\u4E0B\u7684\u6280\u80FD\u6587\u4EF6\u5939" };
  if (owner.id !== "dsh") return { error: `${owner.label} \u7684\u6280\u80FD\u7531\u8BE5\u5DE5\u5177\u81EA\u5DF1\u7EF4\u62A4\uFF0CDSH \u53EA\u80FD\u505C\u7528\u5B83\uFF0C\u4E0D\u80FD\u5220\u9664` };
  return { target };
}
function safeSkillName(value) {
  const name2 = String(value ?? "").trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name2) ? name2 : "";
}
function safeRepositoryUrl(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}
const MAX_UPLOAD_BYTES = 48 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5e3;
async function readBody(req, limit = MAX_UPLOAD_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error(`\u4E0A\u4F20\u5185\u5BB9\u8D85\u8FC7 ${Math.round(limit / 1024 / 1024)}MB \u4E0A\u9650`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function zipEntryName(raw, flags) {
  if (flags & 2048) return raw.toString("utf8");
  const utf8 = raw.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gbk").decode(raw);
  } catch {
    return utf8;
  }
}
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([80, 75, 5, 6]));
  if (end < 0) throw new Error("\u4E0D\u662F\u6709\u6548\u7684 ZIP \u6587\u4EF6\uFF08\u6CA1\u6709\u627E\u5230\u4E2D\u592E\u76EE\u5F55\uFF09");
  const count = buffer.readUInt16LE(end + 10);
  const offset = buffer.readUInt32LE(end + 16);
  if (count === 65535 || offset === 4294967295) throw new Error("\u6682\u4E0D\u652F\u6301 ZIP64 \u683C\u5F0F\u7684\u538B\u7F29\u5305\uFF0C\u8BF7\u6539\u7528\u300C\u6D4F\u89C8\u6587\u4EF6\u5939\u300D");
  if (count > MAX_ARCHIVE_ENTRIES) throw new Error(`\u538B\u7F29\u5305\u5185\u6587\u4EF6\u8FC7\u591A\uFF08${count} \u4E2A\uFF09\uFF0C\u8BF7\u4E00\u6B21\u53EA\u5BFC\u5165\u4E00\u4E2A\u6280\u80FD`);
  const files = [];
  let cursor = offset;
  let bytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 33639248) throw new Error("ZIP \u76EE\u5F55\u9879\u635F\u574F\uFF0C\u65E0\u6CD5\u8BFB\u53D6");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const path = zipEntryName(buffer.subarray(cursor + 46, cursor + 46 + nameLength), flags);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith("/")) continue;
    if (buffer.readUInt32LE(localOffset) !== 67324752) throw new Error(`ZIP \u6210\u5458\u635F\u574F\uFF1A${path}`);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null;
    if (content === null) throw new Error(`\u4E0D\u652F\u6301\u7684\u538B\u7F29\u65B9\u5F0F\uFF08\u6210\u5458 ${path}\uFF09`);
    if (content.length > MAX_FILE_BYTES) throw new Error(`\u6587\u4EF6 ${path} \u8D85\u8FC7 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB \u4E0A\u9650`);
    bytes += content.length;
    if (bytes > MAX_SKILL_BYTES) throw new Error(`\u6280\u80FD\u603B\u5927\u5C0F\u8D85\u8FC7 ${Math.round(MAX_SKILL_BYTES / 1024 / 1024)}MB \u4E0A\u9650`);
    files.push({ path, content });
  }
  return files;
}
function cleanUploadPath(value) {
  const parts = String(value ?? "").replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === ".." || part.includes(":"))) return "";
  const relative = parts.join("/");
  if (relative.startsWith("__MACOSX/") || parts[parts.length - 1] === ".DS_Store") return "";
  return relative;
}
async function installUploaded(files, options) {
  const root = knownRoots().find((item) => item.id === String(options?.root || "dsh"));
  if (!root) throw new Error("\u672A\u77E5\u7684\u6280\u80FD\u6765\u6E90\u76EE\u5F55");
  const entries = [];
  for (const file of files) {
    const relative = cleanUploadPath(file?.path);
    if (!relative) continue;
    entries.push({ relative, content: Buffer.isBuffer(file?.content) ? file.content : Buffer.alloc(0) });
  }
  if (!entries.length) throw new Error("\u4E0A\u4F20\u5185\u5BB9\u91CC\u6CA1\u6709\u53EF\u5BFC\u5165\u7684\u6587\u4EF6");
  const depth = (value) => value ? value.split("/").length : 0;
  const folders = [...new Set(entries.filter((entry) => entry.relative.split("/").pop().toLowerCase() === "skill.md").map((entry) => entry.relative.split("/").slice(0, -1).join("/")))];
  if (!folders.length) throw new Error("\u6CA1\u6709\u627E\u5230 SKILL.md\uFF1A\u8BF7\u9009\u62E9\u6280\u80FD\u6587\u4EF6\u5939\u672C\u8EAB\uFF0C\u6216\u5305\u542B\u8BE5\u6587\u4EF6\u5939\u7684 ZIP");
  const shallowest = Math.min(...folders.map(depth));
  const candidates = folders.filter((folder2) => depth(folder2) === shallowest);
  if (candidates.length > 1) throw new Error(`\u4E0A\u4F20\u5185\u5BB9\u91CC\u5305\u542B ${candidates.length} \u4E2A\u6280\u80FD\uFF08${candidates.map((folder2) => folder2.split("/").pop()).join("\u3001")}\uFF09\uFF0C\u8BF7\u4E00\u6B21\u53EA\u5BFC\u5165\u4E00\u4E2A`);
  const base2 = candidates[0];
  const folder = safeSkillName(options?.name || base2.split("/").pop());
  if (!folder) throw new Error("\u6280\u80FD\u540D\u79F0\u53EA\u80FD\u4F7F\u7528\u82F1\u6587\u3001\u6570\u5B57\u3001\u70B9\u3001\u4E0B\u5212\u7EBF\u548C\u77ED\u6A2A\u7EBF\uFF0C\u8BF7\u5728\u300C\u5BFC\u5165\u540D\u79F0\u300D\u91CC\u586B\u5199\u4E00\u4E2A");
  const target = join(root.path, folder);
  if (await exists(target)) throw new Error(`${folder} \u5DF2\u5B58\u5728\uFF1A\u8BF7\u6362\u4E2A\u540D\u79F0\uFF0C\u6216\u5148\u5220\u9664\u540C\u540D\u6280\u80FD`);
  const prefix = base2 ? `${base2}/` : "";
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
      if (!destination.toLowerCase().startsWith(resolve(stage).toLowerCase() + sep)) throw new Error(`\u975E\u6CD5\u6587\u4EF6\u8DEF\u5F84\uFF1A${relative}`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, entry.content);
      written += 1;
      bytes += entry.content.length;
    }
    if (!written) throw new Error("\u6280\u80FD\u6587\u4EF6\u5939\u91CC\u6CA1\u6709\u4EFB\u4F55\u6587\u4EF6");
    await writeFile(join(stage, ".helloai-import.json"), JSON.stringify({
      source: String(options?.source || "upload"),
      filename: options?.filename ? String(options.filename) : void 0,
      importedAt: (/* @__PURE__ */ new Date()).toISOString()
    }, null, 2), "utf8");
    await rename(stage, target);
    return { name: folder, folder, root: root.id, source: root.label, path: target, files: written, bytes };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => void 0);
    throw error;
  }
}
function reply(res, status, value) {
  const body2 = JSON.stringify({ ok: status < 400, data: value });
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body2) });
  res.end(body2);
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function applyTrace(line) {
  void writeFile(join(store(), "apply.log"), `${(/* @__PURE__ */ new Date()).toISOString()}  ${line}
`, { flag: "a" }).catch(() => void 0);
}
function apply(ctx) {
  applyTrace(`${BUILD_TAG} apply`);
  let mutation = Promise.resolve();
  const enqueue = (task) => {
    const next = mutation.then(task, task);
    mutation = next.catch(() => void 0);
    return next;
  };
  const findRepo = async (id) => (await jsonFile(repoFile(), [])).find((item) => item.id === id);
  const providerInvalidators = /* @__PURE__ */ new Set();
  const invalidateSkills = () => {
    scanCache = { at: 0, value: null };
    for (const invalidate of providerInvalidators) {
      try {
        invalidate();
      } catch {
      }
    }
  };
  const afterWrite = () => notifySkillsChanged(ctx, invalidateSkills);
  if (typeof ctx.effect === "function" && ctx.skills && typeof ctx.skills.registerProvider === "function") {
    try {
      ctx.effect(() => ctx.skills.registerProvider((control) => {
        providerInvalidators.add(control.invalidate);
        control.signal?.addEventListener?.("abort", () => providerInvalidators.delete(control.invalidate), { once: true });
        return externalSkillProvider(control);
      }), "helloai-skills external skill provider");
      applyTrace(`${BUILD_TAG} registerProvider ok`);
    } catch (error) {
      applyTrace(`${BUILD_TAG} registerProvider \u5931\u8D25\uFF1A${String(error?.message || error)}`);
      ctx.logger?.warn?.(`helloai-skills: \u6CE8\u518C\u6280\u80FD\u63D0\u4F9B\u8005\u5931\u8D25\uFF1A${String(error?.message || error)}`);
    }
  } else {
    applyTrace(`${BUILD_TAG} \u7F3A\u5C11 ctx.skills`);
    ctx.logger?.warn?.("helloai-skills: \u672A\u627E\u5230 ctx.skills\uFF0C\u5916\u90E8\u6280\u80FD\u76EE\u5F55\u53EA\u4F1A\u5728\u8BBE\u7F6E\u9875\u5C55\u793A");
  }
  const handler = async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname.endsWith("/state")) return reply(res, 200, await snapshot());
      if (req.method === "GET" && url.pathname.endsWith("/repositories")) return reply(res, 200, await jsonFile(repoFile(), []));
      if (req.method !== "POST") return reply(res, 405, { error: "method not allowed" });
      if (url.pathname.endsWith("/skills/import-upload")) {
        const buffer = await readBody(req);
        if (!buffer.length) throw new Error("\u6CA1\u6709\u6536\u5230\u4E0A\u4F20\u5185\u5BB9");
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
        if (url.pathname.endsWith("/note")) {
          const notes = await jsonFile(noteFile(), {});
          notes[String(input.id)] = String(input.note || "").trim();
          await save(noteFile(), notes);
          invalidateSkills();
          return await snapshot();
        }
        if (url.pathname.endsWith("/toggle")) {
          const policy = await jsonFile(policyFile(), {});
          policy[String(input.id)] = input.enabled === true;
          await save(policyFile(), policy);
          afterWrite();
          return await snapshot();
        }
        if (url.pathname.endsWith("/delete")) {
          const guard = deletableSkillTarget(input.path);
          if (guard.error) throw new Error(guard.error);
          await rm(guard.target, { recursive: true, force: true });
          afterWrite();
          return await snapshot();
        }
        if (url.pathname.endsWith("/skills/create")) {
          const root = knownRoots().find((item) => item.id === String(input.root || "dsh"));
          const name2 = safeSkillName(input.name);
          if (!root || !name2) throw new Error("\u6280\u80FD\u540D\u79F0\u53EA\u80FD\u4F7F\u7528\u82F1\u6587\u3001\u6570\u5B57\u3001\u70B9\u3001\u4E0B\u5212\u7EBF\u548C\u77ED\u6A2A\u7EBF\uFF0C\u4E14\u4E0D\u8D85\u8FC7 64 \u4E2A\u5B57\u7B26");
          const target = join(root.path, name2);
          await mkdir(root.path, { recursive: true });
          await mkdir(target, { recursive: false });
          const description = String(input.description || "").trim();
          const text = `---
name: ${slugForName(name2)}
description: ${description || "\u5F85\u8865\u5145\u6280\u80FD\u8BF4\u660E"}
---

# ${name2}

${description || "\u5728\u8FD9\u91CC\u586B\u5199\u6280\u80FD\u7684\u4F7F\u7528\u8BF4\u660E\u3002"}
`;
          await writeFile(join(target, "SKILL.md"), text, "utf8");
          afterWrite();
          return await snapshot();
        }
        if (url.pathname.endsWith("/skills/import")) {
          const source = resolve(String(input.path || ""));
          const sourceDoc = join(source, "SKILL.md");
          const sourceInfo = await stat(sourceDoc).catch(() => null);
          const root = knownRoots().find((item) => item.id === String(input.root || "dsh"));
          const name2 = safeSkillName(input.name || source.split(/[\\/]/).pop());
          if (!root || !name2 || !sourceInfo?.isFile()) throw new Error("\u8BF7\u9009\u62E9\u5305\u542B SKILL.md \u7684\u6280\u80FD\u6587\u4EF6\u5939\uFF0C\u5E76\u586B\u5199\u6709\u6548\u540D\u79F0");
          const target = join(root.path, name2);
          await mkdir(root.path, { recursive: true });
          if (resolve(source).toLowerCase() === resolve(target).toLowerCase()) throw new Error("\u6E90\u76EE\u5F55\u548C\u76EE\u6807\u76EE\u5F55\u4E0D\u80FD\u76F8\u540C");
          await cp(source, target, { recursive: true, errorOnExist: true });
          afterWrite();
          return await snapshot();
        }
        if (url.pathname.endsWith("/repositories/add")) {
          const urlValue = safeRepositoryUrl(input.url);
          const name2 = String(input.name || "").trim();
          if (!urlValue || !name2 || name2.length > 80) throw new Error("\u8BF7\u586B\u5199\u6709\u6548\u7684 HTTP/HTTPS \u4ED3\u5E93\u5730\u5740\u548C\u4ED3\u5E93\u540D\u79F0");
          const list = await jsonFile(repoFile(), []);
          if (list.some((item) => item.url === urlValue)) throw new Error("\u8FD9\u4E2A\u4ED3\u5E93\u5DF2\u7ECF\u6DFB\u52A0\u8FC7\u4E86");
          const entry = { id: randomUUID(), name: name2, url: urlValue, icon: String(input.icon || "\u25C8"), updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
          list.push(entry);
          await save(repoFile(), list);
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
          await rm(catalogCacheFile(String(input.id)), { force: true }).catch(() => void 0);
          return list;
        }
        if (url.pathname.endsWith("/repositories/catalog") || url.pathname.endsWith("/repositories/skills")) {
          const repo = await findRepo(input.id);
          if (!repo) throw new Error("\u4ED3\u5E93\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5237\u65B0\u5217\u8868");
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
          if (!repo) throw new Error("\u4ED3\u5E93\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5237\u65B0\u5217\u8868");
          const installed = await installSkill(repo, input);
          afterWrite();
          return { installed, state: await snapshot() };
        }
        if (url.pathname.endsWith("/repositories/update")) {
          const list = await jsonFile(repoFile(), []);
          const index = list.findIndex((item) => item.id === input.id);
          if (index < 0) throw new Error("\u4ED3\u5E93\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5237\u65B0\u5217\u8868");
          const current = list[index];
          const nextUrl = safeRepositoryUrl(input.url ?? current.url);
          const nextName = String(input.name ?? current.name).trim();
          if (!nextUrl || !nextName || nextName.length > 80) throw new Error("\u8BF7\u586B\u5199\u6709\u6548\u7684 HTTP/HTTPS \u4ED3\u5E93\u5730\u5740\u548C\u4ED3\u5E93\u540D\u79F0");
          if (list.some((item, at) => at !== index && item.url === nextUrl)) throw new Error("\u8FD9\u4E2A\u4ED3\u5E93\u5730\u5740\u5DF2\u7ECF\u767B\u8BB0\u8FC7\u4E86");
          const urlChanged = nextUrl !== current.url;
          const next = { ...current, name: nextName, url: nextUrl, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
          if (urlChanged) {
            delete next.skillCount;
            delete next.ref;
            delete next.oid;
            delete next.syncedAt;
            await rm(catalogCacheFile(String(current.id)), { force: true }).catch(() => void 0);
          }
          list[index] = next;
          await save(repoFile(), list);
          return { repositories: list, urlChanged };
        }
        if (url.pathname.endsWith("/repositories/refresh")) {
          const list = await jsonFile(repoFile(), []);
          const ids = input.id ? [input.id] : list.map((item) => item.id);
          for (const id of ids) await rm(catalogCacheFile(String(id)), { force: true }).catch(() => void 0);
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
      const isCatalogRead = (url.pathname.endsWith("/repositories/catalog") || url.pathname.endsWith("/repositories/skills")) && input.refresh !== true;
      const result = isCatalogRead ? await runAction() : await enqueue(runAction);
      return reply(res, 200, result);
    } catch (error) {
      return reply(res, 500, { error: String(error?.message || error) });
    }
  };
  const mountApi = () => {
    try {
      return ctx.webServer.register({ kind: "prefix", path: "/api/dsh-helloai-skills", handler });
    } catch (error) {
      const text = String(error?.message ?? error);
      if (!text.includes('duplicate prefix route "/api/dsh-helloai-skills"')) throw error;
      ctx.logger?.warn?.("helloai-skills: \u590D\u7528\u5DF2\u6CE8\u518C\u7684 API \u8DEF\u7531\uFF08\u70ED\u91CD\u8F7D\uFF09");
      return () => {
      };
    }
  };
  if (typeof ctx.effect === "function") ctx.effect(mountApi, "helloai-skills api route");
  else mountApi();
}
function slugForName(name2) {
  return toKebab(name2) || name2.toLowerCase();
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
