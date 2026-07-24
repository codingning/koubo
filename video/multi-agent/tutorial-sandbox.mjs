import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./contracts.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_PRIMITIVES = new Set([
  "caption-pop",
  "keyword-emphasis",
  "element-slide",
  "element-bounce",
  "sfx-cue",
  "voice-pause",
]);
const FORBIDDEN_PARAMETER_KEYS = new Set([
  "code",
  "css",
  "eval",
  "html",
  "javascript",
  "script",
  "src",
  "url",
]);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function assertSafeParameters(value, trail = []) {
  if (typeof value === "string" && /(?:https?:|data:|javascript:|file:|\\\\)/i.test(value)) {
    throw new Error(`external or executable parameter is forbidden: ${trail.join(".")}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeParameters(item, [...trail, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_PARAMETER_KEYS.has(key.toLowerCase())) {
      throw new Error(`source code and external asset parameters are forbidden: ${[...trail, key].join(".")}`);
    }
    assertSafeParameters(item, [...trail, key]);
  }
}

function recipeFor(technique) {
  const title = escapeHtml(technique.title || technique.primitive);
  const recipes = {
    "caption-pop": {
      label: "CAPTION / POP",
      markup: `<div id="subject" class="caption-chip">${title}</div>`,
      animation: `tl.from("#subject",{opacity:0,scale:.78,y:36,duration:.32,ease:"back.out(1.8)"},.25);`,
    },
    "keyword-emphasis": {
      label: "CAPTION / EMPHASIS",
      markup: `<div id="subject" class="sentence">Make the <strong>keyword</strong> visible.</div><div id="marker" class="marker"></div>`,
      animation: `tl.from("#subject",{opacity:0,y:28,duration:.46,ease:"power3.out"},.2);tl.from("#marker",{scaleX:0,duration:.38,ease:"expo.out"},.58);tl.from("#subject strong",{color:"#F7F9FC",duration:.28,ease:"power2.out"},.66);`,
    },
    "element-slide": {
      label: "MOTION / SLIDE",
      markup: `<div id="subject" class="evidence-card"><span>VERIFIED</span><strong>${title}</strong><small>Reveal after the claim</small></div>`,
      animation: `tl.from("#subject",{opacity:0,x:220,rotation:2,duration:.48,ease:"power4.out"},.25);`,
    },
    "element-bounce": {
      label: "MOTION / BOUNCE",
      markup: `<div id="subject" class="bounce-token">✓</div><div id="caption" class="mini-caption">${title}</div>`,
      animation: `tl.from("#subject",{opacity:0,scale:.28,y:90,duration:.58,ease:"bounce.out"},.22);tl.from("#caption",{opacity:0,y:24,duration:.36,ease:"power3.out"},.62);`,
    },
    "sfx-cue": {
      label: "SOUND / CUE",
      markup: `<div id="subject" class="sound-cue"><div class="wave"><i></i><i></i><i></i><i></i><i></i></div><strong>${title}</strong><small>one semantic beat</small></div>`,
      animation: `tl.from("#subject",{opacity:0,scale:.9,duration:.36,ease:"power3.out"},.25);tl.from(".wave i",{scaleY:.15,duration:.28,stagger:.055,ease:"back.out(2)"},.48);`,
      audio: true,
    },
    "voice-pause": {
      label: "VOICE / PAUSE",
      markup: `<div id="subject" class="pause-ring"><strong>0.6</strong><span>SECOND PAUSE</span></div><div id="pulse" class="pulse"></div>`,
      animation: `tl.from("#subject",{opacity:0,scale:.7,rotation:-12,duration:.5,ease:"power4.out"},.22);tl.from("#pulse",{opacity:0,scale:.4,duration:.75,ease:"sine.out"},.48);`,
    },
  };
  return recipes[technique.primitive];
}

function designDocument() {
  return `# Technique Reconstruction Lab

## Style Prompt

A controlled technical test bench derived from Koubo v4: dark neutral canvas,
warm orange for the tested behavior, cool blue for measurement, and amber for
timing. The tested primitive is the only expressive motion.

## Colors

- Background: #07090F
- Surface: #111621
- Primary: #FF6A3D
- Measurement: #55D6FF
- Timing: #FFD166
- Text: #F7F9FC

## Typography

- Display and body: Microsoft YaHei UI, 900 / 350
- Measurements: Cascadia Mono, 700

## Motion

- One 0.28–0.58 second entrance demonstrating the primitive.
- Paused, synchronously registered GSAP timeline.
- No ambient or decorative motion that could hide the tested behavior.

## What NOT to Do

- No network assets or tutorial-provided source code.
- No gradients used as decoration or generic neon glow.
- No motion outside the allowlisted primitive.
- No text below 24 px and no content outside the 8% safe area.
`;
}

function compositionHtml(technique, recipe) {
  const audio = recipe.audio
    ? `<audio id="cue-audio" data-start="0.48" data-duration="0.35" data-track-index="1" data-volume="1" src="assets/cue.wav" preload="auto"></audio>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=1080,height=1920">
  <script src="assets/gsap.min.js"></script>
  <style>
    @font-face{font-family:"Microsoft YaHei UI";src:local("Microsoft YaHei UI");font-weight:100 900}
    @font-face{font-family:"Cascadia Mono";src:local("Cascadia Mono");font-weight:100 900}
    :root{--bg:#07090F;--surface:#111621;--primary:#FF6A3D;--measure:#55D6FF;--timing:#FFD166;--text:#F7F9FC;--muted:#B8C2D0}
    *{box-sizing:border-box}
    html,body{width:1080px;height:1920px;margin:0;overflow:hidden;background:var(--bg);color:var(--text);font-family:"Microsoft YaHei UI","Segoe UI",sans-serif}
    #root{position:relative;width:100%;height:100%;overflow:hidden;background:radial-gradient(circle at 50% 42%,rgba(255,106,61,.12),transparent 34%),var(--bg)}
    .frame{position:absolute;inset:154px 86px;border:2px solid rgba(85,214,255,.32);border-radius:36px;padding:74px;display:flex;flex-direction:column;justify-content:space-between;background:rgba(17,22,33,.82)}
    .header{display:flex;justify-content:space-between;align-items:center;font-family:"Cascadia Mono",monospace;font-size:24px;letter-spacing:.08em;color:var(--measure)}
    .status{color:var(--timing)}
    .stage{display:flex;flex:1;align-items:center;justify-content:center;position:relative;min-height:0}
    .footer{display:flex;justify-content:space-between;font-size:26px;color:var(--muted)}
    .footer strong{font-family:"Cascadia Mono",monospace;color:var(--primary)}
    .caption-chip{max-width:820px;padding:28px 42px;border-radius:22px;background:var(--text);color:var(--bg);font-size:72px;font-weight:900;line-height:1.12;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.38)}
    .sentence{position:relative;z-index:2;max-width:820px;font-size:76px;font-weight:350;line-height:1.18;text-align:center}.sentence strong{color:var(--primary);font-weight:900}
    .marker{position:absolute;width:360px;height:24px;top:55%;background:var(--timing);transform-origin:left;border-radius:99px;opacity:.88}
    .evidence-card{width:760px;padding:52px;border:2px solid var(--measure);border-radius:30px;background:#0B1019;box-shadow:0 30px 80px rgba(0,0,0,.48)}.evidence-card span,.evidence-card small,.evidence-card strong{display:block}.evidence-card span{font:700 24px/1 "Cascadia Mono",monospace;color:var(--measure);letter-spacing:.1em}.evidence-card strong{margin:32px 0 24px;font-size:64px;line-height:1.12}.evidence-card small{font-size:30px;color:var(--muted)}
    .bounce-token{width:260px;height:260px;border-radius:50%;display:grid;place-items:center;background:var(--primary);font-size:150px;font-weight:900;color:var(--bg)}.mini-caption{position:absolute;top:65%;font-size:38px;font-weight:900}
    .sound-cue{display:flex;flex-direction:column;align-items:center;gap:32px}.sound-cue strong{font-size:64px;text-align:center}.sound-cue small{font:700 24px/1 "Cascadia Mono",monospace;color:var(--measure);letter-spacing:.08em}.wave{display:flex;align-items:center;gap:18px;height:260px}.wave i{display:block;width:38px;border-radius:99px;background:var(--primary);transform-origin:center}.wave i:nth-child(1){height:90px}.wave i:nth-child(2){height:170px}.wave i:nth-child(3){height:250px}.wave i:nth-child(4){height:150px}.wave i:nth-child(5){height:70px}
    .pause-ring{width:390px;height:390px;border:18px solid var(--timing);border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center}.pause-ring strong{font:900 132px/1 "Cascadia Mono",monospace}.pause-ring span{margin-top:24px;font:700 24px/1 "Cascadia Mono",monospace;color:var(--timing);letter-spacing:.09em}.pulse{position:absolute;width:540px;height:540px;border:3px solid var(--measure);border-radius:50%}
  </style>
</head>
<body>
  <main id="root" data-composition-id="main" data-start="0" data-duration="3" data-width="1080" data-height="1920" data-fps="30">
    ${audio}
    <section class="frame">
      <header class="header"><span>KOUBO / RECONSTRUCTION LAB</span><span class="status">LOCAL ONLY</span></header>
      <div class="stage">${recipe.markup}</div>
      <footer class="footer"><span>${escapeHtml(recipe.label)}</span><strong>${escapeHtml(technique.primitive)}</strong></footer>
    </section>
  </main>
  <script>
    window.__timelines=window.__timelines||{};
    const tl=gsap.timeline({paused:true});
    tl.from(".header",{opacity:0,y:20,duration:.34,ease:"power3.out"},.12);
    ${recipe.animation}
    tl.from(".footer",{opacity:0,y:-16,duration:.34,ease:"power2.out"},.72);
    tl.to(".frame",{opacity:0,duration:.22,ease:"power2.in"},2.72);
    window.__timelines["main"]=tl;
  </script>
</body>
</html>
`;
}

function writeSineWave(file, {
  durationSeconds = 0.35,
  sampleRate = 48000,
  frequency = 880,
  amplitude = 0.32,
} = {}) {
  const samples = Math.round(durationSeconds * sampleRate);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.min(1, index / 240, (samples - index) / 480);
    const sample = Math.sin(2 * Math.PI * frequency * index / sampleRate) * amplitude * envelope;
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
  }
  fs.writeFileSync(file, buffer);
}

export async function buildTechniqueSandbox({ technique, outputDir } = {}) {
  if (!technique || typeof technique !== "object") throw new Error("technique is required");
  if (!ALLOWED_PRIMITIVES.has(technique.primitive)) {
    throw new Error(`primitive is not allowed: ${technique.primitive}`);
  }
  assertSafeParameters(technique.parameters || {});
  if (!outputDir) throw new Error("outputDir is required");
  const projectDir = path.resolve(outputDir);
  const assetsDir = path.join(projectDir, "assets");
  await fsp.mkdir(assetsDir, { recursive: true });
  const gsapSource = path.resolve(moduleDir, "..", "hyperframes-overlay", "gsap.min.js");
  if (!fs.existsSync(gsapSource)) throw new Error(`local GSAP runtime is missing: ${gsapSource}`);
  await fsp.copyFile(gsapSource, path.join(assetsDir, "gsap.min.js"));

  const recipe = recipeFor(technique);
  if (recipe.audio) writeSineWave(path.join(assetsDir, "cue.wav"));
  const manifest = {
    schemaVersion: 1,
    sandboxVersion: "technique-sandbox-v1",
    techniqueId: String(technique.id),
    techniqueHash: String(technique.contentHash || ""),
    primitive: technique.primitive,
    allowedPrimitive: true,
    sourceCodeAccepted: false,
    networkPolicy: "offline-local-assets-only",
    composition: { id: "main", width: 1080, height: 1920, fps: 30, durationSeconds: 3 },
    qaThresholds: {
      fullDecode: true,
      readable: true,
      safeArea: "8%",
      contrast: "WCAG-AA",
      maxSyncErrorMs: 100,
      maxTruePeakDb: -1.5,
    },
  };
  await fsp.writeFile(path.join(projectDir, "DESIGN.md"), designDocument(), "utf8");
  await fsp.writeFile(path.join(projectDir, "index.html"), compositionHtml(technique, recipe), "utf8");
  await fsp.writeFile(path.join(projectDir, "hyperframes.json"), `${JSON.stringify({
    paths: { assets: "assets", compositions: "compositions" },
    media: { autoProxy: false },
  }, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(projectDir, "package.json"), `${JSON.stringify({
    name: `koubo-sandbox-${technique.primitive}`,
    private: true,
    type: "module",
  }, null, 2)}\n`, "utf8");
  await fsp.writeFile(
    path.join(projectDir, "technique-sandbox-manifest.json"),
    `${canonicalJson(manifest)}\n`,
    "utf8"
  );
  return {
    projectDir,
    manifestPath: path.join(projectDir, "technique-sandbox-manifest.json"),
    primitive: technique.primitive,
  };
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function mediaMetrics(renderFile, cwd) {
  const decode = await run("ffmpeg", ["-v", "error", "-i", renderFile, "-f", "null", "-"], cwd);
  const probe = await run("ffprobe", [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    renderFile,
  ], cwd);
  if (probe.code !== 0) throw new Error(`ffprobe failed: ${probe.stderr.slice(0, 500)}`);
  const metadata = JSON.parse(probe.stdout);
  const hasAudio = Boolean(metadata.streams?.some(stream => stream.codec_type === "audio"));
  let peakDb = null;
  if (hasAudio) {
    const peak = await run("ffmpeg", [
      "-hide_banner", "-i", renderFile,
      "-af", "ebur128=peak=true",
      "-f", "null", "-",
    ], cwd);
    const matches = [...peak.stderr.matchAll(/Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS/g)];
    peakDb = matches.length ? Number(matches.at(-1)[1]) : null;
  }
  return {
    decodeOk: decode.code === 0,
    hasAudio,
    peakDb,
    renderHash: sha256(renderFile),
  };
}

export async function qaTechniqueSandbox(input = {}) {
  const values = { ...input };
  if (values.renderFile) {
    Object.assign(values, await mediaMetrics(
      path.resolve(values.renderFile),
      values.projectDir ? path.resolve(values.projectDir) : process.cwd()
    ));
  }
  if (values.projectDir) {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(path.resolve(values.projectDir), "technique-sandbox-manifest.json"),
      "utf8"
    ));
    if (values.networkAccess === undefined) {
      values.networkAccess = manifest.networkPolicy !== "offline-local-assets-only";
    }
  }

  const checks = {
    decode: values.decodeOk === true,
    readable: values.readable === true,
    safeArea: values.safeArea === true,
    contrast: values.contrast === true,
    sync: Number.isFinite(values.syncErrorMs) && values.syncErrorMs <= 100,
    truePeak: values.hasAudio !== true
      || (Number.isFinite(values.peakDb) && values.peakDb <= -1.5),
    offline: values.networkAccess === false,
  };
  const failures = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return {
    schemaVersion: 1,
    eligibleTransition: failures.length === 0 ? "recreated" : null,
    checks,
    failures,
    metrics: {
      syncErrorMs: Number.isFinite(values.syncErrorMs) ? values.syncErrorMs : null,
      peakDb: Number.isFinite(values.peakDb) ? values.peakDb : null,
      hasAudio: values.hasAudio === true,
    },
    renderHash: values.renderHash || null,
  };
}

export function applyRecreationQa({
  memory,
  technique,
  qa,
  actor = { type: "controller", id: "technique-sandbox-qa" },
} = {}) {
  if (!memory || typeof memory.transition !== "function") throw new Error("memory service is required");
  if (!technique?.id || !technique?.contentHash) throw new Error("technique record is required");
  if (qa?.eligibleTransition !== "recreated") {
    throw new Error(`technique is not eligible for recreated: ${(qa?.failures || []).join(", ")}`);
  }
  return memory.transition({
    kind: "technique-card",
    id: technique.id,
    to: "recreated",
    actor,
    evidence: [{
      type: "render-qa",
      sourceId: technique.id,
      kind: "sandbox-render",
      renderHash: qa.renderHash,
      passed: true,
      checks: qa.checks,
    }],
    expectedHash: technique.contentHash,
  });
}
