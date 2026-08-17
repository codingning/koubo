import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBlindReviewBundle,
  candidateDiversity,
  compareCandidates,
  evaluateCandidate,
} from "../../video/multi-agent/evaluation.mjs";

const baseCandidate = {
  id: "candidate-v4",
  author: "visual-director-v4",
  rationale: "hidden control rationale",
  layout: "speaker-right-information-left",
  captions: { identity: "anchor", placement: "bottom" },
  motion: { structure: ["title-enter", "evidence-reveal"] },
  sound: { structure: [] },
  palette: "v4-orange",
};

const multiCandidate = {
  id: "candidate-multi",
  author: "director-agent",
  agentId: "director-agent",
  prompt: "must stay hidden",
  rationale: "must stay hidden",
  layout: "speaker-pip-evidence-full",
  captions: { identity: "keyword-pop", placement: "semantic-anchor" },
  motion: { structure: ["evidence-fullscreen-transition"] },
  sound: { structure: ["semantic-cue"] },
  palette: "v4-orange",
};

function metrics(overrides = {}) {
  return {
    technical: 1,
    content: 0.9,
    diversity: 0.8,
    brand: 0.9,
    humanEffort: 0.8,
    explainability: 0.9,
    reproducibility: 0.9,
    blindReview: 0.85,
    provenanceCoverage: 1,
    ...overrides,
  };
}

function score(candidate, overrides = {}, options = {}) {
  return evaluateCandidate({
    candidate,
    metrics: metrics(overrides),
    iteration: options.iteration ?? 0,
    baselineId: "koubo-v4-baseline-v1",
    jobId: "job.fixture",
    confounders: {
      sourceHash: "a".repeat(64),
      durationSeconds: 12.4,
      fps: 30,
      rubric: "koubo-multi-agent-rubric-v1",
      ...options.confounders,
    },
    versions: {
      code: "test",
      model: "fixture",
      prompt: "fixture-v1",
      memory: "schema-v1",
      asset: "catalog-v1",
      recipe: "recipe-v1",
      evaluation: "rubric-v1",
    },
  });
}

test("color-only variants fail meaningful diversity", () => {
  const result = candidateDiversity(
    baseCandidate,
    { ...baseCandidate, id: "candidate-color", palette: "v4-blue" }
  );
  assert.equal(result.meaningful, false);
  assert.deepEqual(result.structuralDifferences, []);
  assert.equal(result.cosmeticDifferences.includes("palette"), true);
});

test("layout, motion, caption, or sound changes count as structural diversity", () => {
  const result = candidateDiversity(baseCandidate, multiCandidate);
  assert.equal(result.meaningful, true);
  assert.deepEqual(
    result.structuralDifferences.sort(),
    ["captions", "layout", "motion", "sound"]
  );
});

test("evaluation enforces dimensions, minimums, provenance, and two-iteration ceiling", () => {
  const report = score(multiCandidate);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.iteration, 0);
  assert.equal(report.gatesPassed, true);
  assert.ok(report.weightedScore > 0.8);
  assert.deepEqual(Object.keys(report.scores).sort(), [
    "blindReview",
    "brand",
    "content",
    "diversity",
    "explainability",
    "humanEffort",
    "reproducibility",
    "technical",
  ]);
  assert.throws(
    () => score(multiCandidate, {}, { iteration: 3 }),
    /iteration must be between 0 and 2/
  );
});

test("a candidate with missing provenance cannot outrank v4", () => {
  const v4 = score(baseCandidate, { blindReview: 0.82 });
  const multi = score(multiCandidate, {
    technical: 1,
    content: 0.98,
    diversity: 1,
    brand: 0.98,
    humanEffort: 0.95,
    explainability: 0.95,
    reproducibility: 0.95,
    blindReview: 0.98,
    provenanceCoverage: 0.4,
  });

  const comparison = compareCandidates(v4, multi);

  assert.equal(comparison.winner, "v4");
  assert.equal(comparison.reason, "challenger failed required gates");
  assert.equal(multi.gatesPassed, false);
});

test("technical failure can never be averaged away by subjective scores", () => {
  const v4 = score(baseCandidate);
  const multi = score(multiCandidate, {
    technical: 0.99,
    content: 1,
    diversity: 1,
    brand: 1,
    humanEffort: 1,
    explainability: 1,
    reproducibility: 1,
    blindReview: 1,
  });

  const comparison = compareCandidates(v4, multi);

  assert.equal(comparison.winner, "v4");
  assert.equal(multi.failedGates.includes("technical"), true);
});

test("mismatched source confounders invalidate an A/B winner", () => {
  const v4 = score(baseCandidate);
  const multi = score(multiCandidate, {}, {
    confounders: { sourceHash: "b".repeat(64) },
  });

  const comparison = compareCandidates(v4, multi);

  assert.equal(comparison.winner, null);
  assert.equal(comparison.reason, "comparison is confounded");
  assert.deepEqual(comparison.confounders, ["sourceHash"]);
});

test("challenger wins only with gates, fair confounders, and a material margin", () => {
  const v4 = score(baseCandidate, {
    content: 0.82,
    diversity: 0.62,
    brand: 0.82,
    humanEffort: 0.6,
    explainability: 0.82,
    reproducibility: 0.82,
    blindReview: 0.72,
  });
  const multi = score(multiCandidate, {
    content: 0.96,
    diversity: 0.95,
    brand: 0.94,
    humanEffort: 0.9,
    explainability: 0.96,
    reproducibility: 0.96,
    blindReview: 0.94,
  });

  const comparison = compareCandidates(v4, multi);

  assert.equal(comparison.winner, "challenger");
  assert.ok(comparison.margin >= 0.02);
});

test("blind bundle is stable, order-independent, and strips private fields", () => {
  const candidates = [
    {
      ...baseCandidate,
      transcript: "private transcript body",
      apiKey: "must-not-survive",
      renderPath: "F:\\private\\job\\v4.mp4",
      renderHash: "c".repeat(64),
    },
    {
      ...multiCandidate,
      accessToken: "must-not-survive",
      renderPath: "C:\\Users\\owner\\secret\\multi.mp4",
      renderHash: "d".repeat(64),
    },
  ];
  const forward = buildBlindReviewBundle(candidates, {
    baselineId: "koubo-v4-baseline-v1",
    jobId: "job.fixture",
  });
  const reverse = buildBlindReviewBundle([...candidates].reverse(), {
    baselineId: "koubo-v4-baseline-v1",
    jobId: "job.fixture",
  });
  const serialized = JSON.stringify(forward);

  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.candidates.map(item => item.label), ["A", "B"]);
  assert.equal(serialized.includes("visual-director-v4"), false);
  assert.equal(serialized.includes("director-agent"), false);
  assert.equal(serialized.includes("private transcript body"), false);
  assert.equal(serialized.includes("must-not-survive"), false);
  assert.equal(serialized.includes("C:\\\\"), false);
  assert.equal(serialized.includes("F:\\\\"), false);
  assert.ok(forward.candidates.every(item => /^[a-f0-9]{64}$/.test(item.renderHash)));
});
