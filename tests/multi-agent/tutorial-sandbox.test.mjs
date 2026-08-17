import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

function fixtureRender(root, name, { loudAudio = false } = {}) {
  const file = path.join(root, `${name}.mp4`);
  const args = [
    "-v", "error",
    "-y",
    "-f", "lavfi",
    "-i", "color=c=black:s=320x240:r=30:d=0.6",
  ];
  if (loudAudio) {
    args.push(
      "-f", "lavfi",
      "-i", "sine=frequency=1000:sample_rate=48000:duration=0.6",
      "-filter:a", "volume=8",
      "-shortest",
      "-c:a", "aac",
      "-b:a", "128k"
    );
  } else {
    args.push("-an");
  }
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", file);
  const result = spawnSync("ffmpeg", args, {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(file), true);
  return file;
}

function completeChecks(overrides = {}) {
  return {
    renderFile: true,
    mediaProbe: true,
    decode: true,
    renderHash: true,
    readable: true,
    safeArea: true,
    contrast: true,
    sync: true,
    truePeak: true,
    offline: true,
    motionSidecar: true,
    proofSidecar: true,
    ...overrides,
  };
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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
  assert.match(firstHtml, /id="lab-clip" class="clip lab-clip"/);
  assert.match(firstHtml, /id="lab-frame" class="frame"/);
  assert.equal(firstHtml.includes('tl.to(".clip"'), false);
  assert.equal(firstHtml.includes('tl.to(".frame"'), false);
  assert.equal(firstHtml.includes('tl.to("#lab-frame"'), true);
  assert.equal(fs.existsSync(path.join(first.projectDir, "DESIGN.md")), true);
  assert.equal(manifest.networkPolicy, "offline-local-assets-only");
  assert.equal(manifest.primitive, "caption-pop");
  assert.equal(manifest.sourceCodeAccepted, false);
});

test("supports only the audited recipe primitives", async t => {
  const root = fixtureRoot(t);
  const primitives = [
    "caption-pop",
    "keyword-emphasis",
    "pause-aware-follow-caption",
    "element-slide",
    "element-bounce",
    "semantic-layout-router",
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

test("builds a pause-aware caption with an explicit hold interval and motion sidecar", async t => {
  const root = fixtureRoot(t);
  const result = await buildTechniqueSandbox({
    technique: technique({
      id: "caption.pause-aware.v1",
      primitive: "pause-aware-follow-caption",
      title: "Pause-aware token timing",
    }),
    outputDir: path.join(root, "pause-aware"),
  });
  const html = fs.readFileSync(path.join(result.projectDir, "index.html"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
  const proof = JSON.parse(fs.readFileSync(
    path.join(result.projectDir, "technique-proof.json"),
    "utf8"
  ));
  const motion = JSON.parse(fs.readFileSync(
    path.join(result.projectDir, "index.motion.json"),
    "utf8"
  ));
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(result.projectDir, "package.json"),
    "utf8"
  ));

  assert.equal(manifest.sandboxVersion, "technique-sandbox-v2");
  assert.equal(manifest.hyperframesVersion, "0.7.70");
  assert.equal(manifest.verification.motionSidecar, "index.motion.json");
  assert.equal(manifest.verification.proofSidecar, "technique-proof.json");
  assert.equal(manifest.verification.requirements.pauseHold, true);
  assert.equal(proof.tokenWindows.length, 5);
  assert.equal(proof.pauseIntervals.length, 1);
  assert.ok(proof.pauseIntervals[0].endSeconds > proof.pauseIntervals[0].startSeconds);
  assert.ok(proof.tokenWindows[1].endSeconds <= proof.pauseIntervals[0].startSeconds);
  assert.ok(proof.tokenWindows[2].startSeconds > proof.pauseIntervals[0].endSeconds);
  assert.equal(proof.pauseIntervals[0].comparisonTimesSeconds.length, 2);
  assert.equal(html.includes('tl.set("#pause-badge",{opacity:1},1.82)'), true);
  assert.equal(html.includes('tl.set("#pause-badge",{opacity:0},2.94)'), true);
  assert.equal(html.includes('id="active-token-3"'), true);
  assert.equal(motion.assertions.some(item => item.kind === "keepsMoving"), true);
  assert.match(packageJson.scripts["hf:check"], /hyperframes@0\.7\.70/);
  assert.equal(/Math\.random|Date\.now|performance\.now/.test(html), false);
});

test("builds a semantic layout router with focus, steps, and evidence revealed in order", async t => {
  const root = fixtureRoot(t);
  const result = await buildTechniqueSandbox({
    technique: technique({
      id: "motion.semantic-layout-router.v1",
      primitive: "semantic-layout-router",
      title: "Route meaning before motion",
    }),
    outputDir: path.join(root, "semantic-router"),
  });
  const html = fs.readFileSync(path.join(result.projectDir, "index.html"), "utf8");
  const manifestText = fs.readFileSync(result.manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  const proofText = fs.readFileSync(
    path.join(result.projectDir, "technique-proof.json"),
    "utf8"
  );
  const proof = JSON.parse(proofText);
  const motionText = fs.readFileSync(
    path.join(result.projectDir, "index.motion.json"),
    "utf8"
  );
  const motion = JSON.parse(motionText);

  assert.deepEqual(proof.layouts.map(item => item.role), ["single-focus", "steps", "evidence"]);
  assert.equal(proof.noEarlyReveal, true);
  assert.ok(proof.layouts[0].revealAtSeconds < proof.layouts[1].revealAtSeconds);
  assert.ok(proof.layouts[1].revealAtSeconds < proof.layouts[2].revealAtSeconds);
  assert.equal(proof.sampleExpectations.length, 3);
  assert.equal(html.includes('id="focus-panel"'), true);
  assert.equal(html.includes('id="steps-panel"'), true);
  assert.equal(html.includes('id="evidence-panel"'), true);
  assert.match(html, /\.route-panel\{[^}]*opacity:0/);
  assert.match(html, /\.route-legend span\{[^}]*opacity:0/);
  assert.equal(proof.sampleExpectations[0].hidden.includes("#legend-steps"), true);
  assert.equal(proof.sampleExpectations[0].hidden.includes("#legend-evidence"), true);
  assert.equal(motion.assertions.filter(item => item.kind === "before").length, 2);
  assert.equal(manifest.verification.requirements.semanticLayoutCount, 3);
  assert.equal(manifest.verification.requirements.noEarlyReveal, true);
  assert.doesNotMatch(`${manifestText}\n${proofText}\n${motionText}`, /approve|publish|promote/i);
});

test("primitive-specific QA requires pause hold and semantic no-spoiler evidence", async t => {
  const root = fixtureRoot(t);
  const renderFile = fixtureRender(root, "specialized-proof");
  const common = {
    renderFile,
    readable: true,
    safeArea: true,
    contrast: true,
    syncErrorMs: 0,
    networkAccess: false,
  };
  const pause = await buildTechniqueSandbox({
    technique: technique({ id: "pause.qa.v1", primitive: "pause-aware-follow-caption" }),
    outputDir: path.join(root, "pause"),
  });
  const pauseFail = await qaTechniqueSandbox({ projectDir: pause.projectDir, ...common });
  assert.equal(pauseFail.eligibleTransition, null);
  assert.equal(pauseFail.failures.includes("pauseHold"), true);
  const pausePass = await qaTechniqueSandbox({
    projectDir: pause.projectDir,
    pauseHoldVerified: true,
    ...common,
  });
  assert.equal(pausePass.eligibleTransition, "recreated");

  const semantic = await buildTechniqueSandbox({
    technique: technique({ id: "semantic.qa.v1", primitive: "semantic-layout-router" }),
    outputDir: path.join(root, "semantic"),
  });
  const semanticFail = await qaTechniqueSandbox({
    projectDir: semantic.projectDir,
    semanticLayoutCount: 2,
    noEarlyReveal: false,
    ...common,
  });
  assert.equal(semanticFail.eligibleTransition, null);
  assert.equal(semanticFail.failures.includes("semanticLayouts"), true);
  assert.equal(semanticFail.failures.includes("noEarlyReveal"), true);
  const semanticPass = await qaTechniqueSandbox({
    projectDir: semantic.projectDir,
    semanticLayoutCount: 3,
    noEarlyReveal: true,
    ...common,
  });
  assert.equal(semanticPass.eligibleTransition, "recreated");
});

test("QA requires a real decoded render, readability, safe area, contrast, sync, and audio peak gates", async t => {
  const root = fixtureRoot(t);
  const renderFile = fixtureRender(root, "passing-render");
  const passing = await qaTechniqueSandbox({
    renderFile,
    readable: true,
    safeArea: true,
    contrast: true,
    syncErrorMs: 41,
    networkAccess: false,
  });
  assert.equal(passing.eligibleTransition, "recreated");
  assert.match(passing.renderHash, /^[a-f0-9]{64}$/u);
  assert.equal(passing.checks.renderFile, true);
  assert.equal(passing.checks.mediaProbe, true);
  assert.equal(passing.checks.decode, true);
  assert.equal(passing.checks.renderHash, true);

  for (const failing of [
    { renderFile: null },
    { renderFile: path.join(root, "missing.mp4") },
    { readable: false },
    { safeArea: false },
    { contrast: false },
    { syncErrorMs: 101 },
    { networkAccess: true },
  ]) {
    const result = await qaTechniqueSandbox({
      renderFile,
      readable: true,
      safeArea: true,
      contrast: true,
      syncErrorMs: 0,
      networkAccess: false,
      ...failing,
    });
    assert.equal(result.eligibleTransition, null);
    assert.ok(result.failures.length >= 1);
  }

  const invalidFile = path.join(root, "not-media.mp4");
  fs.writeFileSync(invalidFile, "not a media file", "utf8");
  const invalidMedia = await qaTechniqueSandbox({
    renderFile: invalidFile,
    readable: true,
    safeArea: true,
    contrast: true,
    syncErrorMs: 0,
    networkAccess: false,
  });
  assert.equal(invalidMedia.eligibleTransition, null);
  assert.equal(invalidMedia.failures.includes("mediaProbe"), true);
  assert.equal(invalidMedia.failures.includes("decode"), true);

  const loudRender = fixtureRender(root, "loud-render", { loudAudio: true });
  const loudMedia = await qaTechniqueSandbox({
    renderFile: loudRender,
    readable: true,
    safeArea: true,
    contrast: true,
    syncErrorMs: 0,
    networkAccess: false,
  });
  assert.equal(loudMedia.eligibleTransition, null);
  assert.equal(loudMedia.failures.includes("truePeak"), true);
});

test("only a passing QA report bound to a real render can request the recreated transition", async t => {
  const calls = [];
  const memory = {
    transition(input) {
      calls.push(input);
      return { id: "transition.fixture", record: { status: input.to } };
    },
  };
  const item = technique();
  const root = fixtureRoot(t);
  const project = await buildTechniqueSandbox({
    technique: item,
    outputDir: path.join(root, "transition-project"),
  });
  const renderFile = fixtureRender(project.projectDir, "transition-render");

  await assert.rejects(
    () => applyRecreationQa({
      memory,
      technique: item,
      qa: { eligibleTransition: null, failures: ["decode"] },
    }),
    /not eligible for recreated/
  );
  assert.equal(calls.length, 0);

  const validQa = await qaTechniqueSandbox({
    projectDir: project.projectDir,
    renderFile,
    readable: true,
    safeArea: true,
    contrast: true,
    syncErrorMs: 0,
    networkAccess: false,
  });
  assert.equal(validQa.eligibleTransition, "recreated");

  await assert.rejects(
    () => applyRecreationQa({
      memory,
      technique: item,
      qa: { ...validQa, renderHash: null },
      projectDir: project.projectDir,
      renderFile,
    }),
    /valid render SHA-256/
  );
  await assert.rejects(
    () => applyRecreationQa({
      memory,
      technique: item,
      qa: { ...validQa, checks: completeChecks({ decode: false }) },
      projectDir: project.projectDir,
      renderFile,
    }),
    /missing verified QA checks: decode/
  );
  await assert.rejects(
    () => applyRecreationQa({
      memory,
      technique: item,
      qa: { ...validQa, techniqueId: "other-technique" },
      projectDir: project.projectDir,
      renderFile,
    }),
    /not bound to the current technique/
  );
  assert.equal(calls.length, 0);

  const originalRender = fs.readFileSync(renderFile);
  fs.writeFileSync(renderFile, Buffer.alloc(2048, 7));
  await assert.rejects(
    () => applyRecreationQa({
      memory,
      technique: item,
      qa: { ...validQa, renderHash: sha256File(renderFile) },
      projectDir: project.projectDir,
      renderFile,
    }),
    /failed repeated probe or full decode/
  );
  fs.writeFileSync(renderFile, originalRender);

  const result = await applyRecreationQa({
    memory,
    technique: item,
    qa: validQa,
    projectDir: project.projectDir,
    renderFile,
  });
  assert.equal(result.record.status, "recreated");
  assert.equal(calls[0].to, "recreated");
  assert.equal(calls[0].expectedHash, item.contentHash);
  assert.equal(calls[0].evidence[0].type, "render-qa");
});

test("specialized Motion primitives cannot use the generic recreated transition", async t => {
  const calls = [];
  const memory = {
    transition(input) {
      calls.push(input);
      return { record: { status: input.to } };
    },
  };
  const pause = technique({
    id: "caption.pause-aware.v1",
    primitive: "pause-aware-follow-caption",
  });
  const root = fixtureRoot(t);
  const project = await buildTechniqueSandbox({
    technique: pause,
    outputDir: path.join(root, "specialized-transition-project"),
  });
  const renderFile = fixtureRender(project.projectDir, "specialized-transition-render");
  const qa = await qaTechniqueSandbox({
    projectDir: project.projectDir,
    renderFile,
    readable: true,
    safeArea: true,
    contrast: true,
    syncErrorMs: 0,
    networkAccess: false,
    pauseHoldVerified: true,
  });
  assert.equal(qa.eligibleTransition, "recreated");
  const proofFile = path.join(project.projectDir, "technique-proof.json");
  const proof = fs.readFileSync(proofFile);
  fs.rmSync(proofFile);
  await assert.rejects(
    () => applyRecreationQa({
      memory,
      technique: pause,
      qa,
      projectDir: project.projectDir,
      renderFile,
    }),
    /valid primitive proof sidecar/
  );
  fs.writeFileSync(proofFile, proof);
  await assert.rejects(
    () => applyRecreationQa({
      memory,
      technique: pause,
      qa,
      projectDir: project.projectDir,
      renderFile,
    }),
    /requires its specialized proof verifier/
  );
  assert.equal(calls.length, 0);
});
