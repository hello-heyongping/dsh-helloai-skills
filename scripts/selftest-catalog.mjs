/**
 * dsh-helloai-skills 联网自测：仓库 → 技能目录 → 安装到 DSH 技能根目录。
 *
 * 运行：node scripts/selftest-catalog.mjs [仓库地址]
 * 默认使用 https://github.com/anbeime/skill。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoUrl = process.argv[2] || "https://github.com/anbeime/skill";
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "helloai-catalog-"));
process.env.DSH_HOME = sandbox;

const mod = await import(new URL("../lib/index.js", import.meta.url).href);

let route = null;
const ctx = {
  logger: { warn: (...args) => console.log("   warn:", args.join(" ")) },
  effect: (fn) => fn(),
  webServer: { register(candidate) { route = candidate; return () => {}; } }
};
mod.apply(ctx);
if (!route) { console.log("FAIL  未注册 API 路由"); process.exit(1); }

async function call(method, suffix, payload) {
  const req = (async function* () { if (payload !== undefined) yield Buffer.from(JSON.stringify(payload)); })();
  req.method = method;
  req.url = `/api/dsh-helloai-skills${suffix}`;
  let out = null;
  const res = { writeHead(status) { out = { status, body: "" }; }, end(chunk) { if (out && chunk) out.body = chunk.toString(); } };
  await route.handler(req, res);
  const parsed = JSON.parse(out.body);
  return { status: out.status, ok: parsed.ok, data: parsed.data };
}

const failures = [];
function check(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

console.log(`仓库：${repoUrl}\nDSH_HOME：${sandbox}\n`);

const added = await call("POST", "/repositories/add", { name: "selftest", url: repoUrl });
check("添加仓库成功", added.status === 200 && added.data.repositories?.length === 1, JSON.stringify(added.data).slice(0, 200));
const repoId = added.data.repositories?.[0]?.id;
if (added.data.warning) console.log(`   首次解析提示：${added.data.warning}`);

const started = Date.now();
const catalog = await call("POST", "/repositories/catalog", { id: repoId });
const seconds = ((Date.now() - started) / 1000).toFixed(1);
check("读取仓库技能目录", catalog.status === 200 && catalog.data.skills?.length > 0, `${catalog.data.skills?.length ?? 0} 个技能 / ${seconds}s / 策略 ${catalog.data.strategy} / ref ${catalog.data.ref}`);
check("响应不等待技能说明", catalog.data.filled === true || Number(seconds) < 25, `${seconds}s，待补充 ${catalog.data.pending} 条`);

let described = catalog.data;
for (let round = 0; round < 25 && !described.filled; round += 1) {
  await new Promise((done) => setTimeout(done, 3000));
  described = (await call("POST", "/repositories/catalog", { id: repoId })).data;
  if (round === 2) check("说明是边抓边落的", (described.skills || []).some((skill) => skill.description), `${(described.skills || []).filter((skill) => skill.description).length} 条已就绪`);
}
const withDescription = (described.skills || []).filter((skill) => skill.description).length;
check("SKILL.md 描述后台补齐", withDescription > 0, `${withDescription}/${described.skills?.length ?? 0} 个技能带说明，剩余待补 ${described.pending}`);
for (const skill of (described.skills || []).slice(0, 5)) console.log(`   · ${skill.name}  [${skill.fileCount} 文件]  ${skill.description?.slice(0, 56) || "(无说明)"}`);

const cached = await call("POST", "/repositories/catalog", { id: repoId });
check("目录缓存命中", cached.status === 200 && cached.data.cached === true);

// 本地优先：把网络掐掉，列表仍要能读出来（缓存在 $DSH_HOME/helloai-skills/cache）。
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("offline"); };
const offline = await call("POST", "/repositories/catalog", { id: repoId, descriptions: false });
globalThis.fetch = realFetch;
check("断网时仍读本地缓存", offline.status === 200 && offline.data.cached === true && offline.data.skills?.length > 0, offline.data.error || "");

const repoList = await call("GET", "/repositories");
const summary = (repoList.data || []).find((item) => item.id === repoId);
check("仓库记录里存了同步摘要", Boolean(summary?.skillCount) && Boolean(summary?.syncedAt), `${summary?.skillCount ?? 0} 个技能 / ${summary?.syncedAt ?? "无"}`);

const target = [...(described.skills || catalog.data.skills || [])].sort((left, right) => left.fileCount - right.fileCount)[0];
const installed = await call("POST", "/skills/install", { id: repoId, path: target.path });
const installedDir = path.join(sandbox, "skills", target.folder);
check("安装技能到 DSH", installed.status === 200 && fs.existsSync(path.join(installedDir, "SKILL.md")), `${target.name} → ${installedDir}`);
check("写入来源标记", fs.existsSync(path.join(installedDir, ".helloai-source.json")));

const state = await call("GET", "/state");
check("/state 中出现已安装技能", (state.data.skills || []).some((skill) => skill.path === installedDir));

const again = await call("POST", "/skills/install", { id: repoId, path: target.path });
check("重复安装被拒绝", again.status >= 400 && /已经存在/.test(again.data.error || ""), again.data.error || "");

const removed = await call("POST", "/delete", { path: installedDir });
check("删除已安装技能", removed.status === 200 && !fs.existsSync(installedDir));

let listed = await call("POST", "/repositories/catalog", { id: repoId, refresh: true });
if (listed.status !== 200 || listed.data.error) listed = await call("POST", "/repositories/catalog", { id: repoId, refresh: true });
check("强制刷新仓库", listed.status === 200 && listed.data.cached === false && listed.data.skills?.length > 0, listed.data.error || "");

await call("POST", "/repositories/remove", { id: repoId });
fs.rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${failures.length ? `FAILED: ${failures.join(" / ")}` : "ALL PASS"}`);
if (failures.length) process.exitCode = 1;
