import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function gain(value, fallback = 0.2) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

export function normalizeSoundDesign(value = {}, policy = {}) {
  const cues = (Array.isArray(value.cues) ? value.cues : []).slice(0, Number(policy.semanticSfx?.maxCues || 12)).map((cue, index) => ({
    id: String(cue.id || `cue-${index + 1}`),
    path: path.resolve(String(cue.path || "")),
    at: Math.max(0, Number(cue.at || 0)),
    gain: gain(cue.gain, 0.25),
    licenseBasis: String(cue.licenseBasis || "").trim(),
    semanticReason: String(cue.semanticReason || "").trim(),
  }));
  const backgroundMusic = value.backgroundMusic?.path ? {
    path: path.resolve(String(value.backgroundMusic.path)),
    gain: gain(value.backgroundMusic.gain, 0.12),
    licenseBasis: String(value.backgroundMusic.licenseBasis || "").trim(),
  } : null;
  return {
    enabled: value.enabled === true,
    backgroundMusic,
    cues,
    ducking: {
      enabled: backgroundMusic && value.ducking?.enabled === true,
      threshold: Number(value.ducking?.threshold || policy.speechAwareDucking?.threshold || 0.08),
      ratio: Number(value.ducking?.ratio || policy.speechAwareDucking?.ratio || 8),
      attackMs: Number(value.ducking?.attackMs || policy.speechAwareDucking?.attackMs || 20),
      releaseMs: Number(value.ducking?.releaseMs || policy.speechAwareDucking?.releaseMs || 320),
    },
  };
}

export function soundDesignIssues(design, policy = {}) {
  const issues = [];
  if (design.enabled && policy.productionEnabled !== true) issues.push("声音生产层仍处于 trial，缺少人工晋升批准");
  for (const cue of design.cues || []) {
    if (!fs.existsSync(cue.path)) issues.push(`${cue.id}: 本地 SFX 文件不存在`);
    if (!cue.licenseBasis) issues.push(`${cue.id}: 缺少许可依据`);
    if (!cue.semanticReason) issues.push(`${cue.id}: 缺少语义触发理由`);
  }
  if (design.backgroundMusic) {
    if (!fs.existsSync(design.backgroundMusic.path)) issues.push("BGM 文件不存在");
    if (!design.backgroundMusic.licenseBasis) issues.push("BGM 缺少许可依据");
  }
  return issues;
}

export function buildSoundMixPlan(design) {
  const inputs = [];
  const filters = [];
  const mixLabels = ["[voice]"];
  filters.push("[0:a]asetpts=N/SR/TB[voice]");
  let inputIndex = 1;
  if (design.backgroundMusic) {
    inputs.push("-stream_loop", "-1", "-i", design.backgroundMusic.path);
    const bed = `[${inputIndex}:a]volume=${design.backgroundMusic.gain.toFixed(4)},asetpts=N/SR/TB[bed]`;
    filters.push(bed);
    if (design.ducking.enabled) {
      filters.push(`[bed][voice]sidechaincompress=threshold=${design.ducking.threshold}:ratio=${design.ducking.ratio}:attack=${design.ducking.attackMs}:release=${design.ducking.releaseMs}[ducked]`);
      mixLabels.push("[ducked]");
    } else mixLabels.push("[bed]");
    inputIndex += 1;
  }
  for (const cue of design.cues) {
    inputs.push("-i", cue.path);
    const delay = Math.round(cue.at * 1000);
    const label = `cue${inputIndex}`;
    filters.push(`[${inputIndex}:a]volume=${cue.gain.toFixed(4)},adelay=${delay}|${delay},asetpts=N/SR/TB[${label}]`);
    mixLabels.push(`[${label}]`);
    inputIndex += 1;
  }
  filters.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0,alimiter=limit=0.84[mix]`);
  return { inputs, filterComplex: filters.join(";"), outputLabel: "[mix]" };
}

export function renderSoundDesign({ ffmpeg = "ffmpeg", inputVideo, outputVideo, design, policy, allowTrial = false }) {
  const normalized = normalizeSoundDesign(design, policy);
  const issues = soundDesignIssues(normalized, { ...policy, productionEnabled: allowTrial || policy.productionEnabled === true });
  if (issues.length) throw new Error(issues.join("；"));
  const plan = buildSoundMixPlan(normalized);
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", inputVideo, ...plan.inputs, "-filter_complex", plan.filterComplex, "-map", "0:v:0", "-map", plan.outputLabel, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputVideo];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve({ outputVideo, plan, design: normalized }) : reject(new Error(stderr || `FFmpeg exited ${code}`)));
  });
}
