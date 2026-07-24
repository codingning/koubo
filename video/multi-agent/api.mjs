import crypto from "node:crypto";
import path from "node:path";
import { canonicalJson } from "./contracts.mjs";

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

function errorMessage(error) {
  return String(error?.message || error || "request failed")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<local-path>")
    .replace(/(?:sk|gsk|ghp|github_pat)_[A-Za-z0-9_-]{8,}/g, "<redacted>")
    .slice(0, 500);
}

export function createMultiAgentApi({
  enabled = false,
  defaultPipeline = "visual-director-v4",
  allowedTutorialRoots = [],
  readJob,
  writeArtifact,
  readArtifact,
  listMemory,
  memory,
  tutorials,
  orchestrator,
  buildBlindReviewBundle,
  clock = () => new Date().toISOString(),
} = {}) {
  const idempotency = new Map();

  function requireEnabled() {
    if (!enabled) throw httpError(409, "controlled multi-agent workflow is disabled");
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

  async function handleRoute(req, url) {
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith("/api/multi-agent/")
      && !/^\/api\/jobs\/[^/]+\/multi-agent\//.test(pathname)) {
      return null;
    }
    if (!isLoopback(req.socket?.remoteAddress)) throw httpError(403, "multi-agent API is local-only");

    if (req.method === "GET" && pathname === "/api/multi-agent/status") {
      return {
        status: 200,
        body: {
          enabled,
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

    const memoryMatch = pathname.match(
      /^\/api\/multi-agent\/memory\/([^/]+)\/([^/]+)\/(extract|recreate|trial|approve|promote|reject|expire|disable|rollback)$/
    );
    if (req.method === "POST" && memoryMatch) {
      requireEnabled();
      const [, kind, id, action] = memoryMatch;
      return idempotentMutation(req, pathname, async body => {
        if (["approve", "promote"].includes(action) && body.actor?.type !== "human") {
          throw httpError(409, `${action} requires a human actor`);
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
      if (!pathname.startsWith("/api/multi-agent/")
        && !/^\/api\/jobs\/[^/]+\/multi-agent\//.test(pathname)) {
        return false;
      }
      sendJson(res, error.statusCode || 500, { error: errorMessage(error) });
      return true;
    }
  }

  return { handle };
}
