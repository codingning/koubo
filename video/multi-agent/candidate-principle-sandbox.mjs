import crypto from "node:crypto";

const SANDBOX_VERSION = "candidate-principle-sandbox-v1";
const CLASSIFICATION_PRIORITY = Object.freeze({
  applicable: 1,
  degraded: 2,
  blocked: 3,
});

const FORBIDDEN_PASSTHROUGH_KEYS = new Set([
  "approval",
  "approve",
  "approved",
  "authority",
  "autopublish",
  "memorypromotion",
  "permissions",
  "productionapproval",
  "promotion",
  "promote",
  "publish",
  "published",
]);

const ALLOWED_SEMANTIC_ROLES = Object.freeze([
  "hook",
  "evidence",
  "turn",
  "step",
  "result",
  "chapter-navigation",
]);

function canonicalValue(value, seen) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON does not support non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(item => canonicalValue(item, seen));
  if (!value || typeof value !== "object") {
    throw new Error(`canonical JSON does not support ${typeof value}`);
  }
  if (seen.has(value)) throw new Error("canonical JSON does not support cyclic values");
  seen.add(value);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    output[key] = canonicalValue(value[key], seen);
  }
  seen.delete(value);
  return output;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value, new Set()));
}

function contentHash(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function rule(id, classification, when, reason, advisoryAction) {
  return Object.freeze({ id, classification, when, reason, advisoryAction });
}

const PRINCIPLE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "content-principle.one-primary-audience-payoff.v1",
    candidateStatus: "candidate",
    sourceGroup: "content",
    rules: Object.freeze([
      rule(
        "payoff.creator-log-without-viewer-gain",
        "blocked",
        { all: [
          { path: "payoff.source", op: "equals", value: "creator_activity_only" },
          { path: "payoff.viewerGainDefined", op: "equals", value: false },
        ] },
        "The scenario records creator activity but does not define what the viewer gains.",
        "return-to-audience-payoff-definition"
      ),
      rule(
        "payoff.non-tool-boundary",
        "degraded",
        { all: [
          {
            path: "payoff.kind",
            op: "in",
            value: ["entertainment", "aesthetic", "companionship", "identity", "emotional"],
          },
          { path: "payoff.observablePracticalActionRequired", op: "equals", value: false },
        ] },
        "The payoff is emotional, aesthetic, entertainment, companionship, or identity value rather than a practical tool outcome.",
        "preserve-the-non-tool-payoff-without-forcing-utility"
      ),
      rule(
        "payoff.one-primary-gain-is-clear",
        "applicable",
        { all: [
          { path: "audience.primaryDefined", op: "equals", value: true },
          { path: "payoff.primaryDefined", op: "equals", value: true },
          { path: "payoff.viewerCanRestate", op: "equals", value: true },
        ] },
        "One primary audience and one restatable viewer payoff are explicit.",
        "use-the-payoff-as-the-content-gate"
      ),
    ]),
  }),
  Object.freeze({
    id: "content-principle.opening-creates-audience-contract.v1",
    candidateStatus: "candidate",
    sourceGroup: "content",
    rules: Object.freeze([
      rule(
        "contract.unrelated-value-without-bridge",
        "blocked",
        { all: [
          { path: "contract.unrelatedSegmentPresent", op: "equals", value: true },
          { path: "contract.causalBridgePresent", op: "equals", value: false },
        ] },
        "A segment may be valuable by itself, but it does not advance the promise that brought the viewer into this video.",
        "remove-the-segment-or-build-a-causal-bridge"
      ),
      rule(
        "contract.story-or-pause-still-serves-promise",
        "degraded",
        { all: [
          { path: "contract.necessaryStoryOrPause", op: "equals", value: true },
          { path: "contract.causalBridgePresent", op: "equals", value: true },
          { path: "contract.stillAdvancesPromise", op: "equals", value: true },
        ] },
        "A story beat or pause reduces surface density but still serves the same audience promise through a clear bridge.",
        "keep-the-bridge-and-review-the-necessary-duration"
      ),
      rule(
        "contract.opening-and-payoff-align",
        "applicable",
        { all: [
          { path: "contract.openingDefined", op: "equals", value: true },
          { path: "contract.majorSectionsAdvance", op: "equals", value: true },
          { path: "contract.endingEvidencePresent", op: "equals", value: true },
          { path: "contract.unrelatedSegmentPresent", op: "equals", value: false },
        ] },
        "The opening promise, major sections, and ending evidence form one traceable audience contract.",
        "keep-each-major-section-mapped-to-the-promise"
      ),
    ]),
  }),
  Object.freeze({
    id: "content-principle.voice-source-before-verbatim-draft.v1",
    candidateStatus: "candidate",
    sourceGroup: "content",
    rules: Object.freeze([
      rule(
        "voice.generic-verbatim-before-source",
        "blocked",
        { all: [
          { path: "voice.sourceConversationCaptured", op: "equals", value: false },
          { path: "voice.draftOrigin", op: "equals", value: "generic_ai_verbatim" },
          { path: "voice.creatorFamiliarWithDraft", op: "equals", value: false },
        ] },
        "A generic verbatim draft was created before the creator's real language and evidence were captured.",
        "return-to-creator-interview-and-language-source"
      ),
      rule(
        "voice.exact-wording-exception",
        "degraded",
        { all: [
          { path: "voice.exactWordingRequired", op: "equals", value: true },
          {
            path: "voice.exactWordingReason",
            op: "in",
            value: ["compliance", "medical", "data", "brand", "accessibility", "non_native"],
          },
        ] },
        "Exact wording is required for a bounded accuracy, accessibility, or communication reason.",
        "use-verbatim-support-while-preserving-sourced-creator-language"
      ),
      rule(
        "voice.source-and-readiness-drive-format",
        "applicable",
        { all: [
          { path: "voice.sourceConversationCaptured", op: "equals", value: true },
          { path: "voice.readinessAssessed", op: "equals", value: true },
          {
            path: "voice.draftMode",
            op: "in",
            value: ["outline", "self_rephrase", "verbatim_by_choice"],
          },
          { path: "voice.aiConnectionTextMarked", op: "equals", value: true },
        ] },
        "The creator's own language is available and the draft form follows current speaking readiness.",
        "build-from-sourced-language-and-the-selected-draft-mode"
      ),
    ]),
  }),
  Object.freeze({
    id: "director-technique.plan-preview-promote-gates.v1",
    candidateStatus: "candidate",
    sourceGroup: "cross-group-director-support",
    rules: Object.freeze([
      rule(
        "gates.vague-request-collapses-independent-gates",
        "blocked",
        { all: [
          { path: "gates.directToFullBuild", op: "equals", value: true },
          { any: [
            { path: "gates.planSeparate", op: "equals", value: false },
            { path: "gates.previewSeparate", op: "equals", value: false },
            { path: "gates.experienceRuleSeparate", op: "equals", value: false },
          ] },
        ] },
        "A vague request jumps to a full build while plan, preview, and experience-rule decisions are collapsed into one acknowledgement.",
        "separate-plan-preview-and-experience-rule-decisions"
      ),
      rule(
        "gates.deterministic-constraint-exception",
        "degraded",
        { all: [
          { path: "gates.deterministicConstraintOnly", op: "equals", value: true },
          { path: "gates.technicalQaRequired", op: "equals", value: true },
        ] },
        "A deterministic encoding, aspect, or safe-area constraint does not need an aesthetic choice round, but it still needs technical verification.",
        "apply-the-constraint-and-run-technical-qa"
      ),
      rule(
        "gates.material-fork-keeps-three-decisions-separate",
        "applicable",
        { all: [
          { path: "gates.materialForkPresent", op: "equals", value: true },
          { path: "gates.planSeparate", op: "equals", value: true },
          { path: "gates.previewSeparate", op: "equals", value: true },
          { path: "gates.experienceRuleSeparate", op: "equals", value: true },
          { path: "gates.engineReasonRecorded", op: "equals", value: true },
        ] },
        "Material plan, preview, engine, or aesthetic forks retain separate human decision points and an auditable engine reason.",
        "continue-with-the-separated-gates"
      ),
    ]),
  }),
  Object.freeze({
    id: "director-principle.freeze-structure-before-packaging.v1",
    candidateStatus: "candidate",
    sourceGroup: "director",
    rules: Object.freeze([
      rule(
        "freeze.unresolved-structure-or-source-defect",
        "blocked",
        { all: [
          { path: "freeze.packagingRequested", op: "equals", value: true },
          { any: [
            { path: "freeze.directionConfirmed", op: "equals", value: false },
            { path: "freeze.roughCutConfirmed", op: "equals", value: false },
            { path: "freeze.unresolvedDefect", op: "equals", value: true },
          ] },
        ] },
        "Expensive packaging is requested while direction, rough cut, or a source defect is unresolved.",
        "resolve-content-and-source-defects-before-packaging"
      ),
      rule(
        "freeze.deterministic-technical-fix",
        "degraded",
        { all: [
          { path: "freeze.technicalFixOnly", op: "equals", value: true },
          { path: "freeze.changesMeaning", op: "equals", value: false },
          { path: "freeze.changesTimeline", op: "equals", value: false },
        ] },
        "A deterministic technical repair may run before structural freeze because it does not change meaning or timing.",
        "apply-the-bounded-fix-without-claiming-structure-is-frozen"
      ),
      rule(
        "freeze.semantic-timeline-is-stable",
        "applicable",
        { all: [
          { path: "freeze.directionConfirmed", op: "equals", value: true },
          { path: "freeze.roughCutConfirmed", op: "equals", value: true },
          { path: "freeze.timelineConfirmed", op: "equals", value: true },
          { path: "freeze.unresolvedDefect", op: "equals", value: false },
        ] },
        "Direction, rough cut, and semantic timeline are stable and no source defect remains open.",
        "allow-bounded-packaging-proposals"
      ),
    ]),
  }),
  Object.freeze({
    id: "director-principle.semantic-role-before-effect.v1",
    candidateStatus: "candidate",
    sourceGroup: "director",
    rules: Object.freeze([
      rule(
        "semantic.effect-name-without-purpose",
        "blocked",
        { all: [
          { path: "semantic.effectChosenFirst", op: "equals", value: true },
          { path: "semantic.purposeDefined", op: "equals", value: false },
        ] },
        "An effect or template was selected before anyone could state its communication purpose.",
        "return-to-the-segment-semantic-role"
      ),
      rule(
        "semantic.technical-repair-exception",
        "degraded",
        { all: [
          { path: "semantic.technicalFixOnly", op: "equals", value: true },
          { path: "semantic.narrativeRoleRequired", op: "equals", value: false },
          { path: "semantic.technicalFixRecorded", op: "equals", value: true },
        ] },
        "A crop, noise repair, continuity adjustment, or similar technical fix can be recorded without inventing a narrative role.",
        "keep-the-repair-labeled-as-technical"
      ),
      rule(
        "semantic.role-drives-expression",
        "applicable",
        { all: [
          { path: "semantic.role", op: "in", value: ALLOWED_SEMANTIC_ROLES },
          { path: "semantic.effectServesRole", op: "equals", value: true },
          { path: "semantic.evidenceNotObscured", op: "equals", value: true },
        ] },
        "The segment has a known semantic role and the proposed expression serves it without hiding evidence.",
        "keep-the-role-to-effect-trace"
      ),
    ]),
  }),
  Object.freeze({
    id: "director-principle.offer-choices-then-freeze-after-evidence.v1",
    candidateStatus: "candidate",
    sourceGroup: "director",
    rules: Object.freeze([
      rule(
        "choices.first-preference-is-frozen-or-rejection-is-missing",
        "blocked",
        { any: [
          { path: "choices.firstPreferenceFrozenImmediately", op: "equals", value: true },
          { path: "choices.rejectAllAllowed", op: "equals", value: false },
        ] },
        "A first preference is being frozen immediately or the reviewer cannot reject the entire group.",
        "restore-small-choices-version-history-and-whole-set-rejection"
      ),
      rule(
        "choices.deterministic-constraint-exception",
        "degraded",
        { all: [
          { path: "choices.deterministicConstraintOnly", op: "equals", value: true },
          { path: "choices.aestheticForkPresent", op: "equals", value: false },
          { path: "choices.technicalQaRequired", op: "equals", value: true },
        ] },
        "A deterministic technical constraint does not need multiple aesthetic candidates.",
        "apply-one-technical-path-and-verify-it"
      ),
      rule(
        "choices.small-distinct-set-with-evidence",
        "applicable",
        { all: [
          { path: "choices.aestheticForkPresent", op: "equals", value: true },
          { path: "choices.candidateCount", op: "gte", value: 2 },
          { path: "choices.candidateCount", op: "lte", value: 3 },
          { path: "choices.candidatesClearlyDifferent", op: "equals", value: true },
          { path: "choices.rejectAllAllowed", op: "equals", value: true },
          { path: "choices.evidenceRounds", op: "gte", value: 2 },
          { path: "choices.explicitHumanChoiceRequired", op: "equals", value: true },
        ] },
        "A small, distinct candidate set allows whole-set rejection and waits for repeated evidence plus an explicit human choice before freezing.",
        "keep-the-versioned-choice-set-open"
      ),
    ]),
  }),
]);

const PRINCIPLE_BY_ID = new Map(PRINCIPLE_DEFINITIONS.map(item => [item.id, item]));

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainJson(value, trail = []) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number is not allowed at ${trail.join(".") || "root"}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainJson(item, [...trail, String(index)]));
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error(`plain JSON object is required at ${trail.join(".") || "root"}`);
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z]/giu, "").toLowerCase();
    if (FORBIDDEN_PASSTHROUGH_KEYS.has(normalized)) {
      throw new Error(`authority-like input key is forbidden: ${[...trail, key].join(".")}`);
    }
    assertPlainJson(item, [...trail, key]);
  }
}

function valueAtPath(facts, pathExpression) {
  return String(pathExpression || "")
    .split(".")
    .filter(Boolean)
    .reduce((value, key) => (value == null ? undefined : value[key]), facts);
}

function isEmpty(value) {
  if (value == null) return true;
  if (typeof value === "string" || Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function jsonEqual(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function evaluateLeaf(condition, facts) {
  if (!condition.path || !condition.op) throw new Error("declarative condition needs path and op");
  const actual = valueAtPath(facts, condition.path);
  switch (condition.op) {
    case "equals":
      return jsonEqual(actual, condition.value);
    case "notEquals":
      return !jsonEqual(actual, condition.value);
    case "exists":
      return actual !== undefined;
    case "in":
      if (!Array.isArray(condition.value)) throw new Error("in condition needs an array value");
      return condition.value.some(item => jsonEqual(item, actual));
    case "notIn":
      if (!Array.isArray(condition.value)) throw new Error("notIn condition needs an array value");
      return condition.value.every(item => !jsonEqual(item, actual));
    case "gte":
      return Number.isFinite(actual) && actual >= condition.value;
    case "lte":
      return Number.isFinite(actual) && actual <= condition.value;
    case "empty":
      return isEmpty(actual);
    case "nonEmpty":
      return !isEmpty(actual);
    default:
      throw new Error(`unsupported declarative operator: ${condition.op}`);
  }
}

function evaluateCondition(condition, facts) {
  if (!isPlainObject(condition)) throw new Error("declarative condition must be an object");
  const compositeKeys = ["all", "any", "not"].filter(key => key in condition);
  if (compositeKeys.length > 1) throw new Error("declarative condition may use only one composite operator");
  if ("all" in condition) {
    if (!Array.isArray(condition.all) || condition.all.length === 0) throw new Error("all condition needs entries");
    return condition.all.every(item => evaluateCondition(item, facts));
  }
  if ("any" in condition) {
    if (!Array.isArray(condition.any) || condition.any.length === 0) throw new Error("any condition needs entries");
    return condition.any.some(item => evaluateCondition(item, facts));
  }
  if ("not" in condition) return !evaluateCondition(condition.not, facts);
  return evaluateLeaf(condition, facts);
}

function assertNonEmptyString(value, label) {
  if (!String(value || "").trim()) throw new Error(`${label} is required`);
  return String(value).trim();
}

function assertEvaluation(value) {
  if (!isPlainObject(value)) throw new Error("evaluation must be an object");
  if (value.candidateStatus !== "candidate") throw new Error("evaluation must remain candidate");
  if (!Object.hasOwn(CLASSIFICATION_PRIORITY, value.classification)) {
    throw new Error("evaluation classification is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(String(value.evaluationHash || ""))) {
    throw new Error("evaluation hash is invalid");
  }
}

export function listCandidatePrinciples() {
  return PRINCIPLE_DEFINITIONS.map(item => ({
    id: item.id,
    candidateStatus: item.candidateStatus,
    sourceGroup: item.sourceGroup,
    ruleIds: item.rules.map(ruleItem => ruleItem.id),
  }));
}

export function candidatePrincipleContentHash(value) {
  assertPlainJson(value);
  return contentHash(value);
}

export function evaluateCandidatePrincipleScenario({
  scenarioId,
  principleId,
  facts,
} = {}) {
  const normalizedScenarioId = assertNonEmptyString(scenarioId, "scenarioId");
  const normalizedPrincipleId = assertNonEmptyString(principleId, "principleId");
  const principle = PRINCIPLE_BY_ID.get(normalizedPrincipleId);
  if (!principle) throw new Error(`unknown candidate principle: ${normalizedPrincipleId}`);
  if (!isPlainObject(facts)) throw new Error("facts must be a plain object");
  assertPlainJson(facts);

  const matches = principle.rules
    .map((ruleItem, index) => ({ rule: ruleItem, index }))
    .filter(item => evaluateCondition(item.rule.when, facts));
  const selected = [...matches].sort((left, right) => (
    CLASSIFICATION_PRIORITY[right.rule.classification]
      - CLASSIFICATION_PRIORITY[left.rule.classification]
      || left.index - right.index
  ))[0];

  const selectedRule = selected?.rule || {
    id: "sandbox.insufficient-declarative-evidence",
    classification: "blocked",
    reason: "The declared facts do not establish a safe candidate-principle recommendation.",
    advisoryAction: "add-scenario-evidence-before-continuing",
  };
  const core = {
    schemaVersion: 1,
    sandboxVersion: SANDBOX_VERSION,
    scenarioId: normalizedScenarioId,
    principleId: normalizedPrincipleId,
    candidateStatus: "candidate",
    classification: selectedRule.classification,
    selectedRuleId: selectedRule.id,
    matchedRuleIds: matches.map(item => item.rule.id),
    reasons: [selectedRule.reason],
    advisoryAction: selectedRule.advisoryAction,
    factsHash: contentHash(facts),
  };
  return {
    ...core,
    evaluationHash: contentHash(core),
  };
}

export function evaluateCandidatePrincipleScenarios(scenarios = []) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error("at least one candidate-principle scenario is required");
  }
  const scenarioIds = new Set();
  return scenarios.map(scenario => {
    if (scenarioIds.has(scenario?.id)) throw new Error(`duplicate scenario id: ${scenario.id}`);
    scenarioIds.add(scenario?.id);
    return evaluateCandidatePrincipleScenario({
      scenarioId: scenario?.id,
      principleId: scenario?.principleId,
      facts: scenario?.facts,
    });
  });
}

export function recordWholeSetRejection({
  reviewId,
  evaluations,
  reason,
} = {}) {
  const normalizedReviewId = assertNonEmptyString(reviewId, "reviewId");
  const normalizedReason = assertNonEmptyString(reason, "reason");
  if (!Array.isArray(evaluations) || evaluations.length === 0) {
    throw new Error("whole-set rejection needs evaluated candidates");
  }
  evaluations.forEach(assertEvaluation);
  const core = {
    schemaVersion: 1,
    sandboxVersion: SANDBOX_VERSION,
    reviewId: normalizedReviewId,
    candidateStatus: "candidate",
    classification: "whole_set_rejected",
    evaluatedScenarioCount: evaluations.length,
    principleIds: [...new Set(evaluations.map(item => item.principleId))].sort(),
    evaluationHashes: evaluations.map(item => item.evaluationHash).sort(),
    reason: normalizedReason,
    advisoryAction: "return-to-principle-or-scenario-design",
  };
  return {
    ...core,
    reviewHash: contentHash(core),
  };
}

export function buildCandidatePrincipleScenarioReport({
  batchId,
  scenarios,
  evaluations,
  wholeSetRejection,
} = {}) {
  const normalizedBatchId = assertNonEmptyString(batchId, "batchId");
  if (!Array.isArray(scenarios) || !Array.isArray(evaluations)) {
    throw new Error("scenarios and evaluations are required");
  }
  if (scenarios.length !== evaluations.length) {
    throw new Error("scenario and evaluation counts must match");
  }
  evaluations.forEach(assertEvaluation);
  const scenarioById = new Map(scenarios.map(item => [item.id, item]));
  const counts = Object.fromEntries(Object.keys(CLASSIFICATION_PRIORITY).map(key => [key, 0]));
  for (const evaluation of evaluations) counts[evaluation.classification] += 1;
  const lines = [
    `# Candidate principle scenario report: ${normalizedBatchId}`,
    "",
    `- Sandbox: \`${SANDBOX_VERSION}\``,
    "- Candidate state: `candidate`",
    `- Scenarios: ${evaluations.length}`,
    `- Results: applicable ${counts.applicable}, blocked ${counts.blocked}, degraded ${counts.degraded}`,
    `- Whole-set outcome: \`${wholeSetRejection?.classification || "not_recorded"}\``,
    "",
    "| Scenario | Principle | Expected category | Result | Rule |",
    "|---|---|---|---|---|",
  ];
  for (const evaluation of evaluations) {
    const scenario = scenarioById.get(evaluation.scenarioId) || {};
    lines.push(
      `| ${evaluation.scenarioId} | \`${evaluation.principleId}\` | ${scenario.category || "unknown"} | ${evaluation.classification} | \`${evaluation.selectedRuleId}\` |`
    );
  }
  lines.push("", "This report is advisory evidence only. It does not change runtime configuration, persistent state, or production behavior.", "");
  return lines.join("\n");
}
