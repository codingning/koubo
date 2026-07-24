import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  browserMediaPlan,
  canonicalDouyinVideoUrl,
  classifyBrowserMediaCandidates,
  downloadFile,
  fetchUserVideosWithFallback,
  firstAuthorSecUid,
  isPublicIpAddress,
  opencliArgs,
  parseArguments as parseFetchArguments,
  redactSensitiveOutput,
  resolveOpencliInvocation,
  run,
  sanitizeFreeText,
  tryUserVideosMedia,
  validateCompleteMediaProbe,
  validatePublicHttpUrl,
  validateResumeMetadata,
} from "../scripts/fetch_douyin_reference.mjs";
import {
  parseArguments as parseTranscriptionArguments,
} from "../scripts/transcribe_reference.mjs";

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-reference-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function completeProbe(overrides = {}) {
  return {
    hasVideo: true,
    hasAudio: true,
    durationSeconds: 42,
    videoStartSeconds: 0,
    audioStartSeconds: 0,
    videoDurationSeconds: 42,
    audioDurationSeconds: 42,
    ...overrides,
  };
}

async function publicDns() {
  return [{ address: "93.184.216.34", family: 4 }];
}

function headers(values = {}) {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)])
  );
  return {
    get(name) {
      return normalized[String(name).toLowerCase()] ?? null;
    },
  };
}

function streamedResponse({
  url = "https://cdn.example/reference.mp4",
  status = 200,
  chunks = [],
  responseHeaders = {},
} = {}) {
  return {
    url,
    status,
    ok: status >= 200 && status < 300,
    headers: headers(responseHeaders),
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
      async cancel() {},
    },
  };
}

test("fetch arguments retain only the canonical public Douyin identity", () => {
  const values = parseFetchArguments([
    "--url", "https://cdn.example/media/7624469060838853914.mp4?msToken=secret&a_bogus=secret",
    "--author", "Example",
    "--output-dir", "C:\\Temp\\koubo-reference",
    "--profile", "browser-profile",
  ]);
  assert.equal(values.videoId, "7624469060838853914");
  assert.equal(values.url, canonicalDouyinVideoUrl(values.videoId));
  assert.equal(values.url, "https://www.douyin.com/video/7624469060838853914");
  assert.equal(values.url.includes("cdn.example"), false);
  assert.equal(values.url.includes("msToken"), false);
  assert.equal(values.author, "Example");
  assert.equal(values.profile, "browser-profile");
  assert.equal(values.boundary, "public-reference-research-only-no-redistribution");
  assert.equal(values.withComments, false);
});

test("fetch comments are opt-in because comment failures must not block media research", () => {
  const values = parseFetchArguments([
    "--video-id", "7624469060838853914",
    "--author", "Example",
    "--output-dir", "C:\\Temp\\koubo-reference",
    "--with-comments", "true",
  ]);
  assert.equal(values.withComments, true);
});

test("comment retrieval failure retries the latest feed without comments", async () => {
  const calls = [];
  const result = await fetchUserVideosWithFallback({
    profile: "profile-a",
    secUid: "MS4wLjABAAAAfixture",
    withComments: true,
    fetchFeed: async (profile, secUid, withComments) => {
      calls.push({ profile, secUid, withComments });
      if (withComments) throw new Error("comment detached");
      return [{ aweme_id: "7624469060838853914" }];
    },
  });
  assert.equal(result.failed, false);
  assert.equal(result.feed.length, 1);
  assert.deepEqual(result.fallbackReasons, [
    "comments-query-failed-retried-without-comments",
  ]);
  assert.deepEqual(calls.map(item => item.withComments), [true, false]);
});

test("Windows OpenCLI resolution runs the Node entry without cmd parsing ampersands", async t => {
  const root = fixtureRoot(t);
  const bin = path.join(root, "bin");
  const entry = path.join(
    bin,
    "node_modules",
    "@jackwener",
    "opencli",
    "dist",
    "src",
    "main.js"
  );
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(bin, "opencli.cmd"), "@echo off\r\n", "utf8");
  fs.writeFileSync(
    entry,
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
    "utf8"
  );

  const invocation = resolveOpencliInvocation({
    platform: "win32",
    environment: { PATH: bin },
    nodeExecutable: process.execPath,
  });
  assert.notEqual(path.basename(invocation.command).toLowerCase(), "cmd.exe");
  assert.deepEqual(invocation.prefix, [entry]);

  const argument = "SAFE_A=1&SAFE_B=2";
  const result = await run(
    invocation.command,
    [...invocation.prefix, argument],
    { environment: invocation.environment }
  );
  assert.deepEqual(JSON.parse(result.stdout), [argument]);
});

test("public page parsing ignores self navigation and selects the first public creator sec_uid", () => {
  const page = [
    "https://www.douyin.com/user/self",
    "https://www.douyin.com/user/MS4wLjABAAAAfirst_creator-123",
    "https://www.douyin.com/user/MS4wLjABAAAAsecond_creator-456",
  ].join("\n");
  assert.equal(firstAuthorSecUid(page), "MS4wLjABAAAAfirst_creator-123");
});

test("OpenCLI arguments isolate the browser session and keep raw page output out of storage", () => {
  assert.deepEqual(
    opencliArgs("profile-a", "web", ["read", "--url", "https://example.com", "--stdout", "true"], "plain"),
    [
      "--profile", "profile-a",
      "web", "read", "--url", "https://example.com", "--stdout", "true",
      "--window", "background",
      "--site-session", "ephemeral",
      "--keep-tab", "false",
      "-f", "plain",
    ]
  );
});

test("browser fallback allows complete progressive media and rejects unsafe adaptive pairing", () => {
  const progressive = browserMediaPlan({
    primarySrc: "https://cdn.example/video.mp4?token=secret",
    resources: [],
  });
  assert.equal(progressive.allowed, true);
  assert.equal(progressive.mediaMode, "progressive");

  const adaptive = browserMediaPlan({
    primarySrc: "blob:https://www.douyin.com/not-persisted",
    resources: [
      "https://cdn.example/video.m4s?token=secret",
      "https://cdn.example/audio.m4a?msToken=secret",
    ],
  });
  assert.equal(adaptive.allowed, false);
  assert.equal(adaptive.mediaMode, "unsafe-adaptive");
  assert.equal(adaptive.candidate, null);
  assert.match(adaptive.reason, /controlled browser manual freeze/i);
  assert.equal(/https?:\/\//u.test(adaptive.reason), false);

  const classified = classifyBrowserMediaCandidates({
    primarySrc: "",
    resources: [
      "https://cdn.example/video.m4s",
      "https://cdn.example/audio.m4a",
    ],
  });
  assert.equal(classified.video.length, 1);
  assert.equal(classified.audio.length, 1);
});

test("complete progressive validation checks both streams, start time, and duration", () => {
  assert.equal(validateCompleteMediaProbe(completeProbe(), 42).ok, true);
  assert.equal(
    validateCompleteMediaProbe(completeProbe({ hasAudio: false }), 42).ok,
    false
  );
  assert.equal(
    validateCompleteMediaProbe(completeProbe({ audioStartSeconds: 0.5 }), 42).ok,
    false
  );
  assert.equal(
    validateCompleteMediaProbe(completeProbe({ audioDurationSeconds: 30 }), 42).ok,
    false
  );
  assert.equal(
    validateCompleteMediaProbe(completeProbe({ durationSeconds: 20 }), 42).ok,
    false
  );
});

test("failed downloads clean part files and preserve the previous target", async t => {
  const root = fixtureRoot(t);
  const target = path.join(root, "reference.mp4");
  const original = Buffer.alloc(2048, 7);
  fs.writeFileSync(target, original);
  const originalHash = sha256(original);

  await assert.rejects(
    () => downloadFile("https://cdn.example/reference.mp4", target, {
      resolveHostname: publicDns,
      fetchImpl: async () => streamedResponse({
        chunks: [Buffer.alloc(12, 1)],
      }),
    }),
    /unexpectedly small/i
  );
  assert.equal(fs.existsSync(target + ".part"), false);
  assert.equal(sha256(fs.readFileSync(target)), originalHash);
});

test("download policy rejects loopback, private DNS, and metadata final URLs", async t => {
  const root = fixtureRoot(t);
  const target = path.join(root, "reference.mp4");
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return streamedResponse({ chunks: [Buffer.alloc(2048, 1)] });
  };
  const publicUrl = await validatePublicHttpUrl(
    "https://cdn.example/reference.mp4",
    { resolveHostname: publicDns }
  );
  assert.equal(publicUrl.hostname, "cdn.example");

  for (const url of [
    "http://127.0.0.1/reference.mp4",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/reference.mp4",
  ]) {
    await assert.rejects(
      () => downloadFile(url, target, { fetchImpl, resolveHostname: publicDns }),
      /non-public|public/i
    );
  }
  await assert.rejects(
    () => downloadFile("https://public-name.example/reference.mp4", target, {
      fetchImpl,
      resolveHostname: async () => [{ address: "10.20.30.40", family: 4 }],
    }),
    /non-public/i
  );
  assert.equal(fetchCalls, 0);

  await assert.rejects(
    () => downloadFile("https://cdn.example/reference.mp4", target, {
      resolveHostname: publicDns,
      fetchImpl: async () => streamedResponse({
        url: "http://169.254.169.254/latest/meta-data",
        chunks: [Buffer.alloc(2048, 1)],
      }),
    }),
    /non-public/i
  );
  assert.equal(fs.existsSync(target), false);
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("10.0.0.1"), false);
  assert.equal(isPublicIpAddress("2001:4860:4860::8888"), true);
  assert.equal(isPublicIpAddress("fe80::1"), false);
});

test("cross-host redirects are rejected before the redirected host is fetched", async t => {
  const root = fixtureRoot(t);
  const target = path.join(root, "reference.mp4");
  const calls = [];
  await assert.rejects(
    () => downloadFile("https://cdn.example/reference.mp4", target, {
      resolveHostname: publicDns,
      fetchImpl: async url => {
        calls.push(url);
        return streamedResponse({
          url,
          status: 302,
          responseHeaders: {
            location: "https://other.example/reference.mp4",
          },
        });
      },
    }),
    /cross-host/i
  );
  assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(target + ".part"), false);
});

test("streaming byte limits and timeouts preserve the previous target", async t => {
  const root = fixtureRoot(t);
  const target = path.join(root, "reference.mp4");
  const original = Buffer.alloc(2048, 4);
  fs.writeFileSync(target, original);
  const originalHash = sha256(original);

  await assert.rejects(
    () => downloadFile("https://cdn.example/reference.mp4", target, {
      resolveHostname: publicDns,
      maxBytes: 1024,
      fetchImpl: async () => streamedResponse({
        chunks: [Buffer.alloc(700, 1), Buffer.alloc(700, 2)],
      }),
    }),
    /maximum byte limit/i
  );
  assert.equal(sha256(fs.readFileSync(target)), originalHash);
  assert.equal(fs.existsSync(target + ".part"), false);
  assert.equal(fs.existsSync(target + ".previous"), false);

  await assert.rejects(
    () => downloadFile("https://cdn.example/reference.mp4", target, {
      resolveHostname: publicDns,
      timeoutMs: 20,
      fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(signal.reason || new Error("aborted")),
          { once: true }
        );
      }),
    }),
    /timed out/i
  );
  assert.equal(sha256(fs.readFileSync(target)), originalHash);
  assert.equal(fs.existsSync(target + ".part"), false);
  assert.equal(fs.existsSync(target + ".previous"), false);
});

test("successful streaming replacement removes temporary and backup files", async t => {
  const root = fixtureRoot(t);
  const target = path.join(root, "reference.mp4");
  fs.writeFileSync(target, Buffer.alloc(2048, 4));
  const replacement = Buffer.alloc(3072, 9);
  await downloadFile("https://cdn.example/reference.mp4", target, {
    resolveHostname: publicDns,
    maxBytes: 4096,
    fetchImpl: async () => streamedResponse({
      chunks: [replacement.subarray(0, 1000), replacement.subarray(1000)],
      responseHeaders: { "content-length": replacement.length },
    }),
  });
  assert.equal(sha256(fs.readFileSync(target)), sha256(replacement));
  assert.equal(fs.existsSync(target + ".part"), false);
  assert.equal(fs.existsSync(target + ".previous"), false);
});

test("an expired or incomplete user-videos URL requests the public page fallback", async t => {
  const root = fixtureRoot(t);
  const mediaFile = path.join(root, "reference.mp4");
  fs.writeFileSync(mediaFile, Buffer.alloc(2048, 3));
  fs.writeFileSync(mediaFile + ".part", Buffer.alloc(12, 1));

  const result = await tryUserVideosMedia({
    item: {
      play_url: "https://cdn.example/expired.mp4?msToken=secret",
      duration: 42,
    },
    mediaFile,
    download: async () => {
      throw new Error("HTTP 403");
    },
  });
  assert.equal(result.mediaProbe, null);
  assert.equal(result.mediaMode, null);
  assert.equal(
    result.fallbackReason,
    "user-videos-play-url-failed-or-incomplete"
  );
  assert.equal(fs.existsSync(mediaFile), false);
  assert.equal(fs.existsSync(mediaFile + ".part"), false);
});

test("resume validation rechecks the whitelist, boundary, hash, and complete probe", () => {
  const videoId = "7624469060838853914";
  const canonicalUrl = canonicalDouyinVideoUrl(videoId);
  const mediaSha256 = "a".repeat(64);
  const existing = {
    schemaVersion: 1,
    platform: "douyin",
    videoId,
    url: canonicalUrl,
    author: "Example",
    accountSecUid: "MS4wLjABAAAAfixture",
    title: "Fixture https://cdn.example/title Cookie: sessionid=TITLE_SECRET",
    durationSeconds: 42,
    visibleMetrics: { likes: null },
    topComments: [{
      text: "Comment https://cdn.example/comment authToken=COMMENT_SECRET",
      likes: 3,
    }],
    accessedAt: "2026-07-24T00:00:00.000Z",
    mediaRetrievalStartedAt: "2026-07-24T00:00:01.000Z",
    mediaSha256,
    mediaBytes: 2000,
    retrievalMethod: "public-video-page-fallback",
    mediaMode: "progressive",
    fallbackReasons: ["target-not-found-in-latest-20-or-feed-unavailable"],
    commentsRequested: false,
    usageBoundary: "public-reference-research-only-no-redistribution",
    rawPagePersisted: false,
    signedPlayUrlPersisted: false,
    harmlessExtra: "must-not-be-returned",
  };
  const options = {
    videoId,
    canonicalUrl,
    boundary: existing.usageBoundary,
    actualSha256: mediaSha256,
    actualBytes: 2048,
    mediaProbe: completeProbe(),
    mediaFile: "fixture.mp4",
    metadataFile: "fixture.source.json",
  };

  const resumed = validateResumeMetadata(existing, options);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.url, canonicalUrl);
  assert.equal(resumed.mediaBytes, 2048);
  assert.equal("harmlessExtra" in resumed, false);
  assert.equal(resumed.title.includes("cdn.example"), false);
  assert.equal(resumed.title.includes("TITLE_SECRET"), false);
  assert.equal(resumed.topComments[0].text.includes("cdn.example"), false);
  assert.equal(resumed.topComments[0].text.includes("COMMENT_SECRET"), false);

  for (const sensitive of [
    { play_url: "https://cdn.example/video.mp4?msToken=secret" },
    { cookieHeader: "sessionid=secret" },
    { authToken: "secret" },
    { authorizationHeader: "Bearer secret" },
  ]) {
    assert.equal(validateResumeMetadata({
      ...existing,
      ...sensitive,
    }, options), null);
  }
  assert.equal(validateResumeMetadata(existing, {
    ...options,
    boundary: "different-boundary",
  }), null);
  assert.equal(validateResumeMetadata(existing, {
    ...options,
    actualSha256: "b".repeat(64),
  }), null);
  assert.equal(validateResumeMetadata(existing, {
    ...options,
    mediaProbe: completeProbe({ hasAudio: false }),
  }), null);
});

test("process errors redact raw and JSON-escaped URLs, cookies, and token keys", () => {
  const escapedUrl = "https://cdn.example/video.mp4?msToken=abc"
    .replaceAll("/", "\\/");
  const safe = redactSensitiveOutput(
    "failed https://cdn.example/video.mp4?msToken=abc&a_bogus=def "
      + escapedUrl
      + " Cookie: sessionid=FAKE_SESSION; ttwid=FAKE_TTWID "
      + "odin_tt=FAKE_ODIN authorization=FAKE_AUTH "
      + "cookieHeader=FAKE_COOKIE_HEADER authToken=FAKE_AUTH_TOKEN"
  );
  for (const secret of [
    "cdn.example",
    "abc",
    "def",
    "FAKE_SESSION",
    "FAKE_TTWID",
    "FAKE_ODIN",
    "FAKE_AUTH",
    "FAKE_COOKIE_HEADER",
    "FAKE_AUTH_TOKEN",
  ]) {
    assert.equal(safe.includes(secret), false, secret);
  }
  assert.match(safe, /\[redacted-url\]/);
});

test("free text sanitization removes URLs, Cookie headers, and token signatures", () => {
  const safe = sanitizeFreeText(
    "Title https://cdn.example/video.mp4?signature=SECRET_URL "
      + "Cookie: sessionid=SECRET_COOKIE authToken=SECRET_AUTH"
  );
  assert.equal(safe.includes("cdn.example"), false);
  assert.equal(safe.includes("SECRET_URL"), false);
  assert.equal(safe.includes("SECRET_COOKIE"), false);
  assert.equal(safe.includes("SECRET_AUTH"), false);
  assert.match(safe, /\[redacted/);
});

test("transcription arguments default to the fixed local Chinese small model", () => {
  const values = parseTranscriptionArguments([
    "--input", "C:\\Temp\\source.mp4",
    "--output-dir", "C:\\Temp\\transcript",
  ]);
  assert.equal(values.model, "small");
  assert.equal(values.language, "zh");
});
