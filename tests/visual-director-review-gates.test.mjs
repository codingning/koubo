import test from "node:test";
import assert from "node:assert/strict";
import { assertVisualGateVersion, invalidateVisualStages, rejectVisualGateState, visualGateVersion } from "../video/visual_director.mjs";

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

function reviewJob() {
  const frames = [{ id: "KF01", url: "/frame-1.png" }, { id: "KF02", url: "/frame-2.png" }, { id: "KF03", url: "/frame-3.png" }];
  return {
    id: "review-fixture",
    pipeline: "visual-director-v4",
    status: "awaiting_keyframe_review",
    progress: 58,
    workflow: {
      version: "visual-director-v4",
      currentStage: "keyframe_review",
      stages: {
        style_research: stage({ status: "completed", currentVersion: 1 }),
        content_breakdown: stage({ status: "completed", currentVersion: 1 }),
        keyframes: stage({ status: "completed", currentVersion: 3, artifacts: { frames } }),
        keyframe_review: stage({ status: "awaiting_review", currentVersion: 3, artifacts: { frames } }),
        motion_sample: stage(),
        full_render: stage(),
      },
      audit: [],
    },
  };
}

test("rejecting keyframes records a human decision without generating downstream artifacts", () => {
  const job = reviewJob();
  const originalFrames = structuredClone(job.workflow.stages.keyframes.artifacts.frames);
  const at = "2026-07-25T10:00:00.000Z";

  const rejection = rejectVisualGateState(job, "keyframe_review", "三张都没有把动作说清楚", at);

  assert.deepEqual(rejection, {
    stageId: "keyframe_review",
    version: 3,
    feedback: "三张都没有把动作说清楚",
    at,
  });
  assert.equal(job.status, "keyframe_review_rejected");
  assert.equal(job.progress, 58);
  assert.equal(job.workflow.currentStage, "keyframe_review");
  assert.equal(job.workflow.stages.keyframes.status, "rejected");
  assert.equal(job.workflow.stages.keyframe_review.status, "rejected");
  assert.equal(job.workflow.stages.keyframe_review.approvedVersion, null);
  assert.equal(job.workflow.stages.keyframe_review.rejectedVersion, 3);
  assert.deepEqual(job.workflow.stages.keyframes.artifacts.frames, originalFrames);
  assert.equal(job.workflow.stages.motion_sample.status, "pending");
  assert.equal(job.workflow.stages.motion_sample.currentVersion, 0);
  assert.equal(job.workflow.stages.motion_sample.artifacts, null);
  assert.equal(job.workflow.stages.full_render.status, "pending");
  assert.equal(job.workflow.stages.full_render.currentVersion, 0);
  assert.equal(job.workflow.stages.full_render.artifacts, null);
  assert.deepEqual(job.workflow.audit.at(-1), {
    type: "stage-rejected",
    stageId: "keyframe_review",
    version: 3,
    feedback: "三张都没有把动作说清楚",
    at,
  });
  assert.throws(() => rejectVisualGateState(job, "keyframe_review", "重复拒绝", at), /不在待审核状态/);
});

test("review actions are bound to the exact keyframe or sample version shown to the user", () => {
  const job = reviewJob();
  assert.equal(visualGateVersion(job, "keyframe_review"), 3);
  assert.equal(assertVisualGateVersion(job, "keyframe_review", 3), 3);
  assert.throws(() => assertVisualGateVersion(job, "keyframe_review", 2), /页面为 v2，当前为 v3/);
  assert.throws(() => assertVisualGateVersion(job, "keyframe_review", undefined), /缺少有效的审核版本/);

  job.workflow.stages.motion_sample = stage({
    status: "awaiting_review",
    currentVersion: 2,
    artifacts: { url: "/sample-v2.mp4" },
  });
  assert.equal(visualGateVersion(job, "motion_sample"), 2);
  assert.equal(assertVisualGateVersion(job, "motion_sample", "2"), 2);
  assert.throws(() => visualGateVersion(job, "full_render"), /不使用审核版本/);
});

test("rejecting a motion sample preserves the sample and keeps full render pending", () => {
  const job = reviewJob();
  job.status = "awaiting_sample_review";
  job.progress = 78;
  job.workflow.currentStage = "motion_sample";
  job.workflow.stages.keyframes.status = "approved";
  job.workflow.stages.keyframe_review.status = "approved";
  job.workflow.stages.keyframe_review.approvedVersion = 3;
  job.workflow.stages.motion_sample = stage({
    status: "awaiting_review",
    currentVersion: 2,
    artifacts: { url: "/sample-v2.mp4", sampleStart: 0, sampleEnd: 20 },
  });

  rejectVisualGateState(job, "motion_sample", "声音没跟上第三个动效", "2026-07-25T10:01:00.000Z");

  assert.equal(job.status, "motion_sample_rejected");
  assert.equal(job.progress, 78);
  assert.equal(job.workflow.stages.motion_sample.status, "rejected");
  assert.equal(job.workflow.stages.motion_sample.rejectedVersion, 2);
  assert.equal(job.workflow.stages.motion_sample.artifacts.url, "/sample-v2.mp4");
  assert.equal(job.workflow.stages.full_render.status, "pending");
  assert.equal(job.workflow.stages.full_render.currentVersion, 0);
  assert.equal(job.workflow.stages.full_render.artifacts, null);
});

test("re-running an upstream stage clears stale review metadata but keeps audit history", () => {
  const job = reviewJob();
  rejectVisualGateState(job, "keyframe_review", "整版不接受", "2026-07-25T10:02:00.000Z");
  const auditLength = job.workflow.audit.length;

  invalidateVisualStages(job.workflow, "keyframes", "生成关键帧 v4");

  const gate = job.workflow.stages.keyframe_review;
  assert.equal(gate.status, "pending");
  assert.equal(gate.approvedVersion, null);
  assert.equal(gate.artifacts, null);
  assert.equal("rejectedAt" in gate, false);
  assert.equal("rejectedVersion" in gate, false);
  assert.equal("feedback" in gate, false);
  assert.ok(job.workflow.audit.length > auditLength);
  assert.equal(job.workflow.audit.some(item => item.type === "stage-rejected"), true);
});
