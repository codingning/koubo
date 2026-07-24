import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  contentHash,
  loadAgentProfiles,
  validateRecord,
} from "./contracts.mjs";
import { createMemoryService } from "./memory.mjs";
import { openDomainStore } from "./store.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(moduleDir, "..", "..");
const defaultCatalogFile = path.join(
  defaultRepositoryRoot,
  "config",
  "multi-agent",
  "trials",
  "agent-training-batch-1",
  "trial-catalog.v3.json",
);

const REVIEW_CODES = Object.freeze([
  "C1", "C2", "C3", "M1", "M2", "M3", "S1", "S2", "S3", "D1", "D2", "D3",
]);
const REVISED_CODES = new Set(["M3", "S2", "S3"]);

function readJson(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} is missing: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function finalized(value) {
  const record = structuredClone(value);
  delete record.contentHash;
  record.contentHash = contentHash(record);
  return record;
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function catalogHash(value) {
  const payload = structuredClone(value);
  delete payload.catalogHash;
  return contentHash(payload);
}

function technicalRecordCore(record) {
  return {
    id: record.id,
    source: structuredClone(record.source),
    evidence: structuredClone(record.evidence),
    applicability: structuredClone(record.applicability),
    prohibitions: structuredClone(record.prohibitions),
    versions: structuredClone(record.versions),
    domain: record.domain,
    namespace: record.namespace,
    title: record.title,
    problem: record.problem,
    primitive: record.primitive,
    parameters: structuredClone(record.parameters),
    tags: structuredClone(record.tags || []),
  };
}

function technicalCatalogCore(catalog) {
  return {
    schemaVersion: 1,
    items: catalog.items.map(item => ({
      code: item.code,
      trialCandidate: structuredClone(item.trialCandidate),
      record: technicalRecordCore(item.record),
    })),
  };
}

function normalizedReviewCore(review) {
  return {
    schemaVersion: review.schemaVersion,
    reviewId: review.reviewId,
    candidateStatus: review.candidateStatus,
    reviewStage: review.reviewStage,
    admissionTarget: review.admissionTarget,
    notKnowledgePromotion: review.notKnowledgePromotion,
    evidenceSetHash: review.evidenceSetHash,
    classification: review.classification,
    wholeSetRejected: review.wholeSetRejected,
    completion: {
      decided: review.completion?.decided,
      total: review.completion?.total,
      complete: review.completion?.complete,
    },
    items: (review.items || []).map(item => ({
      code: item.code,
      candidateId: item.candidateId,
      contentHash: item.contentHash,
      decision: item.decision,
      note: item.note,
    })),
  };
}

function expectedReviewCore(catalog) {
  return {
    schemaVersion: catalog.sourceReview.schemaVersion,
    reviewId: catalog.sourceReview.reviewId,
    candidateStatus: "candidate",
    reviewStage: catalog.sourceReview.reviewStage,
    admissionTarget: catalog.sourceReview.admissionTarget,
    notKnowledgePromotion: true,
    evidenceSetHash: catalog.sourceReview.evidenceSetHash,
    classification: "item_level_review",
    wholeSetRejected: false,
    completion: { decided: REVIEW_CODES.length, total: REVIEW_CODES.length, complete: true },
    items: catalog.items.map(item => ({
      code: item.code,
      candidateId: item.sourceDecision.candidateId,
      contentHash: item.sourceDecision.contentHash,
      decision: item.sourceDecision.decision,
      note: "",
    })),
  };
}

function resolutionDecisionCore(catalog) {
  return {
    schemaVersion: 1,
    id: catalog.resolution.id,
    decision: catalog.resolution.decision,
    parentReviewId: catalog.sourceReview.reviewId,
    parentEvidenceSetHash: catalog.sourceReview.evidenceSetHash,
    parentDecisionHash: catalog.sourceReview.decisionHash,
    reviewRuleTextAgain: catalog.resolution.reviewRuleTextAgain,
    nextHumanReview: catalog.resolution.nextHumanReview,
    revisedItems: catalog.resolution.revisedItems.map(item => ({
      code: item.code,
      previousCandidateId: item.previousCandidateId,
      previousContentHash: item.previousContentHash,
      candidateId: item.candidateId,
      candidateContentHash: item.candidateContentHash,
    })),
  };
}

function assertCatalogShape(catalog) {
  if (catalog.schemaVersion !== 1 || catalog.status !== "trial_catalog") {
    throw new Error("trial catalog must be schemaVersion 1 with trial_catalog status");
  }
  if (!/^[a-f0-9]{64}$/.test(String(catalog.catalogHash || ""))) {
    throw new Error("trial catalog must declare a lowercase SHA-256 catalogHash");
  }
  const actualCatalogHash = catalogHash(catalog);
  if (actualCatalogHash !== catalog.catalogHash) {
    throw new Error(`trial catalog hash mismatch: expected ${actualCatalogHash}`);
  }
  if (!Array.isArray(catalog.items) || catalog.items.length !== REVIEW_CODES.length) {
    throw new Error(`trial catalog must contain exactly ${REVIEW_CODES.length} items`);
  }
  if (catalog.items.map(item => item.code).join(",") !== REVIEW_CODES.join(",")) {
    throw new Error("trial catalog item order or coverage changed");
  }
  if (contentHash(expectedReviewCore(catalog)) !== catalog.sourceReview.decisionHash) {
    throw new Error("trial catalog source review decision hash does not match its pinned decisions");
  }
  if (!/^[a-f0-9]{64}$/.test(String(catalog.technicalCatalogHash || ""))) {
    throw new Error("trial catalog must declare a lowercase SHA-256 technicalCatalogHash");
  }
  if (contentHash(technicalCatalogCore(catalog)) !== catalog.technicalCatalogHash) {
    throw new Error("trial catalog technical content hash does not match its record semantics");
  }
  if (!/^[a-f0-9]{64}$/.test(String(catalog.resolution?.decisionHash || ""))) {
    throw new Error("trial catalog resolution must declare a lowercase SHA-256 decisionHash");
  }
  if (contentHash(resolutionDecisionCore(catalog)) !== catalog.resolution?.decisionHash) {
    throw new Error("trial catalog resolution decision hash does not match its pinned revisions");
  }
  const revisedByCode = new Map(
    (catalog.resolution?.revisedItems || []).map(item => [item.code, item]),
  );
  if (catalog.resolution.revisedItems.length !== REVISED_CODES.size
    || revisedByCode.size !== REVISED_CODES.size
    || catalog.resolution.revisedItems.map(item => item.code).join(",") !== [...REVISED_CODES].join(",")) {
    throw new Error("trial catalog must define exactly the three recommended revisions");
  }
  const ids = new Set();
  for (const item of catalog.items) {
    const expectedDecision = REVISED_CODES.has(item.code)
      ? "revise_then_review"
      : "retain_for_real_clip_trial";
    if (item.sourceDecision?.decision !== expectedDecision) {
      throw new Error(`${item.code} source decision must be ${expectedDecision}`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(item.sourceDecision?.contentHash || ""))) {
      throw new Error(`${item.code} source candidate hash is invalid`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(item.trialCandidate?.candidateContentHash || ""))) {
      throw new Error(`${item.code} trial candidate hash is invalid`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(item.trialCandidate?.technicalContentHash || ""))) {
      throw new Error(`${item.code} trial technical content hash is invalid`);
    }
    const actualTechnicalContentHash = contentHash(technicalRecordCore(item.record));
    if (actualTechnicalContentHash !== item.trialCandidate.technicalContentHash) {
      throw new Error(`${item.code} trial technical content hash does not match its record semantics`);
    }
    if (item.record?.id !== item.trialCandidate.candidateId || item.record?.status !== "trial") {
      throw new Error(`${item.code} trial record identity or status is invalid`);
    }
    if (ids.has(item.record.id)) throw new Error(`duplicate trial record id: ${item.record.id}`);
    ids.add(item.record.id);
    const revision = revisedByCode.get(item.code);
    if (REVISED_CODES.has(item.code)) {
      if (!revision
        || revision.previousCandidateId !== item.sourceDecision.candidateId
        || revision.previousContentHash !== item.sourceDecision.contentHash
        || revision.candidateId !== item.trialCandidate.candidateId
        || revision.candidateContentHash !== item.trialCandidate.candidateContentHash
        || revision.candidateTechnicalContentHash !== item.trialCandidate.technicalContentHash
        || !String(revision.acceptedChangeSummary || "").trim()
      ) {
        throw new Error(`${item.code} v1 to v2 lineage is incomplete`);
      }
    } else if (item.sourceDecision.candidateId !== item.trialCandidate.candidateId
      || item.sourceDecision.contentHash !== item.trialCandidate.candidateContentHash) {
      throw new Error(`${item.code} retained candidate must preserve its reviewed identity and hash`);
    }
  }
}

function withReviewBinding(item, catalog) {
  const revised = REVISED_CODES.has(item.code);
  return finalized({
    ...structuredClone(item.record),
    reviewBinding: {
      code: item.code,
      sourceReviewId: catalog.sourceReview.reviewId,
      sourceEvidenceSetHash: catalog.sourceReview.evidenceSetHash,
      sourceDecisionHash: catalog.sourceReview.decisionHash,
      technicalCatalogHash: catalog.technicalCatalogHash,
      sourceCandidateId: item.sourceDecision.candidateId,
      sourceCandidateContentHash: item.sourceDecision.contentHash,
      sourceDecision: item.sourceDecision.decision,
      trialCandidateId: item.trialCandidate.candidateId,
      trialCandidateContentHash: item.trialCandidate.candidateContentHash,
      trialTechnicalContentHash: item.trialCandidate.technicalContentHash,
      resolutionId: revised ? catalog.resolution.id : null,
      resolutionDecisionHash: revised ? catalog.resolution.decisionHash : null,
    },
    authority: structuredClone(catalog.authority),
  });
}

export function loadAgentTrainingTrialCatalog({
  repositoryRoot = defaultRepositoryRoot,
  catalogFile = defaultCatalogFile,
} = {}) {
  const resolvedRoot = path.resolve(repositoryRoot);
  const resolvedCatalog = path.resolve(catalogFile);
  const allowedRoot = path.join(resolvedRoot, "config", "multi-agent", "trials");
  const relative = path.relative(allowedRoot, resolvedCatalog);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("trial catalog must be inside config/multi-agent/trials");
  }
  const catalog = readJson(resolvedCatalog, "trial catalog");
  assertCatalogShape(catalog);
  const records = catalog.items.map(item => {
    const record = withReviewBinding(item, catalog);
    validateRecord("technique-card", record);
    return { code: item.code, record, sourceDecision: item.sourceDecision, trialCandidate: item.trialCandidate };
  });
  return { catalog, records, catalogFile: resolvedCatalog };
}

export function validateAgentTrainingReview(review, catalog) {
  const core = normalizedReviewCore(review);
  const expected = expectedReviewCore(catalog);
  if (canonicalJson(core) !== canonicalJson(expected)) {
    throw new Error("human review does not match the pinned 12 candidate decisions and hashes");
  }
  const decisionHash = contentHash(core);
  if (decisionHash !== catalog.sourceReview.decisionHash) {
    throw new Error("human review decision hash does not match the trial catalog");
  }
  return { core, decisionHash };
}

function immutableRecord(payload) {
  const value = structuredClone(payload);
  value.recordHash = contentHash(value);
  return value;
}

export function buildAgentTrainingHumanRecords({
  review,
  reviewFileSha256,
  catalog,
  actor = { type: "human", id: "koubo-owner" },
  recordedAt = new Date().toISOString(),
} = {}) {
  const { core, decisionHash } = validateAgentTrainingReview(review, catalog);
  if (actor?.type !== "human" || !String(actor.id || "").trim()) {
    throw new Error("trial admission records require a human actor");
  }
  const reviewRecord = immutableRecord({
    schemaVersion: 1,
    id: `${catalog.sourceReview.reviewId}.${decisionHash}`,
    status: "recorded",
    kind: "agent_training_second_level_review",
    recordedAt,
    actor,
    reviewFileSha256,
    decisionHash,
    review: core,
    authority: structuredClone(catalog.authority),
  });
  const resolutionRecord = immutableRecord({
    schemaVersion: 1,
    id: catalog.resolution.id,
    status: "recorded",
    kind: "agent_training_recommended_revision_resolution",
    recordedAt,
    actor,
    parentReviewId: catalog.sourceReview.reviewId,
    parentEvidenceSetHash: catalog.sourceReview.evidenceSetHash,
    parentDecisionHash: decisionHash,
    technicalCatalogHash: catalog.technicalCatalogHash,
    resolutionDecisionHash: catalog.resolution.decisionHash,
    decision: catalog.resolution.decision,
    revisedItems: structuredClone(catalog.resolution.revisedItems),
    reviewExperience: {
      ruleTextReviewRequired: catalog.resolution.reviewRuleTextAgain,
      nextHumanReview: catalog.resolution.nextHumanReview,
      rationale: "The owner delegated technical rule wording and will judge only real-clip outcomes.",
    },
    authority: structuredClone(catalog.authority),
  });
  return { reviewRecord, resolutionRecord };
}

function recordAtStatus(record, status) {
  return finalized({ ...structuredClone(record), status });
}

function writeExclusiveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function safeRemoveStaging(directory, parent) {
  if (!directory) return;
  const relative = path.relative(parent, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
  fs.rmSync(directory, { recursive: true, force: true });
}

export async function applyAgentTrainingTrialBatch({
  repositoryRoot = defaultRepositoryRoot,
  catalogFile = defaultCatalogFile,
  reviewFile,
  outputRoot,
  actor = { type: "human", id: "koubo-owner" },
  clock = () => new Date().toISOString(),
  onItemApplied = () => {},
} = {}) {
  if (!reviewFile || !outputRoot) throw new Error("reviewFile and outputRoot are required");
  const resolvedReview = path.resolve(reviewFile);
  const resolvedOutput = path.resolve(outputRoot);
  if (fs.existsSync(resolvedOutput)) throw new Error(`trial batch output already exists: ${resolvedOutput}`);
  const parent = path.dirname(resolvedOutput);
  fs.mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(resolvedOutput)}.${crypto.randomUUID()}.tmp`);
  const review = readJson(resolvedReview, "human review");
  const { catalog, records } = loadAgentTrainingTrialCatalog({ repositoryRoot, catalogFile });
  const recordedAt = clock();
  const { reviewRecord, resolutionRecord } = buildAgentTrainingHumanRecords({
    review,
    reviewFileSha256: hashFile(resolvedReview),
    catalog,
    actor,
    recordedAt,
  });
  let store;
  try {
    const profiles = await loadAgentProfiles(repositoryRoot);
    store = openDomainStore({
      dbPath: path.join(staging, "runtime", "memory.sqlite"),
      exportRoot: path.join(staging, "library"),
      clock,
    });
    const memory = createMemoryService(store, profiles, { clock });
    const applied = [];
    for (const item of records) {
      const inbox = recordAtStatus(item.record, "inbox");
      memory.ingest(inbox, "technique-card");
      const extracted = memory.transition({
        kind: "technique-card",
        id: item.record.id,
        to: "extracted",
        actor: { type: "controller", id: "agent-training-source-validator" },
        evidence: [{
          type: "source-review-binding",
          sourceId: catalog.sourceReview.reviewId,
          reviewId: catalog.sourceReview.reviewId,
          evidenceSetHash: catalog.sourceReview.evidenceSetHash,
          decisionHash: catalog.sourceReview.decisionHash,
        }],
        expectedHash: memory.get("technique-card", item.record.id).contentHash,
      });
      const recreatedEvidence = item.record.evidence.filter(evidence =>
        new Set(["scenario-suite", "render-qa", "mix-qa", "same-stem-ab-qa", "semantic-cue-qa"]).has(evidence.kind)
      );
      const recreated = memory.transition({
        kind: "technique-card",
        id: item.record.id,
        to: "recreated",
        actor: { type: "controller", id: "agent-training-sandbox-validator" },
        evidence: recreatedEvidence.length ? recreatedEvidence : item.record.evidence,
        expectedHash: memory.get("technique-card", item.record.id).contentHash,
      });
      const revised = REVISED_CODES.has(item.code);
      const trialEvidence = {
        type: "human-review",
        sourceId: revised ? resolutionRecord.id : reviewRecord.id,
        reviewId: revised ? resolutionRecord.id : catalog.sourceReview.reviewId,
        parentReviewId: catalog.sourceReview.reviewId,
        reviewerId: actor.id,
        projectId: catalog.id,
        decision: "approved_for_trial",
        sourceDecision: item.sourceDecision.decision,
        candidateId: item.record.id,
        sourceCandidateContentHash: item.sourceDecision.contentHash,
        trialCandidateContentHash: item.trialCandidate.candidateContentHash,
        trialTechnicalContentHash: item.trialCandidate.technicalContentHash,
        evidenceSetHash: catalog.sourceReview.evidenceSetHash,
        technicalCatalogHash: catalog.technicalCatalogHash,
        decisionHash: revised ? undefined : reviewRecord.decisionHash,
        resolutionHash: revised ? catalog.resolution.decisionHash : undefined,
      };
      const trial = memory.transition({
        kind: "technique-card",
        id: item.record.id,
        to: "trial",
        actor,
        evidence: [trialEvidence],
        expectedHash: memory.get("technique-card", item.record.id).contentHash,
      });
      if (trial.record.contentHash !== item.record.contentHash) {
        throw new Error(`${item.code} final trial record does not match the versioned catalog`);
      }
      applied.push({
        code: item.code,
        recordId: item.record.id,
        contentHash: trial.record.contentHash,
        sourceCandidateContentHash: item.sourceDecision.contentHash,
        trialCandidateContentHash: item.trialCandidate.candidateContentHash,
        trialTechnicalContentHash: item.trialCandidate.technicalContentHash,
        transitions: [extracted.id, recreated.id, trial.id],
        rollbackTransitionId: trial.id,
      });
      onItemApplied({ code: item.code, index: applied.length - 1, stagingRoot: staging });
    }
    const trials = store.list("technique-card", { status: "trial" });
    if (trials.length !== REVIEW_CODES.length
      || store.list("technique-card", { status: "approved" }).length !== 0
      || store.list("technique-card", { status: "promoted" }).length !== 0) {
      throw new Error("trial batch lifecycle count is invalid");
    }
    const manifest = immutableRecord({
      schemaVersion: 1,
      id: `${catalog.id}.application.v1`,
      status: "trial",
      createdAt: clock(),
      catalogId: catalog.id,
      catalogHash: catalog.catalogHash,
      technicalCatalogHash: catalog.technicalCatalogHash,
      catalogFileSha256: hashFile(catalogFile),
      sourceReviewId: catalog.sourceReview.reviewId,
      sourceEvidenceSetHash: catalog.sourceReview.evidenceSetHash,
      sourceDecisionHash: catalog.sourceReview.decisionHash,
      humanReviewRecordHash: reviewRecord.recordHash,
      humanResolutionRecordHash: resolutionRecord.recordHash,
      itemCount: applied.length,
      items: applied,
      authority: structuredClone(catalog.authority),
    });
    writeExclusiveJson(path.join(staging, "human-review-record.json"), reviewRecord);
    writeExclusiveJson(path.join(staging, "human-revision-resolution.json"), resolutionRecord);
    writeExclusiveJson(path.join(staging, "trial-batch-manifest.json"), manifest);
    fs.copyFileSync(catalogFile, path.join(staging, "trial-catalog-snapshot.json"), fs.constants.COPYFILE_EXCL);
    store.close();
    store = null;
    fs.renameSync(staging, resolvedOutput);
    return {
      outputRoot: resolvedOutput,
      itemCount: applied.length,
      catalogHash: catalog.catalogHash,
      catalogFileSha256: manifest.catalogFileSha256,
      reviewRecordHash: reviewRecord.recordHash,
      resolutionRecordHash: resolutionRecord.recordHash,
      manifestHash: manifest.recordHash,
      productionApproval: false,
      memoryPromotion: false,
      publishAuthority: false,
    };
  } catch (error) {
    try { store?.close(); } catch {}
    safeRemoveStaging(staging, parent);
    throw error;
  }
}

export const AGENT_TRAINING_TRIAL_DEFAULTS = Object.freeze({
  repositoryRoot: defaultRepositoryRoot,
  catalogFile: defaultCatalogFile,
  reviewCodes: REVIEW_CODES,
});

export const AGENT_TRAINING_TRIAL_HASHING = Object.freeze({
  catalogHash,
  resolutionDecisionCore,
  technicalCatalogCore,
  technicalRecordCore,
});
