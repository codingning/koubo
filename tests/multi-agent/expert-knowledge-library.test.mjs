import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildExpertKnowledgeLibrary } from "../../video/multi-agent/expert-knowledge-library.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("expert knowledge library aggregates trial and inbox catalogs without promoting them", async () => {
  const library = await buildExpertKnowledgeLibrary({ root, runtimeRecords: [] });

  assert.equal(library.readOnly, true);
  assert.equal(library.summary.total, 42);
  assert.equal(library.summary.trial, 12);
  assert.equal(library.summary.inbox, 30);
  assert.equal(library.summary.approved, 0);
  assert.equal(library.summary.promoted, 0);
  assert.equal(library.summary.runtimeLoaded, 0);
  assert.equal(library.summary.defaultCallable, 0);
  assert.equal(library.catalogs.length, 4);
  assert.equal(new Set(library.records.map(record => record.id)).size, library.records.length);
  assert.equal(library.records.every(record => record.defaultCallable === false), true);
  assert.equal(library.records.some(record => record.id === "sound-technique.semantic-sfx-cue.v2" && record.status === "trial"), true);
  assert.equal(library.records.some(record => record.id === "cover-technique.real-person-content-first.v1" && record.status === "inbox"), true);
});

test("runtime status overrides catalog status while retaining catalog provenance", async () => {
  const library = await buildExpertKnowledgeLibrary({
    root,
    runtimeRecords: [{
      id: "sound-technique.semantic-sfx-cue.v2",
      title: "语义音效锚点",
      status: "approved",
      domain: "sound",
      namespace: "sound.private",
      evidence: [{ type: "human-review", decision: "approved" }],
    }],
  });
  const record = library.records.find(item => item.id === "sound-technique.semantic-sfx-cue.v2");

  assert.equal(record.status, "approved");
  assert.equal(record.runtimeLoaded, true);
  assert.equal(record.defaultCallable, true);
  assert.equal(record.layers.includes("trial"), true);
  assert.equal(record.layers.includes("runtime"), true);
  assert.equal(library.summary.defaultCallable, 1);
  assert.equal(library.summary.approved, 1);
  assert.equal(library.summary.trial, 11);
});
