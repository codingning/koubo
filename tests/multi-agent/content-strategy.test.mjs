import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CONTENT_STRATEGY_CONTRACT,
  buildContentStrategistInput,
  buildContentStrategistAnalysisRequest,
  createContentStrategist,
  normalizeContentStrategistOutput,
  canEnterScriptStage,
} from "../../video/multi-agent/content-strategy.mjs";
import { contentHash } from "../../video/multi-agent/contracts.mjs";

const root = path.resolve(".");
const principleLibrary = JSON.parse(fs.readFileSync(
  path.join(root, "config", "multi-agent", "content-principles.json"),
  "utf8"
));
const principleSchema = JSON.parse(fs.readFileSync(
  path.join(root, "config", "multi-agent", "schemas", "content-principle.schema.json"),
  "utf8"
));

function evidence(id, kind, summary) {
  return { id, kind, summary, locator: `fixture://${id}` };
}

function readyAnalysis(input, evidenceId, overrides = {}) {
  const principle = principleLibrary.principles[0];
  return {
    lockedDirection: input.lockedDirection,
    directionRestatement: `用户希望分析：${input.lockedDirection}`,
    audience: "收藏了很多AI内容但尚未真正行动的普通观众",
    viewerBenefit: "看清一个可验证的行动，并知道自己下一步能做什么",
    strengths: ["方向来自用户的真实意图", "存在可展示的原始证据"],
    weaknesses: ["仍需避免把个案写成普遍因果"],
    evidence: {
      available: [{ id: evidenceId, relevance: "直接证明用户实际做过这件事" }],
      missing: [],
    },
    testableQuestion: "这条内容能否让普通观众理解并完成一个具体动作？",
    principleCitations: [{
      principleId: principle.id,
      contentHash: contentHash(principle),
      relevance: "用于检查成果是否真正连接到受众与分发",
      appliedJudgment: "把观众能否发现并复用成果列为方向是否成立的判断条件",
      applicabilityCheck: "该原则适用于个人项目分享与AI工具实测",
      counterexampleCheck: "当前没有稳定触达渠道，因此反例不阻断使用",
    }],
    recommendation: "单篇",
    nextQuestions: ["用户最希望观众带走哪个动作？"],
    status: "可进入成稿",
    uncertainties: ["发布后的真实观众反应尚未知"],
    ...overrides,
  };
}

test("candidate content principles remain traceable, bounded, and non-authoritative", () => {
  assert.equal(principleLibrary.schemaVersion, 1);
  assert.equal(principleLibrary.status, "candidate_awaiting_user_review");
  assert.equal(principleLibrary.usageBoundary.forbidOriginalWording, true);
  assert.equal(principleLibrary.usageBoundary.forbidVideoFormImitation, true);
  assert.equal(principleSchema.$id, "koubo://schemas/content-principle/v1");
  assert.equal(principleSchema["x-koubo-common-record"], false);
  assert.equal(principleLibrary.principles.length, 16);
  assert.deepEqual(
    [...new Set(principleLibrary.principles.map(item => item.sourceVideoId))].sort(),
    ["7665003502212582683", "7665371144572177700", "7665740666193874227"]
  );
  for (const item of principleLibrary.principles) {
    assert.ok(item.timecodes.length >= 1, item.id);
    assert.ok(item.timecodes.every(range => range.endSeconds > range.startSeconds), item.id);
    assert.ok(item.applicability.length >= 1, item.id);
    assert.ok(item.counterexamples.length >= 1, item.id);
    assert.equal(item.status, "candidate_awaiting_user_review");
  }
});

const directionCases = [
  {
    name: "开源 Skills",
    direction: "分享我如何审计并试用一个适合普通人的开源 Skill",
    evidence: evidence("evidence.skill-audit", "audit-report", "包含许可证、安全、维护状态和本地试用结果"),
    recommendation: "single_piece",
  },
  {
    name: "个人项目",
    direction: "分享我用AI推进个人项目时从第一版失败到返修的真实过程",
    evidence: evidence("evidence.project-version", "version-diff", "包含第一版、失败原因、修改记录和可运行结果"),
    recommendation: "single_piece",
  },
  {
    name: "训练 Agent",
    direction: "记录我训练一个内容Agent识别错误并学会人工兜底的过程",
    evidence: evidence("evidence.agent-run", "evaluation-run", "包含失败输出、人工处理、规则更新和回归结果"),
    recommendation: "series",
  },
];

for (const fixture of directionCases) {
  test(`${fixture.name}方向保持用户锁定并且确认前不能进入成稿`, () => {
    const input = buildContentStrategistInput({
      direction: fixture.direction,
      audienceContext: "从知道到做到的AI行动型观众",
      userFacts: ["用户会展示自己真实完成的步骤"],
      evidence: [fixture.evidence],
      constraints: ["不得虚构结果", "不得擅自换题"],
      interviewAnswers: [
        { question: "这次真实做过什么？", answer: fixture.evidence.summary },
      ],
    });

    const request = buildContentStrategistAnalysisRequest(input, {
      principles: principleLibrary,
    });
    const analysis = normalizeContentStrategistOutput(
      readyAnalysis(input, fixture.evidence.id, { recommendation: fixture.recommendation }),
      input,
      { principles: principleLibrary }
    );

    assert.equal(input.lockedDirection, fixture.direction);
    assert.equal(input.directionAuthority.owner, "user");
    assert.equal(input.directionAuthority.strategistMayReplace, false);
    assert.equal(request.stage, "interview_and_analysis");
    assert.equal(request.operation, "agent_proposals");
    assert.equal(request.task, "content_direction_analysis");
    assert.equal(request.lockedDirection, fixture.direction);
    assert.equal(request.instructions.doNotChangeTopic, true);
    assert.equal(request.instructions.doNotDraftScriptTitlesHooksShotsOrEditPlan, true);
    assert.equal(request.instructions.preserveProvidedFactsExactly, true);
    assert.equal(request.instructions.usePrincipleOnlyWhenItChangesAConcreteJudgment, true);
    assert.equal(request.outputContract.principleCitationPolicy, "zero_to_three_only_when_material");
    assert.ok(request.candidatePrinciples.every(item => item.authority === "advisory_candidate_only"));
    assert.equal(analysis.recommendation, fixture.recommendation);
    assert.equal(analysis.evidence.available[0].sourceId, fixture.evidence.id);
    assert.equal(analysis.evidence.available[0].provenance, "user_provided");
    assert.equal(analysis.principleCitations[0].sourceVideoId, "7665740666193874227");
    assert.ok(analysis.principleCitations[0].timecodes.length > 0);
    assert.equal(analysis.status, "ready_for_script");
    assert.equal(analysis.scriptGate.strategistMayDraft, false);
    assert.equal(analysis.scriptGate.mayHandOffToScriptAgent, false);
    assert.equal(analysis.scriptGate.reason, "awaiting_user_confirmation");
    assert.equal(canEnterScriptStage(input, analysis), false);
  });
}

test("user confirmation unlocks only Script Agent handoff, never Strategist drafting", () => {
  const direction = directionCases[1];
  const input = buildContentStrategistInput({
    direction: direction.direction,
    evidence: [direction.evidence],
    userConfirmation: {
      analysisApproved: true,
      confirmedDirection: direction.direction,
    },
  });
  const analysis = normalizeContentStrategistOutput(
    readyAnalysis(input, direction.evidence.id),
    input,
    { principles: principleLibrary }
  );

  assert.equal(analysis.scriptGate.strategistMayDraft, false);
  assert.equal(analysis.scriptGate.mayHandOffToScriptAgent, true);
  assert.equal(canEnterScriptStage(input, analysis), true);
  assert.equal(CONTENT_STRATEGY_CONTRACT.strategistMayDraft, false);
  assert.equal(CONTENT_STRATEGY_CONTRACT.directionOwner, "user");
});

test("missing evidence cannot be normalized as ready for script", () => {
  const input = buildContentStrategistInput({
    direction: "分享一个尚未实际试用的开源 Skill",
    evidence: [],
  });
  const raw = readyAnalysis(input, "missing", {
    evidence: { available: [], missing: [] },
  });

  assert.throws(
    () => normalizeContentStrategistOutput(raw, input, { principles: principleLibrary }),
    /requires cited available evidence/
  );
});

test("evidence gaps may produce interview analysis but keep the script gate closed", () => {
  const input = buildContentStrategistInput({
    direction: "分享一个尚未实际试用的开源 Skill",
    evidence: [],
  });
  const raw = {
    ...readyAnalysis(input, "unused"),
    evidence: { available: [], missing: ["本地试用结果", "许可证与安全审计"] },
    status: "补证后再写",
    recommendation: "暂缓",
  };
  const analysis = normalizeContentStrategistOutput(raw, input, { principles: principleLibrary });

  assert.equal(analysis.status, "needs_evidence");
  assert.equal(analysis.recommendation, "defer");
  assert.equal(analysis.scriptGate.mayHandOffToScriptAgent, false);
});

test("Strategist output fails when it drafts a script before handoff", () => {
  const fixture = directionCases[2];
  const input = buildContentStrategistInput({
    direction: fixture.direction,
    evidence: [fixture.evidence],
  });
  const raw = readyAnalysis(input, fixture.evidence.id, {
    analysisNotes: {
      fullScript: "这是不应由 Content Strategist 输出的完整口播稿。",
    },
  });

  assert.throws(
    () => normalizeContentStrategistOutput(raw, input, { principles: principleLibrary }),
    /forbidden draft field/
  );
});

test("Strategist output fails when it replaces the user direction", () => {
  const fixture = directionCases[0];
  const input = buildContentStrategistInput({
    direction: fixture.direction,
    evidence: [fixture.evidence],
  });
  const raw = readyAnalysis(input, fixture.evidence.id, {
    scopeAnalysis: {
      replacementDirection: "改成介绍一个热门闭源AI工具",
    },
  });

  assert.throws(
    () => normalizeContentStrategistOutput(raw, input, { principles: principleLibrary }),
    /attempted to change the user-locked direction/
  );
});

test("Strategist gets one bounded repair attempt for malformed structured output", async () => {
  const direction = "分享我训练一个 Agent 的过程";
  const input = buildContentStrategistInput({
    direction,
    directionSource: "user",
    evidence: [{
      id: "evidence-agent-run",
      kind: "run",
      summary: "记录了第一次运行和人工修正",
      sourceId: "artifact-agent-run",
      provenance: "workspace_verified",
    }],
  });
  const principle = principleLibrary.principles[0];
  const requests = [];
  const strategist = createContentStrategist({
    principles: [principle],
    invokeAgent: async request => {
      requests.push(request);
      const base = readyAnalysis(input, "evidence-agent-run");
      return requests.length === 1
        ? { ...base, audience: { invalid: true } }
        : base;
    },
  });

  const result = await strategist.analyze(input);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].validationRepair.attempt, 2);
  assert.match(requests[1].validationRepair.previousError, /audience must be a string/i);
  assert.equal(result.lockedDirection, direction);
  assert.equal(result.scriptGate.mayHandOffToScriptAgent, false);
});

test("Strategist input rejects an agent-invented direction", () => {
  assert.throws(
    () => buildContentStrategistInput({
      direction: "Agent自行挑选的热门选题",
      directionSource: "agent",
    }),
    /explicit user-provided direction/
  );
});

test("Strategist preserves verified evidence timecodes and rejects partial ranges", () => {
  const input = buildContentStrategistInput({
    direction: directionCases[2].direction,
    evidence: [{
      ...directionCases[2].evidence,
      sourceId: "agent-run.transcript.v1",
      provenance: "workspace_verified",
      start: 12.4,
      end: 18.8,
    }],
  });
  const analysis = normalizeContentStrategistOutput(
    readyAnalysis(input, directionCases[2].evidence.id),
    input,
    { principles: principleLibrary }
  );
  assert.deepEqual(
    {
      sourceId: analysis.evidence.available[0].sourceId,
      provenance: analysis.evidence.available[0].provenance,
      start: analysis.evidence.available[0].start,
      end: analysis.evidence.available[0].end,
    },
    {
      sourceId: "agent-run.transcript.v1",
      provenance: "workspace_verified",
      start: 12.4,
      end: 18.8,
    }
  );
  assert.throws(() => buildContentStrategistInput({
    direction: "分享一段带时间码的证据",
    evidence: [{ ...directionCases[2].evidence, start: 1.2 }],
  }), /start and end/);
});

test("Strategist keeps evidence locators out of the model request", () => {
  const input = buildContentStrategistInput({
    direction: "分享一次真实的 Agent 训练实验",
    evidence: [{
      id: "agent-run-v1",
      kind: "evaluation-run",
      summary: "包含失败输出、人工修复和回归结果",
      sourceId: "agent-run-v1",
      provenance: "workspace_verified",
      locator: "artifact://agent-run-v1",
      source: "https://example.com/public-evidence",
      start: 1.2,
      end: 4.8,
    }],
  });
  const request = buildContentStrategistAnalysisRequest(input, { principles: principleLibrary });
  assert.deepEqual(request.minimalInput.evidence[0], {
    id: "agent-run-v1",
    kind: "evaluation-run",
    summary: "包含失败输出、人工修复和回归结果",
    sourceId: "agent-run-v1",
    provenance: "workspace_verified",
    start: 1.2,
    end: 4.8,
  });
  assert.equal("locator" in request.minimalInput.evidence[0], false);
  assert.equal("source" in request.minimalInput.evidence[0], false);
});

test("Strategist rejects local paths before they can reach a model request", () => {
  assert.throws(() => buildContentStrategistInput({
    direction: "分享一次 Agent 训练实验",
    evidence: [{
      id: "agent-run-v1",
      kind: "evaluation-run",
      summary: "证据保存在 C:\\private\\secret.json",
    }],
  }), /local path/i);
});

test("Strategist cannot return approval, publication, or memory authority", () => {
  const fixture = directionCases[1];
  const input = buildContentStrategistInput({ direction: fixture.direction, evidence: [fixture.evidence] });
  const raw = readyAnalysis(input, fixture.evidence.id, {
    workflow: { productionApproval: true },
  });
  assert.throws(
    () => normalizeContentStrategistOutput(raw, input, { principles: principleLibrary }),
    /forbidden authority field/
  );
});

test("Strategist rejects invented or stale principle citations", () => {
  const fixture = directionCases[0];
  const input = buildContentStrategistInput({ direction: fixture.direction, evidence: [fixture.evidence] });
  const invented = readyAnalysis(input, fixture.evidence.id, {
    principleCitations: [{ principleId: "content-principle.invented.v1", contentHash: "a".repeat(64), relevance: "伪造" }],
  });
  assert.throws(
    () => normalizeContentStrategistOutput(invented, input, { principles: principleLibrary }),
    /unavailable principle/
  );
  const stale = readyAnalysis(input, fixture.evidence.id);
  stale.principleCitations[0].contentHash = "b".repeat(64);
  assert.throws(
    () => normalizeContentStrategistOutput(stale, input, { principles: principleLibrary }),
    /stale principle hash/
  );
});

test("Strategist requires material, bounded, condition-checked principle use", () => {
  const fixture = directionCases[0];
  const input = buildContentStrategistInput({ direction: fixture.direction, evidence: [fixture.evidence] });
  const empty = readyAnalysis(input, fixture.evidence.id, { principleCitations: [] });
  assert.deepEqual(normalizeContentStrategistOutput(empty, input, { principles: principleLibrary }).principleCitations, []);

  const missingJudgment = readyAnalysis(input, fixture.evidence.id);
  delete missingJudgment.principleCitations[0].appliedJudgment;
  assert.throws(
    () => normalizeContentStrategistOutput(missingJudgment, input, { principles: principleLibrary }),
    /appliedJudgment/
  );

  const tooMany = readyAnalysis(input, fixture.evidence.id, {
    principleCitations: principleLibrary.principles.slice(0, 4).map(principle => ({
      principleId: principle.id,
      contentHash: contentHash(principle),
      relevance: "相关",
      appliedJudgment: "改变一个具体判断",
      applicabilityCheck: "适用条件匹配",
      counterexampleCheck: "反例不阻断",
    })),
  });
  assert.throws(
    () => normalizeContentStrategistOutput(tooMany, input, { principles: principleLibrary }),
    /at most three/
  );
});
