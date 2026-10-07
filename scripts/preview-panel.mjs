/**
 * 配色自查：把面板渲染成明/暗两张 PNG，用来确认「重要按钮与组件」确实用了 DSH
 * 主题里的高亮色（`--dsw-alias-link` / `--dsw-alias-button-info-fill`，随主题变化）。
 *
 * 运行：node scripts/preview-panel.mjs
 * 需要本机有 Chrome/Chromium：默认依次尝试
 *   $DSH_PREVIEW_CHROME、Playwright 的 chromium-*、系统 Chrome。
 * 主题令牌取自工作区的 .cache/dsh-ref/dsw-tokens.json（缺失时用回退色，仅影响预览）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const plugin = path.resolve(here, "..");
const workspace = path.resolve(plugin, "..");
// 角标版本与真实产物同源：预览页不写死版本号，免得和 package.json 漂移。
const { version } = JSON.parse(fs.readFileSync(path.join(plugin, "package.json"), "utf8"));
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

const chrome = findChrome();
if (!chrome) {
  console.log("跳过：没找到 Chrome/Chromium，可用 DSH_PREVIEW_CHROME 指定路径");
  process.exit(0);
}

// 1) 插件真实的 CSS（构建产物里那份），保证预览与线上一致
const bundle = fs.readFileSync(path.join(plugin, "lib", "client.js"), "utf8");
const cssMatch = bundle.match(/\.his-panel\{[\s\S]*?\.his-modal-actions\{[^}]*\}/);
if (!cssMatch) throw new Error("lib/client.js 里没有找到面板 CSS，请先运行 node scripts/build.mjs");
const panelCss = cssMatch[0].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));

// tab 图标：path 直接从产物里取，预览与真实组件共用同一份数据，不会各自漂移。
const tabIcons = (() => {
  const match = bundle.match(/skills:\["([^"]*)"\],repos:\["([^"]*)","([^"]*)","([^"]*)"\]/);
  if (!match) {
    console.log("提示：产物里没找到 tab 图标 path，预览按无图标渲染");
    return { skills: [], repos: [] };
  }
  return { skills: [match[1]], repos: [match[2], match[3], match[4]] };
})();
const tabIcon = (list) =>
  `<svg class="his-tab-icon" viewBox="0 0 1024 1024" aria-hidden="true">${list.map((d) => `<path d="${d}" fill="currentColor"></path>`).join("")}</svg>`;

// 2) DSH 主题令牌（可选，仅用于预览页取色）
const tokenFile = path.join(workspace, ".cache", "dsh-ref", "dsw-tokens.json");
let tokenCss = ":root{--dsw-alias-bg-base:#101014;--dsw-alias-bg-layer-2:#1c1c20;--dsw-alias-bg-layer-1:#232329;--dsw-alias-label-primary:#f5f6f8;--dsw-alias-label-secondary:#b9bcc4;--dsw-alias-label-tertiary:#8b93a1;--dsw-alias-label-primary-foreground:#151517;--dsw-alias-link:#7aaaff;--dsw-alias-button-info-fill:#7aaaff;--dsw-alias-button-info-hover:#4176e6;--dsw-alias-border-l1:#ffffff1f;--dsw-alias-border-l2:#ffffff1f;--dsw-alias-state-success-primary:#4fd1a1;--dsw-alias-interactive-bg-hover:#ffffff14;--dsw-alias-interactive-bg-hover-danger:#f25a5a26;--dsw-alias-state-error-primary:#f25a5a}";
if (fs.existsSync(tokenFile)) {
  const tokens = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  const theme = (name) => {
    const body = (map) => Object.entries(map ?? {}).map(([key, value]) => `  --${key}: ${value};`).join("\n");
    return `:root[data-theme="${name}"]{\n${body(tokens[`${name}_static`])}\n${body(tokens[`${name}_alias`])}\n${body(tokens[`${name}_specific`])}\n}`;
  };
  tokenCss = [theme("light"), theme("dark")].join("\n");
} else {
  console.log(`提示：${tokenFile} 不存在，预览使用回退色`);
}
// 松绿主题覆盖：只用于看图，和 bak 预览保持一致 —— 实心标签这类「压深 accent」
// 的样式在 accent 偏浅的主题里最容易出对比度问题，所以要单独看一眼。
const PINE = {
  "--dsw-alias-bg-base": "#232e2d",
  "--dsw-alias-bg-layer-1": "#232e2d",
  "--dsw-alias-bg-layer-2": "#283332",
  "--dsw-alias-bg-layer-3": "#2c3836",
  "--dsw-alias-label-primary": "#ccd8d3",
  "--dsw-alias-label-secondary": "#a9b5b0",
  "--dsw-alias-label-tertiary": "#9aa6a1",
  "--dsw-alias-label-primary-foreground": "#131a19",
  "--dsw-alias-link": "#4cb08a",
  "--dsw-alias-button-info-fill": "#4cb08a",
  "--dsw-alias-button-info-hover": "#2f8f6b",
  "--dsw-alias-brand-primary": "#ccd8d3",
  "--dsw-alias-border-l1": "#ffffff0f",
  "--dsw-alias-border-l2": "#ffffff1f",
  "--dsw-alias-interactive-bg-hover": "#ffffff14",
  "--dsw-alias-state-success-primary": "#a6d189",
  "--dsw-alias-state-error-primary": "#e78284"
};
tokenCss += `\n:root[data-theme="pine"]{\n${Object.entries(PINE).map(([key, value]) => `  ${key}: ${value};`).join("\n")}\n}`;

// 3) 面板骨架：类名与真实组件一致，覆盖按钮 / 开关 / 徽标 / 仓库卡片
const closeGlyph = '<svg class="his-icon-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.3 4.3 11.7 11.7M11.7 4.3 4.3 11.7"/></svg>';
const skill = (name, source, desc, extra, slash, hover = false) => `
  <div class="his-row${hover ? " demo-hover" : ""}">
    <div class="his-avatar">SKILL</div>
    <div class="his-main">
      <div class="his-name">${name}<span class="his-meta">${source}</span>${slash ? `<span class="his-badge cmd">/${slash}</span>` : ""}${extra}</div>
      <div class="his-desc">${desc}</div>
      <div class="his-path">C:\\Users\\me\\.dsh\\skills\\${name}</div>
    </div>
    <button class="his-icon" title="详情与备注">注</button>
    <button class="his-icon danger" title="删除技能">删</button>
    <button class="his-switch on" title="已启用"></button>
  </div>`;

const panel = `
<div class="his-panel">
  <div class="his-head">
    <div>
      <div class="his-kicker">HELLOAI | SKILLS MANAGER</div>
      <div class="his-title"><span class="his-title-cn">技能管理</span><span class="his-version" title="插件版本 · 构建时取自 package.json">V${version}</span></div>
      <div class="his-subtitle">把分散在本机的 Agent Skills 整理成一处可维护的目录。</div>
    </div>
    <div class="his-actions">
      <button class="his-button primary">+ 创建</button>
      <button class="his-button">+ 导入</button>
      <button class="his-button">\u21BB 刷新</button>
    </div>
  </div>
  <div class="his-tabs">
    <button class="his-tab active">${tabIcon(tabIcons.skills)}技能</button>
    <button class="his-tab">${tabIcon(tabIcons.repos)}仓库</button>
  </div>
  <div class="his-toolbar">
    <input class="his-search" value="搜索 DSH、CODEX、Claude、Trae、Qoder…" readonly>
    <span class="his-count">17 个技能</span>
  </div>
  <div class="his-list">
    <section class="his-group">
      <div class="his-group-title"><span class="his-dot" style="background:#7c9cff"></span>DSH<span class="his-meta">2</span><span class="his-badge">DSH 原生</span></div>
      ${skill("content-creation-publisher", "DSH", "内容创作者与自媒体创作者在需要将网页素材转化为多平台图文时，使用本技能可自动完成网页提取、Markdown 排版美化、智能配图，并一键发布至微信公众号与 X/Twitter。", '<span class="his-badge ok">已安装</span>')}
      ${skill("dengmi", "DSH", "创作灯谜，输入谜底，后面添加需求。", "", undefined, true)}
    </section>
    <section class="his-group">
      <div class="his-group-title"><span class="his-dot" style="background:#4fd1a1"></span>CODEX<span class="his-meta">2</span><span class="his-badge link">DSH 可调用</span></div>
      ${skill("gotoweb", "CODEX", "Create and modify lightweight offline HTML applications that package into WebCinct HTML-to-APK or HarmonyOS HAP projects.", "", "gotoweb")}
      <div class="his-row">
        <div class="his-avatar">SKILL</div>
        <div class="his-main">
          <div class="his-name">figma<span class="his-meta">Trae CN</span><span class="his-badge">已停用</span></div>
          <div class="his-desc">Use the Figma MCP server to fetch design context, screenshots, variables, and assets from Figma.</div>
          <div class="his-path">C:\\Users\\me\\.trae-cn\\skills\\figma</div>
        </div>
        <button class="his-icon" title="详情与备注">注</button>
        <button class="his-icon" title="外部目录不能删除" disabled>删</button>
        <button class="his-switch" title="已停用"></button>
      </div>
    </section>
    <section class="his-group">
      <div class="his-group-title"><span class="his-dot" style="background:#55b9ed"></span>仓库<span class="his-meta">3</span></div>
      <div class="his-repo-tabs">
        <button class="his-repo-tab active"><span class="his-repo-tab-name">anbeime_skill</span></button>
        <button class="his-repo-tab"><span class="his-repo-tab-name">anthropics/skills</span></button>
        <button class="his-repo-tab"><span class="his-repo-tab-name">一个特别长的仓库名用来看省略号</span></button>
        <button class="his-repo-tab"><span class="his-repo-tab-name">helloai-official</span></button>
      </div>
      <div class="his-repo-card">
        <div class="his-repo-body">
          <div class="his-repo-toolbar">
            <input class="his-repo-search" value="在该仓库中搜索技能…" readonly>
            <span class="his-repo-stat">总数:83</span>
            <span class="his-repo-stat">安装:1</span>
            <button class="his-button tiny">\u21BB 刷新</button>
            <button class="his-button tiny"><svg class="his-icon-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.1 2.2a1.7 1.7 0 0 1 2.4 2.4l-8.3 8.3-3.3.9.9-3.3 8.3-8.3Z"/><path d="M9.8 3.5l2.7 2.7"/></svg> 修改</button>
            <button class="his-button tiny danger"><svg class="his-icon-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 4.3h10.4"/><path d="M6.5 4.3V3.1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.2"/><path d="M4.3 4.3l.6 8.7a1.3 1.3 0 0 0 1.3 1.2h3.6a1.3 1.3 0 0 0 1.3-1.2l.6-8.7"/></svg> 删除</button>
          </div>
          <div class="his-note-line">main@7fd9e02 · 本地缓存（同步于 2026/10/2 00:41），点「刷新」才回源 GitHub</div>
          <div class="his-skill demo-hover">
            <div class="his-avatar">SKILL</div>
            <div class="his-main">
              <div class="his-name">ppt-generator<span class="his-badge ok">已安装</span></div>
              <div class="his-desc">从主题或大纲生成演示文稿，含母版与配图流程。</div>
              <div class="his-path">skills/ppt-generator · 12 个文件</div>
            </div>
            <div class="his-skill-actions"><button class="his-button tiny accent">重新安装</button></div>
          </div>
          <div class="his-skill">
            <div class="his-avatar">SKILL</div>
            <div class="his-main">
              <div class="his-name">stock-analysis</div>
              <div class="his-desc">A 股行情与财报分析，输出结构化研报。</div>
              <div class="his-path">skills/stock-analysis · 6 个文件</div>
            </div>
            <div class="his-skill-actions"><button class="his-button tiny primary">安装</button></div>
          </div>
        </div>
      </div>
    </section>
  </div>
</div>`;

const shell = fs.readFileSync(path.join(here, "preview-shell.html"), "utf8");
// 静态页面没有 :hover，用同名的 demo 规则把「悬停态」也画出来，便于核对圆角。
const hoverDemo = ".his-row.demo-hover,.his-skill.demo-hover{background:var(--dsw-alias-interactive-bg-hover)}.his-row.demo-hover::before,.his-skill.demo-hover::before{opacity:0}";
const html = shell
  .replace("__TOKENS__", tokenCss)
  .replace("__PANEL_CSS__", `${panelCss}\n${hoverDemo}`)
  .replace("__MODE_LABEL__", "DSH theme")
  .replace("__PANEL__", panel);

for (const mode of ["light", "dark", "pine"]) {
  const themed = html.replace('<html lang="zh-CN">', `<html lang="zh-CN" data-theme="${mode}">`);
  const page = path.join(output, `panel-${mode}.html`);
  const shot = path.join(output, `panel-${mode}.png`);
  fs.writeFileSync(page, themed, "utf8");
  execFileSync(chrome, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--window-size=760,1180", `--screenshot=${shot}`, `file:///${page.replace(/\\/g, "/")}`
  ], { stdio: "ignore" });
  console.log("渲染完成：", shot);
}
