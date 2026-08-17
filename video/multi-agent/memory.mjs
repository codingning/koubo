import crypto from "node:crypto";
import { canonicalJson, contentHash } from "./contracts.mjs";

const FORWARD_TRANSITIONS = new Map([
  ["inbox", "extracted"],
  ["extracted", "recreated"],
  ["recreated", "trial"],
  ["trial", "approved"],
  ["approved", "promoted"],
]);
const TERMINAL_STATUSES = new Set(["rejected", "expired", "disabled"]);
const DEFAULT_RETRIEVAL_STATUSES = new Set(["approved", "promoted"]);
const CANDIDATE_STATUSES = new Set(["extracted", "recreated", "trial"]);
const SECRET_KEYS = new Set([
  "apikey",
  "accesstoken",
  "authorization",
  "cookie",
  "password",
  "privatekey",
  "rawbytes",
  "rawmedia",
  "secret",
  "token",
]);

function finalized(record) {
  const value = structuredClone(record);
  delete value.contentHash;
  value.contentHash = contentHash(value);
  return value;
}

function requireActor(actor) {
  if (!actor || typeof actor !== "object" || !String(actor.type || "").trim() || !String(actor.id || "").trim()) {
    throw new Error("actor must contain type and id");
  }
}

function requireEvidence(evidence) {
  if (!Array.isArray(evidence)) throw new Error("evidence must be an array");
}

function normalizedEventEvidence(record, evidence) {
  const items = evidence.length ? evidence : record.evidence;
  return items.map((item, index) => ({
    sourceId: String(item.sourceId || record.id),
    kind: String(item.kind || item.type || `memory-evidence-${index + 1}`),
    ...item,
  }));
}

function makeEvent({ record, action, actor, evidence, payload, clock }) {
  const createdAt = clock();
  return finalized({
    id: `event.memory.${crypto.randomUUID()}`,
    schemaVersion: 1,
    createdAt,
    createdBy: actor,
    status: "recorded",
    source: {
      type: "memory-governance",
      sourceId: record.id,
      author: "koubo",
      license: "project-internal",
    },
    evidence: normalizedEventEvidence(record, evidence),
    applicability: record.applicability || [],
    prohibitions: record.prohibitions || [],
    versions: record.versions,
    subjectId: record.id,
    action,
    payload,
  });
}

function matchesQuery(record, query) {
  if (query.kind && query.kind !== record.kind) return false;
  if (query.domain && query.domain !== record.domain) return false;
  if (query.ids && !query.ids.includes(record.id)) return false;
  if (query.tags?.length) {
    const tags = new Set((record.tags || []).map(tag => String(tag).toLowerCase()));
    if (!query.tags.every(tag => tags.has(String(tag).toLowerCase()))) return false;
  }
  if (query.text) {
    const haystack = [
      record.id,
      record.title,
      record.problem,
      record.primitive,
      ...(record.tags || []),
      ...(record.applicability || []),
    ].join(" ").toLowerCase();
    if (!haystack.includes(String(query.text).toLowerCase())) return false;
  }
  return true;
}

function retrievalRank(record) {
  const status = {
    promoted: 6,
    approved: 5,
    trial: 4,
    recreated: 3,
    extracted: 2,
    rejected: 1,
    expired: 0,
    disabled: 0,
  }[record.status] ?? -1;
  return status * 10 + Number(record.qualityScore || 0);
}

function sanitized(value, seen = new WeakSet()) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return undefined;
  if (Array.isArray(value)) {
    return value.map(item => sanitized(item, seen)).filter(item => item !== undefined);
  }
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (SECRET_KEYS.has(key.replace(/[^a-z0-9]/gi, "").toLowerCase())) continue;
    const safe = sanitized(value[key], seen);
    if (safe !== undefined) output[key] = safe;
  }
  seen.delete(value);
  return output;
}

export function createMemoryService(store, profiles, {
  clock = () => new Date().toISOString(),
} = {}) {
  if (!store?.db || typeof store.put !== "function") throw new Error("a domain store is required");
  if (!Array.isArray(profiles) || profiles.length === 0) throw new Error("agent profiles are required");

  const profileByAgent = new Map();
  const knownNamespaces = new Set();
  for (const profile of profiles) {
    if (!profile?.agentId || !Array.isArray(profile.memoryNamespaces)) {
      throw new Error("each profile must contain agentId and memoryNamespaces");
    }
    if (profileByAgent.has(profile.agentId)) throw new Error(`duplicate agent profile: ${profile.agentId}`);
    profileByAgent.set(profile.agentId, profile);
    for (const namespace of profile.memoryNamespaces) {
      knownNamespaces.add(namespace);
      store.db.prepare(`
        INSERT OR IGNORE INTO agent_namespaces(agent_id, namespace, access)
        VALUES (?, ?, 'read')
      `).run(profile.agentId, namespace);
    }
  }

  function assertNamespace(namespace) {
    if (namespace === "brand.core" || String(namespace).startsWith("brand.core.")) {
      throw new Error("brand-core memory is not supported in v1");
    }
    if (!knownNamespaces.has(namespace)) throw new Error(`unknown memory namespace: ${namespace}`);
  }

  function get(kind, id) {
    return store.get(kind, id);
  }

  function ingest(record, kind = "technique-card") {
    if (record.status !== "inbox") throw new Error("new memory must enter through inbox");
    assertNamespace(record.namespace);
    store.put(kind, record);
    store.appendEvent(makeEvent({
      record,
      action: "memory_ingested",
      actor: record.createdBy,
      evidence: record.evidence,
      payload: { kind, status: "inbox", namespace: record.namespace },
      clock,
    }));
    return record;
  }

  function assertTransitionAllowed(from, to) {
    if (TERMINAL_STATUSES.has(from)) {
      throw new Error(`status ${from} is terminal until explicit rollback`);
    }
    if (TERMINAL_STATUSES.has(to)) return;
    if (FORWARD_TRANSITIONS.get(from) !== to) {
      throw new Error(`transition ${from} -> ${to} is forbidden`);
    }
  }

  function assertGates(to, actor, evidence, record) {
    if (to === "trial") {
      const binding = record.reviewBinding;
      const trialAuthority = record.trialAuthority;
      const matchesCandidateLineage = item => {
        if (!binding) return true;
        return item.candidateId === binding.trialCandidateId
          && item.evidenceSetHash === binding.sourceEvidenceSetHash
          && item.technicalCatalogHash === binding.technicalCatalogHash
          && item.sourceCandidateContentHash === binding.sourceCandidateContentHash
          && item.trialCandidateContentHash === binding.trialCandidateContentHash
          && item.trialTechnicalContentHash === binding.trialTechnicalContentHash;
      };
      const humanTrialAdmission = evidence.some(item => {
        const shaped = item?.type === "human-review"
          && item.decision === "approved_for_trial"
          && String(item.reviewId || "").trim()
          && item.reviewerId === actor.id
          && String(item.projectId || "").trim()
          && item.candidateId === record.id
          && /^[a-f0-9]{64}$/.test(String(item.evidenceSetHash || ""))
          && /^[a-f0-9]{64}$/.test(String(item.technicalCatalogHash || ""))
          && /^[a-f0-9]{64}$/.test(String(item.sourceCandidateContentHash || ""))
          && /^[a-f0-9]{64}$/.test(String(item.trialCandidateContentHash || ""))
          && /^[a-f0-9]{64}$/.test(String(item.trialTechnicalContentHash || ""))
          && (
            /^[a-f0-9]{64}$/.test(String(item.decisionHash || ""))
            || /^[a-f0-9]{64}$/.test(String(item.resolutionHash || ""))
          );
        if (!shaped || !matchesCandidateLineage(item)) return false;
        if (!binding) return true;
        if (binding.resolutionId) {
          return item.reviewId === binding.resolutionId
            && item.resolutionHash === binding.resolutionDecisionHash;
        }
        return item.reviewId === binding.sourceReviewId
          && item.decisionHash === binding.sourceDecisionHash;
      });
      const technicalTrialAdmission = evidence.some(item => {
        const checks = item?.checks || {};
        const shaped = item?.type === "technical-trial-admission"
          && item.decision === "approved_for_trial"
          && item.admitterId === actor.id
          && item.candidateId === record.id
          && /^[a-f0-9]{64}$/.test(String(item.evidenceSetHash || ""))
          && /^[a-f0-9]{64}$/.test(String(item.technicalCatalogHash || ""))
          && /^[a-f0-9]{64}$/.test(String(item.sourceCandidateContentHash || ""))
          && /^[a-f0-9]{64}$/.test(String(item.trialCandidateContentHash || ""))
          && /^[a-f0-9]{64}$/.test(String(item.trialTechnicalContentHash || ""))
          && checks.sourceTraceable === true
          && checks.licenseReviewed === true
          && checks.sandboxPassed === true
          && checks.rollbackReady === true;
        if (!shaped || actor.type !== "controller" || !trialAuthority) return false;
        return trialAuthority.mode === "delegated_technical_governance"
          && item.delegationId === trialAuthority.delegationId
          && item.delegatedBy === trialAuthority.delegatedBy
          && item.technicalCatalogHash === trialAuthority.technicalCatalogHash
          && item.sourceCandidateContentHash === trialAuthority.sourceCandidateContentHash
          && item.trialCandidateContentHash === trialAuthority.trialCandidateContentHash
          && item.trialTechnicalContentHash === trialAuthority.trialTechnicalContentHash
          && matchesCandidateLineage(item);
      });
      if (!((actor.type === "human" && humanTrialAdmission) || technicalTrialAdmission)) {
        throw new Error("trial requires bound human review or delegated technical-admission evidence");
      }
    }
    if (to === "approved") {
      const humanApproval = evidence.some(item =>
        item?.type === "real-clip-outcome-review"
        && item.decision === "approved"
        && item.perceptualDecision === "accept"
        && item.reviewerId === actor.id
        && String(item.projectId || "").trim()
        && String(item.reviewId || "").trim()
        && item.candidateId === record.id
        && String(item.outputVersion || "").trim()
        && /^[a-f0-9]{64}$/.test(String(item.mediaSha256 || ""))
        && /^[a-f0-9]{64}$/.test(String(item.transcriptSha256 || ""))
      );
      if (actor.type !== "human" || !humanApproval) {
        throw new Error("approval requires a human real-clip outcome review bound to media and transcript hashes");
      }
    }
    if (to === "promoted") {
      const approvedProjects = new Set(
        evidence
          .filter(item => item?.type === "approved-project-trial" && String(item.reviewId || "").trim())
          .map(item => String(item.projectId || "").trim())
          .filter(Boolean)
      );
      if (actor.type !== "human" || approvedProjects.size < 2) {
        throw new Error("promotion requires two distinct approved project trials");
      }
    }
  }

  function transition({ kind, id, to, actor, evidence = [], expectedHash }) {
    requireActor(actor);
    requireEvidence(evidence);
    const prior = store.get(kind, id);
    if (!prior) throw new Error(`memory record not found: ${kind}/${id}`);
    assertNamespace(prior.namespace);
    if (!expectedHash) throw new Error("expected hash is required for governed transitions");
    if (prior.contentHash !== expectedHash) throw new Error("expected hash does not match stored record");
    assertTransitionAllowed(prior.status, to);
    assertGates(to, actor, evidence, prior);
    if (TERMINAL_STATUSES.has(to) && evidence.length === 0) {
      throw new Error(`${to} transition requires evidence`);
    }

    const next = finalized({ ...structuredClone(prior), status: to });
    const transitionId = `transition.${crypto.randomUUID()}`;
    const createdAt = clock();

    store.put(kind, next, expectedHash);
    store.db.prepare(`
      INSERT INTO transitions(
        id, record_kind, record_id, from_status, to_status,
        actor_type, actor_id, evidence_json, prior_json, next_json,
        created_at, rolled_back_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      transitionId,
      kind,
      id,
      prior.status,
      to,
      actor.type,
      actor.id,
      canonicalJson(evidence),
      canonicalJson(prior),
      canonicalJson(next),
      createdAt
    );
    store.appendEvent(makeEvent({
      record: next,
      action: "memory_transitioned",
      actor,
      evidence,
      payload: {
        transitionId,
        kind,
        fromStatus: prior.status,
        toStatus: to,
        previousHash: prior.contentHash,
        nextHash: next.contentHash,
      },
      clock,
    }));
    return {
      id: transitionId,
      kind,
      recordId: id,
      fromStatus: prior.status,
      toStatus: to,
      createdAt,
      record: next,
    };
  }

  function reject(input) {
    return transition({ ...input, to: "rejected" });
  }

  function expire(input) {
    return transition({ ...input, to: "expired" });
  }

  function retrieve({ agentId, query = {}, includeCandidate = false } = {}) {
    const profile = profileByAgent.get(agentId);
    if (!profile || profile.status === "disabled") throw new Error(`unknown or disabled agent: ${agentId}`);
    const allowedNamespaces = new Set(profile.memoryNamespaces);
    const statuses = new Set(DEFAULT_RETRIEVAL_STATUSES);
    if (includeCandidate) for (const status of CANDIDATE_STATUSES) statuses.add(status);
    if (query.includeNegative) for (const status of TERMINAL_STATUSES) statuses.add(status);

    return store.db.prepare("SELECT kind, json FROM records ORDER BY id").all()
      .map(row => ({ kind: row.kind, ...JSON.parse(row.json) }))
      .filter(record => allowedNamespaces.has(record.namespace))
      .filter(record => statuses.has(record.status))
      .filter(record => matchesQuery(record, query))
      .sort((a, b) => retrievalRank(b) - retrievalRank(a) || a.id.localeCompare(b.id))
      .map(record => {
        const result = structuredClone(record);
        delete result.kind;
        return result;
      });
  }

  function rollback(transitionId) {
    const row = store.db.prepare("SELECT * FROM transitions WHERE id = ?").get(transitionId);
    if (!row) throw new Error(`transition not found: ${transitionId}`);
    if (row.rolled_back_at) throw new Error(`transition already rolled back: ${transitionId}`);
    const later = store.db.prepare(`
      SELECT id FROM transitions
      WHERE record_kind = ? AND record_id = ? AND rolled_back_at IS NULL
        AND (created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(row.record_kind, row.record_id, row.created_at, row.created_at, row.id);
    if (later) throw new Error(`cannot roll back a non-latest transition; later transition exists: ${later.id}`);

    const prior = JSON.parse(row.prior_json);
    const next = JSON.parse(row.next_json);
    const current = store.get(row.record_kind, row.record_id);
    if (!current || current.contentHash !== next.contentHash) {
      throw new Error("current record no longer matches transition result");
    }

    store.put(row.record_kind, prior, current.contentHash);
    const rolledBackAt = clock();
    store.db.prepare("UPDATE transitions SET rolled_back_at = ? WHERE id = ?").run(rolledBackAt, transitionId);
    const actor = { type: "controller", id: "memory-rollback" };
    store.appendEvent(makeEvent({
      record: prior,
      action: "memory_transition_rolled_back",
      actor,
      evidence: [{
        sourceId: transitionId,
        kind: "transition-record",
        transitionId,
      }],
      payload: {
        transitionId,
        kind: row.record_kind,
        restoredStatus: prior.status,
        restoredHash: prior.contentHash,
      },
      clock,
    }));
    return { id: transitionId, rolledBackAt, record: prior };
  }

  function exportNamespace(agentId) {
    const profile = profileByAgent.get(agentId);
    if (!profile || profile.status === "disabled") throw new Error(`unknown or disabled agent: ${agentId}`);
    const namespaces = [...profile.memoryNamespaces].sort();
    const allowed = new Set(namespaces);
    const records = store.db.prepare("SELECT kind, json FROM records ORDER BY kind, id").all()
      .map(row => ({ kind: row.kind, record: JSON.parse(row.json) }))
      .filter(item => allowed.has(item.record.namespace))
      .filter(item => item.record.status !== "inbox")
      .map(item => sanitized(item));
    return sanitized({
      schemaVersion: 1,
      agentId,
      namespaces,
      records,
    });
  }

  return {
    ingest,
    transition,
    retrieve,
    reject,
    expire,
    rollback,
    exportNamespace,
    get,
  };
}
