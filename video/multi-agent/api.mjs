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
  memory,
  tutorials,
  orchestrator,
  contentStrategist,
  contentPrinciples = [],
  ordinaryViewerCritic,
  buildBlindReviewBundle,
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
    const cacheKey = `${req.method}:${pathname}:${key}`;
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

  async function runContentStrategist(input, request) {
    if (typeof contentStrategist === "function") {
      return normalizedAgentResult(await contentStrategist(input, { request }), "content strategist");
    }
    if (typeof contentStrategist?.analyze === "function") {
      return normalizedAgentResult(await contentStrategist.analyze(input, { request }), "content strategist");
    }
    throw httpError(503, "content strategist is not configured");
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

    const artifactMatch = pathname.match(
      /^\/api\/multi-agent\/artifacts\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/
    );
    if (req.method === "GET" && artifactMatch) {
      const artifact = typeof readArtifact === "function"
        ? await readArtifact(artifactMatch[1], artifactMatch[2])
        : null;
      if (!artifact) throw httpError(404, "multi-agent artifact not found");
      return { status: 200, body: { artifact: sanitize(artifact) } };
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
        try {
          input = buildContentStrategistInput({
            direction: body.direction,
            directionSource: "user",
            audienceContext: body.audienceContext,
            userFacts: body.userFacts,
            evidence: body.evidence,
            constraints: body.constraints,
            interviewAnswers: body.interviewAnswers,
          });
          request = buildContentStrategistAnalysisRequest(input, { principles: contentPrinciples });
        } catch (error) {
          throw validationError(error);
        }
        const rawAnalysis = await runContentStrategist(input, request);
        let analysis;
        try {
          analysis = normalizeContentStrategistOutput(
            rawAnalysis,
            input,
            { principles: contentPrinciples }
          );
        } catch (error) {
          throw httpError(502, `content strategist returned invalid output: ${error.message}`);
        }
        const id = artifactId("content-strategy", key);
        const record = withRecordContentHash({
          schemaVersion: 1,
          kind: "content_strategy_analysis",
          input,
          analysis,
          principleIds: request.candidatePrinciples.map(item => item.id),
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
        return { status: 201, body: { analysisArtifactId: id, analysis, artifact } };
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
        const id = artifactId("content-strategy-confirmation", key);
        const record = withRecordContentHash({
          schemaVersion: 1,
          kind: "content_strategy_human_confirmation",
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
        const approvedDirection = await confirmedDirection(
          body.directionConfirmationArtifactId,
          content,
          { expectedLockedDirection: lockedDirectionFromRecord(content) }
        );
        const input = {
          approvedDirection,
          facts: contentFacts(content, contentId),
          script: contentScript(content, String(body.variant || "full")),
        };
        const review = await runOrdinaryReview(input, { stage: "script" });
        const id = artifactId(`content-${contentId}-ordinary-review`, key);
        const record = {
          schemaVersion: 1,
          kind: "ordinary_viewer_review",
          stage: "script",
          inspectionMode: "script_text",
          subject: { type: "content", id: contentId, source: "authoritative_readContent" },
          approvedDirection,
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
        };
        const artifact = await writeIndependentArtifact("ordinary-viewer-reviews", id, record);
        return { status: 201, body: { reviewArtifactId: id, review, inspectionMode: record.inspectionMode, artifact } };
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
