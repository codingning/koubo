import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditRenderedJobOrdinaryViewer,
  finalRenderedTranscript,
} from "../../video/multi-agent/rendered-ordinary-viewer-audit.mjs";

const completeReview = {
  sharpConclusion: "能看懂，但证据还可以更直接。",
  blockers: [],
  viewerValueGap: "观众需要看到一个更具体的结果。",
  evidenceGap: "当前只依据最终转录和媒体元数据。",
  minimalFix: "补一个已经发生的具体结果。",
  viewerDecision: "清楚且有用",
  classifications: { fact: [], subjective: [], uncertain: [] },
};

function fixtureJob(outputPath, {
  id = "job.fixture",
  version = 1,
  duration = 1.5,
  pipeline = "visual-director-v4",
} = {}) {
  const output = {
    version,
    path: outputPath,
    metadata: { duration, width: 1080, height: 1920 },
    qaPass: true,
  };
  return {
    id,
    pipeline,
    status: "awaiting_review",
    approvedAt: "2026-07-24T00:00:00.000Z",
    publish: { status: "not_published" },
    productionApproval: false,
    autoPublish: false,
    memoryPromotion: false,
    output,
    versions: [structuredClone(output)],
    ordinaryViewerTranscript: [
      { start: 0, end: duration + 2, text: "最终剪辑后的第一句。" },
      { start: duration, end: duration + 1, text: "这句已经在成片之外。" },
    ],
    evidence: [{
      id: "evidence.result",
      summary: "证据保存在 C:\\private\\evidence.json，但这里只审查公开结论。",
    }],
    contentDirection: {
      lockedDirection: "分享一个真实AI行动",
      approvedDirection: {
        audience: "想把AI知识变成行动的普通观众",
        viewerBenefit: "得到一个可以立即照做的动作",
        coreQuestion: "这条视频是否证明行动已经发生？",
        constraints: ["不得换题"],
      },
    },
  };
}

function artifactStore() {
  const values = new Map();
  let writes = 0;
  return {
    values,
    get writes() { return writes; },
    async read(kind, id) {
      return values.get(`${kind}/${id}`) || null;
    },
    async write(kind, id, value) {
      const key = `${kind}/${id}`;
      if (values.has(key)) throw Object.assign(new Error("immutable artifact exists"), { statusCode: 409 });
      writes += 1;
      values.set(key, structuredClone(value));
      return `/api/multi-agent/artifacts/${kind}/${id}`;
    },
  };
}

function writeRenderedFixture(root, name, bytes) {
  const file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  return file;
}

test("v4 full render and legacy FFmpeg render each produce immutable ordinary-viewer evidence", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-rendered-audit-paths-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = artifactStore();
  const calls = [];
  const critic = {
    async review(input, options) {
      calls.push({ input: structuredClone(input), options: structuredClone(options) });
      return completeReview;
    },
  };
  const cases = [
    {
      id: "job.v4",
      pipeline: "visual-director-v4",
      trigger: "visual_director_v4_full_render",
      file: writeRenderedFixture(root, "v4-final.mp4", "v4 immutable media"),
    },
    {
      id: "job.legacy",
      pipeline: "ffmpeg-v3",
      trigger: "legacy_ffmpeg_render_version",
      file: writeRenderedFixture(root, "legacy-final.mp4", "legacy immutable media"),
    },
  ];

  for (const item of cases) {
    const job = fixtureJob(item.file, { id: item.id, pipeline: item.pipeline });
    const before = structuredClone(job);
    const result = await auditRenderedJobOrdinaryViewer({
      job,
      critic,
      writeArtifact: store.write,
      readArtifact: store.read,
      allowedRoots: [root],
      trigger: item.trigger,
      attemptKey: `automatic:${item.trigger}`,
      clock: () => "2026-07-24T01:02:03.000Z",
    });

    assert.equal(result.artifact.status, "complete");
    assert.equal(result.artifact.trigger, item.trigger);
    assert.equal(result.artifact.outputVersion, 1);
    assert.match(result.artifact.mediaSha256, /^[a-f0-9]{64}$/);
    assert.match(result.artifact.transcriptSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.artifact.transcript.length, 1);
    assert.equal(result.artifact.transcript[0].end, 1.5);
    assert.equal(result.artifact.media.attachment, `media://jobs/${item.id}/outputs/1/${result.artifact.mediaSha256}`);
    assert.equal(JSON.stringify(result.artifact).includes(root), false);
    assert.equal(JSON.stringify(result.artifact).includes("C:\\private"), false);
    assert.equal(result.artifact.authority.grantsApproval, false);
    assert.equal(result.artifact.authority.publishes, false);
    assert.equal(result.artifact.authority.promotesMemory, false);
    assert.deepEqual(job, before);
  }

  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.options.stage === "render"));
  assert.ok(calls.every(call => call.input.transcript.every(cue => cue.end <= call.input.media.durationSeconds)));
});

test("different output versions or media hashes create different artifact identities", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-rendered-audit-versions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = artifactStore();
  const critic = { review: async () => completeReview };
  const firstFile = writeRenderedFixture(root, "final-v1.mp4", "version one bytes");
  const secondFile = writeRenderedFixture(root, "final-v2.mp4", "version two bytes");
  const job = fixtureJob(firstFile, { version: 1 });

  const first = await auditRenderedJobOrdinaryViewer({
    job,
    critic,
    writeArtifact: store.write,
    readArtifact: store.read,
    allowedRoots: [root],
    attemptKey: "automatic:render",
  });
  job.output = {
    ...job.output,
    version: 2,
    path: secondFile,
  };
  const second = await auditRenderedJobOrdinaryViewer({
    job,
    critic,
    writeArtifact: store.write,
    readArtifact: store.read,
    allowedRoots: [root],
    attemptKey: "automatic:render",
  });

  assert.notEqual(first.artifactId, second.artifactId);
  assert.notEqual(first.artifact.mediaSha256, second.artifact.mediaSha256);
  assert.equal(first.artifact.outputVersion, 1);
  assert.equal(second.artifact.outputVersion, 2);
  assert.equal(store.writes, 2);
});

test("same immutable output and attempt replays the create-only artifact", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-rendered-audit-replay-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = artifactStore();
  const job = fixtureJob(writeRenderedFixture(root, "final.mp4", "same immutable bytes"));
  let reviews = 0;
  const critic = { review: async () => { reviews += 1; return completeReview; } };
  const options = {
    job,
    critic,
    writeArtifact: store.write,
    readArtifact: store.read,
    allowedRoots: [root],
    attemptKey: "automatic:render",
  };

  const first = await auditRenderedJobOrdinaryViewer(options);
  const replay = await auditRenderedJobOrdinaryViewer(options);

  assert.equal(replay.artifactId, first.artifactId);
  assert.equal(replay.replayed, true);
  assert.equal(reviews, 1);
  assert.equal(store.writes, 1);
});

test("critic failure creates a redacted failed artifact without mutating approval or publish state", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-rendered-audit-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = artifactStore();
  const job = fixtureJob(writeRenderedFixture(root, "failed-review.mp4", "render survives critic failure"));
  const before = structuredClone(job);
  const privatePath = "C:\\Users\\owner\\private\\critic.json";

  const result = await auditRenderedJobOrdinaryViewer({
    job,
    critic: { review: async () => { throw new Error(`critic failed at ${privatePath}`); } },
    writeArtifact: store.write,
    readArtifact: store.read,
    allowedRoots: [root],
    trigger: "visual_director_v4_full_render",
  });

  assert.equal(result.artifact.status, "failed");
  assert.match(result.artifact.error, /critic failed/);
  assert.match(result.artifact.error, /<local-path>/);
  assert.equal(JSON.stringify(result.artifact).includes(privatePath), false);
  assert.equal(result.artifact.authority.grantsApproval, false);
  assert.deepEqual(job, before);
});

test("final transcript is clipped to actual output duration", () => {
  const job = {
    ordinaryViewerTranscript: [
      { start: -0.2, end: 0.4, text: "第一句" },
      { start: 0.9, end: 2.4, text: "第二句" },
      { start: 1, end: 2, text: "成片外" },
    ],
  };
  const transcript = finalRenderedTranscript(job, 1);
  assert.deepEqual(transcript, [
    { start: 0, end: 0.4, text: "第一句" },
    { start: 0.9, end: 1, text: "第二句" },
  ]);
  assert.ok(transcript.every(cue => cue.end <= 1));
});

test("unrendered jobs are rejected before the critic is invoked", async () => {
  let invoked = false;
  await assert.rejects(
    auditRenderedJobOrdinaryViewer({
      job: { id: "job.unrendered", status: "uploaded" },
      critic: { review: async () => { invoked = true; return completeReview; } },
      writeArtifact: async () => "unused",
    }),
    error => error.statusCode === 409 && /no immutable rendered output version/.test(error.message)
  );
  assert.equal(invoked, false);
});

test("media hash is the SHA-256 of the actual output file", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-rendered-audit-hash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("actual rendered bytes", "utf8");
  const file = writeRenderedFixture(root, "actual.mp4", bytes);
  const store = artifactStore();
  const result = await auditRenderedJobOrdinaryViewer({
    job: fixtureJob(file),
    critic: { review: async () => completeReview },
    writeArtifact: store.write,
    readArtifact: store.read,
    allowedRoots: [root],
  });
  const expected = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(result.artifact.mediaSha256, expected);
});
