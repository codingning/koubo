import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-final-output-review-"));
process.env.KOUBO_NO_LISTEN = "1";
process.env.KOUBO_MULTI_AGENT_DATA_ROOT = path.join(dataRoot, "multi-agent");

const serverModule = await import(`../video/server.mjs?final-output-review-test=${Date.now()}`);
const {
  assertOutputReviewVersion,
  closeServerResourcesForTests,
  createOrReadVersionedFinalReview,
  fullRenderStageVersionForOutput,
  withJobMutation,
} = serverModule;

test.after(async () => {
  await closeServerResourcesForTests();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("final revise and approve actions must target the exact latest successful output", () => {
  const job = {
    currentVersion: 8,
    output: { version: 5, url: "/video-jobs/job/final-v5.mp4" },
    versions: [{ version: 4 }, { version: 5 }],
  };

  assert.equal(assertOutputReviewVersion(job, 5), 5);
  assert.equal(assertOutputReviewVersion(job, "5"), 5);
  assert.throws(() => assertOutputReviewVersion(job, 4), /页面为 v4，当前可审核成片为 v5/);
  assert.throws(() => assertOutputReviewVersion(job, undefined), error => error.statusCode === 409 && /缺少有效的成片审核版本/.test(error.message));
});

test("a failed newer render attempt does not change which successful output can be reviewed", () => {
  const job = {
    currentVersion: 9,
    output: { version: 5 },
    workflow: {
      stages: {
        keyframe_review: { approvedVersion: 3 },
        motion_sample: { approvedVersion: 2 },
        full_render: {
          status: "error",
          currentVersion: 4,
          artifacts: { output: { version: 5 } },
          runs: [
            { version: 3, status: "completed", artifacts: { output: { version: 5, workflowDependencies: { keyframeVersion: 3, motionSampleVersion: 2 } } } },
            { version: 4, status: "error" },
          ],
        },
      },
    },
  };

  assert.equal(assertOutputReviewVersion(job, 5), 5);
  assert.equal(fullRenderStageVersionForOutput(job, 5), 3);
});

test("the current full-render artifact maps directly to its workflow stage version", () => {
  const job = {
    workflow: {
      stages: {
        keyframe_review: { approvedVersion: 4 },
        motion_sample: { approvedVersion: 6 },
        full_render: {
          status: "awaiting_review",
          currentVersion: 6,
          artifacts: { output: { version: 11, workflowStageVersion: 6, workflowDependencies: { keyframeVersion: 4, motionSampleVersion: 6 } } },
          runs: [],
        },
      },
    },
  };

  assert.equal(fullRenderStageVersionForOutput(job, 11), 6);
  assert.equal(fullRenderStageVersionForOutput(job, 10), null);
});

test("an upstream-invalidated full render cannot make an old output approvable", () => {
  const job = {
    workflow: {
      stages: {
        keyframe_review: { approvedVersion: 9 },
        motion_sample: { approvedVersion: 8 },
        full_render: {
          status: "pending",
          currentVersion: 4,
          artifacts: null,
          runs: [{ version: 3, status: "completed", artifacts: { output: { version: 5, workflowDependencies: { keyframeVersion: 3, motionSampleVersion: 2 } } } }],
        },
      },
    },
  };

  assert.equal(fullRenderStageVersionForOutput(job, 5), null);
});

test("a failed full render after new upstream approvals cannot revive the old output", () => {
  const job = {
    workflow: {
      stages: {
        keyframe_review: { approvedVersion: 9 },
        motion_sample: { approvedVersion: 8 },
        full_render: {
          status: "error",
          currentVersion: 4,
          artifacts: { output: { version: 5, workflowDependencies: { keyframeVersion: 3, motionSampleVersion: 2 } } },
          runs: [
            { version: 3, status: "completed", artifacts: { output: { version: 5, workflowDependencies: { keyframeVersion: 3, motionSampleVersion: 2 } } } },
            { version: 4, status: "error" },
          ],
        },
      },
    },
  };

  assert.equal(fullRenderStageVersionForOutput(job, 5), null);
});

test("repeating the same final approval preserves the first approvedAt and evidence record", async () => {
  const file = path.join(dataRoot, "final-review-v5.json");
  const base = {
    status: "approved",
    version: 5,
    workflowStageVersion: 3,
    mediaSha256: "a".repeat(64),
    reviewBundle: { sha256: "b".repeat(64), previewSha256: "c".repeat(64) },
    mediaManifest: { sha256: "d".repeat(64) },
    ordinaryViewerAudit: { artifactId: "audit-5", transcriptSha256: "e".repeat(64) },
    approvedAt: "2026-07-25T12:00:00.000Z",
  };

  const first = await createOrReadVersionedFinalReview(file, base);
  const replay = await createOrReadVersionedFinalReview(file, { ...base, approvedAt: "2026-07-25T12:05:00.000Z" });

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.review.approvedAt, base.approvedAt);
  assert.equal(replay.review.evidenceHash, first.review.evidenceHash);
  assert.equal(replay.review.recordHash, first.review.recordHash);
});

test("a conflicting repeated approval cannot overwrite the versioned human review", async () => {
  const file = path.join(dataRoot, "final-review-v6.json");
  const base = {
    status: "approved",
    version: 6,
    workflowStageVersion: 4,
    mediaSha256: "1".repeat(64),
    reviewBundle: { sha256: "2".repeat(64), previewSha256: "3".repeat(64) },
    mediaManifest: { sha256: "4".repeat(64) },
    ordinaryViewerAudit: null,
    approvedAt: "2026-07-25T12:10:00.000Z",
  };
  await createOrReadVersionedFinalReview(file, base);

  await assert.rejects(
    createOrReadVersionedFinalReview(file, { ...base, mediaSha256: "9".repeat(64) }),
    /不同证据的最终审核记录/,
  );
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(persisted.mediaSha256, base.mediaSha256);
});

test("a stored evidenceHash cannot hide tampering in an existing final review", async () => {
  const file = path.join(dataRoot, "final-review-v7.json");
  const base = {
    status: "approved",
    version: 7,
    workflowStageVersion: 5,
    mediaSha256: "5".repeat(64),
    reviewBundle: { sha256: "6".repeat(64), previewSha256: "7".repeat(64) },
    mediaManifest: { sha256: "8".repeat(64) },
    ordinaryViewerAudit: null,
    approvedAt: "2026-07-25T12:20:00.000Z",
  };
  const created = await createOrReadVersionedFinalReview(file, base);
  fs.writeFileSync(file, JSON.stringify({ ...created.review, mediaSha256: "0".repeat(64) }, null, 2));

  await assert.rejects(
    createOrReadVersionedFinalReview(file, base),
    /证据哈希已损坏/,
  );
});

test("missing hashes and approvedAt tampering invalidate an immutable final review", async () => {
  const file = path.join(dataRoot, "final-review-v8.json");
  const base = {
    status: "approved",
    version: 8,
    workflowStageVersion: 6,
    mediaSha256: "a".repeat(64),
    reviewBundle: { url: "/review-bundle-v8.json", sha256: "b".repeat(64), previewUrl: "/preview-v8.mp4", previewSha256: "c".repeat(64) },
    mediaManifest: { url: "/media-manifest-v8.json", sha256: "d".repeat(64) },
    ordinaryViewerAudit: { artifactId: "audit-v8", outputVersion: 8, mediaSha256: "a".repeat(64), transcriptSha256: "e".repeat(64), inspectionMode: "media-and-transcript" },
    qaPass: true,
    mediaReview: { reviewComplete: true, renderReady: true },
    renderedAssetIds: ["asset-1"],
    approvedAt: "2026-07-25T12:30:00.000Z",
    autoPublish: false,
  };
  const created = await createOrReadVersionedFinalReview(file, base);

  fs.writeFileSync(file, JSON.stringify({ ...created.review, evidenceHash: undefined }, null, 2));
  await assert.rejects(createOrReadVersionedFinalReview(file, base), /证据哈希已损坏/);

  fs.writeFileSync(file, JSON.stringify({ ...created.review, approvedAt: "2026-07-25T13:30:00.000Z" }, null, 2));
  await assert.rejects(createOrReadVersionedFinalReview(file, base), /完整记录哈希已损坏/);
});

test("job mutation lock rejects overlap, releases after failure, and isolates different jobs", async () => {
  let releaseFirst;
  const first = withJobMutation("job-lock-a", () => new Promise(resolve => { releaseFirst = resolve; }));
  await new Promise(resolve => setImmediate(resolve));

  await assert.rejects(
    withJobMutation("job-lock-a", async () => "overlap"),
    error => error.statusCode === 409 && /处理中/.test(error.message),
  );
  assert.equal(await withJobMutation("job-lock-b", async () => "other-job"), "other-job");

  releaseFirst("first-complete");
  assert.equal(await first, "first-complete");
  await assert.rejects(withJobMutation("job-lock-a", async () => { throw new Error("expected failure"); }), /expected failure/);
  assert.equal(await withJobMutation("job-lock-a", async () => "released"), "released");
});
