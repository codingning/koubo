import path from "node:path";

function isHash(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

function normalizeMediaRecord(record, label) {
  if (!record?.path || path.isAbsolute(record.path)) {
    throw new Error(`${label} path must be relative`);
  }
  if (!isHash(record.sha256)) throw new Error(`${label} hash is invalid`);
  return {
    path: String(record.path).replaceAll("\\", "/"),
    sha256: String(record.sha256).toLowerCase(),
  };
}

export function normalizeSubjectiveBaseline(value) {
  if (value?.schemaVersion !== 1) throw new Error("subjective baseline schemaVersion must be 1");
  if (!value.baselineId || !value.jobId) throw new Error("subjective baseline identity is required");
  if (value.mediaKind !== "real-talking-head") {
    throw new Error("subjective baseline requires real talking-head media");
  }
  if (!Array.isArray(value.samples) || !value.samples.length) {
    throw new Error("subjective baseline samples are required");
  }
  const ids = new Set();
  const samples = value.samples.map(sample => {
    if (!sample.id || ids.has(sample.id)) throw new Error("subjective sample IDs must be unique");
    ids.add(sample.id);
    const editedStart = Number(sample.editedStart);
    const duration = Number(sample.duration);
    if (!Number.isFinite(editedStart) || editedStart < 0 || !Number.isFinite(duration) || duration <= 0) {
      throw new Error(`sample ${sample.id} has an invalid time window`);
    }
    if (!sample.segmentId || !sample.focus || !sample.question) {
      throw new Error(`sample ${sample.id} needs segment, focus, and question`);
    }
    if (!Array.isArray(sample.reviewHints) || sample.reviewHints.length < 2) {
      throw new Error(`sample ${sample.id} needs at least two review hints`);
    }
    if (!Array.isArray(sample.phrases) || sample.phrases.length !== 3 || sample.phrases.some(item => !String(item).trim())) {
      throw new Error(`sample ${sample.id} needs exactly three phrases`);
    }
    return {
      id: String(sample.id),
      segmentId: String(sample.segmentId),
      editedStart,
      duration,
      focus: String(sample.focus),
      question: String(sample.question),
      reviewHints: sample.reviewHints.map(String),
      phrases: sample.phrases.map(String),
    };
  }).sort((left, right) => left.editedStart - right.editedStart);
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    if (samples[index].editedStart < previous.editedStart + previous.duration) {
      throw new Error(`subjective sample windows overlap: ${previous.id} and ${samples[index].id}`);
    }
  }
  return {
    schemaVersion: 1,
    baselineId: String(value.baselineId),
    mediaKind: value.mediaKind,
    jobId: String(value.jobId),
    source: normalizeMediaRecord(value.source, "source"),
    control: normalizeMediaRecord(value.control, "control"),
    samples,
  };
}

function resolveInside(root, relative, label) {
  const resolved = path.resolve(root, relative);
  const relation = path.relative(root, resolved);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`${label} path escapes the declared job root`);
  }
  return resolved;
}

export function resolveSubjectiveBaselineMedia(value, jobsRoot) {
  const baseline = normalizeSubjectiveBaseline(value);
  const jobRoot = path.resolve(jobsRoot, baseline.jobId);
  return {
    baseline,
    jobRoot,
    source: resolveInside(jobRoot, baseline.source.path, "source"),
    control: resolveInside(jobRoot, baseline.control.path, "control"),
  };
}
