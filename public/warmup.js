(function warmupModule() {
  const $ = (selector) => document.querySelector(selector);

  const view = $("#warmupView");
  if (!view) {
    return;
  }

  const toggle = $("#warmupStatusToggle");
  const statusLabel = $("#warmupStatusLabel");
  const runBtn = $("#warmupRunBtn");
  const runHint = $("#warmupRunHint");
  const progressWrap = $("#warmupProgressWrap");
  const progressBar = $("#warmupProgressBar");
  const progressText = $("#warmupProgressText");
  const progressStatus = $("#warmupProgressStatus");
  const statSentToday = $("#warmupStatSentToday");
  const statTomorrow = $("#warmupStatTomorrow");
  const statDaysActive = $("#warmupStatDaysActive");
  const statTotalSent = $("#warmupStatTotalSent");
  const seedTitle = $("#warmupSeedTitle");
  const seedList = $("#warmupSeedList");
  const seedInput = $("#warmupSeedInput");
  const seedAddBtn = $("#warmupSeedAddBtn");
  const seedError = $("#warmupSeedError");
  const historyBody = $("#warmupHistoryBody");
  const historyEmpty = $("#warmupHistoryEmpty");
  const checkRepliesBtn = $("#warmupCheckRepliesBtn");
  const checkRepliesResult = $("#warmupCheckRepliesResult");

  const state = {
    data: null,
    running: false,
    progressCount: 0,
    progressTotal: 0,
    eventSource: null,
    pollTimer: null,
  };

  function compact(value) {
    return String(value || "").trim();
  }

  function getTodayDate() {
    return new Date().toISOString().slice(0, 10);
  }

  function isValidEmail(value) {
    return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(compact(value));
  }

  async function request(url, { method = "GET", body } = {}) {
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || `Request failed (${response.status})`);
    }
    return payload;
  }

  function showSeedError(message) {
    seedError.textContent = message || "";
    seedError.classList.toggle("hidden", !message);
  }

  function setProgress(count, total) {
    state.progressCount = Math.max(0, Number(count) || 0);
    state.progressTotal = Math.max(0, Number(total) || 0);
    const ratio = state.progressTotal > 0 ? Math.min(100, Math.round((state.progressCount / state.progressTotal) * 100)) : 0;
    progressBar.style.width = `${ratio}%`;
    progressText.textContent = `${state.progressCount} of ${state.progressTotal} sent`;
  }

  function closeEventStream() {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
  }

  function startEventStream() {
    closeEventStream();
    const source = new EventSource("/api/warmup/progress");
    state.eventSource = source;
    source.onmessage = (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data || "{}");
      } catch (_error) {
        return;
      }
      const type = compact(payload?.type).toLowerCase();
      if (type === "sending") {
        setProgress(payload.count, payload.total);
        progressStatus.textContent = `Sending to ${payload.to || "recipient"}...`;
      } else if (type === "waiting") {
        const seconds = Math.max(0, Number(payload.seconds) || 0);
        const mins = Math.floor(seconds / 60);
        const rem = seconds % 60;
        progressStatus.textContent = `Waiting ${mins} min ${rem} sec...`;
      } else if (type === "done") {
        state.running = false;
        progressStatus.textContent = "Done! Check back tomorrow.";
        runHint.textContent = "Done! Check back tomorrow.";
        updateRunButtonState();
        stopStatusPolling();
        setTimeout(() => {
          progressWrap.classList.add("hidden");
          closeEventStream();
        }, 1500);
        void refreshStatus();
      } else if (type === "error") {
        state.running = false;
        progressStatus.textContent = payload.message || "Warmup run error";
        runHint.textContent = payload.message || "Warmup run error";
        updateRunButtonState();
        stopStatusPolling();
        setTimeout(() => closeEventStream(), 1500);
      }
    };
    source.onerror = () => {
      if (!state.running) {
        closeEventStream();
      }
    };
  }

  function updateRunButtonState() {
    const warmup = state.data || {};
    const status = compact(warmup.status || "inactive").toLowerCase();
    const seeds = Array.isArray(warmup.seedEmails) ? warmup.seedEmails : [];
    const ranToday = compact(warmup.lastRunDate) === getTodayDate();

    runBtn.classList.remove("warmup-btn-running", "warmup-btn-done", "btn-ghost", "btn-primary");

    if (status !== "active") {
      runBtn.disabled = true;
      runBtn.textContent = "Warmup is inactive";
      runBtn.classList.add("btn", "btn-ghost");
      return;
    }
    if (seeds.length < 1) {
      runBtn.disabled = true;
      runBtn.textContent = "Add seed emails first";
      runBtn.classList.add("btn", "btn-ghost");
      return;
    }
    if (state.running) {
      runBtn.disabled = true;
      runBtn.textContent = "Running...";
      runBtn.classList.add("btn", "btn-ghost", "warmup-btn-running");
      return;
    }
    if (ranToday) {
      runBtn.disabled = true;
      runBtn.textContent = "Done for today ✓";
      runBtn.classList.add("btn", "btn-primary", "warmup-btn-done");
      return;
    }
    runBtn.disabled = false;
    runBtn.textContent = "Run Today's Warmup";
    runBtn.classList.add("btn", "btn-primary");
  }

  function renderSeeds() {
    const seedEmails = Array.isArray(state.data?.seedEmails) ? state.data.seedEmails : [];
    seedTitle.textContent = `Seed Emails (${seedEmails.length})`;
    seedList.innerHTML = "";
    if (seedEmails.length < 1) {
      seedList.innerHTML = '<p class="muted">No seed emails added yet.</p>';
      return;
    }
    seedEmails.forEach((email) => {
      const row = document.createElement("div");
      row.className = "warmup-seed-row";

      const label = document.createElement("span");
      label.textContent = email;

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn btn-danger warmup-seed-remove";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", async () => {
        try {
          await request("/api/warmup/emails/remove", {
            method: "POST",
            body: { email },
          });
          await refreshStatus();
        } catch (error) {
          showSeedError(error.message);
        }
      });

      row.append(label, removeBtn);
      seedList.appendChild(row);
    });
  }

  function renderHistory() {
    const history = Array.isArray(state.data?.history) ? [...state.data.history] : [];
    history.sort((a, b) => (compact(b.date) > compact(a.date) ? 1 : -1));
    const latest = history.slice(0, 30);
    historyBody.innerHTML = "";
    historyEmpty.classList.toggle("hidden", latest.length > 0);

    latest.forEach((entry) => {
      const tr = document.createElement("tr");
      const tdDate = document.createElement("td");
      const tdSent = document.createElement("td");
      const tdReplies = document.createElement("td");

      tdDate.textContent = compact(entry.date);
      tdSent.textContent = String(Number(entry.sent) || 0);
      tdReplies.textContent = String(Number(entry.replies) || 0);

      tr.append(tdDate, tdSent, tdReplies);
      historyBody.appendChild(tr);
    });
  }

  function renderStats() {
    const warmup = state.data || {};
    const history = Array.isArray(warmup.history) ? warmup.history : [];
    const seeds = Array.isArray(warmup.seedEmails) ? warmup.seedEmails : [];
    const today = getTodayDate();
    const sentToday = Number(warmup.todaySentCount) || 0;
    const volumeFallback = Math.max(0, Math.min(40, seeds.length));
    const currentVolume = Math.max(0, Math.min(40, Number(warmup.currentDailyVolume) || volumeFallback));
    const tomorrowVolume = currentVolume;
    const totalSent = history.reduce((sum, item) => sum + (Number(item?.sent) || 0), 0);

    statSentToday.textContent = `${sentToday} / ${currentVolume}`;
    statTomorrow.textContent = `${tomorrowVolume} emails`;
    statDaysActive.textContent = String(history.length);
    statTotalSent.textContent = String(totalSent);
  }

  function renderStatus() {
    const active = compact(state.data?.status).toLowerCase() === "active";
    toggle.checked = active;
    statusLabel.textContent = active ? "Active" : "Inactive";
    statusLabel.classList.toggle("warmup-active-label", active);
    renderSeeds();
    renderHistory();
    renderStats();
    updateRunButtonState();
  }

  function startStatusPolling() {
    stopStatusPolling();
    state.pollTimer = setInterval(() => {
      void refreshStatus();
    }, 5000);
  }

  function stopStatusPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function refreshStatus() {
    const status = await request("/api/warmup/status");
    state.data = status;
    state.running = Boolean(status.runInProgress);
    renderStatus();
    if (compact(status.status).toLowerCase() === "active" && state.running) {
      startStatusPolling();
      progressWrap.classList.remove("hidden");
    } else {
      stopStatusPolling();
      if (!state.running) {
        progressWrap.classList.add("hidden");
      }
    }
  }

  async function runWarmup() {
    showSeedError("");
    state.running = true;
    setProgress(0, Number(state.data?.currentDailyVolume) || 0);
    progressStatus.textContent = "Starting warmup...";
    progressWrap.classList.remove("hidden");
    updateRunButtonState();
    startStatusPolling();
    startEventStream();

    try {
      const result = await request("/api/warmup/run", { method: "POST" });
      runHint.textContent = `Sent ${result.sent} warmup emails. Next volume: ${result.nextVolume}.`;
      state.running = false;
      await refreshStatus();
      closeEventStream();
    } catch (error) {
      state.running = false;
      runHint.textContent = error.message;
      progressStatus.textContent = error.message;
      progressWrap.classList.add("hidden");
      updateRunButtonState();
      stopStatusPolling();
      closeEventStream();
    }
  }

  toggle.addEventListener("change", async () => {
    try {
      await request("/api/warmup/toggle", { method: "POST" });
      await refreshStatus();
    } catch (error) {
      runHint.textContent = error.message;
      toggle.checked = !toggle.checked;
    }
  });

  runBtn.addEventListener("click", async () => {
    if (runBtn.disabled) {
      return;
    }
    await runWarmup();
  });

  seedAddBtn.addEventListener("click", async () => {
    showSeedError("");
    const email = compact(seedInput.value).toLowerCase();
    if (!isValidEmail(email)) {
      showSeedError("Please enter a valid email address.");
      return;
    }
    try {
      await request("/api/warmup/emails/add", {
        method: "POST",
        body: { email },
      });
      seedInput.value = "";
      await refreshStatus();
    } catch (error) {
      showSeedError(error.message);
    }
  });

  seedInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      seedAddBtn.click();
    }
  });

  checkRepliesBtn.addEventListener("click", async () => {
    checkRepliesResult.textContent = "Checking replies...";
    checkRepliesBtn.disabled = true;
    try {
      const result = await request("/api/warmup/check-replies", { method: "POST" });
      checkRepliesResult.textContent = `Found ${result.repliesFound}, responded to ${result.repliedTo}`;
      await refreshStatus();
    } catch (error) {
      checkRepliesResult.textContent = error.message;
    } finally {
      checkRepliesBtn.disabled = false;
    }
  });

  void refreshStatus().catch((error) => {
    runHint.textContent = error.message;
  });
})();
