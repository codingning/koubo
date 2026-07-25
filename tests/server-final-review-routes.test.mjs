import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const jobId = `route-final-review-${process.pid}-${Date.now()}`;
const jobDir = path.join(root, "video-jobs", jobId);
const dataRoot = path.join(jobDir, "multi-agent-test-data");
process.env.KOUBO_NO_LISTEN = "1";
process.env.KOUBO_MULTI_AGENT_DATA_ROOT = dataRoot;

const serverModule = await import(`../video/server.mjs?final-review-route-test=${Date.now()}`);
const { closeServerResourcesForTests, httpServerForTests, withJobMutation } = serverModule;

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function post(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test.after(async () => {
  await closeServerResourcesForTests();
  fs.rmSync(jobDir, { recursive: true, force: true });
});

test("final review routes reject stale pages, preserve downloads, and replay approval idempotently", async () => {
  await fsp.mkdir(jobDir, { recursive: true });
  const v1Path = path.join(jobDir, "final-v1.mp4");
  const v2Path = path.join(jobDir, "final-v2.mp4");
  const previewPath = path.join(jobDir, "review-preview-v2.mp4");
  await fsp.writeFile(v1Path, "immutable-version-one");
  await fsp.writeFile(v2Path, "immutable-version-two");
  await fsp.writeFile(previewPath, "review-preview-two");
  const manifest = {
    version: 2,
    review: { total: 1, pending: 0, approved: 0, rejected: 1, reviewComplete: true, renderReady: true, complianceIssues: [] },
    assets: [{ id: "skipped-local", approved: false, composited: false }],
    renderedAssetIds: [],
  };
  const bundle = {
    version: 2,
    mode: "full-preview-with-context-segments",
    preview: { path: previewPath, url: `/video-jobs/${jobId}/review-preview-v2.mp4`, metadata: { width: 720, height: 1280 } },
    segments: [],
    finalApprovalHeld: true,
    autoPublish: false,
  };
  await fsp.writeFile(path.join(jobDir, "media-manifest-v2.json"), JSON.stringify(manifest, null, 2));
  await fsp.writeFile(path.join(jobDir, "review-bundle-v2.json"), JSON.stringify(bundle, null, 2));
  const output = {
    version: 2,
    path: v2Path,
    url: `/video-jobs/${jobId}/final-v2.mp4`,
    qaPass: true,
    artifacts: {
      mediaManifest: `/video-jobs/${jobId}/media-manifest-v2.json`,
      reviewBundle: `/video-jobs/${jobId}/review-bundle-v2.json`,
    },
  };
  const job = {
    id: jobId,
    status: "awaiting_review",
    currentVersion: 2,
    output,
    versions: [{ version: 1, path: v1Path, url: `/video-jobs/${jobId}/final-v1.mp4` }, output],
    reviews: [],
  };
  const jobFile = path.join(jobDir, "job.json");
  await fsp.writeFile(jobFile, JSON.stringify(job, null, 2));

  await new Promise((resolve, reject) => {
    httpServerForTests.once("error", reject);
    httpServerForTests.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServerForTests.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const originalJobHash = sha256(jobFile);

  for (const [pathname, body] of [
    [`/api/jobs/${jobId}/revise`, { feedback: "旧页面返修" }],
    [`/api/jobs/${jobId}/revise`, { feedback: "旧页面返修", expectedVersion: 1 }],
    [`/api/jobs/${jobId}/approve`, {}],
    [`/api/jobs/${jobId}/approve`, { expectedVersion: 1 }],
  ]) {
    const { response } = await post(baseUrl, pathname, body);
    assert.equal(response.status, 409);
    assert.equal(sha256(jobFile), originalJobHash);
  }

  const oldDownload = await fetch(`${baseUrl}/video-jobs/${jobId}/final-v1.mp4`);
  const currentDownload = await fetch(`${baseUrl}/video-jobs/${jobId}/final-v2.mp4`);
  assert.equal(await oldDownload.text(), "immutable-version-one");
  assert.equal(await currentDownload.text(), "immutable-version-two");
  assert.equal((await fetch(`${baseUrl}/video-jobs/${jobId}/review-bundle-v2.json`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/video-jobs/${jobId}/media-manifest-v2.json`)).status, 200);

  let releaseMutation;
  const heldMutation = withJobMutation(jobId, () => new Promise(resolve => { releaseMutation = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const filesBeforeLockedRequests = fs.readdirSync(jobDir).sort();
  for (const [pathname, body] of [
    [`/api/jobs/${jobId}/workflow/stages/keyframe_review/run`, { expectedVersion: 1 }],
    [`/api/jobs/${jobId}/retry`, {}],
    [`/api/jobs/${jobId}/revise`, { feedback: "锁竞争返修", expectedVersion: 2 }],
    [`/api/jobs/${jobId}/replan`, { feedback: "锁竞争重做" }],
    [`/api/jobs/${jobId}/rerender`, { reason: "锁竞争重渲染" }],
    [`/api/jobs/${jobId}/cover`, { title: "锁竞争封面" }],
    [`/api/jobs/${jobId}/assets/rediscover`, {}],
    [`/api/jobs/${jobId}/assets/auto-review-preview`, {}],
    [`/api/jobs/${jobId}/assets`, {}],
    [`/api/jobs/${jobId}/assets/missing/file`, {}],
    [`/api/jobs/${jobId}/assets/missing/approve`, { approved: false }],
    [`/api/jobs/${jobId}/assets/render`, {}],
    [`/api/jobs/${jobId}/approve`, { expectedVersion: 2 }],
  ]) {
    const locked = await post(baseUrl, pathname, body);
    assert.equal(locked.response.status, 409, pathname);
    assert.match(locked.payload.error, /处理中/, pathname);
    assert.equal(sha256(jobFile), originalJobHash, pathname);
    assert.deepEqual(fs.readdirSync(jobDir).sort(), filesBeforeLockedRequests, pathname);
  }
  releaseMutation();
  await heldMutation;

  const hiddenPreviewPath = `${previewPath}.missing`;
  await fsp.rename(previewPath, hiddenPreviewPath);
  const missingPreview = await post(baseUrl, `/api/jobs/${jobId}/approve`, { expectedVersion: 2 });
  assert.equal(missingPreview.response.status, 409);
  assert.match(missingPreview.payload.error, /缺少真实审核预览/);
  assert.equal(sha256(jobFile), originalJobHash);
  await fsp.rename(hiddenPreviewPath, previewPath);

  const first = await post(baseUrl, `/api/jobs/${jobId}/approve`, { expectedVersion: 2 });
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.replayed, false);
  assert.equal(first.payload.job.output.artifacts.finalReview, `/video-jobs/${jobId}/final-review-v2.json`);
  const versionedReview = path.join(jobDir, "final-review-v2.json");
  const firstReviewHash = sha256(versionedReview);
  const firstReview = JSON.parse(await fsp.readFile(versionedReview, "utf8"));
  assert.equal(firstReview.version, 2);
  assert.equal(firstReview.mediaSha256, sha256(v2Path));
  assert.equal(firstReview.reviewBundle.previewSha256, sha256(previewPath));

  const replay = await post(baseUrl, `/api/jobs/${jobId}/approve`, { expectedVersion: 2 });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.payload.replayed, true);
  assert.equal(sha256(versionedReview), firstReviewHash);
  assert.equal(replay.payload.finalReview.approvedAt, firstReview.approvedAt);
  assert.equal(await fsp.readFile(v1Path, "utf8"), "immutable-version-one");
});
