import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyRecreationQa,
  buildTechniqueSandbox,
  qaTechniqueSandbox,
} from "../../video/multi-agent/tutorial-sandbox.mjs";

function technique(overrides = {}) {
  return {
    id: "caption.pop.fixture.v1.abcdef12.12345678",
    contentHash: "a".repeat(64),
    status: "extracted",
    primitive: "caption-pop",
    title: "Keyword caption pop",
    problem: "Emphasize one spoken keyword",
    parameters: { durationMs: 320 },
    evidence: [{ sourceId: "tutorial.sha256", start: 0.2, end: 1.8 }],
    ...overrides,
  };
}

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-technique-sandbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("rejects arbitrary tutorial code and unknown primitives", async t => {
  const root = fixtureRoot(t);
  await assert.rejects(
    () => buildTechniqueSandbox({
      technique: technique({
        primitive: "eval-external-js",
        parameters: { code: "fetch('https://example.com/payload.js')" },
      }),
      outputDir: path.join(root, "bad"),
    }),
    /primitive is not allowed/
  );
});

test("builds a deterministic offline HyperFrames project with a visual identity", async t => {
  const root = fixtureRoot(t);
  const first = await buildTechniqueSandbox({
    technique: technique(),
    outputDir: path.join(root, "first"),
  });
  const second = await buildTechniqueSandbox({
    technique: technique(),
    outputDir: path.join(root, "second"),
  });

  const firstHtml = fs.readFileSync(path.join(first.projectDir, "index.html"), "utf8");
  const secondHtml = fs.readFileSync(path.join(second.projectDir, "index.html"), "utf8");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(first.projectDir, "technique-sandbox-manifest.json"), "utf8")
  );

  assert.equal(firstHtml, secondHtml);
  assert.equal(firstHtml.includes("assets/gsap.min.js"), true);
  assert.equal(/https?:\/\//.test(firstHtml), false);
  assert.equal(firstHtml.includes("Math.random"), false);
  assert.equal(firstHtml.includes("Date.now"), false);
  assert.equal(firstHtml.includes('window.__timelines["main"]'), true);
  assert.equal(fs.existsSync(path.join(first.projectDir, "DESIGN.md")), true);
  assert.equal(manifest.networkPolicy, "offline-local-assets-only");
  assert.equal(manifest.primitive, "caption-pop");
  assert.equal(manifest.sourceCodeAccepted, false);
});

test("supports only the six audited recipe primitives", async t => {
  const root = fixtureRoot(t);
  const primitives = [
    "caption-pop",
    "keyword-emphasis",
    "element-slide",
    "element-bounce",
    "sfx-cue",
    "voice-pause",
  ];

  for (const primitive of primitives) {
    const result = await buildTechniqueSandbox({
      technique: technique({ id: `${primitive}.v1`, primitive }),
      outputDir: path.join(root, primitive),
    });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.projectDir, "technique-sandbox-manifest.json"), "utf8")
    );
    assert.equal(manifest.primitive, primitive);
    assert.equal(manifest.allowedPrimitive, true);
  }
  assert.equal(fs.existsSync(path.join(root, "sfx-cue", "assets", "cue.wav")), true);
});

test("QA requires decode, readability, safe area, contrast, sync, and audio peak gates", async () => {
  const passing = await qaTechniqueSandbox({
    decodeOk: true,
    readable: true,
    safeArea: true,
    contrast: true,
    syncErrorMs: 41,
    peakDb: -8,
    hasAudio: true,
    networkAccess: false,
  });
  assert.equal(passing.eligibleTransition, "recreated");

  for (const failing of [
    { decodeOk: false },
    { readable: false },
    { safeArea: false },
    { contrast: false },
    { syncErrorMs: 101 },
    { peakDb: -1.4 },
    { networkAccess: true },
  ]) {
    const result = await qaTechniqueSandbox({
      decodeOk: true,
      readable: true,
      safeArea: true,
      contrast: true,
      syncErrorMs: 0,
      peakDb: -8,
      hasAudio: true,
      networkAccess: false,
      ...failing,
    });
    assert.equal(result.eligibleTransition, null);
    assert.ok(result.failures.length >= 1);
  }
});

test("only a passing QA report can request the recreated transition", async () => {
  const calls = [];
  const memory = {
    transition(input) {
      calls.push(input);
      return { id: "transition.fixture", record: { status: input.to } };
    },
  };
  const item = technique();

  assert.throws(
    () => applyRecreationQa({
      memory,
      technique: item,
      qa: { eligibleTransition: null, failures: ["decode"] },
    }),
    /not eligible for recreated/
  );
  assert.equal(calls.length, 0);

  const result = applyRecreationQa({
    memory,
    technique: item,
    qa: {
      eligibleTransition: "recreated",
      renderHash: "b".repeat(64),
      checks: { decode: true, sync: true },
    },
  });
  assert.equal(result.record.status, "recreated");
  assert.equal(calls[0].to, "recreated");
  assert.equal(calls[0].expectedHash, item.contentHash);
  assert.equal(calls[0].evidence[0].type, "render-qa");
});
