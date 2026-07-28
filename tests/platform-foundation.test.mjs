import test from "node:test";
import assert from "node:assert/strict";
import { authorizeLocalRequest, corsHeaders, createLocalSecurity } from "../video/platform/security.mjs";
import { assertWorkspaceAccess, bindWorkspace, belongsToWorkspace, normalizeWorkspaceId } from "../video/platform/workspaces.mjs";
import { buildExporterEdl, exporterRequest } from "../video/exporters/contracts.mjs";

test("local security allows trusted reads and requires a write token", () => {
  const security = createLocalSecurity({ port: 8787, token: "fixed-test-token" });
  const read = { method: "GET", headers: { origin: "http://127.0.0.1:8787" } };
  assert.doesNotThrow(() => authorizeLocalRequest(read, "/api/jobs", security));
  const write = { method: "POST", headers: { origin: "http://127.0.0.1:8787", "x-koubo-session": "fixed-test-token" } };
  assert.doesNotThrow(() => authorizeLocalRequest(write, "/api/jobs", security));
  assert.throws(() => authorizeLocalRequest({ ...write, headers: { origin: "https://evil.example" } }, "/api/jobs", security), /不可信/);
  assert.throws(() => authorizeLocalRequest({ method: "POST", headers: { origin: "http://127.0.0.1:8787" } }, "/api/jobs", security), /会话令牌/);
  assert.equal(corsHeaders("https://evil.example", security)["Access-Control-Allow-Origin"], undefined);
});

test("workspace ids are stable and records fail closed across workspaces", () => {
  assert.equal(normalizeWorkspaceId(" Demo_User "), "demo_user");
  assert.equal(normalizeWorkspaceId("../../escape"), "local-default");
  const record = bindWorkspace({ id: "job-1" }, "team-a");
  assert.equal(belongsToWorkspace(record, "team-a"), true);
  assert.throws(() => assertWorkspaceAccess(record, "team-b"), /无权访问/);
});

test("exporter contract converts only a contiguous approved timeline", () => {
  const timeline = {
    version: 3,
    source: { path: "F:\\media\\source.mp4", fps: 30 },
    outputDuration: 4,
    clips: [
      { id: "clip-001", sourceIn: 1, sourceOut: 3, outputIn: 0, outputOut: 2, reason: "keep" },
      { id: "clip-002", sourceIn: 5, sourceOut: 7, outputIn: 2, outputOut: 4, reason: "keep" },
    ],
  };
  const edl = buildExporterEdl(timeline);
  assert.equal(edl.ranges.length, 2);
  assert.equal(edl.ranges[1].output_start, 2);
  const request = exporterRequest({ job: { id: "job-1" }, timeline, exporter: "jianying", outputRoot: "F:\\drafts" });
  assert.equal(request.draft_name, "job-1-v3");
  const broken = structuredClone(timeline);
  broken.clips[1].outputIn = 3;
  assert.throws(() => buildExporterEdl(broken), /不连续/);
});
