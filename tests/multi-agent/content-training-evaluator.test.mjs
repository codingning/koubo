import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBlindedContentTrainingRequest,
  createContentTrainingEvaluator,
  normalizeContentTrainingEvaluation,
} from "../../video/multi-agent/content-training-evaluator.mjs";

function record(marker) {
  return {
    input: {
      audienceContext: "想训练个人 Agent 的创作者",
      userFacts: ["已有真实训练记录"],
      evidence: [{ id: "evidence.fixture", kind: "test", summary: "真实训练记录", provenance: "user_provided" }],
      constraints: ["不得虚构效果"],
    },
    analysis: {
      lockedDirection: "分享一次真实的 Agent 训练实验",
      directionRestatement: `保持方向 ${marker}`,
      audience: "想训练个人 Agent 的创作者",
      viewerBenefit: `获得下一步 ${marker}`,
      strengths: [`真实证据 ${marker}`],
      weaknesses: [`缺少重复实验 ${marker}`],
      evidence: { available: [{ id: "evidence.fixture", relevance: marker }], missing: ["盲评"] },
      testableQuestion: `问题 ${marker}`,
      nextQuestions: [`下一步 ${marker}`],
      uncertainties: [`不确定 ${marker}`],
      recommendation: "series",
      status: "needs_evidence",
      principleCitations: marker === "B" ? [{ principleId: "secret-vault-principle" }] : [],
    },
    knowledgeContext: { source: marker === "B" ? "creator-vault" : "none" },
  };
}

test("blinded evaluator request strips knowledge identity and preserves a private mapping", () => {
  const prepared = buildBlindedContentTrainingRequest(record("A"), record("B"));
  const serialized = JSON.stringify(prepared.request);
  assert.equal(serialized.includes("creator-vault"), false);
  assert.equal(serialized.includes("secret-vault-principle"), false);
  assert.equal(serialized.includes("已有真实训练记录"), true);
  assert.deepEqual(new Set(Object.values(prepared.privateMapping)), new Set(["left", "right"]));
  assert.equal(prepared.request.lockedDirection, "分享一次真实的 Agent 训练实验");
});

test("evaluation winner is computed from scores and hard failures, not model preference", () => {
  const result = normalizeContentTrainingEvaluation({
    first: {
      directionUnderstanding: 2,
      evidenceDiscipline: 2,
      actionability: 2,
      boundaryAwareness: 2,
      hardFailures: [],
      summary: "具体且有边界",
    },
    second: {
      directionUnderstanding: 2,
      evidenceDiscipline: 1,
      actionability: 1,
      boundaryAwareness: 1,
      hardFailures: [],
      summary: "较泛",
    },
    comparativeFindings: ["第一项更具体", "第二项证据边界较弱"],
    uncertainties: [],
  }, { first: "right", second: "left" });
  assert.equal(result.winnerPosition, "first");
  assert.equal(result.winnerSource, "right");
  assert.equal(result.candidates.first.total, 8);
});

test("evaluator gets one bounded repair and never grants authority", async () => {
  const calls = [];
  const evaluator = createContentTrainingEvaluator({
    invokeAgent: async request => {
      calls.push(request);
      if (calls.length === 1) return { first: {}, second: {} };
      return {
        first: { directionUnderstanding: 2, evidenceDiscipline: 2, actionability: 2, boundaryAwareness: 2, hardFailures: [], summary: "完整" },
        second: { directionUnderstanding: 2, evidenceDiscipline: 2, actionability: 1, boundaryAwareness: 1, hardFailures: [], summary: "略泛" },
        comparativeFindings: ["第一项行动更具体", "第一项边界更完整"],
        uncertainties: ["仅比较当前样本"],
      };
    },
  });
  const result = await evaluator.evaluate(record("A"), record("B"));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].validationRepair.attempt, 2);
  assert.equal(result.authority.grantsApproval, false);
  assert.equal(result.authority.promotesMemory, false);
});
