import { contentHash } from "./contracts.mjs";
import { validateSubjectiveReview } from "./subjective-review.mjs";

function verifiedPrivateMapping(manifest, privateMap) {
  if (!Array.isArray(privateMap)) throw new Error("blind mapping is required");
  const bySample = new Map(privateMap.map(item => [item.sampleId, item]));
  const output = new Map();
  for (const sample of manifest.samples || []) {
    const privateSample = bySample.get(sample.id);
    if (!privateSample || !Array.isArray(privateSample.mapping)) {
      throw new Error(`blind mapping is missing sample ${sample.id}`);
    }
    const byLabel = new Map(privateSample.mapping.map(item => [item.label, item]));
    const verified = new Map();
    for (const candidate of sample.candidates || []) {
      const mapping = byLabel.get(candidate.label);
      if (!mapping
        || mapping.renderHash !== candidate.renderHash
        || !String(mapping.recipeId || "").trim()) {
        throw new Error(`blind mapping changed for ${sample.id}/${candidate.label}`);
      }
      verified.set(candidate.label, {
        recipeId: String(mapping.recipeId),
        renderHash: candidate.renderHash,
      });
    }
    if (verified.size !== privateSample.mapping.length) {
      throw new Error(`blind mapping contains unexpected candidates for ${sample.id}`);
    }
    output.set(sample.id, verified);
  }
  if (output.size !== privateMap.length) {
    throw new Error("blind mapping contains unexpected samples");
  }
  return output;
}

export function prepareSubjectiveReviewRecord({
  manifest,
  privateMap,
  payload,
  clock = () => new Date().toISOString(),
} = {}) {
  if (!manifest || manifest.status !== "awaiting-user-subjective-review" || manifest.automatedPass !== true) {
    throw new Error("subjective review run is not ready for a human result");
  }
  if (manifest.finalSubjectiveReview) throw new Error("subjective review was already recorded");
  if (payload?.runId !== manifest.runId) throw new Error("review run does not match the manifest");
  if (payload?.reviewerType !== "human") throw new Error("subjective review must be human");

  const mapping = verifiedPrivateMapping(manifest, privateMap);
  const validated = validateSubjectiveReview(payload, manifest.samples);
  const samples = validated.samples.map(review => {
    const candidate = review.decision === "reject-all"
      ? null
      : mapping.get(review.sampleId).get(review.decision);
    return {
      ...review,
      recipeId: candidate?.recipeId || null,
      renderHash: candidate?.renderHash || null,
    };
  });
  const rejectedSamples = samples.filter(item => item.decision === "reject-all").length;
  const outcome = rejectedSamples
    ? "subjective-rejection-recorded"
    : "preference-evidence-recorded";
  const body = {
    schemaVersion: 1,
    recordVersion: "koubo-subjective-review-record-v1",
    runId: manifest.runId,
    baselineId: manifest.baselineId,
    reviewerType: "human",
    reviewedAt: String(payload.reviewedAt || clock()),
    outcome,
    samples,
    summary: {
      sampleCount: samples.length,
      rejectedSamples,
      selectedSamples: samples.length - rejectedSamples,
    },
    productionApproval: false,
    autoPublish: false,
    memoryPromotion: false,
  };
  const record = { ...body, recordHash: contentHash(body) };
  return {
    record,
    updatedManifest: {
      ...structuredClone(manifest),
      status: "subjective-review-recorded",
      finalSubjectiveReview: {
        recordHash: record.recordHash,
        reviewedAt: record.reviewedAt,
        outcome: record.outcome,
      },
      autoPublish: false,
      memoryPromotion: false,
    },
  };
}
