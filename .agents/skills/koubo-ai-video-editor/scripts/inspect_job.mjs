import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const dir = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(path.join(dir, "job.json"))) {
  console.error("用法: node inspect_job.mjs <包含 job.json 的任务目录>");
  process.exit(2);
}
const parseJsonFile = async file => JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
const job = await parseJsonFile(path.join(dir, "job.json"));
const planPath = path.join(dir, "edit-plan.json");
const plan = fs.existsSync(planPath) ? await parseJsonFile(planPath) : null;
const framesDir = path.join(dir, "frames");
await fsp.mkdir(framesDir, { recursive: true });

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", c => stderr += c);
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}): ${stderr.slice(-1000)}`)));
  });
}

const duration = Number(job.source?.duration || plan?.sourceMetadata?.duration || 0);
const moments = new Set([0.5, Math.max(0.5, duration / 2), Math.max(0.5, duration - 0.5)]);
for (const segment of (plan?.keepSegments || []).slice(0, 10)) {
  moments.add(Math.max(0.1, Number(segment.start) + 0.05));
  moments.add(Math.max(0.1, Number(segment.end) - 0.05));
}
let index = 0;
for (const moment of [...moments].filter(v => v < duration).sort((a,b) => a-b).slice(0, 16)) {
  const out = path.join(framesDir, `frame-${String(++index).padStart(2,"0")}-${moment.toFixed(2)}s.jpg`);
  if (!fs.existsSync(out)) await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(moment), "-i", job.sourcePath, "-frames:v", "1", "-q:v", "2", out]);
}
const brief = `# AI剪辑任务摘要\n\n- 任务ID：${job.id}\n- 源视频：${job.sourcePath}\n- 状态：${job.status}\n- 原始时长：${duration.toFixed(2)} 秒\n- 预计成片：${Number(job.analysis?.estimatedDuration || 0).toFixed(2)} 秒\n- 检测停顿：${job.analysis?.silences?.length || 0} 段\n- 输出比例：${job.options?.layout || "vertical"}\n- 字幕：${job.options?.captions === false ? "关闭" : "开启"}\n- AI模式：${job.options?.aiMode || "local-smart-cut"}\n\n## 当前口播稿\n\n${job.script || "（未提供）"}\n\n## 下一步\n\n1. 查看 frames/ 关键帧。\n2. 核对 edit-plan.json 的保留区间。\n3. 决定是否需要语义删错句、动态图卡或平台派生版。\n4. 新输出不得覆盖源视频。\n`;
await fsp.writeFile(path.join(dir, "ai-brief.md"), brief, "utf8");
console.log(JSON.stringify({ job: job.id, status: job.status, frames: index, brief: path.join(dir, "ai-brief.md") }, null, 2));
