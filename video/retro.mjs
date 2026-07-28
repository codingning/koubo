export function buildVideoRetro({ job, version, observations = [], userFeedback = "" } = {}) {
  return {
    schemaVersion: 1,
    jobId: String(job?.id || ""),
    outputVersion: Number(version || job?.output?.version || 0),
    status: "per-video-only",
    autoPromote: false,
    observations: observations.map(item => ({
      category: String(item.category || "general"),
      finding: String(item.finding || item),
      evidence: Array.isArray(item.evidence) ? item.evidence : [],
      recurrenceCount: Number(item.recurrenceCount || 1),
      promotionEligible: false,
    })),
    userFeedback: String(userFeedback || ""),
    promotionRule: "Only repeated findings confirmed by a human may enter trial; retro never promotes directly.",
    generatedAt: new Date().toISOString(),
  };
}

export function retroMarkdown(retro) {
  return [
    `# Video retro · ${retro.jobId} · v${retro.outputVersion}`,
    "",
    "状态：仅限本期，不自动进入长期规则。",
    "",
    ...retro.observations.flatMap((item, index) => [
      `## ${index + 1}. ${item.category}`,
      "",
      item.finding,
      "",
      `证据：${item.evidence.length ? item.evidence.join("；") : "待补"}`,
      "",
    ]),
    "## 用户反馈",
    "",
    retro.userFeedback || "尚未填写。",
    "",
  ].join("\n");
}
