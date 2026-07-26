import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const suiteId = `asset-snapshot-${process.pid}-${Date.now()}`;
const createdJobDirs = [];
const multiAgentRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${suiteId}-multi-agent-`));
process.env.KOUBO_NO_LISTEN = "1";
process.env.KOUBO_MULTI_AGENT_DATA_ROOT = multiAgentRoot;

const serverModule = await import(`../video/server.mjs?asset-snapshot-test=${Date.now()}`);
const {
  appendAssetDecisionAudit,
  assertMotionSampleAssetSnapshotCurrent,
  assetDecisionAuditEntry,
  autoReviewLocalAssetsForPreview,
  buildAssetDecisionSnapshot,
  closeServerResourcesForTests,
  httpServerForTests,
} = serverModule;

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function stage(overrides = {}) {
  return {
    status: "pending",
    currentVersion: 0,
    approvedVersion: null,
    artifacts: null,
    runs: [],
    ...overrides,
  };
}

function workflowWithReviewedSample() {
  return {
    version: "visual-director-v4",
    currentStage: "motion_sample",
    stages: {
      style_research: stage({ status: "completed", currentVersion: 1 }),
      content_breakdown: stage({ status: "completed", currentVersion: 1 }),
      keyframes: stage({ status: "approved", currentVersion: 2, approvedVersion: 2, artifacts: { frames: [{ id: "KF01" }] } }),
      keyframe_review: stage({ status: "approved", currentVersion: 2, approvedVersion: 2, artifacts: { frames: [{ id: "KF01" }] } }),
      motion_sample: stage({ status: "awaiting_review", currentVersion: 3, artifacts: { url: "/sample-v3.mp4" } }),
      full_render: stage({ status: "approved", currentVersion: 4, approvedVersion: 4, artifacts: { output: { version: 5 } } }),
    },
    audit: [],
  };
}

async function createJobDir(jobId) {
  const jobDir = path.join(root, "video-jobs", jobId);
  createdJobDirs.push(jobDir);
  await fsp.mkdir(jobDir, { recursive: true });
  return jobDir;
}

function reviewedAsset(id, file, placement = { start: 1.25, end: 4.75, mode: "broll" }) {
  return {
    id,
    fileName: `${id}.mp4`,
    path: file,
    url: `/video-jobs/test/${id}.mp4`,
    sourceType: "local-upload",
    mediaKind: "video",
    reviewStatus: "approved",
    approved: true,
    placement,
    clipStart: 0,
    clipEnd: null,
    clipDuration: null,
    licenseBasis: "user-owned-local",
    usagePurpose: "本地证据",
    paymentConfirmed: true,
  };
}

function baseJob(jobId, assets = []) {
  return {
    id: jobId,
    pipeline: "visual-director-v4",
    status: "awaiting_sample_review",
    progress: 78,
    source: { duration: 8 },
    currentPlan: { keepSegments: [{ start: 0, end: 8 }] },
    assets,
    assetDecisions: [],
    workflow: workflowWithReviewedSample(),
  };
}

async function persistJob(jobDir, job) {
  await fsp.writeFile(path.join(jobDir, "job.json"), JSON.stringify(job, null, 2));
}

async function postJson(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test.after(async () => {
  await closeServerResourcesForTests();
  for (const jobDir of createdJobDirs) fs.rmSync(jobDir, { recursive: true, force: true });
  fs.rmSync(multiAgentRoot, { recursive: true, force: true });
});

test("motion sample snapshot freezes decision version, approved ids, file hashes, and placement", async () => {
  const jobId = `${suiteId}-freeze`;
  const jobDir = await createJobDir(jobId);
  const approvedFile = path.join(jobDir, "approved.mp4");
  const rejectedFile = path.join(jobDir, "rejected.mp4");
  await fsp.writeFile(approvedFile, "approved-asset-v1");
  await fsp.writeFile(rejectedFile, "rejected-asset-v1");
  const approved = reviewedAsset("asset-approved", approvedFile);
  const rejected = { ...reviewedAsset("asset-rejected", rejectedFile, { start: 5, end: 7, mode: "pip" }), reviewStatus: "rejected", approved: false };
  const job = baseJob(jobId, [approved, rejected]);
  const auditEntries = await Promise.all([
    assetDecisionAuditEntry(approved, { eventType: "asset-approved", reason: "fixture approval" }),
    assetDecisionAuditEntry(rejected, { eventType: "asset-rejected", reason: "fixture rejection" }),
  ]);
  appendAssetDecisionAudit(job, auditEntries, { invalidateSampleReview: false });
  await fsp.writeFile(path.join(jobDir, "asset-decisions.json"), JSON.stringify(job.assetDecisions, null, 2));

  const snapshot = await buildAssetDecisionSnapshot(job);
  assert.equal(snapshot.decisionVersion, 1);
  assert.deepEqual(snapshot.approvedAssetIds, ["asset-approved"]);
  assert.equal(snapshot.assets[0].fileSha256, sha256(approvedFile));
  assert.deepEqual(snapshot.assets[0].placement, { start: 1.25, end: 4.75, mode: "broll" });
  assert.match(snapshot.snapshotHash, /^[a-f0-9]{64}$/);

  const snapshotFileName = "motion-sample-asset-snapshot-v3.json";
  const snapshotFile = path.join(jobDir, snapshotFileName);
  await fsp.writeFile(snapshotFile, JSON.stringify(snapshot, null, 2));
  job.workflow.stages.motion_sample.artifacts = {
    url: "/sample-v3.mp4",
    assetSnapshot: snapshot,
    assetSnapshotFile: snapshotFileName,
    assetSnapshotSha256: sha256(snapshotFile),
  };
  await persistJob(jobDir, job);

  const verified = await assertMotionSampleAssetSnapshotCurrent(job);
  assert.equal(verified.snapshotHash, snapshot.snapshotHash);

  await fsp.writeFile(approvedFile, "approved-asset-v2-tampered");
  await assert.rejects(assertMotionSampleAssetSnapshotCurrent(job), /文件哈希/);
  await fsp.writeFile(approvedFile, "approved-asset-v1");

  approved.placement = { start: 1.5, end: 4.75, mode: "broll" };
  await assert.rejects(assertMotionSampleAssetSnapshotCurrent(job), /缺少当前状态的 asset-decisions 审计记录/);
  approved.placement = { start: 1.25, end: 4.75, mode: "broll" };

  await fsp.rm(path.join(jobDir, "asset-decisions.json"));
  await assert.rejects(assertMotionSampleAssetSnapshotCurrent(job), /缺少 asset-decisions\.json/);
});

test("preview auto review backfills missing decision audit before snapshot creation", async () => {
  const jobId = `${suiteId}-backfill`;
  const jobDir = await createJobDir(jobId);
  const approvedFile = path.join(jobDir, "approved.mp4");
  const rejectedFile = path.join(jobDir, "rejected.mp4");
  await fsp.writeFile(approvedFile, "approved-backfill");
  await fsp.writeFile(rejectedFile, "rejected-backfill");
  const approved = reviewedAsset("approved-backfill", approvedFile);
  const rejected = { ...reviewedAsset("rejected-backfill", rejectedFile), reviewStatus: "rejected", approved: false };
  const job = baseJob(jobId, [approved, rejected]);
  await persistJob(jobDir, job);

  const result = await autoReviewLocalAssetsForPreview(job, { invalidateSampleReview: false });
  assert.equal(result.review.reviewComplete, true);
  assert.equal(result.review.renderReady, true);
  assert.equal(result.decisions.length, 2);
  assert.equal(result.decisions.every(item => item.auditBackfill === true), true);
  assert.equal(job.assetDecisionVersion, 1);
  assert.equal(fs.existsSync(path.join(jobDir, "asset-decisions.json")), true);
  const snapshot = await buildAssetDecisionSnapshot(job);
  assert.deepEqual(snapshot.approvedAssetIds, ["approved-backfill"]);
});

test("an asset decision version invalidates the existing sample and full render but preserves approved keyframes", async () => {
  const job = baseJob(`${suiteId}-invalidate`);
  const result = appendAssetDecisionAudit(job, [{ eventType: "asset-uploaded", assetId: "asset-new", reviewStatus: "pending" }], {
    reason: "new upload invalidates sample",
  });

  assert.equal(result.decisionVersion, 1);
  assert.deepEqual(result.invalidatedStages, ["motion_sample", "full_render"]);
  assert.equal(job.workflow.stages.keyframe_review.status, "approved");
  assert.equal(job.workflow.stages.keyframe_review.approvedVersion, 2);
  assert.equal(job.workflow.stages.motion_sample.status, "pending");
  assert.equal(job.workflow.stages.motion_sample.artifacts, null);
  assert.equal(job.workflow.stages.full_render.status, "pending");
  assert.equal(job.workflow.stages.full_render.artifacts, null);
});

test("upload, replacement, approval, rejection, and placement changes invalidate sample review through HTTP routes", async () => {
  if (!httpServerForTests.listening) {
    await new Promise((resolve, reject) => {
      httpServerForTests.once("error", reject);
      httpServerForTests.listen(0, "127.0.0.1", resolve);
    });
  }
  const baseUrl = `http://127.0.0.1:${httpServerForTests.address().port}`;

  const scenarios = [];
  for (const action of ["upload", "replacement", "approval", "rejection", "placement"]) {
    const jobId = `${suiteId}-route-${action}`;
    const jobDir = await createJobDir(jobId);
    const assetFile = path.join(jobDir, "asset.mp4");
    await fsp.writeFile(assetFile, `asset-${action}`);
    const asset = reviewedAsset("asset-1", assetFile);
    if (action === "rejection") asset.reviewStatus = "pending", asset.approved = false;
    const job = baseJob(jobId, action === "upload" ? [] : [asset]);
    await persistJob(jobDir, job);
    scenarios.push({ action, jobId, jobDir });
  }

  for (const scenario of scenarios) {
    let response;
    if (scenario.action === "upload") {
      response = await fetch(`${baseUrl}/api/jobs/${scenario.jobId}/assets`, {
        method: "POST",
        headers: { "X-File-Name": "uploaded.mp4" },
        body: Buffer.from("uploaded-route-asset"),
      });
    } else if (scenario.action === "replacement") {
      response = await fetch(`${baseUrl}/api/jobs/${scenario.jobId}/assets/asset-1/file`, {
        method: "POST",
        headers: { "X-File-Name": "replacement.mp4" },
        body: Buffer.from("replacement-route-asset"),
      });
    } else if (scenario.action === "approval") {
      ({ response } = await postJson(baseUrl, `/api/jobs/${scenario.jobId}/assets/asset-1/approve`, { approved: true }));
    } else if (scenario.action === "rejection") {
      ({ response } = await postJson(baseUrl, `/api/jobs/${scenario.jobId}/assets/asset-1/approve`, { approved: false }));
    } else {
      ({ response } = await postJson(baseUrl, `/api/jobs/${scenario.jobId}/assets/asset-1/approve`, {
        approved: true,
        placement: { start: 2, end: 6, mode: "pip" },
      }));
    }
    assert.ok([200, 201].includes(response.status), `${scenario.action}: ${response.status}`);
    const persisted = JSON.parse(await fsp.readFile(path.join(scenario.jobDir, "job.json"), "utf8"));
    assert.equal(persisted.workflow.stages.keyframe_review.status, "approved", scenario.action);
    assert.equal(persisted.workflow.stages.motion_sample.status, "pending", scenario.action);
    assert.equal(persisted.workflow.stages.motion_sample.artifacts, null, scenario.action);
    assert.equal(persisted.workflow.stages.full_render.status, "pending", scenario.action);
    assert.equal(persisted.workflow.stages.full_render.artifacts, null, scenario.action);
    assert.equal(persisted.assetDecisionVersion, 1, scenario.action);
    const audit = JSON.parse(await fsp.readFile(path.join(scenario.jobDir, "asset-decisions.json"), "utf8"));
    assert.equal(audit.at(-1).decisionVersion, 1, scenario.action);
    if (scenario.action === "placement") assert.deepEqual(audit.at(-1).placement, { start: 2, end: 6, mode: "pip" });
  }
});

test("sample approval and full-render start both revalidate frozen asset hashes", async () => {
  if (!httpServerForTests.listening) {
    await new Promise((resolve, reject) => {
      httpServerForTests.once("error", reject);
      httpServerForTests.listen(0, "127.0.0.1", resolve);
    });
  }
  const baseUrl = `http://127.0.0.1:${httpServerForTests.address().port}`;

  async function frozenJob(suffix, sampleStatus) {
    const jobId = `${suiteId}-rehash-${suffix}`;
    const jobDir = await createJobDir(jobId);
    const assetFile = path.join(jobDir, "asset.mp4");
    await fsp.writeFile(assetFile, "frozen-asset-v1");
    const asset = reviewedAsset("asset-1", assetFile);
    const job = baseJob(jobId, [asset]);
    const audit = await assetDecisionAuditEntry(asset, { eventType: "asset-approved", reason: "fixture approval" });
    appendAssetDecisionAudit(job, [audit], { invalidateSampleReview: false });
    await fsp.writeFile(path.join(jobDir, "asset-decisions.json"), JSON.stringify(job.assetDecisions, null, 2));
    const snapshot = await buildAssetDecisionSnapshot(job);
    const snapshotFileName = "motion-sample-asset-snapshot-v3.json";
    const snapshotFile = path.join(jobDir, snapshotFileName);
    await fsp.writeFile(snapshotFile, JSON.stringify(snapshot, null, 2));
    job.workflow.stages.motion_sample = stage({
      status: sampleStatus,
      currentVersion: 3,
      approvedVersion: sampleStatus === "approved" ? 3 : null,
      artifacts: {
        url: "/sample-v3.mp4",
        assetSnapshot: snapshot,
        assetSnapshotFile: snapshotFileName,
        assetSnapshotSha256: sha256(snapshotFile),
      },
    });
    job.workflow.stages.full_render = stage();
    await persistJob(jobDir, job);
    await fsp.writeFile(assetFile, "frozen-asset-v2-tampered");
    return { jobId, jobDir };
  }

  const sample = await frozenJob("sample-approval", "awaiting_review");
  const sampleApproval = await postJson(baseUrl, `/api/jobs/${sample.jobId}/workflow/stages/motion_sample/approve`, { expectedVersion: 3 });
  assert.equal(sampleApproval.response.status, 409);
  assert.match(sampleApproval.payload.error, /文件哈希/);
  const sampleJob = JSON.parse(await fsp.readFile(path.join(sample.jobDir, "job.json"), "utf8"));
  assert.equal(sampleJob.workflow.stages.motion_sample.status, "awaiting_review");

  const full = await frozenJob("full-render", "approved");
  const fullStart = await postJson(baseUrl, `/api/jobs/${full.jobId}/workflow/stages/full_render/run`, {});
  assert.equal(fullStart.response.status, 409);
  assert.match(fullStart.payload.error, /文件哈希/);
  const fullJob = JSON.parse(await fsp.readFile(path.join(full.jobDir, "job.json"), "utf8"));
  assert.equal(fullJob.workflow.stages.full_render.currentVersion, 0);
  assert.equal(fullJob.workflow.stages.full_render.artifacts, null);
});
