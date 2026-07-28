import assert from "node:assert/strict";
import test from "node:test";

process.env.KOUBO_NO_LISTEN = "1";
const {
  captionText,
  closeServerResourcesForTests,
  hyperframesTrackVisible,
  masterDimensions,
  materializeHyperframesTemplate,
} = await import(`../video/server.mjs?hyperframes-overlay-dimensions=${Date.now()}`);

test.after(async () => {
  await closeServerResourcesForTests();
});

test("original layout uses displayed dimensions for rotated phone footage", () => {
  assert.deepEqual(masterDimensions({
    options: { layout: "original" },
    source: { width: 720, height: 1280, rotation: 90 },
  }), { width: 1280, height: 720 });
});

test("HyperFrames project adopts the actual master canvas", () => {
  const html = materializeHyperframesTemplate(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=1080, height=1920"><style>html, body { width: 1080px; height: 1920px; }</style></head><body><div data-width="1080" data-height="1920"></div></body></html>`, { width: 1280, height: 720 });
  assert.match(html, /data-koubo-layout="landscape"/);
  assert.match(html, /width=1280, height=720/);
  assert.match(html, /width: 1280px; height: 720px/);
  assert.match(html, /data-width="1280"/);
  assert.match(html, /data-height="720"/);
});

test("caption QA rejects transparent pixels outside the final canvas", () => {
  const dimensions = { width: 1280, height: 720 };
  assert.equal(hyperframesTrackVisible({
    width: 1080,
    height: 1920,
    alpha: true,
    alphaBounds: { x: 66, y: 1645, width: 951, height: 100, x2: 1016, y2: 1744 },
  }, dimensions), false);
  assert.equal(hyperframesTrackVisible({
    width: 1280,
    height: 720,
    alpha: true,
    alphaBounds: { x: 110, y: 620, width: 1060, height: 58, x2: 1169, y2: 677 },
  }, dimensions), true);
});

test("reviewed script corrects mixed Traditional and ASR homophones", () => {
  const script = "我用对话一版一版改出来的。我只交原片，看结果。就剪出了你现在看到的视频。下一步我想给它一条视频，看它能不能学会，而不是照搬内容。你最想让它学哪个视频呢？";
  assert.equal(captionText("你現在看到的是AI工作台重新剪輯後的版本。", script), "你现在看到的是AI工作台重新剪辑后的版本。");
  assert.equal(captionText("不碰時間線,可以嗎?", script), "不碰时间线，可以吗？");
  assert.equal(captionText("一板一板改出來的。", script), "一版一版改出来的。");
  assert.equal(captionText("我只教原片看结果。", script), "我只交原片，看结果。");
  assert.equal(captionText("就剪除了你現在看到的視頻。", script), "就剪出了你现在看到的视频。");
  assert.equal(captionText("看他能不能學會，而不是照辦內容。", script), "看它能不能学会，而不是照搬内容。");
  assert.equal(captionText("你最想讓他學哪個視頻呢？", script), "你最想让它学哪个视频呢？");
});
