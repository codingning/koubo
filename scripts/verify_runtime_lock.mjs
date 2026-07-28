import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(fs.readFileSync(path.join(root, "config", "runtime-lock.json"), "utf8"));
const failures = [];
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}: ${detail}`);
}

function run(file, args) {
  const result = spawnSync(file, args, { cwd: root, encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, output: `${result.stdout || ""}${result.stderr || ""}`.trim() };
}

check("node", process.versions.node === lock.node, process.versions.node);
const python = path.join(root, ".runtime", "Scripts", "python.exe");
const pythonResult = fs.existsSync(python) ? run(python, ["--version"]) : { ok: false, output: "missing .runtime" };
check("python", pythonResult.ok && pythonResult.output.includes(lock.python), pythonResult.output);
const packageResult = fs.existsSync(python) ? run(python, ["-c", "import importlib.metadata as m; print(m.version('faster-whisper')); print(m.version('openai')); print(m.version('python-dotenv'))"]) : { ok: false, output: "missing .runtime" };
check("python-packages", packageResult.ok && packageResult.output.includes("1.2.1") && packageResult.output.includes("2.45.0") && packageResult.output.includes("1.2.2"), packageResult.output);
const ffmpeg = path.join(root, ".runtime", "ffmpeg", "bin", "ffmpeg.exe");
const ffmpegResult = fs.existsSync(ffmpeg) ? run(ffmpeg, ["-version"]) : { ok: false, output: "missing ffmpeg" };
check("ffmpeg-version", ffmpegResult.ok && ffmpegResult.output.includes(lock.ffmpeg.versionContains), ffmpegResult.output.split(/\r?\n/)[0]);
if (fs.existsSync(ffmpeg)) {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(ffmpeg)).digest("hex");
  check("ffmpeg-sha256", hash === lock.ffmpeg.sha256, hash);
}
const server = fs.readFileSync(path.join(root, "video", "server.mjs"), "utf8");
check("hyperframes-pin", server.includes(`hyperframes@${lock.hyperframes}`), lock.hyperframes);
const skill = fs.readFileSync(path.join(root, ".agents", "skills", "koubo-ai-video-editor", "SKILL.md"), "utf8");
check("skill-local-whisper", skill.includes("faster-whisper") && !skill.includes("优先用 `video-use`"), "project Skill routing");
const plugins = JSON.parse(fs.readFileSync(path.join(root, "config", "plugins.json"), "utf8"));
check("p3-default-off", Object.values(plugins.plugins).every(item => item.enabled === false), "collage/whisperx/manim");

console.log(JSON.stringify({ ok: failures.length === 0, checks, failures }, null, 2));
if (failures.length) process.exit(1);
