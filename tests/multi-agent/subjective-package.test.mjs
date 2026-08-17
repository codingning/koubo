import test from "node:test";
import assert from "node:assert/strict";
import { buildSubjectiveReviewPackage } from "../../video/multi-agent/subjective-package.mjs";

test("packages blinded real samples without leaking recipe identities", () => {
  const sample = {
    id: "hook",
    mediaKind: "real-talking-head",
    focus: "钩子",
    question: "愿意继续看吗？",
    reviewHints: ["信息清楚", "动效克制"],
    duration: 18,
  };
  const items = [
    { label: "A", recipeId: "control", renderHash: "a".repeat(64), publicFile: "media/hook-A.mp4", technicalPass: true },
    { label: "B", recipeId: "pulse", renderHash: "b".repeat(64), publicFile: "media/hook-B.mp4", technicalPass: true },
  ];

  const result = buildSubjectiveReviewPackage({
    runId: "run-1",
    baselineId: "baseline-1",
    samples: [{ sample, items }],
  });

  assert.equal(result.manifest.status, "awaiting-user-subjective-review");
  assert.equal(result.publicSamples[0].candidates[0].label, "A");
  assert.equal("recipeId" in result.publicSamples[0].candidates[0], false);
  assert.equal(result.privateMap[0].mapping[0].recipeId, "control");
  assert.match(result.manifest.residualRisks.join(" "), /subtitle text accuracy is not automated/i);
});

test("does not request human review when any technical candidate failed", () => {
  const result = buildSubjectiveReviewPackage({
    runId: "run-2",
    baselineId: "baseline-1",
    samples: [{
      sample: {
        id: "hook",
        mediaKind: "real-talking-head",
        focus: "钩子",
        question: "愿意继续看吗？",
        reviewHints: ["信息清楚", "动效克制"],
        duration: 18,
      },
      items: [
        { label: "A", recipeId: "control", renderHash: "a".repeat(64), publicFile: "media/hook-A.mp4", technicalPass: false },
        { label: "B", recipeId: "pulse", renderHash: "b".repeat(64), publicFile: "media/hook-B.mp4", technicalPass: true },
      ],
    }],
  });

  assert.equal(result.manifest.status, "automated-checks-failed");
});
