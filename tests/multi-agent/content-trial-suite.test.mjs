import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { aggregateContentTrialSuite } from "../../scripts/run_creator_vault_content_trial_suite.mjs";

const suite = JSON.parse(fs.readFileSync(new URL("../../config/multi-agent/evaluation/content-strategist-vault-trial-suite.v1.json", import.meta.url), "utf8"));

function run(caseId, repeat, { delta = 2, winnerVariant = "trial", accuracy = 1, trialHardFailures = [] } = {}) {
  return {
    caseId,
    repeat,
    winnerVariant,
    controlTotal: 5,
    trialTotal: 5 + delta,
    trialHardFailures,
    citationAudit: { citedCount: 4, correctCitations: 4 * accuracy },
  };
}

test("trial suite passes only with four direction wins, score lift, citation accuracy, and no regressions", () => {
  const runs = suite.cases.flatMap(item => [run(item.id, 1), run(item.id, 2)]);
  const summary = aggregateContentTrialSuite({ suite, runs });
  assert.equal(summary.passed, true);
  assert.equal(summary.results.trialDirectionWins, 5);
  assert.equal(summary.results.averageScoreDelta, 2);
  assert.equal(summary.results.citationAccuracy, 1);
  assert.equal(summary.recommendation, "continue_to_real_script_trial");
  assert.equal(summary.authority.promotesMemory, false);
});

test("one regression and inconsistent weak results keep all knowledge in trial", () => {
  const runs = suite.cases.flatMap((item, index) => index === 0
    ? [run(item.id, 1, { delta: -2, winnerVariant: "control" }), run(item.id, 2, { delta: 0, winnerVariant: "tie" })]
    : [run(item.id, 1), run(item.id, 2)]);
  const summary = aggregateContentTrialSuite({ suite, runs });
  assert.equal(summary.passed, false);
  assert.equal(summary.results.regressions, 1);
  assert.equal(summary.recommendation, "keep_trial_and_do_not_advance");
});
