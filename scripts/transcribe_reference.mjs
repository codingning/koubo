#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseArguments(argv) {
  const values = { model: "small", language: "zh" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (["--input", "--output-dir", "--model", "--language", "--python"].includes(key)) {
      values[key.slice(2)] = argv[++index];
      continue;
    }
    throw new Error(`unknown argument: ${key}`);
  }
  if (!String(values.input || "").trim()) throw new Error("--input is required");
  if (!String(values["output-dir"] || "").trim()) throw new Error("--output-dir is required");
  return values;
}

function run(command, args, { cwd = root, timeoutMs = 1800000 } = {}) {
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
    child.on("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const detail = String(stderr || stdout).replace(/\s+/gu, " ").trim().slice(-1000);
        reject(new Error(`transcription bridge exited with ${code}${detail ? `: ${detail}` : ""}`));
      }
    });
  });
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const input = path.resolve(args.input);
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) throw new Error(`input does not exist: ${input}`);
  const outputDir = path.resolve(args["output-dir"]);
  await fsp.mkdir(outputDir, { recursive: true });
  const transcriptFile = path.join(outputDir, "transcript.json");
  const manifestFile = path.join(outputDir, "transcription-manifest.json");
  const inputSha256 = sha256File(input);

  if (fs.existsSync(transcriptFile) && fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8").replace(/^\uFEFF/u, ""));
    if (manifest.inputSha256 === inputSha256 && manifest.model === args.model && manifest.language === args.language) {
      process.stdout.write(`${JSON.stringify({ ...manifest, transcriptFile, manifestFile, resumed: true }, null, 2)}\n`);
      return;
    }
  }

  const python = path.resolve(args.python || process.env.KOUBO_TRANSCRIBE_PYTHON || path.join(root, ".runtime", "Scripts", "python.exe"));
  if (!fs.existsSync(python)) throw new Error(`transcription Python is missing: ${python}`);
  const requestFile = path.join(outputDir, `${crypto.randomUUID()}.request.json`);
  const responseFile = path.join(outputDir, `${crypto.randomUUID()}.response.json`);
  await fsp.writeFile(requestFile, `${JSON.stringify({
    operation: "transcribe",
    input_path: input,
    output_dir: outputDir,
    model_size: args.model,
    language: args.language,
  })}\n`, "utf8");
  try {
    await run(python, [
      path.join(root, "video", "ai_bridge.py"),
      "--request", requestFile,
      "--response", responseFile,
    ]);
    if (!fs.existsSync(responseFile)) throw new Error("transcription bridge created no response file");
    const response = JSON.parse(fs.readFileSync(responseFile, "utf8").replace(/^\uFEFF/u, ""));
    if (!response.success) throw new Error(response.error || "transcription failed");
    const transcript = response.data || {};
    const manifest = {
      schemaVersion: 1,
      inputSha256,
      model: args.model,
      modelLabel: String(response.model || `faster-whisper/${args.model}`),
      language: args.language,
      detectedLanguage: transcript.language || null,
      durationSeconds: Number(transcript.duration || 0),
      segmentCount: Array.isArray(transcript.segments) ? transcript.segments.length : 0,
      wordCount: Array.isArray(transcript.words) ? transcript.words.length : 0,
      transcriptSha256: sha256File(transcriptFile),
      completedAt: new Date().toISOString(),
    };
    await fsp.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...manifest, transcriptFile, manifestFile, resumed: false }, null, 2)}\n`);
  } finally {
    await fsp.rm(requestFile, { force: true });
    await fsp.rm(responseFile, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
