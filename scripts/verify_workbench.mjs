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

const serverSource = read("video/server.mjs");
const bridgeSource = read("video/ai_bridge.py");
const python = path.join(root, ".runtime", "Scripts", "python.exe");
if (fs.existsSync(python)) {
  const bridge = path.join(root, "video", "ai_bridge.py");
  const result = spawnSync(python, ["-B", "-c", "import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))", bridge], { encoding: "utf8" });
  assert(result.status === 0, `ai_bridge.py 语法检查失败：${result.stderr.trim()}`);

  const structureTest = String.raw`
import importlib.util
import pathlib
import sys

bridge = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("koubo_ai_bridge", bridge)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def sample(archetype, count):
    return {
        "structureDesign": {
            "archetype": archetype,
            "selectionReason": "evidence shape and viewer need fit this structure",
            "coreQuestion": "how to turn saved AI tools into a verified result",
            "hookConflict": "saving more tools can disguise the lack of action",
            "saveableFramework": [
                {"label": f"step-{i + 1}", "action": "finish one executable action in ten minutes", "expectedSignal": "a file exists or an explicit error appears"}
                for i in range(count)
            ],
            "personalEvidenceRole": "real project output proves whether the action works",
            "personalVariation": "adapt the action to the actual recording workflow limits",
            "boundary": "an unfilmed result cannot be claimed as complete",
            "payoff": "the viewer can locate their stage and perform the next action",
        }
    }

for archetype, count in {"evidence-story": 2, "saveable-map": 3, "short-resonance": 1}.items():
    issues = module.structure_issues(sample(archetype, count))
    if issues:
        raise AssertionError(f"valid {archetype} rejected: {issues}")

broken = sample("saveable-map", 3)
broken["structureDesign"]["saveableFramework"][1].pop("expectedSignal")
if not module.structure_issues(broken):
    raise AssertionError("missing expectedSignal was accepted")
if not module.structure_issues(sample("copy-a-viral-script", 2)):
    raise AssertionError("invalid archetype was accepted")

primary_close = "Spend ten minutes creating one file you can open."
you = "\u4f60"
content = {
    "engagement": {
        "audienceMirror": "You may have saved many tools without producing a result",
        "commentPrompt": "Which specific problem do you want to solve first?",
        "followPromise": "The next post will show the verified result and boundary",
        "viewerTask": "Complete one small action you can inspect within ten minutes",
        "primaryClose": primary_close,
    },
    "creativeTone": {"humorBeat": "Do not mistake a bookmark for progress.", "trendMeme": {}},
    "shortScript": f"{you} lack a result. {you} choose one problem. {you} only need one step. Do not mistake a bookmark for progress. " + primary_close,
    "fullSegments": [
        {"text": f"{you} saved many tools but still lack a verified result."},
        {"text": f"{you} should narrow the problem, then complete one action. " + primary_close},
    ],
}
if module.engagement_issues(content, {"bannedCallsToAction": []}):
    raise AssertionError("valid primaryClose placement was rejected")
content["shortScript"] = content["shortScript"].replace(primary_close, "")
if not any("primaryClose" in issue for issue in module.engagement_issues(content, {"bannedCallsToAction": []})):
    raise AssertionError("missing short-script primaryClose was accepted")
`;
  const structureResult = spawnSync(python, ["-B", "-c", structureTest, bridge], { encoding: "utf8" });
  assert(structureResult.status === 0, `三种口播结构门禁测试失败：${(structureResult.stderr || structureResult.stdout).trim()}`);
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
  if (item.creativeTone?.humorBeat) assert(String(item.shortScript || "").includes(item.creativeTone.humorBeat), `${item.id} 精简稿没有包含轻松点`);
  if (item.creativeTone?.trendMeme?.id) {
    assert(Boolean(item.creativeTone.trendMeme.sourceUrl), `${item.id} 热梗缺少来源链接`);
    assert(String(item.shortScript || "").includes(item.creativeTone.trendMeme.adaptedLine), `${item.id} 精简稿没有包含热梗改写句`);
  }
  assert(!String(item.shortScript || "").startsWith("我"), `${item.id} 精简稿仍以自我汇报开场`);
}
const contentStyle = JSON.parse(read("config/content_style.json"));
assert(contentStyle.version === "1.3-evidence-structures", "内容风格配置不是 evidence-structures 版本");
assert(contentStyle.engagement?.primaryClose?.includes("自然"), "内容风格配置缺少单一自然收束规则");
for (const archetype of ["evidence-story", "saveable-map", "short-resonance"]) {
  assert(Boolean(contentStyle.structureDesign?.archetypes?.[archetype]), `内容风格配置缺少 ${archetype} 结构`);
}
assert(serverSource.includes("structureDesign"), "服务端没有保存结构设计字段");
assert(bridgeSource.includes("structure_issues"), "生成器没有接入结构质量门禁");
assert(!bridgeSource.includes("def enforce_script_contract"), "生成器仍在机械拼接口播结尾");
assert(fs.existsSync(path.join(root, "docs", "CONTENT_STRUCTURE_RESEARCH_2026-07-20.md")), "缺少本轮内容结构调研报告");
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
