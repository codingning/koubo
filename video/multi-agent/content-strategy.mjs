import { contentHash } from "./contracts.mjs";

const ANALYSIS_STATUSES = Object.freeze([
  "ready_for_script",
  "needs_evidence",
  "needs_restructure",
  "recommend_abandon",
]);

const RECOMMENDATIONS = Object.freeze(["single_piece", "series", "defer"]);

const STATUS_ALIASES = Object.freeze({
  ready_for_script: "ready_for_script",
  "可进入成稿": "ready_for_script",
  needs_evidence: "needs_evidence",
  "补证后再写": "needs_evidence",
  needs_restructure: "needs_restructure",
  "方向需重构": "needs_restructure",
  recommend_abandon: "recommend_abandon",
  "建议放弃": "recommend_abandon",
});

const RECOMMENDATION_ALIASES = Object.freeze({
  single_piece: "single_piece",
  "单篇": "single_piece",
  series: "series",
  "系列": "series",
  defer: "defer",
  "暂缓": "defer",
});

const FORBIDDEN_DRAFT_KEYS = new Set([
  "script",
  "fullscript",
  "draft",
  "narration",
  "voiceover",
  "hook",
  "hooks",
  "title",
  "titles",
  "shotlist",
  "editplan",
  "sceneplan",
  "captionplan",
]);

const DIRECTION_KEYS = new Set([
  "direction",
  "lockeddirection",
  "proposeddirection",
  "newdirection",
  "replacementdirection",
  "topic",
  "newtopic",
  "replacementtopic",
]);
const AUTHORITY_KEYS = new Set([
  "approval",
  "approved",
  "approvedat",
  "autopublish",
  "finaloutput",
  "memorypromotion",
  "productionapproval",
  "promote",
  "publish",
  "publishedat",
]);

function keyToken(key) {
  return String(key).replace(/[-_\s]/g, "").toLowerCase();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function optionalString(value) {
  return String(value ?? "").trim();
}

function assertNoLocalPath(value, label) {
  const text = optionalString(value);
  if (text && (/(?:file:\/\/\/?|\\\\\?\\[A-Za-z]:\\|(?:^|[^A-Za-z0-9+.-])[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+|(?:^|[\s"'([{=])\/(?:Users|home|tmp|var|etc|mnt|opt|srv|Volumes|private|root)(?:[\\/]|$))/iu.test(text))) {
    throw new Error(`${label} must use an opaque artifact id or public URL, not a local path`);
  }
  return text;
}

function requirePublicString(value, label) {
  const text = requireString(value, label);
  assertNoLocalPath(text, label);
  return text;
}

function stringList(value, label, { maxItems = Infinity, minItems = 0 } = {}) {
  if (value === undefined || value === null) value = [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const normalized = value.map((item, index) => requireString(item, `${label}[${index}]`));
  if (normalized.length < minItems) throw new Error(`${label} must contain at least ${minItems} item(s)`);
  if (normalized.length > maxItems) throw new Error(`${label} must contain at most ${maxItems} item(s)`);
  return normalized;
}

function normalizeEvidenceInput(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("evidence must be an array");
  const seen = new Set();
  return value.map((item, index) => {
    requireObject(item, `evidence[${index}]`);
    const id = requirePublicString(item.id, `evidence[${index}].id`);
    if (seen.has(id)) throw new Error(`duplicate evidence id: ${id}`);
    seen.add(id);
    const normalized = {
      id,
      kind: requirePublicString(item.kind, `evidence[${index}].kind`),
      summary: requirePublicString(item.summary, `evidence[${index}].summary`),
      sourceId: requirePublicString(item.sourceId || item.id, `evidence[${index}].sourceId`),
      provenance: requirePublicString(item.provenance || "user_provided", `evidence[${index}].provenance`),
    };
    const hasStart = item.start !== undefined;
    const hasEnd = item.end !== undefined;
    if (hasStart !== hasEnd) throw new Error(`evidence[${index}] start and end must be provided together`);
    if (hasStart) {
      if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start) {
        throw new Error(`evidence[${index}] requires a valid timestamp range`);
      }
      normalized.start = Number(item.start);
      normalized.end = Number(item.end);
    }
    const locator = assertNoLocalPath(item.locator, `evidence[${index}].locator`);
    const source = assertNoLocalPath(item.source, `evidence[${index}].source`);
    if (locator) normalized.locator = locator;
    if (source) normalized.source = source;
    return normalized;
  });
}

function normalizeInterviewAnswers(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("interviewAnswers must be an array");
  return value.map((item, index) => {
    requireObject(item, `interviewAnswers[${index}]`);
    return {
      question: requireString(item.question, `interviewAnswers[${index}].question`),
      answer: requireString(item.answer, `interviewAnswers[${index}].answer`),
    };
  });
}

function assertMinimalInput(input) {
  requireObject(input, "content strategist input");
  if (input.schemaVersion !== 1) throw new Error("content strategist input schemaVersion must equal 1");
  if (input.stage !== "direction_analysis") throw new Error("content strategist input stage must be direction_analysis");
  const lockedDirection = requireString(input.lockedDirection, "lockedDirection");
  if (input.directionAuthority?.owner !== "user") throw new Error("direction authority must remain with the user");
  if (input.directionAuthority?.strategistMayReplace !== false) {
    throw new Error("Content Strategist must not have topic replacement authority");
  }
  if (!Array.isArray(input.evidence)) throw new Error("evidence must be an array");
  return lockedDirection;
}

function normalizePrinciples(value) {
  const list = Array.isArray(value) ? value : value?.principles;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error("principles must be an array or a principle library");
  return list
    .filter(item => item?.status !== "rejected" && item?.status !== "superseded")
    .map((item, index) => {
      requireObject(item, `principles[${index}]`);
      const timecodes = Array.isArray(item.timecodes) ? item.timecodes : [];
      if (timecodes.length === 0) throw new Error(`principles[${index}].timecodes must not be empty`);
      return {
        id: requireString(item.id, `principles[${index}].id`),
        sourceVideoId: requireString(item.sourceVideoId, `principles[${index}].sourceVideoId`),
        timecodes: timecodes.map((range, rangeIndex) => {
          requireObject(range, `principles[${index}].timecodes[${rangeIndex}]`);
          if (!Number.isFinite(range.startSeconds) || !Number.isFinite(range.endSeconds)) {
            throw new Error(`principles[${index}].timecodes[${rangeIndex}] must contain numeric start/end`);
          }
          if (range.startSeconds < 0 || range.endSeconds <= range.startSeconds) {
            throw new Error(`principles[${index}].timecodes[${rangeIndex}] must be a valid range`);
          }
          return {
            startSeconds: range.startSeconds,
            endSeconds: range.endSeconds,
            startLabel: requireString(range.startLabel, `principles[${index}].timecodes[${rangeIndex}].startLabel`),
            endLabel: requireString(range.endLabel, `principles[${index}].timecodes[${rangeIndex}].endLabel`),
          };
        }),
        claim: requireString(item.claim, `principles[${index}].claim`),
        abstraction: requireString(item.abstraction, `principles[${index}].abstraction`),
        applicability: stringList(item.applicability, `principles[${index}].applicability`, { minItems: 1 }),
        counterexamples: stringList(item.counterexamples, `principles[${index}].counterexamples`, { minItems: 1 }),
        status: requireString(item.status, `principles[${index}].status`),
        authority: item.status === "accepted" ? "user_accepted_rule" : "advisory_candidate_only",
        contentHash: contentHash(item),
      };
    });
}

function normalizePrincipleCitations(value, principles) {
  const normalizedPrinciples = normalizePrinciples(principles);
  if (normalizedPrinciples.length === 0) {
    if (!Array.isArray(value) || value.length !== 0) {
      throw new Error("output.principleCitations must be empty when no principles are supplied");
    }
    return [];
  }
  if (!Array.isArray(value)) throw new Error("output.principleCitations must be an array");
  if (value.length > 3) throw new Error("output.principleCitations must contain at most three material principles");
  const available = new Map(normalizedPrinciples.map(item => [item.id, item]));
  const seen = new Set();
  return value.map((item, index) => {
    requireObject(item, `output.principleCitations[${index}]`);
    const principleId = requireString(item.principleId, `output.principleCitations[${index}].principleId`);
    const principle = available.get(principleId);
    if (!principle) throw new Error(`output cites unavailable principle: ${principleId}`);
    if (seen.has(principleId)) throw new Error(`output cites duplicate principle: ${principleId}`);
    seen.add(principleId);
    const declaredHash = requireString(item.contentHash, `output.principleCitations[${index}].contentHash`);
    if (declaredHash !== principle.contentHash) {
      throw new Error(`output cites stale principle hash: ${principleId}`);
    }
    return {
      principleId,
      contentHash: principle.contentHash,
      relevance: requireString(item.relevance, `output.principleCitations[${index}].relevance`),
      appliedJudgment: requireString(item.appliedJudgment, `output.principleCitations[${index}].appliedJudgment`),
      applicabilityCheck: requireString(item.applicabilityCheck, `output.principleCitations[${index}].applicabilityCheck`),
      counterexampleCheck: requireString(item.counterexampleCheck, `output.principleCitations[${index}].counterexampleCheck`),
      authority: principle.authority,
      sourceVideoId: principle.sourceVideoId,
      timecodes: principle.timecodes.map(range => ({ ...range })),
    };
  });
}

function assertNoDraftMaterial(value, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDraftMaterial(item, [...path, String(index)]));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_DRAFT_KEYS.has(keyToken(key))) {
      throw new Error(`Content Strategist output contains forbidden draft field: ${[...path, key].join(".")}`);
    }
    assertNoDraftMaterial(item, [...path, key]);
  }
}

function assertNoAuthority(value, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoAuthority(item, [...path, String(index)]));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (AUTHORITY_KEYS.has(keyToken(key))) {
      throw new Error(`Content Strategist output contains forbidden authority field: ${[...path, key].join(".")}`);
    }
    assertNoAuthority(item, [...path, key]);
  }
}

function assertNoDirectionChange(value, lockedDirection, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDirectionChange(item, lockedDirection, [...path, String(index)]));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const token = keyToken(key);
    if (token === "topicchange" && item !== false && item !== "none" && item !== "no_change") {
      throw new Error(`Content Strategist attempted to change the user-locked direction at ${[...path, key].join(".")}`);
    }
    if (DIRECTION_KEYS.has(token)) {
      if (typeof item !== "string" || item.trim() !== lockedDirection) {
        throw new Error(`Content Strategist attempted to change the user-locked direction at ${[...path, key].join(".")}`);
      }
    }
    assertNoDirectionChange(item, lockedDirection, [...path, key]);
  }
}

function normalizeAvailableEvidence(value, inputEvidence) {
  if (!Array.isArray(value)) throw new Error("output.evidence.available must be an array");
  const allowed = new Map(inputEvidence.map(item => [item.id, item]));
  const seen = new Set();
  return value.map((item, index) => {
    const record = typeof item === "string" ? { id: item } : requireObject(item, `output.evidence.available[${index}]`);
    const id = requireString(record.id, `output.evidence.available[${index}].id`);
    if (!allowed.has(id)) throw new Error(`output cites unavailable evidence: ${id}`);
    if (seen.has(id)) throw new Error(`output cites duplicate evidence: ${id}`);
    seen.add(id);
    const normalized = { id };
    const relevance = optionalString(record.relevance);
    if (relevance) normalized.relevance = relevance;
    const source = allowed.get(id);
    normalized.sourceId = source.sourceId;
    normalized.provenance = source.provenance;
    if (Number.isFinite(source.start) && Number.isFinite(source.end)) {
      normalized.start = source.start;
      normalized.end = source.end;
    }
    return normalized;
  });
}

function normalizedStatus(value) {
  const status = STATUS_ALIASES[String(value ?? "").trim()];
  if (!status || !ANALYSIS_STATUSES.includes(status)) {
    throw new Error(`status must be one of: ${ANALYSIS_STATUSES.join(", ")}`);
  }
  return status;
}

function normalizedRecommendation(value) {
  const recommendation = RECOMMENDATION_ALIASES[String(value ?? "").trim()];
  if (!recommendation || !RECOMMENDATIONS.includes(recommendation)) {
    throw new Error(`recommendation must be one of: ${RECOMMENDATIONS.join(", ")}`);
  }
  return recommendation;
}

function hasUserConfirmation(input) {
  return input.userConfirmation?.analysisApproved === true
    && input.userConfirmation?.confirmedDirection === input.lockedDirection;
}

export function buildContentStrategistInput({
  direction,
  directionSource = "user",
  audienceContext = "",
  userFacts = [],
  evidence = [],
  constraints = [],
  interviewAnswers = [],
  userConfirmation = {},
} = {}) {
  const lockedDirection = requirePublicString(direction, "direction");
  if (directionSource !== "user") {
    throw new Error("Content Strategist requires an explicit user-provided direction");
  }
  const analysisApproved = userConfirmation.analysisApproved === true;
  const confirmedDirection = analysisApproved
    ? requireString(userConfirmation.confirmedDirection, "userConfirmation.confirmedDirection")
    : null;
  if (analysisApproved && confirmedDirection !== lockedDirection) {
    throw new Error("user confirmation must match the original locked direction");
  }
  return {
    schemaVersion: 1,
    stage: "direction_analysis",
    lockedDirection,
    directionAuthority: {
      owner: "user",
      source: "explicit_user_direction",
      strategistMayReplace: false,
      strategistMayNarrowOrSplit: true,
      strategistMayRecommendDeferralOrAbandonment: true,
    },
    audienceContext: assertNoLocalPath(audienceContext, "audienceContext"),
    userFacts: stringList(userFacts, "userFacts").map((item, index) => requirePublicString(item, `userFacts[${index}]`)),
    evidence: normalizeEvidenceInput(evidence),
    constraints: stringList(constraints, "constraints").map((item, index) => requirePublicString(item, `constraints[${index}]`)),
    interviewAnswers: normalizeInterviewAnswers(interviewAnswers).map((item, index) => ({
      question: requirePublicString(item.question, `interviewAnswers[${index}].question`),
      answer: requirePublicString(item.answer, `interviewAnswers[${index}].answer`),
    })),
    interviewPolicy: {
      analyzeBeforeDrafting: true,
      maxNextQuestions: 3,
    },
    userConfirmation: {
      analysisApproved,
      confirmedDirection,
    },
  };
}

export function buildContentStrategistAnalysisRequest(input, { principles = [] } = {}) {
  const lockedDirection = assertMinimalInput(input);
  const candidatePrinciples = normalizePrinciples(principles);
  return {
    operation: "agent_proposals",
    agentId: "content-strategist",
    task: "content_direction_analysis",
    stage: "interview_and_analysis",
    lockedDirection,
    directionAuthority: {
      owner: "user",
      strategistMayReplace: false,
      allowedActions: ["analyze", "narrow", "split", "request_evidence", "recommend_defer", "recommend_abandon"],
    },
    minimalInput: {
      audienceContext: input.audienceContext,
      userFacts: input.userFacts.map(item => item),
      evidence: input.evidence.map(item => ({
        id: item.id,
        kind: item.kind,
        summary: item.summary,
        sourceId: item.sourceId,
        provenance: item.provenance,
        ...(Number.isFinite(item.start) && Number.isFinite(item.end)
          ? { start: item.start, end: item.end }
          : {}),
      })),
      constraints: input.constraints.map(item => item),
      interviewAnswers: input.interviewAnswers.map(item => ({ ...item })),
    },
    candidatePrinciples,
    instructions: {
      firstRestateUserIntent: true,
      interviewAndAnalyzeBeforeAnyDraft: true,
      doNotTreatCandidatePrinciplesAsFactsOrProductionPolicy: true,
      doNotImitateSourceWordingCasesPersonaOrVideoForm: true,
      preserveProvidedFactsExactly: true,
      doNotWeakenBroadenOrContradictProvidedFacts: true,
      preferNoPrincipleOverAWeaklyRelevantPrinciple: true,
      usePrincipleOnlyWhenItChangesAConcreteJudgment: true,
      checkApplicabilityAndCounterexamplesBeforeUse: true,
      doNotChangeTopic: true,
      doNotDraftScriptTitlesHooksShotsOrEditPlan: true,
      maxNextQuestions: 3,
    },
    factFidelityContract: {
      immutableUserFacts: input.userFacts.map((text, index) => ({ id: `user-fact-${index + 1}`, text })),
      immutableEvidence: input.evidence.map(item => ({ id: item.id, summary: item.summary, provenance: item.provenance })),
      forbiddenTransforms: [
        "Do not replace an exact completed quantity with partial, some, estimated, or unverified wording",
        "Do not turn supplied evidence into a missing-evidence claim",
        "Do not infer facts that are absent from minimalInput",
      ],
    },
    knowledgeUseContract: {
      maximumCitations: 3,
      citationsMayBeEmpty: true,
      materialUseRequired: true,
      eachCitationMustState: ["appliedJudgment", "applicabilityCheck", "counterexampleCheck"],
      principleMayNotOverrideUserFactsEvidenceOrConstraints: true,
    },
    outputContract: {
      requiredFields: [
        "lockedDirection",
        "directionRestatement",
        "audience",
        "viewerBenefit",
        "strengths",
        "weaknesses",
        "evidence",
        "testableQuestion",
        "principleCitations",
        "recommendation",
        "nextQuestions",
        "status"
      ],
      recommendationValues: RECOMMENDATIONS.map(item => item),
      statusValues: ANALYSIS_STATUSES.map(item => item),
      exactTypes: {
        lockedDirection: "string",
        directionRestatement: "string",
        audience: "string",
        viewerBenefit: "string",
        strengths: "string[]",
        weaknesses: "string[]",
        evidence: {
          available: "Array<{id: exact minimalInput.evidence id, relevance: string}>",
          missing: "string[]",
        },
        testableQuestion: "string",
        principleCitations: "Array<0..3 {principleId: exact candidate id, contentHash: exact candidate hash, relevance: string, appliedJudgment: string, applicabilityCheck: string, counterexampleCheck: string}>",
        recommendation: "enum string",
        nextQuestions: "string[]",
        status: "enum string",
        uncertainties: "string[]",
      },
      forbidAdditionalFields: true,
      forbidDraftMaterial: true,
      maxNextQuestions: 3,
      principleCitationPolicy: candidatePrinciples.length > 0 ? "zero_to_three_only_when_material" : "must_be_empty",
    },
    scriptGate: {
      strategistMayDraft: false,
      handoffRequiresUserConfirmation: true,
      handoffRequiresReadyStatus: true,
      handoffRequiresCitedEvidence: true,
    },
  };
}

export function normalizeContentStrategistOutput(raw, input, { principles = [] } = {}) {
  const lockedDirection = assertMinimalInput(input);
  requireObject(raw, "Content Strategist output");
  assertNoDraftMaterial(raw);
  assertNoAuthority(raw);
  assertNoDirectionChange(raw, lockedDirection);

  if (requireString(raw.lockedDirection, "output.lockedDirection") !== lockedDirection) {
    throw new Error("Content Strategist output must echo the exact user-locked direction");
  }

  const evidence = requireObject(raw.evidence, "output.evidence");
  const available = normalizeAvailableEvidence(evidence.available, input.evidence);
  const missing = stringList(evidence.missing, "output.evidence.missing");
  const status = normalizedStatus(raw.status);
  if (status === "ready_for_script" && (available.length === 0 || missing.length > 0)) {
    throw new Error("ready_for_script requires cited available evidence and no unresolved evidence gaps");
  }

  const normalized = {
    schemaVersion: 1,
    lockedDirection,
    directionRestatement: requireString(raw.directionRestatement, "output.directionRestatement"),
    audience: requireString(raw.audience, "output.audience"),
    viewerBenefit: requireString(raw.viewerBenefit, "output.viewerBenefit"),
    strengths: stringList(raw.strengths, "output.strengths", { minItems: 1 }),
    weaknesses: stringList(raw.weaknesses, "output.weaknesses", { minItems: 1 }),
    evidence: { available, missing },
    testableQuestion: requireString(raw.testableQuestion, "output.testableQuestion"),
    principleCitations: normalizePrincipleCitations(raw.principleCitations, principles),
    recommendation: normalizedRecommendation(raw.recommendation),
    nextQuestions: stringList(raw.nextQuestions, "output.nextQuestions", { maxItems: 3 }),
    status,
    uncertainties: stringList(raw.uncertainties, "output.uncertainties"),
  };

  const mayHandOffToScriptAgent = canEnterScriptStage(input, normalized);
  normalized.scriptGate = {
    strategistMayDraft: false,
    mayHandOffToScriptAgent,
    reason: mayHandOffToScriptAgent
      ? "user_confirmed_analysis_and_evidence_ready"
      : !hasUserConfirmation(input)
        ? "awaiting_user_confirmation"
        : status !== "ready_for_script"
          ? `analysis_status_${status}`
          : "evidence_not_ready",
  };
  return normalized;
}

export function canEnterScriptStage(input, analysis) {
  try {
    const lockedDirection = assertMinimalInput(input);
    if (!hasUserConfirmation(input)) return false;
    if (!isPlainObject(analysis) || analysis.lockedDirection !== lockedDirection) return false;
    assertNoDraftMaterial(analysis);
    assertNoDirectionChange(analysis, lockedDirection);
    if (analysis.status !== "ready_for_script") return false;
    if (!Array.isArray(analysis.evidence?.available) || analysis.evidence.available.length === 0) return false;
    if (!Array.isArray(analysis.evidence?.missing) || analysis.evidence.missing.length > 0) return false;
    const allowedEvidence = new Set(input.evidence.map(item => item.id));
    if (analysis.evidence.available.some(item => !allowedEvidence.has(item?.id))) return false;
    return true;
  } catch {
    return false;
  }
}

function normalizedAgentResult(response) {
  if (response?.success === false) throw new Error(response.error || "Content Strategist invocation failed");
  return response?.result ?? response;
}

export function createContentStrategist({ invokeAgent, principles = [] } = {}) {
  if (typeof invokeAgent !== "function") throw new Error("invokeAgent is required");
  return {
    async analyze(input) {
      const request = buildContentStrategistAnalysisRequest(input, { principles });
      const raw = normalizedAgentResult(await invokeAgent(request));
      try {
        return normalizeContentStrategistOutput(raw, input, { principles });
      } catch (error) {
        const repaired = normalizedAgentResult(await invokeAgent({
          ...request,
          validationRepair: {
            attempt: 2,
            previousError: String(error?.message || error).slice(0, 500),
            requirements: [
              "Return exactly the declared field types with no extra fields",
              "Echo lockedDirection byte-for-byte",
              "Preserve every supplied user fact and evidence summary without weakening, broadening, or contradiction",
              "Cite zero to three principles only when each changes a concrete judgment, using exact ids and content hashes",
              "For every citation state appliedJudgment, applicabilityCheck, and counterexampleCheck",
              "Do not draft, approve, publish, replace the topic, or relax evidence gaps",
            ],
          },
        }));
        return normalizeContentStrategistOutput(repaired, input, { principles });
      }
    },
  };
}

export const CONTENT_STRATEGY_CONTRACT = Object.freeze({
  schemaVersion: 1,
  analysisStatuses: ANALYSIS_STATUSES,
  recommendations: RECOMMENDATIONS,
  strategistMayDraft: false,
  directionOwner: "user",
});
