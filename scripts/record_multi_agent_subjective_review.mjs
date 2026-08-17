#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { prepareSubjectiveReviewRecord } from "../video/multi-agent/subjective-result.mjs";

function parseArguments(argv) {
  const values = {};
  const names = new Map([
    ["--run-root", "runRoot"],
    ["--review", "review"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = names.get(argv[index]);
    if (!field || !argv[index + 1]) throw new Error(`invalid argument: ${argv[index]}`);
    values[field] = path.resolve(argv[++index]);
  }
  if (!values.runRoot || !values.review) {
    throw new Error("--run-root and --review are required");
  }
  return values;
}

async function readJson(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} is missing`);
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function replaceJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, file);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const manifestFile = path.join(args.runRoot, "subjective-manifest.json");
  const mappingFile = path.join(args.runRoot, "blind-map-private.json");
  const recordFile = path.join(args.runRoot, "subjective-review-record.json");
  if (fs.existsSync(recordFile)) {
    throw new Error(`subjective review record already exists: ${recordFile}`);
  }
  const [manifest, privateMap, payload] = await Promise.all([
    readJson(manifestFile, "subjective manifest"),
    readJson(mappingFile, "private blind mapping"),
    readJson(args.review, "human review"),
  ]);
  const result = prepareSubjectiveReviewRecord({
    manifest,
    privateMap,
    payload,
  });
  await fsp.writeFile(
    recordFile,
    `${JSON.stringify(result.record, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await replaceJson(manifestFile, result.updatedManifest);
  process.stdout.write(`${JSON.stringify({
    success: true,
    runId: result.record.runId,
    outcome: result.record.outcome,
    recordHash: result.record.recordHash,
    record: recordFile,
    manifest: manifestFile,
    productionApproval: false,
    autoPublish: false,
    memoryPromotion: false,
  }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
