import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const library = JSON.parse(fs.readFileSync(
  new URL("../../config/multi-agent/content-task-knowledge.v1.json", import.meta.url),
  "utf8"
));
const heldout = JSON.parse(fs.readFileSync(
  new URL("../../config/multi-agent/evaluation/content-strategist-task-knowledge-heldout-suite.v1.json", import.meta.url),
  "utf8"
));

test("private task knowledge is narrow, artifact-bound, and trial-only", () => {
  assert.equal(library.cards.length, 3);
  assert.equal(library.usageBoundary.privateToContentStrategist, true);
  assert.equal(library.usageBoundary.trialOnly, true);
  assert.equal(library.usageBoundary.productionDefault, false);
  assert.equal(library.usageBoundary.grantsApproval, false);
  assert.match(library.sourceCommit, /^[a-f0-9]{40}$/u);
  for (const card of library.cards) {
    assert.match(card.id, /^content-task\.[a-z0-9.-]+\.v1$/u);
    assert.ok(card.requiredEvidence.length >= 4, card.id);
    assert.ok(card.decisionProcedure.length >= 4, card.id);
    assert.ok(card.failureSignals.length >= 4, card.id);
    assert.ok(card.counterexamples.length >= 2, card.id);
    assert.equal(card.evidence.length, 2, card.id);
    for (const evidence of card.evidence) {
      assert.match(evidence.contentHash, /^[a-f0-9]{64}$/u);
      assert.match(evidence.commit, /^[a-f0-9]{40}$/u);
      assert.equal(evidence.repository, "codingning/koubo");
      assert.ok(evidence.relativePath.startsWith("data/acceptance/creator-vault-content-trial-suite-v2/"));
    }
  }
});

test("held-out suite keeps the original gate and does not copy task-card wording", () => {
  assert.equal(heldout.cases.length, 5);
  assert.equal(heldout.repeats, 2);
  assert.equal(heldout.thresholds.minimumTrialDirectionWins, 4);
  assert.equal(heldout.thresholds.minimumAverageScoreDelta, 1);
  assert.equal(heldout.thresholds.maximumRegressions, 0);
  const ids = new Set(heldout.cases.map(item => item.id));
  assert.equal(ids.size, 5);
  const cardClaims = library.cards.map(card => card.claim);
  for (const item of heldout.cases) {
    assert.ok(item.evidence.length >= 2, item.id);
    assert.ok(item.constraints.length >= 3, item.id);
    assert.equal(cardClaims.includes(item.direction), false, item.id);
  }
});
