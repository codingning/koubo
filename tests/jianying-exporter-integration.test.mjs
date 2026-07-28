import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { exporterRequest } from "../video/exporters/contracts.mjs";
import { runJianyingExporter } from "../video/exporters/jianying.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("real Jianying exporter creates independently editable verified segments", async t => {
  const ffmpeg = path.join(root, ".runtime", "ffmpeg", "bin", "ffmpeg.exe");
  const python = path.join(root, ".runtime-exporters", "Scripts", "python.exe");
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(python)) return t.skip("run scripts/setup_runtime.ps1 first");
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "koubo-jianying-test-"));
  t.after(() => fsp.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source.mp4");
  const generated = spawnSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0x14324A:s=640x360:r=30:d=4",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
  ], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const timeline = {
    version: 1,
    source: { path: source, duration: 4, width: 640, height: 360, fps: 30 },
    outputDuration: 3,
    clips: [
      { id: "clip-001", sourceIn: 0, sourceOut: 1.5, outputIn: 0, outputOut: 1.5, reason: "keep" },
      { id: "clip-002", sourceIn: 2, sourceOut: 3.5, outputIn: 1.5, outputOut: 3, reason: "keep" },
    ],
  };
  const request = exporterRequest({ job: { id: "fixture-job" }, timeline, exporter: "jianying", outputRoot: path.join(temp, "drafts"), draftName: "fixture-draft" });
  const result = await runJianyingExporter(request, { python, cwd: root });
  assert.equal(result.ok, true);
  assert.equal(result.segment_count, 2);
  assert.equal(result.verification.checks.audio_fades_30ms, true);
  assert.equal(result.verification.checks.source_ranges, true);
  assert.deepEqual(result.verification.actual_source_ranges, [
    { start: 0, duration: 1_500_000 },
    { start: 2_000_000, duration: 1_500_000 },
  ]);
  assert.equal(fs.existsSync(path.join(result.draft_path, "draft_content.json")), true);
  assert.equal(fs.existsSync(path.join(result.draft_path, "draft_meta_info.json")), true);
});
