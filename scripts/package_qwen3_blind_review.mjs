#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oldRunId = "faceless-backwards-blind-review-20260729";
const runId = "faceless-backwards-qwen3-blind-review-20260729";
const templateRoot = path.join(repo, "outputs", "acceptance", oldRunId);
const runRoot = path.join(repo, "outputs", "acceptance", runId);
const reviewRoot = path.join(runRoot, "review");
const mediaRoot = path.join(reviewRoot, "media");

const sources = [
  {
    sourceId: "short-video-backwards-a-background-first",
    source: path.join(repo, "videos", "short-video-backwards-a-background-first", "renders", "video-qwen3.mp4"),
  },
  {
    sourceId: "short-video-backwards-b-argument-first",
    source: path.join(repo, "videos", "short-video-backwards-b-argument-first", "renders", "video-qwen3.mp4"),
  },
  {
    sourceId: "short-video-backwards-c-thesis-only",
    source: path.join(repo, "videos", "short-video-backwards-c-thesis-only", "renders", "video-qwen3.mp4"),
  },
];

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", chunk => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex").toUpperCase()));
  });
}

function replaceRequired(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`template marker missing: ${label}`);
  return source.replace(before, after);
}

async function main() {
  try {
    await fsp.access(runRoot);
    throw new Error(`refusing to overwrite existing blind-review run: ${runRoot}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const item of sources) await fsp.access(item.source);

  await fsp.mkdir(mediaRoot, { recursive: true });
  const ordered = [...sources].sort((a, b) => hashText(`${runId}:${a.sourceId}`).localeCompare(hashText(`${runId}:${b.sourceId}`)));
  const labels = ["A", "B", "C"];
  const mapping = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const label = labels[index];
    const item = ordered[index];
    const destination = path.join(mediaRoot, `candidate-${label}.mp4`);
    await fsp.copyFile(item.source, destination);
    mapping.push({
      label,
      sourceId: item.sourceId,
      sourceSha256: await sha256(item.source),
      publicSha256: await sha256(destination),
    });
  }

  let serve = await fsp.readFile(path.join(templateRoot, "serve.mjs"), "utf8");
  serve = serve.replaceAll(oldRunId, runId);
  serve = replaceRequired(serve, "process.argv[2] || 8792", "process.argv[2] || 8794", "default port");
  serve = replaceRequired(
    serve,
    '["hook", "clarity", "editing", "publish"]',
    '["hook", "clarity", "editing", "voice", "publish"]',
    "score keys",
  );
  serve = replaceRequired(serve, "koubo-faceless-blind-review-v1", "koubo-faceless-qwen3-blind-review-v1", "record version");
  await fsp.writeFile(path.join(runRoot, "serve.mjs"), serve, "utf8");

  let html = await fsp.readFile(path.join(templateRoot, "review", "index.html"), "utf8");
  html = html.replaceAll(oldRunId, runId);
  html = replaceRequired(html, "KOUBO · 全新内容实验 · 匿名候选", "KOUBO · QWEN3 本地克隆配音复评 · 匿名候选", "eyebrow");
  html = replaceRequired(
    html,
    "三版均为全新脚本、本地配音和纯图文动效，不含旧口播人物或旧视频。请完整看完后分别打分，再决定选一版继续，或直接判定全组不合格。",
    "三版均已换成本地 Qwen3 音色克隆配音，未上传参考录音；画面、脚本和时长保持上一轮候选条件。请完整看完并单独评价配音自然度，再决定选一版继续，或判定全组不合格。",
    "lead",
  );
  html = replaceRequired(html, "请为三个候选完成四项评分", "请为三个候选完成五项评分", "status count");
  html = replaceRequired(
    html,
    '["editing", "剪辑是否帮助理解而不是抢话"],\n    ["publish", "整体是否愿意发布"]',
    '["editing", "剪辑是否帮助理解而不是抢话"],\n    ["voice", "配音是否自然、像真人表达"],\n    ["publish", "整体是否愿意发布"]',
    "voice metric",
  );
  html = replaceRequired(html, "的四项评分。", "的五项评分。", "validation count");
  await fsp.writeFile(path.join(reviewRoot, "index.html"), html, "utf8");

  await fsp.writeFile(path.join(runRoot, "blind-map-private.json"), `${JSON.stringify({
    runId,
    mapping,
    private: true,
    revealOnlyAfterReview: true,
  }, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(runRoot, "subjective-manifest.json"), `${JSON.stringify({
    schemaVersion: 2,
    runId,
    mediaKind: "faceless-explainer-qwen3-voice-clone",
    status: "awaiting-user-subjective-review",
    automatedPass: true,
    candidateLabels: labels,
    questions: [
      "前三秒是否愿意继续看",
      "核心观点是否清楚",
      "剪辑是否帮助理解而不是抢话",
      "配音是否自然、像真人表达",
      "整体是否愿意发布",
    ],
    productionApproval: false,
    autoPublish: false,
    memoryPromotion: false,
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ success: true, runId, runRoot, reviewRoot, labels })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
