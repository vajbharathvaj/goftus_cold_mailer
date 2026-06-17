const path = require("path");
const express = require("express");
const config = require("./config");
const {
  draftRequestSchema,
  subjectRequestSchema,
  generateRequestSchema,
  campaignUploadSchema,
  mailerDocRequestSchema,
  campaignSendPreviewRequestSchema,
  campaignSendRequestSchema,
  campaignDeleteRowsRequestSchema,
} = require("./schemas/contentSchemas");
const { OllamaClient } = require("./services/ollamaClient");
const { OpenAIClient } = require("./services/openaiClient");
const { CascadeClient } = require("./services/cascadeClient");
const { ContentService } = require("./services/contentService");
const {
  CampaignStorage,
  EMAIL_STATUS_COLUMN,
  EMAIL_TO_COLUMN,
  EMAIL_SUBJECT_COLUMN,
  EMAIL_GENERATED_BODY_COLUMN,
  EMAIL_BODY_COLUMN,
  EMAIL_PREVIEWED_AT_COLUMN,
  EMAIL_SENT_AT_COLUMN,
  EMAIL_MESSAGE_ID_COLUMN,
  EMAIL_ERROR_COLUMN,
  EMAIL_SENDER_COLUMN,
  EMAIL_SENDER_DOMAIN_COLUMN,
} = require("./services/campaignStorage");
const { MailerDocService } = require("./services/mailerDocService");
const { verifyMailer, isMailerConfigured, sendEmail, listSenders } = require("./services/mailerSendService");
const { CampaignSendService } = require("./services/campaignSendService");
const reviewFetchService = require("./services/reviewFetchService");
const ruleEngine = require("./services/ruleEngine");
const { checkChromeCookieAvailability } = require("./services/chromeCookieService");
const { SharedBrowserSession } = require("./services/sharedBrowserSession");
const { readBlocklist, addToBlocklist, removeFromBlocklist } = require("./services/blocklistStorage");
const { resumeVerification, skipVerification } = require("./services/verificationStateService");
const warmupRoutes = require("./routes/warmup");
const { checkReplies } = require("./warmup/replies");
const { readWarmupState } = require("./warmup/state");

let requestCounter = 0;
const campaignSseClients = new Map();
const activeCampaignRuns = new Set();
const completionNotificationSentCampaigns = new Set();

function addCampaignSseClient(campaignId, res) {
  const key = String(campaignId || "").trim();
  if (!key) {
    return;
  }
  if (!campaignSseClients.has(key)) {
    campaignSseClients.set(key, new Set());
  }
  campaignSseClients.get(key).add(res);
}

function removeCampaignSseClient(campaignId, res) {
  const key = String(campaignId || "").trim();
  if (!key || !campaignSseClients.has(key)) {
    return;
  }
  const set = campaignSseClients.get(key);
  set.delete(res);
  if (set.size === 0) {
    campaignSseClients.delete(key);
  }
}

function notifyCampaignUI(campaignId, event) {
  const key = String(campaignId || "").trim();
  if (!key || !campaignSseClients.has(key)) {
    return;
  }
  const payload = `data: ${JSON.stringify(event || {})}\n\n`;
  const clients = campaignSseClients.get(key);
  for (const client of clients) {
    try {
      client.write(payload);
    } catch (_error) {
      clients.delete(client);
    }
  }
  if (clients.size === 0) {
    campaignSseClients.delete(key);
  }
}

function broadcastAllCampaignSse(event) {
  const payload = `data: ${JSON.stringify(event || {})}\n\n`;
  for (const [campaignId, clients] of campaignSseClients.entries()) {
    for (const client of clients) {
      try { client.write(payload); } catch (_) { clients.delete(client); }
    }
    if (clients.size === 0) campaignSseClients.delete(campaignId);
  }
}

function buildCascadeClient() {
  const tiers = [];
  const primaryKey = process.env.OPENAI_API_KEY;
  const primaryModel = process.env.OPENAI_PRIMARY_MODEL || "gpt-4o-mini";
  if (primaryKey) {
    tiers.push({
      name: "primary",
      label: `GPT ${primaryModel}`,
      model: primaryModel,
      client: new OpenAIClient({ apiKey: primaryKey, model: primaryModel, timeoutMs: 90000 }),
      costPer1kTokens: 0.00015,
    });
  }
  const ossModel = compact(process.env.OPENAI_OSS_MODEL);
  const ossKey = compact(process.env.OPENAI_OSS_API_KEY) || primaryKey;
  const ossBaseUrl = compact(process.env.OPENAI_OSS_BASE_URL);
  // Secondary is always present so the UI can display and switch to it;
  // client is null when OSS model is not configured (falls through to table behaviour).
  tiers.push({
    name: "secondary",
    label: ossModel ? `OSS ${ossModel}` : "OSS Secondary",
    model: ossModel || "",
    client: (ossModel && ossKey)
      ? new OpenAIClient({ apiKey: ossKey, model: ossModel, baseUrl: ossBaseUrl || undefined, timeoutMs: 120000 })
      : null,
    costPer1kTokens: 0.0001,
  });
  tiers.push({ name: "table", label: "Table Engine", model: "", client: null, costPer1kTokens: 0 });
  return new CascadeClient({ tiers });
}

const cascadeClient = buildCascadeClient();

function compact(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return compact(value).toLowerCase();
}

function getDomainFromEmail(value) {
  const email = normalizeEmail(value);
  const at = email.lastIndexOf("@");
  if (at < 1 || at >= email.length - 1) {
    return "";
  }
  return email.slice(at + 1);
}

function getCampaignDomainUsage(metadata = {}) {
  const usage = {};
  const rows = Array.isArray(metadata?.rows) ? metadata.rows : [];
  for (const row of rows) {
    const emailStatus = normalizeEmail(row?.emailStatus || row?.sourceRow?.email_status);
    if (emailStatus !== "sent") {
      continue;
    }
    const senderDomain = normalizeEmail(
      row?.senderDomain || row?.sourceRow?.[EMAIL_SENDER_DOMAIN_COLUMN] || getDomainFromEmail(row?.senderEmail || row?.sourceRow?.[EMAIL_SENDER_COLUMN])
    );
    if (!senderDomain) {
      continue;
    }
    usage[senderDomain] = (Number(usage[senderDomain]) || 0) + 1;
  }
  return usage;
}

function getCampaignSenderUsage(metadata = {}) {
  const usage = {};
  const rows = Array.isArray(metadata?.rows) ? metadata.rows : [];
  for (const row of rows) {
    const emailStatus = normalizeEmail(row?.emailStatus || row?.sourceRow?.email_status);
    if (emailStatus !== "sent") {
      continue;
    }
    const senderEmail = normalizeEmail(row?.senderEmail || row?.sourceRow?.[EMAIL_SENDER_COLUMN]);
    if (!senderEmail) {
      continue;
    }
    usage[senderEmail] = (Number(usage[senderEmail]) || 0) + 1;
  }
  return usage;
}

function normalizeUsageMap(value) {
  const usage = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return usage;
  }
  for (const [rawKey, rawCount] of Object.entries(value)) {
    const key = normalizeEmail(rawKey);
    if (!key) {
      continue;
    }
    usage[key] = Math.max(0, Number.parseInt(rawCount, 10) || 0);
  }
  return usage;
}

function mergeUsageMaps(primary = {}, fallback = {}) {
  const merged = { ...normalizeUsageMap(primary) };
  const fallbackUsage = normalizeUsageMap(fallback);
  for (const [key, value] of Object.entries(fallbackUsage)) {
    if (!Object.prototype.hasOwnProperty.call(merged, key)) {
      merged[key] = value;
      continue;
    }
    merged[key] = Math.max(merged[key], value);
  }
  return merged;
}

function getCampaignUsage(metadata = {}) {
  const rowDomainUsage = getCampaignDomainUsage(metadata);
  const rowSenderUsage = getCampaignSenderUsage(metadata);
  const storedDomainUsage = normalizeUsageMap(metadata?.bulkDomainUsage);
  const storedSenderUsage = normalizeUsageMap(metadata?.bulkSenderUsage);
  return {
    domainUsage: mergeUsageMaps(storedDomainUsage, rowDomainUsage),
    senderUsage: mergeUsageMaps(storedSenderUsage, rowSenderUsage),
  };
}

async function incrementCampaignUsageCounters(campaignId, { senderEmail = "", senderDomain = "" } = {}) {
  const normalizedCampaignId = compact(campaignId);
  if (!normalizedCampaignId) {
    return { domainUsage: {}, senderUsage: {} };
  }
  const normalizedSenderEmail = normalizeEmail(senderEmail);
  const normalizedSenderDomain = normalizeEmail(senderDomain || getDomainFromEmail(senderEmail));

  return campaignStorage.withCampaignLock(normalizedCampaignId, async () => {
    const metadata = await campaignStorage.getCampaignMetadata(normalizedCampaignId);
    if (!metadata) {
      return { domainUsage: {}, senderUsage: {} };
    }
    const usage = getCampaignUsage(metadata);
    if (normalizedSenderDomain) {
      usage.domainUsage[normalizedSenderDomain] = (Number(usage.domainUsage[normalizedSenderDomain]) || 0) + 1;
    }
    if (normalizedSenderEmail) {
      usage.senderUsage[normalizedSenderEmail] = (Number(usage.senderUsage[normalizedSenderEmail]) || 0) + 1;
    }
    metadata.bulkDomainUsage = usage.domainUsage;
    metadata.bulkSenderUsage = usage.senderUsage;
    await campaignStorage.writeCampaignMetadata(normalizedCampaignId, metadata);
    return usage;
  });
}

function isWarmupEnabled() {
  const normalized = compact(process.env.WARMUP_ENABLED || "false").toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

const warmupEnabled = isWarmupEnabled();

function getCampaignTargetRows(metadata = {}) {
  const rows = Array.isArray(metadata.rows) ? metadata.rows : [];
  const count = Number.parseInt(metadata.count, 10);
  const targetRows = Number.isFinite(count) ? Math.max(0, Math.min(count, rows.length)) : rows.length;
  return rows.slice(0, targetRows);
}

function isCampaignFullySent(metadata = {}) {
  const targetRows = getCampaignTargetRows(metadata);
  if (targetRows.length < 1) {
    return false;
  }
  return targetRows.every((row) => compact(row?.emailStatus || row?.sourceRow?.email_status).toLowerCase() === "sent");
}

async function markCampaignCompletionNotification(campaignId, updates = {}) {
  await campaignStorage.withCampaignLock(campaignId, async () => {
    const current = await campaignStorage.getCampaignMetadata(campaignId);
    if (!current) {
      return;
    }
    Object.assign(current, updates);
    await campaignStorage.writeCampaignMetadata(campaignId, current);
  });
}

async function maybeSendCampaignCompletionNotification(metadata = {}) {
  if (!warmupEnabled) {
    return;
  }
  const campaignId = compact(metadata.id || metadata.campaignId);
  if (!campaignId) {
    return;
  }
  if (completionNotificationSentCampaigns.has(campaignId)) {
    return;
  }
  if (compact(metadata.warmupCompletionNotifiedAt)) {
    completionNotificationSentCampaigns.add(campaignId);
    return;
  }
  if (!isCampaignFullySent(metadata)) {
    return;
  }

  const warmupData = await readWarmupState();
  const recipients = Array.from(
    new Set(
      (Array.isArray(warmupData.seedEmails) ? warmupData.seedEmails : [])
        .map((item) => compact(item).toLowerCase())
        .filter(Boolean)
    )
  );
  if (recipients.length < 1) {
    return;
  }

  const targetRows = getCampaignTargetRows(metadata);
  const sentCount = targetRows.filter((row) => compact(row?.emailStatus).toLowerCase() === "sent").length;
  const completedAt = compact(metadata.completedAt) || new Date().toISOString();
  const subject = `Campaign Complete: ${campaignId}`;
  const body = [
    `Hello,`,
    ``,
    `This is a confirmation that campaign ${campaignId} has completed successfully.`,
    `All target emails have been sent (${sentCount} of ${targetRows.length}).`,
    ``,
    `Completed at: ${completedAt}`,
    ``,
    `Regards,`,
    `Goftus Mail System`,
  ].join("\n");

  let deliveredCount = 0;
  for (const recipient of recipients) {
    try {
      await sendEmail({
        to: recipient,
        subject,
        text: body,
      });
      deliveredCount += 1;
    } catch (error) {
      console.warn(`[campaign-complete] failed to notify ${recipient}: ${error.message}`);
    }
  }

  if (deliveredCount > 0) {
    const notifiedAt = new Date().toISOString();
    completionNotificationSentCampaigns.add(campaignId);
    await markCampaignCompletionNotification(campaignId, {
      warmupCompletionNotifiedAt: notifiedAt,
      warmupCompletionNotifiedRecipients: recipients,
      warmupCompletionNotifiedCount: deliveredCount,
    });
    console.log(
      `[campaign-complete] campaign=${campaignId} completion notification sent recipients=${deliveredCount}/${recipients.length}`
    );
  }
}

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.resolve(__dirname, "../public")));
app.use((req, res, next) => {
  const requestId = `req-${++requestCounter}`;
  const startedAt = Date.now();
  console.log(`[${requestId}] ${req.method} ${req.path} started`);
  res.on("finish", () => {
    console.log(
      `[${requestId}] ${req.method} ${req.path} completed status=${res.statusCode} elapsedMs=${Date.now() - startedAt}`
    );
  });
  next();
});
app.use("/api/warmup", warmupRoutes);

const ollamaClient = new OllamaClient({
  baseUrl: config.ollamaBaseUrl,
  model: config.ollamaModel,
  timeoutMs: config.requestTimeoutMs,
  generationOptions: config.ollamaGeneration,
  think: config.ollamaThink,
  keepAlive: config.ollamaKeepAlive,
});
const mailerOllamaClient = new OllamaClient({
  baseUrl: config.ollamaBaseUrl,
  model: config.ollamaMailerModel,
  timeoutMs: config.requestTimeoutMs,
  generationOptions: config.ollamaMailerGeneration,
  think: config.ollamaMailerThink,
  keepAlive: config.ollamaMailerKeepAlive || config.ollamaKeepAlive,
});

const hasCloudGeneration = Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_OSS_API_KEY);
const contentGenerationClient = hasCloudGeneration ? cascadeClient : ollamaClient;
const mailerGenerationClient = hasCloudGeneration ? cascadeClient : mailerOllamaClient;

// Shared Chrome session: one persistent browser context reused across all rows in a run.
// Only enabled when using cloud models (OpenAI); Ollama mode keeps per-row Chrome instances.
const sharedBrowserSession = hasCloudGeneration ? new SharedBrowserSession() : null;

cascadeClient.onTierChange((status) => {
  console.log(`[cascade] tier changed to ${status.currentTier}`);
  broadcastAllCampaignSse({ type: "model_tier_changed", ...status });
});

const contentService = new ContentService({ ollamaClient: contentGenerationClient });
const campaignStorage = new CampaignStorage({
  requestTimeoutMs: config.requestTimeoutMs,
  proxyList: config.proxyList,
  linkedInFetchMode: config.linkedInFetchMode,
  chromeExecutablePath: config.chromeExecutablePath,
  chromeUserDataDir: config.chromeUserDataDir,
  chromeProfileDirectory: config.chromeProfileName,
  chromeProfileEnabled: config.chromeProfileEnabled,
  chromeAutomationUserDataDir: config.chromeAutomationUserDataDir,
  chromeForceMirrorProfile: config.chromeForceMirrorProfile,
  chromeHeadless: config.chromeHeadless,
  chromeHeadlessFallback: config.chromeHeadlessFallback,
  chromeCookiesEnabled: config.chromeCookiesEnabled,
  chromeTimeoutMs: config.chromeTimeoutMs,
  playwrightEnabled: config.playwrightEnabled,
  playwrightTimeoutMs: config.playwrightTimeoutMs,
  subpageFetchEnabled: config.subpageFetchEnabled,
  subPageMaxCount: config.subPageMaxCount,
  searchSnippetEnabled: config.searchSnippetEnabled,
  searchSnippetMaxLines: config.searchSnippetMaxLines,
  rowConcurrency: config.rowConcurrency,
  generationConcurrency: config.generationConcurrency,
  profileSearchOnly: config.profileSearchOnly,
  continueOnWebsiteFetchFailure: config.continueOnWebsiteFetchFailure,
  pipelineStageTimeoutMs: config.pipelineStageTimeoutMs,
});
if (sharedBrowserSession) {
  campaignStorage.setSharedBrowserSession(sharedBrowserSession);
}
const mailerDocService = new MailerDocService({ ollamaClient: mailerGenerationClient });
const campaignSendService = new CampaignSendService({
  mailerDocService,
  contentService,
  reviewFetchService,
  ruleEngine,
  preferCombinedGeneration: config.previewUseCombinedGeneration,
});
const singleOllamaModelConfigured =
  String(config.ollamaModel || "").trim().toLowerCase() === String(config.ollamaMailerModel || "").trim().toLowerCase();
const modelLifecycleTargets = singleOllamaModelConfigured
  ? [{ label: "shared", client: ollamaClient }]
  : [
      { label: "mailer", client: mailerOllamaClient },
      { label: "content", client: ollamaClient },
    ];

async function unloadModelInstances(reason = "manual") {
  const startedAt = Date.now();
  console.log(`[model-lifecycle] unloading models reason=${reason}`);
  const unloadResults = await Promise.allSettled(modelLifecycleTargets.map((item) => item.client.unload()));
  unloadResults.forEach((result, index) => {
    if (result.status === "rejected") {
      console.warn(
        `[model-lifecycle] ${modelLifecycleTargets[index].label} unload failed: ${
          result.reason?.message || result.reason
        }`
      );
    }
  });
  if (singleOllamaModelConfigured) {
    console.log("[model-lifecycle] single model mode detected; shared unload used");
  }
  console.log(`[model-lifecycle] unload completed elapsedMs=${Date.now() - startedAt}`);
}

async function warmupModelInstances(reason = "manual") {
  const startedAt = Date.now();
  console.log(`[model-lifecycle] prewarming models reason=${reason}`);
  const warmupResults = await Promise.allSettled(modelLifecycleTargets.map((item) => item.client.warmup()));
  warmupResults.forEach((result, index) => {
    if (result.status === "rejected") {
      console.warn(
        `[model-lifecycle] ${modelLifecycleTargets[index].label} warmup failed: ${
          result.reason?.message || result.reason
        }`
      );
    }
  });
  if (singleOllamaModelConfigured) {
    console.log("[model-lifecycle] single model mode detected; shared warmup used");
  }
  console.log(`[model-lifecycle] prewarm completed elapsedMs=${Date.now() - startedAt}`);
}

campaignStorage.setCampaignEventNotifier((campaignId, event) => notifyCampaignUI(campaignId, event));

campaignStorage.setPipelineHandlers({
  buildMailerDoc: async ({ campaignId, rowNumber, websiteUrl, jinaContent, sourceRow, abortSignal }) => {
    const context = await campaignStorage.resolveRowGenerationContext({
      campaignId,
      rowNumber,
      websiteUrl,
      jinaContent,
      sourceRow,
    });
    const mailerFields = await mailerDocService.buildMailerFieldsForCampaignRow({
      rowNumber: context.rowNumber,
      websiteUrl: context.websiteUrl,
      jinaContent: context.jinaContent,
      sourceRow: context.sourceRow,
      abortSignal,
    });
    return {
      ok: true,
      campaignId: context.campaignId,
      rowNumber: context.rowNumber,
      docFileName: "",
      mailerFields,
    };
  },
  buildSendPreview: async ({ campaignId, rowNumber, websiteUrl, jinaContent, sourceRow, contactEmail, abortSignal }) => {
    const context = await campaignStorage.resolveRowGenerationContext({
      campaignId,
      rowNumber,
      websiteUrl,
      jinaContent,
      sourceRow,
      contactEmail,
    });
    return campaignSendService.buildPreviewForRow({
      campaignId: context.campaignId,
      rowNumber: context.rowNumber,
      websiteUrl: context.websiteUrl,
      jinaContent: context.jinaContent,
      sourceRow: context.sourceRow,
      contactEmail: context.contactEmail,
      draftIterations: 1,
      abortSignal,
    });
  },
  // Campaign pipeline now only prepares previews; actual sends are manual via Send/Send All endpoints.
  sendPreparedEmail: null,
  onRunStart: async ({ campaignId }) => {
    const normalizedCampaignId = String(campaignId || "").trim();
    if (!normalizedCampaignId || activeCampaignRuns.has(normalizedCampaignId)) {
      return;
    }

    activeCampaignRuns.add(normalizedCampaignId);
    if (activeCampaignRuns.size !== 1) {
      return;
    }

    await unloadModelInstances("run_start");
    await warmupModelInstances("run_start");

    if (sharedBrowserSession && !sharedBrowserSession.isOpen()) {
      await sharedBrowserSession.open({
        chromeExecutablePath: config.chromeExecutablePath,
        chromeUserDataDir: config.chromeUserDataDir,
        chromeProfileName: config.chromeProfileName,
        chromeAutomationUserDataDir: config.chromeAutomationUserDataDir,
        chromeForceMirrorProfile: config.chromeForceMirrorProfile,
        chromeHeadless: config.chromeHeadless,
        chromeTimeoutMs: config.chromeTimeoutMs,
      }).catch((error) => {
        console.warn(`[shared-browser] failed to open session: ${error?.message || error}`);
      });
    }
  },
  onRunComplete: async ({ campaignId, status }) => {
    const normalizedCampaignId = String(campaignId || "").trim();
    if (normalizedCampaignId) {
      activeCampaignRuns.delete(normalizedCampaignId);
    }

    const normalizedStatus = String(status || "").trim().toLowerCase();
    if (normalizedCampaignId && normalizedStatus === "completed") {
      const latestMetadata = await campaignStorage.getCampaignMetadata(normalizedCampaignId);
      await maybeSendCampaignCompletionNotification(latestMetadata || {});
    }
    const isTerminalStatus = ["completed", "failed", "stopped"].includes(normalizedStatus);
    if (!isTerminalStatus || activeCampaignRuns.size > 0) {
      return;
    }

    await unloadModelInstances("run_complete");

    if (sharedBrowserSession?.isOpen()) {
      await sharedBrowserSession.close().catch((error) => {
        console.warn(`[shared-browser] failed to close session: ${error?.message || error}`);
      });
    }
  },
});

void unloadModelInstances("server_startup").catch((error) => {
  console.warn(`[model-lifecycle] startup unload failed: ${error?.message || error}`);
});

function toValidationErrors(issues) {
  return issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

async function assertCampaignNotStopped(campaignId) {
  const campaign = await campaignStorage.getCampaignMetadata(campaignId);
  if (!campaign) {
    const error = new Error("Campaign not found");
    error.statusCode = 404;
    throw error;
  }
  const status = String(campaign.status || "").toLowerCase();
  if (status === "stopped") {
    const error = new Error("Campaign is stopped. Resume or restart before generating preview.");
    error.statusCode = 409;
    throw error;
  }
}

function isProtectedCampaignRow(row = {}) {
  const fetchMethod = String(row?.jinaFetchMethod || row?.sourceRow?.jina_fetch_method || "")
    .trim()
    .toLowerCase();
  const warning = String(row?.jinaError || row?.sourceRow?.jina_error || "")
    .trim()
    .toLowerCase();
  if (fetchMethod === "kasada_protected") {
    return true;
  }
  return (
    warning.includes("kasada protected") ||
    warning.includes("protected website blocked automated fetch") ||
    warning.includes("cloudflare") ||
    warning.includes("datadome") ||
    warning.includes("captcha") ||
    warning.includes("human verification") ||
    warning.includes("manual verification") ||
    warning.includes("access denied")
  );
}

async function assertCampaignRowCanGenerateMail(campaignId, rowNumber) {
  const campaign = await campaignStorage.getCampaignMetadata(campaignId);
  if (!campaign) {
    const error = new Error("Campaign not found");
    error.statusCode = 404;
    throw error;
  }
  const targetRowNumber = Number.parseInt(rowNumber, 10);
  const row = Array.isArray(campaign.rows)
    ? campaign.rows.find((item) => Number.parseInt(item?.rowNumber, 10) === targetRowNumber)
    : null;
  if (!row) {
    const error = new Error("Campaign row not found");
    error.statusCode = 404;
    throw error;
  }
  if (isProtectedCampaignRow(row)) {
    const error = new Error("Website is protected. Mail generation is disabled for this row.");
    error.statusCode = 409;
    throw error;
  }
}

app.get("/api/model-tier", (_req, res) => {
  return res.json({ ok: true, ...cascadeClient.getStatus() });
});

app.post("/api/model-tier", async (req, res) => {
  const tierName = compact(req.body?.tier);
  if (!tierName) {
    return res.status(400).json({ error: "tier is required (primary | secondary | table)" });
  }
  const campaignId = compact(req.body?.campaignId);
  try {
    if (campaignId) {
      await campaignStorage.stopCampaignAndWaitForIdle(campaignId, { timeoutMs: 30000 }).catch(() => {});
    }
    cascadeClient.switchToTier(tierName);
    return res.json({ ok: true, stopped: Boolean(campaignId), ...cascadeClient.getStatus() });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "content-creation",
    model: config.ollamaModel,
    mailerModel: config.ollamaMailerModel,
    linkedInFetchMode: config.linkedInFetchMode,
    mailConfigured: isMailerConfigured(),
  });
});

app.get("/api/mail/senders", async (req, res) => {
  try {
    const senders = await listSenders();
    const defaultSenderEmail = compact(process.env.BREVO_FROM);
    const defaultSenderName = compact(process.env.BREVO_FROM_NAME) || "Cold Mailbot";
    const campaignId = compact(req.query?.campaignId);
    const campaignMetadata = campaignId ? await campaignStorage.getCampaignMetadata(campaignId) : null;
    const usage = campaignMetadata ? getCampaignUsage(campaignMetadata) : { domainUsage: {}, senderUsage: {} };
    return res.json({
      ok: true,
      defaultSender: {
        email: defaultSenderEmail,
        name: defaultSenderName,
      },
      bulkDomainLimit: 30,
      domainUsage: usage.domainUsage,
      senderUsage: usage.senderUsage,
      senders,
    });
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.get("/api/blocklist", async (_req, res) => {
  try {
    const blocklist = await readBlocklist();
    return res.json({ ok: true, blocklist });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/blocklist", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const name = String(req.body?.name || "").trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "A valid email address is required" });
  }
  try {
    const blocklist = await addToBlocklist(email, name);
    return res.json({ ok: true, blocklist });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.delete("/api/blocklist/:email", async (req, res) => {
  const email = decodeURIComponent(req.params.email || "");
  try {
    const blocklist = await removeFromBlocklist(email);
    return res.json({ ok: true, blocklist });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/settings/chrome-cookies", (_req, res) => {
  const status = checkChromeCookieAvailability({
    userDataDir: config.chromeUserDataDir,
    profileName: config.chromeProfileName,
  });
  res.json(status);
});

app.post("/api/content/draft", async (req, res) => {
  const parsed = draftRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: toValidationErrors(parsed.error.issues) });
  }
  try {
    const result = await contentService.generateDraft(parsed.data.lead);
    return res.json({
      body: result.draft,
      compliance: result.compliance,
      attempts: result.attempts,
      requiresHumanReview: false,
    });
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.post("/api/content/subject", async (req, res) => {
  const parsed = subjectRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: toValidationErrors(parsed.error.issues) });
  }
  try {
    const result = await contentService.generateSubject(parsed.data.lead, parsed.data.draftBody);
    return res.json({
      subject: result.subject,
      compliance: result.compliance,
      attempts: result.attempts,
      requiresHumanReview: false,
    });
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.post("/api/content/generate", async (req, res) => {
  const parsed = generateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: toValidationErrors(parsed.error.issues) });
  }
  try {
    return res.json(await contentService.generateContent(parsed.data.lead));
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.post("/api/content/variants", async (req, res) => {
  const parsed = generateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: toValidationErrors(parsed.error.issues) });
  }
  try {
    return res.json(await contentService.generateVariants(parsed.data.lead));
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.post("/api/campaigns", async (req, res) => {
  const parsed = campaignUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: toValidationErrors(parsed.error.issues) });
  }
  try {
    return res.json({
      ok: true,
      campaign: await campaignStorage.saveUpload(parsed.data),
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get("/api/campaigns/latest", async (_req, res) => {
  try {
    const campaign = await campaignStorage.getLatestCampaignMetadata();
    return res.json({
      ok: true,
      campaign,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/campaigns/history", async (req, res) => {
  try {
    const campaigns = await campaignStorage.listRecentCampaignMetadata(req.query.limit);
    return res.json({
      ok: true,
      campaigns,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/campaigns/:campaignId/preview", async (req, res) => {
  try {
    const preview = await campaignStorage.getCampaignPreview(req.params.campaignId, req.query.limit);
    if (!preview) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    return res.json({
      ok: true,
      preview,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/campaigns/:campaignId/download", async (req, res) => {
  try {
    const result = await campaignStorage.getEnrichedFilePath(req.params.campaignId);
    if (!result || !result.filePath) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    return res.download(result.filePath, result.fileName);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/campaigns/:campaignId/pause", async (req, res) => {
  try {
    const campaign = await campaignStorage.pauseCampaign(req.params.campaignId);
    return res.json({
      ok: true,
      campaign,
    });
  } catch (error) {
    return res.status(/not found/i.test(error.message) ? 404 : 400).json({ error: error.message });
  }
});

app.post("/api/campaigns/:campaignId/resume", async (req, res) => {
  try {
    const campaign = await campaignStorage.resumeCampaign(req.params.campaignId);
    return res.json({
      ok: true,
      campaign,
    });
  } catch (error) {
    return res.status(/not found/i.test(error.message) ? 404 : 400).json({ error: error.message });
  }
});

app.post("/api/campaigns/:campaignId/stop", async (req, res) => {
  try {
    const normalizedCampaignId = String(req.params.campaignId || "").trim();
    await campaignStorage.stopCampaignAndWaitForIdle(normalizedCampaignId, {
      timeoutMs: Number.parseInt(process.env.CAMPAIGN_STOP_WAIT_TIMEOUT_MS, 10) || 180000,
    });
    await unloadModelInstances(`stop:${normalizedCampaignId || "unknown"}`);
    const campaign = await campaignStorage.getCampaignMetadata(normalizedCampaignId);
    return res.json({
      ok: true,
      campaign,
    });
  } catch (error) {
    return res.status(/not found/i.test(error.message) ? 404 : 400).json({ error: error.message });
  }
});

app.post("/api/campaigns/:campaignId/reset", async (req, res) => {
  try {
    const normalizedCampaignId = String(req.params.campaignId || "").trim();
    await campaignStorage.stopCampaignAndWaitForIdle(normalizedCampaignId, {
      timeoutMs: Number.parseInt(process.env.CAMPAIGN_RESET_WAIT_TIMEOUT_MS, 10) || 180000,
    });
    await unloadModelInstances(`reset:${String(req.params.campaignId || "").trim() || "unknown"}`);
    await campaignStorage.resetCampaign(normalizedCampaignId);
    const campaign = await campaignStorage.resumeCampaign(normalizedCampaignId);
    return res.json({
      ok: true,
      campaign,
    });
  } catch (error) {
    return res.status(/not found/i.test(error.message) ? 404 : 400).json({ error: error.message });
  }
});

app.post("/api/campaigns/:campaignId/rows/:rowNumber/retry", async (req, res) => {
  try {
    const mode = String(req.body?.mode || "").trim().toLowerCase();
    const rebuildPreview = mode === "refetch_and_preview" || req.body?.rebuildPreview === true;
    const campaign = await campaignStorage.retryRow(req.params.campaignId, req.params.rowNumber, { rebuildPreview });
    return res.json({
      ok: true,
      campaign,
    });
  } catch (error) {
    return res.status(/not found/i.test(error.message) ? 404 : 400).json({ error: error.message });
  }
});

app.post("/api/campaigns/:campaignId/rows/delete", async (req, res) => {
  const parsed = campaignDeleteRowsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: toValidationErrors(parsed.error.issues) });
  }
  try {
    const campaign = await campaignStorage.deleteRows(req.params.campaignId, parsed.data.rowNumbers);
    return res.json({
      ok: true,
      campaign,
    });
  } catch (error) {
    const message = String(error?.message || "");
    const isConflict = /pause or stop|cannot delete rows while campaign is running/i.test(message);
    return res.status(isConflict ? 409 : /not found/i.test(message) ? 404 : 400).json({ error: error.message });
  }
});

app.get("/api/campaigns/:campaignId", async (req, res) => {
  try {
    const campaign = await campaignStorage.getCampaignMetadata(req.params.campaignId);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    if (String(campaign.status || "").toLowerCase() === "running") {
      void campaignStorage.ensureRunProcessor(req.params.campaignId);
    }
    return res.json({
      ok: true,
      campaign,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/campaigns/:campaignId/events", (req, res) => {
  const campaignId = String(req.params.campaignId || "").trim();
  if (!campaignId) {
    return res.status(400).json({ error: "campaignId is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  res.write("event: connected\n");
  res.write(`data: ${JSON.stringify({ ok: true, campaignId })}\n\n`);
  addCampaignSseClient(campaignId, res);

  req.on("close", () => {
    removeCampaignSseClient(campaignId, res);
  });
});

app.post("/api/campaigns/:campaignId/resume-row", async (req, res) => {
  const campaignId = String(req.params.campaignId || "").trim();
  const rowValue = req.body?.rowIndex ?? req.body?.rowNumber;
  try {
    const result = resumeVerification(campaignId, rowValue);
    return res.json({
      ok: true,
      campaignId: result.campaignId,
      rowNumber: result.rowNumber,
      rowIndex: result.rowNumber,
    });
  } catch (error) {
    return res.status(/no pending verification/i.test(error.message) ? 404 : 400).json({ error: error.message });
  }
});

app.post("/api/campaigns/:campaignId/skip-row", async (req, res) => {
  const campaignId = String(req.params.campaignId || "").trim();
  const rowValue = req.body?.rowIndex ?? req.body?.rowNumber;
  const reason = String(req.body?.reason || "Skipped by user during verification");
  try {
    try {
      skipVerification(campaignId, rowValue);
    } catch (_error) {
      // If there is no pending verification, still force-skip the row.
    }
    const campaign = await campaignStorage.skipRow(campaignId, rowValue, reason);
    return res.json({
      ok: true,
      campaign,
    });
  } catch (error) {
    return res.status(/not found/i.test(error.message) ? 404 : 400).json({ error: error.message });
  }
});

app.post("/api/campaigns/mailer-doc", async (req, res) => {
  const parsed = mailerDocRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: toValidationErrors(parsed.error.issues) });
  }
  try {
    await assertCampaignNotStopped(parsed.data.campaignId);
    await assertCampaignRowCanGenerateMail(parsed.data.campaignId, parsed.data.rowNumber);
    const context = await campaignStorage.resolveRowGenerationContext(parsed.data);
    const generated = await mailerDocService.generateForCampaignRow({
      campaignId: context.campaignId,
      rowNumber: context.rowNumber,
      websiteUrl: context.websiteUrl,
      jinaContent: context.jinaContent,
      sourceRow: context.sourceRow,
    });
    const emailStatus = "completed";
    await campaignStorage.updateEnrichedRow({
      campaignId: context.campaignId,
      rowNumber: context.rowNumber,
      updates: {
        ...(generated.mailerFields || {}),
        [EMAIL_STATUS_COLUMN]: emailStatus,
      },
    });
    return res.json({
      ...generated,
      emailStatus,
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ error: error.message });
  }
});

app.post("/api/campaigns/send-preview", async (req, res) => {
  const parsed = campaignSendPreviewRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: toValidationErrors(parsed.error.issues) });
  }
  try {
    await assertCampaignNotStopped(parsed.data.campaignId);
    await assertCampaignRowCanGenerateMail(parsed.data.campaignId, parsed.data.rowNumber);
    const context = await campaignStorage.resolveRowGenerationContext(parsed.data);
    const preview = await campaignSendService.buildPreviewForRow({
      campaignId: context.campaignId,
      rowNumber: context.rowNumber,
      websiteUrl: context.websiteUrl,
      jinaContent: context.jinaContent,
      sourceRow: context.sourceRow,
      contactEmail: context.contactEmail,
      draftIterations: parsed.data.draftIterations,
    });
    const emailStatus = "preview_ready";
    await campaignStorage.updateEnrichedRow({
      campaignId: context.campaignId,
      rowNumber: context.rowNumber,
      updates: {
        [EMAIL_TO_COLUMN]: preview.to,
        [EMAIL_SUBJECT_COLUMN]: preview.subject,
        [EMAIL_GENERATED_BODY_COLUMN]: preview.generatedBody,
        [EMAIL_BODY_COLUMN]: preview.body,
        [EMAIL_PREVIEWED_AT_COLUMN]: new Date().toISOString(),
        [EMAIL_ERROR_COLUMN]: "",
        [EMAIL_STATUS_COLUMN]: emailStatus,
      },
    });
    return res.json({
      ...preview,
      emailStatus,
    });
  } catch (error) {
    const statusCode = error.statusCode || (/recipient email/i.test(error.message) ? 400 : 502);
    return res.status(statusCode).json({ error: error.message });
  }
});

app.post("/api/campaigns/send", async (req, res) => {
  const parsed = campaignSendRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: toValidationErrors(parsed.error.issues) });
  }
  try {
    const domainLimit = 30;
    const requestedSenderEmail = compact(parsed.data.senderEmail) || compact(process.env.BREVO_FROM);
    const requestedSenderDomain = getDomainFromEmail(requestedSenderEmail);
    if (parsed.data.enforceDomainBulkLimit && requestedSenderDomain) {
      const campaignMetadata = await campaignStorage.getCampaignMetadata(parsed.data.campaignId);
      const usageByDomain = getCampaignUsage(campaignMetadata || {}).domainUsage;
      const used = Number(usageByDomain[requestedSenderDomain]) || 0;
      if (used >= domainLimit) {
        return res.status(409).json({
          error: `Bulk limit reached for domain ${requestedSenderDomain}: ${used}/${domainLimit}`,
          domain: requestedSenderDomain,
          used,
          limit: domainLimit,
        });
      }
    }

    const sent = await campaignSendService.sendPreparedEmail(parsed.data);
    const emailStatus = "sent";
    const sentSenderEmail = compact(sent?.sender?.email) || requestedSenderEmail;
    const sentSenderDomain = getDomainFromEmail(sentSenderEmail);
    await campaignStorage.updateEnrichedRow({
      campaignId: parsed.data.campaignId,
      rowNumber: parsed.data.rowNumber,
      updates: {
        [EMAIL_TO_COLUMN]: sent.to,
        [EMAIL_SUBJECT_COLUMN]: sent.subject,
        [EMAIL_BODY_COLUMN]: sent.body,
        [EMAIL_SENT_AT_COLUMN]: sent.sentAt || new Date().toISOString(),
        [EMAIL_MESSAGE_ID_COLUMN]: sent.messageId,
        [EMAIL_ERROR_COLUMN]: "",
        [EMAIL_SENDER_COLUMN]: sentSenderEmail,
        [EMAIL_SENDER_DOMAIN_COLUMN]: sentSenderDomain,
        [EMAIL_STATUS_COLUMN]: emailStatus,
      },
    });
    const usage = await incrementCampaignUsageCounters(parsed.data.campaignId, {
      senderEmail: sentSenderEmail,
      senderDomain: sentSenderDomain,
    });
    const campaignMetadata = await campaignStorage.getCampaignMetadata(parsed.data.campaignId);
    await maybeSendCampaignCompletionNotification(campaignMetadata || {});
    return res.json({
      ...sent,
      emailStatus,
      domainUsage: usage.domainUsage,
      senderUsage: usage.senderUsage,
    });
  } catch (error) {
    try {
      await campaignStorage.updateEnrichedRow({
        campaignId: parsed.data.campaignId,
        rowNumber: parsed.data.rowNumber,
        updates: {
          [EMAIL_STATUS_COLUMN]: "send_failed",
          [EMAIL_ERROR_COLUMN]: error.message || "Send failed",
        },
      });
    } catch (_persistError) {
      // Keep API failure reason as the primary error response.
    }
    const statusCode = /recipient email|selected sender|inactive in brevo|gmail smtp is not configured|gmail_user|gmail_app_pass|subject and body|bulk limit reached/i.test(
      error.message
    )
      ? 400
      : 502;
    return res.status(statusCode).json({ error: error.message });
  }
});

app.use((error, _req, res, _next) => {
  res.status(500).json({ error: error.message || "Unexpected server error" });
});

app.get("/", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/index.html"));
});

const PORT = Number.parseInt(process.env.PORT, 10) || config.port || 3000;
async function startServer() {
  try {
    await verifyMailer();
    console.log("Mail connection verified");
  } catch (error) {
    console.error(`Mail connection failed: ${error.message}`);
    process.exit(1);
  }

  if (!warmupEnabled) {
    console.log("[warmup] disabled (WARMUP_ENABLED=false)");
  } else {
    try {
      const warmupData = await readWarmupState();
      if (warmupData.status === "active") {
        checkReplies().catch((error) => {
          console.warn(`[warmup] Reply check failed: ${error.message}`);
        });
      }
    } catch (error) {
      console.warn(`[warmup] Unable to initialize startup reply check: ${error.message}`);
    }
  }

  const server = app.listen(PORT, () => {
    console.log(`Content creation service running on port ${PORT}`);
    console.log(
      `Startup config model=${config.ollamaModel} timeoutMs=${config.requestTimeoutMs} numPredict=${config.ollamaGeneration.numPredict} topP=${config.ollamaGeneration.topP} topK=${config.ollamaGeneration.topK} think=${config.ollamaThink || "default"}`
    );
    console.log(
      `Mailer config model=${config.ollamaMailerModel} numPredict=${config.ollamaMailerGeneration.numPredict} topP=${config.ollamaMailerGeneration.topP} topK=${config.ollamaMailerGeneration.topK} think=${config.ollamaMailerThink || "off"}`
    );
    console.log(`Campaign proxy pool size=${Array.isArray(config.proxyList) ? config.proxyList.length : 0}`);
    console.log(
      `LinkedIn fetch mode=${config.linkedInFetchMode} chromeProfile=${config.chromeProfileDirectory} headless=${config.chromeHeadless}`
    );
    console.log(
      `Website fetch fallbacks playwright=${config.playwrightEnabled} chromeProfile=${config.chromeProfileEnabled} chromeCookies=${config.chromeCookiesEnabled} searchSnippet=${config.searchSnippetEnabled} continueOnFetchFailure=${config.continueOnWebsiteFetchFailure}`
    );
    console.log(
      `Speed controls profileSearchOnly=${config.profileSearchOnly} previewUseCombinedGeneration=${config.previewUseCombinedGeneration} rowConcurrency=${config.rowConcurrency} generationConcurrency=${config.generationConcurrency} pipelineStageTimeoutMs=${config.pipelineStageTimeoutMs}`
    );
  });

  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
      console.error(`[startup] Port ${PORT} is already in use.`);
      console.error("[startup] Run: taskkill /PID <pid> /F (Windows) or kill -9 <pid> (Mac/Linux)");
      console.error("[startup] Or set a different port: PORT=3001 node src/server.js");
      process.exit(1);
    }
    throw error;
  });
}

void startServer();
