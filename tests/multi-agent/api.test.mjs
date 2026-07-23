import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createMultiAgentApi } from "../../video/multi-agent/api.mjs";

function fixtureJob() {
  return {
    id: "job.fixture",
    pipeline: "visual-director-v4",
    status: "approved",
    approvedAt: "2026-07-22T00:00:00.000Z",
    output: {
      version: 4,
      url: "/video-jobs/job.fixture/final.mp4",
      qaPass: true,
    },
    transcript: {
      segments: [{ start: 0, end: 2, text: "I tested the workflow." }],
    },
    currentPlan: {
      layout: "speaker-right-information-left",
      captions: "anchor",
      motion: ["title-enter"],
    },
    assets: [],
    source: { duration: 2 },
  };
}

async function apiFixture(t, overrides = {}) {
  const artifacts = [];
  const transitions = [];
  const ingestions = [];
  const proposalCalls = [];
  const job = fixtureJob();
  const dependencies = {
    enabled: true,
    defaultPipeline: "visual-director-v4",
    allowedTutorialRoots: ["F:\\allowed-tutorials"],
    readJob: async id => {
      assert.equal(id, "job.fixture");
      return job;
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
      async criticize(candidate) {
        return { id: "review.blind", reviewerId: "blind-critic", candidateId: candidate.id };
      },
      async retentionAudit(candidate) {
        return { id: "review.retention", reviewerId: "retention-critic", candidateId: candidate.id };
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
  };
}

test("status reports opt-in capability while v4 remains the default", async t => {
  const { request } = await apiFixture(t);
  const response = await request("GET", "/api/multi-agent/status");

  assert.equal(response.status, 200);
  assert.equal(response.data.enabled, true);
  assert.equal(response.data.defaultPipeline, "visual-director-v4");
  assert.equal(response.data.autoPublish, false);
  assert.equal(response.data.brandCoreMutable, false);
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
