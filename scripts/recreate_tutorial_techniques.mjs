#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadAgentProfiles } from "../video/multi-agent/contracts.mjs";
import { createMemoryService } from "../video/multi-agent/memory.mjs";
import { openDomainStore } from "../video/multi-agent/store.mjs";
import {
  applyRecreationQa,
  buildTechniqueSandbox,
  qaTechniqueSandbox,
} from "../video/multi-agent/tutorial-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HYPERFRAMES_VERSION = "0.7.70";

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (["--checkpoint", "--output", "--data-root"].includes(key)) {
      values[key.slice(2)] = argv[++index];
      continue;
    }
    throw new Error(`unknown argument: ${key}`);
  }
  if (!values.checkpoint) throw new Error("--checkpoint is required");
  values.output ||= ".cache/technique-reconstructions";
  values["data-root"] ||= process.env.KOUBO_MULTI_AGENT_DATA_ROOT || "data/multi-agent";
  return values;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

function requireSuccess(result, label) {
  if (result.code !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout).slice(-1200)}`);
  }
}

function parseJsonOutput(stdout, label) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`${label} returned no JSON`);
  return JSON.parse(stdout.slice(start, end + 1));
}

async function hyperframes(command, projectDir, extra = []) {
  const npxCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  if (!fs.existsSync(npxCli)) throw new Error(`npx CLI not found: ${npxCli}`);
  return run(process.execPath, [
    npxCli,
    "-y",
    `hyperframes@${HYPERFRAMES_VERSION}`,
    command,
    projectDir,
    ...extra,
  ], root);
}

async function reconstruct({ technique, outputRoot, memory }) {
  let current = memory.get("technique-card", technique.id);
  if (!current) throw new Error(`memory record not found: ${technique.id}`);
  if (current.status === "inbox") {
    memory.transition({
      kind: "technique-card",
      id: current.id,
      to: "extracted",
      actor: { type: "controller", id: "tutorial-ingestor" },
      evidence: [{
        sourceId: current.source.sourceId,
        kind: "tutorial-extraction-checkpoint",
        type: "extraction-checkpoint",
        passed: true,
      }],
      expectedHash: current.contentHash,
    });
    current = memory.get("technique-card", technique.id);
  }
  if (current.status === "recreated") {
    return { techniqueId: current.id, status: "recreated", resumed: true };
  }
  if (current.status !== "extracted") {
    throw new Error(`technique must be extracted before reconstruction: ${current.id} is ${current.status}`);
  }

  const projectDir = path.join(outputRoot, current.primitive, current.id);
  await buildTechniqueSandbox({ technique: current, outputDir: projectDir });

  if (["pause-aware-follow-caption", "semantic-layout-router"].includes(current.primitive)) {
    throw new Error(
      `${current.primitive} requires its specialized proof verifier before a governed recreated transition`
    );
  }

  const checked = await hyperframes("check", projectDir, ["--strict", "--json"]);
  requireSuccess(checked, `check ${current.id}`);
  const check = parseJsonOutput(checked.stdout, "hyperframes check");
  if (!check.ok
    || !check.lint?.ok
    || !check.runtime?.ok
    || !check.layout?.ok
    || !check.motion?.ok
    || !check.contrast?.ok
    || Number(check.lint?.errorCount || 0) !== 0
    || Number(check.lint?.warningCount || 0) !== 0) {
    throw new Error(`HyperFrames check failed for ${current.id}`);
  }

  const renderFile = path.join(projectDir, "render.mp4");
  const render = await hyperframes("render", projectDir, [
    "--output", renderFile,
    "--quality", "high",
    "--workers", "1",
    "--sdr",
    "--strict-all",
  ]);
  requireSuccess(render, `render ${current.id}`);
  const qa = await qaTechniqueSandbox({
    projectDir,
    renderFile,
    readable: check.layout.ok,
    safeArea: check.layout.ok,
    contrast: check.contrast.ok,
    syncErrorMs: 0,
    networkAccess: false,
  });
  fs.writeFileSync(path.join(projectDir, "qa-report.json"), `${JSON.stringify(qa, null, 2)}\n`, "utf8");
  if (qa.eligibleTransition !== "recreated") {
    throw new Error(`render QA failed for ${current.id}: ${qa.failures.join(", ")}`);
  }
  const transition = await applyRecreationQa({
    memory,
    technique: current,
    qa,
    projectDir,
    renderFile,
  });
  return {
    techniqueId: current.id,
    primitive: current.primitive,
    status: transition.record.status,
    projectDir,
    renderFile,
    renderHash: qa.renderHash,
    checks: qa.checks,
    resumed: false,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const checkpointFile = path.resolve(root, args.checkpoint);
  const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, "utf8").replace(/^\uFEFF/, ""));
  const outputRoot = path.resolve(root, args.output);
  const dataRoot = path.resolve(root, args["data-root"]);
  fs.mkdirSync(outputRoot, { recursive: true });
  const store = openDomainStore({
    dbPath: path.join(dataRoot, "runtime", "memory.sqlite"),
    exportRoot: path.join(dataRoot, "library"),
  });
  try {
    const profiles = await loadAgentProfiles(root);
    const memory = createMemoryService(store, profiles);
    const results = [];
    for (const technique of checkpoint.artifacts?.techniques || []) {
      results.push(await reconstruct({ technique, outputRoot, memory }));
    }
    const report = {
      schemaVersion: 1,
      tutorialId: checkpoint.id,
      sourceHash: checkpoint.sourceHash,
      status: "recreated",
      results,
    };
    fs.writeFileSync(
      path.join(outputRoot, "recreation-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    store.close();
  }
}

main().catch(error => {
  process.stderr.write(`${String(error?.message || error)}\n`);
  process.exitCode = 1;
});
