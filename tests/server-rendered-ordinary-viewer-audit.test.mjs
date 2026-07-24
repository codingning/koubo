import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-server-rendered-audit-data-"));
process.env.KOUBO_NO_LISTEN = "1";
process.env.KOUBO_MULTI_AGENT_DATA_ROOT = dataRoot;

const serverModule = await import(`../video/server.mjs?rendered-audit-test=${Date.now()}`);
const {
  auditRenderedJobAfterFinalRender,
  closeServerResourcesForTests,
} = serverModule;

test.after(async () => {
  await closeServerResourcesForTests();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

function fixtureJob(file, id, pipeline) {
  const output = {
    version: 3,
    path: file,
    metadata: { duration: 1.25, width: 1080, height: 1920 },
    qaPass: true,
  };
  return {
    id,
    pipeline,
    status: "awaiting_review",
    approvedAt: "2026-07-24T00:00:00.000Z",
    publish: { status: "not_published" },
    publishedAt: null,
    productionApproval: false,
    autoPublish: false,
    memoryPromotion: false,
    output,
    versions: [structuredClone(output)],
    ordinaryViewerTranscript: [{ start: 0, end: 2, text: "这是一条最终成片转录。" }],
    currentPlan: { keepSegments: [] },
    contentDirection: {
      approvedDirection: {
        audience: "需要具体AI行动的普通观众",
        viewerBenefit: "看完能照着完成一个动作",
        coreQuestion: "这条视频是否给出了真实结果？",
        constraints: ["不得换题"],
      },
    },
  };
}

test("server final-render hook preserves review, approval, and publish authority for both render paths", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-server-rendered-audit-media-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifacts = new Map();
  const saved = [];
  const writer = async (kind, id, value) => {
    const key = `${kind}/${id}`;
    if (artifacts.has(key)) throw Object.assign(new Error("immutable artifact exists"), { statusCode: 409 });
    artifacts.set(key, structuredClone(value));
    return `/api/multi-agent/artifacts/${kind}/${id}`;
  };
  const reader = async (kind, id) => artifacts.get(`${kind}/${id}`) || null;
  const cases = [
    {
      id: "job.v4.final",
      pipeline: "visual-director-v4",
      trigger: "visual_director_v4_full_render",
      critic: { review: async () => ({
        sharpConclusion: "结果清楚。",
        blockers: [],
        viewerValueGap: "无",
        evidenceGap: "仅基于最终转录和元数据",
        minimalFix: "保持当前方向",
        viewerDecision: "清楚且有用",
        classifications: { fact: [], subjective: [], uncertain: [] },
      }) },
    },
    {
      id: "job.legacy.final",
      pipeline: "ffmpeg-v3",
      trigger: "legacy_ffmpeg_render_version",
      critic: { review: async () => { throw new Error("critic unavailable at C:\\private\\runtime.json"); } },
    },
  ];

  for (const item of cases) {
    const file = path.join(root, `${item.id}.mp4`);
    fs.writeFileSync(file, `rendered bytes for ${item.id}`);
    const job = fixtureJob(file, item.id, item.pipeline);
    const protectedBefore = {
      status: job.status,
      approvedAt: job.approvedAt,
      publish: structuredClone(job.publish),
      publishedAt: job.publishedAt,
      productionApproval: job.productionApproval,
      autoPublish: job.autoPublish,
      memoryPromotion: job.memoryPromotion,
    };

    const result = await auditRenderedJobAfterFinalRender(job, item.trigger, {
      critic: item.critic,
      writeArtifact: writer,
      readArtifact: reader,
      allowedRoots: [root],
      saveJobFn: async value => saved.push(structuredClone(value)),
      clock: () => "2026-07-24T02:03:04.000Z",
    });

    assert.ok(result);
    assert.deepEqual({
      status: job.status,
      approvedAt: job.approvedAt,
      publish: job.publish,
      publishedAt: job.publishedAt,
      productionApproval: job.productionApproval,
      autoPublish: job.autoPublish,
      memoryPromotion: job.memoryPromotion,
    }, protectedBefore);
    assert.equal(job.output.ordinaryViewerAudit.trigger, item.trigger);
    assert.equal(job.output.ordinaryViewerAudit.outputVersion, 3);
    assert.match(job.output.ordinaryViewerAudit.mediaSha256, /^[a-f0-9]{64}$/);
    assert.match(job.output.ordinaryViewerAudit.transcriptSha256, /^[a-f0-9]{64}$/);
    assert.equal(job.versions[0].ordinaryViewerAudit.artifactId, job.output.ordinaryViewerAudit.artifactId);
    assert.equal(JSON.stringify(result.artifact).includes(root), false);
    assert.equal(JSON.stringify(result.artifact).includes("C:\\private"), false);
  }

  assert.equal(saved.length, 2);
  assert.equal(saved[0].status, "awaiting_review");
  assert.equal(saved[1].status, "awaiting_review");
  assert.equal(saved[0].output.ordinaryViewerAudit.status, "complete");
  assert.equal(saved[1].output.ordinaryViewerAudit.status, "failed");
});

test("both real final-render functions invoke the automatic audit hook", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "video", "server.mjs"), "utf8");
  const visualStart = source.indexOf("async function executeVisualStage");
  const legacyStart = source.indexOf("async function renderVersion");
  const processStart = source.indexOf("async function processJob");
  assert.ok(visualStart >= 0 && legacyStart > visualStart && processStart > legacyStart);
  const visualBlock = source.slice(visualStart, legacyStart);
  const legacyBlock = source.slice(legacyStart, processStart);
  assert.match(visualBlock, /auditRenderedJobAfterFinalRender\(job, "visual_director_v4_full_render"\)/);
  assert.match(legacyBlock, /auditRenderedJobAfterFinalRender\(job, "legacy_ffmpeg_render_version"\)/);
  assert.match(visualBlock, /job\.status = "awaiting_review"[\s\S]*await saveJob\(job\)[\s\S]*auditRenderedJobAfterFinalRender/);
  assert.match(legacyBlock, /job\.status = "awaiting_review"[\s\S]*await saveJob\(job\)[\s\S]*auditRenderedJobAfterFinalRender/);
});
