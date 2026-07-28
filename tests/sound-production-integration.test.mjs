import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { renderSoundDesign } from "../video/audio/production.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("trial-gated local semantic SFX renders without re-encoding video", async t => {
  const ffmpeg = path.join(root, ".runtime", "ffmpeg", "bin", "ffmpeg.exe");
  const ffprobe = path.join(root, ".runtime", "ffmpeg", "bin", "ffprobe.exe");
  if (!fs.existsSync(ffmpeg)) return t.skip("runtime missing");
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "koubo-sound-test-"));
  t.after(() => fsp.rm(temp, { recursive: true, force: true }));
  const input = path.join(temp, "input.mp4");
  const cue = path.join(temp, "cue.wav");
  const output = path.join(temp, "output.mp4");
  let command = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=3", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", input], { encoding: "utf8" });
  assert.equal(command.status, 0, command.stderr);
  command = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=1200:sample_rate=48000:duration=0.12", cue], { encoding: "utf8" });
  assert.equal(command.status, 0, command.stderr);
  await renderSoundDesign({
    ffmpeg,
    inputVideo: input,
    outputVideo: output,
    policy: { productionEnabled: false, semanticSfx: { maxCues: 12 } },
    allowTrial: true,
    design: { enabled: true, cues: [{ id: "confirm", path: cue, at: 1.1, gain: 0.2, licenseBasis: "local-programmatic", semanticReason: "确认结果出现" }] },
  });
  const probed = spawnSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", output], { encoding: "utf8" });
  assert.equal(probed.status, 0, probed.stderr);
  const streams = JSON.parse(probed.stdout).streams;
  assert.equal(streams.some(item => item.codec_type === "video" && item.codec_name === "h264"), true);
  assert.equal(streams.some(item => item.codec_type === "audio" && item.codec_name === "aac"), true);
});
