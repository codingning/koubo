#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceptanceRecipes,
  acceptanceVideoEncodingArgs,
  blindMediaPlan,
} from "../video/multi-agent/acceptance.mjs";
import { buildBlindReviewBundle } from "../video/multi-agent/evaluation.mjs";
import {
  normalizeSubjectiveBaseline,
  resolveSubjectiveBaselineMedia,
} from "../video/multi-agent/subjective-baseline.mjs";
import { buildSubjectiveReviewPackage } from "../video/multi-agent/subjective-package.mjs";
import { buildSubjectiveReviewHtml } from "../video/multi-agent/subjective-review.mjs";
import {
  createContactSheet,
  finalizeQa,
  qaMedia,
  renderChallenger,
  renderControl,
  run,
  sha256,
  writeJson,
} from "./run_multi_agent_acceptance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineFile = path.join(root, "config", "evaluation", "subjective-real-baseline-v1.json");

function parseArguments(argv) {
  const values = {
    jobsRoot: process.env.KOUBO_VIDEO_JOBS_ROOT || path.join(root, "video-jobs"),
    outputRoot: path.join(root, ".cache", "multi-agent-subjective-review"),
    runId: new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14),
  };
  const names = new Map([
    ["--jobs-root", "jobsRoot"],
    ["--output-root", "outputRoot"],
    ["--run-id", "runId"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = names.get(argv[index]);
    if (!field || !argv[index + 1]) throw new Error(`invalid argument: ${argv[index]}`);
    values[field] = argv[++index];
  }
  values.jobsRoot = path.resolve(values.jobsRoot);
  values.outputRoot = path.resolve(values.outputRoot);
  if (!/^[A-Za-z0-9._-]{4,80}$/.test(values.runId)) throw new Error("--run-id is invalid");
  return values;
}

async function extractSegment({ input, output, start, duration }) {
  await run("ffmpeg", [
    "-y", "-v", "warning",
    "-ss", start.toFixed(3),
    "-i", input,
    "-t", duration.toFixed(3),
    "-map", "0:v:0",
    "-map", "0:a:0",
    ...acceptanceVideoEncodingArgs(),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart",
    output,
  ]);
}

async function verifyFrozenMedia(baseline, resolved) {
  if (!fs.existsSync(resolved.source) || !fs.existsSync(resolved.control)) {
    throw new Error("real subjective source or control is missing");
  }
  const sourceHash = await sha256(resolved.source);
  const controlHash = await sha256(resolved.control);
  if (sourceHash !== baseline.source.sha256) throw new Error("real subjective source hash changed");
  if (controlHash !== baseline.control.sha256) throw new Error("real subjective control hash changed");
  return { sourceHash, controlHash };
}

async function renderSample({
  sample,
  source,
  control,
  runRoot,
  reviewMediaRoot,
  sourceHashVerified,
}) {
  const sampleRoot = path.join(runRoot, "samples", sample.id);
  await fsp.mkdir(sampleRoot, { recursive: true });
  const sourceSegment = path.join(sampleRoot, "source-segment.mp4");
  const controlSegment = path.join(sampleRoot, "control-segment.mp4");
  await extractSegment({
    input: source,
    output: sourceSegment,
    start: sample.editedStart,
    duration: sample.duration,
  });
  await extractSegment({
    input: control,
    output: controlSegment,
    start: sample.editedStart,
    duration: sample.duration,
  });

  const items = [];
  for (const recipe of acceptanceRecipes()) {
    const output = path.join(sampleRoot, `${recipe.id}.mp4`);
    let layoutEvidence = null;
    if (recipe.id === "frozen-control") {
      await renderControl({ input: controlSegment, output, duration: sample.duration });
    } else {
      layoutEvidence = await renderChallenger({
        source: sourceSegment,
        output,
        duration: sample.duration,
        recipe,
        phrases: sample.phrases,
        workDir: sampleRoot,
      });
    }
    const sourceEvidence = recipe.id === "frozen-control"
      ? null
      : {
          frozenRawSource: sourceHashVerified,
          sameTimelineSegment: true,
          startSeconds: sample.editedStart,
          durationSeconds: sample.duration,
        };
    const qa = await qaMedia(output, sample.duration, {
      layoutEvidence,
      sourceEvidence,
    });
    const contactSheet = path.join(sampleRoot, `${recipe.id}-contact-sheet.jpg`);
    await createContactSheet(output, contactSheet);
    items.push({
      recipe,
      output,
      contactSheet,
      qa,
      candidate: {
        id: recipe.id,
        renderHash: qa.fileHash,
        layout: recipe.layout,
        captions: recipe.captions,
        motion: recipe.motion,
        sound: recipe.sound,
      },
    });
  }
  finalizeQa(items);
  for (const item of items) {
    await writeJson(path.join(sampleRoot, `${item.recipe.id}-qa.json`), item.qa);
  }

  const bundle = buildBlindReviewBundle(items.map(item => item.candidate), {
    baselineId: "koubo-real-subjective-v1",
    jobId: sample.id,
  });
  const publicPlan = blindMediaPlan(
    bundle,
    items.map(item => ({ renderHash: item.qa.fileHash })),
    sample.id,
  );
  const packagedItems = [];
  for (const planned of publicPlan) {
    const item = items.find(candidate => candidate.qa.fileHash === planned.renderHash);
    const publicFile = `media/${planned.publicFile}`;
    await fsp.copyFile(item.output, path.join(reviewMediaRoot, planned.publicFile));
    packagedItems.push({
      label: planned.label,
      recipeId: item.recipe.id,
      renderHash: planned.renderHash,
      publicFile,
      technicalPass: item.qa.technicalPass,
    });
  }
  return {
    sample: {
      ...sample,
      mediaKind: "real-talking-head",
    },
    items: packagedItems,
    technicalEvidence: items.map(item => ({
      renderHash: item.qa.fileHash,
      technicalPass: item.qa.technicalPass,
      qaFile: path.relative(runRoot, path.join(sampleRoot, `${item.recipe.id}-qa.json`)).replaceAll("\\", "/"),
      contactSheet: path.relative(runRoot, item.contactSheet).replaceAll("\\", "/"),
    })),
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const runRoot = path.join(args.outputRoot, args.runId);
  const manifestFile = path.join(runRoot, "subjective-manifest.json");
  if (fs.existsSync(manifestFile)) {
    throw new Error(`subjective review run already exists and will not be overwritten: ${runRoot}`);
  }
  const baseline = normalizeSubjectiveBaseline(
    JSON.parse(await fsp.readFile(baselineFile, "utf8")),
  );
  const resolved = resolveSubjectiveBaselineMedia(baseline, args.jobsRoot);
  const frozen = await verifyFrozenMedia(baseline, resolved);
  const reviewRoot = path.join(runRoot, "review");
  const reviewMediaRoot = path.join(reviewRoot, "media");
  await fsp.mkdir(reviewMediaRoot, { recursive: true });

  const rendered = [];
  for (const sample of baseline.samples) {
    rendered.push(await renderSample({
      sample,
      source: resolved.source,
      control: resolved.control,
      runRoot,
      reviewMediaRoot,
      sourceHashVerified: frozen.sourceHash === baseline.source.sha256,
    }));
  }
  const reviewPackage = buildSubjectiveReviewPackage({
    runId: args.runId,
    baselineId: baseline.baselineId,
    samples: rendered,
  });
  const publicManifest = {
    ...reviewPackage.manifest,
    frozenMedia: frozen,
    samples: reviewPackage.publicSamples.map((sample, index) => ({
      ...sample,
      technicalEvidence: rendered[index].technicalEvidence,
    })),
  };
  await writeJson(manifestFile, publicManifest);
  await writeJson(path.join(runRoot, "blind-map-private.json"), reviewPackage.privateMap);
  await fsp.writeFile(
    path.join(reviewRoot, "index.html"),
    buildSubjectiveReviewHtml({
      runId: args.runId,
      samples: reviewPackage.publicSamples,
    }),
    "utf8",
  );
  process.stdout.write(`${JSON.stringify({
    success: reviewPackage.manifest.automatedPass,
    status: reviewPackage.manifest.status,
    runId: args.runId,
    sampleCount: reviewPackage.publicSamples.length,
    candidateCount: reviewPackage.publicSamples.reduce(
      (sum, sample) => sum + sample.candidates.length,
      0,
    ),
    manifest: manifestFile,
    review: path.join(reviewRoot, "index.html"),
  }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
