import path from "node:path";

export function assertApprovedTimeline(timeline) {
  if (!timeline || typeof timeline !== "object") throw new Error("缺少批准时间线");
  if (!timeline.source?.path || !path.isAbsolute(timeline.source.path)) throw new Error("时间线源媒体必须是绝对路径");
  if (!Array.isArray(timeline.clips) || !timeline.clips.length) throw new Error("时间线没有可导出的片段");
  let cursor = 0;
  for (const clip of timeline.clips) {
    const values = [clip.sourceIn, clip.sourceOut, clip.outputIn, clip.outputOut].map(Number);
    if (values.some(value => !Number.isFinite(value))) throw new Error(`片段 ${clip.id || "unknown"} 时间无效`);
    if (values[1] <= values[0] || values[3] <= values[2]) throw new Error(`片段 ${clip.id || "unknown"} 范围无效`);
    if (Math.abs(values[2] - cursor) > 0.02) throw new Error(`片段 ${clip.id || "unknown"} 输出时间线不连续`);
    cursor = values[3];
  }
  return timeline;
}

export function buildExporterEdl(timeline) {
  assertApprovedTimeline(timeline);
  return {
    schema_version: 1,
    sources: { primary: timeline.source.path },
    ranges: timeline.clips.map(clip => ({
      id: String(clip.id),
      source: "primary",
      source_start: Number(clip.sourceIn),
      source_end: Number(clip.sourceOut),
      output_start: Number(clip.outputIn),
      output_end: Number(clip.outputOut),
      reason: String(clip.reason || "approved keep segment"),
    })),
    output_duration: Number(timeline.outputDuration),
  };
}

export function exporterRequest({ job, timeline, exporter, outputRoot, draftName }) {
  if (!job?.id) throw new Error("缺少任务 ID");
  return {
    schema_version: 1,
    exporter,
    job_id: job.id,
    timeline_version: Number(timeline.version),
    timeline: buildExporterEdl(timeline),
    output_root: path.resolve(outputRoot),
    draft_name: String(draftName || `${job.id}-v${timeline.version}`),
    fps: Math.max(1, Math.round(Number(timeline.source?.fps || 30))),
  };
}
