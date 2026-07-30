import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildHyperframesDirectorProject,
  DIRECTOR_SCENE_LAYOUT_MODES,
  DIRECTOR_SCENE_ROLES,
  findLockedVisualIntentConflict,
  normalizeContentBreakdown,
  normalizeFullDirection,
  normalizeKeyframeDirection,
  normalizeMotionDirection,
} from "../video/visual_director.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDir, "..");
const sourceVideoFixture = path.join(repositoryRoot, "README.md");

const MEMO_SENTENCE = "写下今天最想让 AI 解决的一件麻烦";
const COMPLETE_PROMPT = "别给计划，只给我一个三十秒动作。做完，再给下一步。";
const INTERNAL_LABELS = [
  "AI VISUAL DIRECTOR · HYPERFRAMES",
  "CORE MESSAGE / 信息卡不是字幕",
  "REAL TALKING HEAD",
  "AI INPUT",
  "BEFORE",
  "AFTER",
];

const presentation = {
  showInternalLabels: false,
  showSafeGuides: false,
};

const memoVisualIntent = {
  title: "AI 只给了这一步",
  keyLine: "先记录一个具体麻烦",
  summary: "",
  factCards: [],
  primaryVisual: {
    kind: "memo-action",
    lines: ["打开备忘录", MEMO_SENTENCE, "写完后告诉 AI"],
    text: "",
    highlights: ["一件麻烦"],
  },
};

const promptVisualIntent = {
  title: "复制这句行动指令",
  keyLine: "让 AI 一次只推动一步",
  summary: "",
  factCards: [],
  primaryVisual: {
    kind: "copy-prompt",
    lines: [],
    text: COMPLETE_PROMPT,
    highlights: ["别给计划", "一个三十秒动作", "做完，再给下一步"],
  },
};

const breakdown = normalizeContentBreakdown({
  summary: "关键帧返修渲染合同",
  segments: [
    {
      id: "S01",
      sourceTime: { start: 0, end: 3 },
      editedTime: { start: 0, end: 3 },
      upperLeftTitle: "先迈出第一步",
      subtitleOrKeyLine: "不要继续囤工具",
      oneSentenceSummary: "真正卡住行动的不是工具数量。",
      factCards: [
        { label: "问题", value: "工具太多" },
        { label: "卡点", value: "没有开始" },
        { label: "目标", value: "迈出第一步" },
      ],
      rightVisual: { type: "行动对比", description: "工具堆积与第一步对比" },
    },
    {
      id: "S04",
      sceneRole: "explanation",
      sourceTime: { start: 17.3, end: 23.58 },
      editedTime: { start: 3, end: 6 },
      upperLeftTitle: "AI 只给了这一步",
      subtitleOrKeyLine: "先记录一个具体麻烦",
      oneSentenceSummary: "AI 把起点缩成一个可以立刻完成的记录动作。",
      factCards: [
        { label: "打开", value: "备忘录" },
        { label: "写下", value: "一件麻烦" },
        { label: "完成后", value: "告诉 AI" },
      ],
      rightVisual: {
        type: "备忘录操作演示",
        description: "展示一条具体而完整的备忘录输入。",
        data: [MEMO_SENTENCE],
      },
    },
    {
      id: "S06",
      sceneRole: "explanation",
      sourceTime: { start: 28.2, end: 34.3 },
      editedTime: { start: 6, end: 9 },
      upperLeftTitle: "复制这句行动指令",
      subtitleOrKeyLine: "让 AI 一次只推动一步",
      oneSentenceSummary: "把 AI 从计划制定者改成逐步行动助手。",
      factCards: [
        { label: "先排除", value: "完整计划" },
        { label: "当前只要", value: "三十秒动作" },
        { label: "下一步", value: "完成之后" },
      ],
      rightVisual: {
        type: "可复制提示词",
        description: "展示一条完整、可直接复制的提示词，而不是重复三张事实卡。",
        data: [COMPLETE_PROMPT],
      },
    },
  ],
}, {
  sourceDuration: 35.2,
  outputDuration: 9,
  minimumSegments: 3,
  maximumSegments: 3,
});

const rawDirection = {
  presentation,
  selectedSegmentIds: ["S01", "S04", "S06"],
  frames: [
    {
      segmentId: "S01",
      sourceTime: 1.5,
      visualIntent: {
        title: "先迈出第一步",
        keyLine: "不要继续囤工具",
        summary: "真正卡住行动的不是工具数量。",
        primaryVisual: {
          kind: "hook-contrast",
          lines: ["继续囤工具", "迈出第一步"],
          text: "",
          highlights: ["第一步"],
        },
      },
    },
    {
      segmentId: "S04",
      sourceTime: 20.1,
      visualIntent: memoVisualIntent,
    },
    {
      segmentId: "S06",
      sourceTime: 31.2,
      visualIntent: promptVisualIntent,
    },
  ],
  revisionSummary: "移除内部制作标签，并把备忘录与结尾提示词改为完整单卡表达。",
};

const styleReport = {
  palette: {
    background: "#07090F",
    surface: "#111621",
    primary: "#FF6A3D",
    secondary: "#55D6FF",
    warning: "#FFD166",
    text: "#F7F9FC",
    muted: "#9FA9B8",
  },
};

function sceneHtml(documentHtml, segmentId, nextSegmentId = null) {
  const startMarker = `<section id="scene-${segmentId}"`;
  const start = documentHtml.indexOf(startMarker);
  assert.notEqual(start, -1, `missing scene for ${segmentId}`);
  const end = nextSegmentId
    ? documentHtml.indexOf(`<section id="scene-${nextSegmentId}"`, start + startMarker.length)
    : documentHtml.indexOf("<aside class=\"speaker-stage\"", start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker for ${segmentId}`);
  return documentHtml.slice(start, end);
}

function visualPanelHtml(scene) {
  const match = scene.match(/<section class="visual-panel(?: [^"]*)?">([\s\S]*?)<\/section>/);
  assert.ok(match, "missing visual panel");
  return match[1];
}

function visibleText(fragment) {
  return String(fragment)
    .replace(/<[^>]+>/g, "")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();
}

function createProjectRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-keyframe-render-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function renderFixtureProject(t, mode, keyframeDirection, options = {}) {
  const root = createProjectRoot(t);
  const fixtureBreakdown = options.breakdown || breakdown;
  return buildHyperframesDirectorProject({
    projectDir: path.join(root, mode),
    sourceVideo: sourceVideoFixture,
    sourceAudio: null,
    breakdown: fixtureBreakdown,
    styleReport,
    mode,
    rangeStart: options.rangeStart ?? 0,
    rangeEnd: options.rangeEnd ?? 9,
    keyframeDirection,
    motionDirection: options.motionDirection || null,
    fullDirection: options.fullDirection || null,
    captions: [],
    approvedAssets: options.approvedAssets || [],
    renderSpec: { width: 1920, height: 1080, fps: 30 },
    promptSnapshot: { stage: mode, feedback: "回归测试" },
  });
}

function timelineFromCalls(documentHtml, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`tl\\.from\\("${escapedSelector}",\\s*(\\{[^}]*\\}),\\s*([0-9.]+)\\);`, "g");
  return [...documentHtml.matchAll(pattern)].map(match => ({ vars: match[1], at: Number(match[2]) }));
}

function assertTimelineVar(vars, key, expected) {
  const escaped = String(expected).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(vars, new RegExp(`(?:${key}|"${key}")\\s*:\\s*(?:"${escaped}"|${escaped})(?:[,}])`));
}

function assertNoInternalLabels(documentHtml) {
  for (const label of INTERNAL_LABELS) {
    assert.equal(documentHtml.includes(label), false, `internal label leaked into HTML: ${label}`);
  }
  assert.doesNotMatch(documentHtml, /<div class="scene-number">[^<]*S\d+/);
  assert.doesNotMatch(documentHtml, /<div class="visual-head">[\s\S]*?<b>S\d+<\/b>/);
}

function assertInheritedScenes(documentHtml, direction) {
  const kf02 = sceneHtml(documentHtml, direction.frames[1].segmentId, direction.frames[2].segmentId);
  const kf02Panel = visualPanelHtml(kf02);
  assert.ok(kf02Panel.includes(MEMO_SENTENCE), "KF02 must render the complete memo sentence");
  assert.equal(kf02.includes('<section class="facts">'), false, "KF02 must honor explicit empty factCards");

  const kf03 = sceneHtml(documentHtml, direction.frames[2].segmentId);
  const kf03Panel = visualPanelHtml(kf03);
  const kf03VisibleText = visibleText(kf03Panel);
  assert.ok(kf03VisibleText.includes(COMPLETE_PROMPT), "KF03 must render the complete prompt");
  assert.equal(kf03VisibleText.split(COMPLETE_PROMPT).length - 1, 1, "KF03 must render the complete prompt once");
  assert.equal(kf03.includes('<section class="facts">'), false, "KF03 must honor explicit empty factCards");
  assert.equal(kf03Panel.includes('<div class="visual-cards">'), false, "KF03 must not repeat the three fact cards in its visual panel");
  assert.notEqual((kf03Panel.match(/<article class="v-step">/g) || []).length, 3, "KF03 visual panel must not be another three-card grid");
}

function assertAudienceFacingScenes(documentHtml, direction) {
  assertNoInternalLabels(documentHtml);
  assertInheritedScenes(documentHtml, direction);
}

test("normalizeKeyframeDirection preserves presentation, visualIntent, and explicit empty factCards", () => {
  const direction = normalizeKeyframeDirection(rawDirection, breakdown, 3);

  assert.deepEqual(direction.frames.map(frame => frame.segmentId), ["S01", "S04", "S06"]);
  assert.deepEqual(direction.presentation, presentation);
  assert.equal(direction.frames[1].visualIntent.title, memoVisualIntent.title);
  assert.equal(direction.frames[1].visualIntent.keyLine, memoVisualIntent.keyLine);
  assert.equal(direction.frames[1].visualIntent.summary, memoVisualIntent.summary);
  assert.equal(direction.frames[1].visualIntent.primaryVisual.kind, "memo-action");
  assert.ok(direction.frames[1].visualIntent.primaryVisual.lines.includes(MEMO_SENTENCE));
  assert.ok(Object.hasOwn(direction.frames[1].visualIntent, "factCards"));
  assert.deepEqual(direction.frames[1].visualIntent.factCards, []);
  assert.equal(direction.frames[2].visualIntent.title, promptVisualIntent.title);
  assert.equal(direction.frames[2].visualIntent.keyLine, promptVisualIntent.keyLine);
  assert.equal(direction.frames[2].visualIntent.summary, promptVisualIntent.summary);
  assert.equal(direction.frames[2].visualIntent.primaryVisual.kind, "copy-prompt");
  assert.equal(direction.frames[2].visualIntent.primaryVisual.text, COMPLETE_PROMPT);
  assert.deepEqual(direction.frames[2].visualIntent.primaryVisual.highlights, promptVisualIntent.primaryVisual.highlights);
  assert.ok(Object.hasOwn(direction.frames[2].visualIntent, "factCards"));
  assert.deepEqual(direction.frames[2].visualIntent.factCards, []);
});

test("fact card normalization drops omitted and empty placeholders while preserving real values", () => {
  const normalized = normalizeContentBreakdown({
    segments: [
      {
        id: "unsafe, segment",
        sourceTime: { start: 0, end: 3 },
        editedTime: { start: 0, end: 3 },
        factCards: [{}, { label: "", value: "" }, { value: "真实事实" }],
      },
      {
        id: "unsafe segment",
        sourceTime: { start: 3, end: 6 },
        editedTime: { start: 3, end: 6 },
      },
      {
        id: ":",
        sourceTime: { start: 6, end: 9 },
        editedTime: { start: 6, end: 9 },
        factCards: null,
      },
    ],
  }, {
    sourceDuration: 9,
    outputDuration: 9,
    minimumSegments: 3,
    maximumSegments: 3,
  });

  assert.deepEqual(normalized.segments.map(segment => segment.id), ["unsafe-segment", "unsafe-segment-2", "S03"]);
  assert.deepEqual(normalized.segments[0].factCards, [{ label: "重点", value: "真实事实" }]);
  assert.deepEqual(normalized.segments[1].factCards, []);
  assert.deepEqual(normalized.segments[2].factCards, []);

  const direction = normalizeKeyframeDirection({
    presentation,
    selectedSegmentIds: normalized.segments.map(segment => segment.id),
    frames: normalized.segments.map((segment, index) => ({
      segmentId: segment.id,
      sourceTime: index * 3 + 1.5,
      visualIntent: {
        factCards: index === 0 ? [{}, { label: "仅标签" }, { value: "关键帧真实事实" }] : null,
        primaryVisual: { kind: "inherit", lines: [], text: "", highlights: [] },
      },
    })),
  }, normalized, 3);

  assert.deepEqual(direction.frames[0].visualIntent.factCards, [{ label: "重点", value: "关键帧真实事实" }]);
  assert.equal(direction.frames[1].visualIntent.factCards, null);
  assert.equal(direction.frames[2].visualIntent.factCards, null);
});

test("content breakdown assigns reusable semantic scene roles instead of a repeated card template", () => {
  const normalized = normalizeContentBreakdown({
    segments: [
      { id: "R01", editedTime: { start: 0, end: 2 }, gist: "先看最终效果", sceneRole: "hook" },
      { id: "R02", editedTime: { start: 2, end: 4 }, gist: "前三条旧视频缩成过去版本墙", rightVisual: { type: "真实证据蒙太奇" } },
      { id: "R03", editedTime: { start: 4, end: 6 }, gist: "这次只验证一个核心问题" },
      { id: "R04", editedTime: { start: 6, end: 8 }, gist: "展示真实工作台界面和操作录屏" },
      { id: "R05", editedTime: { start: 8, end: 10 }, gist: "告诉 AI 哪一秒怎么改，哪些别动" },
      { id: "R06", editedTime: { start: 10, end: 12 }, gist: "把字幕动效节奏规律存进本地知识库" },
      { id: "R07", editedTime: { start: 12, end: 14 }, gist: "最后请观众选择下一步想看什么" },
    ],
  }, { sourceDuration: 14, outputDuration: 14, minimumSegments: 7, maximumSegments: 7 });

  assert.deepEqual(DIRECTOR_SCENE_ROLES, [
    "hook",
    "proof-montage",
    "thesis-takeover",
    "ui-demo",
    "revision-flow",
    "learning-summary",
    "cta",
    "explanation",
  ]);
  assert.deepEqual(normalized.segments.map(segment => segment.sceneRole), [
    "hook",
    "proof-montage",
    "thesis-takeover",
    "ui-demo",
    "revision-flow",
    "learning-summary",
    "cta",
  ]);
});

test("keyframe selection keeps real proof and UI roles when the model omits them", () => {
  const roleBreakdown = normalizeContentBreakdown({
    segments: [
      { id: "E01", editedTime: { start: 0, end: 2 }, sourceTime: { start: 0, end: 2 }, sceneRole: "hook" },
      { id: "E02", editedTime: { start: 2, end: 4 }, sourceTime: { start: 2, end: 4 }, sceneRole: "proof-montage" },
      { id: "E03", editedTime: { start: 4, end: 6 }, sourceTime: { start: 4, end: 6 }, sceneRole: "thesis-takeover" },
      { id: "E04", editedTime: { start: 6, end: 8 }, sourceTime: { start: 6, end: 8 }, sceneRole: "ui-demo" },
      { id: "E05", editedTime: { start: 8, end: 10 }, sourceTime: { start: 8, end: 10 }, sceneRole: "revision-flow" },
      { id: "E06", editedTime: { start: 10, end: 12 }, sourceTime: { start: 10, end: 12 }, sceneRole: "learning-summary" },
      { id: "E07", editedTime: { start: 12, end: 14 }, sourceTime: { start: 12, end: 14 }, sceneRole: "cta" },
    ],
  }, { sourceDuration: 14, outputDuration: 14, minimumSegments: 7, maximumSegments: 7 });
  const direction = normalizeKeyframeDirection({
    selectedSegmentIds: ["E01", "E03", "E05", "E06", "E07"],
    frames: ["E01", "E03", "E05", "E06", "E07"].map(segmentId => ({
      segmentId,
      sourceTime: Number(segmentId.slice(-2)),
      purpose: `model-${segmentId}`,
    })),
  }, roleBreakdown, 4);

  assert.deepEqual(direction.frames.map(frame => frame.segmentId), ["E01", "E02", "E04", "E05", "E06"]);
  assert.equal(direction.frames[1].purpose, "验证核心方法", "forced proof frame must not inherit another segment's model payload");
  assert.equal(direction.frames[2].purpose, "验证结果证据", "forced UI frame must not inherit another segment's model payload");
});

test("semantic scene roles render distinct takeovers and a three-slot proof montage", async t => {
  const roleBreakdown = normalizeContentBreakdown({
    segments: [
      { id: "R01", editedTime: { start: 0, end: 3 }, gist: "先看结果", upperLeftTitle: "先看结果", sceneRole: "hook", factCards: [{ label: "结果", value: "不碰时间线" }] },
      { id: "R02", editedTime: { start: 3, end: 6 }, gist: "过去三个版本", upperLeftTitle: "过去版本", sceneRole: "proof-montage" },
      { id: "R03", editedTime: { start: 6, end: 9 }, gist: "唯一实验问题", upperLeftTitle: "不会剪辑，也能做出层次吗？", oneSentenceSummary: "只验证这一件事", sceneRole: "thesis-takeover" },
      { id: "R04", editedTime: { start: 9, end: 12 }, gist: "自然语言返修", upperLeftTitle: "说清哪一秒怎么改", sceneRole: "revision-flow", factCards: [{ label: "定位", value: "哪一秒" }, { label: "动作", value: "怎么改" }, { label: "边界", value: "哪些别动" }] },
      { id: "R05", editedTime: { start: 12, end: 15 }, gist: "沉淀学习规律", upperLeftTitle: "把规律留下", sceneRole: "learning-summary", factCards: [{ label: "字幕", value: "跟随语义" }, { label: "动效", value: "只强化重点" }, { label: "节奏", value: "快慢有层次" }] },
      { id: "R06", editedTime: { start: 15, end: 18 }, gist: "选择下一步", upperLeftTitle: "下一条先拆什么？", sceneRole: "cta", factCards: [{ label: "A", value: "字幕" }, { label: "B", value: "动效" }, { label: "C", value: "节奏" }] },
    ],
  }, { sourceDuration: 18, outputDuration: 18, minimumSegments: 6, maximumSegments: 6 });
  const fullDirection = normalizeFullDirection({ segmentMotion: [] }, roleBreakdown);
  const assets = ["montage-left", "montage-center", "montage-right"].map((mode, index) => ({
    id: `proof-${index + 1}`,
    sourceType: "local-upload",
    mediaKind: "video",
    path: sourceVideoFixture,
    placement: { start: 3, end: 6, mode },
    clipStart: 0,
  }));
  const project = await renderFixtureProject(t, "full", { presentation, frames: [] }, {
    breakdown: roleBreakdown,
    fullDirection,
    rangeEnd: 18,
    approvedAssets: assets,
  });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(project.manifestPath, "utf8"));

  assert.match(documentHtml, /scene-role-proof-montage/);
  assert.match(documentHtml, /class="thesis-takeover v-step"/);
  assert.match(documentHtml, /class="revision-flow v-step"/);
  assert.match(documentHtml, /class="learning-board v-step"/);
  assert.match(documentHtml, /class="cta-board v-step"/);
  for (const mode of ["montage-left", "montage-center", "montage-right"]) {
    assert.match(documentHtml, new RegExp(`data-placement-mode="${mode}"`));
  }
  assert.deepEqual(manifest.sceneRoles.map(item => item.sceneRole), roleBreakdown.segments.map(segment => segment.sceneRole));
  assert.deepEqual(project.compositedAssetIds.sort(), assets.map(asset => asset.id).sort());
});

test("keyframe mode preserves semantic role layouts and does not collapse revision flow into a memo card", async t => {
  const roleBreakdown = normalizeContentBreakdown({
    segments: [
      {
        id: "K01",
        editedTime: { start: 0, end: 3 },
        gist: "真实工作台界面",
        upperLeftTitle: "它还不是一键成片",
        sceneRole: "ui-demo",
        factCards: [{ label: "成片方式", value: "通过对话逐版修改" }],
      },
      {
        id: "K02",
        editedTime: { start: 3, end: 6 },
        gist: "按秒返修",
        upperLeftTitle: "返修直接说",
        oneSentenceSummary: "定位问题、说明修改、保护其他部分。",
        sceneRole: "revision-flow",
        factCards: [
          { label: "定位方式", value: "指出具体哪一秒" },
          { label: "修改要求", value: "说明应该怎么改" },
          { label: "保护范围", value: "标明哪些别动" },
        ],
      },
      {
        id: "K03",
        editedTime: { start: 6, end: 9 },
        gist: "观众选择下一条",
        upperLeftTitle: "下一条，学哪个视频？",
        sceneRole: "cta",
      },
    ],
  }, { sourceDuration: 9, outputDuration: 9, minimumSegments: 3, maximumSegments: 3 });
  const direction = normalizeKeyframeDirection({
    presentation,
    selectedSegmentIds: ["K01", "K02", "K03"],
    frames: [
      { segmentId: "K01", sourceTime: 1, visualIntent: { primaryVisual: { kind: "memo-action", lines: ["打开工作台", "查看真实界面", "核对版本结果"] } } },
      {
        segmentId: "K02",
        sourceTime: 4,
        visualIntent: {
          title: "返修直接说",
          keyLine: "定位问题、说明修改、保护其他部分",
          summary: "定位问题、说明修改、保护其他部分。",
          factCards: [],
          primaryVisual: {
            kind: "memo-action",
            lines: ["查看结果中的问题", "指出具体哪一秒", "说明应该怎么改", "标明哪些别动"],
          },
        },
      },
      { segmentId: "K03", sourceTime: 7, visualIntent: { primaryVisual: { kind: "inherit" } } },
    ],
  }, roleBreakdown, 3);
  const project = await renderFixtureProject(t, "keyframes", direction, {
    breakdown: roleBreakdown,
    approvedAssets: [{
      id: "ui-proof",
      sourceType: "local-upload",
      mediaKind: "image",
      path: sourceVideoFixture,
      placement: { start: 0, end: 3, mode: "ui-main" },
      clipStart: 0,
    }],
  });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  const uiScene = sceneHtml(documentHtml, "K01", "K02");
  const revisionScene = sceneHtml(documentHtml, "K02", "K03");
  const ctaScene = sceneHtml(documentHtml, "K03");

  assert.match(uiScene, /data-layout-mode="evidence-focus"/);
  assert.match(documentHtml, /data-asset-id="ui-proof"/);
  assert.match(documentHtml, /data-placement-mode="ui-main"/);
  assert.deepEqual(project.compositedAssetIds, ["ui-proof"]);
  assert.match(revisionScene, /data-layout-mode="graphic-focus"/);
  assert.match(revisionScene, /class="revision-flow v-step"/);
  assert.doesNotMatch(revisionScene, /class="memo-card v-step"/);
  assert.match(revisionScene, /指出具体哪一秒/);
  assert.match(revisionScene, /说明应该怎么改/);
  assert.match(revisionScene, /标明哪些别动/);
  assert.match(ctaScene, /data-layout-mode="graphic-focus"/);
  assert.match(documentHtml, /tl\.to\("#speakerStage",\{"x":0,"y":0,"scale":0\.42/);
});

test("legacy unsafe segment ids cannot widen GSAP selectors and duplicate ids fail closed", async t => {
  const unsafeBreakdown = structuredClone(breakdown);
  const unsafeIds = ["S01, body", "S04:panel", "S06 space"];
  unsafeBreakdown.segments.forEach((segment, index) => { segment.id = unsafeIds[index]; });
  const unsafeDirection = normalizeKeyframeDirection({
    ...rawDirection,
    selectedSegmentIds: unsafeIds,
    frames: rawDirection.frames.map((frame, index) => ({ ...frame, segmentId: unsafeIds[index] })),
  }, unsafeBreakdown, 3);
  const motionDirection = normalizeMotionDirection({
    sampleStart: 0,
    sampleDuration: 9,
    strongestSegmentId: unsafeIds[0],
    choreography: [{
      order: 1,
      at: 0.4,
      segmentId: unsafeIds[0],
      target: "title",
      actionPreset: "fade-up",
      easing: "power3.out",
      purpose: "验证安全选择器",
    }],
  }, unsafeBreakdown, { outputDuration: 9, keyframeDirection: unsafeDirection });

  const project = await renderFixtureProject(t, "sample", unsafeDirection, {
    breakdown: unsafeBreakdown,
    motionDirection,
  });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  assert.match(documentHtml, /id="scene-S01-body" data-segment-id="S01, body"/);
  assert.match(documentHtml, /tl\.from\("#scene-S01-body h1"/);
  assert.doesNotMatch(documentHtml, /#scene-S01, body/);

  const duplicateBreakdown = structuredClone(breakdown);
  duplicateBreakdown.segments[1].id = duplicateBreakdown.segments[0].id;
  await assert.rejects(
    renderFixtureProject(t, "full", normalizeKeyframeDirection(rawDirection, duplicateBreakdown, 3), {
      breakdown: duplicateBreakdown,
    }),
    /非空且唯一的 segmentId/,
  );
});

test("keyframe HTML contains audience-facing memo and prompt without internal labels or repeated cards", async t => {
  const direction = normalizeKeyframeDirection(rawDirection, breakdown, 3);
  const project = await renderFixtureProject(t, "keyframes", direction);
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");

  assertAudienceFacingScenes(documentHtml, direction);
});

test("sample and full HTML inherit approved keyframe presentation by segmentId", async t => {
  const direction = normalizeKeyframeDirection(rawDirection, breakdown, 3);

  for (const mode of ["sample", "full"]) {
    const project = await renderFixtureProject(t, mode, direction);
    const documentHtml = fs.readFileSync(project.indexPath, "utf8");
    assertInheritedScenes(documentHtml, direction);
  }
});

test("approved keyframe content does not lock dynamic sample layout", async t => {
  const direction = normalizeKeyframeDirection(rawDirection, breakdown, 3);
  const motionDirection = normalizeMotionDirection({
    sampleStart: 0,
    sampleDuration: 9,
    segmentLayouts: [
      { segmentId: "S01", mode: "speaker-focus", reason: "人物承担开场冲突" },
      { segmentId: "S04", mode: "graphic-focus", reason: "备忘录动作成为主画面" },
      { segmentId: "S06", mode: "split-right", reason: "人物与完整提示词并列收束" },
    ],
  }, breakdown, { outputDuration: 9, keyframeDirection: direction });

  assert.deepEqual(DIRECTOR_SCENE_LAYOUT_MODES, ["speaker-focus", "split-right", "graphic-focus", "evidence-focus"]);
  assert.deepEqual(motionDirection.segmentLayouts.map(item => item.mode), ["speaker-focus", "graphic-focus", "split-right"]);
  assert.equal(motionDirection.segmentLayouts.some(item => Object.hasOwn(item, "lockedByKeyframe")), false);

  const project = await renderFixtureProject(t, "sample", direction, { motionDirection });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(project.manifestPath, "utf8"));

  assert.match(sceneHtml(documentHtml, "S01", "S04"), /class="scene clip layout-speaker-focus/);
  assert.match(sceneHtml(documentHtml, "S04", "S06"), /class="scene clip layout-graphic-focus/);
  assert.match(sceneHtml(documentHtml, "S06"), /class="scene clip layout-split-right/);
  assert.match(documentHtml, /tl\.fromTo\("#speakerStage",\{[^}]*"opacity":0[^}]*\},\{"x":-470,"y":0,"scale":1\.18,"opacity":1[^}]*\}, 0\.180\);/);
  assert.match(documentHtml, /tl\.to\("#speakerStage",\{"x":0,"y":0,"scale":0\.42,"duration":0\.52,"ease":"power3\.inOut","overwrite":"auto"\},3\.020\);/);
  assert.match(documentHtml, /tl\.to\("#speakerStage",\{"x":0,"y":0,"scale":1,"duration":0\.52,"ease":"power3\.inOut","overwrite":"auto"\},6\.020\);/);
  assert.deepEqual(manifest.sceneLayouts.map(item => item.effectiveMode), ["speaker-focus", "graphic-focus", "split-right"]);
  assert.equal(manifest.sceneLayouts.every(item => item.lockedByKeyframe === false), true);
  assert.equal(manifest.sceneLayouts.every(item => item.contentLockedByKeyframe === true), true);
});

test("unsupported and unavailable layout modes fail closed with manifest evidence", async t => {
  const motionDirection = normalizeMotionDirection({
    sampleStart: 0,
    sampleDuration: 9,
    segmentLayouts: [
      { segmentId: "S01", mode: "freeform-fullscreen" },
      { segmentId: "S04", mode: "evidence-focus" },
    ],
  }, breakdown, { outputDuration: 9 });

  assert.equal(motionDirection.segmentLayouts[0].requestedMode, "freeform-fullscreen");
  assert.equal(motionDirection.segmentLayouts[0].mode, "split-right");
  assert.equal(motionDirection.segmentLayouts[0].fallbackReason, "unsupported-layout-mode");

  const project = await renderFixtureProject(t, "sample", { presentation, frames: [] }, { motionDirection });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(project.manifestPath, "utf8"));
  const unsupported = manifest.sceneLayouts.find(item => item.segmentId === "S01");
  const missingEvidence = manifest.sceneLayouts.find(item => item.segmentId === "S04");

  assert.deepEqual(unsupported, {
    segmentId: "S01",
    requestedMode: "freeform-fullscreen",
    effectiveMode: "split-right",
    lockedByKeyframe: false,
    contentLockedByKeyframe: false,
    hasEvidence: false,
    fallbackReason: "unsupported-layout-mode",
  });
  assert.equal(missingEvidence.requestedMode, "evidence-focus");
  assert.equal(missingEvidence.effectiveMode, "graphic-focus");
  assert.equal(missingEvidence.hasEvidence, false);
  assert.match(missingEvidence.fallbackReason, /没有已批准证据素材/);
  assert.match(sceneHtml(documentHtml, "S04", "S06"), /class="scene clip layout-graphic-focus/);
});

test("approved evidence can become the primary layer while the speaker shrinks to PiP", async t => {
  const motionDirection = normalizeMotionDirection({
    sampleStart: 0,
    sampleDuration: 9,
    segmentLayouts: [
      { segmentId: "S01", mode: "split-right" },
      { segmentId: "S04", mode: "evidence-focus" },
      { segmentId: "S06", mode: "speaker-focus" },
    ],
  }, breakdown, { outputDuration: 9 });
  const project = await renderFixtureProject(t, "sample", { presentation, frames: [] }, {
    motionDirection,
    approvedAssets: [{
      id: "approved-evidence",
      sourceType: "local-derived",
      mediaKind: "image",
      path: sourceVideoFixture,
      placement: { start: 3.1, end: 5.8, mode: "broll" },
    }],
  });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(project.manifestPath, "utf8"));
  const evidenceLayout = manifest.sceneLayouts.find(item => item.segmentId === "S04");

  assert.equal(evidenceLayout.effectiveMode, "evidence-focus");
  assert.equal(evidenceLayout.hasEvidence, true);
  assert.equal(evidenceLayout.fallbackReason, null);
  assert.match(documentHtml, /<aside class="evidence layout-evidence-focus"[^>]+data-layout-mode="evidence-focus"/);
  assert.match(documentHtml, /tl\.to\("#speakerStage",\{"x":0,"y":0,"scale":0\.36,"duration":0\.52,"ease":"power3\.inOut","overwrite":"auto"\},3\.020\);/);
  assert.match(documentHtml, /\.evidence\.layout-evidence-focus\{left:/);
});

test("evidence spanning multiple segments is split and participates in every overlapping layout", async t => {
  const motionDirection = normalizeMotionDirection({
    sampleStart: 0,
    sampleDuration: 9,
    segmentLayouts: [
      { segmentId: "S01", mode: "split-right" },
      { segmentId: "S04", mode: "evidence-focus" },
      { segmentId: "S06", mode: "evidence-focus" },
    ],
  }, breakdown, { outputDuration: 9 });
  const project = await renderFixtureProject(t, "sample", { presentation, frames: [] }, {
    motionDirection,
    approvedAssets: [{
      id: "cross-segment-evidence",
      sourceType: "local-derived",
      mediaKind: "video",
      path: sourceVideoFixture,
      placement: { start: 2.5, end: 6.5, mode: "broll" },
      clipStart: 0.5,
    }],
  });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(project.manifestPath, "utf8"));

  assert.deepEqual(manifest.sceneLayouts.map(item => item.hasEvidence), [true, true, true]);
  assert.deepEqual(manifest.sceneLayouts.map(item => item.effectiveMode), ["split-right", "evidence-focus", "evidence-focus"]);
  assert.equal((documentHtml.match(/<aside class="evidence /g) || []).length, 3);
  assert.match(documentHtml, /id="evidence-1"[^>]+data-layout-mode="split-right"/);
  assert.match(documentHtml, /id="evidence-2"[^>]+data-layout-mode="evidence-focus"/);
  assert.match(documentHtml, /id="evidence-3"[^>]+data-layout-mode="evidence-focus"/);
  assert.deepEqual(project.compositedAssetIds, ["cross-segment-evidence"]);
});

test("sample beginning inside evidence placement preserves elapsed media offset", async t => {
  const offsetBreakdown = normalizeContentBreakdown({
    segments: [
      { id: "P01", sourceTime: { start: 0, end: 10 }, editedTime: { start: 0, end: 10 } },
      { id: "P02", sourceTime: { start: 10, end: 15 }, editedTime: { start: 10, end: 15 } },
      { id: "P03", sourceTime: { start: 15, end: 20 }, editedTime: { start: 15, end: 20 } },
    ],
  }, { sourceDuration: 20, outputDuration: 20, minimumSegments: 3, maximumSegments: 3 });
  const motionDirection = normalizeMotionDirection({
    sampleStart: 10,
    sampleDuration: 5,
    segmentLayouts: [{ segmentId: "P02", mode: "evidence-focus" }],
  }, offsetBreakdown, { outputDuration: 20 });
  const project = await renderFixtureProject(t, "sample", { presentation, frames: [] }, {
    breakdown: offsetBreakdown,
    motionDirection,
    rangeStart: 10,
    rangeEnd: 15,
    approvedAssets: [{
      id: "sample-offset-evidence",
      sourceType: "local-derived",
      mediaKind: "video",
      path: sourceVideoFixture,
      placement: { start: 5, end: 15, mode: "broll" },
      clipStart: 2,
    }],
  });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  const evidenceVideo = documentHtml.match(/<video id="evidence-media-1"[^>]*data-start="([^"]+)"[^>]*data-media-start="([^"]+)"/);

  assert.ok(evidenceVideo, "missing evidence video timing");
  const sampleStart = Number(evidenceVideo[1]);
  const mediaStart = Number(evidenceVideo[2]);
  assert.equal(mediaStart, 2 + (10 + sampleStart - 5));
});

test("graphic-focus with approved evidence records a truthful evidence-focus fallback", async t => {
  const motionDirection = normalizeMotionDirection({
    sampleStart: 0,
    sampleDuration: 9,
    segmentLayouts: [
      { segmentId: "S01", mode: "split-right" },
      { segmentId: "S04", mode: "graphic-focus" },
      { segmentId: "S06", mode: "speaker-focus" },
    ],
  }, breakdown, { outputDuration: 9 });
  const project = await renderFixtureProject(t, "sample", { presentation, frames: [] }, {
    motionDirection,
    approvedAssets: [{
      id: "graphic-conflict-evidence",
      sourceType: "local-derived",
      mediaKind: "video",
      path: sourceVideoFixture,
      placement: { start: 3.2, end: 5.7, mode: "broll" },
    }],
  });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(project.manifestPath, "utf8"));
  const scene = manifest.sceneLayouts.find(item => item.segmentId === "S04");

  assert.equal(scene.requestedMode, "graphic-focus");
  assert.equal(scene.effectiveMode, "evidence-focus");
  assert.equal(scene.hasEvidence, true);
  assert.match(scene.fallbackReason, /实际主层切换为证据/);
  assert.match(sceneHtml(documentHtml, "S04", "S06"), /class="scene clip layout-evidence-focus has-evidence/);
  assert.match(documentHtml, /<aside class="evidence layout-evidence-focus"/);
});

test("full direction consumes per-segment layout mode", async t => {
  const direction = normalizeKeyframeDirection(rawDirection, breakdown, 3);
  const fullDirection = normalizeFullDirection({
    segmentMotion: [
      { segmentId: "S01", layoutMode: "speaker-focus" },
      { segmentId: "S04", layoutMode: "graphic-focus" },
      { segmentId: "S06", layoutMode: "split-right" },
    ],
  }, breakdown);
  const project = await renderFixtureProject(t, "full", direction, { fullDirection });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(project.manifestPath, "utf8"));

  assert.deepEqual(fullDirection.segmentMotion.map(item => item.layoutMode), ["speaker-focus", "graphic-focus", "split-right"]);
  assert.deepEqual(manifest.sceneLayouts.map(item => item.effectiveMode), ["speaker-focus", "graphic-focus", "split-right"]);
  assert.match(sceneHtml(documentHtml, "S01", "S04"), /layout-speaker-focus/);
  assert.match(sceneHtml(documentHtml, "S04", "S06"), /layout-graphic-focus/);
});

test("full render keeps scene-role primary evidence visible from the approved placement start", async t => {
  const evidenceBreakdown = structuredClone(breakdown);
  evidenceBreakdown.segments[1].sceneRole = "ui-demo";
  const fullDirection = normalizeFullDirection({
    segmentMotion: [
      { segmentId: "S04", sceneRole: "ui-demo", layoutMode: "evidence-focus", visualAt: 10 },
    ],
  }, evidenceBreakdown);
  const project = await renderFixtureProject(t, "full", { presentation, frames: [] }, {
    breakdown: evidenceBreakdown,
    fullDirection,
    approvedAssets: [{
      id: "full-primary-evidence",
      sourceType: "local-derived",
      mediaKind: "video",
      path: sourceVideoFixture,
      placement: { start: 3, end: 6, mode: "ui-main" },
      clipStart: 0,
    }],
  });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  const evidenceVideo = documentHtml.match(/<video id="evidence-media-1"[^>]*data-start="([^"]+)"[^>]*data-duration="([^"]+)"/);

  assert.ok(evidenceVideo, "missing full-render evidence video timing");
  assert.equal(Number(evidenceVideo[1]), 3);
  assert.equal(Number(evidenceVideo[2]), 3);
});

test("full render sustains subtle ambient motion between information beats", async t => {
  const project = await renderFixtureProject(t, "full", { presentation, frames: [] });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");

  assert.match(documentHtml, /<div class="ambient-drift" data-layout-allow-overflow><\/div>/);
  assert.match(documentHtml, /tl\.to\("\.ambient-drift",\{"x":-160,"y":72,"scale":1\.08,"duration":9,"ease":"none"\},0\);/);
});

test("overlapping approved assets cannot replace locked keyframe visual intent", async t => {
  const direction = normalizeKeyframeDirection(rawDirection, breakdown, 3);
  const approvedAssets = [
    {
      id: "asset-memo-overlap",
      sourceType: "local-derived",
      mediaKind: "video",
      path: sourceVideoFixture,
      placement: { start: 3.2, end: 5.8, mode: "broll" },
      clipStart: 0,
    },
    {
      id: "asset-prompt-overlap",
      sourceType: "local-derived",
      mediaKind: "video",
      path: sourceVideoFixture,
      placement: { start: 6.2, end: 8.8, mode: "broll" },
      clipStart: 0,
    },
  ];

  assert.equal(findLockedVisualIntentConflict(approvedAssets[0], breakdown, direction)?.segmentId, "S04");
  assert.equal(findLockedVisualIntentConflict(approvedAssets[1], breakdown, direction)?.segmentId, "S06");

  for (const mode of ["sample", "full"]) {
    const project = await renderFixtureProject(t, mode, direction, { approvedAssets });
    const documentHtml = fs.readFileSync(project.indexPath, "utf8");
    assertInheritedScenes(documentHtml, direction);
    assert.doesNotMatch(documentHtml, /<(?:video|img)[^>]+class="evidence-media/, `${mode} must not render conflicting evidence media`);
    assert.deepEqual(project.compositedAssetIds, []);
    assert.deepEqual(project.skippedAssetIds.sort(), approvedAssets.map((asset) => asset.id).sort());
  }
});

test("full direction and HTML preserve one, two, and zero fact timings", async t => {
  const limitedDirection = normalizeKeyframeDirection({
    presentation,
    selectedSegmentIds: ["S01", "S04", "S06"],
    frames: [
      {
        segmentId: "S01",
        sourceTime: 1.5,
        visualIntent: {
          title: "一张事实卡",
          keyLine: "保留一项",
          summary: "",
          factCards: [{ label: "唯一", value: "第一项" }],
          primaryVisual: { kind: "inherit", lines: [], text: "", highlights: [] },
        },
      },
      {
        segmentId: "S04",
        sourceTime: 20.1,
        visualIntent: {
          title: "两张事实卡",
          keyLine: "保留两项",
          summary: "",
          factCards: [{ label: "第一", value: "A" }, { label: "第二", value: "B" }],
          primaryVisual: { kind: "inherit", lines: [], text: "", highlights: [] },
        },
      },
      {
        segmentId: "S06",
        sourceTime: 31.2,
        visualIntent: {
          title: "零张事实卡",
          keyLine: "不补占位",
          summary: "",
          factCards: [],
          primaryVisual: { kind: "inherit", lines: [], text: "", highlights: [] },
        },
      },
    ],
  }, breakdown, 3);
  const fullDirection = normalizeFullDirection({
    segmentMotion: [
      { segmentId: "S01", factsAt: [0.55] },
      { segmentId: "S04", factsAt: [0.61, 0.97] },
      { segmentId: "S06", factsAt: [] },
    ],
  }, breakdown);

  assert.deepEqual(fullDirection.segmentMotion.map((item) => item.factsAt), [[0.55], [0.61, 0.97], []]);
  const project = await renderFixtureProject(t, "full", limitedDirection, { fullDirection });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  const oneFactScene = sceneHtml(documentHtml, "S01", "S04");
  const twoFactScene = sceneHtml(documentHtml, "S04", "S06");
  const zeroFactScene = sceneHtml(documentHtml, "S06");

  assert.match(oneFactScene, /class="fact fact-1"/);
  assert.doesNotMatch(oneFactScene, /class="fact fact-2"/);
  assert.match(twoFactScene, /class="fact fact-1"/);
  assert.match(twoFactScene, /class="fact fact-2"/);
  assert.doesNotMatch(twoFactScene, /class="fact fact-3"/);
  assert.doesNotMatch(zeroFactScene, /<section class="facts">/);
  assert.match(documentHtml, /tl\.from\("#scene-S01 \.fact-1",[^;]+, 0\.550\);/);
  assert.match(documentHtml, /tl\.from\("#scene-S04 \.fact-1",[^;]+, 3\.610\);/);
  assert.match(documentHtml, /tl\.from\("#scene-S04 \.fact-2",[^;]+, 3\.970\);/);
  assert.equal(documentHtml.includes("NaN"), false);
});

test("sample HTML applies custom choreography timing, action preset, and easing", async t => {
  const motionDirection = normalizeMotionDirection({
    sampleStart: 0,
    durationSeconds: 9,
    strongestSegmentId: "S01",
    choreography: [{
      order: 1,
      segmentId: "S01",
      target: "title",
      element: "主标题",
      at: 0.731,
      action: "从右侧滑入",
      actionPreset: "slide-right",
      easing: "sine.inOut",
      purpose: "验证样片动作合同",
    }],
  }, breakdown, { outputDuration: 9 });

  assert.equal(motionDirection.choreography[0].at, 0.731);
  assert.equal(motionDirection.choreography[0].actionPreset, "slide-right");
  assert.equal(motionDirection.choreography[0].easing, "sine.inOut");

  const project = await renderFixtureProject(t, "sample", { presentation, frames: [] }, { motionDirection });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  const calls = timelineFromCalls(documentHtml, "#scene-S01 h1");

  assert.equal(calls.length, 1, "custom title choreography must replace the sample fallback call");
  assert.equal(calls[0].at, 0.731);
  assertTimelineVar(calls[0].vars, "x", 60);
  assertTimelineVar(calls[0].vars, "ease", "sine.inOut");
});

test("sample visual-led scenes establish the primary layer without blank lead-in", async t => {
  const visualLedBreakdown = normalizeContentBreakdown({
    segments: [
      {
        id: "V01",
        sourceTime: { start: 0, end: 3 },
        editedTime: { start: 0, end: 3 },
        upperLeftTitle: "Show the result first",
        oneSentenceSummary: "The opening already has a primary visual",
        sceneRole: "hook",
      },
      {
        id: "V02",
        sourceTime: { start: 3, end: 6 },
        editedTime: { start: 3, end: 6 },
        upperLeftTitle: "Three real examples",
        oneSentenceSummary: "Evidence should take over immediately",
        sceneRole: "proof-montage",
      },
      {
        id: "V03",
        sourceTime: { start: 6, end: 9 },
        editedTime: { start: 6, end: 9 },
        upperLeftTitle: "Can it work without a timeline?",
        subtitleOrKeyLine: "The screen must actively deliver the point",
        oneSentenceSummary: "This is the only question",
        factCards: [
          { label: "Constraint", value: "No manual timeline" },
          { label: "Outcome", value: "A layered result" },
        ],
        sceneRole: "thesis-takeover",
      },
    ],
  }, { sourceDuration: 9, outputDuration: 9, minimumSegments: 3, maximumSegments: 3 });
  const motionDirection = normalizeMotionDirection({
    sampleStart: 0,
    sampleDuration: 9,
    segmentLayouts: [
      { segmentId: "V01", mode: "graphic-focus" },
      { segmentId: "V02", mode: "evidence-focus" },
      { segmentId: "V03", mode: "speaker-focus" },
    ],
    choreography: [{
      order: 1,
      at: 3.8,
      segmentId: "V02",
      target: "visual",
      actionPreset: "reveal-right",
      easing: "power4.inOut",
    }],
  }, visualLedBreakdown, { outputDuration: 9 });
  const project = await renderFixtureProject(t, "sample", { presentation, frames: [] }, {
    breakdown: visualLedBreakdown,
    motionDirection,
    rangeEnd: 9,
    approvedAssets: [{
      id: "visual-led-proof",
      sourceType: "local-upload",
      mediaKind: "image",
      path: sourceVideoFixture,
      placement: { start: 3, end: 6, mode: "montage-left" },
    }],
  });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(project.manifestPath, "utf8"));
  const thesisScene = sceneHtml(documentHtml, "V03");
  const thesisVisualCalls = timelineFromCalls(documentHtml, "#scene-V03 .visual-panel");

  assert.ok(manifest.evidenceLayout[0].start <= 3.02, "proof evidence must start at the scene boundary");
  assert.equal(manifest.sceneLayouts.find(item => item.segmentId === "V03")?.effectiveMode, "graphic-focus", "thesis sceneRole must override a speaker-focus model suggestion");
  assert.ok(thesisVisualCalls[0]?.at <= 6.02, "thesis takeover must start its primary visual at the scene boundary");
  assertTimelineVar(thesisVisualCalls[0].vars, "opacity", 0.32);
  assertTimelineVar(thesisVisualCalls[0].vars, "duration", 0.38);
  assert.doesNotMatch(thesisScene, /<section class="facts">/, "thesis takeover must not render redundant standalone facts behind its primary panel");
  assert.equal(timelineFromCalls(documentHtml, "#scene-V03 .summary").length, 0, "missing thesis summary DOM must not receive a GSAP call");
});

test("invalid choreography action and easing never enter sample HTML", async t => {
  const invalidActionPreset = 'spin");window.__BAD_ACTION__=1;//';
  const invalidAction = '");window.__BAD_ACTION_TEXT__=1;//';
  const invalidEasing = 'power4.out");window.__BAD_EASE__=1;//';
  const motionDirection = normalizeMotionDirection({
    sampleStart: 0,
    durationSeconds: 9,
    strongestSegmentId: "S01",
    choreography: [{
      order: 1,
      segmentId: "S01",
      target: "title",
      element: "主标题",
      at: 0.919,
      action: invalidAction,
      actionPreset: invalidActionPreset,
      easing: invalidEasing,
      purpose: "验证非法动作不会进入输出",
    }],
  }, breakdown, { outputDuration: 9 });

  assert.equal(motionDirection.choreography[0].actionPreset, "fade-up");
  assert.equal(motionDirection.choreography[0].easing, "power3.out");

  const project = await renderFixtureProject(t, "sample", { presentation, frames: [] }, { motionDirection });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  for (const unsafe of [invalidActionPreset, invalidAction, invalidEasing, "__BAD_ACTION__", "__BAD_ACTION_TEXT__", "__BAD_EASE__"]) {
    assert.equal(documentHtml.includes(unsafe), false, `unsafe choreography text leaked into HTML: ${unsafe}`);
  }
  const calls = timelineFromCalls(documentHtml, "#scene-S01 h1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at, 0.919);
  assertTimelineVar(calls[0].vars, "y", 30);
  assertTimelineVar(calls[0].vars, "ease", "power3.out");
});

test("keyframes and full HTML ignore sample choreography", async t => {
  const direction = normalizeKeyframeDirection(rawDirection, breakdown, 3);
  const motionDirection = normalizeMotionDirection({
    sampleStart: 0,
    durationSeconds: 9,
    strongestSegmentId: "S01",
    choreography: [{
      order: 1,
      segmentId: "S01",
      target: "title",
      element: "主标题",
      at: 0.731,
      action: "从右侧滑入",
      actionPreset: "slide-right",
      easing: "sine.inOut",
      purpose: "只允许影响动态样片",
    }],
  }, breakdown, { outputDuration: 9 });

  for (const mode of ["keyframes", "full"]) {
    const baseline = await renderFixtureProject(t, mode, direction);
    const withChoreography = await renderFixtureProject(t, mode, direction, { motionDirection });
    assert.equal(
      fs.readFileSync(withChoreography.indexPath, "utf8"),
      fs.readFileSync(baseline.indexPath, "utf8"),
      `${mode} HTML must not change when sample choreography is supplied`,
    );
    const baselineManifest = JSON.parse(fs.readFileSync(baseline.manifestPath, "utf8"));
    const choreographyManifest = JSON.parse(fs.readFileSync(withChoreography.manifestPath, "utf8"));
    for (const manifest of [baselineManifest, choreographyManifest]) {
      assert.equal(manifest.motionDirectionConsumed, false);
      assert.deepEqual(manifest.appliedChoreography, []);
      assert.deepEqual(manifest.unappliedChoreography, []);
    }
  }
});

test("zero through three approved fact cards render without placeholder backfill", async t => {
  const factCounts = [0, 1, 2, 3];
  const factBreakdown = normalizeContentBreakdown({
    summary: "事实卡数量合同",
    segments: factCounts.map((count, index) => ({
      id: `F0${index + 1}`,
      sourceTime: { start: index * 3, end: index * 3 + 3 },
      editedTime: { start: index * 3, end: index * 3 + 3 },
      upperLeftTitle: `${count} 张事实卡`,
      subtitleOrKeyLine: `只保留 ${count} 张`,
      oneSentenceSummary: `本段批准数量是 ${count}`,
      factCards: [0, 1, 2].map(itemIndex => ({
        label: `底层标签-${index + 1}-${itemIndex + 1}`,
        value: `底层占位-${index + 1}-${itemIndex + 1}`,
      })),
      rightVisual: { type: "信息卡", description: "按批准数量展示信息卡" },
    })),
  }, {
    sourceDuration: 12,
    outputDuration: 12,
    minimumSegments: 4,
    maximumSegments: 4,
  });
  const direction = normalizeKeyframeDirection({
    presentation,
    selectedSegmentIds: factBreakdown.segments.map(segment => segment.id),
    frames: factBreakdown.segments.map((segment, index) => ({
      segmentId: segment.id,
      sourceTime: index * 3 + 1.5,
      visualIntent: {
        title: `${factCounts[index]} 张事实卡`,
        keyLine: `只保留 ${factCounts[index]} 张`,
        summary: "",
        factCards: Array.from({ length: factCounts[index] }, (_, factIndex) => ({
          label: `批准标签-${index + 1}-${factIndex + 1}`,
          value: `批准事实-${index + 1}-${factIndex + 1}`,
        })),
        primaryVisual: { kind: "inherit", lines: [], text: "", highlights: [] },
      },
    })),
  }, factBreakdown, 4);

  const project = await renderFixtureProject(t, "full", direction, {
    breakdown: factBreakdown,
    rangeEnd: 12,
  });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");

  factCounts.forEach((count, index) => {
    const segmentId = `F0${index + 1}`;
    const nextSegmentId = index < factCounts.length - 1 ? `F0${index + 2}` : null;
    const scene = sceneHtml(documentHtml, segmentId, nextSegmentId);
    assert.equal((scene.match(/<article class="fact fact-/g) || []).length, count, `${segmentId} fact section count`);
    if (count === 0) {
      assert.equal(scene.includes('<section class="visual-panel'), false, `${segmentId} must not render an empty visual panel`);
    } else {
      const panel = visualPanelHtml(scene);
      assert.equal((panel.match(/<article class="v-step">/g) || []).length, count, `${segmentId} visual card count`);
    }
    assert.equal(scene.includes(`底层占位-${index + 1}-1`), false, `${segmentId} must not backfill source placeholders`);
    for (let factIndex = 0; factIndex < count; factIndex++) {
      assert.ok(scene.includes(`批准标签-${index + 1}-${factIndex + 1}`));
      assert.ok(scene.includes(`批准事实-${index + 1}-${factIndex + 1}`));
    }
  });
  assert.doesNotMatch(documentHtml, />重点<|>方法<|>结果</);

  const motionDirection = normalizeMotionDirection({
    sampleStart: 0,
    sampleDuration: 12,
    strongestSegmentId: "F01",
    choreography: [{
      order: 1,
      at: 0.6,
      segmentId: "F01",
      target: "visual",
      actionPreset: "reveal-right",
      easing: "power3.out",
      purpose: "零事实卡时不得制造空主视觉",
    }],
  }, factBreakdown, { outputDuration: 12, keyframeDirection: direction });
  const sampleProject = await renderFixtureProject(t, "sample", direction, {
    breakdown: factBreakdown,
    rangeEnd: 12,
    motionDirection,
  });
  const sampleHtml = fs.readFileSync(sampleProject.indexPath, "utf8");
  const zeroFactScene = sceneHtml(sampleHtml, "F01", "F02");
  assert.equal(zeroFactScene.includes('<section class="visual-panel'), false);
  assert.equal(sampleHtml.includes('#scene-F01 .visual-panel'), false);
  const sampleManifest = JSON.parse(fs.readFileSync(sampleProject.manifestPath, "utf8"));
  assert.equal(sampleManifest.appliedChoreography.some(item => item.segmentId === "F01" && item.target === "visual"), false);
  assert.ok(sampleManifest.unappliedChoreography.some(item => item.segmentId === "F01" && item.target === "visual" && item.reason === "missing-dom-target"));
});

test("unselected prompt and comparison scenes stay audience-facing in sample and full", async t => {
  const inheritBreakdown = normalizeContentBreakdown({
    summary: "未选中关键帧继承合同",
    segments: [
      {
        id: "U01",
        sourceTime: { start: 0, end: 3 },
        editedTime: { start: 0, end: 3 },
        upperLeftTitle: "普通信息段",
        subtitleOrKeyLine: "不启用特殊主视觉",
        oneSentenceSummary: "这一段只展示原始事实。",
        factCards: [
          { label: "事实一", value: "保留原文一" },
          { label: "事实二", value: "保留原文二" },
          { label: "事实三", value: "保留原文三" },
        ],
        rightVisual: { type: "二维信息动效", description: "展示三项原始事实" },
      },
      {
        id: "U02",
        sourceTime: { start: 3, end: 6 },
        editedTime: { start: 3, end: 6 },
        upperLeftTitle: "真实输入",
        subtitleOrKeyLine: "只展示说过的内容",
        oneSentenceSummary: "输入框只承载真实口播。",
        factCards: [
          { label: "目标", value: "拍完自动处理" },
          { label: "限制", value: "不懂剪辑" },
          { label: "审核", value: "自己确认结果" },
        ],
        rightVisual: { type: "AI输入框二维动效", description: "展示真实输入与三个限制" },
      },
      {
        id: "U03",
        sourceTime: { start: 6, end: 9 },
        editedTime: { start: 6, end: 9 },
        upperLeftTitle: "处理方式对比",
        subtitleOrKeyLine: "对比必须沿用原始事实",
        oneSentenceSummary: "比较两种已经明确说明的处理方式。",
        factCards: [
          { label: "旧方式", value: "手工添加字幕" },
          { label: "共同目标", value: "完成口播视频" },
          { label: "新方式", value: "工作台生成字幕" },
        ],
        rightVisual: { type: "前后状态对照动效", description: "按事实卡做处理方式对比" },
      },
    ],
  }, {
    sourceDuration: 9,
    outputDuration: 9,
    minimumSegments: 3,
    maximumSegments: 3,
  });
  const direction = normalizeKeyframeDirection({
    presentation,
    selectedSegmentIds: ["U01"],
    frames: [{
      segmentId: "U01",
      sourceTime: 1.5,
      visualIntent: {
        factCards: inheritBreakdown.segments[0].factCards,
        primaryVisual: { kind: "inherit", lines: [], text: "", highlights: [] },
      },
    }],
  }, inheritBreakdown, 3);

  for (const mode of ["sample", "full"]) {
    const project = await renderFixtureProject(t, mode, direction, { breakdown: inheritBreakdown });
    const documentHtml = fs.readFileSync(project.indexPath, "utf8");
    assertNoInternalLabels(documentHtml);
    for (const forbidden of ["第一版", "返修版", "AI 工具", "现在只做", "迈出第一步"]) {
      assert.equal(documentHtml.includes(forbidden), false, `${mode} leaked hard-coded semantic copy: ${forbidden}`);
    }

    const promptScene = sceneHtml(documentHtml, "U02", "U03");
    const promptText = visibleText(visualPanelHtml(promptScene));
    assert.match(promptScene, /class="scene clip[^\"]*audience-facing[^\"]*primary-inherit/);
    assert.ok(promptText.includes("输入内容"));
    assert.ok(promptText.includes("拍完自动处理"));
    assert.ok(promptText.includes("自己确认结果"));

    const comparisonScene = sceneHtml(documentHtml, "U03");
    const comparisonText = visibleText(visualPanelHtml(comparisonScene));
    assert.match(comparisonScene, /class="scene clip[^\"]*audience-facing[^\"]*primary-inherit/);
    assert.ok(comparisonText.includes("旧方式"));
    assert.ok(comparisonText.includes("手工添加字幕"));
    assert.ok(comparisonText.includes("新方式"));
    assert.ok(comparisonText.includes("工作台生成字幕"));
  }
});

test("generic comparison wording does not infer the AI tools to first-step visual", () => {
  const comparisonBreakdown = normalizeContentBreakdown({
    segments: [
      {
        id: "C01",
        sourceTime: { start: 0, end: 3 },
        editedTime: { start: 0, end: 3 },
        upperLeftTitle: "画幅选择",
        factCards: [
          { label: "横屏", value: "展示工作台" },
          { label: "竖屏", value: "适配抖音" },
          { label: "原则", value: "按内容决定" },
        ],
        rightVisual: { type: "画幅卡片", description: "横屏和竖屏并列展示" },
      },
      { id: "C02", sourceTime: { start: 3, end: 6 }, editedTime: { start: 3, end: 6 } },
      { id: "C03", sourceTime: { start: 6, end: 9 }, editedTime: { start: 6, end: 9 } },
    ],
  }, {
    sourceDuration: 9,
    outputDuration: 9,
    minimumSegments: 3,
    maximumSegments: 3,
  });
  const direction = normalizeKeyframeDirection({
    selectedSegmentIds: ["C01"],
    frames: [{ segmentId: "C01", sourceTime: 1.5, composition: "展示横屏与竖屏对比" }],
  }, comparisonBreakdown, 3);

  assert.equal(direction.frames[0].visualIntent.primaryVisual.kind, "inherit");
});

test("motion choreography infers segments from nonzero sample-relative time", () => {
  const offsetBreakdown = normalizeContentBreakdown({
    segments: [
      { id: "O01", sourceTime: { start: 0, end: 10 }, editedTime: { start: 0, end: 10 } },
      { id: "O02", sourceTime: { start: 10, end: 20 }, editedTime: { start: 10, end: 20 } },
      { id: "O03", sourceTime: { start: 20, end: 30 }, editedTime: { start: 20, end: 30 } },
    ],
  }, { sourceDuration: 30, outputDuration: 30, minimumSegments: 3, maximumSegments: 3 });
  const direction = normalizeMotionDirection({
    sampleStart: 10,
    sampleDuration: 15,
    strongestSegmentId: "O01",
    choreography: [
      { order: 1, at: 2.5, target: "title", actionPreset: "fade-up" },
      { order: 2, at: 12, target: "summary", actionPreset: "slide-left" },
      { order: 3, at: 15, target: "visual", actionPreset: "push-in" },
    ],
  }, offsetBreakdown, { outputDuration: 30, durationSeconds: 15 });

  assert.equal(direction.sampleStart, 10);
  assert.equal(direction.strongestSegmentId, "O02", "strongest fallback must stay inside the sample");
  assert.equal(direction.choreography[0].segmentId, "O02");
  assert.equal(direction.choreography[0].at, 2.5, "at must stay relative to sampleStart");
  assert.equal(direction.choreography[1].segmentId, "O03");
  assert.equal(direction.choreography[2].segmentId, "O03", "sampleEnd must bind to the last overlapping segment");
});

test("configured sample duration overrides a shorter model suggestion", () => {
  const direction = normalizeMotionDirection({
    sampleStart: 0,
    sampleDuration: 15.86,
  }, { segments: [] }, {
    outputDuration: 20,
    durationSeconds: 20,
  });

  assert.equal(direction.durationSeconds, 20);
  assert.equal(direction.sampleEnd, 20);
});

test("fallback choreography omits fact beats that do not exist in approved keyframes", () => {
  const sparseBreakdown = normalizeContentBreakdown({
    segments: [
      { id: "Z01", sourceTime: { start: 0, end: 7 }, editedTime: { start: 0, end: 7 }, factCards: [{ label: "一", value: "1" }, { label: "二", value: "2" }, { label: "三", value: "3" }] },
      { id: "Z02", sourceTime: { start: 7, end: 14 }, editedTime: { start: 7, end: 14 }, factCards: [{ label: "一", value: "1" }] },
      { id: "Z03", sourceTime: { start: 14, end: 20 }, editedTime: { start: 14, end: 20 }, factCards: [] },
    ],
  }, { sourceDuration: 20, outputDuration: 20, minimumSegments: 3, maximumSegments: 3 });
  const keyframeDirection = normalizeKeyframeDirection({
    selectedSegmentIds: ["Z01", "Z02", "Z03"],
    frames: [
      { segmentId: "Z01", visualIntent: { factCards: [{ label: "批准", value: "只留一张" }], primaryVisual: { kind: "inherit" } } },
      { segmentId: "Z02", visualIntent: { factCards: [], primaryVisual: { kind: "inherit" } } },
      { segmentId: "Z03", visualIntent: { factCards: [], primaryVisual: { kind: "inherit" } } },
    ],
  }, sparseBreakdown, 3);
  const direction = normalizeMotionDirection({}, sparseBreakdown, { outputDuration: 20, durationSeconds: 20, keyframeDirection });

  assert.deepEqual(direction.choreography.filter(item => item.segmentId === "Z01" && /^fact-/.test(item.target)).map(item => item.target), ["fact-1"]);
});

test("specific fact beats supersede a generic facts beat in the same segment", () => {
  const direction = normalizeMotionDirection({
    sampleStart: 0,
    sampleDuration: 9,
    choreography: [
      { order: 1, at: 1.2, segmentId: "S01", target: "facts", actionPreset: "pop" },
      { order: 2, at: 1.7, segmentId: "S01", target: "fact-2", factIndex: 2, actionPreset: "slide-left" },
    ],
  }, breakdown, { outputDuration: 9 });

  assert.equal(direction.choreography.some(item => item.target === "facts"), false);
  assert.equal(direction.choreography.some(item => item.target === "fact-2"), true);
});

test("duplicate targets and speaker beats normalize deterministically", () => {
  const direction = normalizeMotionDirection({
    sampleStart: 0,
    sampleDuration: 9,
    choreography: [
      { order: 7, at: 0.9, segmentId: "S01", target: "title", actionPreset: "slide-right" },
      { order: 2, at: 0.4, segmentId: "S01", target: "title", actionPreset: "slide-left" },
      { order: 2, at: 1.4, segmentId: "S01", target: "summary", actionPreset: "fade-up" },
      { order: 9, at: 3, target: "speaker", actionPreset: "fade" },
      { order: 1, at: 1, target: "speaker", actionPreset: "pop" },
    ],
  }, breakdown, { outputDuration: 9 });

  assert.deepEqual(direction.choreography.map(item => item.order), [1, 2, 3]);
  assert.equal(direction.choreography.filter(item => item.target === "title").length, 1);
  assert.equal(direction.choreography.find(item => item.target === "title")?.actionPreset, "slide-left");
  assert.equal(direction.choreography.filter(item => item.target === "speaker").length, 1);
  assert.equal(direction.choreography.find(item => item.target === "speaker")?.actionPreset, "pop");
});

test("late speaker fade is normalized to a truthful visible push-in", () => {
  const direction = normalizeMotionDirection({
    sampleStart: 0,
    sampleDuration: 9,
    choreography: [{ order: 1, at: 2, target: "speaker", actionPreset: "fade" }],
  }, breakdown, { outputDuration: 9 });

  assert.equal(direction.choreography[0].actionPreset, "push-in");
});

test("early speaker fade preserves the first scene graphic-focus pose", async t => {
  const motionDirection = normalizeMotionDirection({
    sampleStart: 0,
    sampleDuration: 3,
    segmentLayouts: [{ segmentId: "S01", mode: "graphic-focus" }],
    choreography: [{ order: 1, at: 0, target: "speaker", actionPreset: "fade", easing: "sine.out" }],
  }, breakdown, { outputDuration: 9, durationSeconds: 3 });
  const project = await renderFixtureProject(t, "sample", normalizeKeyframeDirection(rawDirection, breakdown, 3), {
    motionDirection,
    rangeEnd: 3,
  });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");

  assert.match(documentHtml, /tl\.fromTo\("#speakerStage",\{[^}]*"opacity":0[^}]*"scale":0\.42[^}]*\},\{"x":0,"y":0,"scale":0\.42,"opacity":1/);
});

test("late speaker choreography keeps the default visible entrance and uses a non-opacity camera beat", async t => {
  const motionDirection = normalizeMotionDirection({
    sampleStart: 0,
    sampleDuration: 9,
    choreography: [{
      order: 1,
      at: 2,
      target: "speaker",
      actionPreset: "slide-right",
      easing: "power2.out",
    }],
  }, breakdown, { outputDuration: 9 });
  const project = await renderFixtureProject(t, "sample", { presentation, frames: [] }, { motionDirection });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(project.manifestPath, "utf8"));
  const lateBeat = documentHtml.match(/tl\.fromTo\("#speakerStage",(\{[^}]*\}),\{[^}]*"immediateRender":false[^}]*\}, 2\.000\);/);

  assert.match(documentHtml, /tl\.from\("#speakerStage",\{[^}]*"opacity":0[^}]*\}, 0\.180\);/);
  assert.ok(lateBeat, "late speaker beat must be a seek-safe fromTo camera motion");
  assert.equal(lateBeat[1].includes("opacity"), false, "late speaker beat must not hide the person before its timestamp");
  assert.equal(manifest.appliedChoreography.find(item => item.target === "speaker")?.at, 2);
});

test("evidence choreography records its actual visual-led start", async t => {
  const motionDirection = normalizeMotionDirection({
    sampleStart: 0,
    sampleDuration: 9,
    choreography: [{
      order: 1,
      at: 4.5,
      segmentId: "S01",
      target: "visual",
      actionPreset: "push-in",
      easing: "power2.out",
    }],
  }, breakdown, { outputDuration: 9 });
  const project = await renderFixtureProject(t, "sample", { presentation, frames: [] }, {
    motionDirection,
    approvedAssets: [{
      id: "placement-constrained-evidence",
      sourceType: "local-derived",
      mediaKind: "image",
      path: sourceVideoFixture,
      placement: { start: 0, end: 1.2, mode: "broll" },
    }],
  });
  const documentHtml = fs.readFileSync(project.indexPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(project.manifestPath, "utf8"));
  const applied = manifest.appliedChoreography.find(item => item.selector === "#evidence-1");

  assert.equal(applied?.at, 0);
  assert.equal(applied?.actionPreset, "push-in");
  assert.equal(applied?.easing, "power2.out");
  assert.match(documentHtml, /tl\.from\("#evidence-1",\{[^}]*"ease":"power2\.out"[^}]*\}, 0\.000\);/);
  assert.match(documentHtml, /tl\.set\("#evidence-1",\{opacity:0\},1\.200\);/, "evidence exit must end with a seek-safe hard kill at the clip boundary");
});
