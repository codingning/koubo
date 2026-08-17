import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDirectory, "..", "..");
const rubricPath = path.join(repositoryRoot, "config", "multi-agent", "ordinary-viewer-rubric.json");

const AUTHORITY_KEYS = new Set([
  "approval",
  "approved",
  "approvedat",
  "autopublish",
  "finaloutput",
  "memorypromotion",
  "productionapproval",
  "promote",
  "publish",
  "publishedat",
]);
const VALID_STAGES = new Set(["script", "render"]);
const VALID_INSPECTION_MODES = new Set([
  "script_text",
  "transcript_and_metadata_only",
  "sampled_frames_and_transcript",
]);
const INSULT_PATTERN = /傻逼|脑残|废物|垃圾作者|蠢货|弱智|白痴|你傻不傻/iu;
const TOPIC_CHANGE_PATTERN = /(?:^|[。！？；，,\s])(?:建议|请|应该|必须|直接)?\s*(?:换题|换个(?:主题|选题)|重新选题|另选(?:主题|选题))/u;
const WHOLE_REWRITE_PATTERN = /(?:整篇|全文|全部|从头).{0,6}(?:重写|推翻)/u;
const PUBLISH_APPROVAL_PATTERN = /批准(?:发布|上线)|准许(?:发布|上线)|同意(?:发布|上线)|可以直接(?:发布|上线)|建议(?:直接)?(?:发布|上线)|通过(?:发布|上线)审核/iu;
const AGGREGATE_RETENTION_PREDICTION_PATTERN = /(?:百分之\s*[一二三四五六七八九十百\d]+|[一二三四五六七八九十百\d]+\s*%|大多数|绝大多数|所有观众|观众(?:都|会)|用户(?:都|会)).{0,24}(?:[一二三四五六七八九十百\d]+\s*秒(?:内|后)?).{0,20}(?:划走|离开|跳出|流失|看不下去)|(?:留存率|完播率|跳出率|掉点).{0,16}(?:会|将|预计|预测|达到|低于|高于|下降|上升)|(?:前|开头)?\s*[一二三四五六七八九十百\d]+\s*秒.{0,16}(?:会|将|导致|造成).{0,12}(?:划走|流失|跳出)/iu;
const WINNER_SELECTION_PATTERN = /(?:这|该)?(?:一版|版本|候选).{0,10}(?:最好|最佳|胜出|获胜|赢家)|(?:建议|应该).{0,8}(?:选择|采用).{0,8}(?:A|B|C|第一版|第二版|这个版本)/iu;
const TECHNICAL_QA_PATTERN = /H\.?264|AAC|yuv420p|BT\.?709|LUFS|码率|色彩空间|完整解码|黑帧|异常冻结|缺帧|削波|分辨率检查/iu;
const PACING_ANALYSIS_PATTERN = /(?:节奏|停顿|语速|动效密度|音效密度|信息密度).{0,10}(?:太快|太慢|过快|过慢|过多|过少|不足|拖沓|密集|稀疏)/iu;
const VISUAL_OBSERVATION_PATTERN = /画面|镜头|字幕|构图|颜色|字体|视觉|截图|看见|看到/u;
const AUDIO_OBSERVATION_PATTERN = /(?:听见|听到)|(?:音效|音量|语气|声音|音频|背景音乐|BGM|bgm|人声).{0,12}(?:清楚|不清楚|太大|太小|太吵|刺耳|嘈杂|有噪声|有杂音|失真|爆音|盖住|盖过|压过|淹没|抢)|(?:有|存在|出现).{0,4}(?:噪声|杂音|底噪|爆音|削波)|(?:噪声|杂音|底噪|爆音|削波).{0,8}(?:明显|严重|太大|很多)|(?:盖住|盖过|压过|淹没).{0,6}(?:人声|讲话|口播|声音)/iu;
const LOCAL_PATH_PATTERN = /(?:file:\/\/\/?|\\\\\?\\[A-Za-z]:\\|(?:^|[^A-Za-z0-9+.-])[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+|(?:^|[\s"'([{=])\/(?:Users|home|tmp|var|etc|mnt|opt|srv|Volumes|private|root)(?:[\\/]|$))/iu;
const OUT_OF_SCOPE_KEYS = new Set([
  "technicalqa",
  "retention",
  "retentionscore",
  "droppoint",
  "winner",
  "ranking",
  "rank",
  "pacing",
  "pauseanalysis",
  "motiondensity",
  "effectdensity",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function readRubric() {
  const value = JSON.parse(fs.readFileSync(rubricPath, "utf8"));
  if (value.schemaVersion !== 1 || !String(value.id || "").trim()) {
    throw new Error("ordinary viewer rubric requires id and schemaVersion 1");
  }
  if (!value.stages?.script || !value.stages?.render) {
    throw new Error("ordinary viewer rubric requires script and render stages");
  }
  if (Number(value.outputContract?.blockers?.maxItems) !== 3) {
    throw new Error("ordinary viewer rubric must limit blockers to three");
  }
  if (!Array.isArray(value.viewerDecisions) || !Array.isArray(value.classifications)) {
    throw new Error("ordinary viewer rubric requires decisions and classifications");
  }
  return deepFreeze(value);
}

export const ORDINARY_VIEWER_RUBRIC = readRubric();

function requiredString(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function optionalString(value) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function assertNoLocalPath(value, label) {
  const text = optionalString(value);
  if (text && LOCAL_PATH_PATTERN.test(text)) {
    throw new Error(`${label} must not contain a local path`);
  }
  return text;
}

function requiredPublicString(value, label) {
  const text = requiredString(value, label);
  if (LOCAL_PATH_PATTERN.test(text)) throw new Error(`${label} must not contain a local path`);
  return text;
}

function normalizedStage(stage) {
  const value = String(stage || "").trim().toLowerCase();
  if (!VALID_STAGES.has(value)) throw new Error("ordinary viewer stage must be script or render");
  return value;
}

function publicDirection(input) {
  const source = input?.approvedDirection;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("approvedDirection is required");
  }
  const output = {
    audience: requiredPublicString(source.audience, "approvedDirection.audience"),
    viewerBenefit: requiredPublicString(source.viewerBenefit, "approvedDirection.viewerBenefit"),
    coreQuestion: requiredPublicString(source.coreQuestion, "approvedDirection.coreQuestion"),
  };
  if (Array.isArray(source.constraints)) {
    output.constraints = source.constraints.map((item, index) => (
      assertNoLocalPath(item, `approvedDirection.constraints[${index}]`)
    )).filter(Boolean);
  }
  return output;
}

function publicFacts(input) {
  const source = input?.facts ?? input?.factSheet ?? input?.evidence ?? [];
  if (!Array.isArray(source)) throw new Error("facts must be an array");
  return source.map((item, index) => {
    if (typeof item === "string") throw new Error(`facts[${index}] must include a traceable sourceId`);
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`facts[${index}] must be an object`);
    }
    const output = {
      sourceId: requiredPublicString(item.sourceId, `facts[${index}].sourceId`),
      provenance: requiredPublicString(item.provenance || "user_provided", `facts[${index}].provenance`),
    };
    for (const key of ["claim", "evidence", "kind", "status", "uncertainty"]) {
      const text = assertNoLocalPath(item[key], `facts[${index}].${key}`);
      if (text) output[key] = text;
    }
    const hasStart = item.start !== undefined;
    const hasEnd = item.end !== undefined;
    if (hasStart !== hasEnd) throw new Error(`facts[${index}] start and end must be provided together`);
    if (hasStart) {
      if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start) {
        throw new Error(`facts[${index}] requires a valid timestamp range`);
      }
      output.start = Number(item.start);
      output.end = Number(item.end);
    }
    if (Object.keys(output).length === 0) throw new Error(`facts[${index}] has no public evidence fields`);
    return output;
  });
}

function publicTranscript(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("render transcript must be a non-empty array");
  }
  return value.map((item, index) => {
    const start = Number(item?.start);
    const end = Number(item?.end);
    const text = requiredPublicString(item?.text, `transcript[${index}].text`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error(`transcript[${index}] requires a valid timestamp range`);
    }
    return { start, end, text };
  });
}

function publicMedia(input, transcript) {
  const source = input?.media ?? input?.render;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("render media is required");
  }
  const attachment = requiredString(
    source.attachment ?? source.mediaRef ?? source.path,
    "media.attachment"
  );
  if (!/^(?:media|artifact):\/\/[A-Za-z0-9._/-]+$/u.test(attachment)) {
    throw new Error("media.attachment must be an opaque media:// or artifact:// reference, not a local path");
  }
  const inferredDuration = Math.max(...transcript.map(item => item.end));
  const durationSeconds = Number(source.durationSeconds ?? input.durationSeconds ?? inferredDuration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("media.durationSeconds must be positive");
  }
  const output = { attachment, durationSeconds };
  for (const key of ["width", "height"]) {
    if (Number.isFinite(source[key]) && Number(source[key]) > 0) output[key] = Number(source[key]);
  }
  return output;
}

function publicFrameEvidence(input, durationSeconds) {
  const source = input?.frameEvidence ?? [];
  if (!Array.isArray(source)) throw new Error("frameEvidence must be an array");
  return source.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`frameEvidence[${index}] must be an object`);
    }
    const start = Number(item.start);
    const end = Number(item.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > durationSeconds + 0.001) {
      throw new Error(`frameEvidence[${index}] requires a valid timestamp range`);
    }
    const artifactId = requiredString(item.artifactId, `frameEvidence[${index}].artifactId`);
    if (!/^(?:frame|contact-sheet|vision):[A-Za-z0-9._/-]+$/u.test(artifactId)) {
      throw new Error(`frameEvidence[${index}].artifactId must be an opaque reviewed artifact id`);
    }
    return {
      artifactId,
      sourceId: requiredPublicString(item.sourceId, `frameEvidence[${index}].sourceId`),
      start,
      end,
      observation: requiredPublicString(item.observation, `frameEvidence[${index}].observation`),
      provenance: requiredPublicString(item.provenance || "vision_verified", `frameEvidence[${index}].provenance`),
    };
  });
}

function anonymousLabel(value) {
  const hash = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return `anonymous-${hash.slice(0, 12)}`;
}

export function buildOrdinaryViewerCriticRequest(input = {}, options = {}) {
  const stage = normalizedStage(options.stage ?? input.stage);
  const base = {
    operation: "agent_critique",
    agentId: "ordinary-viewer-critic",
    critiqueKind: "ordinary_viewer",
    stage,
    rubricId: ORDINARY_VIEWER_RUBRIC.id,
    approvedDirection: publicDirection(input),
    facts: publicFacts(input),
    viewer: ORDINARY_VIEWER_RUBRIC.viewer,
    checks: ORDINARY_VIEWER_RUBRIC.checks,
    outputContract: ORDINARY_VIEWER_RUBRIC.outputContract,
    prohibitions: ORDINARY_VIEWER_RUBRIC.prohibitions,
    inScope: ORDINARY_VIEWER_RUBRIC.inScope,
    outOfScope: ORDINARY_VIEWER_RUBRIC.outOfScope,
  };

  if (stage === "script") {
    base.inspectionMode = "script_text";
    base.script = requiredString(input.script, "script");
  } else {
    base.transcript = publicTranscript(input.transcript);
    base.media = publicMedia(input, base.transcript);
    base.frameEvidence = publicFrameEvidence(input, base.media.durationSeconds);
    base.inspectionMode = base.frameEvidence.length
      ? "sampled_frames_and_transcript"
      : "transcript_and_metadata_only";
    base.evidenceBoundary = base.inspectionMode === "transcript_and_metadata_only"
      ? {
          seen: ["transcript_text", "duration", "dimensions", "traceable_facts"],
          notSeen: ["frames", "visuals", "captions_as_rendered", "audio", "bgm", "noise", "voice_delivery"],
          wordingRule: "Discuss only wording, sequence, viewer value, credibility, evidence, and actionability. Do not repeat visual/audio nouns from the transcript as if observed; render blockers need time ranges and should omit quote when the quote itself describes unreviewed visuals or audio.",
        }
      : {
          seen: ["transcript_text", "duration", "dimensions", "traceable_facts", "reviewed_frame_observations"],
          notSeen: ["unsampled_frames", "audio", "bgm", "noise", "voice_delivery"],
          wordingRule: "Keep every visual observation inside a timestamped blocker fully covered by reviewed frame evidence; do not infer beyond sampled ranges.",
        };
  }

  base.candidateLabel = anonymousLabel({
    stage,
    approvedDirection: base.approvedDirection,
    facts: base.facts,
    script: base.script,
    media: base.media,
    transcript: base.transcript,
    frameEvidence: base.frameEvidence,
    inspectionMode: base.inspectionMode,
  });
  return base;
}

function normalizedKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function assertNoAuthority(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (AUTHORITY_KEYS.has(normalizedKey(key))) {
      throw new Error(`ordinary viewer critic cannot return authority field: ${key}`);
    }
    if (OUT_OF_SCOPE_KEYS.has(normalizedKey(key))) {
      throw new Error(`ordinary viewer critic cannot return out-of-scope field: ${key}`);
    }
    assertNoAuthority(item, seen);
  }
}

function collectStrings(value, output = [], seen = new WeakSet()) {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, seen);
  } else {
    for (const item of Object.values(value)) collectStrings(item, output, seen);
  }
  return output;
}

function validateLanguageSafety(output, request) {
  const combined = collectStrings(output).join("\n");
  if (INSULT_PATTERN.test(combined)) throw new Error("insult is forbidden in ordinary viewer critique");
  if (PUBLISH_APPROVAL_PATTERN.test(combined)) {
    throw new Error("ordinary viewer critic cannot approve publish or launch");
  }
  if (TOPIC_CHANGE_PATTERN.test(combined) || WHOLE_REWRITE_PATTERN.test(combined)) {
    throw new Error("change topic or whole rewrite is forbidden");
  }
  if (AGGREGATE_RETENTION_PREDICTION_PATTERN.test(combined)) {
    throw new Error("ordinary viewer critic cannot make aggregate retention or drop-off predictions");
  }
  if (WINNER_SELECTION_PATTERN.test(combined)) {
    throw new Error("ordinary viewer critic cannot select or rank a winner");
  }
  if (TECHNICAL_QA_PATTERN.test(combined)) {
    throw new Error("ordinary viewer critic cannot perform technical QA");
  }
  if (PACING_ANALYSIS_PATTERN.test(combined)) {
    throw new Error("ordinary viewer critic cannot perform pacing analysis");
  }
  if (request.stage === "render" && AUDIO_OBSERVATION_PATTERN.test(combined)) {
    throw new Error("ordinary viewer render critique cannot claim audio observations without reviewed audio evidence");
  }
  if (request.inspectionMode === "transcript_and_metadata_only" && VISUAL_OBSERVATION_PATTERN.test(combined)) {
    throw new Error("transcript-only ordinary viewer critique cannot claim visual or audio observations");
  }
  if (request.inspectionMode === "sampled_frames_and_transcript") {
    const unscoped = collectStrings({
      sharpConclusion: output.sharpConclusion,
      viewerValueGap: output.viewerValueGap,
      evidenceGap: output.evidenceGap,
      minimalFix: output.minimalFix,
      classifications: output.classifications,
    }).join("\n");
    if (VISUAL_OBSERVATION_PATTERN.test(unscoped)) {
      throw new Error("sampled-frame visual observations must stay in a timestamped blocker covered by reviewed frame evidence");
    }
  }
}

function validateSingleSentence(value) {
  const text = requiredString(value, "sharpConclusion");
  if (/\r|\n/u.test(text)) throw new Error("sharpConclusion must be one sentence");
  const parts = text.replace(/[。！？!?]+$/u, "").split(/[。！？!?]+/u).filter(part => part.trim());
  if (parts.length > ORDINARY_VIEWER_RUBRIC.outputContract.sharpConclusion.maxSentences) {
    throw new Error("sharpConclusion must be one sentence");
  }
  if ([...text].length > ORDINARY_VIEWER_RUBRIC.outputContract.sharpConclusion.maxCharacters) {
    throw new Error("sharpConclusion is too long");
  }
  return text;
}

function sourceScript(request) {
  if (typeof request.script === "string") return request.script;
  return Array.isArray(request.script)
    ? request.script.map(item => String(item?.text || item || "")).join("\n")
    : "";
}

function validateBlockers(value, request) {
  if (!Array.isArray(value)) throw new Error("blockers must be an array");
  if (value.length > ORDINARY_VIEWER_RUBRIC.outputContract.blockers.maxItems) {
    throw new Error("ordinary viewer critique allows at most three blockers");
  }
  const allowedClassifications = new Set(ORDINARY_VIEWER_RUBRIC.classifications);
  const script = sourceScript(request);
  const duration = Number(request.media?.durationSeconds);

  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`blocker ${index} must be an object`);
    }
    const issue = requiredString(item.issue, `blocker ${index}.issue`);
    const classification = requiredString(item.classification, `blocker ${index}.classification`);
    if (!allowedClassifications.has(classification)) {
      throw new Error(`blocker ${index} has invalid classification`);
    }
    const blocker = { issue, classification };

    if (request.stage === "script") {
      const quote = requiredString(item.quote, `blocker ${index}.quote`);
      if (!script.includes(quote)) throw new Error(`blocker ${index} quote must exist in the script`);
      blocker.quote = quote;
    } else {
      const start = Number(item.start);
      const end = Number(item.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        throw new Error(`blocker ${index} requires a valid timestamp range`);
      }
      if (Number.isFinite(duration) && end > duration + 0.001) {
        throw new Error(`blocker ${index} timestamp exceeds render duration`);
      }
      blocker.start = start;
      blocker.end = end;
      const quote = optionalString(item.quote);
      if (quote) blocker.quote = quote;
      const visualClaim = VISUAL_OBSERVATION_PATTERN.test(`${issue}\n${quote || ""}`);
      if (visualClaim) {
        const covered = Array.isArray(request.frameEvidence) && request.frameEvidence.some(frame => (
          Number(frame.start) <= start + 0.001 && Number(frame.end) >= end - 0.001
        ));
        if (!covered) {
          throw new Error(`blocker ${index} visual claim is outside reviewed frame evidence`);
        }
      }
    }
    return blocker;
  });
}

function validateClassifications(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("classifications must be an object");
  }
  const output = {};
  for (const bucket of ORDINARY_VIEWER_RUBRIC.classifications) {
    if (!Array.isArray(value[bucket])) throw new Error(`classifications.${bucket} must be an array`);
    output[bucket] = value[bucket].map((item, index) => requiredString(
      item,
      `classifications.${bucket}[${index}]`
    ));
  }
  return output;
}

export function validateOrdinaryViewerCriticOutput(output, request) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("ordinary viewer critic output must be an object");
  }
  if (!request || !VALID_STAGES.has(request.stage)) {
    throw new Error("validated ordinary viewer request is required");
  }
  if (!VALID_INSPECTION_MODES.has(request.inspectionMode)) {
    throw new Error("ordinary viewer request requires a declared inspection mode");
  }
  assertNoAuthority(output);
  validateLanguageSafety(output, request);

  const sharpConclusion = validateSingleSentence(output.sharpConclusion);
  const blockers = validateBlockers(output.blockers, request);
  const viewerValueGap = requiredString(output.viewerValueGap, "viewerValueGap");
  const evidenceGap = requiredString(output.evidenceGap, "evidenceGap");
  const minimalFix = requiredString(output.minimalFix, "minimalFix");
  if ([...minimalFix].length > ORDINARY_VIEWER_RUBRIC.outputContract.minimalFix.maxCharacters) {
    throw new Error("minimalFix is too long and may be a rewrite");
  }
  const viewerDecision = requiredString(output.viewerDecision, "viewerDecision");
  if (!ORDINARY_VIEWER_RUBRIC.viewerDecisions.includes(viewerDecision)) {
    throw new Error("viewerDecision is not allowed");
  }
  const classifications = validateClassifications(output.classifications);

  return {
    sharpConclusion,
    blockers,
    viewerValueGap,
    evidenceGap,
    minimalFix,
    viewerDecision,
    classifications,
  };
}

function normalizedAgentResult(response) {
  if (response?.success === false) throw new Error(response.error || "ordinary viewer critic invocation failed");
  return response?.result ?? response;
}

export function createOrdinaryViewerCritic({ invokeAgent } = {}) {
  if (typeof invokeAgent !== "function") throw new Error("invokeAgent is required");
  return {
    async review(input, options = {}) {
      const request = buildOrdinaryViewerCriticRequest(input, options);
      const result = normalizedAgentResult(await invokeAgent(request));
      try {
        return validateOrdinaryViewerCriticOutput(result, request);
      } catch (error) {
        const repaired = normalizedAgentResult(await invokeAgent({
          ...request,
          validationRepair: {
            attempt: 2,
            previousError: String(error?.message || error).slice(0, 500),
            requirements: [
              "Return exactly the declared fields with at most three blockers",
              request.stage === "script"
                ? "Every blocker quote must be a byte-for-byte substring of the supplied script"
                : "Every blocker must use a valid numeric time range within the supplied duration",
              "Do not change topic, rewrite the whole script, perform technical QA, predict retention, rank candidates, approve, or publish",
              request.inspectionMode === "transcript_and_metadata_only"
                ? "You have not seen frames or heard audio. Avoid visual/audio observation words, do not repeat transcript claims about visuals or audio, omit blocker.quote when it contains those claims, and critique only wording, sequence, viewer value, credibility, evidence, and actionability"
                : "Do not claim visual or audio observations beyond the declared inspection mode and reviewed evidence",
            ],
          },
        }));
        return validateOrdinaryViewerCriticOutput(repaired, request);
      }
    },
  };
}
