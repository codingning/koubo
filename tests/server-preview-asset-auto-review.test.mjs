import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-preview-asset-review-"));
const assetPath = path.join(dataRoot, "local-derived.mp4");
fs.writeFileSync(assetPath, "fixture");
process.env.KOUBO_NO_LISTEN = "1";
process.env.KOUBO_MULTI_AGENT_DATA_ROOT = path.join(dataRoot, "multi-agent");

const serverModule = await import(`../video/server.mjs?preview-asset-review-test=${Date.now()}`);
const { closeServerResourcesForTests, previewAssetAutoReviewDecision } = serverModule;

test.after(async () => {
  await closeServerResourcesForTests();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

const job = {
  contentBreakdown: {
    segments: [{
      id: "S04",
      editedTime: { start: 3, end: 6 },
      rightVisual: { type: "备忘录操作演示", description: "展示具体记录动作" },
      factCards: [],
    }],
  },
  workflow: {
    stages: {
      keyframes: {
        artifacts: {
          direction: {
            frames: [{
              segmentId: "S04",
              visualIntent: {
                primaryVisual: {
                  kind: "memo-action",
                  lines: ["打开备忘录", "写下一件麻烦", "完成后告诉 AI"],
                },
              },
            }],
          },
        },
      },
    },
  },
};

test("preview auto review rejects a local asset that overlaps locked visual intent", () => {
  const decision = previewAssetAutoReviewDecision({
    id: "asset-conflict",
    sourceType: "local-derived",
    mediaKind: "video",
    path: assetPath,
    placement: { start: 3.4, end: 5.4, mode: "broll" },
  }, job);

  assert.equal(decision.approved, false);
  assert.equal(decision.reviewStatus, "rejected");
  assert.equal(decision.requiresUpdate, true);
  assert.equal(decision.visualIntentConflict?.segmentId, "S04");
  assert.equal(decision.visualIntentConflict?.kind, "memo-action");
  assert.match(decision.reason, /保留主视觉并跳过该素材/);
});

test("preview auto review still approves a non-conflicting local asset", () => {
  const decision = previewAssetAutoReviewDecision({
    id: "asset-clear",
    sourceType: "local-derived",
    mediaKind: "video",
    path: assetPath,
    placement: { start: 0.2, end: 2.4, mode: "broll" },
  }, job);

  assert.equal(decision.approved, true);
  assert.equal(decision.reviewStatus, "approved");
  assert.equal(decision.requiresUpdate, true);
  assert.equal(decision.visualIntentConflict, null);
});

test("preview auto review revokes an approved asset whose local file disappeared", () => {
  const decision = previewAssetAutoReviewDecision({
    id: "asset-stale-approved",
    sourceType: "local-derived",
    mediaKind: "video",
    path: path.join(dataRoot, "missing.mp4"),
    placement: { start: 0.2, end: 2.4, mode: "broll" },
    reviewStatus: "approved",
    approved: true,
  }, job, 8);

  assert.equal(decision.requiresUpdate, true);
  assert.equal(decision.approved, false);
  assert.equal(decision.reviewStatus, "rejected");
  assert.deepEqual(decision.complianceIssues, ["缺少可渲染的本地素材文件"]);
  assert.match(decision.reason, /撤销不可渲染素材/);
});

test("preview auto review leaves a still-valid approved local asset unchanged", () => {
  const decision = previewAssetAutoReviewDecision({
    id: "asset-still-valid",
    sourceType: "local-derived",
    mediaKind: "video",
    path: assetPath,
    placement: { start: 0.2, end: 2.4, mode: "broll" },
    reviewStatus: "approved",
    approved: true,
  }, job, 8);

  assert.equal(decision.requiresUpdate, false);
  assert.equal(decision.approved, true);
  assert.equal(decision.reviewStatus, "approved");
  assert.deepEqual(decision.complianceIssues, []);
});
