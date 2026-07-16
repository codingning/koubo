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
  const videoApiBase = "http://127.0.0.1:8787";
  let videoServiceOnline = false;
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
        editedScript: fullPlainText(item),
        broll: {},
        shoot: {},
        risks: {}
      };
    }
    return persisted.items[item.id];
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

﻿  function formatBytes(bytes) {
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

  async function checkVideoService() {
    const status = byId("video-service-status");
    const detail = byId("video-service-detail");
    try {
      const response = await fetch(`${videoApiBase}/api/health`, { cache: "no-store" });
      if (!response.ok) throw new Error("服务响应异常");
      const health = await response.json();
      videoServiceOnline = !!health.ok && !!health.ffmpeg;
      status.textContent = videoServiceOnline ? "本地AI剪辑服务已就绪" : "已连接，但FFmpeg不可用";
      status.className = `service-status ${videoServiceOnline ? "is-online" : "is-offline"}`;
      detail.textContent = videoServiceOnline
        ? `本地处理已启用 · FFmpeg ${health.ffmpeg ? "可用" : "不可用"} · HyperFrames ${health.hyperframes ? "可用" : "未就绪"}`
        : "请确认 FFmpeg 已安装并重新打开工作台。";
    } catch (_) {
      videoServiceOnline = false;
      status.textContent = "本地AI剪辑服务未启动";
      status.className = "service-status is-offline";
      detail.textContent = "请双击 F:\\code\\koubo\\打开AI口播工作台.vbs；它会静默启动服务并重新打开网页。";
    }
    byId("analyze-video").disabled = !(videoServiceOnline && selectedVideoFile);
  }

  function handleVideoSelection(file) {
    selectedVideoFile = file || null;
    currentVideoJob = null;
    clearTimeout(videoPollTimer);
    byId("edit-results").classList.add("is-hidden");
    byId("edit-analysis").classList.add("is-hidden");
    byId("render-video").disabled = true;
    if (!file) {
      byId("selected-video-info").textContent = "尚未选择视频";
      byId("video-preview").classList.add("is-hidden");
      byId("analyze-video").disabled = true;
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
    setEditProgress(0, "视频已选择，等待分析");
  }

  function currentEditOptions() {
    return {
      layout: byId("edit-layout").value,
      removeSilence: byId("edit-remove-silence").checked,
      captions: byId("edit-captions").checked,
      silenceDuration: Number(byId("edit-silence-duration").value),
      aiMode: byId("edit-ai-mode").value,
      script: shortText(currentItem)
    };
  }

  async function analyzeSelectedVideo() {
    if (!selectedVideoFile || !videoServiceOnline) return;
    byId("analyze-video").disabled = true;
    byId("render-video").disabled = true;
    setEditProgress(2, `正在把 ${selectedVideoFile.name} 复制到本地剪辑工作区……`);
    try {
      const options = currentEditOptions();
      const response = await fetch(`${videoApiBase}/api/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": selectedVideoFile.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(selectedVideoFile.name),
          "X-Content-Id": encodeURIComponent(currentItem.id),
          "X-Options": encodeURIComponent(JSON.stringify(options))
        },
        body: selectedVideoFile
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "视频上传失败");
      currentVideoJob = payload.job;
      setEditProgress(5, "视频已进入本地分析：正在检测停顿、音轨和画面规格……");
      pollVideoJob(currentVideoJob.id);
    } catch (error) {
      byId("analyze-video").disabled = false;
      setEditProgress(0, `分析失败：${error.message}`);
    }
  }

  async function pollVideoJob(id) {
    clearTimeout(videoPollTimer);
    try {
      const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法读取剪辑任务");
      currentVideoJob = payload.job;
      const job = currentVideoJob;
      const labels = {
        uploaded: "视频已上传",
        analyzing: "正在检测停顿和素材规格……",
        analyzed: "分析完成，可以生成成片",
        rendering: "正在本地渲染成片……",
        completed: "剪辑成片已完成",
        error: `处理失败：${job.error || "未知错误"}`
      };
      setEditProgress(job.progress || 0, labels[job.status] || job.status);
      if (job.analysis) renderEditAnalysis(job);
      if (job.status === "analyzed") {
        byId("render-video").disabled = false;
        byId("analyze-video").disabled = false;
        return;
      }
      if (job.status === "completed") {
        byId("render-video").disabled = false;
        byId("analyze-video").disabled = false;
        renderEditResult(job);
        return;
      }
      if (job.status === "error") {
        byId("analyze-video").disabled = false;
        byId("render-video").disabled = !job.analysis;
        return;
      }
      videoPollTimer = setTimeout(() => pollVideoJob(id), 1000);
    } catch (error) {
      setEditProgress(0, `读取任务失败：${error.message}`);
      byId("analyze-video").disabled = false;
    }
  }

  function renderEditAnalysis(job) {
    const analysis = job.analysis;
    const panel = byId("edit-analysis");
    const saved = Math.max(0, Number(analysis.removedDuration || 0));
    panel.innerHTML = `
      <div><span>原始时长</span><strong>${formatDuration(job.source?.duration)}</strong></div>
      <div><span>检测到停顿</span><strong>${analysis.silences?.length || 0} 段</strong></div>
      <div><span>预计删除</span><strong>${saved.toFixed(1)} 秒</strong></div>
      <div><span>预计成片</span><strong>${formatDuration(analysis.estimatedDuration)}</strong></div>
      <p>${htmlEscape(analysis.strategy || "")}</p>`;
    panel.classList.remove("is-hidden");
  }

  async function renderCurrentVideoJob() {
    if (!currentVideoJob?.id) return;
    byId("render-video").disabled = true;
    setEditProgress(1, "正在准备 FFmpeg 剪辑任务……");
    try {
      const response = await fetch(`${videoApiBase}/api/jobs/${encodeURIComponent(currentVideoJob.id)}/render`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法启动渲染");
      pollVideoJob(currentVideoJob.id);
    } catch (error) {
      byId("render-video").disabled = false;
      setEditProgress(0, `渲染启动失败：${error.message}`);
    }
  }

  function renderEditResult(job) {
    const outputUrl = `${videoApiBase}${job.output.url}?t=${Date.now()}`;
    byId("final-video").src = outputUrl;
    byId("download-final").href = outputUrl;
    byId("download-final").download = `${currentItem.day || "koubo"}-AI剪辑成片.mp4`;
    const qa = job.output.qa || {};
    byId("final-qa").innerHTML = [
      ["H.264视频", qa.h264], ["AAC音频", qa.aac], ["yuv420p兼容", qa.yuv420p], ["时长校验", qa.durationMatches]
    ].map(([label, pass]) => `<span class="qa-chip ${pass ? "pass" : "warn"}">${pass ? "✓" : "!"} ${label}</span>`).join("");
    byId("job-folder").textContent = `任务目录：F:\\code\\koubo\\video-jobs\\${job.id}`;
    byId("edit-results").classList.remove("is-hidden");
  }

  function advancedEditPrompt() {
    if (!currentVideoJob?.id) return "";
    return [
      "请使用项目 Skill koubo-ai-video-editor 继续处理我刚刚在网页创建的剪辑任务。",
      `任务目录：F:\\code\\koubo\\video-jobs\\${currentVideoJob.id}`,
      "先读取 job.json 和 edit-plan.json，再查看关键帧与字幕。",
      "目标：检查错句、假启动和切点，按当前口播主题增加必要的动态标题或证据卡片，并输出 final-ai.mp4。",
      "不要覆盖原视频；任何云端上传或付费模型调用前先向我确认。"
    ].join("\n");
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

﻿  // AI video editing
  byId("video-file").addEventListener("change", event => handleVideoSelection(event.target.files?.[0]));
  byId("analyze-video").addEventListener("click", analyzeSelectedVideo);
  byId("render-video").addEventListener("click", renderCurrentVideoJob);
  byId("copy-ai-edit-prompt").addEventListener("click", () => {
    const prompt = advancedEditPrompt();
    if (!prompt) return toast("请先完成一次视频分析");
    copyText(prompt, "高级AI剪辑指令已复制");
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
