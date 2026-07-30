const ANCHOR_TYPES = new Set(["exact", "semantic", "hybrid"]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeAssetAnchor(value, legacyPlacement = null) {
  const type = ANCHOR_TYPES.has(value?.type) ? value.type : "exact";
  const exactStart = finite(value?.start ?? legacyPlacement?.start);
  const exactEnd = finite(value?.end ?? legacyPlacement?.end);
  const segmentId = String(value?.segmentId || "").trim() || null;
  const offsetStart = finite(value?.offsetStart) ?? 0;
  const offsetEnd = finite(value?.offsetEnd);
  if (type === "exact" && (exactStart === null || exactEnd === null || exactStart < 0 || exactEnd <= exactStart)) return null;
  if ((type === "semantic" || type === "hybrid") && !segmentId) return null;
  return {
    type,
    segmentId,
    start: exactStart,
    end: exactEnd,
    offsetStart,
    offsetEnd,
  };
}

function segmentBounds(segment) {
  const start = finite(segment?.outputStart ?? segment?.editedTime?.start ?? segment?.start ?? segment?.outputIn);
  const end = finite(segment?.outputEnd ?? segment?.editedTime?.end ?? segment?.end ?? segment?.outputOut);
  return start !== null && end !== null && end > start ? { start, end } : null;
}

export function resolveAssetAnchor(anchorValue, segments = [], outputDuration = Infinity) {
  const anchor = normalizeAssetAnchor(anchorValue);
  if (!anchor) return null;
  if (anchor.type === "exact") return { start: anchor.start, end: Math.min(outputDuration, anchor.end), anchorType: "exact", segmentId: null };
  const segment = segments.find(item => String(item.segmentId || item.id || "") === anchor.segmentId);
  const bounds = segmentBounds(segment);
  if (!bounds) return null;
  const semanticStart = Math.max(0, bounds.start + anchor.offsetStart);
  const semanticEnd = Math.min(outputDuration, anchor.offsetEnd === null ? bounds.end : bounds.start + anchor.offsetEnd);
  if (semanticEnd <= semanticStart) return null;
  if (anchor.type === "semantic") return { start: semanticStart, end: semanticEnd, anchorType: "semantic", segmentId: anchor.segmentId };
  const start = anchor.start === null ? semanticStart : Math.max(semanticStart, anchor.start);
  const end = anchor.end === null ? semanticEnd : Math.min(semanticEnd, anchor.end);
  return end > start ? { start, end, anchorType: "hybrid", segmentId: anchor.segmentId } : null;
}
