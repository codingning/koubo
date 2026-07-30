import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const jobId = `publish-cover-package-${process.pid}-${Date.now()}`;
const jobDir = path.join(root, "video-jobs", jobId);
process.env.KOUBO_NO_LISTEN = "1";
process.env.KOUBO_MULTI_AGENT_DATA_ROOT = path.join(jobDir, "multi-agent-test-data");

const serverModule = await import(`../video/server.mjs?publish-cover-package-test=${Date.now()}`);
const { closeServerResourcesForTests, httpServerForTests } = serverModule;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  return result.stdout;
}

async function post(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test.after(async () => {
  await closeServerResourcesForTests();
  fs.rmSync(jobDir, { recursive: true, force: true });
});

test("approved jobs generate content-first covers from a separate real-person source and a local publish package", async () => {
  await fsp.mkdir(jobDir, { recursive: true });
  const source = path.join(jobDir, "source.mp4");
  run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=1.2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
  ]);
  const coverSource = path.join(jobDir, "cover-source.mp4");
  run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=1.2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", coverSource,
  ]);
  const coverSourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(coverSource)).digest("hex");
  const output = {
    version: 1,
    path: source,
    url: `/video-jobs/${jobId}/source.mp4`,
    qaPass: true,
    mediaSha256: "a".repeat(64),
    metadata: { duration: 1.2, width: 1080, height: 1920 },
    qa: {},
    artifacts: {},
  };
  const job = {
    id: jobId,
    status: "approved",
    sourcePath: source,
    source: { width: 1080, height: 1920, duration: 1.2, colorTransfer: "bt709", colorPrimaries: "bt709" },
    script: "我做了一个 Skill，把抖音收藏变成了本地 Obsidian 知识库。下次只要问 AI，就能找回原视频。",
    currentPlan: { keepSegments: [{ start: 0, end: 1.2 }], coverDesign: { lines: ["收藏≠学会", "越存越没用"], highlights: ["没用"], sourceTime: 0.5 } },
    options: { generateCover: true, contentTitle: "把抖音收藏变成本地知识库", coverSourcePath: coverSource, coverSourceRole: "user-provided-real-person-source", coverSourceTime: 0.5 },
    output,
    versions: [output],
  };
  await fsp.writeFile(path.join(jobDir, "job.json"), JSON.stringify(job, null, 2));

  await new Promise((resolve, reject) => {
    httpServerForTests.once("error", reject);
    httpServerForTests.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServerForTests.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const result = await post(baseUrl, `/api/jobs/${jobId}/cover`, { coverTitle: "收藏≠学会 / 越存越没用" });

  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.cover.style, "content-first-real-person-conflict-cover-v3");
  assert.ok(result.payload.cover.design.lines.length <= 2);
  assert.equal(result.payload.cover.source.role, "user-provided-real-person-source");
  assert.equal(result.payload.cover.source.sha256, coverSourceSha256);
  assert.equal(result.payload.publishPackage.generation.coverSource.sha256, coverSourceSha256);
  assert.equal(result.payload.publishPackage.status, "ready");
  assert.equal(result.payload.publishPackage.autoPublish, false);
  assert.equal(result.payload.publishPackage.titleCandidates.length, 3);
  assert.ok(result.payload.publishPackage.hashtags.length >= 4);
  assert.ok(result.payload.publishPackage.hashtags.length <= 8);
  assert.deepEqual(Object.keys(result.payload.publishPackage.platforms), ["douyin", "xiaohongshu", "wechat"]);

  const coverDir = path.join(jobDir, "covers", "v1");
  const vertical = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", path.join(coverDir, "cover-v1-9x16.png")])).streams[0];
  const grid = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", path.join(coverDir, "cover-v1-3x4.png")])).streams[0];
  const wide = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", path.join(coverDir, "cover-v1-16x9.png")])).streams[0];
  const landscape = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", path.join(coverDir, "cover-v1-4x3.png")])).streams[0];
  assert.deepEqual([vertical.width, vertical.height], [1080, 1920]);
  assert.deepEqual([grid.width, grid.height], [1080, 1440]);
  assert.deepEqual([wide.width, wide.height], [1920, 1080]);
  assert.deepEqual([landscape.width, landscape.height], [1440, 1080]);
  const gridAss = fs.readFileSync(path.join(coverDir, "cover-3x4.ass"), "utf8");
  assert.match(gridAss, /收藏≠学会/u);
  assert.doesNotMatch(gridAss, /三金AI实战/u);
  assert.equal(fs.existsSync(path.join(jobDir, "publish-package-v1.zip")), true);
});
