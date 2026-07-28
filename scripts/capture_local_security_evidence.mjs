import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const baseUrl = String(process.argv[2] || "http://127.0.0.1:8791").replace(/\/$/u, "");
const outputRelative = String(
  process.argv[3] || "outputs/acceptance/local-security-probe-20260728.json"
).replace(/\\/g, "/");
const outputPath = path.resolve(root, outputRelative);
if (outputPath !== root && !outputPath.startsWith(`${root}${path.sep}`)) {
  throw new Error("output path must stay inside the workspace");
}

const workspaceId = `security-acceptance-${Date.now()}`;
const sessionResponse = await fetch(`${baseUrl}/api/session`, {
  headers: { Origin: baseUrl, "X-Koubo-Workspace": workspaceId },
});
const sessionBody = await sessionResponse.json();
if (!sessionResponse.ok || !sessionBody?.session?.token) {
  throw new Error(`session probe failed with ${sessionResponse.status}`);
}
const token = sessionBody.session.token;

async function writeProbe({ origin, includeToken }) {
  const response = await fetch(`${baseUrl}/api/video-workflow/drafts`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Koubo-Workspace": workspaceId,
      ...(includeToken ? { "X-Koubo-Session": token } : {}),
    },
    body: JSON.stringify({ acceptanceFixture: true }),
  });
  const body = await response.json().catch(() => ({}));
  return {
    request: {
      method: "POST",
      path: "/api/video-workflow/drafts",
      origin,
      contentType: "application/json",
      workspaceHeader: "present",
      sessionHeader: includeToken ? "present" : "absent",
      body: { acceptanceFixture: true },
    },
    response: {
      status: response.status,
      error: String(body?.error || ""),
      createdDraft: response.status === 201 && typeof body?.draftId === "string",
      expiresInSeconds: Number.isFinite(body?.expiresInSeconds) ? body.expiresInSeconds : null,
    },
  };
}

const baseline = spawnSync(
  "git",
  ["show", "6a29b98:video/server.mjs"],
  { cwd: root, encoding: "utf8", windowsHide: true }
);
if (baseline.status !== 0) throw new Error("unable to read baseline security implementation");
const baselineAllowsAnyOrigin = /Access-Control-Allow-Origin["']\s*,\s*["']\*["']/u.test(baseline.stdout);
const currentCommitResult = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
});
if (currentCommitResult.status !== 0) throw new Error("unable to read current source commit");
const healthResponse = await fetch(`${baseUrl}/api/health`, {
  headers: { Origin: baseUrl, "X-Koubo-Workspace": workspaceId },
});
const health = await healthResponse.json();
const missingToken = await writeProbe({ origin: baseUrl, includeToken: false });
const untrustedOrigin = await writeProbe({ origin: "https://evil.example", includeToken: true });
const trustedWrite = await writeProbe({ origin: baseUrl, includeToken: true });

const evidence = {
  schemaVersion: 1,
  kind: "local_security_acceptance_probe",
  capturedAt: new Date().toISOString(),
  scope: {
    baseUrl,
    workspaceId,
    sourceCommit: currentCommitResult.stdout.trim(),
    healthStatus: healthResponse.status,
    serviceVersion: health?.version ?? null,
    safeMutation: "create an in-memory workflow draft fixture",
    excludedClaims: ["DNS rebinding resistance", "remote network exposure", "browser exploitability of the baseline"],
  },
  baseline: {
    commit: "6a29b98",
    allowsAnyOrigin: baselineAllowsAnyOrigin,
    matchedConfiguration: baselineAllowsAnyOrigin ? "Access-Control-Allow-Origin: *" : "not found",
  },
  currentRuntime: {
    sessionRead: {
      request: {
        method: "GET",
        path: "/api/session",
        origin: baseUrl,
        workspaceHeader: "present",
        sessionHeader: "not-required",
      },
      response: {
        status: sessionResponse.status,
        tokenReturned: true,
        tokenValueRecorded: false,
        expires: sessionBody.session.expires,
      },
    },
    missingSessionTokenWrite: missingToken,
    untrustedOriginWithTokenWrite: untrustedOrigin,
    trustedOriginWithTokenWrite: trustedWrite,
  },
  expected: {
    sessionRead: 200,
    missingSessionTokenWrite: 403,
    untrustedOriginWithTokenWrite: 403,
    trustedOriginWithTokenWrite: 201,
  },
};
evidence.observedStatuses = {
  sessionRead: evidence.currentRuntime.sessionRead.response.status,
  missingSessionTokenWrite: evidence.currentRuntime.missingSessionTokenWrite.response.status,
  untrustedOriginWithTokenWrite: evidence.currentRuntime.untrustedOriginWithTokenWrite.response.status,
  trustedOriginWithTokenWrite: evidence.currentRuntime.trustedOriginWithTokenWrite.response.status,
};
evidence.pass = JSON.stringify(evidence.observedStatuses) === JSON.stringify(evidence.expected)
  && evidence.baseline.allowsAnyOrigin === true;

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({ outputRelative, pass: evidence.pass, observedStatuses: evidence.observedStatuses })}\n`);
