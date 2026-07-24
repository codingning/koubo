import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSoundSandbox,
  evaluateAbcSourceIdentity,
} from "../../video/multi-agent/sound-sandbox.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDir, "..", "..");

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-sound-sandbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function filesRecursively(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesRecursively(target) : [target];
  });
}

test("builds a deterministic offline sound recreation with measurable gates", {
  timeout: 120000,
}, async t => {
  const root = fixtureRoot(t);
  const first = await buildSoundSandbox({ outputDir: path.join(root, "first") });
  const second = await buildSoundSandbox({ outputDir: path.join(root, "second") });

  assert.equal(first.status, "recreated");
  assert.equal(first.technicalPass, true);
  assert.equal(second.status, "recreated");
  assert.equal(second.technicalPass, true);

  const firstHashes = readJson(first.hashesFile);
  const secondHashes = readJson(second.hashesFile);
  assert.deepEqual(firstHashes.files, secondHashes.files);
  assert.equal(fs.readFileSync(first.hashesFile, "utf8"), fs.readFileSync(second.hashesFile, "utf8"));

  const actualFiles = filesRecursively(first.outputDir)
    .filter(file => path.basename(file) !== "hashes.json")
    .map(file => path.relative(first.outputDir, file).replaceAll("\\", "/"))
    .sort();
  assert.deepEqual(firstHashes.files.map(item => item.path).sort(), actualFiles);
  for (const item of firstHashes.files) {
    const file = path.join(first.outputDir, ...item.path.split("/"));
    assert.equal(fs.statSync(file).size, item.bytes, item.path);
    assert.equal(sha256File(file), item.sha256, item.path);
  }

  const manifest = readJson(first.manifestFile);
  const qa = readJson(first.qaFile);
  const ledger = readJson(path.join(first.outputDir, "asset-ledger.json"));
  const audioRequest = readJson(path.join(first.outputDir, "audio_request.json"));
  const audioMeta = readJson(path.join(first.outputDir, "audio_meta.json"));
  const review = readJson(first.reviewFile);

  assert.equal(manifest.status, "recreated");
  assert.equal(manifest.knowledgeBoundary, "candidate-recreation-only");
  assert.equal(manifest.networkPolicy, "offline-local-assets-only");
  assert.equal(manifest.tutorialMediaCopied, false);
  assert.deepEqual(manifest.authority, {
    approvesProduction: false,
    changesProductionDefaults: false,
    invokesMemoryTransition: false,
    mutatesConfiguration: false,
    promotesKnowledge: false,
    publishes: false,
  });
  assert.deepEqual(manifest.variants.map(item => item.status), [
    "recreated", "recreated", "recreated", "recreated",
  ]);

  assert.equal(ledger.externalAssetCount, 0);
  assert.equal(ledger.tutorialMediaCopied, false);
  assert.equal(ledger.assets.every(item => item.source === "programmatic-local"), true);
  assert.equal(
    ledger.assets.every(item =>
      item.rightsBasis === "programmatic-original-no-third-party-input"
    ),
    true
  );
  assert.equal(audioRequest.restrictions.externalAssets, false);
  assert.equal(audioRequest.restrictions.productionUseAuthorized, false);
  assert.equal(audioMeta.generator.deterministic, true);

  const serializedContracts = JSON.stringify({
    manifest,
    qa,
    ledger,
    audioRequest,
    audioMeta,
    review,
  });
  assert.equal(/https?:\/\//u.test(serializedContracts), false);
  assert.equal(serializedContracts.includes("douyin.com"), false);

  const abc = manifest.variants.filter(item => ["A", "B", "C"].includes(item.id));
  assert.equal(abc.length, 3);
  const identity = evaluateAbcSourceIdentity(abc);
  assert.equal(identity.pass, true);
  assert.equal(qa.abcComparison.pass, true);
  assert.equal(qa.abcComparison.sameSourceHashes, true);
  assert.equal(qa.abcComparison.sameTimelineHash, true);
  assert.equal(qa.abcComparison.timeAligned, true);
  assert.equal(new Set(abc.map(item => item.sourceVoiceSha256)).size, 1);
  assert.equal(new Set(abc.map(item => item.sourceBgmSha256)).size, 1);
  assert.equal(new Set(abc.map(item => item.timelineHash)).size, 1);

  const tamperedBgm = structuredClone(abc);
  tamperedBgm[1].sourceBgmSha256 = "f".repeat(64);
  assert.equal(evaluateAbcSourceIdentity(tamperedBgm).pass, false);
  const tamperedTimeline = structuredClone(abc);
  tamperedTimeline[2].timelineHash = "e".repeat(64);
  assert.equal(evaluateAbcSourceIdentity(tamperedTimeline).pass, false);
  const tamperedTiming = structuredClone(abc);
  tamperedTiming[0].mediaTiming.mp4.startTimeSeconds = 0.25;
  assert.equal(evaluateAbcSourceIdentity(tamperedTiming).pass, false);

  assert.ok(qa.abcComparison.maximumWavLoudnessDeltaLu <= 0.35);
  assert.ok(qa.abcComparison.maximumMp4LoudnessDeltaLu <= 0.45);
  for (const id of ["A", "B", "C", "S"]) {
    const item = qa.variants[id];
    assert.equal(item.passed, true, id);
    assert.equal(Object.values(item.checks).every(Boolean), true, id);
    assert.ok(Math.abs(item.wav.loudness.integratedLufs + 16) <= 0.35, id);
    assert.ok(Math.abs(item.mp4.loudness.integratedLufs + 16) <= 0.45, id);
    assert.ok(item.wav.loudness.truePeakDbtp <= -1.5, id);
    assert.ok(item.mp4.loudness.truePeakDbtp <= -1.5, id);
    assert.equal(item.wav.decode.ok, true, id);
    assert.equal(item.mp4.decode.ok, true, id);
    assert.equal(item.mp4.probe.video.codec, "h264", id);
    assert.equal(item.mp4.probe.audio.codec, "aac", id);
    assert.equal(item.mp4.probe.video.pixelFormat, "yuv420p", id);
  }

  assert.ok(qa.ducking.B.estimatedReductionDb >= 3);
  assert.ok(qa.ducking.B.estimatedReductionDb <= 8);
  assert.equal(qa.ducking.reductionMeasurement, "active-window-rms-difference-estimate");
  assert.ok(qa.spectralSlot.reductionDb >= 2.5);
  assert.equal(
    qa.spectralSlot.analysis.candidateCentersHz.includes(qa.spectralSlot.measuredCenterHz),
    true
  );
  assert.notEqual(qa.spectralSlot.measuredCenterHz, 300);
  assert.equal(qa.spectralSlot.parameters.selectionMethod, "active-window-biquad-band-energy-v1");

  assert.equal(qa.semanticCues.maximumConcurrentCues, 1);
  assert.ok(qa.semanticCues.minimumSpacingMs >= qa.semanticCues.gates.minimumSpacingMs);
  assert.ok(qa.semanticCues.maximumDurationMs <= qa.semanticCues.gates.maximumDurationMs);
  assert.deepEqual(
    qa.semanticCues.anchors.map(item => item.cueType),
    ["semantic-turn", "visual-impact", "transition-cut"]
  );
  assert.equal(qa.semanticCues.gates.mustAddNewMeaning, true);

  assert.equal(review.rejectAllAllowed, true);
  assert.equal(review.decisionOptions.includes("reject-all"), true);
  assert.equal(review.authority.autoApprove, false);
  assert.equal(review.authority.autoPublish, false);
  assert.equal(review.authority.autoPromoteMemory, false);

  const source = fs.readFileSync(
    path.join(repositoryRoot, "video", "multi-agent", "sound-sandbox.mjs"),
    "utf8"
  );
  assert.equal(source.includes("memory.transition"), false);
  assert.equal(source.includes("config/video_workflow"), false);
});

test("sound recreation CLI rejects output outside the assigned cache root", t => {
  const root = fixtureRoot(t);
  const outside = path.join(root, "outside-sound");
  const script = path.join(
    repositoryRoot,
    "scripts",
    "recreate_sound_training_batch_1.mjs"
  );
  const result = spawnSync(process.execPath, [script, "--output", outside], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(String(result.stderr || result.stdout), /must be a child/i);
  assert.equal(fs.existsSync(outside), false);
});
