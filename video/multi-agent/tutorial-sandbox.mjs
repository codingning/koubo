import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./contracts.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const HYPERFRAMES_VERSION = "0.7.70";
const ALLOWED_PRIMITIVES = new Set([
  "caption-pop",
  "keyword-emphasis",
  "pause-aware-follow-caption",
  "element-slide",
  "element-bounce",
  "semantic-layout-router",
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

function pauseAwareCaptionRecipe(title) {
  const tokenWindows = [
    { id: "active-token-1", text: "先", startSeconds: 0.62, endSeconds: 0.94 },
    { id: "active-token-2", text: "看见", startSeconds: 1.24, endSeconds: 1.58 },
    { id: "active-token-3", text: "停顿", startSeconds: 3.06, endSeconds: 3.42 },
    { id: "active-token-4", text: "再", startSeconds: 4.02, endSeconds: 4.32 },
    { id: "active-token-5", text: "继续", startSeconds: 4.76, endSeconds: 5.12 },
  ];
  const baseTokens = tokenWindows
    .map(token => `<span class="caption-token">${escapeHtml(token.text)}</span>`)
    .join("");
  const activeTokens = tokenWindows
    .map(token => `<span id="${token.id}" class="caption-token active-token">${escapeHtml(token.text)}</span>`)
    .join("");
  const meter = tokenWindows
    .map((token, index) => `<i id="meter-${index + 1}" aria-label="${escapeHtml(token.text)}"></i>`)
    .join("");
  const tokenAnimation = tokenWindows
    .map((token, index) => {
      const duration = Number((token.endSeconds - token.startSeconds).toFixed(2));
      return `tl.fromTo("#${token.id}",{opacity:0,y:18},{opacity:1,y:0,duration:${duration},ease:"power2.out"},${token.startSeconds});tl.fromTo("#meter-${index + 1}",{backgroundColor:"#303A49",scaleX:.18},{backgroundColor:"#55D6FF",scaleX:1,duration:${duration},ease:"power2.out"},${token.startSeconds});`;
    })
    .join("");
  return {
    label: "CAPTION / PAUSE-AWARE FOLLOW",
    durationSeconds: 6.3,
    markup: `<div id="pause-aware-demo" class="follow-caption-demo">
        <div class="demo-kicker">${title}</div>
        <div id="caption-stack" class="caption-stack" data-layout-allow-overlap>
          <div id="base-caption" class="caption-line base-caption">${baseTokens}</div>
          <div id="active-caption" class="caption-line active-caption">${activeTokens}</div>
        </div>
        <div id="token-meter" class="token-meter">${meter}</div>
        <div id="pause-badge" class="pause-badge">PAUSE · HOLD LAST STATE</div>
        <div id="caption-complete" class="caption-complete">TOKEN TIME → FRAME STATE</div>
      </div>`,
    styles: `
    .follow-caption-demo{width:100%;display:flex;flex-direction:column;align-items:center;gap:42px}
    .demo-kicker{max-width:760px;font:700 28px/1.35 "Cascadia Mono",monospace;color:var(--measure);text-align:center;letter-spacing:.04em}
    .caption-stack{position:relative;width:820px;min-height:220px;display:grid;place-items:center;border:2px solid rgba(255,209,102,.44);border-radius:30px;background:#0B1019;padding:52px 44px}
    .caption-line{display:flex;justify-content:center;align-items:center;gap:24px;width:100%;max-width:820px;overflow:hidden;font-size:72px;font-weight:900;line-height:1.15;white-space:nowrap}
    .active-caption{position:absolute;inset:0;padding:52px 44px;color:var(--text)}
    .base-caption{color:#7E899A}.base-caption .caption-token{opacity:.42}
    .caption-token{display:inline-block;min-width:76px;text-align:center}.active-token{opacity:0;color:var(--timing);will-change:transform,opacity}
    .token-meter{display:flex;width:760px;height:18px;gap:14px}.token-meter i{display:block;flex:1;height:18px;border-radius:99px;background:#303A49;transform-origin:left center;will-change:transform}
    .pause-badge{opacity:0;padding:16px 26px;border:2px solid var(--timing);border-radius:99px;font:700 24px/1 "Cascadia Mono",monospace;color:var(--timing);letter-spacing:.08em}
    .caption-complete{opacity:0;font:700 25px/1 "Cascadia Mono",monospace;color:var(--primary);letter-spacing:.09em}
    `,
    animation: `${tokenAnimation}tl.set("#pause-badge",{opacity:1},1.82);tl.set("#pause-badge",{opacity:0},2.94);tl.fromTo("#caption-complete",{opacity:0,y:18},{opacity:1,y:0,duration:.32,ease:"power3.out"},5.34);`,
    proof: {
      schemaVersion: 1,
      primitive: "pause-aware-follow-caption",
      assertionModel: "authored-token-time-plus-rendered-frame-comparison",
      tokenWindows,
      pauseIntervals: [{
        startSeconds: 1.82,
        endSeconds: 2.94,
        holdAfterTokenId: "active-token-2",
        comparisonTimesSeconds: [2.12, 2.62],
      }],
    },
    motion: {
      duration: 6.3,
      maxStaticSec: 1.3,
      assertions: [
        { kind: "appearsBy", selector: "#base-caption", bySec: 0.25 },
        { kind: "appearsBy", selector: "#active-token-1", bySec: 0.95 },
        { kind: "before", a: "#active-token-2", b: "#active-token-3" },
        { kind: "staysInFrame", selector: "#caption-stack" },
        { kind: "keepsMoving", withinSelector: "#pause-aware-demo" },
      ],
    },
    qaRequirements: { pauseHold: true },
  };
}

function semanticLayoutRecipe(title) {
  const layouts = [
    { role: "single-focus", selector: "#focus-panel", revealAtSeconds: 0.42, hideBySeconds: 2.12 },
    { role: "steps", selector: "#steps-panel", revealAtSeconds: 2.28, hideBySeconds: 4.5 },
    { role: "evidence", selector: "#evidence-panel", revealAtSeconds: 4.68, hideBySeconds: 7.12 },
  ];
  return {
    label: "MOTION / SEMANTIC LAYOUT ROUTER",
    durationSeconds: 7.4,
    markup: `<div id="semantic-router-demo" class="semantic-router-demo">
        <div class="demo-kicker">${title}</div>
        <div id="route-stage" class="route-stage">
          <section id="focus-panel" class="route-panel focus-panel">
            <span class="route-tag">ONE FOCUS</span>
            <strong>先讲清</strong>
            <em>这一件事</em>
            <i id="focus-rule"></i>
          </section>
          <section id="steps-panel" class="route-panel steps-panel">
            <span class="route-tag">THREE STEPS</span>
            <div class="step-list">
              <div class="step-item"><b>01</b><span>输入</span><small>一句真实目标</small></div>
              <div class="step-item"><b>02</b><span>动作</span><small>执行最小步骤</small></div>
              <div class="step-item"><b>03</b><span>结果</span><small>留下可核验证据</small></div>
            </div>
          </section>
          <section id="evidence-panel" class="route-panel evidence-panel">
            <span class="route-tag">REAL EVIDENCE</span>
            <div id="local-screen" class="local-screen">
              <div class="screen-bar"><i></i><i></i><i></i><span>LOCAL RUN</span></div>
              <div class="screen-body"><code>input  →  action</code><code>result →  PASS</code><code>sha256 →  recorded</code></div>
            </div>
            <div id="evidence-arrow" class="evidence-arrow"><span></span><i></i></div>
            <div id="evidence-note" class="evidence-note"><b>真实结果</b><small>先于装饰</small></div>
          </section>
        </div>
        <div class="route-legend"><span id="legend-focus">重点</span><span id="legend-steps">步骤</span><span id="legend-evidence">证据</span></div>
      </div>`,
    styles: `
    .semantic-router-demo{width:100%;display:flex;flex-direction:column;align-items:center;gap:32px}
    .semantic-router-demo>.demo-kicker{max-width:760px;font:700 28px/1.35 "Cascadia Mono",monospace;color:var(--measure);text-align:center;letter-spacing:.04em}
    .route-stage{position:relative;width:820px;height:770px}
    .route-panel{position:absolute;inset:0;opacity:0;border:2px solid rgba(85,214,255,.38);border-radius:32px;background:#0B1019;padding:54px;overflow:hidden}
    .route-tag{display:block;font:700 23px/1 "Cascadia Mono",monospace;color:var(--measure);letter-spacing:.1em}
    .focus-panel{display:flex;flex-direction:column;align-items:flex-start;justify-content:center}.focus-panel strong{font-size:104px;line-height:1;color:var(--text)}.focus-panel em{margin-top:24px;font-size:78px;font-style:normal;font-weight:900;color:var(--primary)}.focus-panel i{display:block;width:620px;height:18px;margin-top:52px;border-radius:99px;background:var(--timing);transform-origin:left center}
    .steps-panel{display:flex;flex-direction:column}.step-list{display:flex;flex-direction:column;gap:24px;margin-top:54px}.step-item{display:grid;grid-template-columns:92px 150px 1fr;align-items:center;min-height:142px;padding:24px 30px;border:1px solid rgba(184,194,208,.24);border-radius:22px;background:#111621}.step-item b{font:900 42px/1 "Cascadia Mono",monospace;color:var(--timing)}.step-item span{font-size:46px;font-weight:900}.step-item small{font-size:28px;color:var(--muted)}
    .evidence-panel{display:grid;grid-template-columns:1fr 100px 230px;align-items:center;gap:24px}.evidence-panel>.route-tag{position:absolute;top:54px;left:54px}.local-screen{margin-top:58px;border:2px solid var(--measure);border-radius:24px;overflow:hidden;background:#07090F}.screen-bar{height:72px;display:flex;align-items:center;gap:12px;padding:0 22px;border-bottom:1px solid rgba(85,214,255,.28)}.screen-bar i{width:16px;height:16px;border-radius:50%;background:var(--primary)}.screen-bar i:nth-child(2){background:var(--timing)}.screen-bar i:nth-child(3){background:var(--measure)}.screen-bar span{margin-left:auto;font:700 20px/1 "Cascadia Mono",monospace;color:var(--measure)}.screen-body{display:flex;flex-direction:column;gap:34px;padding:54px 32px}.screen-body code{font:700 24px/1.2 "Cascadia Mono",monospace;color:var(--text)}.screen-body code:nth-child(2){color:var(--timing)}
    .evidence-arrow{display:flex;align-items:center;margin-top:58px}.evidence-arrow span{display:block;width:72px;height:8px;background:var(--primary);transform-origin:left center}.evidence-arrow i{width:0;height:0;border-top:16px solid transparent;border-bottom:16px solid transparent;border-left:24px solid var(--primary)}.evidence-note{margin-top:58px;padding:32px 24px;border:2px solid var(--timing);border-radius:22px;text-align:center}.evidence-note b,.evidence-note small{display:block}.evidence-note b{font-size:38px}.evidence-note small{margin-top:18px;font-size:27px;color:var(--muted)}
    .route-legend{position:relative;width:180px;height:64px}.route-legend span{position:absolute;inset:0;display:grid;place-items:center;opacity:0;border:1px solid rgba(184,194,208,.32);border-radius:99px;font-size:25px;text-align:center;color:var(--muted)}
    `,
    animation: `tl.fromTo("#focus-panel",{opacity:0,scale:.96},{opacity:1,scale:1,duration:.4,ease:"power3.out"},.42);tl.fromTo("#legend-focus",{opacity:0,y:12},{opacity:1,y:0,duration:.28,ease:"power2.out"},.58);tl.fromTo("#focus-rule",{scaleX:0},{scaleX:1,duration:.46,ease:"power3.out"},.78);tl.to(["#focus-panel","#legend-focus"],{opacity:0,y:-24,duration:.22,ease:"power2.in"},1.9);tl.fromTo("#steps-panel",{opacity:0,y:28},{opacity:1,y:0,duration:.38,ease:"power3.out"},2.28);tl.fromTo("#legend-steps",{opacity:0,y:12},{opacity:1,y:0,duration:.28,ease:"power2.out"},2.42);tl.fromTo(".step-item",{opacity:0,x:-34},{opacity:1,x:0,duration:.34,stagger:.12,ease:"power3.out"},2.62);tl.to(["#steps-panel","#legend-steps"],{opacity:0,y:-24,duration:.24,ease:"power2.in"},4.26);tl.fromTo("#evidence-panel",{opacity:0,y:28},{opacity:1,y:0,duration:.38,ease:"power3.out"},4.68);tl.fromTo("#legend-evidence",{opacity:0,y:12},{opacity:1,y:0,duration:.28,ease:"power2.out"},4.82);tl.fromTo("#local-screen",{opacity:0,x:-34},{opacity:1,x:0,duration:.4,ease:"power3.out"},4.96);tl.fromTo("#evidence-arrow span",{scaleX:0},{scaleX:1,duration:.32,ease:"power2.out"},5.28);tl.fromTo("#evidence-arrow i",{opacity:0,x:-10},{opacity:1,x:0,duration:.2,ease:"power2.out"},5.5);tl.fromTo("#evidence-note",{opacity:0,scale:.88},{opacity:1,scale:1,duration:.34,ease:"back.out(1.5)"},5.62);`,
    proof: {
      schemaVersion: 1,
      primitive: "semantic-layout-router",
      assertionModel: "semantic-role-reveal-schedule-plus-snapshot-review",
      layouts,
      sampleExpectations: [
        { atSeconds: 1.2, visible: ["#focus-panel", "#legend-focus"], hidden: ["#steps-panel", "#evidence-panel", "#legend-steps", "#legend-evidence"] },
        { atSeconds: 3.35, visible: ["#steps-panel", "#legend-steps"], hidden: ["#focus-panel", "#evidence-panel", "#legend-focus", "#legend-evidence"] },
        { atSeconds: 5.95, visible: ["#evidence-panel", "#legend-evidence"], hidden: ["#focus-panel", "#steps-panel", "#legend-focus", "#legend-steps"] },
      ],
      noEarlyReveal: true,
    },
    motion: {
      duration: 7.4,
      maxStaticSec: 2.05,
      assertions: [
        { kind: "appearsBy", selector: "#focus-panel", bySec: 0.9 },
        { kind: "before", a: "#focus-panel", b: "#steps-panel" },
        { kind: "before", a: "#steps-panel", b: "#evidence-panel" },
        { kind: "staysInFrame", selector: "#focus-panel" },
        { kind: "staysInFrame", selector: "#steps-panel" },
        { kind: "staysInFrame", selector: "#evidence-panel" },
        { kind: "keepsMoving", withinSelector: "#semantic-router-demo" },
      ],
    },
    qaRequirements: { semanticLayoutCount: 3, noEarlyReveal: true },
  };
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
    "pause-aware-follow-caption": pauseAwareCaptionRecipe(title),
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
    "semantic-layout-router": semanticLayoutRecipe(title),
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

- Bounded, authored beats that expose only the tested behavior.
- Pause-aware captions must hold pixel state during declared silence intervals.
- Semantic routing must reveal one role at a time without previewing later roles.
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
  const durationSeconds = Number(recipe.durationSeconds || 3);
  const fadeAtSeconds = Number((durationSeconds - 0.28).toFixed(2));
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
    #root{position:relative;width:100%;height:100%;overflow:hidden}
    .canvas-bg{position:absolute;inset:0;background:radial-gradient(circle at 50% 42%,rgba(255,106,61,.12),transparent 34%),var(--bg)}
    .lab-clip{position:absolute;inset:0}
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
    ${recipe.styles || ""}
  </style>
</head>
<body>
  <main id="root" data-composition-id="main" data-start="0" data-duration="${durationSeconds}" data-width="1080" data-height="1920" data-fps="30">
    <div id="canvas-bg" class="clip canvas-bg" data-start="0" data-duration="${durationSeconds}" data-track-index="0" data-layout-ignore></div>
    ${audio}
    <section id="lab-clip" class="clip lab-clip" data-start="0" data-duration="${durationSeconds}" data-track-index="2">
      <div id="lab-frame" class="frame">
        <header class="header"><span>KOUBO / RECONSTRUCTION LAB</span><span class="status">LOCAL ONLY</span></header>
        <div class="stage">${recipe.markup}</div>
        <footer class="footer"><span>${escapeHtml(recipe.label)}</span><strong>${escapeHtml(technique.primitive)}</strong></footer>
      </div>
    </section>
  </main>
  <script>
    window.__timelines=window.__timelines||{};
    const tl=gsap.timeline({paused:true});
    tl.fromTo(".header",{opacity:0,y:20},{opacity:1,y:0,duration:.34,ease:"power3.out"},.12);
    ${recipe.animation}
    tl.fromTo(".footer",{opacity:0,y:-16},{opacity:1,y:0,duration:.34,ease:"power2.out"},.72);
    tl.to("#lab-frame",{opacity:0,duration:.22,ease:"power2.in"},${fadeAtSeconds});
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
  const verification = {
    motionSidecar: null,
    proofSidecar: null,
    requirements: recipe.qaRequirements || {},
  };
  if (recipe.motion) {
    verification.motionSidecar = "index.motion.json";
    await fsp.writeFile(
      path.join(projectDir, verification.motionSidecar),
      `${canonicalJson(recipe.motion)}\n`,
      "utf8"
    );
  }
  if (recipe.proof) {
    verification.proofSidecar = "technique-proof.json";
    await fsp.writeFile(
      path.join(projectDir, verification.proofSidecar),
      `${canonicalJson(recipe.proof)}\n`,
      "utf8"
    );
  }
  const durationSeconds = Number(recipe.durationSeconds || 3);
  const manifest = {
    schemaVersion: 1,
    sandboxVersion: "technique-sandbox-v2",
    hyperframesVersion: HYPERFRAMES_VERSION,
    techniqueId: String(technique.id),
    techniqueHash: String(technique.contentHash || ""),
    primitive: technique.primitive,
    allowedPrimitive: true,
    sourceCodeAccepted: false,
    networkPolicy: "offline-local-assets-only",
    composition: { id: "main", width: 1080, height: 1920, fps: 30, durationSeconds },
    verification,
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
    scripts: {
      "hf:lint": `npx --yes hyperframes@${HYPERFRAMES_VERSION} lint .`,
      "hf:check": `npx --yes hyperframes@${HYPERFRAMES_VERSION} check . --strict`,
      "hf:snapshot": `npx --yes hyperframes@${HYPERFRAMES_VERSION} snapshot .`,
      "hf:render": `npx --yes hyperframes@${HYPERFRAMES_VERSION} render .`,
    },
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

function isSha256(value) {
  return /^[a-f0-9]{64}$/u.test(String(value || ""));
}

function validJsonSidecar(file) {
  try {
    if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) return false;
    JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
    return true;
  } catch {
    return false;
  }
}

async function mediaMetrics(renderFile, cwd) {
  const stats = fs.statSync(renderFile);
  const renderHash = sha256(renderFile);
  const decode = await run("ffmpeg", ["-v", "error", "-i", renderFile, "-f", "null", "-"], cwd);
  const probe = await run("ffprobe", [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    renderFile,
  ], cwd);
  if (probe.code !== 0) {
    return {
      renderFilePresent: true,
      renderFileBytes: stats.size,
      mediaProbeOk: false,
      decodeOk: false,
      hasAudio: false,
      peakDb: null,
      renderHash,
    };
  }
  let metadata;
  try {
    metadata = JSON.parse(probe.stdout);
  } catch {
    return {
      renderFilePresent: true,
      renderFileBytes: stats.size,
      mediaProbeOk: false,
      decodeOk: false,
      hasAudio: false,
      peakDb: null,
      renderHash,
    };
  }
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
    renderFilePresent: true,
    renderFileBytes: stats.size,
    mediaProbeOk: true,
    decodeOk: decode.code === 0,
    hasAudio,
    peakDb,
    renderHash,
  };
}

export async function qaTechniqueSandbox(input = {}) {
  const values = {
    ...input,
    renderFilePresent: false,
    renderFileBytes: 0,
    mediaProbeOk: false,
    decodeOk: false,
    hasAudio: false,
    peakDb: null,
    renderHash: null,
  };
  if (values.renderFile) {
    const renderFile = path.resolve(values.renderFile);
    try {
      const stats = fs.statSync(renderFile);
      if (stats.isFile() && stats.size > 0) {
        Object.assign(values, await mediaMetrics(
          renderFile,
          values.projectDir ? path.resolve(values.projectDir) : process.cwd()
        ));
      }
    } catch {
      // Missing or unreadable renders remain explicit failed evidence below.
    }
  }
  if (values.projectDir) {
    const projectDir = path.resolve(values.projectDir);
    const manifest = JSON.parse(fs.readFileSync(
      path.join(projectDir, "technique-sandbox-manifest.json"),
      "utf8"
    ));
    values.primitive = manifest.primitive;
    values.techniqueId = manifest.techniqueId;
    values.techniqueHash = manifest.techniqueHash;
    values.motionSidecarRequired = Boolean(manifest.verification?.motionSidecar);
    values.proofSidecarRequired = Boolean(manifest.verification?.proofSidecar);
    values.qaRequirements = manifest.verification?.requirements || {};
    values.motionSidecarPresent = !values.motionSidecarRequired || validJsonSidecar(path.join(
      projectDir,
      manifest.verification.motionSidecar
    ));
    values.proofSidecarPresent = !values.proofSidecarRequired || validJsonSidecar(path.join(
      projectDir,
      manifest.verification.proofSidecar
    ));
    values.networkAccess = manifest.networkPolicy !== "offline-local-assets-only";
  }
  if (["pause-aware-follow-caption", "semantic-layout-router"].includes(values.primitive)) {
    values.motionSidecarRequired = true;
    values.proofSidecarRequired = true;
    values.motionSidecarPresent = values.motionSidecarPresent === true;
    values.proofSidecarPresent = values.proofSidecarPresent === true;
  }

  const checks = {
    renderFile: values.renderFilePresent === true && values.renderFileBytes > 0,
    mediaProbe: values.mediaProbeOk === true,
    decode: values.decodeOk === true,
    renderHash: isSha256(values.renderHash),
    readable: values.readable === true,
    safeArea: values.safeArea === true,
    contrast: values.contrast === true,
    sync: Number.isFinite(values.syncErrorMs) && values.syncErrorMs <= 100,
    truePeak: values.hasAudio !== true
      || (Number.isFinite(values.peakDb) && values.peakDb <= -1.5),
    offline: values.networkAccess === false,
    motionSidecar: values.motionSidecarRequired !== true || values.motionSidecarPresent === true,
    proofSidecar: values.proofSidecarRequired !== true || values.proofSidecarPresent === true,
  };
  if (values.primitive === "pause-aware-follow-caption") {
    checks.pauseHold = values.pauseHoldVerified === true;
  }
  if (values.primitive === "semantic-layout-router") {
    const expectedLayouts = Number(values.qaRequirements?.semanticLayoutCount || 3);
    checks.semanticLayouts = Number.isFinite(values.semanticLayoutCount)
      && values.semanticLayoutCount >= expectedLayouts;
    checks.noEarlyReveal = values.noEarlyReveal === true;
  }
  const failures = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return {
    schemaVersion: 1,
    primitive: values.primitive || null,
    techniqueId: values.techniqueId || null,
    techniqueHash: values.techniqueHash || null,
    eligibleTransition: failures.length === 0 ? "recreated" : null,
    checks,
    failures,
    metrics: {
      syncErrorMs: Number.isFinite(values.syncErrorMs) ? values.syncErrorMs : null,
      peakDb: Number.isFinite(values.peakDb) ? values.peakDb : null,
      hasAudio: values.hasAudio === true,
      pauseHoldVerified: values.pauseHoldVerified === true,
      semanticLayoutCount: Number.isFinite(values.semanticLayoutCount)
        ? values.semanticLayoutCount
        : null,
      noEarlyReveal: values.noEarlyReveal === true,
    },
    renderHash: values.renderHash || null,
  };
}

export async function applyRecreationQa({
  memory,
  technique,
  qa,
  projectDir,
  renderFile,
  actor = { type: "controller", id: "technique-sandbox-qa" },
} = {}) {
  if (!memory || typeof memory.transition !== "function") throw new Error("memory service is required");
  if (!technique?.id || !technique?.contentHash) throw new Error("technique record is required");
  if (qa?.eligibleTransition !== "recreated") {
    throw new Error(`technique is not eligible for recreated: ${(qa?.failures || []).join(", ")}`);
  }
  if (!isSha256(qa.renderHash)) throw new Error("recreated transition requires a valid render SHA-256");
  if (qa.techniqueId !== technique.id || qa.techniqueHash !== technique.contentHash) {
    throw new Error("recreated transition QA is not bound to the current technique record");
  }
  if (qa.primitive !== technique.primitive) {
    throw new Error("recreated transition QA primitive does not match the technique record");
  }
  const requiredChecks = [
    "renderFile",
    "mediaProbe",
    "decode",
    "renderHash",
    "readable",
    "safeArea",
    "contrast",
    "sync",
    "truePeak",
    "offline",
    "motionSidecar",
    "proofSidecar",
  ];
  const missingChecks = requiredChecks.filter(name => qa.checks?.[name] !== true);
  if (missingChecks.length) {
    throw new Error(`recreated transition is missing verified QA checks: ${missingChecks.join(", ")}`);
  }
  if (!projectDir || !renderFile) {
    throw new Error("recreated transition requires the verified project and render file");
  }
  const resolvedProjectDir = path.resolve(projectDir);
  const resolvedRenderFile = path.resolve(renderFile);
  const renderRelative = path.relative(resolvedProjectDir, resolvedRenderFile);
  if (!renderRelative || renderRelative.startsWith("..") || path.isAbsolute(renderRelative)) {
    throw new Error("recreated transition render must stay inside its sandbox project");
  }
  const manifest = JSON.parse(fs.readFileSync(
    path.join(resolvedProjectDir, "technique-sandbox-manifest.json"),
    "utf8"
  ));
  if (manifest.techniqueId !== technique.id
    || manifest.techniqueHash !== technique.contentHash
    || manifest.primitive !== technique.primitive) {
    throw new Error("recreated transition project manifest does not match the technique record");
  }
  const verifiedMedia = await mediaMetrics(resolvedRenderFile, resolvedProjectDir);
  if (verifiedMedia.mediaProbeOk !== true || verifiedMedia.decodeOk !== true) {
    throw new Error("recreated transition render failed repeated probe or full decode");
  }
  if (!isSha256(verifiedMedia.renderHash) || verifiedMedia.renderHash !== qa.renderHash) {
    throw new Error("recreated transition render SHA-256 changed after QA");
  }
  if (verifiedMedia.hasAudio === true
    && (!Number.isFinite(verifiedMedia.peakDb) || verifiedMedia.peakDb > -1.5)) {
    throw new Error("recreated transition render failed repeated true-peak verification");
  }
  const requiredMotionSidecar = manifest.verification?.motionSidecar;
  const requiredProofSidecar = manifest.verification?.proofSidecar;
  if (requiredMotionSidecar
    && !validJsonSidecar(path.join(resolvedProjectDir, requiredMotionSidecar))) {
    throw new Error("recreated transition requires its valid motion sidecar");
  }
  if (requiredProofSidecar
    && !validJsonSidecar(path.join(resolvedProjectDir, requiredProofSidecar))) {
    throw new Error("recreated transition requires its valid primitive proof sidecar");
  }
  if (technique.primitive === "pause-aware-follow-caption") {
    if (qa.checks.pauseHold !== true) {
      throw new Error("pause-aware-follow-caption requires verified pause-hold proof");
    }
    throw new Error("pause-aware-follow-caption requires its specialized proof verifier");
  }
  if (technique.primitive === "semantic-layout-router") {
    if (qa.checks.semanticLayouts !== true || qa.checks.noEarlyReveal !== true) {
      throw new Error("semantic-layout-router requires verified layout-order proof");
    }
    throw new Error("semantic-layout-router requires its specialized proof verifier");
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
