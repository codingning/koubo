#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };
const read = relative => fs.readFileSync(path.join(root, relative), "utf8").replace(/^\uFEFF/, "");
const normalizeSpokenText = value => String(value || "").replace(/[，。！？、；：,.!?;:\s]/g, "");
const sourceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return start >= 0 && end > start ? source.slice(start, end) : "";
};

for (const file of ["video/server.mjs", "video/visual_director.mjs", "video/ai_bridge.py", "scripts/collect_douyin_references.mjs", "config/reference_creators.json", "config/reference_video_library.json", "config/video_workflow_v4.json", "docs/VISUAL_DIRECTOR_WORKFLOW_V4.md", "video/hyperframes-captions/index.html", "video/hyperframes-overlay/index.html", "web/index.html", "web/app.js", "web/styles.css", "打开AI口播工作台.vbs"]) {
  assert(fs.existsSync(path.join(root, file)), `缺少文件：${file}`);
}

for (const file of ["video/server.mjs", "video/visual_director.mjs", "scripts/collect_douyin_references.mjs", "web/app.js"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { encoding: "utf8" });
  assert(result.status === 0, `${file} 语法检查失败：${result.stderr.trim()}`);
}

process.env.KOUBO_NO_LISTEN = "1";
const mediaPolicy = await import(`${new URL("../video/server.mjs", import.meta.url).href}?policy-test=${Date.now()}`);
const visualDirector = await import(`${new URL("../video/visual_director.mjs", import.meta.url).href}?director-test=${Date.now()}`);
const visualDefaults = JSON.parse(read("config/video_workflow_v4.json"));
const visualConfig = visualDirector.normalizeVisualWorkflowConfig(visualDefaults, { stages: { content_breakdown: { settings: { factCardsPerSegment: 3 } }, keyframes: { settings: { count: 9 } }, motion_sample: { settings: { durationSeconds: 8 } }, full_render: { settings: { masterWidth: 2560, fps: 30 } } } });
assert(!Object.hasOwn(visualConfig.stages.content_breakdown.settings, "factCardsPerSegment"), "旧版固定三张事实卡配置没有被迁移");
assert(visualConfig.stages.content_breakdown.settings.minimumFactCardsPerSegment === 0 && visualConfig.stages.content_breakdown.settings.maximumFactCardsPerSegment === 3, "内容拆解事实卡范围不是0—3张");
assert(visualConfig.stages.keyframes.settings.count === 5, "关键帧数量未限制在3—5张");
assert(visualConfig.stages.motion_sample.settings.durationSeconds === 15, "动态样片未限制在15—25秒");
assert(visualConfig.stages.full_render.settings.masterWidth === 2560 && visualConfig.stages.full_render.settings.masterHeight === 1440, "最终母版默认尺寸不是2560×1440");
const visualState = visualDirector.createVisualWorkflowState(visualConfig);
visualState.stages.keyframes.status = "approved";
visualState.stages.motion_sample.status = "approved";
visualDirector.invalidateVisualStages(visualState, "content_breakdown", "test");
assert(visualState.stages.keyframes.status === "pending" && visualState.stages.motion_sample.status === "pending", "上游重做没有作废下游视觉版本");
const normalizedBreakdown = visualDirector.normalizeContentBreakdown({ segments: [{ sourceTime: { start: 99, end: 120 }, title: "边界测试" }] }, { sourceDuration: 10, outputDuration: 10, minimumSegments: 3, maximumSegments: 5 });
assert(normalizedBreakdown.segments.every(segment => segment.sourceTime.end <= 10 && segment.sourceTime.end > segment.sourceTime.start), "内容拆解时间段越过源视频边界");
assert(normalizedBreakdown.segments.every(segment => segment.factCards.length === 0), "内容拆解省略事实卡时仍补出了占位卡");
const normalizedFrames = visualDirector.normalizeKeyframeDirection({}, normalizedBreakdown, 4);
assert(normalizedFrames.frames.length >= 3 && normalizedFrames.frames.length <= 5, "关键帧方案数量不符合3—5张门禁");
const existingFixture = path.join(root, "README.md");
const externalFixture = {
  id: "external-test",
  sourceType: "external-creator",
  mediaKind: "video",
  path: existingFixture,
  reviewStatus: "approved",
  placement: { start: 0, end: 2, mode: "broll" },
  creatorName: "TestCreator",
  workTitle: "Test Work",
  sourceUrl: "https://example.com/work",
  usagePurpose: "分析该视频的开场结构",
  licenseBasis: "explicit-authorization",
  attributionText: "来源：TestCreator｜Test Work",
  clipStart: 0,
  clipEnd: 2,
  clipDuration: 2
};
assert(mediaPolicy.assetComplianceIssues(externalFixture, { script: "本段采用 TestCreator 的视频作分析" }, 8).length === 0, "完整外部素材元数据被错误拒绝");
assert(mediaPolicy.assetComplianceIssues(externalFixture, { script: "稿件没有创作者名称" }, 8).some(issue => issue.includes("口播稿")), "外部素材缺少稿件披露时未被拦截");
assert(mediaPolicy.assetComplianceIssues({ ...externalFixture, clipEnd: null }, { script: "TestCreator" }, 8).some(issue => issue.includes("截取结束时间")), "外部素材缺少截取结束时间时未被拦截");
assert(mediaPolicy.assetComplianceIssues({ ...externalFixture, licenseBasis: "commentary-quotation", clipEnd: 11, clipDuration: 11 }, { script: "TestCreator" }, 20).some(issue => issue.includes("10秒以内")), "未授权评论性引用超过产品时长限制时未被拦截");
assert(mediaPolicy.assetComplianceIssues({ id: "paid-test", sourceType: "paid-stock", mediaKind: "image", path: existingFixture, reviewStatus: "approved", placement: { start: 0, end: 2, mode: "broll" }, paymentConfirmed: false }, { script: "" }, 8).some(issue => issue.includes("费用确认")), "付费素材未确认费用时未被拦截");
const advisoryIssues = mediaPolicy.assetComplianceIssues({ ...externalFixture, licenseBasis: "" }, { script: "未在口播中提及", options: { rightsReviewMode: "advisory" } }, 8);
assert(!advisoryIssues.some(issue => issue.includes("授权") || issue.includes("口播稿")), "advisory 模式仍错误阻塞版权依据或口播披露");
assert(mediaPolicy.assetComplianceIssues({ ...externalFixture, creatorName: "", attributionText: "" }, { script: "", options: { rightsReviewMode: "advisory" } }, 8).some(issue => issue.includes("创作者") || issue.includes("署名")), "advisory 模式不应跳过来源和画面署名字段");
const placementA = mediaPolicy.candidatePlacement(0, 4, 8), placementB = mediaPolicy.candidatePlacement(1, 4, 8);
assert(placementA.end <= placementB.start, "自动视觉候选时间段发生不必要重叠");

const choreographyBreakdown = visualDirector.normalizeContentBreakdown({
  summary: "动态样片 choreography 落地验证",
  segments: [
    {
      id: "C01",
      sourceTime: { start: 0, end: 6 },
      editedTime: { start: 0, end: 6 },
      upperLeftTitle: "第一段标题",
      subtitleOrKeyLine: "先看标题动作",
      oneSentenceSummary: "标题必须使用导演指定动作。",
      factCards: [{ label: "事实", value: "标题已映射" }],
      rightVisual: { type: "二维信息动效", description: "标题与信息卡" },
    },
    {
      id: "C02",
      sourceTime: { start: 6, end: 12 },
      editedTime: { start: 6, end: 12 },
      upperLeftTitle: "第二段标题",
      subtitleOrKeyLine: "再看主视觉动作",
      oneSentenceSummary: "主视觉必须使用指定推近动作。",
      factCards: [{ label: "事实", value: "主视觉已映射" }],
      rightVisual: { type: "二维信息动效", description: "主视觉窗口" },
    },
    {
      id: "C03",
      sourceTime: { start: 12, end: 20 },
      editedTime: { start: 12, end: 20 },
      upperLeftTitle: "第三段标题",
      subtitleOrKeyLine: "不存在的事实卡应留痕",
      oneSentenceSummary: "本段明确不显示事实卡。",
      factCards: [{ label: "旧事实", value: "不得恢复" }],
      rightVisual: { type: "二维信息动效", description: "无事实卡主视觉" },
    },
  ],
}, { sourceDuration: 20, outputDuration: 20, minimumSegments: 3, maximumSegments: 3 });
const choreographyKeyframes = visualDirector.normalizeKeyframeDirection({
  selectedSegmentIds: ["C01", "C02", "C03"],
  frames: [
    { segmentId: "C01", visualIntent: { primaryVisual: { kind: "inherit" } } },
    { segmentId: "C02", visualIntent: { primaryVisual: { kind: "inherit" } } },
    { segmentId: "C03", visualIntent: { factCards: [], primaryVisual: { kind: "inherit" } } },
  ],
}, choreographyBreakdown, 3);
const normalizedMotionDirection = visualDirector.normalizeMotionDirection({
  sampleStart: 0,
  sampleDuration: 20,
  strongestSegmentId: "C01",
  choreography: [
    { order: 2, at: 0.45, segmentId: "C01", element: "主标题", action: "从左侧滑入", easing: "not-an-ease", purpose: "验证标题动作真正落地" },
    { order: 1, at: 7.25, segmentId: "C02", target: "visual", element: "主视觉窗口", action: "轻微推近", actionPreset: "push-in", easing: "power2.inOut", purpose: "验证主视觉动作真正落地" },
    { order: 3, at: 13.1, segmentId: "C03", target: "fact-3", element: "事实卡3", action: "弹出", easing: "back.out(1.6)", purpose: "验证不存在目标的未应用留痕" },
    { order: 4, at: 5, target: "speaker", element: "真人口播人物", action: "轻微横向镜头运动", actionPreset: "slide-right", easing: "power2.out", purpose: "验证人物持续可见的晚段镜头动作" },
  ],
}, choreographyBreakdown, { outputDuration: 20, durationSeconds: 20 });
assert(normalizedMotionDirection.choreography.map(item => item.order).join(",") === "1,2,3,4", "动态样片 choreography 未按 order 规范化排序");
const normalizedTitleBeat = normalizedMotionDirection.choreography.find(item => item.order === 2);
assert(normalizedTitleBeat?.target === "title" && normalizedTitleBeat.actionPreset === "slide-left" && normalizedTitleBeat.easing === "power3.out", "动态样片 choreography 未规范化目标、动作或缓动");

const choreographyProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-workbench-choreography-"));
try {
  const choreographyProject = await visualDirector.buildHyperframesDirectorProject({
    projectDir: choreographyProjectRoot,
    sourceVideo: existingFixture,
    sourceAudio: null,
    breakdown: choreographyBreakdown,
    styleReport: { palette: {} },
    mode: "sample",
    rangeStart: normalizedMotionDirection.sampleStart,
    rangeEnd: normalizedMotionDirection.sampleEnd,
    keyframeDirection: choreographyKeyframes,
    motionDirection: normalizedMotionDirection,
    captions: [],
    approvedAssets: [],
    renderSpec: { width: 1920, height: 1080, fps: 30 },
    promptSnapshot: { stage: "verify-workbench-choreography" },
  });
  const choreographyManifest = JSON.parse(fs.readFileSync(choreographyProject.manifestPath, "utf8"));
  const choreographyHtml = fs.readFileSync(choreographyProject.indexPath, "utf8");
  const applied = Array.isArray(choreographyManifest.appliedChoreography) ? choreographyManifest.appliedChoreography : [];
  const unapplied = Array.isArray(choreographyManifest.unappliedChoreography) ? choreographyManifest.unappliedChoreography : [];
  assert(choreographyManifest.motionDirectionConsumed === true, "sample manifest 未声明已消费 motionDirection");
  const appliedOrders = new Set(applied.map(item => item.order));
  const unappliedOrders = new Set(unapplied.map(item => item.order));
  assert(appliedOrders.has(1) && appliedOrders.has(2) && appliedOrders.has(4), "sample manifest 未记录已应用的标题、主视觉和人物 choreography");
  assert(unappliedOrders.has(3), "sample manifest 未记录目标不存在的 unapplied choreography");
  for (const beat of normalizedMotionDirection.choreography) {
    assert(appliedOrders.has(beat.order) || unappliedOrders.has(beat.order), `choreography order ${beat.order} 没有 applied/unapplied 审计结果`);
  }
  for (const mapping of applied) {
    const normalized = normalizedMotionDirection.choreography.find(item => item.order === mapping.order);
    assert(Boolean(normalized), `appliedChoreography 出现未知 order：${mapping.order}`);
    assert(mapping.segmentId === normalized?.segmentId && mapping.target && mapping.selector, `appliedChoreography ${mapping.order} 缺少规范化目标或真实 selector`);
    assert(mapping.actionPreset === normalized?.actionPreset && mapping.easing === normalized?.easing, `appliedChoreography ${mapping.order} 没有保留规范化动作或缓动`);
    assert(Number.isFinite(Number(mapping.at)), `appliedChoreography ${mapping.order} 缺少实际应用时间`);
    const escapedSelector = mapping.selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const timelineCalls = choreographyHtml.match(new RegExp(`tl\\.from(?:To)?\\("${escapedSelector}",[\\s\\S]*?\\);`, "g")) || [];
    const appliedAt = Number(mapping.at).toFixed(3);
    assert(timelineCalls.some(call => call.includes(`,${appliedAt})`) || call.includes(`, ${appliedAt})`)), `appliedChoreography ${mapping.order} 没有以记录时间进入对应 sample HTML selector`);
  }
  const stableUnappliedReasons = new Set(["missing-dom-target", "unknown-target", "segment-not-rendered", "superseded-by-specific-target"]);
  for (const mapping of unapplied) {
    assert(stableUnappliedReasons.has(mapping.reason), `unappliedChoreography ${mapping.order} 缺少稳定原因枚举`);
    assert(mapping.target && mapping.actionPreset, `unappliedChoreography ${mapping.order} 缺少目标或规范化动作审计字段`);
  }
} finally {
  fs.rmSync(choreographyProjectRoot, { recursive: true, force: true });
}

const serverSource = read("video/server.mjs");
const visualDirectorSource = read("video/visual_director.mjs");
const bridgeSource = read("video/ai_bridge.py");
for (const capability of [
  "validatePlan",
  "renderHyperframesCards",
  "renderHyperframesCaptions",
  "writeTimelineArtifacts",
  "renderVariants",
  "runQa",
  "ensureMediaManifest",
  "prepareAssetCandidates",
  "createReviewBundle",
  "autoReviewLocalAssetsForPreview",
  "assetComplianceIssues",
  "buildMediaRenderPlan",
  "finalizeMediaManifest",
  "videoColorPipeline",
  "rerenderJob",
  "renderCover",
  "regenerateCover",
]) assert(serverSource.includes(`function ${capability}`), `Missing video capability implementation: ${capability}`);
for (const route of ["/replan", "/rerender", "/cover", "/assets", "/approve"]) {
  assert(serverSource.includes(route), `Missing workflow endpoint: ${route}`);
}
for (const route of ["/api/video-workflow/defaults", "/api/video-workflow/drafts", "workflow\\/stages\\/"]) assert(serverSource.includes(route), `Missing visual-director v4 endpoint: ${route}`);
for (const capability of ["runStyleResearchStage", "runContentBreakdownStage", "runKeyframeStage", "runMotionSampleStage", "runFullRenderStage", "runVisualWorkflowChain", "approveVisualGate", "rejectVisualGate"]) assert(serverSource.includes(`function ${capability}`), `Missing visual-director stage implementation: ${capability}`);
assert(visualDirectorSource.includes("export function rejectVisualGateState"), "视觉导演缺少不触发生成的正式审核拒绝状态迁移");
assert(visualDirectorSource.includes("export function assertVisualGateVersion"), "视觉审核动作没有绑定用户实际看到的产物版本");
const keyframeSchemaSource = sourceBetween(bridgeSource, "def keyframe_direction", "def motion_sample_direction");
for (const token of ["presentation", "showInternalLabels", "showSafeGuides", "visualIntent", "factCards", "primaryVisual", "memo-action", "copy-prompt"]) {
  assert(keyframeSchemaSource.includes(token), `关键帧AI合同缺少字段或类型：${token}`);
}
const keyframeNormalizerSource = sourceBetween(visualDirectorSource, "const KEYFRAME_PRIMARY_VISUAL_KINDS", "export function normalizeMotionDirection");
for (const token of ["presentation", "visualIntent", "factCards"]) {
  assert(keyframeNormalizerSource.includes(token), `关键帧规范化未传播字段：${token}`);
}
assert(keyframeNormalizerSource.includes('showInternalLabels: presentation.showInternalLabels === true') && keyframeNormalizerSource.includes('showSafeGuides: presentation.showSafeGuides === true'), "关键帧规范化没有安全默认关闭内部标签或安全框");
const keyframeStageSource = sourceBetween(serverSource, "async function runKeyframeStage", "async function ensurePreviewAssetDecisions");
assert(keyframeStageSource.includes("previous,") && keyframeStageSource.includes("feedback,") && keyframeStageSource.includes("custom_prompt: feedback ? job.workflow.config.stages.keyframe_review.prompt"), "关键帧返修没有把上一版、反馈和返修提示词传给下一版");
const executeVisualStageSource = sourceBetween(serverSource, "async function executeVisualStage", "async function runVisualWorkflowChain");
for (const token of ["delete stage.approvedAt", "delete stage.rejectedAt", "delete stage.rejectedVersion", "delete stage.feedback"]) assert(executeVisualStageSource.includes(token), `视觉阶段重做未清理旧审核状态：${token}`);
assert(executeVisualStageSource.includes("delete stage.approvedOutputVersion") && executeVisualStageSource.includes("delete job.approvedAt"), "视觉阶段重做仍会残留旧全片批准版本或批准时间");
const workflowStageRouteSource = sourceBetween(serverSource, "const workflowStageMatch", "const retryMatch");
assert(workflowStageRouteSource.includes('requestedStageId === "keyframe_review" && action === "run" ? "keyframes"') && workflowStageRouteSource.includes("runVisualWorkflowChain(job, stageId, feedback)"), "keyframe_review/run 没有携带 feedback 进入关键帧新版本");
assert(workflowStageRouteSource.includes("config|run|approve|reject") && workflowStageRouteSource.includes('action === "reject"'), "视觉审核路由缺少整版拒绝动作");
assert(workflowStageRouteSource.includes("assertVisualGateVersion(job, requestedStageId, body.expectedVersion)"), "视觉审核路由没有在写操作前校验 expectedVersion");
const runGateIndex = workflowStageRouteSource.indexOf('if (stageId === "motion_sample" && job.workflow?.stages?.keyframe_review?.status !== "approved")');
const runConfigIndex = workflowStageRouteSource.indexOf("if (body.settings !== undefined || body.prompt !== undefined) await updateVisualStageConfig");
assert(workflowStageRouteSource.includes('if (action === "run")') && runGateIndex >= 0 && runConfigIndex > runGateIndex, "视觉阶段 run 没有在配置落盘前检查上游审核门");
const motionSampleStageSource = sourceBetween(serverSource, "async function runMotionSampleStage", "async function normalizeHyperframesMaster");
const fullRenderStageSource = sourceBetween(serverSource, "async function runFullRenderStage", "function visualJobStatus");
assert(motionSampleStageSource.includes("keyframeDirection:"), "动态样片构建没有传播已批准关键帧的 presentation/visualIntent");
assert(motionSampleStageSource.includes("motionDirection: direction"), "动态样片构建没有把规范化 choreography 传给 HyperFrames builder");
assert(motionSampleStageSource.includes("previewReview.reviewComplete") && motionSampleStageSource.includes("previewReview.renderReady"), "动态样片没有在交给用户前确认素材自动审核已经可进入全片");
assert(motionSampleStageSource.includes("buildAssetDecisionSnapshot(job)") && motionSampleStageSource.includes("writeMotionSampleAssetSnapshot"), "动态样片没有冻结素材决策版本、批准素材ID、文件哈希和placement");
assert(fullRenderStageSource.includes("keyframeDirection:"), "完整视频构建没有传播已批准关键帧的 presentation/visualIntent");
assert(fullRenderStageSource.includes("assertMotionSampleAssetSnapshotCurrent(job)"), "完整视频启动与渲染完成前没有复验动态样片素材快照");
assert(fullRenderStageSource.includes("workflowDependencies") && serverSource.includes("dependenciesMatch"), "完整视频批准没有绑定当前关键帧与动态样片版本");
assert(workflowStageRouteSource.includes('if (stageId === "full_render") await assertMotionSampleAssetSnapshotCurrent(job)'), "直接启动完整视频前没有复验动态样片素材快照");
assert(serverSource.includes('appendAssetDecisionAudit(job, [uploadedAudit]') && serverSource.includes('appendAssetDecisionAudit(job, [replacedAudit]') && serverSource.includes('appendAssetDecisionAudit(job, [decisionAudit]'), "素材上传、替换或审核变化没有统一作废现有样片审核");
assert(serverSource.includes('pipeline === VISUAL_WORKFLOW_VERSION') && serverSource.includes('runVisualWorkflowChain(job, "style_research")'), "新任务没有默认进入视觉导演v4流程");
assert(serverSource.includes('runVisualWorkflowChain(job, "motion_sample")') && serverSource.includes('runVisualWorkflowChain(job, "full_render")'), "关键帧或动态样片审核门没有驱动下一阶段");
assert(serverSource.includes('masterWidth || 2560') && serverSource.includes('masterHeight || (width === 2560 ? 1440 : 1080)'), "完整视频渲染没有保留2K母版路径");
for (const operation of ["analyze_visual_style", "content_breakdown", "keyframe_direction", "motion_sample_direction", "full_video_direction"]) assert(bridgeSource.includes(operation), `AI bridge missing visual operation: ${operation}`);
assert(serverSource.includes("assets\\/rediscover"), "Missing rich-media rediscovery endpoint");
assert(serverSource.includes("auto-review-preview"), "Missing automatic local-media preview endpoint");
assert(serverSource.includes("assetRenderMatch") && serverSource.includes("renderReviewedAssets"), "Missing reviewed-assets render endpoint");
assert(serverSource.includes("ffmpeg-rich-motion") && serverSource.includes("textOnlyCardsMaxShare"), "Missing rich-media-first candidate generation");
for (const artifact of ["timeline-v", "timeline-v${version}.edl", "qa-report-v", "media-manifest-v", "captions-v", "filter-v", "cover-design-v"]) {
  assert(serverSource.includes(artifact), `Missing auditable artifact: ${artifact}`);
}
assert(serverSource.includes("job.options.generateVariants === false"), "Promotion output switch is not enforced");
assert(serverSource.includes("tonemap=tonemap=hable"), "HLG/HDR source is not tone-mapped for SDR delivery");
assert(serverSource.includes('"-color_primaries", "bt709"'), "Rendered video is not tagged as BT.709");
assert(serverSource.includes('captionStyle: normalizeCaptionStyle(options.captionStyle)'), "新任务未默认启用可控字幕包装");
assert(serverSource.includes('pipeline === VISUAL_WORKFLOW_VERSION ? "landscape-tech"'), "新视觉导演任务未固定使用 16:9 横版");
assert(serverSource.includes('if (layout === "landscape-tech")') && serverSource.includes('ffmpeg-landscape-tech-motion'), "缺少横版科技画布或对应富媒体候选渲染");
assert(serverSource.includes('renderHorizontal(1920, "16x9")') && serverSource.includes('renderHorizontal(1440, "4x3")'), "封面流程缺少 16:9 或 4:3 横版产物");
assert(serverSource.includes("coverPackaging.wide16x9?.metadata?.width === 1920") && serverSource.includes("coverPackaging.landscape4x3?.metadata?.width === 1440"), "四画幅封面尺寸没有进入 QA 门禁");
assert(serverSource.includes('engine: "ass-fallback"'), "动态包装缺少 ASS 降级路径");
assert(serverSource.includes('feedback.trim() ? "revise_plan" : "edit_plan"'), "Replan feedback is not routed to the text model");
assert(!/OPENMONTAGE|OpenMontage|company_openai/i.test(serverSource + bridgeSource), "运行代码仍依赖 OpenMontage");
for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"]) {
  assert(read(".env.example").includes(name), `.env.example 缺少 ${name}`);
}
assert(read(".env.example").includes("OPENCLI_PROFILE") && read(".env.example").includes("KOUBO_LIVE_REFERENCE_RESEARCH"), ".env.example 缺少同题视频研究配置");
assert(serverSource.includes('operation: "plan_topic"'), "生成流程没有先锁定AI选题");
assert(serverSource.includes("reference-research.json") && serverSource.includes("referenceCollector"), "生成流程没有接入同题视频研究包");
assert(bridgeSource.includes("reference_issues") && bridgeSource.includes("duration_issues") && bridgeSource.includes("ai_relevance_issues"), "生成器缺少来源、时长或AI相关性门禁");

const python = path.join(root, ".runtime", "Scripts", "python.exe");
if (fs.existsSync(python)) {
  const bridge = path.join(root, "video", "ai_bridge.py");
  const result = spawnSync(python, ["-B", "-c", "import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))", bridge], { encoding: "utf8" });
  assert(result.status === 0, `ai_bridge.py 语法检查失败：${result.stderr.trim()}`);

  const structureTest = String.raw`
import importlib.util
import json
import pathlib
import sys

bridge = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("koubo_ai_bridge", bridge)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def sample(archetype, count):
    return {
        "structureDesign": {
            "archetype": archetype,
            "selectionReason": "这条内容的证据形态与观众问题适合当前结构",
            "coreQuestion": "普通人如何把收藏AI工具变成一个可验证结果",
            "hookConflict": "收藏越多越容易把准备误认为真正的行动进度",
            "saveableFramework": [
                {"label": f"步骤{i + 1}", "action": "完成一个十分钟内可以执行的小动作", "expectedSignal": "得到一个文件或明确报错"}
                for i in range(count)
            ],
            "personalEvidenceRole": "用真实项目结果证明动作有效",
            "personalVariation": "结合AI口播工作台的实拍限制调整动作",
            "boundary": "尚未拍摄验证的结果不能写成完成",
            "payoff": "观众能判断自己在哪一步并完成下一动作",
        }
    }

valid = {
    "evidence-story": 2,
    "saveable-map": 3,
    "short-resonance": 1,
}
for archetype, count in valid.items():
    issues = module.structure_issues(sample(archetype, count))
    if issues:
        raise AssertionError(f"{archetype} 合法样本被拒绝: {issues}")

broken = sample("saveable-map", 3)
broken["structureDesign"]["saveableFramework"][1].pop("expectedSignal")
issues = module.structure_issues(broken)
if not any("可观察信号" in issue for issue in issues):
    raise AssertionError(f"缺少 expectedSignal 的框架未被拒绝: {issues}")

invalid = sample("copy-a-viral-script", 2)
if not module.structure_issues(invalid):
    raise AssertionError("无效原型未被拒绝")

long_script = {
    "durationFull": "约2—3分钟",
    "fullSegments": [
        {"text": "AI工作流不是功能越多越好。" + "这个知识点要用真实测试和可观察结果讲清楚。" * 4}
        for _ in range(8)
    ],
    "shortScript": "AI工具真正有用的标准，不是生成了多少功能，而是能不能让普通人完成一次测试。" * 7,
}
if module.duration_issues(long_script):
    raise AssertionError(f"合法2—3分钟样本被拒绝: {module.duration_issues(long_script)}")
short_script = {**long_script, "fullSegments": [{"text": "AI很有用。"}] * 3}
if not module.duration_issues(short_script):
    raise AssertionError("过短完整版没有被时长门禁拒绝")

topic_plan = {"aiAngle": "解释AI口播剪辑为什么需要脚本、画面和素材对应关系"}
ai_sample = {**long_script, "mainTopic": "AI口播剪辑先准备什么", "shortTopic": "AI剪辑准备", "hook": "AI剪辑不是把视频丢进去就结束"}
if module.ai_relevance_issues(ai_sample, topic_plan):
    raise AssertionError(f"明确AI主题被误判: {module.ai_relevance_issues(ai_sample, topic_plan)}")

research = {"fullContentSources": [{"sourceId": "douyin-1"}]}
research_sample = {
    "referenceResearch": {
        "sourceIds": ["douyin-1"],
        "borrowedKnowledge": ["知识一", "知识二"],
        "structuralChoices": ["结构一", "结构二"],
        "engagementChoices": ["互动一"],
        "originalityNote": "使用本人真实进度和测试证据重新组织为原创表达",
    }
}
if module.reference_issues(research_sample, research):
    raise AssertionError(f"合法参考研究被拒绝: {module.reference_issues(research_sample, research)}")

class Box:
    def __init__(self, **values):
        self.__dict__.update(values)

fixtures = [
    ('{"keepSegments":[]}', '{"keepSegments":[]}'),
    (json.dumps({"choices": [{"message": {"content": '{"ok":true}'}, "finish_reason": "stop"}]}), '{"ok":true}'),
    ({"choices": [{"message": {"content": [{"type": "text", "text": '{"ok":2}'}]}}]}, '{"ok":2}'),
    (Box(choices=[Box(message=Box(content='{"ok":3}'), finish_reason="stop")], usage=Box(total_tokens=8)), '{"ok":3}'),
    ({"output_text": '{"ok":4}'}, '{"ok":4}'),
    ({"output": [{"content": [{"type": "output_text", "text": '{"ok":5}'}]}]}, '{"ok":5}'),
]
for fixture, expected in fixtures:
    content, _, _ = module.response_details(fixture)
    if content != expected:
        raise AssertionError(f"响应归一化失败: {content!r} != {expected!r}")
`;
  const structureResult = spawnSync(python, ["-B", "-c", structureTest, bridge], { encoding: "utf8" });
  assert(structureResult.status === 0, `三种口播结构门禁测试失败：${(structureResult.stderr || structureResult.stdout).trim()}`);
}

const html = read("web/index.html");
const app = read("web/app.js");
for (const id of [
  "multi-agent-panel",
  "multi-agent-proposals",
  "multi-agent-ab-review",
  "tutorial-ingest-panel",
  "memory-governance-panel",
]) assert(html.includes(`id="${id}"`), `Missing multi-agent UI: ${id}`);
for (const id of [
  "content-direction",
  "content-evidence-summary",
  "analyze-content-direction",
  "content-strategy-analysis",
  "confirm-content-strategy",
  "generate-content",
  "ordinary-viewer-result",
]) assert(html.includes(`id="${id}"`), `Missing content strategy UI: ${id}`);
for (const route of [
  "/api/multi-agent/status",
  "/multi-agent/proposals",
  "/multi-agent/ab",
  "/api/multi-agent/tutorials",
  "/api/multi-agent/memory",
]) assert(app.includes(route), `Missing multi-agent client route: ${route}`);
for (const route of [
  "/api/multi-agent/content-strategy/analyze",
  "/api/multi-agent/content-strategy/confirm",
  "/api/contents/generate",
]) assert(app.includes(route), `Missing content strategy client route: ${route}`);
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const referenced = new Set([...app.matchAll(/byId\("([^"]+)"\)/g)].map(match => match[1]));
for (const id of referenced) assert(ids.has(id), `app.js 引用了不存在的 #${id}`);
assert(!/\/api\/jobs\/\$\{encodeURIComponent\(currentVideoJob\.id\)\}\/render`/.test(app), "网页仍引用旧的手动 render 接口");
assert(!app.includes("copy-ai-edit-prompt"), "网页仍保留复制高级剪辑指令的旧流程");
assert(app.includes("/api/contents/generate"), "网页未接入口播生成接口");
assert(app.includes("lockedDirectionHash: directionHash") && app.includes("strategyConfirmationArtifactId: contentStrategyDraft.confirmationArtifactId"), "网页生成请求没有绑定方向哈希和人工确认 artifact");
assert(app.includes('actor: { type: "human", id: "local-owner" }') && app.includes('confirmationPayload.confirmation?.scriptHandoffAllowed !== true'), "网页没有执行独立人工确认门或检查写稿授权");
assert(app.includes('globalThis.crypto.subtle.digest("SHA-256"') && app.includes('JSON.stringify({ lockedDirection: direction })'), "网页没有按服务端契约计算锁定方向哈希");
assert(app.includes("analysis.audience") && app.includes("analysis.viewerBenefit") && app.includes("analysis.strengths") && app.includes("analysis.weaknesses") && app.includes("analysis.evidence?.missing"), "网页没有完整展示内容顾问的受众、价值、优缺点和证据缺口");
assert(app.includes("review.sharpConclusion") && app.includes("review.minimalFix"), "网页没有展示普通观众的尖锐结论和最小修改");
assert(!app.includes("新口播已生成，可以直接拍摄"), "网页仍在隐藏普通观众点评并直接提示可以拍摄");
assert(app.includes("/revise`"), "网页未接入自然语言返修接口");
assert(app.includes("/approve`"), "网页未接入最终审核接口");
assert(app.includes("selectedVideoOutputVersion") && app.includes("历史版本不可审核"), "网页没有区分当前可审核成片与只读历史版本");
assert(!/id="version-list"[^>]*demo-hide/.test(html), "演示模式仍然隐藏历史版本入口");
assert(app.includes("demoKeyframeReviewCopy") && app.includes("一眼能不能懂、字能不能看清、有没有挡脸"), "关键帧审核仍使用内部编号或技术判断，普通用户无法直接验收");
assert(app.includes("下载旧版 v${output.version}") && app.includes("每次返修都保留一版"), "演示模式没有把旧版预览和下载翻译成普通用户可理解的入口");
assert(app.includes("JSON.stringify({ feedback, expectedVersion })") && app.includes("JSON.stringify({ expectedVersion })"), "最终返修或批准请求没有绑定用户当前所见成片版本");
assert(serverSource.includes("assertOutputReviewVersion(job, body.expectedVersion)"), "服务端最终返修或批准没有校验成片 expectedVersion");
assert(serverSource.includes("approvedOutputVersion") && serverSource.includes("mediaSha256"), "最终批准记录没有绑定输出版本与媒体哈希");
assert(serverSource.includes("final-review-v${outputVersion}.json") && serverSource.includes("reviewBundleSha256") && serverSource.includes("reviewPreviewSha256"), "最终批准没有保留版本化审核记录或绑定审核预览包");
assert(serverSource.includes("createOrReadVersionedFinalReview") && serverSource.includes("该版本已有不同证据的最终审核记录") && serverSource.includes("finalReviewRecordHash"), "同一版本的最终批准记录仍可能被覆盖或完整记录未防篡改");
const jobMutationRouteCount = (serverSource.match(/return await withJobMutation\(jobId/g) || []).length;
assert(serverSource.includes("async function withJobMutation") && serverSource.includes("running.has(id) || jobMutations.has(id)") && jobMutationRouteCount >= 13, "既有任务写接口没有统一经过原子互斥门");
assert(serverSource.includes("writePendingFinalReviewAlias") && serverSource.includes('status: "pending"'), "新成片生成后 final-review 当前别名仍可能冒充旧批准");
assert(serverSource.includes("ordinaryViewerArtifactId") && serverSource.includes("transcriptSha256"), "自然语言返修记录没有绑定基础媒体和普通观众审查证据");
assert(ids.has("edit-caption-style") && ids.has("edit-information-panels"), "网页缺少动态字幕或分屏信息板控制项");
assert(html.includes('<option value="landscape-tech">16:9 视觉导演横版</option>'), "网页未把 16:9 视觉导演横版设为首选");
assert(ids.has("director-workflow-panel") && ids.has("director-stage-cards") && ids.has("director-workflow-version"), "网页缺少六阶段配置与审核面板");
for (const stageId of ["style_research", "content_breakdown", "keyframes", "keyframe_review", "motion_sample", "full_render"]) assert(html.includes(`data-stage="${stageId}"`), `网页进度轨缺少 ${stageId}`);
assert(app.includes("collectDirectorWorkflowOverrides") && app.includes("handleDirectorAction") && app.includes("/api/video-workflow/drafts"), "网页没有把逐阶段配置安全传给服务端");
assert(app.includes("批准并生成动态样片") && app.includes("批准并生成2K全片"), "网页缺少关键帧或动态样片审核门按钮");
assert(app.includes("captionStyle") && app.includes("informationPanels"), "网页未把字幕包装选项发送给服务端");
assert(ids.has("edit-generate-cover") && ids.has("edit-cover-title") && ids.has("regenerate-cover"), "网页缺少自动封面开关、标题覆盖或单独重做入口");
assert(app.includes("generateCover") && app.includes("coverWide16x9") && app.includes("coverLandscape4x3"), "网页未完整接入四画幅封面流程");
assert(ids.has("asset-review-panel") && ids.has("render-with-assets") && ids.has("asset-review-summary"), "网页缺少素材审核板或审核后渲染入口");
assert(ids.has("rediscover-media") && app.includes("/assets/rediscover") && app.includes("rich-media-first"), "网页缺少富媒体候选重建入口");
assert(ids.has("auto-review-preview") && ids.has("review-preview-note") && ids.has("review-segments"), "网页缺少完整预览或分段小样审核入口");
assert(app.includes("/assets/auto-review-preview") && app.includes("reviewBundle"), "网页未接入自动本地素材决策或审核预览包");
for (const id of ["edit-mode-demo", "video-job-picker", "refresh-video-jobs", "demo-analyze-video", "demo-preview-panel", "demo-keyframe-grid", "demo-sample-video", "demo-stage-review-actions", "demo-stage-feedback", "demo-stage-revise", "demo-stage-reject", "demo-stage-approve"]) {
  assert(ids.has(id), `网页缺少普通观众演示入口：${id}`);
}
assert(app.includes("refreshVideoJobs") && app.includes("loadVideoJob") && app.includes("/api/jobs/${encodeURIComponent(id)}"), "网页没有接入可选择的真实任务列表");
assert(app.includes("jobHasStandardOutput") && app.includes("jobKeyframeReview") && app.includes("jobMotionReview") && app.includes("仅样片，不冒充成片") && app.includes("没有标准成片"), "演示模式没有区分标准成片、两道人审与未完成任务");
assert(app.includes("整版不接受，先停在这里") && app.includes("已记录整版不接受；没有生成任何后续视频"), "演示模式缺少零生成的整版拒绝语义");
assert(app.includes('body: JSON.stringify({ feedback, expectedVersion })') && app.includes('action === "run" && !feedback'), "演示审核没有使用版本绑定的最小请求体或空反馈返修门禁");
assert(app.includes("demoJobId") && app.includes("currentVideoJob?.id !== jobId"), "演示审核按钮没有绑定当前任务，存在跨任务误操作风险");
assert(app.includes("demoExpectedVersion") && app.includes("directorExpectedVersion"), "两种审核界面没有绑定当前关键帧或样片版本");
assert(app.includes("approveDisabled: !assetsReady") && app.includes("样片关联素材状态异常"), "演示模式没有在素材状态异常时阻止样片进入全片");
assert(app.includes('editExperienceMode !== "demo" && !rejected') && app.includes("renderReplanAvailability"), "演示模式或已拒绝任务仍可能显示整链重新规划入口");
assert(app.includes("videoJobContextToken") && app.includes("contextToken !== videoJobContextToken"), "任务切换没有隔离旧轮询响应");
assert(app.includes('if (attachCurrentContent) uploadHeaders["X-Content-Id"]') && app.includes('script: attachCurrentContent ? editedScript || shortText(currentItem) : ""'), "演示模式仍可能静默绑定隐藏的内容稿");
assert(app.includes('job?.status === "approved" ? "已通过，可预览和下载"'), "已通过任务仍被错误标记为可返修");
assert(app.includes('document.body.classList.toggle("is-demo-mode"') && html.includes("上传原片 → 等待处理 → 看真实效果 → 用一句话返修 → 下载成片"), "演示模式没有收敛成普通用户五步路径");
assert(read("web/styles.css").includes("body.is-demo-mode #view-edit .demo-hide"), "演示模式没有隐藏技术治理区域");
assert(app.includes("commentary-quotation") && app.includes("data-attribution-text") && app.includes("data-reject-media"), "素材审核板缺少评论性引用、来源署名或拒绝操作");
assert(serverSource.includes("口播稿没有自然说明所采用的创作者名称"), "外部素材未检查稿件中的创作者披露");
assert(serverSource.includes("paidGenerationRequiresConfirmation") && serverSource.includes("paymentConfirmed"), "付费素材缺少费用确认门禁");
assert(serverSource.includes("asset.composited = rendered.has(asset.id)"), "批准素材没有在成功渲染后写入实际合成状态");
assert(serverSource.includes('hyperframes@0.7.71'), "标准 v4 仍未固定到已验证的 HyperFrames 0.7.71");
assert(serverSource.includes('result.replace(/卖出第一步/g, "迈出第一步")'), "已知真人原片字幕纠错规则缺失");

const sandbox = { window: {} };
vm.runInNewContext(read("web/data/content-data.js"), sandbox, { filename: "content-data.js" });
assert(Array.isArray(sandbox.window.KOUBO_DATA?.contentItems), "静态口播数据无法加载");
const growthItems = sandbox.window.KOUBO_DATA?.contentItems?.filter(item => item.kind === "growth") || [];
for (const item of growthItems) {
  const engagement = item.engagement || {};
  assert(Boolean(engagement.audienceMirror), `${item.id} 缺少观众代入点`);
  assert(Boolean(engagement.commentPrompt), `${item.id} 缺少具体评论问题`);
  assert(Boolean(engagement.followPromise), `${item.id} 缺少持续关注理由`);
  assert(Boolean(engagement.viewerTask), `${item.id} 缺少观众最小任务`);
  assert(Boolean(item.creativeTone?.humorBeat), `${item.id} 缺少轻松点或自嘲`);
  if (item.creativeTone?.humorBeat) assert(String(item.shortScript || "").includes(item.creativeTone.humorBeat), `${item.id} 精简稿没有包含轻松点`);
  if (item.creativeTone?.trendMeme?.id) {
    assert(Boolean(item.creativeTone.trendMeme.sourceUrl), `${item.id} 热梗缺少来源链接`);
    assert(normalizeSpokenText(item.shortScript).includes(normalizeSpokenText(item.creativeTone.trendMeme.adaptedLine)), `${item.id} 精简稿没有包含热梗改写句`);
  }
  assert(!String(item.shortScript || "").startsWith("我"), `${item.id} 精简稿仍以自我汇报开场`);
}
const contentStyle = JSON.parse(read("config/content_style.json"));
assert(contentStyle.tone?.spokenLanguage, "内容风格配置缺少口语化规则");
assert(contentStyle.engagement?.commentPrompt?.includes("具体的问题"), "内容风格配置缺少真实问题互动规则");
assert(contentStyle.engagement?.followPromise?.includes("不固定承诺未来多少天"), "内容风格配置仍缺少非倒计时追更规则");
assert(contentStyle.engagement?.primaryClose?.includes("自然"), "内容风格配置缺少单一自然收束规则");
assert(contentStyle.version?.includes("ai-use-case-result-first"), "内容风格尚未升级为AI使用结果优先模式");
assert(contentStyle.storyPriority?.requiredSequence?.length >= 6, "内容风格缺少AI输入、第一版、返修和结果顺序");
assert(contentStyle.storyPriority?.selfDemonstratingMode?.includes("人工审核"), "内容风格缺少自证型成片发布门禁");
assert(contentStyle.structureDesign?.archetypes?.["evidence-story"]?.recommendedDuration === "120—180秒", "证据故事默认时长不是2—3分钟");
for (const archetype of ["evidence-story", "saveable-map", "short-resonance"]) {
  assert(Boolean(contentStyle.structureDesign?.archetypes?.[archetype]), `内容风格配置缺少 ${archetype} 结构`);
}
assert(serverSource.includes("structureDesign"), "服务端没有保存结构设计字段");
assert(serverSource.includes("referenceResearch"), "服务端没有保存参考视频研究字段");
assert(serverSource.includes("contentDirectionFor") && serverSource.includes("content_direction"), "拍后AI剪辑没有继承内容包中的结果证明与视觉设计");
assert(bridgeSource.includes("structure_issues"), "生成器没有接入结构质量门禁");
assert(bridgeSource.includes("viewer_use_case_issues") && bridgeSource.includes("DEVELOPER_LOG_PATTERN"), "生成器缺少AI使用结果与开发日志降权门禁");
const referenceCreators = JSON.parse(read("config/reference_creators.json"));
const referenceLibrary = JSON.parse(read("config/reference_video_library.json"));
assert(referenceCreators.creators?.some(item => item.pinnedVideoIds?.includes("7641901934210813234")), "缺少用户新指定的AI剪辑参考账号");
assert(referenceLibrary.items?.some(item => item.sourceId === "douyin-7641901934210813234" && item.visualLanguage?.length >= 4), "缺少新参考视频的全文与视觉结构摘要");
assert(!bridgeSource.includes("def enforce_script_contract"), "生成器仍在机械拼接口播结尾");
assert(fs.existsSync(path.join(root, "docs", "CONTENT_STRUCTURE_RESEARCH_2026-07-20.md")), "缺少本轮内容结构调研报告");
const memePool = JSON.parse(read("config/meme_pool.json"));
assert(memePool.items?.some(item => item.id === "douyin-xuejie-xian-zuoqilai" && item.status === "active"), "缺少已核对的‘学姐先做起来’热梗");

const urlArg = process.argv.find(arg => arg.startsWith("--url="));
if (urlArg) {
  const base = urlArg.slice(6).replace(/\/$/, "");
  const health = await fetch(`${base}/api/health`).then(async response => ({ response, data: await response.json() }));
  assert(health.response.ok && health.data.ok, "健康检查失败");
  assert(health.data.version === 4, `服务版本不是 v4：${health.data.version}`);
  assert(health.data.defaultPipeline === "visual-director-v4", "服务未声明视觉导演v4为默认流程");
  const workflowDefaults = await fetch(`${base}/api/video-workflow/defaults`).then(async response => ({ response, data: await response.json() }));
  assert(workflowDefaults.response.ok && workflowDefaults.data.workflow?.stages?.full_render?.settings?.masterWidth === 2560, "在线默认工作流接口缺少2K配置");
  assert(health.data.localOnlyVideo === true, "服务未声明原视频本地处理边界");
  assert(health.data.ffmpeg === true, "FFmpeg 不可用");
  const contents = await fetch(`${base}/api/contents`).then(async response => ({ response, data: await response.json() }));
  assert(contents.response.ok && Array.isArray(contents.data.items), "生成内容列表接口失败");
  const day1Package = await fetch(`${base}/runs/2026-07-17/growth/02_main_package.md`);
  assert(day1Package.ok, "网页无法打开第一条完整素材包");
  if (day1Package.ok) assert((await day1Package.text()).includes("学姐都说了，先做起来嘛"), "第一条素材包没有包含已核对热梗");
  await fetch(`${base}/favicon.ico`);
  const healthAfter404 = await fetch(`${base}/api/health`);
  assert(healthAfter404.ok, "404 静态请求导致服务退出");
}

if (failures.length) {
  console.error(failures.map(item => `- ${item}`).join("\n"));
  process.exit(1);
}
console.log(`工作台验证通过：${referenced.size} 个页面控件引用有效${urlArg ? "，v4 服务在线" : ""}。`);
