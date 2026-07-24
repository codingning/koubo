import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentTrainingReview,
  resolveSoundVariantFile,
  reviewCandidateContentHash,
  reviewEvidenceSetHash,
} from "../scripts/build_agent_training_review.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDir, "..");
const reviewCodes = [
  "C1", "C2", "C3", "M1", "M2", "M3", "S1", "S2", "S3", "D1", "D2", "D3",
];

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createReviewFixtureRoot(t) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-review-fixture-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const scenarioSource = path.join(repositoryRoot, "tests", "fixtures", "candidate-principle-scenarios.json");
  const scenarioTarget = path.join(fixtureRoot, "tests", "fixtures", "candidate-principle-scenarios.json");
  fs.mkdirSync(path.dirname(scenarioTarget), { recursive: true });
  fs.copyFileSync(scenarioSource, scenarioTarget);

  const motionFixtures = [
    {
      directory: "pause-aware-follow-caption",
      durationSeconds: 6.3,
      primitive: "pause-aware-follow-caption",
      fill: 0x11,
    },
    {
      directory: "semantic-layout-router",
      durationSeconds: 7.4,
      primitive: "semantic-layout-router",
      fill: 0x22,
    },
  ];
  for (const fixture of motionFixtures) {
    const directory = path.join(
      fixtureRoot,
      ".cache",
      "technique-reconstructions",
      "2026-07-24-motion-batch-1",
      fixture.directory
    );
    fs.mkdirSync(directory, { recursive: true });
    const renderFile = path.join(directory, "render.mp4");
    fs.writeFileSync(renderFile, Buffer.alloc(2048, fixture.fill));
    writeJson(path.join(directory, "technique-sandbox-manifest.json"), {
      schemaVersion: 1,
      primitive: fixture.primitive,
      hyperframesVersion: "0.7.70",
      composition: { durationSeconds: fixture.durationSeconds },
    });
    writeJson(path.join(directory, "qa-report.json"), {
      schemaVersion: 1,
      eligibleTransition: "recreated",
      failures: [],
      renderHash: sha256File(renderFile),
    });
  }

  const soundRoot = path.join(fixtureRoot, ".cache", "agent-training-batch-1", "sound");
  const soundFixtures = [
    { id: "A", file: "A-no-duck.mp4", integratedLufs: -16.19, truePeakDbtp: -2.5, fill: 0x31 },
    { id: "B", file: "B-fullband-duck.mp4", integratedLufs: -16.19, truePeakDbtp: -2.5, fill: 0x32 },
    { id: "C", file: "C-duck-spectral-slot.mp4", integratedLufs: -16.23, truePeakDbtp: -2.5, fill: 0x33 },
    { id: "S", file: "semantic-sfx-cue.mp4", integratedLufs: -16.22, truePeakDbtp: -2.5, fill: 0x34 },
  ];
  const soundVariants = [];
  const soundQaVariants = {};
  for (const fixture of soundFixtures) {
    const relative = path.join("variants", fixture.file).replaceAll("\\", "/");
    const file = path.join(soundRoot, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(2048, fixture.fill));
    soundVariants.push({
      id: fixture.id,
      mp4: {
        path: relative,
        sha256: sha256File(file),
        integratedLufs: fixture.integratedLufs,
        truePeakDbtp: fixture.truePeakDbtp,
      },
    });
    soundQaVariants[fixture.id] = { passed: true };
  }
  writeJson(path.join(soundRoot, "recreation-manifest.json"), {
    schemaVersion: 1,
    technicalPass: true,
    variants: soundVariants,
  });
  writeJson(path.join(soundRoot, "qa.json"), {
    schemaVersion: 1,
    technicalPass: true,
    variants: soundQaVariants,
  });
  return fixtureRoot;
}

function temporaryReviewDirectory(t, fixtureRoot, prefix) {
  const cacheRoot = path.join(fixtureRoot, ".cache", "agent-training-batch-1");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cacheRoot, prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function parseReviewData(html) {
  const match = html.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/u);
  assert.ok(match, "review-data JSON is missing");
  return JSON.parse(match[1]);
}

function parseBehaviorScript(html) {
  const match = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/u);
  assert.ok(match, "review behavior script is missing");
  return match[1];
}

function runInitialReviewBehavior(html, savedState = null) {
  const reviewData = parseReviewData(html);
  const decisions = ["retain_for_real_clip_trial", "revise_then_review", "delete_candidate"];
  const radios = reviewData.items.flatMap(item => decisions.map(value => ({
    name: `decision-${item.code}`,
    value,
    checked: false,
    addEventListener() {},
  })));
  const notes = new Map(reviewData.items.map(item => [item.code, {
    value: "",
    dataset: { noteFor: item.code },
    addEventListener() {},
  }]));
  const elements = new Map([
    ["review-data", { textContent: JSON.stringify(reviewData) }],
    ["review-progress", { textContent: "" }],
    ["review-progress-fill", { style: {} }],
    ["review-message", { textContent: "" }],
    ["reject-whole-set", { addEventListener() {} }],
    ["clear-review", { addEventListener() {} }],
    ["export-review", { addEventListener() {} }],
  ]);
  const document = {
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelectorAll(selector) {
      if (selector === 'input[type="radio"][name^="decision-"]') return radios;
      if (selector === "[data-note-for]") return [...notes.values()];
      const decisionMatch = selector.match(/^input\[name="decision-([^"]+)"\]$/u);
      return decisionMatch ? radios.filter(input => input.name === `decision-${decisionMatch[1]}`) : [];
    },
    querySelector(selector) {
      const noteMatch = selector.match(/^\[data-note-for="([^"]+)"\]$/u);
      return noteMatch ? notes.get(noteMatch[1]) || null : null;
    },
  };
  const context = {
    document,
    localStorage: {
      getItem: () => savedState ? JSON.stringify(savedState) : null,
      setItem() {},
      removeItem() {},
    },
    window: {
      confirm: () => true,
      scrollTo() {},
    },
    setTimeout() {},
  };
  vm.runInNewContext(parseBehaviorScript(html), context, { filename: "agent-training-review-inline.js" });
  return {
    checkedCount: radios.filter(input => input.checked).length,
    progress: elements.get("review-progress").textContent,
    filledNoteCount: [...notes.values()].filter(note => note.value).length,
  };
}

function mediaSources(html) {
  return [...html.matchAll(/<video[^>]+src="([^"]+)"/gu)].map(match => match[1]);
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

async function startRepositoryServer(root) {
  const resolvedRoot = path.resolve(root);
  const server = http.createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      const target = path.resolve(resolvedRoot, pathname.replace(/^\/+/, ""));
      const relative = path.relative(resolvedRoot, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        response.writeHead(403).end("forbidden");
        return;
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        response.writeHead(404).end("missing");
        return;
      }
      const size = fs.statSync(target).size;
      const range = String(request.headers.range || "").match(/^bytes=(\d+)-(\d*)$/u);
      response.setHeader("Content-Type", contentType(target));
      response.setHeader("Accept-Ranges", "bytes");
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (!Number.isInteger(start) || start < 0 || start >= size || end < start) {
          response.writeHead(416).end();
          return;
        }
        response.writeHead(206, {
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${size}`,
        });
        fs.createReadStream(target, { start, end }).pipe(response);
        return;
      }
      response.writeHead(200, { "Content-Length": size });
      fs.createReadStream(target).pipe(response);
    } catch (error) {
      response.writeHead(500).end(String(error.message || error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

test("builds a deterministic 12-item candidate-only review page", async t => {
  const fixtureRoot = createReviewFixtureRoot(t);
  const firstDirectory = temporaryReviewDirectory(t, fixtureRoot, "review-test-a-");
  const secondDirectory = temporaryReviewDirectory(t, fixtureRoot, "review-test-b-");
  const firstFile = path.join(firstDirectory, "index.html");
  const secondFile = path.join(secondDirectory, "index.html");
  const first = await buildAgentTrainingReview({ repositoryRoot: fixtureRoot, outputFile: firstFile });
  const second = await buildAgentTrainingReview({ repositoryRoot: fixtureRoot, outputFile: secondFile });
  const html = fs.readFileSync(firstFile, "utf8");

  assert.equal(first.itemCount, 12);
  assert.equal(first.mediaCount, 6);
  assert.match(first.evidenceSetHash, /^[a-f0-9]{64}$/u);
  assert.equal(fs.readFileSync(secondFile, "utf8"), html);
  assert.equal(second.evidenceSetHash, first.evidenceSetHash);
  assert.equal((html.match(/data-review-code="/gu) || []).length, 12);
  assert.equal((html.match(/data-candidate-id="/gu) || []).length, 12);
  assert.equal((html.match(/data-candidate-content-hash="[a-f0-9]{64}"/gu) || []).length, 12);
  assert.equal((html.match(/<input type="radio"/gu) || []).length, 36);
  assert.equal((html.match(/<input type="radio"[^>]*\schecked(?:\s|>)/gu) || []).length, 0);
  assert.equal((html.match(/<video /gu) || []).length, 6);
  assert.match(html, /Candidate-only/u);
  assert.match(html, /第二级候选审核/u);
  assert.match(html, /真实片段试用准入/u);
  assert.match(html, /不是正式知识晋升/u);
  assert.match(html, /整组全部不接受/u);
  assert.match(html, /确认将本批 12 项候选全部标记为删除/u);
  assert.match(html, /仍导出当前未完成的第二级候选审核 JSON/u);
  assert.match(html, /localStorage/u);
  assert.match(html, /new Blob/u);
  assert.match(html, /candidateId:item\.candidateId,contentHash:item\.candidateContentHash/u);
  assert.match(html, /koubo-agent-training-batch-1-review\.json/u);
  assert.doesNotMatch(html, /批准生产|生产批准|发布|\bapproved\b|\bpublished\b|\bproductionApproval\b/iu);

  const behaviorScript = parseBehaviorScript(html);
  assert.doesNotThrow(() => new vm.Script(behaviorScript, { filename: "agent-training-review-inline.js" }));

  const reviewData = parseReviewData(html);
  assert.equal(reviewData.schemaVersion, 2);
  assert.equal(reviewData.candidateStatus, "candidate");
  assert.equal(reviewData.reviewStage, "second_level_candidate_review");
  assert.equal(reviewData.admissionTarget, "real_clip_trial");
  assert.equal(reviewData.notKnowledgePromotion, true);
  assert.equal(reviewData.evidenceSetHash, first.evidenceSetHash);
  assert.equal(reviewData.storageKey.endsWith(reviewData.evidenceSetHash), true);
  assert.deepEqual(reviewData.items.map(item => item.code), reviewCodes);
  assert.equal(new Set(reviewData.items.map(item => item.candidateId)).size, 12);
  assert.equal(reviewData.items.every(item => /^[a-f0-9]{64}$/u.test(item.candidateContentHash)), true);
  for (const item of reviewData.items) {
    assert.equal(
      item.candidateContentHash,
      reviewCandidateContentHash({ ...item, media: item.mediaEvidence }),
      item.candidateId
    );
  }
  assert.equal(reviewEvidenceSetHash(reviewData.items), first.evidenceSetHash);
  assert.equal(reviewData.items.filter(item => item.scenarios.length === 3).length, 7);
  assert.equal(reviewData.items.reduce((sum, item) => sum + item.scenarios.length, 0), 21);
  assert.deepEqual(
    Object.fromEntries(reviewData.items.map(item => [item.code, item.recommendation])),
    {
      C1: "retain", C2: "retain", C3: "retain",
      M1: "retain", M2: "retain", M3: "revise",
      S1: "retain", S2: "revise", S3: "revise",
      D1: "retain", D2: "retain", D3: "retain",
    }
  );
  assert.deepEqual(reviewData.soundMedia.map(item => item.id), ["A", "B", "C", "S"]);

  const initial = runInitialReviewBehavior(html);
  assert.deepEqual(initial, { checkedCount: 0, progress: "已选择 0 / 12", filledNoteCount: 0 });
  const mismatchedEvidenceState = {
    schemaVersion: reviewData.schemaVersion,
    reviewId: reviewData.reviewId,
    evidenceSetHash: "0".repeat(64),
    items: { C1: { decision: "retain_for_real_clip_trial", note: "must not restore" } },
  };
  assert.deepEqual(
    runInitialReviewBehavior(html, mismatchedEvidenceState),
    { checkedCount: 0, progress: "已选择 0 / 12", filledNoteCount: 0 }
  );
  const matchingEvidenceState = {
    ...mismatchedEvidenceState,
    evidenceSetHash: reviewData.evidenceSetHash,
    items: { C1: { decision: "retain_for_real_clip_trial", note: "restored" } },
  };
  assert.deepEqual(
    runInitialReviewBehavior(html, matchingEvidenceState),
    { checkedCount: 1, progress: "已选择 1 / 12", filledNoteCount: 1 }
  );

  const outputDirectory = path.dirname(firstFile);
  for (const media of [
    ...reviewData.soundMedia,
    ...reviewData.items.map(item => item.media).filter(Boolean),
  ]) {
    const file = path.resolve(outputDirectory, media.src);
    assert.equal(fs.existsSync(file), true, media.src);
    assert.equal(sha256File(file), media.sha256, media.src);
  }
});

test("candidate content hashes bind title, boundary, and the 12-item evidence set", () => {
  const candidate = {
    candidateId: "test-candidate.v1",
    title: "Original title",
    summary: "Summary",
    boundary: "Original boundary",
    recommendation: "retain",
    recommendationText: "Try it in a real clip.",
    scenarios: [{ id: "scenario-1", category: "applicable", title: "Applies", resultRuleId: "rule-1" }],
    media: { sha256: "1".repeat(64), durationSeconds: 6.3 },
  };
  const original = reviewCandidateContentHash(candidate);
  assert.notEqual(reviewCandidateContentHash({ ...candidate, title: "Changed title" }), original);
  assert.notEqual(reviewCandidateContentHash({ ...candidate, boundary: "Changed boundary" }), original);

  const items = reviewCodes.map((code, index) => ({
    candidateId: `candidate-${code}`,
    candidateContentHash: String(index).padStart(64, "0"),
  }));
  const evidenceSetHash = reviewEvidenceSetHash(items);
  const changedItems = items.map((item, index) => index === 11
    ? { ...item, candidateContentHash: "f".repeat(64) }
    : item);
  assert.notEqual(reviewEvidenceSetHash(changedItems), evidenceSetHash);
});

test("sound variant media paths cannot escape the frozen sound root", () => {
  const soundRoot = path.join(repositoryRoot, ".cache", "agent-training-batch-1", "sound");
  assert.equal(
    resolveSoundVariantFile(soundRoot, "variants/A-no-duck.mp4"),
    path.join(soundRoot, "variants", "A-no-duck.mp4")
  );
  assert.throws(() => resolveSoundVariantFile(soundRoot, "../outside.mp4"), /must be a child/u);
  assert.throws(() => resolveSoundVariantFile(soundRoot, "variants/../../outside.mp4"), /must be a child/u);
});

test("page and all six relative media sources load from a repository-root HTTP server", async t => {
  const fixtureRoot = createReviewFixtureRoot(t);
  const directory = temporaryReviewDirectory(t, fixtureRoot, "review-http-");
  const outputFile = path.join(directory, "index.html");
  await buildAgentTrainingReview({ repositoryRoot: fixtureRoot, outputFile });
  const html = fs.readFileSync(outputFile, "utf8");
  const server = await startRepositoryServer(fixtureRoot);
  t.after(() => server.close());
  const pagePath = path.relative(fixtureRoot, outputFile).replaceAll("\\", "/");
  const pageUrl = new URL(`/${pagePath}`, server.origin);

  const pageResponse = await fetch(pageUrl);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-type"), /text\/html/u);
  assert.equal((await pageResponse.text()).includes("data-review-code=\"C1\""), true);

  const sources = mediaSources(html);
  assert.equal(sources.length, 6);
  for (const source of sources) {
    const response = await fetch(new URL(source, pageUrl), {
      headers: { Range: "bytes=0-1023" },
    });
    assert.equal(response.status, 206, source);
    assert.equal(response.headers.get("content-type"), "video/mp4", source);
    assert.equal((await response.arrayBuffer()).byteLength, 1024, source);
  }
});

test("CLI refuses to write the review page outside the assigned cache root", () => {
  const script = path.join(repositoryRoot, "scripts", "build_agent_training_review.mjs");
  const outside = path.join(os.tmpdir(), `koubo-review-outside-${process.pid}.html`);
  fs.rmSync(outside, { force: true });
  const result = spawnSync(process.execPath, [script, "--output", outside], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(String(result.stderr || result.stdout), /must be a child/u);
  assert.equal(fs.existsSync(outside), false);
});
