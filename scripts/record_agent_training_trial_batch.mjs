#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_TRAINING_TRIAL_DEFAULTS,
  applyAgentTrainingTrialBatch,
} from "../video/multi-agent/agent-training-trial.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDir, "..");

function parseArguments(argv) {
  const values = { actorId: "koubo-owner" };
  const names = new Map([
    ["--review", "reviewFile"],
    ["--output-root", "outputRoot"],
    ["--catalog", "catalogFile"],
    ["--actor", "actorId"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = names.get(argv[index]);
    if (!field || !argv[index + 1]) throw new Error(`invalid argument: ${argv[index]}`);
    values[field] = argv[++index];
  }
  if (!values.reviewFile) throw new Error("--review is required");
  values.reviewFile = path.resolve(values.reviewFile);
  values.catalogFile = values.catalogFile
    ? path.resolve(values.catalogFile)
    : AGENT_TRAINING_TRIAL_DEFAULTS.catalogFile;
  values.outputRoot = values.outputRoot
    ? path.resolve(values.outputRoot)
    : path.join(repositoryRoot, "data", "multi-agent", "training-batches", "agent-training-batch-1-trial-v3");
  if (!/^[A-Za-z0-9._-]{2,80}$/.test(values.actorId)) {
    throw new Error("--actor must be a safe non-empty identifier");
  }
  const allowedRoot = path.join(repositoryRoot, "data", "multi-agent", "training-batches");
  const relative = path.relative(allowedRoot, values.outputRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("--output-root must be a child of data/multi-agent/training-batches");
  }
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const result = await applyAgentTrainingTrialBatch({
    repositoryRoot,
    catalogFile: args.catalogFile,
    reviewFile: args.reviewFile,
    outputRoot: args.outputRoot,
    actor: { type: "human", id: args.actorId },
  });
  process.stdout.write(`${JSON.stringify({ success: true, ...result }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
