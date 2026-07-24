import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { canonicalJson, contentHash } from "./contracts.mjs";

const SAMPLE_RATE = 48000;
const DURATION_SECONDS = 12;
const TARGET_LUFS = -16;
const NORMALIZATION_TRUE_PEAK_DBTP = -2.5;
const QA_MAX_TRUE_PEAK_DBTP = -1.5;
const QA_LUFS_TOLERANCE = 0.35;
const VIDEO_WIDTH = 540;
const VIDEO_HEIGHT = 960;
const VIDEO_FPS = 30;

const VOICE_ACTIVE_WINDOWS = Object.freeze([
  Object.freeze({ startSeconds: 0.45, endSeconds: 2.35 }),
  Object.freeze({ startSeconds: 2.82, endSeconds: 4.72 }),
  Object.freeze({ startSeconds: 5.18, endSeconds: 7.42 }),
  Object.freeze({ startSeconds: 7.96, endSeconds: 10.82 }),
]);

const CANDIDATE_CENTER_FREQUENCIES_HZ = Object.freeze([
  180, 260, 380, 520, 760, 1100, 1600, 2400,
]);

const DUCKING_PARAMETERS = Object.freeze({
  threshold: 0.06,
  ratio: 4,
  attackMs: 35,
  releaseMs: 280,
  knee: 2.5,
  makeup: 1,
  detection: "rms",
  link: "average",
});

const SPECTRAL_SLOT_PARAMETERS = Object.freeze({
  q: 1.35,
  gainDb: -4.5,
  selectionMethod: "active-window-biquad-band-energy-v1",
});

const CUE_ANCHORS = Object.freeze([
  Object.freeze({
    id: "semantic-turn-1",
    cueId: "cue-chime",
    cueType: "semantic-turn",
    anchorTimeMs: 1280,
    onsetOffsetMs: 0,
    durationMs: 180,
    cueGainDb: -10,
    evidence: "voice-like phrase changes direction",
  }),
  Object.freeze({
    id: "visual-impact-1",
    cueId: "cue-impact",
    cueType: "visual-impact",
    anchorTimeMs: 5580,
    onsetOffsetMs: -40,
    durationMs: 220,
    cueGainDb: -11,
    evidence: "evidence beat lands",
  }),
  Object.freeze({
    id: "transition-cut-1",
    cueId: "cue-swish",
    cueType: "transition-cut",
    anchorTimeMs: 9180,
    onsetOffsetMs: -20,
    durationMs: 280,
    cueGainDb: -12,
    evidence: "section transition begins",
  }),
]);

const GENERATED_SUBDIRECTORIES = Object.freeze([
  "stems",
  "processed",
  "raw",
  "variants",
]);

const GENERATED_JSON_FILES = Object.freeze([
  "audio_request.json",
  "audio_meta.json",
  "asset-ledger.json",
  "recreation-manifest.json",
  "qa.json",
  "subjective-review-template.json",
  "hashes.json",
]);

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function gainFromDb(db) {
  return 10 ** (db / 20);
}

function dbFromAmplitude(value) {
  return value > 0 ? 20 * Math.log10(value) : -Infinity;
}

function relativePath(root, file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function writeCanonicalJson(file, value) {
  await fsp.writeFile(file, canonicalJson(value) + "\n", "utf8");
}

function assertGeneratedChild(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("generated path must stay inside the sound sandbox root");
  }
}

async function prepareOutputDirectory(outputDir) {
  if (!outputDir) throw new Error("outputDir is required");
  const root = path.resolve(outputDir);
  const parsed = path.parse(root);
  if (root === parsed.root || root === process.cwd()) {
    throw new Error("outputDir must be a dedicated child directory");
  }
  await fsp.mkdir(root, { recursive: true });
  for (const directory of GENERATED_SUBDIRECTORIES) {
    const target = path.join(root, directory);
    assertGeneratedChild(root, target);
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.mkdir(target, { recursive: true });
  }
  for (const name of GENERATED_JSON_FILES) {
    const target = path.join(root, name);
    assertGeneratedChild(root, target);
    await fsp.rm(target, { force: true });
  }
  await fsp.mkdir(path.join(root, "stems", "cues"), { recursive: true });
  return root;
}

function windowEnvelope(timeSeconds, startSeconds, endSeconds, edgeSeconds = 0.045) {
  if (timeSeconds < startSeconds || timeSeconds >= endSeconds) return 0;
  const attack = clamp((timeSeconds - startSeconds) / edgeSeconds, 0, 1);
  const release = clamp((endSeconds - timeSeconds) / edgeSeconds, 0, 1);
  return Math.sin(Math.PI * 0.5 * Math.min(attack, release)) ** 2;
}

function voiceActivityEnvelope(timeSeconds) {
  return VOICE_ACTIVE_WINDOWS.reduce(
    (maximum, window) => Math.max(
      maximum,
      windowEnvelope(timeSeconds, window.startSeconds, window.endSeconds)
    ),
    0
  );
}

function generateVoiceLikeSamples() {
  const totalSamples = Math.round(DURATION_SECONDS * SAMPLE_RATE);
  const output = new Float64Array(totalSamples);
  const harmonics = [
    [155, 0.32],
    [310, 0.20],
    [465, 0.17],
    [620, 0.14],
    [775, 0.28],
    [1085, 0.13],
    [1550, 0.09],
  ];
  for (let index = 0; index < totalSamples; index += 1) {
    const time = index / SAMPLE_RATE;
    const activity = voiceActivityEnvelope(time);
    if (activity === 0) continue;
    const syllable = 0.5
      + 0.31 * Math.sin(2 * Math.PI * 3.7 * time + 0.35)
      + 0.13 * Math.sin(2 * Math.PI * 6.1 * time + 1.1);
    const articulation = clamp(syllable, 0.12, 0.94);
    let sample = 0;
    for (const [frequency, amplitude] of harmonics) {
      const phaseMotion = 0.035 * Math.sin(2 * Math.PI * 4.8 * time);
      sample += amplitude * Math.sin(2 * Math.PI * frequency * time + phaseMotion);
    }
    const breath = 0.025
      * Math.sin(2 * Math.PI * 2330 * time + Math.sin(2 * Math.PI * 2.1 * time));
    output[index] = clamp((sample + breath) * activity * articulation * 0.72, -0.82, 0.82);
  }
  return output;
}

function generateBgmSamples() {
  const totalSamples = Math.round(DURATION_SECONDS * SAMPLE_RATE);
  const output = new Float64Array(totalSamples);
  const tones = [
    [110, 0.08],
    [220, 0.09],
    [330, 0.07],
    [520, 0.10],
    [760, 0.24],
    [1100, 0.09],
    [1520, 0.05],
  ];
  for (let index = 0; index < totalSamples; index += 1) {
    const time = index / SAMPLE_RATE;
    const slowPulse = 0.72
      + 0.16 * Math.sin(2 * Math.PI * 0.42 * time)
      + 0.08 * Math.sin(2 * Math.PI * 0.83 * time + 0.8);
    const barFade = Math.min(1, time / 0.18, (DURATION_SECONDS - time) / 0.22);
    let sample = 0;
    for (const [frequency, amplitude] of tones) {
      sample += amplitude * Math.sin(
        2 * Math.PI * frequency * time + 0.06 * Math.sin(2 * Math.PI * 0.19 * time)
      );
    }
    output[index] = clamp(sample * slowPulse * clamp(barFade, 0, 1) * 0.68, -0.64, 0.64);
  }
  return output;
}

function cueEnvelope(index, totalSamples, attackRatio = 0.08, releaseRatio = 0.36) {
  const attackSamples = Math.max(1, Math.round(totalSamples * attackRatio));
  const releaseSamples = Math.max(1, Math.round(totalSamples * releaseRatio));
  const attack = clamp(index / attackSamples, 0, 1);
  const release = clamp((totalSamples - index - 1) / releaseSamples, 0, 1);
  return Math.sin(Math.PI * 0.5 * Math.min(attack, release)) ** 2;
}

function generateCueSamples(cueId, durationMs) {
  const totalSamples = Math.round(durationMs / 1000 * SAMPLE_RATE);
  const output = new Float64Array(totalSamples);
  for (let index = 0; index < totalSamples; index += 1) {
    const time = index / SAMPLE_RATE;
    const envelope = cueEnvelope(index, totalSamples);
    let sample;
    if (cueId === "cue-chime") {
      sample = 0.55 * Math.sin(2 * Math.PI * 880 * time)
        + 0.24 * Math.sin(2 * Math.PI * 1320 * time + 0.2);
    } else if (cueId === "cue-impact") {
      const progress = index / Math.max(1, totalSamples - 1);
      const frequency = 180 - 105 * progress;
      sample = 0.65 * Math.sin(2 * Math.PI * frequency * time)
        + 0.16 * Math.sin(2 * Math.PI * 520 * time) * (1 - progress);
    } else if (cueId === "cue-swish") {
      const progress = index / Math.max(1, totalSamples - 1);
      const frequency = 420 + 1900 * progress * progress;
      sample = 0.42 * Math.sin(2 * Math.PI * frequency * time)
        + 0.15 * Math.sin(2 * Math.PI * (frequency * 1.37) * time + 0.5);
    } else {
      throw new Error("unknown cue id: " + cueId);
    }
    output[index] = clamp(sample * envelope, -0.86, 0.86);
  }
  return output;
}

function pcmStats(samples) {
  let sumSquares = 0;
  let peak = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
  return {
    rmsDbfs: round(dbFromAmplitude(rms)),
    peakDbfs: round(dbFromAmplitude(peak)),
  };
}

function writeMonoPcm16Wav(file, samples) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.round(clamp(samples[index], -1, 1) * 32767);
    buffer.writeInt16LE(sample, 44 + index * 2);
  }
  fs.writeFileSync(file, buffer);
}

function readMonoPcm16Wav(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.toString("ascii", 0, 4) !== "RIFF"
    || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("expected RIFF/WAVE PCM file: " + file);
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) throw new Error("invalid WAV chunk size: " + file);
    if (id === "fmt ") {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = buffer.subarray(start, end);
    }
    offset = end + (size % 2);
  }
  if (!format || !data
    || format.audioFormat !== 1
    || format.channels !== 1
    || format.bitsPerSample !== 16
    || format.sampleRate !== SAMPLE_RATE) {
    throw new Error("expected mono 48 kHz PCM16 WAV: " + file);
  }
  const samples = new Float64Array(data.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = data.readInt16LE(index * 2) / 32768;
  }
  return samples;
}

function sampleIsInsideWindows(index, windows = VOICE_ACTIVE_WINDOWS) {
  const time = index / SAMPLE_RATE;
  return windows.some(window => time >= window.startSeconds && time < window.endSeconds);
}

function rmsDbfsInWindows(samples, windows = VOICE_ACTIVE_WINDOWS) {
  let sumSquares = 0;
  let count = 0;
  for (let index = 0; index < samples.length; index += 1) {
    if (!sampleIsInsideWindows(index, windows)) continue;
    sumSquares += samples[index] * samples[index];
    count += 1;
  }
  return dbFromAmplitude(Math.sqrt(sumSquares / Math.max(1, count)));
}

function bandpassRmsDbfs(samples, centerHz, q = 2.2) {
  const omega = 2 * Math.PI * centerHz / SAMPLE_RATE;
  const alpha = Math.sin(omega) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b1 = 0;
  const b2 = -alpha / a0;
  const a1 = -2 * Math.cos(omega) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let sumSquares = 0;
  let count = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const x0 = samples[index];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    if (!sampleIsInsideWindows(index)) continue;
    sumSquares += y0 * y0;
    count += 1;
  }
  return dbFromAmplitude(Math.sqrt(sumSquares / Math.max(1, count)));
}

export function analyzeSoundOverlap(voiceSamples, bgmSamples) {
  const voiceFullbandDbfs = rmsDbfsInWindows(voiceSamples);
  const bgmFullbandDbfs = rmsDbfsInWindows(bgmSamples);
  const bands = CANDIDATE_CENTER_FREQUENCIES_HZ.map(centerHz => {
    const voiceBandDbfs = bandpassRmsDbfs(voiceSamples, centerHz);
    const bgmBandDbfs = bandpassRmsDbfs(bgmSamples, centerHz);
    const voiceRelativeDb = voiceBandDbfs - voiceFullbandDbfs;
    const bgmRelativeDb = bgmBandDbfs - bgmFullbandDbfs;
    return {
      centerHz,
      voiceBandDbfs: round(voiceBandDbfs),
      bgmBandDbfs: round(bgmBandDbfs),
      voiceRelativeDb: round(voiceRelativeDb),
      bgmRelativeDb: round(bgmRelativeDb),
      overlapScoreDb: round(voiceRelativeDb + bgmRelativeDb),
    };
  });
  const selected = [...bands].sort(
    (left, right) => right.overlapScoreDb - left.overlapScoreDb
      || left.centerHz - right.centerHz
  )[0];
  return {
    method: SPECTRAL_SLOT_PARAMETERS.selectionMethod,
    voiceActiveWindows: VOICE_ACTIVE_WINDOWS,
    candidateCentersHz: CANDIDATE_CENTER_FREQUENCIES_HZ,
    voiceFullbandDbfs: round(voiceFullbandDbfs),
    bgmFullbandDbfs: round(bgmFullbandDbfs),
    bands,
    measuredCenterHz: selected.centerHz,
    selectedOverlapScoreDb: selected.overlapScoreDb,
  };
}

export function evaluateAbcSourceIdentity(variants) {
  const expectedIds = ["A", "B", "C"];
  const items = expectedIds.map(id => variants.find(item => item.id === id)).filter(Boolean);
  const uniqueIds = new Set(items.map(item => item.id));
  const complete = items.length === expectedIds.length && uniqueIds.size === expectedIds.length;
  const validSha256 = value => /^[a-f0-9]{64}$/u.test(String(value || ""));
  const first = items[0] || {};
  const sameVoiceStem = complete
    && validSha256(first.sourceVoiceSha256)
    && items.every(item => item.sourceVoiceSha256 === first.sourceVoiceSha256);
  const sameBgmStem = complete
    && validSha256(first.sourceBgmSha256)
    && items.every(item => item.sourceBgmSha256 === first.sourceBgmSha256);
  const sameTimelineHash = complete
    && validSha256(first.timelineHash)
    && items.every(item => item.timelineHash === first.timelineHash);
  const timingIsValid = item => {
    const wav = item.mediaTiming?.wav;
    const mp4 = item.mediaTiming?.mp4;
    return Number.isFinite(item.durationSeconds)
      && item.zeroOffsetSeconds === 0
      && Number.isFinite(wav?.startTimeSeconds)
      && Number.isFinite(wav?.durationSeconds)
      && Number.isFinite(mp4?.startTimeSeconds)
      && Number.isFinite(mp4?.durationSeconds)
      && Math.abs(wav.startTimeSeconds) <= 0.001
      && Math.abs(mp4.startTimeSeconds) <= 0.001
      && Math.abs(wav.durationSeconds - item.durationSeconds) <= 0.03
      && Math.abs(mp4.durationSeconds - item.durationSeconds) <= 0.08;
  };
  const timeAligned = sameTimelineHash
    && complete
    && items.every(timingIsValid)
    && items.every(item =>
      Math.abs(item.mediaTiming.wav.durationSeconds - first.mediaTiming.wav.durationSeconds) <= 0.03
      && Math.abs(item.mediaTiming.mp4.durationSeconds - first.mediaTiming.mp4.durationSeconds) <= 0.08
    );
  const sameSourceHashes = sameVoiceStem && sameBgmStem;
  return {
    complete,
    sameVoiceStem,
    sameBgmStem,
    sameTimelineHash,
    sameSourceHashes,
    timeAligned,
    pass: complete && sameSourceHashes && timeAligned,
    sourceVoiceSha256: sameVoiceStem ? first.sourceVoiceSha256 : null,
    sourceBgmSha256: sameBgmStem ? first.sourceBgmSha256 : null,
    timelineHash: sameTimelineHash ? first.timelineHash : null,
    perVariant: Object.fromEntries(items.map(item => [item.id, {
      sourceVoiceSha256: item.sourceVoiceSha256,
      sourceBgmSha256: item.sourceBgmSha256,
      timelineHash: item.timelineHash,
      durationSeconds: item.durationSeconds,
      zeroOffsetSeconds: item.zeroOffsetSeconds,
      mediaTiming: item.mediaTiming,
    }])),
  };
}

function mixCueTrack(cueSources) {
  const output = new Float64Array(Math.round(DURATION_SECONDS * SAMPLE_RATE));
  for (const anchor of CUE_ANCHORS) {
    const source = cueSources.get(anchor.cueId);
    const onsetMs = anchor.anchorTimeMs + anchor.onsetOffsetMs;
    const startSample = Math.round(onsetMs / 1000 * SAMPLE_RATE);
    const gain = gainFromDb(anchor.cueGainDb);
    for (let index = 0; index < source.length; index += 1) {
      const targetIndex = startSample + index;
      if (targetIndex < 0 || targetIndex >= output.length) continue;
      output[targetIndex] = clamp(output[targetIndex] + source[index] * gain, -0.92, 0.92);
    }
  }
  return output;
}

export async function buildSoundSandboxStems({ outputDir } = {}) {
  if (!outputDir) throw new Error("outputDir is required");
  const root = path.resolve(outputDir);
  const stemsDir = path.join(root, "stems");
  const cuesDir = path.join(stemsDir, "cues");
  await fsp.mkdir(cuesDir, { recursive: true });

  const voiceSamples = generateVoiceLikeSamples();
  const bgmSamples = generateBgmSamples();
  const voiceFile = path.join(stemsDir, "voice-like.wav");
  const bgmFile = path.join(stemsDir, "bgm.wav");
  writeMonoPcm16Wav(voiceFile, voiceSamples);
  writeMonoPcm16Wav(bgmFile, bgmSamples);

  const cueSources = new Map();
  const cueFiles = [];
  for (const anchor of CUE_ANCHORS) {
    if (cueSources.has(anchor.cueId)) continue;
    const samples = generateCueSamples(anchor.cueId, anchor.durationMs);
    cueSources.set(anchor.cueId, samples);
    const file = path.join(cuesDir, anchor.cueId + ".wav");
    writeMonoPcm16Wav(file, samples);
    cueFiles.push({
      id: anchor.cueId,
      file,
      durationMs: anchor.durationMs,
      stats: pcmStats(samples),
    });
  }
  const cueTrackSamples = mixCueTrack(cueSources);
  const cueTrackFile = path.join(stemsDir, "semantic-cues.wav");
  writeMonoPcm16Wav(cueTrackFile, cueTrackSamples);

  const analysis = analyzeSoundOverlap(voiceSamples, bgmSamples);
  const timelineHash = contentHash({
    durationSeconds: DURATION_SECONDS,
    sampleRate: SAMPLE_RATE,
    voiceActiveWindows: VOICE_ACTIVE_WINDOWS,
    zeroOffsetSeconds: 0,
  });
  return {
    root,
    durationSeconds: DURATION_SECONDS,
    sampleRate: SAMPLE_RATE,
    timelineHash,
    voice: {
      id: "voice-like",
      file: voiceFile,
      sha256: sha256File(voiceFile),
      stats: pcmStats(voiceSamples),
    },
    bgm: {
      id: "bgm",
      file: bgmFile,
      sha256: sha256File(bgmFile),
      stats: pcmStats(bgmSamples),
    },
    cues: cueFiles.map(item => ({
      ...item,
      sha256: sha256File(item.file),
    })),
    cueTrack: {
      id: "semantic-cues",
      file: cueTrackFile,
      sha256: sha256File(cueTrackFile),
      stats: pcmStats(cueTrackSamples),
    },
    analysis,
  };
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

async function runChecked(command, args, cwd) {
  const result = await run(command, args, cwd);
  if (result.code !== 0) {
    const detail = String(result.stderr || result.stdout).replace(/\s+/gu, " ").trim().slice(-1600);
    throw new Error(command + " exited with " + result.code + (detail ? ": " + detail : ""));
  }
  return result;
}

function parseLoudnormJson(stderr) {
  const matches = [...String(stderr).matchAll(/\{\s*"input_i"[\s\S]*?"target_offset"\s*:\s*"[^"]+"\s*\}/gu)];
  if (!matches.length) throw new Error("FFmpeg loudnorm JSON was not produced");
  const value = JSON.parse(matches.at(-1)[0]);
  const numeric = key => {
    const parsed = Number(value[key]);
    if (!Number.isFinite(parsed)) throw new Error("invalid loudnorm field: " + key);
    return parsed;
  };
  return {
    integratedLufs: numeric("input_i"),
    truePeakDbtp: numeric("input_tp"),
    lraLu: numeric("input_lra"),
    thresholdLufs: numeric("input_thresh"),
    targetOffset: numeric("target_offset"),
  };
}

async function measureLoudness(file, cwd) {
  const result = await runChecked("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i", file,
    "-vn",
    "-af", "loudnorm=I=" + TARGET_LUFS
      + ":TP=" + NORMALIZATION_TRUE_PEAK_DBTP
      + ":LRA=7:print_format=json",
    "-f", "null",
    "-",
  ], cwd);
  const metrics = parseLoudnormJson(result.stderr);
  return {
    integratedLufs: round(metrics.integratedLufs, 2),
    truePeakDbtp: round(metrics.truePeakDbtp, 2),
    lraLu: round(metrics.lraLu, 2),
    thresholdLufs: round(metrics.thresholdLufs, 2),
    targetOffset: round(metrics.targetOffset, 2),
  };
}

async function normalizeAudio(inputFile, outputFile, cwd) {
  const measured = await measureLoudness(inputFile, cwd);
  const filter = "loudnorm=I=" + TARGET_LUFS
    + ":TP=" + NORMALIZATION_TRUE_PEAK_DBTP
    + ":LRA=7"
    + ":measured_I=" + measured.integratedLufs
    + ":measured_LRA=" + measured.lraLu
    + ":measured_TP=" + measured.truePeakDbtp
    + ":measured_thresh=" + measured.thresholdLufs
    + ":offset=" + measured.targetOffset
    + ":linear=true:print_format=summary";
  await runChecked("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", inputFile,
    "-af", filter,
    "-ar", String(SAMPLE_RATE),
    "-ac", "1",
    "-c:a", "pcm_s16le",
    "-map_metadata", "-1",
    "-fflags", "+bitexact",
    "-flags:a", "+bitexact",
    outputFile,
  ], cwd);
  return measured;
}

function audioFormatFilter(label) {
  return label + "aformat=sample_fmts=fltp:sample_rates="
    + SAMPLE_RATE + ":channel_layouts=mono,"
    + "asetnsamples=n=1024:p=1,atrim=duration=" + DURATION_SECONDS
    + ",asetpts=N/SR/TB";
}

async function renderProcessedMusic(stems, outputDir) {
  const processedDir = path.join(outputDir, "processed");
  const aFile = path.join(processedDir, "bgm-a-no-duck.wav");
  const bFile = path.join(processedDir, "bgm-b-fullband-duck.wav");
  const cFile = path.join(processedDir, "bgm-c-duck-spectral-slot.wav");
  await fsp.copyFile(stems.bgm.file, aFile);

  const commonDuck = "sidechaincompress=threshold=" + DUCKING_PARAMETERS.threshold
    + ":ratio=" + DUCKING_PARAMETERS.ratio
    + ":attack=" + DUCKING_PARAMETERS.attackMs
    + ":release=" + DUCKING_PARAMETERS.releaseMs
    + ":makeup=" + DUCKING_PARAMETERS.makeup
    + ":knee=" + DUCKING_PARAMETERS.knee
    + ":link=" + DUCKING_PARAMETERS.link
    + ":detection=" + DUCKING_PARAMETERS.detection;

  const baseFilter = audioFormatFilter("[0:a]")
    + "[voice];"
    + audioFormatFilter("[1:a]")
    + "[music];[music][voice]"
    + commonDuck
    + ",apad=pad_dur=" + DURATION_SECONDS
    + ",atrim=duration=" + DURATION_SECONDS
    + ",asetpts=N/SR/TB[ducked]";
  await runChecked("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", stems.voice.file,
    "-i", stems.bgm.file,
    "-filter_complex", baseFilter,
    "-map", "[ducked]",
    "-t", String(DURATION_SECONDS),
    "-ar", String(SAMPLE_RATE),
    "-ac", "1",
    "-c:a", "pcm_s16le",
    "-map_metadata", "-1",
    "-fflags", "+bitexact",
    "-flags:a", "+bitexact",
    bFile,
  ], outputDir);

  const spectralFilter = baseFilter
    + ";[ducked]equalizer=f=" + stems.analysis.measuredCenterHz
    + ":t=q:w=" + SPECTRAL_SLOT_PARAMETERS.q
    + ":g=" + SPECTRAL_SLOT_PARAMETERS.gainDb
    + ":precision=f64[slotted]";
  await runChecked("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", stems.voice.file,
    "-i", stems.bgm.file,
    "-filter_complex", spectralFilter,
    "-map", "[slotted]",
    "-t", String(DURATION_SECONDS),
    "-ar", String(SAMPLE_RATE),
    "-ac", "1",
    "-c:a", "pcm_s16le",
    "-map_metadata", "-1",
    "-fflags", "+bitexact",
    "-flags:a", "+bitexact",
    cFile,
  ], outputDir);

  const originalSamples = readMonoPcm16Wav(aFile);
  const bSamples = readMonoPcm16Wav(bFile);
  const cSamples = readMonoPcm16Wav(cFile);
  const originalActiveDbfs = rmsDbfsInWindows(originalSamples);
  const bActiveDbfs = rmsDbfsInWindows(bSamples);
  const cActiveDbfs = rmsDbfsInWindows(cSamples);
  const bBandDbfs = bandpassRmsDbfs(bSamples, stems.analysis.measuredCenterHz);
  const cBandDbfs = bandpassRmsDbfs(cSamples, stems.analysis.measuredCenterHz);

  return {
    A: {
      file: aFile,
      sha256: sha256File(aFile),
      activeWindowRmsDbfs: round(originalActiveDbfs),
      estimatedReductionDb: 0,
    },
    B: {
      file: bFile,
      sha256: sha256File(bFile),
      activeWindowRmsDbfs: round(bActiveDbfs),
      estimatedReductionDb: round(originalActiveDbfs - bActiveDbfs),
      measuredCenterBandDbfs: round(bBandDbfs),
    },
    C: {
      file: cFile,
      sha256: sha256File(cFile),
      activeWindowRmsDbfs: round(cActiveDbfs),
      estimatedReductionDb: round(originalActiveDbfs - cActiveDbfs),
      measuredCenterBandDbfs: round(cBandDbfs),
      spectralSlotReductionDb: round(bBandDbfs - cBandDbfs),
    },
  };
}

async function renderRawMix(voiceFile, musicFile, cueTrackFile, outputFile, cwd) {
  const filters = [
    audioFormatFilter("[0:a]") + "[voice]",
    audioFormatFilter("[1:a]") + "[music]",
    "[voice][music]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[base]",
  ];
  let outputLabel = "[base]";
  if (cueTrackFile) {
    filters.push(audioFormatFilter("[2:a]") + "[cues]");
    filters.push("[base][cues]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[mix]");
    outputLabel = "[mix]";
  }
  const inputs = ["-i", voiceFile, "-i", musicFile];
  if (cueTrackFile) inputs.push("-i", cueTrackFile);
  await runChecked("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", outputLabel,
    "-t", String(DURATION_SECONDS),
    "-ar", String(SAMPLE_RATE),
    "-ac", "1",
    "-c:a", "pcm_s16le",
    "-map_metadata", "-1",
    "-fflags", "+bitexact",
    "-flags:a", "+bitexact",
    outputFile,
  ], cwd);
}

async function renderWaveformVideo(audioFile, outputFile, color, cwd) {
  const filter = "[0:a]asplit=2[audio][waveaudio];"
    + "[waveaudio]showwaves=s=" + VIDEO_WIDTH + "x360"
    + ":mode=line:colors=0x55D6FFFF:r=" + VIDEO_FPS
    + ",format=rgba[wave];"
    + "color=c=" + color + ":s=" + VIDEO_WIDTH + "x" + VIDEO_HEIGHT
    + ":r=" + VIDEO_FPS + ":d=" + DURATION_SECONDS + "[background];"
    + "[background][wave]overlay=(W-w)/2:(H-h)/2:shortest=1,"
    + "format=yuv420p,setparams=range=tv:color_primaries=bt709:"
    + "color_trc=bt709:colorspace=bt709[video]";
  await runChecked("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", audioFile,
    "-filter_complex", filter,
    "-map", "[video]",
    "-map", "[audio]",
    "-t", String(DURATION_SECONDS),
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "30",
    "-pix_fmt", "yuv420p",
    "-r", String(VIDEO_FPS),
    "-g", String(VIDEO_FPS),
    "-keyint_min", String(VIDEO_FPS),
    "-sc_threshold", "0",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-colorspace", "bt709",
    "-color_range", "tv",
    "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
    "-c:a", "aac",
    "-b:a", "160k",
    "-ar", String(SAMPLE_RATE),
    "-ac", "1",
    "-movflags", "+faststart",
    "-map_metadata", "-1",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-flags:a", "+bitexact",
    outputFile,
  ], cwd);
}

async function decodeMedia(file, cwd) {
  const result = await run("ffmpeg", [
    "-v", "error",
    "-i", file,
    "-f", "null",
    "-",
  ], cwd);
  return {
    ok: result.code === 0,
    error: result.code === 0
      ? null
      : String(result.stderr || result.stdout).replace(/\s+/gu, " ").trim().slice(-500),
  };
}

async function probeMedia(file, cwd) {
  const result = await runChecked("ffprobe", [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    file,
  ], cwd);
  const data = JSON.parse(result.stdout);
  const video = data.streams.find(stream => stream.codec_type === "video");
  const audio = data.streams.find(stream => stream.codec_type === "audio");
  return {
    startTimeSeconds: round(Number(
      video?.start_time
      ?? audio?.start_time
      ?? data.format?.start_time
      ?? 0
    ), 3),
    durationSeconds: round(Number(data.format?.duration), 3),
    sizeBytes: Number(data.format?.size || fs.statSync(file).size),
    video: video ? {
      codec: video.codec_name,
      width: Number(video.width),
      height: Number(video.height),
      pixelFormat: video.pix_fmt,
      frameRate: video.avg_frame_rate,
      colorPrimaries: video.color_primaries || null,
      colorTransfer: video.color_transfer || null,
      colorSpace: video.color_space || null,
    } : null,
    audio: audio ? {
      codec: audio.codec_name,
      sampleRate: Number(audio.sample_rate),
      channels: Number(audio.channels),
    } : null,
  };
}

function validateCueContract() {
  const intervals = CUE_ANCHORS.map(anchor => ({
    ...anchor,
    onsetTimeMs: anchor.anchorTimeMs + anchor.onsetOffsetMs,
    endTimeMs: anchor.anchorTimeMs + anchor.onsetOffsetMs + anchor.durationMs,
  })).sort((left, right) => left.onsetTimeMs - right.onsetTimeMs);
  let maximumConcurrent = 0;
  for (const candidate of intervals) {
    const concurrent = intervals.filter(item =>
      item.onsetTimeMs < candidate.endTimeMs && item.endTimeMs > candidate.onsetTimeMs
    ).length;
    maximumConcurrent = Math.max(maximumConcurrent, concurrent);
  }
  const spacings = intervals.slice(1).map((item, index) =>
    item.onsetTimeMs - intervals[index].endTimeMs
  );
  return {
    anchors: intervals,
    minimumSpacingMs: Math.min(...spacings),
    maximumConcurrentCues: maximumConcurrent,
    maximumDurationMs: Math.max(...intervals.map(item => item.durationMs)),
    gates: {
      maximumConcurrentCues: 1,
      minimumSpacingMs: 1200,
      maximumDurationMs: 350,
      finalTruePeakDbtp: QA_MAX_TRUE_PEAK_DBTP,
      mustAddNewMeaning: true,
    },
  };
}

async function inspectVariant(wavFile, mp4File, cwd) {
  const [wavDecode, mp4Decode, wavProbe, mp4Probe, wavLoudness, mp4Loudness] = await Promise.all([
    decodeMedia(wavFile, cwd),
    decodeMedia(mp4File, cwd),
    probeMedia(wavFile, cwd),
    probeMedia(mp4File, cwd),
    measureLoudness(wavFile, cwd),
    measureLoudness(mp4File, cwd),
  ]);
  const checks = {
    wavDecode: wavDecode.ok,
    mp4Decode: mp4Decode.ok,
    wavLoudness: Math.abs(wavLoudness.integratedLufs - TARGET_LUFS) <= QA_LUFS_TOLERANCE,
    mp4Loudness: Math.abs(mp4Loudness.integratedLufs - TARGET_LUFS) <= 0.45,
    wavTruePeak: wavLoudness.truePeakDbtp <= QA_MAX_TRUE_PEAK_DBTP,
    mp4TruePeak: mp4Loudness.truePeakDbtp <= QA_MAX_TRUE_PEAK_DBTP,
    duration: Math.abs(wavProbe.durationSeconds - DURATION_SECONDS) <= 0.03
      && Math.abs(mp4Probe.durationSeconds - DURATION_SECONDS) <= 0.08,
    encoding: mp4Probe.video?.codec === "h264"
      && mp4Probe.video?.width === VIDEO_WIDTH
      && mp4Probe.video?.height === VIDEO_HEIGHT
      && mp4Probe.video?.pixelFormat === "yuv420p"
      && mp4Probe.audio?.codec === "aac"
      && mp4Probe.audio?.sampleRate === SAMPLE_RATE,
    color: mp4Probe.video?.colorPrimaries === "bt709"
      && mp4Probe.video?.colorTransfer === "bt709"
      && mp4Probe.video?.colorSpace === "bt709",
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    wav: {
      path: null,
      sha256: sha256File(wavFile),
      decode: wavDecode,
      probe: wavProbe,
      loudness: wavLoudness,
    },
    mp4: {
      path: null,
      sha256: sha256File(mp4File),
      decode: mp4Decode,
      probe: mp4Probe,
      loudness: mp4Loudness,
    },
  };
}

async function listFilesRecursively(root, directory = root) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursively(root, target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

async function writeHashes(root) {
  const outputFile = path.join(root, "hashes.json");
  const files = (await listFilesRecursively(root))
    .filter(file => path.resolve(file) !== path.resolve(outputFile))
    .sort((left, right) => relativePath(root, left).localeCompare(relativePath(root, right)));
  const value = {
    schemaVersion: 1,
    hashAlgorithm: "sha256",
    excludes: ["hashes.json"],
    files: files.map(file => ({
      path: relativePath(root, file),
      bytes: fs.statSync(file).size,
      sha256: sha256File(file),
    })),
  };
  await writeCanonicalJson(outputFile, value);
  return outputFile;
}

function assetRecord(root, {
  id,
  kind,
  file,
  durationSeconds,
  stats,
}) {
  return {
    id,
    kind,
    path: relativePath(root, file),
    sha256: sha256File(file),
    bytes: fs.statSync(file).size,
    durationSeconds: round(durationSeconds, 3),
    sampleRate: SAMPLE_RATE,
    channels: 1,
    source: "programmatic-local",
    rightsBasis: "programmatic-original-no-third-party-input",
    usageBoundary: "local-agent-training-sandbox-until-human-approval",
    commercialUse: true,
    derivativeUse: true,
    attributionRequired: false,
    stats,
  };
}

export async function buildSoundSandbox({ outputDir } = {}) {
  const root = await prepareOutputDirectory(outputDir);
  const stems = await buildSoundSandboxStems({ outputDir: root });
  const processed = await renderProcessedMusic(stems, root);
  const rawDir = path.join(root, "raw");
  const variantsDir = path.join(root, "variants");

  const definitions = [
    {
      id: "A",
      slug: "A-no-duck",
      technique: "mix-gain-guardrail-control",
      music: processed.A.file,
      cueTrack: null,
      color: "0x081722",
      processing: { ducking: false, spectralSlot: false, semanticCues: false },
    },
    {
      id: "B",
      slug: "B-fullband-duck",
      technique: "speech-aware-ducking",
      music: processed.B.file,
      cueTrack: null,
      color: "0x10233A",
      processing: { ducking: true, spectralSlot: false, semanticCues: false },
    },
    {
      id: "C",
      slug: "C-duck-spectral-slot",
      technique: "speech-aware-ducking",
      music: processed.C.file,
      cueTrack: null,
      color: "0x15322F",
      processing: { ducking: true, spectralSlot: true, semanticCues: false },
    },
    {
      id: "S",
      slug: "semantic-sfx-cue",
      technique: "semantic-sfx-cue",
      music: processed.C.file,
      cueTrack: stems.cueTrack.file,
      color: "0x30243D",
      processing: { ducking: true, spectralSlot: true, semanticCues: true },
    },
  ];

  const rendered = [];
  for (const definition of definitions) {
    const rawFile = path.join(rawDir, definition.slug + "-raw.wav");
    const wavFile = path.join(variantsDir, definition.slug + ".wav");
    const mp4File = path.join(variantsDir, definition.slug + ".mp4");
    await renderRawMix(
      stems.voice.file,
      definition.music,
      definition.cueTrack,
      rawFile,
      root
    );
    const preNormalization = await normalizeAudio(rawFile, wavFile, root);
    await renderWaveformVideo(wavFile, mp4File, definition.color, root);
    const inspection = await inspectVariant(wavFile, mp4File, root);
    inspection.wav.path = relativePath(root, wavFile);
    inspection.mp4.path = relativePath(root, mp4File);
    rendered.push({
      ...definition,
      rawFile,
      wavFile,
      mp4File,
      preNormalization,
      inspection,
    });
  }

  const cueContract = validateCueContract();
  const abc = rendered.filter(item => ["A", "B", "C"].includes(item.id));
  const abcWavLoudness = abc.map(item => item.inspection.wav.loudness.integratedLufs);
  const abcMp4Loudness = abc.map(item => item.inspection.mp4.loudness.integratedLufs);
  const maximumWavLoudnessDeltaLu = Math.max(...abcWavLoudness) - Math.min(...abcWavLoudness);
  const maximumMp4LoudnessDeltaLu = Math.max(...abcMp4Loudness) - Math.min(...abcMp4Loudness);
  const sourceIdentity = {
    voiceSha256: stems.voice.sha256,
    bgmSha256: stems.bgm.sha256,
    timelineHash: stems.timelineHash,
    durationSeconds: DURATION_SECONDS,
    zeroOffsetSeconds: 0,
  };
  const processedForQa = Object.fromEntries(Object.entries(processed).map(([key, value]) => [
    key,
    {
      ...value,
      file: relativePath(root, value.file),
    },
  ]));

  const sourceAssets = [
    assetRecord(root, {
      id: stems.voice.id,
      kind: "voice",
      file: stems.voice.file,
      durationSeconds: DURATION_SECONDS,
      stats: stems.voice.stats,
    }),
    assetRecord(root, {
      id: stems.bgm.id,
      kind: "bgm",
      file: stems.bgm.file,
      durationSeconds: DURATION_SECONDS,
      stats: stems.bgm.stats,
    }),
    ...stems.cues.map(cue => assetRecord(root, {
      id: cue.id,
      kind: "sfx",
      file: cue.file,
      durationSeconds: cue.durationMs / 1000,
      stats: cue.stats,
    })),
    assetRecord(root, {
      id: stems.cueTrack.id,
      kind: "sfx-track",
      file: stems.cueTrack.file,
      durationSeconds: DURATION_SECONDS,
      stats: stems.cueTrack.stats,
    }),
  ];

  const audioRequest = {
    schemaVersion: 1,
    requestId: "sound-training-batch-1-local-recreation",
    purpose: "Compare gain guardrail, speech-aware ducking, measured spectral slotting, and semantic SFX cues.",
    requestedAssets: [
      { id: "voice-like", kind: "voice", generation: "programmatic-local" },
      { id: "bgm", kind: "bgm", generation: "programmatic-local" },
      { id: "semantic-cues", kind: "sfx", generation: "programmatic-local" },
    ],
    outputSpec: {
      sampleRate: SAMPLE_RATE,
      channels: 1,
      durationSeconds: DURATION_SECONDS,
      targetIntegratedLufs: TARGET_LUFS,
      maximumTruePeakDbtp: QA_MAX_TRUE_PEAK_DBTP,
    },
    restrictions: {
      offlineOnly: true,
      externalTutorialMedia: false,
      externalAssets: false,
      productionUseAuthorized: false,
      publishingAuthorized: false,
      memoryPromotionAuthorized: false,
    },
  };

  const audioMeta = {
    schemaVersion: 1,
    generator: {
      id: "koubo-sound-sandbox",
      version: "sound-sandbox-v1",
      deterministic: true,
      sourcePolicy: "programmatic-local-only",
    },
    assets: sourceAssets,
  };

  const assetLedger = {
    schemaVersion: 1,
    ledgerId: "sound-training-batch-1-assets",
    sourcePolicy: "programmatic-local-only",
    assets: sourceAssets,
    externalAssetCount: 0,
    tutorialMediaCopied: false,
  };

  const variantManifest = rendered.map(item => ({
    id: item.id,
    slug: item.slug,
    technique: item.technique,
    status: item.inspection.passed ? "recreated" : "qa-failed",
    sourceVoiceSha256: stems.voice.sha256,
    sourceBgmSha256: stems.bgm.sha256,
    timelineHash: stems.timelineHash,
    durationSeconds: DURATION_SECONDS,
    zeroOffsetSeconds: 0,
    mediaTiming: {
      wav: {
        startTimeSeconds: item.inspection.wav.probe.startTimeSeconds,
        durationSeconds: item.inspection.wav.probe.durationSeconds,
      },
      mp4: {
        startTimeSeconds: item.inspection.mp4.probe.startTimeSeconds,
        durationSeconds: item.inspection.mp4.probe.durationSeconds,
      },
    },
    sourceIdentity,
    processing: item.processing,
    processedMusicSha256: sha256File(item.music),
    cueTrackSha256: item.cueTrack ? sha256File(item.cueTrack) : null,
    wav: {
      path: item.inspection.wav.path,
      sha256: item.inspection.wav.sha256,
      integratedLufs: item.inspection.wav.loudness.integratedLufs,
      truePeakDbtp: item.inspection.wav.loudness.truePeakDbtp,
    },
    mp4: {
      path: item.inspection.mp4.path,
      sha256: item.inspection.mp4.sha256,
      integratedLufs: item.inspection.mp4.loudness.integratedLufs,
      truePeakDbtp: item.inspection.mp4.loudness.truePeakDbtp,
    },
  }));
  const abcIdentity = evaluateAbcSourceIdentity(variantManifest);
  const abcLoudnessMatched = maximumWavLoudnessDeltaLu <= QA_LUFS_TOLERANCE
    && maximumMp4LoudnessDeltaLu <= 0.45;

  const qa = {
    schemaVersion: 1,
    qaVersion: "sound-sandbox-qa-v1",
    thresholds: {
      targetIntegratedLufs: TARGET_LUFS,
      loudnessToleranceLu: QA_LUFS_TOLERANCE,
      maximumTruePeakDbtp: QA_MAX_TRUE_PEAK_DBTP,
      minimumDuckReductionDb: 2,
      minimumSpectralSlotReductionDb: 2.5,
    },
    variants: Object.fromEntries(rendered.map(item => [item.id, item.inspection])),
    abcComparison: {
      ...abcIdentity,
      loudnessMatched: abcLoudnessMatched,
      maximumWavLoudnessDeltaLu: round(maximumWavLoudnessDeltaLu, 2),
      maximumMp4LoudnessDeltaLu: round(maximumMp4LoudnessDeltaLu, 2),
      pass: abcIdentity.pass && abcLoudnessMatched,
    },
    ducking: {
      parameters: DUCKING_PARAMETERS,
      B: processedForQa.B,
      C: processedForQa.C,
      pass: processed.B.estimatedReductionDb >= 2
        && processed.C.estimatedReductionDb >= 2,
      reductionMeasurement: "active-window-rms-difference-estimate",
    },
    spectralSlot: {
      measuredCenterHz: stems.analysis.measuredCenterHz,
      analysis: stems.analysis,
      parameters: SPECTRAL_SLOT_PARAMETERS,
      reductionDb: processed.C.spectralSlotReductionDb,
      pass: CANDIDATE_CENTER_FREQUENCIES_HZ.includes(stems.analysis.measuredCenterHz)
        && processed.C.spectralSlotReductionDb >= 2.5,
    },
    semanticCues: {
      ...cueContract,
      pass: cueContract.maximumConcurrentCues <= cueContract.gates.maximumConcurrentCues
        && cueContract.minimumSpacingMs >= cueContract.gates.minimumSpacingMs
        && cueContract.maximumDurationMs <= cueContract.gates.maximumDurationMs
        && rendered.find(item => item.id === "S").inspection.wav.loudness.truePeakDbtp
          <= QA_MAX_TRUE_PEAK_DBTP
        && rendered.find(item => item.id === "S").inspection.mp4.loudness.truePeakDbtp
          <= QA_MAX_TRUE_PEAK_DBTP,
    },
  };
  qa.technicalPass = rendered.every(item => item.inspection.passed)
    && qa.abcComparison.pass
    && qa.ducking.pass
    && qa.spectralSlot.pass
    && qa.semanticCues.pass;

  const recreationManifest = {
    schemaVersion: 1,
    sandboxVersion: "sound-sandbox-v1",
    batchId: "sound-training-batch-1",
    status: qa.technicalPass ? "recreated" : "recreation-qa-failed",
    knowledgeBoundary: "candidate-recreation-only",
    sourceResearch: "docs/research/2026-07-24-sound-training-batch-1.md",
    sourcePolicy: "programmatic-local-only",
    tutorialMediaCopied: false,
    networkPolicy: "offline-local-assets-only",
    durationSeconds: DURATION_SECONDS,
    sampleRate: SAMPLE_RATE,
    measuredOverlap: stems.analysis,
    ducking: {
      parameters: DUCKING_PARAMETERS,
      estimatedReductionDb: {
        B: processed.B.estimatedReductionDb,
        C: processed.C.estimatedReductionDb,
      },
    },
    spectralSlot: {
      measuredCenterHz: stems.analysis.measuredCenterHz,
      parameters: SPECTRAL_SLOT_PARAMETERS,
      measuredReductionDb: processed.C.spectralSlotReductionDb,
    },
    semanticCueContract: cueContract,
    variants: variantManifest,
    authority: {
      changesProductionDefaults: false,
      mutatesConfiguration: false,
      invokesMemoryTransition: false,
      promotesKnowledge: false,
      approvesProduction: false,
      publishes: false,
    },
    technicalPass: qa.technicalPass,
  };

  const subjectiveReviewTemplate = {
    schemaVersion: 1,
    reviewId: "sound-training-batch-1-subjective-review",
    reviewStatus: "pending-human-review",
    candidates: variantManifest.map(item => ({
      label: item.id,
      mediaFile: item.mp4.path,
      renderHash: item.mp4.sha256,
    })),
    decisionOptions: ["A", "B", "C", "S", "reject-all"],
    rejectAllAllowed: true,
    requiredFields: ["decision", "atLeastOneConcreteReason"],
    reviewQuestions: [
      "人声是否始终清楚且不被音乐或音效遮蔽？",
      "避让是否自然，是否能听出抽吸或突兀跳变？",
      "频谱让位是否增加清晰度，而不是只让音乐变薄？",
      "语义音效是否真正证明一个重点，而不是模板化装饰？",
    ],
    authority: {
      autoApprove: false,
      autoPublish: false,
      autoPromoteMemory: false,
    },
  };

  await writeCanonicalJson(path.join(root, "audio_request.json"), audioRequest);
  await writeCanonicalJson(path.join(root, "audio_meta.json"), audioMeta);
  await writeCanonicalJson(path.join(root, "asset-ledger.json"), assetLedger);
  await writeCanonicalJson(path.join(root, "qa.json"), qa);
  await writeCanonicalJson(path.join(root, "recreation-manifest.json"), recreationManifest);
  await writeCanonicalJson(
    path.join(root, "subjective-review-template.json"),
    subjectiveReviewTemplate
  );
  const hashesFile = await writeHashes(root);

  return {
    outputDir: root,
    status: recreationManifest.status,
    technicalPass: qa.technicalPass,
    manifestFile: path.join(root, "recreation-manifest.json"),
    qaFile: path.join(root, "qa.json"),
    hashesFile,
    reviewFile: path.join(root, "subjective-review-template.json"),
    variants: variantManifest,
  };
}
