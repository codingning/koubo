import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const envFile = path.join(root, ".env");
if (typeof process.loadEnvFile === "function" && fs.existsSync(envFile)) process.loadEnvFile(envFile);
const bridge = path.join(root, "video", "ai_bridge.py");
const python = path.join(root, ".runtime", "Scripts", "python.exe");
const opencliCommand = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "opencli";
const opencliPrefix = process.platform === "win32" ? ["/d", "/s", "/c", "opencli"] : [];

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 120000, ...spawnOptions } = options;
    const child = spawn(command, args, { windowsHide: true, ...spawnOptions });
    let stdout = "", stderr = "", settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(Object.assign(new Error(`${command} 超时`), { stdout, stderr }));
      }
    }, timeoutMs);
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timeout); if (!settled) { settled = true; reject(error); } });
    child.on("close", code => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      code === 0 ? resolve({ stdout, stderr }) : reject(Object.assign(new Error(`${command} 退出码 ${code}`), { stdout, stderr, code }));
    });
  });
}

async function readJson(file) {
  return JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

function array(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function clean(value, max = 600) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }

function keywords(plan) {
  return [...new Set(array(plan.keywords).map(item => clean(item, 24)).filter(item => item.length >= 2))].slice(0, 12);
}

function relevance(item, plan, creator = null) {
  const text = `${item.title || item.desc || ""} ${creator?.referenceFor?.join(" ") || ""}`.toLowerCase();
  let score = 0;
  for (const word of keywords(plan)) if (text.includes(word.toLowerCase())) score += word.toLowerCase() === "ai" ? 1 : 3;
  if (creator?.pinnedVideoIds?.includes(String(item.aweme_id || item.videoId))) score += 2;
  return score;
}

async function detectProfile() {
  if (process.env.OPENCLI_PROFILE?.trim()) return process.env.OPENCLI_PROFILE.trim();
  const result = await run(opencliCommand, [...opencliPrefix, "profile", "list"], { cwd: root, timeoutMs: 30000 });
  const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const preferred = lines.find(line => /\bdefault\b/.test(line)) || lines.find(line => /connected v/i.test(line));
  return preferred?.split(/\s+/)[0] || "";
}

async function opencli(profile, commandArgs) {
  const args = [...(profile ? ["--profile", profile] : []), "douyin", ...commandArgs, "--window", "background", "--site-session", "ephemeral", "--keep-tab", "false", "-f", "json"];
  const result = await run(opencliCommand, [...opencliPrefix, ...args], { cwd: root, timeoutMs: 150000 });
  return array(JSON.parse(result.stdout.replace(/^\uFEFF/, "")));
}

async function runBridge(payload, tempDir, name) {
  if (!fs.existsSync(python)) throw new Error("本地AI运行环境不存在");
  const request = path.join(tempDir, `${name}-request.json`);
  const response = path.join(tempDir, `${name}-response.json`);
  await writeJson(request, payload);
  try { await run(python, [bridge, "--request", request, "--response", response], { cwd: root, env: process.env, timeoutMs: 900000 }); } catch {}
  const result = await readJson(response);
  if (!result.success) throw new Error(result.error || `${name}失败`);
  return result;
}

async function download(url, target) {
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", referer: "https://www.douyin.com/" } });
  if (!response.ok) throw new Error(`参考视频下载失败：HTTP ${response.status}`);
  await fsp.writeFile(target, Buffer.from(await response.arrayBuffer()));
}

function librarySource(item, score, mode = "curated-full-transcript") {
  return {
    sourceId: item.sourceId,
    platform: "douyin",
    creator: "用户指定参考账号",
    title: item.topic,
    url: item.url,
    durationSeconds: item.durationSeconds,
    evidenceLevel: mode,
    relevanceScore: score,
    analysis: {
      topic: item.topic,
      relevance: "与本次AI选题共享工具实践、工作流或知识拆解场景",
      structure: item.structure,
      knowledge: item.knowledge,
      engagement: item.engagement,
      discussionSignals: [],
      reusablePatterns: item.structure,
      limits: ["历史完整视频研究只用于结构基线；具体产品事实仍以本次选题证据为准"],
      copyBoundary: item.copyBoundary
    }
  };
}

async function analyzeCandidate(candidate, plan, tempDir) {
  const videoId = String(candidate.aweme_id || candidate.videoId || "");
  const sourceId = `douyin-${videoId}`;
  const video = path.join(tempDir, `${sourceId}.mp4`);
  await download(candidate.play_url, video);
  const transcriptDir = path.join(tempDir, `${sourceId}-transcript`);
  const transcription = await runBridge({ operation: "transcribe", input_path: video, output_dir: transcriptDir, model_size: "small", language: "zh" }, tempDir, `${sourceId}-transcribe`);
  const source = {
    sourceId,
    platform: "douyin",
    creator: clean(candidate.creator || candidate.author || "用户指定参考账号", 80),
    title: clean(candidate.title || candidate.desc, 500),
    url: `https://www.douyin.com/video/${videoId}`,
    durationSeconds: Number(candidate.duration || transcription.data?.duration || 0),
    evidenceLevel: "live-full-video-local-transcript"
  };
  const comments = array(candidate.top_comments).slice(0, 8).map(item => ({ text: clean(item?.text, 240), diggCount: Number(item?.digg_count || 0) }));
  const analysis = await runBridge({ operation: "analyze_reference", topic_plan: plan, source, transcript: transcription.data?.text || "", comments }, tempDir, `${sourceId}-analysis`);
  return { ...source, relevanceScore: Number(candidate._score || 0), analysis: analysis.data };
}

async function main() {
  const planArg = arg("--plan");
  const outputArg = arg("--output");
  if (!planArg || !outputArg) throw new Error("用法：--plan topic-plan.json --output reference-research.json");
  const planFile = path.resolve(planArg);
  const outputFile = path.resolve(outputArg);
  const plan = await readJson(planFile);
  const config = await readJson(path.join(root, "config", "reference_creators.json"));
  const library = await readJson(path.join(root, "config", "reference_video_library.json"));
  const tempDir = path.join(path.dirname(outputFile), ".reference-temp");
  await fsp.rm(tempDir, { recursive: true, force: true });
  await fsp.mkdir(tempDir, { recursive: true });
  const warnings = [];
  const feeds = [];
  const discoveries = [];
  let profile = "";
  try {
    if (String(process.env.KOUBO_LIVE_REFERENCE_RESEARCH || "1") !== "0") {
      profile = await detectProfile();
      for (const creator of config.creators || []) {
        try {
          const items = await opencli(profile, ["user-videos", creator.secUid, "--limit", String(config.policy.feedLimitPerCreator || 8), "--with_comments", "true", "--comment_limit", "5"]);
          for (const item of items) feeds.push({ ...item, _creator: creator, _score: relevance(item, plan, creator) });
        } catch (error) { warnings.push(`${creator.label}主页读取失败：${error.message}${error.stderr ? `；${clean(error.stderr, 400)}` : ""}`); }
      }
      for (const query of array(plan.searchQueries).slice(0, 2)) {
        try {
          const items = await opencli(profile, ["search", clean(query, 80), "--limit", String(config.policy.searchResultLimit || 8)]);
          for (const item of items) discoveries.push({ ...item, _query: query, _score: relevance(item, plan) });
        } catch (error) { warnings.push(`同题搜索“${query}”失败：${error.message}${error.stderr ? `；${clean(error.stderr, 400)}` : ""}`); }
      }
    }
  } catch (error) {
    warnings.push(`实时抖音研究不可用：${error.message}`);
  }

  const fullContentSources = [];
  const selected = [];
  for (const creator of config.creators || []) {
    const ranked = feeds.filter(item => item._creator?.id === creator.id && item.play_url && Number(item.duration || 0) <= Number(config.policy.maximumReferenceDurationSeconds || 900)).sort((a, b) => b._score - a._score);
    const pinned = ranked.find(item => creator.pinnedVideoIds?.includes(String(item.aweme_id)));
    const candidate = pinned && pinned._score >= Number(ranked[0]?._score || 0) - 2 ? pinned : ranked[0];
    if (candidate) selected.push(candidate);
  }
  for (const candidate of selected.sort((a, b) => b._score - a._score).slice(0, Number(config.policy.fullVideoAnalysisCount || 2))) {
    const sourceId = `douyin-${candidate.aweme_id}`;
    const cached = array(library.items).find(item => item.sourceId === sourceId);
    if (cached) fullContentSources.push(librarySource(cached, candidate._score, "live-metadata+curated-full-transcript"));
    else {
      try { fullContentSources.push(await analyzeCandidate(candidate, plan, tempDir)); }
      catch (error) { warnings.push(`完整视频 ${candidate.aweme_id} 分析失败：${error.message}`); }
    }
  }

  if (!fullContentSources.length) {
    for (const item of array(library.items).map(item => ({ item, score: relevance({ title: `${item.topic} ${item.relevanceKeywords?.join(" ") || ""}` }, plan) })).sort((a, b) => b.score - a.score).slice(0, 2)) {
      if (item.score > 0) fullContentSources.push(librarySource(item.item, item.score));
    }
  }

  const metadataOnlySources = discoveries.sort((a, b) => b._score - a._score).slice(0, 8).map(item => ({
    sourceId: `douyin-discovery-${item.url?.match(/\d{12,}/)?.[0] || Math.abs(clean(item.desc || item.title).split("").reduce((sum, char) => ((sum << 5) - sum + char.charCodeAt(0)) | 0, 0))}`,
    platform: "douyin",
    title: clean(item.desc || item.title, 500),
    creator: clean(item.author, 80),
    url: clean(item.url, 500),
    query: clean(item._query, 80),
    evidenceLevel: "metadata-and-visible-metrics-only",
    relevanceScore: Number(item._score || 0),
    visibleMetrics: { plays: item.plays ?? null, likes: item.likes ?? null, comments: item.comments ?? null, shares: item.shares ?? null }
  }));

  if (config.policy.requireAtLeastOneFullContentSource && !fullContentSources.length) throw new Error("没有找到至少一条可完成全文核验的同题参考视频，已停止生成以避免伪装研究");
  const output = {
    status: warnings.length ? "ready-with-warnings" : "ready",
    platform: "douyin",
    generatedAt: new Date().toISOString(),
    topicPlan: plan,
    researchMethod: {
      liveCreatorFeeds: feeds.length > 0,
      liveTopicSearch: discoveries.length > 0,
      localFullVideoTranscription: fullContentSources.some(item => /live-full-video/.test(item.evidenceLevel)),
      curatedFullTranscriptFallback: fullContentSources.some(item => /curated-full-transcript/.test(item.evidenceLevel)),
      opencliProfile: profile || null
    },
    fullContentSources,
    metadataOnlySources,
    warnings,
    usageBoundary: "只有fullContentSources可用于概括视频结构和知识；metadataOnlySources只能用于发现选题、标题和评论方向。所有输出必须重新组织，禁止复制原句、案例、人设或素材。"
  };
  await writeJson(outputFile, output);
  await fsp.rm(tempDir, { recursive: true, force: true });
}

main().catch(async error => {
  const output = arg("--output");
  if (output) await writeJson(path.resolve(output), { status: "blocked", generatedAt: new Date().toISOString(), error: error.message, fullContentSources: [], metadataOnlySources: [], warnings: [error.message] });
  console.error(error.message);
  process.exitCode = 1;
});
