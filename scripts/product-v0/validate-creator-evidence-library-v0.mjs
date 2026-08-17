import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fail(errors, message) {
  errors.push(message);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function walkFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function scanPrivateOutput(directory) {
  const secretPatterns = [
    /sk-[A-Za-z0-9_-]{20,}/gu,
    /ghp_[A-Za-z0-9]{20,}/gu,
    /AKIA[0-9A-Z]{16}/gu,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  ];
  const sensitiveFieldPattern = /(?:^\s*(?:author_)?sec_uid\s*:|"(?:author_)?sec_uid"\s*:)/gimu;
  const hits = [];
  for (const filePath of walkFiles(directory)) {
    const text = fs.readFileSync(filePath, "utf8");
    for (const pattern of [...secretPatterns, sensitiveFieldPattern]) {
      if (pattern.test(text)) hits.push(path.relative(directory, filePath).replaceAll("\\", "/"));
      pattern.lastIndex = 0;
    }
  }
  return [...new Set(hits)];
}

export function validateCreatorEvidenceLibrary(outputRoot, { requireFinal = false } = {}) {
  const root = path.resolve(outputRoot);
  const errors = [];
  const required = [
    "INPUT_MANIFEST.json",
    "DELIVERY_RECEIPT.json",
    "TOPIC_CANDIDATES.json",
    "library/INDEX.md",
    "DEMO/README.md",
  ];
  if (requireFinal) required.push("TOPIC_PACKS.md", "CONTENT_OUTLINE.md");
  required.forEach(relative => {
    if (!fs.existsSync(path.join(root, relative))) fail(errors, `Missing required file: ${relative}`);
  });
  if (errors.length) return { ok: false, errors };

  const manifest = readJson(path.join(root, "INPUT_MANIFEST.json"));
  const receipt = readJson(path.join(root, "DELIVERY_RECEIPT.json"));
  const candidates = readJson(path.join(root, "TOPIC_CANDIDATES.json"));
  const reconciliation = manifest.reconciliation || {};
  const balanced = Number(reconciliation.selected) === Number(reconciliation.success)
    + Number(reconciliation.duplicate) + Number(reconciliation.unavailable);
  if (!balanced || !reconciliation.balanced) fail(errors, "Manifest reconciliation is not balanced");
  if (Number(reconciliation.success) < 50) fail(errors, "Fewer than 50 valid sources");
  if (!receipt?.privacy?.secretScanPassed) fail(errors, "Secret scan did not pass");
  if (!receipt?.privacy?.authorSecUidOmitted) fail(errors, "Author sec_uid was not explicitly omitted");
  if (!receipt?.privacy?.outputIsPrivateRuntime) fail(errors, "Output is not under a private .runtime directory");
  const privacyHits = scanPrivateOutput(root);
  if (privacyHits.length) fail(errors, `Current output privacy scan failed: ${privacyHits.join(", ")}`);

  const currentFiles = walkFiles(root)
    .map(filePath => path.relative(root, filePath).replaceAll("\\", "/"))
    .filter(relative => relative !== "DELIVERY_RECEIPT.json")
    .sort();
  const receiptFiles = Object.keys(receipt.fileHashes || {}).sort();
  if (JSON.stringify(currentFiles) !== JSON.stringify(receiptFiles)) {
    fail(errors, "Delivery receipt file list does not match the current output");
  }
  for (const [relative, expectedHash] of Object.entries(receipt.fileHashes || {})) {
    const filePath = path.join(root, relative);
    if (!fs.existsSync(filePath)) fail(errors, `Receipt references a missing file: ${relative}`);
    else if (sha256File(filePath) !== expectedHash) fail(errors, `Receipt hash mismatch: ${relative}`);
  }

  const sourceIds = new Set();
  for (const source of manifest.sources || []) {
    if (!source.sourceId || sourceIds.has(source.sourceId)) fail(errors, `Duplicate or missing source ID: ${source.sourceId || "<missing>"}`);
    sourceIds.add(source.sourceId);
    if (!String(source.canonicalUrl || "").startsWith("https://www.douyin.com/video/")) {
      fail(errors, `Invalid canonical URL for ${source.sourceId}`);
    }
    const cardPath = path.join(root, source.card || "");
    if (!fs.existsSync(cardPath)) fail(errors, `Missing source card: ${source.card}`);
    else {
      const card = fs.readFileSync(cardPath, "utf8");
      if (!card.includes("## 来源主张") || !card.includes("## 用户判断") || !card.includes("## AI 推断与待核实项")) {
        fail(errors, `Evidence boundary sections missing in ${source.card}`);
      }
    }
  }
  if (sourceIds.size !== Number(reconciliation.success)) fail(errors, "Source card count does not match manifest success count");
  const actualSourceCards = fs.readdirSync(path.join(root, "library", "sources"))
    .filter(fileName => fileName.endsWith(".md"));
  if (actualSourceCards.length !== sourceIds.size) fail(errors, "Generated source directory contains stale or extra cards");

  for (const cluster of candidates.clusters || []) {
    for (const candidate of cluster.candidates || []) {
      if (!sourceIds.has(String(candidate.sourceId))) fail(errors, `Candidate references unknown source: ${candidate.sourceId}`);
    }
  }

  if (requireFinal) {
    const topicText = fs.readFileSync(path.join(root, "TOPIC_PACKS.md"), "utf8");
    const topicSections = [...topicText.matchAll(/^## TOPIC-[^\r\n]+/gmu)];
    if (topicSections.length !== 3) fail(errors, `Expected exactly 3 topic packs, found ${topicSections.length}`);
    const referencedIds = [...topicText.matchAll(/SRC-DOUYIN-(\d{10,})/gu)].map(match => match[1]);
    if (new Set(referencedIds).size < 6) fail(errors, "Topic packs must reference at least 6 distinct real sources");
    referencedIds.forEach(id => {
      if (!sourceIds.has(id)) fail(errors, `Topic pack references unknown source: ${id}`);
    });
    const outline = fs.readFileSync(path.join(root, "CONTENT_OUTLINE.md"), "utf8");
    if (!/selected_topic:\s*TOPIC-/u.test(outline)) fail(errors, "Content outline does not bind a selected topic");
    if (!outline.includes("来源观点") || !outline.includes("用户判断") || !outline.includes("AI 推断")) {
      fail(errors, "Content outline does not preserve evidence boundaries");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      selected: Number(reconciliation.selected),
      success: Number(reconciliation.success),
      duplicate: Number(reconciliation.duplicate),
      unavailable: Number(reconciliation.unavailable),
      sourceCards: sourceIds.size,
      finalRequired: requireFinal,
    },
  };
}

const isCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const output = process.argv[2];
  if (!output) {
    process.stderr.write("Usage: node validate-creator-evidence-library-v0.mjs <output-dir> [--require-final]\n");
    process.exitCode = 2;
  } else {
    const result = validateCreatorEvidenceLibrary(output, { requireFinal: process.argv.includes("--require-final") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  }
}
