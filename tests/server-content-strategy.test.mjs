import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildOrdinaryViewerCriticRequest } from "../video/multi-agent/ordinary-viewer-critic.mjs";
import { contentHash } from "../video/multi-agent/contracts.mjs";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-server-content-strategy-"));
process.env.KOUBO_NO_LISTEN = "1";
process.env.KOUBO_MULTI_AGENT_DATA_ROOT = dataRoot;

const serverModule = await import(`../video/server.mjs?content-strategy-test=${Date.now()}`);
const {
  auditGeneratedContentScript,
  buildGeneratedContentScriptAuditInput,
  closeServerResourcesForTests,
  createWorkspaceEvidenceSnapshot,
  generateContent,
  hashLockedDirection,
  normalizeRequiredReferenceSourceIds,
  preserveLockedDirection,
  validateContentGenerationStrategy,
  writeMultiAgentArtifact,
} = serverModule;

test("workspace evidence snapshot reads only safe relative text files and derives provenance server-side", async () => {
  const snapshot = await createWorkspaceEvidenceSnapshot({
    paths: ["tests/server-content-strategy.test.mjs"],
  }, { workspaceId: "acceptance-workspace" });
  assert.equal(snapshot.workspaceId, "acceptance-workspace");
  assert.equal(snapshot.files[0].relativePath, "tests/server-content-strategy.test.mjs");
  assert.match(snapshot.files[0].sha256, /^[a-f0-9]{64}$/u);
  assert.equal(snapshot.evidence[0].provenance, "workspace_verified");
  assert.equal(snapshot.evidence[0].summary.includes(process.cwd()), false);

  await assert.rejects(
    () => createWorkspaceEvidenceSnapshot({ paths: [".env"] }),
    /non-hidden workspace-relative files/i
  );
  await assert.rejects(
    () => createWorkspaceEvidenceSnapshot({ paths: ["../outside.txt"] }),
    /workspace-relative files/i
  );
});

test("required reference ids are normalized separately from content evidence ids", () => {
  assert.deepEqual(normalizeRequiredReferenceSourceIds({
    requiredReferenceSourceIds: ["douyin-7641901934210813234", "douyin-7641901934210813234", ""],
    requiredReference: "douyin-7662756855256562067",
    requiredSourceIds: ["job-20260725062114-297235-v2", "proof-sample-final"],
  }), [
    "douyin-7641901934210813234",
    "douyin-7662756855256562067",
  ]);
});

test.after(async () => {
  await closeServerResourcesForTests();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

function strategyInput(direction, { evidence = true } = {}) {
  return {
    schemaVersion: 1,
    stage: "direction_analysis",
    lockedDirection: direction,
    directionAuthority: {
      owner: "user",
      strategistMayReplace: false,
    },
    evidence: evidence ? [{
      id: "evidence.real-result",
      kind: "result",
      summary: "真实输入、动作和结果",
      sourceId: "evidence.real-result",
      provenance: "user_provided",
    }] : [],
    userConfirmation: {
      analysisApproved: false,
      confirmedDirection: null,
    },
  };
}

function strategyAnalysis(direction, { evidence = true, missing = [], status = "ready_for_script" } = {}) {
  return {
    schemaVersion: 1,
    lockedDirection: direction,
    audience: "收藏了很多AI方法但还没有开始行动的普通人",
    viewerBenefit: "看到一个可执行动作及真实结果",
    testableQuestion: "观众能否据此完成同样的第一步？",
    status,
    evidence: {
      available: evidence ? [{ id: "evidence.real-result" }] : [],
      missing,
    },
  };
}

function strategyArtifacts(direction, options = {}) {
  const analysisDirection = options.analysisDirection || direction;
  const analysisArtifactId = options.analysisArtifactId || "analysis.ready";
  const confirmationArtifactId = options.confirmationArtifactId || "confirmation.ready";
  const input = strategyInput(analysisDirection, options);
  const analysis = strategyAnalysis(analysisDirection, options);
  const analysisArtifactCore = {
    schemaVersion: 1,
    kind: "content_strategy_analysis",
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    input,
    analysis,
    principleIds: [],
    analyzedAt: "2026-07-24T06:00:00.000Z",
    authority: {
      directionOwner: "user",
      strategistMayDraft: false,
      grantsApproval: false,
      publishes: false,
    },
  };
  const analysisArtifact = {
    ...analysisArtifactCore,
    contentHash: contentHash(analysisArtifactCore),
  };
  const confirmationCore = {
    schemaVersion: 1,
    kind: "content_strategy_human_confirmation",
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    analysisArtifactId,
    analysisContentHash: options.analysisContentHash || analysisArtifact.contentHash,
    lockedDirection: options.confirmationDirection || direction,
    approvedDirection: options.approvedDirection || {
      audience: analysis.audience,
      viewerBenefit: analysis.viewerBenefit,
      coreQuestion: analysis.testableQuestion,
      constraints: input.constraints || [],
    },
    decision: options.decision || "approved",
    actor: options.actor || { type: "human", id: "owner" },
    note: "用户已确认方向与分析",
    confirmedAt: "2026-07-24T06:05:00.000Z",
    scriptHandoffAllowed: options.scriptHandoffAllowed ?? true,
    authority: {
      confirmsAnalysisOnly: true,
      strategistMayDraft: false,
      grantsPublishApproval: false,
    },
  };
  const confirmation = {
    ...confirmationCore,
    contentHash: contentHash(confirmationCore),
  };
  const records = new Map([
    [`content-strategy-analyses/${analysisArtifactId}`, analysisArtifact],
    [`content-strategy-confirmations/${confirmationArtifactId}`, confirmation],
  ]);
  const reads = [];
  return {
    analysisArtifactId,
    confirmationArtifactId,
    analysisArtifact,
    confirmation,
    reads,
    readArtifactFn: async (kind, id) => {
      reads.push({ kind, id });
      return records.get(`${kind}/${id}`) || null;
    },
  };
}

function lockedOptions(direction, artifacts = strategyArtifacts(direction)) {
  return {
    lockedDirection: direction,
    lockedDirectionHash: hashLockedDirection(direction),
    strategyConfirmationArtifactId: artifacts.confirmationArtifactId,
  };
}

test("legacy empty generation request fails clearly before any AI operation", async () => {
  const calls = [];
  await assert.rejects(
    () => generateContent({}, {
      runAiFn: async payload => {
        calls.push(payload.operation);
        throw new Error("must not run");
      },
    }),
    error => error.statusCode === 422
      && /lockedDirection/.test(error.message)
      && /allowAgentTopicSearch=true/.test(error.message)
  );
  assert.deepEqual(calls, []);
});

test("multi-agent artifacts are create-only across idempotency cache restarts", async () => {
  const first = await writeMultiAgentArtifact("content-strategy-analyses", "immutable.fixture", {
    schemaVersion: 1,
    value: "original",
  });
  const replay = await writeMultiAgentArtifact("content-strategy-analyses", "immutable.fixture", {
    schemaVersion: 1,
    value: "original",
  });
  assert.equal(replay, first);
  await assert.rejects(
    () => writeMultiAgentArtifact("content-strategy-analyses", "immutable.fixture", {
      schemaVersion: 1,
      value: "replacement",
    }),
    /immutable content/i
  );
});

test("unconfirmed strategy cannot call plan_topic or generate_content", async () => {
  const direction = "展示我完成AI第一步后拿到的真实第二步";
  const calls = [];
  const artifacts = strategyArtifacts(direction, {
    decision: "rejected",
    scriptHandoffAllowed: false,
  });
  await assert.rejects(
    () => generateContent(lockedOptions(direction, artifacts), {
      runAiFn: async payload => calls.push(payload.operation),
      readArtifactFn: artifacts.readArtifactFn,
    }),
    /not approved|Script Agent handoff/i
  );
  assert.deepEqual(calls, []);
});

test("missing evidence keeps the server-side script gate closed", async () => {
  const direction = "展示一次没有证据的自动化结果";
  const calls = [];
  const artifacts = strategyArtifacts(direction, {
    evidence: false,
    missing: ["真实运行记录"],
    scriptHandoffAllowed: true,
  });
  await assert.rejects(
    () => generateContent(lockedOptions(direction, artifacts), {
      runAiFn: async payload => calls.push(payload.operation),
      readArtifactFn: artifacts.readArtifactFn,
    }),
    /evidence|证据/i
  );
  assert.deepEqual(calls, []);
});

test("client-provided embedded strategy artifacts are rejected even when self-consistent", async () => {
  const direction = "展示我如何把一次真实失败改成第二版";
  const artifacts = strategyArtifacts(direction);
  await assert.rejects(
    () => validateContentGenerationStrategy({
      ...lockedOptions(direction, artifacts),
      strategyArtifact: {
        schemaVersion: 1,
        lockedDirection: direction,
        input: artifacts.analysisArtifact.input,
        analysis: artifacts.analysisArtifact.analysis,
        contentHash: "a".repeat(64),
      },
    }, { readArtifactFn: artifacts.readArtifactFn }),
    /client-provided.*not authoritative|embedded strategy/i
  );
  assert.deepEqual(artifacts.reads, []);
});

test("request direction hash and authoritative confirmation direction must match", async () => {
  const direction = "展示我如何把一次真实失败改成第二版";
  const artifacts = strategyArtifacts(direction);

  await assert.rejects(
    () => validateContentGenerationStrategy({
      ...lockedOptions(direction, artifacts),
      lockedDirectionHash: "0".repeat(64),
    }, { readArtifactFn: artifacts.readArtifactFn }),
    /direction hash/i
  );

  await assert.rejects(
    () => validateContentGenerationStrategy({
      ...lockedOptions("另一个方向", artifacts),
      lockedDirectionHash: hashLockedDirection("另一个方向"),
    }, { readArtifactFn: artifacts.readArtifactFn }),
    /confirmation artifact direction/i
  );
});

test("content generation cannot reuse strategy artifacts from another workspace", async () => {
  const direction = "解释本地工具的写接口安全边界";
  const artifacts = strategyArtifacts(direction, { workspaceId: "workspace-a" });
  await assert.rejects(
    () => validateContentGenerationStrategy({
      ...lockedOptions(direction, artifacts),
      workspaceId: "workspace-b",
    }, { readArtifactFn: artifacts.readArtifactFn }),
    error => error.statusCode === 404 && /different workspace/i.test(error.message)
  );
});

test("confirmation bound to a different analysis direction is rejected", async () => {
  const direction = "展示我如何把一次真实失败改成第二版";
  const artifacts = strategyArtifacts(direction, { analysisDirection: "另一个分析方向" });
  await assert.rejects(
    () => validateContentGenerationStrategy(
      lockedOptions(direction, artifacts),
      { readArtifactFn: artifacts.readArtifactFn }
    ),
    /different locked direction/i
  );
});

test("confirmation cannot silently follow replaced or differently hashed analysis content", async () => {
  const direction = "展示我如何把一次真实失败改成第二版";
  const staleBinding = strategyArtifacts(direction, { analysisContentHash: "0".repeat(64) });
  await assert.rejects(
    () => validateContentGenerationStrategy(
      lockedOptions(direction, staleBinding),
      { readArtifactFn: staleBinding.readArtifactFn }
    ),
    /different analysis content hash/i
  );

  const replaced = strategyArtifacts(direction);
  replaced.analysisArtifact.analysis.viewerBenefit = "服务重启后被替换的未确认分析";
  await assert.rejects(
    () => validateContentGenerationStrategy(
      lockedOptions(direction, replaced),
      { readArtifactFn: replaced.readArtifactFn }
    ),
    /content hash is missing or invalid/i
  );
});

test("direction or authoritative artifact mismatches stop before every AI operation", async () => {
  const direction = "展示我如何把一次真实失败改成第二版";
  const artifacts = strategyArtifacts(direction);
  const calls = [];
  const runAiFn = async payload => calls.push(payload.operation);

  await assert.rejects(
    () => generateContent({
      ...lockedOptions(direction, artifacts),
      lockedDirectionHash: "0".repeat(64),
    }, { runAiFn, readArtifactFn: artifacts.readArtifactFn }),
    /direction hash/i
  );
  const misbound = strategyArtifacts(direction, { analysisDirection: "错绑分析方向" });
  await assert.rejects(
    () => generateContent(lockedOptions(direction, misbound), {
      runAiFn,
      readArtifactFn: misbound.readArtifactFn,
    }),
    /different locked direction/i
  );
  assert.deepEqual(calls, []);
});

test("a real confirmation-to-analysis artifact chain unlocks the user-locked context", async () => {
  const direction = "展示我完成AI第一步后拿到的真实第二步";
  const artifacts = strategyArtifacts(direction);
  const gate = await validateContentGenerationStrategy(
    lockedOptions(direction, artifacts),
    { readArtifactFn: artifacts.readArtifactFn }
  );

  assert.equal(gate.mode, "user_locked_strategy");
  assert.equal(gate.lockedDirection, direction);
  assert.equal(gate.lockedDirectionHash, hashLockedDirection(direction));
  assert.match(gate.strategyArtifactHash, /^[a-f0-9]{64}$/);
  assert.equal(gate.strategyConfirmationArtifactId, artifacts.confirmationArtifactId);
  assert.equal(gate.strategyAnalysisArtifactId, artifacts.analysisArtifactId);
  assert.deepEqual(artifacts.reads, [
    { kind: "content-strategy-confirmations", id: artifacts.confirmationArtifactId },
    { kind: "content-strategy-analyses", id: artifacts.analysisArtifactId },
  ]);
});

test("plan and final content preserve the exact locked direction and hash", async () => {
  const direction = "展示我完成AI第一步后拿到的真实第二步";
  const artifacts = strategyArtifacts(direction);
  const gate = await validateContentGenerationStrategy(
    lockedOptions(direction, artifacts),
    { readArtifactFn: artifacts.readArtifactFn }
  );
  const plan = preserveLockedDirection({ topic: direction }, gate, "plan_topic");
  const content = preserveLockedDirection({ mainTopic: direction }, gate, "generate_content");

  for (const value of [plan, content]) {
    assert.equal(value.lockedDirection, direction);
    assert.equal(value.lockedDirectionHash, hashLockedDirection(direction));
    assert.equal(value.directionSource, "explicit_user_direction");
  }

  assert.throws(
    () => preserveLockedDirection({ lockedDirection: "被模型换掉的方向" }, gate, "plan_topic"),
    /changed the locked direction/i
  );
  assert.throws(
    () => preserveLockedDirection({ topic: "模型擅自换成的新选题" }, gate, "plan_topic"),
    /changed the user-locked topic field/i
  );
  assert.throws(
    () => preserveLockedDirection({ mainTopic: "模型擅自换成的新选题" }, gate, "generate_content"),
    /changed the user-locked topic field/i
  );
});

test("Agent topic search is allowed only by an explicit boolean true", async () => {
  await assert.rejects(
    () => validateContentGenerationStrategy({ allowAgentTopicSearch: "true" }),
    /lockedDirection/
  );

  const searchGate = await validateContentGenerationStrategy({ allowAgentTopicSearch: true });
  assert.equal(searchGate.mode, "agent_topic_search_explicit");
  assert.equal(searchGate.lockedDirection, null);

  const lockedPlan = preserveLockedDirection({
    mainTopic: "用一次真实AI实践解决一个具体麻烦",
  }, searchGate, "plan_topic");
  assert.equal(lockedPlan.lockedDirection, "用一次真实AI实践解决一个具体麻烦");
  assert.equal(lockedPlan.lockedDirectionHash, hashLockedDirection(lockedPlan.lockedDirection));
  assert.equal(lockedPlan.directionSource, "agent_topic_search_explicitly_allowed");
});

test("generated content automatically produces a visible Ordinary Viewer script audit", async () => {
  const direction = "展示我完成AI第一步后拿到的真实第二步";
  const artifacts = strategyArtifacts(direction);
  const gate = await validateContentGenerationStrategy(
    lockedOptions(direction, artifacts),
    { readArtifactFn: artifacts.readArtifactFn }
  );
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-script-audit-pass-"));
  const content = {
    id: "content-audit-pass",
    status: "待审核",
    audienceBenefit: "观众能完成同样的第一步",
    fullSegments: [
      { text: "我做完了上一条的三十秒动作。" },
      { text: "这是AI真实给出的第二步和我执行后的结果。" },
    ],
    sourceFiles: [],
  };
  let captured;
  const critic = {
    async review(input) {
      captured = input;
      return {
        sharpConclusion: "真实输入、动作和结果已经形成普通观众可理解的闭环",
        blockers: [],
        viewerValueGap: "无明显缺口",
        evidenceGap: "发布前仍需核对原始截图时间顺序",
        minimalFix: "只核对证据连续性，不扩写新结论",
        viewerDecision: "清楚且有用",
        classifications: { fact: [], subjective: [], uncertain: [] },
      };
    },
  };

  try {
    const artifact = await auditGeneratedContentScript({
      content,
      generationContext: gate,
      topicPlan: { coreQuestion: "完成第一步后AI会给什么？" },
      outputDirectory,
      critic,
    });

    assert.equal(captured.stage, "script");
    assert.match(captured.script, /真实给出的第二步/);
    assert.ok(captured.approvedDirection.constraints.includes(`lockedDirection: ${direction}`));
    assert.doesNotThrow(() => buildOrdinaryViewerCriticRequest(captured));
    assert.equal(artifact.status, "complete");
    assert.equal(content.status, "待审核");
    assert.equal(content.ordinaryViewerAudit.status, "complete");
    assert.equal(content.ordinaryViewerAudit.viewerDecision, "清楚且有用");
    const saved = JSON.parse(fs.readFileSync(path.join(outputDirectory, "ordinary-viewer-review.json"), "utf8"));
    assert.equal(saved.authority.mayApproveProduction, false);
    assert.equal(saved.authority.mayApprovePublish, false);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("Ordinary Viewer audit failure is persisted and never changes review or publish status", async () => {
  const direction = "展示我完成AI第一步后拿到的真实第二步";
  const artifacts = strategyArtifacts(direction);
  const gate = await validateContentGenerationStrategy(
    lockedOptions(direction, artifacts),
    { readArtifactFn: artifacts.readArtifactFn }
  );
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-script-audit-fail-"));
  const content = {
    id: "content-audit-fail",
    status: "待审核",
    fullSegments: [{ text: "真实稿件" }],
    sourceFiles: [],
  };
  const privatePath = "C:\\Users\\owner\\private\\ordinary-review.json";

  try {
    const artifact = await auditGeneratedContentScript({
      content,
      generationContext: gate,
      topicPlan: {},
      outputDirectory,
      critic: { review: async () => { throw new Error(`critic runtime unavailable at ${privatePath}`); } },
    });

    assert.equal(artifact.status, "failed");
    assert.match(artifact.error, /runtime unavailable/);
    assert.match(artifact.error, /<local-path>/);
    assert.equal(artifact.error.includes(privatePath), false);
    assert.equal(content.status, "待审核");
    assert.equal(content.ordinaryViewerAudit.status, "failed");
    assert.equal("approvedAt" in content, false);
    assert.equal("publish" in content, false);
    const saved = JSON.parse(fs.readFileSync(path.join(outputDirectory, "ordinary-viewer-review.json"), "utf8"));
    assert.equal(saved.status, "failed");
    assert.equal(JSON.stringify(saved).includes(privatePath), false);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("generated Ordinary Viewer facts never expose local evidence locators", () => {
  const privatePath = "C:\\private\\secret.json";
  const input = buildGeneratedContentScriptAuditInput({
    fullSegments: [{ text: "这是一次真实测试。" }],
  }, {
    lockedDirection: "分享一次真实测试",
    strategyArtifact: {
      input: {
        evidence: [{
          id: "evidence.private-run",
          sourceId: "evidence.private-run",
          provenance: "workspace_verified",
          kind: "run-log",
          summary: `真实运行记录位于 ${privatePath}`,
          locator: privatePath,
        }],
      },
      analysis: {
        audience: "需要具体行动的普通观众",
        viewerBenefit: "理解一次真实测试",
        testableQuestion: "观众是否获得可复用动作？",
      },
    },
  });

  assert.equal(JSON.stringify(input).includes(privatePath), false);
  assert.equal("evidence" in input.facts[0], false);
  assert.match(input.facts[0].claim, /<local-path>/);
  assert.doesNotThrow(() => buildOrdinaryViewerCriticRequest(input));
});
