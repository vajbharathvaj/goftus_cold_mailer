const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_PLAYWRIGHT_TIMEOUT_MS = 30000;
const DEFAULT_CHROME_TIMEOUT_MS = 30000;
const DEFAULT_SUBPAGE_MAX_COUNT = 2;
const DEFAULT_SEARCH_SNIPPET_MAX_LINES = 3;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const URL_REGEX = /https?:\/\/[^\s)"'>]+/gi;
const { execSync } = require("node:child_process");
const { getChromeCookiesForUrl } = require("./chromeCookieService");
const { fetchViaRealChromeProfile } = require("./chromeProfileFetchService");

const USEFUL_PATH_PATTERNS = [
  /\/about/i,
  /\/company/i,
  /\/who-we-are/i,
  /\/our-story/i,
  /\/services/i,
  /\/what-we-do/i,
  /\/solutions/i,
  /\/team/i,
  /\/mission/i,
  /\/vision/i,
  /\/product/i,
  /\/platform/i,
];

const SKIP_PATH_PATTERNS = [
  /\/blog/i,
  /\/news/i,
  /\/press/i,
  /\/careers/i,
  /\/jobs/i,
  /\/login/i,
  /\/signup/i,
  /\/register/i,
  /\/terms/i,
  /\/privacy/i,
  /\/cookie/i,
  /\/support/i,
  /\/faq/i,
  /\.(pdf|png|jpg|jpeg|gif|svg|zip)$/i,
];

function compact(value) {
  return String(value || "").trim();
}

function toBool(value, fallback = false) {
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

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeAbsoluteUrl(input, baseUrl = "") {
  const raw = compact(input);
  if (!raw) {
    return "";
  }
  try {
    if (baseUrl) {
      return new URL(raw, baseUrl).toString();
    }
    return new URL(raw).toString();
  } catch (_error) {
    return "";
  }
}

function sanitizeDiscoveredLink(value) {
  const normalized = compact(value).replace(/[)\].,;:]+$/g, "");
  return normalized;
}

function isBlockedResponse(text) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  const looksLikeSearchShell =
    lower.includes("title: google search") ||
    lower.includes("google search\n===============") ||
    lower.includes("if you're having trouble accessing google search") ||
    lower.includes("our systems have detected unusual traffic") ||
    lower.includes("to continue, please verify") ||
    (lower.includes("url source:") && lower.includes("markdown content:") && lower.includes("google search"));
  return (
    lower.includes("access denied") ||
    lower.includes("403: forbidden") ||
    lower.includes("you don't have permission") ||
    lower.includes("enable javascript") ||
    lower.includes("please verify you are a human") ||
    lower.includes("cf-browser-verification") ||
    lower.includes("reference #") ||
    lower.includes("captcha") ||
    looksLikeSearchShell ||
    raw.trim().length < 100
  );
}

function cleanText(raw) {
  return String(raw || "")
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function isUsefulPath(url) {
  return USEFUL_PATH_PATTERNS.some((pattern) => pattern.test(url));
}

function shouldSkipPath(url) {
  return SKIP_PATH_PATTERNS.some((pattern) => pattern.test(url));
}

function isAntiBotChallengeHtml(html) {
  const lower = String(html || "").toLowerCase();
  return (
    lower.includes("kpsdk") ||
    lower.includes("/ips.js") ||
    lower.includes("cf-browser-verification") ||
    lower.includes("captcha") ||
    lower.includes("verify you are human")
  );
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractInternalLinksFromHtml(html, baseUrl) {
  const homepage = normalizeAbsoluteUrl(baseUrl);
  if (!homepage) {
    return [];
  }
  const origin = new URL(homepage).origin;
  const regex = /href\s*=\s*["']([^"']+)["']/gi;
  const deduped = new Set();
  let match = regex.exec(String(html || ""));
  while (match) {
    const href = sanitizeDiscoveredLink(match[1]);
    const normalized = normalizeAbsoluteUrl(href, homepage);
    if (normalized && normalized.startsWith(origin) && normalized !== homepage && !shouldSkipPath(normalized)) {
      deduped.add(normalized);
    }
    match = regex.exec(String(html || ""));
  }
  return Array.from(deduped);
}

function getDomainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch (_error) {
    return "";
  }
}

function getSearchSnippetCompanyName(options = {}) {
  return compact(options.companyName || options.company || "");
}

function buildSearchSnippetQuery(domain, companyName = "") {
  const cleanDomain = compact(domain);
  const cleanCompanyName = compact(companyName);
  if (!cleanDomain && !cleanCompanyName) {
    return "";
  }
  if (!cleanCompanyName) {
    return `site:${cleanDomain} company description`;
  }
  if (!cleanDomain) {
    return `"${cleanCompanyName}" company description`;
  }
  return `site:${cleanDomain} OR "${cleanCompanyName}" company description`;
}

function buildSearchSnippetQueries(domain, companyName = "") {
  const cleanDomain = compact(domain);
  const cleanCompanyName = compact(companyName);
  const queries = [];

  const primary = buildSearchSnippetQuery(cleanDomain, cleanCompanyName);
  if (primary) {
    queries.push(primary);
  }
  if (cleanDomain) {
    queries.push(`site:${cleanDomain} company description`);
    queries.push(`site:${cleanDomain} about`);
  }
  if (cleanCompanyName) {
    queries.push(`"${cleanCompanyName}" company description`);
    queries.push(`"${cleanCompanyName}" about`);
  }

  return Array.from(new Set(queries.filter(Boolean)));
}

function isSnippetNoiseLine(line) {
  const value = compact(line);
  if (!value) {
    return true;
  }
  return (
    /^title:/i.test(value) ||
    /^url source:/i.test(value) ||
    /^published time:/i.test(value) ||
    /^markdown content:/i.test(value) ||
    /^duckduckgo$/i.test(value) ||
    /^all regions$/i.test(value) ||
    /^all languages$/i.test(value) ||
    /^any time$/i.test(value) ||
    /^about \d[\d,.]* results/i.test(value) ||
    /^feedback$/i.test(value) ||
    /^privacy$/i.test(value) ||
    /^terms$/i.test(value) ||
    /^advertise/i.test(value) ||
    /please complete the following challenge/i.test(value) ||
    /verify you are human/i.test(value) ||
    /solve the challenge/i.test(value) ||
    /unusual traffic/i.test(value) ||
    /^https?:\/\//i.test(value) ||
    /^site:/i.test(value) ||
    /duckduckgo/i.test(value) ||
    /(?:images|videos|news|maps|shopping)\b/i.test(value)
  );
}

function extractSearchSnippetText(raw, { domain = "", companyName = "", maxLines = DEFAULT_SEARCH_SNIPPET_MAX_LINES } = {}) {
  const lines = String(raw || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => compact(line))
    .filter(Boolean);
  if (lines.length === 0) {
    return "";
  }

  const domainTokens = compact(domain)
    .split(".")
    .map((token) => compact(token).toLowerCase())
    .filter((token) => token.length >= 3);
  const companyTokens = compact(companyName)
    .split(/[\s\-_]+/)
    .map((token) => compact(token).toLowerCase())
    .filter((token) => token.length >= 3);

  const candidates = lines
    .filter((line) => !isSnippetNoiseLine(line))
    .filter((line) => line.length >= 40 && line.length <= 420)
    .map((line) => {
      const lower = line.toLowerCase();
      const tokenMatches = [...domainTokens, ...companyTokens].filter((token) => lower.includes(token)).length;
      const score = tokenMatches * 3 + (/\b(company|business|services|solutions|platform|team|founded)\b/i.test(line) ? 2 : 0);
      return { line, score };
    })
    .sort((a, b) => b.score - a.score);

  const selected = candidates.slice(0, Math.max(1, maxLines)).map((item) => item.line);
  return cleanText(selected.join("\n"));
}

function extractInternalLinks(homepageText, baseUrl) {
  const homepage = normalizeAbsoluteUrl(baseUrl);
  if (!homepage) {
    return [];
  }
  const origin = new URL(homepage).origin;
  const links = String(homepageText || "").match(URL_REGEX) || [];
  const deduped = new Set();

  for (const candidate of links) {
    const sanitized = sanitizeDiscoveredLink(candidate);
    const normalized = normalizeAbsoluteUrl(sanitized, homepage);
    if (!normalized) {
      continue;
    }
    if (!normalized.startsWith(origin)) {
      continue;
    }
    if (normalizeAbsoluteUrl(normalized) === homepage) {
      continue;
    }
    if (shouldSkipPath(normalized)) {
      continue;
    }
    if (!isUsefulPath(normalized)) {
      continue;
    }
    deduped.add(normalized);
    if (deduped.size >= 5) {
      break;
    }
  }
  return Array.from(deduped);
}

function combinePageContent(homepageText, subPages) {
  const parts = [];
  const cleanedHomepage = cleanText(homepageText);
  if (cleanedHomepage.length > 50) {
    parts.push(`--- Homepage ---\n${cleanedHomepage}`);
  }

  for (const page of Array.isArray(subPages) ? subPages : []) {
    const url = normalizeAbsoluteUrl(page?.url);
    const cleaned = cleanText(page?.text);
    if (!url || cleaned.length <= 50) {
      continue;
    }
    let path = "/";
    try {
      path = new URL(url).pathname || "/";
    } catch (_error) {
      path = "/";
    }
    parts.push(`--- ${path} ---\n${cleaned}`);
  }

  return parts.join("\n\n").trim();
}

function makeJinaReaderUrl(url) {
  return `https://r.jina.ai/${url}`;
}

function normalizeAbortReason(reason, fallback = "Request aborted") {
  const message = compact(reason?.message || reason);
  return message || fallback;
}

async function fetchText(url, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, abortSignal = null } = {}) {
  if (abortSignal?.aborted) {
    throw new Error(normalizeAbortReason(abortSignal.reason, "Campaign stop requested"));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  let abortHandler = null;
  if (abortSignal) {
    abortHandler = () => controller.abort(abortSignal.reason || new Error("Campaign stop requested"));
    abortSignal.addEventListener("abort", abortHandler, { once: true });
  }
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        ...headers,
      },
    });
    const bodyText = await response.text().catch(() => "");
    return {
      ok: response.ok,
      status: response.status,
      text: bodyText,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      if (abortSignal?.aborted) {
        throw new Error(normalizeAbortReason(abortSignal.reason, "Campaign stop requested"));
      }
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
  }
}

async function fetchViaJina(url, options = {}) {
  const readerUrl = makeJinaReaderUrl(url);
  const result = await fetchText(readerUrl, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.requestTimeoutMs,
    abortSignal: options.abortSignal,
    headers: {
      Accept: "text/plain",
      "X-Return-Format": "text",
      "X-With-Generated-Alt": "true",
    },
  });

  if (!result.ok) {
    throw new Error(`Jina returned ${result.status}`);
  }
  if (isBlockedResponse(result.text)) {
    throw new Error("Jina returned blocked/access-denied page");
  }

  return {
    text: cleanText(result.text),
    links: extractInternalLinks(result.text, url),
    source: "jina",
  };
}

async function fetchViaPlaywright(url, options = {}) {
  if (!options.playwrightEnabled) {
    throw new Error("Playwright disabled");
  }

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    throw new Error(
      `Playwright layer requires playwright. Install with: npm install playwright && npx playwright install chromium. ${error.message}`
    );
  }

  const timeoutMs = Math.max(1000, options.playwrightTimeoutMs || DEFAULT_PLAYWRIGHT_TIMEOUT_MS);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForSelector("body", { timeout: Math.min(timeoutMs, 5000) });

    const { rawText, links, html } = await page.evaluate((origin) => {
      ["nav", "footer", "script", "style", "noscript", "header"].forEach((selector) => {
        document.querySelectorAll(selector).forEach((node) => node.remove());
      });
      const hrefs = Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => anchor.href)
        .filter((href) => typeof href === "string" && href.startsWith(origin));
      return {
        rawText: document.body ? document.body.innerText || "" : "",
        links: hrefs,
        html: document.documentElement ? document.documentElement.outerHTML || "" : "",
      };
    }, new URL(url).origin);

    if (isAntiBotChallengeHtml(html)) {
      throw new Error("Playwright was blocked by anti-bot challenge");
    }

    if (isBlockedResponse(rawText)) {
      throw new Error("Playwright returned blocked/access-denied page");
    }

    const cleanedLinks = Array.from(
      new Set(
        (Array.isArray(links) ? links : [])
          .map((link) => normalizeAbsoluteUrl(link, url))
          .filter((link) => link && !shouldSkipPath(link))
      )
    );

    return {
      text: cleanText(rawText),
      links: cleanedLinks,
      source: "playwright",
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function fetchViaGoogleCache(url, options = {}) {
  const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
  const readerUrl = makeJinaReaderUrl(cacheUrl);
  const result = await fetchText(readerUrl, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.requestTimeoutMs,
    abortSignal: options.abortSignal,
  });
  if (!result.ok) {
    throw new Error(`Google cache returned ${result.status}`);
  }

  const text = String(result.text || "");
  if (isBlockedResponse(text) || /did not match any documents/i.test(text)) {
    throw new Error("No Google cache available for this URL");
  }

  return {
    text: cleanText(text),
    links: extractInternalLinks(text, url),
    source: "google_cache",
  };
}

async function fetchWithChromeCookies(url, options = {}) {
  if (!options.chromeCookiesEnabled) {
    throw new Error("Chrome cookie layer disabled");
  }

  const cookieHeader = await getChromeCookiesForUrl(url, {
    userDataDir: options.chromeUserDataDir,
    profileName: options.chromeProfileName,
  });
  // Undici headers require ByteString-compatible values.
  const safeCookieHeader = Buffer.from(String(cookieHeader || ""), "utf8").toString("latin1").replace(/[\r\n]/g, "");

  const timeoutMs = Math.max(1000, toInt(options.chromeTimeoutMs, DEFAULT_CHROME_TIMEOUT_MS));
  const result = await fetchText(url, {
    fetchImpl: options.fetchImpl,
    timeoutMs,
    abortSignal: options.abortSignal,
    headers: {
      Cookie: safeCookieHeader,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "max-age=0",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    },
  });

  if (!result.ok) {
    throw new Error(`Chrome cookies fetch returned ${result.status}`);
  }

  if (isBlockedResponse(result.text)) {
    throw new Error("Chrome cookies fetch returned blocked/challenge page");
  }

  return {
    text: cleanText(result.text),
    links: extractInternalLinks(result.text, url),
    source: "chrome_cookies",
  };
}

function isChromeRunning() {
  if (process.platform !== "win32") {
    return false;
  }
  try {
    const result = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: "utf8" });
    return String(result || "").toLowerCase().includes("chrome.exe");
  } catch (_error) {
    return false;
  }
}

async function fetchViaChromeProfile(url, options = {}) {
  if (!options.chromeProfileEnabled) {
    throw new Error("Chrome profile layer disabled");
  }
  if (isChromeRunning()) {
    throw new Error("Chrome is currently open. Close Chrome before this layer can run.");
  }

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    throw new Error(
      `Chrome profile layer requires playwright. Install with: npm install playwright && npx playwright install chromium. ${error.message}`
    );
  }

  const userDataDir = compact(options.chromeUserDataDir);
  const executablePath = compact(options.chromeExecutablePath);
  const profileName = compact(options.chromeProfileName || "Default");
  const timeoutMs = Math.max(1000, toInt(options.chromeTimeoutMs, DEFAULT_CHROME_TIMEOUT_MS));

  if (!userDataDir || !executablePath) {
    throw new Error("CHROME_USER_DATA_DIR and CHROME_EXECUTABLE_PATH must be set");
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: false,
    args: [`--profile-directory=${profileName}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions-except="],
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    userAgent: DEFAULT_USER_AGENT,
    timeout: timeoutMs,
  });

  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForSelector("body", { timeout: Math.min(timeoutMs, 8000) });
    await page.waitForTimeout(1500);

    const { rawText, links, html } = await page.evaluate((origin) => {
      ["nav", "footer", "script", "style", "noscript", "header"].forEach((selector) => {
        document.querySelectorAll(selector).forEach((node) => node.remove());
      });
      const hrefs = Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => anchor.href)
        .filter((href) => typeof href === "string" && href.startsWith(origin));
      return {
        rawText: document.body ? document.body.innerText || "" : "",
        links: hrefs,
        html: document.documentElement ? document.documentElement.outerHTML || "" : "",
      };
    }, new URL(url).origin);

    if (isAntiBotChallengeHtml(html) || isBlockedResponse(rawText)) {
      throw new Error("Chrome profile returned blocked/challenge page");
    }

    return {
      text: cleanText(rawText),
      links: Array.from(
        new Set(
          (Array.isArray(links) ? links : [])
            .map((link) => normalizeAbsoluteUrl(link, url))
            .filter((link) => link && !shouldSkipPath(link))
        )
      ),
      source: "chrome_profile",
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function fetchViaSearchSnippet(url, options = {}) {
  if (!options.searchSnippetEnabled) {
    throw new Error("Search snippet disabled");
  }

  const domain = getDomainFromUrl(url);
  const companyName = getSearchSnippetCompanyName(options);
  const queries = buildSearchSnippetQueries(domain, companyName);
  if (queries.length === 0) {
    throw new Error("Search snippet query could not be built");
  }

  const errors = [];
  for (const query of queries) {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const readerUrl = makeJinaReaderUrl(searchUrl);
    const result = await fetchText(readerUrl, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.requestTimeoutMs,
      abortSignal: options.abortSignal,
      headers: {
        Accept: "text/plain",
        "X-Return-Format": "text",
      },
    });

    if (!result.ok) {
      errors.push(`query "${query}" returned ${result.status}`);
      continue;
    }

    const snippetText = extractSearchSnippetText(result.text, {
      domain,
      companyName,
      maxLines: Math.max(2, options.searchSnippetMaxLines || DEFAULT_SEARCH_SNIPPET_MAX_LINES),
    });
    if (!snippetText || snippetText.length < 30) {
      errors.push(`query "${query}" had no usable snippet`);
      continue;
    }

    return {
      text: `[Source: search snippet - direct site fetch was blocked]\n\n${snippetText}`,
      links: [],
      source: "search_snippet",
    };
  }

  const details = errors.length > 0 ? ` (${errors.join(" | ")})` : "";
  throw new Error(`Search snippet did not return usable company context${details}`);
}

async function fetchWebsiteContent(url, options = {}) {
  const targetUrl = normalizeAbsoluteUrl(url);
  if (!targetUrl) {
    const invalidError = new Error("Invalid URL");
    invalidError.layerTrace = [`[invalid] Invalid URL: ${String(url || "")}`];
    throw invalidError;
  }

  const layerTrace = [];
  const fetchMethod = options.profileSearchOnly ? "chrome_profile_search_test" : "chrome_profile";
  const profileSearchOnly = options.profileSearchOnly === true;
  const initialHeadless = toBool(options.chromeHeadless, false);
  const enableHeadfulFallback = initialHeadless && toBool(options.chromeHeadlessFallback, true);
  const headlessAttempts = enableHeadfulFallback ? [true, false] : [initialHeadless];

  let lastError = null;
  for (const attemptHeadless of headlessAttempts) {
    try {
      const result = await fetchViaRealChromeProfile(targetUrl, {
        ...options,
        profileSearchOnly,
        chromeHeadless: attemptHeadless,
      });
      layerTrace.push(`[ok] ${fetchMethod} succeeded headless=${attemptHeadless}`);
      return {
        ...result,
        fetchMethod,
        fetchTrace: layerTrace,
      };
    } catch (error) {
      const message = error?.message || "Unknown error";
      layerTrace.push(`[fail] ${fetchMethod} headless=${attemptHeadless}: ${message}`);
      lastError = error;
    }
  }

  const message = lastError?.message || "Unknown error";
  const monoLayerError = new Error(`${fetchMethod} failed for ${targetUrl}: ${message}`);
  monoLayerError.layerTrace = layerTrace.length > 0 ? layerTrace : [`[fail] ${fetchMethod}: ${message}`];
  throw monoLayerError;
}

function resolveSubPageCandidates(homepageText, homepageUrl, existingLinks = []) {
  const homepage = normalizeAbsoluteUrl(homepageUrl);
  if (!homepage) {
    return [];
  }
  const origin = new URL(homepage).origin;
  const pool = Array.isArray(existingLinks) && existingLinks.length > 0 ? existingLinks : extractInternalLinks(homepageText, homepage);
  const deduped = new Set();
  for (const link of pool) {
    const normalized = normalizeAbsoluteUrl(link, homepage);
    if (!normalized) {
      continue;
    }
    if (!normalized.startsWith(origin)) {
      continue;
    }
    if (normalizeAbsoluteUrl(normalized) === homepage) {
      continue;
    }
    if (shouldSkipPath(normalized)) {
      continue;
    }
    if (!isUsefulPath(normalized)) {
      continue;
    }
    deduped.add(normalized);
  }
  return Array.from(deduped);
}

async function fetchSubPages(homepageText, homepageUrl, existingLinks = [], options = {}) {
  if (!options.subpageFetchEnabled) {
    return [];
  }

  const candidates = resolveSubPageCandidates(homepageText, homepageUrl, existingLinks);
  const maxCount = Math.max(0, Number.isFinite(Number(options.subPageMaxCount)) ? Number(options.subPageMaxCount) : DEFAULT_SUBPAGE_MAX_COUNT);
  const targets = candidates.slice(0, maxCount);
  const results = [];

  for (const subUrl of targets) {
    try {
      const result = await fetchWebsiteContent(subUrl, options);
      const cleaned = cleanText(result.text);
      if (cleaned.length > 100) {
        results.push({
          url: subUrl,
          text: cleaned,
          source: result.fetchMethod,
        });
      }
    } catch (_error) {
      // Sub-page failures are isolated and ignored.
    }
  }

  return results;
}

function normalizeEnrichOptions(options = {}) {
  return {
    fetchImpl: options.fetchImpl || fetch,
    requestTimeoutMs: Math.max(1000, toInt(options.requestTimeoutMs, DEFAULT_TIMEOUT_MS)),
    playwrightEnabled: toBool(
      options.playwrightEnabled !== undefined ? options.playwrightEnabled : process.env.PLAYWRIGHT_ENABLED,
      false
    ),
    playwrightTimeoutMs: Math.max(
      1000,
      toInt(
        options.playwrightTimeoutMs !== undefined ? options.playwrightTimeoutMs : process.env.PLAYWRIGHT_TIMEOUT_MS,
        DEFAULT_PLAYWRIGHT_TIMEOUT_MS
      )
    ),
    subpageFetchEnabled: toBool(
      options.subpageFetchEnabled !== undefined ? options.subpageFetchEnabled : process.env.SUBPAGE_FETCH_ENABLED,
      true
    ),
    subPageMaxCount: Math.max(
      0,
      toInt(options.subPageMaxCount !== undefined ? options.subPageMaxCount : process.env.SUBPAGE_MAX_COUNT, DEFAULT_SUBPAGE_MAX_COUNT)
    ),
    chromeCookiesEnabled: toBool(
      options.chromeCookiesEnabled !== undefined ? options.chromeCookiesEnabled : process.env.CHROME_COOKIES_ENABLED,
      false
    ),
    chromeProfileEnabled: toBool(
      options.chromeProfileEnabled !== undefined ? options.chromeProfileEnabled : process.env.CHROME_PROFILE_ENABLED,
      false
    ),
    chromeExecutablePath: compact(
      options.chromeExecutablePath !== undefined ? options.chromeExecutablePath : process.env.CHROME_EXECUTABLE_PATH
    ),
    chromeUserDataDir: compact(
      options.chromeUserDataDir !== undefined ? options.chromeUserDataDir : process.env.CHROME_USER_DATA_DIR
    ),
    chromeAutomationUserDataDir: compact(
      options.chromeAutomationUserDataDir !== undefined
        ? options.chromeAutomationUserDataDir
        : process.env.CHROME_AUTOMATION_USER_DATA_DIR
    ),
    chromeForceMirrorProfile: toBool(
      options.chromeForceMirrorProfile !== undefined
        ? options.chromeForceMirrorProfile
        : process.env.CHROME_FORCE_MIRROR_PROFILE,
      true
    ),
    chromeProfileName: compact(
      options.chromeProfileName !== undefined
        ? options.chromeProfileName
        : process.env.CHROME_PROFILE_NAME || process.env.CHROME_PROFILE_DIRECTORY
    ) || "Default",
    chromeHeadless: toBool(
      options.chromeHeadless !== undefined ? options.chromeHeadless : process.env.CHROME_HEADLESS,
      false
    ),
    chromeHeadlessFallback: toBool(
      options.chromeHeadlessFallback !== undefined
        ? options.chromeHeadlessFallback
        : process.env.CHROME_HEADLESS_FALLBACK,
      true
    ),
    chromeTimeoutMs: Math.max(
      1000,
      toInt(options.chromeTimeoutMs !== undefined ? options.chromeTimeoutMs : process.env.CHROME_TIMEOUT_MS, DEFAULT_CHROME_TIMEOUT_MS)
    ),
    searchSnippetEnabled: toBool(
      options.searchSnippetEnabled !== undefined ? options.searchSnippetEnabled : process.env.SEARCH_SNIPPET_ENABLED,
      true
    ),
    searchSnippetMaxLines: Math.max(
      1,
      toInt(
        options.searchSnippetMaxLines !== undefined ? options.searchSnippetMaxLines : process.env.SEARCH_SNIPPET_MAX_LINES,
        DEFAULT_SEARCH_SNIPPET_MAX_LINES
      )
    ),
    companyName: getSearchSnippetCompanyName(options),
    profileSearchOnly: toBool(
      options.profileSearchOnly !== undefined ? options.profileSearchOnly : process.env.PROFILE_SEARCH_ONLY,
      false
    ),
    profileSearchWaitMs: Math.max(
      1000,
      toInt(
        options.profileSearchWaitMs !== undefined
          ? options.profileSearchWaitMs
          : process.env.CHROME_PROFILE_SEARCH_WAIT_MS,
        5000
      )
    ),
    campaignId: compact(options.campaignId),
    rowNumber: toInt(options.rowNumber, 0),
    rowIndex: toInt(options.rowIndex, 0),
    notifyUI: typeof options.notifyUI === "function" ? options.notifyUI : null,
    abortSignal: options.abortSignal || null,
  };
}

/**
 * @param {string} websiteUrl
 * @param {object} [options]
 * @returns {Promise<{content:string, fetchMethod:string, subPagesFetched:number, error:string|null, fetchTrace:string[]}>}
 */
async function enrichWebsiteContent(websiteUrl, options = {}) {
  const normalizedUrl = normalizeAbsoluteUrl(websiteUrl);
  if (!normalizedUrl) {
    return {
      content: "",
      fetchMethod: "none",
      subPagesFetched: 0,
      error: "Invalid website URL",
      fetchTrace: [`[invalid] Invalid URL: ${String(websiteUrl || "")}`],
    };
  }

  const runtimeOptions = normalizeEnrichOptions(options);
  let homepageResult;
  try {
    homepageResult = await fetchWebsiteContent(normalizedUrl, runtimeOptions);
  } catch (error) {
    return {
      content: "",
      fetchMethod: "none",
      subPagesFetched: 0,
      error: error.message || "Fetch failed",
      fetchTrace: Array.isArray(error?.layerTrace) ? error.layerTrace : [],
    };
  }

  let subPages = [];
  if (!runtimeOptions.profileSearchOnly) {
    try {
      subPages = await fetchSubPages(homepageResult.text, normalizedUrl, homepageResult.links || [], runtimeOptions);
    } catch (_error) {
      subPages = [];
    }
  }

  const combined = combinePageContent(homepageResult.text, subPages);
  return {
    content: combined,
    fetchMethod: compact(homepageResult.fetchMethod || homepageResult.source) || "none",
    subPagesFetched: subPages.length,
    error: null,
    fetchTrace: Array.isArray(homepageResult.fetchTrace) ? homepageResult.fetchTrace : [],
  };
}

module.exports = {
  USEFUL_PATH_PATTERNS,
  SKIP_PATH_PATTERNS,
  buildSearchSnippetQuery,
  buildSearchSnippetQueries,
  cleanText,
  combinePageContent,
  enrichWebsiteContent,
  extractSearchSnippetText,
  extractInternalLinks,
  fetchSubPages,
  fetchWithChromeCookies,
  fetchViaRealChromeProfile,
  fetchViaGoogleCache,
  fetchViaChromeProfile,
  fetchViaJina,
  fetchViaPlaywright,
  fetchViaSearchSnippet,
  fetchWebsiteContent,
  isChromeRunning,
  isBlockedResponse,
  makeJinaReaderUrl,
  normalizeAbsoluteUrl,
  resolveSubPageCandidates,
};
