import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const webRoot = path.join(root, "web");
const jobsRoot = path.join(root, "video-jobs");
const contentRoot = path.join(root, "content-items");
const runtimePython = path.join(root, ".runtime", "Scripts", "python.exe");
const aiBridge = path.join(here, "ai_bridge.py");
const host = "127.0.0.1";
const port = Number(process.env.KOUBO_PORT || 8787);
const running = new Map();
const mime = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".mp4": "video/mp4", ".webm": "video/webm",
  ".srt": "application/x-subrip; charset=utf-8", ".ass": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8"
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
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "", stderr = "";
    child.stdout?.on("data", c => { stdout += c; options.onStdout?.(String(c)); });
    child.stderr?.on("data", c => { stderr += c; options.onStderr?.(String(c)); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(Object.assign(new Error(`${command} 退出码 ${code}`), { stdout, stderr, code })));
  });
}
async function runAi(payload, workDir, name) {
  if (!fs.existsSync(runtimePython)) throw new Error("AI运行环境未安装，请重新运行工作台初始化");
  const request = path.join(workDir, `${name}-request.json`);
  const response = path.join(workDir, `${name}-response.json`);
  await writeJson(request, payload);
  try {
    await run(runtimePython, [aiBridge, "--request", request, "--response", response], { cwd: root, env: { ...process.env, OPENMONTAGE_ROOT: process.env.OPENMONTAGE_ROOT || "F:\\code\\OpenMontage" } });
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
      item.sourcePackagePath ||= `F:\\code\\koubo\\content-items\\${entry.name}\\content.json`;
      items.push(item);
    } catch {}
  }
  return items.sort((a, b) => String(b.generatedAt || b.date).localeCompare(String(a.generatedAt || a.date)));
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
  return {
    id, kind: "growth", date: shanghaiDate(), day: `Day ${dayNumber}`, column: value.column || `普通人学AI第${dayNumber}天`,
    status: "待审核", badge: "AI自动生成", durationFull: value.durationFull || "约75秒", durationShort: value.durationShort || "约40秒",
    mainTopic: String(value.mainTopic || "今天没有足够证据生成主选题"), shortTopic: String(value.shortTopic || value.mainTopic || "待确认").slice(0, 20),
    hook: String(value.hook || ""), audienceBenefit: String(value.audienceBenefit || ""),
    engagement: {
      audienceMirror: String(value.engagement?.audienceMirror || value.audienceMirror || value.audienceBenefit || ""),
      commentPrompt: String(value.engagement?.commentPrompt || value.commentPrompt || ""),
      followPromise: String(value.engagement?.followPromise || value.followPromise || value.tomorrowChallenge || value.storyPosition?.tomorrow || ""),
      viewerTask: String(value.engagement?.viewerTask || value.actionExperiment?.viewerTask || ""),
      primaryClose: String(value.engagement?.primaryClose || "")
    },
    structureDesign,
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
      { label: "AI生成证据包", path: `/content-items/${id}/evidence.json` }
    ],
    sourcePackageHref: `/content-items/${id}/content.json`,
    sourcePackagePath: `F:\\code\\koubo\\content-items\\${id}\\content.json`,
    generatedAt: new Date().toISOString(),
    generation: { model: meta.model, usage: meta.usage || {}, mode: "company-model", automatic: true, qualityRevision: meta.quality_revision || { repaired: false, initial_issues: [] } }
  };
}
async function generateContent() {
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
  const dayNumber = Math.max(1, ...existing.map(x => Number(String(x.day || "").replace(/\D/g, "")) || 0), 1) + 1;
  const id = `growth-day-${dayNumber}-${timestampId()}`;
  const dir = confined(contentRoot, id);
  await fsp.mkdir(dir, { recursive: false });
  const evidence = await collectEvidence();
  await writeJson(path.join(dir, "evidence.json"), evidence);
  const result = await runAi({ operation: "generate_content", date: shanghaiDate(), day_number: dayNumber, evidence, existing_topics: [...baseTopics, ...existing.map(x => x.mainTopic)] }, dir, "generate-content");
  const content = normalizeContent(result.data, dayNumber, id, result);
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
  return { duration, width: Number(video.width || 0), height: Number(video.height || 0), fps: Number((fpsParts[1] ? fpsParts[0] / fpsParts[1] : 0).toFixed(3)), videoCodec: video.codec_name || "", pixelFormat: video.pix_fmt || "", audioCodec: audio?.codec_name || "", hasAudio: !!audio, sizeBytes: Number(raw.format?.size || 0) };
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
function normalizeKeepSegments(raw, duration, fallback) {
  const segments = (Array.isArray(raw) ? raw : []).map(x => ({ start: Math.max(0, Number(x.start)), end: Math.min(duration, Number(x.end)), reason: String(x.reason || "AI保留") })).filter(x => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end - x.start >= 0.3).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const segment of segments) {
    const prev = merged.at(-1);
    if (prev && segment.start <= prev.end + 0.08) prev.end = Math.max(prev.end, segment.end);
    else merged.push(segment);
  }
  const kept = merged.reduce((sum, x) => sum + x.end - x.start, 0);
  if (!merged.length || kept < duration * 0.42) return fallback;
  return merged;
}
function normalizeOverlays(raw, duration) {
  return (Array.isArray(raw) ? raw : []).map((x, i) => ({ id: `overlay-${i + 1}`, start: Math.max(0, Number(x.start)), end: Math.min(duration, Number(x.end)), text: String(x.text || "").slice(0, 24), kind: String(x.kind || "evidence") })).filter(x => x.text && x.end - x.start >= 0.5).slice(0, 6);
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
function transcriptCues(transcript, keeps) {
  const words = Array.isArray(transcript?.words) ? transcript.words : [];
  if (words.length) {
    const mapped = words.map(w => ({ text: String(w.word || "").trim(), start: sourceToOutput(Number(w.start), keeps), end: sourceToOutput(Number(w.end), keeps) })).filter(w => w.text && w.start !== null && w.end !== null);
    const cues = []; let group = null;
    for (const word of mapped) {
      if (!group) group = { start: word.start, end: word.end, text: word.text };
      else {
        const nextText = group.text + word.text;
        const breakNow = nextText.length > 16 || word.end - group.start > 3.2 || /[。！？!?]$/.test(group.text);
        if (breakNow) { cues.push(group); group = { start: word.start, end: word.end, text: word.text }; }
        else { group.text = nextText; group.end = word.end; }
      }
    }
    if (group) cues.push(group);
    return cues;
  }
  return (transcript?.segments || []).map(s => ({ text: s.text, start: sourceToOutput(Number(s.start), keeps), end: sourceToOutput(Number(s.end), keeps) })).filter(x => x.text && x.start !== null && x.end !== null);
}
async function writeAss(jobDir, transcript, keeps, overlays, version) {
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]", "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Caption,Microsoft YaHei,56,&H00FFFFFF,&H000000FF,&H00101010,&H70000000,-1,0,0,0,100,100,1,0,1,4,0,2,70,70,180,1",
    "Style: Overlay,Microsoft YaHei,76,&H00FFFFFF,&H000000FF,&H00000000,&H900F8278,-1,0,0,0,100,100,1,0,3,2,0,8,90,90,230,1", "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
  ];
  for (const cue of transcriptCues(transcript, keeps)) lines.push(`Dialogue: 0,${assTime(cue.start)},${assTime(Math.max(cue.end, cue.start + 0.35))},Caption,,0,0,0,,${assEscape(cue.text)}`);
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
async function renderVersion(job, version) {
  const jobDir = confined(jobsRoot, job.id), plan = job.currentPlan, segments = plan.keepSegments;
  job.status = version > 1 ? "revising" : "rendering"; job.progress = 2; await saveJob(job);
  const duration = segments.reduce((sum, x) => sum + x.end - x.start, 0), filters = [];
  segments.forEach((segment, i) => {
    const d = segment.end - segment.start;
    filters.push(`[0:v]trim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    filters.push(`[0:a]atrim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${Math.min(0.03, d / 3).toFixed(3)},afade=t=out:st=${Math.max(0, d - 0.03).toFixed(3)}:d=${Math.min(0.03, d / 3).toFixed(3)}[a${i}]`);
  });
  filters.push(`${segments.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);
  filters.push(`[vcat]${videoLayoutFilter(job.options.layout || "vertical")}[vbase]`);
  if (job.options.captions !== false) {
    await writeAss(jobDir, job.transcript, segments, plan.overlayCards || [], version);
    filters.push(`[vbase]ass=filename='captions-v${version}.ass'[vsub]`);
    filters.push("[vsub]fps=30,format=yuv420p[vout]");
  } else filters.push("[vbase]fps=30,format=yuv420p[vout]");
  filters.push("[acat]highpass=f=80,lowpass=f=15000,loudnorm=I=-16:TP=-1.5:LRA=11[aout]");
  const filterFile = path.join(jobDir, `filter-v${version}.ffscript`); await fsp.writeFile(filterFile, filters.join(";\r\n") + ";\r\n", "utf8");
  const outputPath = path.join(jobDir, `final-v${version}.mp4`); let progressBuffer = "", stderr = "";
  const child = spawn("ffmpeg", ["-y", "-hide_banner", "-i", job.sourcePath, "-/filter_complex", filterFile, "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", outputPath], { cwd: jobDir, windowsHide: true });
  child.stdout.on("data", async chunk => {
    progressBuffer += String(chunk); const lines = progressBuffer.split(/\r?\n/); progressBuffer = lines.pop() || "";
    for (const line of lines) { const m = line.match(/^out_time_ms=(\d+)/); if (m && duration > 0) { job.progress = Math.min(98, Math.max(3, Math.round(Number(m[1]) / 1e6 / duration * 100))); await saveJob(job).catch(() => {}); } }
  });
  child.stderr.on("data", c => { stderr += c; if (stderr.length > 120000) stderr = stderr.slice(-120000); });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  if (code !== 0) throw Object.assign(new Error(`ffmpeg 渲染失败（退出码 ${code}）`), { stderr });
  await run("ffmpeg", ["-v", "error", "-i", outputPath, "-f", "null", "-"]);
  const output = await probe(outputPath), thumbnail = path.join(jobDir, `thumbnail-v${version}.jpg`);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(Math.min(1.2, output.duration / 3)), "-i", outputPath, "-frames:v", "1", "-q:v", "2", thumbnail]);
  await fsp.copyFile(outputPath, path.join(jobDir, "final.mp4"));
  const versionResult = { version, path: outputPath, url: `/video-jobs/${job.id}/final-v${version}.mp4`, thumbnailUrl: `/video-jobs/${job.id}/thumbnail-v${version}.jpg`, metadata: output, qa: { h264: output.videoCodec === "h264", aac: output.audioCodec === "aac", yuv420p: output.pixelFormat === "yuv420p", durationMatches: Math.abs(output.duration - duration) < 1.6, decodes: true }, createdAt: new Date().toISOString(), model: job.planModel || null };
  job.versions = [...(job.versions || []).filter(x => x.version !== version), versionResult];
  job.output = versionResult; job.status = "awaiting_review"; job.progress = 100; await saveJob(job);
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
      const result = await runAi({ operation: "edit_plan", script: job.script, source: job.source, transcript: job.transcript, base_plan: { silences, keepSegments: fallback } }, jobDir, "edit-plan-v1");
      aiPlan = result.data; job.planModel = result.model; job.modelUsage = result.usage;
    } catch (error) { job.degraded = [...(job.degraded || []), `AI剪辑决策失败，使用停顿剪辑：${error.message}`]; }
    job.currentVersion = 1;
    job.currentPlan = { version: 1, keepSegments: normalizeKeepSegments(aiPlan?.keepSegments, job.source.duration, fallback), overlayCards: normalizeOverlays(aiPlan?.overlayCards, job.source.duration), editSummary: aiPlan?.editSummary || "本地停顿剪辑", removedReasons: aiPlan?.removedReasons || [], confidence: aiPlan?.confidence ?? null, createdAt: new Date().toISOString() };
    await writeJson(path.join(jobDir, "edit-plan-v1.json"), job.currentPlan);
    await saveJob(job);
    await renderVersion(job, 1);
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
    const result = await runAi({ operation: "revise_plan", feedback, script: job.script, source: job.source, transcript: job.transcript, base_plan: job.currentPlan }, dir, `edit-plan-v${version}`);
    const fallback = job.currentPlan.keepSegments;
    job.currentVersion = version; job.planModel = result.model; job.modelUsage = result.usage;
    let revisedOverlays = normalizeOverlays(result.data?.overlayCards, job.source.duration);
    const overlayLimit = feedbackOverlayLimit(feedback);
    if (overlayLimit !== null) revisedOverlays = revisedOverlays.slice(0, overlayLimit);
    job.currentPlan = { version, keepSegments: normalizeKeepSegments(result.data?.keepSegments, job.source.duration, fallback), overlayCards: revisedOverlays, editSummary: result.data?.editSummary || `按反馈修改：${feedback}`, removedReasons: result.data?.removedReasons || [], confidence: result.data?.confidence ?? null, feedback, createdAt: new Date().toISOString() };
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
      return json(res, 200, { ok: true, service: "koubo-ai-workflow", version: 2, localOnlyVideo: true, ffmpeg, hyperframes, ai: { configured: !!ai?.success, model: ai?.model || null, transcriptionModel: ai?.transcription_model || "faster-whisper/small" }, jobsRoot, contentRoot });
    }
    if (req.method === "GET" && pathname === "/api/contents") return json(res, 200, { items: await listGeneratedContents() });
    if (req.method === "POST" && pathname === "/api/contents/generate") return json(res, 201, { item: await generateContent() });
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
      const job = { id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "uploaded", progress: 0, fileName, sizeBytes, sourcePath, contentId: decodeURIComponent(req.headers["x-content-id"] || ""), script: String(options.script || ""), options: { removeSilence: options.removeSilence !== false, captions: options.captions !== false, layout: ["original", "vertical", "square"].includes(options.layout) ? options.layout : "vertical", silenceDb: Number(options.silenceDb ?? -36), silenceDuration: Number(options.silenceDuration ?? 0.45), pauseKeep: Number(options.pauseKeep ?? 0.12), transcriptionModel: options.transcriptionModel || "small", aiMode: "full-auto" }, versions: [], reviews: [] };
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
    if (req.method === "POST" && reviseMatch) { const body = await readBodyJson(req); const feedback = String(body.feedback || "").trim(); if (!feedback) return json(res, 400, { error: "请填写修改意见" }); const job = await readJob(reviseMatch[1]); reviseJob(job, feedback); return json(res, 202, { job }); }
    const approveMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) { const job = await readJob(approveMatch[1]); if (!job.output) return json(res, 409, { error: "还没有可审核的成片" }); job.status = "approved"; job.approvedAt = new Date().toISOString(); await saveJob(job); await writeJson(path.join(confined(jobsRoot, job.id), "final-review.json"), { status: "approved", version: job.currentVersion, approvedAt: job.approvedAt }); return json(res, 200, { job }); }
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
server.listen(port, host, () => console.log(`AI口播工作台：http://${host}:${port}/`));
