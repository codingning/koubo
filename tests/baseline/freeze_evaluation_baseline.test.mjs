import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverJobCandidates,
  selectRepresentativeJobs,
  freezeBaseline,
} from "../../scripts/freeze_evaluation_baseline.mjs";

const fixtureRoot = path.resolve("tests/fixtures/jobs");

test("selects three to five jobs covering legacy, rich review, and v4 sample traits", async () => {
  const candidates = await discoverJobCandidates(fixtureRoot);
  const selected = selectRepresentativeJobs(candidates, { min: 3, max: 5 });

  assert.equal(selected.length, 3);
  const traits = new Set(selected.flatMap(item => item.traits));
  for (const required of ["legacy", "method", "evidence", "captions", "motion", "v4"]) {
    assert.equal(traits.has(required), true, `missing coverage trait: ${required}`);
  }
});

test("excludes isolated Remotion comparison artifacts from the v4 baseline", async () => {
  const candidates = await discoverJobCandidates(fixtureRoot);
  const day2 = candidates.find(item => item.jobId === "day2-review");

  assert.ok(day2);
  assert.equal(day2.artifacts.some(item => /remotion/i.test(item.path)), false);
  assert.equal(day2.artifacts.some(item => item.path === "review-bundle-v5.json"), true);
});

test("freezes portable relative artifacts and stable sha256 hashes", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-baseline-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const jobsRoot = path.join(temp, "jobs");
  fs.cpSync(fixtureRoot, jobsRoot, { recursive: true });
  const outputFile = path.join(temp, "baseline-v1.json");

  const first = await freezeBaseline({
    jobsRoot,
    outputFile,
    now: "2026-07-23T00:00:00.000Z",
  });
  const second = await freezeBaseline({
    jobsRoot,
    outputFile,
    now: "2026-07-23T00:00:00.000Z",
  });

  assert.deepEqual(second, first);
  assert.equal(first.samples.length, 3);
  assert.ok(first.samples.every(sample => sample.artifacts.some(item => item.path === "job.json")));
  assert.ok(first.samples.every(sample => sample.artifacts.every(item => /^[a-f0-9]{64}$/.test(item.sha256))));
  assert.ok(first.samples.every(sample => sample.artifacts.every(item => !path.isAbsolute(item.path))));
});

test("refuses to overwrite a frozen manifest when source hashes change", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-baseline-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const jobsRoot = path.join(temp, "jobs");
  fs.cpSync(fixtureRoot, jobsRoot, { recursive: true });
  const outputFile = path.join(temp, "baseline-v1.json");

  await freezeBaseline({
    jobsRoot,
    outputFile,
    now: "2026-07-23T00:00:00.000Z",
  });
  fs.appendFileSync(path.join(jobsRoot, "legacy-approved", "qa-report-v3.json"), "\n");

  await assert.rejects(
    () => freezeBaseline({
      jobsRoot,
      outputFile,
      now: "2026-07-23T00:00:00.000Z",
    }),
    /frozen baseline differs/
  );
});
