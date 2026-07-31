import crypto from "node:crypto";
import path from "node:path";
import { canonicalJson, contentHash as hashContent } from "./contracts.mjs";
import {
  buildContentStrategistInput,
  buildContentStrategistAnalysisRequest,
  normalizeContentStrategistOutput,
  canEnterScriptStage,
} from "./content-strategy.mjs";
import { auditRenderedJobOrdinaryViewer } from "./rendered-ordinary-viewer-audit.mjs";

const SECRET_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "cookie",
  "password",
  "privatekey",
  "secret",
  "token",
]);

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function sanitize(value, seen = new WeakSet()) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(item => sanitize(item, seen)).filter(item => item !== undefined);
  if (!value || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (SECRET_KEYS.has(normalized)) continue;
    const item = sanitize(value[key], seen);
    if (item !== undefined) output[key] = item;
  }
  seen.delete(value);
  return output;
}

function sendJson(res, status, value, { replayed = false } = {}) {
  const body = `${JSON.stringify(sanitize(value), null, 2)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    ...(replayed ? { "Idempotency-Replayed": "true" } : {}),
  });
  res.end(body);
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw httpError(413, "request body exceeds 1 MiB limit");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw httpError(400, "request body must be valid JSON");
  }
}

function isLoopback(address) {
  if (!address) return true;
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1";
}

function isWithinRoot(file, allowedRoots) {
  const resolved = path.resolve(String(file || ""));
  return allowedRoots.some(root => {
    const base = path.resolve(root);
    const left = resolved.toLowerCase();
    const right = base.toLowerCase();
    return left === right || left.startsWith(`${right}${path.sep}`.toLowerCase());
  });
}

function jobProposalInput(job) {
  const transcript = Array.isArray(job.transcript?.segments)
    ? job.transcript.segments.map(item => ({
      start: Number(item.start),
      end: Number(item.end),
      text: String(item.text || ""),
    }))
    : [];
  const approvedAssets = (job.assets || [])
    .filter(item => item.approved === true || item.status === "approved")
    .map(item => ({
      id: item.id,
      kind: item.mediaKind || item.kind,
      placement: item.placement,
      license: item.license || item.rights?.license,
    }));
  const duration = Number(job.source?.duration || job.output?.duration || 0);
  return {
    jobId: job.id,
    transcript,
    sharedEvidence: approvedAssets.map(item => ({
      id: item.id,
      kind: item.kind,
      start: Number(item.placement?.start || 0),
      end: Number(item.placement?.end || duration),
    })),
    currentPlan: structuredClone(job.currentPlan || {}),
    roleInputs: {
      caption: {
        captionCues: structuredClone(job.captions || []),
        safeArea: job.output?.safeArea || { bottom: 120 },
      },
      motion: {
        sceneWindows: structuredClone(job.timeline?.scenes || []),
        approvedAssets,
      },
      sound: {
        licensedAssets: approvedAssets.filter(item => item.kind === "audio"),
        voicePeakDb: job.output?.qa?.voicePeakDb ?? null,
      },
    },
    v4Plan: {
      engine: "visual-director-v4",
      layout: job.currentPlan?.layout || job.options?.layout || "speaker-right-information-left",
      captions: { identity: job.options?.captionStyle || "anchor" },
      motion: { structure: job.currentPlan?.motion || [] },
      sound: { structure: job.currentPlan?.sound || [] },
    },
  };
}

function isMultiAgentPath(pathname) {
  return pathname.startsWith("/api/multi-agent/")
    || /^\/api\/(?:jobs|contents)\/[^/]+\/multi-agent\//.test(pathname);
}

function requireDependency(value, label) {
  if (typeof value !== "function") throw httpError(503, `${label} is not configured`);
  return value;
}

function validationError(error) {
  if (error?.statusCode) return error;
  return httpError(400, String(error?.message || error || "invalid request"));
}

function normalizedAgentResult(response, label) {
  if (response?.success === false) throw new Error(response.error || `${label} failed`);
  return response?.result ?? response;
}

function artifactId(subjectId, key) {
  const suffix = crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
  return `${subjectId}.${suffix}`;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function recordContentHash(record) {
  const core = structuredClone(record);
  delete core.contentHash;
  return hashContent(core);
}

function withRecordContentHash(record) {
  return { ...record, contentHash: recordContentHash(record) };
}

function assertRecordContentHash(record, label) {
  const declared = String(record?.contentHash || "").trim();
  if (!/^[a-f0-9]{64}$/u.test(declared) || declared !== recordContentHash(record)) {
    throw httpError(409, `${label} content hash is missing or invalid`);
  }
  return declared;
}

function assertNoClientAuthorityFields(body, keys, label) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, `${label} body must be an object`);
  }
  const normalized = new Set(keys.map(key => key.replace(/[^a-z0-9]/gi, "").toLowerCase()));
  for (const key of Object.keys(body)) {
    const token = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (normalized.has(token)) {
      throw httpError(400, `${label} must use authoritative server data; client field ${key} is forbidden`);
    }
  }
}

function normalizedRequestWorkspaceId(req, resolver) {
  const value = typeof resolver === "function"
    ? resolver(req)
    : req?.kouboWorkspaceId;
  return String(value || "local-default").trim().toLowerCase() || "local-default";
}

function assertArtifactWorkspace(artifact, workspaceId, label) {
  const artifactWorkspaceId = String(artifact?.workspaceId || "").trim().toLowerCase();
  if (artifactWorkspaceId && artifactWorkspaceId !== workspaceId) {
    throw httpError(404, `${label} not found`);
  }
}

function clientProvidedEvidence(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw httpError(400, "evidence must be an array");
  return value.map((item, index) => ({
    id: item?.id,
    kind: item?.kind,
    summary: item?.summary,
    sourceId: `user-provided-${index + 1}`,
    provenance: "user_provided",
    ...(Number.isFinite(item?.start) && Number.isFinite(item?.end)
      ? { start: item.start, end: item.end }
      : {}),
  }));
}

function contentScript(content, variant = "full") {
  if (variant !== "full" && variant !== "short") throw httpError(400, "variant must be full or short");
  if (variant === "short") {
    const short = String(content.shortScript || "").trim();
    if (short) return short;
  }
  const segments = Array.isArray(content.fullSegments)
    ? content.fullSegments.map(item => String(item?.text || item || "").trim()).filter(Boolean)
    : [];
  if (segments.length) return segments.join("\n");
  for (const value of [content.script, content.fullScript, content.shortScript]) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  throw httpError(409, "content has no authoritative script candidate");
}

function directionFromRecord(record = {}) {
  const audience = String(
    record.approvedDirection?.audience
      || record.audience
      || record.targetAudience
      || record.engagement?.audienceMirror
      || ""
  ).trim();
  const viewerBenefit = String(
    record.approvedDirection?.viewerBenefit
      || record.viewerBenefit
      || record.audienceBenefit
      || ""
  ).trim();
  const coreQuestion = String(
    record.approvedDirection?.coreQuestion
      || record.coreQuestion
      || record.structureDesign?.coreQuestion
      || record.contentDirection?.structureDesign?.coreQuestion
      || record.mainTopic
      || record.contentDirection?.mainTopic
      || ""
  ).trim();
  if (!audience || !viewerBenefit || !coreQuestion) {
    throw httpError(409, "authoritative record is missing audience, viewer benefit, or core question");
  }
  const constraints = Array.isArray(record.approvedDirection?.constraints)
    ? record.approvedDirection.constraints.map(String).map(item => item.trim()).filter(Boolean)
    : Array.isArray(record.risks)
      ? record.risks.map(item => String(item?.text || item || "").trim()).filter(Boolean)
      : [];
  return { audience, viewerBenefit, coreQuestion, constraints };
}

function lockedDirectionFromRecord(record = {}) {
  return String(
    record.lockedDirection
      || record.generation?.lockedDirection
      || record.contentDirection?.lockedDirection
      || record.contentDirection?.generation?.lockedDirection
      || ""
  ).trim();
}

function traceableFacts(items, prefix) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const value = item && typeof item === "object" && !Array.isArray(item) ? item : { claim: item };
    const sourceId = String(value.sourceId || value.id || `${prefix}.${index + 1}`).trim();
    const fact = {
      sourceId,
      provenance: String(value.provenance || "authoritative_server_record").trim(),
    };
    const claim = String(value.claim || value.summary || value.text || value.evidence || "").trim();
    if (claim) fact.claim = claim;
    for (const key of ["kind", "status", "uncertainty"]) {
      const text = String(value[key] || "").trim();
      if (text) fact[key] = text;
    }
    if (Number.isFinite(value.start) && Number.isFinite(value.end) && value.start >= 0 && value.end > value.start) {
      fact.start = Number(value.start);
      fact.end = Number(value.end);
    }
    return fact;
  });
}

function contentFacts(content, contentId) {
  return traceableFacts(content.evidence || [], `content.${contentId}.evidence`);
}

function errorMessage(error) {
  return String(error?.message || error || "request failed")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<local-path>")
    .replace(/(?:sk|gsk|ghp|github_pat)_[A-Za-z0-9_-]{8,}/g, "<redacted>")
    .slice(0, 500);
}

export function createMultiAgentApi({
  enabled = false,
  advisoryEnabled = enabled,
  defaultPipeline = "visual-director-v4",
  allowedTutorialRoots = [],
  allowedRenderedRoots = [],
  readJob,
  readContent,
  writeArtifact,
  readArtifact,
  listMemory,
  listKnowledgeLibrary,
  memory,
  tutorials,
  orchestrator,
  contentStrategist,
  contentPrinciples = [],
  retrieveContentKnowledge,
  contentTrainingEvaluator,
  ordinaryViewerCritic,
  buildBlindReviewBundle,
  createWorkspaceEvidence,
  workspaceIdForRequest,
  clock = () => new Date().toISOString(),
} = {}) {
  const idempotency = new Map();

  function requireEnabled() {
    if (!enabled) throw httpError(409, "controlled multi-agent workflow is disabled");
  }

  function requireAdvisoryEnabled() {
    if (!advisoryEnabled) throw httpError(409, "content advisory workflow is disabled");
  }

  async function idempotentMutation(req, pathname, action) {
    const key = String(req.headers["idempotency-key"] || "").trim();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw httpError(400, "a valid Idempotency-Key header is required");
    }
    const body = await readJsonBody(req);
    const bodyHash = crypto.createHash("sha256").update(canonicalJson(body)).digest("hex");
    const workspaceId = normalizedRequestWorkspaceId(req, workspaceIdForRequest);
    const cacheKey = `${workspaceId}:${req.method}:${pathname}:${key}`;
    const cached = idempotency.get(cacheKey);
    if (cached) {
      if (cached.bodyHash !== bodyHash) throw httpError(409, "idempotency key was reused with a different body");
      return { ...cached, replayed: true };
    }
    const response = await action(body, key);
    const stored = { ...response, bodyHash, replayed: false };
    idempotency.set(cacheKey, stored);
    if (idempotency.size > 1000) idempotency.delete(idempotency.keys().next().value);
    return stored;
  }

  async function runContentStrategist(input, request, principles) {
    if (typeof contentStrategist === "function") {
      return normalizedAgentResult(await contentStrategist(input, { request, principles }), "content strategist");
    }
    if (typeof contentStrategist?.analyze === "function") {
      return normalizedAgentResult(await contentStrategist.analyze(input, { request, principles }), "content strategist");
    }
    throw httpError(503, "content strategist is not configured");
  }

  function contentKnowledgeQuery(input) {
    return [
      input.lockedDirection,
      input.audienceContext,
      ...input.userFacts,
      ...input.evidence.map(item => item.summary),
      ...input.constraints,
      ...input.interviewAnswers.flatMap(item => [item.question, item.answer]),
    ].map(item => String(item || "").trim()).filter(Boolean).join("\n").slice(0, 4000);
  }

  async function resolveContentKnowledge(selection, input) {
    if (selection === undefined || selection === null) {
      return {
        principles: contentPrinciples,
        audit: {
          source: "repository",
          mode: "default",
          includeTrial: false,
          topK: null,
          query: input.lockedDirection,
          records: [],
        },
      };
    }
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
      throw httpError(400, "knowledgeContext must be an object");
    }
    const mode = String(selection.mode || "").trim();
    if (mode === "none") {
      return {
        principles: [],
        audit: {
          source: "none",
          mode: "explicit-control",
          includeTrial: false,
          topK: 0,
          query: input.lockedDirection,
          records: [],
        },
      };
    }
    if (mode !== "creator-vault") {
      throw httpError(400, "knowledgeContext.mode must be none or creator-vault");
    }
    if (selection.includeTrial !== true) {
      throw httpError(400, "creator-vault mode requires includeTrial=true");
    }
    const topK = Number(selection.topK ?? 5);
    if (!Number.isInteger(topK) || topK < 3 || topK > 5) {
      throw httpError(400, "creator-vault topK must be between 3 and 5");
    }
    if (typeof retrieveContentKnowledge !== "function") {
      throw httpError(409, "Creator Vault knowledge adapter is not configured");
    }
    return retrieveContentKnowledge({
      agentId: "content-strategist",
      query: contentKnowledgeQuery(input),
      includeTrial: true,
      topK,
    });
  }

  async function runOrdinaryReview(input, options) {
    if (typeof ordinaryViewerCritic?.review !== "function") {
      throw httpError(503, "ordinary viewer critic is not configured");
    }
    return ordinaryViewerCritic.review(input, options);
  }

  async function writeIndependentArtifact(kind, id, value) {
    const writer = requireDependency(writeArtifact, "writeArtifact");
    return writer(kind, id, sanitize(value));
  }

  async function verifiedWorkspaceEvidence(body, req) {
    const ids = body.evidenceArtifactIds;
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 6) {
      throw httpError(400, "evidenceArtifactIds must contain 1 to 6 artifact ids");
    }
    const workspaceId = normalizedRequestWorkspaceId(req, workspaceIdForRequest);
    const artifactReader = requireDependency(readArtifact, "readArtifact");
    const output = [];
    const seen = new Set();
    for (const rawId of ids) {
      const id = String(rawId || "").trim();
      if (!/^[A-Za-z0-9._-]{8,160}$/u.test(id) || seen.has(id)) {
        throw httpError(400, "evidenceArtifactIds contains an invalid or duplicate id");
      }
      seen.add(id);
      const artifact = await artifactReader("workspace-evidence", id);
      if (!artifact) throw httpError(404, "workspace evidence artifact not found");
      if (artifact.schemaVersion !== 1 || artifact.kind !== "workspace_evidence_snapshot") {
        throw httpError(409, "workspace evidence artifact has an invalid contract");
      }
      assertArtifactWorkspace(artifact, workspaceId, "workspace evidence artifact");
      assertRecordContentHash(artifact, "workspace evidence artifact");
      if (!Array.isArray(artifact.evidence) || artifact.evidence.length === 0) {
        throw httpError(409, "workspace evidence artifact is empty");
      }
      output.push(...artifact.evidence.map((item, index) => ({
        id: String(item?.id || `${id}.item-${index + 1}`),
        kind: String(item?.kind || "workspace-file"),
        summary: String(item?.summary || ""),
        sourceId: String(item?.sourceId || `${id}.source-${index + 1}`),
        provenance: "workspace_verified",
      })));
    }
    return output;
  }

  async function confirmedDirection(artifactId, fallbackRecord, { expectedLockedDirection = "" } = {}) {
    const id = String(artifactId || "").trim();
    if (!id) return directionFromRecord(fallbackRecord);
    const artifactReader = requireDependency(readArtifact, "readArtifact");
    const confirmation = await artifactReader("content-strategy-confirmations", id);
    if (!confirmation) throw httpError(404, "content strategy confirmation artifact not found");
    assertRecordContentHash(confirmation, "content strategy confirmation");
    if (confirmation.decision !== "approved" || confirmation.scriptHandoffAllowed !== true) {
      throw httpError(409, "content strategy confirmation is not approved");
    }
    if (confirmation.actor?.type !== "human" || !String(confirmation.actor?.id || "").trim()) {
      throw httpError(409, "content strategy confirmation requires a human actor");
    }
    const expected = String(expectedLockedDirection || "").trim();
    if (expected && String(confirmation.lockedDirection || "").trim() !== expected) {
      throw httpError(409, "content strategy confirmation is bound to a different locked direction");
    }
    return directionFromRecord({ approvedDirection: confirmation.approvedDirection });
  }

  async function confirmedContentStrategy(content, confirmationArtifactId) {
    const requestedConfirmationId = String(confirmationArtifactId || "").trim();
    if (!requestedConfirmationId) {
      throw httpError(400, "directionConfirmationArtifactId is required");
    }
    const generation = content?.generation;
    const expectedConfirmationId = String(generation?.strategyConfirmationArtifactId || "").trim();
    const expectedAnalysisId = String(generation?.strategyAnalysisArtifactId || "").trim();
    if (!expectedConfirmationId || !expectedAnalysisId) {
      throw httpError(409, "content generation is missing its strategy analysis or confirmation binding");
    }
    if (requestedConfirmationId !== expectedConfirmationId) {
      throw httpError(409, "content strategy confirmation does not match content generation");
    }

    const artifactReader = requireDependency(readArtifact, "readArtifact");
    const confirmation = await artifactReader("content-strategy-confirmations", requestedConfirmationId);
    if (!confirmation) throw httpError(404, "content strategy confirmation artifact not found");
    if (confirmation.schemaVersion !== 1 || confirmation.kind !== "content_strategy_human_confirmation") {
      throw httpError(409, "content strategy confirmation artifact has an invalid contract");
    }
    const confirmationContentHash = assertRecordContentHash(
      confirmation,
      "content strategy confirmation"
    );
    if (confirmation.decision !== "approved" || confirmation.scriptHandoffAllowed !== true) {
      throw httpError(409, "content strategy confirmation is not approved");
    }
    if (confirmation.actor?.type !== "human" || !String(confirmation.actor?.id || "").trim()) {
      throw httpError(409, "content strategy confirmation requires a human actor");
    }
    const lockedDirection = lockedDirectionFromRecord(content);
    if (!lockedDirection || String(confirmation.lockedDirection || "").trim() !== lockedDirection) {
      throw httpError(409, "content strategy confirmation is bound to a different locked direction");
    }

    const strategyAnalysisArtifactId = String(confirmation.analysisArtifactId || "").trim();
    if (!strategyAnalysisArtifactId || strategyAnalysisArtifactId !== expectedAnalysisId) {
      throw httpError(409, "content strategy analysis does not match content generation");
    }
    const analysisArtifact = await artifactReader(
      "content-strategy-analyses",
      strategyAnalysisArtifactId
    );
    if (!analysisArtifact) throw httpError(404, "content strategy analysis artifact not found");
    if (analysisArtifact.schemaVersion !== 1 || analysisArtifact.kind !== "content_strategy_analysis") {
      throw httpError(409, "content strategy analysis artifact has an invalid contract");
    }
    const analysisContentHash = assertRecordContentHash(
      analysisArtifact,
      "content strategy analysis"
    );
    if (String(confirmation.analysisContentHash || "").trim() !== analysisContentHash) {
      throw httpError(409, "content strategy confirmation is bound to a different analysis content hash");
    }
    if (!analysisArtifact.input || !analysisArtifact.analysis) {
      throw httpError(409, "content strategy analysis artifact is incomplete");
    }
    if (analysisArtifact.input.lockedDirection !== lockedDirection
      || analysisArtifact.analysis.lockedDirection !== lockedDirection) {
      throw httpError(409, "content strategy analysis is bound to a different locked direction");
    }
    const approvedDirection = {
      audience: analysisArtifact.analysis.audience,
      viewerBenefit: analysisArtifact.analysis.viewerBenefit,
      coreQuestion: analysisArtifact.analysis.testableQuestion,
      constraints: analysisArtifact.input.constraints || [],
    };
    if (canonicalJson(confirmation.approvedDirection) !== canonicalJson(approvedDirection)) {
      throw httpError(409, "content strategy confirmation approvedDirection does not match its analysis");
    }
    const confirmedInput = structuredClone(analysisArtifact.input);
    confirmedInput.userConfirmation = {
      analysisApproved: true,
      confirmedDirection: lockedDirection,
    };
    if (!canEnterScriptStage(confirmedInput, analysisArtifact.analysis)) {
      throw httpError(409, "content strategy confirmation is not ready for Script Agent handoff");
    }

    return {
      approvedDirection,
      strategyAnalysisArtifactId,
      strategyConfirmationArtifactId: requestedConfirmationId,
      analysisContentHash,
      confirmationContentHash,
    };
  }

  async function handleRoute(req, url) {
    const pathname = decodeURIComponent(url.pathname);
    if (!isMultiAgentPath(pathname)) return null;
    if (!isLoopback(req.socket?.remoteAddress)) throw httpError(403, "multi-agent API is local-only");

    if (req.method === "GET" && pathname === "/api/multi-agent/status") {
      return {
        status: 200,
        body: {
          enabled,
          advisoryEnabled,
          localOnly: true,
          defaultPipeline,
          multiAgentPipeline: "controlled-multi-agent-v1",
          autoPublish: false,
          brandCoreMutable: false,
          humanApprovalRequired: true,
          maxIterations: 2,
        },
      };
    }

    if (req.method === "GET" && pathname === "/api/multi-agent/memory") {
      const records = typeof listMemory === "function"
        ? await listMemory({
          kind: url.searchParams.get("kind") || undefined,
          status: url.searchParams.get("status") || undefined,
        })
        : [];
      return { status: 200, body: { records: sanitize(records) } };
    }

    if (req.method === "GET" && pathname === "/api/multi-agent/knowledge-library") {
      const library = typeof listKnowledgeLibrary === "function"
        ? await listKnowledgeLibrary()
        : { schemaVersion: 1, readOnly: true, summary: { total: 0 }, catalogs: [], records: [] };
      return { status: 200, body: sanitize(library) };
    }

    const artifactMatch = pathname.match(
      /^\/api\/multi-agent\/artifacts\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/
    );
    if (req.method === "GET" && artifactMatch) {
      const artifact = typeof readArtifact === "function"
        ? await readArtifact(artifactMatch[1], artifactMatch[2])
        : null;
      if (!artifact) throw httpError(404, "multi-agent artifact not found");
      assertArtifactWorkspace(
        artifact,
        normalizedRequestWorkspaceId(req, workspaceIdForRequest),
        "multi-agent artifact"
      );
      return { status: 200, body: { artifact: sanitize(artifact) } };
    }

    if (req.method === "POST" && pathname === "/api/multi-agent/evidence/snapshot") {
      requireAdvisoryEnabled();
      return idempotentMutation(req, pathname, async (body, key) => {
        assertNoClientAuthorityFields(body, [
          "workspaceId", "provenance", "verified", "contentHash", "sha256", "evidence",
        ], "workspace evidence snapshot");
        const producer = requireDependency(createWorkspaceEvidence, "createWorkspaceEvidence");
        const workspaceId = normalizedRequestWorkspaceId(req, workspaceIdForRequest);
        const snapshot = await producer({ paths: body.paths }, { workspaceId });
        if (!snapshot || !Array.isArray(snapshot.evidence) || snapshot.evidence.length === 0) {
          throw httpError(409, "workspace evidence snapshot produced no verified evidence");
        }
        const id = artifactId("workspace-evidence", `${workspaceId}:${key}`);
        const record = withRecordContentHash({
          schemaVersion: 1,
          kind: "workspace_evidence_snapshot",
          workspaceId,
          files: Array.isArray(snapshot.files) ? snapshot.files : [],
          evidence: snapshot.evidence,
          capturedAt: clock(),
          authority: {
            createdBy: "server",
            clientMaySetProvenance: false,
            mutatesSourceFiles: false,
            grantsApproval: false,
          },
        });
        const artifact = await writeIndependentArtifact("workspace-evidence", id, record);
        return { status: 201, body: { evidenceArtifactId: id, artifact, evidence: record.evidence } };
      });
    }

    if (req.method === "POST" && pathname === "/api/multi-agent/content-strategy/analyze") {
      requireAdvisoryEnabled();
      return idempotentMutation(req, pathname, async (body, key) => {
        assertNoClientAuthorityFields(body, [
          "script", "fullScript", "draft", "titles", "hooks", "shotList", "editPlan",
          "userConfirmation", "approved", "publish", "memoryPromotion", "replacementDirection",
        ], "content strategy analysis");
        let input;
        let request;
        let knowledge;
        try {
          const evidence = [
            ...clientProvidedEvidence(body.evidence),
            ...await verifiedWorkspaceEvidence(body, req),
          ];
          input = buildContentStrategistInput({
            direction: body.direction,
            directionSource: "user",
            audienceContext: body.audienceContext,
            userFacts: body.userFacts,
            evidence,
            constraints: body.constraints,
            interviewAnswers: body.interviewAnswers,
          });
        } catch (error) {
          throw validationError(error);
        }
        knowledge = await resolveContentKnowledge(body.knowledgeContext, input);
        try {
          request = buildContentStrategistAnalysisRequest(input, { principles: knowledge.principles });
        } catch (error) {
          throw validationError(error);
        }
        const rawAnalysis = await runContentStrategist(input, request, knowledge.principles);
        let analysis;
        try {
          analysis = normalizeContentStrategistOutput(
            rawAnalysis,
            input,
            { principles: knowledge.principles }
          );
        } catch (error) {
          throw httpError(502, `content strategist returned invalid output: ${error.message}`);
        }
        const workspaceId = normalizedRequestWorkspaceId(req, workspaceIdForRequest);
        const id = artifactId("content-strategy", `${workspaceId}:${key}`);
        const record = withRecordContentHash({
          schemaVersion: 1,
          kind: "content_strategy_analysis",
          workspaceId,
          input,
          analysis,
          principleIds: request.candidatePrinciples.map(item => item.id),
          knowledgeContext: knowledge.audit,
          analyzedAt: clock(),
          authority: {
            directionOwner: "user",
            strategistMayDraft: false,
            mutatesContent: false,
            mutatesJob: false,
            grantsApproval: false,
            publishes: false,
            promotesMemory: false,
          },
        });
        const artifact = await writeIndependentArtifact("content-strategy-analyses", id, record);
        return { status: 201, body: { analysisArtifactId: id, analysis, knowledgeContext: knowledge.audit, artifact } };
      });
    }

    if (req.method === "POST" && pathname === "/api/multi-agent/content-strategy/evaluate-ab") {
      requireAdvisoryEnabled();
      return idempotentMutation(req, pathname, async (body, key) => {
        assertNoClientAuthorityFields(body, [
          "winner", "scores", "approved", "publish", "memoryPromotion", "productionApproval",
        ], "content strategy A/B evaluation");
        const leftAnalysisArtifactId = String(body.leftAnalysisArtifactId || "").trim();
        const rightAnalysisArtifactId = String(body.rightAnalysisArtifactId || "").trim();
        if (!leftAnalysisArtifactId || !rightAnalysisArtifactId) {
          throw httpError(400, "leftAnalysisArtifactId and rightAnalysisArtifactId are required");
        }
        if (leftAnalysisArtifactId === rightAnalysisArtifactId) {
          throw httpError(400, "A/B evaluation requires two distinct analysis artifacts");
        }
        if (typeof contentTrainingEvaluator?.evaluate !== "function") {
          throw httpError(503, "content training evaluator is not configured");
        }
        const artifactReader = requireDependency(readArtifact, "readArtifact");
        const [left, right] = await Promise.all([
          artifactReader("content-strategy-analyses", leftAnalysisArtifactId),
          artifactReader("content-strategy-analyses", rightAnalysisArtifactId),
        ]);
        if (!left || !right) throw httpError(404, "content strategy analysis artifact not found");
        const workspaceId = normalizedRequestWorkspaceId(req, workspaceIdForRequest);
        assertArtifactWorkspace(left, workspaceId, "left content strategy analysis artifact");
        assertArtifactWorkspace(right, workspaceId, "right content strategy analysis artifact");
        const leftContentHash = assertRecordContentHash(left, "left content strategy analysis");
        const rightContentHash = assertRecordContentHash(right, "right content strategy analysis");
        if (left.input?.lockedDirection !== right.input?.lockedDirection) {
          throw httpError(409, "A/B analyses use different locked directions");
        }
        const variantFor = record => {
          const source = record.knowledgeContext?.source;
          if (source === "none") return "control";
          if (source === "creator-vault" && record.knowledgeContext?.includeTrial === true) return "trial";
          throw httpError(409, "A/B analyses must contain one explicit control and one Creator Vault trial variant");
        };
        const leftVariant = variantFor(left);
        const rightVariant = variantFor(right);
        if (leftVariant === rightVariant) throw httpError(409, "A/B analyses must use different knowledge variants");
        const evaluation = await contentTrainingEvaluator.evaluate(left, right);
        const sourceRecord = { left, right };
        const sourceVariant = { left: leftVariant, right: rightVariant };
        const positionSource = evaluation.privateMapping;
        const scoresByVariant = {};
        for (const position of ["first", "second"]) {
          const source = positionSource[position];
          scoresByVariant[sourceVariant[source]] = structuredClone(evaluation.candidates[position]);
        }
        const winnerVariant = ["left", "right"].includes(evaluation.winnerSource)
          ? sourceVariant[evaluation.winnerSource]
          : evaluation.winnerSource;
        const trialSource = leftVariant === "trial" ? "left" : "right";
        const controlSource = leftVariant === "control" ? "left" : "right";
        const trialRecord = sourceRecord[trialSource];
        const retrieved = new Map((trialRecord.knowledgeContext?.records || []).map(item => [item.id, item]));
        const citations = trialRecord.analysis?.principleCitations || [];
        const correctCitations = citations.filter(item => retrieved.has(item.principleId)).length;
        const citationAccuracy = citations.length > 0 ? correctCitations / citations.length : 0;
        const citationAudit = {
          retrievedCount: retrieved.size,
          citedCount: citations.length,
          correctCitations,
          accuracy: Number(citationAccuracy.toFixed(4)),
          controlCitationCount: (sourceRecord[controlSource].analysis?.principleCitations || []).length,
          vaultHashesValid: [...retrieved.values()].every(item => /^[a-f0-9]{64}$/u.test(String(item.contentHash || ""))),
        };
        const id = artifactId("content-training-evaluation", `${workspaceId}:${key}`);
        const record = withRecordContentHash({
          schemaVersion: 1,
          kind: "content_strategy_training_ab_evaluation",
          workspaceId,
          lockedDirection: left.input.lockedDirection,
          analyses: {
            left: { artifactId: leftAnalysisArtifactId, contentHash: leftContentHash, variant: leftVariant },
            right: { artifactId: rightAnalysisArtifactId, contentHash: rightContentHash, variant: rightVariant },
          },
          blindEvaluation: {
            rubricId: evaluation.rubricId,
            dimensions: evaluation.dimensions,
            scoresByVariant,
            comparativeFindings: evaluation.comparativeFindings,
            uncertainties: evaluation.uncertainties,
            winnerVariant,
          },
          citationAudit,
          evaluatedAt: clock(),
          authority: {
            grantsApproval: false,
            publishes: false,
            promotesMemory: false,
            changesProductionDefault: false,
          },
        });
        const artifact = await writeIndependentArtifact("content-training-evaluations", id, record);
        return { status: 201, body: { evaluationArtifactId: id, evaluation: record, artifact } };
      });
    }

    if (req.method === "POST" && pathname === "/api/multi-agent/content-strategy/confirm") {
      requireAdvisoryEnabled();
      return idempotentMutation(req, pathname, async (body, key) => {
        assertNoClientAuthorityFields(body, [
          "lockedDirection", "approvedDirection", "scriptHandoffAllowed", "script", "publish",
          "productionApproval", "memoryPromotion",
        ], "content strategy confirmation");
        const actor = body.actor;
        if (!actor || actor.type !== "human" || !String(actor.id || "").trim()) {
          throw httpError(409, "content strategy confirmation requires a human actor");
        }
        const decision = String(body.decision || "").trim();
        if (!new Set(["approved", "rejected"]).has(decision)) {
          throw httpError(400, "decision must be approved or rejected");
        }
        const analysisArtifactId = String(body.analysisArtifactId || "").trim();
        if (!analysisArtifactId) throw httpError(400, "analysisArtifactId is required");
        const artifactReader = requireDependency(readArtifact, "readArtifact");
        const source = await artifactReader("content-strategy-analyses", analysisArtifactId);
        if (!source) throw httpError(404, "content strategy analysis artifact not found");
        if (!source.input || !source.analysis) throw httpError(409, "content strategy analysis artifact is incomplete");
        const workspaceId = normalizedRequestWorkspaceId(req, workspaceIdForRequest);
        assertArtifactWorkspace(source, workspaceId, "content strategy analysis artifact");
        const analysisContentHash = assertRecordContentHash(source, "content strategy analysis");

        const confirmedInput = structuredClone(source.input);
        confirmedInput.userConfirmation = {
          analysisApproved: decision === "approved",
          confirmedDirection: decision === "approved" ? source.input.lockedDirection : null,
        };
        const scriptHandoffAllowed = decision === "approved"
          && canEnterScriptStage(confirmedInput, source.analysis);
        const approvedDirection = {
          audience: source.analysis.audience,
          viewerBenefit: source.analysis.viewerBenefit,
          coreQuestion: source.analysis.testableQuestion,
          constraints: source.input.constraints || [],
        };
        const id = artifactId("content-strategy-confirmation", `${workspaceId}:${key}`);
        const record = withRecordContentHash({
          schemaVersion: 1,
          kind: "content_strategy_human_confirmation",
          workspaceId,
          analysisArtifactId,
          analysisContentHash,
          lockedDirection: source.input.lockedDirection,
          approvedDirection,
          decision,
          actor: { type: "human", id: String(actor.id).trim() },
          note: String(body.note || "").trim(),
          confirmedAt: clock(),
          scriptHandoffAllowed,
          authority: {
            confirmsAnalysisOnly: true,
            strategistMayDraft: false,
            mutatesContent: false,
            mutatesJob: false,
            grantsPublishApproval: false,
            promotesMemory: false,
          },
        });
        const artifact = await writeIndependentArtifact("content-strategy-confirmations", id, record);
        return { status: 201, body: { confirmationArtifactId: id, confirmation: record, artifact } };
      });
    }

    const memoryMatch = pathname.match(
      /^\/api\/multi-agent\/memory\/([^/]+)\/([^/]+)\/(extract|recreate|trial|approve|promote|reject|expire|disable|rollback)$/
    );
    if (req.method === "POST" && memoryMatch) {
      requireEnabled();
      const [, kind, id, action] = memoryMatch;
      return idempotentMutation(req, pathname, async body => {
        const delegatedTrial = action === "trial"
          && body.actor?.type === "controller"
          && Array.isArray(body.evidence)
          && body.evidence.some(item => item?.type === "technical-trial-admission");
        if (["approve", "promote"].includes(action) && body.actor?.type !== "human") {
          throw httpError(409, `${action} requires a human actor`);
        }
        if (action === "trial" && body.actor?.type !== "human" && !delegatedTrial) {
          throw httpError(409, "trial requires a human actor or delegated technical admission");
        }
        let result;
        if (action === "rollback") {
          if (!String(body.transitionId || "").trim()) throw httpError(400, "transitionId is required");
          result = memory.rollback(body.transitionId);
        } else if (action === "reject") {
          result = memory.reject({
            kind,
            id,
            actor: body.actor,
            evidence: body.evidence || [],
            expectedHash: body.expectedHash,
          });
        } else if (action === "expire") {
          result = memory.expire({
            kind,
            id,
            actor: body.actor,
            evidence: body.evidence || [],
            expectedHash: body.expectedHash,
          });
        } else {
          const status = {
            extract: "extracted",
            recreate: "recreated",
            trial: "trial",
            approve: "approved",
            promote: "promoted",
            disable: "disabled",
          }[action];
          result = memory.transition({
            kind,
            id,
            to: status,
            actor: body.actor,
            evidence: body.evidence || [],
            expectedHash: body.expectedHash,
          });
        }
        return { status: 200, body: { transition: result } };
      });
    }

    if (req.method === "POST" && pathname === "/api/multi-agent/tutorials") {
      requireEnabled();
      return idempotentMutation(req, pathname, async body => {
        if (!isWithinRoot(body.inputPath, allowedTutorialRoots)) {
          throw httpError(403, "tutorial path is outside configured local roots");
        }
        if (!String(body.author || "").trim() || !String(body.license || "").trim()) {
          throw httpError(400, "tutorial author and license are required");
        }
        const checkpoint = await tutorials.ingest({
          inputPath: path.resolve(body.inputPath),
          author: String(body.author),
          license: String(body.license),
          resume: body.resume !== false,
        });
        return { status: 202, body: { tutorial: checkpoint } };
      });
    }

    const tutorialMatch = pathname.match(/^\/api\/multi-agent\/tutorials\/([^/]+)$/);
    if (req.method === "GET" && tutorialMatch) {
      const tutorial = await tutorials.get(tutorialMatch[1]);
      if (!tutorial) throw httpError(404, "tutorial checkpoint not found");
      return { status: 200, body: { tutorial } };
    }

    const contentOrdinaryReviewMatch = pathname.match(
      /^\/api\/contents\/([A-Za-z0-9._-]+)\/multi-agent\/ordinary-review$/
    );
    if (req.method === "POST" && contentOrdinaryReviewMatch) {
      requireAdvisoryEnabled();
      return idempotentMutation(req, pathname, async (body, key) => {
        assertNoClientAuthorityFields(body, [
          "script", "fullScript", "shortScript", "fullSegments", "candidate", "content",
          "facts", "factSheet", "evidence", "approvedDirection", "review", "publish",
          "productionApproval", "memoryPromotion",
        ], "content ordinary review");
        const contentId = contentOrdinaryReviewMatch[1];
        const reader = requireDependency(readContent, "readContent");
        const loaded = await reader(contentId);
        if (!loaded) throw httpError(404, "content not found");
        const content = structuredClone(loaded);
        const variant = String(body.variant || "full").trim();
        let script;
        try {
          script = contentScript(content, variant);
        } catch (error) {
          throw validationError(error);
        }
        const expectedScriptSha256 = String(body.expectedScriptSha256 || "").trim().toLowerCase();
        if (!expectedScriptSha256) throw httpError(400, "expectedScriptSha256 is required");
        if (!/^[a-f0-9]{64}$/u.test(expectedScriptSha256)) {
          throw httpError(400, "expectedScriptSha256 must be a SHA-256 hex digest");
        }
        const scriptSha256 = sha256Text(script);
        if (expectedScriptSha256 !== scriptSha256) {
          throw httpError(409, "expected script SHA-256 does not match authoritative content");
        }
        const strategy = await confirmedContentStrategy(
          content,
          body.directionConfirmationArtifactId
        );
        const input = {
          approvedDirection: strategy.approvedDirection,
          facts: contentFacts(content, contentId),
          script,
        };
        const review = await runOrdinaryReview(input, { stage: "script" });
        const id = artifactId(`content-${contentId}-ordinary-review`, key);
        const record = withRecordContentHash({
          schemaVersion: 1,
          kind: "ordinary_viewer_review",
          stage: "script",
          inspectionMode: "script_text",
          variant,
          scriptSha256,
          strategyAnalysisArtifactId: strategy.strategyAnalysisArtifactId,
          strategyConfirmationArtifactId: strategy.strategyConfirmationArtifactId,
          analysisContentHash: strategy.analysisContentHash,
          confirmationContentHash: strategy.confirmationContentHash,
          subject: { type: "content", id: contentId, source: "authoritative_readContent" },
          approvedDirection: strategy.approvedDirection,
          evidenceSourceIds: input.facts.map(item => item.sourceId),
          review,
          reviewedAt: clock(),
          authority: {
            mutatesContent: false,
            mutatesJob: false,
            grantsApproval: false,
            publishes: false,
            promotesMemory: false,
          },
        });
        const artifact = await writeIndependentArtifact("ordinary-viewer-reviews", id, record);
        return {
          status: 201,
          body: {
            reviewArtifactId: id,
            review,
            inspectionMode: record.inspectionMode,
            variant,
            scriptSha256,
            strategyAnalysisArtifactId: strategy.strategyAnalysisArtifactId,
            strategyConfirmationArtifactId: strategy.strategyConfirmationArtifactId,
            artifact,
          },
        };
      });
    }

    const jobOrdinaryReviewMatch = pathname.match(
      /^\/api\/jobs\/([A-Za-z0-9._-]+)\/multi-agent\/ordinary-review$/
    );
    if (req.method === "POST" && jobOrdinaryReviewMatch) {
      requireAdvisoryEnabled();
      return idempotentMutation(req, pathname, async (body, key) => {
        assertNoClientAuthorityFields(body, [
          "script", "transcript", "media", "render", "frameEvidence", "candidate", "job",
          "facts", "factSheet", "evidence", "approvedDirection", "review", "publish",
          "productionApproval", "memoryPromotion",
        ], "job ordinary review");
        const jobId = jobOrdinaryReviewMatch[1];
        const reader = requireDependency(readJob, "readJob");
        const loaded = await reader(jobId);
        if (!loaded) throw httpError(404, "job not found");
        const job = structuredClone(loaded);
        if (!Number.isInteger(Number(job.output?.version)) || !String(job.output?.path || "").trim()) {
          throw httpError(409, "job has no immutable rendered output version");
        }
        if (typeof ordinaryViewerCritic?.review !== "function") {
          throw httpError(503, "ordinary viewer critic is not configured");
        }
        let directionRecord = {
          ...job,
          ...job.contentDirection,
        };
        if (job.contentId && typeof readContent === "function") {
          const linkedContent = await readContent(String(job.contentId));
          if (linkedContent) directionRecord = structuredClone(linkedContent);
        }
        const approvedDirection = await confirmedDirection(
          body.directionConfirmationArtifactId,
          { ...directionRecord },
          { expectedLockedDirection: lockedDirectionFromRecord(directionRecord) }
        );
        const audit = await auditRenderedJobOrdinaryViewer({
          job,
          approvedDirection,
          critic: ordinaryViewerCritic,
          writeArtifact: async (kind, id, value) => writeIndependentArtifact(kind, id, value),
          readArtifact,
          allowedRoots: allowedRenderedRoots,
          trigger: "manual_api",
          attemptKey: `manual:${key}`,
          clock,
        });
        return {
          status: 201,
          body: {
            reviewArtifactId: audit.artifactId,
            status: audit.artifact.status,
            review: audit.artifact.review,
            error: audit.artifact.error,
            inspectionMode: audit.artifact.inspectionMode,
            outputVersion: audit.artifact.outputVersion,
            mediaSha256: audit.artifact.mediaSha256,
            transcriptSha256: audit.artifact.transcriptSha256,
            artifact: audit.artifactHref,
          },
        };
      });
    }

    const proposalMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/multi-agent\/proposals$/);
    if (req.method === "POST" && proposalMatch) {
      requireEnabled();
      return idempotentMutation(req, pathname, async (body, key) => {
        const job = structuredClone(await readJob(proposalMatch[1]));
        const input = jobProposalInput(job);
        const proposalBundle = await orchestrator.propose({
          ...input,
          constraints: sanitize(body.constraints || {}),
        });
        const directed = await orchestrator.direct(proposalBundle.proposals, {
          jobId: job.id,
          v4Plan: input.v4Plan,
        });
        const bundle = {
          ...proposalBundle,
          candidates: directed.candidates,
          conflicts: directed.conflicts || [],
          directorFallback: directed.fallback || null,
        };
        const artifactId = `${job.id}.${crypto.createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
        const artifact = await writeArtifact("proposals", artifactId, bundle);
        return { status: 202, body: { bundle, artifact } };
      });
    }

    const abMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/multi-agent\/ab$/);
    if (req.method === "POST" && abMatch) {
      requireEnabled();
      return idempotentMutation(req, pathname, async (body, key) => {
        if (!Array.isArray(body.candidates) || body.candidates.length < 2) {
          throw httpError(400, "at least two candidates are required");
        }
        await readJob(abMatch[1]);
        const bundle = buildBlindReviewBundle(body.candidates, {
          baselineId: body.baselineId || "koubo-v4-baseline-v1",
          jobId: abMatch[1],
        });
        const artifactId = `${abMatch[1]}.${crypto.createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
        const artifact = await writeArtifact("blind-bundles", artifactId, bundle);
        return { status: 201, body: { bundle, artifact } };
      });
    }

    const reviewMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/multi-agent\/reviews$/);
    if (req.method === "POST" && reviewMatch) {
      requireEnabled();
      return idempotentMutation(req, pathname, async (body, key) => {
        if (!body.candidate || typeof body.candidate !== "object") {
          throw httpError(400, "candidate is required");
        }
        await readJob(reviewMatch[1]);
        const blind = await orchestrator.criticize(body.candidate, {
          blind: true,
          jobId: reviewMatch[1],
        });
        const retention = await orchestrator.retentionAudit(body.candidate, {
          jobId: reviewMatch[1],
        });
        const reviews = { blind, retention, reviewedAt: clock() };
        const artifactId = `${reviewMatch[1]}.${crypto.createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
        const artifact = await writeArtifact("reviews", artifactId, reviews);
        return { status: 201, body: { reviews, artifact } };
      });
    }

    throw httpError(404, "unknown multi-agent route");
  }

  async function handle(req, res, url) {
    let result;
    try {
      result = await handleRoute(req, url);
      if (result === null) return false;
      sendJson(res, result.status, result.body, { replayed: result.replayed });
      return true;
    } catch (error) {
      const pathname = decodeURIComponent(url.pathname);
      if (!isMultiAgentPath(pathname)) return false;
      sendJson(res, error.statusCode || 500, { error: errorMessage(error) });
      return true;
    }
  }

  return { handle };
}
