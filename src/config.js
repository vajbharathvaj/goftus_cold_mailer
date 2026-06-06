const dotenv = require("dotenv");

dotenv.config();

function getInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getFloat(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getOptionalInt(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getOptionalStops(value) {
  if (!value) {
    return undefined;
  }
  const stops = String(value)
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
  return stops.length > 0 ? stops : undefined;
}

function getOptionalString(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

function getStringList(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(/[\n,;|]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getBool(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function getDefaultThink(modelName) {
  if (String(modelName || "").startsWith("gpt-oss")) {
    return "low";
  }
  return undefined;
}

function buildGenerationOptions(prefix) {
  return {
    temperature: getFloat(process.env[`${prefix}_TEMPERATURE`], 0.2),
    topP: getFloat(process.env[`${prefix}_TOP_P`], 0.85),
    topK: getInt(process.env[`${prefix}_TOP_K`], 40),
    repeatPenalty: getFloat(process.env[`${prefix}_REPEAT_PENALTY`], 1.15),
    numPredict: getInt(process.env[`${prefix}_NUM_PREDICT`], 200),
    seed: getOptionalInt(process.env[`${prefix}_SEED`]),
    stop: getOptionalStops(process.env[`${prefix}_STOP`]),
  };
}

const ollamaModel = process.env.OLLAMA_MODEL || "llama3.1";
const ollamaMailerModel = process.env.OLLAMA_MAILER_MODEL || ollamaModel;

module.exports = {
  port: getInt(process.env.PORT, 3000),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  ollamaModel,
  ollamaMailerModel,
  requestTimeoutMs: getInt(process.env.REQUEST_TIMEOUT_MS, 45000),
  proxyList: getStringList(process.env.PROXY_LIST),
  linkedInFetchMode: getOptionalString(process.env.LINKEDIN_FETCH_MODE) || "jina",
  chromeExecutablePath: getOptionalString(process.env.CHROME_EXECUTABLE_PATH),
  chromeUserDataDir: getOptionalString(process.env.CHROME_USER_DATA_DIR),
  chromeProfileName:
    getOptionalString(process.env.CHROME_PROFILE_NAME) || getOptionalString(process.env.CHROME_PROFILE_DIRECTORY) || "Default",
  chromeProfileDirectory:
    getOptionalString(process.env.CHROME_PROFILE_NAME) || getOptionalString(process.env.CHROME_PROFILE_DIRECTORY) || "Default",
  chromeHeadless: getBool(process.env.CHROME_HEADLESS, false),
  chromeHeadlessFallback: getBool(process.env.CHROME_HEADLESS_FALLBACK, true),
  chromeProfileEnabled: getBool(process.env.CHROME_PROFILE_ENABLED, false),
  chromeAutomationUserDataDir: getOptionalString(process.env.CHROME_AUTOMATION_USER_DATA_DIR),
  chromeForceMirrorProfile: getBool(process.env.CHROME_FORCE_MIRROR_PROFILE, true),
  chromeCookiesEnabled: getBool(process.env.CHROME_COOKIES_ENABLED, false),
  chromeTimeoutMs: getInt(process.env.CHROME_TIMEOUT_MS, 30000),
  playwrightEnabled: getBool(process.env.PLAYWRIGHT_ENABLED, false),
  playwrightTimeoutMs: getInt(process.env.PLAYWRIGHT_TIMEOUT_MS, 30000),
  subpageFetchEnabled: getBool(process.env.SUBPAGE_FETCH_ENABLED, true),
  subPageMaxCount: getInt(process.env.SUBPAGE_MAX_COUNT, 2),
  searchSnippetEnabled: getBool(process.env.SEARCH_SNIPPET_ENABLED, true),
  searchSnippetMaxLines: getInt(process.env.SEARCH_SNIPPET_MAX_LINES, 3),
  rowConcurrency: Math.max(1, getInt(process.env.ROW_CONCURRENCY, 3)),
  generationConcurrency: Math.max(1, getInt(process.env.GENERATION_CONCURRENCY, 1)),
  profileSearchOnly: getBool(process.env.PROFILE_SEARCH_ONLY, false),
  continueOnWebsiteFetchFailure: getBool(process.env.CONTINUE_ON_WEBSITE_FETCH_FAILURE, true),
  pipelineStageTimeoutMs: getInt(process.env.PIPELINE_STAGE_TIMEOUT_MS, 120000),
  previewUseCombinedGeneration: getBool(process.env.PREVIEW_USE_COMBINED_GENERATION, true),
  gmailUser: getOptionalString(process.env.GMAIL_USER),
  gmailAppPass: getOptionalString(process.env.GMAIL_APP_PASS),
  gmailFrom: getOptionalString(process.env.GMAIL_FROM) || getOptionalString(process.env.GMAIL_USER),
  gmailFromName: getOptionalString(process.env.GMAIL_FROM_NAME) || "Cold Mailbot",
  mailerSendDelayMs: getInt(process.env.MAILER_SEND_DELAY_MS, 180000),
  ollamaThink: getOptionalString(process.env.OLLAMA_THINK) || getDefaultThink(ollamaModel),
  ollamaMailerThink: getOptionalString(process.env.OLLAMA_MAILER_THINK),
  ollamaKeepAlive: getOptionalString(process.env.OLLAMA_KEEP_ALIVE),
  ollamaMailerKeepAlive: getOptionalString(process.env.OLLAMA_MAILER_KEEP_ALIVE),
  ollamaGeneration: buildGenerationOptions("OLLAMA"),
  ollamaMailerGeneration: buildGenerationOptions("OLLAMA_MAILER"),
};
