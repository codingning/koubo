import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const allowedStatuses = new Set(["trial", "approved", "promoted"]);
const allowedNamespaces = new Set(["shared.content-principles", "content.private"]);
const searchStopTokens = new Set([
  "agent", "ai", "一个", "不得", "不能", "仍然", "什么", "他们", "以及", "使用", "内容", "可以", "如何",
  "已经", "工作", "当前", "所有", "方向", "没有", "用户", "真实", "结果", "自动", "视频", "证据", "进行", "需要", "问题",
]);

function searchTokens(value) {
  const normalized = String(value || "").normalize("NFKC").toLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9][a-z0-9._-]*/g) || []);
  for (const segment of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    if (segment.length === 1) tokens.add(segment);
    for (let index = 0; index < segment.length - 1; index += 1) tokens.add(segment.slice(index, index + 2));
  }
  for (const token of searchStopTokens) tokens.delete(token);
  return tokens;
}

function overlapCount(tokens, value) {
  const searchable = String(value || "").normalize("NFKC").toLowerCase();
  let count = 0;
  for (const token of tokens) if (searchable.includes(token)) count += 1;
  return count;
}

function principleTokens(principle) {
  return searchTokens([
    principle.claim,
    principle.abstraction,
    ...principle.applicability,
    ...principle.counterexamples,
    ...(principle.requiredEvidence || []),
    ...(principle.decisionProcedure || []),
    ...(principle.failureSignals || []),
  ].join("\n"));
}

function similarity(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

function contextualScore(principle, queryTokens) {
  return overlapCount(queryTokens, principle.applicability.join("\n")) * 6
    + overlapCount(queryTokens, principle.claim) * 3
    + overlapCount(queryTokens, principle.abstraction) * 2
    + overlapCount(queryTokens, principle.counterexamples.join("\n"))
    + overlapCount(queryTokens, (principle.requiredEvidence || []).join("\n")) * 3
    + overlapCount(queryTokens, (principle.decisionProcedure || []).join("\n")) * 2
    + overlapCount(queryTokens, (principle.failureSignals || []).join("\n")) * 2;
}

function sourceKey(principle) {
  return principle.sourceVideoId || principle.sourceRefs?.[0]?.sourceId || principle.id;
}

export function selectDiversePrinciples(principles, { query, topK }) {
  if (!Array.isArray(principles)) throw new Error("principles must be an array");
  if (!Number.isInteger(topK) || topK < 1) throw new Error("topK must be a positive integer");
  const queryTokens = searchTokens(query);
  const candidates = principles.map((principle, retrievalIndex) => ({
    principle,
    retrievalIndex,
    baseScore: contextualScore(principle, queryTokens),
    tokens: principleTokens(principle),
  }));
  const sourceCount = new Map();
  const distinctSources = new Set(candidates.map(item => sourceKey(item.principle))).size;
  const sourceCap = Math.max(1, Math.ceil(topK / Math.max(1, Math.min(3, distinctSources))));
  const selected = [];
  const remaining = new Set(candidates);
  while (selected.length < Math.min(topK, candidates.length)) {
    let eligible = [...remaining].filter(item => (sourceCount.get(sourceKey(item.principle)) || 0) < sourceCap);
    if (eligible.length === 0) eligible = [...remaining];
    eligible.sort((left, right) => {
      const leftSimilarity = selected.length === 0 ? 0 : Math.max(...selected.map(item => similarity(left.tokens, item.tokens)));
      const rightSimilarity = selected.length === 0 ? 0 : Math.max(...selected.map(item => similarity(right.tokens, item.tokens)));
      const leftAdjusted = left.baseScore - leftSimilarity * 8 - (sourceCount.get(sourceKey(left.principle)) || 0) * 4;
      const rightAdjusted = right.baseScore - rightSimilarity * 8 - (sourceCount.get(sourceKey(right.principle)) || 0) * 4;
      return rightAdjusted - leftAdjusted
        || right.baseScore - left.baseScore
        || left.retrievalIndex - right.retrievalIndex
        || left.principle.id.localeCompare(right.principle.id);
    });
    const chosen = eligible[0];
    remaining.delete(chosen);
    const chosenSource = sourceKey(chosen.principle);
    sourceCount.set(chosenSource, (sourceCount.get(chosenSource) || 0) + 1);
    selected.push(chosen);
  }
  return selected.map((item, selectionIndex) => ({
    principle: item.principle,
    selectionRank: selectionIndex + 1,
    retrievalRank: item.retrievalIndex + 1,
    contextualScore: item.baseScore,
  }));
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function label(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function normalizeTimecodes(value, id, { required = true } = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    if (required) throw new Error(`${id} has no source timecodes`);
    return [];
  }
  return value.map((range, index) => {
    const startSeconds = Number(range.startSeconds ?? range.start);
    const endSeconds = Number(range.endSeconds ?? range.end);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) {
      throw new Error(`${id} has invalid source timecode ${index}`);
    }
    return {
      startSeconds,
      endSeconds,
      startLabel: String(range.startLabel || label(startSeconds)),
      endLabel: String(range.endLabel || label(endSeconds)),
    };
  });
}

function recordToPrinciple(record) {
  const parameters = record.parameters || {};
  const namespace = String(record.namespace || "");
  const isTaskContract = namespace === "content.private";
  return {
    id: String(record.id),
    namespace,
    knowledgeKind: String(parameters.knowledgeKind || (isTaskContract ? "" : "content-principle")),
    sourceVideoId: String(parameters.sourceVideoId || ""),
    sourceTitle: String(parameters.sourceTitle || ""),
    timecodes: normalizeTimecodes(parameters.timecodes, record.id, { required: !isTaskContract }),
    sourceRefs: Array.isArray(parameters.sourceRefs) ? structuredClone(parameters.sourceRefs) : [],
    claim: String(parameters.claim || record.title || "").trim(),
    abstraction: String(parameters.abstraction || record.problem || "").trim(),
    applicability: Array.isArray(record.applicability) ? record.applicability.map(String) : [],
    counterexamples: Array.isArray(parameters.counterexamples) ? parameters.counterexamples.map(String) : [],
    requiredEvidence: Array.isArray(parameters.requiredEvidence) ? parameters.requiredEvidence.map(String) : [],
    decisionProcedure: Array.isArray(parameters.decisionProcedure) ? parameters.decisionProcedure.map(String) : [],
    failureSignals: Array.isArray(parameters.failureSignals) ? parameters.failureSignals.map(String) : [],
    status: ["approved", "promoted"].includes(record.status) ? "accepted" : "trial",
  };
}

function validateRecord(record) {
  if (!record || typeof record !== "object") throw new Error("Creator Vault returned a non-object record");
  if (!allowedStatuses.has(record.status)) throw new Error(`Creator Vault returned forbidden status: ${record.status}`);
  if (!allowedNamespaces.has(record.namespace)) {
    throw new Error(`Creator Vault returned forbidden namespace: ${record.namespace}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(String(record.contentHash || ""))) {
    throw new Error(`Creator Vault record has invalid content hash: ${record.id}`);
  }
  const principle = recordToPrinciple(record);
  const sharedPrincipleReady = principle.namespace === "shared.content-principles"
    && principle.sourceVideoId && principle.timecodes.length > 0;
  const privateTaskReady = principle.namespace === "content.private"
    && principle.knowledgeKind === "content-task-contract"
    && principle.sourceRefs.length > 0
    && principle.sourceRefs.every(item => /^[a-f0-9]{64}$/u.test(String(item.contentHash || "")))
    && principle.requiredEvidence.length > 0
    && principle.decisionProcedure.length > 0
    && principle.failureSignals.length > 0;
  if ((!sharedPrincipleReady && !privateTaskReady) || !principle.claim || !principle.abstraction
    || principle.applicability.length === 0 || principle.counterexamples.length === 0) {
    throw new Error(`Creator Vault record is incomplete for Content Strategist: ${record.id}`);
  }
  return principle;
}

async function defaultRun(nodePath, args, options) {
  return execFile(nodePath, args, {
    ...options,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

export function createCreatorVaultKnowledgeAdapter({
  vaultRoot,
  cliPath,
  nodePath = process.execPath,
  run = defaultRun,
} = {}) {
  const resolvedRoot = vaultRoot ? path.resolve(vaultRoot) : null;
  const resolvedCli = cliPath ? path.resolve(cliPath) : null;

  async function retrieve({ agentId, query, includeTrial = false, topK = 5 } = {}) {
    if (!resolvedRoot || !resolvedCli) throw httpError(409, "Creator Vault knowledge adapter is not configured");
    if (agentId !== "content-strategist") throw httpError(400, "Creator Vault trial bridge currently supports only content-strategist");
    if (includeTrial !== true) throw httpError(400, "Creator Vault trial retrieval requires includeTrial=true");
    if (!Number.isInteger(topK) || topK < 3 || topK > 5) throw httpError(400, "Creator Vault topK must be between 3 and 5");
    const normalizedQuery = String(query || "").trim();
    if (!normalizedQuery) throw httpError(400, "Creator Vault retrieval requires the user-locked direction as query");
    if (!fs.existsSync(resolvedRoot) || !fs.existsSync(resolvedCli)) {
      throw httpError(409, "Creator Vault root or CLI is unavailable");
    }
    const candidateLimit = Math.min(100, Math.max(12, topK * 4));
    let result;
    try {
      result = await run(nodePath, [
        resolvedCli,
        "knowledge-retrieve",
        "--root", resolvedRoot,
        "--agent", agentId,
        "--query", normalizedQuery,
        "--trial",
        "--limit", String(candidateLimit),
      ], { cwd: path.dirname(resolvedCli) });
    } catch (error) {
      throw httpError(502, `Creator Vault retrieval failed: ${String(error?.message || error).slice(0, 240)}`);
    }
    let records;
    try {
      records = JSON.parse(typeof result === "string" ? result : result.stdout);
    } catch {
      throw httpError(502, "Creator Vault returned invalid JSON");
    }
    if (!Array.isArray(records)) throw httpError(502, "Creator Vault returned a non-array result");
    let validated;
    try {
      validated = records.map(validateRecord);
    } catch (error) {
      throw httpError(502, `Creator Vault returned invalid knowledge: ${String(error?.message || error).slice(0, 240)}`);
    }
    const selected = selectDiversePrinciples(validated, { query: normalizedQuery, topK });
    const rawById = new Map(records.map(record => [record.id, record]));
    return {
      principles: selected.map(item => item.principle),
      audit: {
        source: "creator-vault",
        mode: "trial-opt-in-contextual-diversity-v2",
        agentId,
        includeTrial: true,
        topK,
        candidateLimit,
        candidatePoolSize: records.length,
        selectionPolicy: "contextual-diversity-v2",
        query: normalizedQuery,
        records: selected.map(item => {
          const record = rawById.get(item.principle.id);
          return {
            rank: item.selectionRank,
            retrievalRank: item.retrievalRank,
            id: record.id,
            status: record.status,
            namespace: record.namespace,
            contentHash: record.contentHash,
            contextualScore: item.contextualScore,
          };
        }),
      },
    };
  }

  return { retrieve };
}
