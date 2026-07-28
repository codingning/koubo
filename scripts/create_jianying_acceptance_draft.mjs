import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exporterRequest } from "../video/exporters/contracts.mjs";
import { runJianyingExporter } from "../video/exporters/jianying.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const draftRoot = path.resolve(String(process.argv[2] || ""));
if (!process.argv[2]) throw new Error("usage: node scripts/create_jianying_acceptance_draft.mjs <jianying-draft-root>");
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const draftName = `koubo-acceptance-${stamp}`;
const fixtureDir = path.join(root, "outputs", "acceptance", draftName);
const source = path.join(fixtureDir, "jianying-source.mp4");
const resultFile = path.join(fixtureDir, "export-result.json");
if (fs.existsSync(path.join(draftRoot, draftName))) throw new Error("acceptance draft already exists");

await fsp.mkdir(fixtureDir, { recursive: false });
const ffmpeg = path.join(root, ".runtime", "ffmpeg", "bin", "ffmpeg.exe");
const python = path.join(root, ".runtime-exporters", "Scripts", "python.exe");
if (!fs.existsSync(ffmpeg) || !fs.existsSync(python)) {
  throw new Error("Koubo exporter runtime is missing");
}
const generated = spawnSync(ffmpeg, [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=6",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
], { cwd: root, encoding: "utf8", windowsHide: true });
if (generated.status !== 0) throw new Error(generated.stderr || "fixture generation failed");

const timeline = {
  version: 1,
  source: { path: source, duration: 6, width: 1280, height: 720, fps: 30 },
  outputDuration: 4,
  clips: [
    { id: "clip-001", sourceIn: 0, sourceOut: 2, outputIn: 0, outputOut: 2, reason: "acceptance first clip" },
    { id: "clip-002", sourceIn: 3, sourceOut: 5, outputIn: 2, outputOut: 4, reason: "acceptance second clip" },
  ],
};
const request = exporterRequest({
  job: { id: draftName },
  timeline,
  exporter: "jianying",
  outputRoot: draftRoot,
  draftName,
});
const result = await runJianyingExporter(request, { python, cwd: root });
const record = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  fixture: { source, codec: "H.264/AAC", width: 1280, height: 720, durationSeconds: 6 },
  timeline,
  exporter: result,
};
await fsp.writeFile(resultFile, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({ draftName, draftPath: result.draft_path, resultFile, verification: result.verification })}\n`);
