import test from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "../../video/multi-agent/orchestrator.mjs";

const input = {
  jobId: "job.fixture",
  transcript: [
    { start: 0, end: 2.4, text: "I tested the AI workflow." },
    { start: 2.4, end: 5.1, text: "Here is the real result." },
  ],
  sharedEvidence: [
    { id: "evidence.result", start: 2.5, end: 4.8, kind: "screen-recording" },
  ],
  currentPlan: {
    layout: "speaker-right-information-left",
    captions: "anchor",
    motion: ["title-enter"],
    sound: [],
  },
  roleInputs: {
    caption: { safeArea: { bottom: 120 }, captionCues: [] },
    motion: { sceneWindows: [{ start: 0, end: 5.1 }], approvedAssets: [] },
    sound: { voicePeakDb: -6, licensedAssets: [] },
  },
  v4Plan: {
    engine: "visual-director-v4",
    layout: "speaker-right-information-left",
    captions: { identity: "anchor" },
    motion: { structure: ["title-enter"] },
    sound: { structure: [] },
  },
};

function memoryFixture() {
  return {
    retrieve({ agentId }) {
      return [{
        id: `${agentId}.memory.v1`,
        contentHash: agentId.padEnd(64, "a").slice(0, 64),
        status: "promoted",
        namespace: agentId.replace("-agent", ".private"),
        primitive: agentId === "caption-agent" ? "caption-pop" : "element-slide",
        parameters: {},
      }];
    },
  };
}

function specialistResponse(request) {
  const kind = request.proposalKind;
  const memory = request.memory[0];
  return {
    success: true,
    result: {
      proposals: [
        {
          candidate: {
            layout: kind === "caption" ? "caption-bottom" : "speaker-right-information-left",
            captions: { identity: kind === "caption" ? "keyword-pop" : "anchor" },
            motion: { structure: kind === "motion" ? ["evidence-slide"] : [] },
            sound: { structure: kind === "sound" ? ["semantic-cue"] : [] },
          },
          citations: [{ recordId: memory.id, contentHash: memory.contentHash }],
          uncertainties: [],
        },
      ],
    },
  };
}

test("specialists receive shared evidence and only their own governed memory", async () => {
  const calls = {};
  const orchestrator = createOrchestrator({
    memory: memoryFixture(),
    invokeAgent: async request => {
      calls[request.agentId] = request;
      return specialistResponse(request);
    },
    clock: () => "2026-07-23T10:00:00.000Z",
  });

  const result = await orchestrator.propose(input);

  assert.equal(result.proposals.length, 3);
  assert.deepEqual(
    calls["caption-agent"].memory.map(item => item.id),
    ["caption-agent.memory.v1"]
  );
  assert.deepEqual(
    calls["motion-agent"].memory.map(item => item.id),
    ["motion-agent.memory.v1"]
  );
  assert.equal("otherAgentProposals" in calls["caption-agent"], false);
  assert.equal("sound" in calls["caption-agent"].roleInput, false);
  assert.deepEqual(calls["caption-agent"].sharedEvidence, input.sharedEvidence);
});

test("specialist proposal count is bounded and every citation was retrievable", async () => {
  const orchestrator = createOrchestrator({
    memory: memoryFixture(),
    invokeAgent: async request => {
      const proposal = specialistResponse(request).result.proposals[0];
      return {
        success: true,
        result: { proposals: [proposal, proposal, proposal] },
      };
    },
    limits: { maxProposalsPerSpecialist: 2 },
    clock: () => "2026-07-23T10:00:00.000Z",
  });

  const result = await orchestrator.propose(input);

  assert.equal(result.proposals.length, 6);
  assert.ok(result.proposals.every(item => item.citations.length === 1));
  assert.ok(result.proposals.every(item => item.contentHash.length === 64));
});

test("unknown memory citations trigger a traceable v4 fallback", async () => {
  const orchestrator = createOrchestrator({
    memory: memoryFixture(),
    invokeAgent: async request => ({
      success: true,
      result: {
        proposals: [{
          ...specialistResponse(request).result.proposals[0],
          citations: [{ recordId: "foreign.private.memory", contentHash: "f".repeat(64) }],
        }],
      },
    }),
    limits: { retries: 0 },
    clock: () => "2026-07-23T10:00:00.000Z",
  });

  const result = await orchestrator.propose(input);

  assert.equal(result.fallback.engine, "visual-director-v4");
  assert.equal(result.proposals.length, 3);
  assert.ok(result.events.some(event => event.action === "agent_invalid_fallback"));
});

test("timeout retries once then falls back without blocking other specialists", async () => {
  const attempts = new Map();
  const orchestrator = createOrchestrator({
    memory: memoryFixture(),
    invokeAgent: request => {
      attempts.set(request.agentId, (attempts.get(request.agentId) || 0) + 1);
      if (request.agentId === "motion-agent") return new Promise(() => {});
      return Promise.resolve(specialistResponse(request));
    },
    limits: { timeoutMs: 15, retries: 1 },
    clock: () => "2026-07-23T10:00:00.000Z",
  });

  const result = await orchestrator.propose(input);

  assert.equal(attempts.get("motion-agent"), 2);
  assert.equal(result.fallback.engine, "visual-director-v4");
  assert.deepEqual(result.fallback.agents, ["motion-agent"]);
  assert.equal(result.events.at(-1).action, "agent_timeout_fallback");
});

test("director composes structurally distinct candidates without approval authority", async () => {
  const orchestrator = createOrchestrator({
    memory: memoryFixture(),
    invokeAgent: async request => {
      if (request.agentId !== "director-agent") return specialistResponse(request);
      return {
        success: true,
        result: {
          approvedAt: "forbidden",
          publish: true,
          memoryPromotion: { id: "forbidden" },
          candidates: [
            {
              id: "candidate-a",
              layout: "speaker-right-information-left",
              captions: { identity: "anchor" },
              motion: { structure: ["evidence-slide"] },
              sound: { structure: [] },
              rationale: "combine caption and motion",
            },
            {
              id: "candidate-b",
              layout: "speaker-center-evidence-full",
              captions: { identity: "keyword-pop" },
              motion: { structure: [] },
              sound: { structure: ["semantic-cue"] },
              rationale: "use audio contrast",
            },
          ],
          conflicts: [{ field: "visual-density", options: ["a", "b"] }],
        },
      };
    },
    clock: () => "2026-07-23T10:00:00.000Z",
  });
  const proposals = (await orchestrator.propose(input)).proposals;

  const result = await orchestrator.direct(proposals, { jobId: input.jobId, v4Plan: input.v4Plan });

  assert.equal(result.candidates.length, 2);
  assert.notEqual(result.candidates[0].layout, result.candidates[1].layout);
  assert.equal("approvedAt" in result, false);
  assert.equal("memoryPromotion" in result, false);
  assert.equal("publish" in result, false);
  assert.equal(result.conflicts.length, 1);
});

test("blind critic receives no author, agent, rationale, prompt, or proposal order", async () => {
  let captured;
  const orchestrator = createOrchestrator({
    memory: memoryFixture(),
    invokeAgent: async request => {
      captured = request;
      return {
        success: true,
        result: {
          scores: { technical: 1, content: 0.9, brand: 0.9 },
          timecodedFindings: [
            { start: 0.5, end: 1.4, type: "strength", finding: "clear opening" },
          ],
        },
      };
    },
    clock: () => "2026-07-23T10:00:00.000Z",
  });
  const candidate = {
    id: "candidate-secret",
    author: "caption-agent",
    agentId: "caption-agent",
    rationale: "hidden",
    prompt: "hidden",
    proposalOrder: 1,
    layout: "speaker-right-information-left",
    motion: { structure: ["evidence-slide"] },
  };

  const review = await orchestrator.criticize(candidate, { blind: true, jobId: input.jobId });
  const serialized = JSON.stringify(captured);

  assert.equal(serialized.includes("candidate-secret"), false);
  assert.equal(serialized.includes("caption-agent"), false);
  assert.equal(serialized.includes("hidden"), false);
  assert.equal(serialized.includes("proposalOrder"), false);
  assert.match(captured.candidateLabel, /^blind-[a-f0-9]{12}$/);
  assert.equal(review.reviewerId, "blind-critic");
  assert.equal(review.timecodedFindings.length, 1);
});

test("retention audit requires timestamped reasons and can recognize necessary pauses", async () => {
  const orchestrator = createOrchestrator({
    memory: memoryFixture(),
    invokeAgent: async request => ({
      success: true,
      result: {
        scores: { retention: 0.84 },
        timecodedFindings: [
          {
            start: 1.8,
            end: 2.4,
            classification: "necessary-pause",
            viewingReason: "viewer needs time to read the evidence",
          },
        ],
      },
    }),
    clock: () => "2026-07-23T10:00:00.000Z",
  });

  const result = await orchestrator.retentionAudit({
    id: "candidate-a",
    duration: 5.1,
    layout: "speaker-right-information-left",
  }, { jobId: input.jobId });

  assert.equal(result.timecodedFindings[0].classification, "necessary-pause");
  assert.equal(result.timecodedFindings[0].start, 1.8);
});

test("retention critic cannot impose an effect-every-second rule", async () => {
  const orchestrator = createOrchestrator({
    memory: memoryFixture(),
    invokeAgent: async () => ({
      success: true,
      result: {
        scores: { retention: 0.2 },
        requireEffectEverySecond: true,
        timecodedFindings: [],
      },
    }),
    clock: () => "2026-07-23T10:00:00.000Z",
  });

  await assert.rejects(
    () => orchestrator.retentionAudit({ id: "candidate-a", duration: 5.1 }, { jobId: input.jobId }),
    /effect-every-second rule is forbidden/
  );
});
