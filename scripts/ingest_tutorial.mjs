#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadAgentProfiles } from "../video/multi-agent/contracts.mjs";
import { createTutorialIngestor } from "../video/multi-agent/tutorial-ingest.mjs";
import { createMemoryService } from "../video/multi-agent/memory.mjs";
import { openDomainStore } from "../video/multi-agent/store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const result = { resume: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--resume") {
      result.resume = true;
      continue;
    }
    if (["--input", "--author", "--license"].includes(value)) {
      result[value.slice(2)] = argv[++index];
      continue;
    }
    throw new Error(`unknown argument: ${value}`);
  }
  for (const key of ["input", "author", "license"]) {
    if (!String(result[key] || "").trim()) throw new Error(`--${key} is required`);
  }
  return result;
}

function loadLocalEnvironment() {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function runProcess(command, args, { cwd = root } = {}) {
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

async function runJsonBridge(executable, script, request, runtimeRoot) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const id = crypto.randomUUID();
  const requestFile = path.join(runtimeRoot, `${id}.request.json`);
  const responseFile = path.join(runtimeRoot, `${id}.response.json`);
  fs.writeFileSync(requestFile, `${JSON.stringify(request)}\n`, "utf8");
  try {
    const result = await runProcess(executable, [
      script,
      "--request",
      requestFile,
      "--response",
      responseFile,
    ]);
    if (!fs.existsSync(responseFile)) {
      throw new Error(`bridge created no response (exit ${result.code}): ${result.stderr.slice(0, 500)}`);
    }
    const response = JSON.parse(fs.readFileSync(responseFile, "utf8"));
    if (!response.success) throw new Error(response.error || `bridge failed with exit ${result.code}`);
    return response;
  } finally {
    fs.rmSync(requestFile, { force: true });
    fs.rmSync(responseFile, { force: true });
  }
}

function sidecarPath(inputPath, suffix) {
  const extension = path.extname(inputPath);
  return path.join(path.dirname(inputPath), `${path.basename(inputPath, extension)}.${suffix}.json`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

async function locateLegacyPython() {
  const configured = String(process.env.KOUBO_TRANSCRIBE_PYTHON || "").trim();
  if (configured && fs.existsSync(configured)) return configured;
  const local = path.join(root, ".runtime", "Scripts", "python.exe");
  if (fs.existsSync(local)) return local;
  const common = await runProcess("git", ["rev-parse", "--git-common-dir"]);
  if (common.code === 0) {
    const repositoryRoot = path.dirname(path.resolve(root, common.stdout.trim()));
    const shared = path.join(repositoryRoot, ".runtime", "Scripts", "python.exe");
    if (fs.existsSync(shared)) return shared;
  }
  throw new Error(
    "faster-whisper runtime not found; set KOUBO_TRANSCRIBE_PYTHON or provide <video>.transcript.json"
  );
}

async function createAdapters(inputPath, runtimeRoot) {
  const multiAgentPython = path.resolve(
    root,
    process.env.KOUBO_MULTI_AGENT_PYTHON || ".runtime-multi-agent/Scripts/python.exe"
  );
  if (!fs.existsSync(multiAgentPython)) {
    throw new Error(`multi-agent Python runtime not found: ${multiAgentPython}`);
  }
  const multiAgentBridge = path.join(root, "video", "multi_agent_bridge.py");
  const transcriptSidecar = sidecarPath(inputPath, "transcript");
  const techniqueSidecar = sidecarPath(inputPath, "techniques");

  const runTool = async request => {
    if (request.operation === "probe") {
      const result = await runProcess("ffprobe", [
        "-v", "error",
        "-show_streams",
        "-show_format",
        "-of", "json",
        request.inputPath,
      ]);
      if (result.code !== 0) throw new Error(`ffprobe failed: ${result.stderr.slice(0, 500)}`);
      const data = JSON.parse(result.stdout);
      const video = data.streams?.find(stream => stream.codec_type === "video");
      return {
        duration: Number(data.format?.duration || video?.duration || 0),
        width: Number(video?.width || 0),
        height: Number(video?.height || 0),
        hasAudio: Boolean(data.streams?.some(stream => stream.codec_type === "audio")),
      };
    }
    if (request.operation === "transcribe") {
      if (fs.existsSync(transcriptSidecar)) {
        return readJson(transcriptSidecar);
      }
      const legacyPython = await locateLegacyPython();
      const response = await runJsonBridge(
        legacyPython,
        path.join(root, "video", "ai_bridge.py"),
        {
          operation: "transcribe",
          input_path: request.inputPath,
          output_dir: path.join(runtimeRoot, "transcription", request.sourceHash),
          model_size: process.env.KOUBO_TRANSCRIPTION_MODEL || "small",
          language: process.env.KOUBO_TRANSCRIPTION_LANGUAGE || "zh",
        },
        runtimeRoot
      );
      return { model: response.model, ...response.data };
    }
    throw new Error(`unsupported local tool operation: ${request.operation}`);
  };

  const invokeBridge = async request => {
    const bridged = { ...request };
    if (request.operation === "extract_techniques" && fs.existsSync(techniqueSidecar)) {
      const data = readJson(techniqueSidecar);
      bridged.fixture_response = { techniques: data.techniques || data };
    }
    return runJsonBridge(multiAgentPython, multiAgentBridge, bridged, runtimeRoot);
  };
  return { runTool, invokeBridge };
}

async function main() {
  loadLocalEnvironment();
  const args = parseArguments(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const dataRoot = path.resolve(
    root,
    process.env.KOUBO_MULTI_AGENT_DATA_ROOT || "data/multi-agent"
  );
  const runtimeRoot = path.join(dataRoot, "runtime", "tutorial-ingest");
  const store = openDomainStore({
    dbPath: path.join(dataRoot, "runtime", "memory.sqlite"),
    exportRoot: path.join(dataRoot, "library"),
  });
  try {
    const profiles = await loadAgentProfiles(root);
    const memory = createMemoryService(store, profiles);
    const adapters = await createAdapters(inputPath, path.join(runtimeRoot, "bridge"));
    const ingestor = createTutorialIngestor({
      ...adapters,
      memory,
      checkpointRoot: path.join(runtimeRoot, "checkpoints"),
    });
    let checkpoint = await ingestor.registerSource({
      inputPath,
      author: args.author,
      license: args.license,
    });
    if (!args.resume && checkpoint.stage !== "registered") {
      throw new Error(`checkpoint already exists at stage ${checkpoint.stage}; pass --resume`);
    }
    checkpoint = await ingestor.resume(checkpoint);
    process.stdout.write(`${JSON.stringify({
      success: true,
      tutorialId: checkpoint.id,
      sourceHash: checkpoint.sourceHash,
      stage: checkpoint.stage,
      techniqueIds: checkpoint.artifacts.techniques.map(item => item.id),
      checkpointPath: checkpoint.checkpointPath,
      mediaCopied: checkpoint.mediaCopied,
    }, null, 2)}\n`);
  } finally {
    store.close();
  }
}

main().catch(error => {
  process.stderr.write(`${String(error?.message || error)}\n`);
  process.exitCode = 1;
});
