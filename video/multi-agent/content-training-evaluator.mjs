import { canonicalJson, contentHash } from "./contracts.mjs";

const DIMENSIONS = Object.freeze([
  "directionUnderstanding",
  "evidenceDiscipline",
  "actionability",
  "boundaryAwareness",
]);
const HARD_FAILURES = new Set([
  "direction_drift",
  "unsupported_claim",
  "authority_overreach",
  "generic_non_actionable",
]);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function stringList(value, label, { min = 0, max = 8 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} must contain ${min} to ${max} items`);
  }
  return value.map((item, index) => requireString(item, `${label}[${index}]`));
}

function score(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > 2) {
    throw new Error(`${label} must be an integer from 0 to 2`);
  }
  return normalized;
}

function publicAnalysis(record, label) {
  requireObject(record, label);
  const analysis = requireObject(record.analysis, `${label}.analysis`);
  return {
    lockedDirection: requireString(analysis.lockedDirection, `${label}.analysis.lockedDirection`),
    directionRestatement: requireString(analysis.directionRestatement, `${label}.analysis.directionRestatement`),
    audience: requireString(analysis.audience, `${label}.analysis.audience`),
    viewerBenefit: requireString(analysis.viewerBenefit, `${label}.analysis.viewerBenefit`),
    strengths: stringList(analysis.strengths, `${label}.analysis.strengths`, { min: 1 }),
    weaknesses: stringList(analysis.weaknesses, `${label}.analysis.weaknesses`, { min: 1 }),
    evidence: structuredClone(requireObject(analysis.evidence, `${label}.analysis.evidence`)),
    testableQuestion: requireString(analysis.testableQuestion, `${label}.analysis.testableQuestion`),
    nextQuestions: stringList(analysis.nextQuestions, `${label}.analysis.nextQuestions`, { max: 3 }),
    uncertainties: stringList(analysis.uncertainties, `${label}.analysis.uncertainties`),
    recommendation: requireString(analysis.recommendation, `${label}.analysis.recommendation`),
    status: requireString(analysis.status, `${label}.analysis.status`),
  };
}

function sharedContext(record, label) {
  const input = requireObject(record.input, `${label}.input`);
  return {
    audienceContext: String(input.audienceContext || ""),
    userFacts: stringList(input.userFacts, `${label}.input.userFacts`, { max: 20 }),
    evidence: Array.isArray(input.evidence) ? input.evidence.map((item, index) => ({
      id: requireString(item.id, `${label}.input.evidence[${index}].id`),
      kind: requireString(item.kind, `${label}.input.evidence[${index}].kind`),
      summary: requireString(item.summary, `${label}.input.evidence[${index}].summary`),
      provenance: String(item.provenance || "user_provided"),
    })) : [],
    constraints: stringList(input.constraints, `${label}.input.constraints`, { max: 20 }),
  };
}

export function buildBlindedContentTrainingRequest(leftRecord, rightRecord) {
  const left = publicAnalysis(leftRecord, "leftRecord");
  const right = publicAnalysis(rightRecord, "rightRecord");
  if (left.lockedDirection !== right.lockedDirection) throw new Error("A/B analyses must use the same locked direction");
  const leftSharedContext = sharedContext(leftRecord, "leftRecord");
  const rightSharedContext = sharedContext(rightRecord, "rightRecord");
  if (canonicalJson(leftSharedContext) !== canonicalJson(rightSharedContext)) {
    throw new Error("A/B analyses must use the same user facts, evidence, and constraints");
  }
  const leftHash = contentHash(left);
  const rightHash = contentHash(right);
  const seed = contentHash({ leftHash, rightHash });
  const ordered = Number.parseInt(seed[0], 16) % 2 === 0
    ? [{ source: "left", analysis: left }, { source: "right", analysis: right }]
    : [{ source: "right", analysis: right }, { source: "left", analysis: left }];
  const privateMapping = {
    first: ordered[0].source,
    second: ordered[1].source,
  };
  return {
    request: {
      operation: "agent_critique",
      agentId: "content-training-evaluator",
      task: "blind_content_strategy_ab_evaluation",
      lockedDirection: left.lockedDirection,
      sharedContext: leftSharedContext,
      rubric: {
        scoreRange: [0, 2],
        dimensions: {
          directionUnderstanding: "准确理解并保持用户方向，不偷换主题",
          evidenceDiscipline: "区分已知、缺失与不确定性；不得削弱、缩小、矛盾改写或遗漏共享上下文中的明确事实",
          actionability: "给出具体、可执行、能决定下一步的分析",
          boundaryAwareness: "识别适用条件、反例、归因限制和权限边界",
        },
        hardFailures: [...HARD_FAILURES],
        comparisonRule: "只评价分析质量；不得猜测候选来源、知识库、Agent或实验组身份",
      },
      candidates: {
        first: ordered[0].analysis,
        second: ordered[1].analysis,
      },
      outputContract: {
        candidateFields: [...DIMENSIONS, "hardFailures", "summary"],
        comparativeFindings: "2 to 6 concise strings",
        uncertainties: "0 to 5 concise strings",
        forbidWinnerGuessFromIdentity: true,
        grantsApproval: false,
        promotesMemory: false,
      },
    },
    privateMapping,
    publicHashes: { left: leftHash, right: rightHash },
  };
}

function normalizeCandidate(value, label) {
  requireObject(value, label);
  const scores = Object.fromEntries(DIMENSIONS.map(dimension => [dimension, score(value[dimension], `${label}.${dimension}`)]));
  const hardFailures = stringList(value.hardFailures, `${label}.hardFailures`, { max: HARD_FAILURES.size });
  for (const failure of hardFailures) {
    if (!HARD_FAILURES.has(failure)) throw new Error(`${label}.hardFailures contains unsupported value: ${failure}`);
  }
  return {
    scores,
    total: DIMENSIONS.reduce((sum, dimension) => sum + scores[dimension], 0),
    hardFailures: [...new Set(hardFailures)].sort(),
    summary: requireString(value.summary, `${label}.summary`),
  };
}

export function normalizeContentTrainingEvaluation(raw, privateMapping) {
  requireObject(raw, "content training evaluation");
  const first = normalizeCandidate(raw.first, "evaluation.first");
  const second = normalizeCandidate(raw.second, "evaluation.second");
  const comparativeFindings = stringList(raw.comparativeFindings, "evaluation.comparativeFindings", { min: 2, max: 6 });
  const uncertainties = stringList(raw.uncertainties, "evaluation.uncertainties", { max: 5 });
  let winnerPosition;
  if (first.hardFailures.length > 0 && second.hardFailures.length > 0) winnerPosition = "reject_both";
  else if (first.hardFailures.length > 0) winnerPosition = "second";
  else if (second.hardFailures.length > 0) winnerPosition = "first";
  else if (first.total >= second.total + 1) winnerPosition = "first";
  else if (second.total >= first.total + 1) winnerPosition = "second";
  else winnerPosition = "tie";
  const winnerSource = ["first", "second"].includes(winnerPosition)
    ? privateMapping[winnerPosition]
    : winnerPosition;
  return {
    schemaVersion: 1,
    rubricId: "content-strategy-training-ab-v1",
    dimensions: [...DIMENSIONS],
    candidates: { first, second },
    comparativeFindings,
    uncertainties,
    winnerPosition,
    winnerSource,
    authority: {
      grantsApproval: false,
      publishes: false,
      promotesMemory: false,
    },
  };
}

function resultValue(response) {
  if (response?.success === false) throw new Error(response.error || "content training evaluator failed");
  return response?.result ?? response;
}

export function createContentTrainingEvaluator({ invokeAgent } = {}) {
  if (typeof invokeAgent !== "function") throw new Error("invokeAgent is required");
  return {
    async evaluate(leftRecord, rightRecord) {
      const prepared = buildBlindedContentTrainingRequest(leftRecord, rightRecord);
      let raw = resultValue(await invokeAgent(prepared.request));
      try {
        return {
          ...normalizeContentTrainingEvaluation(raw, prepared.privateMapping),
          privateMapping: prepared.privateMapping,
          publicHashes: prepared.publicHashes,
        };
      } catch (error) {
        raw = resultValue(await invokeAgent({
          ...prepared.request,
          validationRepair: {
            attempt: 2,
            previousError: String(error?.message || error).slice(0, 400),
            requirements: [
              "Use integer scores from 0 to 2",
              "Use only declared hard failure values",
              "Return two to six comparative findings",
              "Do not infer candidate identity or grant approval",
            ],
          },
        }));
        return {
          ...normalizeContentTrainingEvaluation(raw, prepared.privateMapping),
          privateMapping: prepared.privateMapping,
          publicHashes: prepared.publicHashes,
        };
      }
    },
  };
}

export function contentTrainingEvaluationPromptHash(request) {
  return contentHash(JSON.parse(canonicalJson(request)));
}
