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
  assert.equal(decision.visualIntentConflict, null);
});
