(() => {
  "use strict";

  const data = window.KOUBO_DATA;
  if (!data || !Array.isArray(data.contentItems)) {
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif">内容数据未加载，请检查 web/data/content-data.js。</div>';
    return;
  }

  const storageKey = "koubo-workbench-state-v1";
  let persisted = {};
  try { persisted = JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch (_) { persisted = {}; }
  if (!persisted.items) persisted.items = {};
  if (!persisted.currentId) persisted.currentId = data.contentItems[0].id;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const byId = (id) => document.getElementById(id);
  const htmlEscape = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  const pageNames = {
    today: ["打开网页就能直接拍", "当前拍摄包"],
    script: ["完整版、精简版和提词器", "直接照着念"],
    creative: ["选择最终包装", "标题和封面"],
    shoot: ["B-roll、字幕和准备事项", "拍什么画面"],
    edit: ["视频只在本机处理", "拍完AI剪辑"],
    publish: ["审核后再手动发布", "发布文案"],
    evidence: ["只讲能证明的事实", "证据和风险"],
    roadmap: ["计划不等于完成", "30天成长路线"],
    library: ["成长版和旧基线都保留", "历史内容"]
  };

  const defaultShootChecks = [
    "已经试读一遍，口语没有拗口",
    "标题和封面与正文一致",
    "所有展示画面已完成脱敏",
    "收音、光线和背景已经准备",
    "明日挑战是实际准备继续做的任务"
  ];

  let currentView = "today";
  let currentItem = data.contentItems.find(item => item.id === persisted.currentId) || data.contentItems[0];
  let teleRunning = false;
  let teleFrame = null;
  let teleLastTime = null;
  let toastTimer = null;
  let libraryFilter = "all";
  const videoApiBase = /^https?:$/.test(window.location.protocol) ? window.location.origin : "http://127.0.0.1:8787";
  let videoServiceOnline = false;
  let serviceHealth = null;
  let contentGenerating = false;
  let selectedVideoFile = null;
  let currentVideoJob = null;
  let availableVideoJobs = [];
  let videoJobsLoading = false;
  let editExperienceMode = persisted.editExperienceMode === "demo" ? "demo" : "daily";
  let videoPollTimer = null;
  let videoJobContextToken = 0;
  const directorStageOrder = ["style_research", "content_breakdown", "keyframes", "keyframe_review", "motion_sample", "full_render"];
  const videoRunningStatuses = ["uploaded", "analyzing", "transcribing", "planning", "rendering", "revising", "researching_style", "breaking_down_content", "generating_keyframes", "rendering_sample", "rendering_final"];
  let directorWorkflowDefaults = null;
  let directorDraftConfig = null;
  let directorRenderSignature = "";
  let multiAgentStatus = null;
  let proposalBundle = null;
  let blindReviewBundle = null;
  let tutorialCheckpoint = null;
  let memoryRecords = [];
  let multiAgentReviews = null;
  let contentStrategyAnalyzing = false;
  let contentStrategyDraft = {
    direction: "",
    evidenceSummary: "",
    analysisArtifactId: "",
    analysis: null,
    confirmationArtifactId: "",
    generatedContentId: "",
  };
  const ordinaryViewerReviewCache = new Map();
  const ordinaryViewerReviewLoading = new Map();

  function itemState(item = currentItem) {
    if (!persisted.items[item.id]) {
      persisted.items[item.id] = {
        reviewStatus: item.status || "待审核",
        notes: "",
        selectedTitle: "",
        selectedCover: "",
        contentRevision: item.contentRevision || item.generatedAt || "base",
        editedScript: fullPlainText(item),
        broll: {},
        shoot: {},
        risks: {}
      };
    }
    const state = persisted.items[item.id];
    const revision = item.contentRevision || item.generatedAt || "base";
    if (state.contentRevision !== revision) {
      state.previousEditedScript = state.editedScript || "";
      state.editedScript = fullPlainText(item);
      state.contentRevision = revision;
    }
    return state;
  }

  function saveState(show = false) {
    persisted.currentId = currentItem.id;
    localStorage.setItem(storageKey, JSON.stringify(persisted));
    const indicator = byId("save-indicator");
    if (indicator) {
      indicator.textContent = "已自动保存";
      indicator.style.opacity = "1";
      setTimeout(() => { indicator.style.opacity = ".65"; }, 900);
    }
    if (show) toast("已保存在当前浏览器");
  }

  function fullSegments(item = currentItem) {
    return item.fullSegments || [{ time: "旧基线", label: "原内容", tone: "保留对照", text: item.hook || item.mainTopic }];
  }

  function fullPlainText(item = currentItem) {
    return fullSegments(item).map(segment => segment.text).join("\n\n");
  }

  function shortText(item = currentItem) {
    return item.shortScript || `${item.hook || ""}\n\n旧定位完整稿请从原文件入口打开查看。`;
  }

  function titles(item = currentItem) {
    return item.titles || [{ type: "旧基线标题", text: item.mainTopic }];
  }

  function covers(item = currentItem) {
    return item.covers || [{ id: "legacy-cover", name: "旧基线封面", copy: item.shortTopic || item.mainTopic, expression: "保留对照", composition: "打开旧素材包查看", color: "灰色", reason: "旧定位基线，不作为新定位推荐。" }];
  }

  function sourcePackageHref(item = currentItem) {
    return item.sourcePackageHref || item.legacyPath || item.sourceFiles?.find(file => file.label.includes("完整素材包"))?.path || "#";
  }

  function sourcePackagePath(item = currentItem) {
    return item.sourcePackagePath || "F:\\code\\koubo\\runs\\2026-07-15\\growth\\02_main_package.md";
  }

  function copyText(text, message = "已复制") {
    const value = String(text || "");
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(() => toast(message)).catch(() => fallbackCopy(value, message));
    } else {
      fallbackCopy(value, message);
    }
  }

  function fallbackCopy(value, message) {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try { document.execCommand("copy"); toast(message); } catch (_) { toast("复制失败，请手动选择文字"); }
    textarea.remove();
  }

  function toast(message) {
    const el = byId("toast");
    el.textContent = message;
    el.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), 1800);
  }

  function switchView(view) {
    if (!pageNames[view]) return;
    currentView = view;
    document.body.classList.toggle("is-edit-view", view === "edit");
    $$(".view").forEach(section => section.classList.toggle("is-active", section.id === `view-${view}`));
    $$(".nav-item").forEach(button => button.classList.toggle("is-active", button.dataset.view === view));
    byId("page-eyebrow").textContent = pageNames[view][0];
    byId("page-title").textContent = pageNames[view][1];
    if (view === "edit") renderEditExperienceMode();
    $(".sidebar").classList.remove("is-open");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setCurrentItem(id) {
    const next = data.contentItems.find(item => item.id === id);
    if (!next) return;
    currentItem = next;
    persisted.currentId = id;
    saveState();
    renderAll();
  }

  function renderPicker() {
    const picker = byId("content-picker");
    picker.innerHTML = data.contentItems.map(item => `<option value="${htmlEscape(item.id)}">${htmlEscape(item.day)} · ${htmlEscape(item.shortTopic)}</option>`).join("");
    picker.value = currentItem.id;
  }

  function renderStatus() {
    const state = itemState();
    const chip = byId("global-status");
    chip.textContent = state.reviewStatus;
    chip.classList.toggle("approved", state.reviewStatus === "已通过");
    chip.classList.toggle("needs-edit", state.reviewStatus === "需要修改");
    $$(".status-btn").forEach(button => button.classList.toggle("is-active", button.dataset.reviewStatus === state.reviewStatus));
    byId("review-notes").value = state.notes || "";
  }

  function renderToday() {
    byId("hero-day").textContent = `${currentItem.day} · ${currentItem.date}`;
    byId("hero-column").textContent = currentItem.column;
    byId("hero-duration").textContent = `${currentItem.durationFull || ""} / ${currentItem.durationShort || ""}`;
    byId("hero-topic").textContent = currentItem.mainTopic;
    byId("hero-hook").textContent = currentItem.hook;
    byId("hero-benefit").textContent = currentItem.audienceBenefit;
    const engagement = currentItem.engagement || {};
    const design = currentItem.structureDesign || {};
    const archetypeNames = { "evidence-story": "证据故事", "saveable-map": "可收藏路径图", "short-resonance": "短共鸣" };
    byId("structure-archetype").textContent = archetypeNames[design.archetype] || "旧稿未标注，生成新口播时自动选择";
    byId("structure-question").textContent = design.coreQuestion || "围绕一个观众问题组织整条内容。";
    byId("structure-framework").textContent = Array.isArray(design.saveableFramework) && design.saveableFramework.length
      ? design.saveableFramework.map(item => `${item.label}：${item.action}（信号：${item.expectedSignal}）`).join("；")
      : "新稿会为每一步同时给出动作和可观察信号。";
    byId("viewer-mirror").textContent = engagement.audienceMirror || currentItem.audienceBenefit || "先把个人经历翻译成观众能使用的经验。";
    byId("viewer-task").textContent = engagement.viewerTask || currentItem.actionExperiment?.viewerTask || "给观众一个今天就能完成的最小动作。";
    const tone = currentItem.creativeTone || {};
    const memeLine = tone.trendMeme?.adaptedLine || "";
    byId("humor-beat").textContent = [tone.humorBeat, memeLine].filter(Boolean).join(" · ") || "用一句自然自嘲或反差降低严肃感。";
    byId("comment-prompt").textContent = engagement.commentPrompt || "用一个具体选择题邀请观众参与下一步实验。";
    byId("follow-promise").textContent = engagement.followPromise || currentItem.storyPosition?.tomorrow || "说明下一集会验证什么真实结果。";
    byId("primary-close").textContent = engagement.primaryClose || "旧稿未标注；新稿会从评论、任务和下一次验证中只选一个主动作。";
    const referenceResearch = currentItem.referenceResearch || {};
    byId("reference-sources").textContent = Array.isArray(referenceResearch.sourceIds) && referenceResearch.sourceIds.length
      ? referenceResearch.sourceIds.join("、")
      : "新稿生成前会先核验至少一条同题完整视频。";
    byId("reference-choices").textContent = [
      ...(Array.isArray(referenceResearch.borrowedKnowledge) ? referenceResearch.borrowedKnowledge.slice(0, 2) : []),
      ...(Array.isArray(referenceResearch.structuralChoices) ? referenceResearch.structuralChoices.slice(0, 1) : [])
    ].join("；") || "只借鉴知识、结构和互动机制，不复制原句、案例或人设。";
    byId("home-script-duration").textContent = currentItem.durationFull || "约2—3分钟";
    byId("home-script-preview").textContent = fullPlainText(currentItem);
    byId("source-package-path").textContent = sourcePackagePath(currentItem);
    byId("open-source-package").href = sourcePackageHref(currentItem);
    byId("story-yesterday").textContent = currentItem.storyPosition?.yesterday || "旧定位基线内容，没有成长连续任务。";
    byId("story-today").textContent = currentItem.storyPosition?.today || "保留旧样本供对照。";
    byId("story-tomorrow").textContent = currentItem.storyPosition?.tomorrow || "打开旧素材包查看原计划。";

    const progress = currentItem.progress || ["旧定位内容已完整保留，可从历史内容打开。"];
    byId("progress-list").innerHTML = progress.map(item => `<li>${htmlEscape(item)}</li>`).join("");

    const candidateList = currentItem.candidates || [{ type: "旧定位主选题", topic: currentItem.mainTopic, score: null, result: "旧基线" }];
    byId("candidate-list").innerHTML = candidateList.map(candidate => `
      <div class="candidate-row ${candidate.result === "主选题" ? "is-main" : ""} ${candidate.score === null ? "is-empty" : ""}">
        <div class="candidate-type">${htmlEscape(candidate.type)}</div>
        <div class="candidate-topic">${htmlEscape(candidate.topic)}</div>
        <div class="candidate-score">${candidate.score === null ? "—" : candidate.score.toFixed(1)}</div>
        <div class="candidate-result">${htmlEscape(candidate.result)}</div>
      </div>`).join("");
  }

  function renderScripts() {
    const container = byId("script-segments");
    container.innerHTML = fullSegments().map(segment => `
      <article class="script-segment">
        <div class="segment-meta">
          <span class="time-badge">${htmlEscape(segment.time)}</span>
          <span class="segment-label">${htmlEscape(segment.label)}</span>
          <span class="segment-tone">情绪：${htmlEscape(segment.tone)}</span>
        </div>
        <p>${htmlEscape(segment.text)}</p>
      </article>`).join("");
    byId("script-duration").textContent = currentItem.durationFull || "—";
    byId("short-script-text").textContent = shortText();
    const state = itemState();
    byId("edited-script").value = state.editedScript || fullPlainText();
  }

  function renderCreative() {
    const state = itemState();
    const itemTitles = titles();
    byId("title-options").innerHTML = itemTitles.map((title, index) => {
      const selected = state.selectedTitle === title.text;
      return `<label class="option-item ${selected ? "is-selected" : ""}">
        <input type="radio" name="title-option" value="${htmlEscape(title.text)}" ${selected ? "checked" : ""}>
        <small>${htmlEscape(title.type)}</small><strong>${htmlEscape(title.text)}</strong>
      </label>`;
    }).join("");
    byId("selected-title-label").textContent = state.selectedTitle ? "已选择" : "未选择";
    byId("final-title").textContent = state.selectedTitle || "还没有选择";

    byId("cover-options").innerHTML = covers().map((cover, index) => `
      <button class="cover-card ${state.selectedCover === cover.id ? "is-selected" : ""}" data-cover-id="${htmlEscape(cover.id)}">
        <span class="cover-check">✓</span>
        <div class="cover-preview"><div class="cover-copy">${htmlEscape(cover.copy)}</div></div>
        <div class="cover-body">
          <h4>${htmlEscape(cover.name)}</h4>
          <p><b>表情：</b>${htmlEscape(cover.expression)}</p>
          <p><b>画面：</b>${htmlEscape(cover.composition)}</p>
          <p><b>主色：</b>${htmlEscape(cover.color)}</p>
          <p class="cover-reason">${htmlEscape(cover.reason)}</p>
        </div>
      </button>`).join("");
    const selectedCover = covers().find(cover => cover.id === state.selectedCover);
    byId("final-cover").textContent = selectedCover ? `${selectedCover.name}：${selectedCover.copy}` : "还没有选择";
  }

  function renderShoot() {
    const shooting = currentItem.shooting || {
      tone: "旧定位基线，请打开旧素材包查看。", speed: "—", framing: "—", gestures: "—", highlights: [], broll: []
    };
    const guide = [
      ["语气", shooting.tone], ["语速", shooting.speed], ["景别", shooting.framing], ["手势", shooting.gestures]
    ];
    byId("shoot-guide-list").innerHTML = guide.map(([key, value]) => `<dt>${htmlEscape(key)}</dt><dd>${htmlEscape(value)}</dd>`).join("");
    const state = itemState();
    const broll = shooting.broll || [];
    byId("broll-list").innerHTML = broll.length ? broll.map((item, index) => taskHtml("broll", index, item, !!state.broll[index])).join("") : '<div class="task-item">旧基线请打开原素材包查看B-roll。</div>';
    byId("highlight-list").innerHTML = (shooting.highlights || []).map(item => `<span class="tag">${htmlEscape(item)}</span>`).join("") || '<span class="tag">旧基线</span>';
    byId("shoot-checks").innerHTML = defaultShootChecks.map((item, index) => taskHtml("shoot", index, item, !!state.shoot[index])).join("");
    updateReadiness();
  }

  function taskHtml(group, index, label, checked) {
    const id = `${group}-${currentItem.id}-${index}`;
    return `<div class="task-item"><input id="${htmlEscape(id)}" type="checkbox" data-check-group="${group}" data-check-index="${index}" ${checked ? "checked" : ""}><label for="${htmlEscape(id)}">${htmlEscape(label)}</label></div>`;
  }

  function updateReadiness() {
    const state = itemState();
    const brollTotal = currentItem.shooting?.broll?.length || 0;
    const doneBroll = Object.values(state.broll || {}).filter(Boolean).length;
    const doneShoot = Object.values(state.shoot || {}).filter(Boolean).length;
    const total = brollTotal + defaultShootChecks.length;
    const percent = total ? Math.round((doneBroll + doneShoot) / total * 100) : 0;
    byId("readiness-value").textContent = `${percent}%`;
    byId("broll-progress").textContent = `${doneBroll}/${brollTotal} 已准备`;
  }

  function renderPublish() {
    const platform = persisted.platform || "douyin";
    setPlatform(platform, false);
  }

  function setPlatform(platform, save = true) {
    const labels = { douyin: "抖音发布文案", xiaohongshu: "小红书发布文案", weibo: "微博发布文案" };
    persisted.platform = platform;
    $$(".platform-tab").forEach(button => button.classList.toggle("is-active", button.dataset.platform === platform));
    byId("platform-name").textContent = labels[platform];
    byId("publish-text").value = currentItem.publish?.[platform] || "旧定位基线发布文案请打开原素材包查看。";
    if (save) saveState();
  }

  function renderEvidence() {
    const state = itemState();
    const evidence = currentItem.evidence || [{ name: "旧定位完整素材包", proof: "保留原热点内容", path: currentItem.legacyPath || "", public: true }];
    byId("evidence-list").innerHTML = evidence.map(item => `
      <div class="evidence-item">
        <div><strong>${htmlEscape(item.name)}</strong><p>${htmlEscape(item.proof)}</p>${item.path ? `<a class="text-button" href="${htmlEscape(item.path)}" target="_blank">打开证据</a>` : ""}</div>
        <span class="evidence-badge ${item.public === true ? "" : "caution"}">${item.public === true ? "可公开" : htmlEscape(item.public)}</span>
      </div>`).join("");
    const risks = currentItem.risks || [{ text: "旧定位基线不作为当前发布内容", done: true }];
    byId("risk-list").innerHTML = risks.map((risk, index) => taskHtml("risks", index, risk.text, state.risks[index] ?? risk.done)).join("");
    byId("source-links").innerHTML = (currentItem.sourceFiles || [{ label: "打开旧素材包", path: currentItem.legacyPath || "#" }]).map(file => `<a class="source-link" href="${htmlEscape(file.path)}" target="_blank">${htmlEscape(file.label)} ↗</a>`).join("");
    updateRiskProgress();
  }

  function updateRiskProgress() {
    const checks = $$('#risk-list input[type="checkbox"]');
    const done = checks.filter(check => check.checked).length;
    byId("risk-progress").textContent = `${done}/${checks.length} 已确认`;
  }

  function renderRoadmap() {
    byId("roadmap-grid").innerHTML = data.roadmap.map(([day, phase, challenge, status]) => {
      const phaseIndex = day <= 7 ? 1 : day <= 14 ? 2 : day <= 21 ? 3 : 4;
      return `<article class="roadmap-day phase-index-${phaseIndex} ${status === "已完成" ? "is-done" : ""} ${status === "下一步" ? "is-next" : ""}">
        <div class="day-number">Day ${day}</div><span class="day-phase">${htmlEscape(phase)}</span><p>${htmlEscape(challenge)}</p><span class="day-status">${htmlEscape(status)}</span>
      </article>`;
    }).join("");
  }

  function renderLibrary() {
    const search = byId("library-search").value.trim().toLowerCase();
    const items = data.contentItems.filter(item => {
      const typeMatch = libraryFilter === "all" || item.kind === libraryFilter;
      const text = `${item.date} ${item.day} ${item.column} ${item.mainTopic}`.toLowerCase();
      return typeMatch && (!search || text.includes(search));
    });
    byId("library-list").innerHTML = items.length ? items.map(item => `
      <article class="library-card">
        <div>
          <div class="library-meta"><span class="pill ${item.kind === "growth" ? "kind-growth" : "kind-legacy"}">${item.kind === "growth" ? "AI成长版" : "旧定位基线"}</span><span class="pill">${htmlEscape(item.date)}</span><span class="pill">${htmlEscape(item.day)}</span></div>
          <h3>${htmlEscape(item.mainTopic)}</h3><p>${htmlEscape(item.column)} · ${htmlEscape(item.status)}</p>
        </div>
        <div class="library-actions"><button class="btn btn-secondary" data-open-item="${htmlEscape(item.id)}">打开查看</button></div>
      </article>`).join("") : '<article class="panel" style="padding:28px;text-align:center;color:#6c7b88">没有符合条件的内容</article>';
  }

  function renderAll() {
    renderPicker(); renderStatus(); renderToday(); renderScripts(); renderCreative(); renderShoot(); renderPublish(); renderEvidence(); renderRoadmap(); renderLibrary();
    renderOrdinaryViewerResult();
    void hydrateOrdinaryViewerReview(currentItem);
  }

  function setScriptMode(mode) {
    $$(".segment").forEach(button => button.classList.toggle("is-active", button.dataset.scriptMode === mode));
    byId("full-script-panel").classList.toggle("is-hidden", mode !== "full");
    byId("short-script-panel").classList.toggle("is-hidden", mode !== "short");
    byId("edit-script-panel").classList.toggle("is-hidden", mode !== "edit");
    persisted.scriptMode = mode;
    saveState();
  }

  function currentScriptText() {
    const mode = persisted.scriptMode || "full";
    if (mode === "short") return shortText();
    if (mode === "edit") return byId("edited-script").value;
    return fullPlainText();
  }

  function openTeleprompter() {
    const mode = persisted.scriptMode || "full";
    const container = byId("teleprompter-text");
    if (mode === "full") {
      container.innerHTML = fullSegments().map(segment => `<p><span class="tele-label">${htmlEscape(segment.time)} · ${htmlEscape(segment.label)}</span>${htmlEscape(segment.text)}</p>`).join("");
    } else {
      const text = mode === "edit" ? byId("edited-script").value : shortText();
      container.innerHTML = text.split(/\n{2,}/).map(paragraph => `<p>${htmlEscape(paragraph)}</p>`).join("");
    }
    byId("teleprompter-scroll").scrollTop = 0;
    byId("teleprompter-modal").classList.add("is-open");
    byId("teleprompter-modal").setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    stopTeleprompter();
  }

  function closeTeleprompter() {
    stopTeleprompter();
    byId("teleprompter-modal").classList.remove("is-open");
    byId("teleprompter-modal").setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  function toggleTeleprompter() {
    teleRunning ? stopTeleprompter() : startTeleprompter();
  }

  function startTeleprompter() {
    teleRunning = true;
    teleLastTime = null;
    byId("tele-play").textContent = "暂停滚动";
    teleFrame = requestAnimationFrame(teleStep);
  }

  function stopTeleprompter() {
    teleRunning = false;
    teleLastTime = null;
    if (teleFrame) cancelAnimationFrame(teleFrame);
    teleFrame = null;
    byId("tele-play").textContent = "开始滚动";
  }

  function teleStep(time) {
    if (!teleRunning) return;
    if (teleLastTime !== null) {
      const speed = Number(byId("speed-range").value);
      const scroller = byId("teleprompter-scroll");
      scroller.scrollTop += speed * ((time - teleLastTime) / 1000);
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) stopTeleprompter();
    }
    teleLastTime = time;
    if (teleRunning) teleFrame = requestAnimationFrame(teleStep);
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(2)} GB`;
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Number(seconds || 0));
    const minutes = Math.floor(value / 60);
    const rest = Math.round(value % 60);
    return `${minutes}分${String(rest).padStart(2, "0")}秒`;
  }

  function jobHasStandardOutput(job) {
    return !!job?.output?.url;
  }

  function jobMotionSample(job) {
    const artifacts = job?.workflow?.stages?.motion_sample?.artifacts;
    return artifacts?.url ? artifacts : null;
  }

  function jobDateLabel(job) {
    const date = new Date(job?.updatedAt || job?.createdAt || "");
    if (!Number.isFinite(date.getTime())) return "时间未知";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date).replaceAll("/", "-");
  }

  function jobResultLabel(job) {
    if (jobHasStandardOutput(job)) return job?.status === "approved" ? "已通过，可预览和下载" : "可预览、返修和下载";
    if (jobMotionSample(job)) return "只有真实动态样片";
    if (videoRunningStatuses.includes(job?.status)) return "正在处理";
    return "没有标准成片";
  }

  function jobPickerTitle(job) {
    const source = String(job?.fileName || job?.contentId || job?.id || "本地任务");
    return `${jobDateLabel(job)} · ${jobResultLabel(job)} · ${source}`;
  }

  function upsertAvailableVideoJob(job) {
    if (!job?.id) return;
    availableVideoJobs = [job, ...availableVideoJobs.filter(item => item.id !== job.id)]
      .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  }

  function renderVideoJobPicker() {
    const picker = byId("video-job-picker");
    if (!picker) return;
    picker.innerHTML = [
      '<option value="">新建任务：上传一段原片</option>',
      ...availableVideoJobs.map(job => `<option value="${htmlEscape(job.id)}">${htmlEscape(jobPickerTitle(job))}</option>`),
    ].join("");
    picker.value = currentVideoJob?.id && availableVideoJobs.some(job => job.id === currentVideoJob.id)
      ? currentVideoJob.id
      : "";
    picker.disabled = videoJobsLoading || !videoServiceOnline;
    byId("refresh-video-jobs").disabled = videoJobsLoading || !videoServiceOnline;
  }

  function renderVideoServiceDetail() {
    const detail = byId("video-service-detail");
    const status = byId("video-service-status");
    if (!detail) return;
    if (!videoServiceOnline) {
      detail.textContent = "请双击项目根目录的“打开AI口播工作台.vbs”；它会静默启动服务并重新打开网页。";
      return;
    }
    if (editExperienceMode === "demo") {
      if (status) status.textContent = "本地工作台已就绪";
      detail.textContent = "本地工作台已连接。原视频保留在本机，有真实结果时才会显示预览。";
      return;
    }
    if (status) status.textContent = "视觉导演 v4 工作流已就绪";
    const modelText = serviceHealth?.ai?.configured ? `文本模型 ${serviceHealth.ai.model}` : "文本模型未配置";
    detail.textContent = `HyperFrames默认 · 2K母版 · 两道审核门 · ${modelText} · 本地转录 ${serviceHealth?.ai?.transcriptionModel || "faster-whisper/small"}`;
  }

  function renderDemoPreview(job = currentVideoJob) {
    const panel = byId("demo-preview-panel");
    const video = byId("demo-sample-video");
    if (!panel || !video) return;
    video.pause();
    if (editExperienceMode !== "demo" || jobHasStandardOutput(job)) {
      panel.classList.add("is-hidden");
      video.classList.add("is-hidden");
      video.removeAttribute("src");
      return;
    }
    panel.classList.remove("is-hidden");
    const sample = jobMotionSample(job);
    if (sample) {
      byId("demo-preview-title").textContent = "真实动态样片";
      byId("demo-preview-message").textContent = "这段视频可以检查字幕、动效和声音方向，但它还不是完整成片，因此这里不会开放最终返修和下载。";
      byId("demo-preview-badge").textContent = "仅样片，不冒充成片";
      video.src = `${videoApiBase}${sample.url}`;
      video.classList.remove("is-hidden");
      return;
    }
    video.classList.add("is-hidden");
    video.removeAttribute("src");
    byId("demo-preview-badge").textContent = "真实结果边界";
    if (!job) {
      byId("demo-preview-title").textContent = "还没有选择处理任务";
      byId("demo-preview-message").textContent = "上传一段原片开始新任务，或者从上方选择一个标有“可预览、返修和下载”的已有任务。";
      return;
    }
    if (videoRunningStatuses.includes(job.status)) {
      byId("demo-preview-title").textContent = "任务仍在处理中";
      byId("demo-preview-message").textContent = "工作台还没有生成可核验的标准成片，完成前不会显示占位预览。";
      return;
    }
    byId("demo-preview-title").textContent = "这个任务没有标准成片";
    byId("demo-preview-message").textContent = "它可能是效果方向证明、历史发布记录或未完成任务，不能在这里当作完整结果返修或下载。请选择带“可预览、返修和下载”的任务，或上传新原片。";
  }

  function renderEditExperienceMode() {
    const demo = editExperienceMode === "demo";
    document.body.classList.toggle("is-demo-mode", demo);
    byId("edit-mode-daily").classList.toggle("is-active", !demo);
    byId("edit-mode-demo").classList.toggle("is-active", demo);
    byId("edit-intro-kicker").textContent = demo ? "不会剪辑，也能先看真实效果" : "默认视觉导演 v4 · 每一步可配置";
    byId("edit-intro-title").textContent = demo
      ? "上传原片，等工作台处理；不满意就直接说哪里要改"
      : "先分析同题高质量视频，再拆解口播、审关键帧、审动态样片，最后渲染2K全片";
    byId("edit-intro-description").textContent = demo
      ? "页面只保留上传、处理进度、效果预览、自然语言返修和下载。没有真实结果时会明确说明。"
      : "不改设置就使用默认提示词。关键帧和15—25秒动态样片分别是硬审核门；未批准不会继续生成完整视频。旧任务仍可按原 FFmpeg v3 流程打开。";
    byId("edit-result-title").textContent = demo ? "效果预览" : "完整预览与分段审核";
    byId("edit-result-description").textContent = demo
      ? "先看工作台真实生成的成片；不满意就在右侧用一句话说明，满意后直接下载。"
      : "先看完整节奏，再用15—30秒上下文小样定位问题；通过后才进入最终审核。";
    if (currentView === "edit") byId("page-eyebrow").textContent = demo ? "拍完口播，交给工作台" : pageNames.edit[0];
    renderVideoServiceDetail();
    renderDemoPreview(currentVideoJob);
    if (currentVideoJob?.output) showVideoVersion(currentVideoJob.output.version);
  }

  function setEditExperienceMode(mode, save = true) {
    editExperienceMode = mode === "demo" ? "demo" : "daily";
    if (save) {
      persisted.editExperienceMode = editExperienceMode;
      saveState();
    }
    renderEditExperienceMode();
  }

  function setAnalyzeVideoDisabled(disabled) {
    byId("analyze-video").disabled = disabled;
    byId("demo-analyze-video").disabled = disabled;
  }

  function setEditProgress(value, message) {
    byId("edit-progress-bar").style.width = `${Math.max(0, Math.min(100, Number(value || 0)))}%`;
    if (message) byId("edit-job-status").textContent = message;
  }

  function contentStrategyInputs() {
    return {
      direction: byId("content-direction").value.trim(),
      evidenceSummary: byId("content-evidence-summary").value.trim(),
    };
  }

  function contentAdvisoryReady() {
    return videoServiceOnline
      && serviceHealth?.ai?.configured === true
      && multiAgentStatus?.advisoryEnabled === true;
  }

  function contentStrategyReadyForConfirmation() {
    const current = contentStrategyInputs();
    const analysis = contentStrategyDraft.analysis;
    return !!analysis
      && !!contentStrategyDraft.analysisArtifactId
      && current.direction === contentStrategyDraft.direction
      && current.evidenceSummary === contentStrategyDraft.evidenceSummary
      && analysis.lockedDirection === current.direction
      && analysis.status === "ready_for_script"
      && Array.isArray(analysis.evidence?.available)
      && analysis.evidence.available.length > 0
      && Array.isArray(analysis.evidence?.missing)
      && analysis.evidence.missing.length === 0;
  }

  function updateContentStrategyControls() {
    const { direction, evidenceSummary } = contentStrategyInputs();
    const busy = contentStrategyAnalyzing || contentGenerating;
    const ready = contentStrategyReadyForConfirmation();
    const generated = !!contentStrategyDraft.generatedContentId;
    const analyze = byId("analyze-content-direction");
    const confirmation = byId("confirm-content-strategy");
    const generate = byId("generate-content");
    byId("content-direction").disabled = busy;
    byId("content-evidence-summary").disabled = busy;
    analyze.disabled = !(contentAdvisoryReady() && direction && evidenceSummary && !busy);
    confirmation.disabled = !(contentAdvisoryReady() && ready && !busy && !generated);
    if (confirmation.disabled && (!ready || generated)) confirmation.checked = false;
    generate.disabled = !(contentAdvisoryReady() && ready && confirmation.checked && !busy && !generated);
    if (!busy) generate.textContent = generated ? "本方向已生成" : "第 2 步：确认并生成口播";
  }

  function analysisList(items, emptyText) {
    const values = Array.isArray(items) ? items.filter(Boolean) : [];
    return values.length
      ? `<ul>${values.map(item => `<li>${htmlEscape(item)}</li>`).join("")}</ul>`
      : `<p class="strategy-empty-value">${htmlEscape(emptyText)}</p>`;
  }

  function renderContentStrategyAnalysis(message = "") {
    const host = byId("content-strategy-analysis");
    const analysis = contentStrategyDraft.analysis;
    if (!analysis) {
      host.className = "strategy-analysis is-empty";
      host.innerHTML = htmlEscape(message || "填写左侧两项后点击“分析方向”，这里会展示观众收益、优缺点、证据缺口和最多三个追问。");
      return;
    }
    const statusLabels = {
      ready_for_script: "证据已就绪",
      needs_evidence: "需要补充证据",
      needs_restructure: "需要收窄或重构",
      recommend_abandon: "建议暂缓或放弃",
    };
    const recommendationLabels = {
      single_piece: "适合单篇",
      series: "适合系列",
      defer: "建议暂缓",
    };
    const ready = contentStrategyReadyForConfirmation();
    const generated = !!contentStrategyDraft.generatedContentId;
    const available = (analysis.evidence?.available || []).map(item => item.relevance || item.id);
    const missing = analysis.evidence?.missing || [];
    host.className = `strategy-analysis ${ready ? "is-ready" : "needs-input"}`;
    host.innerHTML = `
      <div class="strategy-analysis-heading">
        <div><span>内容顾问结论</span><strong>${htmlEscape(statusLabels[analysis.status] || analysis.status)}</strong></div>
        <span class="strategy-recommendation">${htmlEscape(recommendationLabels[analysis.recommendation] || analysis.recommendation)}</span>
      </div>
      <p class="strategy-restatement">${htmlEscape(analysis.directionRestatement)}</p>
      <div class="strategy-analysis-grid">
        <article><span>目标受众</span><p>${htmlEscape(analysis.audience)}</p></article>
        <article><span>观众能获得什么</span><p>${htmlEscape(analysis.viewerBenefit)}</p></article>
        <article><span>这条内容要回答</span><p>${htmlEscape(analysis.testableQuestion)}</p></article>
        <article><span>已引用的真实证据</span>${analysisList(available, "没有可引用证据")}</article>
        <article><span>这个方向的优点</span>${analysisList(analysis.strengths, "暂无")}</article>
        <article><span>这个方向的缺点</span>${analysisList(analysis.weaknesses, "暂无")}</article>
        <article class="strategy-gap-card"><span>证据缺口</span>${analysisList(missing, "当前没有未解决的证据缺口")}</article>
        <article><span>下一轮最多三个问题</span>${analysisList(analysis.nextQuestions, "不需要继续追问")}</article>
      </div>
      ${(analysis.uncertainties || []).length ? `<div class="strategy-uncertainties"><b>仍不确定：</b>${htmlEscape(analysis.uncertainties.join("；"))}</div>` : ""}
      <p class="strategy-gate-message">${generated
        ? "这个锁定方向已经生成一份口播。请先阅读下方普通观众点评；如需新方向，修改左侧内容后重新分析。"
        : ready
          ? "分析和证据已满足写稿门槛。请先阅读，再由你勾选确认；内容顾问不会替你确认。"
        : "当前还不能写稿。请根据证据缺口或追问补充左侧信息，然后重新分析。"}</p>`;
  }

  function resetContentStrategyAnalysis(message = "方向或证据已经改变，旧分析已失效；请重新分析。") {
    if (contentStrategyAnalyzing || contentGenerating) return;
    const hadAnalysis = !!contentStrategyDraft.analysisArtifactId || !!contentStrategyDraft.generatedContentId;
    contentStrategyDraft = {
      direction: "",
      evidenceSummary: "",
      analysisArtifactId: "",
      analysis: null,
      confirmationArtifactId: "",
      generatedContentId: "",
    };
    byId("confirm-content-strategy").checked = false;
    renderContentStrategyAnalysis(hadAnalysis ? message : "");
    if (hadAnalysis) byId("generation-status").textContent = message;
    updateContentStrategyControls();
  }

  async function analyzeContentDirection() {
    const { direction, evidenceSummary } = contentStrategyInputs();
    if (!contentAdvisoryReady() || !direction || !evidenceSummary || contentStrategyAnalyzing || contentGenerating) return;
    contentStrategyAnalyzing = true;
    contentStrategyDraft = {
      direction,
      evidenceSummary,
      analysisArtifactId: "",
      analysis: null,
      confirmationArtifactId: "",
      generatedContentId: "",
    };
    byId("confirm-content-strategy").checked = false;
    byId("content-strategy-analysis").className = "strategy-analysis is-loading";
    byId("content-strategy-analysis").textContent = "内容顾问正在分析受众、价值、优缺点和证据缺口；此时不会生成口播。";
    byId("generation-status").textContent = "正在分析你锁定的方向，不会自动换题或写稿。";
    updateContentStrategyControls();
    try {
      const payload = await multiAgentRequest("/api/multi-agent/content-strategy/analyze", {
        method: "POST",
        body: {
          direction,
          userFacts: [evidenceSummary],
          evidence: [{
            id: "evidence.user-summary",
            kind: "creator-provided-summary",
            summary: evidenceSummary,
            sourceId: "user-provided-summary",
            provenance: "user_provided",
          }],
          constraints: [
            "只分析用户锁定的方向，不得换题或直接写稿",
            "只使用真实经历和可追溯证据，不虚构结果",
          ],
        },
        idempotencyPrefix: "content-strategy-analysis",
      });
      contentStrategyDraft.analysisArtifactId = payload.analysisArtifactId;
      contentStrategyDraft.analysis = payload.analysis;
      renderContentStrategyAnalysis();
      byId("generation-status").textContent = contentStrategyReadyForConfirmation()
        ? "方向分析完成。请阅读结果并明确勾选确认，之后才会生成口播。"
        : "分析发现仍有缺口；请补充左侧证据或回答追问后重新分析。";
      toast("方向分析已完成，尚未生成口播");
    } catch (error) {
      contentStrategyDraft.analysisArtifactId = "";
      contentStrategyDraft.analysis = null;
      renderContentStrategyAnalysis(`方向分析失败：${error.message}`);
      byId("generation-status").textContent = `方向分析失败：${error.message}`;
      toast("方向分析失败，请查看页面提示");
    } finally {
      contentStrategyAnalyzing = false;
      updateContentStrategyControls();
    }
  }

  async function lockedDirectionHash(direction) {
    if (!globalThis.crypto?.subtle || typeof TextEncoder !== "function") {
      throw new Error("当前浏览器不支持方向哈希，请通过本地工作台入口重新打开页面");
    }
    const bytes = new TextEncoder().encode(JSON.stringify({ lockedDirection: direction }));
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function renderOrdinaryViewerResult(item = currentItem) {
    const host = byId("ordinary-viewer-result");
    const audit = item?.ordinaryViewerAudit;
    if (!audit) {
      host.className = "ordinary-viewer-result is-empty";
      host.innerHTML = "新口播生成后，普通观众 Agent 会在这里给出最尖锐的一句话、具体阻碍和最小修改。";
      return;
    }
    const cached = ordinaryViewerReviewCache.get(item.id);
    if (audit.status === "failed" || cached?.status === "failed") {
      host.className = "ordinary-viewer-result is-failed";
      host.innerHTML = `<div class="ordinary-viewer-heading"><span>普通观众点评未完成</span><strong>不能据此提示直接拍摄</strong></div><p>${htmlEscape(cached?.error || audit.error || "点评服务返回失败")}</p>`;
      return;
    }
    const review = cached?.review;
    if (!review) {
      host.className = "ordinary-viewer-result is-loading";
      host.innerHTML = `<div class="ordinary-viewer-heading"><span>普通观众的第一反应</span><strong>${htmlEscape(audit.viewerDecision || "正在读取")}</strong></div><blockquote>${htmlEscape(audit.sharpConclusion || "正在读取完整点评……")}</blockquote><p>正在读取“最小修改”和证据缺口，不会把生成完成直接等同于可以拍摄。</p>`;
      return;
    }
    const classificationLabels = { fact: "事实问题", subjective: "主观感受", uncertain: "无法确认" };
    const blockers = (review.blockers || []).map(item => {
      const reference = item.quote
        ? `原文：“${item.quote}”`
        : (Number.isFinite(item.start) && Number.isFinite(item.end) ? `${item.start.toFixed(1)}–${item.end.toFixed(1)} 秒` : "未给出引用");
      return `<li><b>${htmlEscape(item.issue)}</b><span>${htmlEscape(classificationLabels[item.classification] || item.classification || "观点")}</span><small>${htmlEscape(reference)}</small></li>`;
    }).join("");
    host.className = "ordinary-viewer-result is-complete";
    host.innerHTML = `
      <div class="ordinary-viewer-heading"><span>普通观众的第一反应</span><strong>${htmlEscape(review.viewerDecision)}</strong></div>
      <blockquote>${htmlEscape(review.sharpConclusion)}</blockquote>
      <div class="ordinary-viewer-fix"><span>最小修改</span><p>${htmlEscape(review.minimalFix)}</p></div>
      <div class="ordinary-viewer-gaps">
        <article><span>观众价值缺口</span><p>${htmlEscape(review.viewerValueGap)}</p></article>
        <article><span>证据缺口</span><p>${htmlEscape(review.evidenceGap)}</p></article>
      </div>
      <div class="ordinary-viewer-blockers"><span>最关键的阻碍（最多三条）</span>${blockers ? `<ol>${blockers}</ol>` : "<p>没有返回阻碍，但仍需由你决定是否修改或拍摄。</p>"}</div>
      <small class="ordinary-viewer-boundary">这是一份只读普通观众点评，不批准拍摄、发布或自动改稿。</small>`;
  }

  async function hydrateOrdinaryViewerReview(item = currentItem, { force = false } = {}) {
    const audit = item?.ordinaryViewerAudit;
    if (!item?.id || !audit) return null;
    if (!videoServiceOnline) return null;
    if (!force && ordinaryViewerReviewCache.has(item.id)) return ordinaryViewerReviewCache.get(item.id);
    if (ordinaryViewerReviewLoading.has(item.id)) return ordinaryViewerReviewLoading.get(item.id);
    if (audit.status === "failed") {
      const entry = { status: "failed", error: audit.error || "普通观众点评失败" };
      ordinaryViewerReviewCache.set(item.id, entry);
      if (currentItem?.id === item.id) renderOrdinaryViewerResult(item);
      return entry;
    }
    if (!audit.artifactHref) return null;
    const task = (async () => {
      try {
        const href = String(audit.artifactHref);
        const url = /^https?:\/\//i.test(href) ? href : `${videoApiBase}${href.startsWith("/") ? href : `/${href}`}`;
        const response = await fetch(url, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `点评读取失败（${response.status}）`);
        const review = payload.review || payload.artifact?.review;
        if (!review?.sharpConclusion || !review?.minimalFix) throw new Error("普通观众点评缺少尖锐结论或最小修改");
        const entry = { status: "complete", review };
        ordinaryViewerReviewCache.set(item.id, entry);
        if (currentItem?.id === item.id) renderOrdinaryViewerResult(item);
        return entry;
      } catch (error) {
        const entry = { status: "failed", error: error.message };
        ordinaryViewerReviewCache.set(item.id, entry);
        if (currentItem?.id === item.id) renderOrdinaryViewerResult(item);
        return entry;
      } finally {
        ordinaryViewerReviewLoading.delete(item.id);
      }
    })();
    ordinaryViewerReviewLoading.set(item.id, task);
    return task;
  }

  function mergeGeneratedContents(items, selectId = null) {
    const generated = Array.isArray(items) ? items.filter(item => item && item.id) : [];
    const generatedIds = new Set(generated.map(item => item.id));
    data.contentItems = [...generated, ...data.contentItems.filter(item => !generatedIds.has(item.id))];
    const wanted = selectId || persisted.currentId || currentItem?.id;
    currentItem = data.contentItems.find(item => item.id === wanted) || data.contentItems[0];
    persisted.currentId = currentItem.id;
    saveState();
    renderAll();
  }

  async function refreshGeneratedContents(selectId = null) {
    if (!videoServiceOnline) return;
    try {
      const response = await fetch(`${videoApiBase}/api/contents`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法读取AI生成内容");
      mergeGeneratedContents(payload.items, selectId);
    } catch (error) {
      byId("generation-status").textContent = `读取生成内容失败：${error.message}`;
    }
  }

  async function generateNewContent() {
    if (!contentAdvisoryReady() || !contentStrategyReadyForConfirmation() || !byId("confirm-content-strategy").checked || contentGenerating) return;
    contentGenerating = true;
    const button = byId("generate-content");
    const direction = contentStrategyDraft.direction;
    button.textContent = "正在确认并生成……";
    byId("generation-status").textContent = "正在把你的明确确认写成独立凭证，然后按锁定方向生成；通常需要1—3分钟。";
    updateContentStrategyControls();
    try {
      if (!contentStrategyDraft.confirmationArtifactId) {
        const confirmationPayload = await multiAgentRequest("/api/multi-agent/content-strategy/confirm", {
          method: "POST",
          body: {
            analysisArtifactId: contentStrategyDraft.analysisArtifactId,
            decision: "approved",
            actor: { type: "human", id: "local-owner" },
            note: "用户已在本地工作台阅读分析并明确勾选确认",
          },
          idempotencyPrefix: "content-strategy-confirmation",
        });
        if (confirmationPayload.confirmation?.scriptHandoffAllowed !== true) {
          throw new Error("这份分析仍未满足写稿门槛，请补充证据后重新分析");
        }
        contentStrategyDraft.confirmationArtifactId = confirmationPayload.confirmationArtifactId;
      }
      const directionHash = await lockedDirectionHash(direction);
      byId("generation-status").textContent = "确认凭证已建立，正在按原方向研究同题内容、生成口播并运行普通观众点评。";
      const response = await fetch(`${videoApiBase}/api/contents/generate`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lockedDirection: direction,
          lockedDirectionHash: directionHash,
          strategyConfirmationArtifactId: contentStrategyDraft.confirmationArtifactId,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "口播生成失败");
      if (!payload.item?.id) throw new Error("口播生成成功，但服务端没有返回内容 ID");
      contentStrategyDraft.generatedContentId = payload.item.id;
      ordinaryViewerReviewCache.delete(payload.item.id);
      mergeGeneratedContents([payload.item], payload.item.id);
      await refreshGeneratedContents(payload.item.id);
      switchView("today");
      const reviewEntry = await hydrateOrdinaryViewerReview(currentItem, { force: true });
      byId("generation-status").textContent = reviewEntry?.status === "complete"
        ? `已生成 ${payload.item.day} · ${payload.item.mainTopic}；请先看下方普通观众点评，再决定修改或拍摄。`
        : `已生成 ${payload.item.day} · ${payload.item.mainTopic}，但普通观众完整点评读取失败；不要直接进入拍摄。`;
      toast("口播已生成；普通观众点评已展示，请先判断是否修改");
    } catch (error) {
      byId("generation-status").textContent = `生成失败：${error.message}`;
      toast("生成失败，请查看页面提示");
    } finally {
      contentGenerating = false;
      renderContentStrategyAnalysis();
      updateContentStrategyControls();
    }
  }

  function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function visualWorkflowJob(job = currentVideoJob) {
    return !!job && (job.pipeline === "visual-director-v4" || job.workflow?.version === "visual-director-v4");
  }

  function directorStageStatusLabel(status) {
    return ({
      pending: "等待中",
      running: "生成中",
      completed: "已生成",
      awaiting_review: "待审核",
      approved: "已批准",
      error: "失败"
    })[status] || status || "等待中";
  }

  function directorFieldMarkup(stageId, field, settings) {
    const value = settings?.[field.key];
    const id = `director-${stageId}-${field.key}`;
    const help = field.help ? `<small>${htmlEscape(field.help)}</small>` : "";
    if (field.type === "checkbox") return `<label class="director-field director-field-check" for="${id}"><span><strong>${htmlEscape(field.label)}</strong>${help}</span><input id="${id}" data-director-setting="${htmlEscape(field.key)}" data-field-type="checkbox" type="checkbox" ${value !== false ? "checked" : ""}></label>`;
    if (field.type === "lines") return `<label class="director-field director-field-lines" for="${id}"><span><strong>${htmlEscape(field.label)}</strong>${help}</span><textarea id="${id}" data-director-setting="${htmlEscape(field.key)}" data-field-type="lines" rows="3" placeholder="每行一项，可留空">${htmlEscape(Array.isArray(value) ? value.join("\n") : value || "")}</textarea></label>`;
    if (field.type === "select") return `<label class="director-field" for="${id}"><span><strong>${htmlEscape(field.label)}</strong>${help}</span><select id="${id}" data-director-setting="${htmlEscape(field.key)}" data-field-type="select">${(field.options || []).map(option => `<option value="${htmlEscape(option.value)}" ${String(option.value) === String(value) ? "selected" : ""}>${htmlEscape(option.label)}</option>`).join("")}</select></label>`;
    return `<label class="director-field" for="${id}"><span><strong>${htmlEscape(field.label)}</strong>${help}</span><input id="${id}" data-director-setting="${htmlEscape(field.key)}" data-field-type="number" type="number" value="${htmlEscape(value ?? "")}" ${field.min === undefined ? "" : `min="${htmlEscape(field.min)}"`} ${field.max === undefined ? "" : `max="${htmlEscape(field.max)}"`} ${field.step === undefined ? "" : `step="${htmlEscape(field.step)}"`}></label>`;
  }

  function directorStyleOutput(stage) {
    const report = stage?.artifacts?.report;
    if (!report) return "";
    const references = (report.selectedReferences || []).map(item => item.sourceUrl
      ? `<a href="${htmlEscape(item.sourceUrl)}" target="_blank" rel="noreferrer">${htmlEscape(item.creatorName || item.workTitle || "参考视频")}</a>`
      : `<span>${htmlEscape(item.creatorName || item.workTitle || "参考来源")}</span>`).join("");
    return `<div class="director-output"><strong>风格结论</strong><p>${htmlEscape(report.summary || "已完成视觉风格分析")}</p><div class="director-reference-links">${references}</div>${stage.artifacts.reportUrl ? `<a class="director-artifact-link" href="${videoApiBase}${htmlEscape(stage.artifacts.reportUrl)}" target="_blank">打开完整风格报告</a>` : ""}</div>`;
  }

  function directorBreakdownOutput(stage) {
    const breakdown = stage?.artifacts?.breakdown;
    if (!breakdown?.segments?.length) return "";
    return `<div class="director-output"><strong>已拆成 ${breakdown.segments.length} 个信息段</strong><div class="director-segment-strip">${breakdown.segments.slice(0, 12).map(segment => `<article><b>${htmlEscape(segment.id)} · ${htmlEscape(segment.upperLeftTitle)}</b><span>${htmlEscape(segment.oneSentenceSummary)}</span><small>${Number(segment.editedTime?.start || 0).toFixed(1)}—${Number(segment.editedTime?.end || 0).toFixed(1)}秒</small></article>`).join("")}</div>${stage.artifacts.breakdownUrl ? `<a class="director-artifact-link" href="${videoApiBase}${htmlEscape(stage.artifacts.breakdownUrl)}" target="_blank">打开完整内容拆解</a>` : ""}</div>`;
  }

  function directorKeyframeOutput(workflow) {
    const artifacts = workflow?.stages?.keyframes?.artifacts;
    if (!artifacts?.frames?.length) return "";
    return `<div class="director-output"><strong>${artifacts.frames.length} 张 1920×1080 关键帧</strong><div class="director-keyframe-grid">${artifacts.frames.map((frame, index) => `<a href="${videoApiBase}${htmlEscape(frame.url)}" target="_blank" title="打开原图"><img src="${videoApiBase}${htmlEscape(frame.url)}?v=${Number(workflow.stages.keyframes.currentVersion || 1)}" alt="关键帧 ${index + 1}"><span>${htmlEscape(frame.id || `关键帧 ${index + 1}`)} · ${htmlEscape(frame.purpose || "构图审核")}</span></a>`).join("")}</div></div>`;
  }

  function directorSampleOutput(stage) {
    const artifacts = stage?.artifacts;
    if (!artifacts?.url) return "";
    return `<div class="director-output director-sample-output"><strong>15—25秒动态样片</strong><video controls playsinline preload="metadata" poster="${artifacts.thumbnailUrl ? `${videoApiBase}${htmlEscape(artifacts.thumbnailUrl)}` : ""}" src="${videoApiBase}${htmlEscape(artifacts.url)}"></video><small>成片时间 ${Number(artifacts.sampleStart || 0).toFixed(1)}—${Number(artifacts.sampleEnd || 0).toFixed(1)} 秒 · ${artifacts.metadata?.width || 1920}×${artifacts.metadata?.height || 1080}</small></div>`;
  }

  function directorFullOutput(stage, job) {
    if (!stage?.artifacts?.output && !job?.output) return "";
    const output = stage?.artifacts?.output || job.output;
    return `<div class="director-output"><strong>完整视频已生成</strong><p>${output.metadata?.width || 2560}×${output.metadata?.height || 1440} · ${formatDuration(output.metadata?.duration)} · QA ${output.qaPass ? "通过" : "需检查"}</p><span>请在下方“完整预览与分段审核”里观看、返修或最终批准。</span></div>`;
  }

  function directorStageOutput(stageId, stage, workflow, job) {
    if (stageId === "style_research") return directorStyleOutput(stage);
    if (stageId === "content_breakdown") return directorBreakdownOutput(stage);
    if (stageId === "keyframe_review") return directorKeyframeOutput(workflow);
    if (stageId === "motion_sample") return directorSampleOutput(stage);
    if (stageId === "full_render") return directorFullOutput(stage, job);
    return "";
  }

  function directorStageActions(stageId, stage, workflow, hasJob) {
    const running = Object.values(workflow?.stages || {}).some(item => item.status === "running");
    const save = `<button class="btn btn-secondary" data-director-save="${stageId}">${hasJob ? "保存本步配置" : "保留本步设置"}</button>`;
    if (!hasJob) return save;
    const feedback = `<textarea class="director-feedback" data-director-feedback rows="2" placeholder="可选：写本次重做意见；留空按当前配置生成"></textarea>`;
    if (stageId === "keyframe_review") return `${feedback}<div class="inline-actions"><button class="btn btn-secondary" data-director-run="${stageId}" ${running ? "disabled" : ""}>按意见重做关键帧</button><button class="btn btn-primary" data-director-approve="${stageId}" ${stage?.status !== "awaiting_review" || running ? "disabled" : ""}>批准并生成动态样片</button></div>`;
    if (stageId === "motion_sample") return `${feedback}<div class="inline-actions">${save}<button class="btn btn-secondary" data-director-run="${stageId}" ${workflow?.stages?.keyframe_review?.status !== "approved" || running ? "disabled" : ""}>重做动态样片</button><button class="btn btn-primary" data-director-approve="${stageId}" ${stage?.status !== "awaiting_review" || running ? "disabled" : ""}>批准并生成2K全片</button></div>`;
    if (stageId === "full_render") return `${feedback}<div class="inline-actions">${save}<button class="btn btn-secondary" data-director-run="${stageId}" ${workflow?.stages?.motion_sample?.status !== "approved" || running ? "disabled" : ""}>重新渲染全片</button></div>`;
    return `${feedback}<div class="inline-actions">${save}<button class="btn btn-secondary" data-director-run="${stageId}" ${running ? "disabled" : ""}>从本步重新生成</button></div>`;
  }

  function renderDirectorWorkflow(job = currentVideoJob, force = false) {
    const panel = byId("director-workflow-panel");
    const container = byId("director-stage-cards");
    if (!panel || !container) return;
    if (!directorWorkflowDefaults) {
      container.innerHTML = `<div class="empty-state">视觉导演默认配置尚未加载，请确认本地服务已启动。</div>`;
      return;
    }
    const activeJob = visualWorkflowJob(job) ? job : null;
    const workflow = activeJob?.workflow || null;
    const config = workflow?.config || directorDraftConfig || directorWorkflowDefaults;
    const signature = JSON.stringify({ id: activeJob?.id || "draft", configVersion: workflow?.configVersion || 0, stages: directorStageOrder.map(id => [workflow?.stages?.[id]?.status || "pending", workflow?.stages?.[id]?.currentVersion || 0]) });
    if (!force && directorRenderSignature === signature) return;
    if (!force && panel.contains(document.activeElement)) return;
    directorRenderSignature = signature;
    if (workflow?.config) directorDraftConfig = cloneJson(workflow.config);
    byId("director-workflow-version").textContent = activeJob ? `任务 ${activeJob.id} · 配置 v${workflow.configVersion || 1}` : "默认配置 · 未改即直接使用";
    container.innerHTML = directorStageOrder.map(stageId => {
      const stageConfig = config.stages[stageId];
      const stage = workflow?.stages?.[stageId] || { status: "pending", currentVersion: 0 };
      const fields = (stageConfig.uiFields || []).map(field => directorFieldMarkup(stageId, field, stageConfig.settings || {})).join("");
      const statusClass = `is-${String(stage.status || "pending").replaceAll("_", "-")}`;
      const output = directorStageOutput(stageId, stage, workflow, activeJob);
      return `<section class="director-stage-card ${statusClass}" data-director-stage="${stageId}">
        <header><b>${htmlEscape(stageConfig.number)}</b><div><h4>${htmlEscape(stageConfig.label)}</h4><p>${htmlEscape(stageConfig.description)}</p></div><span>${htmlEscape(directorStageStatusLabel(stage.status))}${stage.currentVersion ? ` · v${Number(stage.currentVersion)}` : ""}</span></header>
        ${fields ? `<div class="director-fields">${fields}</div>` : ""}
        <details class="director-prompt"><summary>高级：查看或修改本步提示词</summary><textarea data-director-prompt rows="8">${htmlEscape(stageConfig.prompt || "")}</textarea><small>只影响当前步骤。留空不会调用隐藏提示词，而是明确使用空提示词，请谨慎。</small></details>
        ${output}
        <div class="director-actions">${directorStageActions(stageId, stage, workflow, !!activeJob)}</div>
      </section>`;
    }).join("");
  }

  function readDirectorStageCard(stageId) {
    const card = $(`[data-director-stage="${stageId}"]`, byId("director-stage-cards"));
    if (!card) return { settings: {}, prompt: "", feedback: "" };
    const baseSettings = (currentVideoJob?.workflow?.config || directorDraftConfig || directorWorkflowDefaults)?.stages?.[stageId]?.settings || {};
    const settings = { ...baseSettings };
    $$('[data-director-setting]', card).forEach(input => {
      const key = input.dataset.directorSetting;
      if (input.dataset.fieldType === "checkbox") settings[key] = input.checked;
      else if (input.dataset.fieldType === "lines") settings[key] = input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      else if (input.dataset.fieldType === "number") settings[key] = Number(input.value);
      else settings[key] = typeof baseSettings[key] === "number" ? Number(input.value) : input.value;
    });
    return { settings, prompt: $('[data-director-prompt]', card)?.value || "", feedback: $('[data-director-feedback]', card)?.value.trim() || "" };
  }

  function collectDirectorWorkflowOverrides() {
    if (!directorWorkflowDefaults) return {};
    const overrides = { stages: {} };
    for (const stageId of directorStageOrder) {
      const card = $(`[data-director-stage="${stageId}"]`, byId("director-stage-cards"));
      if (!card) continue;
      const value = readDirectorStageCard(stageId);
      const defaultStage = directorWorkflowDefaults.stages[stageId];
      const visibleKeys = new Set((defaultStage.uiFields || []).map(field => field.key));
      const settings = Object.fromEntries(Object.entries(value.settings).filter(([key]) => visibleKeys.has(key)));
      overrides.stages[stageId] = { settings };
      if (value.prompt !== defaultStage.prompt) overrides.stages[stageId].prompt = value.prompt;
    }
    return overrides;
  }

  async function handleDirectorAction(button) {
    const stageId = button.dataset.directorSave || button.dataset.directorRun || button.dataset.directorApprove;
    if (!stageId) return;
    const value = readDirectorStageCard(stageId);
    if (!visualWorkflowJob()) {
      directorDraftConfig ||= cloneJson(directorWorkflowDefaults);
      directorDraftConfig.stages[stageId].settings = value.settings;
      directorDraftConfig.stages[stageId].prompt = value.prompt;
      toast("本步设置已保留，上传后生效");
      return;
    }
    const action = button.dataset.directorSave ? "config" : button.dataset.directorApprove ? "approve" : "run";
    button.disabled = true;
    try {
      const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(currentVideoJob.id)}/workflow/stages/${encodeURIComponent(stageId)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: value.settings, prompt: value.prompt, feedback: value.feedback })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "阶段操作失败");
      currentVideoJob = payload.job || currentVideoJob;
      directorRenderSignature = "";
      renderDirectorWorkflow(currentVideoJob, true);
      if (action === "config") toast("本步配置已保存，未自动重跑");
      else {
        toast(action === "approve" ? "已批准，工作流开始下一步" : "已启动本步重新生成");
        pollVideoJob(currentVideoJob.id);
      }
    } catch (error) {
      toast(`操作失败：${error.message}`);
      button.disabled = false;
    }
  }

  function multiAgentIdempotencyKey(prefix) {
    const id = globalThis.crypto?.randomUUID?.()
      || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${id}`.slice(0, 128);
  }

  async function multiAgentRequest(pathname, {
    method = "GET",
    body,
    idempotencyPrefix = "koubo-ui",
  } = {}) {
    const response = await fetch(`${videoApiBase}${pathname}`, {
      method,
      cache: "no-store",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(method === "POST"
          ? { "Idempotency-Key": multiAgentIdempotencyKey(idempotencyPrefix) }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
    return payload;
  }

  function multiAgentStructure(candidate = {}) {
    const list = value => Array.isArray(value)
      ? value.join("、")
      : typeof value === "object" && value
        ? JSON.stringify(value)
        : String(value || "无");
    return [
      ["构图", candidate.layout || "未指定"],
      ["字幕", candidate.captions?.identity || list(candidate.captions)],
      ["动效", list(candidate.motion?.structure || candidate.motion)],
      ["声音", list(candidate.sound?.structure || candidate.sound)],
    ];
  }

  function renderMultiAgentStatus() {
    const badge = byId("multi-agent-status");
    const enabled = multiAgentStatus?.enabled === true;
    badge.textContent = enabled ? "实验已开启 · 影子模式" : "实验未开启";
    badge.className = `experiment-badge ${enabled ? "is-enabled" : "is-disabled"}`;
    byId("multi-agent-disabled-note").classList.toggle("is-hidden", enabled);
    byId("multi-agent-workspace").classList.toggle("is-hidden", !enabled);
    byId("multi-agent-generate").disabled = !(enabled && currentVideoJob?.id);
    const tutorialReady = enabled
      && byId("tutorial-input-path").value.trim()
      && byId("tutorial-author").value.trim()
      && byId("tutorial-license").value.trim();
    byId("tutorial-ingest").disabled = !tutorialReady;
    updateContentStrategyControls();
  }

  function renderMultiAgentProposals() {
    const host = byId("multi-agent-proposals");
    const proposals = proposalBundle?.proposals || [];
    const candidates = proposalBundle?.candidates || [];
    if (!proposals.length && !candidates.length) {
      host.innerHTML = '<div class="empty-state">打开一个已有视频任务后，才能生成不改动 V4 成片的影子提案。</div>';
      byId("multi-agent-build-ab").disabled = true;
      byId("multi-agent-run-review").disabled = true;
      return;
    }
    const kindLabels = { caption: "字幕专家", motion: "动效专家", sound: "声音专家" };
    const proposalHtml = proposals.map(item => `
      <article class="proposal-card">
        <header><strong>${htmlEscape(kindLabels[item.proposalKind] || item.proposalKind || "专家提案")}</strong><span>${item.fallbackEngine ? "V4 安全回退" : "受控提案"}</span></header>
        <dl>${multiAgentStructure(item.candidate).map(([label, value]) => `<div><dt>${htmlEscape(label)}</dt><dd>${htmlEscape(value)}</dd></div>`).join("")}</dl>
        <div class="proposal-evidence"><b>引用记忆</b>${(item.citations || []).length
          ? item.citations.map(citation => `<code title="${htmlEscape(citation.contentHash || "")}">${htmlEscape(citation.recordId || "未知记录")}</code>`).join("")
          : "<span>没有引用；保留 V4 基线</span>"}</div>
        ${(item.uncertainties || []).length ? `<p class="proposal-uncertainty">不确定项：${htmlEscape(item.uncertainties.join("；"))}</p>` : ""}
      </article>`).join("");
    const candidateHtml = candidates.map((candidate, index) => `
      <article class="candidate-card">
        <header><strong>结构候选 ${index + 1}</strong><span>${candidate.renderHash ? "已有成片哈希" : "尚未渲染"}</span></header>
        <dl>${multiAgentStructure(candidate).map(([label, value]) => `<div><dt>${htmlEscape(label)}</dt><dd>${htmlEscape(value)}</dd></div>`).join("")}</dl>
        ${candidate.renderHash ? `<code class="candidate-hash">SHA-256 ${htmlEscape(candidate.renderHash)}</code>` : '<small class="candidate-pending">只有经过真实渲染与 QA 后才可进入匿名 A/B。</small>'}
      </article>`).join("");
    const fallback = proposalBundle?.fallback?.agents?.length
      ? `<div class="experiment-warning">以下专家不可用，已逐项回退到 V4：${htmlEscape(proposalBundle.fallback.agents.join("、"))}</div>`
      : "";
    host.innerHTML = `${fallback}<div class="proposal-grid">${proposalHtml}</div>
      <div class="candidate-heading"><strong>导演保留的两个结构候选</strong><span>这里只比较差异，不赋予批准权</span></div>
      <div class="candidate-grid">${candidateHtml}</div>`;
    const renderReady = candidates.length >= 2
      && candidates.slice(0, 2).every(item => /^[a-f0-9]{64}$/.test(item.renderHash || ""));
    byId("multi-agent-build-ab").disabled = !renderReady;
    byId("multi-agent-run-review").disabled = candidates.length === 0;
  }

  function findingMarkup(review, label) {
    if (!review) return "";
    const findings = review.timecodedFindings || [];
    return `<section class="critic-report">
      <header><strong>${htmlEscape(label)}</strong><time>${htmlEscape(review.createdAt || multiAgentReviews?.reviewedAt || "时间未返回")}</time></header>
      <div class="critic-scores">${Object.entries(review.scores || {}).map(([key, value]) => `<span>${htmlEscape(key)} <b>${htmlEscape(value)}</b></span>`).join("")}</div>
      ${findings.map(item => `<article><b>${Number(item.start || 0).toFixed(1)}–${Number(item.end || 0).toFixed(1)} 秒</b><p>${htmlEscape(item.finding || item.viewingReason || item.reason || "已记录")}</p>${item.viewingReason ? `<small>观看理由：${htmlEscape(item.viewingReason)}</small>` : ""}</article>`).join("") || "<p>没有返回时间码结论。</p>"}
    </section>`;
  }

  function renderMultiAgentReview() {
    const host = byId("multi-agent-ab-review");
    if (!blindReviewBundle && !multiAgentReviews) {
      host.innerHTML = '<div class="empty-state">等待两个可验证的候选成片。没有真实 renderHash 时不会伪造比较。</div>';
      return;
    }
    const blindCandidates = (blindReviewBundle?.candidates || []).map(item => `
      <article class="blind-candidate">
        <header><strong>候选 ${htmlEscape(item.label)}</strong><span>身份已隐藏</span></header>
        <dl>${multiAgentStructure(item.structure).map(([label, value]) => `<div><dt>${htmlEscape(label)}</dt><dd>${htmlEscape(value)}</dd></div>`).join("")}</dl>
        <code>${htmlEscape(item.renderHash || "")}</code>
      </article>`).join("");
    host.innerHTML = `${blindCandidates ? `<div class="blind-grid">${blindCandidates}</div>` : ""}
      ${findingMarkup(multiAgentReviews?.blind, "匿名质量批评")}
      ${findingMarkup(multiAgentReviews?.retention, "逐秒留存质检")}`;
  }

  function renderTutorialCheckpoint() {
    const host = byId("tutorial-checkpoint");
    if (!tutorialCheckpoint) {
      host.innerHTML = '<div class="empty-state">尚未登记教程。</div>';
      return;
    }
    const stages = tutorialCheckpoint.completedStages || tutorialCheckpoint.stages || [];
    host.innerHTML = `<article class="checkpoint-card">
      <header><strong>${htmlEscape(tutorialCheckpoint.id || "教程检查点")}</strong><span>${htmlEscape(tutorialCheckpoint.stage || tutorialCheckpoint.status || "已登记")}</span></header>
      <code title="${htmlEscape(tutorialCheckpoint.sourceHash || "")}">${htmlEscape(tutorialCheckpoint.sourceHash || "等待内容哈希")}</code>
      <p>${Array.isArray(stages) ? htmlEscape(stages.join(" → ")) : htmlEscape(stages)}</p>
      <small>断点记录可恢复；原视频不会进入 Agent 长期记忆。</small>
    </article>`;
  }

  function memoryActions(record) {
    const next = {
      inbox: ["extract", "提取为技巧卡"],
      extracted: ["recreate", "进入隔离复刻"],
      recreated: ["trial", "进入项目试用"],
      trial: ["approve", "人工批准"],
      approved: ["promote", "晋级长期记忆"],
      promoted: ["disable", "停用"],
    }[record.status];
    const actions = [];
    if (next) actions.push(`<button class="btn btn-secondary" data-memory-action="${next[0]}">${next[1]}</button>`);
    if (!["rejected", "expired", "disabled"].includes(record.status)) {
      actions.push('<button class="text-button danger" data-memory-action="reject">拒绝</button>');
      actions.push('<button class="text-button" data-memory-action="expire">过期</button>');
    }
    if (record.latestTransitionId) actions.push('<button class="text-button" data-memory-action="rollback">回滚最近一步</button>');
    return actions.join("");
  }

  function renderMemoryRecords() {
    const host = byId("memory-records");
    if (!memoryRecords.length) {
      host.innerHTML = '<div class="empty-state">当前没有技巧记忆。教程提取后会先进入 inbox，不会直接影响成片。</div>';
      return;
    }
    host.innerHTML = memoryRecords.map(record => `
      <article class="memory-card" data-memory-kind="${htmlEscape(record.kind)}" data-memory-id="${htmlEscape(record.id)}">
        <header><div><strong>${htmlEscape(record.title || record.id)}</strong><small>${htmlEscape(record.namespace || "未分配命名空间")}</small></div><span class="memory-status status-${htmlEscape(record.status)}">${htmlEscape(record.status)}</span></header>
        <p>${htmlEscape(record.problem || record.primitive || record.description || "技巧记录")}</p>
        <div class="memory-meta"><span>证据 ${(record.evidence || []).length} 条</span><code title="${htmlEscape(record.contentHash || "")}">expectedHash ${htmlEscape((record.contentHash || "").slice(0, 12))}…</code></div>
        <details><summary>查看证据与版本</summary><pre>${htmlEscape(JSON.stringify({
          evidence: record.evidence || [],
          versions: record.versions || {},
          latestTransitionId: record.latestTransitionId || null,
        }, null, 2))}</pre></details>
        <div class="memory-actions">${memoryActions(record)}</div>
      </article>`).join("");
  }

  async function refreshMultiAgentStatus() {
    try {
      multiAgentStatus = await multiAgentRequest("/api/multi-agent/status");
      renderMultiAgentStatus();
      await refreshMemoryRecords();
    } catch (error) {
      multiAgentStatus = null;
      const badge = byId("multi-agent-status");
      badge.textContent = "实验服务不可用";
      badge.className = "experiment-badge is-disabled";
      byId("multi-agent-workspace").classList.add("is-hidden");
      byId("multi-agent-disabled-note").classList.remove("is-hidden");
      byId("memory-records").innerHTML = `<div class="empty-state">记忆服务读取失败：${htmlEscape(error.message)}</div>`;
      updateContentStrategyControls();
    }
  }

  async function generateMultiAgentProposals() {
    if (!currentVideoJob?.id || !multiAgentStatus?.enabled) return;
    const button = byId("multi-agent-generate");
    button.disabled = true;
    button.textContent = "三个专家正在并行提案…";
    proposalBundle = null;
    blindReviewBundle = null;
    multiAgentReviews = null;
    renderMultiAgentProposals();
    renderMultiAgentReview();
    try {
      const constraints = byId("multi-agent-constraints").value.trim();
      const payload = await multiAgentRequest(
        `/api/jobs/${encodeURIComponent(currentVideoJob.id)}/multi-agent/proposals`,
        {
          method: "POST",
          body: { constraints: constraints ? { brief: constraints } : {} },
          idempotencyPrefix: "proposal",
        }
      );
      proposalBundle = payload.bundle;
      renderMultiAgentProposals();
      toast("影子提案已生成；V4 任务和审核状态没有改变");
    } catch (error) {
      byId("multi-agent-proposals").innerHTML = `<div class="experiment-error">提案失败：${htmlEscape(error.message)}。V4 工作流仍可继续使用。</div>`;
    } finally {
      button.textContent = "为当前任务生成提案";
      renderMultiAgentStatus();
    }
  }

  async function buildMultiAgentAb() {
    const candidates = (proposalBundle?.candidates || []).slice(0, 2);
    if (candidates.length < 2) return;
    try {
      const payload = await multiAgentRequest(
        `/api/jobs/${encodeURIComponent(currentVideoJob.id)}/multi-agent/ab`,
        {
          method: "POST",
          body: { candidates, baselineId: "koubo-v4-baseline-v1" },
          idempotencyPrefix: "blind-ab",
        }
      );
      blindReviewBundle = payload.bundle;
      renderMultiAgentReview();
    } catch (error) {
      toast(`匿名 A/B 建立失败：${error.message}`);
    }
  }

  async function runMultiAgentReview() {
    const candidate = (proposalBundle?.candidates || [])[1]
      || (proposalBundle?.candidates || [])[0];
    if (!candidate || !currentVideoJob?.id) return;
    const button = byId("multi-agent-run-review");
    button.disabled = true;
    try {
      const payload = await multiAgentRequest(
        `/api/jobs/${encodeURIComponent(currentVideoJob.id)}/multi-agent/reviews`,
        {
          method: "POST",
          body: { candidate },
          idempotencyPrefix: "critic-review",
        }
      );
      multiAgentReviews = payload.reviews;
      renderMultiAgentReview();
    } catch (error) {
      toast(`双重质检失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  async function ingestTutorial() {
    const button = byId("tutorial-ingest");
    button.disabled = true;
    button.textContent = "正在登记、分镜和提取…";
    try {
      const payload = await multiAgentRequest("/api/multi-agent/tutorials", {
        method: "POST",
        body: {
          inputPath: byId("tutorial-input-path").value.trim(),
          author: byId("tutorial-author").value.trim(),
          license: byId("tutorial-license").value.trim(),
          resume: true,
        },
        idempotencyPrefix: "tutorial",
      });
      tutorialCheckpoint = payload.tutorial;
      renderTutorialCheckpoint();
      await refreshMemoryRecords();
      toast("教程已进入可恢复的知识提取流程");
    } catch (error) {
      byId("tutorial-checkpoint").innerHTML = `<div class="experiment-error">教程处理失败：${htmlEscape(error.message)}</div>`;
    } finally {
      button.textContent = "登记并提取技巧";
      renderMultiAgentStatus();
    }
  }

  async function refreshMemoryRecords() {
    try {
      const payload = await multiAgentRequest("/api/multi-agent/memory");
      memoryRecords = payload.records || [];
      renderMemoryRecords();
    } catch (error) {
      byId("memory-records").innerHTML = `<div class="empty-state">记忆读取失败：${htmlEscape(error.message)}</div>`;
    }
  }

  function parsedMemoryEvidence() {
    const raw = byId("memory-evidence-json").value.trim();
    if (!raw) return [];
    const evidence = JSON.parse(raw);
    if (!Array.isArray(evidence)) throw new Error("人工证据必须是 JSON 数组");
    return evidence;
  }

  async function transitionMemory(card, action) {
    const kind = card.dataset.memoryKind;
    const id = card.dataset.memoryId;
    const record = memoryRecords.find(item => item.kind === kind && item.id === id);
    if (!record) return;
    let evidence;
    try {
      evidence = parsedMemoryEvidence();
    } catch (error) {
      return toast(error.message);
    }
    if (["approve", "promote", "reject", "expire", "disable"].includes(action) && evidence.length === 0) {
      return toast("这个操作需要先填写可审计的人工证据");
    }
    const body = action === "rollback"
      ? { transitionId: record.latestTransitionId }
      : {
        actor: { type: "human", id: "local-owner" },
        evidence,
        expectedHash: record.contentHash,
      };
    try {
      const payload = await multiAgentRequest(
        `/api/multi-agent/memory/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/${action}`,
        {
          method: "POST",
          body,
          idempotencyPrefix: `memory-${action}`,
        }
      );
      const updated = payload.transition?.record;
      if (updated) {
        memoryRecords = memoryRecords.map(item => item.kind === kind && item.id === id
          ? { kind, ...updated, latestTransitionId: action === "rollback" ? null : payload.transition.id }
          : item);
        renderMemoryRecords();
      }
      await refreshMemoryRecords();
      toast(action === "rollback" ? "已回滚最近一次记忆变化" : `记忆状态已更新为 ${updated?.status || action}`);
    } catch (error) {
      toast(`记忆治理失败：${error.message}`);
    }
  }

  async function checkVideoService() {
    const status = byId("video-service-status");
    const detail = byId("video-service-detail");
    try {
      const response = await fetch(`${videoApiBase}/api/health`, { cache: "no-store" });
      if (!response.ok) throw new Error("服务响应异常");
      serviceHealth = await response.json();
      videoServiceOnline = !!serviceHealth.ok && !!serviceHealth.ffmpeg;
      status.textContent = videoServiceOnline ? "视觉导演 v4 工作流已就绪" : "已连接，但FFmpeg不可用";
      status.className = `service-status ${videoServiceOnline ? "is-online" : "is-offline"}`;
      renderVideoServiceDetail();
      byId("generation-status").textContent = serviceHealth.ai?.configured
        ? `已连接 ${serviceHealth.ai.model}；请先输入本次方向和真实证据，再让内容顾问分析。`
        : "视频仍可本地处理，但AI口播生成和语义剪辑需要文本模型配置。";
      updateContentStrategyControls();
      try {
        const workflowResponse = await fetch(`${videoApiBase}/api/video-workflow/defaults`, { cache: "no-store" });
        const workflowPayload = await workflowResponse.json();
        if (!workflowResponse.ok || !workflowPayload.workflow) throw new Error(workflowPayload.error || "默认配置读取失败");
        directorWorkflowDefaults = workflowPayload.workflow;
        directorDraftConfig ||= cloneJson(directorWorkflowDefaults);
        directorRenderSignature = "";
        renderDirectorWorkflow(currentVideoJob, true);
      } catch (error) {
        byId("director-stage-cards").innerHTML = `<div class="empty-state">六阶段配置读取失败：${htmlEscape(error.message)}</div>`;
      }
      await refreshMultiAgentStatus();
      await refreshGeneratedContents();
      if (!currentVideoJob) await refreshVideoJobs({ selectId: persisted.selectedVideoJobId || null });
    } catch (_) {
      serviceHealth = null;
      videoServiceOnline = false;
      status.textContent = "全自动工作流未启动";
      status.className = "service-status is-offline";
      renderVideoServiceDetail();
      byId("generation-status").textContent = "请先通过“打开AI口播工作台.vbs”启动本地工作流。";
      multiAgentStatus = null;
      renderMultiAgentStatus();
      renderVideoJobPicker();
      updateContentStrategyControls();
    }
    setAnalyzeVideoDisabled(!(videoServiceOnline && selectedVideoFile));
  }

  function handleVideoSelection(file) {
    videoJobContextToken += 1;
    const hadActiveJob = !!currentVideoJob;
    selectedVideoFile = file || null;
    currentVideoJob = null;
    persisted.selectedVideoJobId = "";
    saveState();
    proposalBundle = null;
    blindReviewBundle = null;
    multiAgentReviews = null;
    renderMultiAgentProposals();
    renderMultiAgentReview();
    renderMultiAgentStatus();
    renderVideoJobPicker();
    if (hadActiveJob && directorWorkflowDefaults) directorDraftConfig = cloneJson(directorWorkflowDefaults);
    directorRenderSignature = "";
    renderDirectorWorkflow(null, true);
    clearTimeout(videoPollTimer);
    byId("edit-results").classList.add("is-hidden");
    byId("asset-review-panel").classList.add("is-hidden");
    byId("edit-analysis").classList.add("is-hidden");
    byId("retry-video").classList.add("is-hidden");
    if (!file) {
      byId("selected-video-info").textContent = "尚未选择视频";
      byId("video-preview").classList.add("is-hidden");
      setAnalyzeVideoDisabled(true);
      setEditProgress(0, "等待选择视频");
      renderAutomationRail("upload");
      renderDemoPreview(null);
      return;
    }
    const preview = byId("video-preview");
    if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
    const objectUrl = URL.createObjectURL(file);
    preview.dataset.objectUrl = objectUrl;
    preview.src = objectUrl;
    preview.classList.remove("is-hidden");
    byId("selected-video-info").innerHTML = `<strong>${htmlEscape(file.name)}</strong><span>${formatBytes(file.size)} · ${htmlEscape(file.type || "视频文件")}</span>`;
    setAnalyzeVideoDisabled(!videoServiceOnline);
    setEditProgress(0, "视频已选择，点击一次即可开始全自动处理");
    renderAutomationRail("upload");
    renderDemoPreview(null);
  }

  function currentEditOptions() {
    const attachCurrentContent = editExperienceMode !== "demo";
    const editedScript = String(itemState().editedScript || "").trim();
    const workflowConfig = collectDirectorWorkflowOverrides();
    const contentSettings = workflowConfig.stages?.content_breakdown?.settings || {};
    const localVideoTitle = String(selectedVideoFile?.name || "口播视频").replace(/\.[^.]+$/, "").trim();
    return {
      pipeline: "visual-director-v4",
      workflowConfig,
      layout: byId("edit-layout").value,
      removeSilence: contentSettings.removeSilence !== false,
      captions: byId("edit-captions").checked,
      captionStyle: byId("edit-caption-style").value,
      informationPanels: byId("edit-information-panels").checked,
      generateVariants: byId("edit-generate-variants").checked,
      generateCover: byId("edit-generate-cover").checked,
      coverTitle: attachCurrentContent ? byId("edit-cover-title").value.trim() : "",
      contentTitle: attachCurrentContent
        ? String(itemState().selectedTitle || currentItem.mainTopic || currentItem.shortTopic || "").trim()
        : localVideoTitle,
      silenceDuration: Number(contentSettings.silenceDuration ?? 0.45),
      transcriptionModel: contentSettings.transcriptionModel || "small",
      visualStrategy: "rich-media-first",
      cloudImageGenerationEnabled: attachCurrentContent,
      paidImageGenerationConfirmation: false,
      rightsReviewMode: attachCurrentContent ? "advisory" : "strict",
      script: attachCurrentContent ? editedScript || shortText(currentItem) : ""
    };
  }

  async function analyzeSelectedVideo() {
    if (!selectedVideoFile || !videoServiceOnline) return;
    const requestToken = ++videoJobContextToken;
    const attachCurrentContent = editExperienceMode !== "demo";
    setAnalyzeVideoDisabled(true);
    setEditProgress(1, `正在把 ${selectedVideoFile.name} 复制到本地任务目录……`);
    try {
      const options = currentEditOptions();
      const draftResponse = await fetch(`${videoApiBase}/api/video-workflow/drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options)
      });
      const draftPayload = await draftResponse.json();
      if (!draftResponse.ok) throw new Error(draftPayload.error || "工作流配置保存失败");
      const uploadHeaders = {
        "Content-Type": selectedVideoFile.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(selectedVideoFile.name),
        "X-Workflow-Draft": draftPayload.draftId
      };
      if (attachCurrentContent) uploadHeaders["X-Content-Id"] = encodeURIComponent(currentItem.id);
      const response = await fetch(`${videoApiBase}/api/jobs`, {
        method: "POST",
        headers: uploadHeaders,
        body: selectedVideoFile
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "视频上传失败");
      upsertAvailableVideoJob(payload.job);
      if (requestToken !== videoJobContextToken) {
        renderVideoJobPicker();
        return;
      }
      currentVideoJob = payload.job;
      persisted.selectedVideoJobId = currentVideoJob.id;
      saveState();
      renderVideoJobPicker();
      renderDemoPreview(currentVideoJob);
      setEditProgress(4, "上传完成，工作流会自动继续，无需再次点击");
      pollVideoJob(currentVideoJob.id, requestToken);
    } catch (error) {
      if (requestToken !== videoJobContextToken) return;
      setAnalyzeVideoDisabled(false);
      setEditProgress(0, `启动失败：${error.message}`);
    }
  }

  function statusLabel(job) {
    const labels = {
      uploaded: "视频已上传", analyzing: "正在分析画面、音轨和停顿", transcribing: "正在本地逐字转录（首次可能下载模型）",
      planning: "AI正在根据逐字稿生成剪辑决策", rendering: "正在生成完整剪辑预览与分段上下文小样",
      researching_style: "正在搜索同题视频并提炼可复用包装规则",
      breaking_down_content: "正在转录、保守删错句并拆解信息段",
      generating_keyframes: "正在用真人原片生成3—5张关键帧",
      awaiting_keyframe_review: "关键帧已完成，请逐张检查后批准",
      rendering_sample: "正在渲染15—25秒HyperFrames动态样片",
      awaiting_sample_review: "动态样片已完成，请观看后批准",
      rendering_final: "正在把批准的设计扩展到2K完整视频并执行QA",
      awaiting_asset_review: "素材候选已准备，可逐条审核", revising: "正在按你的意见生成新版本", awaiting_review: "完整成片已生成，可以预览和返修", approved: "已审核通过", error: "自动处理失败",
      effect_proof_approved: "效果方向已确认，但这不是标准成片任务",
      published_by_user: "历史视频已由用户发布，但这不是标准成片任务"
    };
    return labels[job.status] || (editExperienceMode === "demo" ? "任务状态待确认" : job.status) || "处理中";
  }

  function renderAutomationRail(input) {
    const job = typeof input === "object" ? input : null;
    const status = job?.status || input;
    if (visualWorkflowJob(job)) {
      const current = job.workflow?.currentStage || "style_research";
      $$(".automation-rail [data-stage]").forEach(node => {
        const stageId = node.dataset.stage;
        const stage = job.workflow?.stages?.[stageId] || {};
        const done = job.status === "approved" || ["completed", "approved"].includes(stage.status) || (stageId === "keyframes" && job.workflow?.stages?.keyframe_review?.status === "awaiting_review");
        node.classList.toggle("is-active", stageId === current && job.status !== "approved");
        node.classList.toggle("is-done", done && !(stageId === current && ["awaiting_review", "running"].includes(stage.status)));
        node.classList.toggle("is-error", job.status === "error" && (job.errorStage || current) === stageId);
      });
      return;
    }
    const legacyStageByStatus = { uploaded: "style_research", analyzing: "content_breakdown", transcribing: "content_breakdown", planning: "content_breakdown", awaiting_asset_review: "keyframe_review", rendering: "full_render", revising: "full_render", awaiting_review: "full_render", approved: "full_render", error: "full_render" };
    const current = legacyStageByStatus[status] || "style_research";
    const currentIndex = Math.max(0, directorStageOrder.indexOf(current));
    $$(".automation-rail [data-stage]").forEach((node, index) => {
      node.classList.toggle("is-active", index === currentIndex && status !== "approved");
      node.classList.toggle("is-done", index < currentIndex || status === "approved");
      node.classList.toggle("is-error", status === "error" && index === currentIndex);
    });
  }

  async function pollVideoJob(id, contextToken = videoJobContextToken) {
    clearTimeout(videoPollTimer);
    try {
      const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "任务读取失败");
      if (contextToken !== videoJobContextToken || currentVideoJob?.id !== id) return;
      currentVideoJob = payload.job;
      upsertAvailableVideoJob(currentVideoJob);
      renderVideoJobPicker();
      renderVideoJob(currentVideoJob);
      if (videoRunningStatuses.includes(currentVideoJob.status)) {
        videoPollTimer = setTimeout(() => pollVideoJob(id, contextToken), 1400);
      }
    } catch (error) {
      if (contextToken !== videoJobContextToken || currentVideoJob?.id !== id) return;
      setEditProgress(currentVideoJob?.progress || 0, `读取任务失败：${error.message}，正在重试……`);
      videoPollTimer = setTimeout(() => pollVideoJob(id, contextToken), 2600);
    }
  }

  function renderVideoJob(job) {
    renderAutomationRail(job);
    const detail = job.revisionError ? `；最近一次返修失败：${job.revisionError}` : "";
    setEditProgress(job.progress || 0, `${statusLabel(job)}${detail}`);
    if (job.analysis) renderEditAnalysis(job);
    byId("retry-video").classList.toggle("is-hidden", job.status !== "error");
    byId("replan-video").classList.toggle("is-hidden", !(job.transcript && !videoRunningStatuses.includes(job.status)));
    renderDirectorWorkflow(job);
    renderMediaAssets(job);
    renderMultiAgentStatus();
    if (job.output) renderEditResult(job);
    else byId("edit-results").classList.add("is-hidden");
    renderDemoPreview(job);
    upsertAvailableVideoJob(job);
    renderVideoJobPicker();
    if (job.status === "error") setAnalyzeVideoDisabled(!(videoServiceOnline && selectedVideoFile));
  }

  function renderEditAnalysis(job) {
    const analysis = job.analysis || {};
    const panel = byId("edit-analysis");
    const kept = job.currentPlan?.keepSegments?.reduce((sum, item) => sum + Number(item.end) - Number(item.start), 0);
    panel.innerHTML = `
      <div><span>原始时长</span><strong>${formatDuration(job.source?.duration)}</strong></div>
      <div><span>检测到长停顿</span><strong>${analysis.silences?.length || 0} 段</strong></div>
      <div><span>预计成片</span><strong>${formatDuration(kept || (job.source?.duration - Number(analysis.removedDuration || 0)))}</strong></div>
      <div><span>逐字转录</span><strong>${htmlEscape(job.transcriptionModel || "处理中")}</strong></div>
      <p>${htmlEscape(job.currentPlan?.editSummary || "正在生成剪辑策略……")}</p>`;
    panel.classList.remove("is-hidden");
  }

  function versionOutput(job, version) {
    return (job.versions || []).find(item => Number(item.version) === Number(version)) || job.output;
  }

  function showVideoVersion(version) {
    if (!currentVideoJob) return;
    const output = versionOutput(currentVideoJob, version);
    if (!output) return;
    const finalUrl = `${videoApiBase}${output.url}?t=${Date.now()}`;
    const reviewBundle = output.reviewBundle;
    const previewMetadata = reviewBundle?.preview?.metadata || output.metadata || {};
    const landscapePreview = Number(previewMetadata.width || 0) > Number(previewMetadata.height || 0);
    const previewUrl = reviewBundle?.preview?.url ? `${videoApiBase}${reviewBundle.preview.url}?t=${Date.now()}` : finalUrl;
    byId("final-video").src = previewUrl;
    byId("download-final").href = finalUrl;
    byId("download-final").download = `${currentItem.day || "koubo"}-AI剪辑-v${output.version}.mp4`;
    byId("result-version").textContent = `版本 ${output.version}`;
    byId("review-preview-note").textContent = editExperienceMode === "demo"
      ? "这是该任务真实生成的完整效果预览。页面不会用样片或占位画面冒充最终成片，也不会自动发布。"
      : reviewBundle?.preview
        ? `当前播放${previewMetadata.width || ""}×${previewMetadata.height || ""}完整审核预览；共 ${reviewBundle.segments?.length || 0} 个上下文小样。高清母版已保留，但不会自动发布。`
        : "当前版本生成于旧流程，直接播放完整成片；下一次渲染会同时生成分段小样。";
    byId("review-segments").innerHTML = (reviewBundle?.segments || []).map((segment, index) => `
      <article class="review-segment-card ${landscapePreview ? "is-landscape" : ""}">
        <video controls playsinline preload="metadata" poster="${videoApiBase}${htmlEscape(segment.thumbnailUrl || "")}" src="${videoApiBase}${htmlEscape(segment.url)}"></video>
        <div><strong>小样 ${index + 1} · ${htmlEscape(segment.title || "视觉节点")}</strong><small>成片 ${Number(segment.start).toFixed(1)}—${Number(segment.end).toFixed(1)} 秒 · ${Number(segment.duration).toFixed(1)} 秒</small></div>
      </article>`).join("") || `<div class="empty-state">这个旧版本没有分段小样。</div>`;
    const qa = output.qa || {};
    const dynamicCaptionQa = output.captionPackaging?.requested && !["none", "static"].includes(output.captionPackaging.requested)
      ? [["动态字幕轨", qa.dynamicCaptionTrack], ["字幕安全区", qa.captionSafeArea]]
      : [];
    const coverQa = output.cover?.requested ? [["封面四画幅", qa.coverDimensions ?? output.cover.available]] : [];
    const mediaQa = [["素材审核完成", qa.mediaReviewComplete], ["批准素材已合成", qa.mediaApprovedAssetsComposited], ["外部来源署名", qa.externalAttributionRendered], ["稿件说明创作者", qa.externalScriptDisclosure]];
    byId("final-qa").innerHTML = [
      ["H.264视频", qa.h264], ["AAC音频", qa.aac], ["yuv420p兼容", qa.yuv420p], ["BT.709 SDR", qa.sdrBt709], ["完整解码", qa.decodes], ["时长校验", qa.durationMatches], ["无长黑帧", qa.noLongBlackFrames !== false], ["无长冻结", qa.noLongFreezeFrames !== false], ...dynamicCaptionQa, ...coverQa, ...mediaQa
    ].map(([label, pass]) => `<span class="qa-chip ${pass ? "pass" : "warn"}">${pass ? "✓" : "!"} ${label}</span>`).join("");
    const provenance = output.provenance === "silence-fallback" ? "停顿降级" : "语义剪辑";
    const packaging = currentVideoJob.options?.layout === "landscape-tech" ? "16:9 科技包装" : output.packaging?.engine === "hyperframes" ? "HyperFrames" : output.packaging?.engine === "ass-fallback" ? "ASS 降级" : "无动态卡片";
    const captions = output.captionPackaging?.engine === "hyperframes" ? "关键词弹入" : output.captionPackaging?.engine === "ass-static" ? "简洁静态" : output.captionPackaging?.engine === "ass-fallback" ? "ASS 降级" : "关闭";
    const color = output.colorManagement?.engine === "zscale-hable" ? "HLG→SDR / BT.709" : "BT.709";
    const coverStatus = output.cover?.available ? "四画幅已生成" : output.cover?.requested ? "生成失败" : "关闭";
    byId("capability-status").innerHTML = `<span><b>计划</b>${htmlEscape(provenance)}</span><span><b>包装</b>${htmlEscape(packaging)}${output.packaging?.panels ? ` · ${Number(output.packaging.panels)} 个分屏` : ""}</span><span><b>字幕</b>${htmlEscape(captions)}</span><span><b>色彩</b>${htmlEscape(color)}</span><span><b>封面</b>${htmlEscape(coverStatus)}</span><span><b>QA</b>${output.qaPass === false ? "需检查" : "通过"}</span><span><b>素材</b>${Number(output.media?.approvedAssets || 0)} 个已批准</span>`;
    const cover = output.cover;
    const coverPanel = byId("cover-result");
    if (cover?.available) {
      coverPanel.classList.remove("is-hidden");
      byId("cover-preview").src = `${videoApiBase}${cover.wide16x9?.url || cover.vertical.url}?t=${Date.now()}`;
      byId("cover-copy").textContent = [cover.design?.eyebrow, ...(cover.design?.lines || [])].filter(Boolean).join(" · ");
      byId("result-cover-title").value = (cover.design?.lines || []).join(" / ");
      const coverLabels = { vertical: "9:16 竖版", grid: "3:4 主页", wide16x9: "16:9 横版", landscape4x3: "4:3 横版" };
      byId("cover-downloads").innerHTML = Object.entries(coverLabels).map(([name, label]) => cover[name]?.url
        ? `<a href="${videoApiBase}${htmlEscape(cover[name].url)}" download>下载 ${label}</a>`
        : "").join("");
    } else {
      coverPanel.classList.add("is-hidden");
      byId("cover-preview").removeAttribute("src");
      byId("cover-downloads").innerHTML = "";
    }
    const variantLabels = { vertical: "9:16 竖屏", square: "1:1 方形", original: "原比例" };
    const artifactLabels = { editPlan: "剪辑计划", timeline: "时间线 JSON", edl: "CMX 3600 EDL", captions: "字幕 ASS", captionStoryboard: "动态字幕分镜", filter: "FFmpeg 脚本", qa: "QA 报告", mediaManifest: "素材清单", coverDesign: "封面设计 JSON", coverVertical: "封面 9:16", coverGrid: "封面 3:4", coverWide16x9: "封面 16:9", coverLandscape4x3: "封面 4:3", styleReport: "视觉风格分析", contentBreakdown: "内容拆解", keyframeDirection: "关键帧导演方案", motionSample: "动态样片", fullDirection: "全片导演方案", hyperframesProject: "HyperFrames 工程", hyperframesManifest: "HyperFrames 清单" };
    byId("variant-downloads").innerHTML = Object.entries(output.variants || {}).map(([name, item]) => item.available === false
      ? `<span class="variant-unavailable" title="${htmlEscape(item.reason || "当前母版无法生成")}">${variantLabels[name] || name}不可用</span>`
      : `<a href="${videoApiBase}${htmlEscape(item.url)}" download>下载 ${variantLabels[name] || name}</a>`).join("");
    byId("version-artifacts").innerHTML = Object.entries(output.artifacts || {}).map(([name, href]) => `<a href="${videoApiBase}${htmlEscape(href)}" target="_blank" rel="noreferrer">${artifactLabels[name] || name}</a>`).join("");
    $$("[data-video-version]", byId("version-list")).forEach(button => button.classList.toggle("is-active", Number(button.dataset.videoVersion) === Number(output.version)));
  }

  function renderEditResult(job) {
    const output = job.output;
    const degraded = (job.degraded || []).map(item => `<li>${htmlEscape(item)}</li>`).join("");
    byId("edit-summary").innerHTML = `<strong>AI剪辑说明：</strong> ${htmlEscape(job.currentPlan?.editSummary || "自动剪辑完成")}${degraded ? `<ul class="degraded-list">${degraded}</ul>` : ""}`;
    const versions = [...(job.versions || [])].sort((x, y) => Number(x.version) - Number(y.version));
    byId("version-list").innerHTML = versions.map(item => `<button class="version-chip ${item.version === output.version ? "is-active" : ""}" data-video-version="${item.version}">版本 ${item.version}</button>`).join("");
    byId("review-history").innerHTML = (job.reviews || []).length
      ? `<strong>返修记录</strong>${job.reviews.map(item => `<p>版本 ${htmlEscape(item.version)}：${htmlEscape(item.feedback)}</p>`).join("")}`
      : "";
    byId("job-folder").textContent = `任务目录：${job.jobDir || job.output?.path?.replace(/[\\/][^\\/]+$/, "") || `video-jobs\\${job.id}`}`;
    renderMediaAssets(job);
    const approved = job.status === "approved";
    byId("video-review-feedback").disabled = approved;
    byId("revise-video").disabled = approved;
    byId("approve-video").disabled = approved;
    byId("approve-video").textContent = approved ? "已审核通过" : "审核通过";
    byId("edit-results").classList.remove("is-hidden");
    showVideoVersion(output.version);
  }

  async function regenerateVideoCover() {
    if (!currentVideoJob?.id) return;
    const button = byId("regenerate-cover");
    button.disabled = true;
    button.textContent = "正在重做四张封面…";
    try {
      const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(currentVideoJob.id)}/cover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coverTitle: byId("result-cover-title").value.trim() })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "封面生成失败");
      currentVideoJob = payload.job;
      renderVideoJob(currentVideoJob);
      toast("四张封面已重做，视频没有重新渲染");
    } catch (error) {
      toast(`封面生成失败：${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = "只重做四张封面";
    }
  }

  async function submitVideoRevision() {
    if (!currentVideoJob?.id) return;
    const feedback = byId("video-review-feedback").value.trim();
    if (!feedback) return toast("请先写明哪里需要修改");
    byId("revise-video").disabled = true;
    byId("approve-video").disabled = true;
    try {
      const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(currentVideoJob.id)}/revise`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedback })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "返修启动失败");
      byId("video-review-feedback").value = "";
      pollVideoJob(currentVideoJob.id);
    } catch (error) {
      toast(`返修失败：${error.message}`);
      byId("revise-video").disabled = false;
      byId("approve-video").disabled = false;
    }
  }

  async function approveVideo() {
    if (!currentVideoJob?.id) return;
    try {
      const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(currentVideoJob.id)}/approve`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "审核提交失败");
      currentVideoJob = payload.job;
      renderVideoJob(currentVideoJob);
      toast("已审核通过，工作流不会自动发布");
    } catch (error) { toast(`审核失败：${error.message}`); }
  }

  async function retryVideoJob() {
    if (!currentVideoJob?.id) return;
    const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(currentVideoJob.id)}/retry`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) return toast(payload.error || "重试失败");
    pollVideoJob(currentVideoJob.id);
  }

  function clearSelectedVideoFilePreview() {
    selectedVideoFile = null;
    const input = byId("video-file");
    if (input) input.value = "";
    const preview = byId("video-preview");
    if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
    preview.dataset.objectUrl = "";
    preview.removeAttribute("src");
    preview.classList.add("is-hidden");
    byId("selected-video-info").textContent = "当前正在查看已有任务；重新选择视频会创建新任务。";
    setAnalyzeVideoDisabled(true);
  }

  async function loadVideoJob(id, { announce = true } = {}) {
    if (!id) {
      handleVideoSelection(null);
      return null;
    }
    const requestToken = ++videoJobContextToken;
    clearTimeout(videoPollTimer);
    byId("video-job-picker").disabled = true;
    byId("refresh-video-jobs").disabled = true;
    setEditProgress(currentVideoJob?.progress || 0, "正在打开已有任务……");
    try {
      const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.job) throw new Error(payload.error || "任务读取失败");
      if (requestToken !== videoJobContextToken) return null;
      currentVideoJob = payload.job;
      clearSelectedVideoFilePreview();
      proposalBundle = null;
      blindReviewBundle = null;
      multiAgentReviews = null;
      directorRenderSignature = "";
      persisted.selectedVideoJobId = currentVideoJob.id;
      saveState();
      upsertAvailableVideoJob(currentVideoJob);
      renderVideoJob(currentVideoJob);
      renderMultiAgentProposals();
      renderMultiAgentReview();
      if (videoRunningStatuses.includes(currentVideoJob.status)) pollVideoJob(currentVideoJob.id, requestToken);
      if (announce) toast(jobHasStandardOutput(currentVideoJob) ? "已打开可预览任务" : "已打开任务；结果边界已显示");
      return currentVideoJob;
    } catch (error) {
      if (requestToken !== videoJobContextToken) return null;
      setEditProgress(currentVideoJob?.progress || 0, `任务打开失败：${error.message}`);
      toast(`任务打开失败：${error.message}`);
      return null;
    } finally {
      renderVideoJobPicker();
    }
  }

  async function refreshVideoJobs({ selectId = null, loadSelected = true } = {}) {
    if (!videoServiceOnline || videoJobsLoading) return;
    videoJobsLoading = true;
    renderVideoJobPicker();
    try {
      const response = await fetch(`${videoApiBase}/api/jobs`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "任务列表读取失败");
      availableVideoJobs = Array.isArray(payload.jobs) ? payload.jobs.filter(job => job?.id) : [];
      const preferred = selectId && availableVideoJobs.some(job => job.id === selectId)
        ? selectId
        : currentVideoJob?.id && availableVideoJobs.some(job => job.id === currentVideoJob.id)
          ? currentVideoJob.id
          : persisted.selectedVideoJobId && availableVideoJobs.some(job => job.id === persisted.selectedVideoJobId)
            ? persisted.selectedVideoJobId
            : availableVideoJobs[0]?.id || "";
      if (loadSelected && preferred) await loadVideoJob(preferred, { announce: false });
      else if (!preferred) renderDemoPreview(null);
    } catch (error) {
      toast(`任务列表读取失败：${error.message}`);
    } finally {
      videoJobsLoading = false;
      renderVideoJobPicker();
    }
  }

  async function restoreLatestVideoJob() {
    await refreshVideoJobs({ selectId: persisted.selectedVideoJobId || null });
  }

  async function replanVideoJob() {
    if (!currentVideoJob?.id) return;
    byId("replan-video").disabled = true;
    const feedback = byId("video-review-feedback").value.trim();
    try {
      const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(currentVideoJob.id)}/replan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedback }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "重新规划失败");
      toast("已复用现有逐字稿，不会重新运行 Whisper");
      pollVideoJob(currentVideoJob.id);
    } catch (error) { toast(`重新规划失败：${error.message}`); byId("replan-video").disabled = false; }
  }

  function renderMediaAssets(job) {
    const assets = job.assets || [];
    const panel = byId("asset-review-panel");
    panel.classList.toggle("is-hidden", !assets.length && !job.assetDiscovery);
    const review = job.assetReview || {};
    byId("asset-review-summary").textContent = `${Number(review.approved || 0)} 已批准 · ${Number(review.rejected || 0)} 已拒绝 · ${Number(review.pending ?? assets.filter(asset => !asset.reviewStatus || asset.reviewStatus === "pending").length)} 待决定`;
    byId("asset-discovery-note").textContent = job.assetDiscovery?.note || "本地上传的素材也必须先审核，未批准不会进入成片。";
    const canRender = review.reviewComplete === true && review.renderReady === true && !["rendering", "revising"].includes(job.status);
    byId("render-with-assets").disabled = !canRender;
    byId("auto-review-preview").disabled = !job.id || !["awaiting_asset_review", "awaiting_review"].includes(job.status);
    byId("rediscover-media").disabled = !job.id || ["rendering", "revising", "planning", "transcribing"].includes(job.status);
    byId("render-with-assets").textContent = job.output ? "按当前决定生成新预览" : "按当前决定生成预览";
    const sourceLabels = {
      "local-derived": "真实画面衍生", "local-upload": "本地上传", "ai-generated-free": "本地生成视觉",
      "licensed-free": "免费许可素材", "external-creator": "外部创作者视频", "licensed-external": "已授权外部素材",
      "paid-stock": "付费素材", "paid-generated": "付费AI生成"
    };
    const licenseOptions = [
      ["", "请选择授权/引用依据"], ["explicit-authorization", "已取得明确授权"], ["creator-permission", "创作者明确允许"],
      ["platform-license", "平台许可允许使用"], ["commentary-quotation", "为介绍/评论作必要短引用"],
      ["user-owned-local", "本人所有的本地素材"], ["locally-generated", "本地生成素材"]
    ];
    byId("media-assets").innerHTML = assets.length ? assets.map(asset => {
      const external = ["external-creator", "licensed-external"].includes(asset.sourceType);
      const status = asset.reviewStatus || (asset.approved ? "approved" : "pending");
      const preview = asset.previewUrl || asset.url;
      const previewHtml = preview
        ? asset.mediaKind === "video" ? `<video src="${videoApiBase}${htmlEscape(preview)}" muted preload="metadata"></video>` : `<img src="${videoApiBase}${htmlEscape(preview)}" alt="素材预览">`
        : `<div class="asset-missing">尚未附加可渲染文件</div>`;
      const sourceLink = asset.sourceUrl ? `<a href="${htmlEscape(asset.sourceUrl)}" target="_blank" rel="noreferrer">打开原来源</a>` : "";
      const externalFields = external ? `<div class="asset-metadata-grid">
        <label>创作者公开名称<input data-creator-name value="${htmlEscape(asset.creatorName || "")}" placeholder="不能写待确认账号"></label>
        <label>作品标题<input data-work-title value="${htmlEscape(asset.workTitle || "")}" placeholder="原作品标题"></label>
        <label class="wide">原视频链接<input data-source-url value="${htmlEscape(asset.sourceUrl || "")}" placeholder="https://..."></label>
        <label class="wide">使用目的<input data-usage-purpose value="${htmlEscape(asset.usagePurpose || "")}" placeholder="例如：分析该视频如何用结果开场"></label>
        <label>授权/引用依据<select data-license-basis>${licenseOptions.map(([value, label]) => `<option value="${value}" ${asset.licenseBasis === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
        <label>原片截取开始秒<input data-clip-start type="number" min="0" step="0.1" value="${htmlEscape(asset.clipStart ?? 0)}"></label>
        <label>原片截取结束秒<input data-clip-end type="number" min="0.1" step="0.1" value="${htmlEscape(asset.clipEnd ?? "")}"></label>
        <label>引用时长（秒）<input data-clip-duration type="number" min="0.1" step="0.1" value="${htmlEscape(asset.clipDuration ?? "")}"></label>
        <label class="wide">画面署名<input data-attribution-text value="${htmlEscape(asset.attributionText || "")}" placeholder="来源：创作者｜作品标题"></label>
      </div>` : "";
      return `<article class="media-asset status-${status}" data-asset-id="${htmlEscape(asset.id)}">
        <div class="asset-preview">${previewHtml}<span>${htmlEscape(sourceLabels[asset.sourceType] || asset.sourceType || "素材")}</span></div>
        <div class="asset-detail"><div class="asset-title"><div><strong>${htmlEscape(asset.title || asset.fileName || "补充素材")}</strong><small>${status === "approved" ? "已批准，下一次渲染会使用" : status === "rejected" ? "已拒绝，不会进入成片" : "待审核，尚不会进入成片"}</small></div>${sourceLink}</div>
          <p>${htmlEscape(asset.requestedAsset || asset.usagePurpose || asset.sourceLabel || "")}</p>
          <div class="asset-placement"><label>成片开始秒<input data-media-start type="number" min="0" step="0.1" value="${htmlEscape(asset.placement?.start ?? "")}"></label><label>成片结束秒<input data-media-end type="number" min="0" step="0.1" value="${htmlEscape(asset.placement?.end ?? "")}"></label><label>画面方式<select data-media-mode><option value="broll" ${asset.placement?.mode === "broll" ? "selected" : ""}>全屏B-roll</option><option value="pip" ${asset.placement?.mode === "pip" ? "selected" : ""}>右上画中画</option><option value="comparison-left" ${asset.placement?.mode === "comparison-left" ? "selected" : ""}>前后对比左侧</option><option value="comparison-right" ${asset.placement?.mode === "comparison-right" ? "selected" : ""}>前后对比右侧</option></select></label></div>
          ${externalFields}
          ${asset.paymentRequired ? `<label class="payment-confirm"><input data-payment-confirmed type="checkbox" ${asset.paymentConfirmed ? "checked" : ""}> 我已看到预计费用并确认本次付费调用</label>` : ""}
          <div class="asset-actions"><label class="btn btn-secondary file-replace">${preview ? "替换文件" : "附加片段"}<input data-asset-replacement type="file" accept="image/*,video/*"></label><button class="btn btn-secondary" data-reject-media>拒绝</button><button class="btn btn-primary" data-approve-media>${status === "approved" ? "更新并保持批准" : "确认并批准"}</button></div>
        </div></article>`;
    }).join("") : "<p class=\"empty-media\">还没有素材候选。</p>";
  }

  async function uploadMediaAsset() {
    const file = byId("media-file").files?.[0];
    if (!file || !currentVideoJob?.id) return;
    byId("upload-media").disabled = true;
    try {
      const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(currentVideoJob.id)}/assets`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }, body: file });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "素材加入失败");
      currentVideoJob = payload.job; renderVideoJob(currentVideoJob); byId("media-file").value = ""; toast("素材已本地入库，尚未批准");
    } catch (error) { toast(error.message); } finally { byId("upload-media").disabled = !byId("media-file").files?.length; }
  }

  async function rediscoverMediaAssets() {
    if (!currentVideoJob?.id) return;
    byId("rediscover-media").disabled = true;
    try {
      const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(currentVideoJob.id)}/assets/rediscover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "用户要求用真实录屏、前后对比、动态流程和AI视觉替换纯文字卡片",
          cloudImageGenerationEnabled: true,
          paidImageGenerationConfirmation: false,
          rightsReviewMode: "advisory"
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "富媒体候选生成失败");
      currentVideoJob = payload.job;
      renderVideoJob(currentVideoJob);
      toast(`富媒体候选已重建，旧素材清单已保留为第 ${payload.archivedVersions || 1} 版历史`);
    } catch (error) {
      toast(error.message);
    } finally {
      byId("rediscover-media").disabled = !currentVideoJob?.id;
    }
  }

  async function autoReviewAndPreview() {
    if (!currentVideoJob?.id) return;
    const button = byId("auto-review-preview");
    button.disabled = true;
    button.textContent = "正在采用本地素材并启动预览…";
    try {
      const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(currentVideoJob.id)}/assets/auto-review-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "自动采用可渲染本地素材，跳过外部或缺文件素材，生成完整预览与15—30秒上下文小样" })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "完整预览启动失败");
      currentVideoJob = payload.job;
      renderVideoJob(currentVideoJob);
      toast(`已自动决定 ${payload.decisions?.length || 0} 个素材，正在生成完整预览与分段小样`);
      pollVideoJob(currentVideoJob.id);
    } catch (error) {
      toast(error.message);
      renderMediaAssets(currentVideoJob);
    } finally {
      button.textContent = "自动采用本地素材并生成完整预览";
    }
  }

  async function decideMediaAsset(row, decision) {
    const start = Number(row.querySelector("[data-media-start]").value), end = Number(row.querySelector("[data-media-end]").value);
    if (decision === "approved" && (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)) return toast("请填写有效的素材开始和结束秒数");
    const id = row.dataset.assetId;
    const value = selector => row.querySelector(selector)?.value?.trim() || "";
    const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(currentVideoJob.id)}/assets/${encodeURIComponent(id)}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      approved: decision === "approved", reviewStatus: decision, ownership: "user-confirmed",
      creatorName: value("[data-creator-name]"), workTitle: value("[data-work-title]"), sourceUrl: value("[data-source-url]"),
      usagePurpose: value("[data-usage-purpose]"), licenseBasis: value("[data-license-basis]"), attributionText: value("[data-attribution-text]"),
      clipStart: Number(value("[data-clip-start]")) || 0, clipEnd: Number(value("[data-clip-end]")) || undefined,
      clipDuration: Number(value("[data-clip-duration]")) || undefined,
      paymentConfirmed: row.querySelector("[data-payment-confirmed]")?.checked === true,
      placement: Number.isFinite(start) && Number.isFinite(end) ? { start, end, mode: value("[data-media-mode]") || "broll" } : null
    }) });
    const payload = await response.json(); if (!response.ok) return toast(payload.error || "素材批准失败");
    currentVideoJob = payload.job; renderVideoJob(currentVideoJob); toast(decision === "approved" ? "素材已批准并通过合规检查" : "素材已拒绝，不会进入成片");
  }

  async function replaceMediaAsset(row, file) {
    if (!file || !currentVideoJob?.id) return;
    const id = row.dataset.assetId;
    const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(currentVideoJob.id)}/assets/${encodeURIComponent(id)}/file`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }, body: file });
    const payload = await response.json();
    if (!response.ok) return toast(payload.error || "替换素材失败");
    currentVideoJob = payload.job;
    renderVideoJob(currentVideoJob);
    toast("文件已附加，素材恢复为待审核状态");
  }

  async function renderWithApprovedAssets() {
    if (!currentVideoJob?.id) return;
    byId("render-with-assets").disabled = true;
    const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(currentVideoJob.id)}/assets/render`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) { renderMediaAssets(currentVideoJob); return toast(payload.error || "素材渲染启动失败"); }
    currentVideoJob = payload.job;
    renderVideoJob(currentVideoJob);
    pollVideoJob(currentVideoJob.id);
  }

  function reviewSummary() {
    const state = itemState();
    const cover = covers().find(item => item.id === state.selectedCover);
    return [
      `口播样例：${currentItem.mainTopic}`,
      `审核状态：${state.reviewStatus}`,
      `选择标题：${state.selectedTitle || "未选择"}`,
      `选择封面：${cover ? `${cover.name} / ${cover.copy}` : "未选择"}`,
      `修改意见：${state.notes || "无"}`,
      `下一集选择：请根据我的意见继续修改，不要自动发布。`
    ].join("\n");
  }

  function exportReview() {
    const state = itemState();
    const cover = covers().find(item => item.id === state.selectedCover);
    const payload = {
      exportedAt: new Date().toISOString(),
      contentId: currentItem.id,
      topic: currentItem.mainTopic,
      reviewStatus: state.reviewStatus,
      selectedTitle: state.selectedTitle || null,
      selectedCover: cover || null,
      notes: state.notes || "",
      editedScript: state.editedScript || fullPlainText(),
      brollChecks: state.broll,
      shootChecks: state.shoot,
      riskChecks: state.risks,
      autoPublish: false
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `口播审核-${currentItem.id}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast("审核结果已导出");
  }

  // Navigation
  $$(".nav-item").forEach(button => button.addEventListener("click", () => switchView(button.dataset.view)));
  document.addEventListener("click", event => {
    const go = event.target.closest("[data-go]");
    if (go) switchView(go.dataset.go);
    const open = event.target.closest("[data-open-item]");
    if (open) { setCurrentItem(open.dataset.openItem); switchView("today"); }
  });
  byId("mobile-menu").addEventListener("click", () => $(".sidebar").classList.toggle("is-open"));
  byId("content-picker").addEventListener("change", event => setCurrentItem(event.target.value));

  // Review state
  $$(".status-btn").forEach(button => button.addEventListener("click", () => {
    itemState().reviewStatus = button.dataset.reviewStatus; saveState(); renderStatus();
  }));
  byId("review-notes").addEventListener("input", event => { itemState().notes = event.target.value; saveState(); });
  byId("copy-review-summary").addEventListener("click", () => copyText(reviewSummary(), "审核意见已复制"));
  byId("export-review").addEventListener("click", exportReview);

  // Script actions
  $$(".segment").forEach(button => button.addEventListener("click", () => setScriptMode(button.dataset.scriptMode)));
  byId("copy-short-hero").addEventListener("click", () => copyText(fullPlainText(), "2—3分钟完整版已复制"));
  byId("copy-home-script").addEventListener("click", () => copyText(fullPlainText(), "2—3分钟完整版已复制"));
  byId("copy-source-path").addEventListener("click", () => copyText(sourcePackagePath(), "文件位置已复制"));
  byId("copy-short-script").addEventListener("click", () => copyText(shortText(), "精简稿已复制"));
  byId("copy-current-script").addEventListener("click", () => copyText(currentScriptText(), "当前口播稿已复制"));
  byId("edited-script").addEventListener("input", event => { itemState().editedScript = event.target.value; saveState(); });
  byId("reset-edited-script").addEventListener("click", () => {
    if (!confirm("确定恢复原稿？当前浏览器中的修改会被清除。")) return;
    itemState().editedScript = fullPlainText(); byId("edited-script").value = fullPlainText(); saveState(true);
  });

  // Creative choices
  byId("title-options").addEventListener("change", event => {
    if (!event.target.matches('input[name="title-option"]')) return;
    itemState().selectedTitle = event.target.value; saveState(); renderCreative();
  });
  byId("use-custom-title").addEventListener("click", () => {
    const value = byId("custom-title").value.trim();
    if (!value) return toast("请先输入标题");
    itemState().selectedTitle = value; saveState(); renderCreative(); toast("已使用自定义标题");
  });
  byId("cover-options").addEventListener("click", event => {
    const card = event.target.closest("[data-cover-id]");
    if (!card) return;
    itemState().selectedCover = card.dataset.coverId; saveState(); renderCreative();
  });
  byId("copy-creative-choice").addEventListener("click", () => {
    const state = itemState();
    const cover = covers().find(item => item.id === state.selectedCover);
    copyText(`标题：${state.selectedTitle || "未选择"}\n封面：${cover ? `${cover.copy}（${cover.name}）` : "未选择"}`, "标题和封面已复制");
  });

  // Checklists
  document.addEventListener("change", event => {
    const checkbox = event.target.closest("[data-check-group]");
    if (!checkbox) return;
    const group = checkbox.dataset.checkGroup;
    const index = checkbox.dataset.checkIndex;
    if (!itemState()[group]) itemState()[group] = {};
    itemState()[group][index] = checkbox.checked;
    saveState();
    if (group === "broll" || group === "shoot") updateReadiness();
    if (group === "risks") updateRiskProgress();
  });

  // One-click content generation and automatic video workflow
  byId("analyze-content-direction").addEventListener("click", analyzeContentDirection);
  byId("content-direction").addEventListener("input", () => resetContentStrategyAnalysis());
  byId("content-evidence-summary").addEventListener("input", () => resetContentStrategyAnalysis());
  byId("confirm-content-strategy").addEventListener("change", updateContentStrategyControls);
  byId("generate-content").addEventListener("click", generateNewContent);
  byId("video-file").addEventListener("change", event => handleVideoSelection(event.target.files?.[0]));
  byId("analyze-video").addEventListener("click", analyzeSelectedVideo);
  byId("demo-analyze-video").addEventListener("click", analyzeSelectedVideo);
  $$("[data-edit-mode]").forEach(button => button.addEventListener("click", () => setEditExperienceMode(button.dataset.editMode)));
  byId("video-job-picker").addEventListener("change", event => loadVideoJob(event.target.value));
  byId("refresh-video-jobs").addEventListener("click", () => refreshVideoJobs({ selectId: currentVideoJob?.id || persisted.selectedVideoJobId || null }));
  byId("retry-video").addEventListener("click", retryVideoJob);
  byId("replan-video").addEventListener("click", replanVideoJob);
  byId("revise-video").addEventListener("click", submitVideoRevision);
  byId("approve-video").addEventListener("click", approveVideo);
  byId("regenerate-cover").addEventListener("click", regenerateVideoCover);
  byId("media-file").addEventListener("change", event => { byId("upload-media").disabled = !event.target.files?.length || !currentVideoJob?.id; });
  byId("upload-media").addEventListener("click", uploadMediaAsset);
  byId("rediscover-media").addEventListener("click", rediscoverMediaAssets);
  byId("auto-review-preview").addEventListener("click", autoReviewAndPreview);
  byId("render-with-assets").addEventListener("click", renderWithApprovedAssets);
  byId("multi-agent-refresh").addEventListener("click", refreshMultiAgentStatus);
  byId("multi-agent-generate").addEventListener("click", generateMultiAgentProposals);
  byId("multi-agent-build-ab").addEventListener("click", buildMultiAgentAb);
  byId("multi-agent-run-review").addEventListener("click", runMultiAgentReview);
  byId("tutorial-ingest").addEventListener("click", ingestTutorial);
  for (const id of ["tutorial-input-path", "tutorial-author", "tutorial-license"]) {
    byId(id).addEventListener("input", renderMultiAgentStatus);
  }
  byId("memory-refresh").addEventListener("click", refreshMemoryRecords);
  byId("memory-records").addEventListener("click", event => {
    const button = event.target.closest("[data-memory-action]");
    const card = button?.closest("[data-memory-kind][data-memory-id]");
    if (button && card) transitionMemory(card, button.dataset.memoryAction);
  });
  byId("director-stage-cards").addEventListener("click", event => {
    const button = event.target.closest("[data-director-save],[data-director-run],[data-director-approve]");
    if (button) handleDirectorAction(button);
  });
  byId("media-assets").addEventListener("click", event => {
    const approve = event.target.closest("[data-approve-media]");
    const reject = event.target.closest("[data-reject-media]");
    if (approve) decideMediaAsset(approve.closest("[data-asset-id]"), "approved");
    if (reject) decideMediaAsset(reject.closest("[data-asset-id]"), "rejected");
  });
  byId("media-assets").addEventListener("change", event => {
    const input = event.target.closest("[data-asset-replacement]");
    if (input?.files?.[0]) replaceMediaAsset(input.closest("[data-asset-id]"), input.files[0]);
  });
  byId("version-list").addEventListener("click", event => {
    const button = event.target.closest("[data-video-version]");
    if (button) showVideoVersion(Number(button.dataset.videoVersion));
  });

  // Publish
  $$(".platform-tab").forEach(button => button.addEventListener("click", () => setPlatform(button.dataset.platform)));
  byId("copy-publish").addEventListener("click", () => copyText(byId("publish-text").value, "发布文案已复制"));

  // Roadmap and library
  byId("library-search").addEventListener("input", renderLibrary);
  $$(".filter-btn").forEach(button => button.addEventListener("click", () => {
    libraryFilter = button.dataset.filter;
    $$(".filter-btn").forEach(item => item.classList.toggle("is-active", item === button));
    renderLibrary();
  }));

  // Teleprompter
  byId("start-teleprompter").addEventListener("click", () => { setScriptMode("full"); openTeleprompter(); });
  byId("open-teleprompter").addEventListener("click", openTeleprompter);
  byId("close-teleprompter").addEventListener("click", closeTeleprompter);
  byId("tele-play").addEventListener("click", toggleTeleprompter);
  byId("tele-reset").addEventListener("click", () => { stopTeleprompter(); byId("teleprompter-scroll").scrollTop = 0; });
  byId("font-size-range").addEventListener("input", event => {
    byId("font-size-value").textContent = event.target.value;
    byId("teleprompter-text").style.fontSize = `${event.target.value}px`;
  });
  byId("speed-range").addEventListener("input", event => { byId("speed-value").textContent = event.target.value; });
  byId("tele-fullscreen").addEventListener("click", () => {
    const tele = $(".teleprompter");
    if (!document.fullscreenElement && tele.requestFullscreen) tele.requestFullscreen();
    else if (document.exitFullscreen) document.exitFullscreen();
  });
  byId("teleprompter-modal").addEventListener("click", event => { if (event.target === byId("teleprompter-modal")) closeTeleprompter(); });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && byId("teleprompter-modal").classList.contains("is-open")) closeTeleprompter();
    if (event.code === "Space" && byId("teleprompter-modal").classList.contains("is-open") && !event.target.matches("input,textarea,button")) { event.preventDefault(); toggleTeleprompter(); }
  });

  // Initialize remembered mode and render
  renderAll();
  renderMultiAgentStatus();
  renderMultiAgentProposals();
  renderMultiAgentReview();
  renderTutorialCheckpoint();
  renderMemoryRecords();
  renderVideoJobPicker();
  setScriptMode(persisted.scriptMode || "full");
  setEditExperienceMode(editExperienceMode, false);
  checkVideoService();
})();
