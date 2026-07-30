import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash, validateRecord } from "./contracts.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDir, "..", "..");
const DEFAULT_SOURCE_FILE = path.join(
  repositoryRoot,
  "config",
  "multi-agent",
  "sources",
  "reference-batch-2",
  "source-catalog.json"
);
const DEFAULT_CANDIDATE_FILE = path.join(
  repositoryRoot,
  "config",
  "multi-agent",
  "candidates",
  "reference-batch-2",
  "candidate-catalog.json"
);

const ALLOWED_CANDIDATE_STATUSES = new Set(["inbox", "extracted"]);
const PRODUCTION_STATUSES = new Set(["approved", "promoted"]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function hashWithout(value, keys) {
  const copy = structuredClone(value);
  for (const key of keys) delete copy[key];
  return contentHash(copy);
}

function assertLowerSha(value, label) {
  if (!/^[a-f0-9]{64}$/.test(String(value || ""))) {
    throw new Error(`${label} must be a lowercase sha256`);
  }
}

function validateSourceCatalog(catalog) {
  if (catalog.schemaVersion !== 1 || !String(catalog.id || "").trim()) {
    throw new Error("source catalog must have schemaVersion 1 and an id");
  }
  if (catalog.productionEligible !== false) {
    throw new Error("reference source catalog must not be production eligible");
  }
  if (!Array.isArray(catalog.sources) || catalog.sources.length === 0) {
    throw new Error("reference source catalog must contain sources");
  }
  const ids = new Set();
  for (const source of catalog.sources) {
    if (!String(source.id || "").trim() || ids.has(source.id)) {
      throw new Error(`duplicate or empty source id: ${source.id}`);
    }
    ids.add(source.id);
    if (!String(source.url || "").startsWith("https://")) {
      throw new Error(`source must use an https URL: ${source.id}`);
    }
    if (!["fully_reviewed_local_evidence", "reviewed_text", "caption_reviewed", "caption_reviewed_opening_only", "discovery_only"].includes(source.reviewStatus)) {
      throw new Error(`unsupported source review status: ${source.reviewStatus}`);
    }
    if (source.reviewStatus === "fully_reviewed_local_evidence") {
      if (!(Number(source.durationSeconds) > 0)) {
        throw new Error(`reviewed source must declare duration: ${source.id}`);
      }
      assertLowerSha(source.mediaSha256, `${source.id}.mediaSha256`);
      assertLowerSha(source.transcriptSha256, `${source.id}.transcriptSha256`);
      if (source.redistributionAllowed !== false) {
        throw new Error(`reviewed source must remain research-only: ${source.id}`);
      }
    }
  }
  const actualHash = hashWithout(catalog, ["catalogHash"]);
  if (catalog.catalogHash !== actualHash) {
    throw new Error(`source catalog hash mismatch: expected ${actualHash}`);
  }
  return catalog;
}

function techniqueFingerprint(record) {
  return contentHash({
    domain: record.domain,
    primitive: record.primitive,
    problem: record.problem,
    parameters: record.parameters || {},
  });
}

function validateCandidateCatalog(catalog, sourceCatalog) {
  if (catalog.schemaVersion !== 1 || !String(catalog.id || "").trim()) {
    throw new Error("candidate catalog must have schemaVersion 1 and an id");
  }
  if (catalog.productionEligible !== false || catalog.defaultRetrieval !== false) {
    throw new Error("reference candidates must be isolated from production retrieval");
  }
  if (catalog.sourceCatalogId !== sourceCatalog.id || catalog.sourceCatalogHash !== sourceCatalog.catalogHash) {
    throw new Error("candidate catalog is not bound to the declared source catalog");
  }
  if (!Array.isArray(catalog.records) || catalog.records.length === 0) {
    throw new Error("candidate catalog must contain records");
  }

  const reviewedSources = new Map(
    sourceCatalog.sources
      .filter(source => source.reviewStatus === "fully_reviewed_local_evidence")
      .map(source => [source.id, source])
  );
  const ids = new Set();
  const fingerprints = new Set();
  for (const record of catalog.records) {
    validateRecord("technique-card", record);
    if (!ALLOWED_CANDIDATE_STATUSES.has(record.status)) {
      throw new Error(`candidate status leaked beyond inbox/extracted: ${record.id}/${record.status}`);
    }
    if (record.productionEligible !== false) {
      throw new Error(`candidate must explicitly deny production eligibility: ${record.id}`);
    }
    if (ids.has(record.id)) throw new Error(`duplicate candidate id: ${record.id}`);
    ids.add(record.id);
    const fingerprint = techniqueFingerprint(record);
    if (fingerprints.has(fingerprint)) throw new Error(`duplicate candidate fingerprint: ${record.id}`);
    fingerprints.add(fingerprint);
    const actualRecordHash = hashWithout(record, ["contentHash"]);
    if (record.contentHash !== actualRecordHash) {
      throw new Error(`candidate contentHash mismatch: ${record.id}`);
    }
    for (const evidence of record.evidence) {
      const source = reviewedSources.get(evidence.sourceId);
      if (!source) {
        throw new Error(`candidate evidence must bind a fully reviewed source: ${record.id}/${evidence.sourceId}`);
      }
      if (evidence.end > source.durationSeconds + 0.001) {
        throw new Error(`candidate evidence exceeds source duration: ${record.id}`);
      }
      if (evidence.useBoundary !== "public-reference-research-only-no-redistribution") {
        throw new Error(`candidate evidence has an unsafe use boundary: ${record.id}`);
      }
    }
  }

  const actualHash = hashWithout(catalog, ["catalogHash"]);
  if (catalog.catalogHash !== actualHash) {
    throw new Error(`candidate catalog hash mismatch: expected ${actualHash}`);
  }
  return catalog;
}

export function loadReferenceKnowledgeBatch({
  sourceFile = DEFAULT_SOURCE_FILE,
  candidateFile = DEFAULT_CANDIDATE_FILE,
} = {}) {
  const sources = validateSourceCatalog(readJson(sourceFile));
  const candidates = validateCandidateCatalog(readJson(candidateFile), sources);
  return { sources, candidates };
}

export function productionEligibleRecords(batch) {
  return batch.candidates.records.filter(record => PRODUCTION_STATUSES.has(record.status));
}

export function candidateFingerprints(batch) {
  return batch.candidates.records.map(record => ({
    id: record.id,
    fingerprint: techniqueFingerprint(record),
  }));
}

export const referenceKnowledgeBatchPaths = Object.freeze({
  sourceFile: DEFAULT_SOURCE_FILE,
  candidateFile: DEFAULT_CANDIDATE_FILE,
});
