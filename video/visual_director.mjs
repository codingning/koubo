import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VISUAL_WORKFLOW_VERSION = "visual-director-v4";
export const VISUAL_STAGE_ORDER = [
  "style_research",
  "content_breakdown",
  "keyframes",
  "keyframe_review",
  "motion_sample",
  "full_render",
];

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

export function deepMerge(base, override) {
  if (!isObject(base)) return override === undefined ? clone(base) : clone(override);
  const result = clone(base);
  if (!isObject(override)) return result;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    result[key] = isObject(value) && isObject(result[key]) ? deepMerge(result[key], value) : clone(value);
  }
  return result;
}

export async function loadVisualWorkflowDefaults(root) {
  const file = path.join(root, "config", "video_workflow_v4.json");
  const value = JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  if (value.workflowVersion !== VISUAL_WORKFLOW_VERSION) throw new Error("视觉导演默认配置版本不匹配");
  for (const id of VISUAL_STAGE_ORDER) if (!value.stages?.[id]) throw new Error(`视觉导演默认配置缺少阶段：${id}`);
  return value;
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

export function normalizeVisualWorkflowConfig(defaults, overrides = {}) {
  const merged = deepMerge(defaults, overrides);
  merged.workflowVersion = VISUAL_WORKFLOW_VERSION;
  merged.defaultEngine = "hyperframes";
  merged.legacyFallback = defaults.legacyFallback || "ffmpeg-v3";
  merged.execution = deepMerge(defaults.execution, overrides.execution || {});
  merged.rendering = deepMerge(defaults.rendering, overrides.rendering || {});
  merged.stages = {};
  for (const id of VISUAL_STAGE_ORDER) {
    const base = defaults.stages[id];
    const custom = overrides.stages?.[id] || {};
    merged.stages[id] = {
      ...clone(base),
      settings: deepMerge(base.settings || {}, custom.settings || {}),
      prompt: String(custom.prompt ?? base.prompt ?? "").trim().slice(0, 24000),
    };
  }
  const keyframes = merged.stages.keyframes.settings;
  keyframes.count = Math.round(clampNumber(keyframes.count, 4, 3, 5));
  const content = merged.stages.content_breakdown.settings;
  delete content.factCardsPerSegment;
  content.minimumFactCardsPerSegment = Math.round(clampNumber(content.minimumFactCardsPerSegment, 0, 0, 3));
  content.maximumFactCardsPerSegment = Math.round(clampNumber(content.maximumFactCardsPerSegment, 3, content.minimumFactCardsPerSegment, 3));
  const sample = merged.stages.motion_sample.settings;
  sample.durationSeconds = clampNumber(sample.durationSeconds, 20, 15, 25);
  const final = merged.stages.full_render.settings;
  final.masterWidth = Number(final.masterWidth) === 1920 ? 1920 : 2560;
  final.masterHeight = final.masterWidth === 2560 ? 1440 : 1080;
  final.reviewWidth = 1920;
  final.reviewHeight = 1080;
  final.fps = Number(final.fps) === 60 ? 60 : 30;
  return merged;
}

export function createVisualWorkflowState(config) {
  const now = new Date().toISOString();
  return {
    version: VISUAL_WORKFLOW_VERSION,
    engine: "hyperframes",
    legacyFallback: config.legacyFallback || "ffmpeg-v3",
    currentStage: "style_research",
    configVersion: 1,
    config,
    stages: Object.fromEntries(VISUAL_STAGE_ORDER.map((id) => [id, {
      id,
      number: config.stages[id].number,
      label: config.stages[id].label,
      status: "pending",
      currentVersion: 0,
      approvedVersion: null,
      runs: [],
      artifacts: null,
      updatedAt: now,
    }])),
    audit: [{ type: "workflow-created", at: now, version: VISUAL_WORKFLOW_VERSION }],
    createdAt: now,
    updatedAt: now,
  };
}

export function ensureVisualWorkflowState(job, config) {
  if (!job.workflow || job.workflow.version !== VISUAL_WORKFLOW_VERSION) job.workflow = createVisualWorkflowState(config);
  if (!job.workflow.config) job.workflow.config = config;
  for (const id of VISUAL_STAGE_ORDER) {
    job.workflow.stages ||= {};
    job.workflow.stages[id] ||= createVisualWorkflowState(config).stages[id];
  }
  return job.workflow;
}

function visualReviewError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}

export function visualGateVersion(job, stageId) {
  if (stageId === "keyframe_review") return Number(job?.workflow?.stages?.keyframes?.currentVersion || 0);
  if (stageId === "motion_sample") return Number(job?.workflow?.stages?.motion_sample?.currentVersion || 0);
  throw visualReviewError("该阶段不使用审核版本", 400);
}

export function assertVisualGateVersion(job, stageId, expectedVersion) {
  const expected = Number(expectedVersion);
  if (!Number.isInteger(expected) || expected <= 0) throw visualReviewError("缺少有效的审核版本");
  const actual = visualGateVersion(job, stageId);
  if (actual !== expected) throw visualReviewError(`审核版本已更新：页面为 v${expected}，当前为 v${actual}`);
  return actual;
}

export function rejectVisualGateState(job, stageId, feedback = "", at = new Date().toISOString()) {
  const workflow = job?.workflow;
  if (!workflow?.stages) throw visualReviewError("视觉工作流尚未初始化");
  const reason = String(feedback || "").trim().slice(0, 4000) || "本轮全部不接受";
  let version = 0;

  if (stageId === "keyframe_review") {
    const source = workflow.stages.keyframes;
    const gate = workflow.stages.keyframe_review;
    if (!source?.artifacts?.frames?.length || source.status === "error") throw visualReviewError("还没有可拒绝的关键帧");
    if (gate?.status !== "awaiting_review") throw visualReviewError("当前关键帧不在待审核状态");
    version = Number(source.currentVersion || gate.currentVersion || 0);
    source.status = "rejected";
    source.approvedVersion = null;
    source.rejectedVersion = version;
    source.rejectedAt = at;
    source.updatedAt = at;
    delete source.approvedAt;
    gate.status = "rejected";
    gate.approvedVersion = null;
    gate.rejectedVersion = version;
    gate.feedback = reason;
    gate.rejectedAt = at;
    gate.updatedAt = at;
    delete gate.approvedAt;
    job.status = "keyframe_review_rejected";
    job.progress = visualStageProgress("keyframes", "complete");
  } else if (stageId === "motion_sample") {
    const stage = workflow.stages.motion_sample;
    if (!stage?.artifacts?.url || stage.status === "error") throw visualReviewError("还没有可拒绝的动态样片");
    if (stage.status !== "awaiting_review") throw visualReviewError("当前动态样片不在待审核状态");
    version = Number(stage.currentVersion || 0);
    stage.status = "rejected";
    stage.approvedVersion = null;
    stage.rejectedVersion = version;
    stage.feedback = reason;
    stage.rejectedAt = at;
    stage.updatedAt = at;
    delete stage.approvedAt;
    job.status = "motion_sample_rejected";
    job.progress = visualStageProgress("motion_sample", "complete");
  } else {
    throw visualReviewError("该阶段不使用拒绝接口", 400);
  }

  workflow.currentStage = stageId;
  workflow.updatedAt = at;
  workflow.audit ||= [];
  workflow.audit.push({ type: "stage-rejected", stageId, version, feedback: reason, at });
  return { stageId, version, feedback: reason, at };
}

export function invalidateVisualStages(workflow, afterStageId, reason = "上游阶段生成了新版本") {
  const index = VISUAL_STAGE_ORDER.indexOf(afterStageId);
  if (index < 0) return [];
  const invalidated = [];
  for (const id of VISUAL_STAGE_ORDER.slice(index + 1)) {
    const stage = workflow.stages[id];
    if (!stage) continue;
    if (stage.status !== "pending" || stage.approvedVersion !== null || stage.artifacts) invalidated.push(id);
    stage.status = "pending";
    stage.approvedVersion = null;
    stage.artifacts = null;
    stage.invalidatedAt = new Date().toISOString();
    stage.invalidatedReason = reason;
    delete stage.approvedAt;
    delete stage.approvedOutputVersion;
    delete stage.rejectedAt;
    delete stage.rejectedVersion;
    delete stage.feedback;
  }
  workflow.audit ||= [];
  if (invalidated.length) workflow.audit.push({ type: "downstream-invalidated", afterStageId, stages: invalidated, reason, at: new Date().toISOString() });
  workflow.updatedAt = new Date().toISOString();
  return invalidated;
}

export function visualStageProgress(stageId, phase = "running") {
  const ranges = {
    style_research: [3, 16],
    content_breakdown: [18, 40],
    keyframes: [42, 58],
    keyframe_review: [59, 60],
    motion_sample: [61, 78],
    full_render: [80, 100],
  };
  const [start, end] = ranges[stageId] || [0, 100];
  return phase === "complete" ? end : start;
}

const cleanText = (value, limit = 300) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
const array = (value) => Array.isArray(value) ? value : [];
const unique = (values) => [...new Set(values.filter(Boolean))];

function normalizeFactCards(value, valueLimit) {
  return array(value).map((fact) => {
    const factValue = cleanText(fact?.value || fact?.text, valueLimit);
    if (!factValue) return null;
    return {
      label: cleanText(fact?.label, 12),
      value: factValue,
    };
  }).filter(Boolean).slice(0, 3).map((fact, index) => ({
    ...fact,
    label: fact.label || ["重点", "方法", "结果"][index],
  }));
}

function uniqueSegmentId(value, index, seen) {
  const fallback = `S${String(index + 1).padStart(2, "0")}`;
  const normalized = cleanText(value, 80)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || fallback;
  let candidate = normalized;
  let suffix = 2;
  while (seen.has(candidate)) {
    const postfix = `-${suffix++}`;
    candidate = `${normalized.slice(0, Math.max(1, 40 - postfix.length))}${postfix}`;
  }
  seen.add(candidate);
  return candidate;
}

export function normalizeVisualStyleReport(raw, references = [], defaults = {}) {
  const value = isObject(raw) ? raw : {};
  const visual = defaults.visualDefaults || {};
  const paletteSource = isObject(value.colorSystem) ? value.colorSystem : isObject(value.palette) ? value.palette : visual.palette || {};
  const safeColor = (name, fallback) => /^#[0-9a-f]{6}$/i.test(String(paletteSource[name] || "")) ? String(paletteSource[name]).toUpperCase() : fallback;
  const selected = array(value.selectedReferences).map((item) => ({
    sourceId: cleanText(item?.sourceId, 120),
    creatorName: cleanText(item?.creatorName || item?.creator, 120),
    workTitle: cleanText(item?.workTitle || item?.title, 240),
    sourceUrl: cleanText(item?.sourceUrl || item?.url, 1000),
    evidenceLevel: cleanText(item?.evidenceLevel, 120),
    selectionReason: cleanText(item?.selectionReason, 400),
  })).filter((item) => item.sourceId || item.sourceUrl);
  const fallbackReferences = references.slice(0, 5).map((item) => ({
    sourceId: cleanText(item.sourceId, 120),
    creatorName: cleanText(item.creatorName || item.creator, 120),
    workTitle: cleanText(item.workTitle || item.title || item.topic, 240),
    sourceUrl: cleanText(item.sourceUrl || item.url, 1000),
    evidenceLevel: cleanText(item.evidenceLevel || "curated-full-reference", 120),
    selectionReason: "与本条AI口播的视觉包装和信息结构相关",
  }));
  const rules = isObject(value.packagingRules) ? value.packagingRules : {};
  return {
    schemaVersion: 1,
    summary: cleanText(value.summary || "16:9横版科技信息包装，人物在右、信息在左，按标题—摘要—事实—证据逐级推进。", 1000),
    selectedReferences: selected.length ? selected : fallbackReferences,
    analysis: {
      aspectRatioAndComposition: cleanText(value.analysis?.aspectRatioAndComposition || value.aspectRatioAndComposition || "16:9横版；左侧信息、右侧真人，保留充足负空间。", 600),
      subjectPosition: cleanText(value.analysis?.subjectPosition || value.subjectPosition || "真人位于右侧约三分之一区域，不遮挡脸部中轴。", 600),
      captionsAndCards: cleanText(value.analysis?.captionsAndCards || value.captionsAndCards || "字幕位于底部安全区；信息卡固定在左侧，与字幕分轨。", 600),
      motionOrder: array(value.analysis?.motionOrder || value.motionOrder).map((item) => cleanText(item, 240)).filter(Boolean).slice(0, 8),
      hierarchy: cleanText(value.analysis?.hierarchy || value.hierarchy || "主标题最高，摘要第二，事实卡第三，图表与证据在内容需要时接管视觉焦点。", 600),
      colorSystem: cleanText(value.analysis?.colorSystem || value.colorDescription || "深色背景、橙色主强调、青色辅助、黄色警示。", 600),
      pacing: cleanText(value.analysis?.pacing || value.pacing || "开头快，正文每个信息段依次推进，结论留出停顿。", 600),
      copyAndAvoid: cleanText(value.analysis?.copyAndAvoid || value.copyBoundary || "借鉴信息顺序和动效节奏，不复制文案、标题、人设、案例和标志性画面。", 800),
    },
    packagingRules: {
      layout: cleanText(rules.layout || visual.layout || "speaker-right-information-left", 120),
      title: cleanText(rules.title || "左上主标题先出现，控制在两行内。", 400),
      summary: cleanText(rules.summary || "左中摘要条随后滑入，只写本段真正想表达的结论。", 400),
      facts: cleanText(rules.facts || "左下只呈现已批准且实际存在的0—3张事实卡，并按内容需要依次进入。", 400),
      rightVisual: cleanText(rules.rightVisual || "右侧保留真人；展开证据或二维动效时，人物缩为画中画。", 500),
      captions: cleanText(rules.captions || "字幕只呈现说了什么，位于底部安全区，不充当信息卡。", 400),
      motion: array(rules.motion).map((item) => cleanText(item, 220)).filter(Boolean).slice(0, 10).length ? array(rules.motion).map((item) => cleanText(item, 220)).filter(Boolean).slice(0, 10) : clone(visual.motionOrder || []),
      copy: unique(array(rules.copy).map((item) => cleanText(item, 300))).slice(0, 10),
      avoid: unique(array(rules.avoid).map((item) => cleanText(item, 300))).slice(0, 10),
    },
    palette: {
      background: safeColor("background", "#07090F"),
      surface: safeColor("surface", "#111621"),
      primary: safeColor("primary", "#FF6A3D"),
      secondary: safeColor("secondary", "#55D6FF"),
      warning: safeColor("warning", "#FFD166"),
      text: safeColor("text", "#F7F9FC"),
      muted: safeColor("muted", "#9FA9B8"),
    },
    generatedAt: new Date().toISOString(),
  };
}

function sourceRange(item, fallbackStart, fallbackEnd, duration) {
  const range = item?.sourceTime || item?.sourceRange || item?.time || {};
  const start = Number(range.start ?? item?.start ?? fallbackStart);
  const end = Number(range.end ?? item?.end ?? fallbackEnd);
  const latestStart = Math.max(0, duration - 0.35);
  const safeStart = Number.isFinite(start) ? Math.max(0, Math.min(latestStart, start)) : Math.min(latestStart, fallbackStart);
  const requestedEnd = Number.isFinite(end) ? end : fallbackEnd;
  const safeEnd = Math.min(duration, Math.max(safeStart + 0.35, requestedEnd));
  return { start: Number(safeStart.toFixed(3)), end: Number(safeEnd.toFixed(3)) };
}

export function normalizeContentBreakdown(raw, options = {}) {
  const value = isObject(raw) ? raw : {};
  const duration = Math.max(1, Number(options.sourceDuration || 1));
  const outputDuration = Math.max(1, Number(options.outputDuration || duration));
  const minimum = Math.max(3, Number(options.minimumSegments || 5));
  const maximum = Math.max(minimum, Number(options.maximumSegments || 12));
  let requested = array(value.segments);
  if (!requested.length) requested = array(options.fallbackSegments);
  requested = requested.slice(0, maximum);
  const count = Math.max(minimum, requested.length || minimum);
  while (requested.length < count) requested.push({});
  const seenSegmentIds = new Set();
  const segments = requested.map((item, index) => {
    const fallbackStart = duration * index / count;
    const fallbackEnd = duration * (index + 1) / count;
    const range = sourceRange(item, fallbackStart, fallbackEnd, duration);
    const edited = isObject(item?.editedTime) ? item.editedTime : {};
    const editedStartRaw = Number(edited.start);
    const editedEndRaw = Number(edited.end);
    const editedStart = Number.isFinite(editedStartRaw) ? editedStartRaw : outputDuration * index / count;
    const editedEnd = Number.isFinite(editedEndRaw) ? editedEndRaw : outputDuration * (index + 1) / count;
    const gist = cleanText(item?.gist || item?.meaning || item?.summary || `第${index + 1}段核心信息`, 700);
    const title = cleanText(item?.upperLeftTitle || item?.title || `信息段 ${index + 1}`, 36);
    const keyLine = cleanText(item?.subtitleOrKeyLine || item?.keyLine || item?.subtitle || gist, 54);
    const summary = cleanText(item?.oneSentenceSummary || item?.summary || gist, 160);
    const requestedFacts = Object.prototype.hasOwnProperty.call(item || {}, "factCards") ? item.factCards : item?.facts;
    const facts = normalizeFactCards(requestedFacts, 38);
    const visual = isObject(item?.rightVisual) ? item.rightVisual : isObject(item?.visual) ? item.visual : {};
    const reference = isObject(item?.referencePackaging) ? item.referencePackaging : {};
    return {
      id: uniqueSegmentId(item?.id, index, seenSegmentIds),
      sourceTime: range,
      editedTime: {
        start: Number(Math.max(0, editedStart).toFixed(3)),
        end: Number(Math.max(editedStart + 0.35, Math.min(outputDuration, editedEnd)).toFixed(3)),
      },
      gist,
      upperLeftTitle: title,
      subtitleOrKeyLine: keyLine,
      oneSentenceSummary: summary,
      factCards: facts,
      rightVisual: {
        type: cleanText(visual.type || "二维信息动效", 80),
        description: cleanText(visual.description || visual.idea || `把“${title}”转成可视化证据或流程`, 600),
        data: array(visual.data || visual.points).map((entry) => cleanText(entry, 100)).filter(Boolean).slice(0, 6),
        motionOrder: array(visual.motionOrder).map((entry) => cleanText(entry, 180)).filter(Boolean).slice(0, 8),
      },
      referencePackaging: {
        pattern: cleanText(reference.pattern || item?.referencePattern || "标题→摘要→事实卡→右侧证据", 300),
        reason: cleanText(reference.reason || "该包装方式符合本段的信息层级与口播节奏", 400),
      },
    };
  }).sort((a, b) => a.editedTime.start - b.editedTime.start);
  return {
    schemaVersion: 2,
    summary: cleanText(value.summary || `口播被拆为 ${segments.length} 个信息段；字幕和信息卡分轨。`, 1000),
    subtitlePolicy: "字幕呈现说了什么；信息卡提炼这段真正想表达什么。",
    segments,
    generatedAt: new Date().toISOString(),
  };
}

function evenlySpaced(items, count) {
  if (items.length <= count) return items;
  const result = [];
  for (let index = 0; index < count; index++) result.push(items[Math.round(index * (items.length - 1) / Math.max(1, count - 1))]);
  return unique(result);
}

const KEYFRAME_PRIMARY_VISUAL_KINDS = new Set(["inherit", "hook-contrast", "memo-action", "copy-prompt"]);
export const DIRECTOR_SCENE_LAYOUT_MODES = [
  "speaker-focus",
  "split-right",
  "graphic-focus",
  "evidence-focus",
];
const DIRECTOR_SCENE_LAYOUT_MODE_SET = new Set(DIRECTOR_SCENE_LAYOUT_MODES);

function normalizeSceneLayoutMode(value, fallback = "split-right") {
  const requested = cleanText(value, 40);
  return DIRECTOR_SCENE_LAYOUT_MODE_SET.has(requested) ? requested : fallback;
}

function normalizeSceneLayoutSelection(value, fallback = "split-right") {
  const requestedMode = cleanText(value, 40) || null;
  const mode = normalizeSceneLayoutMode(requestedMode, fallback);
  return {
    requestedMode,
    mode,
    fallbackReason: requestedMode && requestedMode !== mode ? "unsupported-layout-mode" : null,
  };
}

function inferKeyframePrimaryVisualKind(frame, segment) {
  const text = `${frame?.composition || ""} ${segment?.rightVisual?.type || ""} ${segment?.rightVisual?.description || ""}`;
  if (/(备忘录|便签|记录动作|笔记)/.test(text)) return "memo-action";
  if (/(可复制|复制.*指令|指令卡|提示词)/.test(text)) return "copy-prompt";
  if (/(工具.*第一步|第一步.*工具|工具.*行动|行动.*工具)/.test(text)) return "hook-contrast";
  return "inherit";
}

function normalizeKeyframeFactCards(value) {
  return normalizeFactCards(value, 48);
}

function normalizeKeyframeVisualIntent(raw, segment, frame = {}) {
  const value = isObject(raw) ? raw : {};
  const primaryRaw = isObject(value.primaryVisual) ? value.primaryVisual : {};
  const inferredKind = inferKeyframePrimaryVisualKind(frame, segment);
  const requestedKind = cleanText(primaryRaw.kind, 40);
  const kind = KEYFRAME_PRIMARY_VISUAL_KINDS.has(requestedKind) ? requestedKind : inferredKind;
  let lines = array(primaryRaw.lines).map((line) => cleanText(line, 140)).filter(Boolean).slice(0, 6);
  if (!lines.length && kind !== "inherit") lines = array(segment?.rightVisual?.data).map((line) => cleanText(line, 140)).filter(Boolean).slice(0, 6);
  if (!lines.length && kind === "hook-contrast") {
    lines = [segment?.factCards?.[0]?.value, segment?.factCards?.[2]?.value].map((line) => cleanText(line, 140)).filter(Boolean);
  }
  const hasFactCards = Object.prototype.hasOwnProperty.call(value, "factCards");
  const optionalText = (key, limit) => Object.prototype.hasOwnProperty.call(value, key) && value[key] !== null ? cleanText(value[key], limit) : null;
  return {
    title: optionalText("title", 72),
    keyLine: optionalText("keyLine", 90),
    summary: optionalText("summary", 220),
    factCards: hasFactCards && value.factCards !== null ? normalizeKeyframeFactCards(value.factCards) : null,
    primaryVisual: {
      kind,
      lines,
      text: cleanText(primaryRaw.text || (kind === "copy-prompt" ? lines.join("，") : ""), 300),
      highlights: array(primaryRaw.highlights).map((item) => cleanText(item, 80)).filter(Boolean).slice(0, 5),
    },
  };
}

export function normalizeKeyframeDirection(raw, breakdown, count = 4) {
  const value = isObject(raw) ? raw : {};
  const target = Math.max(3, Math.min(5, Math.round(Number(count || 4))));
  const byId = new Map(array(breakdown?.segments).map((segment) => [segment.id, segment]));
  const selectedIds = array(value.selectedSegmentIds || value.segmentIds).map((id) => cleanText(id, 20)).filter((id) => byId.has(id));
  const selected = selectedIds.length ? selectedIds.map((id) => byId.get(id)) : evenlySpaced(array(breakdown?.segments), target);
  const framesRaw = array(value.frames);
  const frames = selected.slice(0, target).map((segment, index) => {
    const supplied = framesRaw.find((frame) => frame?.segmentId === segment.id) || framesRaw[index] || {};
    const sourceTime = clampNumber(supplied.sourceTime, (segment.sourceTime.start + segment.sourceTime.end) / 2, segment.sourceTime.start, segment.sourceTime.end);
    return {
      id: `KF${String(index + 1).padStart(2, "0")}`,
      segmentId: segment.id,
      sourceTime: Number(sourceTime.toFixed(3)),
      purpose: cleanText(supplied.purpose || ["验证开场钩子", "验证核心方法", "验证结果证据", "验证结尾互动"][index] || "验证信息层级", 300),
      composition: cleanText(supplied.composition || "左侧标题、摘要与事实卡；右侧真人；视觉证据在人物旁展开。", 500),
      motionBefore: cleanText(supplied.motionBefore || "主标题先出现，人物保持右侧主卡。", 300),
      motionAfter: cleanText(supplied.motionAfter || "事实卡依次弹出，右侧二维视觉展开。", 300),
      validationFocus: cleanText(supplied.validationFocus || "检查标题清晰度、信息层级、颜色统一和脸部中轴安全。", 400),
      visualIntent: normalizeKeyframeVisualIntent(supplied.visualIntent, segment, supplied),
    };
  });
  const presentation = isObject(value.presentation) ? value.presentation : {};
  return {
    schemaVersion: 1,
    rationale: cleanText(value.rationale || "覆盖开场、方法、证据和结尾四类关键视觉状态。", 800),
    presentation: {
      showInternalLabels: presentation.showInternalLabels === true,
      showSafeGuides: presentation.showSafeGuides === true,
    },
    frames,
    revisionSummary: cleanText(value.revisionSummary, 800),
    generatedAt: new Date().toISOString(),
  };
}

const CHOREOGRAPHY_TARGETS = new Set([
  "title",
  "key-line",
  "summary",
  "facts",
  "fact-1",
  "fact-2",
  "fact-3",
  "visual",
  "speaker",
]);

const CHOREOGRAPHY_ACTIONS = new Set([
  "fade",
  "fade-up",
  "slide-left",
  "slide-right",
  "pop",
  "push-in",
  "reveal-right",
]);

function inferChoreographyTarget(element) {
  const text = cleanText(element, 120);
  const factNumber = text.match(/(?:事实卡|信息卡|卡片)\s*([123一二三])/)
    || text.match(/第\s*([123一二三])\s*张(?:事实卡|信息卡|卡片)?/);
  if (factNumber) {
    const index = { "一": 1, "二": 2, "三": 3 }[factNumber[1]] || Number(factNumber[1]);
    return `fact-${index}`;
  }
  if (/(全部|整组|依次|逐张).*(事实卡|信息卡|卡片)|(事实卡|信息卡|卡片).*(全部|整组|依次|逐张)/.test(text)) return "facts";
  if (/(副标题|关键句|副句|黄字)/.test(text)) return "key-line";
  if (/(摘要|结论条|摘要条|核心结论)/.test(text)) return "summary";
  if (/(主标题|大标题|标题)/.test(text)) return "title";
  if (/(人物|真人|镜头|人像|推近|回拉|景别)/.test(text)) return "speaker";
  if (/(主视觉|二维|动效|证据|窗口|备忘录|提示词|对比|流程|图表|右侧|视觉元素)/.test(text)) return "visual";
  return null;
}

function normalizeChoreographyTarget(target, element) {
  const requested = cleanText(target, 40);
  const aliases = {
    "primary-visual": "visual",
    "fact-card": "facts",
    "fact-cards": "facts",
  };
  const canonical = aliases[requested] || requested;
  return CHOREOGRAPHY_TARGETS.has(canonical) ? canonical : inferChoreographyTarget(element);
}

function normalizeChoreographyAction(actionPreset, action, target) {
  const requested = cleanText(actionPreset, 40);
  if (CHOREOGRAPHY_ACTIONS.has(requested)) return requested;
  const text = cleanText(action, 240);
  if (/弹出/.test(text)) return "pop";
  if (/推近|放大/.test(text)) return "push-in";
  if (/右.*(?:滑入|进入)|从右/.test(text)) return "slide-right";
  if (/左.*(?:滑入|进入)|从左/.test(text)) return "slide-left";
  if (/展开|右侧/.test(text)) return "reveal-right";
  if (/上.*(?:淡入|进入)|向上/.test(text)) return "fade-up";
  if (/淡入|出现/.test(text)) return "fade";
  if (target === "visual") return "reveal-right";
  if (target === "summary") return "slide-left";
  if (target?.startsWith("fact") || target === "facts") return "pop";
  return "fade-up";
}

function safeChoreographyEase(value, fallback = "power3.out") {
  const ease = cleanText(value, 40);
  if (/^(?:power[1-4]|sine|circ|expo)\.(?:in|out|inOut)$/.test(ease) || ease === "none") return ease;
  const back = ease.match(/^back\.out\((\d+(?:\.\d+)?)\)$/);
  if (back && Number(back[1]) >= 1 && Number(back[1]) <= 2) return ease;
  return fallback;
}

function choreographyEntranceVars(target, actionPreset, easing, distanceScale = 1) {
  const vars = {
    opacity: 0,
    duration: target === "visual" ? 0.66 : target.startsWith("fact") || target === "facts" ? 0.5 : target === "title" ? 0.62 : 0.48,
    ease: safeChoreographyEase(easing, target === "title" || target === "visual" ? "power4.out" : "power3.out"),
  };
  if (actionPreset === "slide-left") vars.x = -60 * distanceScale;
  if (actionPreset === "slide-right") vars.x = 60 * distanceScale;
  if (actionPreset === "reveal-right") vars.x = 60 * distanceScale;
  if (actionPreset === "fade-up") {
    vars.y = 30 * distanceScale;
    vars.scale = 0.97;
  }
  if (actionPreset === "pop") {
    vars.y = 28 * distanceScale;
    vars.scale = 0.88;
  }
  if (actionPreset === "push-in") vars.scale = 0.9;
  if (actionPreset === "reveal-right") vars.scale = 0.94;
  return vars;
}

function choreographyCompletionSeconds(target, actionPreset, easing) {
  const entrance = choreographyEntranceVars(target, actionPreset, easing).duration;
  if (target === "title") return Math.max(entrance, 0.96);
  if (target === "visual") return Math.max(entrance, 1.5);
  return entrance;
}

export function normalizeMotionDirection(raw, breakdown, options = {}) {
  const value = isObject(raw) ? raw : {};
  const outputDuration = Math.max(1, Number(options.outputDuration || 1));
  const duration = clampNumber(value.sampleDuration || value.durationSeconds || options.durationSeconds, 20, 15, 25);
  let start = Number(value.sampleStart);
  if (!Number.isFinite(start)) {
    const strongestId = cleanText(value.strongestSegmentId, 20);
    const strongest = array(breakdown?.segments).find((segment) => segment.id === strongestId);
    start = options.sampleAnchor === "strongest-segment" && strongest ? strongest.editedTime.start : 0;
  }
  start = Math.max(0, Math.min(Math.max(0, outputDuration - duration), start));
  const end = Math.min(outputDuration, start + duration);
  const titleAt = clampNumber(options.titleLeadSeconds, 0.15, 0, end - start);
  const summaryAt = clampNumber(options.summaryDelaySeconds, 0.85, 0, end - start);
  const factStagger = clampNumber(options.factStaggerSeconds, 0.32, 0.08, 1.2);
  const firstFactAt = Math.min(end - start, Math.max(summaryAt + 0.6, 1.7));
  const choreography = array(value.choreography).map((item, index) => {
    let target = normalizeChoreographyTarget(item?.target, item?.element);
    const factIndex = Math.round(clampNumber(item?.factIndex, 0, 0, 3));
    if (target === "facts" && factIndex >= 1 && factIndex <= 3) target = `fact-${factIndex}`;
    const actionPreset = normalizeChoreographyAction(item?.actionPreset, item?.action, target);
    return {
      order: Math.max(1, Math.round(clampNumber(item?.order, index + 1, 1, 99))),
      at: clampNumber(item?.at, [0.15, 0.85, 1.7, 2.05, 2.4, 4.2][index] || index * 0.5, 0, end - start),
      segmentId: cleanText(item?.segmentId, 20) || null,
      target,
      factIndex: target?.startsWith("fact-") ? Number(target.slice(-1)) : null,
      element: cleanText(item?.element || "视觉元素", 120),
      action: cleanText(item?.action || "淡入", 240),
      actionPreset,
      easing: safeChoreographyEase(item?.easing || "power3.out"),
      purpose: cleanText(item?.purpose || "服务当前口播信息层级", 300),
    };
  }).filter((item) => item.target).sort((left, right) => left.order - right.order || left.at - right.at).slice(0, 14);
  const fallbackChoreography = [
    { order: 1, at: titleAt, target: "title", element: "主标题", action: "从左上淡入并轻微推近", actionPreset: "fade-up", easing: "power4.out", purpose: "先建立本段主题" },
    { order: 2, at: summaryAt, target: "summary", element: "摘要条", action: "从左侧滑入", actionPreset: "slide-left", easing: "power3.out", purpose: "给出本段真正结论" },
    { order: 3, at: firstFactAt, target: "fact-1", element: "事实卡1", action: "淡入并落稳", actionPreset: "pop", easing: "power3.out", purpose: "建立第一层事实" },
    { order: 4, at: Math.min(end - start, firstFactAt + factStagger), target: "fact-2", element: "事实卡2", action: "淡入并落稳", actionPreset: "pop", easing: "power3.out", purpose: "补充方法或对照" },
    { order: 5, at: Math.min(end - start, firstFactAt + factStagger * 2), target: "fact-3", element: "事实卡3", action: "淡入并落稳", actionPreset: "pop", easing: "power3.out", purpose: "落到结果或边界" },
    { order: 6, at: Math.min(end - start, Math.max(4.2, firstFactAt + factStagger * 3 + 0.5)), target: "visual", element: "右侧二维动效", action: "展开并带一次轻推拉", actionPreset: "reveal-right", easing: "power3.inOut", purpose: "把抽象信息变成可见证据" },
  ];
  const segments = array(breakdown?.segments);
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const sampleSegments = segments.filter((segment) => Number(segment.editedTime?.end) > start && Number(segment.editedTime?.start) < end);
  const approvedFactCountBySegment = new Map(array(options.keyframeDirection?.frames).map((frame) => {
    const segment = segmentById.get(frame?.segmentId);
    const intent = segment ? normalizeKeyframeVisualIntent(frame?.visualIntent, segment, frame || {}) : null;
    const count = intent?.factCards === null ? array(segment?.factCards).length : array(intent?.factCards).length;
    return [frame?.segmentId, count];
  }));
  const actualFactCount = (segmentId) => approvedFactCountBySegment.has(segmentId)
    ? approvedFactCountBySegment.get(segmentId)
    : array(segmentById.get(segmentId)?.factCards).length;
  const requestedStrongest = segmentById.get(cleanText(value.strongestSegmentId, 20));
  const strongest = requestedStrongest && sampleSegments.includes(requestedStrongest)
    ? requestedStrongest
    : sampleSegments[0] || null;
  const suppliedLayouts = new Map(array(value.segmentLayouts).map((item) => [cleanText(item?.segmentId, 20), item]));
  const segmentLayouts = sampleSegments.map((segment) => {
    const supplied = suppliedLayouts.get(segment.id) || {};
    const selection = normalizeSceneLayoutSelection(supplied.mode || supplied.layoutMode);
    return {
      segmentId: segment.id,
      requestedMode: selection.requestedMode,
      mode: selection.mode,
      reason: cleanText(
        supplied.reason || (selection.fallbackReason
          ? "布局模式不在安全白名单内，保持兼容的左右分屏"
          : selection.requestedMode
            ? "按本段内容决定人物、图形和证据的主次"
            : "未提供逐段布局选择，保持兼容的左右分屏"),
        300,
      ),
      fallbackReason: selection.fallbackReason,
    };
  });
  const bindSegment = (item) => {
    if (item.target === "speaker") {
      const latest = Math.max(0, end - start - choreographyCompletionSeconds(item.target, item.actionPreset, item.easing));
      const at = Number(Math.min(latest, Math.max(0, item.at)).toFixed(3));
      return {
        ...item,
        segmentId: null,
        at,
        actionPreset: at > 0.35 && item.actionPreset === "fade" ? "push-in" : item.actionPreset,
      };
    }
    const requested = segmentById.get(item.segmentId);
    const sampleRelativeAt = Math.min(Math.max(0, end - start - 0.001), Math.max(0, Number(item.at || 0)));
    const absoluteAt = start + sampleRelativeAt;
    const segment = requested && Number(requested.editedTime?.end) > start && Number(requested.editedTime?.start) < end
      ? requested
      : sampleSegments.find((candidate) => absoluteAt >= Number(candidate.editedTime?.start) && absoluteAt < Number(candidate.editedTime?.end)) || strongest;
    if (!segment) return { ...item, segmentId: null };
    const sceneStart = Math.max(start, Number(segment.editedTime?.start)) - start;
    const sceneEnd = Math.min(end, Number(segment.editedTime?.end)) - start;
    const completion = choreographyCompletionSeconds(item.target, item.actionPreset, item.easing);
    const latest = Math.max(sceneStart, sceneEnd - Math.min(completion, Math.max(0.12, sceneEnd - sceneStart)));
    return {
      ...item,
      segmentId: segment.id,
      at: Number(Math.min(latest, Math.max(sceneStart, sampleRelativeAt)).toFixed(3)),
    };
  };
  const usingFallbackChoreography = choreography.length === 0;
  const boundCandidates = (usingFallbackChoreography ? fallbackChoreography : choreography)
    .map(bindSegment)
    .filter((item) => !usingFallbackChoreography
      || !/^fact-[123]$/.test(item.target || "")
      || Number(item.target.slice(-1)) <= actualFactCount(item.segmentId));
  const segmentsWithSpecificFacts = new Set(boundCandidates
    .filter((item) => /^fact-[123]$/.test(item.target || ""))
    .map((item) => item.segmentId)
    .filter(Boolean));
  const seenTargets = new Set();
  const boundChoreography = [];
  for (const item of boundCandidates) {
    if (item.target === "facts" && segmentsWithSpecificFacts.has(item.segmentId)) continue;
    const key = item.target === "speaker" ? "speaker" : `${item.segmentId || "missing"}:${item.target}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    boundChoreography.push({ ...item, order: boundChoreography.length + 1 });
  }
  return {
    schemaVersion: 1,
    sampleStart: Number(start.toFixed(3)),
    sampleEnd: Number(end.toFixed(3)),
    durationSeconds: Number((end - start).toFixed(3)),
    strongestSegmentId: strongest?.id || null,
    rhythm: cleanText(value.rhythm || "标题先行，摘要滑入，事实卡依次弹出，最后展开证据或二维动效。", 800),
    timing: {
      titleLeadSeconds: Number(titleAt.toFixed(3)),
      summaryDelaySeconds: Number(summaryAt.toFixed(3)),
      factStaggerSeconds: Number(factStagger.toFixed(3)),
    },
    segmentLayouts,
    choreography: boundChoreography,
    generatedAt: new Date().toISOString(),
  };
}

export function normalizeFullDirection(raw, breakdown) {
  const value = isObject(raw) ? raw : {};
  const supplied = new Map(array(value.segmentMotion).map((item) => [item?.segmentId, item]));
  return {
    schemaVersion: 1,
    globalRules: array(value.globalRules).map((item) => cleanText(item, 400)).filter(Boolean).slice(0, 16),
    segmentMotion: array(breakdown?.segments).map((segment, index) => {
      const item = supplied.get(segment.id) || {};
      const layoutSelection = normalizeSceneLayoutSelection(item.layoutMode || item.mode);
      return {
        segmentId: segment.id,
        requestedLayoutMode: layoutSelection.requestedMode,
        layoutMode: layoutSelection.mode,
        layoutFallbackReason: layoutSelection.fallbackReason,
        visualMode: cleanText(item.visualMode || segment.rightVisual?.type || "二维信息动效", 120),
        titleAt: clampNumber(item.titleAt, 0.08, 0, 3),
        summaryAt: clampNumber(item.summaryAt, 0.85, 0.2, 4),
        factsAt: Array.isArray(item.factsAt)
          ? item.factsAt.slice(0, 3).map((time, factIndex) => clampNumber(time, 1.65 + factIndex * 0.32, 0.4, 6))
          : [1.65, 1.97, 2.29],
        visualAt: clampNumber(item.visualAt, Math.min(4.2, Math.max(2.7, (segment.editedTime.end - segment.editedTime.start) * 0.42)), 1.5, 10),
        transition: cleanText(item.transition || (index % 2 ? "轻推入" : "淡入＋缩放"), 120),
        reason: cleanText(item.reason || "按本段信息结构安排，不机械重复上一段。", 400),
      };
    }),
    qaExpectations: unique(array(value.qaExpectations).map((item) => cleanText(item, 300))).slice(0, 20),
    generatedAt: new Date().toISOString(),
  };
}

export function lockedKeyframeVisualWindows(breakdown, keyframeDirection) {
  const byId = new Map(array(breakdown?.segments).map((segment) => [segment.id, segment]));
  return array(keyframeDirection?.frames).flatMap((frame) => {
    const segment = byId.get(frame?.segmentId);
    if (!segment) return [];
    const intent = normalizeKeyframeVisualIntent(frame?.visualIntent, segment, frame || {});
    if (intent.primaryVisual.kind === "inherit") return [];
    const start = Number(segment.editedTime?.start);
    const end = Number(segment.editedTime?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    return [{ segmentId: segment.id, kind: intent.primaryVisual.kind, start, end }];
  });
}

export function findLockedVisualIntentConflict(asset, breakdown, keyframeDirection) {
  const start = Number(asset?.placement?.start);
  const end = Number(asset?.placement?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return lockedKeyframeVisualWindows(breakdown, keyframeDirection)
    .find((window) => end > window.start && start < window.end) || null;
}

function html(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function cssColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : fallback;
}

function visualKind(segment) {
  const text = `${segment?.rightVisual?.type || ""} ${segment?.rightVisual?.description || ""}`;
  if (/(对比|前后|双播放器|擦除)/.test(text)) return "comparison";
  if (/(流程|节点|路径|角色|工作流)/.test(text)) return "workflow";
  if (/(提示词|输入|命令|对话|返修)/.test(text)) return "prompt";
  if (/(审核|检查|扫描|QA|门禁)/i.test(text)) return "qa";
  if (/(图表|柱|折线|数据|数字|比例)/.test(text)) return "chart";
  return "cards";
}

function visualMarkup(segment) {
  const kind = visualKind(segment);
  const facts = array(segment.factCards);
  if (!facts.length && kind !== "prompt") return "";
  if (kind === "comparison") {
    if (facts.length < 2) return `<div class="visual-cards">${facts.map((fact, index) => `<article class="v-step"><span>0${index + 1}</span><b>${html(fact.label)}</b><small>${html(fact.value)}</small></article>`).join("")}</div>`;
    const before = facts[0];
    const after = facts.at(-1);
    return `<div class="compare"><article class="v-step"><small>${html(before.label)}</small><b>${html(before.value)}</b><i></i></article><em class="v-step">→</em><article class="after v-step"><small>${html(after.label)}</small><b>${html(after.value)}</b><i></i></article></div><div class="scan v-step"></div>`;
  }
  if (kind === "workflow") return `<div class="flow">${segment.factCards.map((fact, index) => `<article class="v-step"><span>0${index + 1}</span><b>${html(fact.label)}</b><small>${html(fact.value)}</small></article>${index < segment.factCards.length - 1 ? `<i class="v-step">→</i>` : ""}`).join("")}</div>`;
  if (kind === "prompt") return `<div class="browser v-step"><div class="browser-bar"><i></i><i></i><i></i><span>输入内容</span></div><p>${html(segment.oneSentenceSummary)}</p>${segment.factCards.map((fact) => `<div class="prompt-line v-step"><b>${html(fact.label)}</b><span>${html(fact.value)}</span></div>`).join("")}</div>`;
  if (kind === "qa") return `<div class="qa-board v-step"><div class="qa-scan"></div>${segment.factCards.map((fact, index) => `<div class="qa-row v-step"><span>0${index + 1}</span><b>${html(fact.label)}</b><small>${html(fact.value)}</small><i>✓</i></div>`).join("")}</div>`;
  if (kind === "chart") return `<div class="chart v-step">${segment.factCards.map((fact, index) => `<article><i style="--height:${46 + index * 18}%"></i><b>${html(fact.label)}</b><small>${html(fact.value)}</small></article>`).join("")}</div>`;
  return `<div class="visual-cards">${segment.factCards.map((fact, index) => `<article class="v-step"><span>0${index + 1}</span><b>${html(fact.label)}</b><small>${html(fact.value)}</small></article>`).join("")}</div>`;
}

function highlightedHtml(text, highlights = []) {
  let output = html(text);
  for (const highlight of unique(array(highlights).map((item) => cleanText(item, 80)))) {
    const escaped = html(highlight);
    if (escaped) output = output.split(escaped).join(`<mark>${escaped}</mark>`);
  }
  return output;
}

function resolveScenePresentation(segment, frame) {
  const intent = frame
    ? normalizeKeyframeVisualIntent(frame.visualIntent, segment, frame)
    : normalizeKeyframeVisualIntent({ primaryVisual: { kind: "inherit" } }, segment, null);
  const kind = intent.primaryVisual.kind;
  const inheritedFacts = array(segment?.factCards);
  const factCards = intent.factCards === null
    ? (["hook-contrast", "memo-action", "copy-prompt"].includes(kind) ? [] : inheritedFacts)
    : intent.factCards;
  return {
    title: intent.title === null ? cleanText(segment?.upperLeftTitle, 72) : intent.title,
    keyLine: intent.keyLine === null ? cleanText(segment?.subtitleOrKeyLine, 90) : intent.keyLine,
    summary: intent.summary === null ? cleanText(segment?.oneSentenceSummary, 220) : intent.summary,
    factCards,
    primaryVisual: intent.primaryVisual,
  };
}

function primaryVisualMarkup(presentation, segment) {
  const primary = presentation.primaryVisual || { kind: "inherit", lines: [], text: "", highlights: [] };
  if (primary.kind === "hook-contrast") {
    const action = primary.lines[1] || primary.lines.at(-1) || "迈出第一步";
    return `<div class="hook-contrast"><div class="tool-stack v-step"><span></span><span></span><span></span><b>AI 工具</b></div><em class="v-step">→</em><div class="first-step v-step"><small>现在只做</small><b>${html(action)}</b></div></div>`;
  }
  if (primary.kind === "memo-action") {
    const note = primary.lines[1] || primary.lines[0] || presentation.summary || "写下一件最想让 AI 解决的麻烦";
    const next = primary.lines[2] || "写完后告诉 AI";
    return `<div class="memo-card v-step"><header><i></i><b>备忘录</b><span>完成</span></header><div class="memo-note"><small>今天</small><p>${html(note)}</p><i class="memo-cursor"></i></div><footer><span>✓</span><b>${html(next)}</b></footer></div>`;
  }
  if (primary.kind === "copy-prompt") {
    const prompt = primary.text || primary.lines.join("，") || "别给计划，只给我一个30秒内能完成的动作。做完，再给下一步。";
    return `<div class="copy-prompt-card v-step"><header><span>可复制</span><i>⌘ C</i></header><blockquote>${highlightedHtml(prompt, primary.highlights)}</blockquote><footer>一次只推动一步</footer></div>`;
  }
  return visualMarkup({ ...segment, factCards: presentation.factCards });
}

async function linkOrCopy(source, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try { await fsp.link(source, target); }
  catch { await fsp.copyFile(source, target); }
}

function sceneWindow(segment, rangeStart, rangeEnd) {
  const start = Math.max(rangeStart, Number(segment.editedTime.start));
  const end = Math.min(rangeEnd, Number(segment.editedTime.end));
  if (end - start < 0.2) return null;
  return { start: start - rangeStart, end: end - rangeStart, duration: end - start };
}

function speakerPoseForLayout(mode, scale = 1) {
  if (mode === "speaker-focus") return { x: -470 * scale, y: 0, scale: 1.18 };
  if (mode === "graphic-focus") return { x: 0, y: 0, scale: 0.42 };
  if (mode === "evidence-focus") return { x: 0, y: 0, scale: 0.36 };
  return { x: 0, y: 0, scale: 1 };
}

function effectiveSceneLayoutMode(requestedMode, { hasEvidence = false, hasGraphic = false } = {}) {
  const requested = normalizeSceneLayoutMode(requestedMode);
  if (requested === "evidence-focus" && !hasEvidence) return hasGraphic ? "graphic-focus" : "speaker-focus";
  if (requested === "graphic-focus" && !hasGraphic && !hasEvidence) return "speaker-focus";
  return requested;
}

function gsapFromLine(selector, vars, at) {
  return `tl.from(${JSON.stringify(selector)},${JSON.stringify(vars)}, ${Number(at).toFixed(3)});`;
}

function gsapFromToLine(selector, fromVars, toVars, at) {
  return `tl.fromTo(${JSON.stringify(selector)},${JSON.stringify(fromVars)},${JSON.stringify(toVars)}, ${Number(at).toFixed(3)});`;
}

export async function buildHyperframesDirectorProject(options) {
  const {
    projectDir,
    sourceVideo,
    sourceAudio,
    breakdown,
    styleReport,
    mode = "full",
    renderSpec = {},
    rangeStart = 0,
    rangeEnd = null,
    keyframeDirection = null,
    motionDirection = null,
    fullDirection = null,
    captions = [],
    approvedAssets = [],
    promptSnapshot = {},
  } = options;
  await fsp.mkdir(projectDir, { recursive: true });
  const assetsDir = path.join(projectDir, "assets");
  await fsp.mkdir(assetsDir, { recursive: true });
  const width = Math.max(640, Number(renderSpec.width || 1920));
  const height = Math.max(360, Number(renderSpec.height || 1080));
  const fps = Number(renderSpec.fps || 30);
  const palette = styleReport?.palette || {};
  const sourceVideoTarget = path.join(assetsDir, "speaker.mp4");
  const sourceAudioTarget = path.join(assetsDir, "speaker.m4a");
  if (!fs.existsSync(sourceVideoTarget)) await linkOrCopy(sourceVideo, sourceVideoTarget);
  if (sourceAudio && fs.existsSync(sourceAudio) && !fs.existsSync(sourceAudioTarget)) await linkOrCopy(sourceAudio, sourceAudioTarget);
  const gsapSource = path.join(moduleDir, "hyperframes-overlay", "gsap.min.js");
  if (fs.existsSync(gsapSource) && !fs.existsSync(path.join(assetsDir, "gsap.min.js"))) await fsp.copyFile(gsapSource, path.join(assetsDir, "gsap.min.js"));

  const allSegments = array(breakdown?.segments);
  const segmentIds = allSegments.map((segment) => String(segment?.id || "").trim());
  if (!segmentIds.length || segmentIds.some((id) => !id) || new Set(segmentIds).size !== segmentIds.length) {
    throw new Error("内容拆解必须提供非空且唯一的 segmentId");
  }
  const keyframeBySegmentId = new Map(array(keyframeDirection?.frames).map((frame) => [frame.segmentId, frame]));
  const motionLayoutBySegmentId = new Map(array(motionDirection?.segmentLayouts).map((item) => [item?.segmentId, item]));
  const fullLayoutBySegmentId = new Map(array(fullDirection?.segmentMotion).map((item) => [item?.segmentId, item]));
  const keyframePresentation = isObject(keyframeDirection?.presentation) ? keyframeDirection.presentation : {};
  const showInternalLabels = keyframePresentation.showInternalLabels === true;
  const showSafeGuides = keyframePresentation.showSafeGuides === true;
  let duration;
  let scenes;
  let snapshotTimes = [];
  if (mode === "keyframes") {
    const frames = array(keyframeDirection?.frames);
    const slot = 2.4;
    duration = Math.max(slot, frames.length * slot);
    scenes = frames.map((frame, index) => {
      const segment = allSegments.find((item) => item.id === frame.segmentId) || allSegments[index] || allSegments[0];
      return { segment, frame, window: { start: index * slot, end: (index + 1) * slot, duration: slot }, mediaStart: Math.max(0, Number(frame.sourceTime || 0) - 1.55) };
    }).filter((item) => item.segment);
    snapshotTimes = scenes.map((item) => Number((item.window.start + 1.55).toFixed(3)));
  } else {
    const total = Math.max(0.1, ...allSegments.map((segment) => Number(segment.editedTime?.end || 0)));
    const end = rangeEnd === null ? total : Math.min(total, Number(rangeEnd));
    duration = Math.max(0.1, end - Number(rangeStart || 0));
    scenes = allSegments.map((segment) => ({ segment, frame: keyframeBySegmentId.get(segment.id) || null, window: sceneWindow(segment, rangeStart, end) })).filter((item) => item.window);
    snapshotTimes = scenes.slice(0, 5).map((item) => Number((item.window.start + Math.min(3.2, item.window.duration * 0.5)).toFixed(3)));
  }
  const seenDomSegmentIds = new Set();
  scenes = scenes.map((scene, index) => {
    const presentation = resolveScenePresentation(scene.segment, scene.frame);
    const motionLayout = motionLayoutBySegmentId.get(scene.segment.id) || null;
    const fullLayout = fullLayoutBySegmentId.get(scene.segment.id) || null;
    const directionLayout = mode === "sample" ? motionLayout : fullLayout;
    const rawRequestedLayout = mode === "sample"
      ? directionLayout?.requestedMode ?? directionLayout?.mode
      : directionLayout?.requestedLayoutMode ?? directionLayout?.layoutMode;
    const requestedLayoutMode = mode === "keyframes" ? "split-right" : normalizeSceneLayoutMode(rawRequestedLayout);
    const layoutSelectionFallback = mode === "keyframes"
      ? null
      : directionLayout?.fallbackReason || directionLayout?.layoutFallbackReason || (!rawRequestedLayout ? "direction-layout-missing" : null);
    return {
      ...scene,
      presentation,
      domId: `scene-${uniqueSegmentId(scene.segment.id, index, seenDomSegmentIds)}`,
      primaryMarkup: primaryVisualMarkup(presentation, scene.segment),
      layoutRequestedRaw: rawRequestedLayout || requestedLayoutMode,
      requestedLayoutMode,
      layoutReason: cleanText(
        mode === "keyframes"
          ? "关键帧审核保持静态左右构图"
          : mode === "sample" ? motionLayout?.reason : fullLayout?.reason,
        300,
      ),
      layoutSelectionFallback,
      contentLockedByKeyframe: Boolean(scene.frame),
      layoutLockedByKeyframe: mode === "keyframes",
    };
  });

  const sampleChoreography = mode === "sample" ? array(motionDirection?.choreography) : [];
  const appliedChoreography = [];
  const appliedChoreographyEvents = new Set();
  const appliedChoreographyKeys = new Set();
  const sampleBeatForScene = (scene, target, factIndex = null) => {
    if (mode !== "sample") return null;
    const exactTarget = target;
    const exact = sampleChoreography.find((item) => item?.segmentId === scene.segment.id && item?.target === exactTarget);
    const generic = factIndex === null ? null : sampleChoreography.find((item) => item?.segmentId === scene.segment.id && item?.target === "facts");
    const beat = exact || generic;
    if (!beat) return null;
    const genericOffset = exact ? 0 : factIndex * Number(motionDirection?.timing?.factStaggerSeconds || 0.32);
    const completion = choreographyCompletionSeconds(exactTarget, beat.actionPreset, beat.easing);
    const latest = Math.max(scene.window.start, scene.window.end - Math.min(completion, scene.window.duration));
    const at = Math.min(latest, Math.max(scene.window.start, Number(beat.at || 0) + genericOffset));
    return { beat, at: Number(at.toFixed(3)), target: exactTarget };
  };
  const markChoreographyApplied = (scene, resolved, selector) => {
    if (!resolved?.beat) return;
    const key = `${resolved.beat.order}|${resolved.target || resolved.beat.target}|${selector}`;
    if (appliedChoreographyKeys.has(key)) return;
    appliedChoreographyKeys.add(key);
    appliedChoreographyEvents.add(resolved.beat);
    appliedChoreography.push({
      order: resolved.beat.order,
      segmentId: scene?.segment?.id || null,
      target: resolved.target || resolved.beat.target,
      sourceTarget: resolved.beat.target,
      factIndex: resolved.target?.startsWith("fact-") ? Number(resolved.target.slice(-1)) : null,
      selector,
      at: Number(Number(resolved.at).toFixed(3)),
      actionPreset: resolved.beat.actionPreset,
      easing: safeChoreographyEase(resolved.beat.easing),
      purpose: resolved.beat.purpose,
    });
  };

  const copiedAssets = [];
  const skippedAssetConflicts = [];
  for (const asset of approvedAssets.filter((item) => item?.path && fs.existsSync(item.path) && item.placement)) {
    const conflict = findLockedVisualIntentConflict(asset, breakdown, keyframeDirection);
    if (conflict) {
      skippedAssetConflicts.push({ assetId: asset.id, ...conflict });
      continue;
    }
    const extension = path.extname(asset.path) || (asset.mediaKind === "video" ? ".mp4" : ".png");
    const fileName = `extra-${String(copiedAssets.length + 1).padStart(2, "0")}${extension}`;
    await linkOrCopy(asset.path, path.join(assetsDir, fileName));
    copiedAssets.push({ ...asset, projectFile: `assets/${fileName}` });
  }

  const motionById = new Map(array(fullDirection?.segmentMotion).map((item) => [item.segmentId, item]));
  const visualRevealAt = (scene) => {
    const { segment, window } = scene;
    const sampleVisual = sampleBeatForScene(scene, "visual");
    if (sampleVisual) return sampleVisual.at;
    const motion = motionById.get(segment.id) || {};
    return window.start + Math.min(
      Math.max(0, window.duration - (mode === "sample" ? 1.5 : 0.2)),
      Number(motion.visualAt ?? (mode === "keyframes" ? 0.66 : Math.min(4.2, Math.max(2.7, window.duration * 0.42)))),
    );
  };
  const evidenceEntries = mode === "keyframes" ? [] : copiedAssets.map((asset, index) => {
    const rawStart = Math.max(0, Number(asset.placement.start) - rangeStart);
    const end = Math.min(duration, Number(asset.placement.end) - rangeStart);
    const ownerScene = scenes
      .map((scene) => ({ scene, overlap: Math.max(0, Math.min(end, scene.window.end) - Math.max(rawStart, scene.window.start)) }))
      .sort((left, right) => right.overlap - left.overlap)[0];
    const matchedScene = ownerScene?.overlap > 0 ? ownerScene.scene : null;
    const revealAt = matchedScene ? visualRevealAt(matchedScene) : rawStart;
    const latestUsefulStart = Math.max(rawStart, end - 0.8);
    const start = Math.min(Math.max(rawStart, revealAt), latestUsefulStart);
    return { asset, index, rawStart, start, end, ownerScene: matchedScene };
  }).filter((entry) => entry.end - entry.start >= 0.2);
  const compositedAssetIds = evidenceEntries.map((entry) => entry.asset.id);
  for (const scene of scenes) {
    scene.hasEvidence = evidenceEntries.some((entry) => entry.ownerScene === scene);
    scene.effectiveLayoutMode = effectiveSceneLayoutMode(scene.requestedLayoutMode, {
      hasEvidence: scene.hasEvidence,
      hasGraphic: Boolean(scene.primaryMarkup),
    });
    scene.layoutFallback = scene.effectiveLayoutMode === scene.requestedLayoutMode ? null : {
      requested: scene.requestedLayoutMode,
      effective: scene.effectiveLayoutMode,
      reason: scene.requestedLayoutMode === "evidence-focus" ? "本段没有已批准证据素材" : "本段没有可渲染主视觉",
    };
    if (!scene.layoutFallback && scene.layoutSelectionFallback) {
      scene.layoutFallback = {
        requested: scene.requestedLayoutMode,
        effective: scene.effectiveLayoutMode,
        reason: scene.layoutSelectionFallback,
      };
    }
  }
  const sceneHtml = scenes.map(({ segment, presentation, window, domId, primaryMarkup, hasEvidence, effectiveLayoutMode }) => {
    const visualKindClass = ` primary-${presentation.primaryVisual.kind}`;
    const titleHtml = presentation.title ? `<h1>${html(presentation.title)}</h1><div class="title-rule"></div>` : "";
    const keyLineHtml = presentation.keyLine ? `<p>${html(presentation.keyLine)}</p>` : "";
    const summaryHtml = presentation.summary ? `<section class="summary"><i>↳</i><span>${html(presentation.summary)}</span><b></b></section>` : "";
    const factsHtml = presentation.factCards.length ? `<section class="facts">${presentation.factCards.map((fact, index) => `<article class="fact fact-${index + 1}"><span>0${index + 1}</span><small>${html(fact.label)}</small><b>${html(fact.value)}</b></article>`).join("")}</section>` : "";
    const visualHead = showInternalLabels ? `<div class="visual-head"><span>${html(segment.rightVisual.type)}</span><b>${html(segment.id)}</b></div>` : "";
    return `
    <section id="${html(domId)}" data-segment-id="${html(segment.id)}" data-layout-mode="${html(effectiveLayoutMode)}" class="scene clip layout-${html(effectiveLayoutMode)}${hasEvidence ? " has-evidence" : ""}${showInternalLabels ? " show-internal-labels" : " audience-facing"}${visualKindClass}" data-start="${window.start.toFixed(3)}" data-duration="${window.duration.toFixed(3)}" data-track-index="${10 + allSegments.indexOf(segment)}">
      ${showInternalLabels ? `<div class="scene-number">${html(segment.id)} / ${String(allSegments.length).padStart(2, "0")}</div><div class="eyebrow">AI VISUAL DIRECTOR · HYPERFRAMES</div>` : ""}
      <header class="title-block">
        ${titleHtml}
        ${keyLineHtml}
      </header>
      ${summaryHtml}
      ${showInternalLabels && presentation.factCards.length ? `<div class="information-label">CORE MESSAGE / 信息卡不是字幕</div>` : ""}
      ${factsHtml}
      ${hasEvidence || !primaryMarkup ? "" : `<section class="visual-panel${showInternalLabels ? "" : " audience-facing"}">${visualHead}<div class="visual-body">${primaryMarkup}</div></section>`}
    </section>`;
  }).join("");

  const speakerHtml = mode === "keyframes"
    ? scenes.map(({ mediaStart, window }, index) => `<video id="speaker-clip-${index + 1}" class="speaker-video speaker-clip clip" data-start="${window.start.toFixed(3)}" data-duration="${window.duration.toFixed(3)}" data-track-index="${2 + index}" data-media-start="${Number(mediaStart || 0).toFixed(3)}" src="assets/speaker.mp4" preload="auto" playsinline muted></video>`).join("")
    : `<video id="speakerVideo" class="speaker-video clip" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="2" data-media-start="${Number(rangeStart || 0).toFixed(3)}" src="assets/speaker.mp4" preload="auto" playsinline muted></video>`;
  const audioHtml = mode !== "keyframes" && sourceAudio && fs.existsSync(sourceAudio)
    ? `<audio id="speaker-audio" class="clip" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="0" data-media-start="${Number(rangeStart || 0).toFixed(3)}" data-volume="1" src="assets/speaker.m4a" preload="auto"></audio>` : "";

  const captionHtml = mode === "keyframes" ? "" : captions.filter((cue) => cue.end > rangeStart && cue.start < rangeStart + duration).map((cue, index) => {
    const start = Math.max(0, Number(cue.start) - rangeStart);
    const end = Math.min(duration, Number(cue.end) - rangeStart);
    return `<div class="caption clip" data-start="${start.toFixed(3)}" data-duration="${Math.max(0.1, end - start).toFixed(3)}" data-track-index="80" id="caption-${index + 1}">${html(cue.text)}</div>`;
  }).join("");

  const evidenceHtml = evidenceEntries.map(({ asset, index, rawStart, start, end, ownerScene }) => {
    const mediaStart = Number(asset.clipStart || 0) + Math.max(0, start - rawStart);
    const media = asset.mediaKind === "video"
      ? `<video id="evidence-media-${index + 1}" src="${html(asset.projectFile)}" class="evidence-media clip" data-start="${start.toFixed(3)}" data-duration="${(end - start).toFixed(3)}" data-track-index="${70 + index}" data-media-start="${mediaStart.toFixed(3)}" data-layout-allow-occlusion data-layout-allow-overlap muted playsinline preload="auto"></video>`
      : `<img src="${html(asset.projectFile)}" class="evidence-media" data-layout-allow-occlusion data-layout-allow-overlap alt="">`;
    const layoutMode = ownerScene?.effectiveLayoutMode || "split-right";
    return `<aside class="evidence layout-${html(layoutMode)}" id="evidence-${index + 1}" data-layout-mode="${html(layoutMode)}" data-layout-allow-overflow data-layout-allow-occlusion data-layout-allow-overlap>${media}${asset.attributionText ? `<small>${html(asset.attributionText)}</small>` : ""}</aside>`;
  }).join("");

  const scale = width / 1920;
  const animationLines = [];
  scenes.forEach((scene, sceneIndex) => {
    const { segment, presentation, window } = scene;
    const id = `#${scene.domId}`;
    const speakerPose = speakerPoseForLayout(scene.effectiveLayoutMode, scale);
    if (mode !== "keyframes" && sceneIndex > 0) {
      const layoutAt = Math.max(0.02, window.start + 0.02);
      animationLines.push(`tl.to("#speakerStage",${JSON.stringify({
        ...speakerPose,
        duration: 0.52,
        ease: "power3.inOut",
        overwrite: "auto",
      })},${layoutAt.toFixed(3)});`);
    }
    const hasVisualPanel = !scene.hasEvidence && Boolean(scene.primaryMarkup);
    const motion = motionById.get(segment.id) || {};
    const titleBeat = sampleBeatForScene(scene, "title");
    const keyLineBeat = sampleBeatForScene(scene, "key-line");
    const summaryBeat = sampleBeatForScene(scene, "summary");
    const visualBeat = sampleBeatForScene(scene, "visual");
    const titleAt = titleBeat?.at ?? window.start + Number(motion.titleAt ?? 0.08);
    const keyLineAt = keyLineBeat?.at ?? titleAt + 0.58;
    const summaryAt = summaryBeat?.at ?? window.start + Number(motion.summaryAt ?? (mode === "keyframes" ? 0.22 : 0.85));
    const configuredFactsAt = mode === "keyframes"
      ? [0.34, 0.44, 0.54]
      : Array.isArray(motion.factsAt) ? motion.factsAt.slice(0, 3) : [1.65, 1.97, 2.29];
    const factsAt = presentation.factCards.map((_, index) => clampNumber(
      configuredFactsAt[index],
      mode === "keyframes" ? 0.34 + index * 0.1 : 1.65 + index * 0.32,
      0,
      6,
    ));
    const resolvedFacts = presentation.factCards.map((_, index) => sampleBeatForScene(scene, `fact-${index + 1}`, index));
    const renderedFactStarts = resolvedFacts.map((resolved, index) => resolved?.at ?? window.start + Number(factsAt[index] ?? factsAt.at(-1) ?? 0));
    const visualAt = visualBeat?.at ?? visualRevealAt(scene);
    if (presentation.title && titleBeat) markChoreographyApplied(scene, titleBeat, `${id} h1`);
    if (presentation.keyLine && keyLineBeat) markChoreographyApplied(scene, keyLineBeat, `${id} .title-block p`);
    if (presentation.summary && summaryBeat) markChoreographyApplied(scene, summaryBeat, `${id} .summary`);
    resolvedFacts.forEach((resolved, index) => {
      if (resolved) markChoreographyApplied(scene, resolved, `${id} .fact-${index + 1}`);
    });
    if (hasVisualPanel && visualBeat) markChoreographyApplied(scene, visualBeat, `${id} .visual-panel`);
    const visualEntrance = visualBeat
      ? choreographyEntranceVars("visual", visualBeat.beat.actionPreset, visualBeat.beat.easing, scale)
      : { opacity: 0, x: 70 * scale, scale: 0.94, duration: 0.66, ease: "power4.out" };
    const visualMotion = hasVisualPanel ? `
      ${gsapFromLine(`${id} .visual-panel`, visualEntrance, visualAt)}
      tl.from("${id} .v-step", {opacity:0,y:20,scale:.95,duration:.42,stagger:.16,ease:"power3.out"}, ${(visualAt + 0.18).toFixed(3)});` : "";
    const internalMotion = showInternalLabels ? `tl.from("${id} .eyebrow", {opacity:0,x:-28,duration:.38}, ${titleAt.toFixed(3)});` : "";
    const titleEntrance = titleBeat
      ? choreographyEntranceVars("title", titleBeat.beat.actionPreset, titleBeat.beat.easing, scale)
      : { opacity: 0, y: 34 * scale, scale: 0.97, filter: "blur(8px)", duration: 0.62, ease: "power4.out" };
    const keyLineEntrance = keyLineBeat
      ? choreographyEntranceVars("key-line", keyLineBeat.beat.actionPreset, keyLineBeat.beat.easing, scale)
      : { opacity: 0, x: -20 * scale, duration: 0.38 };
    const summaryEntrance = summaryBeat
      ? choreographyEntranceVars("summary", summaryBeat.beat.actionPreset, summaryBeat.beat.easing, scale)
      : { opacity: 0, x: -90 * scale, duration: 0.58, ease: "power4.out" };
    const titleMotion = presentation.title ? `${gsapFromLine(`${id} h1`, titleEntrance, titleAt)}tl.from("${id} .title-rule", {scaleX:0,duration:.48,ease:"power3.out"}, ${(titleAt + 0.48).toFixed(3)});` : "";
    const keyLineMotion = presentation.keyLine ? gsapFromLine(`${id} .title-block p`, keyLineEntrance, keyLineAt) : "";
    const summaryMotion = presentation.summary ? `${gsapFromLine(`${id} .summary`, summaryEntrance, summaryAt)}tl.from("${id} .summary i", {opacity:0,scale:.3,rotate:-90,duration:.36,ease:"back.out(1.8)"}, ${(summaryAt + 0.12).toFixed(3)});` : "";
    const factsMotion = presentation.factCards.length ? `${showInternalLabels ? `tl.from("${id} .information-label", {opacity:0,x:-18,duration:.34}, ${Math.max(window.start, renderedFactStarts[0] - 0.22).toFixed(3)});` : ""}${presentation.factCards.map((_, index) => {
      const resolved = resolvedFacts[index];
      const entrance = resolved
        ? choreographyEntranceVars(`fact-${index + 1}`, resolved.beat.actionPreset, resolved.beat.easing, scale)
        : { opacity: 0, y: 38 * scale, scale: 0.86, duration: 0.5, ease: "back.out(1.65)" };
      return gsapFromLine(`${id} .fact-${index + 1}`, entrance, renderedFactStarts[index]);
    }).join("")}` : "";
    const exitMotion = mode === "sample" ? "" : `tl.to("${id}", {opacity:.04,duration:.34,ease:"power2.in"}, ${(window.end - 0.34).toFixed(3)});`;
    animationLines.push(`
      ${internalMotion}
      ${titleMotion}
      ${keyLineMotion}
      ${summaryMotion}
      ${factsMotion}
      ${visualMotion}
      ${exitMotion}`);
  });
  evidenceEntries.forEach(({ index, start, end, ownerScene }) => {
    const resolved = ownerScene ? sampleBeatForScene(ownerScene, "visual") : null;
    if (resolved) markChoreographyApplied(ownerScene, { ...resolved, at: start }, `#evidence-${index + 1}`);
    const entrance = resolved
      ? choreographyEntranceVars("visual", resolved.beat.actionPreset, resolved.beat.easing, scale)
      : { opacity: 0, scale: 0.94, x: 44 * scale, duration: 0.52, ease: "power3.out" };
    const sceneMode = ownerScene?.effectiveLayoutMode || "split-right";
    const scenePose = speakerPoseForLayout(sceneMode, scale);
    const evidencePose = sceneMode === "split-right" ? { ...scenePose, scale: 0.52 } : scenePose;
    animationLines.push(`${gsapFromLine(`#evidence-${index + 1}`, entrance, start)}tl.to("#speakerStage",${JSON.stringify({ ...evidencePose, duration: 0.52, ease: "power3.inOut", overwrite: "auto" })},${start.toFixed(3)});tl.to("#evidence-${index + 1}",{opacity:0,duration:.25},${Math.max(start, end - 0.25).toFixed(3)});tl.set("#evidence-${index + 1}",{opacity:0},${end.toFixed(3)});tl.to("#speakerStage",${JSON.stringify({ ...scenePose, duration: 0.32, ease: "power3.out", overwrite: "auto" })},${Math.max(start, end - 0.3).toFixed(3)});`);
  });
  const speakerBeatRaw = mode === "sample" ? sampleChoreography.find((item) => item?.target === "speaker") : null;
  const speakerBeat = speakerBeatRaw ? {
    beat: speakerBeatRaw,
    target: "speaker",
    at: Number(Math.min(Math.max(0, duration - choreographyCompletionSeconds("speaker", speakerBeatRaw.actionPreset, speakerBeatRaw.easing)), Math.max(0, Number(speakerBeatRaw.at || 0))).toFixed(3)),
  } : null;
  if (speakerBeat) markChoreographyApplied(null, speakerBeat, "#speakerStage");
  const firstSpeakerPose = speakerPoseForLayout(scenes[0]?.effectiveLayoutMode || "split-right", scale);
  const speakerPoseAt = (at) => speakerPoseForLayout(
    scenes.find((scene) => at >= scene.window.start && at < scene.window.end)?.effectiveLayoutMode
      || scenes.at(-1)?.effectiveLayoutMode
      || "split-right",
    scale,
  );
  const defaultSpeakerEntrance = { opacity: 0, x: 80 * scale, scale: 0.95, duration: 0.8, ease: "power4.out" };
  let speakerTimeline = firstSpeakerPose.x === 0 && firstSpeakerPose.y === 0 && firstSpeakerPose.scale === 1
    ? gsapFromLine("#speakerStage", defaultSpeakerEntrance, 0.18)
    : gsapFromToLine(
      "#speakerStage",
      { opacity: 0, x: firstSpeakerPose.x + 80 * scale, y: firstSpeakerPose.y, scale: Math.max(0.1, firstSpeakerPose.scale - 0.05) },
      { ...firstSpeakerPose, opacity: 1, duration: 0.8, ease: "power4.out" },
      0.18,
    );
  if (speakerBeat) {
    const customEntrance = choreographyEntranceVars("speaker", speakerBeat.beat.actionPreset, speakerBeat.beat.easing, scale);
    if (speakerBeat.at <= 0.35) {
      speakerTimeline = gsapFromLine("#speakerStage", customEntrance, speakerBeat.at);
    } else {
      const { duration: speakerDuration, ease: speakerEase, opacity: _ignoredOpacity, ...speakerPose } = customEntrance;
      if (!Object.keys(speakerPose).length) speakerPose.scale = 0.985;
      const targetPose = speakerPoseAt(speakerBeat.at);
      speakerTimeline += gsapFromToLine(
        "#speakerStage",
        speakerPose,
        { ...targetPose, duration: speakerDuration, ease: speakerEase, immediateRender: false },
        speakerBeat.at,
      );
    }
  }
  const unappliedChoreography = sampleChoreography.filter((item) => !appliedChoreographyEvents.has(item)).map((item) => {
    const scene = scenes.find((candidate) => candidate.segment.id === item?.segmentId);
    let reason = "missing-dom-target";
    if (!item?.target) reason = "unknown-target";
    else if (item.target !== "speaker" && !scene) reason = "segment-not-rendered";
    else if (item.target === "facts" && scene?.presentation?.factCards?.length) reason = "superseded-by-specific-target";
    return {
      order: item?.order ?? null,
      segmentId: item?.segmentId || null,
      target: item?.target || null,
      actionPreset: item?.actionPreset || null,
      easing: safeChoreographyEase(item?.easing),
      purpose: item?.purpose || "",
      reason,
    };
  });
  appliedChoreography.sort((left, right) => Number(left.order) - Number(right.order) || left.selector.localeCompare(right.selector));
  const speakerLabelCss = showInternalLabels ? `.speaker-stage:before{content:"REAL TALKING HEAD";position:absolute;z-index:4;left:${24 * scale}px;top:${22 * scale}px;padding:${9 * scale}px ${14 * scale}px;border-radius:${99 * scale}px;background:rgba(7,9,15,.8);color:var(--warning);font:700 ${14 * scale}px/1 monospace;letter-spacing:${1.4 * scale}px}` : "";
  const safeGuideCss = showSafeGuides ? `.speaker-safe{position:absolute;z-index:4;inset:${20 * scale}px;border:1px dashed rgba(85,214,255,.25);border-radius:${25 * scale}px;pointer-events:none}` : "";

  const documentHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=${width},height=${height}"><script src="assets/gsap.min.js"></script>
<style>
@font-face{font-family:"Microsoft YaHei";src:local("Microsoft YaHei");font-style:normal;font-weight:100 900;font-display:swap}
@font-face{font-family:"Microsoft YaHei UI";src:local("Microsoft YaHei UI");font-style:normal;font-weight:100 900;font-display:swap}
:root{--bg:${cssColor(palette.background, "#07090F")};--surface:${cssColor(palette.surface, "#111621")};--primary:${cssColor(palette.primary, "#FF6A3D")};--secondary:${cssColor(palette.secondary, "#55D6FF")};--warning:${cssColor(palette.warning, "#FFD166")};--text:${cssColor(palette.text, "#F7F9FC")};--muted:${cssColor(palette.muted, "#9FA9B8")};--u:${scale};}
*{box-sizing:border-box}html,body{width:${width}px;height:${height}px;margin:0;overflow:hidden;background:var(--bg);color:var(--text);font-family:"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif}body:before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 82% 42%,rgba(85,214,255,.13),transparent 34%),linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:auto,${64 * scale}px ${64 * scale}px,${64 * scale}px ${64 * scale}px}
#root{position:relative;width:100%;height:100%;overflow:hidden}.top-progress{position:absolute;z-index:90;left:${56 * scale}px;right:${56 * scale}px;top:${35 * scale}px;height:${5 * scale}px;background:rgba(255,255,255,.08);overflow:hidden}.top-progress i{display:block;width:100%;height:100%;background:linear-gradient(90deg,var(--primary),var(--secondary));transform-origin:left}
.scene{position:absolute;inset:0;padding:${70 * scale}px ${690 * scale}px ${120 * scale}px ${70 * scale}px}.scene-number{position:absolute;right:${72 * scale}px;top:${67 * scale}px;color:var(--secondary);font:700 ${18 * scale}px/1 monospace;letter-spacing:${2 * scale}px}.eyebrow{color:var(--secondary);font-size:${20 * scale}px;font-weight:800;letter-spacing:${2.5 * scale}px}.title-block{margin-top:${24 * scale}px;max-width:${780 * scale}px}.title-block h1{font-size:${62 * scale}px;line-height:1.13;margin:0;letter-spacing:-${2 * scale}px;max-width:${760 * scale}px}.title-rule{width:${170 * scale}px;height:${7 * scale}px;margin:${22 * scale}px 0 ${16 * scale}px;background:linear-gradient(90deg,var(--primary),var(--warning));transform-origin:left}.title-block p{margin:0;color:var(--warning);font-size:${27 * scale}px;font-weight:700}.summary{position:absolute;left:${70 * scale}px;top:${300 * scale}px;width:${760 * scale}px;min-height:${86 * scale}px;padding:${20 * scale}px ${28 * scale}px ${20 * scale}px ${64 * scale}px;background:linear-gradient(100deg,rgba(255,106,61,.18),rgba(17,22,33,.92));border-left:${6 * scale}px solid var(--primary);border-radius:0 ${18 * scale}px ${18 * scale}px 0;box-shadow:0 ${18 * scale}px ${48 * scale}px rgba(0,0,0,.2)}.summary i{position:absolute;left:${24 * scale}px;top:${22 * scale}px;color:var(--primary);font-size:${30 * scale}px}.summary span{font-size:${24 * scale}px;line-height:1.55}.summary b{position:absolute;left:0;bottom:0;height:${3 * scale}px;width:100%;background:linear-gradient(90deg,var(--primary),transparent)}.information-label{position:absolute;left:${70 * scale}px;top:${425 * scale}px;color:var(--muted);font:700 ${16 * scale}px/1 monospace;letter-spacing:${1.5 * scale}px}.facts{position:absolute;left:${70 * scale}px;top:${462 * scale}px;width:${760 * scale}px;display:grid;grid-template-columns:repeat(3,1fr);gap:${16 * scale}px}.fact{min-height:${165 * scale}px;padding:${20 * scale}px;background:linear-gradient(145deg,rgba(24,31,45,.98),rgba(10,14,22,.96));border:1px solid rgba(255,255,255,.12);border-radius:${18 * scale}px;box-shadow:0 ${16 * scale}px ${36 * scale}px rgba(0,0,0,.24)}.fact>span{color:var(--primary);font:800 ${19 * scale}px/1 monospace}.fact small{display:block;color:var(--muted);font-size:${17 * scale}px;margin:${18 * scale}px 0 ${10 * scale}px}.fact b{font-size:${22 * scale}px;line-height:1.32}.visual-panel{position:absolute;left:${70 * scale}px;top:${300 * scale}px;width:${785 * scale}px;height:${360 * scale}px;padding:${58 * scale}px ${28 * scale}px ${24 * scale}px;background:rgba(10,14,22,.96);border:${2 * scale}px solid rgba(85,214,255,.45);border-radius:${24 * scale}px;box-shadow:0 ${24 * scale}px ${70 * scale}px rgba(0,0,0,.38);z-index:12}.visual-head{position:absolute;left:${26 * scale}px;right:${26 * scale}px;top:${18 * scale}px;display:flex;justify-content:space-between;color:var(--secondary);font-size:${17 * scale}px;font-weight:800}.visual-body{height:100%}.compare{display:grid;grid-template-columns:1fr auto 1fr;gap:${20 * scale}px;align-items:center;height:100%}.compare article{height:80%;padding:${24 * scale}px;border-radius:${18 * scale}px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12)}.compare article.after{border-color:var(--secondary);background:rgba(85,214,255,.09)}.compare small,.compare b{display:block}.compare b{font-size:${26 * scale}px;margin-top:${30 * scale}px}.compare article i{display:block;height:${8 * scale}px;margin-top:${38 * scale}px;background:var(--primary)}.compare article.after i{background:var(--secondary)}.compare>em{font-size:${34 * scale}px;color:var(--warning)}.scan{position:absolute;left:${40 * scale}px;right:${40 * scale}px;top:${100 * scale}px;height:${3 * scale}px;background:var(--warning);box-shadow:0 0 ${22 * scale}px var(--warning)}.flow{display:flex;align-items:center;justify-content:space-between;height:100%}.flow article,.visual-cards article{width:30%;min-height:${190 * scale}px;padding:${22 * scale}px;border-radius:${18 * scale}px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12)}.flow article span,.visual-cards span{color:var(--secondary);font:800 ${18 * scale}px/1 monospace}.flow b,.visual-cards b{display:block;margin:${24 * scale}px 0 ${12 * scale}px;font-size:${25 * scale}px}.flow small,.visual-cards small{color:var(--muted);font-size:${17 * scale}px}.flow>i{color:var(--warning);font-size:${30 * scale}px}.browser{height:100%;padding:${62 * scale}px ${25 * scale}px ${20 * scale}px;border-radius:${16 * scale}px;background:#f1f3f6;color:#111827}.browser-bar{position:absolute;left:${28 * scale}px;right:${28 * scale}px;top:${18 * scale}px;height:${30 * scale}px}.browser-bar i{display:inline-block;width:${10 * scale}px;height:${10 * scale}px;border-radius:50%;background:var(--primary);margin-right:${6 * scale}px}.browser-bar span{float:right;font:700 ${14 * scale}px/1 monospace}.browser p{font-size:${18 * scale}px;margin:0 0 ${16 * scale}px}.prompt-line{display:flex;gap:${18 * scale}px;padding:${12 * scale}px ${16 * scale}px;margin-top:${10 * scale}px;background:#fff;border-left:${5 * scale}px solid var(--secondary)}.prompt-line b{min-width:${110 * scale}px}.qa-board{height:100%;position:relative}.qa-row{display:grid;grid-template-columns:${50 * scale}px ${120 * scale}px 1fr ${35 * scale}px;align-items:center;gap:${12 * scale}px;padding:${14 * scale}px ${18 * scale}px;margin-bottom:${12 * scale}px;border-radius:${14 * scale}px;background:rgba(255,255,255,.06)}.qa-row span{color:var(--secondary);font:700 ${17 * scale}px/1 monospace}.qa-row i{color:#5ee3a1;font-style:normal}.qa-scan{position:absolute;left:0;right:0;top:${30 * scale}px;height:${3 * scale}px;background:var(--warning);box-shadow:0 0 ${18 * scale}px var(--warning)}.chart{display:flex;align-items:flex-end;justify-content:space-around;height:100%;padding-top:${20 * scale}px}.chart article{width:28%;height:100%;display:flex;flex-direction:column;justify-content:flex-end;text-align:center}.chart article i{display:block;height:var(--height);background:linear-gradient(var(--secondary),rgba(85,214,255,.1));border-top:${5 * scale}px solid var(--warning);border-radius:${12 * scale}px ${12 * scale}px 0 0}.chart b{margin-top:${12 * scale}px}.chart small{color:var(--muted);margin-top:${6 * scale}px}.visual-cards{display:flex;align-items:center;justify-content:space-between;height:100%}
.speaker-stage{position:absolute;z-index:20;right:${70 * scale}px;top:${92 * scale}px;width:${560 * scale}px;height:${880 * scale}px;border:${3 * scale}px solid rgba(255,106,61,.72);border-radius:${34 * scale}px;overflow:hidden;background:#090d14;box-shadow:0 ${35 * scale}px ${90 * scale}px rgba(0,0,0,.46)}${speakerLabelCss}.speaker-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center}${safeGuideCss}.caption{position:absolute;z-index:100;left:50%;bottom:${38 * scale}px;transform:translateX(-50%);max-width:${1220 * scale}px;padding:${12 * scale}px ${26 * scale}px;color:#fff;background:rgba(5,8,13,.72);border-radius:${13 * scale}px;font-size:${31 * scale}px;font-weight:800;line-height:1.3;text-align:center;text-shadow:0 ${3 * scale}px ${8 * scale}px #000;border:1px solid rgba(255,255,255,.12)}.evidence{position:absolute;z-index:50;left:${65 * scale}px;top:${180 * scale}px;width:${1120 * scale}px;height:${700 * scale}px;padding:${14 * scale}px;border:${3 * scale}px solid var(--secondary);border-radius:${24 * scale}px;background:#080c12;box-shadow:0 ${32 * scale}px ${90 * scale}px rgba(0,0,0,.55);overflow:hidden}.evidence-media{width:100%;height:100%;object-fit:contain;background:#06090e}.evidence small{position:absolute;left:${24 * scale}px;bottom:${22 * scale}px;padding:${10 * scale}px ${15 * scale}px;background:rgba(0,0,0,.78);border-radius:${8 * scale}px;color:#fff;font-size:${17 * scale}px}
.speaker-stage{z-index:60;transform-origin:right bottom}.evidence{left:${860 * scale}px;top:${180 * scale}px;width:${990 * scale}px;height:${700 * scale}px}.visual-panel{left:${860 * scale}px;top:${300 * scale}px;width:${390 * scale}px;height:${360 * scale}px;padding:${54 * scale}px ${18 * scale}px ${18 * scale}px}.visual-head{left:${18 * scale}px;right:${18 * scale}px}.flow,.visual-cards{align-items:stretch;flex-direction:column;gap:${9 * scale}px}.flow article,.visual-cards article{width:100%;min-height:0;flex:1;padding:${12 * scale}px ${14 * scale}px}.flow article span,.visual-cards span{font-size:${14 * scale}px}.flow b,.visual-cards b{display:inline-block;margin:${8 * scale}px ${8 * scale}px 4px 0;font-size:${17 * scale}px}.flow small,.visual-cards small{font-size:${13 * scale}px}.flow>i{display:none}.browser{padding:${55 * scale}px ${15 * scale}px ${12 * scale}px}.browser p{font-size:${14 * scale}px}.prompt-line{gap:${8 * scale}px;padding:${7 * scale}px ${8 * scale}px}.prompt-line b{min-width:${70 * scale}px}.qa-row{grid-template-columns:${34 * scale}px ${70 * scale}px 1fr ${20 * scale}px;padding:${9 * scale}px}.chart b{font-size:${14 * scale}px}.chart small{font-size:${11 * scale}px}.compare{gap:${8 * scale}px}.compare article{padding:${12 * scale}px}.compare b{font-size:${17 * scale}px;margin-top:${18 * scale}px}
.scene.audience-facing .title-block{margin-top:${8 * scale}px}.scene.audience-facing.primary-hook-contrast .visual-panel,.scene.audience-facing.primary-memo-action .visual-panel,.scene.audience-facing.primary-copy-prompt .visual-panel{left:${70 * scale}px;top:${430 * scale}px;width:${1050 * scale}px;height:${430 * scale}px;padding:${24 * scale}px ${28 * scale}px}.visual-panel.audience-facing{padding-top:${24 * scale}px}.hook-contrast{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:${42 * scale}px;height:100%}.tool-stack{position:relative;height:${260 * scale}px}.tool-stack span{position:absolute;left:${40 * scale}px;width:${300 * scale}px;height:${150 * scale}px;border:1px solid rgba(255,255,255,.15);border-radius:${18 * scale}px;background:linear-gradient(145deg,rgba(255,255,255,.11),rgba(255,255,255,.04));box-shadow:0 ${16 * scale}px ${36 * scale}px rgba(0,0,0,.25)}.tool-stack span:nth-child(1){top:${78 * scale}px;transform:rotate(-8deg);opacity:.45}.tool-stack span:nth-child(2){top:${46 * scale}px;left:${78 * scale}px;transform:rotate(4deg);opacity:.7}.tool-stack span:nth-child(3){top:${18 * scale}px;left:${116 * scale}px;border-color:rgba(255,106,61,.65)}.tool-stack b{position:absolute;left:${175 * scale}px;top:${78 * scale}px;font-size:${30 * scale}px}.hook-contrast>em{color:var(--warning);font-size:${58 * scale}px;font-style:normal}.first-step{padding:${42 * scale}px;border:2px solid var(--secondary);border-radius:${24 * scale}px;background:rgba(85,214,255,.1);text-align:center}.first-step small{display:block;color:var(--muted);font-size:${20 * scale}px}.first-step b{display:block;margin-top:${18 * scale}px;color:var(--secondary);font-size:${42 * scale}px}.memo-card{height:100%;overflow:hidden;border-radius:${24 * scale}px;background:#f4f5f7;color:#172033;box-shadow:0 ${24 * scale}px ${60 * scale}px rgba(0,0,0,.35)}.memo-card header{height:${64 * scale}px;padding:0 ${26 * scale}px;display:flex;align-items:center;gap:${14 * scale}px;background:#e9ebef;border-bottom:1px solid #d6dae1}.memo-card header i{width:${18 * scale}px;height:${18 * scale}px;border-radius:50%;background:#ffd166}.memo-card header b{font-size:${22 * scale}px}.memo-card header span{margin-left:auto;color:#1f53c6;font-size:${18 * scale}px}.memo-note{position:relative;height:${228 * scale}px;padding:${32 * scale}px ${42 * scale}px}.memo-note small{color:#5b616c;font-size:${16 * scale}px}.memo-note p{max-width:${830 * scale}px;margin:${18 * scale}px 0 0;font-size:${34 * scale}px;line-height:1.45;font-weight:700}.memo-cursor{display:inline-block;width:${3 * scale}px;height:${38 * scale}px;margin-left:${8 * scale}px;background:#2563eb;vertical-align:middle}.memo-card footer{height:${86 * scale}px;padding:0 ${36 * scale}px;display:flex;align-items:center;gap:${18 * scale}px;background:#fff;border-top:1px solid #e2e5ea}.memo-card footer span{display:grid;place-items:center;width:${36 * scale}px;height:${36 * scale}px;border-radius:50%;background:#15803d;color:#fff;font-weight:900}.memo-card footer b{font-size:${22 * scale}px}.copy-prompt-card{height:100%;padding:${30 * scale}px ${38 * scale}px;border:2px solid rgba(85,214,255,.55);border-radius:${24 * scale}px;background:linear-gradient(145deg,rgba(11,18,30,.98),rgba(17,27,44,.96));box-shadow:0 ${24 * scale}px ${70 * scale}px rgba(0,0,0,.4)}.copy-prompt-card header{display:flex;justify-content:space-between;align-items:center}.copy-prompt-card header span{padding:${8 * scale}px ${15 * scale}px;border-radius:${99 * scale}px;background:rgba(85,214,255,.14);color:var(--secondary);font-size:${17 * scale}px;font-weight:800}.copy-prompt-card header i{color:var(--muted);font-style:normal;font-size:${16 * scale}px}.copy-prompt-card blockquote{margin:${34 * scale}px 0 ${24 * scale}px;font-size:${39 * scale}px;line-height:1.55;font-weight:800;letter-spacing:-${1 * scale}px}.copy-prompt-card mark{padding:0 ${4 * scale}px;background:transparent;color:var(--warning);box-shadow:inset 0 -${7 * scale}px rgba(255,106,61,.35)}.copy-prompt-card footer{color:var(--muted);font-size:${18 * scale}px}
.scene.layout-speaker-focus .title-block{position:absolute;left:${70 * scale}px;top:${70 * scale}px;margin:0;max-width:${590 * scale}px}.scene.layout-speaker-focus .title-block h1{font-size:${50 * scale}px;max-width:${590 * scale}px}.scene.layout-speaker-focus .title-block p{font-size:${23 * scale}px}.scene.layout-speaker-focus .summary{left:${70 * scale}px;top:${260 * scale}px;width:${560 * scale}px;min-height:${76 * scale}px;padding:${16 * scale}px ${22 * scale}px ${16 * scale}px ${56 * scale}px}.scene.layout-speaker-focus .summary span{font-size:${21 * scale}px}.scene.layout-speaker-focus .facts{left:${70 * scale}px;top:auto;bottom:${80 * scale}px;width:${620 * scale}px}.scene.layout-speaker-focus .fact{min-height:${112 * scale}px;padding:${14 * scale}px}.scene.layout-speaker-focus.audience-facing .visual-panel{left:${70 * scale}px;top:${420 * scale}px;width:${560 * scale}px;height:${330 * scale}px;padding:${22 * scale}px}.scene.layout-speaker-focus .copy-prompt-card blockquote{font-size:${25 * scale}px}.scene.layout-speaker-focus .memo-note p{font-size:${25 * scale}px}.evidence.layout-speaker-focus{left:${70 * scale}px;top:${470 * scale}px;width:${560 * scale}px;height:${350 * scale}px}
.scene.layout-graphic-focus .title-block{position:absolute;left:${70 * scale}px;top:${52 * scale}px;margin:0;max-width:${1440 * scale}px}.scene.layout-graphic-focus .title-block h1{font-size:${48 * scale}px;max-width:${1100 * scale}px}.scene.layout-graphic-focus .title-block p{font-size:${22 * scale}px}.scene.layout-graphic-focus .summary{left:${70 * scale}px;top:${190 * scale}px;width:${980 * scale}px;min-height:${70 * scale}px;padding:${14 * scale}px ${22 * scale}px ${14 * scale}px ${56 * scale}px}.scene.layout-graphic-focus .summary span{font-size:${21 * scale}px}.scene.layout-graphic-focus .facts{left:${1080 * scale}px;top:${177 * scale}px;width:${460 * scale}px;gap:${8 * scale}px}.scene.layout-graphic-focus .fact{min-height:${88 * scale}px;padding:${10 * scale}px}.scene.layout-graphic-focus .fact small{margin:${8 * scale}px 0 ${4 * scale}px;font-size:${13 * scale}px}.scene.layout-graphic-focus .fact b{font-size:${16 * scale}px}.scene.layout-graphic-focus.audience-facing .visual-panel{left:${70 * scale}px;top:${300 * scale}px;width:${1500 * scale}px;height:${620 * scale}px;padding:${36 * scale}px}.scene.layout-graphic-focus .flow,.scene.layout-graphic-focus .visual-cards{align-items:center;flex-direction:row;gap:${20 * scale}px}.scene.layout-graphic-focus .flow article,.scene.layout-graphic-focus .visual-cards article{width:30%;min-height:${190 * scale}px;padding:${22 * scale}px}.scene.layout-graphic-focus .flow article span,.scene.layout-graphic-focus .visual-cards span{font-size:${18 * scale}px}.scene.layout-graphic-focus .flow b,.scene.layout-graphic-focus .visual-cards b{display:block;margin:${24 * scale}px 0 ${12 * scale}px;font-size:${25 * scale}px}.scene.layout-graphic-focus .flow small,.scene.layout-graphic-focus .visual-cards small{font-size:${17 * scale}px}.scene.layout-graphic-focus .flow>i{display:block}.scene.layout-graphic-focus .browser p{font-size:${18 * scale}px}.scene.layout-graphic-focus .prompt-line{gap:${18 * scale}px;padding:${12 * scale}px ${16 * scale}px}.scene.layout-graphic-focus .prompt-line b{min-width:${110 * scale}px}.scene.layout-graphic-focus .compare{gap:${20 * scale}px}.scene.layout-graphic-focus .compare article{padding:${24 * scale}px}.scene.layout-graphic-focus .compare b{font-size:${26 * scale}px;margin-top:${30 * scale}px}.evidence.layout-graphic-focus{left:${70 * scale}px;top:${300 * scale}px;width:${1500 * scale}px;height:${620 * scale}px}
.scene.layout-evidence-focus .title-block{position:absolute;left:${70 * scale}px;top:${48 * scale}px;margin:0;max-width:${1450 * scale}px}.scene.layout-evidence-focus .title-block h1{font-size:${46 * scale}px;max-width:${1060 * scale}px}.scene.layout-evidence-focus .title-block p{font-size:${21 * scale}px}.scene.layout-evidence-focus .summary{left:${70 * scale}px;top:${190 * scale}px;width:${960 * scale}px;min-height:${66 * scale}px;padding:${13 * scale}px ${22 * scale}px ${13 * scale}px ${56 * scale}px;z-index:56}.scene.layout-evidence-focus .summary span{font-size:${20 * scale}px}.scene.layout-evidence-focus .facts{left:${90 * scale}px;top:auto;bottom:${72 * scale}px;width:${1180 * scale}px;z-index:58}.scene.layout-evidence-focus .fact{min-height:${96 * scale}px;padding:${12 * scale}px;background:rgba(10,14,22,.86)}.evidence.layout-evidence-focus{left:${55 * scale}px;top:${285 * scale}px;width:${1550 * scale}px;height:${665 * scale}px;border-width:${4 * scale}px;box-shadow:0 ${36 * scale}px ${100 * scale}px rgba(0,0,0,.62)}
</style></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="${duration.toFixed(3)}" data-width="${width}" data-height="${height}" data-fps="${fps}"><div class="top-progress"><i id="progress"></i></div>${audioHtml}${sceneHtml}<aside class="speaker-stage" id="speakerStage" data-layout-allow-overflow>${speakerHtml}${showSafeGuides ? `<div class="speaker-safe"></div>` : ""}</aside>${evidenceHtml}${captionHtml}</div>
<script>window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true,defaults:{ease:"power3.out"}});tl.fromTo("#progress",{scaleX:0},{scaleX:1,duration:${duration.toFixed(3)},ease:"none"},0);${speakerTimeline}${animationLines.join("\n")}document.querySelectorAll(".caption").forEach((caption)=>{const start=Number(caption.dataset.start),d=Number(caption.dataset.duration);tl.from(caption,{opacity:0,y:${14 * scale},scale:.97,duration:.18},start);tl.to(caption,{opacity:0,y:-${8 * scale},duration:.14},start+Math.max(.2,d-.14));});window.__timelines.main=tl;</script></body></html>`;

  await fsp.writeFile(path.join(projectDir, "index.html"), documentHtml, "utf8");
  await fsp.writeFile(path.join(projectDir, "hyperframes.json"), `${JSON.stringify({
    $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
    registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
    paths: { blocks: "compositions", components: "compositions/components", assets: "assets" },
    media: { autoProxy: true },
  }, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(projectDir, "package.json"), `${JSON.stringify({
    name: path.basename(projectDir).toLowerCase().replace(/[^a-z0-9-]/g, "-"), private: true, type: "module",
  }, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(projectDir, "composition-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    workflowVersion: VISUAL_WORKFLOW_VERSION,
    mode,
    composition: { width, height, fps, durationSeconds: duration },
    range: { start: rangeStart, end: rangeStart + duration },
    segmentIds: scenes.map((item) => item.segment.id),
    approvedAssetIds: copiedAssets.map((asset) => asset.id),
    compositedAssetIds,
    skippedAssetConflicts,
    motionDirectionConsumed: mode === "sample" && isObject(motionDirection),
    sceneLayouts: scenes.map((scene) => ({
      segmentId: scene.segment.id,
      requestedMode: scene.layoutRequestedRaw,
      effectiveMode: scene.effectiveLayoutMode,
      lockedByKeyframe: scene.layoutLockedByKeyframe,
      contentLockedByKeyframe: scene.contentLockedByKeyframe,
      hasEvidence: scene.hasEvidence,
      fallbackReason: scene.layoutFallback?.reason || null,
    })),
    appliedChoreography,
    unappliedChoreography,
    snapshotTimes,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(projectDir, "prompt-snapshot.json"), `${JSON.stringify(promptSnapshot, null, 2)}\n`, "utf8");
  return {
    projectDir,
    indexPath: path.join(projectDir, "index.html"),
    manifestPath: path.join(projectDir, "composition-manifest.json"),
    width,
    height,
    fps,
    duration,
    snapshotTimes,
    appliedChoreography,
    unappliedChoreography,
    compositedAssetIds,
    skippedAssetIds: skippedAssetConflicts.map((item) => item.assetId),
  };
}
