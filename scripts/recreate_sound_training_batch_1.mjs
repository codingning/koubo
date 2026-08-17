import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSoundSandbox } from "../video/multi-agent/sound-sandbox.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDir, "..");
const allowedOutputRoot = path.join(
  repositoryRoot,
  ".cache",
  "agent-training-batch-1"
);

function confinedOutput(value) {
  const resolved = path.resolve(repositoryRoot, value);
  const relative = path.relative(allowedOutputRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      "--output must be a child of " + allowedOutputRoot
    );
  }
  return resolved;
}

function parseArguments(argv) {
  const values = {
    output: path.join(repositoryRoot, ".cache", "agent-training-batch-1", "sound"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--output") {
      values.output = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error("unknown argument: " + key);
  }
  if (!String(values.output || "").trim()) throw new Error("--output must not be empty");
  values.output = confinedOutput(values.output);
  return values;
}

const argumentsValue = parseArguments(process.argv.slice(2));
const result = await buildSoundSandbox({ outputDir: argumentsValue.output });
process.stdout.write(JSON.stringify({
  status: result.status,
  technicalPass: result.technicalPass,
  outputDir: result.outputDir,
  manifestFile: result.manifestFile,
  qaFile: result.qaFile,
  hashesFile: result.hashesFile,
  reviewFile: result.reviewFile,
}, null, 2) + "\n");
