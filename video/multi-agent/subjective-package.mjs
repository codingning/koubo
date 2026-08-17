import { normalizeSubjectiveSamples } from "./subjective-review.mjs";

export function buildSubjectiveReviewPackage({
  runId,
  baselineId,
  samples,
  createdAt = new Date().toISOString(),
} = {}) {
  if (!runId || !baselineId || !Array.isArray(samples) || !samples.length) {
    throw new Error("runId, baselineId, and rendered samples are required");
  }
  const publicSamples = normalizeSubjectiveSamples(samples.map(({ sample, items }) => ({
    ...sample,
    candidates: items.map(item => ({
      label: item.label,
      renderHash: item.renderHash,
      publicFile: item.publicFile,
    })),
  })));
  const privateMap = samples.map(({ sample, items }) => ({
    sampleId: sample.id,
    mapping: items.map(item => ({
      label: item.label,
      recipeId: item.recipeId,
      renderHash: item.renderHash,
    })),
  }));
  const automatedPass = samples.every(({ items }) =>
    items.length >= 2 && items.every(item => item.technicalPass === true)
  );
  return {
    publicSamples,
    privateMap,
    manifest: {
      schemaVersion: 1,
      acceptanceVersion: "koubo-real-subjective-v1",
      runId,
      baselineId,
      createdAt,
      mediaKind: "real-talking-head",
      status: automatedPass
        ? "awaiting-user-subjective-review"
        : "automated-checks-failed",
      automatedPass,
      sampleCount: publicSamples.length,
      candidatesPerSample: publicSamples[0]?.candidates.length || 0,
      finalSubjectiveReview: null,
      autoPublish: false,
      memoryPromotion: false,
      residualRisks: [
        "Human preference and one concrete reason per real sample are still required.",
        "Subtitle text accuracy is not automated in this review and must be accepted separately.",
        "Only one real historical talking-head job was available, so three semantic windows from that job are used.",
      ],
    },
  };
}
