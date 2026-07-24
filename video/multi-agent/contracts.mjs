import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDir, "..", "..");
const schemaDirectory = path.join(repositoryRoot, "config", "multi-agent", "schemas");
const schemaKinds = [
  "technique-card",
  "asset-record",
  "combination-recipe",
  "agent-proposal",
  "review-score",
  "memory-promotion",
  "production-event",
  "agent-profile",
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

const schemas = new Map(schemaKinds.map(kind => [
  kind,
  readJson(path.join(schemaDirectory, `${kind}.schema.json`)),
]));

function describePath(parts) {
  return parts.length ? parts.join(".") : "record";
}

function fail(parts, message) {
  throw new Error(`${describePath(parts)} ${message}`);
}

function matchesType(type, value) {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

function validateSchemaValue(schema, value, parts = []) {
  if (schema.type && !matchesType(schema.type, value)) fail(parts, `must be ${schema.type}`);
  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) {
    fail(parts, `must be one of: ${schema.enum.join(", ")}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(parts, `must contain at least ${schema.minLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(parts, `must match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(parts, `must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(parts, `must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(parts, `must contain at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(parts, `must contain at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => validateSchemaValue(schema.items, item, [...parts, String(index)]));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required || []) {
      if (!(required in value)) fail([...parts, required], "is required");
    }
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validateSchemaValue(schema.properties[key], item, [...parts, key]);
      else if (schema.additionalProperties === false) fail([...parts, key], "is not allowed");
    }
  }
}

const commonRequired = [
  "id",
  "schemaVersion",
  "createdAt",
  "createdBy",
  "status",
  "source",
  "evidence",
  "applicability",
  "prohibitions",
  "versions",
  "contentHash",
];
const versionKeys = ["code", "model", "prompt", "memory", "asset", "recipe", "evaluation"];

function validateCommonRecord(kind, value) {
  for (const key of commonRequired) {
    if (!(key in value)) fail([key], "is required");
  }
  if (value.schemaVersion !== SCHEMA_VERSION) fail(["schemaVersion"], `must equal ${SCHEMA_VERSION}`);
  if (!String(value.id || "").trim()) fail(["id"], "must not be empty");
  if (!Number.isFinite(Date.parse(value.createdAt))) fail(["createdAt"], "must be an ISO date");
  if (!value.createdBy || typeof value.createdBy !== "object") fail(["createdBy"], "must be an object");
  if (!String(value.createdBy.type || "").trim() || !String(value.createdBy.id || "").trim()) {
    fail(["createdBy"], "must contain type and id");
  }
  if (!value.source || typeof value.source !== "object") fail(["source"], "must be an object");
  for (const key of ["type", "sourceId", "author", "license"]) {
    if (!String(value.source[key] || "").trim()) fail(["source", key], "is required");
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) fail(["evidence"], "must contain at least one item");
  let timecodedEvidence = false;
  value.evidence.forEach((item, index) => {
    if (!item || typeof item !== "object") fail(["evidence", String(index)], "must be an object");
    if (!String(item.sourceId || "").trim() || !String(item.kind || "").trim()) {
      fail(["evidence", String(index)], "must contain sourceId and kind");
    }
    if (item.start !== undefined || item.end !== undefined) {
      if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start) {
        fail(["evidence", String(index)], "must contain a valid start/end time range");
      }
      timecodedEvidence = true;
    }
  });
  if (kind === "technique-card" && !timecodedEvidence) fail(["evidence"], "must contain timestamped tutorial evidence");
  for (const key of ["applicability", "prohibitions"]) {
    if (!Array.isArray(value[key])) fail([key], "must be an array");
  }
  if (!value.versions || typeof value.versions !== "object") fail(["versions"], "must be an object");
  for (const key of versionKeys) {
    if (!String(value.versions[key] || "").trim()) fail(["versions", key], "is required");
  }
  if (!/^[a-f0-9]{64}$/.test(String(value.contentHash || ""))) fail(["contentHash"], "must be a lowercase sha256");
}

export function validateRecord(kind, value) {
  const schema = schemas.get(kind);
  if (!schema) throw new Error(`unknown record kind: ${kind}`);
  validateSchemaValue(schema, value);
  if (schema["x-koubo-common-record"] === true) validateCommonRecord(kind, value);
  return value;
}

function canonicalValue(value, seen) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON does not support non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(item => canonicalValue(item, seen));
  if (typeof value !== "object") throw new Error(`canonical JSON does not support ${typeof value}`);
  if (seen.has(value)) throw new Error("canonical JSON does not support cyclic values");
  seen.add(value);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    output[key] = canonicalValue(value[key], seen);
  }
  seen.delete(value);
  return output;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value, new Set()));
}

export function contentHash(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export async function loadAgentProfiles(root = repositoryRoot) {
  const file = path.join(root, "config", "multi-agent", "agent-profiles.json");
  const data = readJson(file);
  if (data.schemaVersion !== SCHEMA_VERSION || !Array.isArray(data.profiles)) {
    throw new Error("agent-profiles.json must contain schemaVersion 1 and profiles");
  }
  const ids = new Set();
  for (const profile of data.profiles) {
    validateRecord("agent-profile", profile);
    if (ids.has(profile.agentId)) throw new Error(`duplicate agent profile: ${profile.agentId}`);
    ids.add(profile.agentId);
  }
  return data.profiles;
}

export async function validateRepositoryContracts(root = repositoryRoot) {
  const configuredSchemas = fs.readdirSync(path.join(root, "config", "multi-agent", "schemas"))
    .filter(name => name.endsWith(".schema.json"))
    .sort();
  if (configuredSchemas.length !== schemaKinds.length) {
    throw new Error(`expected ${schemaKinds.length} schemas, found ${configuredSchemas.length}`);
  }
  for (const kind of schemaKinds) {
    const schema = readJson(path.join(root, "config", "multi-agent", "schemas", `${kind}.schema.json`));
    if (schema.type !== "object" || schema["x-koubo-common-record"] !== true || !schema.$id?.endsWith("/v1")) {
      throw new Error(`invalid repository schema: ${kind}`);
    }
  }
  const profiles = await loadAgentProfiles(root);
  const rubric = readJson(path.join(root, "config", "multi-agent", "evaluation-rubric.json"));
  if (rubric.schemaVersion !== SCHEMA_VERSION || !String(rubric.id || "").trim()) {
    throw new Error("evaluation rubric must have id and schemaVersion 1");
  }
  if (!Array.isArray(rubric.dimensions) || rubric.dimensions.length < 7) {
    throw new Error("evaluation rubric must contain all required dimensions");
  }
  const totalWeight = rubric.dimensions.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  if (Math.abs(totalWeight - 1) > 1e-9) throw new Error("evaluation rubric weights must sum to 1");
  return {
    schemaVersion: SCHEMA_VERSION,
    schemas: configuredSchemas.length,
    profiles: profiles.length,
    rubric: rubric.id,
  };
}
