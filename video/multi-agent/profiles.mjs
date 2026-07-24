import { contentHash } from "./contracts.mjs";

export const SPECIALIST_PROFILES = Object.freeze([
  Object.freeze({
    agentId: "caption-agent",
    proposalKind: "caption",
    memoryNamespaces: ["shared.evidence", "caption.private"],
    responsibilities: ["segment-captions", "propose-layout", "propose-emphasis", "cite-memory"],
    prohibitions: ["rewrite spoken facts", "duplicate information cards", "approve output", "publish"],
  }),
  Object.freeze({
    agentId: "motion-agent",
    proposalKind: "motion",
    memoryNamespaces: ["shared.evidence", "motion.private"],
    responsibilities: ["propose-motion-recipe", "propose-timing", "detect-motion-conflicts", "cite-memory"],
    prohibitions: ["add purposeless constant motion", "change transcript", "approve output", "publish"],
  }),
  Object.freeze({
    agentId: "sound-agent",
    proposalKind: "sound",
    memoryNamespaces: ["shared.evidence", "sound.private"],
    responsibilities: ["propose-sfx", "propose-ducking", "propose-pauses", "cite-license"],
    prohibitions: ["rewrite speech", "use unlicensed audio", "mask voice", "approve output", "publish"],
  }),
]);

const HIDDEN_BLIND_KEYS = new Set([
  "agent",
  "agentid",
  "author",
  "createdby",
  "id",
  "prompt",
  "proposalorder",
  "rationale",
]);
const AUTHORITY_KEYS = new Set([
  "approval",
  "approvedat",
  "finaloutput",
  "memorypromotion",
  "promote",
  "publish",
  "publishedat",
]);

function filteredClone(value, forbidden, seen = new WeakSet()) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(item => filteredClone(item, forbidden, seen));
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (forbidden.has(normalized)) continue;
    const item = filteredClone(value[key], forbidden, seen);
    if (item !== undefined) output[key] = item;
  }
  seen.delete(value);
  return output;
}

export function roleMinimalInput(profile, input, memory) {
  return {
    operation: "agent_proposals",
    agentId: profile.agentId,
    proposalKind: profile.proposalKind,
    jobId: input.jobId,
    transcript: structuredClone(input.transcript || []),
    sharedEvidence: structuredClone(input.sharedEvidence || []),
    currentPlan: structuredClone(input.currentPlan || {}),
    roleInput: structuredClone(input.roleInputs?.[profile.proposalKind] || {}),
    responsibilities: [...profile.responsibilities],
    prohibitions: [...profile.prohibitions],
    memoryNamespaces: [...profile.memoryNamespaces],
    memory: structuredClone(memory),
  };
}

export function stripAuthority(value) {
  return filteredClone(value, AUTHORITY_KEYS);
}

export function blindPublicCandidate(candidate) {
  const publicCandidate = filteredClone(candidate, new Set([...HIDDEN_BLIND_KEYS, ...AUTHORITY_KEYS]));
  return {
    label: `blind-${contentHash(publicCandidate).slice(0, 12)}`,
    candidate: publicCandidate,
  };
}
