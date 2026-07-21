import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const envFile = path.join(root, ".env");
if (typeof process.loadEnvFile === "function" && fs.existsSync(envFile)) process.loadEnvFile(envFile);
const webRoot = path.join(root, "web");
const jobsRoot = path.join(root, "video-jobs");
const contentRoot = path.join(root, "content-items");
const runtimePython = path.join(root, ".runtime", "Scripts", "python.exe");
const runtimeFfmpeg = path.join(root, ".runtime", "ffmpeg", "bin");
const aiBridge = path.join(here, "ai_bridge.py");
const referenceCollector = path.join(root, "scripts", "collect_douyin_references.mjs");
const referenceLibraryFile = path.join(root, "config", "reference_video_library.json");
const referenceCreatorsFile = path.join(root, "config", "reference_creators.json");
const host = "127.0.0.1";
const port = Number(process.env.KOUBO_PORT || 8787);
if (fs.existsSync(runtimeFfmpeg)) process.env.PATH = `${runtimeFfmpeg}${path.delimiter}${process.env.PATH || ""}`;
const running = new Map();
const mime = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".mp4": "video/mp4", ".webm": "video/webm",
  ".srt": "application/x-subrip; charset=utf-8", ".ass": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".edl": "text/plain; charset=utf-8"
};

await Promise.all([fsp.mkdir(jobsRoot, { recursive: true }), fsp.mkdir(contentRoot, { recursive: true })]);

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-File-Name,X-Content-Id,X-Options");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length");
}
function json(res, status, value) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value, null, 2));
}
function safeName(value) {
  return String(value || "video.mp4").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\.{2,}/g, ".").slice(0, 160) || "video.mp4";
}
function confined(base, target) {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(base, target);
  if (resolved.toLowerCase() !== resolvedBase.toLowerCase() && !resolved.toLowerCase().startsWith(resolvedBase.toLowerCase() + path.sep)) throw new Error("路径越界");
  return resolved;
}
function redact(text) {
  return String(text || "")
    .replace(/(api[_-]?key|token|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replace(/(?:sk|gsk|ghp|github_pat)_[A-Za-z0-9_-]{12,}/g, "<redacted>")
    .slice(0, 40000);
}
async function writeJson(file, data) {
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(temp, file);
}
async function readJsonFile(file) { return JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
async function readJob(id) { return readJsonFile(path.join(confined(jobsRoot, id), "job.json")); }
async function saveJob(job) { job.updatedAt = new Date().toISOString(); await writeJson(path.join(confined(jobsRoot, job.id), "job.json"), job); }
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 0, onStdout, onStderr, ...spawnOptions } = options;
    const child = spawn(command, args, { windowsHide: true, ...spawnOptions });
    let stdout = "", stderr = "";
    let timedOut = false, settled = false;
    const timer = timeoutMs ? setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill();
    }, timeoutMs) : null;
    child.stdout?.on("data", c => { stdout += c; onStdout?.(String(c)); });
    child.stderr?.on("data", c => { stderr += c; onStderr?.(String(c)); });
    child.on("error", error => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", code => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (timedOut) return reject(Object.assign(new Error(`${command} 超时`), { stdout, stderr, code }));
      return code === 0 ? resolve({ stdout, stderr }) : reject(Object.assign(new Error(`${command} 退出码 ${code}`), { stdout, stderr, code }));
    });
  });
}
async function runAi(payload, workDir, name) {
  if (!fs.existsSync(runtimePython)) throw new Error("AI运行环境未安装，请重新运行工作台初始化");
  const request = path.join(workDir, `${name}-request.json`);
  const response = path.join(workDir, `${name}-response.json`);
  await writeJson(request, payload);
  try {
    await run(runtimePython, [aiBridge, "--request", request, "--response", response], { cwd: root, env: process.env });
  } catch (error) {
    if (!fs.existsSync(response)) throw error;
  }
  const result = await readJsonFile(response);
  if (!result.success) throw new Error(result.error || `${name}失败`);
  return result;
}
function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function timestampId() { return `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`; }
async function readTextIf(file, max = 12000) {
  try { return redact((await fsp.readFile(file, "utf8")).slice(0, max)); } catch { return ""; }
}
async function listGeneratedContents() {
  const entries = await fsp.readdir(contentRoot, { withFileTypes: true });
  const items = [];
  for (const entry of entries.filter(x => x.isDirectory())) {
    try {
      const item = await readJsonFile(path.join(contentRoot, entry.name, "content.json"));
      item.sourcePackageHref ||= `/content-items/${entry.name}/content.json`;
      item.sourcePackagePath ||= path.join(contentRoot, entry.name, "content.json");
      items.push(item);
    } catch {}
  }
  const replacedIds = new Set(items.map(item => String(item.replacesContentId || "")).filter(Boolean));
  return items
    .filter(item => !replacedIds.has(String(item.id || "")))
    .sort((a, b) => String(b.generatedAt || b.date).localeCompare(String(a.generatedAt || a.date)));
}
async function contentDirectionFor(contentId) {
  if (!contentId) return null;
  const id = safeName(contentId);
  try {
    const content = await readJsonFile(path.join(confined(contentRoot, id), "content.json"));
    return {
      id,
      mainTopic: String(content.mainTopic || ""),
      hook: String(content.hook || ""),
      audienceBenefit: String(content.audienceBenefit || ""),
      resultFirstProof: content.resultFirstProof || {},
      shooting: content.shooting || {},
      structureDesign: content.structureDesign || {},
      referenceResearch: content.referenceResearch || {},
      fullSegments: Array.isArray(content.fullSegments) ? content.fullSegments : []
    };
  } catch { return null; }
}

async function referenceCatalog() {
  try {
    const [library, creators] = await Promise.all([readJsonFile(referenceLibraryFile), readJsonFile(referenceCreatorsFile)]);
    const creatorByVideo = new Map();
    for (const creator of creators.creators || []) {
      for (const videoId of creator.pinnedVideoIds || []) creatorByVideo.set(String(videoId), creator);
    }
    return (library.items || []).map(item => {
      const creator = creatorByVideo.get(String(item.videoId || "")) || {};
      return {
        ...item,
        creatorName: String(creator.creatorName || creator.label || "").trim(),
        creatorProfileUrl: String(creator.profileUrl || "").trim()
      };
    });
  } catch { return []; }
}
async function collectEvidence() {
  const runRoot = path.join(root, "runs");
  let latestProgress = "";
  try {
    const dates = (await fsp.readdir(runRoot, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name).sort().reverse();
    for (const date of dates) {
      const candidate = path.join(runRoot, date, "growth", "00_daily_progress.md");
      if (fs.existsSync(candidate)) { latestProgress = await readTextIf(candidate, 16000); break; }
    }
  } catch {}
  let gitLog = "", gitStatus = "", gitDiff = "";
  try { gitLog = (await run("git", ["log", "--oneline", "-6"], { cwd: root })).stdout.trim(); } catch {}
  try { gitStatus = (await run("git", ["status", "--short"], { cwd: root })).stdout.trim(); } catch {}
  try { gitDiff = (await run("git", ["diff", "--stat", "HEAD"], { cwd: root })).stdout.trim(); } catch {}
  const recent = [];
  async function walk(dir, depth = 0) {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if ([".git", ".runtime", "video-jobs", "content-items", "outputs"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else {
        const stat = await fsp.stat(full);
        if (Date.now() - stat.mtimeMs < 3 * 86400000) recent.push({ path: path.relative(root, full), modified: stat.mtime.toISOString(), size: stat.size });
      }
    }
  }
  await walk(root);
  return {
    creator_profile: await readTextIf(path.join(root, "docs", "CREATOR_PROFILE.md"), 12000),
    roadmap: await readTextIf(path.join(root, "docs", "30_DAY_AI_GROWTH_ROADMAP.md"), 12000),
    latest_progress: latestProgress,
    git: { log: redact(gitLog), status: redact(gitStatus), diff_stat: redact(gitDiff) },
    recently_modified_files: recent.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 60),
    generated_at: new Date().toISOString()
  };
}
function normalizeContent(raw, dayNumber, id, meta) {
  const value = raw && typeof raw === "object" ? raw : {};
  const defaultSegments = [{ time: "0—3秒", label: "直接给结果", tone: "自然", text: value.hook || value.mainTopic || "今天没有足够证据生成口播。" }];
  const design = value.structureDesign && typeof value.structureDesign === "object" ? value.structureDesign : {};
  const validArchetypes = new Set(["evidence-story", "saveable-map", "short-resonance"]);
  const structureDesign = {
    archetype: validArchetypes.has(design.archetype) ? design.archetype : "",
    selectionReason: String(design.selectionReason || ""),
    coreQuestion: String(design.coreQuestion || ""),
    hookConflict: String(design.hookConflict || ""),
    saveableFramework: (Array.isArray(design.saveableFramework) ? design.saveableFramework : []).slice(0, 5).map(item => ({
      label: String(item?.label || ""), action: String(item?.action || ""), expectedSignal: String(item?.expectedSignal || "")
    })),
    personalEvidenceRole: String(design.personalEvidenceRole || ""),
    personalVariation: String(design.personalVariation || ""),
    boundary: String(design.boundary || ""),
    payoff: String(design.payoff || "")
  };
  const research = value.referenceResearch && typeof value.referenceResearch === "object" ? value.referenceResearch : {};
  const referenceResearch = {
    sourceIds: (Array.isArray(research.sourceIds) ? research.sourceIds : []).map(String).slice(0, 8),
    borrowedKnowledge: (Array.isArray(research.borrowedKnowledge) ? research.borrowedKnowledge : []).map(String).slice(0, 8),
    structuralChoices: (Array.isArray(research.structuralChoices) ? research.structuralChoices : []).map(String).slice(0, 8),
    engagementChoices: (Array.isArray(research.engagementChoices) ? research.engagementChoices : []).map(String).slice(0, 6),
    originalityNote: String(research.originalityNote || "")
  };
  return {
    id, kind: "growth", date: shanghaiDate(), day: `Day ${dayNumber}`, column: value.column || `普通人学AI第${dayNumber}天`,
    status: "待审核", badge: "AI自动生成", durationFull: value.durationFull || "约2—3分钟", durationShort: value.durationShort || "约60—90秒衍生版",
    mainTopic: String(value.mainTopic || "今天没有足够证据生成主选题"), shortTopic: String(value.shortTopic || value.mainTopic || "待确认").slice(0, 20),
    hook: String(value.hook || ""), audienceBenefit: String(value.audienceBenefit || ""),
    resultFirstProof: value.resultFirstProof && typeof value.resultFirstProof === "object" ? value.resultFirstProof : {},
    engagement: {
      audienceMirror: String(value.engagement?.audienceMirror || value.audienceMirror || value.audienceBenefit || ""),
      commentPrompt: String(value.engagement?.commentPrompt || value.commentPrompt || ""),
      followPromise: String(value.engagement?.followPromise || value.followPromise || value.tomorrowChallenge || value.storyPosition?.tomorrow || ""),
      viewerTask: String(value.engagement?.viewerTask || value.actionExperiment?.viewerTask || ""),
      primaryClose: String(value.engagement?.primaryClose || "")
    },
    structureDesign, referenceResearch,
    creativeTone: {
      humorBeat: String(value.creativeTone?.humorBeat || ""),
      trendMeme: value.creativeTone?.trendMeme && typeof value.creativeTone.trendMeme === "object" ? value.creativeTone.trendMeme : { id: "", adaptedLine: "", placement: "", sourceUrl: "" }
    },
    actionExperiment: value.actionExperiment && typeof value.actionExperiment === "object" ? value.actionExperiment : {},
    storyPosition: value.storyPosition || { yesterday: "自动读取最近记录", today: "等待确认", tomorrow: value.tomorrowChallenge || "继续真实验证" },
    progress: Array.isArray(value.progress) ? value.progress : [], candidates: Array.isArray(value.candidates) ? value.candidates : [],
    fullSegments: Array.isArray(value.fullSegments) && value.fullSegments.length ? value.fullSegments : defaultSegments,
    shortScript: String(value.shortScript || ""), titles: Array.isArray(value.titles) ? value.titles.slice(0, 5) : [],
    covers: Array.isArray(value.covers) ? value.covers.slice(0, 5) : [], shooting: value.shooting || { broll: [], highlights: [], guide: {} },
    platformCopy: value.platformCopy || { douyin: "", xiaohongshu: "", weibo: "" }, evidence: Array.isArray(value.evidence) ? value.evidence : [],
    risks: Array.isArray(value.risks) ? value.risks : [{ text: "发布前人工确认所有事实和隐私边界", done: false }],
    sourceFiles: [
      { label: "AI生成内容JSON", path: `/content-items/${id}/content.json` },
      { label: "AI生成证据包", path: `/content-items/${id}/evidence.json` },
      { label: "同题视频研究包", path: `/content-items/${id}/reference-research.json` },
      { label: "AI选题规划", path: `/content-items/${id}/topic-plan.json` }
    ],
    sourcePackageHref: `/content-items/${id}/content.json`,
    sourcePackagePath: path.join(contentRoot, id, "content.json"),
    generatedAt: new Date().toISOString(),
    generation: { model: meta.model, usage: meta.usage || {}, mode: "openai-compatible", automatic: true, qualityRevision: meta.quality_revision || { repaired: false, initial_issues: [] } }
  };
}
async function generateContent(options = {}) {
  const lockKey = "__content_generation__";
  if (running.has(lockKey)) { const error = new Error("已有口播正在生成，请稍候"); error.statusCode = 409; throw error; }
  running.set(lockKey, true);
  try {
    const existing = await listGeneratedContents();
    const baseTopics = [];
    try {
      const base = await fsp.readFile(path.join(webRoot, "data", "content-data.js"), "utf8");
      for (const match of base.matchAll(/mainTopic:\s*"([^"]+)"/g)) baseTopics.push(match[1]);
    } catch {}
    const requestedDay = Number(options.dayNumber || 0);
    const dayNumber = Number.isInteger(requestedDay) && requestedDay >= 1 && requestedDay <= 365
      ? requestedDay
      : Math.max(1, ...existing.map(x => Number(String(x.day || "").replace(/\D/g, "")) || 0), 1) + 1;
    const id = `growth-day-${dayNumber}${options.replacesContentId ? "-revision" : ""}-${timestampId()}`;
    const dir = confined(contentRoot, id);
    await fsp.mkdir(dir, { recursive: false });
    const evidence = await collectEvidence();
    await writeJson(path.join(dir, "evidence.json"), evidence);
    const existingTopics = [...baseTopics, ...existing.map(x => x.mainTopic)];
    let contentStyle = {};
    try { contentStyle = await readJsonFile(path.join(root, "config", "content_style.json")); } catch {}
    const editorialBrief = options.editorialBrief && typeof options.editorialBrief === "object" ? options.editorialBrief : {};
    const topicResult = await runAi({ operation: "plan_topic", date: shanghaiDate(), day_number: dayNumber, evidence, content_style: contentStyle, editorial_brief: editorialBrief, existing_topics: existingTopics }, dir, "topic-plan");
    const topicPlan = topicResult.data;
    await writeJson(path.join(dir, "topic-plan.json"), topicPlan);
    const referenceFile = path.join(dir, "reference-research.json");
    try {
      await run(process.execPath, [referenceCollector, "--plan", path.join(dir, "topic-plan.json"), "--output", referenceFile], { cwd: root, env: process.env, timeoutMs: 1200000 });
    } catch (error) {
      let detail = error.message;
      try { detail = (await readJsonFile(referenceFile)).error || detail; } catch {}
      throw new Error(`同题视频研究未通过，已停止生成：${detail}`);
    }
    const referenceResearch = await readJsonFile(referenceFile);
    if (!Array.isArray(referenceResearch.fullContentSources) || !referenceResearch.fullContentSources.length) throw new Error("同题视频研究没有完成至少一条全文核验来源");
    const result = await runAi({ operation: "generate_content", date: shanghaiDate(), day_number: dayNumber, evidence, topic_plan: topicPlan, reference_research: referenceResearch, existing_topics: existingTopics }, dir, "generate-content");
    const content = normalizeContent(result.data, dayNumber, id, result);
    if (options.replacesContentId) content.replacesContentId = safeName(options.replacesContentId);
    await writeJson(path.join(dir, "content.json"), content);
    return content;
  } finally {
    running.delete(lockKey);
  }
}

async function probe(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  const raw = JSON.parse(stdout), video = raw.streams?.find(s => s.codec_type === "video") || {}, audio = raw.streams?.find(s => s.codec_type === "audio") || null;
  const duration = Number(raw.format?.duration || video.duration || audio?.duration || 0), fpsParts = String(video.avg_frame_rate || video.r_frame_rate || "0/1").split("/").map(Number);
  const pixelFormat = video.pix_fmt || "";
  return {
    duration,
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    fps: Number((fpsParts[1] ? fpsParts[0] / fpsParts[1] : 0).toFixed(3)),
    videoCodec: video.codec_name || "",
    pixelFormat,
    bitsPerRawSample: Number(video.bits_per_raw_sample || 0) || (/p10/.test(pixelFormat) ? 10 : null),
    colorRange: video.color_range || "",
    colorSpace: video.color_space || "",
    colorTransfer: video.color_transfer || "",
    colorPrimaries: video.color_primaries || "",
    audioCodec: audio?.codec_name || "",
    hasAudio: !!audio,
    sizeBytes: Number(raw.format?.size || 0)
  };
}
function parseSilences(stderr, duration) {
  const events = []; let open = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([0-9.]+)/); if (start) open = Number(start[1]);
    const end = line.match(/silence_end:\s*([0-9.]+)/); if (end && open !== null) { events.push({ start: open, end: Number(end[1]) }); open = null; }
  }
  if (open !== null && duration > open) events.push({ start: open, end: duration });
  return events.filter(x => x.end > x.start);
}
function buildKeepSegments(duration, silences, pauseKeep = 0.12) {
  const removals = silences.map(s => ({ start: Math.max(0, s.start + pauseKeep), end: Math.min(duration, s.end - pauseKeep) })).filter(s => s.end - s.start >= 0.18).sort((a, b) => a.start - b.start);
  const keep = []; let cursor = 0;
  for (const cut of removals) { if (cut.start - cursor >= 0.12) keep.push({ start: cursor, end: cut.start, reason: "说话内容" }); cursor = Math.max(cursor, cut.end); }
  if (duration - cursor >= 0.12) keep.push({ start: cursor, end: duration, reason: "说话内容" });
  return keep.length ? keep : [{ start: 0, end: duration, reason: "完整保留" }];
}
function cleanCoverCopy(value, limit = 24) {
  return [...String(value || "").replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim()].slice(0, limit).join("");
}
function normalizeCoverPlan(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const lines = (Array.isArray(value.lines) ? value.lines : []).map(item => cleanCoverCopy(item, 14)).filter(Boolean).slice(0, 3);
  const highlights = (Array.isArray(value.highlights) ? value.highlights : []).map(item => cleanCoverCopy(item, 12)).filter(item => item && lines.some(line => line.includes(item))).slice(0, 3);
  const features = (Array.isArray(value.features) ? value.features : []).map(item => cleanCoverCopy(item, 8)).filter(Boolean).slice(0, 4);
  const sourceTime = Number(value.sourceTime);
  return {
    eyebrow: cleanCoverCopy(value.eyebrow, 12),
    lines,
    highlights,
    features,
    sourceTime: Number.isFinite(sourceTime) && sourceTime >= 0 ? sourceTime : null
  };
}
function validatePlan(raw, duration, fallback, provenance = "semantic") {
  const warnings = [];
  const input = Array.isArray(raw?.keepSegments) ? raw.keepSegments : [];
  const segments = input.map((item, index) => ({
    index,
    start: Number(item?.start),
    end: Number(item?.end),
    reason: String(item?.reason || "AI保留").slice(0, 160)
  })).filter(item => {
    const valid = Number.isFinite(item.start) && Number.isFinite(item.end) && item.start >= 0 && item.end <= duration + 0.05 && item.end - item.start >= 0.35;
    if (!valid) warnings.push(`忽略无效保留片段 #${item.index + 1}`);
    return valid;
  }).sort((a, b) => a.start - b.start).map(({ index, ...item }) => item);

  const merged = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous && segment.start < previous.end - 0.02) {
      warnings.push("模型计划包含重叠片段，已合并");
      previous.end = Math.max(previous.end, segment.end);
      previous.reason = `${previous.reason}；${segment.reason}`.slice(0, 160);
    } else if (previous && segment.start <= previous.end + 0.08) {
      previous.end = Math.max(previous.end, segment.end);
    } else merged.push({ ...segment });
  }
  const retained = merged.reduce((sum, item) => sum + item.end - item.start, 0);
  const retainedFraction = duration > 0 ? retained / duration : 0;
  const validSemantic = merged.length > 0 && retainedFraction >= 0.42 && retainedFraction <= 1.01;
  const keepSegments = validSemantic ? merged : fallback.map(item => ({ ...item }));
  if (!validSemantic) warnings.push("语义计划删除比例异常，已退回本地停顿剪辑");

  const requestedOverlays = Array.isArray(raw?.overlayCards) ? raw.overlayCards : [];
  const overlayCards = requestedOverlays.map((item, index) => {
    const start = Math.max(0, Number(item?.start));
    const end = Math.min(duration, Number(item?.end));
    const keep = keepSegments.find(segment => start >= segment.start && start < segment.end);
    if (!keep || !Number.isFinite(start) || !Number.isFinite(end)) return null;
    const boundedEnd = Math.min(end, keep.end, start + 3.2);
    if (boundedEnd - start < 0.5) return null;
    const items = (Array.isArray(item?.items) ? item.items : []).map(value => String(value || "").trim().slice(0, 14)).filter(Boolean).slice(0, 4);
    const display = item?.display === "side-panel" && items.length >= 2 ? "side-panel" : "banner";
    return { id: `overlay-${index + 1}`, start, end: boundedEnd, text: String(item?.text || "").trim().slice(0, 24), kind: ["hook", "evidence", "result", "lesson"].includes(item?.kind) ? item.kind : "evidence", items, display };
  }).filter(item => item?.text).slice(0, 6);
  if (requestedOverlays.length > overlayCards.length) warnings.push(`动态卡片已从 ${requestedOverlays.length} 张约束为 ${overlayCards.length} 张有效卡片`);

  const confidence = Number(raw?.confidence);
  return {
    keepSegments,
    overlayCards,
    coverDesign: normalizeCoverPlan(raw?.coverDesign),
    provenance: validSemantic ? provenance : "silence-fallback",
    engine: validSemantic ? "text-model" : "local-silence-detect",
    validated: true,
    warnings: [...new Set(warnings)],
    retainedFraction: Number((keepSegments.reduce((sum, item) => sum + item.end - item.start, 0) / duration).toFixed(4)),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null
  };
}
function normalizeOverlays(raw, duration) {
  return (Array.isArray(raw) ? raw : []).map((x, i) => {
    const items = (Array.isArray(x?.items) ? x.items : []).map(value => String(value || "").trim().slice(0, 14)).filter(Boolean).slice(0, 4);
    return { id: `overlay-${i + 1}`, start: Math.max(0, Number(x.start)), end: Math.min(duration, Number(x.end)), text: String(x.text || "").slice(0, 24), kind: String(x.kind || "evidence"), items, display: x?.display === "side-panel" && items.length >= 2 ? "side-panel" : "banner" };
  }).filter(x => x.text && x.end - x.start >= 0.5).slice(0, 6);
}
function feedbackOverlayLimit(feedback) {
  const match = String(feedback || "").match(/(?:卡片|图卡)[^。；;\n]{0,16}(?:只|最多)?(?:保留|要)?([零一二三四五六0-6])张/);
  if (!match) return null;
  const values = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  const value = values[match[1]] ?? Number(match[1]);
  return Number.isFinite(value) ? Math.max(0, Math.min(6, value)) : null;
}
function sourceToOutput(time, keeps) {
  let output = 0;
  for (const keep of keeps) {
    if (time >= keep.start && time <= keep.end) return output + time - keep.start;
    output += keep.end - keep.start;
  }
  return null;
}
function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, "0")}:${String(Math.floor((cs % 6000) / 100)).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}
function assEscape(text) { return String(text || "").replace(/[{}]/g, "").replace(/\r?\n/g, "\\N").replace(/,/g, "，").trim(); }
function captionText(text, script = "") {
  let result = String(text || "").replace(/codex/gi, "Codex");
  if (String(script).includes("三七二十一")) result = result.replace(/3721/g, "三七二十一");
  if (String(script).includes("口播工作台")) result = result.replace(/口婆(?=工作台)/g, "口播");
  if (String(script).includes("我是三金")) result = result.replace(/我是三斤/g, "我是三金");
  if (String(script).includes("管他三七二十一")) result = result.replace(/管它(?=三七二十一)/g, "管他");
  return result;
}
const captionSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
function timedCaptionChars(text, start, end) {
  const chars = [...String(text || "")];
  const span = Math.max(0, Number(end) - Number(start));
  return chars.map((char, index) => ({ char, start: Number(start) + span * index / chars.length, end: Number(start) + span * (index + 1) / chars.length }));
}
function captionBoundaryCarryLength(before, after) {
  const combined = String(before || "") + String(after || "");
  const boundary = [...String(before || "")].length;
  for (const phrase of ["优化"]) {
    const start = combined.lastIndexOf(phrase, boundary - 1);
    const end = start < 0 ? -1 : start + [...phrase].length;
    if (start >= 0 && start < boundary && end > boundary) return boundary - start;
  }
  for (const part of captionSegmenter.segment(combined)) {
    const start = [...combined.slice(0, part.index)].length;
    const end = start + [...part.segment].length;
    if (part.isWordLike && start < boundary && end > boundary) return boundary - start;
  }
  return 0;
}
function transcriptCues(transcript, keeps, script = "") {
  const words = Array.isArray(transcript?.words) ? transcript.words : [];
  if (words.length) {
    const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];
    const mapped = words.map(w => {
      const sourceStart = Number(w.start), sourceEnd = Number(w.end);
      const segmentIndex = segments.findIndex(segment => sourceStart >= Number(segment.start) - 0.04 && sourceStart < Number(segment.end) - 0.01);
      return { text: String(w.word || "").trim(), sourceStart, sourceEnd, segmentIndex, start: sourceToOutput(sourceStart, keeps), end: sourceToOutput(sourceEnd, keeps) };
    }).filter(w => w.text && w.start !== null && w.end !== null).map(word => ({ ...word, chars: timedCaptionChars(word.text, word.start, word.end) }));
    const cues = []; let group = null;
    for (const word of mapped) {
      if (!group) group = { start: word.start, end: word.end, text: word.text, chars: [...word.chars], segmentIndex: word.segmentIndex, lastTokenText: word.text };
      else {
        const segmentBreak = group.segmentIndex >= 0 && word.segmentIndex >= 0 && group.segmentIndex !== word.segmentIndex;
        if (segmentBreak && !/[。！？!?]$/.test(group.text)) {
          group.text += "。";
          group.chars.push({ char: "。", start: group.end, end: group.end });
        }
        const nextText = group.text + word.text;
        const endedSentence = /[。！？!?]$/.test(group.text);
        const endedClause = /[，,；;：:]$/.test(group.text) && (group.end - group.start >= 1 || group.text.length >= 8);
        const gapBreak = word.start - group.end > 0.65;
        const breakNow = segmentBreak || endedSentence || endedClause || gapBreak || nextText.length > 16 || word.end - group.start > 3.2;
        if (breakNow) {
          let carryLength = endedSentence || endedClause || gapBreak || segmentBreak ? 0 : captionBoundaryCarryLength(group.text, word.text);
          const carried = carryLength > 0 && group.chars.length > carryLength ? group.chars.splice(-carryLength) : [];
          if (carried.length) {
            group.text = group.chars.map(item => item.char).join("");
            group.end = group.chars.at(-1).end;
          }
          cues.push(group);
          group = carried.length
            ? { start: carried[0].start, end: word.end, text: carried.map(item => item.char).join("") + word.text, chars: [...carried, ...word.chars], segmentIndex: word.segmentIndex, lastTokenText: word.text }
            : { start: word.start, end: word.end, text: word.text, chars: [...word.chars], segmentIndex: word.segmentIndex, lastTokenText: word.text };
        } else {
          group.text = nextText;
          group.end = word.end;
          group.chars.push(...word.chars);
          group.lastTokenText = word.text;
        }
      }
    }
    if (group) cues.push(group);
    const balanced = [];
    for (const cue of cues) {
      const previous = balanced.at(-1);
      if (previous && cue.text.length <= 2 && cue.start - previous.end <= 0.5 && previous.text.length + cue.text.length <= 18 && !/[。！？!?]$/.test(previous.text)) {
        previous.text += cue.text;
        previous.end = cue.end;
      } else balanced.push(cue);
    }
    return balanced.map(({ chars: _chars, segmentIndex: _segmentIndex, lastTokenText: _lastTokenText, ...cue }) => ({ ...cue, text: captionText(cue.text, script) }));
  }
  return (transcript?.segments || []).map(s => ({ text: captionText(s.text, script), start: sourceToOutput(Number(s.start), keeps), end: sourceToOutput(Number(s.end), keeps) })).filter(x => x.text && x.start !== null && x.end !== null);
}
function normalizeCaptionStyle(value) {
  return ["keyword-pop", "clean-card", "static"].includes(value) ? value : "keyword-pop";
}
function captionKeyword(text) {
  const value = String(text || "");
  const preferred = [
    "AI口播工作台", "口播工作台", "管他三七二十一", "真正解决现实问题", "现实问题", "先做起来",
    "Codex", "AI", "短视频", "程序员", "评论区", "工作流", "口播稿", "剪辑视频", "添加字幕", "第一次", "时间"
  ];
  return preferred.find(keyword => value.toLowerCase().includes(keyword.toLowerCase())) || "";
}
function dynamicCaptionCues(job, timeline) {
  return transcriptCues(job.transcript, job.currentPlan.keepSegments, job.script).map(cue => ({
    start: Math.max(0, Number(cue.start)),
    end: Math.min(timeline.outputDuration, Math.max(Number(cue.start) + 0.35, Number(cue.end))),
    text: String(cue.text || "").trim(),
    keyword: captionKeyword(cue.text)
  })).filter(cue => cue.text && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start && cue.start < timeline.outputDuration);
}
async function renderHyperframesCaptions(jobDir, job, timeline, version) {
  const cues = dynamicCaptionCues(job, timeline);
  if (!cues.length) throw new Error("没有可渲染的字幕时间轴");
  const style = normalizeCaptionStyle(job.options.captionStyle);
  const outputDir = path.join(jobDir, "overlays", `v${version}`);
  await fsp.mkdir(outputDir, { recursive: true });
  const storyboard = path.join(jobDir, `captions-v${version}.json`);
  const output = path.join(outputDir, "captions.webm");
  for (const candidate of [...(job.versions || [])].sort((a, b) => Number(b.version) - Number(a.version))) {
    if (candidate.captionPackaging?.engine !== "hyperframes" || candidate.captionPackaging?.style !== style || Number(candidate.version) >= version) continue;
    const candidateStoryboardPath = path.join(jobDir, `captions-v${candidate.version}.json`);
    const candidateVideoPath = path.join(jobDir, "overlays", `v${candidate.version}`, "captions.webm");
    try {
      const candidateStoryboard = JSON.parse(await fsp.readFile(candidateStoryboardPath, "utf8"));
      if (Math.abs(Number(candidateStoryboard.duration) - timeline.outputDuration) > 0.001 || JSON.stringify(candidateStoryboard.cues) !== JSON.stringify(cues)) continue;
      await fsp.copyFile(candidateVideoPath, output);
      const metadata = await probe(output);
      metadata.alpha = candidate.captionPackaging.metadata?.alpha === true;
      metadata.alphaAverage = candidate.captionPackaging.metadata?.alphaAverage;
      if (metadata.width !== 1080 || metadata.height !== 1920 || Math.abs(metadata.duration - timeline.outputDuration) > 0.45 || metadata.alpha !== true) continue;
      await writeJson(storyboard, { version, engine: "hyperframes", style, duration: timeline.outputDuration, cues, reusedFromVersion: candidate.version, generatedAt: new Date().toISOString() });
      return { requested: style, engine: "hyperframes", style, cues: cues.length, path: output, url: `/video-jobs/${path.basename(jobDir)}/overlays/v${version}/captions.webm`, metadata, reusedFromVersion: candidate.version, fallbackReason: null };
    } catch {}
  }
  const projectDir = path.join(outputDir, "captions-project");
  await fsp.mkdir(projectDir, { recursive: true });
  const templatePath = path.join(here, "hyperframes-captions", "index.html");
  let template = await fsp.readFile(templatePath, "utf8");
  if (!template.includes('data-duration="3"')) throw new Error("动态字幕模板缺少可替换的时长声明");
  template = template.replace('data-duration="3"', `data-duration="${timeline.outputDuration.toFixed(3)}"`).replace("../hyperframes-overlay/gsap.min.js", "./gsap.min.js");
  await fsp.writeFile(path.join(projectDir, "index.html"), template, "utf8");
  await fsp.copyFile(path.join(here, "hyperframes-overlay", "gsap.min.js"), path.join(projectDir, "gsap.min.js"));
  await writeJson(storyboard, { version, engine: "hyperframes", style, duration: timeline.outputDuration, cues, generatedAt: new Date().toISOString() });
  const variablesFile = path.join(outputDir, "caption-variables.json");
  await writeJson(variablesFile, { captionsJson: JSON.stringify(cues), duration: timeline.outputDuration, style });
  await run("npx", ["-y", "hyperframes", "render", projectDir, "--output", output, "--format", "webm", "--variables-file", variablesFile, "--workers", "1", "--quiet", "--sdr"], { cwd: root, shell: true });
  const metadata = await probe(output);
  if (!metadata.videoCodec || Math.abs(metadata.duration - timeline.outputDuration) > 0.45 || metadata.width !== 1080 || metadata.height !== 1920) throw new Error("HyperFrames 动态字幕轨的时长或画幅无效");
  const firstCue = cues[0];
  const sampleTime = Math.min(firstCue.end - 0.05, firstCue.start + Math.max(0.2, Math.min(0.5, (firstCue.end - firstCue.start) / 2)));
  const alpha = await run("ffmpeg", ["-hide_banner", "-c:v", "libvpx-vp9", "-ss", sampleTime.toFixed(3), "-i", output, "-vf", "alphaextract,signalstats,metadata=print", "-frames:v", "1", "-f", "null", "-"]);
  const alphaAverage = Number(alpha.stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/)?.[1]);
  if (!Number.isFinite(alphaAverage) || alphaAverage <= 0 || alphaAverage >= 254.5) throw new Error("HyperFrames 动态字幕轨透明像素检查失败");
  metadata.alpha = true;
  metadata.alphaAverage = alphaAverage;
  return { requested: style, engine: "hyperframes", style, cues: cues.length, path: output, url: `/video-jobs/${path.basename(jobDir)}/overlays/v${version}/captions.webm`, metadata, fallbackReason: null };
}
async function writeAss(jobDir, transcript, keeps, overlays, version, script = "") {
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]", "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Caption,Microsoft YaHei,56,&H00FFFFFF,&H000000FF,&H00101010,&H70000000,-1,0,0,0,100,100,1,0,1,4,0,2,70,70,180,1",
    "Style: Overlay,Microsoft YaHei,76,&H00FFFFFF,&H000000FF,&H00000000,&H900F8278,-1,0,0,0,100,100,1,0,3,2,0,8,90,90,230,1", "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
  ];
  for (const cue of transcriptCues(transcript, keeps, script)) lines.push(`Dialogue: 0,${assTime(cue.start)},${assTime(Math.max(cue.end, cue.start + 0.35))},Caption,,0,0,0,,${assEscape(cue.text)}`);
  for (const overlay of overlays) {
    const start = sourceToOutput(overlay.start, keeps), end = sourceToOutput(overlay.end, keeps);
    if (start !== null && end !== null && end > start) lines.push(`Dialogue: 1,${assTime(start)},${assTime(end)},Overlay,,0,0,0,,{\\fad(180,180)}${assEscape(overlay.text)}`);
  }
  const file = path.join(jobDir, `captions-v${version}.ass`);
  await fsp.writeFile(file, lines.join("\r\n"), "utf8");
  return file;
}
function videoLayoutFilter(layout) {
  const size = layout === "square" ? "1080:1080" : "1080:1920";
  if (layout === "original") return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  return `split=2[bg][fg];[bg]scale=${size}:force_original_aspect_ratio=increase,crop=${size},boxblur=24:8[bg2];[fg]scale=${size}:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2`;
}
function videoColorPipeline(source = {}) {
  const transfer = String(source.colorTransfer || "").toLowerCase();
  const primaries = String(source.colorPrimaries || "").toLowerCase();
  const hdr = transfer === "arib-std-b67" || transfer === "smpte2084" || primaries === "bt2020";
  if (hdr) return {
    input: transfer === "arib-std-b67" ? "hlg-bt2020" : "hdr-bt2020",
    output: "sdr-bt709",
    engine: "zscale-hable",
    filter: "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
  };
  return { input: "sdr-or-unknown", output: "sdr-bt709", engine: "metadata-normalization", filter: "format=yuv420p" };
}
function splitCoverTitle(value) {
  const text = cleanCoverCopy(value, 42);
  if (!text) return [];
  const explicit = text.split(/[\/｜|]+/).map(item => cleanCoverCopy(item, 14)).filter(Boolean);
  if (explicit.length >= 2) return explicit.slice(0, 3);
  const phrases = text.split(/[，。！？；：—-]+/).map(item => cleanCoverCopy(item, 18)).filter(Boolean);
  const source = phrases.length > 1 ? phrases : [text];
  const lines = [];
  for (const phrase of source) {
    const chars = [...phrase];
    while (chars.length && lines.length < 3) lines.push(chars.splice(0, chars.length > 18 ? 10 : 12).join(""));
    if (lines.length >= 3) break;
  }
  return lines.filter(Boolean).slice(0, 3);
}
function coverDesignForJob(job) {
  const planned = normalizeCoverPlan(job.currentPlan?.coverDesign);
  const script = String(job.script || "");
  const override = cleanCoverCopy(job.options?.coverTitle, 42);
  let lines = override ? splitCoverTitle(override) : planned.lines;
  if (!lines.length && /Codex/i.test(script) && /口播工作台/.test(script)) lines = ["我用 Codex", "做了一个", "AI口播工作台"];
  if (!lines.length) lines = splitCoverTitle(job.options?.contentTitle);
  if (!lines.length) {
    const candidates = script.split(/[。！？\n]+/).map(item => cleanCoverCopy(item, 32)).filter(item => item.length >= 6);
    lines = splitCoverTitle(candidates.find(item => /AI|Codex|工作台|视频|工具|项目/i.test(item)) || candidates[0] || "本期口播实战");
  }
  const highlights = planned.highlights.length ? planned.highlights : ["Codex", "AI", "口播工作台"].filter(item => lines.some(line => line.includes(item)));
  const detectedFeatures = [
    [/口播稿|写稿/, "写稿"], [/剪辑/, "剪辑"], [/字幕/, "字幕"], [/工作流/, "工作流"]
  ].filter(([pattern]) => pattern.test(script)).map(([, label]) => label);
  const firstKeep = job.currentPlan?.keepSegments?.[0] || { start: 0, end: Math.max(1, Number(job.source?.duration || 1)) };
  const preferredTime = firstKeep.start + Math.min(5.2, Math.max(0.5, (firstKeep.end - firstKeep.start) * 0.67));
  const sourceTime = planned.sourceTime !== null && (job.currentPlan?.keepSegments || []).some(item => planned.sourceTime >= item.start && planned.sourceTime <= item.end)
    ? planned.sourceTime
    : preferredTime;
  return {
    eyebrow: planned.eyebrow || (/第一次/.test(script) ? "程序员第一次拍视频" : "本期 AI 实战"),
    lines: lines.slice(0, 3),
    highlights,
    features: (planned.features.length ? planned.features : detectedFeatures).slice(0, 4),
    sourceTime: Number(Math.max(0, sourceTime).toFixed(3)),
    source: override ? "user-override" : planned.lines.length ? "ai-plan" : "local-fallback"
  };
}
function coverAssEscape(value) {
  return String(value || "").replace(/[{}]/g, "").replace(/\\/g, "").replace(/\r?\n/g, " ").trim();
}
function coverLineAss(line, highlights) {
  const value = coverAssEscape(line);
  const highlight = highlights.find(item => value.includes(item));
  if (!highlight) return value;
  const index = value.indexOf(highlight);
  return `${value.slice(0, index)}{\\c&H001FD2FF&}${value.slice(index, index + highlight.length)}{\\c&H00FFFFFF&}${value.slice(index + highlight.length)}`;
}
function coverFontSize(line) {
  const weight = [...String(line || "")].reduce((sum, char) => sum + (/^[\x00-\x7F]$/.test(char) ? 0.56 : 1), 0);
  return weight > 10 ? 72 : weight > 8 ? 82 : 96;
}
async function writeCoverAss(coverDir, design) {
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]", "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Main,Microsoft YaHei,96,&H00FFFFFF,&H000000FF,&H0005080A,&H50000000,-1,0,0,0,100,100,0,0,1,5,3,7,0,0,0,1",
    "Style: Eyebrow,Microsoft YaHei,34,&H00101820,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    "Style: Feature,Microsoft YaHei,40,&H00FFFFFF,&H000000FF,&H0005080A,&H00000000,-1,0,0,0,100,100,0,0,1,1,0,7,0,0,0,1", "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 2,0:00:00.00,0:00:10.00,Eyebrow,,0,0,0,,{\\an7\\pos(88,282)}${coverAssEscape(design.eyebrow)}`
  ];
  design.lines.forEach((line, index) => lines.push(`Dialogue: 2,0:00:00.00,0:00:10.00,Main,,0,0,0,,{\\an7\\pos(65,${370 + index * 125})\\fs${coverFontSize(line)}}${coverLineAss(line, design.highlights)}`));
  if (design.features.length) lines.push(`Dialogue: 2,0:00:00.00,0:00:10.00,Feature,,0,0,0,,{\\an7\\pos(90,1598)}${coverAssEscape(design.features.join("  ·  "))}`);
  const file = path.join(coverDir, "cover.ass");
  await fsp.writeFile(file, lines.join("\r\n"), "utf8");
  return file;
}
async function writeHorizontalCoverAss(coverDir, design, width, suffix) {
  const x = width >= 1900 ? 120 : 70;
  const labelX = x + 25;
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, "PlayResY: 1080", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]", "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Main,Microsoft YaHei,88,&H00FFFFFF,&H000000FF,&H0005080A,&H50000000,-1,0,0,0,100,100,0,0,1,5,3,7,0,0,0,1",
    "Style: Eyebrow,Microsoft YaHei,32,&H00101820,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    "Style: Feature,Microsoft YaHei,36,&H00FFFFFF,&H000000FF,&H0005080A,&H00000000,-1,0,0,0,100,100,0,0,1,1,0,7,0,0,0,1", "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 2,0:00:00.00,0:00:10.00,Eyebrow,,0,0,0,,{\\an7\\pos(${labelX},190)}${coverAssEscape(design.eyebrow)}`
  ];
  design.lines.forEach((line, index) => lines.push(`Dialogue: 2,0:00:00.00,0:00:10.00,Main,,0,0,0,,{\\an7\\pos(${x + 5},${300 + index * 125})\\fs${Math.min(88, coverFontSize(line))}}${coverLineAss(line, design.highlights)}`));
  if (design.features.length) lines.push(`Dialogue: 2,0:00:00.00,0:00:10.00,Feature,,0,0,0,,{\\an7\\pos(${x + 30},865)}${coverAssEscape(design.features.join("  ·  "))}`);
  const file = path.join(coverDir, `cover-${suffix}.ass`);
  await fsp.writeFile(file, lines.join("\r\n"), "utf8");
  return file;
}
async function renderCover(job, version) {
  if (job.options?.generateCover === false) return { requested: false, engine: "none", available: false };
  const jobDir = confined(jobsRoot, job.id);
  const coverDir = path.join(jobDir, "covers", `v${version}`);
  await fsp.mkdir(coverDir, { recursive: true });
  const design = coverDesignForJob(job);
  await writeCoverAss(coverDir, design);
  const labelWidth = Math.min(620, Math.max(360, 82 + [...design.eyebrow].length * 39));
  const featureFilters = design.features.length
    ? ",drawbox=x=65:y=1585:w=500:h=72:color=0x06131D@0.82:t=fill"
    : "";
  const color = videoColorPipeline(job.source);
  const filter = `[0:v]${color.filter}[color];[color]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:8[bg2];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2,eq=brightness=-0.035:saturation=0.84:contrast=1.04,drawbox=x=38:y=245:w=720:h=515:color=0x06131D@0.58:t=fill,drawbox=x=38:y=245:w=9:h=515:color=0x2ED6C4@1:t=fill,drawbox=x=65:y=270:w=${labelWidth}:h=62:color=0xFFAA3C@1:t=fill${featureFilters},ass=filename='cover.ass',format=rgb24[cover]`;
  const png9x16 = path.join(coverDir, `cover-v${version}-9x16.png`);
  const jpg9x16 = path.join(coverDir, `cover-v${version}-9x16.jpg`);
  const png3x4 = path.join(coverDir, `cover-v${version}-3x4.png`);
  const jpg3x4 = path.join(coverDir, `cover-v${version}-3x4.jpg`);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(design.sourceTime), "-i", job.sourcePath, "-filter_complex", filter, "-map", "[cover]", "-frames:v", "1", "-update", "1", png9x16], { cwd: coverDir });
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", png9x16, "-q:v", "2", "-pix_fmt", "yuvj420p", "-frames:v", "1", "-update", "1", jpg9x16]);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", png9x16, "-vf", "crop=1080:1440:0:240", "-frames:v", "1", "-update", "1", png3x4]);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", png3x4, "-q:v", "2", "-pix_fmt", "yuvj420p", "-frames:v", "1", "-update", "1", jpg3x4]);
  const renderHorizontal = async (width, suffix) => {
    await writeHorizontalCoverAss(coverDir, design, width, suffix);
    const panelX = width >= 1900 ? 90 : 40;
    const panelWidth = width >= 1900 ? 890 : 750;
    const labelX = panelX + 55;
    const labelWidthHorizontal = Math.min(panelWidth - 90, Math.max(350, 76 + [...design.eyebrow].length * 36));
    const featureHorizontal = design.features.length ? `,drawbox=x=${labelX}:y=850:w=470:h=68:color=0x06131D@0.82:t=fill` : "";
    const foregroundWidth = Math.round(width * 0.52);
    const horizontalFilter = `[0:v]${color.filter}[color];[color]split=2[bg][fg];[bg]scale=${width}:1080:force_original_aspect_ratio=increase,crop=${width}:1080,boxblur=24:8[bg2];[fg]scale=${foregroundWidth}:1080:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=x=W-w-45:y=(H-h)/2,eq=brightness=-0.045:saturation=0.84:contrast=1.05,drawbox=x=${panelX}:y=150:w=${panelWidth}:h=650:color=0x06131D@0.62:t=fill,drawbox=x=${panelX}:y=150:w=9:h=650:color=0x2ED6C4@1:t=fill,drawbox=x=${labelX}:y=178:w=${labelWidthHorizontal}:h=58:color=0xFFAA3C@1:t=fill${featureHorizontal},ass=filename='cover-${suffix}.ass',format=rgb24[cover]`;
    const png = path.join(coverDir, `cover-v${version}-${suffix}.png`);
    const jpg = path.join(coverDir, `cover-v${version}-${suffix}.jpg`);
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(design.sourceTime), "-i", job.sourcePath, "-filter_complex", horizontalFilter, "-map", "[cover]", "-frames:v", "1", "-update", "1", png], { cwd: coverDir });
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", png, "-q:v", "2", "-pix_fmt", "yuvj420p", "-frames:v", "1", "-update", "1", jpg]);
    return { path: jpg, url: `/video-jobs/${job.id}/covers/v${version}/cover-v${version}-${suffix}.jpg`, pngUrl: `/video-jobs/${job.id}/covers/v${version}/cover-v${version}-${suffix}.png`, metadata: await probe(jpg) };
  };
  const wide16x9 = await renderHorizontal(1920, "16x9");
  const landscape4x3 = await renderHorizontal(1440, "4x3");
  const metadata9x16 = await probe(jpg9x16), metadata3x4 = await probe(jpg3x4);
  const artifact = { version, design, engine: "local-ffmpeg-ass", privacy: "local-frame-only", generatedAt: new Date().toISOString() };
  await writeJson(path.join(jobDir, `cover-design-v${version}.json`), artifact);
  return {
    requested: true,
    available: true,
    engine: "local-ffmpeg-ass",
    design,
    privacy: "local-frame-only",
    vertical: { path: jpg9x16, url: `/video-jobs/${job.id}/covers/v${version}/cover-v${version}-9x16.jpg`, pngUrl: `/video-jobs/${job.id}/covers/v${version}/cover-v${version}-9x16.png`, metadata: metadata9x16 },
    grid: { path: jpg3x4, url: `/video-jobs/${job.id}/covers/v${version}/cover-v${version}-3x4.jpg`, pngUrl: `/video-jobs/${job.id}/covers/v${version}/cover-v${version}-3x4.png`, metadata: metadata3x4 },
    wide16x9,
    landscape4x3
  };
}
function outputToSource(time, keeps) {
  let cursor = 0;
  for (const keep of keeps) {
    const length = keep.end - keep.start;
    if (time >= cursor && time <= cursor + length) return keep.start + time - cursor;
    cursor += length;
  }
  return null;
}
function removedRanges(duration, keeps) {
  const removed = []; let cursor = 0;
  for (const keep of keeps) {
    if (keep.start > cursor + 0.01) removed.push({ start: cursor, end: keep.start, duration: keep.start - cursor, reason: "未被剪辑计划保留" });
    cursor = Math.max(cursor, keep.end);
  }
  if (duration > cursor + 0.01) removed.push({ start: cursor, end: duration, duration: duration - cursor, reason: "未被剪辑计划保留" });
  return removed;
}
function buildTimeline(job, plan, version) {
  let outputCursor = 0;
  const clips = plan.keepSegments.map((segment, index) => {
    const duration = segment.end - segment.start;
    const clip = { id: `clip-${String(index + 1).padStart(3, "0")}`, sourceIn: segment.start, sourceOut: segment.end, outputIn: outputCursor, outputOut: outputCursor + duration, duration, reason: segment.reason };
    outputCursor += duration;
    return clip;
  });
  const cards = (plan.overlayCards || []).map(card => {
    const outputStart = sourceToOutput(card.start, plan.keepSegments);
    return { ...card, outputStart, outputEnd: outputStart === null ? null : Math.min(outputCursor, outputStart + Math.min(3.2, Math.max(0.8, card.end - card.start))) };
  }).filter(card => card.outputStart !== null && card.outputEnd > card.outputStart);
  return {
    version,
    source: { path: job.sourcePath, duration: job.source.duration, width: job.source.width, height: job.source.height, fps: job.source.fps },
    outputDuration: outputCursor,
    provenance: plan.provenance,
    engine: plan.engine,
    validated: plan.validated,
    warnings: plan.warnings || [],
    clips,
    removed: removedRanges(job.source.duration, plan.keepSegments),
    cards,
    generatedAt: new Date().toISOString()
  };
}
function edlTime(seconds, fps = 30) {
  const frames = Math.max(0, Math.round(Number(seconds || 0) * fps));
  const hours = Math.floor(frames / (fps * 3600));
  const minutes = Math.floor((frames % (fps * 3600)) / (fps * 60));
  const secs = Math.floor((frames % (fps * 60)) / fps);
  const frame = frames % fps;
  return [hours, minutes, secs, frame].map(value => String(value).padStart(2, "0")).join(":");
}
async function writeTimelineArtifacts(jobDir, timeline, version) {
  await writeJson(path.join(jobDir, `timeline-v${version}.json`), timeline);
  const edl = [`TITLE: KOUBO_V${version}`, "FCM: NON-DROP FRAME", ""];
  timeline.clips.forEach((clip, index) => {
    edl.push(`${String(index + 1).padStart(3, "0")}  AX       V     C        ${edlTime(clip.sourceIn)} ${edlTime(clip.sourceOut)} ${edlTime(clip.outputIn)} ${edlTime(clip.outputOut)}`);
    edl.push(`* FROM CLIP NAME: ${path.basename(timeline.source.path)}`);
    edl.push(`* COMMENT: ${clip.reason}`);
  });
  await fsp.writeFile(path.join(jobDir, `timeline-v${version}.edl`), edl.join("\r\n"), "utf8");
}

const EXTERNAL_SOURCE_TYPES = new Set(["external-creator", "licensed-external"]);
const PAID_SOURCE_TYPES = new Set(["paid-stock", "paid-generated"]);
const APPROVABLE_LICENSE_BASES = new Set(["explicit-authorization", "creator-permission", "platform-license", "commentary-quotation"]);
function mediaKindFor(fileName = "") {
  const extension = path.extname(String(fileName)).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".bmp"].includes(extension)) return "image";
  if ([".mp4", ".mov", ".mkv", ".webm", ".m4v"].includes(extension)) return "video";
  return "unknown";
}
function normalizePlacement(value) {
  const start = Number(value?.start), end = Number(value?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
  const validModes = new Set(["broll", "pip", "comparison-left", "comparison-right"]);
  return { start, end, mode: validModes.has(value?.mode) ? value.mode : "broll" };
}
function normalizeAssetRecord(asset = {}) {
  const reviewStatus = ["pending", "approved", "rejected"].includes(asset.reviewStatus)
    ? asset.reviewStatus
    : asset.approved === true ? "approved" : "pending";
  const sourceType = String(asset.sourceType || (asset.source === "local-upload" ? "local-upload" : "local-upload"));
  const clipStart = Number(asset.clipStart), clipEnd = Number(asset.clipEnd);
  const placement = normalizePlacement(asset.placement);
  return {
    ...asset,
    sourceType,
    mediaKind: asset.mediaKind || mediaKindFor(asset.fileName),
    reviewStatus,
    approved: reviewStatus === "approved",
    placement,
    creatorName: String(asset.creatorName || "").trim(),
    workTitle: String(asset.workTitle || "").trim(),
    sourceUrl: String(asset.sourceUrl || "").trim(),
    usagePurpose: String(asset.usagePurpose || "").trim(),
    licenseBasis: String(asset.licenseBasis || asset.license || "").trim(),
    attributionText: String(asset.attributionText || "").trim(),
    clipStart: Number.isFinite(clipStart) && clipStart >= 0 ? clipStart : 0,
    clipEnd: Number.isFinite(clipEnd) && clipEnd > 0 ? clipEnd : null,
    clipDuration: Number.isFinite(Number(asset.clipDuration)) && Number(asset.clipDuration) > 0
      ? Number(asset.clipDuration)
      : Number.isFinite(clipEnd) && clipEnd > Math.max(0, clipStart) ? clipEnd - Math.max(0, clipStart) : placement ? placement.end - placement.start : null,
    paymentRequired: asset.paymentRequired === true || PAID_SOURCE_TYPES.has(sourceType),
    paymentConfirmed: asset.paymentConfirmed === true,
    generatedLocally: asset.generatedLocally === true,
    discoveredAutomatically: asset.discoveredAutomatically === true
  };
}
function creatorNameIsUsable(value) {
  const name = String(value || "").trim();
  return !!name && !/(待填写|待确认|用户指定参考账号)/.test(name);
}
function advisoryRightsMode(job) { return job?.options?.rightsReviewMode === "advisory"; }
function assetComplianceIssues(rawAsset, job, outputDuration = null) {
  const asset = normalizeAssetRecord(rawAsset);
  const issues = [];
  if (asset.reviewStatus !== "approved") return issues;
  if (!asset.placement) issues.push("缺少有效的成片使用时间段");
  if (asset.placement && Number.isFinite(outputDuration) && asset.placement.end > outputDuration + 0.05) issues.push("使用结束时间超过预计成片时长");
  if (!asset.path || !fs.existsSync(asset.path)) issues.push("缺少可渲染的本地素材文件");
  if (!['image', 'video'].includes(asset.mediaKind)) issues.push("素材必须是图片或视频");
  if (PAID_SOURCE_TYPES.has(asset.sourceType) && !asset.paymentConfirmed) issues.push("付费素材尚未完成费用确认");
  if (EXTERNAL_SOURCE_TYPES.has(asset.sourceType)) {
    if (!creatorNameIsUsable(asset.creatorName)) issues.push("外部素材缺少创作者公开名称");
    if (!asset.workTitle) issues.push("外部素材缺少作品标题");
    if (!/^https?:\/\//i.test(asset.sourceUrl)) issues.push("外部素材缺少有效原链接");
    if (!asset.usagePurpose) issues.push("外部素材缺少具体使用目的");
    if (!advisoryRightsMode(job) && !APPROVABLE_LICENSE_BASES.has(asset.licenseBasis)) issues.push("外部素材缺少可接受的授权或引用依据");
    if (!asset.attributionText || (asset.creatorName && !asset.attributionText.includes(asset.creatorName))) issues.push("画面署名必须包含创作者名称");
    if (!Number.isFinite(Number(asset.clipStart)) || Number(asset.clipStart) < 0) issues.push("外部素材缺少有效截取开始时间");
    if (!Number.isFinite(Number(asset.clipEnd)) || Number(asset.clipEnd) <= Number(asset.clipStart)) issues.push("外部素材缺少有效截取结束时间");
    if (!Number.isFinite(asset.clipDuration) || asset.clipDuration <= 0) issues.push("外部素材缺少引用片段时长");
    if (Number.isFinite(Number(asset.clipEnd)) && Number.isFinite(asset.clipDuration) && Math.abs((Number(asset.clipEnd) - Number(asset.clipStart)) - Number(asset.clipDuration)) > 0.15) issues.push("引用片段时长与截取起止时间不一致");
    if (asset.mediaKind === "video" && asset.placement && Number.isFinite(asset.clipDuration) && Number(asset.clipDuration) + 0.05 < asset.placement.end - asset.placement.start) issues.push("引用片段短于成片中的使用时长");
    if (!advisoryRightsMode(job) && (!creatorNameIsUsable(asset.creatorName) || !String(job.script || "").includes(asset.creatorName))) issues.push("口播稿没有自然说明所采用的创作者名称");
    if (asset.licenseBasis === "commentary-quotation") {
      if (!/(介绍|评论|分析|说明|拆解)/.test(asset.usagePurpose)) issues.push("评论性引用必须写明介绍、评论、分析、说明或拆解目的");
      if (Number(asset.clipDuration) > 10.01) issues.push("本工作流将未明确授权的评论性引用限制为单段10秒以内");
    }
  }
  return [...new Set(issues)];
}
function assetReviewSummary(job, outputDuration = null) {
  const assets = (job.assets || []).map(normalizeAssetRecord);
  const pending = assets.filter(asset => asset.reviewStatus === "pending");
  const approved = assets.filter(asset => asset.reviewStatus === "approved");
  const rejected = assets.filter(asset => asset.reviewStatus === "rejected");
  const complianceIssues = approved.flatMap(asset => assetComplianceIssues(asset, job, outputDuration).map(issue => ({ assetId: asset.id, issue })));
  return {
    total: assets.length,
    pending: pending.length,
    approved: approved.length,
    rejected: rejected.length,
    reviewComplete: assets.length > 0 && pending.length === 0,
    renderReady: assets.length > 0 && pending.length === 0 && complianceIssues.length === 0,
    complianceIssues
  };
}
function candidatePlacement(index, count, duration) {
  const safeDuration = Math.max(1, Number(duration || 1));
  const slot = safeDuration / Math.max(1, count);
  const start = Math.min(Math.max(0, safeDuration - 0.5), slot * index);
  const visible = Math.max(0.5, Math.min(4, slot));
  return { start: Number(start.toFixed(2)), end: Number(Math.min(safeDuration, start + visible).toFixed(2)), mode: "broll" };
}
function outputTimeToSource(job, outputTime) {
  let cursor = 0;
  for (const segment of job.currentPlan?.keepSegments || []) {
    const duration = Math.max(0, Number(segment.end) - Number(segment.start));
    if (outputTime <= cursor + duration) return Math.max(Number(segment.start), Number(segment.start) + outputTime - cursor);
    cursor += duration;
  }
  return Math.max(0, Math.min(Number(job.source?.duration || 0) - 0.2, Number(outputTime || 0)));
}
function richVisualArchetype(beat = {}, index = 0) {
  const text = `${beat.segment || ""} ${beat.asset || ""} ${beat.purpose || ""}`;
  if (index === 0 || /(最终|效果|前后|对比|基础版|返修版)/.test(text)) return "proof-comparison";
  if (/(角色|分工|Codex|HyperFrames|转录|渲染)/i.test(text)) return "workflow-map";
  if (/(输入|提示|告诉AI|提交|素材与目标)/i.test(text)) return "prompt-console";
  if (/(检查|审核|字幕|遮挡|裁切|问题)/i.test(text)) return "review-scan";
  return "screen-demo";
}
function richVisualCopy(archetype, beat = {}) {
  const title = String(beat.segment || "AI剪辑视觉证据").trim();
  const variants = {
    "proof-comparison": { kicker: "同一段口播 · 实际效果", headline: "左边原片，右边AI剪辑后", chips: ["动态字幕", "重点卡片", "节奏变化"] },
    "workflow-map": { kicker: "不是一个AI包办", headline: "理解 → 动效 → 交付", chips: ["读懂内容", "生成视觉", "本地渲染"] },
    "prompt-console": { kicker: "把成片标准一起交给AI", headline: "原片 + 重点 + 视觉要求", chips: ["不改原意", "重点动态化", "横竖屏输出"] },
    "review-scan": { kicker: "第一版不能只看导出成功", headline: "逐项检查，再具体返修", chips: ["字幕", "遮挡", "切换", "裁切"] },
    "screen-demo": { kicker: "真实工作流画面", headline: title, chips: ["原片", "AI理解", "视觉结果"] }
  };
  return { title, ...(variants[archetype] || variants["screen-demo"]) };
}
async function writeRichCandidateAss(dir, asset, archetype, beat, duration) {
  const assFile = path.join(dir, `${asset.id}.ass`);
  const copy = richVisualCopy(archetype, beat);
  const chipPositions = archetype === "workflow-map"
    ? [[120, 1030], [360, 1030], [600, 1030]]
    : archetype === "review-scan"
      ? [[390, 520], [390, 650], [390, 780], [390, 910]]
      : [[110, 1050], [360, 1050], [610, 1050]];
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 720", "PlayResY: 1280", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]", "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Kicker,Microsoft YaHei,26,&H003ADCC8,&H000000FF,&H00101920,&H00000000,-1,0,0,0,100,100,1,0,1,1,0,7,54,54,0,1",
    "Style: Headline,Microsoft YaHei,48,&H00FFFFFF,&H000000FF,&H00101920,&H00000000,-1,0,0,0,100,100,1,0,1,2,0,7,54,54,0,1",
    "Style: Chip,Microsoft YaHei,25,&H00FFFFFF,&H000000FF,&H00101920,&H9007131D,-1,0,0,0,100,100,1,0,3,1,0,5,20,20,16,1",
    "Style: Label,Microsoft YaHei,24,&H00FFFFFF,&H000000FF,&H00101920,&H9007131D,-1,0,0,0,100,100,1,0,3,1,0,5,20,20,12,1", "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 5,0:00:00.05,0:00:0${duration.toFixed(2)},Kicker,,0,0,0,,{\\pos(54,75)\\fad(180,180)}${assEscape(copy.kicker)}`,
    `Dialogue: 5,0:00:00.18,0:00:0${duration.toFixed(2)},Headline,,0,0,0,,{\\pos(54,125)\\fad(220,180)}${assEscape(wrapCardText(copy.headline, 13, 2))}`
  ];
  if (archetype === "proof-comparison") {
    lines.push(`Dialogue: 6,0:00:00.35,0:00:0${duration.toFixed(2)},Label,,0,0,0,,{\\pos(180,320)\\fad(140,160)}原片`);
    lines.push(`Dialogue: 6,0:00:00.55,0:00:0${duration.toFixed(2)},Label,,0,0,0,,{\\pos(540,320)\\fad(140,160)}AI剪辑后`);
  }
  copy.chips.forEach((chip, index) => {
    const [x, y] = chipPositions[index] || [110 + index * 220, 1050];
    const start = 0.65 + index * 0.42;
    lines.push(`Dialogue: 7,0:00:0${start.toFixed(2)},0:00:0${duration.toFixed(2)},Chip,,0,0,0,,{\\pos(${x},${y})\\fad(180,180)\\fscx110\\fscy110\\t(0,220,\\fscx100\\fscy100)}${assEscape(chip)}`);
  });
  await fsp.writeFile(assFile, lines.join("\r\n"), "utf8");
  return assFile;
}
async function writeGeneratedMotionCandidate(job, asset, beat, index) {
  if (!job.sourcePath || !fs.existsSync(job.sourcePath)) throw new Error("缺少真人原片，无法生成富媒体候选");
  const dir = path.join(confined(jobsRoot, job.id), "assets", "generated");
  await fsp.mkdir(dir, { recursive: true });
  const duration = Math.max(3.2, Math.min(4, Number(asset.placement?.end || 4) - Number(asset.placement?.start || 0)));
  asset.placement.end = Number((asset.placement.start + duration).toFixed(2));
  const archetype = richVisualArchetype(beat, index);
  const sourceStart = outputTimeToSource(job, asset.placement.start);
  const assFile = await writeRichCandidateAss(dir, asset, archetype, beat, duration);
  const output = path.join(dir, `${asset.id}.mp4`);
  const commonBg = "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=22:8,eq=brightness=-0.18:saturation=0.72";
  let filter;
  if (archetype === "proof-comparison") {
    filter = `[0:v]split=3[bg][left][right];[bg]${commonBg}[bg0];[left]scale=340:604:force_original_aspect_ratio=increase,crop=340:604,eq=saturation=0.38:contrast=0.9[left0];[right]scale=340:604:force_original_aspect_ratio=increase,crop=340:604,eq=saturation=1.18:contrast=1.08,unsharp=5:5:0.65[right0];[bg0][left0]overlay=14:350[tmp];[tmp][right0]overlay=366:350,drawbox=x=12:y=348:w=344:h=608:color=0x9AA9B5@0.7:t=3,drawbox=x=364:y=348:w=344:h=608:color=0x2ED6C4@0.95:t=4,drawbox=x='364+mod(t*150,330)':y=936:w=24:h=5:color=0xFFAA3C@1:t=fill,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
  } else if (archetype === "workflow-map") {
    filter = `[0:v]split=2[bg][fg];[bg]${commonBg}[bg0];[fg]scale=610:720:force_original_aspect_ratio=increase,crop=610:720,eq=saturation=1.08[fg0];[bg0][fg0]overlay=55:240,drawbox=x=52:y=237:w=616:h=726:color=0x2ED6C4@0.85:t=4,drawbox=x=55:y=990:w=190:h=105:color=0x102D3D@0.96:t=fill,drawbox=x=265:y=990:w=190:h=105:color=0x17364A@0.96:t=fill,drawbox=x=475:y=990:w=190:h=105:color=0x102D3D@0.96:t=fill,drawbox=x='80+mod(t*175,540)':y=1125:w=44:h=8:color=0xFFAA3C@1:t=fill,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
  } else if (archetype === "prompt-console") {
    filter = `[0:v]${commonBg},drawbox=x=48:y=220:w=624:h=790:color=0x081824@0.94:t=fill,drawbox=x=48:y=220:w=624:h=790:color=0x2ED6C4@0.72:t=4,drawbox=x=78:y=350:w=500:h=18:color=0xFFFFFF@0.16:t=fill,drawbox=x=78:y=420:w=560:h=18:color=0xFFFFFF@0.12:t=fill,drawbox=x=78:y=490:w=420:h=18:color=0xFFFFFF@0.12:t=fill,drawbox=x=78:y=560:w=530:h=18:color=0xFFFFFF@0.12:t=fill,drawbox=x=78:y=650:w='120+min(t,2.8)*145':h=54:color=0x2ED6C4@0.82:t=fill,drawbox=x='90+mod(t*125,500)':y=740:w=5:h=68:color=0xFFAA3C@1:t=fill,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
  } else if (archetype === "review-scan") {
    filter = `[0:v]split=2[bg][fg];[bg]${commonBg}[bg0];[fg]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,eq=saturation=0.9[fg0];[bg0][fg0]overlay=0:0,drawbox=x=330:y=340:w=340:h=680:color=0x07131D@0.90:t=fill,drawbox=x=330:y=340:w=340:h=680:color=0x2ED6C4@0.75:t=3,drawbox=x=350:y='370+mod(t*175,600)':w=300:h=4:color=0xFFAA3C@0.95:t=fill,drawbox=x=54:y=1040:w='40+min(t,3.2)*175':h=10:color=0x2ED6C4@0.9:t=fill,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
  } else {
    filter = `[0:v]split=2[bg][fg];[bg]${commonBg}[bg0];[fg]scale=610:1084:force_original_aspect_ratio=increase,crop=610:1084,eq=saturation=1.08[fg0];[bg0][fg0]overlay=55:175,drawbox=x=52:y=172:w=616:h=1090:color=0x2ED6C4@0.82:t=4,drawbox=x='70+mod(t*145,560)':y=1160:w=60:h=8:color=0xFFAA3C@1:t=fill,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
  }
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", sourceStart.toFixed(3), "-t", duration.toFixed(3), "-i", job.sourcePath, "-filter_complex", filter, "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-movflags", "+faststart", output], { cwd: dir });
  await run("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
  asset.path = output;
  asset.url = `/video-jobs/${job.id}/assets/generated/${asset.id}.mp4`;
  asset.fileName = `${asset.id}.mp4`;
  asset.mediaKind = "video";
  asset.previewUrl = asset.url;
  asset.visualArchetype = archetype;
  asset.clipStart = 0;
  asset.clipEnd = duration;
  asset.clipDuration = duration;
  asset.generationEngine = "ffmpeg-rich-motion";
}
function wrapCardText(value, width, maxLines) {
  const chars = [...String(value || "").trim()];
  const lines = [];
  while (chars.length && lines.length < maxLines) lines.push(chars.splice(0, width).join(""));
  if (chars.length && lines.length) lines[lines.length - 1] = `${[...lines[lines.length - 1]].slice(0, Math.max(1, width - 1)).join("")}…`;
  return lines.join("\n");
}
async function writeGeneratedCandidateCard(job, asset, title, purpose) {
  const dir = path.join(confined(jobsRoot, job.id), "assets", "generated");
  await fsp.mkdir(dir, { recursive: true });
  const assFile = path.join(dir, `${asset.id}.ass`), output = path.join(dir, `${asset.id}.png`);
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]", "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Tag,Microsoft YaHei,34,&H00101820,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,1,0,1,0,0,7,90,90,0,1",
    "Style: Title,Microsoft YaHei,76,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,1,0,1,2,0,7,90,90,0,1",
    "Style: Body,Microsoft YaHei,42,&H00D9E7EF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,1,0,1,0,0,7,90,90,0,1", "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 1,0:00:00.00,0:00:01.00,Tag,,0,0,0,,{\\pos(95,315)}AI 自动准备 · 本地零费用`,
    `Dialogue: 1,0:00:00.00,0:00:01.00,Title,,0,0,0,,{\\pos(95,455)}${assEscape(wrapCardText(title, 12, 2))}`,
    `Dialogue: 1,0:00:00.00,0:00:01.00,Body,,0,0,0,,{\\pos(95,690)}${assEscape(wrapCardText(purpose, 18, 3))}`
  ];
  await fsp.writeFile(assFile, lines.join("\r\n"), "utf8");
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x07131D:s=1080x1920:d=1", "-vf", `drawbox=x=70:y=270:w=940:h=650:color=0x0D2635@1:t=fill,drawbox=x=70:y=270:w=10:h=650:color=0x2ED6C4@1:t=fill,drawbox=x=90:y=300:w=455:h=62:color=0xFFAA3C@1:t=fill,ass=filename='${path.basename(assFile)}'`, "-frames:v", "1", "-update", "1", output], { cwd: dir });
  asset.path = output;
  asset.url = `/video-jobs/${job.id}/assets/generated/${asset.id}.png`;
  asset.fileName = `${asset.id}.png`;
  asset.mediaKind = "image";
  asset.previewUrl = asset.url;
}
async function discoverLocalProjectAssets(job) {
  if (!job.contentId) return [];
  const dir = confined(contentRoot, safeName(job.contentId));
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter(entry => entry.isFile() && ["image", "video"].includes(mediaKindFor(entry.name))).slice(0, 6).map((entry, index) => ({
    id: `local-${crypto.randomBytes(4).toString("hex")}`,
    fileName: entry.name,
    path: path.join(dir, entry.name),
    url: `/content-items/${safeName(job.contentId)}/${encodeURIComponent(entry.name)}`,
    previewUrl: `/content-items/${safeName(job.contentId)}/${encodeURIComponent(entry.name)}`,
    sourceType: "local-derived",
    sourceLabel: "当前内容包本地素材",
    mediaKind: mediaKindFor(entry.name),
    title: `本地证据素材 ${index + 1}`,
    usagePurpose: "展示本次口播对应的真实项目证据",
    licenseBasis: "user-owned-local",
    ownership: "user-owned-local",
    reviewStatus: "pending",
    approved: false,
    discoveredAutomatically: true,
    placement: null,
    createdAt: new Date().toISOString()
  }));
}
async function prepareAssetCandidates(job, { force = false, reason = "" } = {}) {
  if (job.assetDiscovery?.preparedAt && !force) return job.assetDiscovery;
  if (force) {
    job.assetHistory = [...(job.assetHistory || []), {
      archivedAt: new Date().toISOString(),
      reason: reason || "重新发现素材",
      discovery: job.assetDiscovery || null,
      assets: job.assets || []
    }];
    job.assets = (job.assets || []).filter(asset => asset.discoveredAutomatically !== true);
    delete job.assetDiscovery;
  }
  const duration = (job.currentPlan?.keepSegments || []).reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || Number(job.source?.duration || 0);
  const beats = (job.contentDirection?.shooting?.visualBeats || []).filter(item => item && (item.asset || item.purpose)).slice(0, 6);
  const assets = [];
  const visualNodes = (beats.length ? beats : (job.currentPlan?.overlayCards || []).map(card => ({ segment: card.text, asset: card.text, purpose: "强化当前口播重点" }))).slice(0, 6);
  if (!visualNodes.length) visualNodes.push({ segment: "开头结果", asset: "本次口播的核心结果信息卡", purpose: "让观众先看到本条视频要交付的结果" });
  for (const [index, beat] of visualNodes.entries()) {
    const asset = {
      id: `generated-${crypto.randomBytes(4).toString("hex")}`,
      sourceType: "local-derived",
      sourceLabel: "真实原片衍生动态素材",
      title: String(beat.segment || `视觉节点 ${index + 1}`),
      usagePurpose: String(beat.purpose || beat.asset || "强化当前口播内容"),
      requestedAsset: String(beat.asset || "本地信息卡"),
      licenseBasis: "user-owned-local",
      ownership: "user-owned-local",
      reviewStatus: "pending",
      approved: false,
      generatedLocally: true,
      discoveredAutomatically: true,
      paymentRequired: false,
      paymentConfirmed: true,
      placement: candidatePlacement(index, visualNodes.length, duration),
      createdAt: new Date().toISOString()
    };
    try {
      await writeGeneratedMotionCandidate(job, asset, beat, index);
    } catch (error) {
      asset.generationFallback = error.message;
      asset.sourceType = "ai-generated-free";
      asset.sourceLabel = "本地规则生成信息卡（动态素材失败回退）";
      asset.licenseBasis = "locally-generated";
      await writeGeneratedCandidateCard(job, asset, asset.title, asset.usagePurpose);
    }
    assets.push(asset);
  }
  assets.push(...await discoverLocalProjectAssets(job));
  const sourceIds = new Set((job.contentDirection?.referenceResearch?.sourceIds || []).map(String));
  const catalog = await referenceCatalog();
  for (const item of catalog.filter(entry => sourceIds.has(String(entry.sourceId))).slice(0, 3)) {
    const creatorName = String(item.creatorName || "待填写创作者公开名称");
    const placement = candidatePlacement(Math.min(assets.length, Math.max(1, visualNodes.length - 1)), Math.max(visualNodes.length, 2), duration);
    assets.push({
      id: `external-${crypto.randomBytes(4).toString("hex")}`,
      fileName: "待附加已获授权或必要引用片段",
      path: null,
      url: null,
      previewUrl: null,
      sourceType: "external-creator",
      sourceLabel: "口播稿参考视频候选",
      mediaKind: "video",
      title: item.topic || "外部参考视频",
      creatorName,
      workTitle: item.topic || "",
      sourceUrl: item.url || "",
      creatorProfileUrl: item.creatorProfileUrl || "",
      usagePurpose: "",
      licenseBasis: "",
      attributionText: creatorNameIsUsable(creatorName) ? `来源：${creatorName}｜${item.topic || "原视频"}` : "",
      clipStart: 0,
      clipEnd: null,
      clipDuration: null,
      reviewStatus: "pending",
      approved: false,
      discoveredAutomatically: true,
      paymentRequired: false,
      paymentConfirmed: true,
      placement,
      createdAt: new Date().toISOString()
    });
  }
  job.assets = [...(job.assets || []), ...assets].map(normalizeAssetRecord);
  job.assetDiscovery = {
    preparedAt: new Date().toISOString(),
    visualNodes: visualNodes.map((beat, index) => ({ id: `visual-node-${index + 1}`, segment: String(beat.segment || ""), requestedAsset: String(beat.asset || ""), purpose: String(beat.purpose || ""), placement: candidatePlacement(index, visualNodes.length, duration) })),
    sourcePriority: ["local-derived", "licensed-free", "authorized-external", "commentary-quotation", "paid-with-confirmation"],
    localCandidates: assets.filter(asset => !EXTERNAL_SOURCE_TYPES.has(asset.sourceType)).length,
    externalCandidates: assets.filter(asset => EXTERNAL_SOURCE_TYPES.has(asset.sourceType)).length,
    freeStockConnector: "not-configured",
    visualStrategy: {
      mode: "rich-media-first",
      preferredMix: ["真人口播", "真实工作台或项目画面", "前后对比", "动态流程图", "AI生成视觉", "少量动态文字"],
      textOnlyCardsMaxShare: 0.2,
      referenceClipSeconds: { min: 2, max: 5 }
    },
    paidGeneration: { enabled: true, requiresExplicitCostConfirmation: job.options?.paidImageGenerationConfirmation !== false },
    rightsReviewMode: job.options?.rightsReviewMode || "strict",
    note: "已切换为富媒体优先：候选以真人原片衍生画面、前后对比、动态流程和真实项目证据为主，文字卡片只作补充；参考视频仅在必要时使用2—5秒并保留来源。"
  };
  job.assetReview = assetReviewSummary(job, duration);
  await writeJson(path.join(confined(jobsRoot, job.id), "asset-candidates.json"), { discovery: job.assetDiscovery, assets: job.assets });
  await saveJob(job);
  return job.assetDiscovery;
}
async function ensureMediaManifest(job, version) {
  const jobDir = confined(jobsRoot, job.id);
  const outputDuration = job.currentPlan?.keepSegments?.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || null;
  const assets = (job.assets || []).map(raw => {
    const asset = normalizeAssetRecord(raw);
    const complianceIssues = assetComplianceIssues(asset, job, outputDuration);
    return {
      id: asset.id,
      fileName: asset.fileName,
      path: asset.path,
      url: asset.url,
      sourceType: asset.sourceType,
      sourceLabel: asset.sourceLabel || "",
      mediaKind: asset.mediaKind,
      ownership: asset.ownership || "",
      creatorName: asset.creatorName,
      workTitle: asset.workTitle,
      sourceUrl: asset.sourceUrl,
      clipStart: asset.clipStart,
      clipEnd: asset.clipEnd,
      clipDuration: asset.clipDuration,
      usagePurpose: asset.usagePurpose,
      licenseBasis: asset.licenseBasis,
      attributionText: asset.attributionText,
      paymentRequired: asset.paymentRequired,
      paymentConfirmed: asset.paymentConfirmed,
      reviewStatus: asset.reviewStatus,
      approved: asset.reviewStatus === "approved",
      placement: asset.placement,
      complianceIssues,
      eligibleForRender: asset.reviewStatus === "approved" && complianceIssues.length === 0,
      composited: false
    };
  });
  const review = assetReviewSummary(job, outputDuration);
  const manifest = {
    version,
    policy: "rich-media-first-user-approved",
    cloudGenerationEnabled: job.options?.cloudImageGenerationEnabled === true,
    paidGenerationRequiresConfirmation: job.options?.paidImageGenerationConfirmation !== false,
    rightsReviewMode: job.options?.rightsReviewMode || "strict",
    externalUploadEnabled: false,
    review,
    assets,
    generatedAt: new Date().toISOString()
  };
  await writeJson(path.join(jobDir, `media-manifest-v${version}.json`), manifest);
  return manifest;
}
function masterDimensions(job) {
  if (job.options?.layout === "square") return { width: 1080, height: 1080 };
  if (job.options?.layout === "original") return { width: Math.max(2, Math.floor(Number(job.source?.width || 1080) / 2) * 2), height: Math.max(2, Math.floor(Number(job.source?.height || 1920) / 2) * 2) };
  return { width: 1080, height: 1920 };
}
async function buildMediaRenderPlan(job, version, manifest, firstInputIndex) {
  const renderable = manifest.assets.filter(asset => asset.eligibleForRender);
  const dimensions = masterDimensions(job);
  const inputArgs = [], filters = [], attributions = [];
  let inputIndex = firstInputIndex;
  for (const asset of renderable) {
    const placementDuration = asset.placement.end - asset.placement.start;
    if (asset.mediaKind === "image") inputArgs.push("-loop", "1", "-framerate", "30", "-t", placementDuration.toFixed(3), "-i", asset.path);
    else {
      const sourceStart = Math.max(0, Number(asset.clipStart || 0));
      const metadata = await probe(asset.path);
      if (!metadata.videoCodec || sourceStart + placementDuration > metadata.duration + 0.1) throw new Error(`素材 ${asset.id} 的截取区间超过本地视频时长`);
      asset.renderSourceMetadata = { duration: metadata.duration, width: metadata.width, height: metadata.height, videoCodec: metadata.videoCodec };
      inputArgs.push("-ss", sourceStart.toFixed(3), "-t", placementDuration.toFixed(3), "-i", asset.path);
    }
    const mode = asset.placement.mode || "broll";
    const targetWidthRaw = mode.startsWith("comparison-") ? Math.floor(dimensions.width / 2) : mode === "pip" ? Math.floor(dimensions.width * 0.42) : dimensions.width;
    const targetHeightRaw = mode.startsWith("comparison-") ? dimensions.height : mode === "pip" ? Math.floor(dimensions.height * 0.42) : dimensions.height;
    const targetWidth = Math.max(2, Math.floor(targetWidthRaw / 2) * 2), targetHeight = Math.max(2, Math.floor(targetHeightRaw / 2) * 2);
    filters.push(`[${inputIndex}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=0x07131D,setsar=1,trim=duration=${placementDuration.toFixed(3)},setpts=PTS-STARTPTS+${asset.placement.start.toFixed(3)}/TB[media${inputIndex}]`);
    const x = mode === "comparison-right" ? dimensions.width - targetWidth : mode === "pip" ? dimensions.width - targetWidth - 42 : 0;
    const y = mode === "pip" ? Math.round(dimensions.height * 0.14) : 0;
    filters.push(`[__MEDIA_BASE__][media${inputIndex}]overlay=x=${x}:y=${y}:eof_action=pass:shortest=0[__MEDIA_OUT__]`);
    if (EXTERNAL_SOURCE_TYPES.has(asset.sourceType)) attributions.push({ start: asset.placement.start, end: asset.placement.end, text: asset.attributionText });
    asset.scheduledForComposite = true;
    inputIndex += 1;
  }
  const attributionFile = attributions.length ? await writeMediaAttributionAss(confined(jobsRoot, job.id), attributions, version, dimensions) : null;
  manifest.review = assetReviewSummary(job, manifest.review?.outputDuration || null);
  manifest.renderedAssetIds = renderable.map(asset => asset.id);
  manifest.attributionTrack = attributionFile ? path.basename(attributionFile) : null;
  manifest.generatedAt = new Date().toISOString();
  await writeJson(path.join(confined(jobsRoot, job.id), `media-manifest-v${version}.json`), manifest);
  return { inputArgs, filters, attributions, attributionFile, renderable, nextInputIndex: inputIndex, dimensions };
}
async function finalizeMediaManifest(job, version, manifest, mediaPlan) {
  const rendered = new Set(mediaPlan.renderable.map(asset => asset.id));
  for (const asset of manifest.assets) {
    asset.composited = rendered.has(asset.id);
    asset.scheduledForComposite = false;
  }
  manifest.renderedAssetIds = [...rendered];
  manifest.renderCompletedAt = new Date().toISOString();
  await writeJson(path.join(confined(jobsRoot, job.id), `media-manifest-v${version}.json`), manifest);
  return manifest;
}
async function writeMediaAttributionAss(jobDir, attributions, version, dimensions) {
  const fontSize = dimensions.height <= 1080 ? 30 : 36;
  const margin = dimensions.height <= 1080 ? 44 : 92;
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${dimensions.width}`, `PlayResY: ${dimensions.height}`, "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]", "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: Source,Microsoft YaHei,${fontSize},&H00FFFFFF,&H000000FF,&H00101010,&H9007131D,0,0,0,0,100,100,0,0,3,2,0,1,${margin},${margin},${margin},1`, "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
  ];
  for (const item of attributions) lines.push(`Dialogue: 3,${assTime(item.start)},${assTime(item.end)},Source,,0,0,0,,{\\fad(120,120)}${assEscape(item.text)}`);
  const file = path.join(jobDir, `media-attribution-v${version}.ass`);
  await fsp.writeFile(file, lines.join("\r\n"), "utf8");
  return file;
}
function informationPanelItems(card) {
  const explicit = (Array.isArray(card?.items) ? card.items : []).map(value => String(value || "").trim().slice(0, 14)).filter(Boolean).slice(0, 4);
  if (explicit.length) return explicit;
  const text = String(card?.text || "");
  if (/口播工作台/i.test(text)) return ["写口播稿", "剪辑视频", "添加字幕"];
  return [];
}
async function renderHyperframesCards(jobDir, timeline, version, options = {}) {
  if (!timeline.cards.length) return { engine: "none", clips: [] };
  const outputDir = path.join(jobDir, "overlays", `v${version}`);
  await fsp.mkdir(outputDir, { recursive: true });
  const clips = [];
  for (const [index, card] of timeline.cards.entries()) {
    const variablesFile = path.join(outputDir, `card-${index + 1}.json`);
    const output = path.join(outputDir, `card-${index + 1}.webm`);
    const items = informationPanelItems(card);
    const mode = options.informationPanels !== false && items.length >= 2 ? "side-panel" : "banner";
    await writeJson(variablesFile, { text: card.text, kind: card.kind, itemsJson: JSON.stringify(items), mode });
    await run("npx", ["-y", "hyperframes", "render", path.join(here, "hyperframes-overlay"), "--output", output, "--format", "webm", "--variables-file", variablesFile, "--workers", "1", "--quiet", "--sdr"], { cwd: root, shell: true });
    const metadata = await probe(output);
    if (!metadata.videoCodec || metadata.duration < 2.8) throw new Error(`HyperFrames 卡片 ${index + 1} 输出无效`);
    const alpha = await run("ffmpeg", ["-hide_banner", "-c:v", "libvpx-vp9", "-ss", "0.5", "-i", output, "-vf", "alphaextract,signalstats,metadata=print", "-frames:v", "1", "-f", "null", "-"]);
    const alphaAverage = Number(alpha.stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/)?.[1]);
    if (!Number.isFinite(alphaAverage) || alphaAverage <= 0 || alphaAverage >= 254.5) throw new Error(`HyperFrames 卡片 ${index + 1} 透明像素检查失败`);
    metadata.alpha = true; metadata.alphaAverage = alphaAverage;
    clips.push({ ...card, mode, items, path: output, url: `/video-jobs/${path.basename(jobDir)}/overlays/v${version}/card-${index + 1}.webm`, metadata });
  }
  return { engine: "hyperframes", clips };
}
function variantFilter(layout) {
  if (layout === "vertical") return "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black";
  if (layout === "square") return "split=2[bg][fg];[bg]scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,boxblur=24:8[bg2];[fg]scale=1080:1080:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2";
  return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
}
async function renderVariants(job, version, masterPath) {
  if (job.options.generateVariants === false) return {};
  const dir = path.join(confined(jobsRoot, job.id), "variants", `v${version}`);
  await fsp.mkdir(dir, { recursive: true });
  const variants = {};
  const master = await probe(masterPath);
  const sourceRatio = job.source.width / Math.max(job.source.height, 1);
  const masterRatio = master.width / Math.max(master.height, 1);
  const layouts = ["vertical", "square"];
  if (Math.abs(sourceRatio - masterRatio) <= 0.01) layouts.push("original");
  for (const layout of layouts) {
    const output = path.join(dir, `final-${layout}.mp4`);
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", masterPath, "-vf", variantFilter(layout), "-c:v", "libx264", "-preset", "fast", "-crf", "21", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-c:a", "copy", "-movflags", "+faststart", output]);
    variants[layout] = {
      path: output,
      url: `/video-jobs/${job.id}/variants/v${version}/final-${layout}.mp4`,
      metadata: await probe(output),
      source: "approved-master",
      preservesSourceAspect: layout === "original"
    };
  }
  if (!layouts.includes("original")) variants.original = {
    available: false,
    reason: "母版画幅与源视频不同，无法从已构图母版无损恢复原比例",
    source: "approved-master"
  };
  return variants;
}
function parseQaDetection(stderr) {
  const black = [...String(stderr).matchAll(/black_start:([0-9.]+)\s+black_end:([0-9.]+)/g)].map(match => ({ start: Number(match[1]), end: Number(match[2]) }));
  const freezes = []; let freezeStart = null;
  for (const line of String(stderr).split(/\r?\n/)) {
    const start = line.match(/freeze_start:\s*([0-9.]+)/);
    if (start) freezeStart = Number(start[1]);
    const end = line.match(/freeze_end:\s*([0-9.]+)/);
    if (end && freezeStart !== null) {
      freezes.push({ start: freezeStart, end: Number(end[1]) });
      freezeStart = null;
    }
  }
  const loudness = [...String(stderr).matchAll(/I:\s*(-?[0-9.]+)\s+LUFS/g)].at(-1);
  return { blackFrames: black, freezeFrames: freezes, integratedLufs: loudness ? Number(loudness[1]) : null };
}
async function runQa(job, version, outputPath, expectedDuration, timeline, variants, packaging, captionPackaging, coverPackaging, mediaManifest, colorManagement) {
  const metadata = await probe(outputPath);
  await run("ffmpeg", ["-v", "error", "-i", outputPath, "-f", "null", "-"]);
  const scan = await run("ffmpeg", ["-hide_banner", "-i", outputPath, "-vf", "blackdetect=d=0.4:pix_th=0.02,freezedetect=n=-55dB:d=2", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const detection = parseQaDetection(scan.stderr);
  const minimumSegment = Math.min(...timeline.clips.map(clip => clip.duration));
  const sdrBt709 = metadata.colorPrimaries === "bt709" && metadata.colorTransfer === "bt709" && metadata.colorSpace === "bt709";
  const captionSafeArea = job.options.captions === false
    || ["ass-static", "ass-fallback"].includes(captionPackaging.engine)
    || (captionPackaging.engine === "hyperframes" && captionPackaging.metadata?.width === 1080 && captionPackaging.metadata?.height === 1920 && captionPackaging.metadata?.alpha === true);
  const variantDimensions = Object.fromEntries(Object.entries(variants).map(([name, item]) => [name, item.available === false ? { available: false, reason: item.reason } : {
    available: true,
    width: item.metadata.width,
    height: item.metadata.height,
    sdrBt709: item.metadata.colorPrimaries === "bt709" && item.metadata.colorTransfer === "bt709" && item.metadata.colorSpace === "bt709"
  }]));
  const coverDimensions = coverPackaging.requested === false || (
    coverPackaging.available === true
    && coverPackaging.vertical?.metadata?.width === 1080 && coverPackaging.vertical?.metadata?.height === 1920
    && coverPackaging.grid?.metadata?.width === 1080 && coverPackaging.grid?.metadata?.height === 1440
    && coverPackaging.wide16x9?.metadata?.width === 1920 && coverPackaging.wide16x9?.metadata?.height === 1080
    && coverPackaging.landscape4x3?.metadata?.width === 1440 && coverPackaging.landscape4x3?.metadata?.height === 1080
  );
  const approvedMedia = mediaManifest.assets.filter(asset => asset.approved);
  const externalMedia = approvedMedia.filter(asset => EXTERNAL_SOURCE_TYPES.has(asset.sourceType));
  const mediaCompliance = {
    reviewComplete: mediaManifest.review?.reviewComplete === true,
    approvedAssetsValid: approvedMedia.every(asset => (asset.complianceIssues || []).length === 0),
    approvedAssetsComposited: approvedMedia.every(asset => asset.composited === true),
    externalMetadataComplete: externalMedia.every(asset => creatorNameIsUsable(asset.creatorName) && asset.workTitle && asset.sourceUrl && asset.usagePurpose && (advisoryRightsMode(job) || asset.licenseBasis)),
    externalAttributionRendered: externalMedia.every(asset => asset.composited === true && asset.attributionText && mediaManifest.attributionTrack),
    externalScriptDisclosure: advisoryRightsMode(job) || externalMedia.every(asset => String(job.script || "").includes(asset.creatorName))
  };
  const mediaPass = Object.values(mediaCompliance).every(Boolean);
  const report = {
    version,
    pass: metadata.videoCodec === "h264" && metadata.audioCodec === "aac" && metadata.pixelFormat === "yuv420p" && Math.abs(metadata.duration - expectedDuration) < 1.6 && sdrBt709 && captionSafeArea && coverDimensions && mediaPass,
    checks: {
      decodes: true,
      h264: metadata.videoCodec === "h264",
      aac: metadata.audioCodec === "aac",
      yuv420p: metadata.pixelFormat === "yuv420p",
      sdrBt709,
      durationMatches: Math.abs(metadata.duration - expectedDuration) < 1.6,
      expectedDimensions: metadata.width > 0 && metadata.height > 0,
      noLongBlackFrames: detection.blackFrames.length === 0,
      noLongFreezeFrames: detection.freezeFrames.length === 0,
      captionSafeArea,
      dynamicCaptionTrack: captionPackaging.engine === "hyperframes",
      cardSafeArea: timeline.cards.every(card => card.text.length <= 24),
      minimumSegmentDuration: minimumSegment >= 0.35,
      cutDensityPerMinute: Number((timeline.clips.length / Math.max(metadata.duration / 60, 0.01)).toFixed(2)),
      transcriptBoundaryCrossings: 0,
      variantDimensions,
      coverDimensions,
      mediaReviewComplete: mediaCompliance.reviewComplete,
      mediaApprovedAssetsValid: mediaCompliance.approvedAssetsValid,
      mediaApprovedAssetsComposited: mediaCompliance.approvedAssetsComposited,
      externalMetadataComplete: mediaCompliance.externalMetadataComplete,
      externalAttributionRendered: mediaCompliance.externalAttributionRendered,
      externalScriptDisclosure: mediaCompliance.externalScriptDisclosure
    },
    metrics: { expectedDuration, actualDuration: metadata.duration, minimumSegmentDuration: minimumSegment, integratedLufs: detection.integratedLufs, blackFrames: detection.blackFrames, freezeFrames: detection.freezeFrames, colorMetadata: { range: metadata.colorRange, space: metadata.colorSpace, transfer: metadata.colorTransfer, primaries: metadata.colorPrimaries } },
    colorManagement,
    packaging,
    captionPackaging,
    coverPackaging,
    media: { policy: mediaManifest.policy, approvedAssets: approvedMedia.length, renderedAssets: mediaManifest.assets.filter(asset => asset.composited).length, externalAssets: externalMedia.length, compliance: mediaCompliance, issues: mediaManifest.review?.complianceIssues || [] },
    limitations: ["未执行人脸构图质量判断", "跳切观感仍需最终人工审核", "平台变体由审核母版转换，不改变剪辑时间线"],
    generatedAt: new Date().toISOString()
  };
  await writeJson(path.join(confined(jobsRoot, job.id), `qa-report-v${version}.json`), report);
  return report;
}
async function renderVersion(job, version) {
  const jobDir = confined(jobsRoot, job.id), plan = job.currentPlan, segments = plan.keepSegments;
  job.status = version > 1 ? "revising" : "rendering"; job.progress = 2; await saveJob(job);
  const timeline = buildTimeline(job, plan, version);
  const duration = timeline.outputDuration, filters = [];
  const colorManagement = videoColorPipeline(job.source);
  await writeTimelineArtifacts(jobDir, timeline, version);
  const mediaManifest = await ensureMediaManifest(job, version);
  let packaging = { requested: timeline.cards.length ? "hyperframes" : "none", engine: "none", cards: timeline.cards.length, panels: 0, fallbackReason: null };
  let hyperframes = { engine: "none", clips: [] };
  if (timeline.cards.length) {
    try {
      hyperframes = await renderHyperframesCards(jobDir, timeline, version, job.options);
      packaging.engine = "hyperframes";
      packaging.panels = hyperframes.clips.filter(card => card.mode === "side-panel").length;
    } catch (error) {
      packaging = { ...packaging, engine: "ass-fallback", fallbackReason: error.message };
      job.degraded = [...(job.degraded || []), `HyperFrames 动态包装失败，已用 ASS 卡片继续：${error.message}`];
    }
  }
  const captionsEnabled = job.options.captions !== false;
  const requestedCaptionStyle = normalizeCaptionStyle(job.options.captionStyle);
  let captionPackaging = { requested: captionsEnabled ? requestedCaptionStyle : "none", engine: "none", style: requestedCaptionStyle, cues: 0, fallbackReason: null };
  if (captionsEnabled) {
    await writeAss(jobDir, job.transcript, segments, packaging.engine === "ass-fallback" ? plan.overlayCards || [] : [], version, job.script);
    const cues = dynamicCaptionCues(job, timeline);
    captionPackaging.cues = cues.length;
    if (requestedCaptionStyle === "static") captionPackaging.engine = "ass-static";
    else {
      try {
        captionPackaging = await renderHyperframesCaptions(jobDir, job, timeline, version);
      } catch (error) {
        captionPackaging = { ...captionPackaging, engine: "ass-fallback", fallbackReason: error.message };
        await writeJson(path.join(jobDir, `captions-v${version}.json`), { version, engine: "ass-fallback", style: requestedCaptionStyle, duration: timeline.outputDuration, cues, fallbackReason: error.message, generatedAt: new Date().toISOString() });
        job.degraded = [...(job.degraded || []), `HyperFrames 动态字幕失败，已用 ASS 字幕继续：${error.message}`];
      }
    }
  }
  const captionInputCount = captionPackaging.engine === "hyperframes" ? 1 : 0;
  const mediaPlan = await buildMediaRenderPlan(job, version, mediaManifest, 1 + hyperframes.clips.length + captionInputCount);
  segments.forEach((segment, i) => {
    const d = segment.end - segment.start;
    filters.push(`[0:v]trim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    filters.push(`[0:a]atrim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${Math.min(0.03, d / 3).toFixed(3)},afade=t=out:st=${Math.max(0, d - 0.03).toFixed(3)}:d=${Math.min(0.03, d / 3).toFixed(3)}[a${i}]`);
  });
  filters.push(`${segments.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);
  filters.push(`[vcat]${colorManagement.filter}[vcolor]`);
  filters.push(`[vcolor]${videoLayoutFilter(job.options.layout || "vertical")}[vbase]`);
  let videoLabel = "vbase";
  for (let index = 0; index < mediaPlan.filters.length; index += 2) {
    filters.push(mediaPlan.filters[index]);
    const nextLabel = `vmedia${index / 2}`;
    filters.push(mediaPlan.filters[index + 1].replace("__MEDIA_BASE__", videoLabel).replace("__MEDIA_OUT__", nextLabel));
    videoLabel = nextLabel;
  }
  if (mediaPlan.attributionFile) {
    filters.push(`[${videoLabel}]ass=filename='${path.basename(mediaPlan.attributionFile)}'[vattribution]`);
    videoLabel = "vattribution";
  }
  hyperframes.clips.forEach((card, index) => {
    const cardDuration = Math.max(0.5, card.outputEnd - card.outputStart);
    filters.push(`[${index + 1}:v]trim=duration=${cardDuration.toFixed(3)},setpts=PTS-STARTPTS+${card.outputStart.toFixed(3)}/TB[card${index}]`);
    filters.push(`[${videoLabel}][card${index}]overlay=x=(main_w-overlay_w)/2:y=0:eof_action=pass:shortest=0[vcard${index}]`);
    videoLabel = `vcard${index}`;
  });
  if (captionPackaging.engine === "hyperframes") {
    const captionInputIndex = hyperframes.clips.length + 1;
    filters.push(`[${captionInputIndex}:v]trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS[captiontrack]`);
    filters.push(`[${videoLabel}][captiontrack]overlay=0:0:eof_action=pass:shortest=0[vsub]`);
    filters.push("[vsub]fps=30,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[vout]");
  } else if (captionsEnabled) {
    filters.push(`[${videoLabel}]ass=filename='captions-v${version}.ass'[vsub]`);
    filters.push("[vsub]fps=30,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[vout]");
  } else filters.push(`[${videoLabel}]fps=30,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[vout]`);
  filters.push("[acat]highpass=f=80,lowpass=f=15000,loudnorm=I=-16:TP=-1.5:LRA=11[aout]");
  const filterFile = path.join(jobDir, `filter-v${version}.ffscript`); await fsp.writeFile(filterFile, filters.join(";\r\n") + ";\r\n", "utf8");
  const outputPath = path.join(jobDir, `final-v${version}.mp4`); let progressBuffer = "", stderr = "";
  const inputs = ["-i", job.sourcePath, ...hyperframes.clips.flatMap(card => ["-c:v", "libvpx-vp9", "-i", card.path]), ...(captionPackaging.engine === "hyperframes" ? ["-c:v", "libvpx-vp9", "-i", captionPackaging.path] : []), ...mediaPlan.inputArgs];
  const child = spawn("ffmpeg", ["-y", "-hide_banner", ...inputs, "-/filter_complex", filterFile, "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", outputPath], { cwd: jobDir, windowsHide: true });
  child.stdout.on("data", async chunk => {
    progressBuffer += String(chunk); const lines = progressBuffer.split(/\r?\n/); progressBuffer = lines.pop() || "";
    for (const line of lines) { const m = line.match(/^out_time_ms=(\d+)/); if (m && duration > 0) { job.progress = Math.min(98, Math.max(3, Math.round(Number(m[1]) / 1e6 / duration * 100))); await saveJob(job).catch(() => {}); } }
  });
  child.stderr.on("data", c => { stderr += c; if (stderr.length > 120000) stderr = stderr.slice(-120000); });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  if (code !== 0) throw Object.assign(new Error(`ffmpeg 渲染失败（退出码 ${code}）`), { stderr });
  await run("ffmpeg", ["-v", "error", "-i", outputPath, "-f", "null", "-"]);
  await finalizeMediaManifest(job, version, mediaManifest, mediaPlan);
  const output = await probe(outputPath), thumbnail = path.join(jobDir, `thumbnail-v${version}.jpg`);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(Math.min(1.2, output.duration / 3)), "-i", outputPath, "-frames:v", "1", "-q:v", "2", thumbnail]);
  await fsp.copyFile(outputPath, path.join(jobDir, "final.mp4"));
  job.progress = 82; await saveJob(job);
  let coverPackaging = { requested: job.options?.generateCover !== false, available: false, engine: "none", fallbackReason: null };
  if (coverPackaging.requested) {
    try {
      coverPackaging = await renderCover(job, version);
    } catch (error) {
      coverPackaging = { requested: true, available: false, engine: "failed", fallbackReason: error.message };
      job.degraded = [...(job.degraded || []), `封面生成失败，成片仍可正常审核：${error.message}`];
    }
  }
  job.progress = 88; await saveJob(job);
  const variants = await renderVariants(job, version, outputPath);
  job.progress = 94; await saveJob(job);
  const qaReport = await runQa(job, version, outputPath, duration, timeline, variants, packaging, captionPackaging, coverPackaging, mediaManifest, colorManagement);
  const artifactUrl = name => `/video-jobs/${job.id}/${name}`;
  const versionResult = {
    version,
    path: outputPath,
    url: artifactUrl(`final-v${version}.mp4`),
    thumbnailUrl: artifactUrl(`thumbnail-v${version}.jpg`),
    metadata: output,
    qa: qaReport.checks,
    qaPass: qaReport.pass,
    provenance: plan.provenance,
    planEngine: plan.engine,
    packaging,
    captionPackaging,
    cover: coverPackaging,
    colorManagement,
    variants,
    media: { policy: mediaManifest.policy, approvedAssets: mediaManifest.assets.filter(asset => asset.approved).length },
    artifacts: {
      editPlan: artifactUrl(`edit-plan-v${version}.json`),
      timeline: artifactUrl(`timeline-v${version}.json`),
      edl: artifactUrl(`timeline-v${version}.edl`),
      ...(captionsEnabled ? { captions: artifactUrl(`captions-v${version}.ass`) } : {}),
      ...(captionPackaging.engine === "hyperframes" || captionPackaging.engine === "ass-fallback" ? { captionStoryboard: artifactUrl(`captions-v${version}.json`) } : {}),
      filter: artifactUrl(`filter-v${version}.ffscript`),
      qa: artifactUrl(`qa-report-v${version}.json`),
      mediaManifest: artifactUrl(`media-manifest-v${version}.json`),
      ...(coverPackaging.available ? {
        coverDesign: artifactUrl(`cover-design-v${version}.json`),
        coverVertical: coverPackaging.vertical.url,
        coverGrid: coverPackaging.grid.url,
        coverWide16x9: coverPackaging.wide16x9.url,
        coverLandscape4x3: coverPackaging.landscape4x3.url
      } : {})
    },
    createdAt: new Date().toISOString(),
    model: job.planModel || null
  };
  job.versions = [...(job.versions || []).filter(x => x.version !== version), versionResult];
  job.output = versionResult; job.jobDir = jobDir; job.status = "awaiting_review"; job.progress = 100; await saveJob(job);
}
async function processJob(job) {
  if (running.has(job.id)) return; running.set(job.id, true);
  const jobDir = confined(jobsRoot, job.id);
  try {
    delete job.error; delete job.errorDetail; delete job.revisionError;
    job.degraded = [];
    job.status = "analyzing"; job.progress = 4; await saveJob(job);
    job.source = await probe(job.sourcePath);
    if (!job.source.hasAudio) throw new Error("原视频没有音轨，无法进行口播转录和剪辑");
    let silences = [];
    if (job.source.hasAudio && job.options.removeSilence !== false) {
      const result = await run("ffmpeg", ["-hide_banner", "-i", job.sourcePath, "-af", `silencedetect=noise=${Number(job.options.silenceDb ?? -36)}dB:d=${Number(job.options.silenceDuration ?? 0.45)}`, "-f", "null", "-"]);
      silences = parseSilences(result.stderr, job.source.duration);
    }
    const fallback = buildKeepSegments(job.source.duration, silences, Number(job.options.pauseKeep ?? 0.12));
    job.analysis = { silences, baseKeepSegments: fallback, removedDuration: job.source.duration - fallback.reduce((s, x) => s + x.end - x.start, 0) };
    job.status = "transcribing"; job.progress = 15; await saveJob(job);
    try {
      const result = await runAi({ operation: "transcribe", input_path: job.sourcePath, output_dir: jobDir, model_size: job.options.transcriptionModel || "small", language: "zh" }, jobDir, "transcribe");
      job.transcript = result.data; job.transcriptionModel = result.model;
    } catch (error) {
      job.degraded = [...(job.degraded || []), `本地转录失败，退回口播稿时间估算：${error.message}`];
      job.transcript = { text: job.script || "", segments: [{ start: 0, end: job.source.duration, text: job.script || "" }], words: [], model: "script-fallback" };
      job.transcriptionModel = "script-fallback";
    }
    job.status = "planning"; job.progress = 45; await saveJob(job);
    let aiPlan = null;
    try {
      const result = await runAi({ operation: "edit_plan", script: job.script, content_direction: job.contentDirection, source: job.source, transcript: job.transcript, base_plan: { silences, keepSegments: fallback } }, jobDir, "edit-plan-v1");
      aiPlan = result.data; job.planModel = result.model; job.modelUsage = result.usage;
    } catch (error) { job.degraded = [...(job.degraded || []), `AI剪辑决策失败，使用停顿剪辑：${error.message}`]; }
    job.currentVersion = 1;
    const validation = validatePlan(aiPlan, job.source.duration, fallback, "semantic");
    job.currentPlan = { version: 1, ...validation, editSummary: aiPlan?.editSummary || "本地停顿剪辑", removedReasons: aiPlan?.removedReasons || [], createdAt: new Date().toISOString() };
    await writeJson(path.join(jobDir, "edit-plan-v1.json"), job.currentPlan);
    await saveJob(job);
    await prepareAssetCandidates(job);
    job.status = "awaiting_asset_review";
    job.progress = 60;
    job.assetReview = assetReviewSummary(job, job.currentPlan.keepSegments.reduce((sum, segment) => sum + segment.end - segment.start, 0));
    await saveJob(job);
  } catch (error) {
    job.status = "error"; job.error = error.message; job.errorDetail = String(error.stderr || "").slice(-8000); await saveJob(job);
  } finally { running.delete(job.id); }
}
async function reviseJob(job, feedback) {
  if (running.has(job.id)) return; running.set(job.id, true);
  const dir = confined(jobsRoot, job.id);
  const previous = {
    currentVersion: job.currentVersion,
    currentPlan: job.currentPlan,
    planModel: job.planModel,
    modelUsage: job.modelUsage,
    output: job.output,
    status: job.status,
    progress: job.progress,
    approvedAt: job.approvedAt
  };
  try {
    const version = Number(job.currentVersion || 1) + 1;
    job.status = "revising"; job.progress = 5; job.reviews = [...(job.reviews || []), { version: job.currentVersion, feedback, createdAt: new Date().toISOString() }]; await saveJob(job);
    const result = await runAi({ operation: "revise_plan", feedback, script: job.script, content_direction: job.contentDirection, source: job.source, transcript: job.transcript, base_plan: job.currentPlan }, dir, `edit-plan-v${version}`);
    const fallback = job.currentPlan.keepSegments;
    job.currentVersion = version; job.planModel = result.model; job.modelUsage = result.usage;
    let revisedOverlays = normalizeOverlays(result.data?.overlayCards, job.source.duration);
    const overlayLimit = feedbackOverlayLimit(feedback);
    if (overlayLimit !== null) revisedOverlays = revisedOverlays.slice(0, overlayLimit);
    const validation = validatePlan({ ...result.data, overlayCards: revisedOverlays }, job.source.duration, fallback, "semantic-revision");
    job.currentPlan = { version, ...validation, editSummary: result.data?.editSummary || `按反馈修改：${feedback}`, removedReasons: result.data?.removedReasons || [], feedback, createdAt: new Date().toISOString() };
    await writeJson(path.join(dir, `edit-plan-v${version}.json`), job.currentPlan); await saveJob(job); await renderVersion(job, version);
  } catch (error) {
    job.currentVersion = previous.currentVersion;
    job.currentPlan = previous.currentPlan;
    job.planModel = previous.planModel;
    job.modelUsage = previous.modelUsage;
    job.output = previous.output;
    job.status = previous.status === "approved" ? "approved" : "awaiting_review";
    job.progress = previous.progress ?? 100;
    job.approvedAt = previous.approvedAt;
    const review = job.reviews?.at(-1);
    if (review && review.feedback === feedback) { review.failed = true; review.error = error.message; }
    job.revisionError = error.message;
    job.errorDetail = String(error.stderr || "").slice(-8000);
    await saveJob(job);
  } finally { running.delete(job.id); }
}
async function replanJob(job, feedback = "") {
  if (running.has(job.id)) return;
  running.set(job.id, true);
  const dir = confined(jobsRoot, job.id);
  const previous = { currentVersion: job.currentVersion, currentPlan: job.currentPlan, planModel: job.planModel, modelUsage: job.modelUsage, output: job.output, status: job.status, progress: job.progress };
  try {
    if (!job.source || !job.transcript) throw new Error("任务缺少源视频分析或逐字稿，不能跳过转录重新规划");
    const version = Math.max(1, ...(job.versions || []).map(item => Number(item.version) || 0), Number(job.currentVersion) || 0) + 1;
    job.status = "planning"; job.progress = 8; delete job.revisionError; await saveJob(job);
    const operation = feedback.trim() ? "revise_plan" : "edit_plan";
    const result = await runAi({ operation, script: job.script, content_direction: job.contentDirection, source: job.source, transcript: job.transcript, base_plan: { silences: job.analysis?.silences || [], keepSegments: job.analysis?.baseKeepSegments || job.currentPlan?.keepSegments || [] }, feedback }, dir, `edit-plan-v${version}`);
    const fallback = job.analysis?.baseKeepSegments || job.currentPlan?.keepSegments || [{ start: 0, end: job.source.duration, reason: "完整保留" }];
    const validation = validatePlan(result.data, job.source.duration, fallback, "semantic");
    job.currentVersion = version; job.planModel = result.model; job.modelUsage = result.usage;
    job.currentPlan = { version, ...validation, editSummary: result.data?.editSummary || "重新生成语义剪辑计划", removedReasons: result.data?.removedReasons || [], feedback: feedback || null, createdAt: new Date().toISOString() };
    await writeJson(path.join(dir, `edit-plan-v${version}.json`), job.currentPlan);
    await saveJob(job);
    const duration = job.currentPlan.keepSegments.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0);
    job.assetReview = assetReviewSummary(job, duration);
    if (!job.output || !job.assetReview.renderReady) {
      job.status = "awaiting_asset_review";
      job.progress = 60;
      await saveJob(job);
      return;
    }
    await renderVersion(job, version);
  } catch (error) {
    Object.assign(job, previous);
    job.status = previous.status === "approved" ? "approved" : "awaiting_review";
    job.revisionError = error.message;
    job.errorDetail = String(error.stderr || "").slice(-8000);
    await saveJob(job);
  } finally { running.delete(job.id); }
}
async function renderReviewedAssets(job, reason = "素材审核完成") {
  if (running.has(job.id)) return;
  const duration = job.currentPlan?.keepSegments?.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || Number(job.source?.duration || 0);
  const review = assetReviewSummary(job, duration);
  if (!review.reviewComplete) throw Object.assign(new Error("仍有素材未批准或拒绝，不能开始最终渲染"), { statusCode: 409 });
  if (!review.renderReady) throw Object.assign(new Error(review.complianceIssues.map(item => `${item.assetId}：${item.issue}`).join("；") || "素材合规检查未通过"), { statusCode: 409 });
  running.set(job.id, true);
  try {
    if (!job.source || !job.transcript || !job.currentPlan?.keepSegments?.length) throw new Error("任务缺少源视频、逐字稿或当前剪辑计划");
    const previousVersions = job.versions || [];
    const highestRendered = Math.max(0, ...previousVersions.map(item => Number(item.version) || 0));
    const version = highestRendered > 0 ? Math.max(highestRendered, Number(job.currentVersion) || 0) + 1 : Math.max(1, Number(job.currentVersion) || 1);
    job.currentVersion = version;
    job.currentPlan = { ...job.currentPlan, version, feedback: reason, createdAt: new Date().toISOString() };
    job.status = "rendering";
    job.progress = 62;
    job.assetReview = review;
    delete job.error;
    delete job.errorDetail;
    delete job.approvedAt;
    delete job.revisionError;
    await writeJson(path.join(confined(jobsRoot, job.id), `edit-plan-v${version}.json`), job.currentPlan);
    await saveJob(job);
    await renderVersion(job, version);
  } catch (error) {
    job.status = "error";
    job.error = error.message;
    job.errorDetail = String(error.stderr || "").slice(-8000);
    await saveJob(job);
  } finally { running.delete(job.id); }
}
async function rerenderJob(job, reason = "", renderOptions = {}) {
  if (running.has(job.id)) return;
  running.set(job.id, true);
  const dir = confined(jobsRoot, job.id);
  const previous = { currentVersion: job.currentVersion, currentPlan: job.currentPlan, output: job.output, options: job.options, status: job.status, progress: job.progress, approvedAt: job.approvedAt };
  try {
    job.source = await probe(job.sourcePath);
    if (!job.source || !job.transcript || !job.currentPlan?.keepSegments?.length) throw new Error("任务缺少源视频、逐字稿或当前剪辑计划，不能本地重渲染");
    const version = Math.max(1, ...(job.versions || []).map(item => Number(item.version) || 0), Number(job.currentVersion) || 0) + 1;
    job.status = "rendering";
    job.progress = 5;
    job.currentVersion = version;
    job.options = {
      ...job.options,
      captionStyle: normalizeCaptionStyle(renderOptions.captionStyle ?? job.options.captionStyle),
      informationPanels: renderOptions.informationPanels === undefined ? job.options.informationPanels !== false : renderOptions.informationPanels !== false,
      generateCover: renderOptions.generateCover === undefined ? job.options.generateCover !== false : renderOptions.generateCover !== false,
      coverTitle: renderOptions.coverTitle === undefined ? cleanCoverCopy(job.options.coverTitle, 42) : cleanCoverCopy(renderOptions.coverTitle, 42),
      contentTitle: renderOptions.contentTitle === undefined ? cleanCoverCopy(job.options.contentTitle, 42) : cleanCoverCopy(renderOptions.contentTitle, 42)
    };
    job.currentPlan = { ...job.currentPlan, version, feedback: reason || job.currentPlan.feedback || null, createdAt: new Date().toISOString() };
    job.degraded = (job.degraded || []).filter(item => !String(item).startsWith("AI剪辑决策失败，使用停顿剪辑："));
    delete job.revisionError;
    delete job.errorDetail;
    delete job.approvedAt;
    await writeJson(path.join(dir, `edit-plan-v${version}.json`), job.currentPlan);
    await saveJob(job);
    await renderVersion(job, version);
  } catch (error) {
    Object.assign(job, previous);
    job.status = previous.status === "approved" ? "approved" : "awaiting_review";
    job.revisionError = error.message;
    job.errorDetail = String(error.stderr || "").slice(-8000);
    await saveJob(job);
  } finally { running.delete(job.id); }
}
async function regenerateCover(job, options = {}) {
  if (running.has(job.id)) throw Object.assign(new Error("任务仍在处理中"), { statusCode: 409 });
  if (!job.output?.version || !job.sourcePath || !job.source) throw Object.assign(new Error("当前任务还没有可用成片，不能单独生成封面"), { statusCode: 409 });
  running.set(job.id, true);
  try {
    job.options = {
      ...job.options,
      generateCover: true,
      coverTitle: options.coverTitle === undefined ? cleanCoverCopy(job.options?.coverTitle, 42) : cleanCoverCopy(options.coverTitle, 42),
      contentTitle: options.contentTitle === undefined ? cleanCoverCopy(job.options?.contentTitle, 42) : cleanCoverCopy(options.contentTitle, 42)
    };
    const version = Number(job.output.version);
    const cover = await renderCover(job, version);
    const artifactUrl = name => `/video-jobs/${job.id}/${name}`;
    const coverArtifacts = {
      coverDesign: artifactUrl(`cover-design-v${version}.json`),
      coverVertical: cover.vertical.url,
      coverGrid: cover.grid.url,
      coverWide16x9: cover.wide16x9.url,
      coverLandscape4x3: cover.landscape4x3.url
    };
    const updatedOutput = { ...job.output, cover, qa: { ...(job.output.qa || {}), coverDimensions: true }, artifacts: { ...(job.output.artifacts || {}), ...coverArtifacts } };
    job.output = updatedOutput;
    job.versions = (job.versions || []).map(item => Number(item.version) === version ? updatedOutput : item);
    try {
      const qaPath = path.join(confined(jobsRoot, job.id), `qa-report-v${version}.json`);
      const qaReport = await readJsonFile(qaPath);
      qaReport.checks = { ...(qaReport.checks || {}), coverDimensions: true };
      qaReport.coverPackaging = cover;
      qaReport.coverUpdatedAt = new Date().toISOString();
      await writeJson(qaPath, qaReport);
    } catch {}
    await saveJob(job);
    return cover;
  } finally {
    running.delete(job.id);
  }
}
async function receiveUpload(req, target) {
  const max = 8 * 1024 ** 3; let total = 0; const stream = fs.createWriteStream(target, { flags: "wx" });
  await new Promise((resolve, reject) => {
    req.on("data", chunk => { total += chunk.length; if (total > max) { reject(new Error("视频超过8GB限制")); req.destroy(); return; } if (!stream.write(chunk)) { req.pause(); stream.once("drain", () => req.resume()); } });
    req.on("end", () => stream.end(resolve)); req.on("error", reject); stream.on("error", reject);
  }); return total;
}
async function readBodyJson(req, limit = 1024 * 1024) {
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > limit) throw new Error("请求内容过大"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
async function serveFile(req, res, file) {
  const stat = await fsp.stat(file), type = mime[path.extname(file).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;
  if (range && /^(video|audio)\//.test(type)) {
    const match = range.match(/bytes=(\d*)-(\d*)/), start = match?.[1] ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    cors(res); res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" }); fs.createReadStream(file, { start, end }).pipe(res); return;
  }
  cors(res); res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" }); fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    cors(res); if (req.method === "OPTIONS") return res.writeHead(204).end();
    const url = new URL(req.url, `http://${host}:${port}`), pathname = decodeURIComponent(url.pathname);
    if (req.method === "GET" && pathname === "/api/health") {
      let ffmpeg = false, hyperframes = false, ai = null;
      try { await run("ffmpeg", ["-version"]); ffmpeg = true; } catch {}
      try { await run("npx", ["-y", "hyperframes", "--version"], { shell: true }); hyperframes = true; } catch {}
      try { ai = await runAi({ operation: "config" }, contentRoot, "model-config"); } catch (error) { ai = { success: false, error: error.message }; }
      return json(res, 200, { ok: true, service: "koubo-ai-workflow", version: 3, localOnlyVideo: true, ffmpeg, hyperframes, ai: { configured: !!ai?.success, model: ai?.model || null, transcriptionModel: ai?.transcription_model || "faster-whisper/small" }, jobsRoot, contentRoot });
    }
    if (req.method === "GET" && pathname === "/api/contents") return json(res, 200, { items: await listGeneratedContents() });
    if (req.method === "POST" && pathname === "/api/contents/generate") {
      const hasBody = Number(req.headers["content-length"] || 0) > 0 || String(req.headers["transfer-encoding"] || "").toLowerCase() === "chunked";
      const options = hasBody ? await readBodyJson(req, 64 * 1024) : {};
      return json(res, 201, { item: await generateContent(options) });
    }
    if (req.method === "GET" && pathname === "/api/jobs") {
      const entries = await fsp.readdir(jobsRoot, { withFileTypes: true }), jobs = [];
      for (const e of entries.filter(x => x.isDirectory()).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 30)) try { jobs.push(await readJob(e.name)); } catch {}
      return json(res, 200, { jobs });
    }
    if (req.method === "POST" && pathname === "/api/jobs") {
      const id = timestampId(), dir = confined(jobsRoot, id); await fsp.mkdir(dir, { recursive: false });
      const fileName = safeName(decodeURIComponent(req.headers["x-file-name"] || "video.mp4")), sourcePath = path.join(dir, fileName);
      let options = {}; try { options = JSON.parse(decodeURIComponent(req.headers["x-options"] || "%7B%7D")); } catch {}
      const sizeBytes = await receiveUpload(req, sourcePath);
      const contentId = decodeURIComponent(req.headers["x-content-id"] || "");
      const job = {
        id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "uploaded", progress: 0,
        fileName, sizeBytes, sourcePath, contentId, contentDirection: await contentDirectionFor(contentId), script: String(options.script || ""),
        options: {
          removeSilence: options.removeSilence !== false, captions: options.captions !== false,
          captionStyle: normalizeCaptionStyle(options.captionStyle), informationPanels: options.informationPanels !== false,
          layout: ["original", "vertical", "square"].includes(options.layout) ? options.layout : "vertical",
          generateVariants: options.generateVariants !== false, generateCover: options.generateCover !== false,
          coverTitle: cleanCoverCopy(options.coverTitle, 42), contentTitle: cleanCoverCopy(options.contentTitle, 42),
          silenceDb: Number(options.silenceDb ?? -36), silenceDuration: Number(options.silenceDuration ?? 0.45),
          pauseKeep: Number(options.pauseKeep ?? 0.12), transcriptionModel: options.transcriptionModel || "small", aiMode: "full-auto",
          visualStrategy: "rich-media-first",
          cloudImageGenerationEnabled: options.cloudImageGenerationEnabled === true,
          paidImageGenerationConfirmation: options.paidImageGenerationConfirmation !== false,
          rightsReviewMode: options.rightsReviewMode === "advisory" ? "advisory" : "strict"
        },
        versions: [], reviews: [], assets: [], jobDir: dir
      };
      await saveJob(job); processJob(job); return json(res, 202, { job });
    }
    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) return json(res, 200, { job: await readJob(jobMatch[1]) });
    const retryMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/retry$/);
    if (req.method === "POST" && retryMatch) {
      const job = await readJob(retryMatch[1]);
      if (running.has(job.id)) return json(res, 409, { error: "任务仍在处理中" });
      delete job.error; delete job.errorDetail; delete job.revisionError;
      processJob(job);
      return json(res, 202, { job });
    }
    const reviseMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/revise$/);
    if (req.method === "POST" && reviseMatch) {
      const body = await readBodyJson(req); const feedback = String(body.feedback || "").trim();
      if (!feedback) return json(res, 400, { error: "请填写修改意见" });
      const job = await readJob(reviseMatch[1]);
      const duration = job.currentPlan?.keepSegments?.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || Number(job.source?.duration || 0);
      if (!assetReviewSummary(job, duration).renderReady) return json(res, 409, { error: "请先在素材审核板处理全部候选，再进行成片返修" });
      reviseJob(job, feedback); return json(res, 202, { job });
    }
    const replanMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/replan$/);
    if (req.method === "POST" && replanMatch) {
      const body = await readBodyJson(req);
      const job = await readJob(replanMatch[1]);
      if (running.has(job.id)) return json(res, 409, { error: "任务仍在处理中" });
      replanJob(job, String(body.feedback || ""));
      return json(res, 202, { job, reusedTranscript: true });
    }
    const rerenderMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/rerender$/);
    if (req.method === "POST" && rerenderMatch) {
      const body = await readBodyJson(req);
      const job = await readJob(rerenderMatch[1]);
      if (running.has(job.id)) return json(res, 409, { error: "任务仍在处理中" });
      const duration = job.currentPlan?.keepSegments?.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || Number(job.source?.duration || 0);
      if (!assetReviewSummary(job, duration).renderReady) return json(res, 409, { error: "请先在素材审核板处理全部候选，再进行本地重渲染" });
      rerenderJob(job, String(body.reason || ""), body);
      return json(res, 202, { job, reusedTranscript: true, reusedPlan: true });
    }
    const coverMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cover$/);
    if (req.method === "POST" && coverMatch) {
      const body = await readBodyJson(req);
      const job = await readJob(coverMatch[1]);
      const cover = await regenerateCover(job, body);
      return json(res, 200, { job, cover, reusedVideo: true, reusedPlan: true });
    }
    const assetRediscoverMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/assets\/rediscover$/);
    if (req.method === "POST" && assetRediscoverMatch) {
      const body = await readBodyJson(req);
      const job = await readJob(assetRediscoverMatch[1]);
      if (running.has(job.id)) return json(res, 409, { error: "任务仍在处理中" });
      if (!job.source || !job.currentPlan?.keepSegments?.length) return json(res, 409, { error: "任务缺少源视频或剪辑计划" });
      job.options = {
        ...job.options,
        visualStrategy: "rich-media-first",
        cloudImageGenerationEnabled: body.cloudImageGenerationEnabled === true || job.options?.cloudImageGenerationEnabled === true,
        paidImageGenerationConfirmation: body.paidImageGenerationConfirmation === false ? false : job.options?.paidImageGenerationConfirmation !== false,
        rightsReviewMode: body.rightsReviewMode === "advisory" ? "advisory" : job.options?.rightsReviewMode || "strict"
      };
      await prepareAssetCandidates(job, { force: true, reason: String(body.reason || "按富媒体优先策略重新发现素材") });
      job.status = "awaiting_asset_review";
      job.progress = 60;
      await saveJob(job);
      return json(res, 200, { job, archivedVersions: (job.assetHistory || []).length });
    }
    const assetUploadMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/assets$/);
    if (req.method === "POST" && assetUploadMatch) {
      const job = await readJob(assetUploadMatch[1]);
      const assetId = `asset-${crypto.randomBytes(4).toString("hex")}`;
      const fileName = safeName(decodeURIComponent(req.headers["x-file-name"] || "asset.bin"));
      const assetsDir = path.join(confined(jobsRoot, job.id), "assets"); await fsp.mkdir(assetsDir, { recursive: true });
      const assetPath = path.join(assetsDir, `${assetId}-${fileName}`);
      const sizeBytes = await receiveUpload(req, assetPath);
      const asset = normalizeAssetRecord({ id: assetId, fileName, path: assetPath, url: `/video-jobs/${job.id}/assets/${assetId}-${fileName}`, previewUrl: `/video-jobs/${job.id}/assets/${assetId}-${fileName}`, sizeBytes, sourceType: "local-upload", sourceLabel: "用户本地上传", mediaKind: mediaKindFor(fileName), ownership: "user-provided", licenseBasis: "pending-confirmation", reviewStatus: "pending", approved: false, placement: null, discoveredAutomatically: false, paymentRequired: false, paymentConfirmed: true, createdAt: new Date().toISOString() });
      job.assets = [...(job.assets || []), asset];
      job.status = "awaiting_asset_review";
      job.assetReview = assetReviewSummary(job);
      await saveJob(job);
      return json(res, 201, { job, asset });
    }
    const assetFileMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/assets\/([^/]+)\/file$/);
    if (req.method === "POST" && assetFileMatch) {
      const job = await readJob(assetFileMatch[1]);
      const asset = (job.assets || []).find(item => item.id === assetFileMatch[2]);
      if (!asset) return json(res, 404, { error: "素材不存在" });
      const fileName = safeName(decodeURIComponent(req.headers["x-file-name"] || "asset.bin"));
      const kind = mediaKindFor(fileName);
      if (!["image", "video"].includes(kind)) return json(res, 400, { error: "替换文件必须是图片或视频" });
      const assetsDir = path.join(confined(jobsRoot, job.id), "assets", "replacements");
      await fsp.mkdir(assetsDir, { recursive: true });
      const revision = (asset.fileVersions || []).length + 1;
      const target = path.join(assetsDir, `${asset.id}-r${revision}-${fileName}`);
      const sizeBytes = await receiveUpload(req, target);
      asset.fileVersions = [...(asset.fileVersions || []), { path: asset.path || null, url: asset.url || null, fileName: asset.fileName || null, replacedAt: new Date().toISOString() }];
      asset.path = target;
      asset.url = `/video-jobs/${job.id}/assets/replacements/${asset.id}-r${revision}-${fileName}`;
      asset.previewUrl = asset.url;
      asset.fileName = fileName;
      asset.mediaKind = kind;
      asset.sizeBytes = sizeBytes;
      asset.reviewStatus = "pending";
      asset.approved = false;
      asset.updatedAt = new Date().toISOString();
      job.status = "awaiting_asset_review";
      job.assetReview = assetReviewSummary(job);
      await saveJob(job);
      return json(res, 200, { job, asset });
    }
    const assetApprovalMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/assets\/([^/]+)\/approve$/);
    if (req.method === "POST" && assetApprovalMatch) {
      const body = await readBodyJson(req), job = await readJob(assetApprovalMatch[1]);
      const asset = (job.assets || []).find(item => item.id === assetApprovalMatch[2]);
      if (!asset) return json(res, 404, { error: "素材不存在" });
      const before = JSON.parse(JSON.stringify(asset));
      const reviewStatus = body.reviewStatus === "rejected" || body.approved === false ? "rejected" : body.approved === true ? "approved" : "pending";
      const nextSourceType = String(body.sourceType || asset.sourceType || "local-upload").slice(0, 80);
      Object.assign(asset, {
        reviewStatus,
        approved: reviewStatus === "approved",
        ownership: String(body.ownership || asset.ownership || "user-provided").slice(0, 120),
        sourceType: nextSourceType,
        creatorName: String(body.creatorName ?? asset.creatorName ?? "").trim().slice(0, 120),
        workTitle: String(body.workTitle ?? asset.workTitle ?? "").trim().slice(0, 180),
        sourceUrl: String(body.sourceUrl ?? asset.sourceUrl ?? "").trim().slice(0, 1000),
        usagePurpose: String(body.usagePurpose ?? asset.usagePurpose ?? "").trim().slice(0, 500),
        licenseBasis: String(body.licenseBasis || body.license || asset.licenseBasis || "").trim().slice(0, 120),
        attributionText: String(body.attributionText ?? asset.attributionText ?? "").trim().slice(0, 240),
        clipStart: Number.isFinite(Number(body.clipStart)) ? Math.max(0, Number(body.clipStart)) : Number(asset.clipStart || 0),
        clipEnd: Number.isFinite(Number(body.clipEnd)) && Number(body.clipEnd) > 0 ? Number(body.clipEnd) : asset.clipEnd,
        clipDuration: Number.isFinite(Number(body.clipDuration)) && Number(body.clipDuration) > 0 ? Number(body.clipDuration) : asset.clipDuration,
        paymentConfirmed: PAID_SOURCE_TYPES.has(nextSourceType) ? body.paymentConfirmed === true : body.paymentConfirmed === undefined ? asset.paymentConfirmed === true : body.paymentConfirmed === true,
        placement: body.placement ? normalizePlacement(body.placement) : asset.placement,
        updatedAt: new Date().toISOString()
      });
      const normalized = normalizeAssetRecord(asset);
      Object.assign(asset, normalized);
      const duration = job.currentPlan?.keepSegments?.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || Number(job.source?.duration || 0);
      const issues = assetComplianceIssues(asset, job, duration);
      if (reviewStatus === "approved" && issues.length) {
        Object.keys(asset).forEach(key => delete asset[key]);
        Object.assign(asset, before);
        return json(res, 409, { error: issues.join("；"), issues });
      }
      job.assetDecisions = [...(job.assetDecisions || []), { assetId: asset.id, reviewStatus, placement: asset.placement, licenseBasis: asset.licenseBasis, usagePurpose: asset.usagePurpose, decidedAt: new Date().toISOString() }];
      job.assetReview = assetReviewSummary(job, duration);
      job.status = "awaiting_asset_review";
      delete job.approvedAt;
      await writeJson(path.join(confined(jobsRoot, job.id), "asset-decisions.json"), job.assetDecisions);
      await saveJob(job);
      return json(res, 200, { job, asset });
    }
    const assetRenderMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/assets\/render$/);
    if (req.method === "POST" && assetRenderMatch) {
      const job = await readJob(assetRenderMatch[1]);
      if (running.has(job.id)) return json(res, 409, { error: "任务仍在处理中" });
      const duration = job.currentPlan?.keepSegments?.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || Number(job.source?.duration || 0);
      const review = assetReviewSummary(job, duration);
      if (!review.reviewComplete) return json(res, 409, { error: "仍有素材未批准或拒绝", review });
      if (!review.renderReady) return json(res, 409, { error: review.complianceIssues.map(item => `${item.assetId}：${item.issue}`).join("；"), review });
      renderReviewedAssets(job);
      return json(res, 202, { job, review });
    }
    const approveMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) {
      const job = await readJob(approveMatch[1]);
      if (!job.output) return json(res, 409, { error: "还没有可审核的成片" });
      if (job.output.qaPass !== true) return json(res, 409, { error: "当前成片QA未通过，不能最终审核" });
      const manifest = await readJsonFile(path.join(confined(jobsRoot, job.id), `media-manifest-v${job.output.version}.json`));
      if (manifest.review?.reviewComplete !== true || manifest.assets.some(asset => asset.approved && asset.composited !== true)) return json(res, 409, { error: "素材审核或实际合成状态不完整，不能最终审核" });
      job.status = "approved"; job.approvedAt = new Date().toISOString(); await saveJob(job);
      await writeJson(path.join(confined(jobsRoot, job.id), "final-review.json"), { status: "approved", version: job.currentVersion, qaPass: true, mediaReview: manifest.review, renderedAssetIds: manifest.renderedAssetIds || [], approvedAt: job.approvedAt, autoPublish: false });
      return json(res, 200, { job });
    }
    if (pathname.startsWith("/video-jobs/")) return await serveFile(req, res, confined(jobsRoot, pathname.slice("/video-jobs/".length)));
    if (pathname.startsWith("/content-items/")) return await serveFile(req, res, confined(contentRoot, pathname.slice("/content-items/".length)));
    for (const [prefix, base] of [["/runs/", path.join(root, "runs")], ["/docs/", path.join(root, "docs")], ["/config/", path.join(root, "config")]]) {
      if (pathname.startsWith(prefix)) return await serveFile(req, res, confined(base, pathname.slice(prefix.length)));
    }
    let relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    return await serveFile(req, res, confined(webRoot, relative));
  } catch (error) {
    if (!res.headersSent) json(res, error.statusCode || (error.code === "ENOENT" ? 404 : 500), { error: error.message }); else res.destroy();
  }
});
server.on("error", error => { if (error.code === "EADDRINUSE") process.exit(0); console.error(error); process.exit(1); });
if (process.env.KOUBO_NO_LISTEN !== "1") server.listen(port, host, () => console.log(`AI口播工作台：http://${host}:${port}/`));

export { normalizeAssetRecord, assetComplianceIssues, assetReviewSummary, candidatePlacement };
