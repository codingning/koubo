import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, contentHash, validateRecord } from "./contracts.mjs";

const STAGE_ORDER = [
  "registered",
  "probed",
  "scenes",
  "transcribed",
  "extracted",
  "routed",
  "awaiting_recreation",
];
const DOMAIN_NAMESPACE = {
  caption: "caption.private",
  motion: "motion.private",
  sound: "sound.private",
  voice: "sound.private",
  visual: "motion.private",
};

function finalized(record) {
  const value = structuredClone(record);
  delete value.contentHash;
  value.contentHash = contentHash(value);
  return value;
}

function stageAtLeast(checkpoint, stage) {
  return STAGE_ORDER.indexOf(checkpoint.stage) >= STAGE_ORDER.indexOf(stage);
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function safeId(value) {
  const text = String(value || "");
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw new Error(`unsafe technique id: ${text}`);
  return text;
}

function extractResult(response) {
  if (!response?.success) throw new Error(response?.error || "technique extraction failed");
  const result = response.result || response;
  if (!Array.isArray(result.techniques)) throw new Error("technique extraction must return techniques");
  return result.techniques;
}

function techniqueFingerprint(raw) {
  return contentHash({
    domain: raw.domain,
    primitive: raw.primitive,
    problem: raw.problem,
    parameters: raw.parameters || {},
  });
}

function techniqueId(raw, sourceHash, fingerprint) {
  const prefix = raw.id || `${raw.domain}.${raw.primitive}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safeId(`${prefix || "technique"}.${sourceHash.slice(0, 8)}.${fingerprint.slice(0, 8)}`);
}

function normalizeTechnique(raw, checkpoint, fingerprint, clock) {
  if (!raw || typeof raw !== "object") throw new Error("extracted technique must be an object");
  const domain = String(raw.domain || "");
  const namespace = DOMAIN_NAMESPACE[domain];
  if (!namespace) throw new Error(`unsupported technique domain: ${domain}`);
  const start = Number(raw.start ?? raw.evidence?.[0]?.start);
  const end = Number(raw.end ?? raw.evidence?.[0]?.end);
  const duration = Number(checkpoint.artifacts.probe?.duration);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error("technique evidence must contain a valid source time range");
  }
  if (Number.isFinite(duration) && end > duration + 0.001) {
    throw new Error(`technique evidence is outside source duration: ${start}-${end} > ${duration}`);
  }
  if (!String(raw.title || "").trim() || !String(raw.problem || "").trim() || !String(raw.primitive || "").trim()) {
    throw new Error("technique title, problem, and primitive are required");
  }

  const source = checkpoint.source;
  const record = finalized({
    id: techniqueId(raw, checkpoint.sourceHash, fingerprint),
    schemaVersion: 1,
    createdAt: clock(),
    createdBy: { type: "agent", id: "tutorial-ingestor" },
    status: "inbox",
    source: {
      type: "local-tutorial",
      sourceId: checkpoint.sourceHash,
      author: source.author,
      license: source.license,
    },
    evidence: [{
      sourceId: checkpoint.sourceHash,
      kind: "video-time-range",
      start,
      end,
      sceneIndex: raw.sceneIndex ?? null,
      transcriptText: String(raw.transcriptText || ""),
    }],
    applicability: Array.isArray(raw.applicability) ? raw.applicability.map(String) : [],
    prohibitions: Array.isArray(raw.prohibitions) ? raw.prohibitions.map(String) : [],
    versions: {
      code: "tutorial-ingest-v1",
      model: String(checkpoint.artifacts.extractionModel || "fixture"),
      prompt: "extract-techniques-v1",
      memory: "schema-v1",
      asset: "source-hash-v1",
      recipe: "primitive-v1",
      evaluation: "rubric-v1",
    },
    domain,
    namespace,
    title: String(raw.title),
    problem: String(raw.problem),
    primitive: String(raw.primitive),
    parameters: raw.parameters && typeof raw.parameters === "object" ? raw.parameters : {},
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    extractionFingerprint: fingerprint,
  });
  validateRecord("technique-card", record);
  return record;
}

function cleanError(error) {
  return {
    name: String(error?.name || "Error"),
    message: String(error?.message || error || "unknown failure").slice(0, 500),
  };
}

export function createTutorialIngestor({
  runTool,
  invokeBridge,
  memory,
  checkpointRoot,
  clock = () => new Date().toISOString(),
} = {}) {
  if (typeof runTool !== "function") throw new Error("runTool is required");
  if (typeof invokeBridge !== "function") throw new Error("invokeBridge is required");
  if (!memory || typeof memory.ingest !== "function") throw new Error("memory service is required");
  if (!checkpointRoot) throw new Error("checkpointRoot is required");
  const root = path.resolve(checkpointRoot);
  fs.mkdirSync(root, { recursive: true });

  function checkpointPath(sourceHash) {
    return path.join(root, `${sourceHash}.json`);
  }

  function save(checkpoint) {
    checkpoint.updatedAt = clock();
    checkpoint.checkpointPath = checkpointPath(checkpoint.sourceHash);
    const temporary = `${checkpoint.checkpointPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, `${canonicalJson(checkpoint)}\n`, "utf8");
    fs.renameSync(temporary, checkpoint.checkpointPath);
    return checkpoint;
  }

  function load(sourceHash) {
    const file = checkpointPath(sourceHash);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  function verifySource(checkpoint) {
    const inputPath = path.resolve(checkpoint.source.inputPath);
    if (!fs.existsSync(inputPath)) throw new Error(`tutorial source is missing: ${inputPath}`);
    const actual = hashFile(inputPath);
    if (actual !== checkpoint.sourceHash) {
      throw new Error(`tutorial source hash changed: expected ${checkpoint.sourceHash}, got ${actual}`);
    }
  }

  async function registerSource({ inputPath, author, license }) {
    if (!String(author || "").trim() || !String(license || "").trim()) {
      throw new Error("author and license are required");
    }
    const resolvedInput = path.resolve(String(inputPath || ""));
    if (!fs.existsSync(resolvedInput) || !fs.statSync(resolvedInput).isFile()) {
      throw new Error(`tutorial source does not exist: ${resolvedInput}`);
    }
    const sourceHash = hashFile(resolvedInput);
    const existing = load(sourceHash);
    if (existing) {
      verifySource(existing);
      return existing;
    }
    const createdAt = clock();
    return save({
      schemaVersion: 1,
      id: `tutorial.${sourceHash.slice(0, 16)}`,
      sourceHash,
      stage: "registered",
      createdAt,
      updatedAt: createdAt,
      source: {
        inputPath: resolvedInput,
        fileName: path.basename(resolvedInput),
        author: String(author).trim(),
        license: String(license).trim(),
      },
      mediaCopied: false,
      artifacts: {},
      completedStages: ["registered"],
      routedIds: [],
      failures: [],
    });
  }

  async function runCheckpointOperation(checkpoint, operation, action) {
    try {
      const result = await action();
      checkpoint.failures = checkpoint.failures || [];
      return result;
    } catch (error) {
      checkpoint.failures = checkpoint.failures || [];
      checkpoint.failures.push({
        at: clock(),
        operation,
        ...cleanError(error),
      });
      save(checkpoint);
      throw error;
    }
  }

  function completeStage(checkpoint, stage) {
    checkpoint.stage = stage;
    checkpoint.completedStages = [...new Set([...(checkpoint.completedStages || []), stage])];
    save(checkpoint);
  }

  async function preprocess(inputCheckpoint) {
    const checkpoint = structuredClone(inputCheckpoint);
    verifySource(checkpoint);
    if (!stageAtLeast(checkpoint, "probed")) {
      checkpoint.artifacts.probe = await runCheckpointOperation(
        checkpoint,
        "probe",
        () => runTool({
          operation: "probe",
          inputPath: checkpoint.source.inputPath,
          sourceHash: checkpoint.sourceHash,
        })
      );
      completeStage(checkpoint, "probed");
    }
    if (!stageAtLeast(checkpoint, "scenes")) {
      const result = await runCheckpointOperation(
        checkpoint,
        "detect_scenes",
        () => invokeBridge({
          operation: "detect_scenes",
          media_path: checkpoint.source.inputPath,
          source_hash: checkpoint.sourceHash,
        })
      );
      if (!result?.success || !Array.isArray(result.scenes)) {
        throw new Error(result?.error || "scene detection returned no scenes");
      }
      checkpoint.artifacts.scenes = result.scenes;
      completeStage(checkpoint, "scenes");
    }
    if (!stageAtLeast(checkpoint, "transcribed")) {
      checkpoint.artifacts.transcript = await runCheckpointOperation(
        checkpoint,
        "transcribe",
        () => runTool({
          operation: "transcribe",
          inputPath: checkpoint.source.inputPath,
          sourceHash: checkpoint.sourceHash,
        })
      );
      if (!Array.isArray(checkpoint.artifacts.transcript?.segments)) {
        throw new Error("transcription must contain segments");
      }
      completeStage(checkpoint, "transcribed");
    }
    return checkpoint;
  }

  async function extract(inputCheckpoint) {
    const checkpoint = structuredClone(inputCheckpoint);
    verifySource(checkpoint);
    if (!stageAtLeast(checkpoint, "transcribed")) throw new Error("transcription must complete before extraction");
    if (stageAtLeast(checkpoint, "extracted")) return checkpoint;

    const response = await runCheckpointOperation(
      checkpoint,
      "extract_techniques",
      () => invokeBridge({
        operation: "extract_techniques",
        agent_id: "tutorial-ingestor",
        source_hash: checkpoint.sourceHash,
        prompt: canonicalJson({
          task: "Extract reproducible editing techniques with source timecodes.",
          source: {
            author: checkpoint.source.author,
            license: checkpoint.source.license,
          },
          probe: checkpoint.artifacts.probe,
          scenes: checkpoint.artifacts.scenes,
          transcript: checkpoint.artifacts.transcript,
        }),
      })
    );
    const rawTechniques = extractResult(response);
    checkpoint.artifacts.extractionModel = String(response.model || response.mode || "fixture");
    const seen = new Set();
    const techniques = [];
    for (const raw of rawTechniques) {
      const fingerprint = techniqueFingerprint(raw);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      techniques.push(normalizeTechnique(raw, checkpoint, fingerprint, clock));
    }
    if (techniques.length === 0) throw new Error("technique extraction returned no unique techniques");
    checkpoint.artifacts.techniques = techniques;
    completeStage(checkpoint, "extracted");
    return checkpoint;
  }

  async function route(inputCheckpoint) {
    const checkpoint = structuredClone(inputCheckpoint);
    verifySource(checkpoint);
    if (!stageAtLeast(checkpoint, "extracted")) throw new Error("extraction must complete before routing");
    if (checkpoint.stage === "awaiting_recreation") return checkpoint;
    checkpoint.routedIds = checkpoint.routedIds || [];
    for (const technique of checkpoint.artifacts.techniques || []) {
      if (checkpoint.routedIds.includes(technique.id)) continue;
      await runCheckpointOperation(
        checkpoint,
        `memory_ingest:${technique.id}`,
        () => memory.ingest(technique)
      );
      checkpoint.routedIds.push(technique.id);
      checkpoint.stage = "routed";
      checkpoint.completedStages = [...new Set([...(checkpoint.completedStages || []), "routed"])];
      save(checkpoint);
    }
    completeStage(checkpoint, "awaiting_recreation");
    return checkpoint;
  }

  async function resume(inputCheckpoint) {
    let checkpoint = typeof inputCheckpoint === "string"
      ? load(inputCheckpoint)
      : structuredClone(inputCheckpoint);
    if (!checkpoint) throw new Error("tutorial checkpoint not found");
    verifySource(checkpoint);
    if (!stageAtLeast(checkpoint, "transcribed")) checkpoint = await preprocess(checkpoint);
    if (!stageAtLeast(checkpoint, "extracted")) checkpoint = await extract(checkpoint);
    if (checkpoint.stage !== "awaiting_recreation") checkpoint = await route(checkpoint);
    return checkpoint;
  }

  return {
    registerSource,
    preprocess,
    extract,
    route,
    resume,
    load,
    save,
  };
}
