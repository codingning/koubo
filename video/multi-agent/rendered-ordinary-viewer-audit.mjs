import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { canonicalJson, contentHash } from "./contracts.mjs";

export const RENDERED_ORDINARY_VIEWER_ARTIFACT_KIND = "ordinary-viewer-reviews";

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw httpError(409, `${label} is required`);
  return text;
}

function roundSeconds(value) {
  return Number(Number(value).toFixed(6));
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeToken(value, maxLength = 48) {
  const source = String(value || "job");
  const readable = source.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_").slice(0, maxLength) || "job";
  return `${readable}-${hashText(source).slice(0, 8)}`;
}

function opaqueJobId(value) {
  return String(value || "job").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "job";
}

function redactLocalPathsInString(value) {
  return String(value)
    .replace(/(?<![A-Za-z0-9+.-])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+/gu, "<local-path>")
    .replace(/(^|[\s("'=])\/(?!\/)[^\s"'<>]*/gu, (_match, prefix) => `${prefix}<local-path>`)
    .replace(/(?:sk|gsk|ghp|github_pat)_[A-Za-z0-9_-]{8,}/gu, "<redacted>");
}

export function redactRenderedAuditValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactLocalPathsInString(value);
  if (value === null || ["number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(item => redactRenderedAuditValue(item, seen));
  if (!value || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const safe = redactRenderedAuditValue(item, seen);
    if (safe !== undefined) output[key] = safe;
  }
  seen.delete(value);
  return output;
}

function opaqueSourceId(value, fallback) {
  const source = String(value || fallback || "source").trim();
  if (!source) return String(fallback || "source");
  if (/^[A-Za-z]:[\\/]|^\\\\|^\//u.test(source)) return `source-${hashText(source).slice(0, 16)}`;
  return redactLocalPathsInString(source);
}

function traceableFacts(items, prefix) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const value = item && typeof item === "object" && !Array.isArray(item) ? item : { claim: item };
    const fact = {
      sourceId: opaqueSourceId(value.sourceId || value.id, `${prefix}.${index + 1}`),
      provenance: redactLocalPathsInString(String(value.provenance || "authoritative_server_record")),
    };
    const claim = String(value.claim || value.summary || value.text || value.evidence || "").trim();
    if (claim) fact.claim = redactLocalPathsInString(claim);
    for (const key of ["kind", "status", "uncertainty"]) {
      const text = String(value[key] || "").trim();
      if (text) fact[key] = redactLocalPathsInString(text);
    }
    if (Number.isFinite(value.start) && Number.isFinite(value.end) && value.start >= 0 && value.end > value.start) {
      fact.start = Number(value.start);
      fact.end = Number(value.end);
    }
    return fact;
  });
}

export function renderedJobFacts(job = {}) {
  const explicit = traceableFacts(job.evidence || [], `job.${job.id || "unknown"}.evidence`);
  const assets = traceableFacts(
    (job.assets || []).filter(item => item.approved === true || item.status === "approved" || item.reviewStatus === "approved").map(item => ({
      sourceId: item.id,
      kind: item.mediaKind || item.kind || "approved_asset",
      claim: item.summary || item.purpose || "已批准进入任务的证据素材",
      status: "approved",
    })),
    `job.${job.id || "unknown"}.asset`
  );
  return [...explicit, ...assets];
}

export function approvedDirectionFromRenderedJob(job = {}) {
  const record = { ...job, ...(job.contentDirection || {}) };
  const approved = record.approvedDirection || job.contentDirection?.approvedDirection || {};
  const audience = String(
    approved.audience
      || record.audience
      || record.targetAudience
      || record.engagement?.audienceMirror
      || ""
  ).trim();
  const viewerBenefit = String(
    approved.viewerBenefit
      || record.viewerBenefit
      || record.audienceBenefit
      || ""
  ).trim();
  const coreQuestion = String(
    approved.coreQuestion
      || record.coreQuestion
      || record.structureDesign?.coreQuestion
      || record.mainTopic
      || ""
  ).trim();
  if (!audience || !viewerBenefit || !coreQuestion) {
    throw httpError(409, "rendered job is missing audience, viewer benefit, or core question");
  }
  const constraints = Array.isArray(approved.constraints)
    ? approved.constraints.map(String).map(item => item.trim()).filter(Boolean)
    : [];
  const lockedDirection = String(record.lockedDirection || "").trim();
  if (lockedDirection && !constraints.some(item => item.includes(lockedDirection))) {
    constraints.push(`lockedDirection: ${lockedDirection}`);
  }
  return redactRenderedAuditValue({ audience, viewerBenefit, coreQuestion, constraints });
}

function transcriptSource(job, override) {
  if (Array.isArray(override)) return override;
  if (Array.isArray(job.ordinaryViewerTranscript)) return job.ordinaryViewerTranscript;
  if (Array.isArray(job.outputTranscript)) return job.outputTranscript;
  if (Array.isArray(job.output?.transcript)) return job.output.transcript;
  if (Array.isArray(job.transcript?.segments)) return job.transcript.segments;
  return [];
}

export function finalRenderedTranscript(job, durationSeconds, override) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) throw httpError(409, "rendered output duration is invalid");
  return transcriptSource(job, override).map(item => {
    const start = Math.max(0, Number(item?.start));
    const end = Math.min(duration, Number(item?.end));
    const text = redactLocalPathsInString(String(item?.text || "").trim());
    return {
      start: roundSeconds(start),
      end: roundSeconds(end),
      text,
    };
  }).filter(item => item.text
    && Number.isFinite(item.start)
    && Number.isFinite(item.end)
    && item.start < duration
    && item.end > item.start
    && item.end <= duration);
}

function renderedFrameEvidence(job, durationSeconds) {
  const source = [
    ...(Array.isArray(job.frameEvidence) ? job.frameEvidence : []),
    ...(Array.isArray(job.output?.frameEvidence) ? job.output.frameEvidence : []),
  ];
  return source
    .filter(item => item?.reviewed === true || item?.status === "approved" || item?.provenance === "vision_verified")
    .map(item => ({
      artifactId: String(item.artifactId || "").trim(),
      sourceId: opaqueSourceId(item.sourceId || item.artifactId, "frame-evidence"),
      start: roundSeconds(Number(item.start)),
      end: roundSeconds(Number(item.end)),
      observation: redactLocalPathsInString(String(item.observation || "").trim()),
      provenance: redactLocalPathsInString(String(item.provenance || "vision_verified").trim()),
    }))
    .filter(item => /^(?:frame|contact-sheet|vision):[A-Za-z0-9._/-]+$/u.test(item.artifactId)
      && !/^(?:frame|contact-sheet|vision):\//u.test(item.artifactId)
      && item.sourceId
      && item.observation
      && Number.isFinite(item.start)
      && Number.isFinite(item.end)
      && item.start >= 0
      && item.end > item.start
      && item.end <= durationSeconds + 0.001);
}

async function resolvedOutputFile(file, allowedRoots) {
  const requested = requiredText(file, "job.output.path");
  if (!path.isAbsolute(requested)) throw httpError(409, "job.output.path must identify an absolute rendered file");
  let resolved;
  try {
    resolved = await fsp.realpath(requested);
  } catch {
    throw httpError(409, "rendered output file does not exist");
  }
  const roots = Array.isArray(allowedRoots) ? allowedRoots.filter(Boolean) : [];
  if (roots.length) {
    let allowed = false;
    for (const root of roots) {
      let resolvedRoot;
      try { resolvedRoot = await fsp.realpath(path.resolve(root)); } catch { continue; }
      const relative = path.relative(resolvedRoot, resolved);
      if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        allowed = true;
        break;
      }
    }
    if (!allowed) throw httpError(409, "rendered output file is outside the configured job roots");
  }
  const stat = await fsp.stat(resolved);
  if (!stat.isFile() || stat.size <= 0) throw httpError(409, "rendered output file is empty or invalid");
  return { path: resolved, sizeBytes: stat.size };
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export function renderedOrdinaryViewerArtifactId({
  jobId,
  outputVersion,
  mediaSha256,
  transcriptSha256,
  attemptKey = "automatic",
}) {
  return `job-${safeToken(jobId)}.v${Number(outputVersion)}.${String(mediaSha256).slice(0, 16)}.${String(transcriptSha256).slice(0, 16)}.${hashText(attemptKey).slice(0, 12)}`;
}

function artifactHref(kind, id) {
  return `/api/multi-agent/artifacts/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

function withContentHash(record) {
  return { ...record, contentHash: contentHash(record) };
}

function assertExistingIdentity(existing, expected) {
  if (Number(existing?.outputVersion) !== expected.outputVersion
    || existing?.mediaSha256 !== expected.mediaSha256
    || existing?.transcriptSha256 !== expected.transcriptSha256) {
    throw httpError(409, "ordinary viewer artifact id is bound to different immutable render evidence");
  }
}

export async function auditRenderedJobOrdinaryViewer({
  job,
  transcript,
  approvedDirection,
  facts,
  critic,
  writeArtifact,
  readArtifact,
  allowedRoots = [],
  trigger = "automatic",
  attemptKey = trigger,
  clock = () => new Date().toISOString(),
  artifactKind = RENDERED_ORDINARY_VIEWER_ARTIFACT_KIND,
} = {}) {
  if (!job || typeof job !== "object" || Array.isArray(job)) throw httpError(409, "rendered job is required");
  const outputVersion = Number(job.output?.version);
  if (!Number.isInteger(outputVersion) || outputVersion <= 0) {
    throw httpError(409, "job has no immutable rendered output version");
  }
  const outputFile = await resolvedOutputFile(job.output?.path, allowedRoots);
  const durationSeconds = Number(job.output?.metadata?.duration ?? job.output?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw httpError(409, "job rendered output has no authoritative duration");
  }
  const finalTranscript = finalRenderedTranscript(job, durationSeconds, transcript);
  if (!finalTranscript.length) throw httpError(409, "job has no mapped final transcript for ordinary review");
  const mediaSha256 = await sha256File(outputFile.path);
  const transcriptSha256 = hashText(canonicalJson(finalTranscript));
  const id = renderedOrdinaryViewerArtifactId({
    jobId: job.id,
    outputVersion,
    mediaSha256,
    transcriptSha256,
    attemptKey,
  });
  const expectedIdentity = { outputVersion, mediaSha256, transcriptSha256 };
  if (typeof readArtifact === "function") {
    const existing = await readArtifact(artifactKind, id);
    if (existing) {
      assertExistingIdentity(existing, expectedIdentity);
      return {
        artifactId: id,
        artifactHref: artifactHref(artifactKind, id),
        artifact: existing,
        replayed: true,
      };
    }
  }

  const frameEvidence = renderedFrameEvidence(job, durationSeconds);
  const inspectionMode = frameEvidence.length
    ? "sampled_frames_and_transcript"
    : "transcript_and_metadata_only";
  const direction = approvedDirection || approvedDirectionFromRenderedJob(job);
  const input = redactRenderedAuditValue({
    approvedDirection: direction,
    facts: facts || renderedJobFacts(job),
    transcript: finalTranscript,
    media: {
      attachment: `media://jobs/${opaqueJobId(job.id)}/outputs/${outputVersion}/${mediaSha256}`,
      durationSeconds: roundSeconds(durationSeconds),
      ...(Number.isFinite(job.output?.metadata?.width) ? { width: Number(job.output.metadata.width) } : {}),
      ...(Number.isFinite(job.output?.metadata?.height) ? { height: Number(job.output.metadata.height) } : {}),
    },
    frameEvidence,
  });
  const reviewedAt = clock();
  const base = {
    schemaVersion: 1,
    kind: "ordinary_viewer_review",
    stage: "render",
    status: "running",
    trigger: redactLocalPathsInString(trigger),
    inspectionMode,
    subject: { type: "job", id: String(job.id || ""), outputVersion },
    outputVersion,
    media: {
      ...input.media,
      sizeBytes: outputFile.sizeBytes,
    },
    mediaSha256,
    transcriptSha256,
    transcript: finalTranscript,
    approvedDirection: input.approvedDirection,
    evidenceSourceIds: input.facts.map(item => item.sourceId),
    frameEvidenceIds: input.frameEvidence.map(item => item.artifactId),
    reviewedAt,
    authority: {
      mutatesContent: false,
      mutatesJobApproval: false,
      grantsApproval: false,
      publishes: false,
      promotesMemory: false,
    },
  };
  let record;
  try {
    if (typeof critic?.review !== "function") throw new Error("ordinary viewer critic is not configured");
    const review = await critic.review(input, { stage: "render" });
    record = { ...base, status: "complete", review: redactRenderedAuditValue(review) };
  } catch (error) {
    record = {
      ...base,
      status: "failed",
      error: redactLocalPathsInString(String(error?.message || error || "ordinary viewer critic failed")).slice(0, 500),
    };
  }
  record = withContentHash(redactRenderedAuditValue(record));
  if (typeof writeArtifact !== "function") throw httpError(503, "writeArtifact is not configured");
  let href;
  try {
    href = await writeArtifact(artifactKind, id, record);
  } catch (error) {
    if (typeof readArtifact !== "function") throw error;
    const existing = await readArtifact(artifactKind, id);
    if (!existing) throw error;
    assertExistingIdentity(existing, expectedIdentity);
    return {
      artifactId: id,
      artifactHref: artifactHref(artifactKind, id),
      artifact: existing,
      replayed: true,
    };
  }
  return {
    artifactId: id,
    artifactHref: href || artifactHref(artifactKind, id),
    artifact: record,
    replayed: false,
  };
}
