import { access, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { build } from "../../dsh-helloai-bak/node_modules/esbuild/lib/main.js";

// 面板角标显示的版本号以 package.json 为唯一来源：升级时只改 version，
// 重新构建就会把新版本烘进客户端产物，不需要再手改界面代码。
const { version } = JSON.parse(await readFile(resolve("package.json"), "utf8"));

const output = resolve("lib");
const stage = resolve(`.helloai-skills-${randomUUID()}`);
async function exists(path) { try { await access(path); return true; } catch { return false; } }
try {
  await build({ entryPoints: ["src/index.ts"], outfile: join(stage, "index.js"), bundle: false, format: "esm", platform: "node", target: "node20", sourcemap: true });
  await build({ entryPoints: ["src/client.tsx"], outfile: join(stage, "client.js"), bundle: true, format: "cjs", platform: "browser", target: "es2022", external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"], minify: true, define: { "process.env.NODE_ENV": '"production"', __HELLOAI_VERSION__: JSON.stringify(version) }, banner: { js: "window.__ModuleLoader__.load({ id: \"@hello-heyongping/dsh-helloai-skills\", factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;" }, footer: { js: "return module.exports;\n} });" } });
  if (await exists(output)) await rm(output, { recursive: true, force: true });
  await rename(stage, output);
} finally { await rm(stage, { recursive: true, force: true }); }
console.log("[dsh-helloai-skills] built");
