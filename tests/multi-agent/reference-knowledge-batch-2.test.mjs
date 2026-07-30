import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadAgentProfiles } from "../../video/multi-agent/contracts.mjs";
import { createMemoryService } from "../../video/multi-agent/memory.mjs";
import {
  candidateFingerprints,
  loadReferenceKnowledgeBatch,
  productionEligibleRecords,
} from "../../video/multi-agent/reference-knowledge-batch.mjs";
import { openDomainStore } from "../../video/multi-agent/store.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, "..", "..");
const batchIdPrefix = "%reference-knowledge-batch-2%";

test("reference knowledge batch 2 has reviewed sources, 18 unique candidates, and deterministic hashes", () => {
  const batch = loadReferenceKnowledgeBatch();
  const fullyReviewed = batch.sources.sources.filter(
    source => source.reviewStatus === "fully_reviewed_local_evidence"
  );
  const crossReviewed = batch.sources.sources.filter(
    source => ["reviewed_text", "caption_reviewed", "caption_reviewed_opening_only"].includes(source.reviewStatus)
  );

  assert.equal(fullyReviewed.length, 3);
  assert.ok(crossReviewed.length >= 9);
  assert.equal(batch.candidates.records.length, 18);
  assert.ok(batch.candidates.records.every(record => ["inbox", "extracted"].includes(record.status)));
  assert.ok(batch.candidates.records.every(record => record.productionEligible === false));

  const fingerprints = candidateFingerprints(batch);
  assert.equal(new Set(fingerprints.map(item => item.id)).size, fingerprints.length);
  assert.equal(new Set(fingerprints.map(item => item.fingerprint)).size, fingerprints.length);
  assert.deepEqual(productionEligibleRecords(batch), []);
});

test("every candidate is timecode-bound to reviewed evidence and carries originality limits", () => {
  const batch = loadReferenceKnowledgeBatch();
  const reviewedIds = new Set(
    batch.sources.sources
      .filter(source => source.reviewStatus === "fully_reviewed_local_evidence")
      .map(source => source.id)
  );

  for (const record of batch.candidates.records) {
    assert.ok(record.evidence.length > 0, record.id);
    assert.ok(record.evidence.every(item => reviewedIds.has(item.sourceId)), record.id);
    assert.ok(record.evidence.every(item => item.end > item.start), record.id);
    assert.match(record.originalAbstraction, /\S/, record.id);
    assert.ok(
      record.prohibitions.some(item => item.includes("copy source wording examples people assets palette or transition combinations")),
      record.id
    );
  }
});

test("inbox candidates remain invisible to default and candidate retrieval", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-reference-batch-2-"));
  const store = openDomainStore({
    dbPath: path.join(temporary, "memory.sqlite"),
    exportRoot: path.join(temporary, "library"),
  });
  t.after(() => store.close());
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const profiles = await loadAgentProfiles(repositoryRoot);
  const memory = createMemoryService(store, profiles, {
    clock: () => "2026-07-29T00:00:00.000Z",
  });
  const batch = loadReferenceKnowledgeBatch();

  for (const record of batch.candidates.records) memory.ingest(record);
  for (const profile of profiles) {
    assert.deepEqual(memory.retrieve({ agentId: profile.agentId, query: {} }), []);
    assert.deepEqual(memory.retrieve({ agentId: profile.agentId, query: {}, includeCandidate: true }), []);
  }
});

test("the production memory database contains zero records from reference batch 2", () => {
  const databaseFile = path.join(repositoryRoot, "data", "multi-agent", "runtime", "memory.sqlite");
  if (!fs.existsSync(databaseFile)) return;
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT COUNT(*) AS count
      FROM records
      WHERE id LIKE ? OR json LIKE ?
    `).get(batchIdPrefix, batchIdPrefix);
    assert.equal(Number(row.count), 0);
  } finally {
    database.close();
  }
});
