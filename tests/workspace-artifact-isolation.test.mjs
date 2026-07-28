import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

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

async function waitForSession(base, workspaceId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/session`, {
        headers: { Origin: base, "X-Koubo-Workspace": workspaceId },
      });
      if (response.ok) return response.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("server did not start");
}

test("static job and content artifacts are isolated by workspace", async t => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const jobId = `workspace-job-${suffix}`;
  const contentId = `workspace-content-${suffix}`;
  const jobDir = path.join(root, "video-jobs", jobId);
  const contentDir = path.join(root, "content-items", contentId);
  await fsp.mkdir(jobDir, { recursive: false });
  await fsp.mkdir(contentDir, { recursive: false });
  t.after(() => Promise.all([
    fsp.rm(jobDir, { recursive: true, force: true }),
    fsp.rm(contentDir, { recursive: true, force: true }),
  ]));
  await fsp.writeFile(path.join(jobDir, "job.json"), JSON.stringify({ id: jobId, workspaceId: "team-a" }), "utf8");
  await fsp.writeFile(path.join(jobDir, "artifact.txt"), "job artifact", "utf8");
  await fsp.writeFile(path.join(contentDir, "content.json"), JSON.stringify({ id: contentId, workspaceId: "team-a" }), "utf8");
  await fsp.writeFile(path.join(contentDir, "artifact.txt"), "content artifact", "utf8");

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["video/server.mjs"], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, KOUBO_PORT: String(port) },
    stdio: "ignore",
  });
  t.after(() => { if (!child.killed) child.kill(); });
  await waitForSession(base, "team-a");

  for (const url of [
    `/video-jobs/${jobId}/artifact.txt`,
    `/content-items/${contentId}/artifact.txt`,
  ]) {
    const allowed = await fetch(`${base}${url}`, { headers: { Origin: base, "X-Koubo-Workspace": "team-a" } });
    assert.equal(allowed.status, 200, url);
    const denied = await fetch(`${base}${url}`, { headers: { Origin: base, "X-Koubo-Workspace": "team-b" } });
    assert.equal(denied.status, 404, url);
  }
});

test("job creation fails closed when content belongs to another workspace", async t => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const contentId = `workspace-upload-content-${suffix}`;
  const contentDir = path.join(root, "content-items", contentId);
  await fsp.mkdir(contentDir, { recursive: false });
  await fsp.writeFile(path.join(contentDir, "content.json"), JSON.stringify({ id: contentId, workspaceId: "team-a" }), "utf8");
  t.after(() => fsp.rm(contentDir, { recursive: true, force: true }));

  const before = new Set(await fsp.readdir(path.join(root, "video-jobs")));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["video/server.mjs"], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, KOUBO_PORT: String(port) },
    stdio: "ignore",
  });
  t.after(() => { if (!child.killed) child.kill(); });
  const session = await waitForSession(base, "team-b");
  const response = await fetch(`${base}/api/jobs`, {
    method: "POST",
    headers: {
      Origin: base,
      "Content-Type": "application/octet-stream",
      "X-File-Name": "fixture.mp4",
      "X-Content-Id": encodeURIComponent(contentId),
      "X-Koubo-Session": session.session.token,
      "X-Koubo-Workspace": "team-b",
    },
    body: Buffer.from("not-a-real-video"),
  });
  assert.equal(response.status, 404);

  const after = await fsp.readdir(path.join(root, "video-jobs"));
  const created = after.filter(name => !before.has(name));
  t.after(() => Promise.all(created.map(name => fsp.rm(path.join(root, "video-jobs", name), { recursive: true, force: true }))));
  assert.equal(created.length, 1);
  await assert.rejects(fsp.readFile(path.join(root, "video-jobs", created[0], "job.json"), "utf8"), /ENOENT/);
});
