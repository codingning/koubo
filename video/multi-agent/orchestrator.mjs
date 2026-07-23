import crypto from "node:crypto";
import {
  contentHash,
  validateRecord,
} from "./contracts.mjs";
import {
  SPECIALIST_PROFILES,
  blindPublicCandidate,
  roleMinimalInput,
  stripAuthority,
} from "./profiles.mjs";

const DEFAULT_LIMITS = Object.freeze({
  concurrency: 3,
  maxProposalsPerSpecialist: 2,
  timeoutMs: 90_000,
  retries: 1,
});
const VERSION_STAMP = Object.freeze({
  code: "orchestrator-v1",
  model: "runtime",
  prompt: "bounded-specialists-v1",
  memory: "schema-v1",
  asset: "catalog-v1",
  recipe: "recipe-v1",
  evaluation: "rubric-v1",
});

function finalized(record) {
  const value = structuredClone(record);
  delete value.contentHash;
  value.contentHash = contentHash(value);
  return value;
}

function normalizedAgentResult(response) {
  if (response?.success === false) throw new Error(response.error || "agent invocation failed");
  return response?.result ?? response;
}

function proposalKindForAgent(agentId) {
  return SPECIALIST_PROFILES.find(profile => profile.agentId === agentId)?.proposalKind;
}

function proposalRecord({
  profile,
  raw,
  input,
  index,
  clock,
  fallback = false,
}) {
  if (!raw?.candidate || typeof raw.candidate !== "object") {
    throw new Error("proposal candidate must be an object");
  }
  const record = finalized({
    id: `proposal.${input.jobId}.${profile.proposalKind}.${index + 1}.${crypto.randomUUID()}`,
    schemaVersion: 1,
    createdAt: clock(),
    createdBy: { type: fallback ? "controller" : "agent", id: fallback ? "visual-director-v4" : profile.agentId },
    status: "proposed",
    source: {
      type: fallback ? "v4-fallback" : "multi-agent-proposal",
      sourceId: input.jobId,
      author: "koubo",
      license: "project-internal",
    },
    evidence: [{
      sourceId: input.jobId,
      kind: fallback ? "v4-plan" : "job-input",
    }],
    applicability: [profile.proposalKind],
    prohibitions: [...profile.prohibitions],
    versions: VERSION_STAMP,
    agentId: fallback ? "visual-director-v4" : profile.agentId,
    jobId: input.jobId,
    proposalKind: profile.proposalKind,
    candidate: stripAuthority(raw.candidate),
    citations: Array.isArray(raw.citations) ? structuredClone(raw.citations) : [],
    uncertainties: Array.isArray(raw.uncertainties) ? raw.uncertainties.map(String) : [],
    fallbackEngine: fallback ? "visual-director-v4" : undefined,
  });
  validateRecord("agent-proposal", record);
  return record;
}

function fallbackProposal(profile, input, clock) {
  const v4 = input.v4Plan || {};
  const candidate = {
    engine: "visual-director-v4",
    layout: v4.layout || input.currentPlan?.layout || "speaker-right-information-left",
    captions: v4.captions || { identity: input.currentPlan?.captions || "anchor" },
    motion: v4.motion || { structure: input.currentPlan?.motion || [] },
    sound: v4.sound || { structure: input.currentPlan?.sound || [] },
    fallbackFor: profile.proposalKind,
  };
  return proposalRecord({
    profile,
    raw: {
      candidate,
      citations: [],
      uncertainties: ["specialist unavailable; deterministic v4 plan retained"],
    },
    input,
    index: 0,
    clock,
    fallback: true,
  });
}

function validateCitations(proposals, retrieved) {
  const records = new Map(retrieved.map(item => [item.id, item.contentHash]));
  for (const proposal of proposals) {
    for (const citation of proposal.citations || []) {
      if (!records.has(citation.recordId) || records.get(citation.recordId) !== citation.contentHash) {
        throw new Error(`proposal cites unavailable memory: ${citation.recordId}`);
      }
    }
  }
}

function structuralSignature(candidate) {
  return contentHash({
    layout: candidate.layout || null,
    captions: candidate.captions?.identity || candidate.captions?.structure || candidate.captions || null,
    motion: candidate.motion?.structure || candidate.motion || null,
    sound: candidate.sound?.structure || candidate.sound || null,
  });
}

function deterministicDirectorFallback(proposals, options) {
  const v4 = stripAuthority(options.v4Plan || {});
  const selected = Object.fromEntries(
    ["caption", "motion", "sound"].map(kind => [
      kind,
      proposals.find(item => item.proposalKind === kind)?.candidate || {},
    ])
  );
  const base = {
    id: "candidate-v4-control",
    engine: "visual-director-v4",
    layout: v4.layout || "speaker-right-information-left",
    captions: v4.captions || { identity: "anchor" },
    motion: v4.motion || { structure: [] },
    sound: v4.sound || { structure: [] },
  };
  const expression = {
    id: "candidate-multi-agent-expression",
    engine: "controlled-multi-agent-v1",
    layout: selected.motion.layout || selected.caption.layout || "speaker-center-evidence-full",
    captions: selected.caption.captions || { identity: "keyword-pop" },
    motion: selected.motion.motion || { structure: ["evidence-slide"] },
    sound: selected.sound.sound || { structure: ["semantic-cue"] },
  };
  if (structuralSignature(base) === structuralSignature(expression)) {
    expression.layout = "speaker-pip-evidence-full";
    expression.motion = { structure: ["evidence-fullscreen-transition"] };
  }
  return {
    candidates: [base, expression],
    conflicts: [{
      field: "candidate-source",
      options: ["v4-control", "multi-agent-expression"],
      preserved: true,
    }],
    fallback: { engine: "visual-director-v4", reason: "director unavailable or structurally duplicate" },
  };
}

function validateTimecodedFindings(findings, { retention = false } = {}) {
  if (!Array.isArray(findings) || findings.length === 0) {
    throw new Error("review requires timestamped findings");
  }
  for (const [index, item] of findings.entries()) {
    if (!Number.isFinite(item?.start) || !Number.isFinite(item?.end) || item.start < 0 || item.end <= item.start) {
      throw new Error(`review finding ${index} requires a valid timestamp range`);
    }
    if (retention && !String(item.viewingReason || "").trim()) {
      throw new Error(`retention finding ${index} requires a viewing reason`);
    }
  }
}

function reviewRecord({
  reviewerId,
  candidateId,
  jobId,
  result,
  clock,
}) {
  const findings = structuredClone(result.timecodedFindings || []);
  const record = finalized({
    id: `review.${reviewerId}.${candidateId}.${crypto.randomUUID()}`,
    schemaVersion: 1,
    createdAt: clock(),
    createdBy: { type: "agent", id: reviewerId },
    status: "complete",
    source: {
      type: "multi-agent-review",
      sourceId: jobId,
      author: "koubo",
      license: "project-internal",
    },
    evidence: findings.map(item => ({
      sourceId: jobId,
      kind: "candidate-time-range",
      start: item.start,
      end: item.end,
    })),
    applicability: ["candidate review"],
    prohibitions: ["approve output", "publish", "promote memory"],
    versions: VERSION_STAMP,
    reviewerId,
    candidateId,
    rubricId: "koubo-multi-agent-rubric-v1",
    scores: structuredClone(result.scores || {}),
    timecodedFindings: findings,
  });
  validateRecord("review-score", record);
  return record;
}

export function createOrchestrator({
  invokeAgent,
  memory,
  clock = () => new Date().toISOString(),
  limits = {},
} = {}) {
  if (typeof invokeAgent !== "function") throw new Error("invokeAgent is required");
  if (!memory || typeof memory.retrieve !== "function") throw new Error("memory service is required");
  const configured = { ...DEFAULT_LIMITS, ...limits };
  if (configured.concurrency < 1 || configured.maxProposalsPerSpecialist < 1) {
    throw new Error("orchestrator limits must be positive");
  }
  const events = [];

  function trace(action, payload = {}) {
    const event = { action, at: clock(), ...payload };
    events.push(event);
    return event;
  }

  async function invokeWithRetry(request) {
    let lastError;
    for (let attempt = 0; attempt <= configured.retries; attempt += 1) {
      const controller = new AbortController();
      let timeout;
      try {
        const timeoutPromise = new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            const error = new Error(`agent timeout after ${configured.timeoutMs}ms`);
            error.code = "AGENT_TIMEOUT";
            reject(error);
          }, configured.timeoutMs);
        });
        const response = await Promise.race([
          Promise.resolve(invokeAgent({ ...request, signal: controller.signal })),
          timeoutPromise,
        ]);
        clearTimeout(timeout);
        return normalizedAgentResult(response);
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;
        if (attempt < configured.retries) {
          trace("agent_retry", {
            agentId: request.agentId,
            attempt: attempt + 1,
            reason: error.code === "AGENT_TIMEOUT" ? "timeout" : "error",
          });
        }
      }
    }
    throw lastError;
  }

  async function mapWithConcurrency(items, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function consume() {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(configured.concurrency, items.length) }, () => consume())
    );
    return results;
  }

  async function propose(input) {
    if (!String(input?.jobId || "").trim()) throw new Error("jobId is required");
    events.length = 0;
    const fallbackAgents = [];
    const grouped = await mapWithConcurrency(SPECIALIST_PROFILES, async profile => {
      const retrieved = memory.retrieve({
        agentId: profile.agentId,
        query: { tags: [profile.proposalKind] },
      });
      const request = roleMinimalInput(profile, input, retrieved);
      try {
        const result = await invokeWithRetry(request);
        if (!Array.isArray(result?.proposals) || result.proposals.length === 0) {
          throw new Error("agent returned no proposals");
        }
        const records = result.proposals
          .slice(0, configured.maxProposalsPerSpecialist)
          .map((raw, index) => proposalRecord({ profile, raw, input, index, clock }));
        validateCitations(records, retrieved);
        trace("agent_proposals_recorded", { agentId: profile.agentId, count: records.length });
        return records;
      } catch (error) {
        fallbackAgents.push(profile.agentId);
        trace(
          error.code === "AGENT_TIMEOUT" ? "agent_timeout_fallback" : "agent_invalid_fallback",
          { agentId: profile.agentId, engine: "visual-director-v4", reason: String(error.message).slice(0, 240) }
        );
        return [fallbackProposal(profile, input, clock)];
      }
    });
    const proposals = grouped.flat();
    const result = {
      jobId: input.jobId,
      proposals,
      events: structuredClone(events),
    };
    if (fallbackAgents.length) {
      result.fallback = {
        engine: "visual-director-v4",
        agents: fallbackAgents.sort(),
      };
    }
    return result;
  }

  async function direct(proposals, options = {}) {
    if (!Array.isArray(proposals) || proposals.length === 0) throw new Error("proposals are required");
    const publicProposals = proposals.map(item => ({
      proposalKind: item.proposalKind,
      candidate: stripAuthority(item.candidate),
      citations: structuredClone(item.citations || []),
      uncertainties: structuredClone(item.uncertainties || []),
    }));
    try {
      const result = stripAuthority(await invokeWithRetry({
        operation: "agent_proposals",
        agentId: "director-agent",
        proposalKind: "director",
        jobId: options.jobId || proposals[0].jobId,
        proposals: publicProposals,
        responsibilities: ["compare proposals", "preserve conflicts", "compose candidates"],
        prohibitions: ["approve output", "promote memory", "publish", "hide disagreement"],
      }));
      const candidates = Array.isArray(result?.candidates)
        ? result.candidates.slice(0, 2).map(stripAuthority)
        : [];
      if (candidates.length !== 2 || structuralSignature(candidates[0]) === structuralSignature(candidates[1])) {
        return deterministicDirectorFallback(proposals, options);
      }
      return {
        candidates,
        conflicts: Array.isArray(result.conflicts) ? stripAuthority(result.conflicts) : [],
      };
    } catch {
      return deterministicDirectorFallback(proposals, options);
    }
  }

  async function criticize(candidate, { blind = true, jobId = "job.unknown" } = {}) {
    const prepared = blind
      ? blindPublicCandidate(candidate)
      : { label: String(candidate.id || `candidate-${contentHash(candidate).slice(0, 12)}`), candidate: stripAuthority(candidate) };
    const result = await invokeWithRetry({
      operation: "agent_critique",
      agentId: "blind-critic",
      candidateLabel: prepared.label,
      candidate: prepared.candidate,
      rubricId: "koubo-multi-agent-rubric-v1",
      blind,
    });
    validateTimecodedFindings(result.timecodedFindings);
    return reviewRecord({
      reviewerId: "blind-critic",
      candidateId: prepared.label,
      jobId,
      result,
      clock,
    });
  }

  async function retentionAudit(candidate, { jobId = "job.unknown" } = {}) {
    const prepared = blindPublicCandidate(candidate);
    const result = await invokeWithRetry({
      operation: "agent_critique",
      agentId: "retention-critic",
      candidateLabel: prepared.label,
      candidate: prepared.candidate,
      policy: {
        requireTimestampedViewingReasons: true,
        allowNecessaryPauses: true,
        forbidEffectEverySecond: true,
      },
    });
    if (result.requireEffectEverySecond === true) {
      throw new Error("effect-every-second rule is forbidden");
    }
    validateTimecodedFindings(result.timecodedFindings, { retention: true });
    return reviewRecord({
      reviewerId: "retention-critic",
      candidateId: prepared.label,
      jobId,
      result,
      clock,
    });
  }

  return {
    propose,
    direct,
    criticize,
    retentionAudit,
  };
}
