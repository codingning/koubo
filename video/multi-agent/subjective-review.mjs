const DECISION_REJECT_ALL = "reject-all";
const REASON_OPTIONS = [
  "信息不清",
  "字幕表现不合适",
  "动效或卡片喧宾夺主",
  "声音节奏不合适",
  "模板感太强",
  "不像我的账号",
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function isHash(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

export function normalizeSubjectiveSamples(samples) {
  if (!Array.isArray(samples) || !samples.length) {
    throw new Error("at least one subjective sample is required");
  }
  const ids = new Set();
  return samples.map(sample => {
    if (sample?.mediaKind !== "real-talking-head") {
      throw new Error(`subjective style review requires real talking-head media: ${sample?.id || "unknown"}`);
    }
    if (!sample.id || ids.has(sample.id)) throw new Error("subjective sample IDs must be unique");
    ids.add(sample.id);
    if (!sample.focus || !sample.question) throw new Error(`sample ${sample.id} needs a focus and question`);
    if (!Array.isArray(sample.reviewHints) || sample.reviewHints.length < 2) {
      throw new Error(`sample ${sample.id} needs at least two review hints`);
    }
    if (!Array.isArray(sample.candidates) || sample.candidates.length < 2) {
      throw new Error(`sample ${sample.id} needs at least two candidates`);
    }
    const labels = new Set();
    const candidates = sample.candidates.map(candidate => {
      if (!/^[A-Z]$/.test(String(candidate.label || "")) || labels.has(candidate.label)) {
        throw new Error(`sample ${sample.id} candidate labels must be unique uppercase letters`);
      }
      labels.add(candidate.label);
      if (!isHash(candidate.renderHash)) throw new Error(`sample ${sample.id} candidate hash is invalid`);
      if (!/^media\/[A-Za-z0-9._-]+\.mp4$/.test(String(candidate.publicFile || ""))) {
        throw new Error(`sample ${sample.id} candidate file is not a blind public media path`);
      }
      return {
        label: candidate.label,
        renderHash: candidate.renderHash,
        publicFile: candidate.publicFile,
      };
    });
    return {
      id: sample.id,
      mediaKind: sample.mediaKind,
      focus: String(sample.focus),
      question: String(sample.question),
      reviewHints: sample.reviewHints.map(String),
      duration: Number(sample.duration || 0),
      candidates,
    };
  });
}

export function validateSubjectiveReview(payload, expectedSamples) {
  const expected = normalizeSubjectiveSamples(expectedSamples);
  if (!Array.isArray(payload?.samples)) throw new Error("review samples are required");
  const received = new Map(payload.samples.map(sample => [sample.sampleId, sample]));
  if (received.size !== expected.length) throw new Error("every real sample needs one review");
  const samples = expected.map(sample => {
    const review = received.get(sample.id);
    if (!review) throw new Error(`review is missing sample ${sample.id}`);
    const decisions = new Set([
      ...sample.candidates.map(candidate => candidate.label),
      DECISION_REJECT_ALL,
    ]);
    if (!decisions.has(review.decision)) throw new Error(`sample ${sample.id} needs one valid decision`);
    const reasons = Array.isArray(review.reasons)
      ? [...new Set(review.reasons.map(String).map(value => value.trim()).filter(Boolean))]
      : [];
    const note = String(review.note || "").trim();
    if (!reasons.length && !note) throw new Error(`sample ${sample.id} needs at least one concrete reason`);
    return {
      sampleId: sample.id,
      decision: review.decision,
      reasons,
      note,
    };
  });
  return {
    valid: true,
    reviewerType: "human",
    samples,
    autoPublish: false,
    memoryPromotion: false,
  };
}

export function buildSubjectiveReviewHtml({ runId, samples }) {
  const normalized = normalizeSubjectiveSamples(samples);
  const sections = normalized.map((sample, index) => `
    <section class="sample" data-sample="${escapeHtml(sample.id)}">
      <header>
        <span>真实口播 ${index + 1} · ${escapeHtml(sample.focus)}</span>
        <h2>${escapeHtml(sample.question)}</h2>
        <ul>${sample.reviewHints.map(hint => `<li>${escapeHtml(hint)}</li>`).join("")}</ul>
      </header>
      <div class="candidates">${sample.candidates.map(candidate => `
        <article>
          <div class="candidate-head"><strong>候选 ${candidate.label}</strong><code>${candidate.renderHash.slice(0, 12)}…</code></div>
          <video controls preload="metadata" src="${escapeHtml(candidate.publicFile)}"></video>
          <label class="decision"><input type="radio" name="decision-${escapeHtml(sample.id)}" value="${candidate.label}"> 候选 ${candidate.label} 值得继续</label>
        </article>`).join("")}</div>
      <label class="reject"><input type="radio" name="decision-${escapeHtml(sample.id)}" value="${DECISION_REJECT_ALL}"> 全组不合格，不选一个“相对没那么差”的</label>
      <fieldset>
        <legend>主要判断依据（可多选）</legend>
        <div class="reasons">${REASON_OPTIONS.map(reason => `<label><input type="checkbox" data-reason="${escapeHtml(sample.id)}" value="${escapeHtml(reason)}"> ${escapeHtml(reason)}</label>`).join("")}</div>
      </fieldset>
      <label class="notes">一处具体例子；如果是全程问题可以写“全程”<textarea data-note="${escapeHtml(sample.id)}" rows="3" placeholder="例如：全程模板感太强；或 03:20 的卡片盖过了口播重点。"></textarea></label>
    </section>`).join("");
  const clientSamples = normalized.map(sample => ({
    id: sample.id,
    labels: sample.candidates.map(candidate => candidate.label),
  }));
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Koubo 真实口播集中盲审</title>
<style>
:root{color-scheme:dark;--bg:#07131d;--card:#102431;--line:#294554;--teal:#55e0c5;--text:#f4f8fa;--muted:#a6bbc6;--warn:#f0cf75}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 82% 0,#153b46,transparent 38%),var(--bg);color:var(--text);font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif}main{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:46px 0 90px}.hero span,.sample header span{color:var(--teal);font-weight:850}.hero h1{margin:5px 0;font-size:clamp(30px,5vw,52px)}.hero p{max-width:900px;color:var(--muted)}.scope{padding:14px 17px;border:1px solid #5b532e;border-radius:12px;background:#242314;color:#eee2a3}.sample{margin-top:24px;padding:20px;border:1px solid var(--line);border-radius:18px;background:rgba(16,36,49,.9)}.sample h2{margin:4px 0 5px;font-size:24px}.sample header ul{margin:4px 0 0;padding-left:20px;color:var(--muted)}.candidates{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:18px}.candidates article{padding:12px;border:1px solid var(--line);border-radius:13px;background:#081a24}.candidate-head{display:flex;justify-content:space-between;gap:8px;margin-bottom:10px}.candidate-head code{color:var(--muted);font-size:10px}.candidates video{width:100%;aspect-ratio:16/9;border-radius:9px;background:#000}.decision,.reject{display:block;margin-top:10px;padding:9px 11px;border-radius:9px;background:#0c202b;cursor:pointer;font-weight:800}.reject{border:1px solid #6a5932;color:var(--warn)}fieldset{margin-top:14px;border:1px solid var(--line);border-radius:11px}legend{color:var(--muted);font-weight:800}.reasons{display:flex;flex-wrap:wrap;gap:8px 16px}.reasons label{cursor:pointer}.notes{display:block;margin-top:14px;color:var(--muted);font-weight:750}.notes textarea{width:100%;margin-top:5px;padding:10px;border:1px solid var(--line);border-radius:9px;background:#07131d;color:var(--text);font:inherit;resize:vertical}.actions{position:sticky;bottom:14px;display:flex;justify-content:space-between;align-items:center;gap:15px;margin-top:24px;padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:#102431}.actions button{padding:11px 18px;border:0;border-radius:9px;background:var(--teal);color:#05221d;font-weight:900;cursor:pointer}.actions span{color:var(--muted);font-size:12px}@media(max-width:800px){.candidates{grid-template-columns:1fr}.actions{align-items:stretch;flex-direction:column}.actions button{width:100%}}
</style></head><body><main>
<div class="hero"><span>真实口播集中盲审 · ${escapeHtml(runId)}</span><h1>审整体剪辑方案，不是做技术验收</h1><p>每组是同一段真实口播的完整剪辑方案。你在判断信息是否更容易理解、画面是否更想继续看、字幕/动效/声音是否服务表达，以及它像不像你愿意发布的账号内容。</p></div>
<div class="scope"><strong>本轮边界：</strong>这里不要求逐字校对字幕；字幕文本准确性会单独验收。编码、黑帧、响度、画面尺寸和基础音画连续性已由自动检查覆盖。发现任何明显问题仍可指出，但这里的核心是主观成片判断。允许选择“全组不合格”。</div>
${sections}
<div class="actions"><span id="status">每组做一个判断，并至少勾选或写下一条理由。</span><button id="export">导出盲审结果</button></div>
</main><script>
const samples=${JSON.stringify(clientSamples)};
document.querySelector("#export").addEventListener("click",()=>{
  const reviews=samples.map(sample=>{
    const decision=document.querySelector('input[name="decision-'+sample.id+'"]:checked')?.value||"";
    const reasons=[...document.querySelectorAll('input[data-reason="'+sample.id+'"]:checked')].map(item=>item.value);
    const note=document.querySelector('textarea[data-note="'+sample.id+'"]').value.trim();
    return {sampleId:sample.id,decision,reasons,note};
  });
  const invalid=reviews.find(item=>!item.decision||(!item.reasons.length&&!item.note));
  if(invalid){document.querySelector("#status").textContent="请完成 "+invalid.sampleId+" 的判断，并给出至少一条理由。";return}
  const payload={schemaVersion:1,runId:${JSON.stringify(runId)},reviewerType:"human",reviewedAt:new Date().toISOString(),samples:reviews,autoPublish:false,memoryPromotion:false};
  const blob=new Blob([JSON.stringify(payload,null,2)+"\\n"],{type:"application/json"});
  const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download="koubo-subjective-review-${escapeHtml(runId)}.json";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  document.querySelector("#status").textContent="已导出。这个结果不会自动发布视频或晋升记忆。";
});</script></body></html>`;
}
