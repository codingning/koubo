import path from "node:path";

const PRIVATE_KEYS = new Set([
  "accesstoken",
  "agentid",
  "apikey",
  "author",
  "createdby",
  "password",
  "prompt",
  "rationale",
  "renderpath",
  "secret",
  "sourcepath",
  "token",
  "transcript",
]);

export function acceptanceVideoEncodingArgs() {
  return [
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-colorspace", "bt709",
    "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
  ];
}

export function acceptanceAudioMixFilter() {
  return "[0:a][cue]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,volume=0.82,alimiter=limit=0.79:level=false[a]";
}

export function freezeRegressionAgainstControl(control, candidate, toleranceSeconds = 0.16) {
  const controlDuration = Number(control?.maxFreezeDuration || 0);
  const candidateDuration = Number(candidate?.maxFreezeDuration || 0);
  return candidateDuration <= controlDuration + toleranceSeconds;
}

export function acceptanceRecipes() {
  return [
    {
      id: "frozen-control",
      engine: "ffmpeg-acceptance-v1",
      layout: "frozen-control",
      captions: { identity: "frozen" },
      motion: { structure: [] },
      sound: { structure: [] },
      recipeVersion: "acceptance-control-v1",
    },
    {
      id: "caption-pulse",
      engine: "ffmpeg-acceptance-v1",
      layout: "speaker-full-caption-bottom",
      captions: {
        identity: "three-beat-keyword-pulse",
        safeArea: "bottom-12-percent",
      },
      motion: {
        structure: ["progress-rail", "caption-rise", "keyword-accent"],
      },
      sound: {
        structure: ["semantic-cue-at-evidence-beat"],
      },
      recipeVersion: "acceptance-caption-pulse-v1",
    },
    {
      id: "evidence-rail",
      engine: "ffmpeg-acceptance-v1",
      layout: "evidence-left-speaker-right",
      captions: {
        identity: "left-step-stack",
        safeArea: "left-information-rail",
      },
      motion: {
        structure: ["layout-reframe", "step-card-sequence", "evidence-progress"],
      },
      sound: {
        structure: ["low-semantic-cue-at-layout-change"],
      },
      recipeVersion: "acceptance-evidence-rail-v1",
    },
  ];
}

function controlPriority(relative) {
  const normalized = relative.replaceAll("\\", "/").toLowerCase();
  if (/sample.*\/renders\/.*\.mp4$/.test(normalized)) return 0;
  if (/motion-sample.*\.mp4$/.test(normalized)) return 1;
  if (/review-preview.*\.mp4$/.test(normalized)) return 2;
  if (/final-v\d+\.mp4$/.test(normalized)) return 3;
  if (normalized.endsWith(".mp4")) return 4;
  return 99;
}

export function selectFrozenControl(sample, jobsRoot, exists) {
  if (!sample?.jobId || !Array.isArray(sample.artifacts)) {
    throw new Error("frozen sample with artifacts is required");
  }
  const candidates = sample.artifacts
    .filter(item => controlPriority(item.path) < 99)
    .sort((left, right) =>
      controlPriority(left.path) - controlPriority(right.path)
      || left.path.localeCompare(right.path)
    )
    .map(item => path.resolve(jobsRoot, sample.jobId, item.path));
  const selected = candidates.find(file => exists(file));
  if (!selected) throw new Error(`no frozen control media found for ${sample.jobId}`);
  return selected;
}

export function blindMediaPlan(bundle, candidates, sampleId) {
  if (!Array.isArray(bundle?.candidates) || bundle.candidates.length < 2) {
    throw new Error("blind bundle with at least two candidates is required");
  }
  const hashes = new Set(candidates.map(item => item.renderHash));
  return bundle.candidates.map(item => {
    if (!hashes.has(item.renderHash)) {
      throw new Error(`blind hash has no rendered candidate: ${item.renderHash}`);
    }
    return {
      label: item.label,
      renderHash: item.renderHash,
      publicFile: `${sampleId}-candidate-${item.label}.mp4`,
    };
  });
}

function isAbsolutePrivatePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\/.test(value)
    || value.startsWith("/");
}

export function publicAcceptanceValue(value, seen = new WeakSet()) {
  if (value === null || ["number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "string") return isAbsolutePrivatePath(value) ? undefined : value;
  if (Array.isArray(value)) {
    return value
      .map(item => publicAcceptanceValue(item, seen))
      .filter(item => item !== undefined);
  }
  if (!value || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (PRIVATE_KEYS.has(normalized)) continue;
    const item = publicAcceptanceValue(value[key], seen);
    if (item !== undefined) output[key] = item;
  }
  seen.delete(value);
  return output;
}
