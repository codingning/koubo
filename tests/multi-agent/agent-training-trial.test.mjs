import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyAgentTrainingTrialBatch,
  AGENT_TRAINING_TRIAL_HASHING,
  buildAgentTrainingHumanRecords,
  loadAgentTrainingTrialCatalog,
  validateAgentTrainingReview,
} from "../../video/multi-agent/agent-training-trial.mjs";
import { contentHash, loadAgentProfiles } from "../../video/multi-agent/contracts.mjs";
import { createMemoryService } from "../../video/multi-agent/memory.mjs";
import { openDomainStore } from "../../video/multi-agent/store.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDir, "..", "..");
const reviewFixture = path.join(repositoryRoot, "tests", "fixtures", "agent-training-batch-1-review.json");
const catalogFixture = path.join(
  repositoryRoot,
  "config",
  "multi-agent",
  "trials",
  "agent-training-batch-1",
  "trial-catalog.v3.json",
);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fixedClock(start = "2026-07-25T00:20:00.000Z") {
  let tick = 0;
  return () => new Date(Date.parse(start) + tick++ * 1000).toISOString();
}

function withCatalogHash(catalog) {
  const value = structuredClone(catalog);
  delete value.catalogHash;
  value.catalogHash = contentHash(value);
  return value;
}

test("trial catalog pins 12 reviewed candidates and three v1 to v2 revisions", () => {
  const { catalog, records } = loadAgentTrainingTrialCatalog({ repositoryRoot });

  assert.equal(records.length, 12);
  assert.equal(catalog.id, "agent-training-batch-1-trial-catalog.v3");
  assert.match(catalog.technicalCatalogHash, /^[a-f0-9]{64}$/);
  assert.equal(catalog.sourceReview.decisionHash, "2631d1e130643b65e62d71e8c04724e51426447a1a8c0c411a85f86333d00a89");
  assert.equal(catalog.resolution.decisionHash, "b0df2da07851ef64ee737afb4b438e1cef0f34b31bd755af0b2a8782cefdba5b");
  assert.deepEqual(catalog.resolution.revisedItems.map(item => item.code), ["M3", "S2", "S3"]);
  assert.equal(records.every(item => item.record.status === "trial"), true);
  assert.equal(records.every(item => /^[a-f0-9]{64}$/.test(item.record.contentHash)), true);
  assert.equal(records.every(item => /^[a-f0-9]{64}$/.test(item.trialCandidate.technicalContentHash)), true);
  assert.equal(records.find(item => item.code === "M3").record.id, "director-technique.plan-preview-promote-gates.v2");
  assert.equal(records.find(item => item.code === "S2").record.id, "sound-technique.speech-aware-ducking.v2");
  assert.equal(records.find(item => item.code === "S3").record.id, "sound-technique.semantic-sfx-cue.v2");
  assert.equal(records.some(item => item.record.id === "sound-technique.speech-aware-ducking.v1"), false);
  assert.equal(records.filter(item => item.record.domain === "content").length, 3);
  assert.equal(records.filter(item => item.record.domain === "director").length, 4);
});

test("technical catalog hash binds complete trial record semantics", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-agent-training-catalog-tamper-"));
  const catalogFile = path.join(
    root,
    "config",
    "multi-agent",
    "trials",
    "agent-training-batch-1",
    "trial-catalog.v3.json",
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const source = readJson(catalogFixture);
  source.items[0].record.parameters.primaryAudienceRequired = false;
  const tampered = withCatalogHash(source);
  fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
  fs.writeFileSync(catalogFile, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

  assert.throws(
    () => loadAgentTrainingTrialCatalog({ repositoryRoot: root, catalogFile }),
    /technical content hash/
  );
});

test("technical and human decision hashes have separate stable scopes", () => {
  const catalog = readJson(catalogFixture);
  const technicalBefore = contentHash(AGENT_TRAINING_TRIAL_HASHING.technicalCatalogCore(catalog));
  const resolutionBefore = contentHash(AGENT_TRAINING_TRIAL_HASHING.resolutionDecisionCore(catalog));

  const metadataOnly = structuredClone(catalog);
  metadataOnly.id = "metadata-only-catalog-change";
  metadataOnly.authority.productionDefaultChanged = true;
  metadataOnly.items[0].record.createdAt = "2030-01-01T00:00:00.000Z";
  metadataOnly.items[0].record.createdBy = { type: "controller", id: "metadata-test" };
  metadataOnly.items[0].record.status = "recreated";
  assert.equal(
    contentHash(AGENT_TRAINING_TRIAL_HASHING.technicalCatalogCore(metadataOnly)),
    technicalBefore,
  );

  const technicalChange = structuredClone(catalog);
  technicalChange.items[0].record.parameters.primaryAudienceRequired = false;
  assert.notEqual(
    contentHash(AGENT_TRAINING_TRIAL_HASHING.technicalCatalogCore(technicalChange)),
    technicalBefore,
  );
  technicalChange.technicalCatalogHash = "f".repeat(64);
  assert.equal(
    contentHash(AGENT_TRAINING_TRIAL_HASHING.resolutionDecisionCore(technicalChange)),
    resolutionBefore,
  );
});

test("human review and follow-up resolution are hash-bound and trial-only", () => {
  const { catalog } = loadAgentTrainingTrialCatalog({ repositoryRoot });
  const review = readJson(reviewFixture);
  const validated = validateAgentTrainingReview(review, catalog);
  assert.equal(validated.decisionHash, catalog.sourceReview.decisionHash);

  const records = buildAgentTrainingHumanRecords({
    review,
    reviewFileSha256: "f".repeat(64),
    catalog,
    actor: { type: "human", id: "koubo-owner" },
    recordedAt: "2026-07-25T00:20:00.000Z",
  });
  assert.match(records.reviewRecord.recordHash, /^[a-f0-9]{64}$/);
  assert.match(records.resolutionRecord.recordHash, /^[a-f0-9]{64}$/);
  assert.equal(records.resolutionRecord.resolutionDecisionHash, catalog.resolution.decisionHash);
  assert.equal(records.resolutionRecord.reviewExperience.ruleTextReviewRequired, false);
  assert.equal(records.resolutionRecord.reviewExperience.nextHumanReview, "real_clip_outcome");
  assert.deepEqual(records.reviewRecord.authority, {
    trialAdmissionOnly: true,
    approved: false,
    promoted: false,
    productionDefaultChanged: false,
    publishAuthority: false,
  });

  const tampered = structuredClone(review);
  tampered.items[0].contentHash = "0".repeat(64);
  assert.throws(
    () => validateAgentTrainingReview(tampered, catalog),
    /does not match|decision hash/
  );
});

test("batch application is atomic, immutable and retrieves trial memory only when requested", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-agent-training-trial-"));
  const outputRoot = path.join(root, "batch");
  let store;
  t.after(() => {
    try { store?.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await applyAgentTrainingTrialBatch({
    repositoryRoot,
    reviewFile: reviewFixture,
    outputRoot,
    clock: fixedClock(),
  });
  assert.equal(result.itemCount, 12);
  assert.equal(result.productionApproval, false);
  assert.equal(result.memoryPromotion, false);
  assert.equal(result.publishAuthority, false);
  assert.equal(fs.existsSync(path.join(outputRoot, "human-review-record.json")), true);
  assert.equal(fs.existsSync(path.join(outputRoot, "human-revision-resolution.json")), true);
  assert.equal(fs.readFileSync(path.join(outputRoot, "trial-catalog-snapshot.json")).equals(fs.readFileSync(catalogFixture)), true);

  const manifest = readJson(path.join(outputRoot, "trial-batch-manifest.json"));
  assert.equal(manifest.itemCount, 12);
  assert.equal(manifest.technicalCatalogHash, loadAgentTrainingTrialCatalog({ repositoryRoot }).catalog.technicalCatalogHash);
  assert.match(manifest.catalogFileSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.items.every(item => item.transitions.length === 3), true);
  assert.equal(manifest.items.some(item => item.recordId === "director-technique.plan-preview-promote-gates.v1"), false);
  assert.equal(manifest.items.some(item => item.recordId === "director-technique.plan-preview-promote-gates.v2"), true);

  store = openDomainStore({
    dbPath: path.join(outputRoot, "runtime", "memory.sqlite"),
    exportRoot: path.join(outputRoot, "library"),
    clock: fixedClock("2026-07-25T01:00:00.000Z"),
  });
  const profiles = await loadAgentProfiles(repositoryRoot);
  const memory = createMemoryService(store, profiles, { clock: fixedClock("2026-07-25T01:10:00.000Z") });

  assert.equal(store.list("technique-card", { status: "trial" }).length, 12);
  assert.equal(store.list("technique-card", { status: "approved" }).length, 0);
  assert.equal(store.list("technique-card", { status: "promoted" }).length, 0);
  assert.deepEqual(memory.retrieve({ agentId: "content-strategist" }), []);
  const contentCandidates = memory.retrieve({ agentId: "content-strategist", includeCandidate: true });
  assert.deepEqual(contentCandidates.map(item => item.id).sort(), [
    "content-principle.one-primary-audience-payoff.v1",
    "content-principle.opening-creates-audience-contract.v1",
    "content-principle.voice-source-before-verbatim-draft.v1",
  ]);
  const soundCandidates = memory.retrieve({ agentId: "sound-agent", includeCandidate: true });
  assert.equal(soundCandidates.some(item => item.id === "sound-technique.speech-aware-ducking.v2"), true);
  assert.equal(soundCandidates.some(item => item.id === "sound-technique.speech-aware-ducking.v1"), false);

  const latest = manifest.items.find(item => item.code === "S2");
  const rollback = memory.rollback(latest.rollbackTransitionId);
  assert.equal(rollback.record.status, "recreated");
  assert.equal(store.list("technique-card", { status: "trial" }).length, 11);

  await assert.rejects(
    () => applyAgentTrainingTrialBatch({
      repositoryRoot,
      reviewFile: reviewFixture,
      outputRoot,
      clock: fixedClock(),
    }),
    /already exists/
  );
});

test("invalid review leaves no partial batch or staging directory", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-agent-training-invalid-"));
  const outputRoot = path.join(root, "batch");
  const badReview = path.join(root, "bad-review.json");
  const payload = readJson(reviewFixture);
  payload.items[5].decision = "retain_for_real_clip_trial";
  fs.writeFileSync(badReview, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () => applyAgentTrainingTrialBatch({
      repositoryRoot,
      reviewFile: badReview,
      outputRoot,
      clock: fixedClock(),
    }),
    /does not match|decision hash/
  );
  assert.equal(fs.existsSync(outputRoot), false);
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith(".tmp")), []);
});

test("failure after partial transitions removes the whole staging batch", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-agent-training-fault-"));
  const outputRoot = path.join(root, "batch");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () => applyAgentTrainingTrialBatch({
      repositoryRoot,
      reviewFile: reviewFixture,
      outputRoot,
      clock: fixedClock(),
      onItemApplied({ code }) {
        if (code === "M2") throw new Error("injected failure after partial transitions");
      },
    }),
    /injected failure/
  );
  assert.equal(fs.existsSync(outputRoot), false);
  assert.equal(fs.readdirSync(root).some(name => name.endsWith(".tmp")), false);
});
