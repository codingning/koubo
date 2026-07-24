#!/usr/bin/env node
import crypto from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLI_MAIN_RELATIVE = path.join(
  "node_modules",
  "@jackwener",
  "opencli",
  "dist",
  "src",
  "main.js"
);
const SAFE_RESUME_RETRIEVAL_METHODS = new Set([
  "user-videos",
  "public-video-page-fallback",
]);
const SAFE_MEDIA_MODES = new Set(["progressive"]);
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const SENSITIVE_KEY_PATTERN = /(?:^|_)(?:access_?token|auth_?token|authorization|authorization_?header|cookie|cookie_?header|csrf_session_id|ms_?token|odin_tt|passport_csrf_token|play_?url|primary_?src|refresh_?token|resources|sessionid(?:_ss)?|sid_guard|sid_tt|signature|signed_?url|ttwid|verify_?fp|webid|x_?bogus|a_?bogus)(?:$|_)/iu;
let cachedOpencliInvocation = null;

export function redactSensitiveOutput(value) {
  return String(value || "")
    .replace(/https?:\\\/\\\/(?:\\.|[^"'<>\\\s])+/giu, "[redacted-url]")
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(
      /((?:access_?token|authToken|authorization|authorizationHeader|cookie|cookieHeader|csrf_session_id|msToken|odin_tt|passport_csrf_token|refresh_?token|sessionid(?:_ss)?|sid_guard|sid_tt|signature|signedUrl|token|ttwid|verifyFp|fp|webid|x-bogus|a_bogus)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^;,&}\s]+)/giu,
      "$1=[redacted]"
    );
}

export function sanitizeFreeText(value, maxLength = 1000) {
  const limit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : 1000;
  return redactSensitiveOutput(value)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

export function canonicalDouyinVideoUrl(videoId) {
  if (!/^\d{19}$/u.test(String(videoId || ""))) {
    throw new Error("a 19-digit Douyin video id is required");
  }
  return "https://www.douyin.com/video/" + videoId;
}

function envValue(env, key) {
  const matched = Object.keys(env || {}).find(name => name.toLowerCase() === key.toLowerCase());
  return matched ? env[matched] : "";
}

function expandWindowsEnvironment(value, env) {
  return String(value || "").replace(/%([^%]+)%/gu, (match, key) => {
    const resolved = envValue(env, key);
    return resolved === undefined || resolved === null || resolved === "" ? match : String(resolved);
  });
}

function opencliEntryInDirectory(directory, exists) {
  const entry = path.join(directory, OPENCLI_MAIN_RELATIVE);
  return exists(entry) ? entry : "";
}

function parseWindowsWrapperEnvironment(text, baseEnvironment) {
  const environment = { ...baseEnvironment };
  for (const line of String(text || "").split(/\r?\n/u)) {
    const match = line.match(/^\s*set\s+"([^=]+)=(.*)"\s*$/iu);
    if (!match) continue;
    const existingKey = Object.keys(environment)
      .find(name => name.toLowerCase() === match[1].toLowerCase());
    environment[existingKey || match[1]] = expandWindowsEnvironment(match[2], environment);
  }
  return environment;
}

function wrapperTargets(text, wrapperDirectory, environment) {
  const targets = [];
  for (const match of String(text || "").matchAll(/"([^"]+opencli\.cmd)"\s+%[*]/giu)) {
    const expanded = expandWindowsEnvironment(match[1], environment)
      .replaceAll("%~dp0", wrapperDirectory + path.sep);
    targets.push(path.resolve(wrapperDirectory, expanded));
  }
  return targets;
}

function pathDirectories(environment) {
  return String(envValue(environment, "PATH") || "")
    .split(path.delimiter)
    .map(value => value.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean);
}

export function resolveOpencliInvocation({
  platform = process.platform,
  environment = process.env,
  exists = fs.existsSync,
  readText = file => fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""),
  nodeExecutable = process.execPath,
} = {}) {
  if (platform !== "win32") {
    return {
      command: "opencli",
      prefix: [],
      environment: { ...environment },
      source: "path-executable",
    };
  }

  const initialEnvironment = { ...environment };
  const seen = new Set();
  const queue = pathDirectories(initialEnvironment)
    .map(directory => path.join(directory, "opencli.cmd"))
    .filter(exists)
    .map(file => ({ file: path.resolve(file), environment: initialEnvironment }));

  while (queue.length) {
    const current = queue.shift();
    const identity = current.file.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);

    const directory = path.dirname(current.file);
    const directEntry = opencliEntryInDirectory(directory, exists);
    if (directEntry) {
      const localNode = path.join(directory, "node.exe");
      return {
        command: exists(localNode) ? localNode : nodeExecutable,
        prefix: [directEntry],
        environment: current.environment,
        source: current.file,
      };
    }

    let text;
    try {
      text = readText(current.file);
    } catch {
      continue;
    }
    const wrapperEnvironment = parseWindowsWrapperEnvironment(text, current.environment);
    for (const target of wrapperTargets(text, directory, wrapperEnvironment)) {
      if (exists(target)) queue.push({ file: target, environment: wrapperEnvironment });
    }
    for (const searchDirectory of pathDirectories(wrapperEnvironment)) {
      const entry = opencliEntryInDirectory(searchDirectory, exists);
      if (!entry) continue;
      const localNode = path.join(searchDirectory, "node.exe");
      return {
        command: exists(localNode) ? localNode : nodeExecutable,
        prefix: [entry],
        environment: wrapperEnvironment,
        source: current.file,
      };
    }
  }
  throw new Error("could not resolve the shell-free OpenCLI Node entry");
}

function parseBoolean(value, key) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${key} must be true or false`);
}

export function parseArguments(argv) {
  const values = {
    profile: "",
    boundary: "public-reference-research-only-no-redistribution",
    withComments: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (["--url", "--video-id", "--author", "--output-dir", "--profile", "--boundary"].includes(key)) {
      const next = argv[++index];
      if (next === undefined) throw new Error(key + " requires a value");
      values[key.slice(2)] = next;
      continue;
    }
    if (key === "--with-comments") {
      const next = argv[++index];
      if (next === undefined) throw new Error(key + " requires a value");
      values.withComments = parseBoolean(next, key);
      continue;
    }
    throw new Error(`unknown argument: ${key}`);
  }
  if (!values.url && !values["video-id"]) throw new Error("--url or --video-id is required");
  const match = String(values["video-id"] || values.url).match(/\d{19}/u);
  if (!match) throw new Error("a 19-digit Douyin video id is required");
  values.videoId = match[0];
  values.url = canonicalDouyinVideoUrl(values.videoId);
  if (!String(values.author || "").trim()) throw new Error("--author is required");
  if (!String(values["output-dir"] || "").trim()) throw new Error("--output-dir is required");
  values.boundary = sanitizeFreeText(values.boundary, 300);
  if (!values.boundary) throw new Error("--boundary must not be empty");
  return values;
}

export function run(command, args, {
  cwd = root,
  timeoutMs = 150000,
  environment = process.env,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(path.basename(command) + " timed out"));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ stdout, stderr });
      else {
        const detail = redactSensitiveOutput(stderr || stdout).replace(/\s+/gu, " ").trim().slice(-800);
        const error = new Error(
          path.basename(command) + " exited with " + code + (detail ? ": " + detail : "")
        );
        error.code = code;
        reject(error);
      }
    });
  });
}

export function opencliArgs(profile, site, commandArgs, format = "json") {
  return [
    ...(profile ? ["--profile", profile] : []),
    site,
    ...commandArgs,
    "--window", "background",
    "--site-session", "ephemeral",
    "--keep-tab", "false",
    "-f", format,
  ];
}

async function opencli(profile, site, commandArgs, { format = "json", timeoutMs = 150000 } = {}) {
  cachedOpencliInvocation ||= resolveOpencliInvocation();
  const result = await run(
    cachedOpencliInvocation.command,
    [...cachedOpencliInvocation.prefix, ...opencliArgs(profile, site, commandArgs, format)],
    { timeoutMs, environment: cachedOpencliInvocation.environment }
  );
  return result.stdout.replace(/^\uFEFF/u, "");
}

async function opencliBrowser(profile, session, commandArgs, { timeoutMs = 150000 } = {}) {
  cachedOpencliInvocation ||= resolveOpencliInvocation();
  const result = await run(
    cachedOpencliInvocation.command,
    [
      ...cachedOpencliInvocation.prefix,
      ...(profile ? ["--profile", profile] : []),
      "browser",
      session,
      ...commandArgs,
      "--window", "background",
    ],
    { timeoutMs, environment: cachedOpencliInvocation.environment }
  );
  return result.stdout.replace(/^\uFEFF/u, "");
}

export function firstAuthorSecUid(pageText) {
  const matches = [...String(pageText).matchAll(/https:\/\/www\.douyin\.com\/user\/(MS4wLjAB[A-Za-z0-9_-]+)/gu)];
  return matches[0]?.[1] || "";
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function ipv4Octets(address) {
  const parts = String(address || "").split(".").map(Number);
  return parts.length === 4
    && parts.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    ? parts
    : null;
}

export function isPublicIpAddress(address) {
  const normalized = String(address || "")
    .trim()
    .replace(/^\[|\]$/gu, "")
    .split("%")[0]
    .toLowerCase();
  const family = net.isIP(normalized);
  if (family === 4) {
    const parts = ipv4Octets(normalized);
    if (!parts) return false;
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    if (normalized === "::" || normalized === "::1") return false;
    if (normalized.startsWith("::ffff:")) return false;
    if (/^(?:fc|fd)/u.test(normalized)) return false;
    if (/^fe[89ab]/u.test(normalized)) return false;
    if (normalized.startsWith("ff")) return false;
    if (normalized.startsWith("2001:db8")
      || normalized.startsWith("2001:0:")
      || normalized.startsWith("2001:2:")
      || normalized.startsWith("2001:10:")
      || normalized.startsWith("2001:20:")
      || normalized.startsWith("2002:")
      || normalized.startsWith("3fff:")) {
      return false;
    }
    const firstGroup = Number.parseInt(normalized.split(":")[0], 16);
    return Number.isFinite(firstGroup) && firstGroup >= 0x2000 && firstGroup <= 0x3fff;
  }
  return false;
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error("operation aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error("operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

export async function validatePublicHttpUrl(value, {
  resolveHostname = dnsLookup,
  signal,
} = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("media URL must be valid HTTP(S)");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("media URL must use HTTP(S)");
  }
  if (parsed.username || parsed.password) {
    throw new Error("media URL credentials are forbidden");
  }
  const hostname = parsed.hostname
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLowerCase();
  if (!hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home")
    || hostname.endsWith(".lan")
    || hostname.endsWith(".test")
    || hostname.endsWith(".invalid")) {
    throw new Error("media URL host must be public");
  }
  if (net.isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) throw new Error("media URL resolved to a non-public address");
    return parsed;
  }
  if (!hostname.includes(".")) throw new Error("media URL host must be a public DNS name");
  const resolved = await abortable(
    resolveHostname(hostname, { all: true, verbatim: true }),
    signal
  );
  const records = Array.isArray(resolved) ? resolved : [resolved];
  const addresses = records
    .map(record => typeof record === "string" ? record : record?.address)
    .filter(Boolean);
  if (!addresses.length || addresses.some(address => !isPublicIpAddress(address))) {
    throw new Error("media URL resolved to a non-public address");
  }
  return parsed;
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Best-effort response cleanup.
  }
}

async function fetchPublicResponse(initialUrl, {
  fetchImpl,
  resolveHostname,
  signal,
  allowCrossHostRedirects,
  maxRedirects,
}) {
  let current = await validatePublicHttpUrl(initialUrl, { resolveHostname, signal });
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await fetchImpl(current.href, {
      headers: {
        "user-agent": "Mozilla/5.0",
        referer: "https://www.douyin.com/",
      },
      redirect: "manual",
      signal,
    });
    const responseUrl = await validatePublicHttpUrl(
      response.url || current.href,
      { resolveHostname, signal }
    );
    if (!allowCrossHostRedirects
      && responseUrl.hostname.toLowerCase() !== current.hostname.toLowerCase()) {
      await cancelResponseBody(response);
      throw new Error("cross-host media redirects are forbidden");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.("location");
      await cancelResponseBody(response);
      if (!location) throw new Error("media redirect did not provide a location");
      if (redirectCount >= maxRedirects) throw new Error("media redirect limit exceeded");
      const next = await validatePublicHttpUrl(
        new URL(location, current).href,
        { resolveHostname, signal }
      );
      if (!allowCrossHostRedirects
        && next.hostname.toLowerCase() !== current.hostname.toLowerCase()) {
        throw new Error("cross-host media redirects are forbidden");
      }
      current = next;
      continue;
    }
    return response;
  }
  throw new Error("media redirect limit exceeded");
}

async function* responseChunks(body) {
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) yield chunk;
    return;
  }
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  throw new Error("media response body is not streamable");
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!(result.bytesWritten > 0)) throw new Error("media stream write made no progress");
    offset += result.bytesWritten;
  }
}

async function recoverPreviousTarget(target) {
  const backup = target + ".previous";
  if (fs.existsSync(target)) {
    await fsp.rm(backup, { force: true });
    return;
  }
  if (fs.existsSync(backup)) await fsp.rename(backup, target);
}

async function replaceCompletedDownload(temporary, target) {
  const backup = target + ".previous";
  await recoverPreviousTarget(target);
  const hadTarget = fs.existsSync(target);
  if (hadTarget) {
    await fsp.rm(backup, { force: true });
    await fsp.rename(target, backup);
  }
  try {
    await fsp.rename(temporary, target);
  } catch (error) {
    if (hadTarget && fs.existsSync(backup) && !fs.existsSync(target)) {
      await fsp.rename(backup, target);
    }
    throw error;
  }
  await fsp.rm(backup, { force: true });
}

export async function downloadFile(url, target, {
  fetchImpl = fetch,
  resolveHostname = dnsLookup,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  allowCrossHostRedirects = false,
} = {}) {
  const temporary = target + ".part";
  await fsp.rm(temporary, { force: true });
  await recoverPreviousTarget(target);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error("media download timed out"));
  }, timeoutMs);
  let handle = null;
  try {
    if (!Number.isFinite(maxBytes) || maxBytes < 1024) {
      throw new Error("maxBytes must be at least 1024");
    }
    const response = await fetchPublicResponse(url, {
      fetchImpl,
      resolveHostname,
      signal: controller.signal,
      allowCrossHostRedirects,
      maxRedirects,
    });
    if (!response.ok) throw new Error("media download failed with HTTP " + response.status);
    const declaredBytes = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await cancelResponseBody(response);
      throw new Error("media download exceeds the maximum byte limit");
    }
    handle = await fsp.open(temporary, "wx");
    let receivedBytes = 0;
    for await (const chunk of responseChunks(response.body)) {
      if (controller.signal.aborted) throw controller.signal.reason;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > maxBytes) {
        await cancelResponseBody(response);
        throw new Error("media download exceeds the maximum byte limit");
      }
      await writeAll(handle, buffer);
    }
    await handle.sync();
    await handle.close();
    handle = null;
    if (receivedBytes < 1024) throw new Error("downloaded media is unexpectedly small");
    await replaceCompletedDownload(temporary, target);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("media download timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(temporary, { force: true });
  }
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export async function probeMedia(file) {
  const result = await run("ffprobe", [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    file,
  ], { timeoutMs: 120000 });
  const data = JSON.parse(result.stdout.replace(/^\uFEFF/u, ""));
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find(stream => stream.codec_type === "video");
  const audio = streams.find(stream => stream.codec_type === "audio");
  const durationSeconds = finiteNumber(data.format?.duration, 0);
  return {
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    durationSeconds,
    videoStartSeconds: finiteNumber(video?.start_time, 0),
    audioStartSeconds: finiteNumber(audio?.start_time, 0),
    videoDurationSeconds: finiteNumber(video?.duration, durationSeconds),
    audioDurationSeconds: finiteNumber(audio?.duration, durationSeconds),
  };
}

export function validateCompleteMediaProbe(probe, expectedDurationSeconds = 0) {
  const reasons = [];
  const duration = finiteNumber(probe?.durationSeconds, 0);
  const videoStart = finiteNumber(probe?.videoStartSeconds, 0);
  const audioStart = finiteNumber(probe?.audioStartSeconds, 0);
  const videoDuration = finiteNumber(probe?.videoDurationSeconds, duration);
  const audioDuration = finiteNumber(probe?.audioDurationSeconds, duration);
  if (probe?.hasVideo !== true) reasons.push("video-stream-missing");
  if (probe?.hasAudio !== true) reasons.push("audio-stream-missing");
  if (!(duration > 0)) reasons.push("duration-missing");
  if (Math.abs(videoStart) > 0.5 || Math.abs(audioStart) > 0.5) {
    reasons.push("stream-start-not-near-zero");
  }
  if (Math.abs(videoStart - audioStart) > 0.25) reasons.push("stream-start-mismatch");
  const streamDurationTolerance = Math.max(0.75, duration * 0.03);
  if (Math.abs(videoDuration - audioDuration) > streamDurationTolerance) {
    reasons.push("stream-duration-mismatch");
  }
  const expected = finiteNumber(expectedDurationSeconds, 0);
  if (expected > 0 && Math.abs(duration - expected) > Math.max(1.5, expected * 0.05)) {
    reasons.push("page-duration-mismatch");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    durationSeconds: duration,
  };
}

function uniqueHttp(values) {
  return [...new Set((values || []).map(value => String(value || "").trim()))]
    .filter(value => /^https?:\/\//iu.test(value));
}

export function classifyBrowserMediaCandidates({ primarySrc = "", resources = [] } = {}) {
  const candidates = uniqueHttp([primarySrc, ...resources]);
  const looksAudio = value => /(?:mime_type=audio|audio_mp4|\baudio\b|\.m4a(?:\?|$)|\.aac(?:\?|$))/iu.test(value);
  const looksVideo = value => /(?:mime_type=video|video_mp4|\bvideo\b|\.mp4(?:\?|$)|\.m4s(?:\?|$))/iu.test(value);
  return {
    primary: /^https?:\/\//iu.test(primarySrc) ? primarySrc : "",
    audio: candidates.filter(looksAudio),
    video: candidates.filter(looksVideo),
    all: candidates,
  };
}

export function browserMediaPlan(input = {}) {
  const candidates = classifyBrowserMediaCandidates(input);
  if (candidates.primary) {
    return {
      allowed: true,
      mediaMode: "progressive",
      candidate: candidates.primary,
      reason: null,
    };
  }
  const adaptiveEvidence = candidates.audio.length > 0
    || candidates.video.length > 0
    || candidates.all.length > 0;
  return {
    allowed: false,
    mediaMode: adaptiveEvidence ? "unsafe-adaptive" : "unresolved",
    candidate: null,
    reason: adaptiveEvidence
      ? "automatic adaptive stream pairing is disabled; use controlled browser manual freeze"
      : "public video page exposed no complete progressive media source",
  };
}

function browserProbeJavascript() {
  return `(() => {
    const authorHref = [...document.querySelectorAll('a[href*="/user/"]')]
      .map(node => String(node.href || ''))
      .find(value => /\\/user\\/MS4wLjAB[A-Za-z0-9_-]+/.test(value)) || '';
    const videos = [...document.querySelectorAll('video')]
      .map(video => {
        const rect = video.getBoundingClientRect();
        return {
          src: String(video.currentSrc || video.src || ''),
          duration: Number.isFinite(video.duration) ? Number(video.duration) : 0,
          pixels: Number(video.videoWidth || 0) * Number(video.videoHeight || 0),
          visibleArea: Math.max(0, rect.width) * Math.max(0, rect.height),
        };
      })
      .filter(item => /^https?:\\/\\//i.test(item.src))
      .sort((a, b) => b.visibleArea - a.visibleArea || b.pixels - a.pixels || b.duration - a.duration);
    const resources = performance.getEntriesByType('resource')
      .map(entry => String(entry.name || ''))
      .filter(value => /^https?:\\/\\//i.test(value))
      .filter(value => /(?:video|audio|\\.mp4|\\.m4s|mime_type=video|mime_type=audio)/i.test(value));
    return {
      pathname: location.pathname,
      title: String(document.title || '').slice(0, 500),
      authorHref,
      primarySrc: videos[0]?.src || '',
      durationSeconds: videos[0]?.duration || 0,
      resources: [...new Set(resources)].slice(-80),
    };
  })()`;
}

async function browserFallback({ profile, url, videoId, outputDir, mediaFile }) {
  const session = "koubo-reference-" + videoId + "-" + crypto.randomUUID().slice(0, 8);
  const primaryFile = path.join(outputDir, videoId + ".browser-primary.mp4");
  const legacyCompanionFile = path.join(outputDir, videoId + ".browser-companion.mp4");
  const legacyMergedFile = mediaFile + ".merge.mp4";
  try {
    await opencliBrowser(profile, session, ["open", url], { timeoutMs: 120000 });
    await opencliBrowser(profile, session, ["wait", "time", "8"], { timeoutMs: 30000 });
    const encoded = Buffer.from(browserProbeJavascript(), "utf8").toString("base64");
    const probeText = await opencliBrowser(
      profile,
      session,
      ["eval", "eval(atob('" + encoded + "'))"]
    );
    const page = JSON.parse(probeText);
    if (!String(page.pathname || "").includes(videoId)) {
      throw new Error("browser fallback did not remain on the requested public video page");
    }
    const plan = browserMediaPlan(page);
    if (!plan.allowed) throw new Error(plan.reason);
    await downloadFile(plan.candidate, primaryFile);
    const primaryProbe = await probeMedia(primaryFile);
    const completeness = validateCompleteMediaProbe(primaryProbe, page.durationSeconds);
    if (!completeness.ok) {
      throw new Error(
        "public progressive media was incomplete; use controlled browser manual freeze"
      );
    }
    await fsp.rm(mediaFile, { force: true });
    await fsp.rename(primaryFile, mediaFile);
    return {
      page: {
        pathname: String(page.pathname || ""),
        title: String(page.title || ""),
        authorHref: String(page.authorHref || ""),
        durationSeconds: finiteNumber(page.durationSeconds, primaryProbe.durationSeconds),
      },
      mediaProbe: primaryProbe,
      mediaMode: "progressive",
    };
  } finally {
    await fsp.rm(primaryFile, { force: true });
    await fsp.rm(primaryFile + ".part", { force: true });
    await fsp.rm(legacyCompanionFile, { force: true });
    await fsp.rm(legacyCompanionFile + ".part", { force: true });
    await fsp.rm(legacyMergedFile, { force: true });
    await fsp.rm(legacyMergedFile + ".part", { force: true });
    try {
      await opencliBrowser(profile, session, ["close"], { timeoutMs: 30000 });
    } catch {
      // The browser lease is best-effort cleanup; no signed URL or session data is persisted.
    }
  }
}

function containsSensitiveMetadataKey(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) {
    const found = value.some(item => containsSensitiveMetadataKey(item, seen));
    seen.delete(value);
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key
      .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
      .replace(/[^A-Za-z0-9]+/gu, "_")
      .toLowerCase();
    const allowedSafetyMarker = normalized === "signed_play_url_persisted"
      || normalized === "raw_page_persisted";
    if (!allowedSafetyMarker && SENSITIVE_KEY_PATTERN.test(normalized)) {
      seen.delete(value);
      return true;
    }
    if (containsSensitiveMetadataKey(item, seen)) {
      seen.delete(value);
      return true;
    }
  }
  seen.delete(value);
  return false;
}

function publicMetadata(metadata) {
  return {
    schemaVersion: 1,
    platform: "douyin",
    videoId: String(metadata.videoId || ""),
    url: String(metadata.url || ""),
    author: sanitizeFreeText(metadata.author, 200),
    accountSecUid: String(metadata.accountSecUid || ""),
    title: sanitizeFreeText(metadata.title, 1000),
    durationSeconds: finiteNumber(metadata.durationSeconds, 0),
    visibleMetrics: {
      likes: metadata.visibleMetrics?.likes !== null
        && metadata.visibleMetrics?.likes !== undefined
        && Number.isFinite(Number(metadata.visibleMetrics.likes))
        ? Number(metadata.visibleMetrics.likes)
        : null,
    },
    topComments: Array.isArray(metadata.topComments)
      ? metadata.topComments.slice(0, 5).map(comment => ({
        text: sanitizeFreeText(comment?.text, 500),
        likes: Number.isFinite(Number(comment?.likes)) ? Number(comment.likes) : 0,
      }))
      : [],
    accessedAt: String(metadata.accessedAt || ""),
    mediaRetrievalStartedAt: String(metadata.mediaRetrievalStartedAt || ""),
    mediaSha256: String(metadata.mediaSha256 || "").toLowerCase(),
    mediaBytes: Number(metadata.mediaBytes || 0),
    retrievalMethod: String(metadata.retrievalMethod || ""),
    mediaMode: String(metadata.mediaMode || ""),
    fallbackReasons: Array.isArray(metadata.fallbackReasons)
      ? [...new Set(metadata.fallbackReasons
        .map(value => sanitizeFreeText(value, 120))
        .filter(value => /^[a-z0-9-]+$/u.test(value)))]
      : [],
    commentsRequested: metadata.commentsRequested === true,
    usageBoundary: sanitizeFreeText(metadata.usageBoundary, 300),
    rawPagePersisted: false,
    signedPlayUrlPersisted: false,
  };
}

export function validateResumeMetadata(existing, {
  videoId,
  canonicalUrl,
  boundary,
  actualSha256,
  actualBytes,
  mediaProbe,
  mediaFile,
  metadataFile,
} = {}) {
  if (!existing || typeof existing !== "object" || containsSensitiveMetadataKey(existing)) {
    return null;
  }
  const normalized = publicMetadata(existing);
  if (existing.schemaVersion !== 1
    || existing.platform !== "douyin"
    || normalized.videoId !== videoId
    || normalized.url !== canonicalUrl
    || normalized.usageBoundary !== boundary
    || existing.rawPagePersisted !== false
    || existing.signedPlayUrlPersisted !== false
    || !SAFE_RESUME_RETRIEVAL_METHODS.has(normalized.retrievalMethod)
    || !SAFE_MEDIA_MODES.has(normalized.mediaMode)
    || !/^[a-f0-9]{64}$/u.test(normalized.mediaSha256)
    || normalized.mediaSha256 !== String(actualSha256 || "").toLowerCase()) {
    return null;
  }
  const completeness = validateCompleteMediaProbe(mediaProbe, normalized.durationSeconds);
  if (!completeness.ok) return null;
  return {
    ...normalized,
    mediaBytes: Number(actualBytes || normalized.mediaBytes || 0),
    mediaFile,
    metadataFile,
    resumed: true,
  };
}

async function validResumePayload({
  mediaFile,
  metadataFile,
  videoId,
  canonicalUrl,
  boundary,
}) {
  try {
    const existing = JSON.parse(
      fs.readFileSync(metadataFile, "utf8").replace(/^\uFEFF/u, "")
    );
    const actualSha256 = sha256File(mediaFile);
    const mediaProbe = await probeMedia(mediaFile);
    return validateResumeMetadata(existing, {
      videoId,
      canonicalUrl,
      boundary,
      actualSha256,
      actualBytes: fs.statSync(mediaFile).size,
      mediaProbe,
      mediaFile,
      metadataFile,
    });
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file, value) {
  const temporary = file + ".part";
  await fsp.rm(temporary, { force: true });
  try {
    await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
    await fsp.rm(file, { force: true });
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

async function fetchUserVideos(profile, secUid, withComments) {
  const feedText = await opencli(profile, "douyin", [
    "user-videos",
    secUid,
    "--limit", "20",
    "--with_comments", String(withComments),
    "--comment_limit", withComments ? "5" : "0",
  ]);
  const parsed = JSON.parse(feedText);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.data)) return parsed.data;
  throw new Error("user-videos response did not contain an item array");
}

export async function fetchUserVideosWithFallback({
  profile,
  secUid,
  withComments,
  fetchFeed = fetchUserVideos,
} = {}) {
  try {
    return {
      feed: await fetchFeed(profile, secUid, withComments),
      fallbackReasons: [],
      failed: false,
    };
  } catch {
    if (!withComments) {
      return {
        feed: null,
        fallbackReasons: ["user-videos-feed-failed"],
        failed: true,
      };
    }
    try {
      return {
        feed: await fetchFeed(profile, secUid, false),
        fallbackReasons: ["comments-query-failed-retried-without-comments"],
        failed: false,
      };
    } catch {
      return {
        feed: null,
        fallbackReasons: [
          "comments-query-failed-retried-without-comments",
          "user-videos-feed-failed",
        ],
        failed: true,
      };
    }
  }
}

export async function tryUserVideosMedia({
  item,
  mediaFile,
  download = downloadFile,
  probe = probeMedia,
  remove = file => fsp.rm(file, { force: true }),
} = {}) {
  if (!item?.play_url) {
    return {
      mediaProbe: null,
      mediaMode: null,
      fallbackReason: null,
    };
  }
  try {
    await download(item.play_url, mediaFile);
    const mediaProbe = await probe(mediaFile);
    const completeness = validateCompleteMediaProbe(mediaProbe, item.duration);
    if (!completeness.ok) throw new Error("user-videos media was incomplete");
    return {
      mediaProbe,
      mediaMode: "progressive",
      fallbackReason: null,
    };
  } catch {
    await remove(mediaFile);
    await remove(mediaFile + ".part");
    return {
      mediaProbe: null,
      mediaMode: null,
      fallbackReason: "user-videos-play-url-failed-or-incomplete",
    };
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const outputDir = path.resolve(args["output-dir"]);
  await fsp.mkdir(outputDir, { recursive: true });
  const mediaFile = path.join(outputDir, args.videoId + ".mp4");
  const metadataFile = path.join(outputDir, args.videoId + ".source.json");

  if (fs.existsSync(mediaFile) && fs.existsSync(metadataFile)) {
    const resumed = await validResumePayload({
      mediaFile,
      metadataFile,
      videoId: args.videoId,
      canonicalUrl: args.url,
      boundary: String(args.boundary).trim(),
    });
    if (resumed) {
      process.stdout.write(JSON.stringify(resumed, null, 2) + "\n");
      return;
    }
  }
  await fsp.rm(mediaFile, { force: true });
  await fsp.rm(mediaFile + ".part", { force: true });
  await fsp.rm(mediaFile + ".merge.mp4", { force: true });
  await fsp.rm(metadataFile, { force: true });
  await fsp.rm(metadataFile + ".part", { force: true });

  const accessedAt = new Date().toISOString();
  const fallbackReasons = [];
  let pageText = "";
  let pageReadFailed = false;
  try {
    pageText = await opencli(args.profile, "web", [
      "read",
      "--url", args.url,
      "--stdout", "true",
      "--download-images", "false",
      "--wait", "5",
    ], { format: "plain" });
  } catch {
    pageReadFailed = true;
    fallbackReasons.push("public-page-reader-failed");
  }
  let secUid = firstAuthorSecUid(pageText);
  let item = null;
  if (secUid) {
    const feedResult = await fetchUserVideosWithFallback({
      profile: args.profile,
      secUid,
      withComments: args.withComments,
    });
    fallbackReasons.push(...feedResult.fallbackReasons);
    item = feedResult.feed
      ?.find(candidate => String(candidate.aweme_id) === args.videoId) || null;
  } else {
    fallbackReasons.push("public-page-reader-did-not-resolve-author");
  }
  if (!item) fallbackReasons.push("target-not-found-in-latest-20-or-feed-unavailable");
  else if (!item.play_url) fallbackReasons.push("user-videos-play-url-missing");

  const mediaRetrievalStartedAt = new Date().toISOString();
  let retrievalMethod = "user-videos";
  let mediaMode = "progressive";
  let mediaProbe = null;
  let browserPage = null;
  if (item?.play_url) {
    const attempt = await tryUserVideosMedia({ item, mediaFile });
    mediaProbe = attempt.mediaProbe;
    mediaMode = attempt.mediaMode || mediaMode;
    if (attempt.fallbackReason) fallbackReasons.push(attempt.fallbackReason);
  }
  if (!mediaProbe) {
    retrievalMethod = "public-video-page-fallback";
    const fallback = await browserFallback({
      profile: args.profile,
      url: args.url,
      videoId: args.videoId,
      outputDir,
      mediaFile,
    });
    browserPage = fallback.page;
    mediaProbe = fallback.mediaProbe;
    mediaMode = fallback.mediaMode;
    const browserSecUid = firstAuthorSecUid(String(browserPage.authorHref || ""));
    if (browserSecUid) secUid = browserSecUid;
  }
  if (!secUid) throw new Error("could not resolve the public author sec_uid from the target video page");
  const finalCompleteness = validateCompleteMediaProbe(
    mediaProbe,
    item?.duration || browserPage?.durationSeconds || 0
  );
  if (!finalCompleteness.ok) {
    throw new Error("frozen reference media failed complete audio/video validation");
  }
  const metadata = publicMetadata({
    schemaVersion: 1,
    platform: "douyin",
    videoId: args.videoId,
    url: args.url,
    author: String(args.author).trim(),
    accountSecUid: secUid,
    title: String(item?.title || browserPage?.title || "").trim(),
    durationSeconds: mediaProbe.durationSeconds,
    visibleMetrics: { likes: item ? finiteNumber(item.digg_count, null) : null },
    topComments: Array.isArray(item?.top_comments)
      ? item.top_comments.map(comment => ({
        text: String(comment?.text || "").trim().slice(0, 500),
        likes: Number(comment?.digg_count || 0),
      }))
      : [],
    accessedAt,
    mediaRetrievalStartedAt,
    mediaSha256: sha256File(mediaFile),
    mediaBytes: fs.statSync(mediaFile).size,
    retrievalMethod,
    mediaMode,
    fallbackReasons: [...new Set(fallbackReasons)],
    commentsRequested: args.withComments,
    usageBoundary: String(args.boundary).trim(),
    rawPagePersisted: false,
    signedPlayUrlPersisted: false,
  });
  await writeJsonAtomic(metadataFile, metadata);
  process.stdout.write(JSON.stringify({
    ...metadata,
    mediaFile,
    metadataFile,
    resumed: false,
  }, null, 2) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(redactSensitiveOutput(String(error?.message || error)) + "\n");
    process.exitCode = 1;
  });
}
