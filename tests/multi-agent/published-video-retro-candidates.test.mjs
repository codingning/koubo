import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(...segments) {
  return JSON.parse(fs.readFileSync(path.join(root, ...segments), "utf8"));
}

test("Douyin profile cover study remains research-only and inbox-only", () => {
  const sources = readJson("config", "multi-agent", "sources", "douyin-profile-cover-study-v1", "source-catalog.json");
  const candidates = readJson("config", "multi-agent", "candidates", "douyin-profile-cover-study-v1", "candidate-catalog.json");

  assert.equal(sources.productionEligible, false);
  assert.equal(sources.sources.length, 6);
  assert.equal(sources.sources.filter(item => item.platform === "douyin").every(item => item.reviewStatus === "visually_reviewed_live_profile_grid"), true);
  assert.equal(sources.sources.some(item => item.id === "project-user-cover-review-2026-07-30"), true);
  assert.equal(candidates.productionEligible, false);
  assert.equal(candidates.records.length, 3);
  assert.equal(candidates.records.every(item => item.status === "inbox"), true);
  assert.deepEqual(candidates.records.map(item => item.id), [
    "cover-technique.real-person-content-first.v1",
    "cover-technique.two-line-conflict-consequence.v1",
    "cover-technique.independent-four-ratio-layout.v1",
  ]);
});

test("published video retrospective records one-project evidence without promoting it", () => {
  const sources = readJson("config", "multi-agent", "sources", "published-video-retro-douyin-obsidian-v1", "source-catalog.json");
  const candidates = readJson("config", "multi-agent", "candidates", "published-video-retro-douyin-obsidian-v1", "candidate-catalog.json");
  const master = sources.sources.find(item => item.id === "douyin-obsidian-approved-master-v1");

  assert.equal(sources.productionEligible, false);
  assert.equal(master.mediaSha256, "37caabf2ac20cb9bc08e385d2fa6286f15f2ff3b9c549defc73fddbbc9074e7e");
  assert.match(master.outcomeBoundary, /have not been supplied/u);
  assert.equal(candidates.productionEligible, false);
  assert.equal(candidates.records.length, 9);
  assert.equal(candidates.records.every(item => item.status === "inbox"), true);
  assert.equal(candidates.records.some(item => item.status === "approved" || item.status === "promoted"), false);
  assert.equal(candidates.records.some(item => item.id === "cover-technique.real-person-conflict-multi-ratio-cover.v1"), true);
});
