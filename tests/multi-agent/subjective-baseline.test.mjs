import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  normalizeSubjectiveBaseline,
  resolveSubjectiveBaselineMedia,
} from "../../video/multi-agent/subjective-baseline.mjs";

const baseline = {
  schemaVersion: 1,
  baselineId: "real-subjective-v1",
  mediaKind: "real-talking-head",
  jobId: "job-1",
  source: {
    path: "project/assets/clean.mp4",
    sha256: "a".repeat(64),
  },
  control: {
    path: "project/renders/control.mp4",
    sha256: "b".repeat(64),
  },
  samples: [
    {
      id: "hook",
      segmentId: "S01",
      editedStart: 0,
      duration: 18.386,
      focus: "钩子与结果证明",
      question: "前三秒是否建立继续观看的理由？",
      reviewHints: ["信息重点是否立刻清楚", "动效是否帮助理解"],
      phrases: ["动态字幕", "重点卡片", "横竖两个版本"],
    },
  ],
};

test("normalizes a versioned real-talking-head subjective baseline", () => {
  const result = normalizeSubjectiveBaseline(baseline);
  assert.equal(result.samples[0].duration, 18.386);
  assert.equal(result.samples[0].phrases.length, 3);
});

test("rejects synthetic media and overlapping or invalid sample windows", () => {
  assert.throws(
    () => normalizeSubjectiveBaseline({ ...baseline, mediaKind: "synthetic-fixture" }),
    /real talking-head/i,
  );
  assert.throws(
    () => normalizeSubjectiveBaseline({
      ...baseline,
      samples: [
        baseline.samples[0],
        { ...baseline.samples[0], id: "overlap", editedStart: 10 },
      ],
    }),
    /overlap/i,
  );
});

test("resolves source and control inside the declared job root", () => {
  const jobsRoot = path.resolve("X:/jobs");
  const resolved = resolveSubjectiveBaselineMedia(baseline, jobsRoot);
  assert.equal(resolved.jobRoot, path.join(jobsRoot, "job-1"));
  assert.equal(resolved.source, path.join(jobsRoot, "job-1", "project", "assets", "clean.mp4"));
  assert.throws(
    () => resolveSubjectiveBaselineMedia({
      ...baseline,
      source: { ...baseline.source, path: "../escape.mp4" },
    }, jobsRoot),
    /escapes/i,
  );
});
