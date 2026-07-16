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
const host = "127.0.0.1";
const port = Number(process.env.KOUBO_PORT || 8787);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".srt": "application/x-subrip; charset=utf-8"
};

await fsp.mkdir(jobsRoot, { recursive: true });
const running = new Map();

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
  return String(value || "video.mp4")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.{2,}/g, ".")
    .slice(0, 160) || "video.mp4";
}

function confined(base, target) {
  const resolved = path.resolve(base, target);
  if (!resolved.toLowerCase().startsWith(path.resolve(base).toLowerCase() + path.sep.toLowerCase()) && resolved.toLowerCase() !== path.resolve(base).toLowerCase()) {
    throw new Error("路径越界");
  }
  return resolved;
}

async function writeJson(file, data) {
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(temp, file);
}

async function readJob(id) {
  const dir = confined(jobsRoot, id);
  return JSON.parse(await fsp.readFile(path.join(dir, "job.json"), "utf8"));
}

async function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  await writeJson(path.join(confined(jobsRoot, job.id), "job.json"), job);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; options.onStdout?.(String(chunk)); });
    child.stderr?.on("data", chunk => { stderr += chunk; options.onStderr?.(String(chunk)); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(Object.assign(new Error(`${command} 退出码 ${code}`), { stdout, stderr, code })));
  });
}

async function probe(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  const raw = JSON.parse(stdout);
  const video = raw.streams?.find(s => s.codec_type === "video") || {};
  const audio = raw.streams?.find(s => s.codec_type === "audio") || null;
  const duration = Number(raw.format?.duration || video.duration || audio?.duration || 0);
  const fpsParts = String(video.avg_frame_rate || video.r_frame_rate || "0/1").split("/").map(Number);
  const fps = fpsParts[1] ? fpsParts[0] / fpsParts[1] : 0;
  return {
    duration,
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    fps: Number(fps.toFixed(3)),
    videoCodec: video.codec_name || "",
    pixelFormat: video.pix_fmt || "",
    audioCodec: audio?.codec_name || "",
    hasAudio: !!audio,
    sizeBytes: Number(raw.format?.size || 0)
  };
}

function parseSilences(stderr, duration) {
  const events = [];
  let open = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([0-9.]+)/);
    if (start) open = Number(start[1]);
    const end = line.match(/silence_end:\s*([0-9.]+)/);
    if (end && open !== null) {
      events.push({ start: open, end: Number(end[1]) });
      open = null;
    }
  }
  if (open !== null && duration > open) events.push({ start: open, end: duration });
  return events.filter(item => item.end > item.start);
}

function buildKeepSegments(duration, silences, pauseKeep = 0.12) {
  const removals = silences
    .map(s => ({ start: Math.max(0, s.start + pauseKeep), end: Math.min(duration, s.end - pauseKeep) }))
    .filter(s => s.end - s.start >= 0.18)
    .sort((a, b) => a.start - b.start);
  const keep = [];
  let cursor = 0;
  for (const cut of removals) {
    if (cut.start - cursor >= 0.12) keep.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (duration - cursor >= 0.12) keep.push({ start: cursor, end: duration });
  return keep.length ? keep : [{ start: 0, end: duration }];
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const z = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(z).padStart(3, "0")}`;
}

function splitCaptionText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const sentences = normalized.split(/(?<=[，。！？；：,.!?;:])/u).filter(Boolean);
  const chunks = [];
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > 15) {
      let end = 13;
      const near = rest.slice(7, 16).search(/[，。！？；：,.!?;:]/u);
      if (near >= 0) end = 7 + near + 1;
      chunks.push(rest.slice(0, end));
      rest = rest.slice(end);
    }
    if (rest) chunks.push(rest);
  }
  return chunks;
}

async function writeCaptions(jobDir, script, duration) {
  const chunks = splitCaptionText(script);
  if (!chunks.length || duration <= 0) return null;
  const totalWeight = chunks.reduce((sum, item) => sum + Math.max(4, item.length), 0);
  let cursor = 0;
  const lines = [];
  chunks.forEach((chunk, index) => {
    const share = Math.max(4, chunk.length) / totalWeight;
    const next = index === chunks.length - 1 ? duration : Math.min(duration, cursor + Math.max(0.9, duration * share));
    lines.push(String(index + 1), `${srtTime(cursor)} --> ${srtTime(next)}`, chunk, "");
    cursor = next;
  });
  const file = path.join(jobDir, "captions.srt");
  await fsp.writeFile(file, lines.join("\r\n"), "utf8");
  return file;
}

function videoLayoutFilter(layout) {
  if (layout === "vertical") {
    return "split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:8[bg2];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2";
  }
  if (layout === "square") {
    return "split=2[bg][fg];[bg]scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,boxblur=24:8[bg2];[fg]scale=1080:1080:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2";
  }
  return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
}

async function analyzeJob(job) {
  const jobDir = confined(jobsRoot, job.id);
  try {
    job.status = "analyzing";
    job.progress = 5;
    await saveJob(job);
    job.source = await probe(job.sourcePath);
    job.progress = 20;
    await saveJob(job);

    let silences = [];
    if (job.source.hasAudio && job.options.removeSilence !== false) {
      const noise = Number(job.options.silenceDb ?? -36);
      const minDuration = Number(job.options.silenceDuration ?? 0.45);
      const result = await run("ffmpeg", ["-hide_banner", "-i", job.sourcePath, "-af", `silencedetect=noise=${noise}dB:d=${minDuration}`, "-f", "null", "-"]);
      silences = parseSilences(result.stderr, job.source.duration);
    }
    const keepSegments = buildKeepSegments(job.source.duration, silences, Number(job.options.pauseKeep ?? 0.12));
    const outputDuration = keepSegments.reduce((sum, item) => sum + item.end - item.start, 0);
    job.analysis = {
      silences,
      keepSegments,
      removedDuration: Math.max(0, job.source.duration - outputDuration),
      estimatedDuration: outputDuration,
      strategy: "优先保留完整说话段，删除长停顿；每个切点保留短呼吸并在音频两侧加淡入淡出。"
    };
    await writeJson(path.join(jobDir, "edit-plan.json"), {
      version: 1,
      source: job.sourcePath,
      contentId: job.contentId,
      options: job.options,
      sourceMetadata: job.source,
      keepSegments,
      silences,
      estimatedDuration: outputDuration,
      inheritedSkills: ["HyperFrames", "Video Use", "Promotion", "Generative Media", "Video Cut", "AI Video Workflow"]
    });
    job.status = "analyzed";
    job.progress = 100;
    await saveJob(job);
  } catch (error) {
    job.status = "error";
    job.error = error.message;
    job.errorDetail = String(error.stderr || "").slice(-6000);
    await saveJob(job);
  }
}

async function renderJob(job) {
  if (running.has(job.id)) return;
  running.set(job.id, true);
  const jobDir = confined(jobsRoot, job.id);
  try {
    job.status = "rendering";
    job.progress = 1;
    job.error = null;
    await saveJob(job);
    const segments = job.analysis?.keepSegments || [{ start: 0, end: job.source.duration }];
    const duration = segments.reduce((sum, item) => sum + item.end - item.start, 0);
    const filterLines = [];
    segments.forEach((segment, index) => {
      const d = segment.end - segment.start;
      filterLines.push(`[0:v]trim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},setpts=PTS-STARTPTS[v${index}]`);
      filterLines.push(`[0:a]atrim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${Math.min(0.03, d / 3).toFixed(3)},afade=t=out:st=${Math.max(0, d - 0.03).toFixed(3)}:d=${Math.min(0.03, d / 3).toFixed(3)}[a${index}]`);
    });
    const concatInputs = segments.map((_, index) => `[v${index}][a${index}]`).join("");
    filterLines.push(`${concatInputs}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);
    filterLines.push(`[vcat]${videoLayoutFilter(job.options.layout || "vertical")}[vbase]`);
    let videoOut = "vbase";
    if (job.options.captions !== false && job.script) {
      await writeCaptions(jobDir, job.script, duration);
      filterLines.push(`[vbase]subtitles=filename='captions.srt':force_style='FontName=Microsoft YaHei,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=110'[vcap]`);
      videoOut = "vcap";
    }
    filterLines.push(`[${videoOut}]fps=30,format=yuv420p[vout]`);
    filterLines.push("[acat]loudnorm=I=-16:TP=-1.5:LRA=11[aout]");
    const filterFile = path.join(jobDir, "filter.ffscript");
    await fsp.writeFile(filterFile, filterLines.join(";\r\n") + ";\r\n", "utf8");
    const outputPath = path.join(jobDir, "final.mp4");
    let progressBuffer = "";
    const child = spawn("ffmpeg", [
      "-y", "-hide_banner", "-i", job.sourcePath,
      "-/filter_complex", filterFile,
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
      "-progress", "pipe:1", "-nostats", outputPath
    ], { cwd: jobDir, windowsHide: true });
    child.stdout.on("data", async chunk => {
      progressBuffer += String(chunk);
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || "";
      for (const line of lines) {
        const match = line.match(/^out_time_ms=(\d+)/);
        if (match && duration > 0) {
          job.progress = Math.min(99, Math.max(2, Math.round((Number(match[1]) / 1000000 / duration) * 100)));
          await saveJob(job).catch(() => {});
        }
      }
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 100000) stderr = stderr.slice(-100000); });
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    if (code !== 0) throw Object.assign(new Error(`ffmpeg 渲染失败（退出码 ${code}）`), { stderr });
    const output = await probe(outputPath);
    const thumbnail = path.join(jobDir, "thumbnail.jpg");
    await run("ffmpeg", ["-y", "-ss", String(Math.min(1, output.duration / 3)), "-i", outputPath, "-frames:v", "1", "-q:v", "2", thumbnail]);
    job.output = {
      path: outputPath,
      url: `/video-jobs/${job.id}/final.mp4`,
      thumbnailUrl: `/video-jobs/${job.id}/thumbnail.jpg`,
      metadata: output,
      qa: {
        h264: output.videoCodec === "h264",
        aac: output.audioCodec === "aac",
        yuv420p: output.pixelFormat === "yuv420p",
        durationMatches: Math.abs(output.duration - duration) < 1.5
      }
    };
    job.status = "completed";
    job.progress = 100;
    await saveJob(job);
  } catch (error) {
    job.status = "error";
    job.error = error.message;
    job.errorDetail = String(error.stderr || "").slice(-6000);
    await saveJob(job);
  } finally {
    running.delete(job.id);
  }
}

async function receiveUpload(req, jobDir, target) {
  const maxBytes = 8 * 1024 * 1024 * 1024;
  let total = 0;
  const stream = fs.createWriteStream(target, { flags: "wx" });
  await new Promise((resolve, reject) => {
    req.on("data", chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("视频超过 8GB 限制"));
        req.destroy();
        return;
      }
      if (!stream.write(chunk)) req.pause(), stream.once("drain", () => req.resume());
    });
    req.on("end", () => stream.end(resolve));
    req.on("error", reject);
    stream.on("error", reject);
  });
  return total;
}

async function serveFile(res, file) {
  const stat = await fsp.stat(file);
  const type = mime[path.extname(file).toLowerCase()] || "application/octet-stream";
  cors(res);
  res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    cors(res);
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const url = new URL(req.url, `http://${host}:${port}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === "GET" && pathname === "/api/health") {
      let ffmpeg = false;
      let hyperframes = false;
      try { await run("ffmpeg", ["-version"]); ffmpeg = true; } catch {}
      try { await run("npx", ["-y", "hyperframes", "--version"], { shell: true }); hyperframes = true; } catch {}
      return json(res, 200, { ok: true, service: "koubo-ai-video", version: 1, localOnly: true, ffmpeg, hyperframes, jobsRoot });
    }

    if (req.method === "GET" && pathname === "/api/jobs") {
      const entries = await fsp.readdir(jobsRoot, { withFileTypes: true });
      const jobs = [];
      for (const entry of entries.filter(x => x.isDirectory()).slice(-30).reverse()) {
        try { jobs.push(await readJob(entry.name)); } catch {}
      }
      return json(res, 200, { jobs });
    }

    if (req.method === "POST" && pathname === "/api/jobs") {
      const id = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
      const jobDir = confined(jobsRoot, id);
      await fsp.mkdir(jobDir, { recursive: false });
      const fileName = safeName(decodeURIComponent(req.headers["x-file-name"] || "video.mp4"));
      const sourcePath = path.join(jobDir, fileName);
      let options = {};
      try { options = JSON.parse(decodeURIComponent(req.headers["x-options"] || "%7B%7D")); } catch {}
      const contentId = decodeURIComponent(req.headers["x-content-id"] || "");
      const sizeBytes = await receiveUpload(req, jobDir, sourcePath);
      const job = {
        id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "uploaded",
        progress: 0,
        fileName,
        sizeBytes,
        sourcePath,
        contentId,
        script: String(options.script || ""),
        options: {
          removeSilence: options.removeSilence !== false,
          captions: options.captions !== false,
          layout: ["original", "vertical", "square"].includes(options.layout) ? options.layout : "vertical",
          silenceDb: Number(options.silenceDb ?? -36),
          silenceDuration: Number(options.silenceDuration ?? 0.45),
          pauseKeep: Number(options.pauseKeep ?? 0.12),
          aiMode: options.aiMode || "local-smart-cut"
        }
      };
      await saveJob(job);
      analyzeJob(job);
      return json(res, 202, { job });
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) return json(res, 200, { job: await readJob(jobMatch[1]) });

    const renderMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/render$/);
    if (req.method === "POST" && renderMatch) {
      const job = await readJob(renderMatch[1]);
      if (!job.analysis) return json(res, 409, { error: "请先等待分析完成" });
      renderJob(job);
      return json(res, 202, { job });
    }

    if (pathname.startsWith("/video-jobs/")) {
      const file = confined(jobsRoot, pathname.slice("/video-jobs/".length));
      return await serveFile(res, file);
    }

    let relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    if (relative === "data/content-data.js") relative = path.join("data", "content-data.js");
    const file = confined(webRoot, relative);
    return await serveFile(res, file);
  } catch (error) {
    if (!res.headersSent) json(res, error.code === "ENOENT" ? 404 : 500, { error: error.message });
    else res.destroy();
  }
});

server.on("error", error => {
  if (error.code === "EADDRINUSE") process.exit(0);
  console.error(error);
  process.exit(1);
});
server.listen(port, host, () => console.log(`AI口播工作台：http://${host}:${port}/`));
