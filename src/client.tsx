/**
 * Browser half of the HelloAI skills manager.
 *
 * It contributes one settings **page** (`settings.section`) so the entry shows
 * up in the settings navigation, and talks to the host half over
 * `/api/dsh-helloai-skills`.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";

export const name = "helloai-skills-client";

/**
 * `slots` must be declared: the client Loader only resolves a service for a
 * plugin that asked for it, so without this line `ctx.slots` is unavailable
 * when `apply` runs and the settings page silently never registers.
 */
export const inject = ["slots"];

const API = "/api/dsh-helloai-skills";
/** 浏览器上传的上限（与宿主 MAX_UPLOAD_BYTES 对齐，base64 前后各留一份余量）。 */
const UPLOAD_LIMIT_BYTES = 24 * 1024 * 1024;
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const NS = "helloai-skills";

/**
 * 插件版本号，由 `scripts/build.mjs` 在构建时从 package.json 注入 `define`。
 * `typeof` 守卫让没有注入 define 的场景（例如只跑 tsc 类型检查）退化成占位版本
 * 而不是抛 ReferenceError。
 */
declare const __HELLOAI_VERSION__: string;
const VERSION = typeof __HELLOAI_VERSION__ === "string" ? __HELLOAI_VERSION__ : "0.0.0";

/**
 * 「添加技能仓库」弹窗里「仓库地址」右侧的常用仓库菜单。
 * 这几个地址是平时反复手填的，点一下就把地址（名称空着时连名称一起）填进表单。
 * 写死在这里就够了：它们是「默认值」而不是数据，也省掉一份要同步的配置文件；
 * 想加新的，往下面这行数组里追加一条即可（改完要重新 `node scripts/build.mjs`）。
 */
const REPO_PRESETS = [
  { label: "anthropics/skills", name: "Claude 官方技能库", note: "Anthropic 官方 Agent Skills（文档、设计、MCP 等）", url: "https://github.com/anthropics/skills" },
  { label: "nextlevelbuilder/ui-ux-pro-max-skill", name: "UI/UX Pro Max", note: "UI/UX 设计智能：设计系统、品牌、图标与配色", url: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill" },
  { label: "kevin0315/-skill", name: "中文技能商店", note: "按分类收录的中文技能商店（文档 / 创作 / 开发 / 自动化）", url: "https://github.com/kevin0315/-skill/tree/main" },
  { label: "ComposioHQ/awesome-claude-skills", name: "Awesome Claude Skills", note: "Composio 精选技能合集 + 大量自动化技能", url: "https://github.com/ComposioHQ/awesome-claude-skills" }
];

const CSS = `
/* 主题里的高亮色（对话里链接、行内代码用的那个蓝）：亮色 #4176e6 / 暗色 #7aaaff，
   全部经由 --dsw-* 令牌取值，所以跟着主题走，不写死颜色。
   实心色块（primary 按钮、开关）一律压白字：--dsw-alias-label-primary-foreground 在暗色
   主题里是近黑的 #0f1115，配浅蓝 #7aaaff 就成了「蓝底黑字」，所以前景色固定 #fff；
   同时把填充往深色压一档，白字在偏亮的高亮色（暗色主题的 #7aaaff、松绿的 #4cb08a）上
   也能保住 4:1 以上对比度，色相仍是主题自己的高亮色。 */
.his-panel{--his-accent:var(--dsw-alias-link,#4176e6);--his-accent-fill:color-mix(in srgb,var(--dsw-alias-button-info-fill,var(--his-accent)) 70%,#0b1220);--his-accent-hover:color-mix(in srgb,var(--dsw-alias-button-info-hover,var(--his-accent)) 84%,#0b1220);--his-accent-on:#fff;--his-accent-soft:color-mix(in srgb,var(--his-accent) 14%,transparent);--his-accent-line:color-mix(in srgb,var(--his-accent) 45%,transparent);--his-row-pad:10px;color:var(--dsw-alias-label-primary);font-family:inherit;max-width:980px;padding-bottom:28px}
.his-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:4px 0 18px}
.his-kicker{font-size:11px;color:var(--dsw-alias-label-tertiary);letter-spacing:.08em;text-transform:uppercase}
.his-title{display:flex;align-items:baseline;gap:8px;font-size:19px;font-weight:650;line-height:26px;margin-top:3px}.his-title-cn{font-size:19px;font-weight:650;color:var(--dsw-alias-label-primary)}
/* 标题右上角的版本角标：贴着标题文字的上沿，主题换色时跟着 accent 走。 */
.his-version{align-self:flex-start;flex:none;border:1px solid var(--his-accent-line);border-radius:999px;background:var(--his-accent-soft);color:var(--his-accent);font-size:10px;font-weight:700;letter-spacing:.06em;line-height:15px;padding:0 6px;font-variant-numeric:tabular-nums;white-space:nowrap}
.his-subtitle{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.his-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
.his-button{height:30px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.his-button:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.his-button:disabled{opacity:.6;cursor:default}
.his-button.primary{background:var(--his-accent-fill);border-color:var(--his-accent-fill);color:var(--his-accent-on);font-weight:600;box-shadow:0 1px 2px color-mix(in srgb,var(--his-accent) 30%,transparent)}
.his-button.primary:hover{background:var(--his-accent-hover);border-color:var(--his-accent-hover);color:var(--his-accent-on)}
.his-button.primary:disabled{opacity:.55}
.his-button.accent{border-color:var(--his-accent-line);color:var(--his-accent);background:var(--his-accent-soft);font-weight:600}
.his-button.accent:hover{border-color:var(--his-accent);color:var(--his-accent);background:color-mix(in srgb,var(--his-accent) 22%,transparent)}
.his-tabs{display:flex;border-bottom:1px solid var(--dsw-alias-border-l1);gap:22px}
.his-tab{border:0;border-bottom:2px solid transparent;margin-bottom:-1px;background:transparent;color:var(--dsw-alias-label-tertiary);padding:8px 1px 10px;font:inherit;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px}
.his-tab.active{color:var(--his-accent);border-color:var(--his-accent);font-weight:600}
/* tab 图标用 currentColor 填充，颜色取自 .his-panel 上的 --his-accent（主题高亮色），
   所以换主题时图标和文字一起变；未选中的 tab 只压低透明度，不换颜色。 */
.his-tab-icon{width:20px;height:20px;flex:none;color:var(--his-accent);opacity:.55;transition:opacity .14s ease}
.his-tab:hover .his-tab-icon{opacity:.85}
.his-tab.active .his-tab-icon{opacity:1}
.his-toolbar{display:flex;align-items:center;gap:10px;padding:14px 0 8px}
.his-search{flex:1;min-width:160px;height:32px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 10px;font:inherit;font-size:12px;outline:none}
.his-search:focus{border-color:var(--his-accent);box-shadow:0 0 0 2px var(--his-accent-soft)}
.his-count{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.his-list{border-top:1px solid var(--dsw-alias-border-l1)}
.his-group{padding-top:15px}
.his-group-title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);padding-bottom:6px}
.his-dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none}
.his-meta{font-size:10px;font-weight:500;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:1px 5px;margin-left:7px;vertical-align:middle}
/* 行分隔线用内缩的伪元素画，这样悬停底色可以用圆角，不会和边框打架。 */
.his-row{position:relative;display:flex;align-items:flex-start;gap:10px;padding:10px 4px;border-radius:8px;transition:background .12s ease}
.his-row::before{content:"";position:absolute;left:4px;right:4px;top:0;height:1px;background:var(--dsw-alias-border-l1);transition:opacity .12s ease}
.his-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.his-row:hover::before{opacity:0}
.his-avatar{margin-top:1px}
.his-main{flex:1;min-width:0}
.his-name{font-size:13px;font-weight:560;display:flex;align-items:center;flex-wrap:wrap}
.his-desc{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:3px;overflow-wrap:anywhere}
.his-path{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:3px;overflow-wrap:anywhere}
.his-detail{margin-top:8px;display:flex;flex-direction:column;gap:7px}
.his-note{width:100%;min-height:62px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:7px 9px;font:inherit;font-size:12px;resize:vertical;outline:none}
.his-note:focus{border-color:var(--his-accent);box-shadow:0 0 0 2px var(--his-accent-soft)}
.his-detail-actions{display:flex;gap:7px;justify-content:flex-end}
.his-icon{width:26px;height:26px;flex:none;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-ghost-active-fill,var(--dsw-alias-interactive-bg-active));color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;font:inherit;font-size:11px;font-weight:600;line-height:1;transition:background .12s ease,border-color .12s ease,color .12s ease}
.his-icon:hover{border-color:var(--his-accent-line);background:var(--his-accent-soft);color:var(--his-accent)}
.his-icon:active{background:color-mix(in srgb,var(--his-accent) 24%,transparent)}
.his-icon:disabled{border-color:var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-tertiary);opacity:.55;cursor:default}
.his-icon.danger:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.his-icon-glyph{width:14px;height:14px;display:block;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.his-switch{width:30px;height:17px;flex:none;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);cursor:pointer;position:relative;padding:0;margin-top:4px}
.his-switch:after{content:"";position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .14s ease}
.his-switch.on{background:var(--his-accent-fill);border-color:var(--his-accent-fill);box-shadow:0 0 0 2px var(--his-accent-soft)}
.his-switch.on:after{transform:translateX(13px);background:var(--his-accent-on)}
.his-repo{display:flex;align-items:center;gap:10px;padding:11px 4px;border-top:1px solid var(--dsw-alias-border-l1)}
/* 父级仓库与子级技能共用同一个 32×18 圆角文字框，尺寸一致好对照。 */
.his-avatar{width:32px;height:18px;flex:none;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;background:var(--his-accent-soft);border:1px solid var(--his-accent-line);color:var(--his-accent);font-size:7px;font-weight:700;letter-spacing:.02em;line-height:1;white-space:nowrap}
.his-empty{padding:22px 4px;font-size:12px;color:var(--dsw-alias-label-tertiary);text-align:center}
.his-repo-card{border-top:1px solid var(--dsw-alias-border-l1)}
.his-repo-card:first-child{border-top:0}
/* 仓库多起来以后纵向卡片很难找，所以仓库页改成横向滑动的 tabs：一库一个 tab，
   选中的库在下面展开自己的搜索框 + 刷新/修改/删除。tab 条本身可横向滚动。 */
.his-repo-tabs{display:flex;gap:6px;overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x proximity;padding:12px 0 6px;scrollbar-width:thin}
.his-repo-tabs + .his-repo-card{border-top:0}
.his-repo-tab{flex:none;scroll-snap-align:start;display:inline-flex;align-items:center;gap:6px;height:28px;max-width:220px;padding:0 11px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.his-repo-tab:hover{border-color:var(--his-accent-line);color:var(--dsw-alias-label-primary)}
.his-repo-tab.active{border-color:var(--his-accent);background:var(--his-accent-soft);color:var(--his-accent);font-weight:600}
.his-repo-tab-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.his-badge{font-size:10px;font-weight:500;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:1px 5px;color:var(--dsw-alias-label-tertiary)}
/* 技能名后的 /名称 调用提示：只保留这一个框，字色跟正文一档（label-secondary），
   特意不用高亮色——一屏几十个技能时，满排的彩色斜杠名会把真正需要点的高亮控件淹掉。
   组标题上的「DSH 可调用」是分组级说明，才继续用高亮色。 */
.his-badge.cmd{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1);background:transparent;font-weight:500}
.his-badge.ok{color:var(--dsw-alias-state-success-primary,#4fd1a1);border-color:currentColor}
.his-badge.busy{color:var(--his-accent);border-color:var(--his-accent-line);background:var(--his-accent-soft)}
.his-badge.link{color:var(--his-accent);border-color:var(--his-accent-line);background:var(--his-accent-soft);font-weight:600}
.his-repo-body{padding:10px var(--his-row-pad) 14px var(--his-row-pad)}
/* tab 面板只有一行功能条：搜索框 + 总数/安装两个计数 + 刷新/修改/删除。
   原来的 REPO 徽标与仓库标题/地址整块去掉了（名字在 tab 上，地址在「修改」弹窗里），
   这样每个 tab 的排版完全一致。 */
.his-repo-toolbar{display:flex;align-items:center;gap:8px;padding:2px 0 8px;flex-wrap:wrap}
.his-repo-toolbar .his-button{flex:none}
.his-repo-stat{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums;padding-right:2px}
.his-repo-search{flex:1;min-width:120px;height:28px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 9px;font:inherit;font-size:12px;outline:none}
.his-repo-search:focus{border-color:var(--his-accent);box-shadow:0 0 0 2px var(--his-accent-soft)}
.his-skill{position:relative;display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-radius:8px;transition:background .12s ease}
.his-skill + .his-skill::before{content:"";position:absolute;left:0;right:0;top:0;height:1px;background:var(--dsw-alias-border-l1);transition:opacity .12s ease}
.his-skill:hover{background:var(--dsw-alias-interactive-bg-hover)}
.his-skill:hover::before{opacity:0}
.his-skill .his-avatar{margin-left:0}
.his-skill .his-name{font-size:12.5px;font-weight:560}
.his-skill .his-desc{font-size:11.5px}
.his-skill-actions{display:flex;align-items:center;gap:6px;flex:none;padding-top:2px}
.his-button.tiny{height:26px;padding:0 9px;font-size:11.5px}
.his-button.tiny.danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary)}
.his-button.tiny.danger:hover{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.his-note-line{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:4px 0 2px}
.his-error{margin:10px 0 0;padding:8px 10px;border-radius:6px;font-size:12px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.his-modal-backdrop{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:20px}
.his-modal{width:min(520px,100%);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 16px 48px rgba(0,0,0,.3);padding:18px}
.his-modal-head{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:16px}.his-modal-title{font-size:15px;font-weight:650}.his-form{display:flex;flex-direction:column;gap:12px}.his-field{display:flex;flex-direction:column;gap:6px}.his-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}.his-field input,.his-field select,.his-field textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:8px 9px;font:inherit;font-size:12px;outline:none}.his-field textarea{min-height:100px;resize:vertical}.his-field input:focus,.his-field select:focus,.his-field textarea:focus{border-color:var(--his-accent);box-shadow:0 0 0 2px var(--his-accent-soft)}.his-field-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}.his-pick-row{display:flex;flex-wrap:wrap;gap:7px}.his-modal-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}
/* 「仓库地址」这一行的标签右边挂一个常用仓库菜单。标签和按钮用 flex 分到两端，
   输入框仍是整行宽度，所以加了菜单之后地址框的排版和别的字段完全一致。 */
.his-field-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:20px}
.his-preset{position:relative;flex:none}
.his-preset-toggle{height:22px;padding:0 8px;border-radius:999px;border:1px solid var(--his-accent-line);background:var(--his-accent-soft);color:var(--his-accent);font:inherit;font-size:11px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.his-preset-toggle:hover{border-color:var(--his-accent);background:color-mix(in srgb,var(--his-accent) 22%,transparent)}
.his-preset-toggle[aria-expanded="true"]{border-color:var(--his-accent);background:color-mix(in srgb,var(--his-accent) 26%,transparent)}
.his-preset-caret{font-size:9px;line-height:1}
/* 菜单右对齐到触发按钮、浮在输入框上方；地址太长时换行，不撑破弹窗。 */
.his-preset-menu{position:absolute;top:calc(100% + 5px);right:0;z-index:30;width:min(340px,72vw);padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 30px rgba(0,0,0,.3);display:flex;flex-direction:column;gap:2px}
.his-preset-item{display:flex;flex-direction:column;gap:2px;width:100%;box-sizing:border-box;text-align:left;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);padding:7px 9px;font:inherit;cursor:pointer}
.his-preset-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.his-preset-item.active{border-color:var(--his-accent-line);background:var(--his-accent-soft)}
.his-preset-item-name{font-size:12px;font-weight:600}
.his-preset-item.active .his-preset-item-name{color:var(--his-accent)}
.his-preset-item-note{font-size:11px;color:var(--dsw-alias-label-secondary)}
.his-preset-item-url{font-size:10.5px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
`;

const icon = { refresh: "\u21BB", add: "+" };

/**
 * Tabs 上的两个图标（1024 视图盒）。只保留 path，填充改用 `currentColor`，
 * 具体颜色交给 `.his-tab-icon` 的 --his-accent，和主题高亮色保持同一来源。
 */
const TAB_ICONS = {
  skills: [
    "M665.6 934.4a38.4 38.4 0 0 1 5.222 76.442l-5.222 0.358H358.4a38.4 38.4 0 0 1-5.222-76.442l5.222-0.358h307.2zM512 12.8a422.4 422.4 0 0 1 195.38 796.98l-3.38 1.689V870.4a38.4 38.4 0 0 1-33.178 38.042l-5.222 0.358H358.4a38.4 38.4 0 0 1-38.4-38.4v-58.931l-3.328-1.639A422.4 422.4 0 0 1 89.856 450.1l-0.256-14.9A422.4 422.4 0 0 1 512 12.8z m0 76.8a345.6 345.6 0 0 0-138.24 662.477 38.438 38.438 0 0 1 23.04 35.225L396.749 832l79.053 0.051a38.144 38.144 0 0 1-1.844-7.68l-0.358-5.171V570.317L340.02 436.736a38.4 38.4 0 0 1 50.38-57.702l3.942 3.43L512 500.122l117.658-117.658a38.4 38.4 0 0 1 50.38-3.43l3.943 3.43a38.4 38.4 0 0 1 3.43 50.38l-3.43 3.892L550.4 570.266V819.2a38.349 38.349 0 0 1-2.202 12.851L627.2 832v-44.749c0-13.363 6.963-25.6 18.022-32.563l5.018-2.611A345.651 345.651 0 0 0 512 89.6z"
  ],
  repos: [
    "M490.666667 437.333333h-145.066667c-17.066667 0-32-14.933333-32-32s14.933333-32 32-32H490.666667c17.066667 0 32 14.933333 32 32s-14.933333 32-32 32zM448 614.4h-102.4c-17.066667 0-32-14.933333-32-32s14.933333-32 32-32H448c17.066667 0 32 14.933333 32 32s-14.933333 32-32 32zM405.333333 789.333333h-59.733333c-17.066667 0-32-14.933333-32-32s14.933333-32 32-32H405.333333c17.066667 0 32 14.933333 32 32S422.4 789.333333 405.333333 789.333333z",
    "M923.733333 403.2c-6.4 0-12.8-2.133333-19.2-6.4L512 110.933333 121.6 396.8c-12.8 10.666667-34.133333 10.666667-44.8-4.266667-10.666667-12.8-10.666667-34.133333 4.266667-44.8 2.133333 0 2.133333-2.133333 4.266666-2.133333L482.133333 55.466667c19.2-12.8 44.8-12.8 61.866667 0l398.933333 290.133333c14.933333 10.666667 17.066667 29.866667 6.4 44.8-6.4 8.533333-14.933333 12.8-25.6 12.8z",
    "M518.4 979.2H300.8c-76.8 0-138.666667-61.866667-138.666667-138.666667V317.866667c0-17.066667 14.933333-32 32-32s32 14.933333 32 32v522.666666c0 40.533333 34.133333 74.666667 74.666667 74.666667h219.733333c17.066667 0 32 14.933333 32 32s-14.933333 32-34.133333 32zM832 571.733333c-17.066667 0-32-14.933333-32-32V317.866667c0-17.066667 14.933333-32 32-32s32 14.933333 32 32v221.866666c0 19.2-14.933333 32-32 32zM740.266667 970.666667c-10.666667 0-21.333333-2.133333-29.866667-8.533334l-145.066667-93.866666c-14.933333-10.666667-19.2-29.866667-10.666666-44.8 10.666667-14.933333 29.866667-19.2 44.8-10.666667l134.4 87.466667L896 659.2c8.533333-14.933333 29.866667-19.2 44.8-10.666667s19.2 29.866667 10.666667 44.8c0 0 0 2.133333-2.133334 2.133334l-164.266666 251.733333c-8.533333 12.8-19.2 19.2-34.133334 23.466667h-10.666666z"
  ]
} as const;

function TabIcon({ name }: { name: keyof typeof TAB_ICONS }) {
  return (
    <svg className="his-tab-icon" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
      {TAB_ICONS[name].map((d, index) => (
        <path key={index} d={d} fill="currentColor" />
      ))}
    </svg>
  );
}

/** 技能行左侧的圆角文字框（仓库已经改成 tab，不再需要 REPO 徽标）。 */
const skillBadge = "SKILL";

/** 行内动作按钮：圆角方形 + 文字，一眼能看出是按钮。 */
const detailLabel = "注";
const removeLabel = "删";

/** 仓库工具条上的「修改 / 删除」用线条图标（和弹窗关闭叉同一套 16×16 描边），不再用「改」「删」两个字。 */
const editGlyph = (
  <svg className="his-icon-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M11.1 2.2a1.7 1.7 0 0 1 2.4 2.4l-8.3 8.3-3.3.9.9-3.3 8.3-8.3Z" />
    <path d="M9.8 3.5l2.7 2.7" />
  </svg>
);
const removeGlyph = (
  <svg className="his-icon-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M2.8 4.3h10.4" />
    <path d="M6.5 4.3V3.1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.2" />
    <path d="M4.3 4.3l.6 8.7a1.3 1.3 0 0 0 1.3 1.2h3.6a1.3 1.3 0 0 0 1.3-1.2l.6-8.7" />
  </svg>
);
/** 弹窗右上角的关闭仍用线条叉。 */
const closeGlyph = (
  <svg className="his-icon-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M4.3 4.3 11.7 11.7M11.7 4.3 4.3 11.7" />
  </svg>
);

/**
 * 注入样式：既要避免重复插入，也必须在热重载后**替换旧内容**。
 * 早先版本发现已存在 <style> 就直接 return，于是 HMR 后 DOM 是新的、CSS 还是旧的
 * （典型症状：新徽标配着老缩进，父子图标对不齐）。
 */
function injectStyle() {
  if (typeof document === "undefined") return;
  let style = document.querySelector("style[data-helloai-skills]");
  if (style === null) {
    style = document.createElement("style");
    style.dataset.helloaiSkills = "1";
    document.head.appendChild(style);
  }
  if (style.textContent !== CSS) style.textContent = CSS;
}

async function call(path: string, options: RequestInit = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.ok !== true) {
    const message = payload?.data?.error || payload?.error || `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  // 宿主半边的兜底分支会以 200 + { error: "unknown action" } 回包（插件升级后没重启宿主时，
  // 新端点就落到这里）。只看 HTTP 状态会把「什么都没发生」当成成功，所以显式判一次。
  const data = payload.data;
  if (data && typeof data === "object" && typeof data.error === "string" && data.error) throw new Error(data.error);
  return data;
}

/* --------------------------------------------------- 浏览文件夹 / ZIP（上传） */

type PickedSource =
  | { kind: "zip"; file: File; label: string }
  | { kind: "folder"; files: Array<{ path: string; data: string }>; label: string };

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 技能目录名必须能直接当文件夹名用；能提出来就顺手填进「导入名称」。 */
function nameFromPath(value: string) {
  const candidate = String(value || "").split(/[\\/]/).filter(Boolean).pop() || "";
  return SKILL_NAME_PATTERN.test(candidate) ? candidate : "";
}

/** SKILL.md 所在的那一层就是技能根：和宿主的判定保持一致，先给用户一个准信。 */
function skillBaseOf(paths: string[]) {
  const folders = [...new Set(paths
    .filter((path) => path.split("/").pop()?.toLowerCase() === "skill.md")
    .map((path) => path.split("/").slice(0, -1).join("/")))];
  if (!folders.length) return null;
  const depth = (value: string) => (value ? value.split("/").length : 0);
  const shallowest = Math.min(...folders.map(depth));
  return folders.filter((folder) => depth(folder) === shallowest);
}

function readFileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    reader.readAsDataURL(file);
  });
}

/** ZIP 按原始字节省事地交给宿主；FileReader 比 Blob.arrayBuffer() 的老环境覆盖更广。 */
function readFileBytes(file: File) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    reader.readAsArrayBuffer(file);
  });
}

function SkillRows({ groups, query, onChanged, onError }) {
  const [detail, setDetail] = useState(null);
  const [note, setNote] = useState("");
  const matches = (skill) => `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(query.toLowerCase());
  const visible = groups.flatMap((group) => group.skills.filter(matches));
  const guard = (task) => (event) => {
    event.stopPropagation();
    Promise.resolve(task()).catch((error) => onError(String(error?.message || error)));
  };
  async function saveNote() {
    await call("/note", { method: "POST", body: JSON.stringify({ id: detail.id, note }) });
    setDetail(null);
    await onChanged();
  }
  return (
    <div className="his-list">
      {groups.map((group) => {
        const rows = group.skills.filter(matches);
        if (!rows.length) return null;
        return (
          <section className="his-group" key={group.id}>
            <div className="his-group-title">
              <span className="his-dot" style={{ background: group.tone }} />
              {group.label}
              <span className="his-meta">{rows.length}</span>
              {group.callable
                ? <span className="his-badge link" title="已注册到 DSH，可作为 /名称 调用">DSH 可调用</span>
                : <span className="his-badge" title="DSH 自带加载器读取的目录">DSH 原生</span>}
            </div>
            {rows.map((skill) => (
              <div className="his-row" key={skill.id}>
                <div className="his-avatar">{skillBadge}</div>
                <div className="his-main">
                  <div className="his-name">
                    {skill.name}
                    <span className="his-meta">{skill.source}</span>
                    {skill.callable && <span className="his-badge cmd" title="在对话里用这个名称调用">/{skill.slug}</span>}
                    {!skill.enabled && <span className="his-badge">已停用</span>}
                  </div>
                  <div className="his-desc">{skill.description}</div>
                  <div className="his-path">{skill.path}</div>
                  {detail?.id === skill.id && (
                    <div className="his-detail">
                      <textarea
                        className="his-note"
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="添加一条更容易理解的备注…"
                      />
                      <div className="his-detail-actions">
                        <button className="his-button" onClick={() => setDetail(null)}>取消</button>
                        <button className="his-button primary" onClick={guard(saveNote)}>保存备注</button>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  className="his-icon"
                  title="详情与备注"
                  onClick={() => {
                    setDetail(detail?.id === skill.id ? null : skill);
                    setNote(skill.note || "");
                  }}
                >
                  {detailLabel}
                </button>
                {skill.mutable ? (
                  <button
                    className="his-icon danger"
                    title="删除技能"
                    onClick={guard(async () => {
                      if (!window.confirm(`删除技能 ${skill.name}？此操作不可撤销。`)) return;
                      await call("/delete", { method: "POST", body: JSON.stringify({ path: skill.path }) });
                      await onChanged();
                    })}
                  >
                    {removeLabel}
                  </button>
                ) : (
                  <button
                    className="his-icon"
                    title="外部目录的技能由对应工具维护：这里只能停用，不删除文件"
                    disabled
                  >
                    {removeLabel}
                  </button>
                )}
                <button
                  className={`his-switch ${skill.enabled ? "on" : ""}`}
                  title={skill.enabled ? "已启用" : "已停用"}
                  onClick={guard(async () => {
                    await call("/toggle", { method: "POST", body: JSON.stringify({ id: skill.id, enabled: !skill.enabled }) });
                    await onChanged();
                  })}
                />
              </div>
            ))}
          </section>
        );
      })}
      {!visible.length && <div className="his-empty">{query ? "没有匹配的技能" : "还没有扫描到技能"}</div>}
    </div>
  );
}

function RepoCard({ repo, onChanged, onError, onEdit }) {
  const [loading, setLoading] = useState(false);
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [installing, setInstalling] = useState("");
  const [message, setMessage] = useState("");
  /** 改过地址之后，面板里的旧列表已经作废，等用户点「刷新」再回源。 */
  const [stale, setStale] = useState(false);

  const load = useCallback(
    async (refresh = false, silent = false) => {
      if (!silent) setLoading(true);
      if (!silent) setError("");
      try {
        const data = await call("/repositories/catalog", {
          method: "POST",
          body: JSON.stringify({ id: repo.id, refresh })
        });
        setCatalog(data);
        setStale(false);
      } catch (failure) {
        if (!silent) setError(String(failure?.message || failure));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    // 只依赖 id：改了地址不自动重新下载，避免「改个名字/地址」顺带回源一遍仓库。
    [repo.id]
  );

  useEffect(() => {
    load(false).catch(() => undefined);
  }, [load]);

  // 地址换了：本地列表属于上一个仓库，直接作废并提示，下载交给「刷新」按钮。
  const knownUrl = useRef(repo.url);
  useEffect(() => {
    if (knownUrl.current === repo.url) return;
    knownUrl.current = repo.url;
    setCatalog(null);
    setQuery("");
    setMessage("");
    setStale(true);
  }, [repo.url]);

  // 技能说明由主机侧后台逐条补齐：没补完就安静地再取一次，不打断阅读。
  const pending = catalog?.pending ?? 0;
  const polls = useRef(0);
  useEffect(() => {
    if (!catalog || !pending || catalog.filled || polls.current >= 20) return undefined;
    const timer = setTimeout(() => {
      polls.current += 1;
      load(false, true).catch(() => undefined);
    }, 3000);
    return () => clearTimeout(timer);
  }, [catalog, pending, load]);

  async function install(skill) {
    setInstalling(skill.path);
    setMessage("");
    try {
      const result = await call("/skills/install", {
        method: "POST",
        body: JSON.stringify({ id: repo.id, path: skill.path, overwrite: Boolean(skill.installed) })
      });
      setMessage(`已安装 ${result.installed.name}（${result.installed.files} 个文件）到 ${result.installed.source} 技能目录`);
      setCatalog((current) =>
        current
          ? { ...current, skills: current.skills.map((item) => (item.path === skill.path ? { ...item, installed: true, installedPath: result.installed.path } : item)) }
          : current
      );
      await onChanged();
    } catch (failure) {
      setMessage("");
      onError(String(failure?.message || failure));
    } finally {
      setInstalling("");
    }
  }

  const skills = catalog?.skills || [];
  const matching = query ? skills.filter((skill) => `${skill.name} ${skill.description} ${skill.path}`.toLowerCase().includes(query.toLowerCase())) : skills;
  const installedCount = skills.filter((skill) => skill.installed).length;
  const skillCount = skills.length || repo.skillCount || 0;
  const syncedAt = catalog?.fetchedAt ? new Date(catalog.fetchedAt).toLocaleString() : "";

  function removeRepo() {
    if (!window.confirm(`删除仓库 ${repo.name}？已安装的技能不会被删除。`)) return;
    Promise.resolve(call("/repositories/remove", { method: "POST", body: JSON.stringify({ id: repo.id }) }))
      .then(onChanged)
      .catch((failure) => onError(String(failure?.message || failure)));
  }

  return (
    <div className="his-repo-card">
      <div className="his-repo-body">
        {error && <div className="his-error">{error}</div>}
        <div className="his-repo-toolbar">
          <input className="his-repo-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="在该仓库中搜索技能…" />
          <span className="his-repo-stat">总数:{catalog ? (query ? `${matching.length}/${skillCount}` : skillCount) : "—"}</span>
          <span className="his-repo-stat">安装:{catalog ? installedCount : "—"}</span>
          <button className="his-button tiny" onClick={() => load(true).catch(() => undefined)} disabled={loading} title="回源 GitHub 重新获取技能列表（平时只读本地缓存）">
            {icon.refresh} 刷新
          </button>
          <button className="his-button tiny" onClick={() => onEdit()} title="修改仓库名称或地址">
            {editGlyph} 修改
          </button>
          <button className="his-button tiny danger" onClick={removeRepo} title="删除仓库">
            {removeGlyph} 删除
          </button>
        </div>
        {stale && <div className="his-note-line">仓库地址已修改，本地列表已作废 —— 点「刷新」重新加载。</div>}
        {loading && !catalog && <div className="his-note-line">正在读取仓库技能列表…</div>}
        {!loading && !error && catalog && (
          <>
            <div className="his-note-line">
              {catalog.ref}@{String(catalog.oid || "").slice(0, 7)} · {catalog.cached ? `本地缓存${syncedAt ? `（同步于 ${syncedAt}）` : ""}，点「刷新」才回源 GitHub` : `刚从仓库获取${syncedAt ? `（${syncedAt}）` : ""}`}
            </div>
            {message && <div className="his-note-line">{message}</div>}
            {catalog.truncated && <div className="his-note-line">仓库技能过多，只列出前 {skills.length} 个。</div>}
            {pending > 0 && <div className="his-note-line">技能说明补充中（还剩 {pending} 个），列表可以先用。</div>}
            {matching.map((skill) => (
              <div className="his-skill" key={skill.path || skill.name}>
                <div className="his-avatar">{skillBadge}</div>
                <div className="his-main">
                  <div className="his-name">
                    {skill.name}
                    {skill.installed && <span className="his-badge ok">已安装</span>}
                  </div>
                  <div className="his-desc">{skill.description || (pending > 0 ? "说明补充中…" : "（SKILL.md 未提供 description）")}</div>
                  <div className="his-path">
                    {skill.path || "(仓库根目录)"} · {skill.fileCount} 个文件
                  </div>
                </div>
                <div className="his-skill-actions">
                  <button className={`his-button tiny ${skill.installed ? "accent" : "primary"}`} disabled={installing === skill.path} onClick={() => install(skill)}>
                    {installing === skill.path ? "安装中…" : skill.installed ? "重新安装" : "安装"}
                  </button>
                </div>
              </div>
            ))}
            {!matching.length && <div className="his-empty">{query ? "没有匹配的技能" : "这个仓库里没有找到 SKILL.md"}</div>}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 仓库页：一库一个横向滑动的 tab，选中的库在下面展开自己的搜索框与刷新 / 修改 / 删除。
 * 仓库多了以后纵向堆卡片要滚很久，tab 条本身可以横向滑动，找库只要看一行。
 */
function RepoTabs({ repositories, onChanged, onError, onEdit }) {
  const [activeId, setActiveId] = useState(repositories[0]?.id || "");
  const knownIds = useRef(repositories.map((repo) => repo.id));

  // 列表变化后：新加的仓库直接切过去；删掉的仓库切回第一个；其余情况保留当前选择。
  useEffect(() => {
    const ids = repositories.map((repo) => repo.id);
    const added = ids.find((id) => !knownIds.current.includes(id));
    knownIds.current = ids;
    if (!ids.length) {
      if (activeId) setActiveId("");
      return;
    }
    if (added) {
      setActiveId(added);
      return;
    }
    if (!ids.includes(activeId)) setActiveId(ids[0]);
  }, [repositories, activeId]);

  if (!repositories.length) return <div className="his-empty">还没有添加仓库。点击右上角「添加」登记一个技能仓库。</div>;
  const active = repositories.find((repo) => repo.id === activeId) || repositories[0];

  return (
    <div className="his-list">
      <div className="his-repo-tabs" role="tablist" aria-label="技能仓库">
        {repositories.map((repo) => (
          <button
            key={repo.id}
            type="button"
            role="tab"
            aria-selected={repo.id === active.id}
            className={`his-repo-tab ${repo.id === active.id ? "active" : ""}`}
            title={repo.url || repo.name}
            onClick={() => setActiveId(repo.id)}
          >
            <span className="his-repo-tab-name">{repo.name}</span>
          </button>
        ))}
      </div>
      <RepoCard key={active.id} repo={active} onChanged={onChanged} onError={onError} onEdit={() => onEdit(active)} />
    </div>
  );
}

function EntryModal({ mode, roots, onClose, onSubmit, busy, error, uploadReady, initial }) {
  const [name, setName] = useState(initial?.name || "");
  const [root, setRoot] = useState(roots[0]?.id || "dsh");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState(initial?.url || "");
  const [sourcePath, setSourcePath] = useState("");
  const [picked, setPicked] = useState<PickedSource | null>(null);
  const [pickNotice, setPickNotice] = useState("");
  const [reading, setReading] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const zipInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const presetBox = useRef<HTMLDivElement | null>(null);

  const isRepoEdit = mode === "repo-edit";
  const isRepo = mode === "repo" || isRepoEdit;
  const isImport = mode === "import";
  const title = isRepoEdit ? "修改仓库" : isRepo ? "添加技能仓库" : isImport ? "导入本地技能" : "创建新技能";

  /**
   * 常用仓库菜单开着的时候才监听：点菜单外面或按 Esc 关掉它。
   * 只挂在 window 上收尾，不做「点哪都关」的全局拦截，弹窗里别的控件照旧。
   */
  useEffect(() => {
    if (!presetOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (presetBox.current && !presetBox.current.contains(event.target as Node)) setPresetOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setPresetOpen(false); };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [presetOpen]);

  /**
   * 选中常用仓库：地址总是覆盖（用户就是来填它的）；名称只在空着时补上，
   * 免得把已经起好的 tab 名字冲掉。宿主要求名称非空，所以顺手补名很有用。
   */
  const applyPreset = (preset: (typeof REPO_PRESETS)[number]) => {
    setUrl(preset.url);
    if (!name.trim()) setName(preset.name);
    setPresetOpen(false);
  };

  // React 的类型里没有 webkitdirectory，只在挂载时补上这个非标准属性。
  const attachFolderPicker = useCallback((node: HTMLInputElement | null) => {
    folderInput.current = node;
    if (!node) return;
    node.setAttribute("webkitdirectory", "");
    node.setAttribute("directory", "");
  }, []);

  const remember = (next: PickedSource | null, note: string) => {
    setPicked(next);
    setPickNotice(note);
    const derived = next?.kind === "zip" ? nameFromPath(next.file.name.replace(/\.zip$/i, "")) : next ? nameFromPath(next.label) : "";
    if (derived && !name.trim()) setName(derived);
  };

  async function onZipChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > UPLOAD_LIMIT_BYTES) return remember(null, `压缩包 ${formatBytes(file.size)} 超过 ${formatBytes(UPLOAD_LIMIT_BYTES)} 上限，请拆分后再导入`);
    if (!/\.zip$/i.test(file.name)) return remember(null, "请选择 .zip 压缩包");
    return remember({ kind: "zip", file, label: file.name }, `已选择压缩包：${file.name}（${formatBytes(file.size)}），导入时会上传解压`);
  }

  async function onFolderChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(event.target.files || []);
    event.target.value = "";
    if (!list.length) return;
    setReading(true);
    try {
      const total = list.reduce((sum, file) => sum + file.size, 0);
      if (total > UPLOAD_LIMIT_BYTES) {
        remember(null, `文件夹共 ${formatBytes(total)}，超过 ${formatBytes(UPLOAD_LIMIT_BYTES)} 上限，请改用 ZIP 或拆分`);
        return;
      }
      const files = [];
      for (const file of list) {
        const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        if (path.split("/").pop() === ".DS_Store") continue;
        files.push({ path, data: await readFileBase64(file) });
      }
      const folderName = files[0]?.path.split("/")[0] || "";
      const base = skillBaseOf(files.map((file) => file.path));
      if (!base) {
        remember(null, "这个文件夹里没有找到 SKILL.md：请选择技能文件夹本身（或它在 ZIP 里的样子）");
        return;
      }
      if (base.length > 1) {
        remember(null, `这个文件夹里有 ${base.length} 个技能（${base.map((item) => item.split("/").pop()).join("、")}），请一次只导入一个`);
        return;
      }
      remember({ kind: "folder", files, label: folderName }, `已选择文件夹：${folderName}（${files.length} 个文件，${formatBytes(total)}）`);
      if (!name.trim() && base[0].split("/").pop()) setName(nameFromPath(base[0].split("/").pop() || ""));
    } catch (failure) {
      remember(null, String((failure as Error)?.message || failure));
    } finally {
      setReading(false);
    }
  }

  const submit = (event) => {
    event.preventDefault();
    onSubmit(isRepo ? { name, url } : isImport ? { name, root, path: sourcePath, picked } : { name, root, description });
  };

  return (
    <div className="his-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="his-modal" role="dialog" aria-modal="true" aria-labelledby="his-modal-title">
        <div className="his-modal-head">
          <div className="his-modal-title" id="his-modal-title">{title}</div>
          <button className="his-icon" type="button" title="关闭" onClick={onClose}>{closeGlyph}</button>
        </div>
        <form className="his-form" onSubmit={submit}>
          {isRepo ? (
            <>
              <div className="his-field"><label htmlFor="his-repo-name">仓库名称</label><input id="his-repo-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：HelloAI 官方技能" autoFocus /></div>
              <div className="his-field">
                <div className="his-field-head">
                  <label htmlFor="his-repo-url">仓库地址</label>
                  <div className="his-preset" ref={presetBox}>
                    <button
                      className="his-preset-toggle"
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={presetOpen}
                      title="从常用仓库里选一个直接填入"
                      onClick={() => setPresetOpen((open) => !open)}
                    >
                      常用仓库<span className="his-preset-caret" aria-hidden="true">▾</span>
                    </button>
                    {presetOpen && (
                      <div className="his-preset-menu" role="menu">
                        {REPO_PRESETS.map((preset) => (
                          <button
                            key={preset.url}
                            className={url.trim() === preset.url ? "his-preset-item active" : "his-preset-item"}
                            type="button"
                            role="menuitem"
                            onClick={() => applyPreset(preset)}
                          >
                            <span className="his-preset-item-name">{preset.label}</span>
                            <span className="his-preset-item-note">{preset.note}</span>
                            <span className="his-preset-item-url">{preset.url.replace(/^https:\/\//, "")}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <input id="his-repo-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/example/skills" />
              </div>
              <div className="his-field-hint">{isRepoEdit ? "改名只影响 tab 上的显示；改了地址会清掉旧目录缓存并作废本地列表，点「刷新」或重新进入这个 tab 才会回源下载。" : "支持 github.com 仓库地址（可带 /tree/分支/子目录），或者点上面的「常用仓库」直接填一个。登记后会自动列出仓库里的 SKILL.md 技能，可一键安装到 DSH。"}</div>
            </>
          ) : isImport ? (
            <>
              <div className="his-field">
                <label htmlFor="his-import-path">本地技能文件夹</label>
                <input id="his-import-path" value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="例如：C:\\Users\\me\\skills\\web-search" autoFocus />
                <div className="his-pick-row">
                  <button className="his-button tiny" type="button" onClick={() => folderInput.current?.click()} disabled={reading || !uploadReady} title={uploadReady ? "选择本机的一个技能文件夹" : "宿主插件重启后可用"}>{reading ? "读取中…" : "浏览文件夹…"}</button>
                  <button className="his-button tiny" type="button" onClick={() => zipInput.current?.click()} disabled={reading || !uploadReady} title={uploadReady ? "选择一个 .zip 技能包" : "宿主插件重启后可用"}>选择 ZIP…</button>
                  {picked && <button className="his-button tiny" type="button" onClick={() => remember(null, "")} disabled={reading}>清除选择</button>}
                </div>
                <div className="his-field-hint">{picked ? pickNotice : uploadReady ? "两种方式都行：上面的路径由 DSH 直接读取；「浏览文件夹 / 选择 ZIP」会把内容上传给 DSH 再安装（技能文件夹内必须包含 SKILL.md）。" : "两种方式都行：上面的路径由 DSH 直接读取；「浏览文件夹 / 选择 ZIP」需要宿主插件重启后才会出现。"}</div>
                {pickNotice && !picked && <div className="his-error">{pickNotice}</div>}
                <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={onZipChosen} />
                <input ref={attachFolderPicker} type="file" multiple hidden onChange={onFolderChosen} />
              </div>
              <div className="his-field"><label htmlFor="his-import-name">导入名称（可选）</label><input id="his-import-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="留空则使用原文件夹名称" /></div>
              <div className="his-field"><label htmlFor="his-import-root">放入技能来源</label><select id="his-import-root" value={root} onChange={(event) => setRoot(event.target.value)}>{roots.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
            </>
          ) : (
            <>
              <div className="his-field"><label htmlFor="his-create-name">技能名称</label><input id="his-create-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：release-notes" autoFocus /><div className="his-field-hint">使用英文、数字、点、下划线或短横线。</div></div>
              <div className="his-field"><label htmlFor="his-create-root">技能来源</label><select id="his-create-root" value={root} onChange={(event) => setRoot(event.target.value)}>{roots.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
              <div className="his-field"><label htmlFor="his-create-description">技能说明</label><textarea id="his-create-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="说明这个技能适合处理什么任务。" /></div>
            </>
          )}
          {error && <div className="his-error">{error}</div>}
          <div className="his-modal-actions"><button className="his-button" type="button" onClick={onClose}>取消</button><button className="his-button primary" type="submit" disabled={busy}>{busy ? "保存中…" : isRepoEdit ? "保存修改" : isRepo ? "添加仓库" : isImport ? "开始导入" : "创建技能"}</button></div>
        </form>
      </div>
    </div>
  );
}

function SkillsManager() {
  const [tab, setTab] = useState("skills");
  const [state, setState] = useState({ skills: [], groups: [] });
  const [repositories, setRepositories] = useState([]);  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modal, setModal] = useState("");
  const [modalRepo, setModalRepo] = useState(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (tab === "skills") setState(await call("/state"));
      else setRepositories(await call("/repositories"));
    } catch (failure) {
      setError(String(failure?.message || failure));
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { injectStyle(); }, []);
  useEffect(() => { reload(); }, [reload]);

  function openModal(kind) { setModalError(""); if (kind !== "repo-edit") setModalRepo(null); setModal(kind); }
  function openRepoEdit(repo) { setModalError(""); setModalRepo(repo); setModal("repo-edit"); }
  function closeModal() { if (!modalBusy) { setModal(""); setModalError(""); setModalRepo(null); } }
  async function submitModal(input) {
    setModalBusy(true);
    setModalError("");
    try {
      if (modal === "import" && input.picked) {
        const query = `?root=${encodeURIComponent(input.root || "dsh")}&name=${encodeURIComponent(input.name || "")}`;
        if (input.picked.kind === "zip") {
          await call(`/skills/import-upload${query}&filename=${encodeURIComponent(input.picked.file.name)}`, {
            method: "POST",
            headers: { "content-type": "application/zip" },
            body: await readFileBytes(input.picked.file)
          });
        } else {
          await call("/skills/import-files", {
            method: "POST",
            body: JSON.stringify({ root: input.root, name: input.name, files: input.picked.files })
          });
        }
      } else {
        const endpoint = modal === "repo" ? "/repositories/add" : modal === "repo-edit" ? "/repositories/update" : modal === "import" ? "/skills/import" : "/skills/create";
        await call(endpoint, { method: "POST", body: JSON.stringify(modal === "repo-edit" ? { ...input, id: modalRepo?.id } : input) });
      }
      setModal("");
      await reload();
    } catch (failure) {
      setModalError(String(failure?.message || failure));
    } finally {
      setModalBusy(false);
    }
  }

  return (
    <div className="his-panel">
      <div className="his-head">
        <div>
          <div className="his-kicker">HELLOAI | SKILLS MANAGER</div>
          <div className="his-title"><span className="his-title-cn">技能管理</span><span className="his-version" title="插件版本 · 构建时取自 package.json">V{VERSION}</span></div>
          <div className="his-subtitle">把分散在本机的 Agent Skills 整理成一处可维护的目录。</div>
        </div>
        <div className="his-actions">
          {tab === "skills" ? (
            <>
              <button className="his-button primary" onClick={() => openModal("create")}>{icon.add} 创建</button>
              <button className="his-button" onClick={() => openModal("import")}>{icon.add} 导入</button>
              <button className="his-button" onClick={reload} disabled={loading}>{icon.refresh} 刷新</button>
            </>
          ) : (
            <>
              <button className="his-button primary" onClick={() => openModal("repo")}>{icon.add} 添加</button>
              <button className="his-button" onClick={reload} disabled={loading}>{icon.refresh} 更新</button>
            </>
          )}
        </div>
      </div>
      <div className="his-tabs">
        <button className={`his-tab ${tab === "skills" ? "active" : ""}`} onClick={() => setTab("skills")}>
          <TabIcon name="skills" />
          技能
        </button>
        <button className={`his-tab ${tab === "repos" ? "active" : ""}`} onClick={() => setTab("repos")}>
          <TabIcon name="repos" />
          仓库
        </button>
      </div>
      {tab === "skills" && (
        <div className="his-toolbar">
          <input className="his-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 DSH、CODEX、Claude、Trae、Qoder、CC Switch…" />
          <span className="his-count">{state.skills.length} 个技能</span>
        </div>
      )}
      {tab === "repos" && <div className="his-note-line">仓库多的时候用上面那排 tab 横向切换；每个仓库里的 SKILL.md 目录都是一个可安装技能，列表默认只读本地缓存，点「刷新」才回源 GitHub。</div>}
      {error && <div className="his-error">读取失败：{error}</div>}
      {loading ? <div className="his-empty">正在读取…</div> : tab === "skills" ? <SkillRows groups={state.groups} query={query} onChanged={reload} onError={setError} /> : <RepoTabs repositories={repositories} onChanged={reload} onError={setError} onEdit={openRepoEdit} />}
      {modal && <EntryModal mode={modal} roots={state.groups} initial={modal === "repo-edit" ? modalRepo : null} onClose={closeModal} onSubmit={submitModal} busy={modalBusy} error={modalError} uploadReady={state.capabilities?.uploadImport === true} />}
    </div>
  );
}

/**
 * Contribute one page to the settings navigation.
 * `label` is a function so the shell can re-read it (and bump the ledger)
 * whenever it re-registers the section.
 */
export function apply(ctx) {
  try {
    injectStyle();
  } catch (failure) {
    console.warn(`[${NS}] style injection skipped`, failure);
  }

  const mount = () => {
    try {
      return ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: NS,
            order: 19,
            label: () => "技能管理"
          },
          SkillsManager
        )
      );
    } catch (failure) {
      // A hot reload can re-run apply while the previous entry is still live.
      console.warn(`[${NS}] settings section not registered`, failure);
      return () => {};
    }
  };

  if (typeof ctx.effect === "function") ctx.effect(mount, `${NS} settings section`);
  else mount();
}

export default apply;

/**
 * Mirror the declaration onto the function as well: depending on how the
 * client Loader unwraps the bundle it may read `inject` off the default export
 * rather than off the module namespace.
 */
(apply as unknown as { inject: string[] }).inject = inject;
