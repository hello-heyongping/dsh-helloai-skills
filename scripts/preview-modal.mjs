/**
 * 组件级预览：用 jsdom + 真实 React 渲染 lib/client.js 里的技能面板，点开
 * 「导入本地技能」弹窗并截图，用来核对新加的「浏览文件夹 / 选择 ZIP」这一行。
 *
 * 运行：node scripts/preview-modal.mjs
 * React / react-dom / jsdom 从隔壁插件（dsh-helloai-bak）的依赖里取，本插件保持零依赖。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const plugin = path.resolve(here, "..");
const workspace = path.resolve(plugin, "..");
const deps = createRequire(path.join(workspace, "dsh-helloai-bak", "package.json"));
const React = deps("react");
const jsxRuntime = deps("react/jsx-runtime");
const { createRoot } = deps("react-dom/client");
const { JSDOM } = deps("jsdom");
const requireModule = (name) => (name === "react" ? React : name === "react/jsx-runtime" ? jsxRuntime : undefined);

const output = path.join(os.tmpdir(), "helloai-preview");
fs.mkdirSync(output, { recursive: true });

function findChrome() {
  const candidates = [];
  if (process.env.DSH_PREVIEW_CHROME) candidates.push(process.env.DSH_PREVIEW_CHROME);
  const playwright = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  if (fs.existsSync(playwright)) {
    for (const entry of fs.readdirSync(playwright)) {
      if (!entry.startsWith("chromium")) continue;
      for (const nested of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        candidates.push(path.join(playwright, entry, nested));
      }
    }
  }
  candidates.push("C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe");
  return candidates.find((candidate) => fs.existsSync(candidate));
}

// 1) 真实面板 CSS + DSH 主题令牌（+ 松绿预览覆盖）
const bundle = fs.readFileSync(path.join(plugin, "lib", "client.js"), "utf8");
// 取到弹窗后面那几条「常用仓库」菜单样式为止：只截到 .his-modal-actions 的话，
// 菜单会以无样式的裸按钮出现在截图里，看着像是坏了。
const cssMatch = bundle.match(/\.his-panel\{[\s\S]*?\.his-preset-item-url\{[^}]*\}/);
if (!cssMatch) throw new Error("lib/client.js 里没有找到面板 CSS（含常用仓库菜单），请先运行 node scripts/build.mjs");
const panelCss = cssMatch[0];

const tokenFile = path.join(workspace, ".cache", "dsh-ref", "dsw-tokens.json");
let tokenCss = ":root{--dsw-alias-bg-base:#232e2d;--dsw-alias-bg-layer-1:#232e2d;--dsw-alias-bg-layer-2:#283332;--dsw-alias-bg-layer-3:#2c3836;--dsw-alias-label-primary:#ccd8d3;--dsw-alias-label-secondary:#a9b5b0;--dsw-alias-label-tertiary:#9aa6a1;--dsw-alias-label-primary-foreground:#131a19;--dsw-alias-link:#4cb08a;--dsw-alias-button-info-fill:#4cb08a;--dsw-alias-button-info-hover:#2f8f6b;--dsw-alias-border-l1:#ffffff0f;--dsw-alias-border-l2:#ffffff1f;--dsw-alias-border-l3:#ffffff29;--dsw-alias-interactive-bg-hover:#ffffff14;--dsw-alias-interactive-bg-active:#ffffff24;--dsw-alias-state-success-primary:#a6d189;--dsw-alias-state-error-primary:#e78284;--dsw-alias-interactive-bg-hover-danger:#f25a5a26;--dsw-alias-bg-base-hover:#ffffff14}";
if (fs.existsSync(tokenFile)) {
  const tokens = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  const body = (map) => Object.entries(map ?? {}).map(([key, value]) => `  --${key}: ${value};`).join("\n");
  tokenCss = `:root[data-theme="dark"]{\n${body(tokens.dark_static)}\n${body(tokens.dark_alias)}\n${body(tokens.dark_specific)}\n}`;
}

// 2) 用真实组件渲染（接口桩）
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://127.0.0.1:19387/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.FileReader = dom.window.FileReader;
globalThis.File = dom.window.File;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

const STATE = {
  ok: true,
  data: {
    capabilities: { uploadImport: true },
    skills: [
      { id: "dsh:web-search", name: "web-search", description: "联网检索并汇总来源。", source: "DSH", callable: true, path: "C:\\Users\\me\\.dsh\\skills\\web-search", enabled: true },
      { id: "codex:gotoweb", name: "gotoweb", description: "打开网页并抓取正文。", source: "CODEX", callable: true, path: "C:\\Users\\me\\.codex\\skills\\gotoweb", enabled: true }
    ],
    groups: [
      { id: "dsh", label: "DSH", tone: "#4cb08a", callable: true, skills: [{ id: "dsh:web-search", name: "web-search", description: "联网检索并汇总来源。", source: "DSH", callable: true, path: "C:\\Users\\me\\.dsh\\skills\\web-search", enabled: true }] },
      { id: "codex", label: "CODEX", tone: "#7aaaff", callable: true, skills: [{ id: "codex:gotoweb", name: "gotoweb", description: "打开网页并抓取正文。", source: "CODEX", callable: true, path: "C:\\Users\\me\\.codex\\skills\\gotoweb", enabled: true }] }
    ]
  }
};
const calls = [];
const json = (data, ok = true, status = 200) => ({ ok, status, json: async () => ({ ok, data }) });
dom.window.fetch = globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  if (String(url).endsWith("/state")) return json(STATE.data);
  if (String(url).endsWith("/repositories")) return json([]);
  return json({ installed: { name: "web-search", files: 2, source: "DSH" }, state: STATE.data });
};

let loaded;
dom.window.__ModuleLoader__ = { load: ({ factory }) => { loaded = factory(requireModule); } };
new Function("window", "document", "require", "module", "exports", bundle)(dom.window, dom.window.document, requireModule, { exports: {} }, {});
if (!loaded?.apply) throw new Error("client bundle 没有导出 apply()");

let registered;
loaded.apply({
  slots: { inject: (_name, factory) => factory(), register: (_options, component) => { registered = component; } }
});

const root = createRoot(document.getElementById("root"));
root.render(React.createElement(registered, { t: (key) => key }));
const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
await settle(400);

const buttons = () => [...document.querySelectorAll("button")];
const click = (label) => {
  const target = buttons().find((element) => (element.textContent || "").includes(label));
  if (!target) throw new Error(`没有找到按钮：${label}`);
  target.click();
};

/** 选中一个文件：把 files 挂到 input 上再派发 change，走真实的 onChange 分支。 */
function pickFile(input, file, extra = {}) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  for (const [key, value] of Object.entries(extra)) Object.defineProperty(file, key, { value, configurable: true });
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

const shots = [];
const shell = (mode, body) => `<!doctype html><html lang="zh-CN" data-theme="${mode}"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;padding:26px 30px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:"Microsoft YaHei",system-ui,sans-serif}
${tokenCss}
${panelCss}
</style></head><body>${body}</body></html>`;

const chrome = findChrome();
async function shoot(name, mode, body, size) {
  const page = path.join(output, `${name}.html`);
  fs.writeFileSync(page, shell(mode, body), "utf8");
  if (!chrome) return console.log("没找到 Chrome/Chromium，仅生成 HTML：", page);
  execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${size}`, `--screenshot=${path.join(output, `${name}.png`)}`, `file:///${page.replace(/\\/g, "/")}`], { stdio: "ignore" });
  shots.push(path.join(output, `${name}.png`));
}

// 3) 默认弹窗 + 选中 ZIP 的弹窗
click("导入");
await settle();
await shoot("modal-default", "dark", document.getElementById("root").innerHTML, "720,560");

const zipInput = document.querySelector('input[type="file"][accept*="zip"]');
if (!zipInput) throw new Error("弹窗里没有 ZIP 文件输入框");
pickFile(zipInput, new dom.window.File([Buffer.alloc(2048, 7)], "web-search.zip", { type: "application/zip" }));
await settle();
if (!document.body.textContent.includes("已选择压缩包")) throw new Error("选择 ZIP 后没有显示已选文件");
await shoot("modal-zip", "dark", document.getElementById("root").innerHTML, "720,560");

// 提交 ZIP：必须走 /skills/import-upload，body 是原始字节，名字取自「导入名称」。
calls.length = 0;
click("开始导入");
await settle(400);
const zipCall = calls.find((entry) => entry.url.includes("/skills/import-upload"));
if (!zipCall) throw new Error(`ZIP 导入没有调用上传接口：${calls.map((entry) => entry.url).join(", ")}`);
if (!zipCall.url.includes("root=dsh") || !zipCall.url.includes("name=web-search") || !zipCall.url.includes("filename=web-search.zip")) throw new Error(`上传参数不对：${zipCall.url}`);
if (!String(zipCall.init.headers?.["content-type"] || "").includes("zip")) throw new Error("ZIP 上传的 content-type 不是 zip");
const sent = zipCall.init.body;
if (!(sent instanceof ArrayBuffer) || sent.byteLength !== 2048) throw new Error(`ZIP 上传的字节数不对：${sent?.byteLength ?? typeof sent}`);
console.log("PASS  ZIP 导入：POST /skills/import-upload，原始字节 2048 B，name=web-search");

// 4) 浏览文件夹：模拟 webkitRelativePath
click("导入");
await settle();
const folderInput = [...document.querySelectorAll('input[type="file"]')].find((element) => element.hasAttribute("webkitdirectory"));
if (!folderInput) throw new Error("弹窗里没有文件夹输入框（webkitdirectory）");
const files = [
  Object.assign(new dom.window.File(["---\nname: web-search\ndescription: 联网检索\n---\n"], "SKILL.md", { type: "text/markdown" }), { webkitRelativePath: "web-search/SKILL.md" }),
  Object.assign(new dom.window.File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }), { webkitRelativePath: "web-search/assets/logo.svg" })
];
Object.defineProperty(folderInput, "files", { value: files, configurable: true });
folderInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
await settle(400);
if (!document.body.textContent.includes("已选择文件夹")) throw new Error("选择文件夹后没有显示已选目录");
if (!document.body.textContent.includes("web-search（2 个文件")) throw new Error("已选目录的文件数不对");
await shoot("modal-folder", "dark", document.getElementById("root").innerHTML, "720,560");

calls.length = 0;
click("开始导入");
await settle(400);
const folderCall = calls.find((entry) => entry.url.includes("/skills/import-files"));
if (!folderCall) throw new Error("文件夹导入没有调用 /skills/import-files");
const payload = JSON.parse(String(folderCall.init.body));
if (payload.root !== "dsh" || payload.files.length !== 2) throw new Error(`文件夹清单不对：${String(folderCall.init.body).slice(0, 120)}`);
const manifest = payload.files.find((file) => file.path.endsWith("assets/logo.svg"));
if (!manifest || Buffer.from(manifest.data, "base64").toString("utf8") !== "<svg/>") throw new Error("文件夹清单里的 base64 内容不对");
console.log("PASS  文件夹导入：POST /skills/import-files，2 个文件（含 assets/logo.svg 的 base64 正文）");

// 5) 仓库 tab：「修改」必须带着该 tab 的名称与地址打开，并真的 POST /repositories/update。
//    这条是回归测试：曾经把 onEdit 直接当 onClick，React 把点击事件当成了仓库对象，
//    于是弹窗里名称/地址是空的，点了保存也不会有任何变化。
const REPO = { id: "repo-1", name: "anbeime_skill", url: "https://github.com/anbeime/skill", icon: "◈" };
const MOVED = { ...REPO, url: "https://github.com/anbeime/moved" };
let repoState = REPO;
dom.window.fetch = globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  if (String(url).endsWith("/repositories/catalog")) return json({ repository: repoState, ref: "main", oid: "7fd9e02", cached: true, pending: 0, skills: [] });
  if (String(url).endsWith("/repositories/update")) { repoState = MOVED; return json({ repositories: [MOVED], urlChanged: true }); }
  if (String(url).endsWith("/repositories")) return json([repoState]);
  return json({ installed: { name: "web-search", files: 2, source: "DSH" }, state: STATE.data });
};

click("仓库");
await settle(400);
click("修改");
await settle(300);
const nameInput = document.getElementById("his-repo-name");
const urlInput = document.getElementById("his-repo-url");
if (!nameInput || !urlInput) throw new Error("「修改」没有打开仓库弹窗");
if (nameInput.value !== REPO.name || urlInput.value !== REPO.url) throw new Error(`「修改」没有带上当前仓库信息：name=${nameInput.value} url=${urlInput.value}`);
console.log(`PASS  修改仓库：弹窗预填 ${nameInput.value} / ${urlInput.value}`);
await shoot("modal-repo-edit", "dark", document.getElementById("root").innerHTML, "720,560");

calls.length = 0;
click("保存修改");
await settle(500);
const updateCall = calls.find((entry) => entry.url.includes("/repositories/update"));
if (!updateCall) throw new Error(`「保存修改」没有调用 /repositories/update：${calls.map((entry) => entry.url).join(", ")}`);
const updatePayload = JSON.parse(String(updateCall.init.body));
if (updatePayload.id !== REPO.id || updatePayload.name !== REPO.name || updatePayload.url !== REPO.url) throw new Error(`修改请求体不对：${String(updateCall.init.body)}`);
console.log("PASS  修改仓库：POST /repositories/update 带上 id/name/url");

// 保存后只刷新登记列表（tab 名称要跟着变），但绝不能顺手回源下载技能列表 ——
// 下载只由「刷新」触发；地址变了就把本地列表作废并提示。
if (!calls.some((entry) => entry.url.endsWith("/repositories"))) throw new Error("保存修改后没有重新读取仓库列表，tab 名称不会更新");
const catalogAfter = calls.filter((entry) => entry.url.includes("/repositories/catalog"));
if (catalogAfter.length) throw new Error(`保存修改后不该自动回源下载：${catalogAfter.map((entry) => entry.url).join(", ")}`);
if (!document.body.textContent.includes("本地列表已作废")) throw new Error("改了地址后没有提示需要点「刷新」重新加载");
console.log("PASS  修改仓库：只有「刷新」才重新下载，改地址后列表作废并给提示");

// 6) 「仓库地址」右侧的常用仓库菜单：四个预设要能填表，名称只在空着时补，
//    点外面和按 Esc 都要关掉菜单。
const PRESETS = [
  { label: "anthropics/skills", url: "https://github.com/anthropics/skills", name: "Claude 官方技能库" },
  { label: "nextlevelbuilder/ui-ux-pro-max-skill", url: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill", name: "UI/UX Pro Max" },
  { label: "kevin0315/-skill", url: "https://github.com/kevin0315/-skill/tree/main", name: "中文技能商店" },
  { label: "ComposioHQ/awesome-claude-skills", url: "https://github.com/ComposioHQ/awesome-claude-skills", name: "Awesome Claude Skills" }
];
const menu = () => document.querySelector(".his-preset-menu");
const menuItems = () => [...document.querySelectorAll(".his-preset-item")];
const toggle = () => buttons().find((element) => (element.textContent || "").includes("常用仓库"));
const itemFor = (label) => menuItems().find((element) => (element.textContent || "").includes(label));
const press = (target, type, init) => target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, ...init }));

click("添加");
await settle();
if (!toggle()) throw new Error("添加仓库弹窗里没有「常用仓库」按钮");
if (toggle().getAttribute("aria-expanded") !== "false") throw new Error("菜单按钮初始 aria-expanded 应该是 false");
if (menu()) throw new Error("还没点开菜单，菜单就已经渲染出来了");

toggle().click();
await settle();
if (menuItems().length !== PRESETS.length) throw new Error(`菜单项数量不对：${menuItems().length}`);
if (toggle().getAttribute("aria-expanded") !== "true") throw new Error("菜单打开后 aria-expanded 不是 true");
for (const preset of PRESETS) {
  if (!itemFor(preset.label)) throw new Error(`菜单里没有 ${preset.label}`);
  if (!(itemFor(preset.label).textContent || "").includes(preset.url.replace(/^https:\/\//, ""))) throw new Error(`${preset.label} 没有显示完整地址`);
}
console.log(`PASS  常用仓库：菜单列出 ${PRESETS.length} 个预设仓库`);

// 选中 kevin0315/-skill（带 /tree/main 的那种地址），名称空着时要跟着填。
itemFor("kevin0315/-skill").click();
await settle();
// 上面第 5) 步拿到的输入框节点已经被卸载了，这里必须重新取一遍。
const presetUrlInput = document.getElementById("his-repo-url");
const presetNameInput = document.getElementById("his-repo-name");
if (presetUrlInput.value !== PRESETS[2].url) throw new Error(`选中后地址没填对：${presetUrlInput.value}`);
if (presetNameInput.value !== PRESETS[2].name) throw new Error(`名称为空时应该补上建议名：${presetNameInput.value}`);
if (menu()) throw new Error("选中之后菜单没有关掉");
console.log(`PASS  常用仓库：选中后填入 ${presetUrlInput.value}，并补名「${presetNameInput.value}」`);

// 再打开：当前地址对应的那一条要标记成选中态。
toggle().click();
await settle();
if (!itemFor("kevin0315/-skill").className.includes("active")) throw new Error("当前地址对应的菜单项没有标记选中");
await shoot("modal-repo-presets", "dark", document.getElementById("root").innerHTML, "720,600");

// 换成 anthropics/skills：地址覆盖，已经填好的名称不动。
itemFor("anthropics/skills").click();
await settle();
if (presetUrlInput.value !== PRESETS[0].url) throw new Error(`换一个预设后地址没覆盖：${presetUrlInput.value}`);
if (presetNameInput.value !== PRESETS[2].name) throw new Error(`名称不该被覆盖：${presetNameInput.value}`);
console.log(`PASS  常用仓库：换预设覆盖地址（${presetUrlInput.value}），已有名称保持不变`);

// 点菜单外面关掉。
toggle().click();
await settle();
press(document.body, "mousedown");
await settle();
if (menu()) throw new Error("点菜单外面没有关掉菜单");

// Esc 也能关掉。
toggle().click();
await settle();
document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await settle();
if (menu()) throw new Error("按 Esc 没有关掉菜单");
console.log("PASS  常用仓库：点外面 / 按 Esc 都能收起菜单");

// 提交：登记用的就是菜单填进去的地址与名称。
calls.length = 0;
click("添加仓库");
await settle(500);
const addCall = calls.find((entry) => entry.url.includes("/repositories/add"));
if (!addCall) throw new Error(`「添加仓库」没有调用 /repositories/add：${calls.map((entry) => entry.url).join(", ")}`);
const addPayload = JSON.parse(String(addCall.init.body));
if (addPayload.url !== PRESETS[0].url || addPayload.name !== PRESETS[2].name) throw new Error(`登记请求体不对：${String(addCall.init.body)}`);
console.log(`PASS  常用仓库：POST /repositories/add 用的是 ${addPayload.name} / ${addPayload.url}`);

console.log("渲染完成：");
for (const shot of shots) console.log(" -", shot);
