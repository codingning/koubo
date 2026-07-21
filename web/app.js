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
  let videoPollTimer = null;

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
    $$(".view").forEach(section => section.classList.toggle("is-active", section.id === `view-${view}`));
    $$(".nav-item").forEach(button => button.classList.toggle("is-active", button.dataset.view === view));
    byId("page-eyebrow").textContent = pageNames[view][0];
    byId("page-title").textContent = pageNames[view][1];
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
    byId("home-script-duration").textContent = currentItem.durationShort || "精简版";
    byId("home-script-preview").textContent = shortText(currentItem);
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

  function setEditProgress(value, message) {
    byId("edit-progress-bar").style.width = `${Math.max(0, Math.min(100, Number(value || 0)))}%`;
    if (message) byId("edit-job-status").textContent = message;
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
    if (!videoServiceOnline || contentGenerating) return;
    contentGenerating = true;
    const button = byId("generate-content");
    button.disabled = true;
    button.textContent = "AI正在生成……";
    byId("generation-status").textContent = "正在汇总最近真实进展、Git记录和公开边界，然后由文本模型生成可拍口播。通常需要1—3分钟。";
    try {
      const response = await fetch(`${videoApiBase}/api/contents/generate`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "口播生成失败");
      await refreshGeneratedContents(payload.item.id);
      switchView("today");
      byId("generation-status").textContent = `已生成 ${payload.item.day} · ${payload.item.mainTopic}`;
      toast("新口播已生成，可以直接拍摄");
    } catch (error) {
      byId("generation-status").textContent = `生成失败：${error.message}`;
      toast("生成失败，请查看页面提示");
    } finally {
      contentGenerating = false;
      button.textContent = "AI生成新口播";
      button.disabled = !(videoServiceOnline && serviceHealth?.ai?.configured);
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
      status.textContent = videoServiceOnline ? "全自动口播工作流已就绪" : "已连接，但FFmpeg不可用";
      status.className = `service-status ${videoServiceOnline ? "is-online" : "is-offline"}`;
      const modelText = serviceHealth.ai?.configured ? `文本模型 ${serviceHealth.ai.model}` : "文本模型未配置";
      detail.textContent = videoServiceOnline
        ? `本地视频处理 · ${modelText} · 本地转录 ${serviceHealth.ai?.transcriptionModel || "faster-whisper/small"}`
        : "请确认 FFmpeg 已安装并重新打开工作台。";
      byId("generation-status").textContent = serviceHealth.ai?.configured
        ? `已连接 ${serviceHealth.ai.model}；点击即可根据最近真实进展生成新口播。`
        : "视频仍可本地处理，但AI口播生成和语义剪辑需要文本模型配置。";
      byId("generate-content").disabled = !(videoServiceOnline && serviceHealth.ai?.configured);
      await refreshGeneratedContents();
      if (!currentVideoJob) await restoreLatestVideoJob();
    } catch (_) {
      serviceHealth = null;
      videoServiceOnline = false;
      status.textContent = "全自动工作流未启动";
      status.className = "service-status is-offline";
      detail.textContent = "请双击项目根目录的“打开AI口播工作台.vbs”；它会静默启动服务并重新打开网页。";
      byId("generation-status").textContent = "请先通过“打开AI口播工作台.vbs”启动本地工作流。";
      byId("generate-content").disabled = true;
    }
    byId("analyze-video").disabled = !(videoServiceOnline && selectedVideoFile);
  }

  function handleVideoSelection(file) {
    selectedVideoFile = file || null;
    currentVideoJob = null;
    clearTimeout(videoPollTimer);
    byId("edit-results").classList.add("is-hidden");
    byId("edit-analysis").classList.add("is-hidden");
    byId("retry-video").classList.add("is-hidden");
    if (!file) {
      byId("selected-video-info").textContent = "尚未选择视频";
      byId("video-preview").classList.add("is-hidden");
      byId("analyze-video").disabled = true;
      setEditProgress(0, "等待选择视频");
      renderAutomationRail("upload");
      return;
    }
    const preview = byId("video-preview");
    if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
    const objectUrl = URL.createObjectURL(file);
    preview.dataset.objectUrl = objectUrl;
    preview.src = objectUrl;
    preview.classList.remove("is-hidden");
    byId("selected-video-info").innerHTML = `<strong>${htmlEscape(file.name)}</strong><span>${formatBytes(file.size)} · ${htmlEscape(file.type || "视频文件")}</span>`;
    byId("analyze-video").disabled = !videoServiceOnline;
    setEditProgress(0, "视频已选择，点击一次即可开始全自动处理");
    renderAutomationRail("upload");
  }

  function currentEditOptions() {
    const editedScript = String(itemState().editedScript || "").trim();
    return {
      layout: byId("edit-layout").value,
      removeSilence: byId("edit-remove-silence").checked,
      captions: byId("edit-captions").checked,
      captionStyle: byId("edit-caption-style").value,
      informationPanels: byId("edit-information-panels").checked,
      generateVariants: byId("edit-generate-variants").checked,
      generateCover: byId("edit-generate-cover").checked,
      coverTitle: byId("edit-cover-title").value.trim(),
      contentTitle: String(itemState().selectedTitle || currentItem.mainTopic || currentItem.shortTopic || "").trim(),
      silenceDuration: Number(byId("edit-silence-duration").value),
      transcriptionModel: byId("edit-transcription-model").value,
      script: editedScript || shortText(currentItem)
    };
  }

  async function analyzeSelectedVideo() {
    if (!selectedVideoFile || !videoServiceOnline) return;
    byId("analyze-video").disabled = true;
    setEditProgress(1, `正在把 ${selectedVideoFile.name} 复制到本地任务目录……`);
    try {
      const response = await fetch(`${videoApiBase}/api/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": selectedVideoFile.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(selectedVideoFile.name),
          "X-Content-Id": encodeURIComponent(currentItem.id),
          "X-Options": encodeURIComponent(JSON.stringify(currentEditOptions()))
        },
        body: selectedVideoFile
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "视频上传失败");
      currentVideoJob = payload.job;
      setEditProgress(4, "上传完成，工作流会自动继续，无需再次点击");
      pollVideoJob(currentVideoJob.id);
    } catch (error) {
      byId("analyze-video").disabled = false;
      setEditProgress(0, `启动失败：${error.message}`);
    }
  }

  function statusLabel(job) {
    const labels = {
      uploaded: "视频已上传", analyzing: "正在分析画面、音轨和停顿", transcribing: "正在本地逐字转录（首次可能下载模型）",
      planning: "AI正在根据逐字稿生成剪辑决策", rendering: "正在加字幕、重点卡片、调音量并渲染",
      revising: "正在按你的意见生成新版本", awaiting_review: "成片已完成，请你最终审核", approved: "已审核通过", error: "自动处理失败"
    };
    return labels[job.status] || job.status || "处理中";
  }

  function renderAutomationRail(status) {
    const stageByStatus = { uploaded: "upload", analyzing: "upload", transcribing: "transcribe", planning: "plan", rendering: "render", revising: "render", awaiting_review: "review", approved: "review", error: "render" };
    const order = ["upload", "transcribe", "plan", "render", "review"];
    const current = stageByStatus[status] || status || "upload";
    const currentIndex = Math.max(0, order.indexOf(current));
    $$(".automation-rail [data-stage]").forEach((node, index) => {
      node.classList.toggle("is-active", index === currentIndex);
      node.classList.toggle("is-done", index < currentIndex || status === "approved");
      node.classList.toggle("is-error", status === "error" && index === currentIndex);
    });
  }

  async function pollVideoJob(id) {
    clearTimeout(videoPollTimer);
    try {
      const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "任务读取失败");
      currentVideoJob = payload.job;
      renderVideoJob(currentVideoJob);
      if (["uploaded", "analyzing", "transcribing", "planning", "rendering", "revising"].includes(currentVideoJob.status)) {
        videoPollTimer = setTimeout(() => pollVideoJob(id), 1400);
      }
    } catch (error) {
      setEditProgress(currentVideoJob?.progress || 0, `读取任务失败：${error.message}，正在重试……`);
      videoPollTimer = setTimeout(() => pollVideoJob(id), 2600);
    }
  }

  function renderVideoJob(job) {
    renderAutomationRail(job.status);
    const detail = job.revisionError ? `；最近一次返修失败：${job.revisionError}` : "";
    setEditProgress(job.progress || 0, `${statusLabel(job)}${detail}`);
    if (job.analysis) renderEditAnalysis(job);
    byId("retry-video").classList.toggle("is-hidden", job.status !== "error");
    byId("replan-video").classList.toggle("is-hidden", !(job.transcript && !["uploaded", "analyzing", "transcribing", "planning", "rendering", "revising"].includes(job.status)));
    if (job.output) renderEditResult(job);
    if (job.status === "error") byId("analyze-video").disabled = false;
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
    const outputUrl = `${videoApiBase}${output.url}?t=${Date.now()}`;
    byId("final-video").src = outputUrl;
    byId("download-final").href = outputUrl;
    byId("download-final").download = `${currentItem.day || "koubo"}-AI剪辑-v${output.version}.mp4`;
    byId("result-version").textContent = `版本 ${output.version}`;
    const qa = output.qa || {};
    const dynamicCaptionQa = output.captionPackaging?.requested && !["none", "static"].includes(output.captionPackaging.requested)
      ? [["动态字幕轨", qa.dynamicCaptionTrack], ["字幕安全区", qa.captionSafeArea]]
      : [];
    const coverQa = output.cover?.requested ? [["封面四画幅", qa.coverDimensions ?? output.cover.available]] : [];
    byId("final-qa").innerHTML = [
      ["H.264视频", qa.h264], ["AAC音频", qa.aac], ["yuv420p兼容", qa.yuv420p], ["BT.709 SDR", qa.sdrBt709], ["完整解码", qa.decodes], ["时长校验", qa.durationMatches], ["无长黑帧", qa.noLongBlackFrames !== false], ["无长冻结", qa.noLongFreezeFrames !== false], ...dynamicCaptionQa, ...coverQa
    ].map(([label, pass]) => `<span class="qa-chip ${pass ? "pass" : "warn"}">${pass ? "✓" : "!"} ${label}</span>`).join("");
    const provenance = output.provenance === "silence-fallback" ? "停顿降级" : "语义剪辑";
    const packaging = output.packaging?.engine === "hyperframes" ? "HyperFrames" : output.packaging?.engine === "ass-fallback" ? "ASS 降级" : "无动态卡片";
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
    const artifactLabels = { editPlan: "剪辑计划", timeline: "时间线 JSON", edl: "CMX 3600 EDL", captions: "字幕 ASS", captionStoryboard: "动态字幕分镜", filter: "FFmpeg 脚本", qa: "QA 报告", mediaManifest: "素材清单", coverDesign: "封面设计 JSON", coverVertical: "封面 9:16", coverGrid: "封面 3:4", coverWide16x9: "封面 16:9", coverLandscape4x3: "封面 4:3" };
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

  async function restoreLatestVideoJob() {
    try {
      const response = await fetch(`${videoApiBase}/api/jobs`, { cache: "no-store" });
      const payload = await response.json();
      const job = payload.jobs?.[0];
      if (!response.ok || !job) return;
      currentVideoJob = job;
      renderVideoJob(job);
      if (["uploaded", "analyzing", "transcribing", "planning", "rendering", "revising"].includes(job.status)) pollVideoJob(job.id);
    } catch (_) {}
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
    byId("media-assets").innerHTML = assets.length ? assets.map(asset => `<div class="media-asset" data-asset-id="${htmlEscape(asset.id)}"><div><strong>${htmlEscape(asset.fileName)}</strong><small>${asset.approved ? "已确认权属并批准" : "待确认，默认不进入成片"}</small></div><input data-media-start type="number" min="0" step="0.1" placeholder="开始秒" value="${htmlEscape(asset.placement?.start ?? "")}"><input data-media-end type="number" min="0" step="0.1" placeholder="结束秒" value="${htmlEscape(asset.placement?.end ?? "")}"><button class="btn btn-secondary" data-approve-media>${asset.approved ? "更新位置" : "确认并批准"}</button></div>`).join("") : "<p class=\"empty-media\">尚未加入补充素材。素材只保存在当前任务目录，默认不批准、不上传云端。</p>";
  }

  async function uploadMediaAsset() {
    const file = byId("media-file").files?.[0];
    if (!file || !currentVideoJob?.id) return;
    byId("upload-media").disabled = true;
    try {
      const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(currentVideoJob.id)}/assets`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }, body: file });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "素材加入失败");
      currentVideoJob = payload.job; renderMediaAssets(currentVideoJob); byId("media-file").value = ""; toast("素材已本地入库，尚未批准");
    } catch (error) { toast(error.message); } finally { byId("upload-media").disabled = !byId("media-file").files?.length; }
  }

  async function approveMediaAsset(row) {
    const start = Number(row.querySelector("[data-media-start]").value), end = Number(row.querySelector("[data-media-end]").value);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return toast("请填写有效的素材开始和结束秒数");
    const id = row.dataset.assetId;
    const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(currentVideoJob.id)}/assets/${encodeURIComponent(id)}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved: true, ownership: "user-confirmed", license: "user-confirmed", placement: { start, end, mode: "broll" } }) });
    const payload = await response.json(); if (!response.ok) return toast(payload.error || "素材批准失败");
    currentVideoJob = payload.job; renderMediaAssets(currentVideoJob); toast("已记录权属、批准状态和时间线位置");
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
  byId("copy-short-hero").addEventListener("click", () => copyText(shortText(), "精简稿已复制"));
  byId("copy-home-script").addEventListener("click", () => copyText(shortText(), "这版口播稿已复制"));
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
  byId("generate-content").addEventListener("click", generateNewContent);
  byId("video-file").addEventListener("change", event => handleVideoSelection(event.target.files?.[0]));
  byId("analyze-video").addEventListener("click", analyzeSelectedVideo);
  byId("retry-video").addEventListener("click", retryVideoJob);
  byId("replan-video").addEventListener("click", replanVideoJob);
  byId("revise-video").addEventListener("click", submitVideoRevision);
  byId("approve-video").addEventListener("click", approveVideo);
  byId("regenerate-cover").addEventListener("click", regenerateVideoCover);
  byId("media-file").addEventListener("change", event => { byId("upload-media").disabled = !event.target.files?.length || !currentVideoJob?.id; });
  byId("upload-media").addEventListener("click", uploadMediaAsset);
  byId("media-assets").addEventListener("click", event => { const button = event.target.closest("[data-approve-media]"); if (button) approveMediaAsset(button.closest("[data-asset-id]")); });
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
  setScriptMode(persisted.scriptMode || "full");
  checkVideoService();
})();
