function sourceId(value, index) {
  return String(value?.sourceId || value?.id || value?.videoId || `source-${index + 1}`);
}

export function createReferenceDistillation({ topicPlan = {}, research = {} } = {}) {
  const rawSources = Array.isArray(research.fullContentSources) && research.fullContentSources.length
    ? research.fullContentSources
    : Array.isArray(research.sources) ? research.sources : [];
  const sources = rawSources.map((source, index) => ({
    id: sourceId(source, index),
    url: String(source.url || source.sourceUrl || ""),
    title: String(source.title || source.name || ""),
    creator: String(source.creator || source.creatorName || ""),
    evidenceLevel: String(source.evidenceLevel || source.verificationLevel || "full-content"),
    mediaHash: String(source.mediaHash || source.sha256 || ""),
    durationSeconds: Number(source.durationSeconds || source.duration || 0) || null,
    hook: source.hook || null,
    timeline: Array.isArray(source.timeline) ? source.timeline : [],
    shots: Array.isArray(source.shots) ? source.shots : [],
    rhythm: source.rhythm || null,
    audio: source.audio || null,
    visual: source.visual || null,
    reusable: Array.isArray(source.reusable) ? source.reusable : [],
    prohibited: Array.isArray(source.prohibited) ? source.prohibited : [],
    uncertainties: Array.isArray(source.uncertainties) ? source.uncertainties : [],
  }));
  return {
    schemaVersion: 1,
    topic: String(topicPlan.topic || topicPlan.lockedDirection || ""),
    sourceCount: sources.length,
    sources,
    synthesis: {
      hooks: Array.isArray(research.hooks) ? research.hooks : [],
      structurePatterns: Array.isArray(research.structurePatterns) ? research.structurePatterns : [],
      visualPatterns: Array.isArray(research.visualPatterns) ? research.visualPatterns : [],
      audioPatterns: Array.isArray(research.audioPatterns) ? research.audioPatterns : [],
      reusable: Array.isArray(research.reusable) ? research.reusable : [],
      prohibited: Array.isArray(research.prohibited) ? research.prohibited : ["不得复制原句、人设、案例或核心表达"],
      uncertainties: Array.isArray(research.uncertainties) ? research.uncertainties : [],
    },
    generatedAt: new Date().toISOString(),
  };
}

export function validateReferenceDistillation(value) {
  const issues = [];
  if (Number(value?.schemaVersion) !== 1) issues.push("schemaVersion");
  if (!Array.isArray(value?.sources) || !value.sources.length) issues.push("sources");
  for (const source of value?.sources || []) {
    if (!source.id) issues.push("source.id");
    if (!source.url && !source.mediaHash) issues.push(`${source.id}.evidence`);
  }
  return { ok: issues.length === 0, issues };
}
