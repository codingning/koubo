import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contentHash } from "../../video/multi-agent/contracts.mjs";
import { createMemoryService } from "../../video/multi-agent/memory.mjs";
import { openDomainStore } from "../../video/multi-agent/store.mjs";

const NOW = "2026-07-23T08:00:00.000Z";

function finalized(record) {
  const value = structuredClone(record);
  delete value.contentHash;
  value.contentHash = contentHash(value);
  return value;
}

function technique(overrides = {}) {
  return finalized({
    id: "caption.pop.v1",
    schemaVersion: 1,
    createdAt: NOW,
    createdBy: { type: "agent", id: "tutorial-ingestor" },
    status: "inbox",
    source: {
      type: "local-tutorial",
      sourceId: "tutorial.sha256",
      author: "Koubo local fixture",
      license: "self-created",
    },
    evidence: [
      {
        sourceId: "tutorial.sha256",
        kind: "video-time-range",
        start: 1.2,
        end: 3.4,
      },
    ],
    applicability: ["spoken keyword emphasis"],
    prohibitions: ["do not cover the speaker face"],
    versions: {
      code: "test",
      model: "fixture",
      prompt: "extract-technique-v1",
      memory: "schema-v1",
      asset: "none",
      recipe: "caption-pop-v1",
      evaluation: "rubric-v1",
    },
    domain: "caption",
    namespace: "caption.private",
    title: "Keyword caption pop",
    problem: "Make one spoken keyword noticeable",
    primitive: "caption-pop",
    parameters: { durationMs: 320 },
    tags: ["caption", "keyword"],
    qualityScore: 0.72,
    ...overrides,
  });
}

const profiles = [
  {
    agentId: "caption-agent",
    status: "active",
    memoryNamespaces: ["shared.evidence", "caption.private", "shared.recipes"],
  },
  {
    agentId: "motion-agent",
    status: "active",
    memoryNamespaces: ["shared.evidence", "motion.private", "shared.recipes"],
  },
];

function fixtureMemory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-memory-"));
  let tick = 0;
  const clock = () => new Date(Date.parse(NOW) + tick++ * 1000).toISOString();
  const store = openDomainStore({
    dbPath: path.join(root, "runtime", "memory.sqlite"),
    exportRoot: path.join(root, "library"),
    clock,
  });
  const memory = createMemoryService(store, profiles, { clock });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { memory, root, store };
}

function step(memory, id, to, evidence = []) {
  const current = memory.get("technique-card", id);
  return memory.transition({
    kind: "technique-card",
    id,
    to,
    actor: { type: "controller", id: "memory-governor" },
    evidence,
    expectedHash: current.contentHash,
  });
}

function advanceToTrial(memory, record = technique()) {
  memory.ingest(record);
  step(memory, record.id, "extracted");
  step(memory, record.id, "recreated", [
    { type: "render-qa", renderId: "sandbox.caption.pop.v1", passed: true },
  ]);
  step(memory, record.id, "trial", [
    { type: "project-trial", projectId: "job.alpha", outcome: "eligible" },
  ]);
  return record.id;
}

function approve(memory, id, projectId = "job.alpha") {
  return memory.transition({
    kind: "technique-card",
    id,
    to: "approved",
    actor: { type: "human", id: "owner" },
    evidence: [
      {
        type: "human-review",
        reviewId: `review.${projectId}`,
        reviewerId: "owner",
        projectId,
        decision: "approved",
      },
    ],
    expectedHash: memory.get("technique-card", id).contentHash,
  });
}

test("automatic extraction cannot skip lifecycle stages", t => {
  const { memory } = fixtureMemory(t);
  memory.ingest(technique());

  assert.throws(
    () => memory.transition({
      kind: "technique-card",
      id: "caption.pop.v1",
      to: "approved",
      actor: { type: "agent", id: "caption-agent" },
      evidence: [],
      expectedHash: memory.get("technique-card", "caption.pop.v1").contentHash,
    }),
    /transition inbox -> approved is forbidden/
  );
});

test("approval requires an explicit human approval record", t => {
  const { memory } = fixtureMemory(t);
  const id = advanceToTrial(memory);

  assert.throws(
    () => step(memory, id, "approved", [
      { type: "agent-review", reviewerId: "blind-critic", decision: "approved" },
    ]),
    /human approval evidence/
  );
});

test("promotion requires two distinct approved project trials", t => {
  const { memory } = fixtureMemory(t);
  const id = advanceToTrial(memory);
  approve(memory, id, "job.alpha");

  assert.throws(
    () => memory.transition({
      kind: "technique-card",
      id,
      to: "promoted",
      actor: { type: "human", id: "owner" },
      evidence: [
        { type: "approved-project-trial", projectId: "job.alpha", reviewId: "review.a" },
        { type: "approved-project-trial", projectId: "job.alpha", reviewId: "review.b" },
      ],
      expectedHash: memory.get("technique-card", id).contentHash,
    }),
    /two distinct approved project trials/
  );

  const result = memory.transition({
    kind: "technique-card",
    id,
    to: "promoted",
    actor: { type: "human", id: "owner" },
    evidence: [
      { type: "approved-project-trial", projectId: "job.alpha", reviewId: "review.a" },
      { type: "approved-project-trial", projectId: "job.beta", reviewId: "review.b" },
    ],
    expectedHash: memory.get("technique-card", id).contentHash,
  });
  assert.equal(result.record.status, "promoted");
});

test("agents retrieve approved memory only from their allowed namespaces", t => {
  const { memory } = fixtureMemory(t);
  const id = advanceToTrial(memory);
  approve(memory, id);

  assert.equal(
    memory.retrieve({ agentId: "caption-agent", query: { tags: ["caption"] } }).length,
    1
  );
  assert.equal(
    memory.retrieve({ agentId: "motion-agent", query: { tags: ["caption"] } }).length,
    0
  );
});

test("candidate retrieval never exposes inbox items", t => {
  const { memory } = fixtureMemory(t);
  memory.ingest(technique());

  assert.deepEqual(
    memory.retrieve({
      agentId: "caption-agent",
      query: { tags: ["caption"] },
      includeCandidate: true,
    }),
    []
  );

  step(memory, "caption.pop.v1", "extracted");
  assert.equal(
    memory.retrieve({
      agentId: "caption-agent",
      query: { tags: ["caption"] },
      includeCandidate: true,
    }).length,
    1
  );
});

test("negative memory is retained but excluded from normal proposal retrieval", t => {
  const { memory } = fixtureMemory(t);
  memory.ingest(technique());
  const rejected = memory.reject({
    kind: "technique-card",
    id: "caption.pop.v1",
    actor: { type: "human", id: "owner" },
    evidence: [{ type: "human-review", decision: "rejected", reason: "covers face" }],
    expectedHash: memory.get("technique-card", "caption.pop.v1").contentHash,
  });

  assert.equal(rejected.record.status, "rejected");
  assert.equal(memory.retrieve({ agentId: "caption-agent", query: {} }).length, 0);
  assert.equal(
    memory.retrieve({
      agentId: "caption-agent",
      query: { includeNegative: true },
    })[0].status,
    "rejected"
  );
});

test("rollback restores prior record and retrieval behavior", t => {
  const { memory } = fixtureMemory(t);
  const id = advanceToTrial(memory);
  const before = memory.retrieve({
    agentId: "caption-agent",
    query: {},
    includeCandidate: true,
  });
  const transition = approve(memory, id);
  assert.notDeepEqual(memory.retrieve({ agentId: "caption-agent", query: {} }), []);

  const rollback = memory.rollback(transition.id);

  assert.equal(rollback.record.status, "trial");
  assert.deepEqual(
    memory.retrieve({
      agentId: "caption-agent",
      query: {},
      includeCandidate: true,
    }),
    before
  );
  assert.throws(() => memory.rollback(transition.id), /already rolled back/);
});

test("namespace export is deterministic and strips raw bytes and secret-shaped fields", t => {
  const { memory } = fixtureMemory(t);
  const id = advanceToTrial(memory, technique({
    parameters: {
      durationMs: 320,
      rawMedia: Buffer.from("not-for-export"),
      apiKey: "must-not-survive",
      nested: { accessToken: "also-secret", safe: "kept" },
    },
  }));
  approve(memory, id);

  const exported = memory.exportNamespace("caption-agent");
  const serialized = JSON.stringify(exported);

  assert.equal(exported.agentId, "caption-agent");
  assert.equal(serialized.includes("must-not-survive"), false);
  assert.equal(serialized.includes("also-secret"), false);
  assert.equal(serialized.includes("not-for-export"), false);
  assert.equal(serialized.includes('"safe":"kept"'), true);
});

test("brand-core memory mutation remains unsupported in v1", t => {
  const { memory } = fixtureMemory(t);
  assert.throws(
    () => memory.ingest(technique({ id: "brand.core.v1", namespace: "brand.core" })),
    /brand-core memory is not supported/
  );
});
