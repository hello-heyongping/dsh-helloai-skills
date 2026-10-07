/**
 * dsh-helloai-skills 离线自测：验证插件在热重载下可重复应用、删除保护只作用于
 * DSH 技能目录，以及各个技能目录（DSH / CODEX / Trae …）都注册成了 DSH 可调用技能。
 *
 * 运行：node scripts/selftest.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pluginUrl = new URL("../lib/index.js", import.meta.url).href;
const mod = await import(pluginUrl);

let route = null;
let attempts = 0;
let provider = null;
const control = { signal: { addEventListener: () => undefined }, invalidate: () => undefined };
const ctx = {
  logger: { warn: (...args) => console.log("   warn:", args.join(" ")) },
  effect: (fn) => fn(),
  emit: () => undefined,
  get: () => undefined,
  skills: {
    registerProvider(create) {
      provider = create(control);
      return () => undefined;
    }
  },
  webServer: {
    register(candidate) {
      attempts += 1;
      if (attempts > 1) throw new Error('webserver: duplicate prefix route "/api/dsh-helloai-skills"');
      route = candidate;
      return () => {};
    }
  }
};

mod.apply(ctx);
mod.apply(ctx);
mod.apply(ctx);
const repeatable = attempts === 3 && route !== null;
console.log(`${repeatable ? "PASS" : "FAIL"}  重复应用：register 调用 ${attempts} 次，未抛错`);

async function call(method, suffix, payload) {
  const req = (async function* () {
    if (payload !== undefined) yield Buffer.from(JSON.stringify(payload));
  })();
  req.method = method;
  req.url = `/api/dsh-helloai-skills${suffix}`;
  let out = null;
  const res = {
    writeHead(status) { out = { status, body: "" }; },
    end(chunk) { if (out && chunk) out.body = chunk.toString(); }
  };
  await route.handler(req, res);
  return JSON.parse(out.body);
}

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const skillsRoot = path.join(dshHome, "skills");
const probe = path.join(skillsRoot, "__helloai_selftest__");
fs.mkdirSync(probe, { recursive: true });
fs.writeFileSync(path.join(probe, "SKILL.md"), "---\nname: helloai-selftest\ndescription: 临时探针\n---\n\n# 探针\n", "utf8");

const state = (await call("GET", "/state")).data;
const listed = state.skills.some((skill) => skill.path === probe);
console.log(`${listed ? "PASS" : "FAIL"}  /state 扫描到探针技能（共 ${state.skills.length} 个技能 / ${state.groups.length} 个来源）`);
const sourceLabels = state.groups.map((group) => `${group.label}${group.callable ? "(可调用)" : "(原生)"}`).join("、");
console.log(`   来源：${sourceLabels || "(空)"}`);

const empty = await call("POST", "/delete", {});
const emptyRefused = empty.ok === false && fs.existsSync(probe);
console.log(`${emptyRefused ? "PASS" : "FAIL"}  空路径删除被拒绝（status ${empty.status ?? 500}），技能目录未被删除`);

const outside = await call("POST", "/delete", { path: path.parse(dshHome).root });
const outsideRefused = outside.ok === false;
console.log(`${outsideRefused ? "PASS" : "FAIL"}  根目录之外删除被拒绝`);

const removal = await call("POST", "/delete", { path: probe });
const removed = removal.ok === true && !fs.existsSync(probe);
console.log(`${removed ? "PASS" : "FAIL"}  合法技能删除成功`);

// --- 外部技能来源 -> DSH 可调用技能 -----------------------------------------
const hasProvider = Boolean(provider) && typeof provider.list === "function" && typeof provider.get === "function";
console.log(`${hasProvider ? "PASS" : "FAIL"}  注册 ctx.skills 提供者（${provider?.name || "无"}）`);

let candidates = [];
if (hasProvider) {
  const listedCandidates = await provider.list({});
  candidates = Array.isArray(listedCandidates) ? listedCandidates : listedCandidates?.candidates || [];
}
// 探针在上一段已经被删掉，所以这里必须重新取一次 /state，不能复用旧快照。
const stateBeforeProvider = (await call("GET", "/state")).data;
const external = stateBeforeProvider.skills.filter((skill) => skill.callable);
// 提供者会跳过停用技能，并对同名技能只保留优先级最高的那个来源；
// /state 是完整清单，所以按同样的规则折算出「应该被注册的名字」。
const expectedNames = [];
const expectedSeen = new Set();
for (const skill of external) {
  if (!skill.enabled || expectedSeen.has(skill.slug)) continue;
  expectedSeen.add(skill.slug);
  expectedNames.push(skill.slug);
}
const actualNames = candidates.map((candidate) => candidate.name).sort();
const providerMatches = actualNames.join() === expectedNames.slice().sort().join();
console.log(`${providerMatches ? "PASS" : "FAIL"}  提供者与 /state 的可调用技能一致（${candidates.length} vs ${expectedNames.length}）`);

const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const malformed = candidates.filter((candidate) => {
  if (!kebab.test(candidate.name)) return true;
  if (typeof candidate.description !== "string" || !candidate.description) return true;
  if (candidate.provider !== provider.name) return true;
  if (typeof candidate.rank !== "number" || !Number.isFinite(candidate.rank)) return true;
  if (typeof candidate.source !== "string") return true;
  const policy = candidate.invocation;
  return !policy || typeof policy.modelInvocable !== "boolean" || typeof policy.userInvocable !== "boolean";
});
console.log(`${!malformed.length ? "PASS" : "FAIL"}  候选技能符合 DSH 校验（${malformed.map((item) => item.name).join(", ") || "全部合规"}）`);

if (candidates.length) {
  const sample = candidates.find((candidate) => candidate.source.includes("codex")) || candidates[0];
  const loaded = await provider.get(sample, {});
  const loadable = Boolean(loaded && loaded.name === sample.name && typeof loaded.content === "string" && loaded.content.length > 0 && loaded.provider === provider.name);
  console.log(`${loadable ? "PASS" : "FAIL"}  provider.get 载入技能正文：${sample.name}（${loaded?.content?.length ?? 0} 字符）`);
  console.log(`   例：${candidates.slice(0, 6).map((candidate) => `/${candidate.name}`).join(" ")}`);
} else {
  console.log("SKIP  本机没有 DSH 之外的可调用技能目录");
}

if (fs.existsSync(probe)) fs.rmSync(probe, { recursive: true, force: true });

// --- 浏览器上传导入：ZIP 与文件夹清单 ---------------------------------------
/** 只写不压缩的极简 ZIP 打包器：够验证宿主那份读取器即可（CRC 不参与校验）。 */
function storeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [path, text] of entries) {
    const name = Buffer.from(path, "utf8");
    const data = Buffer.from(text, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名字
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function callRaw(suffix, buffer) {
  const req = (async function* () { yield buffer; })();
  req.method = "POST";
  req.url = `/api/dsh-helloai-skills${suffix}`;
  let out = null;
  const res = {
    writeHead(status) { out = { status, body: "" }; },
    end(chunk) { if (out && chunk) out.body = chunk.toString(); }
  };
  await route.handler(req, res);
  return JSON.parse(out.body);
}

const uploaded = [];
const zipTarget = path.join(skillsRoot, "helloai-selftest-zip");
const zip = storeZip([
  ["helloai-selftest-zip/SKILL.md", "---\nname: selftest-zip\ndescription: 上传探针\n---\n\n# 上传探针\n"],
  ["helloai-selftest-zip/notes/readme.txt", "hello\n"],
  ["__MACOSX/._SKILL.md", "junk\n"]
]);
const zipReply = await callRaw(`/skills/import-upload?root=dsh&name=helloai-selftest-zip&filename=probe.zip`, zip);
uploaded.push(zipTarget);
const zipOk = zipReply.ok === true
  && fs.existsSync(path.join(zipTarget, "SKILL.md"))
  && fs.existsSync(path.join(zipTarget, "notes", "readme.txt"))
  && !fs.existsSync(path.join(zipTarget, "__MACOSX"))
  && fs.existsSync(path.join(zipTarget, ".helloai-import.json"));
console.log(`${zipOk ? "PASS" : "FAIL"}  ZIP 上传解包导入（${zipReply.data?.installed?.files ?? 0} 个文件，来源标记 ${zipReply.data?.installed?.source ?? "无"}）`);

const listedAfterUpload = (await call("GET", "/state")).data.skills.some((skill) => skill.path === zipTarget);
console.log(`${listedAfterUpload ? "PASS" : "FAIL"}  上传导入的技能出现在 /state`);

const folderTarget = path.join(skillsRoot, "helloai-selftest-folder");
const folderReply = await call("POST", "/skills/import-files", {
  root: "dsh",
  name: "helloai-selftest-folder",
  files: [
    { path: "picked/SKILL.md", data: Buffer.from("---\nname: selftest-folder\ndescription: 文件夹探针\n---\n").toString("base64") },
    { path: "picked/assets/logo.svg", data: Buffer.from("<svg/>").toString("base64") }
  ]
});
uploaded.push(folderTarget);
const folderOk = folderReply.ok === true && fs.existsSync(path.join(folderTarget, "SKILL.md")) && fs.existsSync(path.join(folderTarget, "assets", "logo.svg"));
console.log(`${folderOk ? "PASS" : "FAIL"}  文件夹清单上传导入（外层目录 ${folderReply.data?.installed?.folder ?? "无"}）`);

const noSkill = await callRaw(`/skills/import-upload?root=dsh&name=helloai-selftest-noskill`, storeZip([["readme.txt", "no skill here"]]));
console.log(`${noSkill.ok === false ? "PASS" : "FAIL"}  没有 SKILL.md 的压缩包被拒绝：${noSkill.data?.error ?? noSkill.error ?? ""}`);

const many = storeZip([["a/SKILL.md", "# a\n"], ["b/SKILL.md", "# b\n"]]);
const twoSkills = await callRaw(`/skills/import-upload?root=dsh&name=helloai-selftest-two`, many);
console.log(`${twoSkills.ok === false ? "PASS" : "FAIL"}  一次导入两个技能被拒绝：${twoSkills.data?.error ?? twoSkills.error ?? ""}`);

const escapee = path.join(dshHome, "__helloai_escape__.txt");
const traversal = await callRaw(`/skills/import-upload?root=dsh&name=helloai-selftest-evil`, storeZip([["../__helloai_escape__.txt", "x"]]));
const traversalSafe = traversal.ok === false && !fs.existsSync(escapee);
console.log(`${traversalSafe ? "PASS" : "FAIL"}  路径穿越成员被拦下（未写出 ${path.basename(escapee)}）`);

const duplicate = await callRaw(`/skills/import-upload?root=dsh&name=helloai-selftest-zip`, zip);
console.log(`${duplicate.ok === false ? "PASS" : "FAIL"}  同名技能已存在时拒绝覆盖：${duplicate.data?.error ?? duplicate.error ?? ""}`);

const externalGuard = await callRaw(`/skills/import-upload?root=does-not-exist&name=helloai-selftest-external`, storeZip([["SKILL.md", "# x\n"]]));
console.log(`${externalGuard.ok === false ? "PASS" : "FAIL"}  未知技能来源被拒绝：${externalGuard.data?.error ?? externalGuard.error ?? ""}`);

/* ---------------- 仓库登记信息：修改（/repositories/update） ---------------- */
// 这一段用临时 DSH_HOME：既不动真实 ~/.dsh 里的仓库列表，也不触发回源网络请求，
// 只验证登记信息本身的校验与落盘。
const repoHome = fs.mkdtempSync(path.join(os.tmpdir(), "helloai-repo-"));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = repoHome;
const repoStore = path.join(repoHome, "helloai-skills");
fs.mkdirSync(repoStore, { recursive: true });
const seeded = [
  { id: "repo-a", name: "旧名字", url: "https://github.com/example/skills", icon: "◈", updatedAt: new Date().toISOString() },
  { id: "repo-b", name: "另一个", url: "https://github.com/example/other", icon: "◈", updatedAt: new Date().toISOString() }
];
fs.writeFileSync(path.join(repoStore, "repositories.json"), JSON.stringify(seeded, null, 2), "utf8");

const renamed = await call("POST", "/repositories/update", { id: "repo-a", name: "新名字", url: "https://github.com/example/skills" });
const renamedOk = renamed.ok === true && renamed.data?.repositories?.find((item) => item.id === "repo-a")?.name === "新名字";
console.log(`${renamedOk ? "PASS" : "FAIL"}  修改仓库名称`);

const moved = await call("POST", "/repositories/update", { id: "repo-a", name: "新名字", url: "https://github.com/example/moved" });
const movedOk = moved.ok === true && moved.data?.urlChanged === true && moved.data?.repositories?.find((item) => item.id === "repo-a")?.url === "https://github.com/example/moved";
console.log(`${movedOk ? "PASS" : "FAIL"}  修改仓库地址（并标记旧目录缓存失效）`);

const repoDupe = await call("POST", "/repositories/update", { id: "repo-a", name: "新名字", url: "https://github.com/example/other" });
console.log(`${repoDupe.ok === false ? "PASS" : "FAIL"}  改到已登记过的地址被拒绝：${repoDupe.data?.error ?? ""}`);

const repoBadUrl = await call("POST", "/repositories/update", { id: "repo-a", name: "新名字", url: "ftp://example.com/x" });
console.log(`${repoBadUrl.ok === false ? "PASS" : "FAIL"}  非 HTTP(S) 地址被拒绝：${repoBadUrl.data?.error ?? ""}`);

const repoMissing = await call("POST", "/repositories/update", { id: "does-not-exist", name: "x", url: "https://github.com/example/x" });
console.log(`${repoMissing.ok === false ? "PASS" : "FAIL"}  修改不存在的仓库被拒绝：${repoMissing.data?.error ?? ""}`);

process.env.DSH_HOME = previousHome;
fs.rmSync(repoHome, { recursive: true, force: true });

for (const target of uploaded) fs.rmSync(target, { recursive: true, force: true });
if (fs.existsSync(escapee)) fs.rmSync(escapee, { force: true });

if (!repeatable || !listed || !emptyRefused || !outsideRefused || !removed || !hasProvider || malformed.length || !providerMatches) process.exitCode = 1;
if (!zipOk || !listedAfterUpload || !folderOk || noSkill.ok !== false || twoSkills.ok !== false || !traversalSafe || duplicate.ok !== false || externalGuard.ok !== false) process.exitCode = 1;
if (!renamedOk || !movedOk || repoDupe.ok !== false || repoBadUrl.ok !== false || repoMissing.ok !== false) process.exitCode = 1;
