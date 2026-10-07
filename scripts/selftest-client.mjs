/**
 * dsh-helloai-skills 客户端自测：把 lib/client.js 当浏览器里的 CJS bundle 装载一次，
 * 验证它通过 __ModuleLoader__ 注册、导出 apply/inject，并能注册设置页。
 *
 * 运行：node scripts/selftest-client.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const failures = [];
function check(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

const source = new URL("../lib/client.js", import.meta.url);
const bundle = fs.readFileSync(source, "utf8");

// A `.js` file inside a `"type": "module"` package cannot be require()d as CJS,
// so the bundle is staged as `.cjs` — exactly how the browser treats it.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "helloai-client-"));
const staged = path.join(stage, "client.cjs");
fs.writeFileSync(staged, bundle, "utf8");

const registrations = [];
const styleNodes = [];
globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
globalThis.document = {
  querySelector: (selector) => (selector === "style[data-helloai-skills]" ? styleNodes[styleNodes.length - 1] ?? null : null),
  createElement: () => ({ dataset: {}, style: {}, textContent: "" }),
  head: { appendChild: (node) => styleNodes.push(node) }
};
// 页面里可能已经留着上一版注入的样式（热重载），apply 必须覆盖它而不是再插一份。
styleNodes.push({ dataset: { helloaiSkills: "1" }, style: {}, textContent: ".his-panel{color:red}" });

const react = {
  createElement: (...args) => ({ args }),
  useState: (value) => [value, () => undefined],
  useEffect: () => undefined,
  useCallback: (fn) => fn,
  useMemo: (fn) => fn()
};
const require = createRequire(staged);

try { require(staged); } catch (error) { check("bundle 可执行", false, String(error?.message || error)); }

check("注册到 __ModuleLoader__", registrations.length === 1);
const registration = registrations[0] || {};
check("注册 id 正确", registration.id === "@hello-heyongping/dsh-helloai-skills", registration.id || "");
check("bundle 提供 factory", typeof registration.factory === "function");

const jsxRuntime = { jsx: (...args) => ({ args }), jsxs: (...args) => ({ args }), Fragment: "Fragment" };
const stubRequire = (id) => (id === "react" ? react : id === "react/jsx-runtime" ? jsxRuntime : require(id));

const exportsObject = typeof registration.factory === "function" ? registration.factory(stubRequire) : {};
check("导出 apply", typeof exportsObject.apply === "function");
check("导出 inject = ['slots']", Array.isArray(exportsObject.inject) && exportsObject.inject.join() === "slots");
check("apply 上也带 inject", Array.isArray(exportsObject.apply?.inject) && exportsObject.apply.inject.join() === "slots");

let registered = null;
try {
  exportsObject.apply?.({
    slots: {
      inject: (name, fn) => fn(),
      register: (options, component) => { registered = { options, component }; return () => undefined; }
    }
  });
} catch (error) {
  check("apply 可执行", false, String(error?.message || error));
}
check("注册 settings.section", registered?.options?.name === "settings.section" && registered?.options?.id === "helloai-skills", registered?.options?.label?.() || "");
check("复用同一份样式节点（不重复插入）", styleNodes.length === 1, `共 ${styleNodes.length} 个 <style>`);
check("热重载时替换样式内容", styleNodes[0].textContent.includes(".his-repo-tab") && styleNodes[0].textContent.includes(".his-repo-stat") && !styleNodes[0].textContent.includes("color:red"));

const features = ["/repositories/catalog", "/repositories/update", "/skills/install", "重新安装", "安装中…", "SKILL", "his-repo-tab", "his-repo-stat", "总数:", "安装:", "修改", "删除", "M11.1 2.2a1.7", "M2.8 4.3h10.4"];
// esbuild 的 ascii charset 会把中文写成 \uXXXX，比较前先还原。
const decoded = bundle.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
for (const feature of features) check(`bundle 包含 ${feature}`, decoded.includes(feature));

// 「仓库地址」右侧的常用仓库菜单：四个预设地址必须原样进产物（少一个就是漏了数据），
// 菜单本身的类名也要在，否则界面改回普通输入框时这里会先报警。
const presets = [
  "https://github.com/anthropics/skills",
  "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
  "https://github.com/kevin0315/-skill/tree/main",
  "https://github.com/ComposioHQ/awesome-claude-skills"
];
check("bundle 包含常用仓库菜单文案", decoded.includes("常用仓库"));
check("bundle 包含菜单类名", decoded.includes("his-preset-menu") && bundle.includes("his-preset-toggle"));
check("bundle 包含四种菜单项样式", bundle.includes("his-preset-item-name") && bundle.includes("his-preset-item-note") && bundle.includes("his-preset-item-url"));
for (const preset of presets) check(`常用仓库含 ${preset}`, decoded.includes(preset));

// 标题右上角的版本角标必须来自 package.json（构建时注入 define），
// 这样升级只改 package.json 就不会出现界面版本落后于产物的情况。
const declaredVersion = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
check("bundle 注入 package.json 版本", bundle.includes(`"${declaredVersion}"`), declaredVersion);
check("bundle 包含版本角标", decoded.includes('className:"his-version"'));

fs.rmSync(stage, { recursive: true, force: true });
console.log(`\n${failures.length ? `FAILED: ${failures.join(" / ")}` : "ALL PASS"}`);
if (failures.length) process.exitCode = 1;
