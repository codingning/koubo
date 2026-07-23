import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptanceAudioMixFilter,
  acceptanceVideoEncodingArgs,
  acceptanceRecipes,
  blindMediaPlan,
  freezeRegressionAgainstControl,
  publicAcceptanceValue,
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
