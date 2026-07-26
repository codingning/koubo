import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const collector = path.join(root, "scripts", "collect_douyin_references.mjs");

function runCollector(t, plan) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-reference-collector-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const planFile = path.join(temp, "topic-plan.json");
  const outputFile = path.join(temp, "reference-research.json");
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2), "utf8");
  const result = spawnSync(process.execPath, [collector, "--plan", planFile, "--output", outputFile], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, KOUBO_LIVE_REFERENCE_RESEARCH: "0" },
  });
  const output = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  return { result, output };
}

test("collector always includes an explicitly required fully verified library source", t => {
  const requiredSourceId = "douyin-7641901934210813234";
  const { result, output } = runCollector(t, {
    topic: "口播工作台真实结果证明",
    keywords: ["自然语言返修", "版本保留", "关键帧审核"],
    requiredReferenceSourceIds: [requiredSourceId],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.status, "ready");
  assert.deepEqual(output.researchMethod.requiredCuratedSourceIds, [requiredSourceId]);
  assert.equal(output.fullContentSources.some(item => item.sourceId === requiredSourceId), true);
  assert.match(
    output.fullContentSources.find(item => item.sourceId === requiredSourceId).evidenceLevel,
    /user-required-curated-full-transcript/
  );
});

test("collector fails closed when an explicitly required source is absent from the verified library", t => {
  const missingSourceId = "douyin-7000000000000000000";
  const { result, output } = runCollector(t, {
    topic: "口播工作台真实结果证明",
    keywords: ["AI剪辑"],
    requiredReferenceSourceIds: [missingSourceId],
  });

  assert.notEqual(result.status, 0);
  assert.equal(output.status, "blocked");
  assert.match(output.error, /未在本地全文核验库中找到或证据不完整/);
  assert.match(output.error, new RegExp(missingSourceId));
});

test("collector does not confuse content evidence ids with required reference source ids", t => {
  const { result, output } = runCollector(t, {
    topic: "口播工作台真实结果证明",
    keywords: ["AI剪辑"],
    requiredSourceIds: ["job-20260725062114-297235-v2", "proof-sample-final"],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.status, "ready");
  assert.deepEqual(output.researchMethod.requiredCuratedSourceIds, []);
  assert.equal(output.fullContentSources.length > 0, true);
});
