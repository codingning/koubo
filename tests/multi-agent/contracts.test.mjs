import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  validateRecord,
  canonicalJson,
  contentHash,
  loadAgentProfiles,
  validateRepositoryContracts,
} from "../../video/multi-agent/contracts.mjs";

const root = path.resolve(".");

function validTechnique(overrides = {}) {
  return {
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
      memory: "empty",
      asset: "none",
      recipe: "caption-pop-v1",
      evaluation: "rubric-v1",
    },
    contentHash: "a".repeat(64),
    domain: "caption",
    namespace: "caption.private",
    title: "关键词弹出",
    problem: "让关键词在不重复信息卡内容的情况下被注意到",
    primitive: "caption-pop",
    parameters: {
      durationMs: 320,
      scaleFrom: 0.88,
      scaleTo: 1,
    },
    ...overrides,
  };
}

test("rejects a technique card without timestamped evidence", () => {
  assert.throws(
    () => validateRecord("technique-card", validTechnique({ evidence: [] })),
    /evidence/
  );
});

test("accepts a complete technique card", () => {
  assert.deepEqual(validateRecord("technique-card", validTechnique()), validTechnique());
});

test("canonical hashes ignore object key order but not content", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }));
  assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
});

test("loads six bounded production profiles with isolated memory namespaces", async () => {
  const profiles = await loadAgentProfiles(root);
  assert.deepEqual(
    profiles.map(item => item.agentId).sort(),
    ["blind-critic", "caption-agent", "director-agent", "motion-agent", "retention-critic", "sound-agent"]
  );
  const motion = profiles.find(item => item.agentId === "motion-agent");
  assert.deepEqual(motion.memoryNamespaces, ["shared.evidence", "motion.private", "shared.recipes"]);
  assert.equal(profiles.some(item => item.responsibilities.includes("publish")), false);
  assert.equal(profiles.some(item => item.responsibilities.includes("promote-memory")), false);
});

test("agent profile hashes match their canonical record content", async () => {
  const profiles = await loadAgentProfiles(root);
  for (const profile of profiles) {
    const withoutDeclaredHash = { ...profile };
    delete withoutDeclaredHash.contentHash;
    assert.equal(profile.contentHash, contentHash(withoutDeclaredHash), profile.agentId);
  }
});

test("validates every repository schema, profile, and evaluation rubric", async () => {
  const report = await validateRepositoryContracts(root);
  assert.deepEqual(report, {
    schemaVersion: 1,
    schemas: 8,
    profiles: 6,
    rubric: "koubo-multi-agent-rubric-v1",
  });
});
