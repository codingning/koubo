import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCandidatePrincipleScenarioReport,
  candidatePrincipleContentHash,
  evaluateCandidatePrincipleScenario,
  evaluateCandidatePrincipleScenarios,
  listCandidatePrinciples,
  recordWholeSetRejection,
} from "../../video/multi-agent/candidate-principle-sandbox.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDir, "..", "..");
const fixtureFile = path.join(
  repositoryRoot,
  "tests",
  "fixtures",
  "candidate-principle-scenarios.json"
);

function readFixture() {
  return JSON.parse(fs.readFileSync(fixtureFile, "utf8").replace(/^\uFEFF/u, ""));
}

function collectKeys(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach(item => collectKeys(item, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value)) {
    output.push(key);
    collectKeys(item, output);
  }
  return output;
}

test("covers seven candidate principles with applicable, blocked, and degraded scenarios", () => {
  const fixture = readFixture();
  const principles = listCandidatePrinciples();
  assert.equal(principles.length, 7);
  assert.equal(fixture.scenarios.length, 21);
  assert.equal(fixture.candidateStatus, "candidate");

  const counts = new Map();
  for (const scenario of fixture.scenarios) {
    const current = counts.get(scenario.principleId) || new Set();
    current.add(scenario.category);
    counts.set(scenario.principleId, current);
  }
  assert.deepEqual([...counts.keys()].sort(), principles.map(item => item.id).sort());
  for (const categories of counts.values()) {
    assert.deepEqual([...categories].sort(), ["applicable", "blocked", "degraded"]);
  }
  assert.deepEqual(
    Object.fromEntries(["applicable", "blocked", "degraded"].map(category => [
      category,
      fixture.scenarios.filter(item => item.category === category).length,
    ])),
    { applicable: 7, blocked: 7, degraded: 7 }
  );
});

test("evaluates all fixture scenarios deterministically and keeps every principle candidate", () => {
  const fixture = readFixture();
  const evaluations = evaluateCandidatePrincipleScenarios(fixture.scenarios);
  assert.equal(evaluations.length, fixture.scenarios.length);

  evaluations.forEach((evaluation, index) => {
    const scenario = fixture.scenarios[index];
    assert.equal(evaluation.scenarioId, scenario.id);
    assert.equal(evaluation.principleId, scenario.principleId);
    assert.equal(evaluation.candidateStatus, "candidate");
    assert.equal(evaluation.classification, scenario.expected.classification);
    assert.equal(evaluation.selectedRuleId, scenario.expected.selectedRuleId);
    assert.match(evaluation.factsHash, /^[a-f0-9]{64}$/u);
    assert.match(evaluation.evaluationHash, /^[a-f0-9]{64}$/u);
    assert.equal(evaluation.reasons.length, 1);
  });

  const reordered = structuredClone(fixture.scenarios[0]);
  reordered.facts = {
    payoff: {
      observablePracticalActionRequired: true,
      kind: "understanding",
      viewerCanRestate: true,
      viewerGainDefined: true,
      primaryDefined: true,
      source: "viewer_change",
    },
    audience: { primaryDefined: true },
  };
  assert.deepEqual(
    evaluateCandidatePrincipleScenario({
      scenarioId: reordered.id,
      principleId: reordered.principleId,
      facts: reordered.facts,
    }),
    evaluations[0]
  );
});

test("fails closed when evidence is insufficient and rejects authority-like passthrough", () => {
  const fallback = evaluateCandidatePrincipleScenario({
    scenarioId: "insufficient-evidence",
    principleId: "content-principle.one-primary-audience-payoff.v1",
    facts: {},
  });
  assert.equal(fallback.candidateStatus, "candidate");
  assert.equal(fallback.classification, "blocked");
  assert.equal(fallback.selectedRuleId, "sandbox.insufficient-declarative-evidence");

  assert.throws(
    () => evaluateCandidatePrincipleScenario({
      scenarioId: "unsafe-passthrough",
      principleId: "content-principle.one-primary-audience-payoff.v1",
      facts: { publish: true },
    }),
    /authority-like input key is forbidden/
  );
  assert.throws(
    () => evaluateCandidatePrincipleScenario({
      scenarioId: "unknown-principle",
      principleId: "content-principle.unknown.v1",
      facts: {},
    }),
    /unknown candidate principle/
  );
});

test("resolves overlapping declarative rules with blocked before degraded before applicable", () => {
  const result = evaluateCandidatePrincipleScenario({
    scenarioId: "overlapping-payoff-rules",
    principleId: "content-principle.one-primary-audience-payoff.v1",
    facts: {
      audience: { primaryDefined: true },
      payoff: {
        source: "creator_activity_only",
        primaryDefined: true,
        viewerGainDefined: false,
        viewerCanRestate: true,
        kind: "companionship",
        observablePracticalActionRequired: false,
      },
    },
  });
  assert.equal(result.classification, "blocked");
  assert.equal(result.selectedRuleId, "payoff.creator-log-without-viewer-gain");
  assert.deepEqual(result.matchedRuleIds, [
    "payoff.creator-log-without-viewer-gain",
    "payoff.non-tool-boundary",
    "payoff.one-primary-gain-is-clear",
  ]);
});

test("outputs no authority fields and does not touch production or persistent state", () => {
  const fixture = readFixture();
  const evaluations = evaluateCandidatePrincipleScenarios(fixture.scenarios);
  const forbiddenKeys = new Set([
    "approval",
    "approve",
    "approved",
    "authority",
    "autoPublish",
    "memoryPromotion",
    "permissions",
    "productionApproval",
    "promotion",
    "promote",
    "publish",
    "published",
    "selected",
    "winner",
  ].map(item => item.toLowerCase()));
  for (const key of collectKeys(evaluations)) {
    assert.equal(forbiddenKeys.has(key.toLowerCase()), false, key);
  }

  const source = fs.readFileSync(
    path.join(repositoryRoot, "video", "multi-agent", "candidate-principle-sandbox.mjs"),
    "utf8"
  );
  assert.equal(source.includes("memory.transition"), false);
  assert.equal(source.includes("content-principles.json"), false);
  assert.equal(source.includes("agent-profiles.json"), false);
  assert.equal(source.includes("memory.sqlite"), false);
  assert.equal(source.includes("./contracts.mjs"), false);
  assert.equal(source.includes("fetch("), false);
  assert.equal(source.includes("node:fs"), false);
  assert.equal(source.includes("node:child_process"), false);
});

test("records an explicit whole-set rejection without forcing a relative winner", () => {
  const fixture = readFixture();
  const evaluations = evaluateCandidatePrincipleScenarios(fixture.scenarios);
  const rejection = recordWholeSetRejection({
    reviewId: fixture.wholeSetReview.reviewId,
    evaluations,
    reason: fixture.wholeSetReview.reason,
  });

  assert.equal(rejection.candidateStatus, "candidate");
  assert.equal(rejection.classification, "whole_set_rejected");
  assert.equal(rejection.evaluatedScenarioCount, 21);
  assert.equal(rejection.principleIds.length, 7);
  assert.equal(rejection.evaluationHashes.length, 21);
  assert.match(rejection.reviewHash, /^[a-f0-9]{64}$/u);
  assert.equal("winner" in rejection, false);
  assert.equal("selected" in rejection, false);

  const second = recordWholeSetRejection({
    reviewId: fixture.wholeSetReview.reviewId,
    evaluations: [...evaluations].reverse(),
    reason: fixture.wholeSetReview.reason,
  });
  assert.equal(second.reviewHash, rejection.reviewHash);
  assert.deepEqual(second, rejection);
});

test("builds a deterministic report over all scenario results", () => {
  const fixture = readFixture();
  const evaluations = evaluateCandidatePrincipleScenarios(fixture.scenarios);
  const rejection = recordWholeSetRejection({
    reviewId: fixture.wholeSetReview.reviewId,
    evaluations,
    reason: fixture.wholeSetReview.reason,
  });
  const report = buildCandidatePrincipleScenarioReport({
    batchId: fixture.batchId,
    scenarios: fixture.scenarios,
    evaluations,
    wholeSetRejection: rejection,
  });
  assert.match(report, /Scenarios: 21/u);
  assert.match(report, /applicable 7, blocked 7, degraded 7/u);
  assert.match(report, /whole_set_rejected/u);
  for (const principle of listCandidatePrinciples()) assert.match(report, new RegExp(principle.id));
  assert.equal(
    report,
    buildCandidatePrincipleScenarioReport({
      batchId: fixture.batchId,
      scenarios: fixture.scenarios,
      evaluations,
      wholeSetRejection: rejection,
    })
  );
});

test("checked-in research report carries the verified counts and hashes", () => {
  const fixture = readFixture();
  const evaluations = evaluateCandidatePrincipleScenarios(fixture.scenarios);
  const rejection = recordWholeSetRejection({
    reviewId: fixture.wholeSetReview.reviewId,
    evaluations,
    reason: fixture.wholeSetReview.reason,
  });
  const scenarioSetHash = candidatePrincipleContentHash(
    evaluations.map(item => item.evaluationHash).sort()
  );
  const report = fs.readFileSync(
    path.join(
      repositoryRoot,
      "docs",
      "research",
      "2026-07-24-candidate-principle-sandbox-batch-1.md"
    ),
    "utf8"
  );
  assert.match(report, /21 个场景/u);
  assert.match(report, /applicable 7 \/ blocked 7 \/ degraded 7/u);
  assert.equal(report.includes(scenarioSetHash), true);
  assert.equal(report.includes(rejection.reviewHash), true);
  assert.match(report, /no_runtime_integration/u);
});
