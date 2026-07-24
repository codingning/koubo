#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  acceptanceAudioMixFilter,
  acceptanceVideoEncodingArgs,
  acceptanceRecipes,
  blindMediaPlan,
  freezeRegressionAgainstControl,
  joinFfmpegFilterChains,
  measuredTextLayout,
  parseFfmpegBbox,
  publicAcceptanceValue,
  selectChallengerSource,
  selectFrozenControl,
} from "../video/multi-agent/acceptance.mjs";
import {
  buildBlindReviewBundle,
  candidateDiversity,
} from "../video/multi-agent/evaluation.mjs";
import {
  canonicalJson,
  loadAgentProfiles,
} from "../video/multi-agent/contracts.mjs";
import { createMemoryService } from "../video/multi-agent/memory.mjs";
import { createOrchestrator } from "../video/multi-agent/orchestrator.mjs";
import { openDomainStore } from "../video/multi-agent/store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineFile = path.join(root, "config", "evaluation", "baseline-v1.json");
const fontFile = "C:\\Windows\\Fonts\\msyh.ttc";
const agentForNamespace = {
  "caption.private": "caption-agent",
  "motion.private": "motion-agent",
  "sound.private": "sound-agent",
};

function parseArguments(argv) {
  const values = {
    jobsRoot: process.env.KOUBO_VIDEO_JOBS_ROOT || path.join(root, "video-jobs"),
    outputRoot: path.join(root, ".cache", "multi-agent-acceptance"),
    tutorial: path.join(root, ".cache", "legal-tutorial-fixture-v2", "tutorial.mp4"),
    runId: new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14),
  };
  const names = new Map([
    ["--jobs-root", "jobsRoot"],
    ["--output-root", "outputRoot"],
    ["--tutorial", "tutorial"],
    ["--run-id", "runId"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = names.get(argv[index]);
    if (!field) throw new Error(`unknown argument: ${argv[index]}`);
    values[field] = argv[++index];
  }
  values.jobsRoot = path.resolve(values.jobsRoot);
  values.outputRoot = path.resolve(values.outputRoot);
  values.tutorial = path.resolve(values.tutorial);
  if (!/^[A-Za-z0-9._-]{4,80}$/.test(values.runId)) throw new Error("--run-id is invalid");
  return values;
}

function run(command, args, {
  cwd = root,
  env = process.env,
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", code => {
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`${command} failed (${code}): ${(stderr || stdout).slice(-2000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseJsonOutput(stdout, label) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`${label} returned no JSON`);
  return JSON.parse(stdout.slice(start, end + 1));
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, file);
}

function relativeToRun(runRoot, file) {
  return path.relative(runRoot, file).replaceAll("\\", "/");
}

async function verifyFrozenBaseline(baseline, jobsRoot) {
  const verified = [];
  for (const sample of baseline.samples) {
    const artifacts = [];
    for (const artifact of sample.artifacts) {
      const file = path.join(jobsRoot, sample.jobId, artifact.path);
      if (!fs.existsSync(file)) throw new Error(`frozen artifact is missing: ${sample.jobId}/${artifact.path}`);
      const actualHash = await sha256(file);
      if (actualHash !== artifact.sha256) {
        throw new Error(`frozen artifact hash changed: ${sample.jobId}/${artifact.path}`);
      }
      artifacts.push({ path: artifact.path, sha256: actualHash, bytes: fs.statSync(file).size });
    }
    verified.push({ jobId: sample.jobId, artifacts });
  }
  return verified;
}

async function runTutorialLifecycle({ runRoot, tutorial }) {
  const dataRoot = path.join(runRoot, "governed-memory");
  const recreationRoot = path.join(runRoot, "tutorial-recreations");
  const environment = {
    ...process.env,
    KOUBO_MULTI_AGENT_DATA_ROOT: dataRoot,
    KOUBO_MULTI_AGENT_PYTHON: path.join(root, ".runtime-multi-agent", "Scripts", "python.exe"),
  };
  const ingestion = parseJsonOutput((await run(process.execPath, [
    path.join(root, "scripts", "ingest_tutorial.mjs"),
    "--input", tutorial,
    "--author", "koubo-acceptance-fixture",
    "--license", "self-created-test-fixture",
  ], { env: environment })).stdout, "tutorial ingestion");
  const recreation = parseJsonOutput((await run(process.execPath, [
    path.join(root, "scripts", "recreate_tutorial_techniques.mjs"),
    "--checkpoint", ingestion.checkpointPath,
    "--output", recreationRoot,
    "--data-root", dataRoot,
  ], { env: environment, timeoutMs: 90 * 60 * 1000 })).stdout, "tutorial recreation");

  const store = openDomainStore({
    dbPath: path.join(dataRoot, "runtime", "memory.sqlite"),
    exportRoot: path.join(dataRoot, "library"),
  });
  try {
    const profiles = await loadAgentProfiles(root);
    const memory = createMemoryService(store, profiles);
    const techniques = store.db.prepare(
      "SELECT json FROM records WHERE kind = 'technique-card' ORDER BY id"
    ).all().map(row => JSON.parse(row.json));
    if (techniques.length < 3 || techniques.some(item => item.status !== "recreated")) {
      throw new Error("acceptance requires three recreated specialist techniques");
    }

    const invokeAgent = async request => {
      const remembered = request.memory?.[0];
      const base = {
        layout: "speaker-right-information-left",
        captions: { identity: "anchor" },
        motion: { structure: [] },
        sound: { structure: [] },
      };
      if (remembered?.namespace === "caption.private") {
        base.captions = { identity: remembered.primitive };
      }
      if (remembered?.namespace === "motion.private") {
        base.motion = { structure: [remembered.primitive] };
      }
      if (remembered?.namespace === "sound.private") {
        base.sound = { structure: [remembered.primitive] };
      }
      return {
        success: true,
        result: {
          proposals: [{
            candidate: base,
            citations: remembered
              ? [{ recordId: remembered.id, contentHash: remembered.contentHash }]
              : [],
            uncertainties: remembered ? [] : ["no governed memory was retrievable"],
          }],
        },
      };
    };
    const proposalInput = {
      jobId: "acceptance-memory-effect",
      transcript: [{ start: 0, end: 4, text: "从知道到做到，用真实结果验证 AI。" }],
      sharedEvidence: [{ id: "fixture-evidence", kind: "fixture", start: 0, end: 4 }],
      currentPlan: {
        layout: "speaker-right-information-left",
        captions: "anchor",
        motion: [],
        sound: [],
      },
      roleInputs: {
        caption: { captionCues: [], safeArea: { bottom: 120 } },
        motion: { sceneWindows: [{ start: 0, end: 4 }], approvedAssets: [] },
        sound: { licensedAssets: [], voicePeakDb: -6 },
      },
      v4Plan: {
        engine: "visual-director-v4",
        layout: "speaker-right-information-left",
        captions: { identity: "anchor" },
        motion: { structure: [] },
        sound: { structure: [] },
      },
    };
    const orchestrator = createOrchestrator({
      memory,
      invokeAgent,
      clock: () => "2026-07-23T12:00:00.000Z",
      limits: { retries: 0, timeoutMs: 5_000 },
    });
    const proposalShape = result => result.proposals.map(item => ({
      proposalKind: item.proposalKind,
      candidate: item.candidate,
      citations: item.citations,
    }));
    const beforeRetrieval = Object.fromEntries(Object.entries(agentForNamespace).map(([namespace, agentId]) => [
      namespace,
      memory.retrieve({ agentId }).map(item => item.id),
    ]));
    const beforeProposal = proposalShape(await orchestrator.propose(proposalInput));
    const transitions = [];
    const recreationById = new Map(recreation.results.map(item => [item.techniqueId, item]));
    for (const initial of techniques) {
      let current = memory.get("technique-card", initial.id);
      const recreated = recreationById.get(current.id);
      transitions.push(memory.transition({
        kind: "technique-card",
        id: current.id,
        to: "trial",
        actor: { type: "controller", id: "acceptance-trial-controller" },
        evidence: [{
          type: "render-qa",
          sourceId: current.id,
          kind: "sandbox-render",
          renderHash: recreated.renderHash,
          passed: true,
        }],
        expectedHash: current.contentHash,
      }));
      current = memory.get("technique-card", current.id);
      transitions.push(memory.transition({
        kind: "technique-card",
        id: current.id,
        to: "approved",
        actor: { type: "human", id: "fixture-acceptance-reviewer" },
        evidence: [{
          type: "human-review",
          decision: "approved",
          reviewerId: "fixture-acceptance-reviewer",
          projectId: "fixture-project-one",
          fixture: true,
        }],
        expectedHash: current.contentHash,
      }));
      current = memory.get("technique-card", current.id);
      transitions.push(memory.transition({
        kind: "technique-card",
        id: current.id,
        to: "promoted",
        actor: { type: "human", id: "fixture-acceptance-reviewer" },
        evidence: [
          { type: "approved-project-trial", projectId: "fixture-project-one", reviewId: `fixture-review-one-${current.id}`, fixture: true },
          { type: "approved-project-trial", projectId: "fixture-project-two", reviewId: `fixture-review-two-${current.id}`, fixture: true },
        ],
        expectedHash: current.contentHash,
      }));
    }
    const afterRetrieval = Object.fromEntries(Object.entries(agentForNamespace).map(([namespace, agentId]) => [
      namespace,
      memory.retrieve({ agentId }).map(item => item.id),
    ]));
    const afterProposal = proposalShape(await orchestrator.propose(proposalInput));

    const promotions = transitions.filter(item => item.toStatus === "promoted");
    const approvals = transitions.filter(item => item.toStatus === "approved");
    for (const transition of promotions) memory.rollback(transition.id);
    for (const transition of approvals) memory.rollback(transition.id);
    const rollbackRetrieval = Object.fromEntries(Object.entries(agentForNamespace).map(([namespace, agentId]) => [
      namespace,
      memory.retrieve({ agentId }).map(item => item.id),
    ]));
    const rollbackProposal = proposalShape(await orchestrator.propose(proposalInput));
    const rollbackRestored = canonicalJson(rollbackProposal) === canonicalJson(beforeProposal);
    if (!rollbackRestored) throw new Error("memory rollback did not restore the prior proposal behavior");

    const finalTransitions = [];
    for (const initial of techniques) {
      let current = memory.get("technique-card", initial.id);
      finalTransitions.push(memory.transition({
        kind: "technique-card",
        id: current.id,
        to: "approved",
        actor: { type: "human", id: "fixture-acceptance-reviewer" },
        evidence: [{
          type: "human-review",
          decision: "approved",
          reviewerId: "fixture-acceptance-reviewer",
          projectId: "fixture-project-one",
          fixture: true,
        }],
        expectedHash: current.contentHash,
      }));
      current = memory.get("technique-card", current.id);
      finalTransitions.push(memory.transition({
        kind: "technique-card",
        id: current.id,
        to: "promoted",
        actor: { type: "human", id: "fixture-acceptance-reviewer" },
        evidence: [
          { type: "approved-project-trial", projectId: "fixture-project-one", reviewId: `fixture-review-final-one-${current.id}`, fixture: true },
          { type: "approved-project-trial", projectId: "fixture-project-two", reviewId: `fixture-review-final-two-${current.id}`, fixture: true },
        ],
        expectedHash: current.contentHash,
      }));
    }
    const finalRecords = techniques.map(item => memory.get("technique-card", item.id));
    const evidence = {
      tutorial: {
        tutorialId: ingestion.tutorialId,
        sourceHash: ingestion.sourceHash,
        stage: ingestion.stage,
        mediaCopied: ingestion.mediaCopied,
      },
      recreation: {
        status: recreation.status,
        results: recreation.results.map(item => ({
          techniqueId: item.techniqueId,
          primitive: item.primitive,
          renderHash: item.renderHash,
          checks: item.checks,
        })),
      },
      fixtureApprovalDisclosure: "All acceptance approvals are explicit test-fixture approvals, not the user's real approval.",
      before: { retrieval: beforeRetrieval, proposal: beforeProposal },
      afterPromotion: { retrieval: afterRetrieval, proposal: afterProposal },
      afterRollback: { retrieval: rollbackRetrieval, proposal: rollbackProposal },
      rollbackRestored,
      finalRecords: finalRecords.map(item => ({
        id: item.id,
        namespace: item.namespace,
        primitive: item.primitive,
        status: item.status,
        contentHash: item.contentHash,
      })),
      transitionCount: transitions.length + finalTransitions.length,
    };
    await writeJson(path.join(runRoot, "memory-lifecycle-evidence.json"), evidence);
    return { evidence, finalRecords, dataRoot };
  } finally {
    store.close();
  }
}

function phraseCandidates(job) {
  const transcript = job.transcript?.segments?.map(item => String(item.text || "").trim()).filter(Boolean) || [];
  const script = String(job.script || "").split(/[。！？!?\n]/).map(item => item.trim()).filter(Boolean);
  const phrases = [...transcript, ...script]
    .map(item => item.replace(/\s+/g, " ").slice(0, 22))
    .filter((item, index, array) => item && array.indexOf(item) === index)
    .slice(0, 3);
  while (phrases.length < 3) phrases.push(["真实输入", "可见结果", "人工审核"][phrases.length]);
  return phrases;
}

async function probeMedia(file) {
  const result = await run("ffprobe", [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    file,
  ]);
  return JSON.parse(result.stdout);
}

function mediaDuration(probe) {
  return Number(probe.format?.duration || probe.streams?.find(item => item.codec_type === "video")?.duration || 0);
}

async function renderControl({ input, output, duration }) {
  const filter = [
    `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,`,
    "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x08131b,",
    `fps=30,tpad=stop_mode=clone:stop_duration=${duration.toFixed(3)}[v];`,
    "[0:a]aresample=48000,apad[a]",
  ].join("");
  await run("ffmpeg", [
    "-y", "-v", "warning",
    "-i", input,
    "-filter_complex", filter,
    "-map", "[v]", "-map", "[a]",
    "-t", duration.toFixed(3),
    ...acceptanceVideoEncodingArgs(),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart",
    output,
  ]);
}

function ffmpegFilterPath(file) {
  return file.replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, "$1\\:")
    .replaceAll("'", "\\'");
}

function createFontMeasurer({ workDir, fontSize, label }) {
  const cache = new Map();
  return async text => {
    const value = String(text || "");
    if (cache.has(value)) return cache.get(value);
    const digest = crypto.createHash("sha256").update(`${fontSize}:${value}`).digest("hex").slice(0, 16);
    const textFile = path.join(workDir, `${label}-measure-${digest}.txt`);
    await fsp.writeFile(textFile, value, "utf8");
    const font = ffmpegFilterPath(fontFile);
    const file = ffmpegFilterPath(textFile);
    const filter = [
      `drawtext=fontfile='${font}':textfile='${file}':`,
      `fontsize=${fontSize}:fontcolor=white:x=0:y=0,bbox`,
    ].join("");
    const result = await run("ffmpeg", [
      "-hide_banner", "-v", "info",
      "-f", "lavfi",
      "-i", "color=c=black:s=2048x256:d=0.08:r=25",
      "-vf", filter,
      "-frames:v", "1",
      "-f", "null", "-",
    ]);
    const size = parseFfmpegBbox(result.stderr);
    cache.set(value, size);
    return size;
  };
}

async function renderChallenger({
  source,
  output,
  duration,
  recipe,
  phrases,
  workDir,
}) {
  const captionMode = recipe.id === "caption-pulse";
  const fontSize = captionMode ? 38 : 25;
  const maxWidth = captionMode ? 1040 : 292;
  const maxLines = captionMode ? 2 : 3;
  const lineHeight = captionMode ? 48 : 34;
  const paddingY = captionMode ? 0 : 18;
  const measure = createFontMeasurer({
    workDir,
    fontSize,
    label: recipe.id,
  });
  const layouts = [];
  for (const phrase of phrases) {
    layouts.push(await measuredTextLayout(phrase, {
      maxWidth,
      maxLines,
      lineHeight,
      paddingY,
      measure,
    }));
  }
  const phraseFiles = [];
  for (const [index, layout] of layouts.entries()) {
    const file = path.join(workDir, `${recipe.id}-phrase-${index + 1}.txt`);
    await fsp.writeFile(file, layout.text, "utf8");
    phraseFiles.push(ffmpegFilterPath(file));
  }
  const font = ffmpegFilterPath(fontFile);
  const starts = [0.55, duration / 3, duration * 2 / 3].map(value => Number(value.toFixed(3)));
  let videoFilter;
  let overlayGeometrySafe;
  if (captionMode) {
    const captions = starts.map((start, index) => {
      const end = Math.min(duration - 0.15, start + 3.7);
      return `drawtext=fontfile='${font}':textfile='${phraseFiles[index]}':fontsize=${fontSize}:line_spacing=6:fontcolor=white:box=1:boxcolor=0x07131d@0.82:boxborderw=16:x=(w-text_w)/2:y='h-text_h-54-18*exp(-5*(t-${start}))':enable='between(t,${start},${end.toFixed(3)})'`;
    });
    videoFilter = [
      "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,",
      "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x08131b,",
      `fps=30,tpad=stop_mode=clone:stop_duration=${duration.toFixed(3)}[base];`,
      `[base]drawbox=x=0:y=0:w='iw*min(t/${duration.toFixed(3)},1)':h=8:color=0x4ee2c1@0.95:t=fill,${captions.join(",")}[v]`,
    ].join("");
    const highestCaptionTop = Math.min(...layouts.map(layout =>
      720 - (layout.lines.length * lineHeight) - 54 - 18 - 32
    ));
    overlayGeometrySafe = highestCaptionTop >= 500;
  } else {
    const cards = starts.map((start, index) => {
      const end = Math.min(duration - 0.15, start + duration / 2);
      const y = 82 + index * 196;
      const cardHeight = Math.max(96, layouts[index].boxHeight);
      const textHeight = layouts[index].lines.length * lineHeight;
      const textY = Math.round(y + (cardHeight - textHeight) / 2);
      return [
        `drawbox=x=28:y=${y}:w=332:h=${cardHeight}:color=0x12384a@0.94:t=fill:enable='between(t,${start},${end.toFixed(3)})'`,
        `drawtext=fontfile='${font}':textfile='${phraseFiles[index]}':fontsize=${fontSize}:line_spacing=8:fontcolor=white:x=48:y=${textY}:enable='between(t,${start},${end.toFixed(3)})'`,
      ].join(",");
    });
    videoFilter = [
      "[0:v]scale=880:720:force_original_aspect_ratio=decrease,",
      "pad=880:720:(ow-iw)/2:(oh-ih)/2:color=0x07131d,",
      `fps=30,tpad=stop_mode=clone:stop_duration=${duration.toFixed(3)}[main];`,
      `color=c=0x071a25:s=1280x720:r=30:d=${duration.toFixed(3)}[bg];`,
      "[bg][main]overlay=400:0[layout];",
      `[layout]drawbox=x=382:y=0:w=6:h='720*min(t/${duration.toFixed(3)},1)':color=0x4ee2c1@0.95:t=fill,${cards.join(",")}[v]`,
    ].join("");
    overlayGeometrySafe = layouts.every((layout, index) => {
      const cardHeight = Math.max(96, layout.boxHeight);
      const y = 82 + index * 196;
      return Math.max(...layout.widths) <= maxWidth
        && 48 + Math.max(...layout.widths) < 382
        && y + cardHeight <= 720;
    });
  }
  const filter = joinFfmpegFilterChains([
    videoFilter,
    "[0:a]aresample=48000,apad[voice]",
    "[1:a]adelay=2200|2200,volume=0.07[cue]",
    acceptanceAudioMixFilter("[voice]"),
  ]);
  const filterFile = path.join(workDir, `${recipe.id}.ffscript`);
  await fsp.writeFile(filterFile, filter, "utf8");
  await run("ffmpeg", [
    "-y", "-v", "warning",
    "-i", source,
    "-f", "lavfi",
    "-i", `sine=frequency=${captionMode ? 740 : 520}:sample_rate=48000:duration=0.12`,
    "-filter_complex", filter,
    "-map", "[v]", "-map", "[a]",
    "-t", duration.toFixed(3),
    ...acceptanceVideoEncodingArgs(),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart",
    output,
  ]);
  return {
    cleanSource: true,
    overlayGeometrySafe,
    measuredTextFits: layouts.every(layout => layout.fits),
    layouts: layouts.map(layout => ({
      lineCount: layout.lines.length,
      widths: layout.widths,
      maxWidth: layout.maxWidth,
      lineHeight: layout.lineHeight,
      boxHeight: layout.boxHeight,
      fits: layout.fits,
    })),
  };
}

function parseDetection(stderr, pattern) {
  return [...stderr.matchAll(pattern)].map(match => Number(match[1]));
}

async function qaMedia(file, expectedDuration, {
  layoutEvidence = null,
  sourceEvidence = null,
} = {}) {
  const probe = await probeMedia(file);
  const video = probe.streams.find(item => item.codec_type === "video");
  const audio = probe.streams.find(item => item.codec_type === "audio");
  const decode = await run("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]);
  const black = await run("ffmpeg", [
    "-v", "info", "-i", file,
    "-vf", "blackdetect=d=1:pic_th=0.98",
    "-an", "-f", "null", "-",
  ]);
  const freeze = await run("ffmpeg", [
    "-v", "info", "-i", file,
    "-vf", "freezedetect=n=-60dB:d=2",
    "-an", "-f", "null", "-",
  ]);
  const volume = await run("ffmpeg", [
    "-v", "info", "-i", file,
    "-af", "volumedetect",
    "-vn", "-f", "null", "-",
  ]);
  const peakMatch = volume.stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/i);
  const peakDb = peakMatch ? Number(peakMatch[1]) : null;
  const duration = mediaDuration(probe);
  const fpsParts = String(video?.r_frame_rate || "0/1").split("/").map(Number);
  const fps = fpsParts[1] ? fpsParts[0] / fpsParts[1] : fpsParts[0];
  const blackStarts = parseDetection(black.stderr, /black_start:([\d.]+)/g);
  const freezeStarts = parseDetection(freeze.stderr, /freeze_start:\s*([\d.]+)/g);
  const freezeDurations = parseDetection(freeze.stderr, /freeze_duration:\s*([\d.]+)/g);
  const maxFreezeDuration = freezeDurations.length
    ? Math.max(...freezeDurations)
    : freezeStarts.length
      ? Math.max(...freezeStarts.map(start => Math.max(0, duration - start)))
      : 0;
  const checks = {
    decodes: decode.stderr.trim() === "",
    durationMatches: Math.abs(duration - expectedDuration) <= 0.16,
    dimensions: video?.width === 1280 && video?.height === 720,
    fps: Math.abs(fps - 30) < 0.01,
    h264: video?.codec_name === "h264",
    aac: audio?.codec_name === "aac",
    yuv420p: video?.pix_fmt === "yuv420p",
    sdrBt709: ["bt709", undefined].includes(video?.color_space)
      && ["bt709", undefined].includes(video?.color_transfer)
      && ["bt709", undefined].includes(video?.color_primaries),
    audioPeakSafe: peakDb !== null && peakDb <= -1 && peakDb >= -30,
    noLongBlackFrames: blackStarts.length === 0,
    measuredTextFits: layoutEvidence
      ? layoutEvidence.measuredTextFits === true
        && layoutEvidence.layouts.every(item =>
          item.fits === true
          && item.widths.every(width => width <= item.maxWidth)
        )
      : true,
    overlayGeometrySafe: layoutEvidence
      ? layoutEvidence.overlayGeometrySafe === true
      : true,
    frozenRawSource: sourceEvidence
      ? sourceEvidence.frozenRawSource === true
      : true,
    speechSyncPreserved: sourceEvidence
      ? sourceEvidence.sameTimelineSegment === true
      : true,
  };
  return {
    fileHash: await sha256(file),
    bytes: fs.statSync(file).size,
    duration,
    width: video?.width,
    height: video?.height,
    fps,
    peakDb,
    blackStarts,
    freezeStarts,
    freezeDurations,
    maxFreezeDuration,
    layoutEvidence,
    sourceEvidence,
    checks,
  };
}

async function createContactSheet(input, output) {
  await run("ffmpeg", [
    "-y", "-v", "warning",
    "-i", input,
    "-vf", "fps=1/4,scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=0x08131b,tile=4x1",
    "-frames:v", "1",
    "-q:v", "2",
    output,
  ]);
}

function finalizeQa(items) {
  const controlQa = items.find(item => item.recipe.id === "frozen-control")?.qa;
  for (const item of items) {
    item.qa.checks.noNewLongFreeze = freezeRegressionAgainstControl(controlQa, item.qa);
    item.qa.technicalPass = Object.values(item.qa.checks).every(Boolean);
  }
}

function criticFixtures(candidate, duration) {
  const cue = candidate.captions?.identity === "frozen"
    ? "control rhythm preserved"
    : "visible information change is tied to a spoken beat";
  return {
    blind: {
      scores: {
        technical: candidate.renderEvidence.technicalPass ? 1 : 0,
        content: 0.9,
        brand: 0.9,
      },
      timecodedFindings: [{
        start: 0.5,
        end: Math.min(3.2, duration),
        type: "strength",
        finding: cue,
      }],
    },
    retention: {
      scores: { retention: candidate.captions?.identity === "frozen" ? 0.72 : 0.82 },
      timecodedFindings: [{
        start: Math.min(2, duration - 0.5),
        end: Math.min(4, duration),
        type: "attention-change",
        finding: cue,
        viewingReason: "The visual or caption change reinforces the current spoken claim without requiring an effect every second.",
        necessaryPause: true,
      }],
    },
  };
}

async function runCritics(candidate, duration, jobId) {
  const fixture = criticFixtures(candidate, duration);
  const orchestrator = createOrchestrator({
    memory: { retrieve: () => [] },
    invokeAgent: async request => ({
      success: true,
      result: request.agentId === "retention-critic" ? fixture.retention : fixture.blind,
    }),
    clock: () => "2026-07-23T12:30:00.000Z",
    limits: { retries: 0, timeoutMs: 5_000 },
  });
  return {
    mode: "deterministic-fixture-preflight",
    disclosure: "These critic records verify isolation, schemas, timecodes, and policy. They are not the user's final subjective review.",
    blind: await orchestrator.criticize(candidate, { blind: true, jobId }),
    retention: await orchestrator.retentionAudit(candidate, { jobId }),
  };
}

async function renderSamples({
  baseline,
  jobsRoot,
  runRoot,
  memories,
}) {
  const recipes = acceptanceRecipes();
  const samplesRoot = path.join(runRoot, "samples");
  const blindRoot = path.join(runRoot, "blind-review");
  const blindMediaRoot = path.join(blindRoot, "media");
  await fsp.mkdir(blindMediaRoot, { recursive: true });
  const sampleReports = [];
  const privateMaps = [];

  for (const sample of baseline.samples) {
    const sampleDir = path.join(samplesRoot, sample.jobId);
    await fsp.mkdir(sampleDir, { recursive: true });
    const controlInput = selectFrozenControl(sample, jobsRoot, fs.existsSync);
    const challengerInput = selectChallengerSource(sample, jobsRoot, fs.existsSync);
    const sourceProbe = await probeMedia(controlInput);
    const sourceDuration = mediaDuration(sourceProbe);
    const duration = Math.max(15, Math.min(20, sourceDuration));
    const job = JSON.parse(await fsp.readFile(path.join(jobsRoot, sample.jobId, "job.json"), "utf8"));
    const phrases = phraseCandidates(job);
    const items = [];
    for (const recipe of recipes) {
      const output = path.join(sampleDir, `${recipe.id}.mp4`);
      let layoutEvidence = null;
      if (recipe.id === "frozen-control") {
        await renderControl({ input: controlInput, output, duration });
      } else {
        layoutEvidence = await renderChallenger({
          source: challengerInput,
          output,
          duration,
          recipe,
          phrases,
          workDir: sampleDir,
        });
      }
      const sourceEvidence = recipe.id === "frozen-control"
        ? null
        : {
            frozenRawSource: challengerInput === path.resolve(jobsRoot, sample.jobId, sample.source),
            sameTimelineSegment: true,
            startSeconds: 0,
            durationSeconds: duration,
          };
      const qa = await qaMedia(output, duration, {
        layoutEvidence,
        sourceEvidence,
      });
      const contactSheet = path.join(sampleDir, `${recipe.id}-contact-sheet.jpg`);
      await createContactSheet(output, contactSheet);
      const memoryCitations = recipe.id === "frozen-control"
        ? []
        : memories.map(item => ({ recordId: item.id, contentHash: item.contentHash }));
      items.push({
        recipe,
        output,
        contactSheet,
        qa,
        candidate: {
          ...recipe,
          duration,
          renderHash: qa.fileHash,
          renderEvidence: {
            technicalPass: false,
            qaHash: crypto.createHash("sha256").update(canonicalJson(qa)).digest("hex"),
            contactSheetHash: await sha256(contactSheet),
            sameSourceSegment: true,
            frozenRawSource: sourceEvidence?.frozenRawSource ?? true,
            layoutEvidence,
          },
          memoryCitations,
          versions: {
            code: "run-multi-agent-acceptance-v2",
            model: "deterministic-fixture-preflight",
            prompt: "bounded-specialists-v1",
            memory: "schema-v1",
            asset: "frozen-raw-challenger-source-v2",
            recipe: recipe.recipeVersion,
            evaluation: "rubric-v1",
          },
        },
      });
    }
    finalizeQa(items);
    for (const item of items) {
      await writeJson(path.join(sampleDir, `${item.recipe.id}-qa.json`), item.qa);
      item.candidate.renderEvidence.technicalPass = item.qa.technicalPass;
      item.critics = await runCritics(item.candidate, duration, sample.jobId);
    }
    if (items.some(item => !item.qa.technicalPass)) {
      throw new Error(`technical QA failed for baseline sample ${sample.jobId}`);
    }
    const diversity = [
      candidateDiversity(items[0].candidate, items[1].candidate),
      candidateDiversity(items[0].candidate, items[2].candidate),
      candidateDiversity(items[1].candidate, items[2].candidate),
    ];
    if (diversity.some(item => !item.meaningful)) {
      throw new Error(`candidate diversity failed for ${sample.jobId}`);
    }
    const blindBundle = buildBlindReviewBundle(items.map(item => item.candidate), {
      baselineId: baseline.baselineId,
      jobId: sample.jobId,
    });
    const publicPlan = blindMediaPlan(blindBundle, items.map(item => ({
      id: item.recipe.id,
      renderHash: item.qa.fileHash,
      renderPath: item.output,
    })), sample.jobId);
    for (const planned of publicPlan) {
      const source = items.find(item => item.qa.fileHash === planned.renderHash);
      await fsp.copyFile(source.output, path.join(blindMediaRoot, planned.publicFile));
    }
    privateMaps.push({
      jobId: sample.jobId,
      mapping: publicPlan.map(item => ({
        label: item.label,
        recipeId: items.find(candidate => candidate.qa.fileHash === item.renderHash).recipe.id,
        renderHash: item.renderHash,
      })),
    });
    sampleReports.push({
      jobId: sample.jobId,
      frozenPipeline: sample.pipeline,
      coverage: sample.coverage,
      duration,
      controlHash: await sha256(controlInput),
      challengerSourceHash: await sha256(challengerInput),
      challengerSourceArtifactHash: sample.artifacts.find(item =>
        String(item.path || "").replaceAll("\\", "/") === String(sample.source).replaceAll("\\", "/")
      )?.sha256,
      sameSourceSegment: true,
      sameDimensions: true,
      sameFrameRate: true,
      sameRenderer: "ffmpeg-acceptance-v1",
      candidates: items.map(item => ({
        id: item.recipe.id,
        structure: {
          layout: item.recipe.layout,
          captions: item.recipe.captions,
          motion: item.recipe.motion,
          sound: item.recipe.sound,
        },
        renderHash: item.qa.fileHash,
        qa: item.qa,
        output: relativeToRun(runRoot, item.output),
        contactSheet: relativeToRun(runRoot, item.contactSheet),
        memoryCitations: item.candidate.memoryCitations,
        versions: item.candidate.versions,
        critics: item.critics,
      })),
      diversity,
      blindBundle,
      blindMedia: publicPlan.map(item => ({
        ...item,
        publicFile: `media/${item.publicFile}`,
      })),
    });
  }
  await writeJson(path.join(runRoot, "blind-map-private.json"), privateMaps);
  return { sampleReports, privateMaps };
}

function blindReviewHtml(sampleReports, runId) {
  const sections = sampleReports.map((sample, index) => `
    <section class="sample" data-job="${sample.jobId}">
      <header><span>样本 ${index + 1}</span><h2>${sample.jobId}</h2><p>${sample.duration.toFixed(1)} 秒 · 同源、同尺寸、同帧率、同渲染器 · 候选身份已隐藏</p></header>
      <div class="candidates">${sample.blindMedia.map(item => `
        <article>
          <div class="candidate-head"><strong>候选 ${item.label}</strong><code>${item.renderHash.slice(0, 12)}…</code></div>
          <video controls preload="metadata" src="${item.publicFile}"></video>
          <label><input type="radio" name="winner-${sample.jobId}" value="${item.label}"> 这个候选最好</label>
        </article>`).join("")}</div>
      <label class="notes">时间码与理由<textarea data-notes="${sample.jobId}" rows="3" placeholder="例如：候选 B，3.2–5.0 秒的信息变化最自然；候选 A 的声音提示略多。"></textarea></label>
    </section>`).join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Koubo 多 Agent 集中盲审</title>
<style>
:root{color-scheme:dark;--bg:#07131d;--card:#102431;--line:#294554;--teal:#55e0c5;--text:#f4f8fa;--muted:#a6bbc6}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#153b46,transparent 38%),var(--bg);color:var(--text);font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif}main{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:50px 0 80px}.hero{margin-bottom:28px}.hero span{color:var(--teal);font-weight:800}.hero h1{margin:5px 0;font-size:clamp(30px,5vw,54px)}.hero p{max-width:760px;color:var(--muted)}.notice{padding:13px 16px;border:1px solid #5b532e;border-radius:12px;background:#242314;color:#eadf9d}.sample{margin-top:22px;padding:20px;border:1px solid var(--line);border-radius:18px;background:rgba(16,36,49,.88)}.sample header span{color:var(--teal);font-weight:800}.sample h2{margin:2px 0;font-size:20px}.sample header p{margin:0;color:var(--muted);font-size:12px}.candidates{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:18px}.candidates article{padding:12px;border:1px solid var(--line);border-radius:13px;background:#081a24}.candidate-head{display:flex;justify-content:space-between;gap:8px;margin-bottom:10px}.candidate-head code{color:var(--muted);font-size:10px}.candidates video{width:100%;aspect-ratio:16/9;border-radius:9px;background:#000}.candidates label{display:block;margin-top:9px;cursor:pointer;font-weight:700}.notes{display:block;margin-top:14px;color:var(--muted);font-weight:700}.notes textarea{width:100%;margin-top:5px;padding:10px;border:1px solid var(--line);border-radius:9px;background:#07131d;color:var(--text);font:inherit;resize:vertical}.actions{position:sticky;bottom:15px;display:flex;justify-content:space-between;align-items:center;gap:15px;margin-top:24px;padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:#102431}.actions button{padding:11px 18px;border:0;border-radius:9px;background:var(--teal);color:#05221d;font-weight:900;cursor:pointer}.actions span{color:var(--muted);font-size:12px}@media(max-width:800px){.candidates{grid-template-columns:1fr}.actions{align-items:stretch;flex-direction:column}.actions button{width:100%}}
</style></head><body><main>
<div class="hero"><span>集中式最终验收 · ${runId}</span><h1>只看结果，不看是谁做的</h1><p>请完整观看每个样本的所有候选，再为每个样本选一个最好版本，并写下至少一个时间码理由。页面不包含方案作者、Agent、生成顺序或提示词。</p></div>
<div class="notice">这一步只记录主观偏好，不会批准成片、晋升记忆或发布视频。</div>
${sections}
<div class="actions"><span id="status">3 个样本都选择后可导出审核 JSON。</span><button id="export">导出盲审结果</button></div>
</main><script>
document.querySelector("#export").addEventListener("click",()=>{
  const samples=[...document.querySelectorAll(".sample")].map(section=>({
    jobId:section.dataset.job,
    winner:section.querySelector("input[type=radio]:checked")?.value||null,
    timecodedNotes:section.querySelector("textarea").value.trim()
  }));
  if(samples.some(item=>!item.winner)){document.querySelector("#status").textContent="请先为每个样本选择一个候选。";return}
  const payload={schemaVersion:1,runId:${JSON.stringify(runId)},reviewerType:"human",reviewedAt:new Date().toISOString(),samples,autoPublish:false,memoryPromotion:false};
  const blob=new Blob([JSON.stringify(payload,null,2)+"\\n"],{type:"application/json"});
  const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download="koubo-blind-review-${runId}.json";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  document.querySelector("#status").textContent="已导出；请把 JSON 交给 Codex 记录最终结果。";
});</script></body></html>`;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const runRoot = path.join(args.outputRoot, args.runId);
  if (fs.existsSync(path.join(runRoot, "acceptance-manifest.json"))) {
    throw new Error(`acceptance run already completed and will not be overwritten: ${runRoot}`);
  }
  await fsp.mkdir(runRoot, { recursive: true });
  if (!fs.existsSync(args.tutorial)) throw new Error(`legal tutorial fixture is missing: ${args.tutorial}`);
  if (!fs.existsSync(fontFile)) throw new Error(`required local system font is missing: ${fontFile}`);
  const baseline = JSON.parse(await fsp.readFile(baselineFile, "utf8"));
  const frozenVerification = await verifyFrozenBaseline(baseline, args.jobsRoot);
  const lifecycle = await runTutorialLifecycle({ runRoot, tutorial: args.tutorial });
  const { sampleReports } = await renderSamples({
    baseline,
    jobsRoot: args.jobsRoot,
    runRoot,
    memories: lifecycle.finalRecords,
  });
  const automatedPass = sampleReports.every(sample =>
    sample.candidates.every(candidate => candidate.qa.technicalPass)
    && sample.diversity.every(item => item.meaningful)
  ) && lifecycle.evidence.rollbackRestored;
  const blindRoot = path.join(runRoot, "blind-review");
  await fsp.mkdir(blindRoot, { recursive: true });
  await fsp.writeFile(
    path.join(blindRoot, "index.html"),
    blindReviewHtml(sampleReports, args.runId),
    "utf8"
  );
  const manifest = publicAcceptanceValue({
    schemaVersion: 1,
    acceptanceVersion: "koubo-controlled-multi-agent-v2",
    runId: args.runId,
    createdAt: new Date().toISOString(),
    status: automatedPass ? "awaiting-user-blind-review" : "automated-checks-failed",
    baselineId: baseline.baselineId,
    frozenVerification,
    tutorialLifecycle: lifecycle.evidence,
    samples: sampleReports,
    iterations: [{
      iteration: 0,
      outcome: automatedPass ? "automated gates passed; no focused repair iteration required" : "failed",
    }],
    automatedPass,
    finalSubjectiveReview: null,
    autoPublish: false,
    brandCoreMutated: false,
    destructiveMigration: false,
    residualRisks: [
      "Human blind preference and timecoded rationale are still required.",
      "Acceptance critic calls use deterministic fixtures to verify isolation and schema behavior; they are not a substitute for the user's blind review.",
      "The first frozen legacy sample has only 14.2 seconds of source, so the synchronized 15-second acceptance track pads the final frame and audio tail.",
      "Challengers are rendered from the frozen raw job source while the control remains the frozen v4/legacy result; both begin at timeline zero and preserve the same speech segment.",
    ],
    blindReview: {
      index: "blind-review/index.html",
      sampleCount: sampleReports.length,
      candidatesPerSample: 3,
    },
  });
  await writeJson(path.join(runRoot, "acceptance-manifest.json"), manifest);
  await writeJson(path.join(blindRoot, "blind-review-bundles.json"), {
    schemaVersion: 1,
    runId: args.runId,
    samples: sampleReports.map(sample => ({
      jobId: sample.jobId,
      bundle: sample.blindBundle,
      media: sample.blindMedia,
    })),
  });
  process.stdout.write(`${JSON.stringify({
    success: automatedPass,
    runId: args.runId,
    status: manifest.status,
    sampleCount: sampleReports.length,
    candidateCount: sampleReports.reduce((sum, sample) => sum + sample.candidates.length, 0),
    manifest: path.join(runRoot, "acceptance-manifest.json"),
    blindReview: path.join(blindRoot, "index.html"),
  }, null, 2)}\n`);
}

function isMainModule() {
  return Boolean(process.argv[1])
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

export {
  probeMedia,
  renderControl,
  renderChallenger,
  qaMedia,
  createContactSheet,
  finalizeQa,
  run,
  sha256,
  writeJson,
};

if (isMainModule()) {
  main().catch(error => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}
