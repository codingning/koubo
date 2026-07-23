import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSubjectiveReviewHtml,
  normalizeSubjectiveSamples,
  validateSubjectiveReview,
} from "../../video/multi-agent/subjective-review.mjs";

const realSamples = [
  {
    id: "hook",
    mediaKind: "real-talking-head",
    focus: "钩子与结果证明",
    question: "前三秒是否建立了继续观看的理由？",
    reviewHints: ["重点是否清楚", "动效是否抢话"],
    candidates: [
      { label: "A", renderHash: "a".repeat(64), publicFile: "media/hook-A.mp4" },
      { label: "B", renderHash: "b".repeat(64), publicFile: "media/hook-B.mp4" },
      { label: "C", renderHash: "c".repeat(64), publicFile: "media/hook-C.mp4" },
    ],
  },
];

test("subjective review accepts real clips and rejects synthetic style samples", () => {
  assert.equal(normalizeSubjectiveSamples(realSamples)[0].id, "hook");
  assert.throws(
    () => normalizeSubjectiveSamples([{
      ...realSamples[0],
      id: "fixture",
      mediaKind: "synthetic-fixture",
    }]),
    /real talking-head/i,
  );
});

test("review may reject an entire group without choosing a least-bad winner", () => {
  const result = validateSubjectiveReview({
    samples: [{
      sampleId: "hook",
      decision: "reject-all",
      reasons: ["模板感"],
      note: "全程都不像我会发布的视频。",
    }],
  }, normalizeSubjectiveSamples(realSamples));

  assert.equal(result.valid, true);
  assert.equal(result.samples[0].decision, "reject-all");
});

test("review requires one decision and one concrete reason per real sample", () => {
  assert.throws(
    () => validateSubjectiveReview({
      samples: [{ sampleId: "hook", decision: "A", reasons: [], note: "" }],
    }, normalizeSubjectiveSamples(realSamples)),
    /reason/i,
  );
});

test("blind review HTML explains scope and includes reject-all without identities", () => {
  const html = buildSubjectiveReviewHtml({
    runId: "real-review-v1",
    samples: normalizeSubjectiveSamples(realSamples),
  });

  assert.match(html, /整体剪辑方案/);
  assert.match(html, /全组不合格/);
  assert.match(html, /不要求逐字校对.*单独验收/s);
  assert.doesNotMatch(html, /字幕是否逐字准确.*自动检查/s);
  assert.match(html, /前三秒是否建立了继续观看的理由/);
  assert.match(html, /提交审核结果/);
  assert.match(html, /fetch\("\/api\/subjective-review"/);
  assert.match(html, /本地服务不可用.*下载 JSON/s);
  assert.doesNotMatch(html, /caption-pulse|evidence-rail|frozen-control|agent/i);
});
