import test from "node:test";
import assert from "node:assert/strict";
import { prepareSubjectiveReviewRecord } from "../../video/multi-agent/subjective-result.mjs";

const manifest = {
  schemaVersion: 1,
  runId: "real-review-v1",
  baselineId: "baseline-v1",
  status: "awaiting-user-subjective-review",
  automatedPass: true,
  finalSubjectiveReview: null,
  samples: [
    {
      id: "hook",
      mediaKind: "real-talking-head",
      focus: "钩子",
      question: "愿意继续看吗？",
      reviewHints: ["信息清楚", "动效克制"],
      duration: 18,
      candidates: [
        { label: "A", renderHash: "a".repeat(64), publicFile: "media/hook-A.mp4" },
        { label: "B", renderHash: "b".repeat(64), publicFile: "media/hook-B.mp4" },
      ],
    },
  ],
};

const privateMap = [{
  sampleId: "hook",
  mapping: [
    { label: "A", recipeId: "frozen-control", renderHash: "a".repeat(64) },
    { label: "B", recipeId: "caption-pulse", renderHash: "b".repeat(64) },
  ],
}];

test("records a blinded preference with its private recipe mapping but grants no authority", () => {
  const result = prepareSubjectiveReviewRecord({
    manifest,
    privateMap,
    payload: {
      runId: "real-review-v1",
      reviewerType: "human",
      reviewedAt: "2026-07-23T10:00:00.000Z",
      samples: [{
        sampleId: "hook",
        decision: "B",
        reasons: ["信息清楚"],
        note: "00:02 的重点更明确。",
      }],
    },
  });

  assert.equal(result.record.samples[0].recipeId, "caption-pulse");
  assert.equal(result.record.outcome, "preference-evidence-recorded");
  assert.equal(result.updatedManifest.status, "subjective-review-recorded");
  assert.equal(result.record.autoPublish, false);
  assert.equal(result.record.memoryPromotion, false);
  assert.equal(result.record.productionApproval, false);
});

test("records reject-all without inventing a least-bad winner", () => {
  const result = prepareSubjectiveReviewRecord({
    manifest,
    privateMap,
    payload: {
      runId: "real-review-v1",
      reviewerType: "human",
      reviewedAt: "2026-07-23T10:00:00.000Z",
      samples: [{
        sampleId: "hook",
        decision: "reject-all",
        reasons: ["模板感太强"],
        note: "全程。",
      }],
    },
  });

  assert.equal(result.record.outcome, "subjective-rejection-recorded");
  assert.equal(result.record.samples[0].recipeId, null);
});

test("refuses the wrong run, changed blind map, or a second final review", () => {
  assert.throws(
    () => prepareSubjectiveReviewRecord({
      manifest,
      privateMap,
      payload: {
        runId: "other-run",
        reviewerType: "human",
        samples: [{
          sampleId: "hook",
          decision: "A",
          reasons: ["信息清楚"],
        }],
      },
    }),
    /run/i,
  );
  assert.throws(
    () => prepareSubjectiveReviewRecord({
      manifest,
      privateMap: [{
        sampleId: "hook",
        mapping: [{ label: "A", recipeId: "control", renderHash: "c".repeat(64) }],
      }],
      payload: {
        runId: "real-review-v1",
        reviewerType: "human",
        samples: [{
          sampleId: "hook",
          decision: "A",
          reasons: ["信息清楚"],
        }],
      },
    }),
    /mapping/i,
  );
  assert.throws(
    () => prepareSubjectiveReviewRecord({
      manifest: { ...manifest, finalSubjectiveReview: { recordHash: "x" } },
      privateMap,
      payload: {
        runId: "real-review-v1",
        reviewerType: "human",
        samples: [{
          sampleId: "hook",
          decision: "A",
          reasons: ["信息清楚"],
        }],
      },
    }),
    /already/i,
  );
});
