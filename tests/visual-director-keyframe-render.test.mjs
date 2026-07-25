import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildHyperframesDirectorProject,
  findLockedVisualIntentConflict,
  normalizeContentBreakdown,
  normalizeFullDirection,
  normalizeKeyframeDirection,
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
  return buildHyperframesDirectorProject({
    projectDir: path.join(root, mode),
    sourceVideo: sourceVideoFixture,
    sourceAudio: null,
    breakdown,
    styleReport,
    mode,
    rangeStart: 0,
    rangeEnd: 9,
    keyframeDirection,
    fullDirection: options.fullDirection || null,
    captions: [],
    approvedAssets: options.approvedAssets || [],
    renderSpec: { width: 1920, height: 1080, fps: 30 },
    promptSnapshot: { stage: mode, feedback: "回归测试" },
  });
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
