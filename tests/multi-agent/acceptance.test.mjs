import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptanceAudioMixFilter,
  acceptanceVideoEncodingArgs,
  acceptanceRecipes,
  blindMediaPlan,
  freezeRegressionAgainstControl,
  joinFfmpegFilterChains,
  measuredTextLayout,
  parseFfmpegBbox,
  publicAcceptanceValue,
  selectChallengerSource,
  selectFrozenControl,
} from "../../video/multi-agent/acceptance.mjs";
import { candidateDiversity } from "../../video/multi-agent/evaluation.mjs";

test("acceptance recipes contain a control and two meaningfully different challengers", () => {
  const recipes = acceptanceRecipes();

  assert.deepEqual(recipes.map(item => item.id), [
    "frozen-control",
    "caption-pulse",
    "evidence-rail",
  ]);
  assert.equal(candidateDiversity(recipes[0], recipes[1]).meaningful, true);
  assert.equal(candidateDiversity(recipes[1], recipes[2]).meaningful, true);
  assert.notDeepEqual(recipes[1].motion.structure, recipes[2].motion.structure);
});

test("frozen control selection prefers an existing synchronized sample", () => {
  const sample = {
    jobId: "job-1",
    artifacts: [
      { path: "review-preview-v5.mp4" },
      { path: "sample-18s-v1/renders/opening.mp4" },
      { path: "source.mp4" },
    ],
  };
  const existing = new Set([
    "X:\\jobs\\job-1\\review-preview-v5.mp4",
    "X:\\jobs\\job-1\\sample-18s-v1\\renders\\opening.mp4",
    "X:\\jobs\\job-1\\source.mp4",
  ]);

  const selected = selectFrozenControl(sample, "X:\\jobs", file => existing.has(file));

  assert.match(selected, /sample-18s-v1[\\/]renders[\\/]opening\.mp4$/);
});

test("challenger selection uses the frozen raw source instead of a rendered control", () => {
  const sample = {
    jobId: "job-1",
    source: "raw-source.mp4",
    artifacts: [
      { path: "raw-source.mp4", sha256: "a".repeat(64) },
      { path: "sample-18s-v1/renders/opening.mp4", sha256: "b".repeat(64) },
    ],
  };
  const existing = new Set([
    "X:\\jobs\\job-1\\raw-source.mp4",
    "X:\\jobs\\job-1\\sample-18s-v1\\renders\\opening.mp4",
  ]);

  const selected = selectChallengerSource(sample, "X:\\jobs", file => existing.has(file));

  assert.match(selected, /job-1[\\/]raw-source\.mp4$/);
  assert.doesNotMatch(selected, /renders/);
});

test("challenger selection rejects an unfrozen source path", () => {
  const sample = {
    jobId: "job-1",
    source: "raw-source.mp4",
    artifacts: [{ path: "rendered.mp4", sha256: "b".repeat(64) }],
  };

  assert.throws(
    () => selectChallengerSource(sample, "X:\\jobs", () => true),
    /not frozen in the baseline/i,
  );
});

test("measured text layout wraps against actual measured width and grows the card", async () => {
  const layout = await measuredTextLayout("一二三四五六七八九十", {
    maxWidth: 100,
    maxLines: 3,
    lineHeight: 32,
    paddingY: 18,
    measure: async value => ({
      width: Array.from(value).length * 25,
      height: 26,
    }),
  });

  assert.deepEqual(layout.lines, ["一二三四", "五六七八", "九十"]);
  assert.deepEqual(layout.widths, [100, 100, 50]);
  assert.equal(layout.boxHeight, 132);
  assert.equal(layout.fits, true);
});

test("measured text layout refuses to hide text beyond the line budget", async () => {
  await assert.rejects(
    measuredTextLayout("一二三四五六七八九十十一十二十三", {
      maxWidth: 100,
      maxLines: 3,
      measure: async value => ({
        width: Array.from(value).length * 25,
        height: 26,
      }),
    }),
    /exceeds 3 measured lines/i,
  );
});

test("FFmpeg bbox output becomes deterministic font metrics", () => {
  const stderr = [
    "noise before the filter",
    "[Parsed_bbox_1 @ 000001] n:0 pts:0 x1:0 x2:492 y1:0 y2:25 w:493 h:26 crop=493:26:0:0",
  ].join("\n");

  assert.deepEqual(parseFfmpegBbox(stderr), { width: 493, height: 26 });
  assert.throws(() => parseFfmpegBbox("no bbox output"), /bbox measurement/i);
});

test("FFmpeg filter chains cannot create empty filters at semicolon boundaries", () => {
  const graph = joinFfmpegFilterChains([
    "[0:v]copy[v];",
    ";[0:a]aresample=48000[a];",
    "[a]anull[out]",
  ]);

  assert.equal(graph, "[0:v]copy[v];[0:a]aresample=48000[a];[a]anull[out]");
  assert.equal(graph.includes(";;"), false);
});

test("blind media plan exposes labels and hashes but never recipe identities", () => {
  const candidates = [
    { id: "frozen-control", renderHash: "a".repeat(64), renderPath: "private/control.mp4" },
    { id: "caption-pulse", renderHash: "b".repeat(64), renderPath: "private/caption.mp4" },
  ];
  const bundle = {
    candidates: [
      { label: "A", renderHash: "b".repeat(64) },
      { label: "B", renderHash: "a".repeat(64) },
    ],
  };

  const plan = blindMediaPlan(bundle, candidates, "sample-1");
  const serialized = JSON.stringify(plan);

  assert.deepEqual(plan.map(item => item.publicFile), [
    "sample-1-candidate-A.mp4",
    "sample-1-candidate-B.mp4",
  ]);
  assert.equal(serialized.includes("frozen-control"), false);
  assert.equal(serialized.includes("caption-pulse"), false);
  assert.equal(serialized.includes("private/"), false);
});

test("public acceptance values strip secret fields and absolute local paths", () => {
  const value = publicAcceptanceValue({
    ok: true,
    apiKey: "secret",
    renderPath: "F:\\private\\candidate.mp4",
    nested: {
      token: "secret",
      publicFile: "blind/sample-candidate-A.mp4",
    },
  });

  assert.deepEqual(value, {
    nested: { publicFile: "blind/sample-candidate-A.mp4" },
    ok: true,
  });
});

test("acceptance encoding writes explicit BT.709 VUI metadata", () => {
  const args = acceptanceVideoEncodingArgs();
  const serialized = args.join(" ");

  assert.match(serialized, /colorprim=bt709/);
  assert.match(serialized, /transfer=bt709/);
  assert.match(serialized, /colormatrix=bt709/);
  assert.match(serialized, /yuv420p/);
});

test("freeze regression compares longest duration, not the number of intentional changes", () => {
  const control = { maxFreezeDuration: 14.8 };
  const challengerWithMoreShortEvents = { maxFreezeDuration: 4.5 };
  const challengerWithNewLongFreeze = { maxFreezeDuration: 15.3 };

  assert.equal(freezeRegressionAgainstControl(control, challengerWithMoreShortEvents), true);
  assert.equal(freezeRegressionAgainstControl(control, challengerWithNewLongFreeze), false);
});

test("challenger audio limiter cannot auto-compensate gain above the QA ceiling", () => {
  const filter = acceptanceAudioMixFilter();

  assert.match(filter, /volume=0\.82/);
  assert.match(filter, /limit=0\.79/);
  assert.match(filter, /level=false/);
});
