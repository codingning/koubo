import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createOrchestrator } from "../../video/multi-agent/orchestrator.mjs";
import { buildContentStrategistInput } from "../../video/multi-agent/content-strategy.mjs";
import { contentHash } from "../../video/multi-agent/contracts.mjs";

const principleLibrary = JSON.parse(fs.readFileSync(
  path.resolve("config", "multi-agent", "content-principles.json"),
  "utf8"
));

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

test("content strategist runs before scripting without entering specialist or fallback paths", async () => {
  let captured;
  const principle = principleLibrary.principles[0];
  const directionInput = buildContentStrategistInput({
    direction: "分享我如何审计并试用一个开源 Skill",
    evidence: [{
      id: "evidence.skill-audit",
      sourceId: "audit-report.v1",
      provenance: "workspace_verified",
      kind: "audit-report",
      summary: "包含许可证、安全、维护状态和真实试用结果",
    }],
  });
  const orchestrator = createOrchestrator({
    memory: memoryFixture(),
    contentPrinciples: principleLibrary,
    invokeAgent: async request => {
      captured = request;
      return {
        success: true,
        result: {
          lockedDirection: directionInput.lockedDirection,
          directionRestatement: "分析用户给出的开源 Skill 分享方向",
          audience: "收藏了很多AI方法但尚未行动的普通观众",
          viewerBenefit: "知道怎样判断一个 Skill 是否值得安全试用",
          strengths: ["有真实审计与试用证据"],
          weaknesses: ["不能把单次试用推广为普遍结论"],
          evidence: { available: [{ id: "evidence.skill-audit", relevance: "证明真实试用" }], missing: [] },
          testableQuestion: "观众能否据此完成一次最小审计？",
          principleCitations: [{
            principleId: principle.id,
            contentHash: contentHash(principle),
            relevance: "用于检查完成成果与观众发现之间的关系",
            appliedJudgment: "增加观众能否发现并使用审计结果的判断",
            applicabilityCheck: "该方向属于开源方案介绍",
            counterexampleCheck: "没有稳定触达渠道，反例不适用",
          }],
          recommendation: "single_piece",
          nextQuestions: ["观众最终能拿走哪一张检查表？"],
          status: "ready_for_script",
          uncertainties: ["真实发布反馈尚未知"],
        },
      };
    },
  });
  const result = await orchestrator.analyzeContentDirection(directionInput);

  assert.equal(captured.agentId, "content-strategist");
  assert.equal(captured.operation, "agent_proposals");
  assert.equal(captured.task, "content_direction_analysis");
  assert.equal("script" in captured, false);
  assert.equal(result.analysis.scriptGate.mayHandOffToScriptAgent, false);
  assert.equal(result.events.at(-1).action, "content_direction_analyzed");
});

test("ordinary viewer audit is isolated from Blind, Retention, winner, and production authority", async () => {
  let captured;
  const orchestrator = createOrchestrator({
    memory: memoryFixture(),
    invokeAgent: async request => {
      captured = request;
      return {
        success: true,
        result: {
          sharpConclusion: "这是一份项目周报，普通观众拿不到可执行结果",
          blockers: [{
            issue: "项目进度没有翻译成观众收益",
            quote: "我们完成了十二个接口",
            classification: "subjective",
          }],
          viewerValueGap: "没有说明普通人能完成什么",
          evidenceGap: "没有展示输入、执行和结果",
          minimalFix: "保留方向，只补一个真实任务、结果证据和观众可复制动作",
          viewerDecision: "听懂但无用",
          classifications: { fact: [], subjective: ["内容以项目进度为主"], uncertain: [] },
        },
      };
    },
  });
  const result = await orchestrator.ordinaryViewerAudit({
    stage: "script",
    approvedDirection: {
      audience: "尚未开始行动的普通人",
      viewerBenefit: "得到一个可执行动作",
      coreQuestion: "项目如何转化为观众价值",
    },
    script: "我们完成了十二个接口，但还没有展示普通人如何使用。",
    facts: [],
    author: "hidden",
  });

  const serialized = JSON.stringify(captured);
  assert.equal(captured.agentId, "ordinary-viewer-critic");
  assert.equal(captured.operation, "agent_critique");
  assert.equal(serialized.includes("hidden"), false);
  assert.equal("winner" in result.review, false);
  assert.equal("approval" in result.review, false);
  assert.equal(result.events.at(-1).action, "ordinary_viewer_reviewed");
});

test("advisory agent failures stop explicitly without v4 or script fallback", async () => {
  const orchestrator = createOrchestrator({
    memory: memoryFixture(),
    contentPrinciples: principleLibrary,
    limits: { retries: 0, timeoutMs: 100 },
    invokeAgent: async () => { throw new Error("advisory unavailable"); },
  });
  const directionInput = buildContentStrategistInput({
    direction: "分享训练 Agent 的真实过程",
    evidence: [],
  });
  await assert.rejects(
    () => orchestrator.analyzeContentDirection(directionInput),
    /advisory unavailable/
  );
});
