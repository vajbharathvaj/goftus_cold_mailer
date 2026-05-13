const express = require("express");
const { checkReplies } = require("../warmup/replies");
const { getTodayDate, readWarmupState, writeWarmupState } = require("../warmup/state");
const { isWarmupRunning, runWarmupSession, subscribeProgress } = require("../warmup/engine");

const router = express.Router();

function compact(value) {
  return String(value || "").trim();
}

function isWarmupEnabled() {
  const normalized = compact(process.env.WARMUP_ENABLED || "false").toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function isValidEmail(value) {
  const email = compact(value).toLowerCase();
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email);
}

function getDailyVolumeFromSeeds(seedEmails = []) {
  const normalizedSeeds = Array.isArray(seedEmails)
    ? seedEmails
        .map((item) => compact(item).toLowerCase())
        .filter(Boolean)
    : [];
  return Math.max(0, Math.min(40, normalizedSeeds.length));
}

router.get("/status", async (_req, res) => {
  try {
    const state = await readWarmupState();
    if (!isWarmupEnabled()) {
      return res.json({
        ...state,
        status: "inactive",
        enabled: false,
        runInProgress: false,
      });
    }
    return res.json({
      ...state,
      enabled: true,
      runInProgress: isWarmupRunning(),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post("/toggle", async (_req, res) => {
  if (!isWarmupEnabled()) {
    return res.status(503).json({ error: "Warmup is disabled for now" });
  }
  try {
    const state = await readWarmupState();
    const nextStatus = state.status === "active" ? "inactive" : "active";
    const next = await writeWarmupState({
      ...state,
      status: nextStatus,
      startedAt: nextStatus === "active" && !state.startedAt ? new Date().toISOString() : state.startedAt,
    });
    return res.json(next);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post("/run", async (_req, res) => {
  if (!isWarmupEnabled()) {
    return res.status(503).json({ error: "Warmup is disabled for now" });
  }
  try {
    if (isWarmupRunning()) {
      return res.status(409).json({ error: "Warmup run already in progress" });
    }

    const state = await readWarmupState();
    const today = getTodayDate();
    if (state.status !== "active") {
      return res.status(400).json({ error: "Warmup is inactive" });
    }
    if (!Array.isArray(state.seedEmails) || state.seedEmails.length < 1) {
      return res.status(400).json({ error: "No seed emails added yet" });
    }
    if (state.lastRunDate === today) {
      return res.status(400).json({ error: "Already ran today. Come back tomorrow." });
    }

    const result = await runWarmupSession();
    if (result?.skipped && result.reason === "already ran today") {
      return res.status(400).json({ error: "Already ran today. Come back tomorrow." });
    }
    if (result?.skipped && result.reason === "run already in progress") {
      return res.status(409).json({ error: "Warmup run already in progress" });
    }
    return res.json({
      sent: Number(result?.sent) || 0,
      dailyVolume: Number(result?.dailyVolume) || getDailyVolumeFromSeeds(state.seedEmails),
      nextVolume: Number(result?.nextVolume) || getDailyVolumeFromSeeds(state.seedEmails),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post("/emails/add", async (req, res) => {
  try {
    const rawEmail = compact(req.body?.email).toLowerCase();
    if (!isValidEmail(rawEmail)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const state = await readWarmupState();
    const seedEmails = Array.isArray(state.seedEmails) ? [...state.seedEmails] : [];
    if (seedEmails.includes(rawEmail)) {
      return res.status(400).json({ error: "Email already exists in seed list", seedEmails });
    }
    seedEmails.push(rawEmail);
    const next = await writeWarmupState({
      ...state,
      seedEmails,
      currentDailyVolume: getDailyVolumeFromSeeds(seedEmails),
    });
    return res.json({ seedEmails: next.seedEmails });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post("/emails/remove", async (req, res) => {
  try {
    const rawEmail = compact(req.body?.email).toLowerCase();
    const state = await readWarmupState();
    const seedEmails = (Array.isArray(state.seedEmails) ? state.seedEmails : []).filter((item) => item !== rawEmail);
    const next = await writeWarmupState({
      ...state,
      seedEmails,
      currentDailyVolume: getDailyVolumeFromSeeds(seedEmails),
    });
    return res.json({ seedEmails: next.seedEmails });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get("/history", async (_req, res) => {
  try {
    const state = await readWarmupState();
    return res.json({
      history: Array.isArray(state.history) ? state.history : [],
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get("/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const sendEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  if (!isWarmupEnabled()) {
    sendEvent({
      type: "connected",
      enabled: false,
      runInProgress: false,
      message: "Warmup is disabled for now",
    });
    req.on("close", () => {});
    return;
  }
  sendEvent({
    type: "connected",
    enabled: true,
    runInProgress: isWarmupRunning(),
  });

  const unsubscribe = subscribeProgress(sendEvent);
  req.on("close", () => {
    unsubscribe();
  });
});

router.post("/check-replies", async (_req, res) => {
  if (!isWarmupEnabled()) {
    return res.status(503).json({ error: "Warmup is disabled for now" });
  }
  try {
    return res.json(await checkReplies());
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
