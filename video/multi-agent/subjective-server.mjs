import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { prepareSubjectiveReviewRecord } from "./subjective-result.mjs";
import { buildSubjectiveReviewHtml } from "./subjective-review.mjs";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mp4", "video/mp4"],
]);

function sendJson(res, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function isLoopback(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(String(address || ""));
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function replaceJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, file);
}

export async function refreshSubjectiveReviewPage({ runRoot } = {}) {
  if (!runRoot) throw new Error("runRoot is required");
  const resolvedRunRoot = path.resolve(runRoot);
  const manifest = await readJson(path.join(resolvedRunRoot, "subjective-manifest.json"));
  if (manifest.status !== "awaiting-user-subjective-review") {
    return { runId: manifest.runId, refreshed: false, status: manifest.status };
  }
  const html = buildSubjectiveReviewHtml({
    runId: manifest.runId,
    samples: manifest.samples,
  });
  const file = path.join(resolvedRunRoot, "review", "index.html");
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, html, "utf8");
  await fsp.rename(temporary, file);
  return { runId: manifest.runId, refreshed: true, status: manifest.status };
}

async function readRequestJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("review payload is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("review payload is not valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function staticFile(reviewRoot, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (!relative || relative.includes("\0")) return null;
  const resolved = path.resolve(reviewRoot, relative);
  const relation = path.relative(reviewRoot, resolved);
  if (relation.startsWith("..") || path.isAbsolute(relation)) return null;
  return resolved;
}

function rangeWindow(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || ""));
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start === null && end !== null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    start ??= 0;
    end ??= size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

async function serveStatic(req, res, reviewRoot, pathname) {
  const file = staticFile(reviewRoot, pathname);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const stat = fs.statSync(file);
  const range = rangeWindow(req.headers.range, stat.size);
  if (range?.invalid) {
    res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  const status = range ? 206 : 200;
  const headers = {
    "Content-Type": CONTENT_TYPES.get(path.extname(file).toLowerCase()) || "application/octet-stream",
    "Content-Length": Math.max(0, end - start + 1),
    "Accept-Ranges": "bytes",
    "Cache-Control": path.extname(file).toLowerCase() === ".html" ? "no-store" : "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(status, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(file, { start, end }).pipe(res);
}

async function recordReview(req, res, runRoot) {
  if (!isLoopback(req.socket.remoteAddress)) {
    sendJson(res, 403, { error: "loopback access required" });
    return;
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    sendJson(res, 415, { error: "application/json required" });
    return;
  }
  const manifestFile = path.join(runRoot, "subjective-manifest.json");
  const mappingFile = path.join(runRoot, "blind-map-private.json");
  const recordFile = path.join(runRoot, "subjective-review-record.json");
  if (fs.existsSync(recordFile)) {
    sendJson(res, 409, { error: "subjective review was already recorded" });
    return;
  }
  const [manifest, privateMap, payload] = await Promise.all([
    readJson(manifestFile),
    readJson(mappingFile),
    readRequestJson(req),
  ]);
  const result = prepareSubjectiveReviewRecord({ manifest, privateMap, payload });
  await fsp.writeFile(
    recordFile,
    `${JSON.stringify(result.record, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await replaceJson(manifestFile, result.updatedManifest);
  sendJson(res, 201, {
    success: true,
    runId: result.record.runId,
    outcome: result.record.outcome,
    recordHash: result.record.recordHash,
    productionApproval: false,
    autoPublish: false,
    memoryPromotion: false,
  });
}

export function createSubjectiveReviewServer({ runRoot } = {}) {
  if (!runRoot) throw new Error("runRoot is required");
  const resolvedRunRoot = path.resolve(runRoot);
  const reviewRoot = path.join(resolvedRunRoot, "review");
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/api/subjective-review") {
        await recordReview(req, res, resolvedRunRoot);
        return;
      }
      if (["GET", "HEAD"].includes(req.method || "")) {
        await serveStatic(req, res, reviewRoot, url.pathname);
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
    } catch (error) {
      sendJson(res, error.statusCode || 400, {
        error: String(error.message || "request failed")
          .replace(/[A-Za-z]:[\\/][^\s"]+/g, "[local-path]"),
      });
    }
  });
}
