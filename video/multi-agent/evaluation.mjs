import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, contentHash } from "./contracts.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDir, "..", "..");
const rubric = JSON.parse(fs.readFileSync(
  path.join(repositoryRoot, "config", "multi-agent", "evaluation-rubric.json"),
  "utf8"
).replace(/^\uFEFF/, ""));
const BLIND_REVIEW_MINIMUM = 0.6;
const PROVENANCE_MINIMUM = 0.8;
const MATERIAL_MARGIN = 0.02;
const FAIR_CONFOUNDER_KEYS = ["baselineId", "jobId", "sourceHash", "durationSeconds", "fps", "rubric"];
const PRIVATE_KEYS = new Set([
  "accesstoken",
  "agent",
  "agentid",
  "apikey",
  "author",
  "createdby",
  "prompt",
  "rationale",
  "renderpath",
  "secret",
  "token",
  "transcript",
]);

function normalizedStructure(candidate) {
  return {
    layout: candidate?.layout ?? null,
    captions: candidate?.captions?.identity
      ?? candidate?.captions?.structure
      ?? candidate?.captions
      ?? null,
    motion: candidate?.motion?.structure ?? candidate?.motion ?? null,
    sound: candidate?.sound?.structure ?? candidate?.sound ?? null,
  };
}

function differs(left, right) {
  return canonicalJson(left) !== canonicalJson(right);
}

function assertScore(name, value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} score must be between 0 and 1`);
  }
}

function rounded(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function sanitize(value, seen = new WeakSet()) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(item => sanitize(item, seen)).filter(item => item !== undefined);
  if (!value || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (PRIVATE_KEYS.has(normalized)) continue;
    const item = sanitize(value[key], seen);
    if (item !== undefined) output[key] = item;
  }
  seen.delete(value);
  return output;
}

export function candidateDiversity(left, right) {
  const leftStructure = normalizedStructure(left);
  const rightStructure = normalizedStructure(right);
  const structuralDifferences = Object.keys(leftStructure)
    .filter(key => differs(leftStructure[key], rightStructure[key]));
  const cosmeticDifferences = [];
  for (const key of ["palette", "colors", "accent", "theme"]) {
    if (differs(left?.[key] ?? null, right?.[key] ?? null)) cosmeticDifferences.push(key);
  }
  return {
    meaningful: structuralDifferences.length > 0,
    structuralDifferences,
    cosmeticDifferences,
    leftSignature: contentHash(leftStructure),
    rightSignature: contentHash(rightStructure),
  };
}

export function evaluateCandidate({
  candidate,
  metrics,
  iteration,
  baselineId,
  jobId,
  confounders = {},
  versions = {},
} = {}) {
  if (!candidate || typeof candidate !== "object") throw new Error("candidate is required");
  if (!Number.isInteger(iteration) || iteration < 0 || iteration > 2) {
    throw new Error("iteration must be between 0 and 2");
  }
  const scores = {};
  const failedGates = [];
  for (const dimension of rubric.dimensions) {
    const value = Number(metrics?.[dimension.id]);
    assertScore(dimension.id, value);
    scores[dimension.id] = value;
    if (value < dimension.minimum) failedGates.push(dimension.id);
  }
  const blindReview = Number(metrics?.blindReview);
  assertScore("blindReview", blindReview);
  scores.blindReview = blindReview;
  if (blindReview < BLIND_REVIEW_MINIMUM) failedGates.push("blindReview");
  const provenanceCoverage = Number(metrics?.provenanceCoverage);
  assertScore("provenanceCoverage", provenanceCoverage);
  if (provenanceCoverage < PROVENANCE_MINIMUM) failedGates.push("provenanceCoverage");

  const baseWeighted = rubric.dimensions.reduce(
    (sum, dimension) => sum + scores[dimension.id] * dimension.weight,
    0
  );
  const weightedScore = rounded(baseWeighted * 0.9 + blindReview * 0.1);
  const structure = normalizedStructure(candidate);
  const report = {
    schemaVersion: 1,
    evaluationVersion: "koubo-candidate-evaluation-v1",
    baselineId,
    jobId,
    iteration,
    candidateId: String(candidate.id || `candidate-${contentHash(structure).slice(0, 12)}`),
    candidateSignature: contentHash(structure),
    scores,
    weights: {
      ...Object.fromEntries(rubric.dimensions.map(item => [item.id, rounded(item.weight * 0.9)])),
      blindReview: 0.1,
    },
    weightedScore,
    provenanceCoverage,
    gatesPassed: failedGates.length === 0,
    failedGates,
    confounders: {
      baselineId,
      jobId,
      ...structuredClone(confounders),
    },
    versions: structuredClone(versions),
  };
  return { ...report, reportHash: contentHash(report) };
}

export function compareCandidates(v4, challenger) {
  if (!v4 || !challenger) throw new Error("both scorecards are required");
  const confounders = FAIR_CONFOUNDER_KEYS.filter(key =>
    !Object.is(v4.confounders?.[key], challenger.confounders?.[key])
  );
  if (confounders.length) {
    return {
      winner: null,
      reason: "comparison is confounded",
      confounders,
      margin: null,
    };
  }
  const margin = rounded(challenger.weightedScore - v4.weightedScore);
  if (!challenger.gatesPassed) {
    return {
      winner: "v4",
      reason: "challenger failed required gates",
      failedGates: [...challenger.failedGates],
      margin,
    };
  }
  if (!v4.gatesPassed) {
    return {
      winner: "challenger",
      reason: "control failed required gates",
      failedGates: [...v4.failedGates],
      margin,
    };
  }
  if (margin >= MATERIAL_MARGIN) {
    return {
      winner: "challenger",
      reason: "material improvement with all gates passed",
      margin,
    };
  }
  return {
    winner: "v4",
    reason: margin > 0 ? "improvement below material margin" : "v4 is equal or better",
    margin,
  };
}

function blindCandidate(candidate) {
  const safe = sanitize({
    layout: candidate.layout,
    captions: candidate.captions,
    motion: candidate.motion,
    sound: candidate.sound,
    palette: candidate.palette,
    duration: candidate.duration,
  });
  return {
    stableKey: contentHash({
      structure: safe,
      renderHash: candidate.renderHash,
    }),
    renderHash: String(candidate.renderHash || ""),
    structure: safe,
  };
}

export function buildBlindReviewBundle(candidates, {
  baselineId,
  jobId,
} = {}) {
  if (!Array.isArray(candidates) || candidates.length < 2) {
    throw new Error("at least two candidates are required");
  }
  const prepared = candidates.map(blindCandidate)
    .sort((left, right) => left.stableKey.localeCompare(right.stableKey));
  for (const item of prepared) {
    if (!/^[a-f0-9]{64}$/.test(item.renderHash)) {
      throw new Error("blind candidate renderHash must be sha256");
    }
  }
  const publicCandidates = prepared.map((item, index) => ({
    label: String.fromCharCode(65 + index),
    renderHash: item.renderHash,
    structure: item.structure,
  }));
  const body = {
    schemaVersion: 1,
    bundleVersion: "koubo-blind-review-v1",
    baselineId,
    jobId,
    rubricId: rubric.id,
    candidates: publicCandidates,
    reviewRequirements: {
      timestampedFindings: true,
      hideAuthors: true,
      hideRationales: true,
    },
  };
  return { ...body, bundleHash: contentHash(body) };
}
