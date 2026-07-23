import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSubjectiveReviewServer,
  refreshSubjectiveReviewPage,
} from "../../video/multi-agent/subjective-server.mjs";

async function fixtureRun() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "koubo-review-server-"));
  const reviewRoot = path.join(root, "review");
  await fsp.mkdir(path.join(reviewRoot, "media"), { recursive: true });
  await fsp.writeFile(path.join(reviewRoot, "index.html"), "<h1>review</h1>");
  await fsp.writeFile(path.join(reviewRoot, "media", "hook-A.mp4"), Buffer.from("0123456789"));
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  await fsp.writeFile(path.join(root, "subjective-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    runId: "real-review-v1",
    baselineId: "baseline-v1",
    status: "awaiting-user-subjective-review",
    automatedPass: true,
    finalSubjectiveReview: null,
    samples: [{
      id: "hook",
      mediaKind: "real-talking-head",
      focus: "钩子",
      question: "愿意继续看吗？",
      reviewHints: ["信息清楚", "动效克制"],
      duration: 18,
      candidates: [
        { label: "A", renderHash: hashA, publicFile: "media/hook-A.mp4" },
        { label: "B", renderHash: hashB, publicFile: "media/hook-B.mp4" },
      ],
    }],
  }));
  await fsp.writeFile(path.join(root, "blind-map-private.json"), JSON.stringify([{
    sampleId: "hook",
    mapping: [
      { label: "A", recipeId: "frozen-control", renderHash: hashA },
      { label: "B", recipeId: "caption-pulse", renderHash: hashB },
    ],
  }]));
  return root;
}

test("loopback server serves only review assets with media range support", async () => {
  const runRoot = await fixtureRun();
  const server = createSubjectiveReviewServer({ runRoot });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const page = await fetch(`http://127.0.0.1:${port}/index.html`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /review/);
    const media = await fetch(`http://127.0.0.1:${port}/media/hook-A.mp4`, {
      headers: { Range: "bytes=2-5" },
    });
    assert.equal(media.status, 206);
    assert.equal(await media.text(), "2345");
    assert.equal(media.headers.get("content-range"), "bytes 2-5/10");
    const privateFile = await fetch(`http://127.0.0.1:${port}/../blind-map-private.json`);
    assert.equal(privateFile.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fsp.rm(runRoot, { recursive: true, force: true });
  }
});

test("POST records one validated review without production or memory authority", async () => {
  const runRoot = await fixtureRun();
  const server = createSubjectiveReviewServer({ runRoot });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const payload = {
    runId: "real-review-v1",
    reviewerType: "human",
    reviewedAt: "2026-07-23T10:00:00.000Z",
    samples: [{
      sampleId: "hook",
      decision: "reject-all",
      reasons: ["模板感太强"],
      note: "全程。",
    }],
  };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/subjective-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.productionApproval, false);
    assert.equal(result.memoryPromotion, false);
    assert.equal(fs.existsSync(path.join(runRoot, "subjective-review-record.json")), true);
    const replay = await fetch(`http://127.0.0.1:${port}/api/subjective-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(replay.status, 409);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fsp.rm(runRoot, { recursive: true, force: true });
  }
});

test("refreshes the generated page from the frozen public manifest before serving", async () => {
  const runRoot = await fixtureRun();
  try {
    const page = await refreshSubjectiveReviewPage({ runRoot });
    assert.equal(page.runId, "real-review-v1");
    const html = await fsp.readFile(path.join(runRoot, "review", "index.html"), "utf8");
    assert.match(html, /提交审核结果/);
    assert.match(html, /愿意继续看吗/);
  } finally {
    await fsp.rm(runRoot, { recursive: true, force: true });
  }
});
