import fsp from "node:fs/promises";
import path from "node:path";

export const EXPERT_KNOWLEDGE_CATALOGS = Object.freeze([
  {
    layer: "trial",
    relativePath: "config/multi-agent/trials/agent-training-batch-1/trial-catalog.v3.json",
  },
  {
    layer: "inbox",
    relativePath: "config/multi-agent/candidates/reference-batch-2/candidate-catalog.json",
  },
  {
    layer: "inbox",
    relativePath: "config/multi-agent/candidates/douyin-profile-cover-study-v1/candidate-catalog.json",
  },
  {
    layer: "inbox",
    relativePath: "config/multi-agent/candidates/published-video-retro-douyin-obsidian-v1/candidate-catalog.json",
  },
]);

const STATUS_ORDER = Object.freeze({
  promoted: 0,
  approved: 1,
  trial: 2,
  recreated: 3,
  extracted: 4,
  inbox: 5,
  disabled: 6,
  expired: 7,
  rejected: 8,
  unknown: 9,
});

function asArray(value) {
  if (Array.isArray(value)) return value.filter(item => item !== null && item !== undefined);
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map(value => String(value || "").trim()).filter(Boolean))];
}

function statusOf(value, fallback = "unknown") {
  const status = String(value || fallback).trim().toLowerCase();
  return Object.hasOwn(STATUS_ORDER, status) ? status : "unknown";
}

function inferredDomain(record = {}) {
  const explicit = String(record.domain || "").trim().toLowerCase();
  if (explicit) return explicit === "visual" ? "motion" : explicit;
  const value = `${record.type || ""} ${record.id || ""} ${record.namespace || ""}`.toLowerCase();
  if (/cover/.test(value)) return "cover";
  if (/caption|subtitle/.test(value)) return "caption";
  if (/voice/.test(value)) return "voice";
  if (/sound|audio|sonic|sfx/.test(value)) return "sound";
  if (/director/.test(value)) return "director";
  if (/brand/.test(value)) return "brand";
  if (/release|publish/.test(value)) return "release";
  if (/qa|quality/.test(value)) return "qa";
  if (/motion|visual/.test(value)) return "motion";
  if (/content|script|hook|story/.test(value)) return "content";
  return "other";
}

function descriptionOf(record = {}) {
  return String(
    record.definition
    || record.problem
    || record.abstraction
    || record.claim
    || record.primitive
    || record.description
    || "尚未填写技巧说明。"
  ).trim();
}

function normalizedEvidence(value) {
  return asArray(value).map(item => {
    if (item && typeof item === "object" && !Array.isArray(item)) return item;
    return { summary: String(item || "").trim() };
  }).filter(item => Object.values(item).some(entry => entry !== "" && entry !== null && entry !== undefined));
}

function normalizedRecord(record, {
  layer,
  catalogId,
  catalogStatus,
  sourcePath,
  code,
} = {}) {
  const id = String(record?.id || record?.candidateId || "").trim();
  if (!id) return null;
  const status = statusOf(record.status, layer === "trial" ? "trial" : "inbox");
  const layers = uniqueStrings([layer]);
  const runtimeLoaded = layer === "runtime";
  return {
    id,
    code: String(code || record.code || "").trim() || null,
    title: String(record.title || record.name || id).trim(),
    status,
    domain: inferredDomain(record),
    kind: String(record.type || record.kind || "technique-card").trim(),
    namespace: String(record.namespace || "").trim() || null,
    description: descriptionOf(record),
    primitive: String(record.primitive || "").trim() || null,
    applicability: uniqueStrings(record.applicability),
    prohibitions: uniqueStrings(record.prohibitions),
    tags: uniqueStrings(record.tags),
    evidence: normalizedEvidence(record.evidence),
    versions: record.versions && typeof record.versions === "object" ? record.versions : {},
    parameters: record.parameters && typeof record.parameters === "object" ? record.parameters : {},
    source: record.source && typeof record.source === "object" ? record.source : null,
    contentHash: String(record.contentHash || record.candidateContentHash || "").trim() || null,
    layers,
    sourcePaths: uniqueStrings([sourcePath]),
    catalogIds: uniqueStrings([catalogId]),
    catalogStatuses: uniqueStrings([catalogStatus]),
    runtimeLoaded,
    defaultCallable: runtimeLoaded && ["approved", "promoted"].includes(status),
    usageState: runtimeLoaded && ["approved", "promoted"].includes(status)
      ? "production-callable"
      : runtimeLoaded && status === "trial"
        ? "runtime-trial-only"
        : status === "trial"
          ? "isolated-trial-catalog"
          : status === "inbox"
            ? "candidate-only"
            : "not-production-callable",
  };
}

function mergeRecord(previous, incoming) {
  if (!previous) return incoming;
  const preferIncoming = incoming.runtimeLoaded
    || (!previous.runtimeLoaded && STATUS_ORDER[incoming.status] < STATUS_ORDER[previous.status]);
  const primary = preferIncoming ? incoming : previous;
  const secondary = preferIncoming ? previous : incoming;
  const merged = { ...secondary, ...primary };
  for (const field of ["title", "description", "primitive", "namespace", "contentHash"]) {
    if (!merged[field]) merged[field] = secondary[field] || null;
  }
  merged.layers = uniqueStrings([...previous.layers, ...incoming.layers]);
  merged.sourcePaths = uniqueStrings([...previous.sourcePaths, ...incoming.sourcePaths]);
  merged.catalogIds = uniqueStrings([...previous.catalogIds, ...incoming.catalogIds]);
  merged.catalogStatuses = uniqueStrings([...previous.catalogStatuses, ...incoming.catalogStatuses]);
  merged.applicability = uniqueStrings([...previous.applicability, ...incoming.applicability]);
  merged.prohibitions = uniqueStrings([...previous.prohibitions, ...incoming.prohibitions]);
  merged.tags = uniqueStrings([...previous.tags, ...incoming.tags]);
  merged.evidence = incoming.evidence.length ? incoming.evidence : previous.evidence;
  merged.runtimeLoaded = previous.runtimeLoaded || incoming.runtimeLoaded;
  merged.defaultCallable = merged.runtimeLoaded && ["approved", "promoted"].includes(merged.status);
  merged.usageState = merged.defaultCallable
    ? "production-callable"
    : merged.runtimeLoaded && merged.status === "trial"
      ? "runtime-trial-only"
      : merged.status === "trial"
        ? "isolated-trial-catalog"
        : merged.status === "inbox"
          ? "candidate-only"
          : "not-production-callable";
  return merged;
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

function recordsFromCatalog(catalog, descriptor) {
  if (descriptor.layer === "trial") {
    return asArray(catalog.items).map(item => normalizedRecord(item.record || item.trialCandidate || {}, {
      layer: "trial",
      catalogId: catalog.id,
      catalogStatus: catalog.status,
      sourcePath: descriptor.relativePath,
      code: item.code,
    })).filter(Boolean);
  }
  return asArray(catalog.records).map(record => normalizedRecord(record, {
    layer: "inbox",
    catalogId: catalog.id,
    catalogStatus: catalog.status,
    sourcePath: descriptor.relativePath,
  })).filter(Boolean);
}

function increment(map, key) {
  map[key] = Number(map[key] || 0) + 1;
}

export async function buildExpertKnowledgeLibrary({ root, runtimeRecords = [] } = {}) {
  if (!root) throw new Error("root is required");
  const recordsById = new Map();
  const catalogs = [];
  for (const descriptor of EXPERT_KNOWLEDGE_CATALOGS) {
    const catalog = await readJson(path.join(root, descriptor.relativePath));
    const records = recordsFromCatalog(catalog, descriptor);
    catalogs.push({
      id: String(catalog.id || path.basename(descriptor.relativePath)),
      status: String(catalog.status || descriptor.layer),
      layer: descriptor.layer,
      path: descriptor.relativePath.replaceAll("\\", "/"),
      recordCount: records.length,
    });
    for (const record of records) recordsById.set(record.id, mergeRecord(recordsById.get(record.id), record));
  }
  for (const runtimeRecord of asArray(runtimeRecords)) {
    const record = normalizedRecord(runtimeRecord, {
      layer: "runtime",
      catalogId: "runtime-memory.sqlite",
      catalogStatus: "runtime",
      sourcePath: "data/multi-agent/runtime/memory.sqlite",
    });
    if (record) recordsById.set(record.id, mergeRecord(recordsById.get(record.id), record));
  }

  const records = [...recordsById.values()].sort((left, right) => (
    STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
    || left.domain.localeCompare(right.domain)
    || left.title.localeCompare(right.title, "zh-CN")
  ));
  const byStatus = {};
  const byDomain = {};
  const byUsageState = {};
  for (const record of records) {
    increment(byStatus, record.status);
    increment(byDomain, record.domain);
    increment(byUsageState, record.usageState);
  }
  return {
    schemaVersion: 1,
    readOnly: true,
    summary: {
      total: records.length,
      catalogCount: catalogs.length,
      runtimeLoaded: records.filter(record => record.runtimeLoaded).length,
      defaultCallable: records.filter(record => record.defaultCallable).length,
      trial: Number(byStatus.trial || 0),
      inbox: Number(byStatus.inbox || 0),
      approved: Number(byStatus.approved || 0),
      promoted: Number(byStatus.promoted || 0),
      byStatus,
      byDomain,
      byUsageState,
    },
    boundaries: {
      productionRetrieval: "Only runtime-loaded approved or promoted records are default-callable.",
      trial: "Trial catalog records are isolated experiment assets and do not enter default production retrieval.",
      inbox: "Inbox records are candidate teaching material and cannot affect a render until governed admission.",
      mutation: "This endpoint is read-only and does not approve, promote, reject, or import records.",
    },
    catalogs,
    records,
  };
}
