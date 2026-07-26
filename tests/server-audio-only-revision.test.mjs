import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  createVisualWorkflowState,
  loadVisualWorkflowDefaults,
  normalizeVisualWorkflowConfig,
} from "../video/visual_director.mjs";

const root = process.cwd();
const jobId = `audio-only-revision-${process.pid}-${Date.now()}`;
const jobDir = path.join(root, "video-jobs", jobId);
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${jobId}-multi-agent-`));
process.env.KOUBO_NO_LISTEN = "1";
process.env.KOUBO_MULTI_AGENT_DATA_ROOT = dataRoot;

const serverModule = await import(`../video/server.mjs?audio-only-revision-test=${Date.now()}`);
const {
  buildAssetDecisionSnapshot,
  closeServerResourcesForTests,
  finalReviewEvidenceHash,
  finalReviewRecordHash,
  hasAudioOnlyRevisionIntent,
  httpServerForTests,
  parseAudioOnlyRevisionFeedback,
} = serverModule;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout || `${command} failed`);
  return result;
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function probe(file) {
  const raw = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]).stdout);
  const video = raw.streams.find(stream => stream.codec_type === "video");
  const audio = raw.streams.find(stream => stream.codec_type === "audio");
  const [fpsNumerator, fpsDenominator] = String(video.avg_frame_rate || video.r_frame_rate || "0/1").split("/").map(Number);
  return {
    duration: Number(raw.format.duration || video.duration || 0),
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    fps: fpsDenominator ? fpsNumerator / fpsDenominator : 0,
    videoCodec: video.codec_name,
    pixelFormat: video.pix_fmt,
    colorRange: video.color_range,
    colorSpace: video.color_space,
    colorTransfer: video.color_transfer,
    colorPrimaries: video.color_primaries,
    audioCodec: audio?.codec_name || null,
    hasAudio: !!audio,
    sizeBytes: Number(raw.format.size || 0),
  };
}

function videoHash(file, decoded = false) {
  const args = decoded
    ? ["-v", "error", "-i", file, "-map", "0:v:0", "-an", "-c:v", "rawvideo", "-pix_fmt", "yuv420p", "-f", "hash", "-hash", "sha256", "-"]
    : ["-v", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "streamhash", "-hash", "sha256", "-"];
  const output = run("ffmpeg", args).stdout;
  const match = output.match(/SHA256=([a-f0-9]{64})/i);
  assert.ok(match, output);
  return match[1].toLowerCase();
}

function videoPacketTimingHash(file) {
  const output = run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "packet=pts_time,dts_time,duration_time,flags",
    "-of", "csv=p=0",
    file,
  ]).stdout.replace(/\r\n/g, "\n");
  return sha256Buffer(Buffer.from(output));
}

function loudness(file) {
  const result = run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-filter_complex", "ebur128=peak=true", "-f", "null", "-"]);
  const integrated = [...result.stderr.matchAll(/I:\s*(-?[0-9.]+)\s+LUFS/g)].at(-1);
  const peak = [...result.stderr.matchAll(/Peak:\s*(-?[0-9.]+)\s+dBFS/g)].at(-1);
  assert.ok(integrated && peak, result.stderr);
  return { integratedLufs: Number(integrated[1]), truePeakDbfs: Number(peak[1]) };
}

async function post(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function waitForRevision() {
  const jobFile = path.join(jobDir, "job.json");
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const job = JSON.parse(await fsp.readFile(jobFile, "utf8"));
    if (job.status === "error") throw new Error(job.error || job.errorDetail || "audio-only revision failed");
    if (job.status === "awaiting_review" && Number(job.output?.version) === 3) return job;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("audio-only revision timed out");
}

async function waitForRollback() {
  const jobFile = path.join(jobDir, "job.json");
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = JSON.parse(await fsp.readFile(jobFile, "utf8"));
    if (job.revisionError && job.status === "approved" && Number(job.output?.version) === 2) return job;
    if (job.status === "error") throw new Error(job.error || job.errorDetail || "audio-only rollback failed");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("audio-only rollback timed out");
}

test.after(async () => {
  await closeServerResourcesForTests();
  fs.rmSync(jobDir, { recursive: true, force: true });
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("audio-only feedback classifier fails closed", () => {
  const accepted = parseAudioOnlyRevisionFeedback("只把整条人声响度调整到约 -16 LUFS、真峰值不高于 -1.5 dBTP；画面、字幕、动效、时间线和素材全部保持不变。");
  assert.deepEqual(accepted, {
    mode: "audio-only",
    loudnessLufs: -16,
    truePeakDbtp: -1.5,
    feedback: "只把整条人声响度调整到约 -16 LUFS、真峰值不高于 -1.5 dBTP;画面、字幕、动效、时间线和素材全部保持不变。",
  });
  for (const feedback of [
    "声音小一点",
    "把人声调到 -16 LUFS，真峰值 -1.5 dBTP",
    "只改音频，顺便把字幕放大；画面、字幕、动效、时间线和素材全部保持不变，目标 -16 LUFS / -1.5 dBTP",
    "只把第 10 秒提示音调大到 -16 LUFS，真峰值 -1.5 dBTP；画面、字幕、动效、时间线和素材全部保持不变",
    "只改响度到 -16 LUFS；画面、字幕、动效、时间线和素材全部保持不变",
    "只改人声响度到 -16 LUFS，真峰值不低于 -1.5 dBTP；画面、字幕、动效、时间线和素材全部保持不变",
    "只改人声响度到 -80 LUFS，真峰值不高于 -1.5 dBTP；画面、字幕、动效、时间线和素材全部保持不变",
    "只把人声响度调整到 -16 LUFS，真峰值不高于 -1.5 dBTP；画面、字幕加粗、动效、时间线和素材全部保持不变",
  ]) assert.equal(parseAudioOnlyRevisionFeedback(feedback), null, feedback);
  assert.equal(hasAudioOnlyRevisionIntent("只把字幕放大，音频保持不变"), false);
  assert.equal(hasAudioOnlyRevisionIntent("只把动效加快，音量不要变"), false);
  assert.equal(hasAudioOnlyRevisionIntent("只把音频调到 -16 LUFS，其他都别动"), true);
});

test("visual-director revise creates a pending audio-only v3 while preserving approved v2 evidence", async () => {
  await fsp.mkdir(jobDir, { recursive: true });
  const v2Path = path.join(jobDir, "final-v2.mp4");
  run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-filter_complex", "[1:a]volume=0.4,pan=stereo|c0=c0|c1=c0[a]",
    "-map", "0:v:0", "-map", "[a]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
    "-c:a", "aac", "-b:a", "192k", "-shortest", v2Path,
  ]);
  const metadata = probe(v2Path);
  const previewV2 = path.join(jobDir, "review-preview-v2.mp4");
  await fsp.copyFile(v2Path, previewV2);
  const v2MediaHash = sha256(v2Path);
  const manifestV2 = {
    version: 2,
    policy: "rich-media-first-user-approved",
    review: { total: 0, pending: 0, approved: 0, rejected: 0, reviewComplete: true, renderReady: true, complianceIssues: [] },
    assets: [],
    renderedAssetIds: [],
    attributionTrack: null,
  };
  const bundleV2 = {
    version: 2,
    mode: "full-preview-with-context-segments",
    preview: { path: previewV2, url: `/video-jobs/${jobId}/review-preview-v2.mp4`, metadata },
    segments: [],
    highResolutionMasterRetained: true,
    finalApprovalHeld: true,
    autoPublish: false,
  };
  await fsp.writeFile(path.join(jobDir, "media-manifest-v2.json"), JSON.stringify(manifestV2, null, 2));
  await fsp.writeFile(path.join(jobDir, "review-bundle-v2.json"), JSON.stringify(bundleV2, null, 2));
  await fsp.writeFile(path.join(jobDir, "edit-plan-v2.json"), JSON.stringify({ version: 2 }, null, 2));
  const timelineV2 = {
    version: 2,
    source: { path: v2Path, duration: metadata.duration, width: metadata.width, height: metadata.height, fps: metadata.fps },
    outputDuration: metadata.duration,
    provenance: "semantic",
    engine: "fixture",
    validated: true,
    warnings: [],
    clips: [{ id: "clip-001", sourceIn: 0, sourceOut: metadata.duration, outputIn: 0, outputOut: metadata.duration, duration: metadata.duration, reason: "保留全部" }],
    removed: [],
    cards: [],
    generatedAt: "2026-07-26T00:00:00.000Z",
  };
  await fsp.writeFile(path.join(jobDir, "timeline-v2.json"), JSON.stringify(timelineV2, null, 2));
  const finalReviewBase = {
    status: "approved",
    version: 2,
    workflowStageVersion: 1,
    mediaSha256: v2MediaHash,
    reviewBundle: {
      url: `/video-jobs/${jobId}/review-bundle-v2.json`,
      sha256: sha256(path.join(jobDir, "review-bundle-v2.json")),
      previewUrl: bundleV2.preview.url,
      previewSha256: sha256(previewV2),
    },
    mediaManifest: {
      url: `/video-jobs/${jobId}/media-manifest-v2.json`,
      sha256: sha256(path.join(jobDir, "media-manifest-v2.json")),
    },
    ordinaryViewerAudit: null,
    qaPass: true,
    mediaReview: manifestV2.review,
    renderedAssetIds: [],
    approvedAt: "2026-07-26T00:00:00.000Z",
    autoPublish: false,
  };
  let finalReviewWithEvidence = { ...finalReviewBase, evidenceHash: finalReviewEvidenceHash(finalReviewBase) };
  let finalReviewV2 = { ...finalReviewWithEvidence, recordHash: finalReviewRecordHash(finalReviewWithEvidence) };
  await fsp.writeFile(path.join(jobDir, "final-review-v2.json"), JSON.stringify(finalReviewV2, null, 2));

  const defaults = await loadVisualWorkflowDefaults(root);
  const config = normalizeVisualWorkflowConfig(defaults, {
    rendering: { final: { loudnessTarget: "-16 LUFS", truePeakTarget: "-1.5 dBTP" } },
  });
  const workflow = createVisualWorkflowState(config);
  for (const id of ["style_research", "content_breakdown", "keyframes", "keyframe_review"]) {
    workflow.stages[id].status = "approved";
    workflow.stages[id].currentVersion = 1;
    workflow.stages[id].approvedVersion = 1;
  }
  workflow.currentStage = "full_render";

  const outputV2 = {
    version: 2,
    workflowStageVersion: 1,
    workflowDependencies: { keyframeVersion: 1, motionSampleVersion: 1, assetDecisionVersion: 1 },
    path: v2Path,
    url: `/video-jobs/${jobId}/final-v2.mp4`,
    thumbnailUrl: `/video-jobs/${jobId}/thumbnail-v2.jpg`,
    metadata,
    qa: { decodes: true },
    qaPass: true,
    provenance: "semantic",
    planEngine: "fixture",
    packaging: { requested: "hyperframes", engine: "hyperframes", project: "workflow/full-v2", cards: 0, panels: 0 },
    captionPackaging: { requested: "none", engine: "none", integrated: true, safeArea: true },
    cover: { requested: false, available: false, engine: "none", fallbackReason: null },
    colorManagement: { input: "sdr-or-unknown", output: "sdr-bt709", engine: "metadata-normalization", filter: "format=yuv420p" },
    variants: {},
    reviewBundle: bundleV2,
    media: { policy: manifestV2.policy, approvedAssets: 0 },
    artifacts: {
      editPlan: `/video-jobs/${jobId}/edit-plan-v2.json`,
      timeline: `/video-jobs/${jobId}/timeline-v2.json`,
      qa: `/video-jobs/${jobId}/qa-report-v2.json`,
      mediaManifest: `/video-jobs/${jobId}/media-manifest-v2.json`,
      reviewBundle: `/video-jobs/${jobId}/review-bundle-v2.json`,
      reviewPreview: bundleV2.preview.url,
      fullDirection: `/video-jobs/${jobId}/full-video-direction-v1.json`,
      hyperframesProject: `/video-jobs/${jobId}/workflow/full-v2/index.html`,
      hyperframesManifest: `/video-jobs/${jobId}/workflow/full-v2/composition-manifest.json`,
      finalReview: `/video-jobs/${jobId}/final-review-v2.json`,
    },
    createdAt: "2026-07-26T00:00:00.000Z",
    model: "fixture",
    mediaSha256: v2MediaHash,
    finalReview: { ...finalReviewV2, url: `/video-jobs/${jobId}/final-review-v2.json` },
  };
  const job = {
    id: jobId,
    pipeline: "visual-director-v4",
    status: "approved",
    progress: 100,
    sourcePath: v2Path,
    source: metadata,
    script: "测试音频专用返修",
    transcript: { text: "测试音频专用返修", segments: [{ start: 0, end: metadata.duration, text: "测试音频专用返修" }], words: [] },
    currentPlan: {
      version: 2,
      keepSegments: [{ start: 0, end: metadata.duration, reason: "保留全部" }],
      overlayCards: [],
      provenance: "semantic",
      engine: "fixture",
      validated: true,
      warnings: [],
    },
    currentVersion: 2,
    options: { captions: false, generateVariants: false, generateCover: false, layout: "original", autoPublish: false },
    assets: [],
    assetDecisionVersion: 1,
    assetDecisions: [{ eventType: "asset-catalog-empty", decisionVersion: 1, decidedAt: "2026-07-26T00:00:00.000Z" }],
    workflow,
    versions: [outputV2],
    output: outputV2,
    reviews: [],
    approvedAt: finalReviewV2.approvedAt,
    autoPublish: false,
  };
  await fsp.writeFile(path.join(jobDir, "asset-decisions.json"), JSON.stringify(job.assetDecisions, null, 2));
  const snapshot = await buildAssetDecisionSnapshot(job);
  const snapshotName = "motion-sample-asset-snapshot-v1.json";
  const snapshotFile = path.join(jobDir, snapshotName);
  await fsp.writeFile(snapshotFile, JSON.stringify(snapshot, null, 2));
  manifestV2.motionSampleAssetSnapshot = {
    decisionVersion: snapshot.decisionVersion,
    snapshotHash: snapshot.snapshotHash,
    artifactSha256: sha256(snapshotFile),
  };
  await fsp.writeFile(path.join(jobDir, "media-manifest-v2.json"), JSON.stringify(manifestV2, null, 2));
  finalReviewBase.mediaManifest.sha256 = sha256(path.join(jobDir, "media-manifest-v2.json"));
  finalReviewWithEvidence = { ...finalReviewBase, evidenceHash: finalReviewEvidenceHash(finalReviewBase) };
  finalReviewV2 = { ...finalReviewWithEvidence, recordHash: finalReviewRecordHash(finalReviewWithEvidence) };
  await fsp.writeFile(path.join(jobDir, "final-review-v2.json"), JSON.stringify(finalReviewV2, null, 2));
  outputV2.finalReview = { ...finalReviewV2, url: `/video-jobs/${jobId}/final-review-v2.json` };
  outputV2.artifacts.finalReview = `/video-jobs/${jobId}/final-review-v2.json`;
  job.approvedAt = finalReviewV2.approvedAt;
  workflow.stages.motion_sample.status = "approved";
  workflow.stages.motion_sample.currentVersion = 1;
  workflow.stages.motion_sample.approvedVersion = 1;
  workflow.stages.motion_sample.artifacts = { assetSnapshot: snapshot, assetSnapshotFile: snapshotName, assetSnapshotSha256: sha256(snapshotFile) };
  workflow.stages.motion_sample.runs = [{ version: 1, status: "completed", artifacts: workflow.stages.motion_sample.artifacts }];
  workflow.stages.full_render.status = "approved";
  workflow.stages.full_render.currentVersion = 1;
  workflow.stages.full_render.approvedVersion = 1;
  workflow.stages.full_render.approvedOutputVersion = 2;
  workflow.stages.full_render.artifacts = { output: outputV2 };
  workflow.stages.full_render.runs = [{ version: 1, status: "completed", artifacts: { output: outputV2 } }];
  await fsp.writeFile(path.join(jobDir, "job.json"), JSON.stringify(job, null, 2));
  await fsp.writeFile(path.join(jobDir, "final-review.json"), JSON.stringify(finalReviewV2, null, 2));
  await fsp.copyFile(v2Path, path.join(jobDir, "final.mp4"));

  const immutableV2Files = ["final-v2.mp4", "final-review-v2.json", "review-bundle-v2.json", "review-preview-v2.mp4", "media-manifest-v2.json", "edit-plan-v2.json", "timeline-v2.json"];
  const beforeHashes = Object.fromEntries(immutableV2Files.map(name => [name, sha256(path.join(jobDir, name))]));

  await new Promise((resolve, reject) => {
    httpServerForTests.once("error", reject);
    httpServerForTests.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${httpServerForTests.address().port}`;
  const feedback = "只把整条人声响度调整到约 -16 LUFS、真峰值不高于 -1.5 dBTP；画面、字幕、动效、时间线和素材全部保持不变。";
  const ambiguousFeedback = "只把音频调到 -16 LUFS，其他都别动";
  const ambiguous = await post(baseUrl, `/api/jobs/${jobId}/revise`, { expectedVersion: 2, feedback: ambiguousFeedback });
  assert.equal(ambiguous.response.status, 400, JSON.stringify(ambiguous.payload));
  assert.match(ambiguous.payload.error, /安全旁路格式/);
  const unsupportedFeedback = "只把整条人声响度调整到约 -18 LUFS、真峰值不高于 -1.5 dBTP；画面、字幕、动效、时间线和素材全部保持不变。";
  const unsupported = await post(baseUrl, `/api/jobs/${jobId}/revise`, { expectedVersion: 2, feedback: unsupportedFeedback });
  assert.equal(unsupported.response.status, 409, JSON.stringify(unsupported.payload));
  const unchangedAfterUnsupported = JSON.parse(await fsp.readFile(path.join(jobDir, "job.json"), "utf8"));
  assert.equal(unchangedAfterUnsupported.output.version, 2);
  assert.equal(unchangedAfterUnsupported.currentVersion, 2);
  assert.equal(unchangedAfterUnsupported.workflow.stages.full_render.status, "approved");
  assert.equal(unchangedAfterUnsupported.workflow.stages.full_render.currentVersion, 1);
  assert.equal(unchangedAfterUnsupported.approvedAt, finalReviewV2.approvedAt);
  assert.equal(sha256(path.join(jobDir, "final.mp4")), v2MediaHash);
  assert.equal(sha256(path.join(jobDir, "final-review.json")), sha256(path.join(jobDir, "final-review-v2.json")));
  assert.equal(fs.existsSync(path.join(jobDir, "final-v3.mp4")), false);

  const qaFailureFixture = JSON.parse(await fsp.readFile(path.join(jobDir, "job.json"), "utf8"));
  qaFailureFixture.output.cover = { requested: true, available: false, engine: "failed", fallbackReason: "fixture" };
  qaFailureFixture.versions[0].cover = structuredClone(qaFailureFixture.output.cover);
  delete qaFailureFixture.revisionError;
  delete qaFailureFixture.errorDetail;
  await fsp.writeFile(path.join(jobDir, "job.json"), JSON.stringify(qaFailureFixture, null, 2));
  const qaFailure = await post(baseUrl, `/api/jobs/${jobId}/revise`, { expectedVersion: 2, feedback });
  assert.equal(qaFailure.response.status, 202, JSON.stringify(qaFailure.payload));
  const rolledBackAfterQa = await waitForRollback();
  assert.match(rolledBackAfterQa.revisionError, /未通过响度、真峰值或媒体 QA/);
  assert.equal(rolledBackAfterQa.status, "approved");
  assert.equal(rolledBackAfterQa.approvedAt, finalReviewV2.approvedAt);
  assert.equal(rolledBackAfterQa.workflow.stages.full_render.status, "approved");
  assert.equal(rolledBackAfterQa.workflow.stages.full_render.currentVersion, 1);
  assert.equal(fs.existsSync(path.join(jobDir, "final-v3.mp4")), false);
  assert.equal(fs.existsSync(path.join(jobDir, "thumbnail-v3.jpg")), false);
  assert.equal(fs.existsSync(path.join(jobDir, "timeline-v3.json")), false);
  assert.equal(fs.existsSync(path.join(jobDir, "media-manifest-v3.json")), false);
  assert.equal(fs.existsSync(path.join(jobDir, "qa-report-v3.json")), false);
  assert.equal(sha256(path.join(jobDir, "final.mp4")), v2MediaHash);
  assert.equal(sha256(path.join(jobDir, "final-review.json")), sha256(path.join(jobDir, "final-review-v2.json")));

  const successFixture = JSON.parse(await fsp.readFile(path.join(jobDir, "job.json"), "utf8"));
  successFixture.output.cover = { requested: false, available: false, engine: "none", fallbackReason: null };
  successFixture.versions[0].cover = structuredClone(successFixture.output.cover);
  delete successFixture.revisionError;
  delete successFixture.errorDetail;
  await fsp.writeFile(path.join(jobDir, "job.json"), JSON.stringify(successFixture, null, 2));

  const started = await post(baseUrl, `/api/jobs/${jobId}/revise`, { expectedVersion: 2, feedback });
  assert.equal(started.response.status, 202, JSON.stringify(started.payload));
  const revised = await waitForRevision();
  const v3Path = path.join(jobDir, "final-v3.mp4");
  assert.equal(fs.existsSync(v3Path), true);
  assert.equal(videoHash(v2Path), videoHash(v3Path));
  assert.equal(videoHash(v2Path, true), videoHash(v3Path, true));
  assert.equal(videoPacketTimingHash(v2Path), videoPacketTimingHash(v3Path));
  assert.notEqual(sha256(v2Path), sha256(v3Path));
  const measured = loudness(v3Path);
  assert.ok(Math.abs(measured.integratedLufs + 16) <= 0.3, JSON.stringify(measured));
  assert.ok(measured.truePeakDbfs <= -1.4, JSON.stringify(measured));
  assert.equal(revised.output.version, 3);
  assert.equal(revised.currentVersion, 3);
  assert.equal(revised.status, "awaiting_review");
  assert.equal(Object.hasOwn(revised, "approvedAt"), false);
  assert.equal(revised.autoPublish, false);
  assert.equal(revised.revisionError, undefined);
  assert.equal(revised.output.finalReview, undefined);
  assert.equal(revised.output.mediaSha256, undefined);
  assert.equal(revised.output.ordinaryViewerAudit, undefined);
  assert.equal(revised.versions.length, 2);
  assert.equal(revised.versions[0].version, 2);
  assert.equal(revised.versions[0].finalReview.status, "approved");
  assert.equal(revised.versions[1].version, 3);
  assert.equal(revised.workflow.stages.full_render.currentVersion, 2);
  assert.equal(revised.workflow.stages.full_render.status, "awaiting_review");
  assert.equal(revised.workflow.stages.full_render.approvedVersion, null);
  assert.equal(revised.workflow.stages.full_render.runs.at(-1).artifacts.output.version, 3);
  assert.equal(revised.reviews.at(-1).version, 2);
  assert.equal(revised.reviews.at(-1).mediaSha256, v2MediaHash);
  assert.equal(revised.reviews.at(-1).feedback, feedback);
  assert.equal(fs.existsSync(path.join(jobDir, "final-review-v3.json")), false);
  assert.equal(fs.existsSync(path.join(jobDir, "workflow", "full-v3")), false);
  assert.equal(fs.existsSync(path.join(jobDir, "full-video-direction-v2.json")), false);
  const pendingReview = JSON.parse(await fsp.readFile(path.join(jobDir, "final-review.json"), "utf8"));
  assert.equal(pendingReview.status, "pending");
  assert.equal(pendingReview.version, 3);
  assert.equal(pendingReview.previousApprovedVersion, 2);
  for (const name of immutableV2Files) assert.equal(sha256(path.join(jobDir, name)), beforeHashes[name], name);

  for (const [version, file] of [[2, v2Path], [3, v3Path]]) {
    const response = await fetch(`${baseUrl}/video-jobs/${jobId}/final-v${version}.mp4`);
    assert.equal(response.status, 200);
    assert.equal(sha256Buffer(Buffer.from(await response.arrayBuffer())), sha256(file));
  }
  const staleApprove = await post(baseUrl, `/api/jobs/${jobId}/approve`, { expectedVersion: 2 });
  assert.equal(staleApprove.response.status, 409);
  const staleRevise = await post(baseUrl, `/api/jobs/${jobId}/revise`, { expectedVersion: 2, feedback });
  assert.equal(staleRevise.response.status, 409);
  const approvedV3 = await post(baseUrl, `/api/jobs/${jobId}/approve`, { expectedVersion: 3 });
  assert.equal(approvedV3.response.status, 200, JSON.stringify(approvedV3.payload));
  assert.equal(approvedV3.payload.job.status, "approved");
  assert.equal(approvedV3.payload.job.autoPublish, false);
  const finalReviewV3Path = path.join(jobDir, "final-review-v3.json");
  const finalReviewV3 = JSON.parse(await fsp.readFile(finalReviewV3Path, "utf8"));
  assert.equal(finalReviewV3.status, "approved");
  assert.equal(finalReviewV3.version, 3);
  assert.equal(finalReviewV3.autoPublish, false);
  assert.equal(finalReviewEvidenceHash(finalReviewV3), finalReviewV3.evidenceHash);
  assert.equal(finalReviewRecordHash(finalReviewV3), finalReviewV3.recordHash);
  assert.equal(finalReviewV3.mediaSha256, sha256(v3Path));
  assert.equal(finalReviewV3.reviewBundle.sha256, sha256(path.join(jobDir, "review-bundle-v3.json")));
  assert.equal(finalReviewV3.reviewBundle.previewSha256, sha256(path.join(jobDir, "review-preview-v3.mp4")));
  assert.equal(finalReviewV3.mediaManifest.sha256, sha256(path.join(jobDir, "media-manifest-v3.json")));
  for (const name of immutableV2Files) assert.equal(sha256(path.join(jobDir, name)), beforeHashes[name], name);
});
