import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contentHash } from "../../video/multi-agent/contracts.mjs";
import { openDomainStore } from "../../video/multi-agent/store.mjs";

function finalized(record) {
  const value = structuredClone(record);
  delete value.contentHash;
  value.contentHash = contentHash(value);
  return value;
}

function validTechnique(overrides = {}) {
  return finalized({
    id: "caption.pop.v1",
    schemaVersion: 1,
    createdAt: "2026-07-23T00:00:00.000Z",
    createdBy: { type: "agent", id: "tutorial-ingestor" },
    status: "inbox",
    source: {
      type: "local-tutorial",
      sourceId: "tutorial.sha256",
      author: "Koubo local fixture",
      license: "self-created",
    },
    evidence: [{ sourceId: "tutorial.sha256", kind: "video-time-range", start: 1.2, end: 3.4 }],
    applicability: ["spoken keyword emphasis"],
    prohibitions: ["do not cover the speaker face"],
    versions: {
      code: "test",
      model: "fixture",
      prompt: "extract-technique-v1",
      memory: "empty",
      asset: "none",
      recipe: "caption-pop-v1",
      evaluation: "rubric-v1",
    },
    domain: "caption",
    namespace: "caption.private",
    title: "关键词弹出",
    problem: "强调关键词",
    primitive: "caption-pop",
    parameters: { durationMs: 320 },
    ...overrides,
  });
}

function validEvent(overrides = {}) {
  return finalized({
    id: "event.001",
    schemaVersion: 1,
    createdAt: "2026-07-23T00:00:01.000Z",
    createdBy: { type: "controller", id: "visual-director-v4" },
    status: "recorded",
    source: {
      type: "system-event",
      sourceId: "job.fixture",
      author: "koubo",
      license: "project-internal",
    },
    evidence: [{ sourceId: "job.fixture", kind: "job-state" }],
    applicability: [],
    prohibitions: [],
    versions: {
      code: "test",
      model: "none",
      prompt: "none",
      memory: "schema-v1",
      asset: "none",
      recipe: "none",
      evaluation: "rubric-v1",
    },
    subjectId: "caption.pop.v1",
    action: "record_created",
    payload: { kind: "technique-card" },
    ...overrides,
  });
}

function fixtureStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-domain-store-"));
  const store = openDomainStore({
    dbPath: path.join(root, "runtime", "memory.sqlite"),
    exportRoot: path.join(root, "library"),
    clock: () => "2026-07-23T00:00:00.000Z",
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store };
}

test("migrations are checksum-verified and idempotent", t => {
  const { store } = fixtureStore(t);
  assert.deepEqual(store.migrate(), [{ version: 1, applied: false }]);
  assert.deepEqual(store.migrate(), [{ version: 1, applied: false }]);
  const rows = store.db.prepare("SELECT version, checksum FROM schema_migrations").all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].checksum, /^[a-f0-9]{64}$/);
});

test("writes a validated record and atomically exports canonical JSON", t => {
  const { root, store } = fixtureStore(t);
  const record = validTechnique();

  store.put("technique-card", record);

  assert.deepEqual(store.get("technique-card", record.id), record);
  const exported = JSON.parse(fs.readFileSync(
    path.join(root, "library", "technique-card", `${record.id}.json`),
    "utf8"
  ));
  assert.deepEqual(exported, record);
});

test("optimistic hashes prevent silent record overwrite", t => {
  const { store } = fixtureStore(t);
  const original = validTechnique();
  store.put("technique-card", original);
  const changed = validTechnique({ title: "不同标题" });

  assert.throws(
    () => store.put("technique-card", changed, "f".repeat(64)),
    /expected hash does not match/
  );
  assert.deepEqual(store.get("technique-card", original.id), original);
});

test("events are append-only and queryable by subject", t => {
  const { store } = fixtureStore(t);
  const event = validEvent();
  store.appendEvent(event);

  assert.deepEqual(store.eventsFor(event.subjectId), [event]);
  assert.throws(
    () => store.db.exec("UPDATE events SET action = 'changed' WHERE id = 'event.001'"),
    /append-only/
  );
  assert.throws(
    () => store.db.exec("DELETE FROM events WHERE id = 'event.001'"),
    /append-only/
  );
});

test("rejects a declared content hash that does not match record content", t => {
  const { store } = fixtureStore(t);
  const record = validTechnique();
  record.contentHash = "0".repeat(64);

  assert.throws(() => store.put("technique-card", record), /contentHash does not match/);
});
