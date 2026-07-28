function time(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function buildStoryboard({ jobId, version, breakdown = {}, timeline = {}, style = {} } = {}) {
  const clips = timeline.clips || [];
  const scenes = (breakdown.segments || []).map((segment, index) => {
    const clip = clips[index] || {};
    return {
      sceneId: String(segment.segmentId || segment.id || `scene-${index + 1}`),
      start: time(segment.outputStart ?? clip.outputIn),
      end: time(segment.outputEnd ?? clip.outputOut),
      spokenMeaning: String(segment.meaning || segment.summary || segment.text || ""),
      title: String(segment.title || segment.heading || ""),
      keyLine: String(segment.keyLine || segment.subtitle || ""),
      summary: String(segment.summary || ""),
      factCards: Array.isArray(segment.factCards) ? segment.factCards : [],
      primaryVisual: segment.primaryVisual || segment.rightVisual || null,
      layoutMode: String(segment.layoutMode || "director-select"),
      renderer: String(segment.renderer || "director-select"),
      fallback: String(segment.fallback || "speaker-focus"),
    };
  });
  return {
    schemaVersion: 1,
    jobId: String(jobId || ""),
    version: Number(version || 1),
    authority: "derived-from-json",
    editable: false,
    visualStyle: style,
    scenes,
    generatedAt: new Date().toISOString(),
  };
}

export function storyboardMarkdown(storyboard) {
  const lines = [
    `# Storyboard v${storyboard.version}`,
    "",
    "> 派生视图：权威状态仍是 job.json、timeline 和 content-breakdown JSON；不要从本文件反写任务状态。",
    "",
  ];
  for (const scene of storyboard.scenes || []) {
    lines.push(`## ${scene.sceneId} · ${scene.start.toFixed(2)}–${scene.end.toFixed(2)}s`, "");
    if (scene.title) lines.push(`- 标题：${scene.title}`);
    if (scene.keyLine) lines.push(`- 重点句：${scene.keyLine}`);
    if (scene.spokenMeaning) lines.push(`- 口播含义：${scene.spokenMeaning}`);
    lines.push(`- 布局：${scene.layoutMode}`);
    lines.push(`- 渲染器：${scene.renderer}（fallback: ${scene.fallback}）`);
    lines.push(`- 事实卡：${scene.factCards.length ? scene.factCards.map(item => typeof item === "string" ? item : item.text || item.title || JSON.stringify(item)).join("；") : "无"}`);
    lines.push(`- 主视觉：${scene.primaryVisual ? JSON.stringify(scene.primaryVisual) : "由 Director 决定"}`, "");
  }
  return lines.join("\n");
}
