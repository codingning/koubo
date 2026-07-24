import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createMultiAgentApi } from "../../video/multi-agent/api.mjs";

function fixtureJob(outputPath) {
  return {
    id: "job.fixture",
    contentId: "content.fixture",
    pipeline: "visual-director-v4",
    status: "approved",
    approvedAt: "2026-07-22T00:00:00.000Z",
    output: {
      version: 4,
      path: outputPath,
      url: "/video-jobs/job.fixture/final.mp4",
      qaPass: true,
      metadata: {
        duration: 1.5,
        width: 1080,
        height: 1920,
      },
    },
    transcript: {
      segments: [{ start: 0, end: 2, text: "I tested the workflow." }],
    },
    ordinaryViewerTranscript: [
      { start: 0, end: 1.5, text: "I tested the edited workflow." },
    ],
    currentPlan: {
      layout: "speaker-right-information-left",
      captions: "anchor",
      motion: ["title-enter"],
    },
    assets: [],
    source: { duration: 2 },
    contentDirection: {
      lockedDirection: "我如何把AI知识变成一个真实动作",
      mainTopic: "我如何把AI知识变成一个真实动作",
      audience: "收藏很多AI方法却迟迟没有行动的普通观众",
      audienceBenefit: "看懂一个可以立即照做的最小动作",
      structureDesign: {
        coreQuestion: "一个普通人怎样真正迈出AI实践第一步？",
      },
    },
  };
}

function fixtureContent() {
  return {
    id: "content.fixture",
    status: "待审核",
    lockedDirection: "我如何审计并试用一个开源 Skill",
    mainTopic: "我如何审计并试用一个开源 Skill",
    audience: "想使用开源AI工具但担心安全和维护成本的普通观众",
    audienceBenefit: "获得一套可复用的开源方案审计顺序",
    structureDesign: {
      coreQuestion: "一个开源 Skill 在真正使用前要检查什么？",
    },
    fullSegments: [
      { text: "这是服务器保存的第一段真实稿件。" },
      { text: "我先检查许可证、安全、维护状态，再做本地试用。" },
    ],
    shortScript: "这是服务器保存的短版稿件。",
    evidence: [
      {
        id: "evidence.skill-audit",
        kind: "audit-report",
        summary: "本地审计记录和试用结果",
      },
    ],
    risks: [{ text: "不得把未验证的开源项目说成安全可用" }],
  };
}

const principleFixture = {
  id: "content-principle.verifiable-history-builds-trust.v1",
  sourceVideoId: "7665740666193874227",
  sourceTitle: "在场即信任：AI时代普通人的资产",
  timecodes: [
    { startSeconds: 498, endSeconds: 544, startLabel: "08:18", endLabel: "09:04" },
  ],
  claim: "长期、真实且可回看的行动历史，比单条观点更难被简单复制。",
  abstraction: "内容分析应寻找第一版、失败、返修、结果和边界。",
  applicability: ["个人项目", "Agent训练", "开源方案试用"],
  counterexamples: ["持续出现但缺少价值和兑现，不会自动形成信任。"],
  status: "candidate_awaiting_user_review",
};

async function apiFixture(t, overrides = {}) {
  const artifacts = [];
  const transitions = [];
  const ingestions = [];
  const proposalCalls = [];
  const contentStrategyCalls = [];
  const ordinaryReviewCalls = [];
  const renderedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-api-rendered-review-"));
  const outputPath = path.join(renderedRoot, "final-v4.mp4");
  fs.writeFileSync(outputPath, "immutable rendered fixture");
  t.after(() => fs.rmSync(renderedRoot, { recursive: true, force: true }));
  const job = fixtureJob(outputPath);
  const content = fixtureContent();
  const dependencies = {
    enabled: true,
    defaultPipeline: "visual-director-v4",
    allowedTutorialRoots: ["F:\\allowed-tutorials"],
    allowedRenderedRoots: [renderedRoot],
    readJob: async id => {
      assert.equal(id, "job.fixture");
      return job;
    },
    readContent: async id => {
      assert.equal(id, "content.fixture");
      return content;
    },
    writeArtifact: async (kind, id, value) => {
      artifacts.push({ kind, id, value });
      return `/runtime/${kind}/${id}.json`;
    },
    readArtifact: async (kind, id) => {
      const artifact = artifacts.find(item => item.kind === kind && item.id === id);
      return artifact?.value ?? null;
    },
    listMemory: async () => [{
      id: "caption.pop.v1",
      status: "recreated",
      namespace: "caption.private",
      apiKey: "must-not-survive",
    }],
    memory: {
      transition(input) {
        transitions.push(input);
        return { id: "transition.fixture", record: { id: input.id, status: input.to } };
      },
      reject(input) {
        transitions.push({ ...input, to: "rejected" });
        return { id: "transition.fixture", record: { id: input.id, status: "rejected" } };
      },
      expire(input) {
        transitions.push({ ...input, to: "expired" });
        return { id: "transition.fixture", record: { id: input.id, status: "expired" } };
      },
      rollback(id) {
        transitions.push({ rollback: id });
        return { id, record: { status: "trial" } };
      },
    },
    tutorials: {
      async ingest(input) {
        ingestions.push(input);
        return { id: "tutorial.fixture", sourceHash: "a".repeat(64), stage: "awaiting_recreation" };
      },
      async get(id) {
        return id === "tutorial.fixture"
          ? { id, sourceHash: "a".repeat(64), stage: "awaiting_recreation" }
          : null;
      },
    },
    orchestrator: {
      async propose(input) {
        proposalCalls.push(input);
        return {
          jobId: input.jobId,
          proposals: [{ id: "proposal.caption", proposalKind: "caption" }],
          events: [],
        };
      },
      async direct(proposals, options) {
        return {
          candidates: [
            {
              id: "candidate-v4-control",
              layout: options.v4Plan.layout,
              captions: { identity: "anchor" },
              motion: { structure: ["title-enter"] },
              sound: { structure: [] },
            },
            {
              id: "candidate-multi-agent-expression",
              layout: "speaker-center-evidence-full",
              captions: { identity: "keyword-pop" },
              motion: { structure: ["evidence-slide"] },
              sound: { structure: ["semantic-cue"] },
            },
          ],
          conflicts: [],
        };
      },
      async criticize(candidate) {
        return { id: "review.blind", reviewerId: "blind-critic", candidateId: candidate.id };
      },
      async retentionAudit(candidate) {
        return { id: "review.retention", reviewerId: "retention-critic", candidateId: candidate.id };
      },
    },
    contentStrategist: {
      async analyze(input, { request }) {
        contentStrategyCalls.push(request);
        const evidenceId = input.evidence[0]?.id;
        const principle = request.candidatePrinciples[0];
        return {
          lockedDirection: input.lockedDirection,
          directionRestatement: `用户希望分析：${input.lockedDirection}`,
          audience: "收藏很多AI方法却迟迟没有行动的普通观众",
          viewerBenefit: "看懂一个真实动作并能立即开始",
          strengths: ["方向由用户提供", "存在真实证据"],
          weaknesses: ["不能把单次结果泛化为普遍规律"],
          evidence: {
            available: evidenceId ? [{ id: evidenceId }] : [],
            missing: evidenceId ? [] : ["真实行动证据"],
          },
          testableQuestion: "这条内容能否让观众完成一个具体动作？",
          principleCitations: [{
            principleId: principle.id,
            contentHash: principle.contentHash,
            relevance: "用于检查方向是否包含真实、可核验的行动历史",
          }],
          recommendation: evidenceId ? "单篇" : "暂缓",
          nextQuestions: ["观众今天最小能做什么？"],
          status: evidenceId ? "可进入成稿" : "补证后再写",
          uncertainties: [],
        };
      },
    },
    contentPrinciples: [principleFixture],
    ordinaryViewerCritic: {
      async review(input, options) {
        ordinaryReviewCalls.push({ input: structuredClone(input), options: structuredClone(options) });
        return {
          sharpConclusion: "内容可以理解，但证据边界必须保留。",
          blockers: [],
          viewerValueGap: "需要让观众明确自己能带走什么。",
          evidenceGap: "只使用服务器权威记录中的证据。",
          minimalFix: "补充一个观众当天能完成的动作。",
          viewerDecision: "清楚且有用",
          classifications: { fact: [], subjective: [], uncertain: [] },
        };
      },
    },
    buildBlindReviewBundle(candidates, context) {
      return {
        schemaVersion: 1,
        jobId: context.jobId,
        candidates: candidates.map((item, index) => ({
          label: String.fromCharCode(65 + index),
          renderHash: item.renderHash,
        })),
      };
    },
    ...overrides,
  };
  const api = createMultiAgentApi(dependencies);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const handled = await api.handle(req, res, url);
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"not found"}');
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  async function request(method, pathname, body, {
    idempotencyKey = "test-key",
    headers = {},
  } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(method === "POST" ? { "Idempotency-Key": idempotencyKey } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  return {
    api,
    request,
    job,
    artifacts,
    transitions,
    ingestions,
    proposalCalls,
    contentStrategyCalls,
    ordinaryReviewCalls,
    content,
  };
}

test("status reports opt-in capability while v4 remains the default", async t => {
  const { request } = await apiFixture(t);
  const response = await request("GET", "/api/multi-agent/status");

  assert.equal(response.status, 200);
  assert.equal(response.data.enabled, true);
  assert.equal(response.data.advisoryEnabled, true);
  assert.equal(response.data.defaultPipeline, "visual-director-v4");
  assert.equal(response.data.autoPublish, false);
  assert.equal(response.data.brandCoreMutable, false);
});

test("content advisory routes can stay enabled while the experimental creative pipeline is disabled", async t => {
  const { request } = await apiFixture(t, { enabled: false, advisoryEnabled: true });
  const status = await request("GET", "/api/multi-agent/status");
  assert.equal(status.data.enabled, false);
  assert.equal(status.data.advisoryEnabled, true);

  const analyzed = await request(
    "POST",
    "/api/multi-agent/content-strategy/analyze",
    {
      direction: "分享我如何训练一个Agent",
      evidence: [{ id: "evidence.advisory", kind: "test", summary: "真实训练记录" }],
    },
    { idempotencyKey: "advisory-with-creative-disabled" }
  );
  assert.equal(analyzed.status, 201);

  const proposal = await request(
    "POST",
    "/api/jobs/job.fixture/multi-agent/proposals",
    {},
    { idempotencyKey: "creative-disabled-proposal" }
  );
  assert.equal(proposal.status, 409);
  assert.match(proposal.data.error, /workflow is disabled/);
});

test("content strategy analysis is idempotent and writes only an independent artifact", async t => {
  const {
    request,
    artifacts,
    contentStrategyCalls,
    job,
    content,
  } = await apiFixture(t);
  const beforeJob = structuredClone(job);
  const beforeContent = structuredClone(content);
  const body = {
    direction: "分享我如何审计并试用一个适合普通人的开源 Skill",
    audienceContext: "想使用开源AI工具但担心安全的普通观众",
    userFacts: ["用户完成了本地审计和试用"],
    evidence: [{
      id: "evidence.skill-audit",
      kind: "audit-report",
      summary: "许可证、安全、维护状态和本地试用结果",
    }],
    constraints: ["不得虚构安全结论"],
  };

  const first = await request(
    "POST",
    "/api/multi-agent/content-strategy/analyze",
    body,
    { idempotencyKey: "content-strategy-analysis-1" }
  );
  const replay = await request(
    "POST",
    "/api/multi-agent/content-strategy/analyze",
    body,
    { idempotencyKey: "content-strategy-analysis-1" }
  );

  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.deepEqual(replay, first);
  assert.equal(contentStrategyCalls.length, 1);
  assert.equal(contentStrategyCalls[0].lockedDirection, body.direction);
  assert.equal(contentStrategyCalls[0].instructions.doNotDraftScriptTitlesHooksShotsOrEditPlan, true);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].kind, "content-strategy-analyses");
  assert.equal(artifacts[0].value.authority.mutatesContent, false);
  assert.equal(artifacts[0].value.authority.mutatesJob, false);
  assert.equal(artifacts[0].value.authority.grantsApproval, false);
  assert.equal(artifacts[0].value.authority.publishes, false);
  assert.equal(artifacts[0].value.authority.promotesMemory, false);
  assert.deepEqual(job, beforeJob);
  assert.deepEqual(content, beforeContent);
});

test("human confirmation creates a separate artifact and only unlocks Script Agent handoff", async t => {
  const { request, artifacts } = await apiFixture(t);
  const analyzed = await request(
    "POST",
    "/api/multi-agent/content-strategy/analyze",
    {
      direction: "分享个人项目从第一版失败到返修的真实过程",
      evidence: [{
        id: "evidence.project-version",
        kind: "version-diff",
        summary: "第一版、失败原因、修改和结果",
      }],
    },
    { idempotencyKey: "strategy-for-confirmation" }
  );
  const confirmed = await request(
    "POST",
    "/api/multi-agent/content-strategy/confirm",
    {
      analysisArtifactId: analyzed.data.analysisArtifactId,
      decision: "approved",
      actor: { type: "human", id: "owner" },
      note: "方向与分析已确认",
    },
    { idempotencyKey: "strategy-human-confirmation" }
  );

  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.data.confirmation.decision, "approved");
  assert.equal(confirmed.data.confirmation.scriptHandoffAllowed, true);
  assert.equal(confirmed.data.confirmation.authority.strategistMayDraft, false);
  assert.equal(confirmed.data.confirmation.authority.grantsPublishApproval, false);
  assert.match(artifacts[0].value.contentHash, /^[a-f0-9]{64}$/);
  assert.match(artifacts[1].value.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(artifacts[1].value.analysisContentHash, artifacts[0].value.contentHash);
  assert.deepEqual(
    artifacts.map(item => item.kind),
    ["content-strategy-analyses", "content-strategy-confirmations"]
  );
});

test("human confirmation rejects an analysis artifact changed after it was written", async t => {
  const { request, artifacts } = await apiFixture(t);
  const analyzed = await request(
    "POST",
    "/api/multi-agent/content-strategy/analyze",
    {
      direction: "分享一次真实Agent训练",
      evidence: [{ id: "evidence.agent", kind: "test", summary: "真实失败与回归" }],
    },
    { idempotencyKey: "strategy-before-tamper" }
  );
  artifacts[0].value.analysis.viewerBenefit = "未经用户确认的新收益";

  const response = await request(
    "POST",
    "/api/multi-agent/content-strategy/confirm",
    {
      analysisArtifactId: analyzed.data.analysisArtifactId,
      decision: "approved",
      actor: { type: "human", id: "owner" },
    },
    { idempotencyKey: "strategy-confirm-tampered" }
  );

  assert.equal(response.status, 409);
  assert.match(response.data.error, /content hash is missing or invalid/);
  assert.equal(artifacts.length, 1);
});

test("content strategy confirmation rejects non-human actors", async t => {
  const { request, artifacts } = await apiFixture(t);
  const analyzed = await request(
    "POST",
    "/api/multi-agent/content-strategy/analyze",
    {
      direction: "记录训练一个内容Agent的真实过程",
      evidence: [{ id: "evidence.agent-run", kind: "evaluation", summary: "失败与回归记录" }],
    },
    { idempotencyKey: "strategy-agent-confirm-source" }
  );
  const response = await request(
    "POST",
    "/api/multi-agent/content-strategy/confirm",
    {
      analysisArtifactId: analyzed.data.analysisArtifactId,
      decision: "approved",
      actor: { type: "agent", id: "content-strategist" },
    },
    { idempotencyKey: "strategy-agent-confirm-rejected" }
  );

  assert.equal(response.status, 409);
  assert.match(response.data.error, /human actor/);
  assert.deepEqual(artifacts.map(item => item.kind), ["content-strategy-analyses"]);
});

test("content ordinary review reads the authoritative script and cannot mutate content", async t => {
  const { request, content, ordinaryReviewCalls, artifacts } = await apiFixture(t);
  const before = structuredClone(content);

  const response = await request(
    "POST",
    "/api/contents/content.fixture/multi-agent/ordinary-review",
    { variant: "full" },
    { idempotencyKey: "content-ordinary-review-1" }
  );

  assert.equal(response.status, 201);
  assert.equal(response.data.inspectionMode, "script_text");
  assert.equal(ordinaryReviewCalls.length, 1);
  assert.equal(ordinaryReviewCalls[0].options.stage, "script");
  assert.equal(
    ordinaryReviewCalls[0].input.script,
    content.fullSegments.map(item => item.text).join("\n")
  );
  assert.equal(ordinaryReviewCalls[0].input.facts[0].sourceId, "evidence.skill-audit");
  assert.equal(artifacts[0].kind, "ordinary-viewer-reviews");
  assert.equal(artifacts[0].value.subject.source, "authoritative_readContent");
  assert.deepEqual(content, before);
});

test("content ordinary review rejects a client-forged script candidate", async t => {
  const { request, ordinaryReviewCalls, artifacts } = await apiFixture(t);
  const response = await request(
    "POST",
    "/api/contents/content.fixture/multi-agent/ordinary-review",
    { script: "客户端伪造的完整稿件" },
    { idempotencyKey: "content-forged-script" }
  );

  assert.equal(response.status, 400);
  assert.match(response.data.error, /authoritative server data/);
  assert.equal(ordinaryReviewCalls.length, 0);
  assert.equal(artifacts.length, 0);
});

test("job ordinary review uses authoritative transcript and marks missing visual evidence", async t => {
  const { request, job, ordinaryReviewCalls, artifacts } = await apiFixture(t);
  const before = structuredClone(job);

  const response = await request(
    "POST",
    "/api/jobs/job.fixture/multi-agent/ordinary-review",
    {},
    { idempotencyKey: "job-ordinary-review-1" }
  );

  assert.equal(response.status, 201);
  assert.equal(response.data.inspectionMode, "transcript_and_metadata_only");
  assert.equal(ordinaryReviewCalls.length, 1);
  assert.equal(ordinaryReviewCalls[0].options.stage, "render");
  assert.deepEqual(ordinaryReviewCalls[0].input.transcript, job.ordinaryViewerTranscript);
  assert.equal(ordinaryReviewCalls[0].input.media.durationSeconds, job.output.metadata.duration);
  assert.equal(ordinaryReviewCalls[0].input.media.width, job.output.metadata.width);
  assert.equal(ordinaryReviewCalls[0].input.media.height, job.output.metadata.height);
  assert.deepEqual(ordinaryReviewCalls[0].input.frameEvidence, []);
  assert.match(ordinaryReviewCalls[0].input.media.attachment, /^media:\/\/jobs\/job\.fixture\/outputs\/4\/[a-f0-9]{64}$/);
  assert.equal(artifacts[0].kind, "ordinary-viewer-reviews");
  assert.equal(artifacts[0].value.inspectionMode, "transcript_and_metadata_only");
  assert.equal(artifacts[0].value.outputVersion, 4);
  assert.match(artifacts[0].value.mediaSha256, /^[a-f0-9]{64}$/);
  assert.match(artifacts[0].value.transcriptSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(artifacts[0].value).includes(job.output.path), false);
  assert.equal(artifacts[0].value.authority.grantsApproval, false);
  assert.equal(artifacts[0].value.authority.publishes, false);
  assert.equal(artifacts[0].value.authority.promotesMemory, false);
  assert.deepEqual(job, before);
});

test("job ordinary review rejects an unrendered job", async t => {
  const { request, job, ordinaryReviewCalls, artifacts } = await apiFixture(t);
  delete job.output;

  const response = await request(
    "POST",
    "/api/jobs/job.fixture/multi-agent/ordinary-review",
    {},
    { idempotencyKey: "job-ordinary-review-unrendered" }
  );

  assert.equal(response.status, 409);
  assert.match(response.data.error, /no immutable rendered output version/);
  assert.equal(ordinaryReviewCalls.length, 0);
  assert.equal(artifacts.length, 0);
});

test("ordinary review rejects a confirmation artifact bound to another locked direction", async t => {
  const { request, ordinaryReviewCalls, artifacts } = await apiFixture(t);
  const analyzed = await request(
    "POST",
    "/api/multi-agent/content-strategy/analyze",
    {
      direction: "另一个完全不同的方向",
      evidence: [{ id: "evidence.other", kind: "test", summary: "另一方向的证据" }],
    },
    { idempotencyKey: "strategy-other-direction" }
  );
  const confirmed = await request(
    "POST",
    "/api/multi-agent/content-strategy/confirm",
    {
      analysisArtifactId: analyzed.data.analysisArtifactId,
      decision: "approved",
      actor: { type: "human", id: "owner" },
    },
    { idempotencyKey: "strategy-other-direction-confirm" }
  );

  const response = await request(
    "POST",
    "/api/contents/content.fixture/multi-agent/ordinary-review",
    { directionConfirmationArtifactId: confirmed.data.confirmationArtifactId },
    { idempotencyKey: "content-review-wrong-direction" }
  );

  assert.equal(response.status, 409);
  assert.match(response.data.error, /different locked direction/);
  assert.equal(ordinaryReviewCalls.length, 0);
  assert.deepEqual(
    artifacts.map(item => item.kind),
    ["content-strategy-analyses", "content-strategy-confirmations"]
  );
});

test("job ordinary review binds an explicit confirmation to the linked content direction", async t => {
  const { request, ordinaryReviewCalls, artifacts } = await apiFixture(t);
  const analyzed = await request(
    "POST",
    "/api/multi-agent/content-strategy/analyze",
    {
      direction: "与 linked content 不同的方向",
      evidence: [{ id: "evidence.job-other", kind: "test", summary: "另一方向证据" }],
    },
    { idempotencyKey: "strategy-job-other-direction" }
  );
  const confirmed = await request(
    "POST",
    "/api/multi-agent/content-strategy/confirm",
    {
      analysisArtifactId: analyzed.data.analysisArtifactId,
      decision: "approved",
      actor: { type: "human", id: "owner" },
    },
    { idempotencyKey: "strategy-job-other-confirm" }
  );

  const response = await request(
    "POST",
    "/api/jobs/job.fixture/multi-agent/ordinary-review",
    { directionConfirmationArtifactId: confirmed.data.confirmationArtifactId },
    { idempotencyKey: "job-review-wrong-direction" }
  );

  assert.equal(response.status, 409);
  assert.match(response.data.error, /different locked direction/);
  assert.equal(ordinaryReviewCalls.length, 0);
  assert.deepEqual(
    artifacts.map(item => item.kind),
    ["content-strategy-analyses", "content-strategy-confirmations"]
  );
});

test("job ordinary review rejects client-provided frame evidence", async t => {
  const { request, ordinaryReviewCalls } = await apiFixture(t);
  const response = await request(
    "POST",
    "/api/jobs/job.fixture/multi-agent/ordinary-review",
    {
      frameEvidence: [{
        artifactId: "vision:client-forged",
        sourceId: "client",
        start: 0,
        end: 1,
        observation: "伪造画面结论",
      }],
    },
    { idempotencyKey: "job-forged-frames" }
  );

  assert.equal(response.status, 400);
  assert.match(response.data.error, /authoritative server data/);
  assert.equal(ordinaryReviewCalls.length, 0);
});

test("every new mutation route requires Idempotency-Key", async t => {
  const { request } = await apiFixture(t);
  const routes = [
    ["/api/multi-agent/content-strategy/analyze", { direction: "测试方向" }],
    ["/api/multi-agent/content-strategy/confirm", { analysisArtifactId: "missing", decision: "approved", actor: { type: "human", id: "owner" } }],
    ["/api/contents/content.fixture/multi-agent/ordinary-review", {}],
    ["/api/jobs/job.fixture/multi-agent/ordinary-review", {}],
  ];
  for (const [pathname, body] of routes) {
    const response = await request("POST", pathname, body, {
      headers: { "Idempotency-Key": "" },
    });
    assert.equal(response.status, 400, pathname);
    assert.match(response.data.error, /Idempotency-Key/, pathname);
  }
});

test("proposal route cannot mutate job approval or output", async t => {
  const { request, job, proposalCalls, artifacts } = await apiFixture(t);
  const before = structuredClone(job);

  const response = await request(
    "POST",
    "/api/jobs/job.fixture/multi-agent/proposals",
    {}
  );

  assert.equal(response.status, 202);
  assert.deepEqual(job.output, before.output);
  assert.equal(job.approvedAt, before.approvedAt);
  assert.equal(job.status, before.status);
  assert.equal(proposalCalls.length, 1);
  assert.equal("sourcePath" in proposalCalls[0], false);
  assert.equal(artifacts[0].kind, "proposals");
  assert.equal(response.data.bundle.candidates.length, 2);
  assert.equal(response.data.bundle.candidates[0].id, "candidate-v4-control");
});

test("memory promotion rejects non-human approval before calling memory", async t => {
  const { request, transitions } = await apiFixture(t);

  const response = await request(
    "POST",
    "/api/multi-agent/memory/technique-card/caption.pop.v1/promote",
    {
      actor: { type: "agent", id: "director-agent" },
      expectedHash: "a".repeat(64),
      evidence: [],
    }
  );

  assert.equal(response.status, 409);
  assert.match(response.data.error, /human actor/);
  assert.equal(transitions.length, 0);
});

test("idempotency key replays a mutation without executing it twice", async t => {
  const { request, transitions } = await apiFixture(t);
  const body = {
    actor: { type: "human", id: "owner" },
    expectedHash: "a".repeat(64),
    evidence: [{
      type: "human-review",
      reviewerId: "owner",
      projectId: "job.fixture",
      decision: "approved",
    }],
  };

  const first = await request(
    "POST",
    "/api/multi-agent/memory/technique-card/caption.pop.v1/approve",
    body,
    { idempotencyKey: "same-transition" }
  );
  const second = await request(
    "POST",
    "/api/multi-agent/memory/technique-card/caption.pop.v1/approve",
    body,
    { idempotencyKey: "same-transition" }
  );

  assert.equal(first.status, 200);
  assert.deepEqual(second, first);
  assert.equal(transitions.length, 1);
});

test("tutorial ingestion accepts only configured local roots", async t => {
  const { request, ingestions } = await apiFixture(t);

  const rejected = await request("POST", "/api/multi-agent/tutorials", {
    inputPath: "C:\\Users\\owner\\Downloads\\untrusted.mp4",
    author: "owner",
    license: "self-created",
  });
  assert.equal(rejected.status, 403);
  assert.equal(ingestions.length, 0);

  const accepted = await request("POST", "/api/multi-agent/tutorials", {
    inputPath: "F:\\allowed-tutorials\\lesson.mp4",
    author: "owner",
    license: "self-created",
  }, { idempotencyKey: "tutorial-1" });
  assert.equal(accepted.status, 202);
  assert.equal(ingestions.length, 1);
});

test("memory listing redacts secret-shaped fields", async t => {
  const { request } = await apiFixture(t);
  const response = await request("GET", "/api/multi-agent/memory");

  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(response.data).includes("must-not-survive"), false);
});

test("A/B and review routes write artifacts but never approve a job", async t => {
  const { request, job, artifacts } = await apiFixture(t);
  const before = structuredClone(job);
  const candidates = [
    { id: "v4", renderHash: "a".repeat(64) },
    { id: "multi", renderHash: "b".repeat(64) },
  ];

  const ab = await request(
    "POST",
    "/api/jobs/job.fixture/multi-agent/ab",
    { candidates },
    { idempotencyKey: "ab-key-01" }
  );
  const reviews = await request(
    "POST",
    "/api/jobs/job.fixture/multi-agent/reviews",
    { candidate: candidates[1] },
    { idempotencyKey: "reviews-1" }
  );

  assert.equal(ab.status, 201);
  assert.equal(reviews.status, 201);
  assert.deepEqual(job, before);
  assert.deepEqual(artifacts.map(item => item.kind), ["blind-bundles", "reviews"]);
});

test("disabled mutation endpoints return 409 while status stays readable", async t => {
  const { request } = await apiFixture(t, { enabled: false });

  assert.equal((await request("GET", "/api/multi-agent/status")).status, 200);
  const response = await request(
    "POST",
    "/api/jobs/job.fixture/multi-agent/proposals",
    {}
  );
  assert.equal(response.status, 409);
  assert.match(response.data.error, /disabled/);
});

test("artifact route is read-only and redacts secret-shaped fields", async t => {
  const { request, artifacts } = await apiFixture(t);
  artifacts.push({
    kind: "reviews",
    id: "job-1.review-1",
    value: {
      winner: "candidate-b",
      accessToken: "must-not-leak",
    },
  });

  const response = await request(
    "GET",
    "/api/multi-agent/artifacts/reviews/job-1.review-1"
  );

  assert.equal(response.status, 200);
  assert.equal(response.data.artifact.winner, "candidate-b");
  assert.equal("accessToken" in response.data.artifact, false);
});
