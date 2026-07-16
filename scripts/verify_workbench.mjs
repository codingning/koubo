#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };
const read = relative => fs.readFileSync(path.join(root, relative), "utf8").replace(/^\uFEFF/, "");

for (const file of ["video/server.mjs", "video/ai_bridge.py", "web/index.html", "web/app.js", "web/styles.css", "打开AI口播工作台.vbs"]) {
  assert(fs.existsSync(path.join(root, file)), `缺少文件：${file}`);
}

for (const file of ["video/server.mjs", "web/app.js"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { encoding: "utf8" });
  assert(result.status === 0, `${file} 语法检查失败：${result.stderr.trim()}`);
}

const python = path.join(root, ".runtime", "Scripts", "python.exe");
if (fs.existsSync(python)) {
  const result = spawnSync(python, ["-m", "py_compile", path.join(root, "video", "ai_bridge.py")], { encoding: "utf8" });
  assert(result.status === 0, `ai_bridge.py 语法检查失败：${result.stderr.trim()}`);
}

const html = read("web/index.html");
const app = read("web/app.js");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const referenced = new Set([...app.matchAll(/byId\("([^"]+)"\)/g)].map(match => match[1]));
for (const id of referenced) assert(ids.has(id), `app.js 引用了不存在的 #${id}`);
assert(!app.includes("/render`"), "网页仍引用旧的手动 render 接口");
assert(!app.includes("copy-ai-edit-prompt"), "网页仍保留复制高级剪辑指令的旧流程");
assert(app.includes("/api/contents/generate"), "网页未接入口播生成接口");
assert(app.includes("/revise`"), "网页未接入自然语言返修接口");
assert(app.includes("/approve`"), "网页未接入最终审核接口");

const sandbox = { window: {} };
vm.runInNewContext(read("web/data/content-data.js"), sandbox, { filename: "content-data.js" });
assert(Array.isArray(sandbox.window.KOUBO_DATA?.contentItems), "静态口播数据无法加载");

const urlArg = process.argv.find(arg => arg.startsWith("--url="));
if (urlArg) {
  const base = urlArg.slice(6).replace(/\/$/, "");
  const health = await fetch(`${base}/api/health`).then(async response => ({ response, data: await response.json() }));
  assert(health.response.ok && health.data.ok, "健康检查失败");
  assert(health.data.version === 2, `服务版本不是 v2：${health.data.version}`);
  assert(health.data.localOnlyVideo === true, "服务未声明原视频本地处理边界");
  assert(health.data.ffmpeg === true, "FFmpeg 不可用");
  const contents = await fetch(`${base}/api/contents`).then(async response => ({ response, data: await response.json() }));
  assert(contents.response.ok && Array.isArray(contents.data.items), "生成内容列表接口失败");
  await fetch(`${base}/favicon.ico`);
  const healthAfter404 = await fetch(`${base}/api/health`);
  assert(healthAfter404.ok, "404 静态请求导致服务退出");
}

if (failures.length) {
  console.error(failures.map(item => `- ${item}`).join("\n"));
  process.exit(1);
}
console.log(`工作台验证通过：${referenced.size} 个页面控件引用有效${urlArg ? "，v2 服务在线" : ""}。`);
