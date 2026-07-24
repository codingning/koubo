import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidatePrincipleContentHash,
  evaluateCandidatePrincipleScenarios,
  recordWholeSetRejection,
} from "../video/multi-agent/candidate-principle-sandbox.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(moduleDir, "..");
const REVIEW_SCHEMA_VERSION = 2;
const REVIEW_ID = "koubo-agent-training-batch-1-second-level-candidate-review-v2";
const STORAGE_KEY_PREFIX = "koubo.agent-training.batch-1.review.v2";
const REVIEW_CODES = Object.freeze([
  "C1", "C2", "C3", "M1", "M2", "M3", "S1", "S2", "S3", "D1", "D2", "D3",
]);

const CANDIDATE_SPECS = Object.freeze([
  {
    code: "C1",
    candidateId: "content-principle.one-primary-audience-payoff.v1",
    group: "内容策略",
    title: "一个主要观众收益",
    principleId: "content-principle.one-primary-audience-payoff.v1",
    summary: "先说清一条内容主要服务谁，以及观众看完具体多了什么。",
    recommendation: "retain",
    recommendationText: "建议保留进入真实片段试用：验证它能否把项目自述转成观众可复述的单一收益。",
    boundary: "娱乐、审美和陪伴也可以是收益，不强迫所有内容都变成工具教程。",
  },
  {
    code: "C2",
    candidateId: "content-principle.opening-creates-audience-contract.v1",
    group: "内容策略",
    title: "开头形成观众合同",
    principleId: "content-principle.opening-creates-audience-contract.v1",
    summary: "开头承诺什么，主要段落和结尾证据就持续偿还什么。",
    recommendation: "retain",
    recommendationText: "建议保留进入真实片段试用：重点检查有价值但与开头无关的段落是否被及时删掉。",
    boundary: "允许故事、停顿和主题扩大，但需要清楚的因果桥。",
  },
  {
    code: "C3",
    candidateId: "content-principle.voice-source-before-verbatim-draft.v1",
    group: "内容策略",
    title: "先取得本人语言",
    principleId: "content-principle.voice-source-before-verbatim-draft.v1",
    summary: "先从真实访谈取得观点和措辞，再按表达熟练度选择大纲、复述或逐字稿。",
    recommendation: "retain",
    recommendationText: "建议保留进入真实片段试用：用一次真实方向访谈检查成稿是否仍像本人。",
    boundary: "合规、数据、无障碍等场景可以使用更精确的逐字支持。",
  },
  {
    code: "M1",
    candidateId: "caption-technique.pause-aware-follow-caption.v1",
    group: "字幕与动效",
    title: "停顿感知跟读字幕",
    summary: "活跃字幕按真实 token 或短语时间推进，语音停顿时保持上一状态。",
    recommendation: "retain",
    recommendationText: "建议保留进入真实片段试用：下一门必须换成真人语音与真实转录时间。",
    boundary: "当前样片使用 authored 时间，只证明暂停保持与可寻址时间线，不证明真人转录精度。",
  },
  {
    code: "M2",
    candidateId: "motion-technique.semantic-layout-router.v1",
    group: "字幕与动效",
    title: "语义版式路由",
    summary: "先区分单重点、步骤和证据，再选择画面结构，避免先套模板。",
    recommendation: "retain",
    recommendationText: "建议保留进入真实片段试用：用真实录屏或截图验证证据层不会被装饰遮住。",
    boundary: "当前只覆盖三类基础结构，尚未覆盖多人画面、长文本和复杂证据。",
  },
  {
    code: "M3",
    candidateId: "director-technique.plan-preview-promote-gates.v1",
    group: "Director 流程",
    title: "方案、预览、经验规则三门分离",
    principleId: "director-technique.plan-preview-promote-gates.v1",
    summary: "有实质分叉时，方案判断、样片判断和经验规则判断彼此独立。",
    recommendation: "revise",
    recommendationText: "建议修改后保留：合并为 Director 流程门，不单独维护与 D1、D3 重复的规则。",
    boundary: "编码、画幅和安全区等确定性约束不需要额外制造审美选择。",
  },
  {
    code: "S1",
    candidateId: "sound-technique.mix-gain-guardrail.v1",
    group: "声音",
    title: "响度与真峰值底线",
    summary: "用整段响度和真峰值检查人声、音乐与音效总线，而不是套固定滑块比例。",
    recommendation: "retain",
    recommendationText: "建议保留进入真实片段试用：它是 S2、S3 的确定性安全底座。",
    boundary: "当前 voice-like 和音乐均为程序化素材，只证明测量与编码链成立。",
  },
  {
    code: "S2",
    candidateId: "sound-technique.speech-aware-ducking.v1",
    group: "声音",
    title: "人声触发音乐避让",
    summary: "先做全带 duck；只有同 stem 测量证明存在频带冲突时，才增加频谱让位。",
    recommendation: "revise",
    recommendationText: "建议修改后保留：全带 duck 为基础，频谱让位仅在同 stem 测量有证据时启用。",
    boundary: "本轮 7.668 dB 避让接近首轮搜索上沿，真人片段必须重点听抽吸感。",
  },
  {
    code: "S3",
    candidateId: "sound-technique.semantic-sfx-cue.v1",
    group: "声音",
    title: "语义音效锚点",
    summary: "音效只服务视觉落点、语义转折或人物动作中的一个明确 beat。",
    recommendation: "revise",
    recommendationText: "建议修改后保留：保留语义锚点、授权和密度门，禁止固定音效字典。",
    boundary: "当前 cue 全部为程序化素材；真实素材必须逐项记录来源与使用边界。",
  },
  {
    code: "D1",
    candidateId: "director-principle.freeze-structure-before-packaging.v1",
    group: "Director 原则",
    title: "先冻结结构再包装",
    principleId: "director-principle.freeze-structure-before-packaging.v1",
    summary: "方向、粗剪和语义时间线稳定后，再投入字幕、动效与声音包装。",
    recommendation: "retain",
    recommendationText: "建议保留进入真实片段试用：它能阻止包装掩盖内容或素材缺陷。",
    boundary: "不改变意义和时间线的确定性技术修复可以提前执行。",
  },
  {
    code: "D2",
    candidateId: "director-principle.semantic-role-before-effect.v1",
    group: "Director 原则",
    title: "先语义角色再选效果",
    principleId: "director-principle.semantic-role-before-effect.v1",
    summary: "先标记钩子、证据、转折、步骤或结果，再选择字幕、动效和声音。",
    recommendation: "retain",
    recommendationText: "建议保留进入真实片段试用：检查每个效果是否能说出清楚的表达职责。",
    boundary: "降噪、裁切等技术修复只需标明是技术动作，不必虚构叙事职责。",
  },
  {
    code: "D3",
    candidateId: "director-principle.offer-choices-then-freeze-after-evidence.v1",
    group: "Director 原则",
    title: "少量选择，证据后冻结",
    principleId: "director-principle.offer-choices-then-freeze-after-evidence.v1",
    summary: "审美不确定时只给少量差异清楚的候选，允许全部不接受，多轮证据后再冻结。",
    recommendation: "retain",
    recommendationText: "建议保留进入真实片段试用：继续坚持少候选、单变量和整组拒绝。",
    boundary: "确定性技术约束可以直接走一条路径，但仍需技术检查。",
  },
]);

const MOTION_SPECS = Object.freeze({
  M1: {
    directory: [".cache", "technique-reconstructions", "2026-07-24-motion-batch-1", "pause-aware-follow-caption"],
    metric: "6.3 秒 · 1080×1920 · 暂停区间两帧源图哈希一致",
  },
  M2: {
    directory: [".cache", "technique-reconstructions", "2026-07-24-motion-batch-1", "semantic-layout-router"],
    metric: "7.4 秒 · 1080×1920 · 单重点 / 步骤 / 证据三态按序出现",
  },
});

const SOUND_LABELS = Object.freeze({
  A: { title: "A｜不避让", note: "同一 voice-like 与 BGM 的基线。" },
  B: { title: "B｜全带 duck", note: "人声活动区间让音乐整体避让。" },
  C: { title: "C｜duck + 实测频带让位", note: "在 B 基础上，对本轮实测 760 Hz 冲突点额外让位。" },
  S: { title: "S｜C + 三个语义 cue", note: "比较 cue 是否增加意义，而不是只增加热闹。" },
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assertFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${label} is missing: ${file}`);
  }
}

function assertInside(parent, target, label) {
  const relative = path.relative(parent, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child of ${parent}`);
  }
}

export function resolveSoundVariantFile(soundRoot, variantPath) {
  if (typeof variantPath !== "string" || !variantPath.trim()) {
    throw new Error("sound variant path must be a non-empty string");
  }
  const resolvedRoot = path.resolve(soundRoot);
  const resolvedFile = path.resolve(resolvedRoot, variantPath.replaceAll("\\", "/"));
  assertInside(resolvedRoot, resolvedFile, "sound variant media");
  return resolvedFile;
}

export function reviewCandidateContentHash({
  candidateId,
  title,
  summary,
  boundary,
  recommendation,
  recommendationText,
  scenarios = [],
  media = null,
}) {
  return candidatePrincipleContentHash({
    candidateId,
    title,
    summary,
    boundary,
    recommendation,
    recommendationText,
    scenarios,
    media,
  });
}

export function reviewEvidenceSetHash(items) {
  return candidatePrincipleContentHash({
    reviewId: REVIEW_ID,
    candidates: items.map(item => ({
      candidateId: item.candidateId,
      candidateContentHash: item.candidateContentHash,
    })),
  });
}

function toRelativeUrl(fromDirectory, targetFile) {
  const relative = path.relative(fromDirectory, targetFile).replaceAll("\\", "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeScriptJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function renderScenarioRows(scenarios = []) {
  const labels = { applicable: "适用", blocked: "阻断", degraded: "边界" };
  return scenarios.map(item => `
    <li class="scenario scenario-${escapeHtml(item.category)}">
      <span>${escapeHtml(labels[item.category] || item.category)}</span>
      <p>${escapeHtml(item.title)}</p>
      <code>${escapeHtml(item.resultRuleId)}</code>
    </li>`).join("");
}

function renderDecisionControls(code) {
  const options = [
    ["retain_for_real_clip_trial", "保留进入真实片段试用"],
    ["revise_then_review", "修改后再审"],
    ["delete_candidate", "删除"],
  ];
  return `<fieldset class="decision-box">
    <legend>你的判断</legend>
    <div class="decision-options">${options.map(([value, label]) => `
      <label><input type="radio" name="decision-${code}" value="${value}"> <span>${label}</span></label>`).join("")}
    </div>
    <label class="note-label" for="note-${code}">可选说明</label>
    <textarea id="note-${code}" data-note-for="${code}" rows="2" placeholder="例如：保留原则，但真实片段要重点验证……"></textarea>
  </fieldset>`;
}

function renderCandidateCard(item) {
  const recommendationClass = item.recommendation === "retain" ? "recommend-retain" : "recommend-revise";
  const scenarios = item.scenarios?.length
    ? `<details class="scenario-details"><summary>查看适用、阻断与边界场景</summary><ul>${renderScenarioRows(item.scenarios)}</ul></details>`
    : "";
  const media = item.media
    ? `<div class="media-panel">
        <video controls playsinline preload="metadata" src="${escapeHtml(item.media.src)}"></video>
        <div><strong>${escapeHtml(item.media.metric)}</strong><code>SHA-256 ${escapeHtml(item.media.sha256)}</code></div>
      </div>`
    : "";
  return `<article class="candidate-card" data-review-code="${item.code}" data-candidate-id="${escapeHtml(item.candidateId)}" data-candidate-content-hash="${escapeHtml(item.candidateContentHash)}" id="candidate-${item.code}">
    <header>
      <span class="review-code">${item.code}</span>
      <div><p>${escapeHtml(item.group)}</p><h3>${escapeHtml(item.title)}</h3></div>
    </header>
    <div class="candidate-identity"><code>${escapeHtml(item.candidateId)}</code><code>candidate SHA-256 ${escapeHtml(item.candidateContentHash)}</code></div>
    <p class="candidate-summary">${escapeHtml(item.summary)}</p>
    <div class="recommendation ${recommendationClass}"><b>Codex 建议</b><span>${escapeHtml(item.recommendationText)}</span></div>
    <p class="boundary"><b>边界：</b>${escapeHtml(item.boundary)}</p>
    ${media}
    ${scenarios}
    ${renderDecisionControls(item.code)}
  </article>`;
}

function renderSoundLab(soundMedia) {
  return `<section class="sound-lab" id="sound-comparison">
    <div class="section-heading">
      <span>同一组 stems · 四个版本</span>
      <h2>声音试听对照</h2>
      <p>先听 A，再听 B / C / S。四个版本已做等响度处理，音量变小本身不能冒充更清楚。</p>
    </div>
    <div class="sound-grid">${soundMedia.map(item => `
      <article class="sound-item" data-sound-variant="${item.id}">
        <div class="sound-title"><span>${item.id}</span><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.note)}</p></div></div>
        <video controls playsinline preload="metadata" src="${escapeHtml(item.src)}"></video>
        <dl>
          <div><dt>LUFS</dt><dd>${item.integratedLufs}</dd></div>
          <div><dt>真峰值</dt><dd>${item.truePeakDbtp} dBTP</dd></div>
          <div><dt>哈希</dt><dd><code>${escapeHtml(item.sha256.slice(0, 12))}…</code></dd></div>
        </dl>
      </article>`).join("")}</div>
  </section>`;
}

function renderHtml(reviewData) {
  const byCode = new Map(reviewData.items.map(item => [item.code, item]));
  const contentCards = ["C1", "C2", "C3", "M3", "D1", "D2", "D3"].map(code => renderCandidateCard(byCode.get(code))).join("");
  const motionCards = ["M1", "M2"].map(code => renderCandidateCard(byCode.get(code))).join("");
  const soundCards = ["S1", "S2", "S3"].map(code => renderCandidateCard(byCode.get(code))).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Koubo Agent 首批第二级候选审核</title>
  <style>
    :root{color-scheme:dark;--bg:#071116;--panel:#0f2028;--panel2:#132b34;--line:#284751;--text:#f4f8f7;--muted:#9fb3b8;--teal:#69e6c4;--cyan:#68c9ff;--amber:#f2cf70;--red:#ff8b7c;--ink:#031613}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 85% 0,rgba(58,142,146,.24),transparent 34%),radial-gradient(circle at 0 35%,rgba(46,100,133,.17),transparent 30%),var(--bg);color:var(--text);font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif}
    button,input,textarea{font:inherit}button{cursor:pointer}.shell{width:min(1220px,calc(100% - 32px));margin:0 auto;padding:46px 0 130px}.hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:end}.eyebrow,.section-heading>span{color:var(--teal);font-weight:850;letter-spacing:.08em;text-transform:uppercase}.hero h1{max-width:850px;margin:8px 0 14px;font-size:clamp(34px,6vw,70px);line-height:1.04;letter-spacing:-.04em}.hero p{max-width:820px;margin:0;color:var(--muted);font-size:17px}.hero-metric{min-width:220px;padding:18px;border:1px solid var(--line);border-radius:18px;background:rgba(15,32,40,.84)}.hero-metric strong{display:block;font-size:40px;color:var(--teal)}.candidate-banner{margin-top:24px;padding:16px 18px;border:1px solid #56603d;border-radius:14px;background:#222819;color:#e9efbd;font-weight:750}.quick-nav{display:flex;flex-wrap:wrap;gap:9px;margin-top:24px}.quick-nav a{padding:8px 13px;border:1px solid var(--line);border-radius:99px;color:var(--text);text-decoration:none;background:rgba(15,32,40,.7)}.quick-nav a:hover{border-color:var(--teal)}
    .section{margin-top:54px}.section-heading{max-width:820px}.section-heading h2{margin:5px 0 8px;font-size:clamp(28px,4vw,44px);line-height:1.1}.section-heading p{margin:0;color:var(--muted)}.candidate-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:22px}.candidate-card,.sound-lab{border:1px solid var(--line);border-radius:22px;background:linear-gradient(145deg,rgba(19,43,52,.94),rgba(11,26,33,.94));box-shadow:0 20px 60px rgba(0,0,0,.16)}.candidate-card{padding:22px}.candidate-card>header{display:flex;align-items:center;gap:14px}.candidate-card header p{margin:0;color:var(--muted);font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.candidate-card h3{margin:1px 0 0;font-size:25px;line-height:1.2}.review-code{display:grid;place-items:center;flex:0 0 54px;height:54px;border-radius:16px;background:var(--teal);color:var(--ink);font-size:20px;font-weight:950}.candidate-identity{display:grid;gap:3px;margin:14px 0 0;padding:9px 11px;border-radius:10px;background:rgba(4,16,21,.62);color:var(--muted);font-size:10px;word-break:break-all}.candidate-summary{min-height:48px;margin:18px 0 14px}.recommendation{display:grid;grid-template-columns:auto 1fr;gap:11px;padding:12px 14px;border-radius:13px}.recommendation b{white-space:nowrap}.recommend-retain{background:rgba(105,230,196,.1);border:1px solid rgba(105,230,196,.32)}.recommend-revise{background:rgba(242,207,112,.1);border:1px solid rgba(242,207,112,.34)}.boundary{color:var(--muted)}.boundary b{color:var(--amber)}
    .scenario-details{margin:16px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:12px 0}.scenario-details summary{cursor:pointer;color:var(--cyan);font-weight:800}.scenario-details ul{display:grid;gap:8px;margin:12px 0 0;padding:0;list-style:none}.scenario{display:grid;grid-template-columns:54px 1fr;gap:7px 11px;padding:10px;border-radius:10px;background:rgba(6,19,24,.7)}.scenario span{grid-row:1 / span 2;font-weight:900}.scenario-applicable span{color:var(--teal)}.scenario-blocked span{color:var(--red)}.scenario-degraded span{color:var(--amber)}.scenario p{margin:0}.scenario code{color:var(--muted);font-size:11px;word-break:break-all}
    .media-panel{display:grid;grid-template-columns:210px 1fr;gap:16px;align-items:center;margin:16px 0;padding:12px;border:1px solid var(--line);border-radius:15px;background:#081820}.media-panel video{width:100%;aspect-ratio:9/16;border-radius:10px;background:#000}.media-panel strong,.media-panel code{display:block}.media-panel code{margin-top:8px;color:var(--muted);font-size:10px;word-break:break-all}.decision-box{margin-top:18px;padding:14px;border:1px solid var(--line);border-radius:14px}.decision-box legend{padding:0 7px;color:var(--cyan);font-weight:900}.decision-options{display:grid;gap:8px}.decision-options label{display:flex;gap:8px;align-items:center;padding:9px 10px;border-radius:9px;background:rgba(5,20,25,.68)}.decision-options input{accent-color:var(--teal)}.note-label{display:block;margin-top:12px;color:var(--muted);font-weight:800}.decision-box textarea{width:100%;margin-top:5px;padding:10px;border:1px solid var(--line);border-radius:9px;background:#07161d;color:var(--text);resize:vertical}
    .sound-lab{margin-top:22px;padding:24px}.sound-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:20px}.sound-item{padding:13px;border:1px solid var(--line);border-radius:15px;background:#081820}.sound-title{display:flex;gap:10px;align-items:flex-start}.sound-title>span{display:grid;place-items:center;flex:0 0 36px;height:36px;border-radius:11px;background:var(--cyan);color:#05151b;font-weight:950}.sound-title h3{margin:0;font-size:17px}.sound-title p{min-height:55px;margin:4px 0;color:var(--muted);font-size:12px}.sound-item video{width:100%;margin-top:10px;aspect-ratio:9/16;border-radius:10px;background:#000}.sound-item dl{display:grid;gap:5px;margin:10px 0 0}.sound-item dl>div{display:flex;justify-content:space-between;gap:8px}.sound-item dt{color:var(--muted)}.sound-item dd{margin:0}
    .review-bar{position:fixed;z-index:20;left:50%;bottom:15px;display:grid;grid-template-columns:minmax(230px,1fr) auto;gap:15px;align-items:center;width:min(1100px,calc(100% - 30px));padding:13px 15px;border:1px solid #3f626c;border-radius:17px;background:rgba(9,25,31,.96);box-shadow:0 18px 70px rgba(0,0,0,.45);transform:translateX(-50%);backdrop-filter:blur(14px)}.progress-line{height:7px;margin-top:7px;border-radius:99px;background:#243a42;overflow:hidden}.progress-line i{display:block;width:0;height:100%;background:linear-gradient(90deg,var(--teal),var(--cyan));transition:width .2s}.review-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}.review-actions button{padding:10px 13px;border:1px solid var(--line);border-radius:10px;background:#17323c;color:var(--text);font-weight:850}.review-actions .reject-all{border-color:#78483f;background:#351d1b;color:#ffd5cf}.review-actions .export{border:0;background:var(--teal);color:var(--ink)}.review-message{color:var(--muted);font-size:12px}
    @media(max-width:980px){.sound-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.hero{grid-template-columns:1fr}.hero-metric{width:220px}.review-bar{grid-template-columns:1fr}.review-actions{justify-content:flex-start}}
    @media(max-width:720px){.shell{width:min(100% - 20px,1220px);padding-top:28px}.candidate-grid,.sound-grid{grid-template-columns:1fr}.candidate-card,.sound-lab{border-radius:17px}.media-panel{grid-template-columns:1fr}.media-panel video{max-height:520px}.recommendation{grid-template-columns:1fr}.review-bar{bottom:8px;width:calc(100% - 16px)}.review-actions button{flex:1 1 140px}.scenario{grid-template-columns:48px 1fr}}
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div><span class="eyebrow">Koubo · Agent Knowledge Lab</span><h1>首批 12 项候选知识<br>第二级候选审核</h1><p>本页只判断候选能否取得真实片段试用准入。先看场景边界和原创沙盒证据，再逐项保留、要求修改或删除，也可以整组全部不接受。</p></div>
      <div class="hero-metric"><span>本批候选</span><strong>12</strong><small>7 条原则 · 2 项画面 · 3 项声音</small></div>
    </section>
    <div class="candidate-banner">Candidate-only：这是“真实片段试用准入”的第二级候选审核，不是正式知识晋升；本页不会改变运行规则、默认引擎或任何外部状态。</div>
    <nav class="quick-nav" aria-label="审核分组"><a href="#principles">内容与 Director</a><a href="#motion">字幕与动效</a><a href="#sound-comparison">声音试听</a><a href="#sound-items">声音条目</a></nav>

    <section class="section" id="principles"><div class="section-heading"><span>7 项场景合同</span><h2>内容与 Director</h2><p>每条都有适用、阻断和边界场景；技术通过不替代你的判断。</p></div><div class="candidate-grid">${contentCards}</div></section>
    <section class="section" id="motion"><div class="section-heading"><span>2 项原创离线样片</span><h2>字幕与动效</h2><p>直接播放 M1 / M2，重点看暂停保持、信息顺序和画面是否真的帮助理解。</p></div><div class="candidate-grid">${motionCards}</div></section>
    ${renderSoundLab(reviewData.soundMedia)}
    <section class="section" id="sound-items"><div class="section-heading"><span>3 项声音判断</span><h2>声音候选</h2><p>S1 看安全底线，S2 听避让是否自然，S3 判断 cue 是否增加了新意义。</p></div><div class="candidate-grid">${soundCards}</div></section>
  </main>

  <aside class="review-bar" aria-label="审核进度">
    <div><strong id="review-progress">已选择 0 / 12</strong><div class="progress-line"><i id="review-progress-fill"></i></div><div class="review-message" id="review-message">选择会自动保存在这台设备的浏览器中。</div></div>
    <div class="review-actions"><button type="button" id="clear-review">清空本页选择</button><button type="button" class="reject-all" id="reject-whole-set">整组全部不接受</button><button type="button" class="export" id="export-review">导出 JSON</button></div>
  </aside>

  <script id="review-data" type="application/json">${safeScriptJson(reviewData)}</script>
  <script>
    (()=>{
      const data=JSON.parse(document.getElementById("review-data").textContent);
      const validDecisions=new Set(["retain_for_real_clip_trial","revise_then_review","delete_candidate"]);
      const blankItems=()=>Object.fromEntries(data.items.map(item=>[item.code,{decision:null,note:""}]));
      let state={schemaVersion:data.schemaVersion,reviewId:data.reviewId,evidenceSetHash:data.evidenceSetHash,candidateStatus:"candidate",reviewStage:data.reviewStage,admissionTarget:data.admissionTarget,wholeSetRejected:false,updatedAt:null,items:blankItems()};
      try{
        const saved=JSON.parse(localStorage.getItem(data.storageKey)||"null");
        if(saved&&saved.schemaVersion===data.schemaVersion&&saved.reviewId===data.reviewId&&saved.evidenceSetHash===data.evidenceSetHash){
          for(const item of data.items){
            const prior=saved.items?.[item.code];
            if(prior&&validDecisions.has(prior.decision)) state.items[item.code].decision=prior.decision;
            if(prior&&typeof prior.note==="string") state.items[item.code].note=prior.note.slice(0,2000);
          }
          state.wholeSetRejected=saved.wholeSetRejected===true;
          state.updatedAt=saved.updatedAt||null;
        }
      }catch{}

      const progress=document.getElementById("review-progress");
      const fill=document.getElementById("review-progress-fill");
      const message=document.getElementById("review-message");
      function decidedCount(){return data.items.filter(item=>validDecisions.has(state.items[item.code].decision)).length}
      function syncControls(){
        for(const item of data.items){
          const value=state.items[item.code];
          document.querySelectorAll('input[name="decision-'+item.code+'"]').forEach(input=>{input.checked=input.value===value.decision});
          const note=document.querySelector('[data-note-for="'+item.code+'"]');
          if(note&&note.value!==value.note) note.value=value.note;
        }
        const count=decidedCount();
        progress.textContent="已选择 "+count+" / "+data.items.length;
        fill.style.width=(count/data.items.length*100)+"%";
        message.textContent=state.wholeSetRejected?"当前结果：整组全部不接受。":"选择会自动保存在这台设备的浏览器中。";
      }
      function save(){
        state.updatedAt=new Date().toISOString();
        try{localStorage.setItem(data.storageKey,JSON.stringify(state))}catch{}
        syncControls();
      }
      document.querySelectorAll('input[type="radio"][name^="decision-"]').forEach(input=>input.addEventListener("change",event=>{
        const code=event.target.name.replace("decision-","");
        state.items[code].decision=event.target.value;
        state.wholeSetRejected=false;
        save();
      }));
      document.querySelectorAll("[data-note-for]").forEach(input=>input.addEventListener("input",event=>{
        state.items[event.target.dataset.noteFor].note=event.target.value.slice(0,2000);
        save();
      }));
      document.getElementById("reject-whole-set").addEventListener("click",()=>{
        if(!window.confirm("确认将本批 12 项候选全部标记为删除？这仍只是第二级候选审核，不会产生正式知识晋升。")) return;
        for(const item of data.items) state.items[item.code].decision="delete_candidate";
        state.wholeSetRejected=true;
        save();
        window.scrollTo({top:0,behavior:"smooth"});
      });
      document.getElementById("clear-review").addEventListener("click",()=>{
        if(!window.confirm("清空本页已保存的选择？")) return;
        state={schemaVersion:data.schemaVersion,reviewId:data.reviewId,evidenceSetHash:data.evidenceSetHash,candidateStatus:"candidate",reviewStage:data.reviewStage,admissionTarget:data.admissionTarget,wholeSetRejected:false,updatedAt:new Date().toISOString(),items:blankItems()};
        try{localStorage.removeItem(data.storageKey)}catch{}
        syncControls();
      });
      document.getElementById("export-review").addEventListener("click",()=>{
        const count=decidedCount();
        if(count!==data.items.length&&!window.confirm("还有 "+(data.items.length-count)+" 项未选择，仍导出当前未完成的第二级候选审核 JSON？")) return;
        const payload={
          schemaVersion:data.schemaVersion,
          reviewId:data.reviewId,
          candidateStatus:"candidate",
          reviewStage:data.reviewStage,
          admissionTarget:data.admissionTarget,
          notKnowledgePromotion:true,
          evidenceSetHash:data.evidenceSetHash,
          classification:state.wholeSetRejected?"whole_set_rejected":"item_level_review",
          wholeSetRejected:state.wholeSetRejected,
          completion:{decided:count,total:data.items.length,complete:count===data.items.length},
          updatedAt:state.updatedAt||new Date().toISOString(),
          items:data.items.map(item=>({code:item.code,candidateId:item.candidateId,contentHash:item.candidateContentHash,decision:state.items[item.code].decision,note:state.items[item.code].note}))
        };
        const blob=new Blob([JSON.stringify(payload,null,2)+"\\n"],{type:"application/json"});
        const href=URL.createObjectURL(blob);
        const link=document.createElement("a");
        link.href=href;link.download="koubo-agent-training-batch-1-review.json";link.click();
        setTimeout(()=>URL.revokeObjectURL(href),1000);
        message.textContent=count===data.items.length?"已导出完整结果。":"已导出当前结果，还有 "+(data.items.length-count)+" 项未选择。";
      });
      syncControls();
    })();
  </script>
</body>
</html>`;
}

function buildReviewData(repositoryRoot, outputFile) {
  const outputDirectory = path.dirname(outputFile);
  const fixtureFile = path.join(repositoryRoot, "tests", "fixtures", "candidate-principle-scenarios.json");
  assertFile(fixtureFile, "candidate-principle fixture");
  const fixture = readJson(fixtureFile);
  if (!Array.isArray(fixture.scenarios) || fixture.scenarios.length !== 21) {
    throw new Error("candidate-principle fixture must contain 21 scenarios");
  }
  const evaluations = evaluateCandidatePrincipleScenarios(fixture.scenarios);
  const evaluationById = new Map(evaluations.map(item => [item.scenarioId, item]));
  const wholeSet = recordWholeSetRejection({
    reviewId: fixture.wholeSetReview.reviewId,
    evaluations,
    reason: fixture.wholeSetReview.reason,
  });
  const principleScenarioHash = candidatePrincipleContentHash(
    evaluations.map(item => item.evaluationHash).sort()
  );

  const motionEvidence = {};
  for (const [code, spec] of Object.entries(MOTION_SPECS)) {
    const directory = path.join(repositoryRoot, ...spec.directory);
    const manifestFile = path.join(directory, "technique-sandbox-manifest.json");
    const qaFile = path.join(directory, "qa-report.json");
    const renderFile = path.join(directory, "render.mp4");
    assertFile(manifestFile, `${code} manifest`);
    assertFile(qaFile, `${code} QA`);
    assertFile(renderFile, `${code} render`);
    const manifest = readJson(manifestFile);
    const qa = readJson(qaFile);
    const actualHash = sha256File(renderFile);
    if (qa.renderHash !== actualHash || qa.failures?.length || !qa.eligibleTransition) {
      throw new Error(`${code} render evidence does not match its QA record`);
    }
    motionEvidence[code] = {
      src: toRelativeUrl(outputDirectory, renderFile),
      sha256: actualHash,
      metric: spec.metric,
      durationSeconds: manifest.composition.durationSeconds,
      hyperframesVersion: manifest.hyperframesVersion,
    };
  }

  const soundRoot = path.join(repositoryRoot, ".cache", "agent-training-batch-1", "sound");
  const soundManifestFile = path.join(soundRoot, "recreation-manifest.json");
  const soundQaFile = path.join(soundRoot, "qa.json");
  assertFile(soundManifestFile, "sound manifest");
  assertFile(soundQaFile, "sound QA");
  const soundManifest = readJson(soundManifestFile);
  const soundQa = readJson(soundQaFile);
  if (soundManifest.technicalPass !== true || soundQa.technicalPass !== true) {
    throw new Error("sound recreation technical evidence is incomplete");
  }
  const soundMedia = soundManifest.variants.map(variant => {
    const file = resolveSoundVariantFile(soundRoot, variant.mp4.path);
    assertFile(file, `sound ${variant.id} media`);
    const actualHash = sha256File(file);
    if (actualHash !== variant.mp4.sha256 || soundQa.variants?.[variant.id]?.passed !== true) {
      throw new Error(`sound ${variant.id} evidence does not match its QA record`);
    }
    return {
      id: variant.id,
      title: SOUND_LABELS[variant.id].title,
      note: SOUND_LABELS[variant.id].note,
      src: toRelativeUrl(outputDirectory, file),
      sha256: actualHash,
      integratedLufs: variant.mp4.integratedLufs,
      truePeakDbtp: variant.mp4.truePeakDbtp,
    };
  });
  if (soundMedia.map(item => item.id).join("") !== "ABCS") {
    throw new Error("sound review needs A, B, C, and S media in order");
  }
  const soundMediaEvidence = soundMedia.map(item => ({
    id: item.id,
    sha256: item.sha256,
    integratedLufs: item.integratedLufs,
    truePeakDbtp: item.truePeakDbtp,
  }));

  const items = CANDIDATE_SPECS.map(spec => {
    const scenarios = spec.principleId
      ? fixture.scenarios
        .filter(item => item.principleId === spec.principleId)
        .map(item => ({
          id: item.id,
          category: item.category,
          title: item.title,
          resultRuleId: evaluationById.get(item.id)?.selectedRuleId,
        }))
      : [];
    if (spec.principleId && scenarios.length !== 3) {
      throw new Error(`${spec.code} must have three principle scenarios`);
    }
    const media = motionEvidence[spec.code] || null;
    const mediaEvidence = spec.code.startsWith("S")
      ? soundMediaEvidence
      : media
        ? {
            sha256: media.sha256,
            metric: media.metric,
            durationSeconds: media.durationSeconds,
            hyperframesVersion: media.hyperframesVersion,
          }
        : null;
    const item = {
      code: spec.code,
      candidateId: spec.candidateId,
      group: spec.group,
      title: spec.title,
      summary: spec.summary,
      recommendation: spec.recommendation,
      recommendationText: spec.recommendationText,
      boundary: spec.boundary,
      scenarios,
      media,
      mediaEvidence,
    };
    return {
      ...item,
      candidateContentHash: reviewCandidateContentHash({ ...item, media: mediaEvidence }),
    };
  });
  if (items.map(item => item.code).join(",") !== REVIEW_CODES.join(",")) {
    throw new Error("review item order or coverage changed");
  }
  if (new Set(items.map(item => item.candidateId)).size !== REVIEW_CODES.length) {
    throw new Error("review candidate IDs must be unique");
  }
  const evidenceSetHash = reviewEvidenceSetHash(items);
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    reviewId: REVIEW_ID,
    candidateStatus: "candidate",
    reviewStage: "second_level_candidate_review",
    admissionTarget: "real_clip_trial",
    notKnowledgePromotion: true,
    storageKey: `${STORAGE_KEY_PREFIX}.${evidenceSetHash}`,
    evidenceSetHash,
    principleScenarioHash,
    wholeSetHash: wholeSet.reviewHash,
    items,
    soundMedia,
  };
}

export async function buildAgentTrainingReview({
  repositoryRoot = defaultRepositoryRoot,
  outputFile = path.join(repositoryRoot, ".cache", "agent-training-batch-1", "review", "index.html"),
} = {}) {
  const resolvedRoot = path.resolve(repositoryRoot);
  const resolvedOutput = path.resolve(outputFile);
  const allowedRoot = path.join(resolvedRoot, ".cache", "agent-training-batch-1");
  assertInside(allowedRoot, resolvedOutput, "review output");
  const reviewData = buildReviewData(resolvedRoot, resolvedOutput);
  const html = renderHtml(reviewData);
  await fsp.mkdir(path.dirname(resolvedOutput), { recursive: true });
  await fsp.writeFile(resolvedOutput, html, "utf8");
  return {
    outputFile: resolvedOutput,
    itemCount: reviewData.items.length,
    mediaCount: reviewData.soundMedia.length + reviewData.items.filter(item => item.media).length,
    evidenceSetHash: reviewData.evidenceSetHash,
    bytes: Buffer.byteLength(html),
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") {
      values.outputFile = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (values.outputFile) values.outputFile = path.resolve(defaultRepositoryRoot, values.outputFile);
  return values;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = await buildAgentTrainingReview(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
