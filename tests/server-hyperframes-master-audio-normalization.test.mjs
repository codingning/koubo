import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-server-hyperframes-master-data-"));
process.env.KOUBO_NO_LISTEN = "1";
process.env.KOUBO_MULTI_AGENT_DATA_ROOT = dataRoot;

const serverModule = await import(`../video/server.mjs?hyperframes-master-audio-test=${Date.now()}`);
const {
  closeServerResourcesForTests,
  integratedHyperframesSafeAreaChecks,
  normalizeHyperframesMaster,
} = serverModule;

test.after(async () => {
  await closeServerResourcesForTests();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || `${command} failed`);
  return result;
}

function probe(file) {
  return JSON.parse(run("ffprobe", [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    file,
  ]).stdout);
}

function loudness(file) {
  const result = run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i", file,
    "-filter_complex", "ebur128=peak=true",
    "-f", "null",
    "-",
  ]);
  const integrated = [...result.stderr.matchAll(/I:\s*(-?[0-9.]+)\s+LUFS/g)].at(-1);
  const peak = [...result.stderr.matchAll(/Peak:\s*(-?[0-9.]+)\s+dBFS/g)].at(-1);
  assert.ok(integrated, "integrated loudness summary is missing");
  assert.ok(peak, "true peak summary is missing");
  return { integratedLufs: Number(integrated[1]), truePeakDbfs: Number(peak[1]) };
}

function videoStreamHash(file) {
  return run("ffmpeg", [
    "-v", "error",
    "-i", file,
    "-map", "0:v:0",
    "-c", "copy",
    "-f", "streamhash",
    "-hash", "sha256",
    "-",
  ]).stdout.trim();
}

test("integrated HyperFrames master uses composition validation instead of transparent-track metadata", () => {
  assert.deepEqual(integratedHyperframesSafeAreaChecks({
    packaging: { engine: "hyperframes", safeArea: true, validatedBy: "hyperframes-check" },
    captionPackaging: { engine: "hyperframes", integrated: true, safeArea: true, validatedBy: "hyperframes-check" },
    dimensions: { width: 1920, height: 1080 },
  }), {
    captionSafeArea: true,
    dynamicCaptionTrack: true,
    cardSafeArea: true,
  });
});

test("HyperFrames master packaging normalizes audio without re-encoding a compatible video stream", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-hyperframes-master-audio-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "input.mp4");
  const output = path.join(root, "output.mp4");
  run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "testsrc2=size=320x180:rate=30:duration=3",
    "-f", "lavfi",
    "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-filter_complex", "[1:a]volume=0.4,pan=stereo|c0=c0|c1=c0[a]",
    "-map", "0:v:0",
    "-map", "[a]",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    input,
  ]);

  const inputVideoHash = videoStreamHash(input);
  await normalizeHyperframesMaster(input, output, 320, 180, 30, {
    loudnessTarget: "-16 LUFS",
    truePeakTarget: "-1.5 dBTP",
  });

  const inspected = probe(output);
  const video = inspected.streams.find(stream => stream.codec_type === "video");
  const audio = inspected.streams.find(stream => stream.codec_type === "audio");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.pix_fmt, "yuv420p");
  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.equal(audio.codec_name, "aac");
  assert.equal(videoStreamHash(output), inputVideoHash);
  const measured = loudness(output);
  assert.ok(Math.abs(measured.integratedLufs + 16) <= 0.6, JSON.stringify(measured));
  assert.ok(measured.truePeakDbfs <= -1.4, JSON.stringify(measured));
});

test("HyperFrames master packaging preserves video-only inputs", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-hyperframes-master-silent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "input.mp4");
  const output = path.join(root, "output.mp4");
  run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "color=c=black:size=320x180:rate=30:duration=1",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    input,
  ]);

  await normalizeHyperframesMaster(input, output, 320, 180, 30);
  const inspected = probe(output);
  assert.equal(inspected.streams.filter(stream => stream.codec_type === "video").length, 1);
  assert.equal(inspected.streams.filter(stream => stream.codec_type === "audio").length, 0);
  run("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
});

test("HyperFrames master packaging re-encodes incompatible video while still normalizing audio", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-hyperframes-master-resize-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "input.mp4");
  const output = path.join(root, "output.mp4");
  run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "testsrc2=size=640x360:rate=24:duration=3",
    "-f", "lavfi",
    "-i", "sine=frequency=660:sample_rate=48000:duration=3",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    input,
  ]);

  const inputVideoHash = videoStreamHash(input);
  await normalizeHyperframesMaster(input, output, 320, 180, 30, {
    loudnessTarget: -16,
    truePeakTarget: -1.5,
  });
  const inspected = probe(output);
  const video = inspected.streams.find(stream => stream.codec_type === "video");
  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.equal(video.r_frame_rate, "30/1");
  assert.notEqual(videoStreamHash(output), inputVideoHash);
  const measured = loudness(output);
  assert.ok(Math.abs(measured.integratedLufs + 16) <= 0.6, JSON.stringify(measured));
  assert.ok(measured.truePeakDbfs <= -1.4, JSON.stringify(measured));
});
