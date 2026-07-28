import crypto from "node:crypto";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function trustedOrigins({ host = "127.0.0.1", port = 8787, configured = [], extra = "" } = {}) {
  const defaults = [`http://${host}:${port}`, `http://localhost:${port}`];
  const rendered = configured.map(value => String(value).replaceAll("{port}", String(port)));
  const extras = String(extra || "").split(",").map(value => value.trim()).filter(Boolean);
  return new Set([...defaults, ...rendered, ...extras]);
}

export function createLocalSecurity(options = {}) {
  const token = String(options.token || crypto.randomBytes(32).toString("base64url"));
  const origins = trustedOrigins(options);
  return Object.freeze({ token, origins });
}

export function corsHeaders(origin, security) {
  if (!origin || !security.origins.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Idempotency-Key,X-File-Name,X-Content-Id,X-Options,X-Workflow-Draft,X-Koubo-Session,X-Koubo-Workspace,X-Expected-Asset-Decision-Version",
    "Access-Control-Expose-Headers": "Content-Length,Idempotency-Replayed",
  };
}

export function authorizeLocalRequest(req, pathname, security, { enforceWriteToken = true } = {}) {
  const method = String(req.method || "GET").toUpperCase();
  const origin = String(req.headers?.origin || "").trim();
  if (origin && !security.origins.has(origin)) {
    const error = new Error("不可信的本地工作台来源");
    error.statusCode = 403;
    error.code = "UNTRUSTED_ORIGIN";
    throw error;
  }
  if (SAFE_METHODS.has(method) || pathname === "/api/session") return;
  if (!enforceWriteToken) return;
  const received = String(req.headers?.["x-koubo-session"] || "");
  const expected = Buffer.from(security.token);
  const actual = Buffer.from(received);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    const error = new Error("写操作缺少有效的本机会话令牌");
    error.statusCode = 403;
    error.code = "INVALID_SESSION_TOKEN";
    throw error;
  }
}

export function publicSession(security, workspaceId) {
  return { token: security.token, workspaceId, expires: "process-lifetime", localOnly: true };
}
