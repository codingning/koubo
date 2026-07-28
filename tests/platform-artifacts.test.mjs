import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAssetAnchor, resolveAssetAnchor } from "../video/assets/anchors.mjs";
import { createReferenceDistillation, validateReferenceDistillation } from "../video/research/reference_distillation.mjs";
import { buildStoryboard, storyboardMarkdown } from "../video/storyboard.mjs";
import { buildVideoRetro } from "../video/retro.mjs";
import { loadShotRegistry, selectShot } from "../video/shots/registry.mjs";
import { normalizeCaptureSpec, normalizeCaptureUrl } from "../video/shots/pagecam.mjs";
import { buildSoundMixPlan, normalizeSoundDesign, soundDesignIssues } from "../video/audio/production.mjs";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("workbench keeps universal drafts isolated per workspace", () => {
  const source = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
  assert.match(source, /persisted\.workspaces/);
  assert.match(source, /function currentWorkspaceState/);
  assert.match(source, /contentDraft: \{ direction: "", evidenceSummary: "" \}/);
  assert.match(source, /workspace\.contentProfile = \{ \.\.\.workspace\.contentProfile, \.\.\.profile \}/);
});

test("semantic and hybrid anchors relocate inside stable segments", () => {
  const segments = [{ segmentId: "s1", outputStart: 5, outputEnd: 12 }];
  assert.deepEqual(resolveAssetAnchor({ type: "semantic", segmentId: "s1", offsetStart: 1, offsetEnd: 4 }, segments, 20), { start: 6, end: 9, anchorType: "semantic", segmentId: "s1" });
  assert.deepEqual(resolveAssetAnchor({ type: "hybrid", segmentId: "s1", start: 7, end: 15 }, segments, 20), { start: 7, end: 12, anchorType: "hybrid", segmentId: "s1" });
  assert.equal(normalizeAssetAnchor({ type: "semantic" }), null);
});

test("reference distillation keeps evidence and explicit uncertainty", () => {
  const value = createReferenceDistillation({
    topicPlan: { topic: "如何介绍一杯咖啡" },
    research: { fullContentSources: [{ id: "v1", url: "https://example.test/v1", title: "Coffee", uncertainties: ["BGM 许可未知"] }] },
  });
  assert.equal(value.sourceCount, 1);
  assert.deepEqual(value.sources[0].uncertainties, ["BGM 许可未知"]);
  assert.equal(validateReferenceDistillation(value).ok, true);
});

test("storyboard and retro are derived artifacts without approval power", () => {
  const storyboard = buildStoryboard({ jobId: "job-1", version: 2, breakdown: { segments: [{ segmentId: "s1", outputStart: 0, outputEnd: 4, title: "开场" }] } });
  assert.equal(storyboard.authority, "derived-from-json");
  assert.match(storyboardMarkdown(storyboard), /不要从本文件反写/);
  const retro = buildVideoRetro({ job: { id: "job-1" }, version: 2, observations: ["字幕略快"] });
  assert.equal(retro.autoPromote, false);
  assert.equal(retro.observations[0].promotionEligible, false);
});

test("shot registry blocks trial shots from production selection", () => {
  const registry = loadShotRegistry(path.join(root, "config", "shot_registry.json"));
  assert.equal(registry.shots.length, 6);
  assert.throws(() => selectShot(registry, "pagecam-overview"), /尚未通过/);
  assert.equal(selectShot(registry, "pagecam-overview", { allowTrial: true }).renderer, "hyperframes");
});

test("PageCam defaults to local-only capture and normalizes element contracts", () => {
  assert.equal(normalizeCaptureUrl("http://127.0.0.1:8787/"), "http://127.0.0.1:8787/");
  assert.throws(() => normalizeCaptureUrl("https://example.com"), /本机页面/);
  const spec = normalizeCaptureSpec({ url: "http://localhost:8787", width: 99999, selectors: [{ id: "Hero title", selector: "#hero-topic" }] });
  assert.equal(spec.width, 3840);
  assert.deepEqual(spec.selectors[0], { id: "Hero-title", selector: "#hero-topic" });
});

test("sound production is executable but fails closed before trial approval", () => {
  const design = normalizeSoundDesign({ enabled: true, cues: [{ id: "ping", path: "Z:/missing.wav", at: 1.2, gain: 0.25, licenseBasis: "local-programmatic", semanticReason: "确认动作" }] }, { semanticSfx: { maxCues: 12 } });
  assert.match(soundDesignIssues(design, { productionEnabled: false }).join("；"), /仍处于 trial/);
  const plan = buildSoundMixPlan({ ...design, cues: [] });
  assert.match(plan.filterComplex, /amix=inputs=1/);
});
