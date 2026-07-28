import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForSession(base, origin) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/session`, { headers: { Origin: origin } });
      if (response.ok) return response.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("server did not start");
}

test("approved timeline exports through the secured Jianying route without mutating timeline", async t => {
  const ffmpeg = path.join(root, ".runtime", "ffmpeg", "bin", "ffmpeg.exe");
  const exporterPython = path.join(root, ".runtime-exporters", "Scripts", "python.exe");
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(exporterPython)) return t.skip("runtime missing");
  const jobId = `platform-route-${Date.now()}`;
  const jobDir = path.join(root, "video-jobs", jobId);
  await fsp.mkdir(jobDir, { recursive: false });
  t.after(() => fsp.rm(jobDir, { recursive: true, force: true }));
  const source = path.join(jobDir, "source.mp4");
  const media = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x234567:s=640x360:r=30:d=3", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source], { encoding: "utf8" });
  assert.equal(media.status, 0, media.stderr);
  const timeline = { version: 1, source: { path: source, duration: 3, width: 640, height: 360, fps: 30 }, outputDuration: 2, clips: [{ id: "clip-001", sourceIn: 0, sourceOut: 1, outputIn: 0, outputOut: 1, reason: "keep" }, { id: "clip-002", sourceIn: 2, sourceOut: 3, outputIn: 1, outputOut: 2, reason: "keep" }] };
  const job = { id: jobId, workspaceId: "local-default", status: "approved", sourcePath: source, output: { version: 1, finalReview: { status: "approved", version: 1 } }, versions: [], reviews: [], assets: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await fsp.writeFile(path.join(jobDir, "job.json"), JSON.stringify(job, null, 2), "utf8");
  await fsp.writeFile(path.join(jobDir, "timeline-v1.json"), JSON.stringify(timeline, null, 2), "utf8");
  const beforeTimeline = await fsp.readFile(path.join(jobDir, "timeline-v1.json"), "utf8");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["video/server.mjs"], { cwd: root, windowsHide: true, env: { ...process.env, KOUBO_PORT: String(port), KOUBO_EXPORTER_PYTHON: exporterPython }, stdio: "ignore" });
  t.after(() => { if (!child.killed) child.kill(); });
  const session = await waitForSession(base, base);
  const response = await fetch(`${base}/api/jobs/${jobId}/exports/jianying`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json", "X-Koubo-Session": session.session.token, "X-Koubo-Workspace": "local-default" },
    body: JSON.stringify({ timelineVersion: 1, draftName: "route-fixture" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.equal(payload.export.result.verification.ok, true);
  assert.equal(await fsp.readFile(path.join(jobDir, "timeline-v1.json"), "utf8"), beforeTimeline);
  assert.equal(fs.existsSync(path.join(jobDir, "exports", "jianying", "route-fixture", "draft_content.json")), true);
});
