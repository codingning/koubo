import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandConfigPath = path.join(root, "config", "creator_brand.json");
const brandTemplatePath = path.join(root, "video", "brand", "sanjin-ip-sting-v2.html");
const sonicLogoPath = path.join(
  root,
  "video",
  "brand",
  "audio",
  "sanjin-ip-sonic-v2.wav",
);
const creatorProfilePath = path.join(root, "docs", "CREATOR_PROFILE.md");
const sampleIndexPath = path.join(
  root,
  "videos",
  "douyin-obsidian-old-favorite-proof-v1",
  "index.html",
);
const sampleAudioMetaPath = path.join(
  root,
  "videos",
  "douyin-obsidian-old-favorite-proof-v1",
  "audio_meta.json",
);
const sampleVoiceTimelinePath = path.join(
  root,
  "videos",
  "douyin-obsidian-old-favorite-proof-v1",
  "voice-input",
  "expressive-v2",
  "timeline.json",
);

test("Sanjin IP sting v2 stays the approved post-opening default", () => {
  const config = JSON.parse(fs.readFileSync(brandConfigPath, "utf8"));
  const sting = config.defaultIpSting;

  assert.equal(config.status, "user-approved-default");
  assert.equal(config.creatorName, "三金");
  assert.equal(config.channelName, "三金AI实战");
  assert.equal(config.brandCore, "从知道到做到");
  assert.equal(sting.enabled, true);
  assert.equal(sting.placement, "after-opening-segment");
  assert.equal(sting.startAnchor, "opening-segment-end");
  assert.equal(sting.durationSeconds, 3);
  assert.equal(sting.keepCaptionsAbove, true);
  assert.equal(sting.overlayTrackIndex, 5);
  assert.equal(sting.templatePath, "video/brand/sanjin-ip-sting-v2.html");
  assert.equal(sting.sonicLogoPath, "video/brand/audio/sanjin-ip-sonic-v2.wav");
  assert.equal(sting.contentPromise, "把AI知识做成真实结果");
  assert.ok(fs.existsSync(brandTemplatePath));
  assert.ok(fs.existsSync(sonicLogoPath));
});

test("content-first cover v3 uses real footage and conflict copy without a brand badge", () => {
  const config = JSON.parse(fs.readFileSync(brandConfigPath, "utf8"));
  const cover = config.defaultCoverTemplate;

  assert.equal(cover.id, "content-first-real-person-conflict-cover-v3");
  assert.equal(cover.status, "user-directed-current-candidate");
  assert.equal(cover.contentRules.headlineMaxLines, 2);
  assert.equal(cover.contentRules.realPersonFullFramePreferred, true);
  assert.equal(cover.contentRules.separateCoverSourceAllowed, true);
  assert.equal(cover.contentRules.brandSignature, false);
  assert.equal(cover.contentRules.generatedHumanPortraits, false);
  assert.equal(cover.safeArea.gridCrop.width, 1080);
  assert.equal(cover.safeArea.gridCrop.height, 1440);
  assert.match(cover.researchBasis, /douyin-profile-cover-study/u);
});

test("canonical sting and creator profile preserve the visible identity", () => {
  const template = fs.readFileSync(brandTemplatePath, "utf8");
  const profile = fs.readFileSync(creatorProfilePath, "utf8");

  assert.match(template, /data-composition-id="sanjin-ip-sting-v2"/u);
  assert.match(template, />三金</u);
  assert.match(template, />AI 实战</u);
  assert.match(template, /做成真实结果/u);
  assert.match(template, /真实问题 · 真实执行 · 真实结果/u);
  assert.match(profile, /本期作者：三金/u);
  assert.match(profile, /完整播完第一段/u);
  assert.match(profile, /config\/creator_brand\.json/u);
});

test("current episode inserts the three-second sting after the opening segment", () => {
  const index = fs.readFileSync(sampleIndexPath, "utf8");
  const audioMeta = JSON.parse(fs.readFileSync(sampleAudioMetaPath, "utf8"));
  const voiceTimeline = JSON.parse(fs.readFileSync(sampleVoiceTimelinePath, "utf8"));
  const host = index.match(
    /<div[^>]+data-composition-id="sanjin-ip-sting-v2"[^>]+><\/div>/u,
  )?.[0];

  assert.ok(host, "current episode must mount the v2 IP sting");
  assert.match(host, /data-start="5\.5"/u);
  assert.match(host, /data-duration="3"/u);
  assert.match(host, /data-track-index="5"/u);
  assert.match(index, /data-composition-id="captions-scene-01"[^>]+data-track-index="6"/u);
  assert.match(index, /data-composition-id="scene-01-hook"[^>]+data-start="0"[^>]+data-duration="5\.5"/u);
  assert.match(index, /data-composition-id="scene-02-old-favorite"[^>]+data-start="8\.5"/u);
  assert.match(index, /id="voice-02"[^>]+data-start="8\.5"/u);
  assert.match(index, /id="sanjin-sonic-v2"[^>]+data-start="5\.5"[^>]+data-duration="2\.61"/u);
  assert.match(index, /data-composition-id="main"[^>]+data-duration="93"/u);
  assert.equal(audioMeta.voices[1].start, 8.5);
  assert.equal(audioMeta.totalDuration_s, 93);
  assert.equal(voiceTimeline.segments[1].start, 8.5);
  assert.equal(voiceTimeline.scenes[1].start, 8.5);
  assert.equal(voiceTimeline.totalDuration, 93);
});
