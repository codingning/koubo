#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const naturalCompare = (left, right) => left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });

async function readJson(file) {
  return JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function walkFiles(root, current = root, output = []) {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => naturalCompare(a.name, b.name))) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", ".cache"].includes(entry.name)) continue;
      if (/(^|[-_])remotion($|[-_])/i.test(entry.name)) continue;
      await walkFiles(root, full, output);
      continue;
    }
    if (entry.isFile()) output.push(path.relative(root, full).replaceAll("\\", "/"));
  }
  return output;
}

function artifactCategory(relative, job) {
  const base = path.posix.basename(relative).toLowerCase();
  if (relative === "job.json") return "job";
  if (base === String(job.fileName || "").toLowerCase()) return "source";
  for (const prefix of [
    "qa-report",
    "review-bundle",
    "timeline",
    "captions",
    "edit-plan",
    "content-breakdown",
    "media-manifest",
    "motion-sample",
    "asset-decisions",
  ]) {
    if (base.startsWith(prefix) && /\.(json|md|csv|edl)$/.test(base)) return prefix;
  }
  if (/\.(mp4|webm)$/.test(base) && /(sample|review-preview|opening|full-hyperframes-review)/.test(base)) {
    return base.includes("sample") || base.includes("opening") ? "sample-video" : "review-video";
  }
  return null;
}

async function collectArtifacts(jobDir, job) {
  const files = await walkFiles(jobDir);
  const latestByCategory = new Map();
  for (const relative of files) {
    const category = artifactCategory(relative, job);
    if (!category) continue;
    const existing = latestByCategory.get(category);
    if (!existing || naturalCompare(existing, relative) < 0) latestByCategory.set(category, relative);
  }
  const selected = [...latestByCategory.values()].sort(naturalCompare);
  return Promise.all(selected.map(async relative => {
    const full = path.join(jobDir, ...relative.split("/"));
    const stat = await fsp.stat(full);
    return {
      path: relative,
      bytes: stat.size,
      sha256: await sha256(full),
    };
  }));
}

function inferTraits(job, artifactPaths) {
  const traits = new Set();
  const pipeline = String(job.pipeline || "");
  const allPaths = artifactPaths.join(" ").toLowerCase();
  if (!pipeline || pipeline === "ffmpeg-v3" || pipeline === "legacy-ffmpeg-v3") traits.add("legacy");
  if (pipeline === "visual-director-v4" || job.workflow?.version === "visual-director-v4") traits.add("v4");
  if (job.status === "approved" || String(job.script || "").trim()) traits.add("method");
  if (job.options?.captions !== false && (job.transcript?.segments?.length || /captions/.test(allPaths))) traits.add("captions");
  if (job.assets?.length || /media-manifest|review-bundle/.test(allPaths)) traits.add("evidence");
  if (
    job.workflow?.stages?.motion_sample
    || /motion|sample|review-bundle/.test(allPaths)
    || job.options?.informationPanels === true
  ) traits.add("motion");
  return [...traits].sort(naturalCompare);
}

export async function discoverJobCandidates(jobsRoot) {
  const root = path.resolve(jobsRoot);
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => naturalCompare(a.name, b.name))) {
    const jobDir = path.join(root, entry.name);
    const jobFile = path.join(jobDir, "job.json");
    if (!fs.existsSync(jobFile)) continue;
    const job = await readJson(jobFile);
    const artifacts = await collectArtifacts(jobDir, job);
    candidates.push({
      jobId: String(job.id || entry.name),
      pipeline: String(job.pipeline || job.workflow?.version || "legacy-ffmpeg-v3"),
      status: String(job.status || "unknown"),
      source: String(job.fileName || path.basename(job.sourcePath || "")),
      traits: inferTraits(job, artifacts.map(item => item.path)),
      artifacts,
    });
  }
  return candidates;
}

function candidateScore(candidate, uncovered) {
  const coverage = candidate.traits.filter(trait => uncovered.has(trait)).length;
  const v4 = candidate.traits.includes("v4") ? 2 : 0;
  const evidence = candidate.traits.includes("evidence") ? 1 : 0;
  return coverage * 10 + v4 + evidence;
}

export function selectRepresentativeJobs(candidates, { min = 3, max = 5 } = {}) {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
    throw new Error("invalid baseline selection limits");
  }
  if (candidates.length < min) throw new Error(`need at least ${min} valid jobs, found ${candidates.length}`);
  const required = new Set(["legacy", "method", "evidence", "captions", "motion", "v4"]);
  const remaining = [...candidates];
  const selected = [];
  while (remaining.length && selected.length < max && (selected.length < min || required.size)) {
    remaining.sort((left, right) => {
      const score = candidateScore(right, required) - candidateScore(left, required);
      return score || naturalCompare(left.jobId, right.jobId);
    });
    const next = remaining.shift();
    selected.push(next);
    for (const trait of next.traits) required.delete(trait);
  }
  if (required.size) throw new Error(`baseline coverage missing: ${[...required].join(", ")}`);
  return selected.sort((a, b) => naturalCompare(a.jobId, b.jobId));
}

function stableBaselineView(value) {
  return {
    schemaVersion: value.schemaVersion,
    baselineId: value.baselineId,
    sourceRootPolicy: value.sourceRootPolicy,
    samples: value.samples,
  };
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temp, file);
}

export async function freezeBaseline({
  jobsRoot,
  outputFile,
  min = 3,
  max = 5,
  now = new Date().toISOString(),
} = {}) {
  if (!jobsRoot || !outputFile) throw new Error("jobsRoot and outputFile are required");
  const candidates = await discoverJobCandidates(jobsRoot);
  const selected = selectRepresentativeJobs(candidates, { min, max });
  const manifest = {
    schemaVersion: 1,
    baselineId: "koubo-v4-baseline-v1",
    frozenAt: now,
    sourceRootPolicy: {
      type: "external-local-jobs-root",
      environmentVariable: "KOUBO_VIDEO_JOBS_ROOT",
      repositoryDefault: "video-jobs",
      mediaCopiedIntoGit: false,
    },
    samples: selected.map(candidate => ({
      jobId: candidate.jobId,
      pipeline: candidate.pipeline,
      status: candidate.status,
      source: candidate.source,
      coverage: candidate.traits,
      artifacts: candidate.artifacts,
    })),
  };
  const resolvedOutput = path.resolve(outputFile);
  if (fs.existsSync(resolvedOutput)) {
    const existing = await readJson(resolvedOutput);
    const oldStable = JSON.stringify(stableBaselineView(existing));
    const newStable = JSON.stringify(stableBaselineView(manifest));
    if (oldStable !== newStable) throw new Error("frozen baseline differs from current job artifacts; create a new baseline version instead of overwriting");
    return existing;
  }
  await writeJsonAtomic(resolvedOutput, manifest);
  return manifest;
}

function cliArguments(argv) {
  const value = name => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : "";
  };
  return {
    jobsRoot: value("--jobs-root") || process.env.KOUBO_VIDEO_JOBS_ROOT || path.resolve("video-jobs"),
    outputFile: value("--output") || path.resolve("config/evaluation/baseline-v1.json"),
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  freezeBaseline(cliArguments(process.argv.slice(2)))
    .then(manifest => {
      console.log(`已冻结 ${manifest.samples.length} 个评测样本：${manifest.samples.map(item => item.jobId).join(", ")}`);
    })
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
