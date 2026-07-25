import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
  VISUAL_WORKFLOW_VERSION,
  VISUAL_STAGE_ORDER,
  loadVisualWorkflowDefaults,
  normalizeVisualWorkflowConfig,
  createVisualWorkflowState,
  ensureVisualWorkflowState,
  invalidateVisualStages,
  visualStageProgress,
  normalizeVisualStyleReport,
  normalizeContentBreakdown,
  normalizeKeyframeDirection,
  normalizeMotionDirection,
  normalizeFullDirection,
  buildHyperframesDirectorProject,
} from "./visual_director.mjs";
import { createMultiAgentApi } from "./multi-agent/api.mjs";
import { buildBlindReviewBundle } from "./multi-agent/evaluation.mjs";
import { canonicalJson, contentHash, loadAgentProfiles, validateLibrary } from "./multi-agent/contracts.mjs";
import { canEnterScriptStage } from "./multi-agent/content-strategy.mjs";
import { createOrdinaryViewerCritic } from "./multi-agent/ordinary-viewer-critic.mjs";
import { auditRenderedJobOrdinaryViewer } from "./multi-agent/rendered-ordinary-viewer-audit.mjs";
import { createMemoryService } from "./multi-agent/memory.mjs";
import { createOrchestrator } from "./multi-agent/orchestrator.mjs";
import { openDomainStore } from "./multi-agent/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const envFile = path.join(root, ".env");
const requestedPort = process.env.KOUBO_PORT;
if (typeof process.loadEnvFile === "function" && fs.existsSync(envFile)) process.loadEnvFile(envFile);
const webRoot = path.join(root, "web");
const jobsRoot = path.join(root, "video-jobs");
const contentRoot = path.join(root, "content-items");
const runtimePython = path.join(root, ".runtime", "Scripts", "python.exe");
const runtimeFfmpeg = path.join(root, ".runtime", "ffmpeg", "bin");
const aiBridge = path.join(here, "ai_bridge.py");
const referenceCollector = path.join(root, "scripts", "collect_douyin_references.mjs");
const referenceLibraryFile = path.join(root, "config", "reference_video_library.json");
const referenceCreatorsFile = path.join(root, "config", "reference_creators.json");
const visualWorkflowDefaults = await loadVisualWorkflowDefaults(root);
const host = "127.0.0.1";
const port = Number(requestedPort || process.env.KOUBO_PORT || 8787);
if (fs.existsSync(runtimeFfmpeg)) process.env.PATH = `${runtimeFfmpeg}${path.delimiter}${process.env.PATH || ""}`;
const running = new Map();
const workflowDrafts = new Map();
const mime = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".mp4": "video/mp4", ".webm": "video/webm",
  ".srt": "application/x-subrip; charset=utf-8", ".ass": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".edl": "text/plain; charset=utf-8"
};

await Promise.all([fsp.mkdir(jobsRoot, { recursive: true }), fsp.mkdir(contentRoot, { recursive: true })]);

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Idempotency-Key,X-File-Name,X-Content-Id,X-Options,X-Workflow-Draft");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length,Idempotency-Replayed");
}
function json(res, status, value) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value, null, 2));
}
function safeName(value) {
  return String(value || "video.mp4").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\.{2,}/g, ".").slice(0, 160) || "video.mp4";
}
function confined(base, target) {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(base, target);
  if (resolved.toLowerCase() !== resolvedBase.toLowerCase() && !resolved.toLowerCase().startsWith(resolvedBase.toLowerCase() + path.sep)) throw new Error("路径越界");
  return resolved;
}
function redact(text) {
  return String(text || "")
    .replace(/(?:file:\/{2,3})?[A-Za-z]:[\\/][^\r\n"'<>,;)\]]+/gi, "<local-path>")
    .replace(/\\\\[^\\/\s]+[\\/][^\r\n"'<>,;)\]]+/g, "<local-path>")
    .replace(/(api[_-]?key|token|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replace(/(?:sk|gsk|ghp|github_pat)_[A-Za-z0-9_-]{12,}/g, "<redacted>")
    .slice(0, 40000);
}
async function writeJson(file, data) {
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(temp, file);
}
async function readJsonFile(file) { return JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
async function readJob(id) { return readJsonFile(path.join(confined(jobsRoot, id), "job.json")); }
async function readContent(id) {
  const safeId = safeName(id);
  try {
    return await readJsonFile(path.join(confined(contentRoot, safeId), "content.json"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function saveJob(job) { job.updatedAt = new Date().toISOString(); await writeJson(path.join(confined(jobsRoot, job.id), "job.json"), job); }
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 0, onStdout, onStderr, ...spawnOptions } = options;
    const child = spawn(command, args, { windowsHide: true, ...spawnOptions });
    let stdout = "", stderr = "";
    let timedOut = false, settled = false;
    const timer = timeoutMs ? setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill();
    }, timeoutMs) : null;
    child.stdout?.on("data", c => { stdout += c; onStdout?.(String(c)); });
    child.stderr?.on("data", c => { stderr += c; onStderr?.(String(c)); });
    child.on("error", error => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", code => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (timedOut) return reject(Object.assign(new Error(`${command} 超时`), { stdout, stderr, code }));
      return code === 0 ? resolve({ stdout, stderr }) : reject(Object.assign(new Error(`${command} 退出码 ${code}`), { stdout, stderr, code }));
    });
  });
}
async function runAi(payload, workDir, name) {
  if (!fs.existsSync(runtimePython)) throw new Error("AI运行环境未安装，请重新运行工作台初始化");
  const request = path.join(workDir, `${name}-request.json`);
  const response = path.join(workDir, `${name}-response.json`);
  await writeJson(request, payload);
  try {
    await run(runtimePython, [aiBridge, "--request", request, "--response", response], { cwd: root, env: process.env });
  } catch (error) {
    if (!fs.existsSync(response)) throw error;
  }
  const result = await readJsonFile(response);
  if (!result.success) throw new Error(result.error || `${name}失败`);
  return result;
}
function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function timestampId() { return `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`; }
async function readTextIf(file, max = 12000) {
  try { return redact((await fsp.readFile(file, "utf8")).slice(0, max)); } catch { return ""; }
}
async function listGeneratedContents() {
  const entries = await fsp.readdir(contentRoot, { withFileTypes: true });
  const items = [];
  for (const entry of entries.filter(x => x.isDirectory())) {
    try {
      const item = await readJsonFile(path.join(contentRoot, entry.name, "content.json"));
      item.sourcePackageHref ||= `/content-items/${entry.name}/content.json`;
      item.sourcePackagePath ||= path.join(contentRoot, entry.name, "content.json");
      items.push(item);
    } catch {}
  }
  const replacedIds = new Set(items.map(item => String(item.replacesContentId || "")).filter(Boolean));
  return items
    .filter(item => !replacedIds.has(String(item.id || "")))
    .sort((a, b) => String(b.generatedAt || b.date).localeCompare(String(a.generatedAt || a.date)));
}
async function contentDirectionFor(contentId) {
  if (!contentId) return null;
  const id = safeName(contentId);
  try {
    const content = await readJsonFile(path.join(confined(contentRoot, id), "content.json"));
    return {
      id,
      lockedDirection: String(content.lockedDirection || ""),
      lockedDirectionHash: String(content.lockedDirectionHash || content.generation?.lockedDirectionHash || ""),
      directionSource: String(content.directionSource || ""),
      strategyConfirmationArtifactId: String(content.generation?.strategyConfirmationArtifactId || ""),
      strategyAnalysisArtifactId: String(content.generation?.strategyAnalysisArtifactId || ""),
      approvedDirection: content.approvedDirection || null,
      audience: String(content.audience || ""),
      viewerBenefit: String(content.viewerBenefit || content.audienceBenefit || ""),
      coreQuestion: String(content.coreQuestion || content.structureDesign?.coreQuestion || ""),
      mainTopic: String(content.mainTopic || ""),
      hook: String(content.hook || ""),
      audienceBenefit: String(content.audienceBenefit || ""),
      resultFirstProof: content.resultFirstProof || {},
      shooting: content.shooting || {},
      structureDesign: content.structureDesign || {},
      referenceResearch: content.referenceResearch || {},
      fullSegments: Array.isArray(content.fullSegments) ? content.fullSegments : []
    };
  } catch { return null; }
}

async function referenceCatalog() {
  try {
    const [library, creators] = await Promise.all([readJsonFile(referenceLibraryFile), readJsonFile(referenceCreatorsFile)]);
    const creatorByVideo = new Map();
    for (const creator of creators.creators || []) {
      for (const videoId of creator.pinnedVideoIds || []) creatorByVideo.set(String(videoId), creator);
    }
    return (library.items || []).map(item => {
      const creator = creatorByVideo.get(String(item.videoId || "")) || {};
      return {
        ...item,
        creatorName: String(creator.creatorName || creator.label || "").trim(),
        creatorProfileUrl: String(creator.profileUrl || "").trim()
      };
    });
  } catch { return []; }
}
async function collectEvidence() {
  const runRoot = path.join(root, "runs");
  let latestProgress = "";
  try {
    const dates = (await fsp.readdir(runRoot, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name).sort().reverse();
    for (const date of dates) {
      const candidate = path.join(runRoot, date, "growth", "00_daily_progress.md");
      if (fs.existsSync(candidate)) { latestProgress = await readTextIf(candidate, 16000); break; }
    }
  } catch {}
  let gitLog = "", gitStatus = "", gitDiff = "";
  try { gitLog = (await run("git", ["log", "--oneline", "-6"], { cwd: root })).stdout.trim(); } catch {}
  try { gitStatus = (await run("git", ["status", "--short"], { cwd: root })).stdout.trim(); } catch {}
  try { gitDiff = (await run("git", ["diff", "--stat", "HEAD"], { cwd: root })).stdout.trim(); } catch {}
  const recent = [];
  async function walk(dir, depth = 0) {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if ([".git", ".runtime", "video-jobs", "content-items", "outputs"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else {
        const stat = await fsp.stat(full);
        if (Date.now() - stat.mtimeMs < 3 * 86400000) recent.push({ path: path.relative(root, full), modified: stat.mtime.toISOString(), size: stat.size });
      }
    }
  }
  await walk(root);
  return {
    creator_profile: await readTextIf(path.join(root, "docs", "CREATOR_PROFILE.md"), 12000),
    roadmap: await readTextIf(path.join(root, "docs", "30_DAY_AI_GROWTH_ROADMAP.md"), 12000),
    latest_progress: latestProgress,
    git: { log: redact(gitLog), status: redact(gitStatus), diff_stat: redact(gitDiff) },
    recently_modified_files: recent.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 60),
    generated_at: new Date().toISOString()
  };
}
function normalizeContent(raw, dayNumber, id, meta) {
  const value = raw && typeof raw === "object" ? raw : {};
  const defaultSegments = [{ time: "0—3秒", label: "直接给结果", tone: "自然", text: value.hook || value.mainTopic || "今天没有足够证据生成口播。" }];
  const design = value.structureDesign && typeof value.structureDesign === "object" ? value.structureDesign : {};
  const validArchetypes = new Set(["evidence-story", "saveable-map", "short-resonance"]);
  const structureDesign = {
    archetype: validArchetypes.has(design.archetype) ? design.archetype : "",
    selectionReason: String(design.selectionReason || ""),
    coreQuestion: String(design.coreQuestion || ""),
    hookConflict: String(design.hookConflict || ""),
    saveableFramework: (Array.isArray(design.saveableFramework) ? design.saveableFramework : []).slice(0, 5).map(item => ({
      label: String(item?.label || ""), action: String(item?.action || ""), expectedSignal: String(item?.expectedSignal || "")
    })),
    personalEvidenceRole: String(design.personalEvidenceRole || ""),
    personalVariation: String(design.personalVariation || ""),
    boundary: String(design.boundary || ""),
    payoff: String(design.payoff || "")
  };
  const research = value.referenceResearch && typeof value.referenceResearch === "object" ? value.referenceResearch : {};
  const referenceResearch = {
    sourceIds: (Array.isArray(research.sourceIds) ? research.sourceIds : []).map(String).slice(0, 8),
    borrowedKnowledge: (Array.isArray(research.borrowedKnowledge) ? research.borrowedKnowledge : []).map(String).slice(0, 8),
    structuralChoices: (Array.isArray(research.structuralChoices) ? research.structuralChoices : []).map(String).slice(0, 8),
    engagementChoices: (Array.isArray(research.engagementChoices) ? research.engagementChoices : []).map(String).slice(0, 6),
    originalityNote: String(research.originalityNote || "")
  };
  return {
    id, kind: "growth", date: shanghaiDate(), day: `Day ${dayNumber}`, column: value.column || `普通人学AI第${dayNumber}天`,
    status: "待审核", badge: "AI自动生成", durationFull: value.durationFull || "约2—3分钟", durationShort: value.durationShort || "约60—90秒衍生版",
    mainTopic: String(value.mainTopic || "今天没有足够证据生成主选题"), shortTopic: String(value.shortTopic || value.mainTopic || "待确认").slice(0, 20),
    hook: String(value.hook || ""), audienceBenefit: String(value.audienceBenefit || ""),
    resultFirstProof: value.resultFirstProof && typeof value.resultFirstProof === "object" ? value.resultFirstProof : {},
    engagement: {
      audienceMirror: String(value.engagement?.audienceMirror || value.audienceMirror || value.audienceBenefit || ""),
      commentPrompt: String(value.engagement?.commentPrompt || value.commentPrompt || ""),
      followPromise: String(value.engagement?.followPromise || value.followPromise || value.tomorrowChallenge || value.storyPosition?.tomorrow || ""),
      viewerTask: String(value.engagement?.viewerTask || value.actionExperiment?.viewerTask || ""),
      primaryClose: String(value.engagement?.primaryClose || "")
    },
    structureDesign, referenceResearch,
    creativeTone: {
      humorBeat: String(value.creativeTone?.humorBeat || ""),
      trendMeme: value.creativeTone?.trendMeme && typeof value.creativeTone.trendMeme === "object" ? value.creativeTone.trendMeme : { id: "", adaptedLine: "", placement: "", sourceUrl: "" }
    },
    actionExperiment: value.actionExperiment && typeof value.actionExperiment === "object" ? value.actionExperiment : {},
    storyPosition: value.storyPosition || { yesterday: "自动读取最近记录", today: "等待确认", tomorrow: value.tomorrowChallenge || "继续真实验证" },
    progress: Array.isArray(value.progress) ? value.progress : [], candidates: Array.isArray(value.candidates) ? value.candidates : [],
    fullSegments: Array.isArray(value.fullSegments) && value.fullSegments.length ? value.fullSegments : defaultSegments,
    shortScript: String(value.shortScript || ""), titles: Array.isArray(value.titles) ? value.titles.slice(0, 5) : [],
    covers: Array.isArray(value.covers) ? value.covers.slice(0, 5) : [], shooting: value.shooting || { broll: [], highlights: [], guide: {} },
    platformCopy: value.platformCopy || { douyin: "", xiaohongshu: "", weibo: "" }, evidence: Array.isArray(value.evidence) ? value.evidence : [],
    risks: Array.isArray(value.risks) ? value.risks : [{ text: "发布前人工确认所有事实和隐私边界", done: false }],
    sourceFiles: [
      { label: "AI生成内容JSON", path: `/content-items/${id}/content.json` },
      { label: "AI生成证据包", path: `/content-items/${id}/evidence.json` },
      { label: "同题视频研究包", path: `/content-items/${id}/reference-research.json` },
      { label: "AI选题规划", path: `/content-items/${id}/topic-plan.json` }
    ],
    sourcePackageHref: `/content-items/${id}/content.json`,
    sourcePackagePath: path.join(contentRoot, id, "content.json"),
    generatedAt: new Date().toISOString(),
    generation: { model: meta.model, usage: meta.usage || {}, mode: "openai-compatible", automatic: true, qualityRevision: meta.quality_revision || { repaired: false, initial_issues: [] } }
  };
}

function contentStrategyError(code, message, statusCode = 422) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function requiredLockedDirection(value, label = "lockedDirection") {
  const direction = String(value ?? "").trim();
  if (!direction) throw contentStrategyError(
    "CONTENT_DIRECTION_REQUIRED",
    `${label} is required. 默认生成不再自动选题；请先提交用户锁定方向和服务端 strategyConfirmationArtifactId，或显式设置 allowAgentTopicSearch=true。`
  );
  return direction;
}

export function hashLockedDirection(direction) {
  return contentHash({ lockedDirection: requiredLockedDirection(direction) });
}

function serverArtifactContentHash(artifact) {
  const core = structuredClone(artifact);
  delete core.contentHash;
  return contentHash(core);
}

function assertServerArtifactContentHash(artifact, label) {
  const declared = String(artifact?.contentHash || "").trim();
  if (!/^[a-f0-9]{64}$/u.test(declared) || declared !== serverArtifactContentHash(artifact)) {
    throw contentStrategyError(
      "CONTENT_STRATEGY_ARTIFACT_HASH_INVALID",
      `${label} content hash is missing or invalid`,
      409
    );
  }
  return declared;
}

function strategyNotReadyMessage(input, analysis) {
  if (input.userConfirmation?.analysisApproved !== true
    || input.userConfirmation?.confirmedDirection !== input.lockedDirection) {
    return "strategy artifact must be user-confirmed and ready for script（策略分析尚未由用户确认进入写稿）";
  }
  if (!Array.isArray(input.evidence) || input.evidence.length === 0
    || !Array.isArray(analysis.evidence?.available) || analysis.evidence.available.length === 0
    || !Array.isArray(analysis.evidence?.missing) || analysis.evidence.missing.length > 0) {
    return "strategy artifact evidence is incomplete（真实证据缺失或仍有未解决证据项）";
  }
  return "strategy artifact is not confirmed and ready for script（状态、方向或证据未通过写稿门禁）";
}

function expectedApprovedDirection(input, analysis) {
  return {
    audience: analysis.audience,
    viewerBenefit: analysis.viewerBenefit,
    coreQuestion: analysis.testableQuestion,
    constraints: input.constraints || [],
  };
}

async function requiredStrategyArtifact(readArtifactFn, kind, id, label) {
  const artifact = await readArtifactFn(kind, id);
  if (!artifact) throw contentStrategyError("CONTENT_STRATEGY_ARTIFACT_NOT_FOUND", `${label} artifact not found`, 404);
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw contentStrategyError("CONTENT_STRATEGY_ARTIFACT_INVALID", `${label} artifact is invalid`, 409);
  }
  return artifact;
}

export async function validateContentGenerationStrategy(options = {}, dependencies = {}) {
  if (options.allowAgentTopicSearch === true) {
    if (String(options.lockedDirection || "").trim()
      || options.strategyArtifact
      || String(options.strategyConfirmationArtifactId || "").trim()) {
      throw contentStrategyError(
        "CONTENT_TOPIC_AUTHORITY_CONFLICT",
        "allowAgentTopicSearch=true cannot be combined with a user-locked direction or strategy confirmation; choose one authority path."
      );
    }
    return {
      mode: "agent_topic_search_explicit",
      directionSource: "agent_topic_search_explicitly_allowed",
      lockedDirection: null,
      lockedDirectionHash: null,
      strategyArtifact: null,
      strategyArtifactHash: null,
    };
  }

  if (options.strategyArtifact !== undefined) {
    throw contentStrategyError(
      "CONTENT_STRATEGY_INLINE_FORBIDDEN",
      "client-provided strategyArtifact is not authoritative; submit strategyConfirmationArtifactId from the server confirmation route"
    );
  }

  const lockedDirection = requiredLockedDirection(options.lockedDirection);
  const expectedDirectionHash = hashLockedDirection(lockedDirection);
  const declaredDirectionHash = String(options.lockedDirectionHash || "").trim();
  if (declaredDirectionHash !== expectedDirectionHash) {
    throw contentStrategyError(
      "CONTENT_DIRECTION_HASH_MISMATCH",
      "locked direction hash does not match lockedDirection"
    );
  }

  const confirmationArtifactId = String(options.strategyConfirmationArtifactId || "").trim();
  if (!confirmationArtifactId) {
    throw contentStrategyError(
      "CONTENT_STRATEGY_CONFIRMATION_REQUIRED",
      "strategyConfirmationArtifactId is required. Use the server-side human confirmation artifact; embedded strategy objects are rejected."
    );
  }
  const readArtifactFn = dependencies.readArtifactFn || readMultiAgentArtifact;
  if (typeof readArtifactFn !== "function") {
    throw contentStrategyError("CONTENT_STRATEGY_READER_UNAVAILABLE", "server strategy artifact reader is unavailable", 503);
  }
  const confirmation = await requiredStrategyArtifact(
    readArtifactFn,
    "content-strategy-confirmations",
    confirmationArtifactId,
    "content strategy confirmation"
  );
  if (confirmation.schemaVersion !== 1 || confirmation.kind !== "content_strategy_human_confirmation") {
    throw contentStrategyError("CONTENT_STRATEGY_CONFIRMATION_INVALID", "confirmation artifact has an invalid contract", 409);
  }
  assertServerArtifactContentHash(confirmation, "content strategy confirmation");
  if (confirmation.decision !== "approved" || confirmation.scriptHandoffAllowed !== true) {
    throw contentStrategyError(
      "CONTENT_STRATEGY_NOT_APPROVED",
      "confirmation artifact is not approved for Script Agent handoff",
      409
    );
  }
  if (confirmation.actor?.type !== "human" || !String(confirmation.actor?.id || "").trim()) {
    throw contentStrategyError(
      "CONTENT_STRATEGY_CONFIRMATION_ACTOR_INVALID",
      "confirmation artifact requires a human actor",
      409
    );
  }
  if (String(confirmation.lockedDirection || "").trim() !== lockedDirection) {
    throw contentStrategyError(
      "CONTENT_STRATEGY_DIRECTION_MISMATCH",
      "confirmation artifact direction does not match the request lockedDirection",
      409
    );
  }
  const analysisArtifactId = String(confirmation.analysisArtifactId || "").trim();
  if (!analysisArtifactId) {
    throw contentStrategyError(
      "CONTENT_STRATEGY_ANALYSIS_BINDING_MISSING",
      "confirmation artifact does not identify its analysis artifact",
      409
    );
  }
  const analysisArtifact = await requiredStrategyArtifact(
    readArtifactFn,
    "content-strategy-analyses",
    analysisArtifactId,
    "content strategy analysis"
  );
  if (analysisArtifact.schemaVersion !== 1 || analysisArtifact.kind !== "content_strategy_analysis") {
    throw contentStrategyError("CONTENT_STRATEGY_ANALYSIS_INVALID", "analysis artifact has an invalid contract", 409);
  }
  const analysisContentHash = assertServerArtifactContentHash(
    analysisArtifact,
    "content strategy analysis"
  );
  if (String(confirmation.analysisContentHash || "").trim() !== analysisContentHash) {
    throw contentStrategyError(
      "CONTENT_STRATEGY_ANALYSIS_HASH_MISMATCH",
      "confirmation artifact is bound to a different analysis content hash",
      409
    );
  }
  if (!analysisArtifact.input || !analysisArtifact.analysis) {
    throw contentStrategyError(
      "CONTENT_STRATEGY_ANALYSIS_INCOMPLETE",
      "analysis artifact is missing its original input or analysis",
      409
    );
  }
  if (analysisArtifact.input.lockedDirection !== lockedDirection
    || analysisArtifact.analysis.lockedDirection !== lockedDirection) {
    throw contentStrategyError(
      "CONTENT_STRATEGY_DIRECTION_MISMATCH",
      "confirmation is bound to an analysis with a different locked direction",
      409
    );
  }
  const approvedDirection = expectedApprovedDirection(analysisArtifact.input, analysisArtifact.analysis);
  if (canonicalJson(confirmation.approvedDirection) !== canonicalJson(approvedDirection)) {
    throw contentStrategyError(
      "CONTENT_STRATEGY_APPROVED_DIRECTION_MISMATCH",
      "confirmation approvedDirection does not match the bound analysis",
      409
    );
  }
  const confirmedInput = structuredClone(analysisArtifact.input);
  confirmedInput.userConfirmation = {
    analysisApproved: true,
    confirmedDirection: lockedDirection,
  };
  if (!canEnterScriptStage(confirmedInput, analysisArtifact.analysis)) {
    throw contentStrategyError(
      "CONTENT_STRATEGY_NOT_READY",
      strategyNotReadyMessage(confirmedInput, analysisArtifact.analysis),
      409
    );
  }

  const authoritativeStrategy = {
    confirmationArtifactId,
    analysisArtifactId,
    confirmation: structuredClone(confirmation),
    input: confirmedInput,
    analysis: structuredClone(analysisArtifact.analysis),
  };
  const authoritativeStrategyHash = contentHash(authoritativeStrategy);

  return {
    mode: "user_locked_strategy",
    directionSource: "explicit_user_direction",
    lockedDirection,
    lockedDirectionHash: expectedDirectionHash,
    strategyConfirmationArtifactId: confirmationArtifactId,
    strategyAnalysisArtifactId: analysisArtifactId,
    strategyArtifact: authoritativeStrategy,
    strategyArtifactHash: authoritativeStrategyHash,
  };
}

function returnedDirection(value) {
  for (const candidate of [
    value?.lockedDirection,
    value?.topic,
    value?.mainTopic,
    value?.selectedTopic,
    value?.direction,
  ]) {
    const direction = String(candidate ?? "").trim();
    if (direction) return direction;
  }
  return "";
}

function returnedTopicField(value, stage) {
  const candidates = stage === "plan_topic"
    ? [value?.topic, value?.mainTopic, value?.selectedTopic, value?.direction]
    : [value?.mainTopic, value?.topic, value?.selectedTopic, value?.direction];
  for (const candidate of candidates) {
    const direction = String(candidate ?? "").trim();
    if (direction) return direction;
  }
  return "";
}

export function preserveLockedDirection(value, generationContext, stage = "content") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contentStrategyError("CONTENT_DIRECTION_OUTPUT_INVALID", `${stage} must return an object`, 502);
  }
  const output = structuredClone(value);
  let lockedDirection = generationContext?.lockedDirection;
  let lockedDirectionHash = generationContext?.lockedDirectionHash;
  let directionSource = generationContext?.directionSource;

  if (!lockedDirection) {
    lockedDirection = requiredLockedDirection(returnedDirection(output), `${stage}.lockedDirection`);
    lockedDirectionHash = hashLockedDirection(lockedDirection);
    directionSource = "agent_topic_search_explicitly_allowed";
  }

  if (String(output.lockedDirection || "").trim()
    && String(output.lockedDirection).trim() !== lockedDirection) {
    throw contentStrategyError(
      "CONTENT_DIRECTION_CHANGED",
      `${stage} changed the locked direction`,
      409
    );
  }
  if (String(output.lockedDirectionHash || "").trim()
    && String(output.lockedDirectionHash).trim() !== lockedDirectionHash) {
    throw contentStrategyError(
      "CONTENT_DIRECTION_HASH_CHANGED",
      `${stage} changed the locked direction hash`,
      409
    );
  }
  if (String(output.directionSource || "").trim()
    && String(output.directionSource).trim() !== directionSource) {
    throw contentStrategyError(
      "CONTENT_DIRECTION_SOURCE_CHANGED",
      `${stage} changed the direction authority`,
      409
    );
  }

  const returnedTopic = returnedTopicField(output, stage);
  if (generationContext?.lockedDirection && returnedTopic !== lockedDirection) {
    throw contentStrategyError(
      "CONTENT_DIRECTION_CHANGED",
      `${stage} changed the user-locked topic field`,
      409
    );
  }

  output.lockedDirection = lockedDirection;
  output.lockedDirectionHash = lockedDirectionHash;
  output.directionSource = directionSource;
  return output;
}

function generationLockPayload(generationContext) {
  const payload = {
    direction_source: generationContext.directionSource,
    allow_agent_topic_search: generationContext.mode === "agent_topic_search_explicit",
  };
  if (generationContext.lockedDirection) {
    payload.locked_direction = generationContext.lockedDirection;
    payload.locked_direction_hash = generationContext.lockedDirectionHash;
  }
  if (generationContext.strategyArtifact) {
    payload.strategy_artifact = generationContext.strategyArtifact;
    payload.strategy_artifact_hash = generationContext.strategyArtifactHash;
  }
  return payload;
}

function generationContextFromPlan(generationContext, topicPlan) {
  if (generationContext.lockedDirection) return generationContext;
  return {
    ...generationContext,
    lockedDirection: topicPlan.lockedDirection,
    lockedDirectionHash: topicPlan.lockedDirectionHash,
    directionSource: topicPlan.directionSource,
  };
}

function generatedScriptText(content) {
  const segments = Array.isArray(content?.fullSegments)
    ? content.fullSegments.map(item => String(item?.text || "").trim()).filter(Boolean)
    : [];
  return segments.join("\n") || String(content?.shortScript || content?.hook || content?.mainTopic || "").trim();
}

function redactAuditLocalPaths(value) {
  let text = String(value ?? "");
  text = text.replace(/file:\/\/\/?[^\s"'<>]+/giu, "<local-path>");
  text = text.replace(/(?:\\\\\?\\)?[A-Za-z]:[\\/][^\s"'<>|]*/gu, "<local-path>");
  text = text.replace(/\\\\[^\\/\s]+[\\/][^\s"'<>|]*/gu, "<local-path>");
  text = text.replace(
    /(^|[\s"'([{=])\/(?:Users|home|tmp|var|etc|mnt|opt|srv|Volumes|private|root)(?:\/[^\s"'<>]*)?/giu,
    (_, prefix) => `${prefix}<local-path>`
  );
  return text.trim();
}

function opaqueAuditSourceId(value, fallback) {
  const text = String(value ?? "").trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(text)) return text;
  const digest = crypto.createHash("sha256").update(text || fallback).digest("hex").slice(0, 16);
  return `${fallback}-${digest}`;
}

function generatedAuditFacts(content, generationContext) {
  const strategyEvidence = generationContext.strategyArtifact?.input?.evidence;
  if (Array.isArray(strategyEvidence) && strategyEvidence.length) {
    return strategyEvidence.map((item, index) => ({
      sourceId: opaqueAuditSourceId(item.sourceId || item.id, `strategy-evidence-${index + 1}`),
      provenance: opaqueAuditSourceId(item.provenance || "user_provided", "provenance"),
      claim: redactAuditLocalPaths(item.summary || item.kind || item.id || "真实证据"),
      kind: opaqueAuditSourceId(item.kind || "evidence", "evidence-kind"),
      status: opaqueAuditSourceId(item.provenance || "user_provided", "evidence-status"),
      ...(Number.isFinite(item.start) && Number.isFinite(item.end) ? { start: item.start, end: item.end } : {}),
    }));
  }
  return (Array.isArray(content?.evidence) ? content.evidence : []).slice(0, 12).map((item, index) => {
    if (typeof item === "string") return {
      sourceId: `generated-content-evidence-${index + 1}`,
      provenance: "generated_content_claim",
      claim: redactAuditLocalPaths(item),
    };
    return {
      sourceId: opaqueAuditSourceId(item?.sourceId || item?.id, `generated-content-evidence-${index + 1}`),
      provenance: opaqueAuditSourceId(item?.provenance || "generated_content_claim", "provenance"),
      claim: redactAuditLocalPaths(item?.summary || item?.claim || item?.text || item?.kind || "生成内容证据"),
      kind: opaqueAuditSourceId(item?.kind || "evidence", "evidence-kind"),
      status: opaqueAuditSourceId(item?.status || "generated_content_claim", "evidence-status"),
    };
  });
}

export function buildGeneratedContentScriptAuditInput(content, generationContext, topicPlan = {}) {
  const analysis = generationContext.strategyArtifact?.analysis || {};
  const audience = String(analysis.audience || topicPlan.viewerUseCase || content.audienceBenefit || "时间有限、需要具体AI行动的普通观众").trim();
  const viewerBenefit = String(analysis.viewerBenefit || topicPlan.methodPromise || content.audienceBenefit || "看完能完成一个可验证的AI动作").trim();
  const coreQuestion = String(analysis.testableQuestion || topicPlan.coreQuestion || content.structureDesign?.coreQuestion || "这条内容是否给出真实、可复用的观众价值").trim();
  return {
    stage: "script",
    approvedDirection: {
      audience,
      viewerBenefit,
      coreQuestion,
      constraints: [
        `lockedDirection: ${generationContext.lockedDirection}`,
        "不得换题、整篇重写或批准发布",
      ],
    },
    script: generatedScriptText(content),
    facts: generatedAuditFacts(content, generationContext),
  };
}

export async function auditGeneratedContentScript({
  content,
  generationContext,
  topicPlan,
  outputDirectory,
  critic,
  writeJsonFn = writeJson,
} = {}) {
  if (!critic || typeof critic.review !== "function") throw new Error("ordinary viewer critic is required");
  const originalStatus = content.status;
  const reviewFile = path.join(outputDirectory, "ordinary-viewer-review.json");
  const base = {
    schemaVersion: 1,
    stage: "script",
    lockedDirection: generationContext.lockedDirection,
    lockedDirectionHash: generationContext.lockedDirectionHash,
    strategyArtifactHash: generationContext.strategyArtifactHash || null,
    generatedAt: new Date().toISOString(),
    authority: {
      mayApproveProduction: false,
      mayApprovePublish: false,
      mayChangeDirection: false,
    },
  };
  let artifact;
  try {
    const review = await critic.review(buildGeneratedContentScriptAuditInput(content, generationContext, topicPlan));
    artifact = { ...base, status: "complete", review };
    content.ordinaryViewerAudit = {
      status: "complete",
      stage: "script",
      artifactHref: `/content-items/${content.id}/ordinary-viewer-review.json`,
      viewerDecision: review.viewerDecision,
      sharpConclusion: review.sharpConclusion,
      blockers: review.blockers.length,
    };
  } catch (error) {
    artifact = { ...base, status: "failed", error: redact(error.message) };
    content.ordinaryViewerAudit = {
      status: "failed",
      stage: "script",
      artifactHref: `/content-items/${content.id}/ordinary-viewer-review.json`,
      error: artifact.error,
    };
  }
  content.status = originalStatus;
  content.sourceFiles = [
    ...(Array.isArray(content.sourceFiles) ? content.sourceFiles : []),
    { label: "普通观众稿件审查", path: `/content-items/${content.id}/ordinary-viewer-review.json` },
  ];
  await writeJsonFn(reviewFile, artifact);
  return artifact;
}

export async function generateContent(options = {}, dependencies = {}) {
  let generationContext = await validateContentGenerationStrategy(options, {
    readArtifactFn: dependencies.readArtifactFn,
  });
  const runAiFn = dependencies.runAiFn || runAi;
  const lockKey = "__content_generation__";
  if (running.has(lockKey)) { const error = new Error("已有口播正在生成，请稍候"); error.statusCode = 409; throw error; }
  running.set(lockKey, true);
  try {
    const existing = await listGeneratedContents();
    const baseTopics = [];
    try {
      const base = await fsp.readFile(path.join(webRoot, "data", "content-data.js"), "utf8");
      for (const match of base.matchAll(/mainTopic:\s*"([^"]+)"/g)) baseTopics.push(match[1]);
    } catch {}
    const requestedDay = Number(options.dayNumber || 0);
    const dayNumber = Number.isInteger(requestedDay) && requestedDay >= 1 && requestedDay <= 365
      ? requestedDay
      : Math.max(1, ...existing.map(x => Number(String(x.day || "").replace(/\D/g, "")) || 0), 1) + 1;
    const id = `growth-day-${dayNumber}${options.replacesContentId ? "-revision" : ""}-${timestampId()}`;
    const dir = confined(contentRoot, id);
    await fsp.mkdir(dir, { recursive: false });
    const evidence = await collectEvidence();
    await writeJson(path.join(dir, "evidence.json"), evidence);
    const existingTopics = [...baseTopics, ...existing.map(x => x.mainTopic)];
    let contentStyle = {};
    try { contentStyle = await readJsonFile(path.join(root, "config", "content_style.json")); } catch {}
    const editorialBrief = options.editorialBrief && typeof options.editorialBrief === "object" ? options.editorialBrief : {};
    const planLock = generationLockPayload(generationContext);
    const topicResult = await runAiFn({
      operation: "plan_topic",
      date: shanghaiDate(),
      day_number: dayNumber,
      evidence,
      content_style: contentStyle,
      editorial_brief: {
        ...editorialBrief,
        ...(generationContext.lockedDirection ? {
          topic: generationContext.lockedDirection,
          lockedDirection: generationContext.lockedDirection,
          lockedDirectionHash: generationContext.lockedDirectionHash,
        } : {}),
      },
      existing_topics: existingTopics,
      ...planLock,
    }, dir, "topic-plan");
    const topicPlan = preserveLockedDirection(topicResult.data, generationContext, "plan_topic");
    generationContext = generationContextFromPlan(generationContext, topicPlan);
    await writeJson(path.join(dir, "topic-plan.json"), topicPlan);
    const referenceFile = path.join(dir, "reference-research.json");
    try {
      await run(process.execPath, [referenceCollector, "--plan", path.join(dir, "topic-plan.json"), "--output", referenceFile], { cwd: root, env: process.env, timeoutMs: 1200000 });
    } catch (error) {
      let detail = error.message;
      try { detail = (await readJsonFile(referenceFile)).error || detail; } catch {}
      throw new Error(`同题视频研究未通过，已停止生成：${detail}`);
    }
    const referenceResearch = await readJsonFile(referenceFile);
    if (!Array.isArray(referenceResearch.fullContentSources) || !referenceResearch.fullContentSources.length) throw new Error("同题视频研究没有完成至少一条全文核验来源");
    const result = await runAiFn({
      operation: "generate_content",
      date: shanghaiDate(),
      day_number: dayNumber,
      evidence,
      topic_plan: topicPlan,
      reference_research: referenceResearch,
      existing_topics: existingTopics,
      ...generationLockPayload(generationContext),
    }, dir, "generate-content");
    const lockedResult = preserveLockedDirection(result.data, generationContext, "generate_content");
    const content = preserveLockedDirection(normalizeContent(lockedResult, dayNumber, id, result), generationContext, "content");
    const strategyAnalysis = generationContext.strategyArtifact?.analysis || {};
    content.audience = String(strategyAnalysis.audience || topicPlan.viewerUseCase || content.engagement?.audienceMirror || "").trim();
    content.viewerBenefit = String(strategyAnalysis.viewerBenefit || topicPlan.methodPromise || content.audienceBenefit || "").trim();
    content.coreQuestion = String(strategyAnalysis.testableQuestion || topicPlan.coreQuestion || content.structureDesign?.coreQuestion || "").trim();
    if (generationContext.mode === "user_locked_strategy") {
      content.approvedDirection = {
        audience: content.audience,
        viewerBenefit: content.viewerBenefit,
        coreQuestion: content.coreQuestion,
        constraints: Array.isArray(generationContext.strategyArtifact?.input?.constraints)
          ? generationContext.strategyArtifact.input.constraints.map(String)
          : [],
      };
    }
    content.generation = {
      ...content.generation,
      topicMode: generationContext.mode,
      allowAgentTopicSearch: generationContext.mode === "agent_topic_search_explicit",
      strategyArtifactHash: generationContext.strategyArtifactHash || null,
      strategyConfirmationArtifactId: generationContext.strategyConfirmationArtifactId || null,
      strategyAnalysisArtifactId: generationContext.strategyAnalysisArtifactId || null,
      lockedDirectionHash: generationContext.lockedDirectionHash,
      ordinaryViewerAuditRequired: true,
    };
    if (options.replacesContentId) content.replacesContentId = safeName(options.replacesContentId);
    await auditGeneratedContentScript({
      content,
      generationContext,
      topicPlan,
      outputDirectory: dir,
      critic: dependencies.ordinaryViewerCritic || multiAgentOrdinaryViewerCritic,
    });
    await writeJson(path.join(dir, "content.json"), content);
    return content;
  } finally {
    running.delete(lockKey);
  }
}

async function probe(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  const raw = JSON.parse(stdout), video = raw.streams?.find(s => s.codec_type === "video") || {}, audio = raw.streams?.find(s => s.codec_type === "audio") || null;
  const duration = Number(raw.format?.duration || video.duration || audio?.duration || 0), fpsParts = String(video.avg_frame_rate || video.r_frame_rate || "0/1").split("/").map(Number);
  const pixelFormat = video.pix_fmt || "";
  return {
    duration,
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    fps: Number((fpsParts[1] ? fpsParts[0] / fpsParts[1] : 0).toFixed(3)),
    videoCodec: video.codec_name || "",
    pixelFormat,
    bitsPerRawSample: Number(video.bits_per_raw_sample || 0) || (/p10/.test(pixelFormat) ? 10 : null),
    colorRange: video.color_range || "",
    colorSpace: video.color_space || "",
    colorTransfer: video.color_transfer || "",
    colorPrimaries: video.color_primaries || "",
    audioCodec: audio?.codec_name || "",
    hasAudio: !!audio,
    sizeBytes: Number(raw.format?.size || 0)
  };
}
function parseSilences(stderr, duration) {
  const events = []; let open = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([0-9.]+)/); if (start) open = Number(start[1]);
    const end = line.match(/silence_end:\s*([0-9.]+)/); if (end && open !== null) { events.push({ start: open, end: Number(end[1]) }); open = null; }
  }
  if (open !== null && duration > open) events.push({ start: open, end: duration });
  return events.filter(x => x.end > x.start);
}
function buildKeepSegments(duration, silences, pauseKeep = 0.12) {
  const removals = silences.map(s => ({ start: Math.max(0, s.start + pauseKeep), end: Math.min(duration, s.end - pauseKeep) })).filter(s => s.end - s.start >= 0.18).sort((a, b) => a.start - b.start);
  const keep = []; let cursor = 0;
  for (const cut of removals) { if (cut.start - cursor >= 0.12) keep.push({ start: cursor, end: cut.start, reason: "说话内容" }); cursor = Math.max(cursor, cut.end); }
  if (duration - cursor >= 0.12) keep.push({ start: cursor, end: duration, reason: "说话内容" });
  return keep.length ? keep : [{ start: 0, end: duration, reason: "完整保留" }];
}
function cleanCoverCopy(value, limit = 24) {
  return [...String(value || "").replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim()].slice(0, limit).join("");
}
function normalizeCoverPlan(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const lines = (Array.isArray(value.lines) ? value.lines : []).map(item => cleanCoverCopy(item, 14)).filter(Boolean).slice(0, 3);
  const highlights = (Array.isArray(value.highlights) ? value.highlights : []).map(item => cleanCoverCopy(item, 12)).filter(item => item && lines.some(line => line.includes(item))).slice(0, 3);
  const features = (Array.isArray(value.features) ? value.features : []).map(item => cleanCoverCopy(item, 8)).filter(Boolean).slice(0, 4);
  const sourceTime = Number(value.sourceTime);
  return {
    eyebrow: cleanCoverCopy(value.eyebrow, 12),
    lines,
    highlights,
    features,
    sourceTime: Number.isFinite(sourceTime) && sourceTime >= 0 ? sourceTime : null
  };
}
function validatePlan(raw, duration, fallback, provenance = "semantic") {
  const warnings = [];
  const input = Array.isArray(raw?.keepSegments) ? raw.keepSegments : [];
  const segments = input.map((item, index) => ({
    index,
    start: Number(item?.start),
    end: Number(item?.end),
    reason: String(item?.reason || "AI保留").slice(0, 160)
  })).filter(item => {
    const valid = Number.isFinite(item.start) && Number.isFinite(item.end) && item.start >= 0 && item.end <= duration + 0.05 && item.end - item.start >= 0.35;
    if (!valid) warnings.push(`忽略无效保留片段 #${item.index + 1}`);
    return valid;
  }).sort((a, b) => a.start - b.start).map(({ index, ...item }) => item);

  const merged = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous && segment.start < previous.end - 0.02) {
      warnings.push("模型计划包含重叠片段，已合并");
      previous.end = Math.max(previous.end, segment.end);
      previous.reason = `${previous.reason}；${segment.reason}`.slice(0, 160);
    } else if (previous && segment.start <= previous.end + 0.08) {
      previous.end = Math.max(previous.end, segment.end);
    } else merged.push({ ...segment });
  }
  const retained = merged.reduce((sum, item) => sum + item.end - item.start, 0);
  const retainedFraction = duration > 0 ? retained / duration : 0;
  const validSemantic = merged.length > 0 && retainedFraction >= 0.42 && retainedFraction <= 1.01;
  const keepSegments = validSemantic ? merged : fallback.map(item => ({ ...item }));
  if (!validSemantic) warnings.push("语义计划删除比例异常，已退回本地停顿剪辑");

  const requestedOverlays = Array.isArray(raw?.overlayCards) ? raw.overlayCards : [];
  const overlayCards = requestedOverlays.map((item, index) => {
    const start = Math.max(0, Number(item?.start));
    const end = Math.min(duration, Number(item?.end));
    const keep = keepSegments.find(segment => start >= segment.start && start < segment.end);
    if (!keep || !Number.isFinite(start) || !Number.isFinite(end)) return null;
    const boundedEnd = Math.min(end, keep.end, start + 3.2);
    if (boundedEnd - start < 0.5) return null;
    const items = (Array.isArray(item?.items) ? item.items : []).map(value => String(value || "").trim().slice(0, 14)).filter(Boolean).slice(0, 4);
    const display = item?.display === "side-panel" && items.length >= 2 ? "side-panel" : "banner";
    return { id: `overlay-${index + 1}`, start, end: boundedEnd, text: String(item?.text || "").trim().slice(0, 24), kind: ["hook", "evidence", "result", "lesson"].includes(item?.kind) ? item.kind : "evidence", items, display };
  }).filter(item => item?.text).slice(0, 6);
  if (requestedOverlays.length > overlayCards.length) warnings.push(`动态卡片已从 ${requestedOverlays.length} 张约束为 ${overlayCards.length} 张有效卡片`);

  const confidence = Number(raw?.confidence);
  return {
    keepSegments,
    overlayCards,
    coverDesign: normalizeCoverPlan(raw?.coverDesign),
    provenance: validSemantic ? provenance : "silence-fallback",
    engine: validSemantic ? "text-model" : "local-silence-detect",
    validated: true,
    warnings: [...new Set(warnings)],
    retainedFraction: Number((keepSegments.reduce((sum, item) => sum + item.end - item.start, 0) / duration).toFixed(4)),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null
  };
}
function normalizeOverlays(raw, duration) {
  return (Array.isArray(raw) ? raw : []).map((x, i) => {
    const items = (Array.isArray(x?.items) ? x.items : []).map(value => String(value || "").trim().slice(0, 14)).filter(Boolean).slice(0, 4);
    return { id: `overlay-${i + 1}`, start: Math.max(0, Number(x.start)), end: Math.min(duration, Number(x.end)), text: String(x.text || "").slice(0, 24), kind: String(x.kind || "evidence"), items, display: x?.display === "side-panel" && items.length >= 2 ? "side-panel" : "banner" };
  }).filter(x => x.text && x.end - x.start >= 0.5).slice(0, 6);
}
function feedbackOverlayLimit(feedback) {
  const match = String(feedback || "").match(/(?:卡片|图卡)[^。；;\n]{0,16}(?:只|最多)?(?:保留|要)?([零一二三四五六0-6])张/);
  if (!match) return null;
  const values = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  const value = values[match[1]] ?? Number(match[1]);
  return Number.isFinite(value) ? Math.max(0, Math.min(6, value)) : null;
}
function sourceToOutput(time, keeps) {
  let output = 0;
  for (const keep of keeps) {
    if (time >= keep.start && time <= keep.end) return output + time - keep.start;
    output += keep.end - keep.start;
  }
  return null;
}
function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, "0")}:${String(Math.floor((cs % 6000) / 100)).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}
function assEscape(text) { return String(text || "").replace(/[{}]/g, "").replace(/\r?\n/g, "\\N").replace(/,/g, "，").trim(); }
function captionText(text, script = "") {
  let result = String(text || "").replace(/codex/gi, "Codex");
  if (String(script).includes("三七二十一")) result = result.replace(/3721/g, "三七二十一");
  if (String(script).includes("口播工作台")) result = result.replace(/口婆(?=工作台)/g, "口播");
  if (String(script).includes("我是三金")) result = result.replace(/我是三斤/g, "我是三金");
  if (String(script).includes("管他三七二十一")) result = result.replace(/管它(?=三七二十一)/g, "管他");
  if (String(script).includes("迈出第一步")) result = result.replace(/卖出第一步/g, "迈出第一步");
  return result;
}
const captionSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
function timedCaptionChars(text, start, end) {
  const chars = [...String(text || "")];
  const span = Math.max(0, Number(end) - Number(start));
  return chars.map((char, index) => ({ char, start: Number(start) + span * index / chars.length, end: Number(start) + span * (index + 1) / chars.length }));
}
function captionBoundaryCarryLength(before, after) {
  const combined = String(before || "") + String(after || "");
  const boundary = [...String(before || "")].length;
  for (const phrase of ["优化"]) {
    const start = combined.lastIndexOf(phrase, boundary - 1);
    const end = start < 0 ? -1 : start + [...phrase].length;
    if (start >= 0 && start < boundary && end > boundary) return boundary - start;
  }
  for (const part of captionSegmenter.segment(combined)) {
    const start = [...combined.slice(0, part.index)].length;
    const end = start + [...part.segment].length;
    if (part.isWordLike && start < boundary && end > boundary) return boundary - start;
  }
  return 0;
}
function transcriptCues(transcript, keeps, script = "") {
  const words = Array.isArray(transcript?.words) ? transcript.words : [];
  if (words.length) {
    const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];
    const mapped = words.map(w => {
      const sourceStart = Number(w.start), sourceEnd = Number(w.end);
      const segmentIndex = segments.findIndex(segment => sourceStart >= Number(segment.start) - 0.04 && sourceStart < Number(segment.end) - 0.01);
      return { text: String(w.word || "").trim(), sourceStart, sourceEnd, segmentIndex, start: sourceToOutput(sourceStart, keeps), end: sourceToOutput(sourceEnd, keeps) };
    }).filter(w => w.text && w.start !== null && w.end !== null).map(word => ({ ...word, chars: timedCaptionChars(word.text, word.start, word.end) }));
    const cues = []; let group = null;
    for (const word of mapped) {
      if (!group) group = { start: word.start, end: word.end, text: word.text, chars: [...word.chars], segmentIndex: word.segmentIndex, lastTokenText: word.text };
      else {
        const segmentBreak = group.segmentIndex >= 0 && word.segmentIndex >= 0 && group.segmentIndex !== word.segmentIndex;
        if (segmentBreak && !/[。！？!?]$/.test(group.text)) {
          group.text += "。";
          group.chars.push({ char: "。", start: group.end, end: group.end });
        }
        const nextText = group.text + word.text;
        const endedSentence = /[。！？!?]$/.test(group.text);
        const endedClause = /[，,；;：:]$/.test(group.text) && (group.end - group.start >= 1 || group.text.length >= 8);
        const gapBreak = word.start - group.end > 0.65;
        const breakNow = segmentBreak || endedSentence || endedClause || gapBreak || nextText.length > 16 || word.end - group.start > 3.2;
        if (breakNow) {
          let carryLength = endedSentence || endedClause || gapBreak || segmentBreak ? 0 : captionBoundaryCarryLength(group.text, word.text);
          const carried = carryLength > 0 && group.chars.length > carryLength ? group.chars.splice(-carryLength) : [];
          if (carried.length) {
            group.text = group.chars.map(item => item.char).join("");
            group.end = group.chars.at(-1).end;
          }
          cues.push(group);
          group = carried.length
            ? { start: carried[0].start, end: word.end, text: carried.map(item => item.char).join("") + word.text, chars: [...carried, ...word.chars], segmentIndex: word.segmentIndex, lastTokenText: word.text }
            : { start: word.start, end: word.end, text: word.text, chars: [...word.chars], segmentIndex: word.segmentIndex, lastTokenText: word.text };
        } else {
          group.text = nextText;
          group.end = word.end;
          group.chars.push(...word.chars);
          group.lastTokenText = word.text;
        }
      }
    }
    if (group) cues.push(group);
    const balanced = [];
    for (const cue of cues) {
      const previous = balanced.at(-1);
      if (previous && cue.text.length <= 2 && cue.start - previous.end <= 0.5 && previous.text.length + cue.text.length <= 18 && !/[。！？!?]$/.test(previous.text)) {
        previous.text += cue.text;
        previous.end = cue.end;
      } else balanced.push(cue);
    }
    return balanced.map(({ chars: _chars, segmentIndex: _segmentIndex, lastTokenText: _lastTokenText, ...cue }) => ({ ...cue, text: captionText(cue.text, script) }));
  }
  return (transcript?.segments || []).map(s => ({ text: captionText(s.text, script), start: sourceToOutput(Number(s.start), keeps), end: sourceToOutput(Number(s.end), keeps) })).filter(x => x.text && x.start !== null && x.end !== null);
}
function normalizeCaptionStyle(value) {
  return ["keyword-pop", "clean-card", "static"].includes(value) ? value : "keyword-pop";
}
function captionKeyword(text) {
  const value = String(text || "");
  const preferred = [
    "AI口播工作台", "口播工作台", "管他三七二十一", "真正解决现实问题", "现实问题", "先做起来",
    "Codex", "AI", "短视频", "程序员", "评论区", "工作流", "口播稿", "剪辑视频", "添加字幕", "第一次", "时间"
  ];
  return preferred.find(keyword => value.toLowerCase().includes(keyword.toLowerCase())) || "";
}
function dynamicCaptionCues(job, timeline) {
  return transcriptCues(job.transcript, job.currentPlan.keepSegments, job.script).map(cue => ({
    start: Math.max(0, Number(cue.start)),
    end: Math.min(timeline.outputDuration, Math.max(Number(cue.start) + 0.35, Number(cue.end))),
    text: String(cue.text || "").trim(),
    keyword: captionKeyword(cue.text)
  })).filter(cue => cue.text && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start && cue.start < timeline.outputDuration);
}
async function renderHyperframesCaptions(jobDir, job, timeline, version) {
  const cues = dynamicCaptionCues(job, timeline);
  if (!cues.length) throw new Error("没有可渲染的字幕时间轴");
  const style = normalizeCaptionStyle(job.options.captionStyle);
  const outputDir = path.join(jobDir, "overlays", `v${version}`);
  await fsp.mkdir(outputDir, { recursive: true });
  const storyboard = path.join(jobDir, `captions-v${version}.json`);
  const output = path.join(outputDir, "captions.webm");
  for (const candidate of [...(job.versions || [])].sort((a, b) => Number(b.version) - Number(a.version))) {
    if (candidate.captionPackaging?.engine !== "hyperframes" || candidate.captionPackaging?.style !== style || Number(candidate.version) >= version) continue;
    const candidateStoryboardPath = path.join(jobDir, `captions-v${candidate.version}.json`);
    const candidateVideoPath = path.join(jobDir, "overlays", `v${candidate.version}`, "captions.webm");
    try {
      const candidateStoryboard = JSON.parse(await fsp.readFile(candidateStoryboardPath, "utf8"));
      if (Math.abs(Number(candidateStoryboard.duration) - timeline.outputDuration) > 0.001 || JSON.stringify(candidateStoryboard.cues) !== JSON.stringify(cues)) continue;
      await fsp.copyFile(candidateVideoPath, output);
      const metadata = await probe(output);
      metadata.alpha = candidate.captionPackaging.metadata?.alpha === true;
      metadata.alphaAverage = candidate.captionPackaging.metadata?.alphaAverage;
      if (metadata.width !== 1080 || metadata.height !== 1920 || Math.abs(metadata.duration - timeline.outputDuration) > 0.45 || metadata.alpha !== true) continue;
      await writeJson(storyboard, { version, engine: "hyperframes", style, duration: timeline.outputDuration, cues, reusedFromVersion: candidate.version, generatedAt: new Date().toISOString() });
      return { requested: style, engine: "hyperframes", style, cues: cues.length, path: output, url: `/video-jobs/${path.basename(jobDir)}/overlays/v${version}/captions.webm`, metadata, reusedFromVersion: candidate.version, fallbackReason: null };
    } catch {}
  }
  const projectDir = path.join(outputDir, "captions-project");
  await fsp.mkdir(projectDir, { recursive: true });
  const templatePath = path.join(here, "hyperframes-captions", "index.html");
  let template = await fsp.readFile(templatePath, "utf8");
  if (!template.includes('data-duration="3"')) throw new Error("动态字幕模板缺少可替换的时长声明");
  template = template.replace('data-duration="3"', `data-duration="${timeline.outputDuration.toFixed(3)}"`).replace("../hyperframes-overlay/gsap.min.js", "./gsap.min.js");
  await fsp.writeFile(path.join(projectDir, "index.html"), template, "utf8");
  await fsp.copyFile(path.join(here, "hyperframes-overlay", "gsap.min.js"), path.join(projectDir, "gsap.min.js"));
  await writeJson(storyboard, { version, engine: "hyperframes", style, duration: timeline.outputDuration, cues, generatedAt: new Date().toISOString() });
  const variablesFile = path.join(outputDir, "caption-variables.json");
  await writeJson(variablesFile, { captionsJson: JSON.stringify(cues), duration: timeline.outputDuration, style });
  await run("npx", ["-y", "hyperframes", "render", projectDir, "--output", output, "--format", "webm", "--variables-file", variablesFile, "--workers", "1", "--quiet", "--sdr"], { cwd: root, shell: true });
  const metadata = await probe(output);
  if (!metadata.videoCodec || Math.abs(metadata.duration - timeline.outputDuration) > 0.45 || metadata.width !== 1080 || metadata.height !== 1920) throw new Error("HyperFrames 动态字幕轨的时长或画幅无效");
  const firstCue = cues[0];
  const sampleTime = Math.min(firstCue.end - 0.05, firstCue.start + Math.max(0.2, Math.min(0.5, (firstCue.end - firstCue.start) / 2)));
  const alpha = await run("ffmpeg", ["-hide_banner", "-c:v", "libvpx-vp9", "-ss", sampleTime.toFixed(3), "-i", output, "-vf", "alphaextract,signalstats,metadata=print", "-frames:v", "1", "-f", "null", "-"]);
  const alphaAverage = Number(alpha.stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/)?.[1]);
  if (!Number.isFinite(alphaAverage) || alphaAverage <= 0 || alphaAverage >= 254.5) throw new Error("HyperFrames 动态字幕轨透明像素检查失败");
  metadata.alpha = true;
  metadata.alphaAverage = alphaAverage;
  return { requested: style, engine: "hyperframes", style, cues: cues.length, path: output, url: `/video-jobs/${path.basename(jobDir)}/overlays/v${version}/captions.webm`, metadata, fallbackReason: null };
}
async function writeAss(jobDir, transcript, keeps, overlays, version, script = "", dimensions = { width: 1080, height: 1920 }) {
  const landscape = dimensions.width > dimensions.height;
  const captionFontSize = landscape ? 34 : 56;
  const captionMargin = landscape ? 42 : 180;
  const captionSideMargin = landscape ? 110 : 70;
  const overlayFontSize = landscape ? 42 : 76;
  const overlayMargin = landscape ? 52 : 230;
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${dimensions.width}`, `PlayResY: ${dimensions.height}`, "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]", "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: Caption,Microsoft YaHei,${captionFontSize},&H00FFFFFF,&H000000FF,&H00101010,&H70000000,-1,0,0,0,100,100,1,0,1,3,0,2,${captionSideMargin},${captionSideMargin},${captionMargin},1`,
    `Style: Overlay,Microsoft YaHei,${overlayFontSize},&H00FFFFFF,&H000000FF,&H00000000,&H900F8278,-1,0,0,0,100,100,1,0,3,2,0,8,90,90,${overlayMargin},1`, "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
  ];
  for (const cue of transcriptCues(transcript, keeps, script)) lines.push(`Dialogue: 0,${assTime(cue.start)},${assTime(Math.max(cue.end, cue.start + 0.35))},Caption,,0,0,0,,${assEscape(cue.text)}`);
  for (const overlay of overlays) {
    const start = sourceToOutput(overlay.start, keeps), end = sourceToOutput(overlay.end, keeps);
    if (start !== null && end !== null && end > start) lines.push(`Dialogue: 1,${assTime(start)},${assTime(end)},Overlay,,0,0,0,,{\\fad(180,180)}${assEscape(overlay.text)}`);
  }
  const file = path.join(jobDir, `captions-v${version}.ass`);
  await fsp.writeFile(file, lines.join("\r\n"), "utf8");
  return file;
}
function videoLayoutFilter(layout) {
  if (layout === "landscape-tech") return "split=2[bg][fg];[bg]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,boxblur=28:10,eq=brightness=-0.48:saturation=0.42,drawgrid=w=64:h=64:t=1:c=0x2ED6C4@0.07[bg2];[fg]scale=404:720:force_original_aspect_ratio=decrease,pad=404:720:(ow-iw)/2:(oh-ih)/2:color=0x060A10,eq=saturation=1.05:contrast=1.04[fg2];[bg2]drawbox=x=0:y=0:w=850:h=720:color=0x050A11@0.68:t=fill,drawbox=x=30:y=28:w=790:h=664:color=0x162331@0.42:t=2,drawbox=x=850:y=0:w=4:h=720:color=0xE0A82E@0.9:t=fill[stage];[stage][fg2]overlay=876:0";
  const size = layout === "square" ? "1080:1080" : "1080:1920";
  if (layout === "original") return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  return `split=2[bg][fg];[bg]scale=${size}:force_original_aspect_ratio=increase,crop=${size},boxblur=24:8[bg2];[fg]scale=${size}:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2`;
}
function videoColorPipeline(source = {}) {
  const transfer = String(source.colorTransfer || "").toLowerCase();
  const primaries = String(source.colorPrimaries || "").toLowerCase();
  const hdr = transfer === "arib-std-b67" || transfer === "smpte2084" || primaries === "bt2020";
  if (hdr) return {
    input: transfer === "arib-std-b67" ? "hlg-bt2020" : "hdr-bt2020",
    output: "sdr-bt709",
    engine: "zscale-hable",
    filter: "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
  };
  return { input: "sdr-or-unknown", output: "sdr-bt709", engine: "metadata-normalization", filter: "format=yuv420p" };
}
function splitCoverTitle(value) {
  const text = cleanCoverCopy(value, 42);
  if (!text) return [];
  const explicit = text.split(/[\/｜|]+/).map(item => cleanCoverCopy(item, 14)).filter(Boolean);
  if (explicit.length >= 2) return explicit.slice(0, 3);
  const phrases = text.split(/[，。！？；：—-]+/).map(item => cleanCoverCopy(item, 18)).filter(Boolean);
  const source = phrases.length > 1 ? phrases : [text];
  const lines = [];
  for (const phrase of source) {
    const chars = [...phrase];
    while (chars.length && lines.length < 3) lines.push(chars.splice(0, chars.length > 18 ? 10 : 12).join(""));
    if (lines.length >= 3) break;
  }
  return lines.filter(Boolean).slice(0, 3);
}
function coverDesignForJob(job) {
  const planned = normalizeCoverPlan(job.currentPlan?.coverDesign);
  const script = String(job.script || "");
  const override = cleanCoverCopy(job.options?.coverTitle, 42);
  let lines = override ? splitCoverTitle(override) : planned.lines;
  if (!lines.length && /Codex/i.test(script) && /口播工作台/.test(script)) lines = ["我用 Codex", "做了一个", "AI口播工作台"];
  if (!lines.length) lines = splitCoverTitle(job.options?.contentTitle);
  if (!lines.length) {
    const candidates = script.split(/[。！？\n]+/).map(item => cleanCoverCopy(item, 32)).filter(item => item.length >= 6);
    lines = splitCoverTitle(candidates.find(item => /AI|Codex|工作台|视频|工具|项目/i.test(item)) || candidates[0] || "本期口播实战");
  }
  const highlights = planned.highlights.length ? planned.highlights : ["Codex", "AI", "口播工作台"].filter(item => lines.some(line => line.includes(item)));
  const detectedFeatures = [
    [/口播稿|写稿/, "写稿"], [/剪辑/, "剪辑"], [/字幕/, "字幕"], [/工作流/, "工作流"]
  ].filter(([pattern]) => pattern.test(script)).map(([, label]) => label);
  const firstKeep = job.currentPlan?.keepSegments?.[0] || { start: 0, end: Math.max(1, Number(job.source?.duration || 1)) };
  const preferredTime = firstKeep.start + Math.min(5.2, Math.max(0.5, (firstKeep.end - firstKeep.start) * 0.67));
  const sourceTime = planned.sourceTime !== null && (job.currentPlan?.keepSegments || []).some(item => planned.sourceTime >= item.start && planned.sourceTime <= item.end)
    ? planned.sourceTime
    : preferredTime;
  return {
    eyebrow: planned.eyebrow || (/第一次/.test(script) ? "程序员第一次拍视频" : "本期 AI 实战"),
    lines: lines.slice(0, 3),
    highlights,
    features: (planned.features.length ? planned.features : detectedFeatures).slice(0, 4),
    sourceTime: Number(Math.max(0, sourceTime).toFixed(3)),
    source: override ? "user-override" : planned.lines.length ? "ai-plan" : "local-fallback"
  };
}
function coverAssEscape(value) {
  return String(value || "").replace(/[{}]/g, "").replace(/\\/g, "").replace(/\r?\n/g, " ").trim();
}
function coverLineAss(line, highlights) {
  const value = coverAssEscape(line);
  const highlight = highlights.find(item => value.includes(item));
  if (!highlight) return value;
  const index = value.indexOf(highlight);
  return `${value.slice(0, index)}{\\c&H001FD2FF&}${value.slice(index, index + highlight.length)}{\\c&H00FFFFFF&}${value.slice(index + highlight.length)}`;
}
function coverFontSize(line) {
  const weight = [...String(line || "")].reduce((sum, char) => sum + (/^[\x00-\x7F]$/.test(char) ? 0.56 : 1), 0);
  return weight > 10 ? 72 : weight > 8 ? 82 : 96;
}
async function writeCoverAss(coverDir, design) {
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]", "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Main,Microsoft YaHei,96,&H00FFFFFF,&H000000FF,&H0005080A,&H50000000,-1,0,0,0,100,100,0,0,1,5,3,7,0,0,0,1",
    "Style: Eyebrow,Microsoft YaHei,34,&H00101820,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    "Style: Feature,Microsoft YaHei,40,&H00FFFFFF,&H000000FF,&H0005080A,&H00000000,-1,0,0,0,100,100,0,0,1,1,0,7,0,0,0,1", "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 2,0:00:00.00,0:00:10.00,Eyebrow,,0,0,0,,{\\an7\\pos(88,282)}${coverAssEscape(design.eyebrow)}`
  ];
  design.lines.forEach((line, index) => lines.push(`Dialogue: 2,0:00:00.00,0:00:10.00,Main,,0,0,0,,{\\an7\\pos(65,${370 + index * 125})\\fs${coverFontSize(line)}}${coverLineAss(line, design.highlights)}`));
  if (design.features.length) lines.push(`Dialogue: 2,0:00:00.00,0:00:10.00,Feature,,0,0,0,,{\\an7\\pos(90,1598)}${coverAssEscape(design.features.join("  ·  "))}`);
  const file = path.join(coverDir, "cover.ass");
  await fsp.writeFile(file, lines.join("\r\n"), "utf8");
  return file;
}
async function writeHorizontalCoverAss(coverDir, design, width, suffix) {
  const x = width >= 1900 ? 120 : 70;
  const labelX = x + 25;
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, "PlayResY: 1080", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]", "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Main,Microsoft YaHei,88,&H00FFFFFF,&H000000FF,&H0005080A,&H50000000,-1,0,0,0,100,100,0,0,1,5,3,7,0,0,0,1",
    "Style: Eyebrow,Microsoft YaHei,32,&H00101820,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    "Style: Feature,Microsoft YaHei,36,&H00FFFFFF,&H000000FF,&H0005080A,&H00000000,-1,0,0,0,100,100,0,0,1,1,0,7,0,0,0,1", "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 2,0:00:00.00,0:00:10.00,Eyebrow,,0,0,0,,{\\an7\\pos(${labelX},190)}${coverAssEscape(design.eyebrow)}`
  ];
  design.lines.forEach((line, index) => lines.push(`Dialogue: 2,0:00:00.00,0:00:10.00,Main,,0,0,0,,{\\an7\\pos(${x + 5},${300 + index * 125})\\fs${Math.min(88, coverFontSize(line))}}${coverLineAss(line, design.highlights)}`));
  if (design.features.length) lines.push(`Dialogue: 2,0:00:00.00,0:00:10.00,Feature,,0,0,0,,{\\an7\\pos(${x + 30},865)}${coverAssEscape(design.features.join("  ·  "))}`);
  const file = path.join(coverDir, `cover-${suffix}.ass`);
  await fsp.writeFile(file, lines.join("\r\n"), "utf8");
  return file;
}
async function renderCover(job, version) {
  if (job.options?.generateCover === false) return { requested: false, engine: "none", available: false };
  const jobDir = confined(jobsRoot, job.id);
  const coverDir = path.join(jobDir, "covers", `v${version}`);
  await fsp.mkdir(coverDir, { recursive: true });
  const design = coverDesignForJob(job);
  await writeCoverAss(coverDir, design);
  const labelWidth = Math.min(620, Math.max(360, 82 + [...design.eyebrow].length * 39));
  const featureFilters = design.features.length
    ? ",drawbox=x=65:y=1585:w=500:h=72:color=0x06131D@0.82:t=fill"
    : "";
  const color = videoColorPipeline(job.source);
  const filter = `[0:v]${color.filter}[color];[color]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:8[bg2];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2,eq=brightness=-0.035:saturation=0.84:contrast=1.04,drawbox=x=38:y=245:w=720:h=515:color=0x06131D@0.58:t=fill,drawbox=x=38:y=245:w=9:h=515:color=0x2ED6C4@1:t=fill,drawbox=x=65:y=270:w=${labelWidth}:h=62:color=0xFFAA3C@1:t=fill${featureFilters},ass=filename='cover.ass',format=rgb24[cover]`;
  const png9x16 = path.join(coverDir, `cover-v${version}-9x16.png`);
  const jpg9x16 = path.join(coverDir, `cover-v${version}-9x16.jpg`);
  const png3x4 = path.join(coverDir, `cover-v${version}-3x4.png`);
  const jpg3x4 = path.join(coverDir, `cover-v${version}-3x4.jpg`);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(design.sourceTime), "-i", job.sourcePath, "-filter_complex", filter, "-map", "[cover]", "-frames:v", "1", "-update", "1", png9x16], { cwd: coverDir });
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", png9x16, "-q:v", "2", "-pix_fmt", "yuvj420p", "-frames:v", "1", "-update", "1", jpg9x16]);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", png9x16, "-vf", "crop=1080:1440:0:240", "-frames:v", "1", "-update", "1", png3x4]);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", png3x4, "-q:v", "2", "-pix_fmt", "yuvj420p", "-frames:v", "1", "-update", "1", jpg3x4]);
  const renderHorizontal = async (width, suffix) => {
    await writeHorizontalCoverAss(coverDir, design, width, suffix);
    const panelX = width >= 1900 ? 90 : 40;
    const panelWidth = width >= 1900 ? 890 : 750;
    const labelX = panelX + 55;
    const labelWidthHorizontal = Math.min(panelWidth - 90, Math.max(350, 76 + [...design.eyebrow].length * 36));
    const featureHorizontal = design.features.length ? `,drawbox=x=${labelX}:y=850:w=470:h=68:color=0x06131D@0.82:t=fill` : "";
    const foregroundWidth = Math.round(width * 0.52);
    const horizontalFilter = `[0:v]${color.filter}[color];[color]split=2[bg][fg];[bg]scale=${width}:1080:force_original_aspect_ratio=increase,crop=${width}:1080,boxblur=24:8[bg2];[fg]scale=${foregroundWidth}:1080:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=x=W-w-45:y=(H-h)/2,eq=brightness=-0.045:saturation=0.84:contrast=1.05,drawbox=x=${panelX}:y=150:w=${panelWidth}:h=650:color=0x06131D@0.62:t=fill,drawbox=x=${panelX}:y=150:w=9:h=650:color=0x2ED6C4@1:t=fill,drawbox=x=${labelX}:y=178:w=${labelWidthHorizontal}:h=58:color=0xFFAA3C@1:t=fill${featureHorizontal},ass=filename='cover-${suffix}.ass',format=rgb24[cover]`;
    const png = path.join(coverDir, `cover-v${version}-${suffix}.png`);
    const jpg = path.join(coverDir, `cover-v${version}-${suffix}.jpg`);
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(design.sourceTime), "-i", job.sourcePath, "-filter_complex", horizontalFilter, "-map", "[cover]", "-frames:v", "1", "-update", "1", png], { cwd: coverDir });
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", png, "-q:v", "2", "-pix_fmt", "yuvj420p", "-frames:v", "1", "-update", "1", jpg]);
    return { path: jpg, url: `/video-jobs/${job.id}/covers/v${version}/cover-v${version}-${suffix}.jpg`, pngUrl: `/video-jobs/${job.id}/covers/v${version}/cover-v${version}-${suffix}.png`, metadata: await probe(jpg) };
  };
  const wide16x9 = await renderHorizontal(1920, "16x9");
  const landscape4x3 = await renderHorizontal(1440, "4x3");
  const metadata9x16 = await probe(jpg9x16), metadata3x4 = await probe(jpg3x4);
  const artifact = { version, design, engine: "local-ffmpeg-ass", privacy: "local-frame-only", generatedAt: new Date().toISOString() };
  await writeJson(path.join(jobDir, `cover-design-v${version}.json`), artifact);
  return {
    requested: true,
    available: true,
    engine: "local-ffmpeg-ass",
    design,
    privacy: "local-frame-only",
    vertical: { path: jpg9x16, url: `/video-jobs/${job.id}/covers/v${version}/cover-v${version}-9x16.jpg`, pngUrl: `/video-jobs/${job.id}/covers/v${version}/cover-v${version}-9x16.png`, metadata: metadata9x16 },
    grid: { path: jpg3x4, url: `/video-jobs/${job.id}/covers/v${version}/cover-v${version}-3x4.jpg`, pngUrl: `/video-jobs/${job.id}/covers/v${version}/cover-v${version}-3x4.png`, metadata: metadata3x4 },
    wide16x9,
    landscape4x3
  };
}
function outputToSource(time, keeps) {
  let cursor = 0;
  for (const keep of keeps) {
    const length = keep.end - keep.start;
    if (time >= cursor && time <= cursor + length) return keep.start + time - cursor;
    cursor += length;
  }
  return null;
}
function removedRanges(duration, keeps) {
  const removed = []; let cursor = 0;
  for (const keep of keeps) {
    if (keep.start > cursor + 0.01) removed.push({ start: cursor, end: keep.start, duration: keep.start - cursor, reason: "未被剪辑计划保留" });
    cursor = Math.max(cursor, keep.end);
  }
  if (duration > cursor + 0.01) removed.push({ start: cursor, end: duration, duration: duration - cursor, reason: "未被剪辑计划保留" });
  return removed;
}
function buildTimeline(job, plan, version) {
  let outputCursor = 0;
  const clips = plan.keepSegments.map((segment, index) => {
    const duration = segment.end - segment.start;
    const clip = { id: `clip-${String(index + 1).padStart(3, "0")}`, sourceIn: segment.start, sourceOut: segment.end, outputIn: outputCursor, outputOut: outputCursor + duration, duration, reason: segment.reason };
    outputCursor += duration;
    return clip;
  });
  const cards = (plan.overlayCards || []).map(card => {
    const outputStart = sourceToOutput(card.start, plan.keepSegments);
    return { ...card, outputStart, outputEnd: outputStart === null ? null : Math.min(outputCursor, outputStart + Math.min(3.2, Math.max(0.8, card.end - card.start))) };
  }).filter(card => card.outputStart !== null && card.outputEnd > card.outputStart);
  return {
    version,
    source: { path: job.sourcePath, duration: job.source.duration, width: job.source.width, height: job.source.height, fps: job.source.fps },
    outputDuration: outputCursor,
    provenance: plan.provenance,
    engine: plan.engine,
    validated: plan.validated,
    warnings: plan.warnings || [],
    clips,
    removed: removedRanges(job.source.duration, plan.keepSegments),
    cards,
    generatedAt: new Date().toISOString()
  };
}
function edlTime(seconds, fps = 30) {
  const frames = Math.max(0, Math.round(Number(seconds || 0) * fps));
  const hours = Math.floor(frames / (fps * 3600));
  const minutes = Math.floor((frames % (fps * 3600)) / (fps * 60));
  const secs = Math.floor((frames % (fps * 60)) / fps);
  const frame = frames % fps;
  return [hours, minutes, secs, frame].map(value => String(value).padStart(2, "0")).join(":");
}
async function writeTimelineArtifacts(jobDir, timeline, version) {
  await writeJson(path.join(jobDir, `timeline-v${version}.json`), timeline);
  const edl = [`TITLE: KOUBO_V${version}`, "FCM: NON-DROP FRAME", ""];
  timeline.clips.forEach((clip, index) => {
    edl.push(`${String(index + 1).padStart(3, "0")}  AX       V     C        ${edlTime(clip.sourceIn)} ${edlTime(clip.sourceOut)} ${edlTime(clip.outputIn)} ${edlTime(clip.outputOut)}`);
    edl.push(`* FROM CLIP NAME: ${path.basename(timeline.source.path)}`);
    edl.push(`* COMMENT: ${clip.reason}`);
  });
  await fsp.writeFile(path.join(jobDir, `timeline-v${version}.edl`), edl.join("\r\n"), "utf8");
}

const EXTERNAL_SOURCE_TYPES = new Set(["external-creator", "licensed-external"]);
const PAID_SOURCE_TYPES = new Set(["paid-stock", "paid-generated"]);
const APPROVABLE_LICENSE_BASES = new Set(["explicit-authorization", "creator-permission", "platform-license", "commentary-quotation"]);
function mediaKindFor(fileName = "") {
  const extension = path.extname(String(fileName)).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".bmp"].includes(extension)) return "image";
  if ([".mp4", ".mov", ".mkv", ".webm", ".m4v"].includes(extension)) return "video";
  return "unknown";
}
function normalizePlacement(value) {
  const start = Number(value?.start), end = Number(value?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
  const validModes = new Set(["broll", "pip", "comparison-left", "comparison-right"]);
  return { start, end, mode: validModes.has(value?.mode) ? value.mode : "broll" };
}

function landscapeBeatAnchor(beat = {}, fallback = 0) {
  const text = `${beat.segment || ""} ${beat.asset || ""} ${beat.purpose || ""}`;
  if (/(最终效果|开头结果)/.test(text)) return 0;
  if (/(返修前后验证|同一时间点|指定位置.*对比)/.test(text)) return 0.77;
  if (/(自然语言返修|时间点.*具体问题)/.test(text)) return 0.63;
  if (/(最终人工审核|最终发布|能不能发)/.test(text)) return 0.89;
  if (/(基础版限制|基础字幕|返修前)/.test(text)) return 0.11;
  if (/(三个角色|角色分工|Codex.*HyperFrames)/i.test(text)) return 0.2;
  if (/(完整输入|输入方式|剪辑目标)/.test(text)) return 0.33;
  if (/(AI理解|复述重点|第一版播放)/.test(text)) return 0.45;
  if (/(检查第一版|逐段播放|人工检查)/.test(text)) return 0.53;
  return fallback;
}

function candidatePlacementForBeat(beat, index, count, duration) {
  const safeDuration = Math.max(1, Number(duration || 1));
  const fallback = index / Math.max(1, count);
  const start = Math.min(Math.max(0, safeDuration - 0.5), safeDuration * landscapeBeatAnchor(beat, fallback));
  const visible = Math.max(0.5, Math.min(5.6, safeDuration - start));
  return { start: Number(start.toFixed(2)), end: Number((start + visible).toFixed(2)), mode: "broll" };
}
function normalizeAssetRecord(asset = {}) {
  const reviewStatus = ["pending", "approved", "rejected"].includes(asset.reviewStatus)
    ? asset.reviewStatus
    : asset.approved === true ? "approved" : "pending";
  const sourceType = String(asset.sourceType || (asset.source === "local-upload" ? "local-upload" : "local-upload"));
  const clipStart = Number(asset.clipStart), clipEnd = Number(asset.clipEnd);
  const placement = normalizePlacement(asset.placement);
  return {
    ...asset,
    sourceType,
    mediaKind: asset.mediaKind || mediaKindFor(asset.fileName),
    reviewStatus,
    approved: reviewStatus === "approved",
    placement,
    creatorName: String(asset.creatorName || "").trim(),
    workTitle: String(asset.workTitle || "").trim(),
    sourceUrl: String(asset.sourceUrl || "").trim(),
    usagePurpose: String(asset.usagePurpose || "").trim(),
    licenseBasis: String(asset.licenseBasis || asset.license || "").trim(),
    attributionText: String(asset.attributionText || "").trim(),
    clipStart: Number.isFinite(clipStart) && clipStart >= 0 ? clipStart : 0,
    clipEnd: Number.isFinite(clipEnd) && clipEnd > 0 ? clipEnd : null,
    clipDuration: Number.isFinite(Number(asset.clipDuration)) && Number(asset.clipDuration) > 0
      ? Number(asset.clipDuration)
      : Number.isFinite(clipEnd) && clipEnd > Math.max(0, clipStart) ? clipEnd - Math.max(0, clipStart) : placement ? placement.end - placement.start : null,
    paymentRequired: asset.paymentRequired === true || PAID_SOURCE_TYPES.has(sourceType),
    paymentConfirmed: asset.paymentConfirmed === true,
    generatedLocally: asset.generatedLocally === true,
    discoveredAutomatically: asset.discoveredAutomatically === true
  };
}
function creatorNameIsUsable(value) {
  const name = String(value || "").trim();
  return !!name && !/(待填写|待确认|用户指定参考账号)/.test(name);
}
function advisoryRightsMode(job) { return job?.options?.rightsReviewMode === "advisory"; }
function assetComplianceIssues(rawAsset, job, outputDuration = null) {
  const asset = normalizeAssetRecord(rawAsset);
  const issues = [];
  if (asset.reviewStatus !== "approved") return issues;
  if (!asset.placement) issues.push("缺少有效的成片使用时间段");
  if (asset.placement && Number.isFinite(outputDuration) && asset.placement.end > outputDuration + 0.05) issues.push("使用结束时间超过预计成片时长");
  if (!asset.path || !fs.existsSync(asset.path)) issues.push("缺少可渲染的本地素材文件");
  if (!['image', 'video'].includes(asset.mediaKind)) issues.push("素材必须是图片或视频");
  if (PAID_SOURCE_TYPES.has(asset.sourceType) && !asset.paymentConfirmed) issues.push("付费素材尚未完成费用确认");
  if (EXTERNAL_SOURCE_TYPES.has(asset.sourceType)) {
    if (!creatorNameIsUsable(asset.creatorName)) issues.push("外部素材缺少创作者公开名称");
    if (!asset.workTitle) issues.push("外部素材缺少作品标题");
    if (!/^https?:\/\//i.test(asset.sourceUrl)) issues.push("外部素材缺少有效原链接");
    if (!asset.usagePurpose) issues.push("外部素材缺少具体使用目的");
    if (!advisoryRightsMode(job) && !APPROVABLE_LICENSE_BASES.has(asset.licenseBasis)) issues.push("外部素材缺少可接受的授权或引用依据");
    if (!asset.attributionText || (asset.creatorName && !asset.attributionText.includes(asset.creatorName))) issues.push("画面署名必须包含创作者名称");
    if (!Number.isFinite(Number(asset.clipStart)) || Number(asset.clipStart) < 0) issues.push("外部素材缺少有效截取开始时间");
    if (!Number.isFinite(Number(asset.clipEnd)) || Number(asset.clipEnd) <= Number(asset.clipStart)) issues.push("外部素材缺少有效截取结束时间");
    if (!Number.isFinite(asset.clipDuration) || asset.clipDuration <= 0) issues.push("外部素材缺少引用片段时长");
    if (Number.isFinite(Number(asset.clipEnd)) && Number.isFinite(asset.clipDuration) && Math.abs((Number(asset.clipEnd) - Number(asset.clipStart)) - Number(asset.clipDuration)) > 0.15) issues.push("引用片段时长与截取起止时间不一致");
    if (asset.mediaKind === "video" && asset.placement && Number.isFinite(asset.clipDuration) && Number(asset.clipDuration) + 0.05 < asset.placement.end - asset.placement.start) issues.push("引用片段短于成片中的使用时长");
    if (!advisoryRightsMode(job) && (!creatorNameIsUsable(asset.creatorName) || !String(job.script || "").includes(asset.creatorName))) issues.push("口播稿没有自然说明所采用的创作者名称");
    if (asset.licenseBasis === "commentary-quotation") {
      if (!/(介绍|评论|分析|说明|拆解)/.test(asset.usagePurpose)) issues.push("评论性引用必须写明介绍、评论、分析、说明或拆解目的");
      if (Number(asset.clipDuration) > 10.01) issues.push("本工作流将未明确授权的评论性引用限制为单段10秒以内");
    }
  }
  return [...new Set(issues)];
}
function assetReviewSummary(job, outputDuration = null) {
  const assets = (job.assets || []).map(normalizeAssetRecord);
  const pending = assets.filter(asset => asset.reviewStatus === "pending");
  const approved = assets.filter(asset => asset.reviewStatus === "approved");
  const rejected = assets.filter(asset => asset.reviewStatus === "rejected");
  const complianceIssues = approved.flatMap(asset => assetComplianceIssues(asset, job, outputDuration).map(issue => ({ assetId: asset.id, issue })));
  return {
    total: assets.length,
    pending: pending.length,
    approved: approved.length,
    rejected: rejected.length,
    reviewComplete: assets.length > 0 && pending.length === 0,
    renderReady: assets.length > 0 && pending.length === 0 && complianceIssues.length === 0,
    complianceIssues
  };
}
function candidatePlacement(index, count, duration) {
  const safeDuration = Math.max(1, Number(duration || 1));
  const slot = safeDuration / Math.max(1, count);
  const start = Math.min(Math.max(0, safeDuration - 0.5), slot * index);
  const visible = Math.max(0.5, Math.min(4, slot));
  return { start: Number(start.toFixed(2)), end: Number(Math.min(safeDuration, start + visible).toFixed(2)), mode: "broll" };
}
function outputTimeToSource(job, outputTime) {
  let cursor = 0;
  for (const segment of job.currentPlan?.keepSegments || []) {
    const duration = Math.max(0, Number(segment.end) - Number(segment.start));
    if (outputTime <= cursor + duration) return Math.max(Number(segment.start), Number(segment.start) + outputTime - cursor);
    cursor += duration;
  }
  return Math.max(0, Math.min(Number(job.source?.duration || 0) - 0.2, Number(outputTime || 0)));
}
function richVisualArchetype(beat = {}, index = 0) {
  const text = `${beat.segment || ""} ${beat.asset || ""} ${beat.purpose || ""}`;
  if (/(角色|分工|Codex|HyperFrames|转录|渲染)/i.test(text)) return "workflow-map";
  if (/(自然语言返修|完整输入|输入方式|提示|告诉AI|提交|时间点.*具体问题|素材与目标)/i.test(text)) return "prompt-console";
  if (/(最终人工审核|检查第一版|审核|字幕核对|遮挡检查|裁切检查)/i.test(text)) return "review-scan";
  if (index === 0 || /(最终效果|前后验证|同一时间点|基础版限制|返修版)/.test(text)) return "proof-comparison";
  return "screen-demo";
}
function richVisualCopy(archetype, beat = {}) {
  const title = String(beat.segment || "AI剪辑视觉证据").trim();
  const variants = {
    "proof-comparison": { kicker: "同一段口播 · 实际效果", headline: "左边原片，右边AI剪辑后", chips: ["动态字幕", "重点卡片", "节奏变化"] },
    "workflow-map": { kicker: "不是一个AI包办", headline: "理解 → 动效 → 交付", chips: ["读懂内容", "生成视觉", "本地渲染"] },
    "prompt-console": { kicker: "把成片标准一起交给AI", headline: "原片 + 重点 + 视觉要求", chips: ["不改原意", "重点动态化", "横竖屏输出"] },
    "review-scan": { kicker: "第一版不能只看导出成功", headline: "逐项检查，再具体返修", chips: ["字幕", "遮挡", "切换", "裁切"] },
    "screen-demo": { kicker: "真实工作流画面", headline: title, chips: ["原片", "AI理解", "视觉结果"] }
  };
  return { title, ...(variants[archetype] || variants["screen-demo"]) };
}

function landscapeHudTitle(value = "") {
  const text = String(value || "").trim();
  const mappings = [
    [/最终效果|0—8秒/, "先看最终效果"],
    [/基础版限制/, "第一版不等于成片"],
    [/三个角色/, "AI剪辑的四个角色"],
    [/完整输入/, "把成片标准一起交给AI"],
    [/AI理解/, "先复述重点，再生成第一版"],
    [/检查第一版/, "逐项检查，记录时间点"],
    [/自然语言返修/, "返修只需要三段式"],
    [/返修前后验证/, "回到同一位置做对比"],
    [/最终人工审核/, "AI生成，人决定交付"]
  ];
  return mappings.find(([pattern]) => pattern.test(text))?.[1] || text || "AI口播剪辑实战";
}

async function writeLandscapeHudAss(jobDir, job, timeline, version) {
  const approved = (job.assets || [])
    .filter(asset => asset.reviewStatus === "approved" && asset.placement && !EXTERNAL_SOURCE_TYPES.has(asset.sourceType))
    .sort((a, b) => Number(a.placement.start) - Number(b.placement.start));
  const unique = [];
  for (const asset of approved) {
    if (unique.some(item => Math.abs(Number(item.placement.start) - Number(asset.placement.start)) < 0.4)) continue;
    unique.push(asset);
  }
  if (!unique.length) return null;
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1280", "PlayResY: 720", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]", "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: HudKicker,Microsoft YaHei,20,&H002ED6C4,&H000000FF,&H00101920,&H00000000,-1,0,0,0,100,100,1,0,1,1,0,7,60,60,0,1",
    "Style: HudTitle,Microsoft YaHei,44,&H00FFFFFF,&H000000FF,&H00101920,&H00000000,-1,0,0,0,100,100,1,0,1,2,0,7,60,60,0,1",
    "Style: HudChip,Microsoft YaHei,22,&H00FFFFFF,&H000000FF,&H00101920,&HA00B1924,-1,0,0,0,100,100,1,0,3,1,0,7,60,60,0,1",
    "Style: HudStep,Consolas,18,&H00E0A82E,&H000000FF,&H00101920,&H00000000,-1,0,0,0,100,100,2,0,1,1,0,7,60,60,0,1", "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
  ];
  unique.forEach((asset, index) => {
    const start = Math.max(0, Number(asset.placement.start || 0));
    const end = index + 1 < unique.length ? Math.max(start + 0.8, Number(unique[index + 1].placement.start || timeline.outputDuration)) : timeline.outputDuration;
    const title = landscapeHudTitle(asset.title || asset.fileName);
    const copy = richVisualCopy(asset.visualArchetype || "screen-demo", { segment: asset.title || title });
    const fade = "{\\fad(220,180)}";
    lines.push(`Dialogue: 1,${assTime(start)},${assTime(end)},HudStep,,0,0,0,,{\\pos(66,72)}${fade}SECTION ${String(index + 1).padStart(2, "0")}  /  ${String(unique.length).padStart(2, "0")}`);
    lines.push(`Dialogue: 1,${assTime(start)},${assTime(end)},HudKicker,,0,0,0,,{\\pos(66,118)}${fade}DAY 02 · AI口播剪辑实验`);
    lines.push(`Dialogue: 1,${assTime(start)},${assTime(end)},HudTitle,,0,0,0,,{\\pos(66,190)}${fade}${assEscape(wrapCardText(title, 14, 2))}`);
    copy.chips.slice(0, 3).forEach((chip, chipIndex) => {
      lines.push(`Dialogue: 1,${assTime(start + 0.12 + chipIndex * 0.08)},${assTime(end)},HudChip,,0,0,0,,{\\pos(70,${390 + chipIndex * 66})}${fade}  ${assEscape(chip)}  `);
    });
  });
  const file = path.join(jobDir, `landscape-hud-v${version}.ass`);
  await fsp.writeFile(file, lines.join("\r\n"), "utf8");
  return file;
}
async function writeRichCandidateAss(dir, asset, archetype, beat, duration, layout = "vertical") {
  const assFile = path.join(dir, `${asset.id}.ass`);
  const copy = richVisualCopy(archetype, beat);
  if (layout === "landscape-tech") {
    const chips = copy.chips.slice(0, 4);
    const chipPositions = archetype === "review-scan"
      ? [[820, 270], [820, 350], [820, 430], [820, 510]]
      : [[80, 586], [310, 586], [540, 586], [770, 586]];
    const lines = [
      "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1280", "PlayResY: 720", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
      "[V4+ Styles]", "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
      "Style: Kicker,Microsoft YaHei,22,&H002ED6C4,&H000000FF,&H00101920,&H00000000,-1,0,0,0,100,100,1,0,1,1,0,7,48,48,0,1",
      "Style: Headline,Microsoft YaHei,38,&H00FFFFFF,&H000000FF,&H00101920,&H00000000,-1,0,0,0,100,100,1,0,1,2,0,7,48,48,0,1",
      "Style: Chip,Microsoft YaHei,20,&H00FFFFFF,&H000000FF,&H00101920,&HA0060A10,-1,0,0,0,100,100,1,0,3,1,0,5,16,16,10,1",
      "Style: Label,Microsoft YaHei,20,&H00FFFFFF,&H000000FF,&H00101920,&HA0060A10,-1,0,0,0,100,100,1,0,3,1,0,5,16,16,10,1", "",
      "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
      `Dialogue: 5,0:00:00.05,0:00:0${duration.toFixed(2)},Kicker,,0,0,0,,{\\pos(48,48)\\fad(180,180)}${assEscape(copy.kicker)}`,
      `Dialogue: 5,0:00:00.16,0:00:0${duration.toFixed(2)},Headline,,0,0,0,,{\\pos(48,88)\\fad(220,180)}${assEscape(wrapCardText(copy.headline, 22, 2))}`
    ];
    if (archetype === "proof-comparison") {
      lines.push(`Dialogue: 6,0:00:00.35,0:00:0${duration.toFixed(2)},Label,,0,0,0,,{\\pos(330,205)\\fad(140,160)}原片`);
      lines.push(`Dialogue: 6,0:00:00.55,0:00:0${duration.toFixed(2)},Label,,0,0,0,,{\\pos(950,205)\\fad(140,160)}AI剪辑后`);
    } else if (archetype === "workflow-map") {
      [[420, 226, "01  Codex · 接收目标 / 串联流程"], [420, 331, "02  视频理解 · 识别重点 / 定位停顿"], [420, 436, "03  HyperFrames · 动态字幕 / 重点卡片"], [420, 529, "04  本地渲染 · 16:9成片 / QA"]].forEach(([x, y, text], index) => {
        lines.push(`Dialogue: 6,0:00:0${(0.42 + index * 0.22).toFixed(2)},0:00:0${duration.toFixed(2)},Label,,0,0,0,,{\\pos(${x},${y})\\fad(150,180)}${assEscape(text)}`);
      });
    } else if (archetype === "prompt-console") {
      [[225, 230, "01 上传真人口播"], [225, 292, "02 说清主题与重点"], [225, 354, "03 指定视觉和画幅"], [225, 416, "04 先复述，再生成"]].forEach(([x, y, text], index) => {
        lines.push(`Dialogue: 6,0:00:0${(0.42 + index * 0.2).toFixed(2)},0:00:0${duration.toFixed(2)},Label,,0,0,0,,{\\pos(${x},${y})\\fad(150,180)}${assEscape(text)}`);
      });
    } else if (archetype === "review-scan") {
      lines.push(`Dialogue: 6,0:00:00.36,0:00:0${duration.toFixed(2)},Label,,0,0,0,,{\\pos(820,205)\\fad(140,160)}逐项检查 · 记录时间点`);
    } else {
      lines.push(`Dialogue: 6,0:00:00.36,0:00:0${duration.toFixed(2)},Label,,0,0,0,,{\\pos(390,270)\\fad(140,160)}先核对AI理解，再看第一版`);
    }
    chips.forEach((chip, index) => {
      const [x, y] = chipPositions[index] || [80 + index * 230, 586];
      const start = 0.65 + index * 0.34;
      lines.push(`Dialogue: 7,0:00:0${start.toFixed(2)},0:00:0${duration.toFixed(2)},Chip,,0,0,0,,{\\pos(${x},${y})\\fad(160,180)\\fscx112\\fscy112\\t(0,220,\\fscx100\\fscy100)}${assEscape(chip)}`);
    });
    await fsp.writeFile(assFile, lines.join("\r\n"), "utf8");
    return assFile;
  }
  const chipPositions = archetype === "workflow-map"
    ? [[120, 1030], [360, 1030], [600, 1030]]
    : archetype === "review-scan"
      ? [[390, 520], [390, 650], [390, 780], [390, 910]]
      : [[110, 1050], [360, 1050], [610, 1050]];
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 720", "PlayResY: 1280", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]", "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Kicker,Microsoft YaHei,26,&H003ADCC8,&H000000FF,&H00101920,&H00000000,-1,0,0,0,100,100,1,0,1,1,0,7,54,54,0,1",
    "Style: Headline,Microsoft YaHei,48,&H00FFFFFF,&H000000FF,&H00101920,&H00000000,-1,0,0,0,100,100,1,0,1,2,0,7,54,54,0,1",
    "Style: Chip,Microsoft YaHei,25,&H00FFFFFF,&H000000FF,&H00101920,&H9007131D,-1,0,0,0,100,100,1,0,3,1,0,5,20,20,16,1",
    "Style: Label,Microsoft YaHei,24,&H00FFFFFF,&H000000FF,&H00101920,&H9007131D,-1,0,0,0,100,100,1,0,3,1,0,5,20,20,12,1", "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 5,0:00:00.05,0:00:0${duration.toFixed(2)},Kicker,,0,0,0,,{\\pos(54,75)\\fad(180,180)}${assEscape(copy.kicker)}`,
    `Dialogue: 5,0:00:00.18,0:00:0${duration.toFixed(2)},Headline,,0,0,0,,{\\pos(54,125)\\fad(220,180)}${assEscape(wrapCardText(copy.headline, 13, 2))}`
  ];
  if (archetype === "proof-comparison") {
    lines.push(`Dialogue: 6,0:00:00.35,0:00:0${duration.toFixed(2)},Label,,0,0,0,,{\\pos(180,320)\\fad(140,160)}原片`);
    lines.push(`Dialogue: 6,0:00:00.55,0:00:0${duration.toFixed(2)},Label,,0,0,0,,{\\pos(540,320)\\fad(140,160)}AI剪辑后`);
  }
  copy.chips.forEach((chip, index) => {
    const [x, y] = chipPositions[index] || [110 + index * 220, 1050];
    const start = 0.65 + index * 0.42;
    lines.push(`Dialogue: 7,0:00:0${start.toFixed(2)},0:00:0${duration.toFixed(2)},Chip,,0,0,0,,{\\pos(${x},${y})\\fad(180,180)\\fscx110\\fscy110\\t(0,220,\\fscx100\\fscy100)}${assEscape(chip)}`);
  });
  await fsp.writeFile(assFile, lines.join("\r\n"), "utf8");
  return assFile;
}
async function writeGeneratedMotionCandidate(job, asset, beat, index) {
  if (!job.sourcePath || !fs.existsSync(job.sourcePath)) throw new Error("缺少真人原片，无法生成富媒体候选");
  const dir = path.join(confined(jobsRoot, job.id), "assets", "generated");
  await fsp.mkdir(dir, { recursive: true });
  const landscape = job.options?.layout === "landscape-tech";
  const duration = Math.max(3.2, Math.min(landscape ? 5.6 : 4, Number(asset.placement?.end || 4) - Number(asset.placement?.start || 0)));
  asset.placement.end = Number((asset.placement.start + duration).toFixed(2));
  const archetype = richVisualArchetype(beat, index);
  const sourceStart = outputTimeToSource(job, asset.placement.start);
  const assFile = await writeRichCandidateAss(dir, asset, archetype, beat, duration, job.options?.layout);
  const output = path.join(dir, `${asset.id}.mp4`);
  if (landscape) {
    const techBg = "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,boxblur=30:10,eq=brightness=-0.48:saturation=0.42,drawgrid=w=64:h=64:t=1:c=0x2ED6C4@0.07";
    const evidenceImage = [
      path.join(confined(jobsRoot, job.id), "assets", "generated", "day2-workbench-viewport-v2.png"),
      path.join(confined(jobsRoot, job.id), "assets", "generated", "day2-workbench-viewport.png")
    ].find(candidate => fs.existsSync(candidate));
    const useEvidenceImage = !!evidenceImage && ["prompt-console", "review-scan", "screen-demo"].includes(archetype);
    let landscapeFilter;
    if (archetype === "proof-comparison") {
      landscapeFilter = `[0:v]split=3[bg][left][right];[bg]${techBg}[bg0];[left]scale=560:315:force_original_aspect_ratio=increase,crop=560:315,eq=saturation=0.38:contrast=0.92[left0];[right]scale=560:315:force_original_aspect_ratio=increase,crop=560:315,eq=saturation=1.15:contrast=1.08,unsharp=5:5:0.65[right0];[bg0]drawbox=x=38:y=185:w=584:h=349:color=0x8D9AA5@0.65:t=3,drawbox=x=658:y=185:w=584:h=349:color=0xE0A82E@0.95:t=4[stage];[stage][left0]overlay=50:202[tmp];[tmp][right0]overlay=670:202,drawbox=x='670+mod(t*180,520)':y=528:w=36:h=5:color=0x2ED6C4@1:t=fill,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
    } else if (archetype === "workflow-map") {
      landscapeFilter = `[0:v]split=2[bg][speaker];[bg]${techBg}[bg0];[speaker]scale=360:640:force_original_aspect_ratio=decrease,pad=360:640:(ow-iw)/2:(oh-ih)/2:color=0x060A10,eq=saturation=1.06[speaker0];[bg0]drawbox=x=48:y=185:w=740:h=84:color=0x0D1B27@0.96:t=fill,drawbox=x=48:y=290:w=740:h=84:color=0x102432@0.96:t=fill,drawbox=x=48:y=395:w=740:h=84:color=0x0D1B27@0.96:t=fill,drawbox=x=48:y=500:w=740:h=58:color=0x102432@0.96:t=fill,drawbox=x=46:y=183:w=744:h=379:color=0x2ED6C4@0.65:t=2,drawbox=x='65+mod(t*190,690)':y=548:w=45:h=6:color=0xE0A82E@1:t=fill[stage];[stage][speaker0]overlay=872:40,drawbox=x=868:y=36:w=368:h=648:color=0xE0A82E@0.88:t=3,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
    } else if (archetype === "prompt-console" && useEvidenceImage) {
      landscapeFilter = `[0:v]split=2[bg][speaker];[bg]${techBg}[bg0];[speaker]scale=340:604:force_original_aspect_ratio=decrease,pad=340:604:(ow-iw)/2:(oh-ih)/2:color=0x060A10[speaker0];[1:v]scale=760:390:force_original_aspect_ratio=decrease,pad=760:390:(ow-iw)/2:(oh-ih)/2:color=0xF3F5F7,trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS[evidence];[bg0]drawbox=x=48:y=165:w=790:h=410:color=0x07131D@0.96:t=fill,drawbox=x=48:y=165:w=790:h=410:color=0x2ED6C4@0.72:t=3[stage];[stage][evidence]overlay=63:180[tmp];[tmp][speaker0]overlay=890:68,drawbox=x=886:y=64:w=348:h=612:color=0xE0A82E@0.88:t=3,drawbox=x='75+mod(t*150,720)':y=548:w=42:h=5:color=0xE0A82E@1:t=fill,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
    } else if (archetype === "prompt-console") {
      landscapeFilter = `[0:v]split=2[bg][speaker];[bg]${techBg}[bg0];[speaker]scale=340:604:force_original_aspect_ratio=decrease,pad=340:604:(ow-iw)/2:(oh-ih)/2:color=0x060A10[speaker0];[bg0]drawbox=x=48:y=170:w=790:h=375:color=0x07131D@0.96:t=fill,drawbox=x=48:y=170:w=790:h=375:color=0x2ED6C4@0.72:t=3,drawbox=x='92+mod(t*145,650)':y=492:w=5:h=32:color=0xE0A82E@1:t=fill[stage];[stage][speaker0]overlay=890:68,drawbox=x=886:y=64:w=348:h=612:color=0xE0A82E@0.88:t=3,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
    } else if (archetype === "review-scan" && useEvidenceImage) {
      landscapeFilter = `[0:v]split=2[bg][speaker];[bg]${techBg}[bg0];[speaker]scale=300:534:force_original_aspect_ratio=decrease,pad=300:534:(ow-iw)/2:(oh-ih)/2:color=0x060A10[speaker0];[1:v]scale=800:440:force_original_aspect_ratio=decrease,pad=800:440:(ow-iw)/2:(oh-ih)/2:color=0xF3F5F7,trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS[evidence];[bg0]drawbox=x=48:y=165:w=830:h=470:color=0x07131D@0.94:t=fill,drawbox=x=48:y=165:w=830:h=470:color=0x2ED6C4@0.65:t=3[stage];[stage][evidence]overlay=63:180[tmp];[tmp][speaker0]overlay=925:116,drawbox=x=921:y=112:w=308:h=542:color=0xE0A82E@0.88:t=3,drawbox=x=75:y='195+mod(t*120,400)':w=770:h=4:color=0xE0A82E@0.95:t=fill,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
    } else if (archetype === "review-scan") {
      landscapeFilter = `[0:v]split=2[bg][speaker];[bg]${techBg}[bg0];[speaker]scale=340:604:force_original_aspect_ratio=decrease,pad=340:604:(ow-iw)/2:(oh-ih)/2:color=0x060A10[speaker0];[bg0]drawbox=x=430:y=185:w=800:h=380:color=0x07131D@0.94:t=fill,drawbox=x=430:y=185:w=800:h=380:color=0x2ED6C4@0.65:t=3,drawbox=x=465:y='210+mod(t*130,320)':w=720:h=4:color=0xE0A82E@0.95:t=fill[stage];[stage][speaker0]overlay=48:68,drawbox=x=44:y=64:w=348:h=612:color=0xE0A82E@0.88:t=3,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
    } else {
      landscapeFilter = `[0:v]split=2[bg][speaker];[bg]${techBg}[bg0];[speaker]scale=360:640:force_original_aspect_ratio=decrease,pad=360:640:(ow-iw)/2:(oh-ih)/2:color=0x060A10[speaker0];[bg0]drawbox=x=48:y=185:w=760:h=360:color=0x07131D@0.92:t=fill,drawbox=x=48:y=185:w=760:h=360:color=0x2ED6C4@0.58:t=3,drawbox=x=82:y=245:w=620:h=18:color=0xFFFFFF@0.14:t=fill,drawbox=x=82:y=320:w=560:h=18:color=0xFFFFFF@0.10:t=fill,drawbox=x=82:y=395:w='150+min(t,3.2)*150':h=52:color=0x2ED6C4@0.75:t=fill[stage];[stage][speaker0]overlay=872:40,drawbox=x=868:y=36:w=368:h=648:color=0xE0A82E@0.88:t=3,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
    }
    const landscapeInputs = ["-ss", sourceStart.toFixed(3), "-t", duration.toFixed(3), "-i", job.sourcePath, ...(useEvidenceImage ? ["-loop", "1", "-t", duration.toFixed(3), "-i", evidenceImage] : [])];
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...landscapeInputs, "-filter_complex", landscapeFilter, "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-movflags", "+faststart", output], { cwd: dir });
    await run("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
    asset.path = output;
    asset.url = `/video-jobs/${job.id}/assets/generated/${asset.id}.mp4`;
    asset.fileName = `${asset.id}.mp4`;
    asset.mediaKind = "video";
    asset.previewUrl = asset.url;
    asset.visualArchetype = archetype;
    asset.clipStart = 0;
    asset.clipEnd = duration;
    asset.clipDuration = duration;
    asset.generationEngine = "ffmpeg-landscape-tech-motion";
    return;
  }
  const commonBg = "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=22:8,eq=brightness=-0.18:saturation=0.72";
  let filter;
  if (archetype === "proof-comparison") {
    filter = `[0:v]split=3[bg][left][right];[bg]${commonBg}[bg0];[left]scale=340:604:force_original_aspect_ratio=increase,crop=340:604,eq=saturation=0.38:contrast=0.9[left0];[right]scale=340:604:force_original_aspect_ratio=increase,crop=340:604,eq=saturation=1.18:contrast=1.08,unsharp=5:5:0.65[right0];[bg0][left0]overlay=14:350[tmp];[tmp][right0]overlay=366:350,drawbox=x=12:y=348:w=344:h=608:color=0x9AA9B5@0.7:t=3,drawbox=x=364:y=348:w=344:h=608:color=0x2ED6C4@0.95:t=4,drawbox=x='364+mod(t*150,330)':y=936:w=24:h=5:color=0xFFAA3C@1:t=fill,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
  } else if (archetype === "workflow-map") {
    filter = `[0:v]split=2[bg][fg];[bg]${commonBg}[bg0];[fg]scale=610:720:force_original_aspect_ratio=increase,crop=610:720,eq=saturation=1.08[fg0];[bg0][fg0]overlay=55:240,drawbox=x=52:y=237:w=616:h=726:color=0x2ED6C4@0.85:t=4,drawbox=x=55:y=990:w=190:h=105:color=0x102D3D@0.96:t=fill,drawbox=x=265:y=990:w=190:h=105:color=0x17364A@0.96:t=fill,drawbox=x=475:y=990:w=190:h=105:color=0x102D3D@0.96:t=fill,drawbox=x='80+mod(t*175,540)':y=1125:w=44:h=8:color=0xFFAA3C@1:t=fill,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
  } else if (archetype === "prompt-console") {
    filter = `[0:v]${commonBg},drawbox=x=48:y=220:w=624:h=790:color=0x081824@0.94:t=fill,drawbox=x=48:y=220:w=624:h=790:color=0x2ED6C4@0.72:t=4,drawbox=x=78:y=350:w=500:h=18:color=0xFFFFFF@0.16:t=fill,drawbox=x=78:y=420:w=560:h=18:color=0xFFFFFF@0.12:t=fill,drawbox=x=78:y=490:w=420:h=18:color=0xFFFFFF@0.12:t=fill,drawbox=x=78:y=560:w=530:h=18:color=0xFFFFFF@0.12:t=fill,drawbox=x=78:y=650:w='120+min(t,2.8)*145':h=54:color=0x2ED6C4@0.82:t=fill,drawbox=x='90+mod(t*125,500)':y=740:w=5:h=68:color=0xFFAA3C@1:t=fill,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
  } else if (archetype === "review-scan") {
    filter = `[0:v]split=2[bg][fg];[bg]${commonBg}[bg0];[fg]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,eq=saturation=0.9[fg0];[bg0][fg0]overlay=0:0,drawbox=x=330:y=340:w=340:h=680:color=0x07131D@0.90:t=fill,drawbox=x=330:y=340:w=340:h=680:color=0x2ED6C4@0.75:t=3,drawbox=x=350:y='370+mod(t*175,600)':w=300:h=4:color=0xFFAA3C@0.95:t=fill,drawbox=x=54:y=1040:w='40+min(t,3.2)*175':h=10:color=0x2ED6C4@0.9:t=fill,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
  } else {
    filter = `[0:v]split=2[bg][fg];[bg]${commonBg}[bg0];[fg]scale=610:1084:force_original_aspect_ratio=increase,crop=610:1084,eq=saturation=1.08[fg0];[bg0][fg0]overlay=55:175,drawbox=x=52:y=172:w=616:h=1090:color=0x2ED6C4@0.82:t=4,drawbox=x='70+mod(t*145,560)':y=1160:w=60:h=8:color=0xFFAA3C@1:t=fill,ass=filename='${path.basename(assFile)}',fps=30,format=yuv420p[v]`;
  }
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", sourceStart.toFixed(3), "-t", duration.toFixed(3), "-i", job.sourcePath, "-filter_complex", filter, "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-movflags", "+faststart", output], { cwd: dir });
  await run("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
  asset.path = output;
  asset.url = `/video-jobs/${job.id}/assets/generated/${asset.id}.mp4`;
  asset.fileName = `${asset.id}.mp4`;
  asset.mediaKind = "video";
  asset.previewUrl = asset.url;
  asset.visualArchetype = archetype;
  asset.clipStart = 0;
  asset.clipEnd = duration;
  asset.clipDuration = duration;
  asset.generationEngine = "ffmpeg-rich-motion";
}
function wrapCardText(value, width, maxLines) {
  const chars = [...String(value || "").trim()];
  const lines = [];
  while (chars.length && lines.length < maxLines) lines.push(chars.splice(0, width).join(""));
  if (chars.length && lines.length) lines[lines.length - 1] = `${[...lines[lines.length - 1]].slice(0, Math.max(1, width - 1)).join("")}…`;
  return lines.join("\n");
}
async function writeGeneratedCandidateCard(job, asset, title, purpose) {
  const dir = path.join(confined(jobsRoot, job.id), "assets", "generated");
  await fsp.mkdir(dir, { recursive: true });
  const assFile = path.join(dir, `${asset.id}.ass`), output = path.join(dir, `${asset.id}.png`);
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]", "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Tag,Microsoft YaHei,34,&H00101820,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,1,0,1,0,0,7,90,90,0,1",
    "Style: Title,Microsoft YaHei,76,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,1,0,1,2,0,7,90,90,0,1",
    "Style: Body,Microsoft YaHei,42,&H00D9E7EF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,1,0,1,0,0,7,90,90,0,1", "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 1,0:00:00.00,0:00:01.00,Tag,,0,0,0,,{\\pos(95,315)}AI 自动准备 · 本地零费用`,
    `Dialogue: 1,0:00:00.00,0:00:01.00,Title,,0,0,0,,{\\pos(95,455)}${assEscape(wrapCardText(title, 12, 2))}`,
    `Dialogue: 1,0:00:00.00,0:00:01.00,Body,,0,0,0,,{\\pos(95,690)}${assEscape(wrapCardText(purpose, 18, 3))}`
  ];
  await fsp.writeFile(assFile, lines.join("\r\n"), "utf8");
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x07131D:s=1080x1920:d=1", "-vf", `drawbox=x=70:y=270:w=940:h=650:color=0x0D2635@1:t=fill,drawbox=x=70:y=270:w=10:h=650:color=0x2ED6C4@1:t=fill,drawbox=x=90:y=300:w=455:h=62:color=0xFFAA3C@1:t=fill,ass=filename='${path.basename(assFile)}'`, "-frames:v", "1", "-update", "1", output], { cwd: dir });
  asset.path = output;
  asset.url = `/video-jobs/${job.id}/assets/generated/${asset.id}.png`;
  asset.fileName = `${asset.id}.png`;
  asset.mediaKind = "image";
  asset.previewUrl = asset.url;
}
async function discoverLocalProjectAssets(job) {
  if (!job.contentId) return [];
  const dir = confined(contentRoot, safeName(job.contentId));
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter(entry => entry.isFile() && ["image", "video"].includes(mediaKindFor(entry.name))).slice(0, 6).map((entry, index) => ({
    id: `local-${crypto.randomBytes(4).toString("hex")}`,
    fileName: entry.name,
    path: path.join(dir, entry.name),
    url: `/content-items/${safeName(job.contentId)}/${encodeURIComponent(entry.name)}`,
    previewUrl: `/content-items/${safeName(job.contentId)}/${encodeURIComponent(entry.name)}`,
    sourceType: "local-derived",
    sourceLabel: "当前内容包本地素材",
    mediaKind: mediaKindFor(entry.name),
    title: `本地证据素材 ${index + 1}`,
    usagePurpose: "展示本次口播对应的真实项目证据",
    licenseBasis: "user-owned-local",
    ownership: "user-owned-local",
    reviewStatus: "pending",
    approved: false,
    discoveredAutomatically: true,
    placement: null,
    createdAt: new Date().toISOString()
  }));
}
async function prepareAssetCandidates(job, { force = false, reason = "" } = {}) {
  if (job.assetDiscovery?.preparedAt && !force) return job.assetDiscovery;
  if (force) {
    job.assetHistory = [...(job.assetHistory || []), {
      archivedAt: new Date().toISOString(),
      reason: reason || "重新发现素材",
      discovery: job.assetDiscovery || null,
      assets: job.assets || []
    }];
    job.assets = (job.assets || []).filter(asset => asset.discoveredAutomatically !== true);
    delete job.assetDiscovery;
  }
  const duration = (job.currentPlan?.keepSegments || []).reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || Number(job.source?.duration || 0);
  const beats = (job.contentDirection?.shooting?.visualBeats || []).filter(item => item && (item.asset || item.purpose)).slice(0, job.options?.layout === "landscape-tech" ? 10 : 6);
  const assets = [];
  const visualNodes = (beats.length ? beats : (job.currentPlan?.overlayCards || []).map(card => ({ segment: card.text, asset: card.text, purpose: "强化当前口播重点" }))).slice(0, job.options?.layout === "landscape-tech" ? 10 : 6);
  if (!visualNodes.length) visualNodes.push({ segment: "开头结果", asset: "本次口播的核心结果信息卡", purpose: "让观众先看到本条视频要交付的结果" });
  for (const [index, beat] of visualNodes.entries()) {
    const asset = {
      id: `generated-${crypto.randomBytes(4).toString("hex")}`,
      sourceType: "local-derived",
      sourceLabel: "真实原片衍生动态素材",
      title: String(beat.segment || `视觉节点 ${index + 1}`),
      usagePurpose: String(beat.purpose || beat.asset || "强化当前口播内容"),
      requestedAsset: String(beat.asset || "本地信息卡"),
      licenseBasis: "user-owned-local",
      ownership: "user-owned-local",
      reviewStatus: "pending",
      approved: false,
      generatedLocally: true,
      discoveredAutomatically: true,
      paymentRequired: false,
      paymentConfirmed: true,
      placement: job.options?.layout === "landscape-tech" ? candidatePlacementForBeat(beat, index, visualNodes.length, duration) : candidatePlacement(index, visualNodes.length, duration),
      createdAt: new Date().toISOString()
    };
    try {
      await writeGeneratedMotionCandidate(job, asset, beat, index);
    } catch (error) {
      asset.generationFallback = error.message;
      asset.sourceType = "ai-generated-free";
      asset.sourceLabel = "本地规则生成信息卡（动态素材失败回退）";
      asset.licenseBasis = "locally-generated";
      await writeGeneratedCandidateCard(job, asset, asset.title, asset.usagePurpose);
    }
    assets.push(asset);
  }
  assets.push(...await discoverLocalProjectAssets(job));
  const sourceIds = new Set((job.contentDirection?.referenceResearch?.sourceIds || []).map(String));
  const catalog = await referenceCatalog();
  for (const item of catalog.filter(entry => sourceIds.has(String(entry.sourceId))).slice(0, 3)) {
    const creatorName = String(item.creatorName || "待填写创作者公开名称");
    const placement = candidatePlacement(Math.min(assets.length, Math.max(1, visualNodes.length - 1)), Math.max(visualNodes.length, 2), duration);
    assets.push({
      id: `external-${crypto.randomBytes(4).toString("hex")}`,
      fileName: "待附加已获授权或必要引用片段",
      path: null,
      url: null,
      previewUrl: null,
      sourceType: "external-creator",
      sourceLabel: "口播稿参考视频候选",
      mediaKind: "video",
      title: item.topic || "外部参考视频",
      creatorName,
      workTitle: item.topic || "",
      sourceUrl: item.url || "",
      creatorProfileUrl: item.creatorProfileUrl || "",
      usagePurpose: "",
      licenseBasis: "",
      attributionText: creatorNameIsUsable(creatorName) ? `来源：${creatorName}｜${item.topic || "原视频"}` : "",
      clipStart: 0,
      clipEnd: null,
      clipDuration: null,
      reviewStatus: "pending",
      approved: false,
      discoveredAutomatically: true,
      paymentRequired: false,
      paymentConfirmed: true,
      placement,
      createdAt: new Date().toISOString()
    });
  }
  job.assets = [...(job.assets || []), ...assets].map(normalizeAssetRecord);
  job.assetDiscovery = {
    preparedAt: new Date().toISOString(),
    visualNodes: visualNodes.map((beat, index) => ({ id: `visual-node-${index + 1}`, segment: String(beat.segment || ""), requestedAsset: String(beat.asset || ""), purpose: String(beat.purpose || ""), placement: job.options?.layout === "landscape-tech" ? candidatePlacementForBeat(beat, index, visualNodes.length, duration) : candidatePlacement(index, visualNodes.length, duration) })),
    sourcePriority: ["local-derived", "licensed-free", "authorized-external", "commentary-quotation", "paid-with-confirmation"],
    localCandidates: assets.filter(asset => !EXTERNAL_SOURCE_TYPES.has(asset.sourceType)).length,
    externalCandidates: assets.filter(asset => EXTERNAL_SOURCE_TYPES.has(asset.sourceType)).length,
    freeStockConnector: "not-configured",
    visualStrategy: {
      mode: job.options?.layout === "landscape-tech" ? "landscape-tech-reference" : "rich-media-first",
      preferredMix: job.options?.layout === "landscape-tech" ? ["16:9科技画布", "真人矩形画中画", "真实工作台或项目画面", "前后对比", "动态流程图", "底部描边字幕"] : ["真人口播", "真实工作台或项目画面", "前后对比", "动态流程图", "AI生成视觉", "少量动态文字"],
      textOnlyCardsMaxShare: 0.2,
      referenceClipSeconds: { min: 2, max: 5 }
    },
    paidGeneration: { enabled: true, requiresExplicitCostConfirmation: job.options?.paidImageGenerationConfirmation !== false },
    rightsReviewMode: job.options?.rightsReviewMode || "strict",
    note: "已切换为富媒体优先：候选以真人原片衍生画面、前后对比、动态流程和真实项目证据为主，文字卡片只作补充；参考视频仅在必要时使用2—5秒并保留来源。"
  };
  job.assetReview = assetReviewSummary(job, duration);
  await writeJson(path.join(confined(jobsRoot, job.id), "asset-candidates.json"), { discovery: job.assetDiscovery, assets: job.assets });
  await saveJob(job);
  return job.assetDiscovery;
}
async function ensureMediaManifest(job, version) {
  const jobDir = confined(jobsRoot, job.id);
  const outputDuration = job.currentPlan?.keepSegments?.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || null;
  const assets = (job.assets || []).map(raw => {
    const asset = normalizeAssetRecord(raw);
    const complianceIssues = assetComplianceIssues(asset, job, outputDuration);
    return {
      id: asset.id,
      fileName: asset.fileName,
      path: asset.path,
      url: asset.url,
      sourceType: asset.sourceType,
      sourceLabel: asset.sourceLabel || "",
      mediaKind: asset.mediaKind,
      ownership: asset.ownership || "",
      creatorName: asset.creatorName,
      workTitle: asset.workTitle,
      sourceUrl: asset.sourceUrl,
      clipStart: asset.clipStart,
      clipEnd: asset.clipEnd,
      clipDuration: asset.clipDuration,
      usagePurpose: asset.usagePurpose,
      licenseBasis: asset.licenseBasis,
      attributionText: asset.attributionText,
      paymentRequired: asset.paymentRequired,
      paymentConfirmed: asset.paymentConfirmed,
      reviewStatus: asset.reviewStatus,
      approved: asset.reviewStatus === "approved",
      placement: asset.placement,
      complianceIssues,
      eligibleForRender: asset.reviewStatus === "approved" && complianceIssues.length === 0,
      composited: false
    };
  });
  const review = assetReviewSummary(job, outputDuration);
  const manifest = {
    version,
    policy: "rich-media-first-user-approved",
    cloudGenerationEnabled: job.options?.cloudImageGenerationEnabled === true,
    paidGenerationRequiresConfirmation: job.options?.paidImageGenerationConfirmation !== false,
    rightsReviewMode: job.options?.rightsReviewMode || "strict",
    externalUploadEnabled: false,
    review,
    assets,
    generatedAt: new Date().toISOString()
  };
  await writeJson(path.join(jobDir, `media-manifest-v${version}.json`), manifest);
  return manifest;
}
function masterDimensions(job) {
  if (job.options?.layout === "landscape-tech") return { width: 1280, height: 720 };
  if (job.options?.layout === "square") return { width: 1080, height: 1080 };
  if (job.options?.layout === "original") return { width: Math.max(2, Math.floor(Number(job.source?.width || 1080) / 2) * 2), height: Math.max(2, Math.floor(Number(job.source?.height || 1920) / 2) * 2) };
  return { width: 1080, height: 1920 };
}
async function buildMediaRenderPlan(job, version, manifest, firstInputIndex) {
  const renderable = manifest.assets.filter(asset => asset.eligibleForRender);
  const dimensions = masterDimensions(job);
  const inputArgs = [], filters = [], attributions = [];
  let inputIndex = firstInputIndex;
  for (const asset of renderable) {
    const placementDuration = asset.placement.end - asset.placement.start;
    if (asset.mediaKind === "image") inputArgs.push("-loop", "1", "-framerate", "30", "-t", placementDuration.toFixed(3), "-i", asset.path);
    else {
      const sourceStart = Math.max(0, Number(asset.clipStart || 0));
      const metadata = await probe(asset.path);
      if (!metadata.videoCodec || sourceStart + placementDuration > metadata.duration + 0.1) throw new Error(`素材 ${asset.id} 的截取区间超过本地视频时长`);
      asset.renderSourceMetadata = { duration: metadata.duration, width: metadata.width, height: metadata.height, videoCodec: metadata.videoCodec };
      inputArgs.push("-ss", sourceStart.toFixed(3), "-t", placementDuration.toFixed(3), "-i", asset.path);
    }
    const mode = asset.placement.mode || "broll";
    const targetWidthRaw = mode.startsWith("comparison-") ? Math.floor(dimensions.width / 2) : mode === "pip" ? Math.floor(dimensions.width * 0.42) : dimensions.width;
    const targetHeightRaw = mode.startsWith("comparison-") ? dimensions.height : mode === "pip" ? Math.floor(dimensions.height * 0.42) : dimensions.height;
    const targetWidth = Math.max(2, Math.floor(targetWidthRaw / 2) * 2), targetHeight = Math.max(2, Math.floor(targetHeightRaw / 2) * 2);
    filters.push(`[${inputIndex}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=0x07131D,trim=duration=${placementDuration.toFixed(3)},setpts=PTS-STARTPTS+${asset.placement.start.toFixed(3)}/TB[media${inputIndex}]`);
    const x = mode === "comparison-right" ? dimensions.width - targetWidth : mode === "pip" ? dimensions.width - targetWidth - 42 : 0;
    const y = mode === "pip" ? Math.round(dimensions.height * 0.14) : 0;
    filters.push(`[__MEDIA_BASE__][media${inputIndex}]overlay=x=${x}:y=${y}:eof_action=pass:shortest=0[__MEDIA_OUT__]`);
    if (EXTERNAL_SOURCE_TYPES.has(asset.sourceType)) attributions.push({ start: asset.placement.start, end: asset.placement.end, text: asset.attributionText });
    asset.scheduledForComposite = true;
    inputIndex += 1;
  }
  const attributionFile = attributions.length ? await writeMediaAttributionAss(confined(jobsRoot, job.id), attributions, version, dimensions) : null;
  manifest.review = assetReviewSummary(job, manifest.review?.outputDuration || null);
  manifest.renderedAssetIds = renderable.map(asset => asset.id);
  manifest.attributionTrack = attributionFile ? path.basename(attributionFile) : null;
  manifest.generatedAt = new Date().toISOString();
  await writeJson(path.join(confined(jobsRoot, job.id), `media-manifest-v${version}.json`), manifest);
  return { inputArgs, filters, attributions, attributionFile, renderable, nextInputIndex: inputIndex, dimensions };
}
async function finalizeMediaManifest(job, version, manifest, mediaPlan) {
  const rendered = new Set(mediaPlan.renderable.map(asset => asset.id));
  for (const asset of manifest.assets) {
    asset.composited = rendered.has(asset.id);
    asset.scheduledForComposite = false;
  }
  manifest.renderedAssetIds = [...rendered];
  manifest.renderCompletedAt = new Date().toISOString();
  await writeJson(path.join(confined(jobsRoot, job.id), `media-manifest-v${version}.json`), manifest);
  return manifest;
}
async function writeMediaAttributionAss(jobDir, attributions, version, dimensions) {
  const fontSize = dimensions.height <= 1080 ? 30 : 36;
  const margin = dimensions.height <= 1080 ? 44 : 92;
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${dimensions.width}`, `PlayResY: ${dimensions.height}`, "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]", "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: Source,Microsoft YaHei,${fontSize},&H00FFFFFF,&H000000FF,&H00101010,&H9007131D,0,0,0,0,100,100,0,0,3,2,0,1,${margin},${margin},${margin},1`, "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
  ];
  for (const item of attributions) lines.push(`Dialogue: 3,${assTime(item.start)},${assTime(item.end)},Source,,0,0,0,,{\\fad(120,120)}${assEscape(item.text)}`);
  const file = path.join(jobDir, `media-attribution-v${version}.ass`);
  await fsp.writeFile(file, lines.join("\r\n"), "utf8");
  return file;
}
function informationPanelItems(card) {
  const explicit = (Array.isArray(card?.items) ? card.items : []).map(value => String(value || "").trim().slice(0, 14)).filter(Boolean).slice(0, 4);
  if (explicit.length) return explicit;
  const text = String(card?.text || "");
  if (/口播工作台/i.test(text)) return ["写口播稿", "剪辑视频", "添加字幕"];
  return [];
}
async function renderHyperframesCards(jobDir, timeline, version, options = {}) {
  if (!timeline.cards.length) return { engine: "none", clips: [] };
  const outputDir = path.join(jobDir, "overlays", `v${version}`);
  await fsp.mkdir(outputDir, { recursive: true });
  const clips = [];
  for (const [index, card] of timeline.cards.entries()) {
    const variablesFile = path.join(outputDir, `card-${index + 1}.json`);
    const output = path.join(outputDir, `card-${index + 1}.webm`);
    const items = informationPanelItems(card);
    const mode = options.informationPanels !== false && items.length >= 2 ? "side-panel" : "banner";
    await writeJson(variablesFile, { text: card.text, kind: card.kind, itemsJson: JSON.stringify(items), mode });
    await run("npx", ["-y", "hyperframes", "render", path.join(here, "hyperframes-overlay"), "--output", output, "--format", "webm", "--variables-file", variablesFile, "--workers", "1", "--quiet", "--sdr"], { cwd: root, shell: true });
    const metadata = await probe(output);
    if (!metadata.videoCodec || metadata.duration < 2.8) throw new Error(`HyperFrames 卡片 ${index + 1} 输出无效`);
    const alpha = await run("ffmpeg", ["-hide_banner", "-c:v", "libvpx-vp9", "-ss", "0.5", "-i", output, "-vf", "alphaextract,signalstats,metadata=print", "-frames:v", "1", "-f", "null", "-"]);
    const alphaAverage = Number(alpha.stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/)?.[1]);
    if (!Number.isFinite(alphaAverage) || alphaAverage <= 0 || alphaAverage >= 254.5) throw new Error(`HyperFrames 卡片 ${index + 1} 透明像素检查失败`);
    metadata.alpha = true; metadata.alphaAverage = alphaAverage;
    clips.push({ ...card, mode, items, path: output, url: `/video-jobs/${path.basename(jobDir)}/overlays/v${version}/card-${index + 1}.webm`, metadata });
  }
  return { engine: "hyperframes", clips };
}
function variantFilter(layout) {
  if (layout === "vertical") return "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black";
  if (layout === "square") return "split=2[bg][fg];[bg]scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,boxblur=24:8[bg2];[fg]scale=1080:1080:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2";
  return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
}
async function renderVariants(job, version, masterPath) {
  if (job.options.generateVariants === false) return {};
  const dir = path.join(confined(jobsRoot, job.id), "variants", `v${version}`);
  await fsp.mkdir(dir, { recursive: true });
  const variants = {};
  const master = await probe(masterPath);
  const sourceRatio = job.source.width / Math.max(job.source.height, 1);
  const masterRatio = master.width / Math.max(master.height, 1);
  const layouts = ["vertical", "square"];
  if (Math.abs(sourceRatio - masterRatio) <= 0.01) layouts.push("original");
  for (const layout of layouts) {
    const output = path.join(dir, `final-${layout}.mp4`);
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", masterPath, "-vf", variantFilter(layout), "-c:v", "libx264", "-preset", "fast", "-crf", "21", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-c:a", "copy", "-movflags", "+faststart", output]);
    variants[layout] = {
      path: output,
      url: `/video-jobs/${job.id}/variants/v${version}/final-${layout}.mp4`,
      metadata: await probe(output),
      source: "approved-master",
      preservesSourceAspect: layout === "original"
    };
  }
  if (!layouts.includes("original")) variants.original = {
    available: false,
    reason: "母版画幅与源视频不同，无法从已构图母版无损恢复原比例",
    source: "approved-master"
  };
  return variants;
}
function parseQaDetection(stderr) {
  const black = [...String(stderr).matchAll(/black_start:([0-9.]+)\s+black_end:([0-9.]+)/g)].map(match => ({ start: Number(match[1]), end: Number(match[2]) }));
  const freezes = []; let freezeStart = null;
  for (const line of String(stderr).split(/\r?\n/)) {
    const start = line.match(/freeze_start:\s*([0-9.]+)/);
    if (start) freezeStart = Number(start[1]);
    const end = line.match(/freeze_end:\s*([0-9.]+)/);
    if (end && freezeStart !== null) {
      freezes.push({ start: freezeStart, end: Number(end[1]) });
      freezeStart = null;
    }
  }
  const loudness = [...String(stderr).matchAll(/I:\s*(-?[0-9.]+)\s+LUFS/g)].at(-1);
  return { blackFrames: black, freezeFrames: freezes, integratedLufs: loudness ? Number(loudness[1]) : null };
}
async function runQa(job, version, outputPath, expectedDuration, timeline, variants, packaging, captionPackaging, coverPackaging, mediaManifest, colorManagement) {
  const metadata = await probe(outputPath);
  await run("ffmpeg", ["-v", "error", "-i", outputPath, "-f", "null", "-"]);
  const scan = await run("ffmpeg", ["-hide_banner", "-i", outputPath, "-vf", "blackdetect=d=0.4:pix_th=0.02,freezedetect=n=-55dB:d=2", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const detection = parseQaDetection(scan.stderr);
  const minimumSegment = Math.min(...timeline.clips.map(clip => clip.duration));
  const sdrBt709 = metadata.colorPrimaries === "bt709" && metadata.colorTransfer === "bt709" && metadata.colorSpace === "bt709";
  const captionSafeArea = job.options.captions === false
    || ["ass-static", "ass-fallback"].includes(captionPackaging.engine)
    || (captionPackaging.engine === "hyperframes" && captionPackaging.integrated === true && captionPackaging.safeArea === true)
    || (captionPackaging.engine === "hyperframes" && captionPackaging.metadata?.width === 1080 && captionPackaging.metadata?.height === 1920 && captionPackaging.metadata?.alpha === true);
  const variantDimensions = Object.fromEntries(Object.entries(variants).map(([name, item]) => [name, item.available === false ? { available: false, reason: item.reason } : {
    available: true,
    width: item.metadata.width,
    height: item.metadata.height,
    sdrBt709: item.metadata.colorPrimaries === "bt709" && item.metadata.colorTransfer === "bt709" && item.metadata.colorSpace === "bt709"
  }]));
  const coverDimensions = coverPackaging.requested === false || (
    coverPackaging.available === true
    && coverPackaging.vertical?.metadata?.width === 1080 && coverPackaging.vertical?.metadata?.height === 1920
    && coverPackaging.grid?.metadata?.width === 1080 && coverPackaging.grid?.metadata?.height === 1440
    && coverPackaging.wide16x9?.metadata?.width === 1920 && coverPackaging.wide16x9?.metadata?.height === 1080
    && coverPackaging.landscape4x3?.metadata?.width === 1440 && coverPackaging.landscape4x3?.metadata?.height === 1080
  );
  const approvedMedia = mediaManifest.assets.filter(asset => asset.approved);
  const externalMedia = approvedMedia.filter(asset => EXTERNAL_SOURCE_TYPES.has(asset.sourceType));
  const mediaCompliance = {
    reviewComplete: mediaManifest.review?.reviewComplete === true,
    approvedAssetsValid: approvedMedia.every(asset => (asset.complianceIssues || []).length === 0),
    approvedAssetsComposited: approvedMedia.every(asset => asset.composited === true),
    externalMetadataComplete: externalMedia.every(asset => creatorNameIsUsable(asset.creatorName) && asset.workTitle && asset.sourceUrl && asset.usagePurpose && (advisoryRightsMode(job) || asset.licenseBasis)),
    externalAttributionRendered: externalMedia.every(asset => asset.composited === true && asset.attributionText && mediaManifest.attributionTrack),
    externalScriptDisclosure: advisoryRightsMode(job) || externalMedia.every(asset => String(job.script || "").includes(asset.creatorName))
  };
  const mediaPass = Object.values(mediaCompliance).every(Boolean);
  const report = {
    version,
    pass: metadata.videoCodec === "h264" && metadata.audioCodec === "aac" && metadata.pixelFormat === "yuv420p" && Math.abs(metadata.duration - expectedDuration) < 1.6 && sdrBt709 && captionSafeArea && coverDimensions && mediaPass,
    checks: {
      decodes: true,
      h264: metadata.videoCodec === "h264",
      aac: metadata.audioCodec === "aac",
      yuv420p: metadata.pixelFormat === "yuv420p",
      sdrBt709,
      durationMatches: Math.abs(metadata.duration - expectedDuration) < 1.6,
      expectedDimensions: metadata.width > 0 && metadata.height > 0,
      noLongBlackFrames: detection.blackFrames.length === 0,
      noLongFreezeFrames: detection.freezeFrames.length === 0,
      captionSafeArea,
      dynamicCaptionTrack: captionPackaging.engine === "hyperframes",
      cardSafeArea: timeline.cards.every(card => card.text.length <= 24),
      minimumSegmentDuration: minimumSegment >= 0.35,
      cutDensityPerMinute: Number((timeline.clips.length / Math.max(metadata.duration / 60, 0.01)).toFixed(2)),
      transcriptBoundaryCrossings: 0,
      variantDimensions,
      coverDimensions,
      mediaReviewComplete: mediaCompliance.reviewComplete,
      mediaApprovedAssetsValid: mediaCompliance.approvedAssetsValid,
      mediaApprovedAssetsComposited: mediaCompliance.approvedAssetsComposited,
      externalMetadataComplete: mediaCompliance.externalMetadataComplete,
      externalAttributionRendered: mediaCompliance.externalAttributionRendered,
      externalScriptDisclosure: mediaCompliance.externalScriptDisclosure
    },
    metrics: { expectedDuration, actualDuration: metadata.duration, minimumSegmentDuration: minimumSegment, integratedLufs: detection.integratedLufs, blackFrames: detection.blackFrames, freezeFrames: detection.freezeFrames, colorMetadata: { range: metadata.colorRange, space: metadata.colorSpace, transfer: metadata.colorTransfer, primaries: metadata.colorPrimaries } },
    colorManagement,
    packaging,
    captionPackaging,
    coverPackaging,
    media: { policy: mediaManifest.policy, approvedAssets: approvedMedia.length, renderedAssets: mediaManifest.assets.filter(asset => asset.composited).length, externalAssets: externalMedia.length, compliance: mediaCompliance, issues: mediaManifest.review?.complianceIssues || [] },
    limitations: ["未执行人脸构图质量判断", "跳切观感仍需最终人工审核", "平台变体由审核母版转换，不改变剪辑时间线"],
    generatedAt: new Date().toISOString()
  };
  await writeJson(path.join(confined(jobsRoot, job.id), `qa-report-v${version}.json`), report);
  return report;
}
function reviewContextWindows(job, outputDuration) {
  const duration = Math.max(0, Number(outputDuration || 0));
  const approved = (job.assets || []).filter(asset => asset.reviewStatus === "approved" && asset.placement);
  const raw = approved.map(asset => {
    const placementStart = Math.max(0, Number(asset.placement.start || 0));
    const placementEnd = Math.min(duration, Math.max(placementStart, Number(asset.placement.end || placementStart)));
    let start = Math.max(0, placementStart - 5);
    let end = Math.min(duration, Math.max(placementEnd + 8, start + 15));
    if (end - start < 15) start = Math.max(0, end - 15);
    return { start, end, assetIds: [asset.id], titles: [asset.title || asset.fileName || "视觉节点"] };
  }).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const item of raw) {
    const previous = merged.at(-1);
    if (previous && item.start <= previous.end + 1 && Math.max(previous.end, item.end) - previous.start <= 30) {
      previous.end = Math.max(previous.end, item.end);
      previous.assetIds.push(...item.assetIds);
      previous.titles.push(...item.titles);
    } else merged.push({ ...item });
  }
  return merged.map((item, index) => ({
    id: `review-segment-${index + 1}`,
    title: [...new Set(item.titles)].join("＋"),
    start: Number(item.start.toFixed(2)),
    end: Number(item.end.toFixed(2)),
    duration: Number((item.end - item.start).toFixed(2)),
    assetIds: [...new Set(item.assetIds)]
  }));
}
async function createReviewBundle(job, version, outputPath, outputDuration) {
  const jobDir = confined(jobsRoot, job.id);
  const previewName = `review-preview-v${version}.mp4`;
  const previewPath = path.join(jobDir, previewName);
  const outputMetadata = await probe(outputPath);
  const finalSettings = job.workflow?.version === VISUAL_WORKFLOW_VERSION ? job.workflow?.config?.stages?.full_render?.settings || {} : {};
  const previewSize = job.workflow?.version === VISUAL_WORKFLOW_VERSION && outputMetadata.width > outputMetadata.height
    ? `${Number(finalSettings.reviewWidth || 1920)}:${Number(finalSettings.reviewHeight || 1080)}`
    : outputMetadata.width > outputMetadata.height ? "960:540" : "720:1280";
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", outputPath,
    "-vf", `scale=${previewSize}:force_original_aspect_ratio=decrease,pad=${previewSize}:(ow-iw)/2:(oh-ih)/2:color=0x07131D,fps=30,format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-movflags", "+faststart", previewPath]);
  await run("ffmpeg", ["-v", "error", "-i", previewPath, "-f", "null", "-"]);
  const previewMetadata = await probe(previewPath);
  const segments = [];
  for (const [index, window] of reviewContextWindows(job, outputDuration).entries()) {
    const clipName = `review-segment-v${version}-${String(index + 1).padStart(2, "0")}.mp4`;
    const thumbnailName = `review-segment-v${version}-${String(index + 1).padStart(2, "0")}.jpg`;
    const clipPath = path.join(jobDir, clipName);
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", window.start.toFixed(3), "-i", previewPath, "-t", window.duration.toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", clipPath]);
    await run("ffmpeg", ["-v", "error", "-i", clipPath, "-f", "null", "-"]);
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", "1", "-i", clipPath, "-frames:v", "1", "-q:v", "3", path.join(jobDir, thumbnailName)]);
    segments.push({ ...window, path: clipPath, url: `/video-jobs/${job.id}/${clipName}`, thumbnailUrl: `/video-jobs/${job.id}/${thumbnailName}` });
  }
  const bundle = {
    version,
    mode: "full-preview-with-context-segments",
    preview: { path: previewPath, url: `/video-jobs/${job.id}/${previewName}`, metadata: previewMetadata },
    segments,
    highResolutionMasterRetained: true,
    finalApprovalHeld: true,
    autoPublish: false,
    createdAt: new Date().toISOString()
  };
  await writeJson(path.join(jobDir, `review-bundle-v${version}.json`), bundle);
  return bundle;
}

function workflowUrl(job, relative) {
  return `/video-jobs/${job.id}/${String(relative).replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/")}`;
}

function visualStageConfig(job, stageId) {
  const workflow = ensureVisualWorkflowState(job, normalizeVisualWorkflowConfig(visualWorkflowDefaults, job.workflow?.config || {}));
  return workflow.config.stages[stageId];
}

async function saveVisualWorkflowConfig(job) {
  const workflow = ensureVisualWorkflowState(job, normalizeVisualWorkflowConfig(visualWorkflowDefaults, job.workflow?.config || {}));
  workflow.updatedAt = new Date().toISOString();
  const name = `workflow-config-v${workflow.configVersion || 1}.json`;
  await writeJson(path.join(confined(jobsRoot, job.id), name), workflow.config);
  workflow.configArtifact = workflowUrl(job, name);
  return name;
}

function visualTopicForJob(job, settings = {}) {
  const topic = String(job.contentDirection?.mainTopic || job.options?.contentTitle || job.script || "AI口播剪辑").trim();
  const configured = Array.isArray(settings.searchQueries) ? settings.searchQueries.map(value => String(value || "").trim()).filter(Boolean) : [];
  const searchQueries = configured.length ? configured.slice(0, 3) : [topic, `${topic} AI实操`, `${topic} 前后对比`].slice(0, 3);
  const keywords = [...new Set(`${topic} ${job.contentDirection?.audienceBenefit || ""}`.split(/[\s，。！？、：；/]+/).map(value => value.trim()).filter(value => value.length >= 2))].slice(0, 12);
  return {
    topic,
    shortTopic: topic.slice(0, 20),
    aiAngle: String(job.contentDirection?.audienceBenefit || "用AI得到可见结果"),
    viewerUseCase: "观众如何复用这套AI方法得到具体结果",
    searchQueries,
    keywords,
    requiredSourceIds: (settings.manualReferenceUrls || []).map(url => String(url).match(/\d{12,}/)?.[0]).filter(Boolean).map(id => `douyin-${id}`),
  };
}

async function collectVisualReferences(job, stageVersion, stageConfig) {
  const jobDir = confined(jobsRoot, job.id);
  const topicPlan = visualTopicForJob(job, stageConfig.settings || {});
  const planName = `visual-topic-plan-v${stageVersion}.json`;
  const researchName = `visual-reference-research-v${stageVersion}.json`;
  const planPath = path.join(jobDir, planName);
  const researchPath = path.join(jobDir, researchName);
  await writeJson(planPath, topicPlan);
  let liveResearch = { status: "skipped", fullContentSources: [], metadataOnlySources: [], warnings: [] };
  if (stageConfig.settings?.autoSearchDouyin !== false) {
    try {
      await run(process.execPath, [referenceCollector, "--plan", planPath, "--output", researchPath], {
        cwd: root,
        env: process.env,
        timeoutMs: Math.max(60, Number(stageConfig.settings?.liveResearchTimeoutSeconds || 240)) * 1000,
      });
      liveResearch = await readJsonFile(researchPath);
    } catch (error) {
      try { liveResearch = await readJsonFile(researchPath); }
      catch { liveResearch = { status: "fallback", fullContentSources: [], metadataOnlySources: [], warnings: [`实时抖音搜索失败：${error.message}`] }; }
    }
  }
  const catalog = await referenceCatalog();
  const manual = (stageConfig.settings?.manualReferenceUrls || []).map((url, index) => ({
    sourceId: `manual-${String(url).match(/\d{12,}/)?.[0] || index + 1}`,
    platform: "douyin",
    sourceUrl: String(url),
    url: String(url),
    title: "用户手动指定的参考视频",
    evidenceLevel: "manual-url-pending-live-verification",
  }));
  const live = [...(liveResearch.fullContentSources || []), ...(liveResearch.metadataOnlySources || [])];
  const references = [...manual, ...live, ...catalog].filter((item, index, items) => {
    const key = item.sourceId || item.sourceUrl || item.url;
    return key && items.findIndex(other => (other.sourceId || other.sourceUrl || other.url) === key) === index;
  }).slice(0, Math.max(3, Number(stageConfig.settings?.maxReferences || 5) + 3));
  const researchBundle = {
    ...liveResearch,
    topicPlan,
    manualReferences: manual,
    curatedFallbackCount: catalog.length,
    references,
    generatedAt: new Date().toISOString(),
  };
  await writeJson(researchPath, researchBundle);
  return { topicPlan, researchBundle, planName, researchName };
}

function fallbackBreakdownSegments(job, timeline, count = 6) {
  const outputDuration = Math.max(1, Number(timeline.outputDuration || 1));
  const transcriptSegments = Array.isArray(job.transcript?.segments) ? job.transcript.segments : [];
  return Array.from({ length: count }, (_, index) => {
    const editedStart = outputDuration * index / count;
    const editedEnd = outputDuration * (index + 1) / count;
    const sourceStart = outputToSource(editedStart, job.currentPlan.keepSegments);
    const sourceEnd = outputToSource(Math.max(editedStart + 0.35, editedEnd - 0.01), job.currentPlan.keepSegments);
    const spoken = transcriptSegments.filter(item => Number(item.end) > sourceStart && Number(item.start) < sourceEnd).map(item => String(item.text || "").trim()).join("");
    const gist = spoken || `第${index + 1}段口播信息`;
    return {
      id: `S${String(index + 1).padStart(2, "0")}`,
      sourceTime: { start: sourceStart, end: sourceEnd },
      editedTime: { start: editedStart, end: editedEnd },
      gist,
      upperLeftTitle: [...gist].slice(0, 16).join("") || `信息段${index + 1}`,
      subtitleOrKeyLine: [...gist].slice(0, 24).join(""),
      oneSentenceSummary: [...gist].slice(0, 70).join(""),
      factCards: [
        { label: "主题", value: [...gist].slice(0, 16).join("") },
        { label: "方法", value: "按口播语义组织" },
        { label: "证据", value: "使用真人原片" },
      ],
      rightVisual: { type: "二维信息动效", description: "把本段核心信息转成可视化层级", data: [], motionOrder: [] },
      referencePackaging: { pattern: "标题→摘要→事实卡→证据", reason: "本地降级拆解" },
    };
  });
}

function alignBreakdownToTimeline(breakdown, job, timeline) {
  const duration = timeline.outputDuration;
  const segments = breakdown.segments.sort((a, b) => a.sourceTime.start - b.sourceTime.start);
  let previousEnd = 0;
  for (const [index, segment] of segments.entries()) {
    const mappedStart = sourceToOutput(segment.sourceTime.start, job.currentPlan.keepSegments);
    const mappedEnd = sourceToOutput(Math.max(segment.sourceTime.start, segment.sourceTime.end - 0.01), job.currentPlan.keepSegments);
    const fallbackStart = duration * index / segments.length;
    const fallbackEnd = duration * (index + 1) / segments.length;
    const start = Math.max(previousEnd, Number.isFinite(mappedStart) ? mappedStart : fallbackStart);
    const end = Math.max(start + 0.35, Math.min(duration, Number.isFinite(mappedEnd) ? mappedEnd + 0.01 : fallbackEnd));
    segment.editedTime = { start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) };
    previousEnd = segment.editedTime.end;
  }
  if (segments.length) segments.at(-1).editedTime.end = Number(duration.toFixed(3));
  return breakdown;
}

async function ensureWorkflowCleanSource(job) {
  const jobDir = confined(jobsRoot, job.id);
  const mediaDir = path.join(jobDir, "workflow", "media");
  await fsp.mkdir(mediaDir, { recursive: true });
  const editVersion = Number(job.currentPlan?.version || 1);
  const videoPath = path.join(mediaDir, `clean-source-v${editVersion}.mp4`);
  const audioPath = path.join(mediaDir, `clean-source-v${editVersion}.m4a`);
  if (fs.existsSync(videoPath) && fs.existsSync(audioPath)) {
    try {
      const metadata = await probe(videoPath);
      if (metadata.videoCodec && metadata.duration > 0.5) return { videoPath, audioPath, metadata };
    } catch {}
  }
  const segments = job.currentPlan?.keepSegments || [];
  if (!segments.length) throw new Error("缺少可生成干净口播源的保留片段");
  const filters = [];
  const hasAudio = job.source?.hasAudio !== false;
  for (const [index, segment] of segments.entries()) {
    const segmentDuration = Number(segment.end) - Number(segment.start);
    filters.push(`[0:v]trim=start=${Number(segment.start).toFixed(3)}:end=${Number(segment.end).toFixed(3)},setpts=PTS-STARTPTS[v${index}]`);
    if (hasAudio) filters.push(`[0:a]atrim=start=${Number(segment.start).toFixed(3)}:end=${Number(segment.end).toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${Math.min(0.03, segmentDuration / 3).toFixed(3)},afade=t=out:st=${Math.max(0, segmentDuration - 0.03).toFixed(3)}:d=${Math.min(0.03, segmentDuration / 3).toFixed(3)}[a${index}]`);
  }
  if (hasAudio) filters.push(`${segments.map((_, index) => `[v${index}][a${index}]`).join("")}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);
  else filters.push(`${segments.map((_, index) => `[v${index}]`).join("")}concat=n=${segments.length}:v=1:a=0[vcat]`);
  const color = videoColorPipeline(job.source);
  filters.push(`[vcat]${color.filter},fps=30,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[vout]`);
  if (hasAudio) filters.push("[acat]highpass=f=80,lowpass=f=15000,loudnorm=I=-16:TP=-1.5:LRA=11[aout]");
  const filterPath = path.join(mediaDir, `clean-source-v${editVersion}.ffscript`);
  await fsp.writeFile(filterPath, filters.join(";\r\n") + ";\r\n", "utf8");
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", job.sourcePath, "-/filter_complex", filterPath, "-map", "[vout]", ...(hasAudio ? ["-map", "[aout]"] : []), "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-g", "30", "-keyint_min", "30", "-sc_threshold", "0", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : []), "-movflags", "+faststart", videoPath];
  await run("ffmpeg", args, { cwd: mediaDir, timeoutMs: 30 * 60 * 1000 });
  const metadata = await probe(videoPath);
  if (hasAudio) await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", videoPath, "-vn", "-c:a", "copy", audioPath]);
  else await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", metadata.duration.toFixed(3), "-c:a", "aac", "-b:a", "192k", audioPath]);
  await writeJson(path.join(mediaDir, `clean-source-v${editVersion}.json`), { videoPath, audioPath, metadata, timelineVersion: editVersion, generatedAt: new Date().toISOString() });
  return { videoPath, audioPath, metadata };
}

async function runHyperframes(args, cwd, timeoutMs = 30 * 60 * 1000) {
  return run("npx", ["--yes", "hyperframes@0.7.71", ...args], { cwd, shell: true, timeoutMs, env: process.env });
}

async function inspectHyperframesProject(projectDir, timestamps = []) {
  const qaDir = path.join(projectDir, "qa");
  await fsp.mkdir(qaDir, { recursive: true });
  let check;
  try {
    check = await runHyperframes(["check", "."], projectDir, 10 * 60 * 1000);
  } catch (error) {
    await fsp.writeFile(
      path.join(qaDir, "check.txt"),
      `${error.message}\n${error.stdout || ""}\n${error.stderr || ""}`,
      "utf8",
    );
    throw error;
  }
  await fsp.writeFile(path.join(qaDir, "check.txt"), `${check.stdout}\n${check.stderr}`, "utf8");
  try {
    const args = ["inspect", ".", "--json"];
    if (timestamps.length) args.push("--at", timestamps.slice(0, 10).join(","));
    const inspect = await runHyperframes(args, projectDir, 10 * 60 * 1000);
    await fsp.writeFile(path.join(qaDir, "inspect.json"), inspect.stdout || "{}", "utf8");
  } catch (error) {
    await fsp.writeFile(path.join(qaDir, "inspect-error.txt"), `${error.message}\n${error.stdout || ""}\n${error.stderr || ""}`, "utf8");
  }
}

async function runStyleResearchStage(job, version, stageConfig) {
  const jobDir = confined(jobsRoot, job.id);
  const research = await collectVisualReferences(job, version, stageConfig);
  let modelResult = null;
  try {
    modelResult = await runAi({
      operation: "analyze_visual_style",
      topic: { ...research.topicPlan, contentDirection: job.contentDirection || {}, script: job.script },
      references: research.researchBundle.references,
      visual_defaults: job.workflow.config.visualDefaults,
      custom_prompt: stageConfig.prompt,
    }, jobDir, `visual-style-v${version}`);
  } catch (error) {
    job.degraded = [...(job.degraded || []), `视觉风格模型分析失败，已使用可审查默认规则：${error.message}`];
  }
  const report = normalizeVisualStyleReport(modelResult?.data || {}, research.researchBundle.references, job.workflow.config);
  report.model = modelResult?.model || null;
  report.researchWarnings = research.researchBundle.warnings || [];
  const reportName = `visual-style-report-v${version}.json`;
  await writeJson(path.join(jobDir, reportName), report);
  job.visualStyleReport = report;
  return {
    report,
    reportUrl: workflowUrl(job, reportName),
    researchUrl: workflowUrl(job, research.researchName),
    topicPlanUrl: workflowUrl(job, research.planName),
    referenceCount: report.selectedReferences.length,
    model: modelResult?.model || null,
  };
}

async function runContentBreakdownStage(job, version, stageConfig) {
  const jobDir = confined(jobsRoot, job.id);
  job.status = "analyzing"; job.progress = 18; await saveJob(job);
  job.source = await probe(job.sourcePath);
  let silences = [];
  if (stageConfig.settings?.removeSilence !== false) {
    const result = await run("ffmpeg", ["-hide_banner", "-i", job.sourcePath, "-af", `silencedetect=noise=${Number(job.options.silenceDb ?? -36)}dB:d=${Number(stageConfig.settings?.silenceDuration ?? 0.45)}`, "-f", "null", "-"]);
    silences = parseSilences(result.stderr, job.source.duration);
  }
  const fallback = buildKeepSegments(job.source.duration, silences, Number(stageConfig.settings?.pauseKeep ?? 0.12));
  job.analysis = { silences, baseKeepSegments: fallback, removedDuration: job.source.duration - fallback.reduce((sum, item) => sum + item.end - item.start, 0) };
  job.status = "transcribing"; job.progress = 22; await saveJob(job);
  if (!job.transcript || job.transcriptionModel !== `faster-whisper/${stageConfig.settings?.transcriptionModel || "small"}`) {
    try {
      const transcription = await runAi({ operation: "transcribe", input_path: job.sourcePath, output_dir: jobDir, model_size: stageConfig.settings?.transcriptionModel || "small", language: stageConfig.settings?.language || "zh" }, jobDir, `transcribe-v${version}`);
      job.transcript = transcription.data;
      job.transcriptionModel = transcription.model;
    } catch (error) {
      job.degraded = [...(job.degraded || []), `本地转录失败，退回口播稿时间估算：${error.message}`];
      job.transcript = { text: job.script || "", segments: [{ start: 0, end: job.source.duration, text: job.script || "" }], words: [], model: "script-fallback" };
      job.transcriptionModel = "script-fallback";
    }
  }
  job.status = "breaking_down_content"; job.progress = 31; await saveJob(job);
  let planResult = null;
  try {
    planResult = await runAi({ operation: "edit_plan", script: job.script, content_direction: job.contentDirection, source: job.source, transcript: job.transcript, base_plan: { silences, keepSegments: fallback }, custom_prompt: stageConfig.prompt }, jobDir, `edit-plan-visual-v${version}`);
  } catch (error) {
    job.degraded = [...(job.degraded || []), `语义剪辑计划失败，使用停顿剪辑：${error.message}`];
  }
  const validation = validatePlan(planResult?.data, job.source.duration, fallback, planResult ? "semantic" : "silence-fallback");
  const editVersion = Number(job.currentPlan?.version || 0) + 1;
  job.currentPlan = { version: editVersion, ...validation, editSummary: planResult?.data?.editSummary || "本地停顿剪辑", removedReasons: planResult?.data?.removedReasons || [], createdAt: new Date().toISOString() };
  job.currentVersion = Math.max(1, Number(job.currentVersion || 0));
  job.planModel = planResult?.model || null;
  await writeJson(path.join(jobDir, `edit-plan-v${editVersion}.json`), job.currentPlan);
  const timeline = buildTimeline(job, job.currentPlan, editVersion);
  await writeTimelineArtifacts(jobDir, timeline, editVersion);
  let breakdownResult = null;
  try {
    breakdownResult = await runAi({
      operation: "content_breakdown",
      script: job.script,
      transcript: job.transcript,
      timeline,
      style_report: job.visualStyleReport || {},
      minimum_segments: stageConfig.settings?.minimumSegments || 5,
      maximum_segments: stageConfig.settings?.maximumSegments || 12,
      custom_prompt: stageConfig.prompt,
    }, jobDir, `content-breakdown-v${version}`);
  } catch (error) {
    job.degraded = [...(job.degraded || []), `内容拆解模型失败，已生成可继续审核的本地分段：${error.message}`];
  }
  const fallbackSegments = fallbackBreakdownSegments(job, timeline, Math.max(5, Math.min(8, Number(stageConfig.settings?.minimumSegments || 5))));
  let breakdown = normalizeContentBreakdown(breakdownResult?.data || {}, {
    sourceDuration: job.source.duration,
    outputDuration: timeline.outputDuration,
    minimumSegments: stageConfig.settings?.minimumSegments || 5,
    maximumSegments: stageConfig.settings?.maximumSegments || 12,
    fallbackSegments,
  });
  breakdown = alignBreakdownToTimeline(breakdown, job, timeline);
  breakdown.model = breakdownResult?.model || null;
  breakdown.editPlanVersion = editVersion;
  const transcriptName = `transcript-v${version}.json`;
  const breakdownName = `content-breakdown-v${version}.json`;
  await writeJson(path.join(jobDir, transcriptName), job.transcript);
  await writeJson(path.join(jobDir, breakdownName), breakdown);
  job.contentBreakdown = breakdown;
  await prepareAssetCandidates(job, { force: version > 1, reason: "视觉导演内容拆解完成，按信息段发现素材" });
  return {
    breakdown,
    breakdownUrl: workflowUrl(job, breakdownName),
    transcriptUrl: workflowUrl(job, transcriptName),
    editPlanUrl: workflowUrl(job, `edit-plan-v${editVersion}.json`),
    timelineUrl: workflowUrl(job, `timeline-v${editVersion}.json`),
    segmentCount: breakdown.segments.length,
    outputDuration: timeline.outputDuration,
    model: breakdownResult?.model || null,
  };
}

async function runKeyframeStage(job, version, stageConfig, feedback = "") {
  const jobDir = confined(jobsRoot, job.id);
  const previous = job.workflow.stages.keyframes?.artifacts?.direction || {};
  let result = null;
  try {
    result = await runAi({
      operation: "keyframe_direction",
      style_report: job.visualStyleReport || {},
      breakdown: job.contentBreakdown || {},
      count: stageConfig.settings?.count || 4,
      previous,
      feedback,
      custom_prompt: feedback ? job.workflow.config.stages.keyframe_review.prompt : stageConfig.prompt,
    }, jobDir, `keyframe-direction-v${version}`);
  } catch (error) {
    job.degraded = [...(job.degraded || []), `关键帧导演方案失败，使用均匀选择：${error.message}`];
  }
  const direction = normalizeKeyframeDirection(result?.data || {}, job.contentBreakdown, stageConfig.settings?.count || 4);
  const directionName = `keyframe-direction-v${version}.json`;
  await writeJson(path.join(jobDir, directionName), direction);
  const clean = await ensureWorkflowCleanSource(job);
  const projectRelative = path.join("workflow", `keyframes-v${version}`);
  const projectDir = path.join(jobDir, projectRelative);
  const project = await buildHyperframesDirectorProject({
    projectDir,
    sourceVideo: clean.videoPath,
    sourceAudio: clean.audioPath,
    breakdown: job.contentBreakdown,
    styleReport: job.visualStyleReport,
    mode: "keyframes",
    keyframeDirection: direction,
    renderSpec: { ...job.workflow.config.rendering.keyframes, count: direction.frames.length },
    promptSnapshot: { stage: "keyframes", version, prompt: stageConfig.prompt, feedback, settings: stageConfig.settings, model: result?.model || null },
  });
  await inspectHyperframesProject(projectDir, project.snapshotTimes);
  const snapshotDir = path.join(projectDir, "snapshots");
  await runHyperframes(["snapshot", ".", "--output", snapshotDir, "--at", project.snapshotTimes.join(","), "--no-end", "--describe", "false"], projectDir, 20 * 60 * 1000);
  const frameFiles = (await fsp.readdir(snapshotDir)).filter(name => /\.png$/i.test(name)).sort().slice(0, 5);
  if (frameFiles.length < 3) throw new Error(`HyperFrames只生成了${frameFiles.length}张关键帧，未达到3张门禁`);
  const frames = frameFiles.map((name, index) => ({
    id: direction.frames[index]?.id || `KF${index + 1}`,
    segmentId: direction.frames[index]?.segmentId || null,
    sourceTime: direction.frames[index]?.sourceTime ?? null,
    path: path.join(snapshotDir, name),
    url: workflowUrl(job, path.relative(jobDir, path.join(snapshotDir, name))),
    purpose: direction.frames[index]?.purpose || "关键帧审核",
  }));
  return {
    direction,
    directionUrl: workflowUrl(job, directionName),
    frames,
    frameCount: frames.length,
    projectUrl: workflowUrl(job, path.join(projectRelative, "index.html")),
    manifestUrl: workflowUrl(job, path.join(projectRelative, "composition-manifest.json")),
    qaUrl: workflowUrl(job, path.join(projectRelative, "qa", "check.txt")),
    model: result?.model || null,
  };
}

async function ensurePreviewAssetDecisions(job) {
  const duration = job.currentPlan?.keepSegments?.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || Number(job.source?.duration || 0);
  const review = assetReviewSummary(job, duration);
  if (review.reviewComplete && review.renderReady) return review;
  const decision = await autoReviewLocalAssetsForPreview(job);
  return decision.review;
}

async function runMotionSampleStage(job, version, stageConfig, feedback = "") {
  const jobDir = confined(jobsRoot, job.id);
  const keyframes = job.workflow.stages.keyframes?.artifacts;
  let modelResult = null;
  try {
    modelResult = await runAi({
      operation: "motion_sample_direction",
      keyframes,
      breakdown: job.contentBreakdown,
      style_report: job.visualStyleReport,
      settings: stageConfig.settings,
      feedback,
      custom_prompt: stageConfig.prompt,
    }, jobDir, `motion-sample-direction-v${version}`);
  } catch (error) {
    job.degraded = [...(job.degraded || []), `动态样片导演方案失败，使用默认有序动效：${error.message}`];
  }
  const outputDuration = job.currentPlan.keepSegments.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0);
  const direction = normalizeMotionDirection(modelResult?.data || {}, job.contentBreakdown, { ...stageConfig.settings, outputDuration });
  const directionName = `motion-sample-direction-v${version}.json`;
  await writeJson(path.join(jobDir, directionName), direction);
  await ensurePreviewAssetDecisions(job);
  const clean = await ensureWorkflowCleanSource(job);
  const captions = transcriptCues(job.transcript, job.currentPlan.keepSegments, job.script);
  const approvedAssets = (job.assets || []).filter(asset => asset.reviewStatus === "approved" && !assetComplianceIssues(asset, job, outputDuration).length);
  const projectRelative = path.join("workflow", `sample-v${version}`);
  const projectDir = path.join(jobDir, projectRelative);
  const project = await buildHyperframesDirectorProject({
    projectDir,
    sourceVideo: clean.videoPath,
    sourceAudio: clean.audioPath,
    breakdown: job.contentBreakdown,
    styleReport: job.visualStyleReport,
    mode: "sample",
    rangeStart: direction.sampleStart,
    rangeEnd: direction.sampleEnd,
    motionDirection: direction,
    captions,
    approvedAssets,
    renderSpec: job.workflow.config.rendering.sample,
    promptSnapshot: { stage: "motion_sample", version, prompt: stageConfig.prompt, feedback, settings: stageConfig.settings, model: modelResult?.model || null },
  });
  await inspectHyperframesProject(projectDir, project.snapshotTimes);
  const rendersDir = path.join(projectDir, "renders");
  await fsp.mkdir(rendersDir, { recursive: true });
  const outputPath = path.join(rendersDir, `motion-sample-v${version}.mp4`);
  await runHyperframes(["render", ".", "--skill=talking-head-recut", "--output", outputPath, "--fps", String(project.fps), "--quality", "standard", "--workers", "2"], projectDir, 45 * 60 * 1000);
  await run("ffmpeg", ["-v", "error", "-i", outputPath, "-f", "null", "-"]);
  const metadata = await probe(outputPath);
  if (metadata.duration < 14.5 || metadata.duration > 25.8) throw new Error(`动态样片时长${metadata.duration.toFixed(1)}秒，不在15—25秒门禁内`);
  const thumbnailPath = path.join(rendersDir, `motion-sample-v${version}.jpg`);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(Math.min(3, metadata.duration / 3)), "-i", outputPath, "-frames:v", "1", "-q:v", "2", thumbnailPath]);
  return {
    direction,
    directionUrl: workflowUrl(job, directionName),
    path: outputPath,
    url: workflowUrl(job, path.relative(jobDir, outputPath)),
    thumbnailUrl: workflowUrl(job, path.relative(jobDir, thumbnailPath)),
    metadata,
    projectUrl: workflowUrl(job, path.join(projectRelative, "index.html")),
    manifestUrl: workflowUrl(job, path.join(projectRelative, "composition-manifest.json")),
    qaUrl: workflowUrl(job, path.join(projectRelative, "qa", "check.txt")),
    sampleStart: direction.sampleStart,
    sampleEnd: direction.sampleEnd,
    model: modelResult?.model || null,
  };
}

async function normalizeHyperframesMaster(inputPath, outputPath, width, height, fps) {
  const metadata = await probe(inputPath);
  const alreadyCompatible = metadata.videoCodec === "h264" && metadata.audioCodec === "aac" && metadata.pixelFormat === "yuv420p" && metadata.width === width && metadata.height === height;
  if (alreadyCompatible) {
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", inputPath, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-movflags", "+faststart", outputPath]);
  } else {
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", inputPath, "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x07090F,fps=${fps},format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709`, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", outputPath], { timeoutMs: 90 * 60 * 1000 });
  }
  await run("ffmpeg", ["-v", "error", "-i", outputPath, "-f", "null", "-"]);
  return probe(outputPath);
}

async function runFullRenderStage(job, stageVersion, stageConfig, feedback = "") {
  const jobDir = confined(jobsRoot, job.id);
  const outputDuration = job.currentPlan.keepSegments.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0);
  const review = assetReviewSummary(job, outputDuration);
  if (!review.reviewComplete || !review.renderReady) throw new Error("素材审核状态在样片批准后发生变化，请先处理所有素材再生成完整视频");
  let modelResult = null;
  try {
    modelResult = await runAi({
      operation: "full_video_direction",
      style_report: job.visualStyleReport,
      breakdown: job.contentBreakdown,
      keyframes: job.workflow.stages.keyframes?.artifacts,
      sample_direction: job.workflow.stages.motion_sample?.artifacts?.direction,
      settings: stageConfig.settings,
      feedback,
      custom_prompt: stageConfig.prompt,
    }, jobDir, `full-video-direction-v${stageVersion}`);
  } catch (error) {
    job.degraded = [...(job.degraded || []), `完整视频导演方案失败，使用批准样片的默认动效语法：${error.message}`];
  }
  const direction = normalizeFullDirection(modelResult?.data || {}, job.contentBreakdown);
  const directionName = `full-video-direction-v${stageVersion}.json`;
  await writeJson(path.join(jobDir, directionName), direction);
  const clean = await ensureWorkflowCleanSource(job);
  const captions = transcriptCues(job.transcript, job.currentPlan.keepSegments, job.script);
  const approvedAssets = (job.assets || []).filter(asset => asset.reviewStatus === "approved" && !assetComplianceIssues(asset, job, outputDuration).length);
  const videoVersion = Math.max(0, ...(job.versions || []).map(item => Number(item.version) || 0), Number(job.currentVersion || 0)) + 1;
  job.currentVersion = videoVersion;
  const finalSettings = stageConfig.settings;
  const width = Number(finalSettings.masterWidth || 2560);
  const height = Number(finalSettings.masterHeight || (width === 2560 ? 1440 : 1080));
  const fps = Number(finalSettings.fps || 30);
  const projectRelative = path.join("workflow", `full-v${videoVersion}`);
  const projectDir = path.join(jobDir, projectRelative);
  const project = await buildHyperframesDirectorProject({
    projectDir,
    sourceVideo: clean.videoPath,
    sourceAudio: clean.audioPath,
    breakdown: job.contentBreakdown,
    styleReport: job.visualStyleReport,
    mode: "full",
    rangeStart: 0,
    rangeEnd: outputDuration,
    fullDirection: direction,
    captions,
    approvedAssets,
    renderSpec: { width, height, fps },
    promptSnapshot: { stage: "full_render", stageVersion, videoVersion, prompt: stageConfig.prompt, feedback, settings: finalSettings, model: modelResult?.model || null },
  });
  await inspectHyperframesProject(projectDir, project.snapshotTimes);
  const rendersDir = path.join(projectDir, "renders");
  await fsp.mkdir(rendersDir, { recursive: true });
  const rawPath = path.join(rendersDir, `full-hyperframes-v${videoVersion}-raw.mp4`);
  await runHyperframes(["render", ".", "--skill=talking-head-recut", "--output", rawPath, "--fps", String(fps), "--quality", "high", "--workers", "2"], projectDir, 4 * 60 * 60 * 1000);
  const outputPath = path.join(jobDir, `final-v${videoVersion}.mp4`);
  const metadata = await normalizeHyperframesMaster(rawPath, outputPath, width, height, fps);
  await fsp.copyFile(outputPath, path.join(jobDir, "final.mp4"));
  const thumbnail = path.join(jobDir, `thumbnail-v${videoVersion}.jpg`);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(Math.min(1.5, metadata.duration / 3)), "-i", outputPath, "-frames:v", "1", "-q:v", "2", thumbnail]);
  const timeline = buildTimeline(job, job.currentPlan, videoVersion);
  await writeTimelineArtifacts(jobDir, timeline, videoVersion);
  const manifest = await ensureMediaManifest(job, videoVersion);
  const composited = new Set(project.compositedAssetIds);
  for (const asset of manifest.assets) asset.composited = composited.has(asset.id);
  manifest.renderedAssetIds = [...composited];
  manifest.attributionTrack = manifest.assets.some(asset => asset.composited && EXTERNAL_SOURCE_TYPES.has(asset.sourceType)) ? "hyperframes-integrated" : null;
  manifest.renderCompletedAt = new Date().toISOString();
  await writeJson(path.join(jobDir, `media-manifest-v${videoVersion}.json`), manifest);
  let coverPackaging = { requested: job.options?.generateCover !== false, available: false, engine: "none", fallbackReason: null };
  if (coverPackaging.requested) {
    try { coverPackaging = await renderCover(job, videoVersion); }
    catch (error) { coverPackaging = { requested: true, available: false, engine: "failed", fallbackReason: error.message }; }
  }
  const variants = await renderVariants(job, videoVersion, outputPath);
  const packaging = { requested: "hyperframes", engine: "hyperframes", cards: job.contentBreakdown?.segments?.length || 0, panels: job.contentBreakdown?.segments?.length || 0, project: projectRelative };
  const captionPackaging = { requested: job.options.captions === false ? "none" : "keyword-pop", engine: job.options.captions === false ? "none" : "hyperframes", style: "keyword-pop", cues: captions.length, integrated: true, safeArea: true };
  const qaReport = await runQa(job, videoVersion, outputPath, outputDuration, timeline, variants, packaging, captionPackaging, coverPackaging, manifest, videoColorPipeline(job.source));
  const reviewBundle = await createReviewBundle(job, videoVersion, outputPath, outputDuration);
  const artifactUrl = name => `/video-jobs/${job.id}/${name}`;
  const output = {
    version: videoVersion,
    path: outputPath,
    url: artifactUrl(`final-v${videoVersion}.mp4`),
    thumbnailUrl: artifactUrl(`thumbnail-v${videoVersion}.jpg`),
    metadata,
    qa: qaReport.checks,
    qaPass: qaReport.pass,
    provenance: job.currentPlan.provenance,
    planEngine: job.currentPlan.engine,
    packaging,
    captionPackaging,
    cover: coverPackaging,
    colorManagement: videoColorPipeline(job.source),
    variants,
    reviewBundle,
    media: { policy: manifest.policy, approvedAssets: manifest.assets.filter(asset => asset.approved).length },
    artifacts: {
      editPlan: artifactUrl(`edit-plan-v${job.currentPlan.version}.json`),
      timeline: artifactUrl(`timeline-v${videoVersion}.json`),
      edl: artifactUrl(`timeline-v${videoVersion}.edl`),
      qa: artifactUrl(`qa-report-v${videoVersion}.json`),
      mediaManifest: artifactUrl(`media-manifest-v${videoVersion}.json`),
      reviewBundle: artifactUrl(`review-bundle-v${videoVersion}.json`),
      reviewPreview: reviewBundle.preview.url,
      styleReport: job.workflow.stages.style_research?.artifacts?.reportUrl,
      contentBreakdown: job.workflow.stages.content_breakdown?.artifacts?.breakdownUrl,
      keyframeDirection: job.workflow.stages.keyframes?.artifacts?.directionUrl,
      motionSample: job.workflow.stages.motion_sample?.artifacts?.url,
      fullDirection: artifactUrl(directionName),
      hyperframesProject: workflowUrl(job, path.join(projectRelative, "index.html")),
      hyperframesManifest: workflowUrl(job, path.join(projectRelative, "composition-manifest.json")),
      ...(coverPackaging.available ? { coverDesign: artifactUrl(`cover-design-v${videoVersion}.json`), coverVertical: coverPackaging.vertical.url, coverGrid: coverPackaging.grid.url, coverWide16x9: coverPackaging.wide16x9.url, coverLandscape4x3: coverPackaging.landscape4x3.url } : {}),
    },
    createdAt: new Date().toISOString(),
    model: modelResult?.model || null,
  };
  job.versions = [...(job.versions || []).filter(item => Number(item.version) !== videoVersion), output];
  job.output = output;
  return { output, direction, directionUrl: artifactUrl(directionName), projectUrl: workflowUrl(job, path.join(projectRelative, "index.html")), manifestUrl: workflowUrl(job, path.join(projectRelative, "composition-manifest.json")), videoVersion };
}

function visualJobStatus(stageId) {
  return {
    style_research: "researching_style",
    content_breakdown: "breaking_down_content",
    keyframes: "generating_keyframes",
    motion_sample: "rendering_sample",
    full_render: "rendering_final",
  }[stageId] || "planning";
}

const RENDERED_AUDIT_PROTECTED_FIELDS = [
  "approvedAt",
  "autoPublish",
  "finalReview",
  "memoryPromotion",
  "productionApproval",
  "publish",
  "publishedAt",
  "publishStatus",
];

function renderedAuditProtectedState(job) {
  return {
    status: job.status,
    fields: Object.fromEntries(RENDERED_AUDIT_PROTECTED_FIELDS.map(key => [key, {
      present: Object.prototype.hasOwnProperty.call(job, key),
      value: structuredClone(job[key]),
    }])),
  };
}

function restoreRenderedAuditProtectedState(job, snapshot) {
  job.status = snapshot.status;
  for (const [key, state] of Object.entries(snapshot.fields)) {
    if (state.present) job[key] = state.value;
    else delete job[key];
  }
}

export async function auditRenderedJobAfterFinalRender(job, trigger, dependencies = {}) {
  const protectedState = renderedAuditProtectedState(job);
  try {
    const keeps = Array.isArray(job.currentPlan?.keepSegments) ? job.currentPlan.keepSegments : [];
    const mappedTranscript = keeps.length
      ? transcriptCues(job.transcript, keeps, job.script)
      : undefined;
    const audit = await auditRenderedJobOrdinaryViewer({
      job,
      transcript: mappedTranscript,
      critic: dependencies.critic || multiAgentOrdinaryViewerCritic,
      writeArtifact: dependencies.writeArtifact || writeMultiAgentArtifact,
      readArtifact: dependencies.readArtifact || readMultiAgentArtifact,
      allowedRoots: dependencies.allowedRoots || [jobsRoot],
      trigger,
      attemptKey: dependencies.attemptKey || `automatic:${trigger}`,
      clock: dependencies.clock || (() => new Date().toISOString()),
    });
    const artifact = audit.artifact;
    const summary = {
      status: artifact.status,
      stage: "render",
      trigger,
      artifactId: audit.artifactId,
      artifactHref: audit.artifactHref,
      outputVersion: artifact.outputVersion,
      mediaSha256: artifact.mediaSha256,
      transcriptSha256: artifact.transcriptSha256,
      inspectionMode: artifact.inspectionMode,
      reviewedAt: artifact.reviewedAt,
      ...(artifact.review ? {
        viewerDecision: artifact.review.viewerDecision,
        sharpConclusion: artifact.review.sharpConclusion,
        blockers: Array.isArray(artifact.review.blockers) ? artifact.review.blockers.length : 0,
      } : {}),
      ...(artifact.error ? { error: artifact.error } : {}),
    };
    const outputVersion = Number(job.output?.version);
    job.output = { ...job.output, ordinaryViewerAudit: summary };
    job.versions = (job.versions || []).map(item => Number(item.version) === outputVersion
      ? { ...item, ordinaryViewerAudit: summary }
      : item);
    restoreRenderedAuditProtectedState(job, protectedState);
    await (dependencies.saveJobFn || saveJob)(job);
    return audit;
  } catch (error) {
    restoreRenderedAuditProtectedState(job, protectedState);
    console.warn(`Ordinary Viewer 成片审查未能落库：${redact(error?.message || error)}`);
    return null;
  }
}

async function executeVisualStage(job, stageId, feedback = "") {
  const workflow = ensureVisualWorkflowState(job, normalizeVisualWorkflowConfig(visualWorkflowDefaults, job.workflow?.config || {}));
  const stage = workflow.stages[stageId];
  if (!stage || !["style_research", "content_breakdown", "keyframes", "motion_sample", "full_render"].includes(stageId)) throw new Error(`不可执行的视觉阶段：${stageId}`);
  invalidateVisualStages(workflow, stageId, `阶段 ${stageId} 开始生成新版本`);
  const version = Number(stage.currentVersion || 0) + 1;
  const config = workflow.config.stages[stageId];
  const runRecord = { version, status: "running", feedback: String(feedback || ""), prompt: config.prompt, settings: config.settings, startedAt: new Date().toISOString() };
  stage.currentVersion = version;
  stage.status = "running";
  stage.approvedVersion = null;
  stage.runs = [...(stage.runs || []), runRecord];
  stage.updatedAt = new Date().toISOString();
  workflow.currentStage = stageId;
  workflow.updatedAt = new Date().toISOString();
  job.status = visualJobStatus(stageId);
  job.progress = visualStageProgress(stageId);
  delete job.error;
  delete job.errorDetail;
  delete job.errorStage;
  await saveVisualWorkflowConfig(job);
  await saveJob(job);
  try {
    let artifacts;
    if (stageId === "style_research") artifacts = await runStyleResearchStage(job, version, config);
    else if (stageId === "content_breakdown") artifacts = await runContentBreakdownStage(job, version, config);
    else if (stageId === "keyframes") artifacts = await runKeyframeStage(job, version, config, feedback);
    else if (stageId === "motion_sample") artifacts = await runMotionSampleStage(job, version, config, feedback);
    else artifacts = await runFullRenderStage(job, version, config, feedback);
    stage.artifacts = artifacts;
    stage.status = ["motion_sample", "full_render"].includes(stageId) ? "awaiting_review" : "completed";
    stage.updatedAt = new Date().toISOString();
    runRecord.status = "completed";
    runRecord.completedAt = stage.updatedAt;
    runRecord.artifacts = artifacts;
    if (stageId === "keyframes") {
      const gate = workflow.stages.keyframe_review;
      gate.status = "awaiting_review";
      gate.currentVersion = version;
      gate.artifacts = artifacts;
      gate.updatedAt = stage.updatedAt;
      workflow.currentStage = "keyframe_review";
      job.status = "awaiting_keyframe_review";
    } else if (stageId === "motion_sample") {
      workflow.currentStage = "motion_sample";
      job.status = "awaiting_sample_review";
    } else if (stageId === "full_render") {
      workflow.currentStage = "full_render";
      job.status = "awaiting_review";
    }
    job.progress = visualStageProgress(stageId, "complete");
    workflow.updatedAt = new Date().toISOString();
    await saveJob(job);
    if (stageId === "full_render") {
      await auditRenderedJobAfterFinalRender(job, "visual_director_v4_full_render");
    }
    return artifacts;
  } catch (error) {
    stage.status = "error";
    stage.updatedAt = new Date().toISOString();
    runRecord.status = "error";
    runRecord.completedAt = stage.updatedAt;
    runRecord.error = error.message;
    job.status = "error";
    job.error = error.message;
    job.errorDetail = String(error.stderr || error.stdout || error.message || "").slice(-8000);
    job.errorStage = stageId;
    await saveJob(job);
    throw error;
  }
}

async function runVisualWorkflowChain(job, startStage = "style_research", feedback = "") {
  if (running.has(job.id)) return;
  running.set(job.id, true);
  try {
    const startIndex = VISUAL_STAGE_ORDER.indexOf(startStage);
    if (startIndex < 0) throw new Error(`未知视觉工作流阶段：${startStage}`);
    if (startStage === "motion_sample" && job.workflow?.stages?.keyframe_review?.status !== "approved") throw new Error("关键帧尚未批准，不能生成动态样片");
    if (startStage === "full_render" && job.workflow?.stages?.motion_sample?.status !== "approved") throw new Error("动态样片尚未批准，不能生成完整视频");
    if (startIndex <= VISUAL_STAGE_ORDER.indexOf("style_research")) await executeVisualStage(job, "style_research", feedback);
    if (startIndex <= VISUAL_STAGE_ORDER.indexOf("content_breakdown") && startStage !== "motion_sample" && startStage !== "full_render") await executeVisualStage(job, "content_breakdown", feedback);
    if (startIndex <= VISUAL_STAGE_ORDER.indexOf("keyframes") && startStage !== "motion_sample" && startStage !== "full_render") await executeVisualStage(job, "keyframes", feedback);
    if (startStage === "motion_sample") await executeVisualStage(job, "motion_sample", feedback);
    if (startStage === "full_render") await executeVisualStage(job, "full_render", feedback);
  } catch (error) {
    if (job.status !== "error") {
      job.status = "error";
      job.error = error.message;
      job.errorDetail = String(error.stderr || error.stdout || error.message || "").slice(-8000);
      await saveJob(job);
    }
  } finally {
    running.delete(job.id);
  }
}

async function updateVisualStageConfig(job, stageId, body = {}) {
  const workflow = ensureVisualWorkflowState(job, normalizeVisualWorkflowConfig(visualWorkflowDefaults, job.workflow?.config || {}));
  if (!VISUAL_STAGE_ORDER.includes(stageId)) throw Object.assign(new Error("未知工作流阶段"), { statusCode: 404 });
  const current = workflow.config.stages[stageId];
  const overrides = cloneVisualConfig(workflow.config);
  overrides.stages[stageId] = {
    ...overrides.stages[stageId],
    settings: { ...overrides.stages[stageId].settings, ...(body.settings || {}) },
    ...(body.prompt === undefined ? {} : { prompt: String(body.prompt || "") }),
  };
  workflow.config = normalizeVisualWorkflowConfig(visualWorkflowDefaults, overrides);
  workflow.configVersion = Number(workflow.configVersion || 1) + 1;
  workflow.audit ||= [];
  workflow.audit.push({ type: "stage-config-updated", stageId, configVersion: workflow.configVersion, changedPrompt: body.prompt !== undefined && body.prompt !== current.prompt, at: new Date().toISOString() });
  await saveVisualWorkflowConfig(job);
  await saveJob(job);
  return workflow.config.stages[stageId];
}

function cloneVisualConfig(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

async function approveVisualGate(job, stageId, body = {}) {
  const workflow = ensureVisualWorkflowState(job, normalizeVisualWorkflowConfig(visualWorkflowDefaults, job.workflow?.config || {}));
  const now = new Date().toISOString();
  if (stageId === "keyframe_review") {
    const source = workflow.stages.keyframes;
    if (!source?.artifacts?.frames?.length || source.status === "error") throw Object.assign(new Error("还没有可批准的关键帧"), { statusCode: 409 });
    const gate = workflow.stages.keyframe_review;
    gate.status = "approved";
    gate.approvedVersion = source.currentVersion;
    gate.feedback = String(body.feedback || "");
    gate.approvedAt = now;
    source.status = "approved";
    source.approvedVersion = source.currentVersion;
    workflow.audit.push({ type: "stage-approved", stageId, version: source.currentVersion, at: now });
    await saveJob(job);
    runVisualWorkflowChain(job, "motion_sample");
    return;
  }
  if (stageId === "motion_sample") {
    const stage = workflow.stages.motion_sample;
    if (!stage?.artifacts?.url || stage.status === "error") throw Object.assign(new Error("还没有可批准的动态样片"), { statusCode: 409 });
    stage.status = "approved";
    stage.approvedVersion = stage.currentVersion;
    stage.feedback = String(body.feedback || "");
    stage.approvedAt = now;
    workflow.audit.push({ type: "stage-approved", stageId, version: stage.currentVersion, at: now });
    await saveJob(job);
    runVisualWorkflowChain(job, "full_render");
    return;
  }
  throw Object.assign(new Error("该阶段不使用此批准接口"), { statusCode: 400 });
}

async function renderVersion(job, version) {
  const jobDir = confined(jobsRoot, job.id), plan = job.currentPlan, segments = plan.keepSegments;
  job.status = version > 1 ? "revising" : "rendering"; job.progress = 2; await saveJob(job);
  const timeline = buildTimeline(job, plan, version);
  const duration = timeline.outputDuration, filters = [];
  const colorManagement = videoColorPipeline(job.source);
  await writeTimelineArtifacts(jobDir, timeline, version);
  const mediaManifest = await ensureMediaManifest(job, version);
  const landscapeHud = job.options?.layout === "landscape-tech" ? await writeLandscapeHudAss(jobDir, job, timeline, version) : null;
  let packaging = { requested: timeline.cards.length ? "hyperframes" : "none", engine: "none", cards: timeline.cards.length, panels: 0, fallbackReason: null };
  let hyperframes = { engine: "none", clips: [] };
  if (timeline.cards.length && job.options?.layout !== "landscape-tech") {
    try {
      hyperframes = await renderHyperframesCards(jobDir, timeline, version, job.options);
      packaging.engine = "hyperframes";
      packaging.panels = hyperframes.clips.filter(card => card.mode === "side-panel").length;
    } catch (error) {
      packaging = { ...packaging, engine: "ass-fallback", fallbackReason: error.message };
      job.degraded = [...(job.degraded || []), `HyperFrames 动态包装失败，已用 ASS 卡片继续：${error.message}`];
    }
  }
  const captionsEnabled = job.options.captions !== false;
  const requestedCaptionStyle = job.options?.layout === "landscape-tech" ? "static" : normalizeCaptionStyle(job.options.captionStyle);
  let captionPackaging = { requested: captionsEnabled ? requestedCaptionStyle : "none", engine: "none", style: requestedCaptionStyle, cues: 0, fallbackReason: null };
  if (captionsEnabled) {
    await writeAss(jobDir, job.transcript, segments, job.options?.layout === "landscape-tech" || packaging.engine === "ass-fallback" ? plan.overlayCards || [] : [], version, job.script, masterDimensions(job));
    const cues = dynamicCaptionCues(job, timeline);
    captionPackaging.cues = cues.length;
    if (requestedCaptionStyle === "static") captionPackaging.engine = "ass-static";
    else {
      try {
        captionPackaging = await renderHyperframesCaptions(jobDir, job, timeline, version);
      } catch (error) {
        captionPackaging = { ...captionPackaging, engine: "ass-fallback", fallbackReason: error.message };
        await writeJson(path.join(jobDir, `captions-v${version}.json`), { version, engine: "ass-fallback", style: requestedCaptionStyle, duration: timeline.outputDuration, cues, fallbackReason: error.message, generatedAt: new Date().toISOString() });
        job.degraded = [...(job.degraded || []), `HyperFrames 动态字幕失败，已用 ASS 字幕继续：${error.message}`];
      }
    }
  }
  const captionInputCount = captionPackaging.engine === "hyperframes" ? 1 : 0;
  const mediaPlan = await buildMediaRenderPlan(job, version, mediaManifest, 1 + hyperframes.clips.length + captionInputCount);
  segments.forEach((segment, i) => {
    const d = segment.end - segment.start;
    filters.push(`[0:v]trim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    filters.push(`[0:a]atrim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${Math.min(0.03, d / 3).toFixed(3)},afade=t=out:st=${Math.max(0, d - 0.03).toFixed(3)}:d=${Math.min(0.03, d / 3).toFixed(3)}[a${i}]`);
  });
  filters.push(`${segments.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);
  filters.push(`[vcat]${colorManagement.filter}[vcolor]`);
  if (landscapeHud) {
    filters.push(`[vcolor]${videoLayoutFilter(job.options.layout || "landscape-tech")}[vbase-raw]`);
    filters.push(`[vbase-raw]ass=filename='${path.basename(landscapeHud)}'[vbase]`);
  } else filters.push(`[vcolor]${videoLayoutFilter(job.options.layout || "landscape-tech")}[vbase]`);
  let videoLabel = "vbase";
  for (let index = 0; index < mediaPlan.filters.length; index += 2) {
    filters.push(mediaPlan.filters[index]);
    const nextLabel = `vmedia${index / 2}`;
    filters.push(mediaPlan.filters[index + 1].replace("__MEDIA_BASE__", videoLabel).replace("__MEDIA_OUT__", nextLabel));
    videoLabel = nextLabel;
  }
  if (mediaPlan.attributionFile) {
    filters.push(`[${videoLabel}]ass=filename='${path.basename(mediaPlan.attributionFile)}'[vattribution]`);
    videoLabel = "vattribution";
  }
  hyperframes.clips.forEach((card, index) => {
    const cardDuration = Math.max(0.5, card.outputEnd - card.outputStart);
    filters.push(`[${index + 1}:v]trim=duration=${cardDuration.toFixed(3)},setpts=PTS-STARTPTS+${card.outputStart.toFixed(3)}/TB[card${index}]`);
    filters.push(`[${videoLabel}][card${index}]overlay=x=(main_w-overlay_w)/2:y=0:eof_action=pass:shortest=0[vcard${index}]`);
    videoLabel = `vcard${index}`;
  });
  if (captionPackaging.engine === "hyperframes") {
    const captionInputIndex = hyperframes.clips.length + 1;
    filters.push(`[${captionInputIndex}:v]trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS[captiontrack]`);
    filters.push(`[${videoLabel}][captiontrack]overlay=0:0:eof_action=pass:shortest=0[vsub]`);
    filters.push("[vsub]fps=30,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[vout]");
  } else if (captionsEnabled) {
    filters.push(`[${videoLabel}]ass=filename='captions-v${version}.ass'[vsub]`);
    filters.push("[vsub]fps=30,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[vout]");
  } else filters.push(`[${videoLabel}]fps=30,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[vout]`);
  filters.push("[acat]highpass=f=80,lowpass=f=15000,loudnorm=I=-16:TP=-1.5:LRA=11[aout]");
  const filterFile = path.join(jobDir, `filter-v${version}.ffscript`); await fsp.writeFile(filterFile, filters.join(";\r\n") + ";\r\n", "utf8");
  const outputPath = path.join(jobDir, `final-v${version}.mp4`); let progressBuffer = "", stderr = "";
  const inputs = ["-i", job.sourcePath, ...hyperframes.clips.flatMap(card => ["-c:v", "libvpx-vp9", "-i", card.path]), ...(captionPackaging.engine === "hyperframes" ? ["-c:v", "libvpx-vp9", "-i", captionPackaging.path] : []), ...mediaPlan.inputArgs];
  const child = spawn("ffmpeg", ["-y", "-hide_banner", ...inputs, "-/filter_complex", filterFile, "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", outputPath], { cwd: jobDir, windowsHide: true });
  child.stdout.on("data", async chunk => {
    progressBuffer += String(chunk); const lines = progressBuffer.split(/\r?\n/); progressBuffer = lines.pop() || "";
    for (const line of lines) { const m = line.match(/^out_time_ms=(\d+)/); if (m && duration > 0) { job.progress = Math.min(98, Math.max(3, Math.round(Number(m[1]) / 1e6 / duration * 100))); await saveJob(job).catch(() => {}); } }
  });
  child.stderr.on("data", c => { stderr += c; if (stderr.length > 120000) stderr = stderr.slice(-120000); });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  if (code !== 0) throw Object.assign(new Error(`ffmpeg 渲染失败（退出码 ${code}）`), { stderr });
  await run("ffmpeg", ["-v", "error", "-i", outputPath, "-f", "null", "-"]);
  await finalizeMediaManifest(job, version, mediaManifest, mediaPlan);
  const output = await probe(outputPath), thumbnail = path.join(jobDir, `thumbnail-v${version}.jpg`);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(Math.min(1.2, output.duration / 3)), "-i", outputPath, "-frames:v", "1", "-q:v", "2", thumbnail]);
  await fsp.copyFile(outputPath, path.join(jobDir, "final.mp4"));
  job.progress = 82; await saveJob(job);
  let coverPackaging = { requested: job.options?.generateCover !== false, available: false, engine: "none", fallbackReason: null };
  if (coverPackaging.requested) {
    try {
      coverPackaging = await renderCover(job, version);
    } catch (error) {
      coverPackaging = { requested: true, available: false, engine: "failed", fallbackReason: error.message };
      job.degraded = [...(job.degraded || []), `封面生成失败，成片仍可正常审核：${error.message}`];
    }
  }
  job.progress = 88; await saveJob(job);
  const variants = await renderVariants(job, version, outputPath);
  job.progress = 94; await saveJob(job);
  const qaReport = await runQa(job, version, outputPath, duration, timeline, variants, packaging, captionPackaging, coverPackaging, mediaManifest, colorManagement);
  job.progress = 97; await saveJob(job);
  const reviewBundle = await createReviewBundle(job, version, outputPath, duration);
  const artifactUrl = name => `/video-jobs/${job.id}/${name}`;
  const versionResult = {
    version,
    path: outputPath,
    url: artifactUrl(`final-v${version}.mp4`),
    thumbnailUrl: artifactUrl(`thumbnail-v${version}.jpg`),
    metadata: output,
    qa: qaReport.checks,
    qaPass: qaReport.pass,
    provenance: plan.provenance,
    planEngine: plan.engine,
    packaging,
    captionPackaging,
    cover: coverPackaging,
    colorManagement,
    variants,
    reviewBundle,
    media: { policy: mediaManifest.policy, approvedAssets: mediaManifest.assets.filter(asset => asset.approved).length },
    artifacts: {
      editPlan: artifactUrl(`edit-plan-v${version}.json`),
      timeline: artifactUrl(`timeline-v${version}.json`),
      edl: artifactUrl(`timeline-v${version}.edl`),
      ...(captionsEnabled ? { captions: artifactUrl(`captions-v${version}.ass`) } : {}),
      ...(captionPackaging.engine === "hyperframes" || captionPackaging.engine === "ass-fallback" ? { captionStoryboard: artifactUrl(`captions-v${version}.json`) } : {}),
      filter: artifactUrl(`filter-v${version}.ffscript`),
      qa: artifactUrl(`qa-report-v${version}.json`),
      mediaManifest: artifactUrl(`media-manifest-v${version}.json`),
      reviewBundle: artifactUrl(`review-bundle-v${version}.json`),
      reviewPreview: reviewBundle.preview.url,
      ...(coverPackaging.available ? {
        coverDesign: artifactUrl(`cover-design-v${version}.json`),
        coverVertical: coverPackaging.vertical.url,
        coverGrid: coverPackaging.grid.url,
        coverWide16x9: coverPackaging.wide16x9.url,
        coverLandscape4x3: coverPackaging.landscape4x3.url
      } : {})
    },
    createdAt: new Date().toISOString(),
    model: job.planModel || null
  };
  job.versions = [...(job.versions || []).filter(x => x.version !== version), versionResult];
  job.output = versionResult;
  job.jobDir = jobDir;
  job.status = "awaiting_review";
  job.progress = 100;
  await saveJob(job);
  await auditRenderedJobAfterFinalRender(job, "legacy_ffmpeg_render_version");
}
async function processJob(job) {
  if (running.has(job.id)) return; running.set(job.id, true);
  const jobDir = confined(jobsRoot, job.id);
  try {
    delete job.error; delete job.errorDetail; delete job.revisionError;
    job.degraded = [];
    job.status = "analyzing"; job.progress = 4; await saveJob(job);
    job.source = await probe(job.sourcePath);
    if (!job.source.hasAudio) throw new Error("原视频没有音轨，无法进行口播转录和剪辑");
    let silences = [];
    if (job.source.hasAudio && job.options.removeSilence !== false) {
      const result = await run("ffmpeg", ["-hide_banner", "-i", job.sourcePath, "-af", `silencedetect=noise=${Number(job.options.silenceDb ?? -36)}dB:d=${Number(job.options.silenceDuration ?? 0.45)}`, "-f", "null", "-"]);
      silences = parseSilences(result.stderr, job.source.duration);
    }
    const fallback = buildKeepSegments(job.source.duration, silences, Number(job.options.pauseKeep ?? 0.12));
    job.analysis = { silences, baseKeepSegments: fallback, removedDuration: job.source.duration - fallback.reduce((s, x) => s + x.end - x.start, 0) };
    job.status = "transcribing"; job.progress = 15; await saveJob(job);
    try {
      const result = await runAi({ operation: "transcribe", input_path: job.sourcePath, output_dir: jobDir, model_size: job.options.transcriptionModel || "small", language: "zh" }, jobDir, "transcribe");
      job.transcript = result.data; job.transcriptionModel = result.model;
    } catch (error) {
      job.degraded = [...(job.degraded || []), `本地转录失败，退回口播稿时间估算：${error.message}`];
      job.transcript = { text: job.script || "", segments: [{ start: 0, end: job.source.duration, text: job.script || "" }], words: [], model: "script-fallback" };
      job.transcriptionModel = "script-fallback";
    }
    job.status = "planning"; job.progress = 45; await saveJob(job);
    let aiPlan = null;
    try {
      const result = await runAi({ operation: "edit_plan", script: job.script, content_direction: job.contentDirection, source: job.source, transcript: job.transcript, base_plan: { silences, keepSegments: fallback } }, jobDir, "edit-plan-v1");
      aiPlan = result.data; job.planModel = result.model; job.modelUsage = result.usage;
    } catch (error) { job.degraded = [...(job.degraded || []), `AI剪辑决策失败，使用停顿剪辑：${error.message}`]; }
    job.currentVersion = 1;
    const validation = validatePlan(aiPlan, job.source.duration, fallback, "semantic");
    job.currentPlan = { version: 1, ...validation, editSummary: aiPlan?.editSummary || "本地停顿剪辑", removedReasons: aiPlan?.removedReasons || [], createdAt: new Date().toISOString() };
    await writeJson(path.join(jobDir, "edit-plan-v1.json"), job.currentPlan);
    await saveJob(job);
    await prepareAssetCandidates(job);
    job.status = "awaiting_asset_review";
    job.progress = 60;
    job.assetReview = assetReviewSummary(job, job.currentPlan.keepSegments.reduce((sum, segment) => sum + segment.end - segment.start, 0));
    await saveJob(job);
  } catch (error) {
    job.status = "error"; job.error = error.message; job.errorDetail = String(error.stderr || "").slice(-8000); await saveJob(job);
  } finally { running.delete(job.id); }
}
async function reviseJob(job, feedback) {
  if (running.has(job.id)) return; running.set(job.id, true);
  const dir = confined(jobsRoot, job.id);
  const previous = {
    currentVersion: job.currentVersion,
    currentPlan: job.currentPlan,
    planModel: job.planModel,
    modelUsage: job.modelUsage,
    output: job.output,
    status: job.status,
    progress: job.progress,
    approvedAt: job.approvedAt
  };
  try {
    const version = Number(job.currentVersion || 1) + 1;
    job.status = "revising"; job.progress = 5; job.reviews = [...(job.reviews || []), { version: job.currentVersion, feedback, createdAt: new Date().toISOString() }]; await saveJob(job);
    const result = await runAi({ operation: "revise_plan", feedback, script: job.script, content_direction: job.contentDirection, source: job.source, transcript: job.transcript, base_plan: job.currentPlan }, dir, `edit-plan-v${version}`);
    const fallback = job.currentPlan.keepSegments;
    job.currentVersion = version; job.planModel = result.model; job.modelUsage = result.usage;
    let revisedOverlays = normalizeOverlays(result.data?.overlayCards, job.source.duration);
    const overlayLimit = feedbackOverlayLimit(feedback);
    if (overlayLimit !== null) revisedOverlays = revisedOverlays.slice(0, overlayLimit);
    const validation = validatePlan({ ...result.data, overlayCards: revisedOverlays }, job.source.duration, fallback, "semantic-revision");
    job.currentPlan = { version, ...validation, editSummary: result.data?.editSummary || `按反馈修改：${feedback}`, removedReasons: result.data?.removedReasons || [], feedback, createdAt: new Date().toISOString() };
    await writeJson(path.join(dir, `edit-plan-v${version}.json`), job.currentPlan); await saveJob(job); await renderVersion(job, version);
  } catch (error) {
    job.currentVersion = previous.currentVersion;
    job.currentPlan = previous.currentPlan;
    job.planModel = previous.planModel;
    job.modelUsage = previous.modelUsage;
    job.output = previous.output;
    job.status = previous.status === "approved" ? "approved" : "awaiting_review";
    job.progress = previous.progress ?? 100;
    job.approvedAt = previous.approvedAt;
    const review = job.reviews?.at(-1);
    if (review && review.feedback === feedback) { review.failed = true; review.error = error.message; }
    job.revisionError = error.message;
    job.errorDetail = String(error.stderr || "").slice(-8000);
    await saveJob(job);
  } finally { running.delete(job.id); }
}
async function replanJob(job, feedback = "") {
  if (running.has(job.id)) return;
  running.set(job.id, true);
  const dir = confined(jobsRoot, job.id);
  const previous = { currentVersion: job.currentVersion, currentPlan: job.currentPlan, planModel: job.planModel, modelUsage: job.modelUsage, output: job.output, status: job.status, progress: job.progress };
  try {
    if (!job.source || !job.transcript) throw new Error("任务缺少源视频分析或逐字稿，不能跳过转录重新规划");
    const version = Math.max(1, ...(job.versions || []).map(item => Number(item.version) || 0), Number(job.currentVersion) || 0) + 1;
    job.status = "planning"; job.progress = 8; delete job.revisionError; await saveJob(job);
    const operation = feedback.trim() ? "revise_plan" : "edit_plan";
    const result = await runAi({ operation, script: job.script, content_direction: job.contentDirection, source: job.source, transcript: job.transcript, base_plan: { silences: job.analysis?.silences || [], keepSegments: job.analysis?.baseKeepSegments || job.currentPlan?.keepSegments || [] }, feedback }, dir, `edit-plan-v${version}`);
    const fallback = job.analysis?.baseKeepSegments || job.currentPlan?.keepSegments || [{ start: 0, end: job.source.duration, reason: "完整保留" }];
    const validation = validatePlan(result.data, job.source.duration, fallback, "semantic");
    job.currentVersion = version; job.planModel = result.model; job.modelUsage = result.usage;
    job.currentPlan = { version, ...validation, editSummary: result.data?.editSummary || "重新生成语义剪辑计划", removedReasons: result.data?.removedReasons || [], feedback: feedback || null, createdAt: new Date().toISOString() };
    await writeJson(path.join(dir, `edit-plan-v${version}.json`), job.currentPlan);
    await saveJob(job);
    const duration = job.currentPlan.keepSegments.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0);
    job.assetReview = assetReviewSummary(job, duration);
    if (!job.output || !job.assetReview.renderReady) {
      job.status = "awaiting_asset_review";
      job.progress = 60;
      await saveJob(job);
      return;
    }
    await renderVersion(job, version);
  } catch (error) {
    Object.assign(job, previous);
    job.status = previous.status === "approved" ? "approved" : "awaiting_review";
    job.revisionError = error.message;
    job.errorDetail = String(error.stderr || "").slice(-8000);
    await saveJob(job);
  } finally { running.delete(job.id); }
}
async function renderReviewedAssets(job, reason = "素材审核完成") {
  if (running.has(job.id)) return;
  const duration = job.currentPlan?.keepSegments?.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || Number(job.source?.duration || 0);
  const review = assetReviewSummary(job, duration);
  if (!review.reviewComplete) throw Object.assign(new Error("仍有素材未批准或拒绝，不能开始最终渲染"), { statusCode: 409 });
  if (!review.renderReady) throw Object.assign(new Error(review.complianceIssues.map(item => `${item.assetId}：${item.issue}`).join("；") || "素材合规检查未通过"), { statusCode: 409 });
  running.set(job.id, true);
  try {
    if (!job.source || !job.transcript || !job.currentPlan?.keepSegments?.length) throw new Error("任务缺少源视频、逐字稿或当前剪辑计划");
    const previousVersions = job.versions || [];
    const highestRendered = Math.max(0, ...previousVersions.map(item => Number(item.version) || 0));
    const version = highestRendered > 0 ? Math.max(highestRendered, Number(job.currentVersion) || 0) + 1 : Math.max(1, Number(job.currentVersion) || 1);
    job.currentVersion = version;
    job.currentPlan = { ...job.currentPlan, version, feedback: reason, createdAt: new Date().toISOString() };
    job.status = "rendering";
    job.progress = 62;
    job.assetReview = review;
    delete job.error;
    delete job.errorDetail;
    delete job.approvedAt;
    delete job.revisionError;
    await writeJson(path.join(confined(jobsRoot, job.id), `edit-plan-v${version}.json`), job.currentPlan);
    await saveJob(job);
    await renderVersion(job, version);
  } catch (error) {
    job.status = "error";
    job.error = error.message;
    job.errorDetail = String(error.stderr || "").slice(-8000);
    await saveJob(job);
  } finally { running.delete(job.id); }
}
async function autoReviewLocalAssetsForPreview(job) {
  const duration = job.currentPlan?.keepSegments?.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || Number(job.source?.duration || 0);
  const decidedAt = new Date().toISOString();
  const decisions = [];
  for (const asset of job.assets || []) {
    if (asset.reviewStatus !== "pending") continue;
    const isLocalRenderable = !EXTERNAL_SOURCE_TYPES.has(asset.sourceType) && !PAID_SOURCE_TYPES.has(asset.sourceType)
      && ["image", "video"].includes(asset.mediaKind) && asset.path && fs.existsSync(asset.path) && asset.placement;
    asset.reviewStatus = isLocalRenderable ? "approved" : "rejected";
    asset.approved = isLocalRenderable;
    asset.updatedAt = decidedAt;
    decisions.push({
      assetId: asset.id,
      reviewStatus: asset.reviewStatus,
      placement: asset.placement || null,
      licenseBasis: asset.licenseBasis || "",
      usagePurpose: asset.usagePurpose || "",
      reason: isLocalRenderable ? "完整预览模式自动采用可渲染的本地富媒体素材" : "完整预览模式跳过外部、付费、缺文件或缺时间段素材",
      decidedAt
    });
  }
  job.options = { ...job.options, reviewMode: "full-preview-with-context-segments", autoReviewLocalAssets: true };
  job.assetDecisions = [...(job.assetDecisions || []), ...decisions];
  job.assetReview = assetReviewSummary(job, duration);
  const visualSampleInProgress = job.workflow?.version === VISUAL_WORKFLOW_VERSION && job.workflow?.currentStage === "motion_sample";
  job.status = visualSampleInProgress ? "rendering_sample" : "awaiting_asset_review";
  job.progress = visualSampleInProgress ? visualStageProgress("motion_sample") : 60;
  const jobDir = confined(jobsRoot, job.id);
  await writeJson(path.join(jobDir, "asset-decisions.json"), job.assetDecisions);
  await writeJson(path.join(jobDir, "asset-candidates.json"), { discovery: job.assetDiscovery, assets: job.assets });
  await saveJob(job);
  return { decisions, review: job.assetReview };
}
async function rerenderJob(job, reason = "", renderOptions = {}) {
  if (running.has(job.id)) return;
  running.set(job.id, true);
  const dir = confined(jobsRoot, job.id);
  const previous = { currentVersion: job.currentVersion, currentPlan: job.currentPlan, output: job.output, options: job.options, status: job.status, progress: job.progress, approvedAt: job.approvedAt };
  try {
    job.source = await probe(job.sourcePath);
    if (!job.source || !job.transcript || !job.currentPlan?.keepSegments?.length) throw new Error("任务缺少源视频、逐字稿或当前剪辑计划，不能本地重渲染");
    const version = Math.max(1, ...(job.versions || []).map(item => Number(item.version) || 0), Number(job.currentVersion) || 0) + 1;
    job.status = "rendering";
    job.progress = 5;
    job.currentVersion = version;
    job.options = {
      ...job.options,
      layout: ["landscape-tech", "original", "vertical", "square"].includes(renderOptions.layout) ? renderOptions.layout : job.options.layout,
      captionStyle: normalizeCaptionStyle(renderOptions.captionStyle ?? job.options.captionStyle),
      informationPanels: renderOptions.informationPanels === undefined ? job.options.informationPanels !== false : renderOptions.informationPanels !== false,
      generateCover: renderOptions.generateCover === undefined ? job.options.generateCover !== false : renderOptions.generateCover !== false,
      coverTitle: renderOptions.coverTitle === undefined ? cleanCoverCopy(job.options.coverTitle, 42) : cleanCoverCopy(renderOptions.coverTitle, 42),
      contentTitle: renderOptions.contentTitle === undefined ? cleanCoverCopy(job.options.contentTitle, 42) : cleanCoverCopy(renderOptions.contentTitle, 42)
    };
    job.currentPlan = { ...job.currentPlan, version, feedback: reason || job.currentPlan.feedback || null, createdAt: new Date().toISOString() };
    job.degraded = (job.degraded || []).filter(item => !String(item).startsWith("AI剪辑决策失败，使用停顿剪辑："));
    delete job.revisionError;
    delete job.errorDetail;
    delete job.approvedAt;
    await writeJson(path.join(dir, `edit-plan-v${version}.json`), job.currentPlan);
    await saveJob(job);
    await renderVersion(job, version);
  } catch (error) {
    Object.assign(job, previous);
    job.status = previous.status === "approved" ? "approved" : "awaiting_review";
    job.revisionError = error.message;
    job.errorDetail = String(error.stderr || "").slice(-8000);
    await saveJob(job);
  } finally { running.delete(job.id); }
}
async function regenerateCover(job, options = {}) {
  if (running.has(job.id)) throw Object.assign(new Error("任务仍在处理中"), { statusCode: 409 });
  if (!job.output?.version || !job.sourcePath || !job.source) throw Object.assign(new Error("当前任务还没有可用成片，不能单独生成封面"), { statusCode: 409 });
  running.set(job.id, true);
  try {
    job.options = {
      ...job.options,
      generateCover: true,
      coverTitle: options.coverTitle === undefined ? cleanCoverCopy(job.options?.coverTitle, 42) : cleanCoverCopy(options.coverTitle, 42),
      contentTitle: options.contentTitle === undefined ? cleanCoverCopy(job.options?.contentTitle, 42) : cleanCoverCopy(options.contentTitle, 42)
    };
    const version = Number(job.output.version);
    const cover = await renderCover(job, version);
    const artifactUrl = name => `/video-jobs/${job.id}/${name}`;
    const coverArtifacts = {
      coverDesign: artifactUrl(`cover-design-v${version}.json`),
      coverVertical: cover.vertical.url,
      coverGrid: cover.grid.url,
      coverWide16x9: cover.wide16x9.url,
      coverLandscape4x3: cover.landscape4x3.url
    };
    const updatedOutput = { ...job.output, cover, qa: { ...(job.output.qa || {}), coverDimensions: true }, artifacts: { ...(job.output.artifacts || {}), ...coverArtifacts } };
    job.output = updatedOutput;
    job.versions = (job.versions || []).map(item => Number(item.version) === version ? updatedOutput : item);
    try {
      const qaPath = path.join(confined(jobsRoot, job.id), `qa-report-v${version}.json`);
      const qaReport = await readJsonFile(qaPath);
      qaReport.checks = { ...(qaReport.checks || {}), coverDimensions: true };
      qaReport.coverPackaging = cover;
      qaReport.coverUpdatedAt = new Date().toISOString();
      await writeJson(qaPath, qaReport);
    } catch {}
    await saveJob(job);
    return cover;
  } finally {
    running.delete(job.id);
  }
}
async function receiveUpload(req, target) {
  const max = 8 * 1024 ** 3; let total = 0; const stream = fs.createWriteStream(target, { flags: "wx" });
  await new Promise((resolve, reject) => {
    req.on("data", chunk => { total += chunk.length; if (total > max) { reject(new Error("视频超过8GB限制")); req.destroy(); return; } if (!stream.write(chunk)) { req.pause(); stream.once("drain", () => req.resume()); } });
    req.on("end", () => stream.end(resolve)); req.on("error", reject); stream.on("error", reject);
  }); return total;
}
async function readBodyJson(req, limit = 1024 * 1024) {
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > limit) throw new Error("请求内容过大"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
async function serveFile(req, res, file) {
  const stat = await fsp.stat(file), type = mime[path.extname(file).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;
  if (range && /^(video|audio)\//.test(type)) {
    const match = range.match(/bytes=(\d*)-(\d*)/), start = match?.[1] ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    cors(res); res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" }); fs.createReadStream(file, { start, end }).pipe(res); return;
  }
  cors(res); res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" }); fs.createReadStream(file).pipe(res);
}

const multiAgentEnabled = process.env.KOUBO_MULTI_AGENT_ENABLED === "1";
const contentAdvisoryEnabled = process.env.KOUBO_CONTENT_ADVISORY_ENABLED !== "0";
const multiAgentDataRoot = path.resolve(
  root,
  process.env.KOUBO_MULTI_AGENT_DATA_ROOT || "data/multi-agent"
);
const multiAgentPython = path.resolve(
  root,
  process.env.KOUBO_MULTI_AGENT_PYTHON || ".runtime-multi-agent/Scripts/python.exe"
);
const multiAgentBridge = path.join(here, "multi_agent_bridge.py");
const multiAgentStore = openDomainStore({
  dbPath: path.join(multiAgentDataRoot, "runtime", "memory.sqlite"),
  exportRoot: path.join(multiAgentDataRoot, "library"),
});
const multiAgentProfiles = await loadAgentProfiles(root);
const multiAgentContentPrinciples = validateLibrary(
  "content-principle",
  await readJsonFile(path.join(root, "config", "multi-agent", "content-principles.json"))
);
const multiAgentMemory = createMemoryService(multiAgentStore, multiAgentProfiles);
const multiAgentBridgeRoot = path.join(multiAgentDataRoot, "runtime", "bridge");
const multiAgentArtifactRoot = path.join(multiAgentDataRoot, "runtime", "artifacts");
const configuredTutorialRoots = String(process.env.KOUBO_TUTORIAL_ROOTS || "")
  .split(path.delimiter)
  .map(item => item.trim())
  .filter(Boolean)
  .map(item => path.resolve(item));
const allowedTutorialRoots = [
  path.join(root, ".cache"),
  jobsRoot,
  ...configuredTutorialRoots,
];

function multiAgentSafeInput(value, seen = new WeakSet()) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(item => multiAgentSafeInput(item, seen)).filter(item => item !== undefined);
  if (!value || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "signal" || /(api.?key|access.?token|password|authorization|cookie|secret)/i.test(key)) continue;
    const item = multiAgentSafeInput(value[key], seen);
    if (item !== undefined) output[key] = item;
  }
  seen.delete(value);
  return output;
}

async function invokeMultiAgentBridge(request) {
  if (!fs.existsSync(multiAgentPython) || !fs.existsSync(multiAgentBridge)) {
    throw new Error("multi-agent Python runtime is unavailable");
  }
  await fsp.mkdir(multiAgentBridgeRoot, { recursive: true });
  const id = crypto.randomUUID();
  const requestFile = path.join(multiAgentBridgeRoot, `${id}.request.json`);
  const responseFile = path.join(multiAgentBridgeRoot, `${id}.response.json`);
  const safe = multiAgentSafeInput(request);
  const payload = {
    operation: safe.operation,
    agent_id: safe.agentId,
    prompt: canonicalJson(safe),
  };
  if (safe.fixture_response !== undefined) payload.fixture_response = safe.fixture_response;
  await writeJson(requestFile, payload);
  try {
    try {
      await run(
        multiAgentPython,
        [multiAgentBridge, "--request", requestFile, "--response", responseFile],
        { cwd: root, env: process.env, signal: request.signal }
      );
    } catch (error) {
      if (!fs.existsSync(responseFile)) throw error;
    }
    const response = await readJsonFile(responseFile);
    if (!response.success) throw new Error(response.error || "multi-agent bridge failed");
    return response;
  } finally {
    await Promise.all([
      fsp.rm(requestFile, { force: true }),
      fsp.rm(responseFile, { force: true }),
    ]);
  }
}

const multiAgentOrdinaryViewerCritic = createOrdinaryViewerCritic({
  invokeAgent: request => invokeMultiAgentBridge({
    ...request,
    agentId: "ordinary-viewer-critic",
  }),
});

const multiAgentOrchestrator = createOrchestrator({
  invokeAgent: invokeMultiAgentBridge,
  memory: multiAgentMemory,
  contentPrinciples: multiAgentContentPrinciples,
});

async function writeMultiAgentArtifact(kind, id, value) {
  const safeKind = safeName(kind).replace(/\./g, "_");
  const safeId = safeName(id).replace(/\//g, "_");
  const directory = confined(multiAgentArtifactRoot, safeKind);
  await fsp.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${safeId}.json`);
  const safeValue = multiAgentSafeInput(value);
  const serialized = JSON.stringify(safeValue, null, 2);
  try {
    await fsp.writeFile(file, serialized, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readJsonFile(file);
    if (canonicalJson(existing) !== canonicalJson(safeValue)) {
      const conflict = new Error("multi-agent artifact id already exists with different immutable content");
      conflict.statusCode = 409;
      throw conflict;
    }
  }
  return `/api/multi-agent/artifacts/${encodeURIComponent(safeKind)}/${encodeURIComponent(safeId)}`;
}

async function readMultiAgentArtifact(kind, id) {
  const safeKind = safeName(kind).replace(/\./g, "_");
  const safeId = safeName(id).replace(/\//g, "_");
  const file = confined(path.join(multiAgentArtifactRoot, safeKind), `${safeId}.json`);
  try {
    return multiAgentSafeInput(await readJsonFile(file));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function listMultiAgentMemory({ kind, status } = {}) {
  const conditions = [];
  const values = [];
  if (kind) {
    conditions.push("kind = ?");
    values.push(kind);
  }
  if (status) {
    conditions.push("status = ?");
    values.push(status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return multiAgentStore.db.prepare(
    `SELECT records.kind, records.json,
      (
        SELECT transitions.id
        FROM transitions
        WHERE transitions.record_kind = records.kind
          AND transitions.record_id = records.id
          AND transitions.rolled_back_at IS NULL
        ORDER BY transitions.created_at DESC, transitions.id DESC
        LIMIT 1
      ) AS latest_transition_id
    FROM records ${where}
    ORDER BY records.updated_at DESC, records.kind, records.id
    LIMIT 500`
  ).all(...values).map(row => ({
    kind: row.kind,
    ...multiAgentSafeInput(JSON.parse(row.json)),
    latestTransitionId: row.latest_transition_id || null,
  }));
}

function parseLastJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("tutorial runner returned no JSON");
  return JSON.parse(text.slice(start, end + 1));
}

const multiAgentTutorials = {
  async ingest({ inputPath, author, license, resume }) {
    const args = [
      path.join(root, "scripts", "ingest_tutorial.mjs"),
      "--input", inputPath,
      "--author", author,
      "--license", license,
      ...(resume ? ["--resume"] : []),
    ];
    const result = await run(process.execPath, args, {
      cwd: root,
      env: {
        ...process.env,
        KOUBO_MULTI_AGENT_DATA_ROOT: multiAgentDataRoot,
        KOUBO_MULTI_AGENT_PYTHON: multiAgentPython,
      },
      timeoutMs: 90 * 60 * 1000,
    });
    return parseLastJson(result.stdout);
  },
  async get(id) {
    const directory = path.join(multiAgentDataRoot, "runtime", "tutorial-ingest", "checkpoints");
    let entries;
    try { entries = await fsp.readdir(directory); } catch { return null; }
    for (const name of entries.filter(item => item.endsWith(".json"))) {
      try {
        const checkpoint = await readJsonFile(path.join(directory, name));
        if (checkpoint.id === id || checkpoint.sourceHash === id) return multiAgentSafeInput(checkpoint);
      } catch {}
    }
    return null;
  },
};

const multiAgentApi = createMultiAgentApi({
  enabled: multiAgentEnabled,
  advisoryEnabled: contentAdvisoryEnabled,
  defaultPipeline: VISUAL_WORKFLOW_VERSION,
  allowedTutorialRoots,
  allowedRenderedRoots: [jobsRoot],
  readJob: async id => {
    const job = await readJob(id);
    const keeps = Array.isArray(job.currentPlan?.keepSegments) ? job.currentPlan.keepSegments : [];
    if (keeps.length) {
      job.ordinaryViewerTranscript = transcriptCues(job.transcript, keeps, job.script)
        .map(item => ({ start: Number(item.start), end: Number(item.end), text: String(item.text || "").trim() }))
        .filter(item => item.text && Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start);
    }
    return job;
  },
  readContent,
  writeArtifact: writeMultiAgentArtifact,
  readArtifact: readMultiAgentArtifact,
  listMemory: listMultiAgentMemory,
  memory: multiAgentMemory,
  tutorials: multiAgentTutorials,
  orchestrator: multiAgentOrchestrator,
  contentStrategist: {
    analyze: async input => (await multiAgentOrchestrator.analyzeContentDirection(input)).analysis,
  },
  contentPrinciples: multiAgentContentPrinciples,
  ordinaryViewerCritic: multiAgentOrdinaryViewerCritic,
  buildBlindReviewBundle,
});

const server = http.createServer(async (req, res) => {
  try {
    cors(res); if (req.method === "OPTIONS") return res.writeHead(204).end();
    const url = new URL(req.url, `http://${host}:${port}`), pathname = decodeURIComponent(url.pathname);
    if (await multiAgentApi.handle(req, res, url)) return;
    if (req.method === "GET" && pathname === "/api/health") {
      let ffmpeg = false, hyperframes = false, ai = null;
      try { await run("ffmpeg", ["-version"]); ffmpeg = true; } catch {}
      try { await run("npx", ["-y", "hyperframes", "--version"], { shell: true }); hyperframes = true; } catch {}
      try { ai = await runAi({ operation: "config" }, contentRoot, "model-config"); } catch (error) { ai = { success: false, error: error.message }; }
      return json(res, 200, {
        ok: true,
        service: "koubo-ai-workflow",
        version: 4,
        defaultPipeline: VISUAL_WORKFLOW_VERSION,
        legacyPipeline: "ffmpeg-v3",
        localOnlyVideo: true,
        ffmpeg,
        hyperframes,
        ai: { configured: !!ai?.success, model: ai?.model || null, transcriptionModel: ai?.transcription_model || "faster-whisper/small" },
        workflow: {
          version: visualWorkflowDefaults.workflowVersion,
          engine: visualWorkflowDefaults.defaultEngine,
          stages: VISUAL_STAGE_ORDER,
          keyframeReviewRequired: true,
          sampleReviewRequired: true,
          finalMaster: visualWorkflowDefaults.rendering.final,
        },
        multiAgent: {
          enabled: multiAgentEnabled,
          pipeline: "controlled-multi-agent-v1",
          default: false,
          humanApprovalRequired: true,
          autoPublish: false,
        },
        jobsRoot,
        contentRoot,
      });
    }
    if (req.method === "GET" && pathname === "/api/video-workflow/defaults") {
      return json(res, 200, { workflow: visualWorkflowDefaults });
    }
    if (req.method === "POST" && pathname === "/api/video-workflow/drafts") {
      const options = await readBodyJson(req, 512 * 1024);
      const draftId = crypto.randomBytes(16).toString("hex");
      workflowDrafts.set(draftId, { options, createdAt: Date.now() });
      for (const [id, draft] of workflowDrafts) if (Date.now() - draft.createdAt > 30 * 60 * 1000) workflowDrafts.delete(id);
      return json(res, 201, { draftId, expiresInSeconds: 1800 });
    }
    if (req.method === "GET" && pathname === "/api/contents") return json(res, 200, { items: await listGeneratedContents() });
    if (req.method === "POST" && pathname === "/api/contents/generate") {
      const hasBody = Number(req.headers["content-length"] || 0) > 0 || String(req.headers["transfer-encoding"] || "").toLowerCase() === "chunked";
      const options = hasBody ? await readBodyJson(req, 64 * 1024) : {};
      return json(res, 201, { item: await generateContent(options) });
    }
    if (req.method === "GET" && pathname === "/api/jobs") {
      const entries = await fsp.readdir(jobsRoot, { withFileTypes: true }), jobs = [];
      for (const e of entries.filter(x => x.isDirectory()).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 30)) try { jobs.push(await readJob(e.name)); } catch {}
      return json(res, 200, { jobs });
    }
    if (req.method === "POST" && pathname === "/api/jobs") {
      const id = timestampId(), dir = confined(jobsRoot, id); await fsp.mkdir(dir, { recursive: false });
      const fileName = safeName(decodeURIComponent(req.headers["x-file-name"] || "video.mp4")), sourcePath = path.join(dir, fileName);
      const workflowDraftId = String(req.headers["x-workflow-draft"] || "");
      let options = workflowDrafts.get(workflowDraftId)?.options || {};
      if (!workflowDraftId || !workflowDrafts.has(workflowDraftId)) {
        try { options = JSON.parse(decodeURIComponent(req.headers["x-options"] || "%7B%7D")); } catch {}
      }
      if (workflowDraftId) workflowDrafts.delete(workflowDraftId);
      const sizeBytes = await receiveUpload(req, sourcePath);
      const contentId = decodeURIComponent(req.headers["x-content-id"] || "");
      const pipeline = options.pipeline === "ffmpeg-v3" || options.pipeline === "legacy-ffmpeg-v3" ? "ffmpeg-v3" : VISUAL_WORKFLOW_VERSION;
      const workflowConfig = pipeline === VISUAL_WORKFLOW_VERSION
        ? normalizeVisualWorkflowConfig(visualWorkflowDefaults, options.workflowConfig || {})
        : null;
      const contentSettings = workflowConfig?.stages?.content_breakdown?.settings || {};
      const job = {
        id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "uploaded", progress: 0,
        pipeline,
        fileName, sizeBytes, sourcePath, contentId, contentDirection: await contentDirectionFor(contentId), script: String(options.script || ""),
        options: {
          removeSilence: contentSettings.removeSilence === undefined ? options.removeSilence !== false : contentSettings.removeSilence !== false,
          captions: options.captions !== false,
          captionStyle: normalizeCaptionStyle(options.captionStyle), informationPanels: options.informationPanels !== false,
          layout: pipeline === VISUAL_WORKFLOW_VERSION ? "landscape-tech" : ["landscape-tech", "original", "vertical", "square"].includes(options.layout) ? options.layout : "landscape-tech",
          generateVariants: options.generateVariants !== false, generateCover: options.generateCover !== false,
          coverTitle: cleanCoverCopy(options.coverTitle, 42), contentTitle: cleanCoverCopy(options.contentTitle, 42),
          silenceDb: Number(options.silenceDb ?? -36), silenceDuration: Number(contentSettings.silenceDuration ?? options.silenceDuration ?? 0.45),
          pauseKeep: Number(contentSettings.pauseKeep ?? options.pauseKeep ?? 0.12), transcriptionModel: contentSettings.transcriptionModel || options.transcriptionModel || "small", aiMode: "full-auto",
          visualStrategy: "rich-media-first",
          cloudImageGenerationEnabled: options.cloudImageGenerationEnabled === true,
          paidImageGenerationConfirmation: options.paidImageGenerationConfirmation !== false,
          rightsReviewMode: options.rightsReviewMode === "advisory" ? "advisory" : "strict"
        },
        versions: [], reviews: [], assets: [], jobDir: dir,
        ...(workflowConfig ? { workflow: createVisualWorkflowState(workflowConfig) } : {}),
      };
      if (workflowConfig) await saveVisualWorkflowConfig(job);
      await saveJob(job);
      if (pipeline === VISUAL_WORKFLOW_VERSION) runVisualWorkflowChain(job, "style_research");
      else processJob(job);
      return json(res, 202, { job });
    }
    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) return json(res, 200, { job: await readJob(jobMatch[1]) });
    const workflowStageMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/workflow\/stages\/([^/]+)\/(config|run|approve)$/);
    if (req.method === "POST" && workflowStageMatch) {
      const [, jobId, requestedStageId, action] = workflowStageMatch;
      const body = await readBodyJson(req, 256 * 1024);
      const job = await readJob(jobId);
      if (job.pipeline !== VISUAL_WORKFLOW_VERSION && job.workflow?.version !== VISUAL_WORKFLOW_VERSION) return json(res, 409, { error: "该任务不是视觉导演 v4 工作流" });
      const stageId = requestedStageId === "keyframe_review" && action === "run" ? "keyframes" : requestedStageId;
      if (!VISUAL_STAGE_ORDER.includes(requestedStageId)) return json(res, 404, { error: "未知工作流阶段" });
      if (action === "config") {
        const stage = await updateVisualStageConfig(job, requestedStageId, body);
        return json(res, 200, { job, stage });
      }
      if (running.has(job.id)) return json(res, 409, { error: "任务仍在处理中" });
      if (body.settings !== undefined || body.prompt !== undefined) await updateVisualStageConfig(job, requestedStageId, body);
      if (action === "approve") {
        await approveVisualGate(job, requestedStageId, body);
        return json(res, 202, { job, nextStage: requestedStageId === "keyframe_review" ? "motion_sample" : "full_render" });
      }
      const feedback = String(body.feedback || "").trim();
      if (stageId === "motion_sample" && job.workflow?.stages?.keyframe_review?.status !== "approved") return json(res, 409, { error: "请先批准关键帧" });
      if (stageId === "full_render" && job.workflow?.stages?.motion_sample?.status !== "approved") return json(res, 409, { error: "请先批准动态样片" });
      runVisualWorkflowChain(job, stageId, feedback);
      return json(res, 202, { job, stageId });
    }
    const retryMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/retry$/);
    if (req.method === "POST" && retryMatch) {
      const job = await readJob(retryMatch[1]);
      if (running.has(job.id)) return json(res, 409, { error: "任务仍在处理中" });
      delete job.error; delete job.errorDetail; delete job.revisionError;
      if (job.pipeline === VISUAL_WORKFLOW_VERSION || job.workflow?.version === VISUAL_WORKFLOW_VERSION) {
        const failedStage = job.errorStage || job.workflow?.currentStage || "style_research";
        const retryStage = failedStage === "keyframe_review" ? "keyframes" : failedStage;
        runVisualWorkflowChain(job, retryStage);
      } else processJob(job);
      return json(res, 202, { job });
    }
    const reviseMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/revise$/);
    if (req.method === "POST" && reviseMatch) {
      const body = await readBodyJson(req); const feedback = String(body.feedback || "").trim();
      if (!feedback) return json(res, 400, { error: "请填写修改意见" });
      const job = await readJob(reviseMatch[1]);
      if (job.pipeline === VISUAL_WORKFLOW_VERSION || job.workflow?.version === VISUAL_WORKFLOW_VERSION) {
        if (running.has(job.id)) return json(res, 409, { error: "任务仍在处理中" });
        if (job.workflow?.stages?.motion_sample?.status !== "approved") return json(res, 409, { error: "动态样片尚未批准，不能返修完整视频" });
        job.reviews = [...(job.reviews || []), { version: job.output?.version || job.currentVersion || null, feedback, createdAt: new Date().toISOString() }];
        delete job.approvedAt;
        await saveJob(job);
        runVisualWorkflowChain(job, "full_render", feedback);
        return json(res, 202, { job, reusedTranscript: true, reusedDesign: true });
      }
      const duration = job.currentPlan?.keepSegments?.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || Number(job.source?.duration || 0);
      if (!assetReviewSummary(job, duration).renderReady) return json(res, 409, { error: "请先在素材审核板处理全部候选，再进行成片返修" });
      reviseJob(job, feedback); return json(res, 202, { job });
    }
    const replanMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/replan$/);
    if (req.method === "POST" && replanMatch) {
      const body = await readBodyJson(req);
      const job = await readJob(replanMatch[1]);
      if (running.has(job.id)) return json(res, 409, { error: "任务仍在处理中" });
      if (job.pipeline === VISUAL_WORKFLOW_VERSION || job.workflow?.version === VISUAL_WORKFLOW_VERSION) runVisualWorkflowChain(job, "content_breakdown", String(body.feedback || ""));
      else replanJob(job, String(body.feedback || ""));
      return json(res, 202, { job, reusedTranscript: true });
    }
    const rerenderMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/rerender$/);
    if (req.method === "POST" && rerenderMatch) {
      const body = await readBodyJson(req);
      const job = await readJob(rerenderMatch[1]);
      if (running.has(job.id)) return json(res, 409, { error: "任务仍在处理中" });
      if (job.pipeline === VISUAL_WORKFLOW_VERSION || job.workflow?.version === VISUAL_WORKFLOW_VERSION) {
        if (job.workflow?.stages?.motion_sample?.status !== "approved") return json(res, 409, { error: "请先批准动态样片" });
        runVisualWorkflowChain(job, "full_render", String(body.reason || "本地重渲染"));
        return json(res, 202, { job, reusedTranscript: true, reusedPlan: true });
      }
      const duration = job.currentPlan?.keepSegments?.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || Number(job.source?.duration || 0);
      if (!assetReviewSummary(job, duration).renderReady) return json(res, 409, { error: "请先在素材审核板处理全部候选，再进行本地重渲染" });
      rerenderJob(job, String(body.reason || ""), body);
      return json(res, 202, { job, reusedTranscript: true, reusedPlan: true });
    }
    const coverMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cover$/);
    if (req.method === "POST" && coverMatch) {
      const body = await readBodyJson(req);
      const job = await readJob(coverMatch[1]);
      const cover = await regenerateCover(job, body);
      return json(res, 200, { job, cover, reusedVideo: true, reusedPlan: true });
    }
    const assetRediscoverMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/assets\/rediscover$/);
    if (req.method === "POST" && assetRediscoverMatch) {
      const body = await readBodyJson(req);
      const job = await readJob(assetRediscoverMatch[1]);
      if (running.has(job.id)) return json(res, 409, { error: "任务仍在处理中" });
      if (!job.source || !job.currentPlan?.keepSegments?.length) return json(res, 409, { error: "任务缺少源视频或剪辑计划" });
      job.options = {
        ...job.options,
        visualStrategy: "rich-media-first",
        cloudImageGenerationEnabled: body.cloudImageGenerationEnabled === true || job.options?.cloudImageGenerationEnabled === true,
        paidImageGenerationConfirmation: body.paidImageGenerationConfirmation === false ? false : job.options?.paidImageGenerationConfirmation !== false,
        rightsReviewMode: body.rightsReviewMode === "advisory" ? "advisory" : job.options?.rightsReviewMode || "strict"
      };
      await prepareAssetCandidates(job, { force: true, reason: String(body.reason || "按富媒体优先策略重新发现素材") });
      job.status = "awaiting_asset_review";
      job.progress = 60;
      await saveJob(job);
      return json(res, 200, { job, archivedVersions: (job.assetHistory || []).length });
    }
    const autoReviewPreviewMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/assets\/auto-review-preview$/);
    if (req.method === "POST" && autoReviewPreviewMatch) {
      const body = await readBodyJson(req);
      const job = await readJob(autoReviewPreviewMatch[1]);
      if (running.has(job.id)) return json(res, 409, { error: "任务仍在处理中" });
      if (!job.source || !job.currentPlan?.keepSegments?.length) return json(res, 409, { error: "任务缺少源视频或剪辑计划" });
      const result = await autoReviewLocalAssetsForPreview(job);
      if (!result.review.reviewComplete || !result.review.renderReady) return json(res, 409, { error: "自动素材决策后仍未达到预览渲染条件", review: result.review, job });
      renderReviewedAssets(job, String(body.reason || "自动采用本地富媒体素材并生成完整预览与分段小样"));
      return json(res, 202, { job, review: result.review, decisions: result.decisions });
    }
    const assetUploadMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/assets$/);
    if (req.method === "POST" && assetUploadMatch) {
      const job = await readJob(assetUploadMatch[1]);
      const assetId = `asset-${crypto.randomBytes(4).toString("hex")}`;
      const fileName = safeName(decodeURIComponent(req.headers["x-file-name"] || "asset.bin"));
      const assetsDir = path.join(confined(jobsRoot, job.id), "assets"); await fsp.mkdir(assetsDir, { recursive: true });
      const assetPath = path.join(assetsDir, `${assetId}-${fileName}`);
      const sizeBytes = await receiveUpload(req, assetPath);
      const asset = normalizeAssetRecord({ id: assetId, fileName, path: assetPath, url: `/video-jobs/${job.id}/assets/${assetId}-${fileName}`, previewUrl: `/video-jobs/${job.id}/assets/${assetId}-${fileName}`, sizeBytes, sourceType: "local-upload", sourceLabel: "用户本地上传", mediaKind: mediaKindFor(fileName), ownership: "user-provided", licenseBasis: "pending-confirmation", reviewStatus: "pending", approved: false, placement: null, discoveredAutomatically: false, paymentRequired: false, paymentConfirmed: true, createdAt: new Date().toISOString() });
      job.assets = [...(job.assets || []), asset];
      job.status = "awaiting_asset_review";
      job.assetReview = assetReviewSummary(job);
      await saveJob(job);
      return json(res, 201, { job, asset });
    }
    const assetFileMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/assets\/([^/]+)\/file$/);
    if (req.method === "POST" && assetFileMatch) {
      const job = await readJob(assetFileMatch[1]);
      const asset = (job.assets || []).find(item => item.id === assetFileMatch[2]);
      if (!asset) return json(res, 404, { error: "素材不存在" });
      const fileName = safeName(decodeURIComponent(req.headers["x-file-name"] || "asset.bin"));
      const kind = mediaKindFor(fileName);
      if (!["image", "video"].includes(kind)) return json(res, 400, { error: "替换文件必须是图片或视频" });
      const assetsDir = path.join(confined(jobsRoot, job.id), "assets", "replacements");
      await fsp.mkdir(assetsDir, { recursive: true });
      const revision = (asset.fileVersions || []).length + 1;
      const target = path.join(assetsDir, `${asset.id}-r${revision}-${fileName}`);
      const sizeBytes = await receiveUpload(req, target);
      asset.fileVersions = [...(asset.fileVersions || []), { path: asset.path || null, url: asset.url || null, fileName: asset.fileName || null, replacedAt: new Date().toISOString() }];
      asset.path = target;
      asset.url = `/video-jobs/${job.id}/assets/replacements/${asset.id}-r${revision}-${fileName}`;
      asset.previewUrl = asset.url;
      asset.fileName = fileName;
      asset.mediaKind = kind;
      asset.sizeBytes = sizeBytes;
      asset.reviewStatus = "pending";
      asset.approved = false;
      asset.updatedAt = new Date().toISOString();
      job.status = "awaiting_asset_review";
      job.assetReview = assetReviewSummary(job);
      await saveJob(job);
      return json(res, 200, { job, asset });
    }
    const assetApprovalMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/assets\/([^/]+)\/approve$/);
    if (req.method === "POST" && assetApprovalMatch) {
      const body = await readBodyJson(req), job = await readJob(assetApprovalMatch[1]);
      const asset = (job.assets || []).find(item => item.id === assetApprovalMatch[2]);
      if (!asset) return json(res, 404, { error: "素材不存在" });
      const before = JSON.parse(JSON.stringify(asset));
      const reviewStatus = body.reviewStatus === "rejected" || body.approved === false ? "rejected" : body.approved === true ? "approved" : "pending";
      const nextSourceType = String(body.sourceType || asset.sourceType || "local-upload").slice(0, 80);
      Object.assign(asset, {
        reviewStatus,
        approved: reviewStatus === "approved",
        ownership: String(body.ownership || asset.ownership || "user-provided").slice(0, 120),
        sourceType: nextSourceType,
        creatorName: String(body.creatorName ?? asset.creatorName ?? "").trim().slice(0, 120),
        workTitle: String(body.workTitle ?? asset.workTitle ?? "").trim().slice(0, 180),
        sourceUrl: String(body.sourceUrl ?? asset.sourceUrl ?? "").trim().slice(0, 1000),
        usagePurpose: String(body.usagePurpose ?? asset.usagePurpose ?? "").trim().slice(0, 500),
        licenseBasis: String(body.licenseBasis || body.license || asset.licenseBasis || "").trim().slice(0, 120),
        attributionText: String(body.attributionText ?? asset.attributionText ?? "").trim().slice(0, 240),
        clipStart: Number.isFinite(Number(body.clipStart)) ? Math.max(0, Number(body.clipStart)) : Number(asset.clipStart || 0),
        clipEnd: Number.isFinite(Number(body.clipEnd)) && Number(body.clipEnd) > 0 ? Number(body.clipEnd) : asset.clipEnd,
        clipDuration: Number.isFinite(Number(body.clipDuration)) && Number(body.clipDuration) > 0 ? Number(body.clipDuration) : asset.clipDuration,
        paymentConfirmed: PAID_SOURCE_TYPES.has(nextSourceType) ? body.paymentConfirmed === true : body.paymentConfirmed === undefined ? asset.paymentConfirmed === true : body.paymentConfirmed === true,
        placement: body.placement ? normalizePlacement(body.placement) : asset.placement,
        updatedAt: new Date().toISOString()
      });
      const normalized = normalizeAssetRecord(asset);
      Object.assign(asset, normalized);
      const duration = job.currentPlan?.keepSegments?.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || Number(job.source?.duration || 0);
      const issues = assetComplianceIssues(asset, job, duration);
      if (reviewStatus === "approved" && issues.length) {
        Object.keys(asset).forEach(key => delete asset[key]);
        Object.assign(asset, before);
        return json(res, 409, { error: issues.join("；"), issues });
      }
      job.assetDecisions = [...(job.assetDecisions || []), { assetId: asset.id, reviewStatus, placement: asset.placement, licenseBasis: asset.licenseBasis, usagePurpose: asset.usagePurpose, decidedAt: new Date().toISOString() }];
      job.assetReview = assetReviewSummary(job, duration);
      job.status = "awaiting_asset_review";
      delete job.approvedAt;
      await writeJson(path.join(confined(jobsRoot, job.id), "asset-decisions.json"), job.assetDecisions);
      await saveJob(job);
      return json(res, 200, { job, asset });
    }
    const assetRenderMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/assets\/render$/);
    if (req.method === "POST" && assetRenderMatch) {
      const job = await readJob(assetRenderMatch[1]);
      if (running.has(job.id)) return json(res, 409, { error: "任务仍在处理中" });
      const duration = job.currentPlan?.keepSegments?.reduce((sum, segment) => sum + Number(segment.end) - Number(segment.start), 0) || Number(job.source?.duration || 0);
      const review = assetReviewSummary(job, duration);
      if (!review.reviewComplete) return json(res, 409, { error: "仍有素材未批准或拒绝", review });
      if (!review.renderReady) return json(res, 409, { error: review.complianceIssues.map(item => `${item.assetId}：${item.issue}`).join("；"), review });
      renderReviewedAssets(job);
      return json(res, 202, { job, review });
    }
    const approveMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) {
      const job = await readJob(approveMatch[1]);
      if (!job.output) return json(res, 409, { error: "还没有可审核的成片" });
      if (job.output.qaPass !== true) return json(res, 409, { error: "当前成片QA未通过，不能最终审核" });
      const manifest = await readJsonFile(path.join(confined(jobsRoot, job.id), `media-manifest-v${job.output.version}.json`));
      if (manifest.review?.reviewComplete !== true || manifest.assets.some(asset => asset.approved && asset.composited !== true)) return json(res, 409, { error: "素材审核或实际合成状态不完整，不能最终审核" });
      job.status = "approved"; job.approvedAt = new Date().toISOString();
      if (job.workflow?.version === VISUAL_WORKFLOW_VERSION) {
        const stage = job.workflow.stages.full_render;
        stage.status = "approved";
        stage.approvedVersion = stage.currentVersion;
        stage.approvedAt = job.approvedAt;
        job.workflow.audit ||= [];
        job.workflow.audit.push({ type: "stage-approved", stageId: "full_render", version: stage.currentVersion, at: job.approvedAt });
      }
      await saveJob(job);
      await writeJson(path.join(confined(jobsRoot, job.id), "final-review.json"), { status: "approved", version: job.currentVersion, qaPass: true, mediaReview: manifest.review, renderedAssetIds: manifest.renderedAssetIds || [], approvedAt: job.approvedAt, autoPublish: false });
      return json(res, 200, { job });
    }
    if (pathname.startsWith("/video-jobs/")) return await serveFile(req, res, confined(jobsRoot, pathname.slice("/video-jobs/".length)));
    if (pathname.startsWith("/content-items/")) return await serveFile(req, res, confined(contentRoot, pathname.slice("/content-items/".length)));
    for (const [prefix, base] of [["/runs/", path.join(root, "runs")], ["/docs/", path.join(root, "docs")], ["/config/", path.join(root, "config")]]) {
      if (pathname.startsWith(prefix)) return await serveFile(req, res, confined(base, pathname.slice(prefix.length)));
    }
    let relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    return await serveFile(req, res, confined(webRoot, relative));
  } catch (error) {
    if (!res.headersSent) json(res, error.statusCode || (error.code === "ENOENT" ? 404 : 500), { error: error.message }); else res.destroy();
  }
});
let serverResourcesClosed = false;
function closeMultiAgentStore() {
  if (serverResourcesClosed) return;
  serverResourcesClosed = true;
  multiAgentStore.close();
}
server.on("error", error => { if (error.code === "EADDRINUSE") process.exit(0); console.error(error); process.exit(1); });
server.on("close", closeMultiAgentStore);
if (process.env.KOUBO_NO_LISTEN !== "1") server.listen(port, host, () => console.log(`AI口播工作台：http://${host}:${port}/`));

export async function closeServerResourcesForTests() {
  if (server.listening) {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  closeMultiAgentStore();
}

export {
  normalizeAssetRecord,
  assetComplianceIssues,
  assetReviewSummary,
  candidatePlacement,
  writeMultiAgentArtifact,
};
