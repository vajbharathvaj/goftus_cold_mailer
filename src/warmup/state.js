const fs = require("fs/promises");
const path = require("path");

const DATA_DIR = path.resolve(__dirname, "../../data");
const WARMUP_FILE = path.join(DATA_DIR, "warmup.json");

const DEFAULT_WARMUP_STATE = {
  status: "inactive",
  startedAt: null,
  currentDailyVolume: 5,
  todaySentCount: 0,
  lastRunDate: null,
  seedEmails: [],
  history: [],
};

function normalizeHistoryEntry(entry = {}) {
  return {
    date: String(entry.date || "").trim(),
    sent: Number.isFinite(Number(entry.sent)) ? Number(entry.sent) : 0,
    replies: Number.isFinite(Number(entry.replies)) ? Number(entry.replies) : 0,
  };
}

function normalizeWarmupState(state = {}) {
  const normalizedStatus = String(state.status || DEFAULT_WARMUP_STATE.status).trim().toLowerCase();
  return {
    status: normalizedStatus === "inactive" ? "inactive" : "active",
    startedAt: state.startedAt ? String(state.startedAt).trim() : null,
    currentDailyVolume: Math.max(
      1,
      Math.min(
        40,
        Number.isFinite(Number(state.currentDailyVolume)) ? Math.round(Number(state.currentDailyVolume)) : 5
      )
    ),
    todaySentCount: Math.max(0, Number.isFinite(Number(state.todaySentCount)) ? Math.round(Number(state.todaySentCount)) : 0),
    lastRunDate: state.lastRunDate ? String(state.lastRunDate).trim() : null,
    seedEmails: Array.from(
      new Set(
        (Array.isArray(state.seedEmails) ? state.seedEmails : [])
          .map((item) => String(item || "").trim().toLowerCase())
          .filter(Boolean)
      )
    ),
    history: (Array.isArray(state.history) ? state.history : [])
      .map((item) => normalizeHistoryEntry(item))
      .filter((item) => item.date),
  };
}

async function ensureWarmupFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(WARMUP_FILE);
  } catch (_error) {
    await fs.writeFile(WARMUP_FILE, JSON.stringify(DEFAULT_WARMUP_STATE, null, 2));
  }
}

async function readWarmupState() {
  await ensureWarmupFile();
  try {
    const raw = await fs.readFile(WARMUP_FILE, "utf8");
    return normalizeWarmupState(JSON.parse(raw));
  } catch (_error) {
    const normalized = normalizeWarmupState(DEFAULT_WARMUP_STATE);
    await writeWarmupState(normalized);
    return normalized;
  }
}

async function writeWarmupState(state) {
  await ensureWarmupFile();
  const normalized = normalizeWarmupState(state);
  await fs.writeFile(WARMUP_FILE, JSON.stringify(normalized, null, 2));
  return normalized;
}

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = {
  DATA_DIR,
  WARMUP_FILE,
  DEFAULT_WARMUP_STATE,
  readWarmupState,
  writeWarmupState,
  getTodayDate,
};
