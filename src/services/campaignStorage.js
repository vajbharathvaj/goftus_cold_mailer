const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const XLSX = require("xlsx");
const { enrichWebsiteContent } = require("./websiteFetchService");

const ALLOWED_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);
const STORAGE_ROOT = path.resolve(__dirname, "../../storage/campaigns");
const WEBSITE_COLUMN_CANDIDATES = ["website", "websiteurl", "website_url", "url", "site"];
const LINKEDIN_COLUMN_CANDIDATES = [
  "linkedin",
  "linkedinurl",
  "linkedin_url",
  "linkedinprofile",
  "linkedinprofileurl",
  "linkedincompany",
  "linkedincompanyurl",
];
const EMAIL_COLUMN_CANDIDATES = [
  "email",
  "emailaddress",
  "contactemail",
  "workemail",
  "businessemail",
  "primaryemail",
  "contactprofessionsemail",
  "contactprofessionalemail",
  "directdecisionmakeremail",
  "bestoutreachemail",
  "decisionmakeremail",
  "prospectemail",
  "emailid",
  "emails",
];
const JINA_CONTENT_COLUMN = "jina_content";
const JINA_ERROR_COLUMN = "jina_error";
const JINA_FETCH_METHOD_COLUMN = "jina_fetch_method";
const JINA_SUB_PAGES_COLUMN = "jina_sub_pages";
const JINA_FETCH_TRACE_COLUMN = "jina_fetch_trace";
const LINKEDIN_CONTENT_COLUMN = "linkedin_content";
const LINKEDIN_DESCRIPTION_COLUMN = "linkedin_description";
const LINKEDIN_ERROR_COLUMN = "linkedin_error";
const EMAIL_STATUS_COLUMN = "email_status";
const EMAIL_TO_COLUMN = "email_to";
const EMAIL_SUBJECT_COLUMN = "email_subject";
const EMAIL_GENERATED_BODY_COLUMN = "email_generated_body";
const EMAIL_BODY_COLUMN = "email_body";
const EMAIL_PREVIEWED_AT_COLUMN = "email_previewed_at";
const EMAIL_SENT_AT_COLUMN = "email_sent_at";
const EMAIL_MESSAGE_ID_COLUMN = "email_message_id";
const EMAIL_ERROR_COLUMN = "email_error";
const EMAIL_SENDER_COLUMN = "email_sender";
const EMAIL_SENDER_DOMAIN_COLUMN = "email_sender_domain";
const EMAIL_STATUS_MISSING_RECIPIENT = "missing_email";
const MISSING_RECIPIENT_EMAIL_ERROR = "Missing recipient email. Row skipped from processing.";
const CAMPAIGN_STATUS_RUNNING = "running";
const CAMPAIGN_STATUS_PAUSED = "paused";
const CAMPAIGN_STATUS_COMPLETED = "completed";
const CAMPAIGN_STATUS_STOPPED = "stopped";
const CAMPAIGN_STATUS_FAILED = "failed";
const ROW_STATUS_QUEUED = "queued";
const ROW_STATUS_FETCHING = "fetching";
const ROW_STATUS_FETCHED = "fetched";
const ROW_STATUS_GENERATING_MAIL = "generating_mail";
const ROW_STATUS_GENERATING_PREVIEW = "generating_preview";
const ROW_STATUS_READY = "ready";
const ROW_STATUS_SENT = "sent";
const ROW_STATUS_PAUSED = "paused";
const ROW_STATUS_AWAITING_VERIFICATION = "awaiting_verification";
const ROW_STATUS_DONE = "done";
const ROW_STATUS_FAILED = "failed";
const MAX_CELL_LENGTH = 32000;
const METADATA_READ_MAX_ATTEMPTS = 4;
const METADATA_READ_RETRY_DELAY_MS = 25;
const METADATA_WRITE_MAX_ATTEMPTS = 8;
const METADATA_WRITE_RETRY_DELAY_MS = 40;
const URL_REGEX = /\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+/gi;

function isCampaignRunningStatus(status) {
  return String(status || "").toLowerCase() === CAMPAIGN_STATUS_RUNNING;
}

function sanitizeFileName(fileName) {
  const baseName = path.basename(String(fileName || "").trim());
  const cleaned = baseName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return cleaned || "campaign-upload.xlsx";
}

function truncateCellText(value) {
  const normalized = String(value || "").trim();
  if (normalized.length <= MAX_CELL_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_CELL_LENGTH - 15)}\n\n[truncated...]`;
}

function formatFetchTrace(trace) {
  if (Array.isArray(trace)) {
    return trace
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .join("\n");
  }
  return String(trace || "").trim();
}

function isKasadaProtectionWarning(value) {
  const lower = compact(value).toLowerCase();
  return (
    lower.includes("kasada protected") ||
    lower.includes("window.kpsdk") ||
    lower.includes("x-kpsdk") ||
    lower.includes("kp_uidz")
  );
}

function isProtectedWebsiteWarning(value) {
  const lower = compact(value).toLowerCase();
  if (!lower) {
    return false;
  }
  if (isKasadaProtectionWarning(lower)) {
    return true;
  }
  return (
    lower.includes("protected website blocked automated fetch") ||
    lower.includes("cloudflare") ||
    lower.includes("datadome") ||
    lower.includes("captcha") ||
    lower.includes("human verification") ||
    lower.includes("manual verification") ||
    lower.includes("access denied")
  );
}

function isProtectedFetchMethod(value) {
  const method = compact(value).toLowerCase();
  return method === "kasada_protected";
}

function buildResetColumnUpdates() {
  return {
    [JINA_CONTENT_COLUMN]: "",
    [JINA_ERROR_COLUMN]: "",
    [JINA_FETCH_METHOD_COLUMN]: "none",
    [JINA_SUB_PAGES_COLUMN]: 0,
    [JINA_FETCH_TRACE_COLUMN]: "",
    [LINKEDIN_CONTENT_COLUMN]: "",
    [LINKEDIN_DESCRIPTION_COLUMN]: "",
    [LINKEDIN_ERROR_COLUMN]: "",
    [EMAIL_TO_COLUMN]: "",
    [EMAIL_SUBJECT_COLUMN]: "",
    [EMAIL_GENERATED_BODY_COLUMN]: "",
    [EMAIL_BODY_COLUMN]: "",
    [EMAIL_PREVIEWED_AT_COLUMN]: "",
    [EMAIL_SENT_AT_COLUMN]: "",
    [EMAIL_MESSAGE_ID_COLUMN]: "",
    [EMAIL_ERROR_COLUMN]: "",
    [EMAIL_SENDER_COLUMN]: "",
    [EMAIL_SENDER_DOMAIN_COLUMN]: "",
    [EMAIL_STATUS_COLUMN]: "pending",
  };
}

function compact(value) {
  return String(value || "").trim();
}

function normalizeEmailValue(value) {
  return compact(value).toLowerCase();
}

function domainFromEmail(value) {
  const email = normalizeEmailValue(value);
  const atIndex = email.lastIndexOf("@");
  if (atIndex < 1 || atIndex >= email.length - 1) {
    return "";
  }
  return email.slice(atIndex + 1);
}

function normalizeUsageCountMap(value) {
  const usage = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return usage;
  }
  for (const [rawKey, rawCount] of Object.entries(value)) {
    const key = normalizeEmailValue(rawKey);
    if (!key) {
      continue;
    }
    usage[key] = Math.max(0, Number.parseInt(rawCount, 10) || 0);
  }
  return usage;
}

function buildSenderUsageFromRows(rows = []) {
  const usage = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const status = normalizeEmailValue(row?.emailStatus || row?.sourceRow?.[EMAIL_STATUS_COLUMN]);
    if (status !== "sent") {
      continue;
    }
    const senderEmail = normalizeEmailValue(row?.senderEmail || row?.sourceRow?.[EMAIL_SENDER_COLUMN]);
    if (!senderEmail) {
      continue;
    }
    usage[senderEmail] = (Number(usage[senderEmail]) || 0) + 1;
  }
  return usage;
}

function buildDomainUsageFromRows(rows = []) {
  const usage = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const status = normalizeEmailValue(row?.emailStatus || row?.sourceRow?.[EMAIL_STATUS_COLUMN]);
    if (status !== "sent") {
      continue;
    }
    const senderDomain = normalizeEmailValue(
      row?.senderDomain || row?.sourceRow?.[EMAIL_SENDER_DOMAIN_COLUMN] || domainFromEmail(row?.senderEmail || row?.sourceRow?.[EMAIL_SENDER_COLUMN])
    );
    if (!senderDomain) {
      continue;
    }
    usage[senderDomain] = (Number(usage[senderDomain]) || 0) + 1;
  }
  return usage;
}

function mergeUsageCountMaps(primary = {}, fallback = {}) {
  const merged = { ...normalizeUsageCountMap(primary) };
  const fallbackUsage = normalizeUsageCountMap(fallback);
  for (const [key, value] of Object.entries(fallbackUsage)) {
    if (!Object.prototype.hasOwnProperty.call(merged, key)) {
      merged[key] = value;
      continue;
    }
    merged[key] = Math.max(merged[key], value);
  }
  return merged;
}

function buildMergedUsageFromMetadata(metadata = {}) {
  const rows = Array.isArray(metadata?.rows) ? metadata.rows : [];
  return {
    domainUsage: mergeUsageCountMaps(metadata?.bulkDomainUsage, buildDomainUsageFromRows(rows)),
    senderUsage: mergeUsageCountMaps(metadata?.bulkSenderUsage, buildSenderUsageFromRows(rows)),
  };
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMailerSendDelayMs() {
  const parsed = Number.parseInt(process.env.MAILER_SEND_DELAY_MS, 10);
  if (!Number.isFinite(parsed)) {
    return 180000;
  }
  return Math.max(parsed, 0);
}

function isTransientMetadataWriteError(error) {
  const code = String(error?.code || "").toUpperCase();
  return ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY", "EMFILE", "ENFILE"].includes(code);
}

function tryParseRepairedMetadata(raw) {
  const source = String(raw || "");
  if (!source.trim()) {
    return null;
  }
  const resultsKey = '"results"';
  const resultsIndex = source.indexOf(resultsKey);
  if (resultsIndex < 0) {
    return null;
  }
  const prefix = source.slice(0, resultsIndex);
  const repaired = `${prefix}"results": []\n}`;
  try {
    return JSON.parse(repaired);
  } catch (_error) {
    return null;
  }
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
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

function toNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = compact(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function safeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function resolveCompanyNameForFetch(row = {}, sourceRow = {}) {
  return firstNonEmpty(
    row?.companyName,
    sourceRow?.companyName,
    sourceRow?.CompanyName,
    sourceRow?.company,
    sourceRow?.Company,
    sourceRow?.["Business Name"],
    sourceRow?.businessName,
    sourceRow?.Business
  );
}

function normalizeProxyUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  return `http://${raw}`;
}

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function detectColumn(rows, candidates) {
  const headerPool = new Map();
  rows.forEach((row) => {
    Object.keys(row || {}).forEach((key) => {
      const normalized = normalizeHeader(key);
      if (normalized && !headerPool.has(normalized)) {
        headerPool.set(normalized, key);
      }
    });
  });
  for (const candidate of candidates) {
    if (headerPool.has(candidate)) {
      return headerPool.get(candidate);
    }
  }
  return "";
}

function detectWebsiteColumn(rows) {
  return detectColumn(rows, WEBSITE_COLUMN_CANDIDATES);
}

function detectLinkedInColumn(rows) {
  return detectColumn(rows, LINKEDIN_COLUMN_CANDIDATES);
}

function detectEmailColumn(rows) {
  return detectColumn(rows, EMAIL_COLUMN_CANDIDATES);
}

function normalizeWebsiteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new Error("Row is missing a website URL");
  }
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return new URL(withProtocol).toString();
}

function normalizeRecipientEmail(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const jsonCandidate = raw.startsWith("[") || raw.startsWith("{");
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const nested = normalizeRecipientEmail(item?.address || item?.email || item);
          if (nested) {
            return nested;
          }
        }
      } else if (parsed && typeof parsed === "object") {
        return normalizeRecipientEmail(parsed.address || parsed.email);
      }
    } catch (_error) {
      // Fall through to token extraction.
    }
  }
  const tokens = raw
    .split(/[\s,;|]+/g)
    .map((item) => String(item || "").replace(/[<>()"'`]+/g, "").trim())
    .filter(Boolean);
  const emailPattern = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
  for (const token of tokens) {
    if (emailPattern.test(token)) {
      return token.toLowerCase();
    }
  }
  if (emailPattern.test(raw)) {
    return raw.toLowerCase();
  }
  return "";
}

function resolveRecipientEmailFromRow({ row = {}, sourceRow = {}, emailColumn = "" } = {}) {
  return normalizeRecipientEmail(
    firstNonEmpty(
      row?.contactEmail,
      row?.emailTo,
      emailColumn ? sourceRow?.[emailColumn] : "",
      sourceRow?.contactEmail,
      sourceRow?.ContactEmail,
      sourceRow?.email,
      sourceRow?.Email,
      sourceRow?.emailAddress,
      sourceRow?.EmailAddress,
      sourceRow?.workEmail,
      sourceRow?.WorkEmail,
      sourceRow?.businessEmail,
      sourceRow?.BusinessEmail,
      sourceRow?.contact_professions_email,
      sourceRow?.contactProfessionalEmail,
      sourceRow?.direct_decision_maker_email,
      sourceRow?.best_outreach_email,
      sourceRow?.["Direct Decision Maker Email"],
      sourceRow?.["Best Outreach Email"],
      sourceRow?.emails
    )
  );
}

function buildJinaReaderUrl(url) {
  return `https://r.jina.ai/${url}`;
}

function getWorkbookTypeForExtension(extension) {
  if (extension === ".csv") {
    return "csv";
  }
  if (extension === ".xls") {
    return "biff8";
  }
  return "xlsx";
}

function resolveLinkedInEntityInfo(linkedInUrl) {
  const parsed = new URL(normalizeWebsiteUrl(linkedInUrl));
  const host = parsed.hostname.replace(/^www\./i, "");
  const pathParts = parsed.pathname
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const segment = pathParts[0] || "";
  const slug = pathParts[1] || "";

  if ((segment === "in" || segment === "company") && slug) {
    return {
      host,
      pathParts,
      segment,
      slug,
      target: `${host}/${segment}/${slug}`,
    };
  }

  return {
    host,
    pathParts,
    segment,
    slug: pathParts[pathParts.length - 1] || "",
    target: `${host}${parsed.pathname.replace(/\/+$/, "")}`,
  };
}

function normalizeLinkedInSearchTarget(linkedInUrl) {
  return resolveLinkedInEntityInfo(linkedInUrl).target;
}

function getLinkedInPathParts(linkedInUrl) {
  return resolveLinkedInEntityInfo(linkedInUrl).pathParts;
}

function buildSearchNameFromLinkedInUrl(linkedInUrl) {
  const { slug } = resolveLinkedInEntityInfo(linkedInUrl);
  const tokens = slug
    .split(/[-_]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => /[a-z]/i.test(item) && !/\d/.test(item));
  if (tokens.length === 0) {
    return "";
  }
  return tokens.map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(" ");
}

function buildLinkedInQueries(linkedInUrl) {
  const target = normalizeLinkedInSearchTarget(linkedInUrl);
  const { segment, slug } = resolveLinkedInEntityInfo(linkedInUrl);
  const searchName = buildSearchNameFromLinkedInUrl(linkedInUrl);
  const queries = [];

  if (segment === "in" && searchName) {
    queries.push(`site:linkedin.com/in/ "${searchName}"`);
  } else if (segment === "company" && searchName) {
    queries.push(`site:linkedin.com/company/ "${searchName}"`);
  }

  queries.push(`site:${target}`);
  queries.push(`"${target}"`);

  // Last-resort fallback in broad unquoted format:
  // example: site:linkedin.com/in akil kuhan
  const looseName = (searchName || slug || "")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (segment === "in" && looseName) {
    queries.push(`site:linkedin.com/in ${looseName}`);
  } else if (segment === "company" && looseName) {
    queries.push(`site:linkedin.com/company ${looseName}`);
  }

  return Array.from(new Set(queries));
}

function buildLinkedInSearchUrls(linkedInUrl) {
  const queries = buildLinkedInQueries(linkedInUrl);
  const urls = [];
  for (const query of queries) {
    const encoded = encodeURIComponent(query);
    urls.push(`https://html.duckduckgo.com/html/?q=${encoded}`);
    urls.push(`https://www.bing.com/search?q=${encoded}`);
    urls.push(`https://www.google.com/search?q=${encoded}`);
  }
  return urls;
}

function extractPlainTextFromJinaResponse(value) {
  const input = String(value || "").replace(/\r\n/g, "\n");
  const withoutReferenceLinks = input.replace(/^\s*\[[^\]]+\]:\s+\S+.*$/gm, "");
  const withoutMarkdownImages = withoutReferenceLinks.replace(/!\[[^\]]*]\([^)]*\)/gi, "");
  const withNamedLinksFlattened = withoutMarkdownImages.replace(/\[([^\]]*)\]\(([^)]+)\)/gi, "$1");
  const withoutScriptLikeUris = withNamedLinksFlattened.replace(/\b(?:javascript|blob):[^\s)]+/gi, "");
  const withoutAutoLinks = withoutScriptLikeUris.replace(/<\s*(https?:\/\/[^>]+)\s*>/gi, "");
  const withoutBareUrls = withoutAutoLinks.replace(URL_REGEX, "");
  const withoutHtmlTags = withoutBareUrls.replace(/<\/?[^>]+>/g, " ");
  const withoutMarkdownSyntax = withoutHtmlTags.replace(/^[#>*-]+\s*/gm, "").replace(/`{1,3}/g, "").replace(/\|/g, " ");
  return withoutMarkdownSyntax
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function extractLinkedInDescriptionFromText(value, linkedInUrl = "") {
  const lines = String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return "";
  }

  const bannedPatterns = [
    /^(sign in|join now|linkedin)$/i,
    /^(google|all|images|videos|news|maps|shopping|tools)$/i,
    /^duckduckgo$/i,
    /^bing$/i,
    /^title:/i,
    /^url source:/i,
    /^published time:/i,
    /^markdown content:/i,
    /^warning:/i,
    /^no results found for\b/i,
    /^search only for\b/i,
    /^showing results for\b/i,
    /^remove unnecessary punctuation\b/i,
    /javascript:void\(0\)/i,
    /\bblob:/i,
    /\bprofile picture\b/i,
    /^about \d[\d,.]* results/i,
    /\bat duckduckgo\b/i,
    /\bat bing\b/i,
    /\bcached snapshot of the original page\b/i,
    /\bfollowers?\b/i,
    /\bconnections?\b/i,
    /\bsee all details\b/i,
    /\bpeople also viewed\b/i,
    /\bhome\b/i,
    /\bjobs\b/i,
    /\bposts\b/i,
    /please solve the challenge below to continue/i,
    /solve the challenge below/i,
    /\bcomplete the challenge\b/i,
  ];
  const normalizeForMatch = (line) => String(line || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const isDividerLine = (line) => /^(?:[=\-_*~#\s]){5,}$/.test(line);
  const isValidCandidateLine = (line) =>
    line.length >= 25 &&
    line.length <= 600 &&
    /[A-Za-z]/.test(line) &&
    !isDividerLine(line) &&
    !/^https?:\/\//i.test(line) &&
    !/\s›\s/.test(line) &&
    !/\blinkedin\.[a-z]{2,}\b/i.test(line) &&
    !/site:linkedin\.com\//i.test(line) &&
    !/linkedin\.com\//i.test(line) &&
    !/\b(description|search)\b.*\bduckduckgo\b/i.test(line) &&
    !/\s-\s*linkedin$/i.test(line) &&
    !/\blinkedin\s*$/i.test(line) &&
    !bannedPatterns.some((pattern) => pattern.test(line));
  const findCandidateLine = (pool) => pool.find((line) => isValidCandidateLine(line)) || "";

  const target = linkedInUrl ? normalizeLinkedInSearchTarget(linkedInUrl) : "";
  const { segment = "" } = linkedInUrl ? resolveLinkedInEntityInfo(linkedInUrl) : {};
  const targetSlug = target.split("/").pop() || "";
  const compactTarget = normalizeForMatch(target);
  const compactSlug = normalizeForMatch(targetSlug);
  const compactSegment = normalizeForMatch(segment);
  const slugTokens = targetSlug
    .split(/[-_]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length >= 3 && !/^\d+$/.test(item));
  const isTargetAnchorLine = (line) => {
    const compactLine = normalizeForMatch(line);
    if (!compactLine || /^site:/i.test(line)) {
      return false;
    }
    if (!/\blinkedin\b/i.test(line)) {
      return false;
    }
    if (compactTarget && compactLine.includes(compactTarget)) {
      return true;
    }
    if (!compactSlug || !compactLine.includes(compactSlug)) {
      return false;
    }
    if (!compactSegment) {
      return true;
    }
    if (compactLine.includes(`${compactSegment}${compactSlug}`)) {
      return true;
    }
    return new RegExp(`\\b${segment}\\b`, "i").test(line);
  };
  const findTargetAnchoredCandidate = () => {
    if (!compactSlug && !compactTarget) {
      return { foundAnchor: false, description: "" };
    }
    const anchorIndex = lines.findIndex((line) => isTargetAnchorLine(line));
    if (anchorIndex < 0) {
      return { foundAnchor: false, description: "" };
    }
    const hasTargetReference = (line) => {
      const compactLine = normalizeForMatch(line);
      return (compactTarget && compactLine.includes(compactTarget)) || (compactSlug && compactLine.includes(compactSlug));
    };
    const isLinkedInUrlLikeLine = (line) =>
      /^https?:\/\//i.test(line) ||
      /\s›\s(in|company)\s›\s/i.test(line) ||
      /linkedin\.[a-z]{2,}\/(in|company)\//i.test(line);
    let poolEnd = Math.min(lines.length, anchorIndex + 12);
    for (let index = anchorIndex + 1; index < Math.min(lines.length, anchorIndex + 14); index += 1) {
      const line = lines[index];
      if (!isLinkedInUrlLikeLine(line)) {
        continue;
      }
      if (hasTargetReference(line)) {
        continue;
      }
      poolEnd = index;
      break;
    }
    const pool = lines.slice(anchorIndex + 1, poolEnd);
    const slugMatched = pool.find(
      (line) => isValidCandidateLine(line) && compactSlug && normalizeForMatch(line).includes(compactSlug)
    );
    if (slugMatched) {
      return { foundAnchor: true, description: slugMatched };
    }
    return {
      foundAnchor: true,
      description: findCandidateLine(pool),
    };
  };

  const aboutIndex = lines.findIndex((line) => /^(about|overview)$/i.test(line));
  if (aboutIndex >= 0) {
    const aboutLine = findCandidateLine(lines.slice(aboutIndex + 1));
    if (aboutLine) {
      return aboutLine;
    }
  }

  if (target) {
    const targetIndex = lines.findIndex((line) => line.toLowerCase().includes(target.toLowerCase()));
    if (targetIndex >= 0) {
      const nearby = findCandidateLine(lines.slice(targetIndex + 1, targetIndex + 6));
      if (nearby) {
        return nearby;
      }
    }
  }

  const targetAnchored = findTargetAnchoredCandidate();
  if (targetAnchored.foundAnchor) {
    return targetAnchored.description;
  }

  if (compactSlug) {
    const compactSlugLine = lines.find(
      (line) => isValidCandidateLine(line) && normalizeForMatch(line).includes(compactSlug)
    );
    if (compactSlugLine) {
      return compactSlugLine;
    }
  }

  if (slugTokens.length > 0) {
    const tokenLine = lines.find(
      (line) =>
        slugTokens.some((token) => line.toLowerCase().includes(token)) &&
        isValidCandidateLine(line)
    );
    if (tokenLine) {
      return tokenLine;
    }
  }

  const scoredLine = lines.find((line) => /\b(is|helps|provides|builds|offers|specializes)\b/i.test(line));
  if (
    scoredLine &&
    /[A-Za-z]/.test(scoredLine) &&
    !isDividerLine(scoredLine) &&
    !bannedPatterns.some((pattern) => pattern.test(scoredLine))
  ) {
    return scoredLine;
  }

  return findCandidateLine(lines);
}

class CampaignStorage {
  constructor({
    requestTimeoutMs = 20000,
    proxyList = [],
    linkedInFetchMode = "jina",
    chromeExecutablePath = "",
    chromeUserDataDir = "",
    chromeProfileDirectory = "Default",
    chromeProfileEnabled = false,
    chromeAutomationUserDataDir = "",
    chromeForceMirrorProfile = true,
    chromeHeadless = false,
    chromeHeadlessFallback = true,
    chromeCookiesEnabled = false,
    chromeTimeoutMs = 30000,
    playwrightEnabled = false,
    playwrightTimeoutMs = 30000,
    subpageFetchEnabled = true,
    subPageMaxCount = 2,
    searchSnippetEnabled = true,
    searchSnippetMaxLines = 3,
    rowConcurrency = 1,
    generationConcurrency = 1,
    profileSearchOnly = false,
    continueOnWebsiteFetchFailure = true,
    pipelineStageTimeoutMs = 120000,
  } = {}) {
    this.requestTimeoutMs = Number.isFinite(requestTimeoutMs) ? Math.max(1000, requestTimeoutMs) : 20000;
    this.proxyList = Array.isArray(proxyList)
      ? proxyList.map((item) => normalizeProxyUrl(item)).filter(Boolean)
      : [];
    this.proxyCursor = 0;
    this.proxyDispatchers = new Map();
    this.linkedInFetchMode = compact(linkedInFetchMode).toLowerCase() || "jina";
    this.chromeExecutablePath = compact(chromeExecutablePath);
    this.chromeUserDataDir =
      compact(chromeUserDataDir) || path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
    this.chromeProfileDirectory = compact(chromeProfileDirectory) || "Default";
    this.chromeProfileEnabled = toBoolean(chromeProfileEnabled, false);
    this.chromeAutomationUserDataDir = compact(chromeAutomationUserDataDir);
    this.chromeForceMirrorProfile = toBoolean(chromeForceMirrorProfile, true);
    this.chromeHeadless = Boolean(chromeHeadless);
    this.chromeHeadlessFallback = toBoolean(chromeHeadlessFallback, true);
    this.chromeCookiesEnabled = toBoolean(chromeCookiesEnabled, false);
    this.chromeTimeoutMs = Number.isFinite(Number(chromeTimeoutMs)) ? Math.max(1000, Number(chromeTimeoutMs)) : 30000;
    this.playwrightEnabled = toBoolean(playwrightEnabled, false);
    this.playwrightTimeoutMs = Number.isFinite(Number(playwrightTimeoutMs))
      ? Math.max(1000, Number(playwrightTimeoutMs))
      : 30000;
    this.subpageFetchEnabled = toBoolean(subpageFetchEnabled, true);
    this.subPageMaxCount = toNonNegativeInt(subPageMaxCount, 2);
    this.searchSnippetEnabled = toBoolean(searchSnippetEnabled, true);
    this.searchSnippetMaxLines = Math.max(1, toNonNegativeInt(searchSnippetMaxLines, 3));
    this.rowConcurrency = Math.max(1, toNonNegativeInt(rowConcurrency, 1));
    this.generationConcurrency = Math.max(1, toNonNegativeInt(generationConcurrency, 1));
    this.profileSearchOnly = toBoolean(profileSearchOnly, false);
    this.continueOnWebsiteFetchFailure = toBoolean(continueOnWebsiteFetchFailure, true);
    this.pipelineStageTimeoutMs = Number.isFinite(Number(pipelineStageTimeoutMs))
      ? Math.max(5000, Number(pipelineStageTimeoutMs))
      : 120000;
    this.chromeBrowserPromise = null;
    this.chromePagePromise = null;
    this.activeRuns = new Map();
    this.runControls = new Map();
    this.campaignLockChains = new Map();
    this.campaignEventNotifier = null;
    this.pipelineHandlers = {
      buildMailerDoc: null,
      buildSendPreview: null,
      sendPreparedEmail: null,
      onRunStart: null,
      onRunComplete: null,
    };
  }

  ensureRunControl(campaignId) {
    const normalizedCampaignId = compact(campaignId);
    if (!normalizedCampaignId) {
      return null;
    }
    if (this.runControls.has(normalizedCampaignId)) {
      return this.runControls.get(normalizedCampaignId);
    }
    let stopResolve;
    const control = {
      campaignId: normalizedCampaignId,
      stopRequested: false,
      stopReason: "",
      abortControllers: new Set(),
      stopPromise: new Promise((resolve) => {
        stopResolve = resolve;
      }),
      resolveStop: (reason = "Campaign stop requested") => {
        if (control.stopRequested) {
          return;
        }
        control.stopRequested = true;
        control.stopReason = reason;
        for (const controller of control.abortControllers) {
          try {
            controller.abort(reason);
          } catch (_error) {
            // Ignore individual controller abort errors.
          }
        }
        control.abortControllers.clear();
        stopResolve(reason);
      },
    };
    this.runControls.set(normalizedCampaignId, control);
    return control;
  }

  getRunControl(campaignId) {
    const normalizedCampaignId = compact(campaignId);
    if (!normalizedCampaignId) {
      return null;
    }
    return this.runControls.get(normalizedCampaignId) || null;
  }

  clearRunControl(campaignId) {
    const normalizedCampaignId = compact(campaignId);
    if (!normalizedCampaignId) {
      return;
    }
    this.runControls.delete(normalizedCampaignId);
  }

  isRunStopRequested(campaignId) {
    const control = this.getRunControl(campaignId);
    return Boolean(control?.stopRequested);
  }

  requestRunStop(campaignId, reason = "Campaign stop requested") {
    const control = this.getRunControl(campaignId);
    if (!control) {
      return false;
    }
    control.resolveStop(String(reason || "Campaign stop requested"));
    return true;
  }

  registerRunAbortController(campaignId) {
    const control = this.ensureRunControl(campaignId);
    if (!control) {
      return null;
    }
    const controller = new AbortController();
    control.abortControllers.add(controller);
    if (control.stopRequested) {
      controller.abort(control.stopReason || "Campaign stop requested");
    }
    return controller;
  }

  releaseRunAbortController(campaignId, controller) {
    if (!controller) {
      return;
    }
    const control = this.getRunControl(campaignId);
    if (!control) {
      return;
    }
    control.abortControllers.delete(controller);
  }

  async withRunAbortSignal(campaignId, execute) {
    const controller = this.registerRunAbortController(campaignId);
    try {
      return await Promise.resolve(execute(controller?.signal));
    } finally {
      this.releaseRunAbortController(campaignId, controller);
    }
  }

  buildRunStopError(stage = "processing") {
    return new Error(`Campaign stop requested during ${stage}`);
  }

  isRunStopError(error) {
    const message = compact(error?.message).toLowerCase();
    return message.includes("campaign stop requested");
  }

  assertRunNotStopped(campaignId, stage = "processing") {
    if (this.isRunStopRequested(campaignId)) {
      throw this.buildRunStopError(stage);
    }
  }

  async waitWithRunStop(campaignId, waitMsValue, stage = "wait") {
    const normalizedWaitMs = Math.max(0, Number(waitMsValue) || 0);
    if (normalizedWaitMs < 1) {
      return;
    }
    const control = this.getRunControl(campaignId);
    if (!control) {
      await waitMs(normalizedWaitMs);
      return;
    }
    const stopToken = Symbol("campaign-stop");
    const raceResult = await Promise.race([waitMs(normalizedWaitMs), control.stopPromise.then(() => stopToken)]);
    if (raceResult === stopToken) {
      throw this.buildRunStopError(stage);
    }
  }

  async runPipelineStage({ campaignId, stageName, rowNumber, execute }) {
    const timeoutMs = this.pipelineStageTimeoutMs;
    const startedAt = Date.now();
    console.log(`[campaign-stage] row=${rowNumber} ${stageName} started timeoutMs=${timeoutMs}`);
    let timer;
    try {
      const control = this.getRunControl(campaignId);
      const stopToken = Symbol("campaign-stop");
      const stopPromise = control ? control.stopPromise.then(() => stopToken) : null;
      const raceEntries = [
        Promise.resolve().then(() => execute()),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`${stageName} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ];
      if (stopPromise) {
        raceEntries.push(stopPromise);
      }
      const raceResult = await Promise.race(raceEntries);
      if (raceResult === stopToken) {
        throw this.buildRunStopError(stageName);
      }
      return raceResult;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      console.log(`[campaign-stage] row=${rowNumber} ${stageName} finished elapsedMs=${Date.now() - startedAt}`);
    }
  }

  getNextProxy() {
    if (this.proxyList.length === 0) {
      return "";
    }
    const proxy = this.proxyList[this.proxyCursor % this.proxyList.length];
    this.proxyCursor = (this.proxyCursor + 1) % this.proxyList.length;
    return proxy;
  }

  getProxyDispatcher(proxyUrl) {
    if (!proxyUrl) {
      return undefined;
    }
    if (this.proxyDispatchers.has(proxyUrl)) {
      return this.proxyDispatchers.get(proxyUrl);
    }

    let ProxyAgent;
    try {
      ({ ProxyAgent } = require("undici"));
    } catch (error) {
      throw new Error(
        `Proxy support requires undici. Install it with: npm install undici. Original error: ${error.message}`
      );
    }

    const dispatcher = new ProxyAgent(proxyUrl);
    this.proxyDispatchers.set(proxyUrl, dispatcher);
    return dispatcher;
  }

  async fetchWithProxy(url, options = {}) {
    const proxyUrl = this.getNextProxy();
    try {
      const dispatcher = this.getProxyDispatcher(proxyUrl);
      return await fetch(url, {
        ...options,
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (error) {
      if (proxyUrl) {
        throw new Error(`Proxy request failed via ${proxyUrl}: ${error.message}`);
      }
      throw error;
    }
  }

  isChromeProfileMode() {
    return this.linkedInFetchMode === "chrome_profile";
  }

  async readChromePageSnapshot(page) {
    const snapshot = await page.evaluate(() => ({
      text: document.body ? document.body.innerText : "",
      title: document.title || "",
    }));
    return {
      text: String(snapshot?.text || ""),
      title: String(snapshot?.title || ""),
      url: String(page.url() || ""),
    };
  }

  isHumanVerificationSnapshot({ text = "", title = "", url = "" } = {}) {
    const combined = `${text}\n${title}\n${url}`.toLowerCase();
    return [
      "verify you are human",
      "verify you're human",
      "quick verification",
      "human verification",
      "captcha",
      "i'm not a robot",
      "unusual traffic",
      "complete the security check",
      "prove you are human",
      "press and hold",
      "detected unusual activity",
      "recaptcha",
      "please solve the challenge below to continue",
      "solve the challenge below",
      "complete the challenge",
    ].some((needle) => combined.includes(needle));
  }

  async waitForHumanVerification(page, searchUrl) {
    const maxWaitMs = Math.max(this.requestTimeoutMs, 10 * 60 * 1000);
    const pollIntervalMs = 1500;
    const startedAt = Date.now();

    console.warn(
      `[LinkedIn] Human verification detected for ${searchUrl}. Complete verification in the opened Chrome window; polling until cleared.`
    );

    while (Date.now() - startedAt <= maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const snapshot = await this.readChromePageSnapshot(page);
      if (!this.isHumanVerificationSnapshot(snapshot) && snapshot.text.trim()) {
        console.log(`[LinkedIn] Human verification cleared for ${searchUrl}; resuming fetch.`);
        return snapshot.text;
      }
    }

    throw new Error(`Human verification did not clear within ${maxWaitMs}ms for ${searchUrl}`);
  }

  async getChromePage() {
    if (this.chromePagePromise) {
      return this.chromePagePromise;
    }

    this.chromePagePromise = (async () => {
      let puppeteer;
      try {
        puppeteer = require("puppeteer-core");
      } catch (error) {
        throw new Error(
          `Chrome profile mode requires puppeteer-core. Install it with: npm install puppeteer-core. Original error: ${error.message}`
        );
      }

      if (!this.chromeBrowserPromise) {
        const args = [
          `--profile-directory=${this.chromeProfileDirectory}`,
          "--no-first-run",
          "--no-default-browser-check",
        ];
        const launchOptions = {
          headless: this.chromeHeadless,
          userDataDir: this.chromeUserDataDir,
          timeout: this.requestTimeoutMs,
          pipe: true,
          args,
        };
        if (this.chromeExecutablePath) {
          launchOptions.executablePath = this.chromeExecutablePath;
        }

        this.chromeBrowserPromise = puppeteer.launch(launchOptions).catch((error) => {
          this.chromeBrowserPromise = null;
          throw new Error(
            `Unable to launch Chrome profile. Close running Chrome windows for this profile or set CHROME_PROFILE_DIRECTORY/CHROME_USER_DATA_DIR correctly. ${error.message}`
          );
        });
      }

      const browser = await this.chromeBrowserPromise;
      const pages = await browser.pages();
      const page = pages[0] || (await browser.newPage());
      page.setDefaultNavigationTimeout(this.requestTimeoutMs);
      page.setDefaultTimeout(this.requestTimeoutMs);
      return page;
    })().catch((error) => {
      this.chromePagePromise = null;
      throw error;
    });

    return this.chromePagePromise;
  }

  async fetchLinkedInSearchContent(searchUrl) {
    if (!this.isChromeProfileMode()) {
      return this.fetchJinaContent(buildJinaReaderUrl(searchUrl));
    }

    const page = await this.getChromePage();
    try {
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.requestTimeoutMs,
      });
      const snapshot = await this.readChromePageSnapshot(page);
      const text = this.isHumanVerificationSnapshot(snapshot)
        ? await this.waitForHumanVerification(page, searchUrl)
        : snapshot.text;
      if (!String(text || "").trim()) {
        throw new Error("Chrome returned an empty page body");
      }
      return text;
    } catch (error) {
      throw new Error(`Chrome profile fetch failed for ${searchUrl}: ${error.message}`);
    }
  }

  setPipelineHandlers({ buildMailerDoc, buildSendPreview, sendPreparedEmail, onRunStart, onRunComplete } = {}) {
    this.pipelineHandlers = {
      buildMailerDoc: typeof buildMailerDoc === "function" ? buildMailerDoc : null,
      buildSendPreview: typeof buildSendPreview === "function" ? buildSendPreview : null,
      sendPreparedEmail: typeof sendPreparedEmail === "function" ? sendPreparedEmail : null,
      onRunStart: typeof onRunStart === "function" ? onRunStart : null,
      onRunComplete: typeof onRunComplete === "function" ? onRunComplete : null,
    };
  }

  setCampaignEventNotifier(notifier) {
    this.campaignEventNotifier = typeof notifier === "function" ? notifier : null;
  }

  async emitCampaignEvent(campaignId, event) {
    if (!this.campaignEventNotifier) {
      return;
    }
    try {
      await Promise.resolve(this.campaignEventNotifier(campaignId, event));
    } catch (error) {
      console.warn(`[campaign-event] failed campaign=${campaignId}: ${error.message}`);
    }
  }

  normalizeCampaignMetadata(metadata) {
    if (!metadata || typeof metadata !== "object") {
      return null;
    }
    const next = { ...metadata };
    const legacyResults = Array.isArray(metadata.results) ? metadata.results : [];
    const rawRows = Array.isArray(metadata.rows)
      ? metadata.rows
      : legacyResults.map((item, index) => ({
            index,
            rowNumber: Number(item?.rowNumber) || index + 2,
            companyName: compact(item?.companyName),
            websiteUrl: compact(item?.websiteUrl),
            contactEmail: normalizeRecipientEmail(item?.contactEmail),
            status: item?.status === "failed" ? ROW_STATUS_FAILED : ROW_STATUS_READY,
            durationMs: Number(item?.durationMs) || 0,
            error: compact(item?.error || item?.jinaError),
            jinaContent: compact(item?.jinaContent),
            jinaError: compact(item?.jinaError),
            jinaFetchMethod: compact(item?.jinaFetchMethod || item?.sourceRow?.[JINA_FETCH_METHOD_COLUMN]) || "none",
            jinaSubPages: toNonNegativeInt(item?.jinaSubPages ?? item?.sourceRow?.[JINA_SUB_PAGES_COLUMN], 0),
            jinaFetchTrace: compact(item?.jinaFetchTrace || item?.sourceRow?.[JINA_FETCH_TRACE_COLUMN]),
            linkedInUrl: compact(item?.linkedInUrl),
            linkedInContent: compact(item?.linkedInContent),
            linkedInDescription: compact(item?.linkedInDescription),
            linkedInError: compact(item?.linkedInError),
            emailTo: compact(item?.emailTo || item?.sourceRow?.[EMAIL_TO_COLUMN]),
            emailSubject: compact(item?.emailSubject || item?.sourceRow?.[EMAIL_SUBJECT_COLUMN]),
            emailGeneratedBody: compact(item?.emailGeneratedBody || item?.sourceRow?.[EMAIL_GENERATED_BODY_COLUMN]),
            emailBody: compact(item?.emailBody || item?.sourceRow?.[EMAIL_BODY_COLUMN]),
            senderEmail: compact(item?.senderEmail || item?.sourceRow?.[EMAIL_SENDER_COLUMN]),
            senderDomain: compact(item?.senderDomain || item?.sourceRow?.[EMAIL_SENDER_DOMAIN_COLUMN]),
            mailerFields: item?.mailerFields && typeof item.mailerFields === "object" ? item.mailerFields : {},
            sourceRow: item && typeof item.sourceRow === "object" && !Array.isArray(item.sourceRow) ? item.sourceRow : {},
            emailStatus: compact(item?.emailStatus) || "pending",
            skipAutoPreview: toBoolean(item?.skipAutoPreview, false),
          }));

    next.rows = rawRows.map((item, index) => {
      const sourceRow = item && typeof item.sourceRow === "object" && !Array.isArray(item.sourceRow) ? item.sourceRow : {};
      const rowStatus = compact(item?.status).toLowerCase();
      const acceptedStatuses = new Set([
        ROW_STATUS_QUEUED,
        ROW_STATUS_FETCHING,
        ROW_STATUS_FETCHED,
        ROW_STATUS_GENERATING_MAIL,
        ROW_STATUS_GENERATING_PREVIEW,
        ROW_STATUS_AWAITING_VERIFICATION,
        ROW_STATUS_READY,
        ROW_STATUS_SENT,
        ROW_STATUS_PAUSED,
        ROW_STATUS_FAILED,
        ROW_STATUS_DONE, // legacy support
      ]);
      const normalizedEmailStatus = compact(item?.emailStatus || sourceRow[EMAIL_STATUS_COLUMN]) || "pending";
      const normalizedStatus =
        rowStatus === ROW_STATUS_DONE
          ? ROW_STATUS_READY
          : rowStatus === "success"
            ? ROW_STATUS_READY
            : acceptedStatuses.has(rowStatus)
              ? rowStatus
              : normalizedEmailStatus === "sent"
                ? ROW_STATUS_SENT
                : ROW_STATUS_QUEUED;
      return {
        index: Number.isFinite(Number(item?.index)) ? Number(item.index) : index,
        rowNumber: Number(item?.rowNumber) || index + 2,
        companyName: compact(item?.companyName),
        websiteUrl: compact(item?.websiteUrl),
        contactEmail: normalizeRecipientEmail(item?.contactEmail),
        status: normalizedStatus,
        durationMs: Number(item?.durationMs) || 0,
        startedAt: compact(item?.startedAt),
        completedAt: compact(item?.completedAt),
        error: compact(item?.error),
        jinaContent: compact(item?.jinaContent),
        jinaError: compact(item?.jinaError),
        jinaFetchMethod: compact(item?.jinaFetchMethod || sourceRow[JINA_FETCH_METHOD_COLUMN]) || "none",
        jinaSubPages: toNonNegativeInt(item?.jinaSubPages ?? sourceRow[JINA_SUB_PAGES_COLUMN], 0),
        jinaFetchTrace: compact(item?.jinaFetchTrace || sourceRow[JINA_FETCH_TRACE_COLUMN]),
        linkedInUrl: compact(item?.linkedInUrl),
        linkedInContent: compact(item?.linkedInContent),
        linkedInDescription: compact(item?.linkedInDescription),
        linkedInError: compact(item?.linkedInError),
        emailTo: compact(item?.emailTo || sourceRow[EMAIL_TO_COLUMN]),
        emailSubject: compact(item?.emailSubject || sourceRow[EMAIL_SUBJECT_COLUMN]),
        emailGeneratedBody: compact(item?.emailGeneratedBody || sourceRow[EMAIL_GENERATED_BODY_COLUMN]),
        emailBody: compact(item?.emailBody || sourceRow[EMAIL_BODY_COLUMN]),
        senderEmail: compact(item?.senderEmail || sourceRow[EMAIL_SENDER_COLUMN]),
        senderDomain: compact(item?.senderDomain || sourceRow[EMAIL_SENDER_DOMAIN_COLUMN]),
        mailerFields: item?.mailerFields && typeof item.mailerFields === "object" ? item.mailerFields : {},
        docFileName: compact(item?.docFileName),
        sourceRow,
        emailStatus: normalizedEmailStatus,
        skipAutoPreview: toBoolean(item?.skipAutoPreview, false),
      };
    });

    const succeeded = next.rows.filter((item) => item.status === ROW_STATUS_READY || item.status === ROW_STATUS_SENT).length;
    const failed = next.rows.filter((item) => item.status === ROW_STATUS_FAILED).length;
    next.succeeded = succeeded;
    next.failed = failed;
    next.processedRows = succeeded + failed;
    next.count = Number.isFinite(Number(next.count))
      ? Math.max(0, Math.min(Number.parseInt(next.count, 10), next.rows.length))
      : next.rows.length;
    if (next.rows.length > 0 && next.count < 1) {
      next.count = next.rows.length;
    }
    next.availableRows = next.rows.length;

    const resumeRow = this.findNextPendingRowNumber(next.rows);
    if (!compact(next.resumeFromRow) && resumeRow) {
      next.resumeFromRow = resumeRow;
    }

    next.status = compact(next.status).toLowerCase() || (next.processedRows >= next.rows.length ? CAMPAIGN_STATUS_COMPLETED : CAMPAIGN_STATUS_RUNNING);
    const usage = buildMergedUsageFromMetadata(next);
    next.bulkDomainUsage = usage.domainUsage;
    next.bulkSenderUsage = usage.senderUsage;
    next.results = next.rows.map((row) => this.toResultRow(row));
    return next;
  }

  toResultRow(row) {
    const sourceRow = row && typeof row.sourceRow === "object" && !Array.isArray(row.sourceRow) ? row.sourceRow : {};
    const status =
      row?.status === ROW_STATUS_FAILED
        ? "failed"
        : row?.status === ROW_STATUS_READY || row?.status === ROW_STATUS_SENT || row?.status === ROW_STATUS_DONE
          ? "success"
          : row?.status || ROW_STATUS_QUEUED;
    return {
      rowNumber: Number(row?.rowNumber) || 0,
      websiteUrl: compact(row?.websiteUrl),
      contactEmail: normalizeRecipientEmail(row?.contactEmail),
      emailStatus: compact(row?.emailStatus || sourceRow[EMAIL_STATUS_COLUMN]) || "pending",
      status,
      error: compact(row?.error),
      durationMs: Number(row?.durationMs) || 0,
      jinaContent: compact(row?.jinaContent),
      jinaError: compact(row?.jinaError),
      jinaFetchMethod: compact(row?.jinaFetchMethod || sourceRow[JINA_FETCH_METHOD_COLUMN]) || "none",
      jinaSubPages: toNonNegativeInt(row?.jinaSubPages ?? sourceRow[JINA_SUB_PAGES_COLUMN], 0),
      jinaFetchTrace: compact(row?.jinaFetchTrace || sourceRow[JINA_FETCH_TRACE_COLUMN]),
      linkedInUrl: compact(row?.linkedInUrl),
      linkedInContent: compact(row?.linkedInContent),
      linkedInDescription: compact(row?.linkedInDescription),
      linkedInError: compact(row?.linkedInError),
      emailTo: compact(row?.emailTo || sourceRow[EMAIL_TO_COLUMN]),
      emailSubject: compact(row?.emailSubject || sourceRow[EMAIL_SUBJECT_COLUMN]),
      emailGeneratedBody: compact(row?.emailGeneratedBody || sourceRow[EMAIL_GENERATED_BODY_COLUMN]),
      emailBody: compact(row?.emailBody || sourceRow[EMAIL_BODY_COLUMN]),
      senderEmail: compact(row?.senderEmail || sourceRow[EMAIL_SENDER_COLUMN]),
      senderDomain: compact(row?.senderDomain || sourceRow[EMAIL_SENDER_DOMAIN_COLUMN]),
      mailerFields: row?.mailerFields && typeof row.mailerFields === "object" ? row.mailerFields : {},
      docFileName: compact(row?.docFileName),
      sourceRow,
      skipAutoPreview: toBoolean(row?.skipAutoPreview, false),
    };
  }

  buildWorksheetRowFromCampaignRow(row = {}) {
    const sourceRow = safeObject(row?.sourceRow);
    return {
      ...sourceRow,
      [JINA_CONTENT_COLUMN]: firstNonEmpty(row?.jinaContent, sourceRow[JINA_CONTENT_COLUMN]),
      [JINA_ERROR_COLUMN]: firstNonEmpty(row?.jinaError, sourceRow[JINA_ERROR_COLUMN]),
      [JINA_FETCH_METHOD_COLUMN]: firstNonEmpty(row?.jinaFetchMethod, sourceRow[JINA_FETCH_METHOD_COLUMN]) || "none",
      [JINA_SUB_PAGES_COLUMN]: toNonNegativeInt(
        row?.jinaSubPages !== undefined ? row.jinaSubPages : sourceRow[JINA_SUB_PAGES_COLUMN],
        0
      ),
      [JINA_FETCH_TRACE_COLUMN]: firstNonEmpty(row?.jinaFetchTrace, sourceRow[JINA_FETCH_TRACE_COLUMN]),
      [LINKEDIN_CONTENT_COLUMN]: firstNonEmpty(row?.linkedInContent, sourceRow[LINKEDIN_CONTENT_COLUMN]),
      [LINKEDIN_DESCRIPTION_COLUMN]: firstNonEmpty(row?.linkedInDescription, sourceRow[LINKEDIN_DESCRIPTION_COLUMN]),
      [LINKEDIN_ERROR_COLUMN]: firstNonEmpty(row?.linkedInError, sourceRow[LINKEDIN_ERROR_COLUMN]),
      [EMAIL_TO_COLUMN]: firstNonEmpty(row?.emailTo, sourceRow[EMAIL_TO_COLUMN]),
      [EMAIL_SUBJECT_COLUMN]: firstNonEmpty(row?.emailSubject, sourceRow[EMAIL_SUBJECT_COLUMN]),
      [EMAIL_GENERATED_BODY_COLUMN]: firstNonEmpty(row?.emailGeneratedBody, sourceRow[EMAIL_GENERATED_BODY_COLUMN]),
      [EMAIL_BODY_COLUMN]: firstNonEmpty(row?.emailBody, sourceRow[EMAIL_BODY_COLUMN]),
      [EMAIL_PREVIEWED_AT_COLUMN]: firstNonEmpty(sourceRow[EMAIL_PREVIEWED_AT_COLUMN]),
      [EMAIL_SENT_AT_COLUMN]: firstNonEmpty(sourceRow[EMAIL_SENT_AT_COLUMN]),
      [EMAIL_MESSAGE_ID_COLUMN]: firstNonEmpty(sourceRow[EMAIL_MESSAGE_ID_COLUMN]),
      [EMAIL_ERROR_COLUMN]: firstNonEmpty(sourceRow[EMAIL_ERROR_COLUMN]),
      [EMAIL_SENDER_COLUMN]: firstNonEmpty(row?.senderEmail, sourceRow[EMAIL_SENDER_COLUMN]),
      [EMAIL_SENDER_DOMAIN_COLUMN]: firstNonEmpty(row?.senderDomain, sourceRow[EMAIL_SENDER_DOMAIN_COLUMN]),
      [EMAIL_STATUS_COLUMN]: firstNonEmpty(row?.emailStatus, sourceRow[EMAIL_STATUS_COLUMN]) || "pending",
    };
  }

  getCampaignMetadataPath(campaignId) {
    return path.join(STORAGE_ROOT, campaignId, "metadata.json");
  }

  findNextPendingRowNumber(rows = [], fromIndex = 0) {
    for (let index = Math.max(0, fromIndex); index < rows.length; index += 1) {
      const row = rows[index];
      if (!row) {
        continue;
      }
      if (row.status !== ROW_STATUS_READY && row.status !== ROW_STATUS_SENT && row.status !== ROW_STATUS_FAILED) {
        return row.rowNumber;
      }
    }
    return null;
  }

  findRowIndex(metadata, rowNumber) {
    const normalized = Number.parseInt(rowNumber, 10);
    const rows = Array.isArray(metadata?.rows) ? metadata.rows : [];
    return rows.findIndex((item) => Number(item?.rowNumber) === normalized);
  }

  async withCampaignLock(campaignId, execute) {
    const key = compact(campaignId);
    if (!key) {
      return execute();
    }
    const previous = this.campaignLockChains.get(key) || Promise.resolve();
    let releaseCurrent;
    const current = new Promise((resolve) => {
      releaseCurrent = resolve;
    });
    const chain = previous.then(() => current);
    this.campaignLockChains.set(key, chain);
    await previous;
    try {
      return await execute();
    } finally {
      releaseCurrent();
      if (this.campaignLockChains.get(key) === chain) {
        this.campaignLockChains.delete(key);
      }
    }
  }

  async patchCampaignRow(campaignId, rowNumber, mutate) {
    return this.withCampaignLock(campaignId, async () => {
      const metadata = await this.getCampaignMetadata(campaignId);
      if (!metadata) {
        return null;
      }
      const rowIndex = this.findRowIndex(metadata, rowNumber);
      if (rowIndex < 0) {
        return metadata;
      }
      const row = metadata.rows[rowIndex];
      await Promise.resolve(mutate(row, metadata, rowIndex));
      return this.writeCampaignMetadata(campaignId, metadata);
    });
  }

  async claimNextConcurrentRow(campaignId, targetRows) {
    return this.withCampaignLock(campaignId, async () => {
      const metadata = await this.getCampaignMetadata(campaignId);
      if (!metadata) {
        return null;
      }
      if (
        metadata.status === CAMPAIGN_STATUS_PAUSED ||
        metadata.status === CAMPAIGN_STATUS_STOPPED ||
        metadata.status === CAMPAIGN_STATUS_FAILED ||
        metadata.status === CAMPAIGN_STATUS_COMPLETED
      ) {
        return null;
      }

      const rows = Array.isArray(metadata.rows) ? metadata.rows : [];
      const limit = Math.min(Math.max(0, Number.parseInt(targetRows, 10) || rows.length), rows.length);
      const busyStatuses = new Set([
        ROW_STATUS_FETCHING,
        ROW_STATUS_GENERATING_MAIL,
        ROW_STATUS_GENERATING_PREVIEW,
        ROW_STATUS_AWAITING_VERIFICATION,
      ]);
      const rowIndex = rows.findIndex((item, index) => {
        if (index >= limit || !item) {
          return false;
        }
        const status = compact(item.status).toLowerCase();
        if (
          status === ROW_STATUS_READY ||
          status === ROW_STATUS_SENT ||
          status === ROW_STATUS_FAILED ||
          busyStatuses.has(status)
        ) {
          return false;
        }
        return true;
      });

      if (rowIndex < 0) {
        return null;
      }

      const row = rows[rowIndex];
      row.status = ROW_STATUS_FETCHING;
      row.startedAt = new Date().toISOString();
      row.error = "";
      metadata.resumeFromRow = row.rowNumber;
      metadata.pausedAtRow = null;
      const persisted = await this.writeCampaignMetadata(campaignId, metadata);
      const persistedRow = persisted.rows[rowIndex];

      return {
        rowNumber: persistedRow.rowNumber,
      };
    });
  }

  async claimNextFetchRow(campaignId, targetRows) {
    return this.withCampaignLock(campaignId, async () => {
      const metadata = await this.getCampaignMetadata(campaignId);
      if (!metadata || metadata.status !== CAMPAIGN_STATUS_RUNNING) {
        return null;
      }

      const rows = Array.isArray(metadata.rows) ? metadata.rows : [];
      const limit = Math.min(Math.max(0, Number.parseInt(targetRows, 10) || rows.length), rows.length);
      const rowIndex = rows.findIndex((item, index) => {
        if (index >= limit || !item) {
          return false;
        }
        return compact(item.status).toLowerCase() === ROW_STATUS_QUEUED;
      });
      if (rowIndex < 0) {
        return null;
      }

      const row = rows[rowIndex];
      row.status = ROW_STATUS_FETCHING;
      row.startedAt = row.startedAt || new Date().toISOString();
      row.error = "";
      metadata.resumeFromRow = row.rowNumber;
      metadata.pausedAtRow = null;
      const persisted = await this.writeCampaignMetadata(campaignId, metadata);
      const persistedRow = persisted.rows[rowIndex];
      return {
        rowNumber: persistedRow.rowNumber,
      };
    });
  }

  async claimNextGenerationRow(campaignId, targetRows) {
    return this.withCampaignLock(campaignId, async () => {
      const metadata = await this.getCampaignMetadata(campaignId);
      if (!metadata || metadata.status !== CAMPAIGN_STATUS_RUNNING) {
        return null;
      }

      const rows = Array.isArray(metadata.rows) ? metadata.rows : [];
      const limit = Math.min(Math.max(0, Number.parseInt(targetRows, 10) || rows.length), rows.length);
      const rowIndex = rows.findIndex((item, index) => {
        if (index >= limit || !item) {
          return false;
        }
        return compact(item.status).toLowerCase() === ROW_STATUS_FETCHED;
      });
      if (rowIndex < 0) {
        return null;
      }

      const row = rows[rowIndex];
      row.status = ROW_STATUS_GENERATING_MAIL;
      row.startedAt = row.startedAt || new Date().toISOString();
      metadata.resumeFromRow = row.rowNumber;
      metadata.pausedAtRow = null;
      const persisted = await this.writeCampaignMetadata(campaignId, metadata);
      const persistedRow = persisted.rows[rowIndex];
      return {
        rowNumber: persistedRow.rowNumber,
      };
    });
  }

  async writeCampaignMetadata(campaignId, metadata) {
    const normalizedCampaignId = compact(campaignId);
    if (!normalizedCampaignId) {
      throw new Error("campaignId is required");
    }
    const normalized = this.normalizeCampaignMetadata(metadata);
    const metadataPath = this.getCampaignMetadataPath(normalizedCampaignId);
    const serialized = JSON.stringify(normalized, null, 2);
    const backupPath = `${metadataPath}.bak`;
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });

    let lastError = null;
    for (let attempt = 1; attempt <= METADATA_WRITE_MAX_ATTEMPTS; attempt += 1) {
      const tempPath = `${metadataPath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      let renamed = false;
      try {
        await fs.writeFile(tempPath, serialized, "utf8");
        await fs.rename(tempPath, metadataPath);
        renamed = true;
      } catch (error) {
        lastError = error;
        const isTransient = isTransientMetadataWriteError(error);
        const isLastAttempt = attempt >= METADATA_WRITE_MAX_ATTEMPTS;
        if (!isTransient || isLastAttempt) {
          if (isTransient) {
            await fs.writeFile(metadataPath, serialized, "utf8");
            renamed = true;
          } else {
            throw error;
          }
        } else {
          await waitMs(METADATA_WRITE_RETRY_DELAY_MS * attempt);
        }
      } finally {
        await fs.rm(tempPath, { force: true }).catch(() => {});
      }

      if (!renamed) {
        continue;
      }

      await fs.writeFile(backupPath, serialized, "utf8").catch(() => {});
      return normalized;
    }

    throw lastError || new Error(`Unable to write campaign metadata for ${normalizedCampaignId}`);
  }

  async getCampaignMetadata(campaignId) {
    const normalizedCampaignId = compact(campaignId);
    if (!normalizedCampaignId) {
      throw new Error("campaignId is required");
    }

    const metadataPath = this.getCampaignMetadataPath(normalizedCampaignId);
    const backupPath = `${metadataPath}.bak`;
    let lastError = null;
    let lastRaw = "";
    for (let attempt = 1; attempt <= METADATA_READ_MAX_ATTEMPTS; attempt += 1) {
      try {
        const metadataRaw = await fs.readFile(metadataPath, "utf8");
        lastRaw = String(metadataRaw || "");
        const trimmed = String(metadataRaw || "").trim();
        if (!trimmed) {
          throw new SyntaxError("Campaign metadata file is empty");
        }
        const parsed = JSON.parse(trimmed);
        return this.normalizeCampaignMetadata(parsed);
      } catch (error) {
        if (error.code === "ENOENT") {
          lastError = error;
          if (attempt < METADATA_READ_MAX_ATTEMPTS) {
            await waitMs(METADATA_READ_RETRY_DELAY_MS);
            continue;
          }
          break;
        }
        const isJsonError =
          error instanceof SyntaxError || /unexpected end of json input|unexpected token/i.test(String(error?.message || ""));
        if (!isJsonError) {
          throw error;
        }
        lastError = error;
        if (attempt < METADATA_READ_MAX_ATTEMPTS) {
          await waitMs(METADATA_READ_RETRY_DELAY_MS);
          continue;
        }
      }
    }

    const repaired = tryParseRepairedMetadata(lastRaw);
    if (repaired) {
      const normalized = this.normalizeCampaignMetadata(repaired);
      await this.writeCampaignMetadata(normalizedCampaignId, normalized).catch(() => {});
      return normalized;
    }

    try {
      const backupRaw = await fs.readFile(backupPath, "utf8");
      const backupTrimmed = String(backupRaw || "").trim();
      if (!backupTrimmed) {
        throw new SyntaxError("Campaign metadata backup file is empty");
      }
      const parsedBackup = JSON.parse(backupTrimmed);
      return this.normalizeCampaignMetadata(parsedBackup);
    } catch (backupError) {
      if (lastError?.code === "ENOENT" && backupError?.code === "ENOENT") {
        return null;
      }
      if (lastError) {
        throw lastError;
      }
      throw backupError;
    }
  }

  async listRecentCampaignMetadata(limit = 5) {
    let entries = [];
    try {
      entries = await fs.readdir(STORAGE_ROOT, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const campaigns = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const metadata = await this.getCampaignMetadata(entry.name);
        if (metadata) {
          campaigns.push(metadata);
        }
      } catch (_error) {
        // Ignore invalid campaign folders.
      }
    }

    campaigns.sort((a, b) => {
      const aTs = Date.parse(a?.savedAt || "") || 0;
      const bTs = Date.parse(b?.savedAt || "") || 0;
      return bTs - aTs;
    });

    const normalizedLimit = Number.isFinite(Number(limit))
      ? Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 5))
      : 5;
    return campaigns.slice(0, normalizedLimit);
  }

  async getLatestCampaignMetadata() {
    const campaigns = await this.listRecentCampaignMetadata(1);
    return campaigns[0] || null;
  }

  async getCampaignPreview(campaignId, limit = 25) {
    const metadata = await this.getCampaignMetadata(campaignId);
    if (!metadata) {
      return null;
    }

    const normalizedLimit = Number.isFinite(Number(limit))
      ? Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 25))
      : 25;
    const targetDir = path.join(STORAGE_ROOT, metadata.id);
    const enrichedPath = path.join(targetDir, metadata.enrichedFileName);
    const workbookBuffer = await fs.readFile(enrichedPath);
    const workbook = XLSX.read(workbookBuffer, { type: "buffer" });
    const worksheetName = compact(metadata.worksheetName) || workbook.SheetNames[0];
    if (!worksheetName || !workbook.Sheets[worksheetName]) {
      throw new Error("Unable to locate campaign worksheet in enriched file");
    }

    const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[worksheetName], { defval: "", raw: false });
    const rows = rawRows.slice(0, normalizedLimit).map((row, index) => ({
      __rowNumber: index + 2,
      ...row,
    }));

    const columns = [];
    const seen = new Set();
    for (const row of rows) {
      for (const key of Object.keys(row || {})) {
        if (!seen.has(key)) {
          seen.add(key);
          columns.push(key);
        }
      }
    }
    if (!seen.has("__rowNumber")) {
      columns.unshift("__rowNumber");
    }

    return {
      campaignId: metadata.id,
      worksheetName,
      enrichedFileName: metadata.enrichedFileName,
      totalRows: rawRows.length,
      limit: normalizedLimit,
      columns,
      rows,
    };
  }

  async resolveRowGenerationContext({
    campaignId,
    rowNumber,
    websiteUrl = "",
    jinaContent = "",
    sourceRow = {},
    contactEmail = "",
  } = {}) {
    const metadata = await this.getCampaignMetadata(campaignId);
    if (!metadata) {
      throw new Error("Campaign not found");
    }

    const rowIndex = this.findRowIndex(metadata, rowNumber);
    if (rowIndex < 0) {
      throw new Error("Row not found");
    }

    const row = metadata.rows[rowIndex];
    const persistedSourceRow = safeObject(row?.sourceRow);
    const providedSourceRow = safeObject(sourceRow);
    const resolvedSourceRow = {
      ...providedSourceRow,
      ...persistedSourceRow,
    };

    const resolvedWebsiteUrl = firstNonEmpty(
      row?.websiteUrl,
      persistedSourceRow[metadata.websiteColumn],
      websiteUrl,
      providedSourceRow[metadata.websiteColumn]
    );
    if (!resolvedWebsiteUrl) {
      throw new Error(`Row ${row?.rowNumber || rowNumber} is missing website URL in campaign metadata`);
    }

    const resolvedJinaContent = firstNonEmpty(
      row?.jinaContent,
      persistedSourceRow[JINA_CONTENT_COLUMN],
      jinaContent,
      providedSourceRow[JINA_CONTENT_COLUMN]
    );

    const resolvedContactEmail = normalizeRecipientEmail(
      firstNonEmpty(
        row?.contactEmail,
        row?.emailTo,
        persistedSourceRow[EMAIL_TO_COLUMN],
        persistedSourceRow[metadata.emailColumn],
        contactEmail,
        providedSourceRow[metadata.emailColumn]
      )
    );

    return {
      campaignId: metadata.id,
      rowNumber: Number(row?.rowNumber) || Number.parseInt(rowNumber, 10),
      websiteUrl: resolvedWebsiteUrl,
      jinaContent: resolvedJinaContent,
      sourceRow: resolvedSourceRow,
      contactEmail: resolvedContactEmail,
      row,
    };
  }

  async ensureRunProcessor(campaignId) {
    const normalizedCampaignId = compact(campaignId);
    if (!normalizedCampaignId) {
      throw new Error("campaignId is required");
    }

    if (this.activeRuns.has(normalizedCampaignId)) {
      return this.activeRuns.get(normalizedCampaignId);
    }

    const onRunStart = this.pipelineHandlers.onRunStart;
    const onRunComplete = this.pipelineHandlers.onRunComplete;
    this.ensureRunControl(normalizedCampaignId);
    const runPromise = (async () => {
      if (onRunStart) {
        try {
          await Promise.resolve(onRunStart({ campaignId: normalizedCampaignId }));
        } catch (error) {
          console.warn(`[campaign-run] onRunStart failed campaign=${normalizedCampaignId}: ${error.message}`);
        }
      }
      return this.processCampaignRows(normalizedCampaignId);
    })()
      .catch(async (error) => {
        if (this.isRunStopError(error)) {
          return;
        }
        try {
          await this.withCampaignLock(normalizedCampaignId, async () => {
            const metadata = await this.getCampaignMetadata(normalizedCampaignId);
            if (!metadata) {
              return;
            }
            metadata.status = CAMPAIGN_STATUS_FAILED;
            metadata.error = error.message || "Campaign processing failed";
            await this.writeCampaignMetadata(normalizedCampaignId, metadata);
          });
        } catch (_persistError) {
          // Preserve original failure.
        }
      })
      .finally(async () => {
        this.activeRuns.delete(normalizedCampaignId);
        this.clearRunControl(normalizedCampaignId);
        if (onRunComplete) {
          try {
            const metadata = await this.getCampaignMetadata(normalizedCampaignId);
            await Promise.resolve(
              onRunComplete({
                campaignId: normalizedCampaignId,
                status: compact(metadata?.status).toLowerCase(),
                metadata,
              })
            );
          } catch (error) {
            console.warn(`[campaign-run] onRunComplete failed campaign=${normalizedCampaignId}: ${error.message}`);
          }
        }
      });

    this.activeRuns.set(normalizedCampaignId, runPromise);
    return runPromise;
  }

  async processCampaignRows(campaignId) {
    let metadata = await this.getCampaignMetadata(campaignId);
    if (!metadata) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    if (
      metadata.status === CAMPAIGN_STATUS_COMPLETED ||
      metadata.status === CAMPAIGN_STATUS_STOPPED ||
      metadata.status === CAMPAIGN_STATUS_FAILED
    ) {
      return metadata;
    }

    if (metadata.status !== CAMPAIGN_STATUS_RUNNING) {
      metadata.status = CAMPAIGN_STATUS_RUNNING;
      metadata.pausedAtRow = null;
      metadata.startedAt = metadata.startedAt || new Date().toISOString();
      await this.writeCampaignMetadata(campaignId, metadata);
    }

    const targetRows = Math.min(
      Number.isFinite(Number(metadata.count)) ? Number.parseInt(metadata.count, 10) : metadata.rows.length,
      metadata.rows.length
    );

    if (this.rowConcurrency > 1) {
      return this.processCampaignRowsConcurrent(campaignId, targetRows);
    }

    for (let index = 0; index < targetRows; index += 1) {
      this.assertRunNotStopped(campaignId, "row-loop");
      metadata = await this.getCampaignMetadata(campaignId);
      if (!metadata) {
        break;
      }
      if (metadata.status === CAMPAIGN_STATUS_PAUSED || metadata.status === CAMPAIGN_STATUS_STOPPED) {
        metadata.resumeFromRow = this.findNextPendingRowNumber(metadata.rows, index);
        await this.writeCampaignMetadata(campaignId, metadata);
        return metadata;
      }
      if (metadata.status === CAMPAIGN_STATUS_FAILED) {
        return metadata;
      }

      const row = metadata.rows[index];
      if (!row || row.status === ROW_STATUS_READY || row.status === ROW_STATUS_SENT || row.status === ROW_STATUS_FAILED) {
        continue;
      }

      row.status = ROW_STATUS_FETCHING;
      row.startedAt = new Date().toISOString();
      row.error = "";
      metadata.resumeFromRow = row.rowNumber;
      await this.writeCampaignMetadata(campaignId, metadata);

      const rowStartedAt = Date.now();
      let failureStage = "websiteFetch";
      try {
        this.assertRunNotStopped(campaignId, "websiteFetch");
        // Align default campaign fetch with refetch behavior: Google search -> result open -> hard refresh flow.
        const profileSearchOnly = this.profileSearchOnly;
        const websiteUrl = normalizeWebsiteUrl(firstNonEmpty(row.websiteUrl, row.sourceRow?.[metadata.websiteColumn]));
        const companyNameForFetch = resolveCompanyNameForFetch(row, row.sourceRow || {});
        const notifyUI = async (event) => {
          if (!event || typeof event !== "object") {
            return;
          }
          const eventType = compact(event.type).toLowerCase();
          const eventRowNumber = Number.parseInt(event.rowNumber || row.rowNumber, 10) || row.rowNumber;
          if (eventType === "verification_required" || eventType === "verification_cleared") {
            const current = await this.getCampaignMetadata(campaignId);
            const eventRowIndex = this.findRowIndex(current, eventRowNumber);
            if (current && eventRowIndex >= 0) {
              const targetRow = current.rows[eventRowIndex];
              targetRow.status =
                eventType === "verification_required" ? ROW_STATUS_AWAITING_VERIFICATION : ROW_STATUS_FETCHING;
              await this.writeCampaignMetadata(campaignId, current);
            }
          }
          await this.emitCampaignEvent(campaignId, {
            ...event,
            campaignId,
            rowNumber: eventRowNumber,
            rowIndex: eventRowNumber,
          });
        };
        const fetchAbortController = this.registerRunAbortController(campaignId);
        const websiteResult = await (async () => {
          try {
            return await enrichWebsiteContent(websiteUrl, {
              fetchImpl: this.fetchWithProxy.bind(this),
              requestTimeoutMs: this.requestTimeoutMs,
              playwrightEnabled: this.playwrightEnabled,
              playwrightTimeoutMs: this.playwrightTimeoutMs,
              chromeProfileEnabled: this.chromeProfileEnabled,
              chromeExecutablePath: this.chromeExecutablePath,
              chromeAutomationUserDataDir: this.chromeAutomationUserDataDir,
              chromeForceMirrorProfile: this.chromeForceMirrorProfile,
              chromeHeadless: this.chromeHeadless,
              chromeHeadlessFallback: this.chromeHeadlessFallback,
              subpageFetchEnabled: this.subpageFetchEnabled,
              subPageMaxCount: this.subPageMaxCount,
              chromeCookiesEnabled: this.chromeCookiesEnabled,
              chromeUserDataDir: this.chromeUserDataDir,
              chromeProfileName: this.chromeProfileDirectory,
              chromeTimeoutMs: this.chromeTimeoutMs,
              searchSnippetEnabled: this.searchSnippetEnabled,
              searchSnippetMaxLines: this.searchSnippetMaxLines,
              companyName: companyNameForFetch,
              profileSearchOnly,
              campaignId,
              rowNumber: row.rowNumber,
              rowIndex: row.rowNumber,
              notifyUI,
              abortSignal: fetchAbortController?.signal,
            });
          } finally {
            this.releaseRunAbortController(campaignId, fetchAbortController);
          }
        })();
        if (Array.isArray(websiteResult.fetchTrace) && websiteResult.fetchTrace.length > 0) {
          console.log(`[campaign-row-trace] row=${row.rowNumber} ${websiteResult.fetchTrace.join(" | ")}`);
        }
        let websiteFetchWarning = websiteResult.error ? truncateCellText(websiteResult.error) : "";
        let jinaContent = truncateCellText(websiteResult.content);
        let jinaFetchMethod = compact(websiteResult.fetchMethod) || "none";
        let jinaSubPages = toNonNegativeInt(websiteResult.subPagesFetched, 0);
        let jinaFetchTrace = truncateCellText(formatFetchTrace(websiteResult.fetchTrace));

        if (profileSearchOnly) {
          const rawContent = String(websiteResult?.content || "");
          console.log(
            `[profile-search-content] ${JSON.stringify({
              campaignId,
              rowNumber: row.rowNumber,
              fetchMethod: jinaFetchMethod,
              contentLength: rawContent.length,
              content: rawContent,
            })}`
          );
        }

        if (
          profileSearchOnly &&
          websiteResult?.profileSearchSnapshot &&
          typeof websiteResult.profileSearchSnapshot === "object"
        ) {
          const snapshot = websiteResult.profileSearchSnapshot;
          const entries = Array.isArray(snapshot.entries)
            ? snapshot.entries
            : [
                {
                  pageType: "homepage",
                  url: snapshot.homepageUrl || snapshot.destinationUrl || "",
                  title: snapshot.homepageTitle || snapshot.destinationTitle || "",
                  textLength: Number(snapshot.homepageTextLength) || 0,
                  rawTextLength: Number(snapshot.homepageRawTextLength) || 0,
                  text: String(snapshot.homepageText || ""),
                },
                ...(snapshot.aboutPageUrl || snapshot.aboutPageText
                  ? [
                      {
                        pageType: "about",
                        url: snapshot.aboutPageUrl || "",
                        title: snapshot.aboutPageTitle || "",
                        textLength: Number(snapshot.aboutPageTextLength) || 0,
                        rawTextLength: Number(snapshot.aboutPageRawTextLength) || 0,
                        text: String(snapshot.aboutPageText || ""),
                      },
                    ]
                  : []),
                ...(snapshot.servicesPageUrl || snapshot.servicesPageText
                  ? [
                      {
                        pageType: "services",
                        url: snapshot.servicesPageUrl || "",
                        title: snapshot.servicesPageTitle || "",
                        textLength: Number(snapshot.servicesPageTextLength) || 0,
                        rawTextLength: Number(snapshot.servicesPageRawTextLength) || 0,
                        text: String(snapshot.servicesPageText || ""),
                      },
                    ]
                  : []),
              ];
          console.log(
            `[profile-search-snapshot] ${JSON.stringify({
              campaignId,
              rowNumber: row.rowNumber,
              searchedUrl: snapshot.searchedUrl || websiteUrl,
              destinationUrl: snapshot.destinationUrl || "",
              destinationTitle: snapshot.destinationTitle || "",
              entries,
              textLength: Number(snapshot.textLength) || 0,
              rawTextLength: Number(snapshot.rawTextLength) || 0,
              text: String(snapshot.text || ""),
            })}`
          );
          const traceEntry = "[info] profile_search_snapshot: logged_to_console";
          jinaFetchTrace = truncateCellText([jinaFetchTrace, traceEntry].filter(Boolean).join("\n"));
        }

        if (!jinaContent && !websiteFetchWarning) {
          websiteFetchWarning = "Website content fetch returned empty response";
        }

        if (websiteFetchWarning) {
          if (!this.continueOnWebsiteFetchFailure) {
            const blockingError = new Error(websiteFetchWarning);
            blockingError.fetchTrace = websiteResult.fetchTrace;
            throw blockingError;
          }
          const kasadaProtected = isKasadaProtectionWarning(websiteFetchWarning);
          jinaContent = "";
          jinaFetchMethod = kasadaProtected ? "kasada_protected" : "fetch_blocked";
          jinaSubPages = 0;
          if (kasadaProtected && !/kasada protected/i.test(websiteFetchWarning)) {
            websiteFetchWarning = `Kasada protected website blocked automated fetch: ${websiteFetchWarning}`;
          }
          console.warn(
            `[campaign-row] row=${row.rowNumber} website=${websiteUrl} fetch warning (continuing with limited context): ${websiteFetchWarning}`
          );
        }

        await this.updateEnrichedRow({
          campaignId,
          rowNumber: row.rowNumber,
          updates: {
            [JINA_CONTENT_COLUMN]: jinaContent,
            [JINA_ERROR_COLUMN]: websiteFetchWarning,
            [JINA_FETCH_METHOD_COLUMN]: jinaFetchMethod,
            [JINA_SUB_PAGES_COLUMN]: jinaSubPages,
            [JINA_FETCH_TRACE_COLUMN]: jinaFetchTrace,
            [EMAIL_STATUS_COLUMN]: row.emailStatus || "pending",
          },
        });

        metadata = await this.getCampaignMetadata(campaignId);
        const nextRow = metadata?.rows?.[index];
        if (nextRow) {
          nextRow.websiteUrl = websiteUrl;
          nextRow.jinaContent = jinaContent;
          nextRow.jinaError = websiteFetchWarning;
          nextRow.jinaFetchMethod = jinaFetchMethod;
          nextRow.jinaSubPages = jinaSubPages;
          nextRow.jinaFetchTrace = jinaFetchTrace;
          nextRow.sourceRow = {
            ...(nextRow.sourceRow && typeof nextRow.sourceRow === "object" ? nextRow.sourceRow : {}),
            [JINA_CONTENT_COLUMN]: jinaContent,
            [JINA_ERROR_COLUMN]: websiteFetchWarning,
            [JINA_FETCH_METHOD_COLUMN]: jinaFetchMethod,
            [JINA_SUB_PAGES_COLUMN]: jinaSubPages,
            [JINA_FETCH_TRACE_COLUMN]: jinaFetchTrace,
          };
        }

        metadata = await this.getCampaignMetadata(campaignId);
        if (!metadata) {
          break;
        }
        if (!isCampaignRunningStatus(metadata.status)) {
          const haltedRow = metadata.rows?.[index];
          if (haltedRow) {
            haltedRow.status = ROW_STATUS_READY;
            haltedRow.durationMs = Date.now() - rowStartedAt;
            haltedRow.completedAt = new Date().toISOString();
            haltedRow.error = compact(haltedRow.jinaError);
            haltedRow.skipAutoPreview = false;
          }
          await this.writeCampaignMetadata(campaignId, metadata);
          return metadata;
        }

        const skipMailGenerationForProtectedWebsite =
          isProtectedFetchMethod(jinaFetchMethod) || isProtectedWebsiteWarning(websiteFetchWarning);
        if (skipMailGenerationForProtectedWebsite) {
          const protectedRow = metadata.rows?.[index];
          if (protectedRow) {
            protectedRow.status = ROW_STATUS_FAILED;
            protectedRow.durationMs = Date.now() - rowStartedAt;
            protectedRow.completedAt = new Date().toISOString();
            protectedRow.error = compact(protectedRow.jinaError) || "Protected website. Mail generation skipped.";
            protectedRow.skipAutoPreview = false;
            protectedRow.emailStatus = "pending";
            protectedRow.sourceRow = {
              ...(protectedRow.sourceRow && typeof protectedRow.sourceRow === "object" ? protectedRow.sourceRow : {}),
              [EMAIL_STATUS_COLUMN]: "pending",
            };
          }
          await this.writeCampaignMetadata(campaignId, metadata);
          continue;
        }

        if (this.pipelineHandlers.buildMailerDoc) {
          failureStage = "buildMailerDoc";
          const mailPrepRow = metadata?.rows?.[index];
          if (mailPrepRow) {
            mailPrepRow.status = ROW_STATUS_GENERATING_MAIL;
            await this.writeCampaignMetadata(campaignId, metadata);
          }

          const mailerResult = await this.runPipelineStage({
            campaignId,
            stageName: "buildMailerDoc",
            rowNumber: row.rowNumber,
            execute: () =>
              this.withRunAbortSignal(campaignId, (abortSignal) =>
                this.pipelineHandlers.buildMailerDoc({
                  campaignId,
                  rowNumber: row.rowNumber,
                  websiteUrl,
                  jinaContent,
                  sourceRow: mailPrepRow?.sourceRow || row.sourceRow || {},
                  abortSignal,
                })
              ),
          });

          metadata = await this.getCampaignMetadata(campaignId);
          const mailRow = metadata?.rows?.[index];
          if (mailRow) {
            mailRow.mailerFields =
              mailerResult?.mailerFields && typeof mailerResult.mailerFields === "object" ? mailerResult.mailerFields : {};
            mailRow.docFileName = compact(mailerResult?.docFileName);
            mailRow.sourceRow = {
              ...(mailRow.sourceRow && typeof mailRow.sourceRow === "object" ? mailRow.sourceRow : {}),
              ...(mailRow.mailerFields || {}),
            };
          }
        }

        if (this.pipelineHandlers.buildSendPreview) {
          failureStage = "buildSendPreview";
          metadata = await this.getCampaignMetadata(campaignId);
          if (!metadata) {
            break;
          }
          if (!isCampaignRunningStatus(metadata.status)) {
            const haltedRow = metadata.rows?.[index];
            if (haltedRow) {
              haltedRow.status = ROW_STATUS_READY;
              haltedRow.durationMs = Date.now() - rowStartedAt;
              haltedRow.completedAt = new Date().toISOString();
              haltedRow.error = compact(haltedRow.jinaError);
              haltedRow.skipAutoPreview = false;
            }
            await this.writeCampaignMetadata(campaignId, metadata);
            return metadata;
          }
          const previewRow = metadata?.rows?.[index];
          if (previewRow) {
            previewRow.status = ROW_STATUS_GENERATING_PREVIEW;
            await this.writeCampaignMetadata(campaignId, metadata);
          }

          const previewResult = await this.runPipelineStage({
            campaignId,
            stageName: "buildSendPreview",
            rowNumber: row.rowNumber,
            execute: () =>
              this.withRunAbortSignal(campaignId, (abortSignal) =>
                this.pipelineHandlers.buildSendPreview({
                  campaignId,
                  rowNumber: row.rowNumber,
                  websiteUrl,
                  jinaContent,
                  sourceRow: previewRow?.sourceRow || row.sourceRow || {},
                  contactEmail: previewRow?.contactEmail || row.contactEmail || "",
                  abortSignal,
                })
              ),
          });

          const previewTo = normalizeRecipientEmail(previewResult?.to || "");
          const previewSubject = compact(previewResult?.subject);
          const previewGeneratedBody = String(previewResult?.generatedBody || "").trim();
          const previewBody = String(previewResult?.body || "").trim();
          const previewedAt = new Date().toISOString();

          await this.updateEnrichedRow({
            campaignId,
            rowNumber: row.rowNumber,
            updates: {
              [EMAIL_TO_COLUMN]: previewTo,
              [EMAIL_SUBJECT_COLUMN]: previewSubject,
              [EMAIL_GENERATED_BODY_COLUMN]: previewGeneratedBody,
              [EMAIL_BODY_COLUMN]: previewBody,
              [EMAIL_PREVIEWED_AT_COLUMN]: previewedAt,
              [EMAIL_ERROR_COLUMN]: "",
              [EMAIL_STATUS_COLUMN]: "preview_ready",
            },
          });

          metadata = await this.getCampaignMetadata(campaignId);
          const doneRow = metadata?.rows?.[index];
          if (doneRow) {
            doneRow.emailTo = previewTo;
            doneRow.emailSubject = previewSubject;
            doneRow.emailGeneratedBody = previewGeneratedBody;
            doneRow.emailBody = previewBody;
            doneRow.emailStatus = "preview_ready";
            doneRow.sourceRow = {
              ...(doneRow.sourceRow && typeof doneRow.sourceRow === "object" ? doneRow.sourceRow : {}),
              [EMAIL_TO_COLUMN]: previewTo,
              [EMAIL_SUBJECT_COLUMN]: previewSubject,
              [EMAIL_GENERATED_BODY_COLUMN]: previewGeneratedBody,
              [EMAIL_BODY_COLUMN]: previewBody,
              [EMAIL_PREVIEWED_AT_COLUMN]: previewedAt,
              [EMAIL_ERROR_COLUMN]: "",
              [EMAIL_STATUS_COLUMN]: "preview_ready",
            };
          }

          if (this.pipelineHandlers.sendPreparedEmail) {
            failureStage = "sendPreparedEmail";
            const sent = await this.runPipelineStage({
              campaignId,
              stageName: "sendPreparedEmail",
              rowNumber: row.rowNumber,
              execute: () =>
                this.withRunAbortSignal(campaignId, (abortSignal) =>
                  this.pipelineHandlers.sendPreparedEmail({
                    campaignId,
                    rowNumber: row.rowNumber,
                    to: previewTo,
                    subject: previewSubject,
                    body: previewBody,
                    mailerFields: previewResult?.mailerFields || {},
                    abortSignal,
                  })
                ),
            });
            const sentAt = compact(sent?.sentAt) || new Date().toISOString();
            const messageId = compact(sent?.messageId);
            const mailerSendDelayMs = getMailerSendDelayMs();
            if (mailerSendDelayMs > 0) {
              await this.waitWithRunStop(campaignId, mailerSendDelayMs, "send-delay");
            }

            await this.updateEnrichedRow({
              campaignId,
              rowNumber: row.rowNumber,
              updates: {
                [EMAIL_TO_COLUMN]: previewTo,
                [EMAIL_SUBJECT_COLUMN]: previewSubject,
                [EMAIL_BODY_COLUMN]: previewBody,
                [EMAIL_SENT_AT_COLUMN]: sentAt,
                [EMAIL_MESSAGE_ID_COLUMN]: messageId,
                [EMAIL_ERROR_COLUMN]: "",
                [EMAIL_STATUS_COLUMN]: "sent",
              },
            });

            metadata = await this.getCampaignMetadata(campaignId);
            const sentRow = metadata?.rows?.[index];
            if (sentRow) {
              sentRow.emailTo = previewTo;
              sentRow.emailSubject = previewSubject;
              sentRow.emailBody = previewBody;
              sentRow.emailStatus = "sent";
              sentRow.sourceRow = {
                ...(sentRow.sourceRow && typeof sentRow.sourceRow === "object" ? sentRow.sourceRow : {}),
                [EMAIL_TO_COLUMN]: previewTo,
                [EMAIL_SUBJECT_COLUMN]: previewSubject,
                [EMAIL_BODY_COLUMN]: previewBody,
                [EMAIL_SENT_AT_COLUMN]: sentAt,
                [EMAIL_MESSAGE_ID_COLUMN]: messageId,
                [EMAIL_ERROR_COLUMN]: "",
                [EMAIL_STATUS_COLUMN]: "sent",
              };
            }
          }
        }

        metadata = await this.getCampaignMetadata(campaignId);
        const finalRow = metadata?.rows?.[index];
        failureStage = "finalize";
        if (finalRow) {
          finalRow.status = finalRow.emailStatus === "sent" ? ROW_STATUS_SENT : ROW_STATUS_READY;
          finalRow.durationMs = Date.now() - rowStartedAt;
          finalRow.completedAt = new Date().toISOString();
          finalRow.error = compact(finalRow.jinaError);
          finalRow.skipAutoPreview = false;
        }
      } catch (error) {
        if (this.isRunStopError(error)) {
          return this.getCampaignMetadata(campaignId);
        }
        const failureMessage = truncateCellText(error.message || "Unknown enrichment error");
        const failureTrace = truncateCellText(formatFetchTrace(error?.fetchTrace || error?.layerTrace));
        const fetchStageFailure = failureStage === "websiteFetch";
        console.error(
          `[campaign-row] row=${row.rowNumber} website=${row.websiteUrl || ""} stage=${failureStage} failed: ${failureMessage}`
        );
        if (fetchStageFailure) {
          await this.updateEnrichedRow({
            campaignId,
            rowNumber: row.rowNumber,
            updates: {
              [JINA_CONTENT_COLUMN]: "",
              [JINA_ERROR_COLUMN]: failureMessage,
              [JINA_FETCH_METHOD_COLUMN]: "none",
              [JINA_SUB_PAGES_COLUMN]: 0,
              [JINA_FETCH_TRACE_COLUMN]: failureTrace,
              [EMAIL_STATUS_COLUMN]: row.emailStatus || "pending",
            },
          });
        } else {
          await this.updateEnrichedRow({
            campaignId,
            rowNumber: row.rowNumber,
            updates: {
              [EMAIL_ERROR_COLUMN]: failureMessage,
              [EMAIL_STATUS_COLUMN]: row.emailStatus || "pending",
            },
          });
        }

        metadata = await this.getCampaignMetadata(campaignId);
        const nextRow = metadata?.rows?.[index];
        if (nextRow) {
          nextRow.status = ROW_STATUS_FAILED;
          nextRow.durationMs = Date.now() - rowStartedAt;
          nextRow.completedAt = new Date().toISOString();
          nextRow.error = failureMessage;
          nextRow.skipAutoPreview = false;
          if (fetchStageFailure) {
            nextRow.jinaContent = "";
            nextRow.jinaError = failureMessage;
            nextRow.jinaFetchMethod = "none";
            nextRow.jinaSubPages = 0;
            nextRow.jinaFetchTrace = failureTrace;
            nextRow.sourceRow = {
              ...(nextRow.sourceRow && typeof nextRow.sourceRow === "object" ? nextRow.sourceRow : {}),
              [JINA_CONTENT_COLUMN]: "",
              [JINA_ERROR_COLUMN]: failureMessage,
              [JINA_FETCH_METHOD_COLUMN]: "none",
              [JINA_SUB_PAGES_COLUMN]: 0,
              [JINA_FETCH_TRACE_COLUMN]: failureTrace,
            };
          } else {
            nextRow.emailStatus = compact(nextRow.emailStatus) || "pending";
            nextRow.sourceRow = {
              ...(nextRow.sourceRow && typeof nextRow.sourceRow === "object" ? nextRow.sourceRow : {}),
              [EMAIL_ERROR_COLUMN]: failureMessage,
              [EMAIL_STATUS_COLUMN]: nextRow.emailStatus,
            };
          }
        }
      }

      if (!metadata) {
        metadata = await this.getCampaignMetadata(campaignId);
      }
      if (!metadata) {
        break;
      }
      metadata.pausedAtRow = null;
      metadata.resumeFromRow = this.findNextPendingRowNumber(metadata.rows, index + 1);
      await this.writeCampaignMetadata(campaignId, metadata);
    }

    metadata = await this.getCampaignMetadata(campaignId);
    if (!metadata) {
      return null;
    }
    if (metadata.status === CAMPAIGN_STATUS_RUNNING) {
      metadata.status = CAMPAIGN_STATUS_COMPLETED;
      metadata.completedAt = new Date().toISOString();
      metadata.pausedAtRow = null;
      metadata.resumeFromRow = null;
      await this.writeCampaignMetadata(campaignId, metadata);
      return this.getCampaignMetadata(campaignId);
    }
    return metadata;
  }

  async processCampaignRowsConcurrent(campaignId, targetRows) {
    this.assertRunNotStopped(campaignId, "concurrent-run-start");
    const fetchWorkers = Math.max(1, Math.min(this.rowConcurrency, Math.max(1, targetRows)));
    const generationWorkers = Math.max(1, Math.min(this.generationConcurrency, Math.max(1, targetRows)));
    console.log(
      `[campaign-run] pipeline concurrency enabled campaign=${campaignId} fetchWorkers=${fetchWorkers} generationWorkers=${generationWorkers}`
    );
    let fetchCompleted = false;
    const fetchPromises = Array.from({ length: fetchWorkers }, (_value, index) =>
      this.runConcurrentCampaignFetchWorker(campaignId, targetRows, index + 1)
    );
    const generationPromises = Array.from({ length: generationWorkers }, (_value, index) =>
      this.runConcurrentCampaignGenerationWorker(campaignId, targetRows, index + 1, () => fetchCompleted)
    );
    await Promise.all(fetchPromises);
    this.assertRunNotStopped(campaignId, "concurrent-fetch-complete");
    fetchCompleted = true;
    await Promise.all(generationPromises);
    this.assertRunNotStopped(campaignId, "concurrent-generation-complete");

    return this.withCampaignLock(campaignId, async () => {
      const metadata = await this.getCampaignMetadata(campaignId);
      if (!metadata) {
        return null;
      }
      if (metadata.status === CAMPAIGN_STATUS_RUNNING) {
        const nextPending = this.findNextPendingRowNumber(metadata.rows);
        metadata.pausedAtRow = null;
        metadata.resumeFromRow = nextPending;
        if (!nextPending) {
          metadata.status = CAMPAIGN_STATUS_COMPLETED;
          metadata.completedAt = new Date().toISOString();
          metadata.resumeFromRow = null;
        }
        return this.writeCampaignMetadata(campaignId, metadata);
      }
      return metadata;
    });
  }

  async runConcurrentCampaignFetchWorker(campaignId, targetRows, workerId) {
    try {
      while (true) {
        this.assertRunNotStopped(campaignId, `fetch-worker-${workerId}`);
        const claim = await this.claimNextFetchRow(campaignId, targetRows);
        if (!claim?.rowNumber) {
          return;
        }
        await this.processSingleCampaignRowFetchConcurrent({
          campaignId,
          rowNumber: claim.rowNumber,
          workerId,
        });
      }
    } catch (error) {
      if (this.isRunStopError(error)) {
        return;
      }
      throw error;
    }
  }

  async runConcurrentCampaignGenerationWorker(campaignId, targetRows, workerId, isFetchCompleted) {
    try {
      while (true) {
        this.assertRunNotStopped(campaignId, `generation-worker-${workerId}`);
        const claim = await this.claimNextGenerationRow(campaignId, targetRows);
        if (claim?.rowNumber) {
          await this.processSingleCampaignRowGenerationConcurrent({
            campaignId,
            rowNumber: claim.rowNumber,
            workerId,
          });
          continue;
        }
        if (isFetchCompleted()) {
          return;
        }
        await this.waitWithRunStop(campaignId, 250, `generation-worker-${workerId}-wait`);
      }
    } catch (error) {
      if (this.isRunStopError(error)) {
        return;
      }
      throw error;
    }
  }

  async processSingleCampaignRowFetchConcurrent({ campaignId, rowNumber, workerId }) {
    let metadata = await this.getCampaignMetadata(campaignId);
    if (!metadata) {
      return;
    }
    const rowIndex = this.findRowIndex(metadata, rowNumber);
    if (rowIndex < 0) {
      return;
    }
    const row = metadata.rows[rowIndex];
    const rowStartedAt = Date.parse(String(row.startedAt || "")) || Date.now();
    try {
      this.assertRunNotStopped(campaignId, `fetch-row-${rowNumber}`);
      const profileSearchOnly = this.profileSearchOnly;
      const websiteUrl = normalizeWebsiteUrl(firstNonEmpty(row.websiteUrl, row.sourceRow?.[metadata.websiteColumn]));
      const companyNameForFetch = resolveCompanyNameForFetch(row, row.sourceRow || {});
      const workerAutomationUserDataDir = this.chromeAutomationUserDataDir
        ? path.join(this.chromeAutomationUserDataDir, `worker-${workerId}`)
        : this.chromeAutomationUserDataDir;
      const notifyUI = async (event) => {
        if (!event || typeof event !== "object") {
          return;
        }
        const eventType = compact(event.type).toLowerCase();
        const eventRowNumber = Number.parseInt(event.rowNumber || rowNumber, 10) || rowNumber;
        if (eventType === "verification_required" || eventType === "verification_cleared") {
          await this.patchCampaignRow(campaignId, eventRowNumber, (targetRow) => {
            if (!targetRow) {
              return;
            }
            targetRow.status =
              eventType === "verification_required" ? ROW_STATUS_AWAITING_VERIFICATION : ROW_STATUS_FETCHING;
          });
        }
        await this.emitCampaignEvent(campaignId, {
          ...event,
          campaignId,
          rowNumber: eventRowNumber,
          rowIndex: eventRowNumber,
        });
      };

      const fetchAbortController = this.registerRunAbortController(campaignId);
      const websiteResult = await (async () => {
        try {
          return await enrichWebsiteContent(websiteUrl, {
            fetchImpl: this.fetchWithProxy.bind(this),
            requestTimeoutMs: this.requestTimeoutMs,
            playwrightEnabled: this.playwrightEnabled,
            playwrightTimeoutMs: this.playwrightTimeoutMs,
            chromeProfileEnabled: this.chromeProfileEnabled,
            chromeExecutablePath: this.chromeExecutablePath,
            chromeAutomationUserDataDir: workerAutomationUserDataDir,
            chromeForceMirrorProfile: this.chromeForceMirrorProfile,
            chromeHeadless: this.chromeHeadless,
            chromeHeadlessFallback: this.chromeHeadlessFallback,
            subpageFetchEnabled: this.subpageFetchEnabled,
            subPageMaxCount: this.subPageMaxCount,
            chromeCookiesEnabled: this.chromeCookiesEnabled,
            chromeUserDataDir: this.chromeUserDataDir,
            chromeProfileName: this.chromeProfileDirectory,
            chromeTimeoutMs: this.chromeTimeoutMs,
            searchSnippetEnabled: this.searchSnippetEnabled,
            searchSnippetMaxLines: this.searchSnippetMaxLines,
            companyName: companyNameForFetch,
            profileSearchOnly,
            campaignId,
            rowNumber,
            rowIndex: rowNumber,
            notifyUI,
            abortSignal: fetchAbortController?.signal,
          });
        } finally {
          this.releaseRunAbortController(campaignId, fetchAbortController);
        }
      })();

      if (Array.isArray(websiteResult.fetchTrace) && websiteResult.fetchTrace.length > 0) {
        console.log(`[campaign-row-trace] row=${rowNumber} ${websiteResult.fetchTrace.join(" | ")}`);
      }

      let websiteFetchWarning = websiteResult.error ? truncateCellText(websiteResult.error) : "";
      let jinaContent = truncateCellText(websiteResult.content);
      let jinaFetchMethod = compact(websiteResult.fetchMethod) || "none";
      let jinaSubPages = toNonNegativeInt(websiteResult.subPagesFetched, 0);
      let jinaFetchTrace = truncateCellText(formatFetchTrace(websiteResult.fetchTrace));

      if (!jinaContent && !websiteFetchWarning) {
        websiteFetchWarning = "Website content fetch returned empty response";
      }

      if (websiteFetchWarning) {
        if (!this.continueOnWebsiteFetchFailure) {
          const blockingError = new Error(websiteFetchWarning);
          blockingError.fetchTrace = websiteResult.fetchTrace;
          throw blockingError;
        }
        const kasadaProtected = isKasadaProtectionWarning(websiteFetchWarning);
        jinaContent = "";
        jinaFetchMethod = kasadaProtected ? "kasada_protected" : "fetch_blocked";
        jinaSubPages = 0;
        if (kasadaProtected && !/kasada protected/i.test(websiteFetchWarning)) {
          websiteFetchWarning = `Kasada protected website blocked automated fetch: ${websiteFetchWarning}`;
        }
        console.warn(
          `[campaign-row] row=${rowNumber} website=${websiteUrl} fetch warning (continuing with limited context): ${websiteFetchWarning}`
        );
      }

      await this.updateEnrichedRow({
        campaignId,
        rowNumber,
        updates: {
          [JINA_CONTENT_COLUMN]: jinaContent,
          [JINA_ERROR_COLUMN]: websiteFetchWarning,
          [JINA_FETCH_METHOD_COLUMN]: jinaFetchMethod,
          [JINA_SUB_PAGES_COLUMN]: jinaSubPages,
          [JINA_FETCH_TRACE_COLUMN]: jinaFetchTrace,
          [EMAIL_STATUS_COLUMN]: row.emailStatus || "pending",
        },
      });

      await this.patchCampaignRow(campaignId, rowNumber, (nextRow, currentMetadata, currentRowIndex) => {
        if (!nextRow) {
          return;
        }
        const skipMailGenerationForProtectedWebsite =
          isProtectedFetchMethod(jinaFetchMethod) || isProtectedWebsiteWarning(websiteFetchWarning);
        nextRow.websiteUrl = websiteUrl;
        nextRow.jinaContent = jinaContent;
        nextRow.jinaError = websiteFetchWarning;
        nextRow.jinaFetchMethod = jinaFetchMethod;
        nextRow.jinaSubPages = jinaSubPages;
        nextRow.jinaFetchTrace = jinaFetchTrace;
        nextRow.sourceRow = {
          ...(nextRow.sourceRow && typeof nextRow.sourceRow === "object" ? nextRow.sourceRow : {}),
          [JINA_CONTENT_COLUMN]: jinaContent,
          [JINA_ERROR_COLUMN]: websiteFetchWarning,
          [JINA_FETCH_METHOD_COLUMN]: jinaFetchMethod,
          [JINA_SUB_PAGES_COLUMN]: jinaSubPages,
          [JINA_FETCH_TRACE_COLUMN]: jinaFetchTrace,
        };
        nextRow.status = skipMailGenerationForProtectedWebsite ? ROW_STATUS_FAILED : ROW_STATUS_FETCHED;
        nextRow.skipAutoPreview = false;
        if (skipMailGenerationForProtectedWebsite) {
          nextRow.durationMs = Date.now() - rowStartedAt;
          nextRow.completedAt = new Date().toISOString();
          nextRow.error = compact(nextRow.jinaError) || "Protected website. Mail generation skipped.";
          nextRow.emailStatus = "pending";
          nextRow.sourceRow = {
            ...(nextRow.sourceRow && typeof nextRow.sourceRow === "object" ? nextRow.sourceRow : {}),
            [EMAIL_STATUS_COLUMN]: "pending",
          };
        } else {
          nextRow.error = compact(nextRow.jinaError);
        }
        currentMetadata.pausedAtRow = null;
        currentMetadata.resumeFromRow = this.findNextPendingRowNumber(currentMetadata.rows, currentRowIndex + 1);
      });
    } catch (error) {
      if (this.isRunStopError(error)) {
        return;
      }
      const failureMessage = truncateCellText(error.message || "Unknown enrichment error");
      const failureTrace = truncateCellText(formatFetchTrace(error?.fetchTrace || error?.layerTrace));
      console.error(
        `[campaign-row] row=${rowNumber} website=${row.websiteUrl || ""} stage=websiteFetch failed: ${failureMessage}`
      );

      await this.updateEnrichedRow({
        campaignId,
        rowNumber,
        updates: {
          [JINA_CONTENT_COLUMN]: "",
          [JINA_ERROR_COLUMN]: failureMessage,
          [JINA_FETCH_METHOD_COLUMN]: "none",
          [JINA_SUB_PAGES_COLUMN]: 0,
          [JINA_FETCH_TRACE_COLUMN]: failureTrace,
          [EMAIL_STATUS_COLUMN]: row.emailStatus || "pending",
        },
      });

      await this.patchCampaignRow(campaignId, rowNumber, (nextRow, currentMetadata, currentRowIndex) => {
        if (!nextRow) {
          return;
        }
        nextRow.status = ROW_STATUS_FAILED;
        nextRow.durationMs = Date.now() - rowStartedAt;
        nextRow.completedAt = new Date().toISOString();
        nextRow.error = failureMessage;
        nextRow.skipAutoPreview = false;
        nextRow.jinaContent = "";
        nextRow.jinaError = failureMessage;
        nextRow.jinaFetchMethod = "none";
        nextRow.jinaSubPages = 0;
        nextRow.jinaFetchTrace = failureTrace;
        nextRow.sourceRow = {
          ...(nextRow.sourceRow && typeof nextRow.sourceRow === "object" ? nextRow.sourceRow : {}),
          [JINA_CONTENT_COLUMN]: "",
          [JINA_ERROR_COLUMN]: failureMessage,
          [JINA_FETCH_METHOD_COLUMN]: "none",
          [JINA_SUB_PAGES_COLUMN]: 0,
          [JINA_FETCH_TRACE_COLUMN]: failureTrace,
        };
        currentMetadata.pausedAtRow = null;
        currentMetadata.resumeFromRow = this.findNextPendingRowNumber(currentMetadata.rows, currentRowIndex + 1);
      });
    }
  }

  async processSingleCampaignRowGenerationConcurrent({ campaignId, rowNumber }) {
    let metadata = await this.getCampaignMetadata(campaignId);
    if (!metadata) {
      return;
    }
    const rowIndex = this.findRowIndex(metadata, rowNumber);
    if (rowIndex < 0) {
      return;
    }
    const row = metadata.rows[rowIndex];
    const generationStartedAt = Date.now();
    let failureStage = "buildMailerDoc";

    try {
      this.assertRunNotStopped(campaignId, `generation-row-${rowNumber}`);
      if (!isCampaignRunningStatus(metadata.status)) {
        return;
      }
      const websiteUrl = normalizeWebsiteUrl(firstNonEmpty(row.websiteUrl, row.sourceRow?.[metadata.websiteColumn]));
      const jinaContent = firstNonEmpty(row.jinaContent, row.sourceRow?.[JINA_CONTENT_COLUMN]);

      if (this.pipelineHandlers.buildMailerDoc) {
        const mailContext = await this.resolveRowGenerationContext({ campaignId, rowNumber });
        const mailerResult = await this.runPipelineStage({
          campaignId,
          stageName: "buildMailerDoc",
          rowNumber,
          execute: () =>
            this.withRunAbortSignal(campaignId, (abortSignal) =>
              this.pipelineHandlers.buildMailerDoc({
                campaignId,
                rowNumber,
                websiteUrl,
                jinaContent,
                sourceRow: mailContext.sourceRow || {},
                abortSignal,
              })
            ),
        });

        await this.patchCampaignRow(campaignId, rowNumber, (mailRow) => {
          if (!mailRow) {
            return;
          }
          mailRow.mailerFields =
            mailerResult?.mailerFields && typeof mailerResult.mailerFields === "object" ? mailerResult.mailerFields : {};
          mailRow.docFileName = compact(mailerResult?.docFileName);
          mailRow.sourceRow = {
            ...(mailRow.sourceRow && typeof mailRow.sourceRow === "object" ? mailRow.sourceRow : {}),
            ...(mailRow.mailerFields || {}),
          };
        });
      }

      if (this.pipelineHandlers.buildSendPreview) {
        failureStage = "buildSendPreview";
        await this.patchCampaignRow(campaignId, rowNumber, (previewRow) => {
          if (previewRow) {
            previewRow.status = ROW_STATUS_GENERATING_PREVIEW;
          }
        });

        const previewContext = await this.resolveRowGenerationContext({ campaignId, rowNumber });
        const previewResult = await this.runPipelineStage({
          campaignId,
          stageName: "buildSendPreview",
          rowNumber,
          execute: () =>
            this.withRunAbortSignal(campaignId, (abortSignal) =>
              this.pipelineHandlers.buildSendPreview({
                campaignId,
                rowNumber,
                websiteUrl,
                jinaContent,
                sourceRow: previewContext.sourceRow || {},
                contactEmail: previewContext.contactEmail || "",
                abortSignal,
              })
            ),
        });

        const previewTo = normalizeRecipientEmail(previewResult?.to || "");
        const previewSubject = compact(previewResult?.subject);
        const previewGeneratedBody = String(previewResult?.generatedBody || "").trim();
        const previewBody = String(previewResult?.body || "").trim();
        const previewedAt = new Date().toISOString();

        await this.updateEnrichedRow({
          campaignId,
          rowNumber,
          updates: {
            [EMAIL_TO_COLUMN]: previewTo,
            [EMAIL_SUBJECT_COLUMN]: previewSubject,
            [EMAIL_GENERATED_BODY_COLUMN]: previewGeneratedBody,
            [EMAIL_BODY_COLUMN]: previewBody,
            [EMAIL_PREVIEWED_AT_COLUMN]: previewedAt,
            [EMAIL_ERROR_COLUMN]: "",
            [EMAIL_STATUS_COLUMN]: "preview_ready",
          },
        });

        await this.patchCampaignRow(campaignId, rowNumber, (doneRow) => {
          if (!doneRow) {
            return;
          }
          doneRow.emailTo = previewTo;
          doneRow.emailSubject = previewSubject;
          doneRow.emailGeneratedBody = previewGeneratedBody;
          doneRow.emailBody = previewBody;
          doneRow.emailStatus = "preview_ready";
          doneRow.sourceRow = {
            ...(doneRow.sourceRow && typeof doneRow.sourceRow === "object" ? doneRow.sourceRow : {}),
            [EMAIL_TO_COLUMN]: previewTo,
            [EMAIL_SUBJECT_COLUMN]: previewSubject,
            [EMAIL_GENERATED_BODY_COLUMN]: previewGeneratedBody,
            [EMAIL_BODY_COLUMN]: previewBody,
            [EMAIL_PREVIEWED_AT_COLUMN]: previewedAt,
            [EMAIL_ERROR_COLUMN]: "",
            [EMAIL_STATUS_COLUMN]: "preview_ready",
          };
        });

        if (this.pipelineHandlers.sendPreparedEmail) {
          failureStage = "sendPreparedEmail";
          const sent = await this.runPipelineStage({
            campaignId,
            stageName: "sendPreparedEmail",
            rowNumber,
            execute: () =>
              this.withRunAbortSignal(campaignId, (abortSignal) =>
                this.pipelineHandlers.sendPreparedEmail({
                  campaignId,
                  rowNumber,
                  to: previewTo,
                  subject: previewSubject,
                  body: previewBody,
                  mailerFields: previewResult?.mailerFields || {},
                  abortSignal,
                })
              ),
          });
          const sentAt = compact(sent?.sentAt) || new Date().toISOString();
          const messageId = compact(sent?.messageId);
          const mailerSendDelayMs = getMailerSendDelayMs();
          if (mailerSendDelayMs > 0) {
            await this.waitWithRunStop(campaignId, mailerSendDelayMs, "send-delay");
          }

          await this.updateEnrichedRow({
            campaignId,
            rowNumber,
            updates: {
              [EMAIL_TO_COLUMN]: previewTo,
              [EMAIL_SUBJECT_COLUMN]: previewSubject,
              [EMAIL_BODY_COLUMN]: previewBody,
              [EMAIL_SENT_AT_COLUMN]: sentAt,
              [EMAIL_MESSAGE_ID_COLUMN]: messageId,
              [EMAIL_ERROR_COLUMN]: "",
              [EMAIL_STATUS_COLUMN]: "sent",
            },
          });

          await this.patchCampaignRow(campaignId, rowNumber, (sentRow) => {
            if (!sentRow) {
              return;
            }
            sentRow.emailTo = previewTo;
            sentRow.emailSubject = previewSubject;
            sentRow.emailBody = previewBody;
            sentRow.emailStatus = "sent";
            sentRow.sourceRow = {
              ...(sentRow.sourceRow && typeof sentRow.sourceRow === "object" ? sentRow.sourceRow : {}),
              [EMAIL_TO_COLUMN]: previewTo,
              [EMAIL_SUBJECT_COLUMN]: previewSubject,
              [EMAIL_BODY_COLUMN]: previewBody,
              [EMAIL_SENT_AT_COLUMN]: sentAt,
              [EMAIL_MESSAGE_ID_COLUMN]: messageId,
              [EMAIL_ERROR_COLUMN]: "",
              [EMAIL_STATUS_COLUMN]: "sent",
            };
          });
        }
      }

      await this.patchCampaignRow(campaignId, rowNumber, (finalRow, currentMetadata, currentRowIndex) => {
        if (!finalRow) {
          return;
        }
        finalRow.status = finalRow.emailStatus === "sent" ? ROW_STATUS_SENT : ROW_STATUS_READY;
        finalRow.durationMs = Date.now() - generationStartedAt;
        finalRow.completedAt = new Date().toISOString();
        finalRow.error = compact(finalRow.jinaError);
        finalRow.skipAutoPreview = false;
        currentMetadata.pausedAtRow = null;
        currentMetadata.resumeFromRow = this.findNextPendingRowNumber(currentMetadata.rows, currentRowIndex + 1);
      });
    } catch (error) {
      if (this.isRunStopError(error)) {
        return;
      }
      const failureMessage = truncateCellText(error.message || "Unknown enrichment error");
      console.error(
        `[campaign-row] row=${rowNumber} website=${row.websiteUrl || ""} stage=${failureStage} failed: ${failureMessage}`
      );

      await this.updateEnrichedRow({
        campaignId,
        rowNumber,
        updates: {
          [EMAIL_ERROR_COLUMN]: failureMessage,
          [EMAIL_STATUS_COLUMN]: row.emailStatus || "pending",
        },
      });

      await this.patchCampaignRow(campaignId, rowNumber, (nextRow, currentMetadata, currentRowIndex) => {
        if (!nextRow) {
          return;
        }
        nextRow.status = ROW_STATUS_FAILED;
        nextRow.durationMs = Date.now() - generationStartedAt;
        nextRow.completedAt = new Date().toISOString();
        nextRow.error = failureMessage;
        nextRow.skipAutoPreview = false;
        nextRow.emailStatus = compact(nextRow.emailStatus) || "pending";
        nextRow.sourceRow = {
          ...(nextRow.sourceRow && typeof nextRow.sourceRow === "object" ? nextRow.sourceRow : {}),
          [EMAIL_ERROR_COLUMN]: failureMessage,
          [EMAIL_STATUS_COLUMN]: nextRow.emailStatus,
        };
        currentMetadata.pausedAtRow = null;
        currentMetadata.resumeFromRow = this.findNextPendingRowNumber(currentMetadata.rows, currentRowIndex + 1);
      });
    }
  }

  async pauseCampaign(campaignId) {
    const normalizedCampaignId = compact(campaignId);
    return this.withCampaignLock(normalizedCampaignId, async () => {
      const metadata = await this.getCampaignMetadata(normalizedCampaignId);
      if (!metadata) {
        throw new Error("Campaign not found");
      }
      if (
        metadata.status === CAMPAIGN_STATUS_COMPLETED ||
        metadata.status === CAMPAIGN_STATUS_STOPPED ||
        metadata.status === CAMPAIGN_STATUS_FAILED
      ) {
        return metadata;
      }

      metadata.status = CAMPAIGN_STATUS_PAUSED;
      const activeStatuses = new Set([
        ROW_STATUS_FETCHING,
        ROW_STATUS_GENERATING_MAIL,
        ROW_STATUS_GENERATING_PREVIEW,
        ROW_STATUS_AWAITING_VERIFICATION,
      ]);
      const processingRowIndex = metadata.rows.findIndex((item) => activeStatuses.has(item?.status));
      if (processingRowIndex >= 0) {
        metadata.rows[processingRowIndex].status = ROW_STATUS_PAUSED;
        metadata.pausedAtRow = metadata.rows[processingRowIndex].rowNumber;
        metadata.resumeFromRow = metadata.rows[processingRowIndex].rowNumber;
      } else {
        metadata.resumeFromRow = this.findNextPendingRowNumber(metadata.rows) || null;
        metadata.pausedAtRow = metadata.resumeFromRow;
      }
      metadata.pausedAt = new Date().toISOString();
      return this.writeCampaignMetadata(normalizedCampaignId, metadata);
    });
  }

  async resumeCampaign(campaignId) {
    const normalizedCampaignId = compact(campaignId);
    const persisted = await this.withCampaignLock(normalizedCampaignId, async () => {
      const metadata = await this.getCampaignMetadata(normalizedCampaignId);
      if (!metadata) {
        throw new Error("Campaign not found");
      }
      if (metadata.status === CAMPAIGN_STATUS_COMPLETED) {
        return metadata;
      }

      metadata.status = CAMPAIGN_STATUS_RUNNING;
      metadata.pausedAtRow = null;
      metadata.pausedAt = "";
      metadata.stoppedAt = "";
      metadata.rows = (metadata.rows || []).map((item) => {
        const status = String(item?.status || "").toLowerCase();
        if (
          [
            ROW_STATUS_PAUSED,
            ROW_STATUS_FETCHING,
            ROW_STATUS_GENERATING_MAIL,
            ROW_STATUS_GENERATING_PREVIEW,
            ROW_STATUS_AWAITING_VERIFICATION,
          ].includes(status)
        ) {
          return { ...item, status: ROW_STATUS_QUEUED };
        }
        return item;
      });
      metadata.resumeFromRow = this.findNextPendingRowNumber(metadata.rows) || null;
      if (!metadata.resumeFromRow) {
        metadata.status = CAMPAIGN_STATUS_COMPLETED;
        metadata.completedAt = metadata.completedAt || new Date().toISOString();
        return this.writeCampaignMetadata(normalizedCampaignId, metadata);
      }
      return this.writeCampaignMetadata(normalizedCampaignId, metadata);
    });
    void this.ensureRunProcessor(normalizedCampaignId);
    return persisted;
  }

  async stopCampaign(campaignId) {
    const normalizedCampaignId = compact(campaignId);
    this.requestRunStop(normalizedCampaignId, "Campaign stop requested by user");
    return this.withCampaignLock(normalizedCampaignId, async () => {
      const metadata = await this.getCampaignMetadata(normalizedCampaignId);
      if (!metadata) {
        throw new Error("Campaign not found");
      }

      metadata.status = CAMPAIGN_STATUS_STOPPED;
      metadata.stoppedAt = new Date().toISOString();
      metadata.resumeFromRow = this.findNextPendingRowNumber(metadata.rows) || null;
      metadata.pausedAtRow = metadata.resumeFromRow;
      return this.writeCampaignMetadata(normalizedCampaignId, metadata);
    });
  }

  async waitForCampaignRunToStop(campaignId, timeoutMs = 180000) {
    const normalizedCampaignId = compact(campaignId);
    const runPromise = this.activeRuns.get(normalizedCampaignId);
    if (!runPromise) {
      return;
    }
    const normalizedTimeoutMs = Number.isFinite(Number(timeoutMs)) ? Math.max(1000, Number(timeoutMs)) : 180000;
    await Promise.race([
      runPromise.catch(() => null),
      (async () => {
        await waitMs(normalizedTimeoutMs);
        throw new Error(`Timed out waiting for campaign ${normalizedCampaignId} to stop`);
      })(),
    ]);
  }

  async stopCampaignAndWaitForIdle(campaignId, { timeoutMs = 180000 } = {}) {
    const normalizedCampaignId = compact(campaignId);
    const metadata = await this.getCampaignMetadata(normalizedCampaignId);
    if (!metadata) {
      throw new Error("Campaign not found");
    }

    const status = String(metadata.status || "").toLowerCase();
    const hasActiveRun = this.activeRuns.has(normalizedCampaignId);
    if (status === CAMPAIGN_STATUS_RUNNING || hasActiveRun || this.isRunStopRequested(normalizedCampaignId)) {
      await this.stopCampaign(normalizedCampaignId);
      await this.waitForCampaignRunToStop(normalizedCampaignId, timeoutMs);
    }

    return this.getCampaignMetadata(normalizedCampaignId);
  }

  async resetCampaign(campaignId) {
    const normalizedCampaignId = compact(campaignId);
    return this.withCampaignLock(normalizedCampaignId, async () => {
      const metadata = await this.getCampaignMetadata(normalizedCampaignId);
      if (!metadata) {
        throw new Error("Campaign not found");
      }
      if (String(metadata.status || "").toLowerCase() === CAMPAIGN_STATUS_RUNNING) {
        throw new Error("Stop or pause the campaign before reset");
      }

      const targetDir = path.join(STORAGE_ROOT, metadata.id);
      const enrichedFileName = compact(metadata.enrichedFileName);
      if (!enrichedFileName) {
        throw new Error("Campaign metadata is missing enrichedFileName");
      }
      const enrichedPath = path.join(targetDir, enrichedFileName);
      const workbookBuffer = await fs.readFile(enrichedPath);
      const workbook = XLSX.read(workbookBuffer, { type: "buffer" });
      const worksheetName = compact(metadata.worksheetName) || workbook.SheetNames[0];
      if (!worksheetName || !workbook.Sheets[worksheetName]) {
        throw new Error("Unable to locate campaign worksheet in enriched file");
      }

      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[worksheetName], { defval: "", raw: false });
      const resetUpdates = buildResetColumnUpdates();
      for (let index = 0; index < rows.length; index += 1) {
        rows[index] = {
          ...(rows[index] && typeof rows[index] === "object" ? rows[index] : {}),
          ...resetUpdates,
        };
      }

      const updatedWorkbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(updatedWorkbook, XLSX.utils.json_to_sheet(rows), worksheetName);
      for (let sheetIndex = 1; sheetIndex < workbook.SheetNames.length; sheetIndex += 1) {
        const sheetName = workbook.SheetNames[sheetIndex];
        XLSX.utils.book_append_sheet(updatedWorkbook, workbook.Sheets[sheetName], sheetName);
      }
      const extension = path.extname(enrichedFileName).toLowerCase();
      const updatedBuffer = XLSX.write(updatedWorkbook, {
        type: "buffer",
        bookType: getWorkbookTypeForExtension(extension),
      });
      await fs.writeFile(enrichedPath, updatedBuffer);

      const queueRows = (metadata.rows || []).map((item, idx) => {
        const sourceRow = item && typeof item.sourceRow === "object" && !Array.isArray(item.sourceRow) ? item.sourceRow : {};
        const contactEmail = resolveRecipientEmailFromRow({
          row: item,
          sourceRow,
          emailColumn: metadata.emailColumn,
        });
        const missingRecipientEmail = !contactEmail;
        const emailStatus = missingRecipientEmail ? EMAIL_STATUS_MISSING_RECIPIENT : "pending";
        const rowError = missingRecipientEmail ? MISSING_RECIPIENT_EMAIL_ERROR : "";
        return {
          ...item,
          index: Number.isFinite(Number(item?.index)) ? Number(item.index) : idx,
          rowNumber: Number(item?.rowNumber) || idx + 2,
          contactEmail,
          status: missingRecipientEmail ? ROW_STATUS_FAILED : ROW_STATUS_QUEUED,
          durationMs: 0,
          startedAt: "",
          completedAt: "",
          error: rowError,
          jinaContent: "",
          jinaError: "",
          jinaFetchMethod: "none",
          jinaSubPages: 0,
          jinaFetchTrace: "",
          linkedInContent: "",
          linkedInDescription: "",
          linkedInError: "",
          emailTo: "",
          emailSubject: "",
          emailGeneratedBody: "",
          emailBody: "",
          senderEmail: "",
          senderDomain: "",
          emailStatus,
          mailerFields: {},
          docFileName: "",
          skipAutoPreview: false,
          sourceRow: {
            ...sourceRow,
            ...resetUpdates,
            [EMAIL_ERROR_COLUMN]: rowError,
            [EMAIL_STATUS_COLUMN]: emailStatus,
          },
        };
      });

      metadata.rows = queueRows;
      metadata.results = queueRows.map((item) => this.toResultRow(item));
      metadata.succeeded = 0;
      metadata.failed = queueRows.filter((item) => item.status === ROW_STATUS_FAILED).length;
      metadata.processedRows = metadata.failed;
      metadata.bulkDomainUsage = {};
      metadata.bulkSenderUsage = {};
      metadata.status = CAMPAIGN_STATUS_PAUSED;
      metadata.error = "";
      metadata.completedAt = "";
      metadata.stoppedAt = "";
      metadata.pausedAt = new Date().toISOString();
      metadata.resumeFromRow = this.findNextPendingRowNumber(queueRows) || null;
      metadata.pausedAtRow = metadata.resumeFromRow;

      return this.writeCampaignMetadata(normalizedCampaignId, metadata);
    });
  }

  async retryRow(campaignId, rowNumber, { rebuildPreview = false } = {}) {
    const normalizedCampaignId = compact(campaignId);
    const metadata = await this.getCampaignMetadata(normalizedCampaignId);
    if (!metadata) {
      throw new Error("Campaign not found");
    }

    const rowIndex = this.findRowIndex(metadata, rowNumber);
    if (rowIndex < 0) {
      throw new Error("Row not found");
    }
    const retryRow = metadata.rows[rowIndex];
    const retrySourceRow =
      retryRow && typeof retryRow.sourceRow === "object" && !Array.isArray(retryRow.sourceRow) ? retryRow.sourceRow : {};
    const retryRecipientEmail = resolveRecipientEmailFromRow({
      row: retryRow,
      sourceRow: retrySourceRow,
      emailColumn: metadata.emailColumn,
    });
    if (!retryRecipientEmail) {
      throw new Error("Row is missing recipient email and cannot be processed");
    }

    const targetRowNumber = Number(metadata.rows[rowIndex].rowNumber);
    const resetRowUpdates = {
      [JINA_CONTENT_COLUMN]: "",
      [JINA_ERROR_COLUMN]: "",
      [JINA_FETCH_METHOD_COLUMN]: "none",
      [JINA_SUB_PAGES_COLUMN]: 0,
      [JINA_FETCH_TRACE_COLUMN]: "",
      [EMAIL_TO_COLUMN]: "",
      [EMAIL_SUBJECT_COLUMN]: "",
      [EMAIL_GENERATED_BODY_COLUMN]: "",
      [EMAIL_BODY_COLUMN]: "",
      [EMAIL_PREVIEWED_AT_COLUMN]: "",
      [EMAIL_SENT_AT_COLUMN]: "",
      [EMAIL_MESSAGE_ID_COLUMN]: "",
      [EMAIL_ERROR_COLUMN]: "",
      [EMAIL_SENDER_COLUMN]: "",
      [EMAIL_SENDER_DOMAIN_COLUMN]: "",
      [EMAIL_STATUS_COLUMN]: "pending",
    };

    await this.updateEnrichedRow({
      campaignId: normalizedCampaignId,
      rowNumber: targetRowNumber,
      updates: resetRowUpdates,
    });

    const persisted = await this.withCampaignLock(normalizedCampaignId, async () => {
      const currentMetadata = await this.getCampaignMetadata(normalizedCampaignId);
      if (!currentMetadata) {
        throw new Error("Campaign not found");
      }

      const currentRowIndex = this.findRowIndex(currentMetadata, targetRowNumber);
      if (currentRowIndex < 0) {
        throw new Error("Row not found");
      }
      const row = currentMetadata.rows[currentRowIndex];
      row.status = ROW_STATUS_QUEUED;
      row.error = "";
      row.durationMs = 0;
      row.startedAt = "";
      row.completedAt = "";
      row.jinaContent = "";
      row.jinaError = "";
      row.jinaFetchMethod = "none";
      row.jinaSubPages = 0;
      row.jinaFetchTrace = "";
      row.emailTo = "";
      row.emailSubject = "";
      row.emailGeneratedBody = "";
      row.emailBody = "";
      row.senderEmail = "";
      row.senderDomain = "";
      row.emailStatus = "pending";
      row.mailerFields = {};
      row.docFileName = "";
      row.skipAutoPreview = false;
      row.sourceRow = {
        ...(row.sourceRow && typeof row.sourceRow === "object" ? row.sourceRow : {}),
        ...resetRowUpdates,
      };

      currentMetadata.status = CAMPAIGN_STATUS_RUNNING;
      currentMetadata.pausedAtRow = null;
      currentMetadata.resumeFromRow = targetRowNumber;
      return this.writeCampaignMetadata(normalizedCampaignId, currentMetadata);
    });
    void this.ensureRunProcessor(normalizedCampaignId);
    return persisted;
  }

  async deleteRows(campaignId, rowNumbers = []) {
    const normalizedCampaignId = compact(campaignId);
    if (!normalizedCampaignId) {
      throw new Error("Campaign not found");
    }

    const normalizedRowNumbers = Array.from(
      new Set(
        (Array.isArray(rowNumbers) ? rowNumbers : [])
          .map((value) => Number.parseInt(value, 10))
          .filter((value) => Number.isFinite(value) && value >= 2)
      )
    );
    if (normalizedRowNumbers.length < 1) {
      throw new Error("At least one valid row number is required");
    }

    return this.withCampaignLock(normalizedCampaignId, async () => {
      const metadata = await this.getCampaignMetadata(normalizedCampaignId);
      if (!metadata) {
        throw new Error("Campaign not found");
      }

      const status = compact(metadata.status).toLowerCase();
      if (status === CAMPAIGN_STATUS_RUNNING || this.activeRuns.has(normalizedCampaignId)) {
        throw new Error("Cannot delete rows while campaign is running. Pause or stop the campaign first.");
      }
      const usageBeforeDelete = buildMergedUsageFromMetadata(metadata);

      const rowSet = new Set(normalizedRowNumbers);
      const rows = Array.isArray(metadata.rows) ? metadata.rows : [];
      const matchedCount = rows.filter((item) => rowSet.has(Number(item?.rowNumber))).length;
      if (matchedCount < 1) {
        throw new Error("No matching rows found for deletion");
      }

      const remainingRows = rows
        .filter((item) => !rowSet.has(Number(item?.rowNumber)))
        .map((item, index) => ({
          ...item,
          index,
          rowNumber: index + 2,
        }));

      const targetDir = path.join(STORAGE_ROOT, metadata.id);
      const enrichedFileName = compact(metadata.enrichedFileName);
      if (!enrichedFileName) {
        throw new Error("Campaign metadata is missing enrichedFileName");
      }
      const enrichedPath = path.join(targetDir, enrichedFileName);
      const workbookBuffer = await fs.readFile(enrichedPath);
      const workbook = XLSX.read(workbookBuffer, { type: "buffer" });
      const worksheetName = compact(metadata.worksheetName) || workbook.SheetNames[0];
      if (!worksheetName || !workbook.Sheets[worksheetName]) {
        throw new Error("Unable to locate campaign worksheet in enriched file");
      }

      const rebuiltRows = remainingRows.map((item) => this.buildWorksheetRowFromCampaignRow(item));
      const rebuiltWorkbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(rebuiltWorkbook, XLSX.utils.json_to_sheet(rebuiltRows), worksheetName);
      for (const sheetName of workbook.SheetNames) {
        if (sheetName === worksheetName) {
          continue;
        }
        XLSX.utils.book_append_sheet(rebuiltWorkbook, workbook.Sheets[sheetName], sheetName);
      }

      const extension = path.extname(enrichedFileName).toLowerCase();
      const rebuiltBuffer = XLSX.write(rebuiltWorkbook, {
        type: "buffer",
        bookType: getWorkbookTypeForExtension(extension),
      });
      await fs.writeFile(enrichedPath, rebuiltBuffer);

      metadata.rows = remainingRows;
      metadata.results = remainingRows.map((item) => this.toResultRow(item));
      metadata.count = remainingRows.length;
      metadata.availableRows = remainingRows.length;
      metadata.bulkDomainUsage = usageBeforeDelete.domainUsage;
      metadata.bulkSenderUsage = usageBeforeDelete.senderUsage;
      metadata.pausedAtRow = null;
      metadata.resumeFromRow = this.findNextPendingRowNumber(remainingRows) || null;
      if (remainingRows.length < 1 || !metadata.resumeFromRow) {
        metadata.status = CAMPAIGN_STATUS_COMPLETED;
        metadata.completedAt = new Date().toISOString();
        metadata.resumeFromRow = null;
      }

      return this.writeCampaignMetadata(normalizedCampaignId, metadata);
    });
  }

  async skipRow(campaignId, rowNumber, reason = "Skipped by user during verification") {
    const normalizedCampaignId = compact(campaignId);
    const metadata = await this.getCampaignMetadata(normalizedCampaignId);
    if (!metadata) {
      throw new Error("Campaign not found");
    }

    const rowIndex = this.findRowIndex(metadata, rowNumber);
    if (rowIndex < 0) {
      throw new Error("Row not found");
    }

    const targetRowNumber = Number(metadata.rows[rowIndex].rowNumber);
    const rowError = compact(reason);
    const rowFetchMethod = compact(metadata.rows[rowIndex].jinaFetchMethod) || "none";

    await this.updateEnrichedRow({
      campaignId: normalizedCampaignId,
      rowNumber: targetRowNumber,
      updates: {
        [JINA_ERROR_COLUMN]: rowError,
        [JINA_FETCH_METHOD_COLUMN]: rowFetchMethod,
      },
    });

    const persisted = await this.withCampaignLock(normalizedCampaignId, async () => {
      const currentMetadata = await this.getCampaignMetadata(normalizedCampaignId);
      if (!currentMetadata) {
        throw new Error("Campaign not found");
      }
      const currentRowIndex = this.findRowIndex(currentMetadata, targetRowNumber);
      if (currentRowIndex < 0) {
        throw new Error("Row not found");
      }
      const row = currentMetadata.rows[currentRowIndex];
      row.status = ROW_STATUS_FAILED;
      row.error = rowError;
      row.completedAt = new Date().toISOString();
      row.skipAutoPreview = false;
      row.sourceRow = {
        ...(row.sourceRow && typeof row.sourceRow === "object" ? row.sourceRow : {}),
        [JINA_ERROR_COLUMN]: rowError,
        [JINA_FETCH_METHOD_COLUMN]: rowFetchMethod,
      };
      currentMetadata.resumeFromRow = this.findNextPendingRowNumber(currentMetadata.rows, currentRowIndex + 1);
      return this.writeCampaignMetadata(normalizedCampaignId, currentMetadata);
    });
    await this.emitCampaignEvent(campaignId, {
      type: "row_skipped",
      campaignId,
      rowNumber: targetRowNumber,
      rowIndex: targetRowNumber,
      message: rowError,
    });
    return persisted;
  }

  async getEnrichedFilePath(campaignId) {
    const metadata = await this.getCampaignMetadata(campaignId);
    if (!metadata) {
      return null;
    }
    const enrichedFileName = compact(metadata.enrichedFileName);
    if (!enrichedFileName) {
      return null;
    }
    return {
      metadata,
      filePath: path.join(STORAGE_ROOT, metadata.id, enrichedFileName),
      fileName: enrichedFileName,
    };
  }

  async saveUpload({ campaignFile, count }) {
    const safeName = sanitizeFileName(campaignFile.name);
    const extension = path.extname(safeName).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error("Campaign file must be .xlsx, .xls, or .csv");
    }

    const fileBuffer = Buffer.from(campaignFile.contentBase64, "base64");
    if (fileBuffer.length === 0) {
      throw new Error("Campaign file is empty");
    }

    const campaignId = `campaign-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const targetDir = path.join(STORAGE_ROOT, campaignId);
    const metadataPath = path.join(targetDir, "metadata.json");
    const savedAt = new Date().toISOString();

    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, safeName), fileBuffer);

    const workbook = XLSX.read(fileBuffer, { type: "buffer" });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      throw new Error("Campaign file does not contain any worksheets");
    }
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], { defval: "", raw: false });
    if (rows.length === 0) {
      throw new Error("Campaign sheet does not contain any data rows");
    }

    const websiteColumn = detectWebsiteColumn(rows);
    if (!websiteColumn) {
      throw new Error("Unable to find a website column. Expected one of: website, websiteUrl, website_url, url, site");
    }
    const linkedInColumn = "";
    const emailColumn = detectEmailColumn(rows);

    const limit = Math.min(rows.length, Number.parseInt(count, 10) || rows.length);
    const queueRows = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      row[JINA_CONTENT_COLUMN] = compact(row[JINA_CONTENT_COLUMN]);
      row[JINA_ERROR_COLUMN] = compact(row[JINA_ERROR_COLUMN]);
      row[JINA_FETCH_METHOD_COLUMN] = compact(row[JINA_FETCH_METHOD_COLUMN]) || "none";
      row[JINA_SUB_PAGES_COLUMN] = toNonNegativeInt(row[JINA_SUB_PAGES_COLUMN], 0);
      row[JINA_FETCH_TRACE_COLUMN] = compact(row[JINA_FETCH_TRACE_COLUMN]);
      row[LINKEDIN_CONTENT_COLUMN] = compact(row[LINKEDIN_CONTENT_COLUMN]);
      row[LINKEDIN_DESCRIPTION_COLUMN] = compact(row[LINKEDIN_DESCRIPTION_COLUMN]);
      row[LINKEDIN_ERROR_COLUMN] = compact(row[LINKEDIN_ERROR_COLUMN]);
      row[EMAIL_TO_COLUMN] = compact(row[EMAIL_TO_COLUMN]);
      row[EMAIL_SUBJECT_COLUMN] = compact(row[EMAIL_SUBJECT_COLUMN]);
      row[EMAIL_GENERATED_BODY_COLUMN] = compact(row[EMAIL_GENERATED_BODY_COLUMN]);
      row[EMAIL_BODY_COLUMN] = compact(row[EMAIL_BODY_COLUMN]);
      row[EMAIL_PREVIEWED_AT_COLUMN] = compact(row[EMAIL_PREVIEWED_AT_COLUMN]);
      row[EMAIL_SENT_AT_COLUMN] = compact(row[EMAIL_SENT_AT_COLUMN]);
      row[EMAIL_MESSAGE_ID_COLUMN] = compact(row[EMAIL_MESSAGE_ID_COLUMN]);
      row[EMAIL_ERROR_COLUMN] = compact(row[EMAIL_ERROR_COLUMN]);
      row[EMAIL_SENDER_COLUMN] = compact(row[EMAIL_SENDER_COLUMN]);
      row[EMAIL_SENDER_DOMAIN_COLUMN] = compact(row[EMAIL_SENDER_DOMAIN_COLUMN]);
      row[EMAIL_STATUS_COLUMN] = compact(row[EMAIL_STATUS_COLUMN]) || "pending";

      if (index >= limit) {
        continue;
      }

      const normalizedContactEmail = resolveRecipientEmailFromRow({
        row: {
          contactEmail: row[EMAIL_TO_COLUMN],
        },
        sourceRow: row,
        emailColumn,
      });
      const missingRecipientEmail = !normalizedContactEmail;
      if (missingRecipientEmail) {
        row[EMAIL_ERROR_COLUMN] = MISSING_RECIPIENT_EMAIL_ERROR;
        row[EMAIL_STATUS_COLUMN] = EMAIL_STATUS_MISSING_RECIPIENT;
      } else {
        row[EMAIL_ERROR_COLUMN] = "";
        row[EMAIL_STATUS_COLUMN] = compact(row[EMAIL_STATUS_COLUMN]) || "pending";
      }

      const sourceRow = Object.fromEntries(
        Object.entries(row).filter(
          ([key]) =>
            key !== JINA_CONTENT_COLUMN &&
            key !== JINA_ERROR_COLUMN &&
            key !== JINA_FETCH_METHOD_COLUMN &&
            key !== JINA_SUB_PAGES_COLUMN &&
            key !== JINA_FETCH_TRACE_COLUMN &&
            key !== LINKEDIN_CONTENT_COLUMN &&
            key !== LINKEDIN_DESCRIPTION_COLUMN &&
            key !== LINKEDIN_ERROR_COLUMN
        )
      );

      queueRows.push({
        index,
        rowNumber: index + 2,
        companyName: firstNonEmpty(
          sourceRow.companyName,
          sourceRow.CompanyName,
          sourceRow.company,
          sourceRow.Company,
          sourceRow.name,
          sourceRow.Name
        ),
        websiteUrl: compact(row[websiteColumn]),
        contactEmail: normalizedContactEmail,
        status: missingRecipientEmail ? ROW_STATUS_FAILED : ROW_STATUS_QUEUED,
        durationMs: 0,
        error: missingRecipientEmail ? MISSING_RECIPIENT_EMAIL_ERROR : "",
        jinaContent: "",
        jinaError: "",
        jinaFetchMethod: compact(row[JINA_FETCH_METHOD_COLUMN]) || "none",
        jinaSubPages: toNonNegativeInt(row[JINA_SUB_PAGES_COLUMN], 0),
        jinaFetchTrace: compact(row[JINA_FETCH_TRACE_COLUMN]),
        linkedInUrl: "",
        linkedInContent: "",
        linkedInDescription: "",
        linkedInError: "",
        emailTo: "",
        emailSubject: "",
        emailGeneratedBody: "",
        emailBody: "",
        senderEmail: compact(row[EMAIL_SENDER_COLUMN]),
        senderDomain: compact(row[EMAIL_SENDER_DOMAIN_COLUMN]),
        mailerFields: {},
        docFileName: "",
        sourceRow,
        emailStatus: missingRecipientEmail ? EMAIL_STATUS_MISSING_RECIPIENT : compact(row[EMAIL_STATUS_COLUMN]) || "pending",
        skipAutoPreview: false,
      });
    }

    const enrichedWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(enrichedWorkbook, XLSX.utils.json_to_sheet(rows), firstSheetName);
    for (let sheetIndex = 1; sheetIndex < workbook.SheetNames.length; sheetIndex += 1) {
      const sheetName = workbook.SheetNames[sheetIndex];
      XLSX.utils.book_append_sheet(enrichedWorkbook, workbook.Sheets[sheetName], sheetName);
    }

    const enrichedFileName = this.buildOutputFileName(safeName, extension);
    const enrichedBuffer = XLSX.write(enrichedWorkbook, {
      type: "buffer",
      bookType: getWorkbookTypeForExtension(extension),
    });
    await fs.writeFile(path.join(targetDir, enrichedFileName), enrichedBuffer);

    const metadata = {
      id: campaignId,
      originalFileName: campaignFile.name,
      savedFileName: safeName,
      mimeType: campaignFile.mimeType || "application/octet-stream",
      count,
      sizeBytes: fileBuffer.length,
      savedAt,
      worksheetName: firstSheetName,
      websiteColumn,
      linkedInColumn,
      emailColumn,
      destinationColumns: [
        JINA_CONTENT_COLUMN,
        JINA_ERROR_COLUMN,
        JINA_FETCH_METHOD_COLUMN,
        JINA_SUB_PAGES_COLUMN,
        JINA_FETCH_TRACE_COLUMN,
        LINKEDIN_CONTENT_COLUMN,
        LINKEDIN_DESCRIPTION_COLUMN,
        LINKEDIN_ERROR_COLUMN,
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
      ],
      availableRows: rows.length,
      processedRows: 0,
      succeeded: 0,
      failed: queueRows.filter((item) => item.status === ROW_STATUS_FAILED).length,
      bulkDomainUsage: {},
      bulkSenderUsage: {},
      status: CAMPAIGN_STATUS_RUNNING,
      pausedAtRow: null,
      resumeFromRow: this.findNextPendingRowNumber(queueRows) || null,
      startedAt: new Date().toISOString(),
      enrichedFileName,
      rows: queueRows,
      results: queueRows.map((item) => this.toResultRow(item)),
    };
    metadata.processedRows = metadata.failed;
    const normalized = await this.writeCampaignMetadata(campaignId, metadata);
    void this.ensureRunProcessor(campaignId);
    return normalized;
  }

  async updateEnrichedRow({ campaignId, rowNumber, updates }) {
    const normalizedCampaignId = compact(campaignId);
    if (!normalizedCampaignId) {
      throw new Error("campaignId is required");
    }

    const normalizedRowNumber = Number.parseInt(rowNumber, 10);
    if (!Number.isFinite(normalizedRowNumber) || normalizedRowNumber < 2) {
      throw new Error("rowNumber must be an integer >= 2");
    }

    const patchEntries = Object.entries(updates || {}).filter(([key]) => compact(key));
    if (patchEntries.length === 0) {
      return {
        ok: true,
        campaignId: normalizedCampaignId,
        rowNumber: normalizedRowNumber,
        appliedUpdates: {},
      };
    }

    return this.withCampaignLock(normalizedCampaignId, async () => {
      const targetDir = path.join(STORAGE_ROOT, normalizedCampaignId);
      const metadata = await this.getCampaignMetadata(normalizedCampaignId);
      if (!metadata) {
        throw new Error("Campaign metadata not found");
      }

      const enrichedFileName = compact(metadata.enrichedFileName);
      if (!enrichedFileName) {
        throw new Error("Campaign metadata is missing enrichedFileName");
      }

      const enrichedPath = path.join(targetDir, enrichedFileName);
      const workbookBuffer = await fs.readFile(enrichedPath);
      const workbook = XLSX.read(workbookBuffer, { type: "buffer" });
      const worksheetName = compact(metadata.worksheetName) || workbook.SheetNames[0];
      if (!worksheetName || !workbook.Sheets[worksheetName]) {
        throw new Error("Unable to locate campaign worksheet in enriched file");
      }

      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[worksheetName], { defval: "", raw: false });
      const rowIndex = normalizedRowNumber - 2;
      if (rowIndex < 0 || rowIndex >= rows.length) {
        throw new Error(`Row ${normalizedRowNumber} is out of range for this campaign`);
      }

      const currentRow = rows[rowIndex] && typeof rows[rowIndex] === "object" ? rows[rowIndex] : {};
      const appliedUpdates = {};

      for (const [key, rawValue] of patchEntries) {
        const columnName = String(key || "").trim();
        if (!columnName) {
          continue;
        }
        const cellValue = truncateCellText(rawValue);
        currentRow[columnName] = cellValue;
        appliedUpdates[columnName] = cellValue;
      }

      rows[rowIndex] = currentRow;

      const updatedWorkbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(updatedWorkbook, XLSX.utils.json_to_sheet(rows), worksheetName);
      for (let sheetIndex = 1; sheetIndex < workbook.SheetNames.length; sheetIndex += 1) {
        const sheetName = workbook.SheetNames[sheetIndex];
        XLSX.utils.book_append_sheet(updatedWorkbook, workbook.Sheets[sheetName], sheetName);
      }

      const extension = path.extname(enrichedFileName).toLowerCase();
      const updatedBuffer = XLSX.write(updatedWorkbook, {
        type: "buffer",
        bookType: getWorkbookTypeForExtension(extension),
      });
      await fs.writeFile(enrichedPath, updatedBuffer);

      const rowIndexInMetadata = this.findRowIndex(metadata, normalizedRowNumber);
      if (rowIndexInMetadata >= 0) {
        const rowEntry = metadata.rows[rowIndexInMetadata];
        rowEntry.sourceRow = {
          ...(rowEntry.sourceRow && typeof rowEntry.sourceRow === "object" ? rowEntry.sourceRow : {}),
          ...appliedUpdates,
        };

        if (Object.prototype.hasOwnProperty.call(appliedUpdates, JINA_CONTENT_COLUMN)) {
          rowEntry.jinaContent = compact(appliedUpdates[JINA_CONTENT_COLUMN]);
        }
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, JINA_ERROR_COLUMN)) {
          rowEntry.jinaError = compact(appliedUpdates[JINA_ERROR_COLUMN]);
        }
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, JINA_FETCH_METHOD_COLUMN)) {
          rowEntry.jinaFetchMethod = compact(appliedUpdates[JINA_FETCH_METHOD_COLUMN]) || "none";
        }
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, JINA_SUB_PAGES_COLUMN)) {
          rowEntry.jinaSubPages = toNonNegativeInt(appliedUpdates[JINA_SUB_PAGES_COLUMN], 0);
        }
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, JINA_FETCH_TRACE_COLUMN)) {
          rowEntry.jinaFetchTrace = compact(appliedUpdates[JINA_FETCH_TRACE_COLUMN]);
        }
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, LINKEDIN_CONTENT_COLUMN)) {
          rowEntry.linkedInContent = compact(appliedUpdates[LINKEDIN_CONTENT_COLUMN]);
        }
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, LINKEDIN_DESCRIPTION_COLUMN)) {
          rowEntry.linkedInDescription = compact(appliedUpdates[LINKEDIN_DESCRIPTION_COLUMN]);
        }
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, LINKEDIN_ERROR_COLUMN)) {
          rowEntry.linkedInError = compact(appliedUpdates[LINKEDIN_ERROR_COLUMN]);
        }
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, EMAIL_STATUS_COLUMN)) {
          rowEntry.emailStatus = compact(appliedUpdates[EMAIL_STATUS_COLUMN]) || rowEntry.emailStatus || "pending";
          if (rowEntry.emailStatus === "sent") {
            rowEntry.status = ROW_STATUS_SENT;
          } else if (rowEntry.emailStatus === "preview_ready" && rowEntry.status !== ROW_STATUS_FAILED) {
            rowEntry.status = ROW_STATUS_READY;
          }
        }
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, EMAIL_TO_COLUMN)) {
          rowEntry.contactEmail = normalizeRecipientEmail(appliedUpdates[EMAIL_TO_COLUMN]);
          rowEntry.emailTo = normalizeRecipientEmail(appliedUpdates[EMAIL_TO_COLUMN]);
        }
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, EMAIL_SUBJECT_COLUMN)) {
          rowEntry.emailSubject = compact(appliedUpdates[EMAIL_SUBJECT_COLUMN]);
        }
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, EMAIL_GENERATED_BODY_COLUMN)) {
          rowEntry.emailGeneratedBody = compact(appliedUpdates[EMAIL_GENERATED_BODY_COLUMN]);
        }
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, EMAIL_BODY_COLUMN)) {
          rowEntry.emailBody = compact(appliedUpdates[EMAIL_BODY_COLUMN]);
        }
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, EMAIL_SENDER_COLUMN)) {
          rowEntry.senderEmail = compact(appliedUpdates[EMAIL_SENDER_COLUMN]);
        }
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, EMAIL_SENDER_DOMAIN_COLUMN)) {
          rowEntry.senderDomain = compact(appliedUpdates[EMAIL_SENDER_DOMAIN_COLUMN]);
        }
      }

      await this.writeCampaignMetadata(normalizedCampaignId, metadata);

      return {
        ok: true,
        campaignId: normalizedCampaignId,
        rowNumber: normalizedRowNumber,
        appliedUpdates,
      };
    });
  }

  buildOutputFileName(fileName, extension) {
    const stem = path.basename(fileName, extension);
    return `${stem}-enriched${extension || ".xlsx"}`;
  }

  async fetchJinaContent(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const proxyUrl = this.getNextProxy();
    try {
      const dispatcher = this.getProxyDispatcher(proxyUrl);
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {}),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (!response.ok) {
        throw new Error(`Jina request failed with status ${response.status}`);
      }
      const text = await response.text();
      if (!text.trim()) {
        throw new Error("Jina returned an empty response");
      }
      return text;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Jina request timed out after ${this.requestTimeoutMs}ms`);
      }
      if (proxyUrl) {
        throw new Error(`Proxy request failed via ${proxyUrl}: ${error.message}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
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
  buildJinaReaderUrl,
  buildLinkedInQueries,
  buildLinkedInSearchUrls,
  buildSearchNameFromLinkedInUrl,
  detectWebsiteColumn,
  detectLinkedInColumn,
  detectEmailColumn,
  extractLinkedInDescriptionFromText,
  extractPlainTextFromJinaResponse,
  getLinkedInPathParts,
  normalizeLinkedInSearchTarget,
  normalizeRecipientEmail,
  normalizeWebsiteUrl,
  resolveLinkedInEntityInfo,
};
