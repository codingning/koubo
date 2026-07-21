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
const normalizeSpokenText = value => String(value || "").replace(/[，。！？、；：,.!?;:\s]/g, "");

for (const file of ["video/server.mjs", "video/ai_bridge.py", "video/hyperframes-captions/index.html", "video/hyperframes-overlay/index.html", "web/index.html", "web/app.js", "web/styles.css", "打开AI口播工作台.vbs"]) {
  assert(fs.existsSync(path.join(root, file)), `缺少文件：${file}`);
}

for (const file of ["video/server.mjs", "web/app.js"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { encoding: "utf8" });
  assert(result.status === 0, `${file} 语法检查失败：${result.stderr.trim()}`);
}

const serverSource = read("video/server.mjs");
const bridgeSource = read("video/ai_bridge.py");
for (const capability of [
  "validatePlan",
  "renderHyperframesCards",
  "renderHyperframesCaptions",
  "writeTimelineArtifacts",
  "renderVariants",
  "runQa",
  "ensureMediaManifest",
  "videoColorPipeline",
  "rerenderJob",
  "renderCover",
  "regenerateCover",
]) assert(serverSource.includes(`function ${capability}`), `Missing video capability implementation: ${capability}`);
for (const route of ["/replan", "/rerender", "/cover", "/assets", "/approve"]) {
  assert(serverSource.includes(route), `Missing workflow endpoint: ${route}`);
}
for (const artifact of ["timeline-v", "timeline-v${version}.edl", "qa-report-v", "media-manifest-v", "captions-v", "filter-v", "cover-design-v"]) {
  assert(serverSource.includes(artifact), `Missing auditable artifact: ${artifact}`);
}
assert(serverSource.includes("job.options.generateVariants === false"), "Promotion output switch is not enforced");
assert(serverSource.includes("tonemap=tonemap=hable"), "HLG/HDR source is not tone-mapped for SDR delivery");
assert(serverSource.includes('"-color_primaries", "bt709"'), "Rendered video is not tagged as BT.709");
assert(serverSource.includes('captionStyle: normalizeCaptionStyle(options.captionStyle)'), "新任务未默认启用可控字幕包装");
assert(serverSource.includes('renderHorizontal(1920, "16x9")') && serverSource.includes('renderHorizontal(1440, "4x3")'), "封面流程缺少 16:9 或 4:3 横版产物");
assert(serverSource.includes("coverPackaging.wide16x9?.metadata?.width === 1920") && serverSource.includes("coverPackaging.landscape4x3?.metadata?.width === 1440"), "四画幅封面尺寸没有进入 QA 门禁");
assert(serverSource.includes('engine: "ass-fallback"'), "动态包装缺少 ASS 降级路径");
assert(serverSource.includes('feedback.trim() ? "revise_plan" : "edit_plan"'), "Replan feedback is not routed to the text model");
assert(!/OPENMONTAGE|OpenMontage|company_openai/i.test(serverSource + bridgeSource), "运行代码仍依赖 OpenMontage");
for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"]) {
  assert(read(".env.example").includes(name), `.env.example 缺少 ${name}`);
}

const python = path.join(root, ".runtime", "Scripts", "python.exe");
if (fs.existsSync(python)) {
  const bridge = path.join(root, "video", "ai_bridge.py");
  const result = spawnSync(python, ["-B", "-c", "import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))", bridge], { encoding: "utf8" });
  assert(result.status === 0, `ai_bridge.py 语法检查失败：${result.stderr.trim()}`);

  const structureTest = String.raw`
import importlib.util
import json
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
            "selectionReason": "这条内容的证据形态与观众问题适合当前结构",
            "coreQuestion": "普通人如何把收藏AI工具变成一个可验证结果",
            "hookConflict": "收藏越多越容易把准备误认为真正的行动进度",
            "saveableFramework": [
                {"label": f"步骤{i + 1}", "action": "完成一个十分钟内可以执行的小动作", "expectedSignal": "得到一个文件或明确报错"}
                for i in range(count)
            ],
            "personalEvidenceRole": "用真实项目结果证明动作有效",
            "personalVariation": "结合AI口播工作台的实拍限制调整动作",
            "boundary": "尚未拍摄验证的结果不能写成完成",
            "payoff": "观众能判断自己在哪一步并完成下一动作",
        }
    }

valid = {
    "evidence-story": 2,
    "saveable-map": 3,
    "short-resonance": 1,
}
for archetype, count in valid.items():
    issues = module.structure_issues(sample(archetype, count))
    if issues:
        raise AssertionError(f"{archetype} 合法样本被拒绝: {issues}")

broken = sample("saveable-map", 3)
broken["structureDesign"]["saveableFramework"][1].pop("expectedSignal")
issues = module.structure_issues(broken)
if not any("可观察信号" in issue for issue in issues):
    raise AssertionError(f"缺少 expectedSignal 的框架未被拒绝: {issues}")

invalid = sample("copy-a-viral-script", 2)
if not module.structure_issues(invalid):
    raise AssertionError("无效原型未被拒绝")

class Box:
    def __init__(self, **values):
        self.__dict__.update(values)

fixtures = [
    ('{"keepSegments":[]}', '{"keepSegments":[]}'),
    (json.dumps({"choices": [{"message": {"content": '{"ok":true}'}, "finish_reason": "stop"}]}), '{"ok":true}'),
    ({"choices": [{"message": {"content": [{"type": "text", "text": '{"ok":2}'}]}}]}, '{"ok":2}'),
    (Box(choices=[Box(message=Box(content='{"ok":3}'), finish_reason="stop")], usage=Box(total_tokens=8)), '{"ok":3}'),
    ({"output_text": '{"ok":4}'}, '{"ok":4}'),
    ({"output": [{"content": [{"type": "output_text", "text": '{"ok":5}'}]}]}, '{"ok":5}'),
]
for fixture, expected in fixtures:
    content, _, _ = module.response_details(fixture)
    if content != expected:
        raise AssertionError(f"响应归一化失败: {content!r} != {expected!r}")
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
assert(ids.has("edit-caption-style") && ids.has("edit-information-panels"), "网页缺少动态字幕或分屏信息板控制项");
assert(app.includes("captionStyle") && app.includes("informationPanels"), "网页未把字幕包装选项发送给服务端");
assert(ids.has("edit-generate-cover") && ids.has("edit-cover-title") && ids.has("regenerate-cover"), "网页缺少自动封面开关、标题覆盖或单独重做入口");
assert(app.includes("generateCover") && app.includes("coverWide16x9") && app.includes("coverLandscape4x3"), "网页未完整接入四画幅封面流程");

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
    assert(normalizeSpokenText(item.shortScript).includes(normalizeSpokenText(item.creativeTone.trendMeme.adaptedLine)), `${item.id} 精简稿没有包含热梗改写句`);
  }
  assert(!String(item.shortScript || "").startsWith("我"), `${item.id} 精简稿仍以自我汇报开场`);
}
const contentStyle = JSON.parse(read("config/content_style.json"));
assert(contentStyle.tone?.spokenLanguage, "内容风格配置缺少口语化规则");
assert(contentStyle.engagement?.commentPrompt?.includes("具体的问题"), "内容风格配置缺少真实问题互动规则");
assert(contentStyle.engagement?.followPromise?.includes("不固定承诺未来多少天"), "内容风格配置仍缺少非倒计时追更规则");
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
