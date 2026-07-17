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
const growthItems = sandbox.window.KOUBO_DATA?.contentItems?.filter(item => item.kind === "growth") || [];
for (const item of growthItems) {
  const engagement = item.engagement || {};
  assert(Boolean(engagement.audienceMirror), `${item.id} 缺少观众代入点`);
  assert(Boolean(engagement.commentPrompt), `${item.id} 缺少具体评论问题`);
  assert(Boolean(engagement.followPromise), `${item.id} 缺少持续关注理由`);
  assert(Boolean(engagement.viewerTask), `${item.id} 缺少观众最小任务`);
  assert(Boolean(item.creativeTone?.humorBeat), `${item.id} 缺少轻松点或自嘲`);
  if (engagement.commentPrompt) assert(String(item.shortScript || "").includes(engagement.commentPrompt), `${item.id} 精简稿没有包含评论问题`);
  if (engagement.followPromise) assert(String(item.shortScript || "").includes(engagement.followPromise), `${item.id} 精简稿没有包含持续关注理由`);
  if (engagement.viewerTask) assert(String(item.shortScript || "").includes(engagement.viewerTask), `${item.id} 精简稿没有包含观众最小任务`);
  if (item.creativeTone?.humorBeat) assert(String(item.shortScript || "").includes(item.creativeTone.humorBeat), `${item.id} 精简稿没有包含轻松点`);
  if (item.creativeTone?.trendMeme?.id) {
    assert(Boolean(item.creativeTone.trendMeme.sourceUrl), `${item.id} 热梗缺少来源链接`);
    assert(String(item.shortScript || "").includes(item.creativeTone.trendMeme.adaptedLine), `${item.id} 精简稿没有包含热梗改写句`);
  }
  assert(!String(item.shortScript || "").startsWith("我"), `${item.id} 精简稿仍以自我汇报开场`);
}
const contentStyle = JSON.parse(read("config/content_style.json"));
assert(contentStyle.version === "1.1-action-humor", "内容风格配置不是 action-humor 版本");
const memePool = JSON.parse(read("config/meme_pool.json"));
assert(memePool.items?.some(item => item.id === "douyin-xuejie-xian-zuoqilai" && item.status === "active"), "缺少已核对的‘学姐先做起来’热梗");

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
  const day1Package = await fetch(`${base}/runs/2026-07-17/growth/02_main_package.md`);
  assert(day1Package.ok, "网页无法打开第一条完整素材包");
  if (day1Package.ok) assert((await day1Package.text()).includes("学姐都说了，先做起来嘛"), "第一条素材包没有包含已核对热梗");
  await fetch(`${base}/favicon.ico`);
  const healthAfter404 = await fetch(`${base}/api/health`);
  assert(healthAfter404.ok, "404 静态请求导致服务退出");
}

if (failures.length) {
  console.error(failures.map(item => `- ${item}`).join("\n"));
  process.exit(1);
}
console.log(`工作台验证通过：${referenced.size} 个页面控件引用有效${urlArg ? "，v2 服务在线" : ""}。`);
