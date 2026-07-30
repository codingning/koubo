import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function argsOf(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    result[value.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function safeId(value) {
  return String(value || "published-video").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "published-video";
}

function scriptText(markdown) {
  const source = String(markdown || "");
  const narration = source.match(/##\s+Narration segments\s*\r?\n([\s\S]*?)(?=\r?\n##\s+|$)/i)?.[1];
  if (narration) {
    return narration.split(/\r?\n/)
      .map(line => line.replace(/^\s*\d+\.\s*/, "").trim())
      .filter(Boolean)
      .join("\n");
  }
  return source
    .replace(/^---[\s\S]*?---/m, "")
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^\*\*.*?\*\*.*$/gm, "")
    .replace(/^\d+\.\s*/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => fs.createReadStream(file).on("data", chunk => hash.update(chunk)).on("end", resolve).on("error", reject));
  return hash.digest("hex");
}

const options = argsOf(process.argv.slice(2));
if (!options.video || !options.project || !options.title) {
  throw new Error("usage: node scripts/build_publish_package.mjs --video <final.mp4> --project <project-dir> --title <cover title> [--cover-source <real-person.mp4>] [--cover-time <seconds>] [--script <SCRIPT.md>] [--version <n>]");
}

const videoPath = path.resolve(options.video);
const coverSourcePath = options["cover-source"] ? path.resolve(options["cover-source"]) : videoPath;
const projectDir = path.resolve(options.project);
const version = Math.max(1, Number(options.version || 1));
const projectId = safeId(path.basename(projectDir));
const jobId = `published-${projectId}-v${version}`;
const jobDir = path.join(root, "video-jobs", jobId);
const publishDir = path.join(projectDir, "publish", `v${version}`);
const scriptPath = options.script ? path.resolve(options.script) : path.join(projectDir, "SCRIPT.md");

if (!fs.existsSync(videoPath)) throw new Error(`video not found: ${videoPath}`);
if (!fs.existsSync(coverSourcePath)) throw new Error(`cover source not found: ${coverSourcePath}`);
await Promise.all([fsp.mkdir(jobDir, { recursive: true }), fsp.mkdir(publishDir, { recursive: true })]);
const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", videoPath]));
const videoStream = probe.streams.find(stream => stream.codec_type === "video");
const duration = Number(probe.format?.duration || videoStream?.duration || 0);
const coverProbe = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", coverSourcePath]));
const coverVideoStream = coverProbe.streams.find(stream => stream.codec_type === "video");
const coverDuration = Number(coverProbe.format?.duration || coverVideoStream?.duration || 0);
const requestedCoverTime = Number(options["cover-time"] ?? options.time);
const coverSourceTime = Number.isFinite(requestedCoverTime)
  ? Math.min(Math.max(0, requestedCoverTime), Math.max(0, coverDuration - 0.05))
  : Math.min(Math.max(0.5, coverDuration * 0.22), Math.max(0.5, coverDuration - 0.25));
const script = fs.existsSync(scriptPath) ? scriptText(await fsp.readFile(scriptPath, "utf8")) : String(options.title);
const mediaSha256 = await sha256(videoPath);

process.env.KOUBO_NO_LISTEN = "1";
process.env.KOUBO_MULTI_AGENT_DATA_ROOT = path.join(jobDir, "multi-agent-runtime");
const server = await import(`../video/server.mjs?publish-cli=${Date.now()}`);

const output = {
  version,
  path: videoPath,
  url: videoPath,
  qaPass: true,
  mediaSha256,
  duration,
  metadata: { duration, width: Number(videoStream?.width || 1080), height: Number(videoStream?.height || 1920) },
  qa: {},
  artifacts: {},
};
const job = {
  id: jobId,
  status: "approved",
  sourcePath: videoPath,
  source: {
    width: Number(videoStream?.width || 1080),
    height: Number(videoStream?.height || 1920),
    duration,
    colorTransfer: videoStream?.color_transfer || "bt709",
    colorPrimaries: videoStream?.color_primaries || "bt709",
  },
  script,
  currentPlan: {
    keepSegments: [{ start: 0, end: duration }],
    coverDesign: {
      lines: String(options.title).split(/[\/｜|]+/).map(item => item.trim()).filter(Boolean).slice(0, 2),
      highlights: String(options.highlight || "没用").split(/[，,、\s]+/).filter(Boolean),
      sourceTime: coverSourceTime,
    },
  },
  options: {
    generateCover: true,
    coverTitle: String(options.title),
    contentTitle: String(options.title).replace(/[\/｜|]+/g, ""),
    coverSourcePath,
    coverSourceRole: coverSourcePath === videoPath ? "approved-final-video-frame" : "user-provided-real-person-source",
    coverSourceTime,
  },
  output,
  versions: [output],
  approvedAt: new Date().toISOString(),
};

try {
  const cover = await server.renderCover(job, version);
  job.output = { ...job.output, cover };
  job.versions = [job.output];
  const publishPackage = await server.buildPublishPackage(job, version, { mode: "regenerate", automatic: true });
  await fsp.writeFile(path.join(jobDir, "job.json"), JSON.stringify(job, null, 2), "utf8");
  const files = [
    `publish-package-v${version}.json`, `publish-copy-v${version}.md`, `publish-package-v${version}.zip`,
    path.join("covers", `v${version}`, `cover-v${version}-9x16.png`),
    path.join("covers", `v${version}`, `cover-v${version}-3x4.png`),
    path.join("covers", `v${version}`, `cover-v${version}-16x9.png`),
    path.join("covers", `v${version}`, `cover-v${version}-4x3.png`),
  ];
  for (const relative of files) {
    const source = path.join(jobDir, relative);
    if (fs.existsSync(source)) await fsp.copyFile(source, path.join(publishDir, path.basename(source)));
  }
  await fsp.writeFile(path.join(projectDir, "publish", "latest.json"), JSON.stringify({
    jobId,
    outputVersion: version,
    mediaSha256,
    publishDir,
    selectedTitle: publishPackage.selectedTitle,
    generatedAt: publishPackage.generatedAt,
    autoPublish: false,
  }, null, 2), "utf8");
  console.log(JSON.stringify({ jobId, publishDir, mediaSha256, publishPackage }, null, 2));
} finally {
  await server.closeServerResourcesForTests();
}
