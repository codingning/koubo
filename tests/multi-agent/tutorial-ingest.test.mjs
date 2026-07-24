import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTutorialIngestor } from "../../video/multi-agent/tutorial-ingest.mjs";

const NOW = "2026-07-23T09:00:00.000Z";

function fixture(t, { failOnceAt } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-tutorial-ingest-"));
  const video = path.join(root, "tutorial.mp4");
  fs.writeFileSync(video, Buffer.from("legal-self-created-video-fixture"));
  const calls = [];
  const ingested = [];
  let failed = false;
  const runTool = async request => {
    calls.push(request.operation);
    if (failOnceAt === request.operation && !failed) {
      failed = true;
      throw new Error(`fixture ${request.operation} failure`);
    }
    if (request.operation === "probe") {
      return { duration: 6, width: 1280, height: 720, hasAudio: true };
    }
    if (request.operation === "transcribe") {
      return {
        model: "fixture-transcript",
        segments: [
          { start: 0, end: 2, text: "Make the keyword caption pop." },
          { start: 2, end: 4, text: "Slide the evidence card in." },
          { start: 4, end: 6, text: "Add one licensed sound cue." },
        ],
      };
    }
    throw new Error(`unexpected tool operation: ${request.operation}`);
  };
  const invokeBridge = async request => {
    calls.push(request.operation);
    if (failOnceAt === request.operation && !failed) {
      failed = true;
      throw new Error(`fixture ${request.operation} failure`);
    }
    if (request.operation === "detect_scenes") {
      return {
        success: true,
        scenes: [
          { index: 0, start: 0, end: 2, duration: 2 },
          { index: 1, start: 2, end: 4, duration: 2 },
          { index: 2, start: 4, end: 6, duration: 2 },
        ],
      };
    }
    if (request.operation === "extract_techniques") {
      return {
        success: true,
        result: {
          techniques: [
            {
              id: "caption.pop.v1",
              domain: "caption",
              title: "Keyword caption pop",
              problem: "Emphasize one spoken keyword",
              primitive: "caption-pop",
              start: 0.2,
              end: 1.8,
              parameters: { durationMs: 320 },
              applicability: ["spoken keyword"],
              prohibitions: ["do not cover the speaker"],
              tags: ["caption", "keyword"],
            },
            {
              id: "caption.pop.duplicate",
              domain: "caption",
              title: "Keyword caption pop duplicate",
              problem: "Emphasize one spoken keyword",
              primitive: "caption-pop",
              start: 0.3,
              end: 1.7,
              parameters: { durationMs: 320 },
              applicability: ["spoken keyword"],
              prohibitions: ["do not cover the speaker"],
              tags: ["caption", "keyword"],
            },
            {
              id: "motion.slide.v1",
              domain: "motion",
              title: "Evidence card slide",
              problem: "Reveal evidence after the claim",
              primitive: "element-slide",
              start: 2.1,
              end: 3.8,
              parameters: { direction: "right", durationMs: 420 },
              applicability: ["evidence card"],
              prohibitions: ["no constant motion"],
              tags: ["motion", "evidence"],
            },
          ],
        },
      };
    }
    throw new Error(`unexpected bridge operation: ${request.operation}`);
  };
  const memory = {
    ingest(record) {
      ingested.push(record);
      return record;
    },
  };
  const ingestor = createTutorialIngestor({
    runTool,
    invokeBridge,
    memory,
    checkpointRoot: path.join(root, "checkpoints"),
    clock: () => NOW,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, video, calls, ingested, ingestor };
}

test("registers a legal local source by content hash without copying media", async t => {
  const { root, video, ingestor } = fixture(t);
  const checkpoint = await ingestor.registerSource({
    inputPath: video,
    author: "Koubo local fixture",
    license: "self-created",
  });
  const expectedHash = crypto.createHash("sha256")
    .update(fs.readFileSync(video))
    .digest("hex");

  assert.equal(checkpoint.stage, "registered");
  assert.equal(checkpoint.sourceHash, expectedHash);
  assert.equal(checkpoint.source.author, "Koubo local fixture");
  assert.equal(checkpoint.source.license, "self-created");
  assert.equal(checkpoint.mediaCopied, false);
  assert.equal(fs.existsSync(path.join(root, "checkpoints", `${expectedHash}.json`)), true);
});

test("routes deduplicated techniques to inbox with source timecodes", async t => {
  const { video, ingestor, ingested } = fixture(t);
  const registered = await ingestor.registerSource({
    inputPath: video,
    author: "Koubo local fixture",
    license: "self-created",
  });
  const result = await ingestor.resume(registered);

  assert.equal(result.stage, "awaiting_recreation");
  assert.equal(result.artifacts.techniques.length, 2);
  assert.equal(ingested.length, 2);
  assert.ok(ingested.every(item => item.status === "inbox"));
  assert.ok(ingested.every(item => item.evidence[0].start < item.evidence[0].end));
  assert.deepEqual(
    ingested.map(item => item.namespace).sort(),
    ["caption.private", "motion.private"]
  );
});

test("resumes after transcription without repeating probe, scenes, or transcription", async t => {
  const { video, ingestor, calls } = fixture(t);
  let checkpoint = await ingestor.registerSource({
    inputPath: video,
    author: "Koubo local fixture",
    license: "self-created",
  });
  checkpoint = await ingestor.preprocess(checkpoint);
  assert.equal(checkpoint.stage, "transcribed");
  calls.length = 0;

  const result = await ingestor.resume(checkpoint);

  assert.equal(result.stage, "awaiting_recreation");
  assert.deepEqual(calls, ["extract_techniques"]);
});

test("records a failed stage and resumes from the last completed checkpoint", async t => {
  const { video, ingestor, calls } = fixture(t, { failOnceAt: "transcribe" });
  const registered = await ingestor.registerSource({
    inputPath: video,
    author: "Koubo local fixture",
    license: "self-created",
  });

  await assert.rejects(() => ingestor.resume(registered), /fixture transcribe failure/);
  const failed = ingestor.load(registered.sourceHash);
  assert.equal(failed.stage, "scenes");
  assert.equal(failed.failures.at(-1).operation, "transcribe");
  calls.length = 0;

  const result = await ingestor.resume(failed);

  assert.equal(result.stage, "awaiting_recreation");
  assert.deepEqual(calls, ["transcribe", "extract_techniques"]);
});

test("refuses missing provenance and detects source mutation before resume", async t => {
  const { video, ingestor } = fixture(t);
  await assert.rejects(
    () => ingestor.registerSource({ inputPath: video, author: "", license: "" }),
    /author and license are required/
  );
  const registered = await ingestor.registerSource({
    inputPath: video,
    author: "Koubo local fixture",
    license: "self-created",
  });
  fs.appendFileSync(video, Buffer.from("mutated"));

  await assert.rejects(() => ingestor.resume(registered), /source hash changed/);
});

test("extraction rejects invalid or out-of-range time evidence", async t => {
  const { video, ingestor } = fixture(t);
  const checkpoint = await ingestor.registerSource({
    inputPath: video,
    author: "Koubo local fixture",
    license: "self-created",
  });
  checkpoint.stage = "transcribed";
  checkpoint.artifacts.probe = { duration: 2 };
  checkpoint.artifacts.scenes = [{ start: 0, end: 2 }];
  checkpoint.artifacts.transcript = { segments: [{ start: 0, end: 2, text: "fixture" }] };
  ingestor.save(checkpoint);

  const badIngestor = createTutorialIngestor({
    runTool: async () => assert.fail("tool should not be called"),
    invokeBridge: async () => ({
      success: true,
      result: {
        techniques: [{
          domain: "caption",
          primitive: "caption-pop",
          title: "Bad range",
          problem: "Bad evidence",
          start: 1.5,
          end: 3,
          parameters: {},
        }],
      },
    }),
    memory: { ingest: () => assert.fail("bad record must not be ingested") },
    checkpointRoot: path.join(path.dirname(checkpoint.checkpointPath)),
    clock: () => NOW,
  });

  await assert.rejects(() => badIngestor.extract(checkpoint), /outside source duration/);
});
