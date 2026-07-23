import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("CLI atomically records one human subjective review and refuses overwrite", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "koubo-subjective-result-"));
  const runRoot = path.join(root, "run");
  await fsp.mkdir(runRoot);
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  await fsp.writeFile(path.join(runRoot, "subjective-manifest.json"), JSON.stringify({
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
  }, null, 2));
  await fsp.writeFile(path.join(runRoot, "blind-map-private.json"), JSON.stringify([{
    sampleId: "hook",
    mapping: [
      { label: "A", recipeId: "frozen-control", renderHash: hashA },
      { label: "B", recipeId: "caption-pulse", renderHash: hashB },
    ],
  }], null, 2));
  const reviewFile = path.join(root, "review.json");
  await fsp.writeFile(reviewFile, JSON.stringify({
    runId: "real-review-v1",
    reviewerType: "human",
    reviewedAt: "2026-07-23T10:00:00.000Z",
    samples: [{
      sampleId: "hook",
      decision: "reject-all",
      reasons: ["模板感太强"],
      note: "全程。",
    }],
  }, null, 2));

  const script = path.resolve("scripts/record_multi_agent_subjective_review.mjs");
  const first = spawnSync(process.execPath, [script, "--run-root", runRoot, "--review", reviewFile], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.existsSync(path.join(runRoot, "subjective-review-record.json")), true);
  const manifest = JSON.parse(await fsp.readFile(path.join(runRoot, "subjective-manifest.json"), "utf8"));
  assert.equal(manifest.status, "subjective-review-recorded");

  const second = spawnSync(process.execPath, [script, "--run-root", runRoot, "--review", reviewFile], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already|exists/i);

  await fsp.rm(root, { recursive: true, force: true });
});
