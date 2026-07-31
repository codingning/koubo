import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const allowedStatuses = new Set(["trial", "approved", "promoted"]);

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function label(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function normalizeTimecodes(value, id) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${id} has no source timecodes`);
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
  return {
    id: String(record.id),
    sourceVideoId: String(parameters.sourceVideoId || ""),
    sourceTitle: String(parameters.sourceTitle || ""),
    timecodes: normalizeTimecodes(parameters.timecodes, record.id),
    claim: String(parameters.claim || record.title || "").trim(),
    abstraction: String(parameters.abstraction || record.problem || "").trim(),
    applicability: Array.isArray(record.applicability) ? record.applicability.map(String) : [],
    counterexamples: Array.isArray(parameters.counterexamples) ? parameters.counterexamples.map(String) : [],
    status: ["approved", "promoted"].includes(record.status) ? "accepted" : "trial",
  };
}

function validateRecord(record) {
  if (!record || typeof record !== "object") throw new Error("Creator Vault returned a non-object record");
  if (!allowedStatuses.has(record.status)) throw new Error(`Creator Vault returned forbidden status: ${record.status}`);
  if (record.namespace !== "shared.content-principles") {
    throw new Error(`Creator Vault returned forbidden namespace: ${record.namespace}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(String(record.contentHash || ""))) {
    throw new Error(`Creator Vault record has invalid content hash: ${record.id}`);
  }
  const principle = recordToPrinciple(record);
  if (!principle.sourceVideoId || !principle.claim || !principle.abstraction
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
    let result;
    try {
      result = await run(nodePath, [
        resolvedCli,
        "knowledge-retrieve",
        "--root", resolvedRoot,
        "--agent", agentId,
        "--query", normalizedQuery,
        "--trial",
        "--limit", String(topK),
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
    let principles;
    try {
      principles = records.map(validateRecord);
    } catch (error) {
      throw httpError(502, `Creator Vault returned invalid knowledge: ${String(error?.message || error).slice(0, 240)}`);
    }
    return {
      principles,
      audit: {
        source: "creator-vault",
        mode: "trial-opt-in",
        agentId,
        includeTrial: true,
        topK,
        query: normalizedQuery,
        records: records.map((record, index) => ({
          rank: index + 1,
          id: record.id,
          status: record.status,
          namespace: record.namespace,
          contentHash: record.contentHash,
        })),
      },
    };
  }

  return { retrieve };
}
