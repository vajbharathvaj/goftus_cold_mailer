# Website Data Extraction

This document explains the **exact website data extraction layers** used in this project, the end-to-end flow, and the layer code.

Source implementation:
- `src/services/websiteFetchService.js`
- `src/services/campaignStorage.js`

## Layer Order

`fetchWebsiteContent()` tries layers in this exact order:

1. `jina`
2. `playwright`
3. `google_cache`
4. `chrome_cookies`
5. `search_snippet`

If all fail, it throws `All fetch layers failed...` with a `layerTrace`.

## High-Level Flow

```text
Campaign row website URL
  -> normalize URL
  -> fetchWebsiteContent(url, options)
       -> Layer 1: Jina
       -> Layer 2: Playwright (if enabled)
       -> Layer 3: Google Cache via Jina
       -> Layer 4: Chrome cookies (if enabled)
       -> Layer 5: Search snippet fallback (if enabled)
  -> if one layer succeeds:
       -> discover useful internal sub-pages
       -> fetch sub-pages (same layered resolver)
       -> combine homepage + sub-pages
  -> return:
       content, fetchMethod, subPagesFetched, error, fetchTrace
  -> campaignStorage writes:
       jina_content, jina_error, jina_fetch_method, jina_sub_pages, jina_fetch_trace
```

## Core Helper (Block Detection)

```js
function isBlockedResponse(text) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  return (
    lower.includes("access denied") ||
    lower.includes("403: forbidden") ||
    lower.includes("you don't have permission") ||
    lower.includes("enable javascript") ||
    lower.includes("please verify you are a human") ||
    lower.includes("cf-browser-verification") ||
    lower.includes("reference #") ||
    lower.includes("captcha") ||
    raw.trim().length < 100
  );
}
```

## Layer 1: Jina

```js
async function fetchViaJina(url, options = {}) {
  const readerUrl = makeJinaReaderUrl(url);
  const result = await fetchText(readerUrl, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.requestTimeoutMs,
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
```

## Layer 2: Playwright

```js
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
```

## Layer 3: Google Cache

```js
async function fetchViaGoogleCache(url, options = {}) {
  const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
  const readerUrl = makeJinaReaderUrl(cacheUrl);
  const result = await fetchText(readerUrl, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.requestTimeoutMs,
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
```

## Layer 4: Chrome Cookies

```js
async function fetchWithChromeCookies(url, options = {}) {
  if (!options.chromeCookiesEnabled) {
    throw new Error("Chrome cookie layer disabled");
  }

  const cookieHeader = await getChromeCookiesForUrl(url, {
    userDataDir: options.chromeUserDataDir,
    profileName: options.chromeProfileName,
  });
  const safeCookieHeader = Buffer.from(String(cookieHeader || ""), "utf8").toString("latin1").replace(/[\r\n]/g, "");

  const timeoutMs = Math.max(1000, toInt(options.chromeTimeoutMs, DEFAULT_CHROME_TIMEOUT_MS));
  const result = await fetchText(url, {
    fetchImpl: options.fetchImpl,
    timeoutMs,
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
```

## Layer 5: Search Snippet Fallback

```js
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
```

## Layer Orchestrator

```js
async function fetchWebsiteContent(url, options = {}) {
  const targetUrl = normalizeAbsoluteUrl(url);
  if (!targetUrl) {
    const invalidError = new Error("Invalid URL");
    invalidError.layerTrace = [`[invalid] Invalid URL: ${String(url || "")}`];
    throw invalidError;
  }

  const layers = [
    { name: "jina", fn: () => fetchViaJina(targetUrl, options) },
    { name: "playwright", fn: () => fetchViaPlaywright(targetUrl, options) },
    { name: "google_cache", fn: () => fetchViaGoogleCache(targetUrl, options) },
    { name: "chrome_cookies", fn: () => fetchWithChromeCookies(targetUrl, options) },
    { name: "search_snippet", fn: () => fetchViaSearchSnippet(targetUrl, options) },
  ];

  const layerErrors = [];
  const layerTrace = [];
  for (const layer of layers) {
    try {
      const result = await layer.fn();
      console.log(`[website-fetch] ${targetUrl} succeeded via ${layer.name}`);
      layerTrace.push(`[ok] ${layer.name} succeeded`);
      return {
        ...result,
        fetchMethod: layer.name,
        fetchTrace: layerTrace,
      };
    } catch (error) {
      const message = error?.message || "Unknown error";
      console.warn(`[website-fetch] ${targetUrl} ${layer.name} failed: ${message}`);
      layerErrors.push(`${layer.name}: ${message}`);
      layerTrace.push(`[fail] ${layer.name}: ${message}`);
    }
  }

  const details = layerErrors.length > 0 ? `: ${layerErrors.join(" | ")}` : "";
  const finalError = new Error(`All fetch layers failed for ${targetUrl}${details}`);
  finalError.layerTrace = layerTrace;
  throw finalError;
}
```

## Sub-Page Discovery and Fetch

```js
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
```

## Final Enrichment Output

```js
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
  try {
    subPages = await fetchSubPages(homepageResult.text, normalizedUrl, homepageResult.links || [], runtimeOptions);
  } catch (_error) {
    subPages = [];
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
```

## How Campaign Pipeline Uses It

`campaignStorage.processCampaignRows()` calls `enrichWebsiteContent()` and persists output columns:

```js
const websiteResult = await enrichWebsiteContent(websiteUrl, {
  fetchImpl: this.fetchWithProxy.bind(this),
  requestTimeoutMs: this.requestTimeoutMs,
  playwrightEnabled: this.playwrightEnabled,
  playwrightTimeoutMs: this.playwrightTimeoutMs,
  subpageFetchEnabled: this.subpageFetchEnabled,
  subPageMaxCount: this.subPageMaxCount,
  chromeCookiesEnabled: this.chromeCookiesEnabled,
  chromeUserDataDir: this.chromeUserDataDir,
  chromeProfileName: this.chromeProfileDirectory,
  chromeTimeoutMs: this.chromeTimeoutMs,
  searchSnippetEnabled: this.searchSnippetEnabled,
  searchSnippetMaxLines: this.searchSnippetMaxLines,
  companyName: companyNameForFetch,
});

let websiteFetchWarning = websiteResult.error ? truncateCellText(websiteResult.error) : "";
let jinaContent = truncateCellText(websiteResult.content);
let jinaFetchMethod = compact(websiteResult.fetchMethod) || "none";
let jinaSubPages = toNonNegativeInt(websiteResult.subPagesFetched, 0);
let jinaFetchTrace = truncateCellText(formatFetchTrace(websiteResult.fetchTrace));
```

## Env Flags That Control Layers

- `PLAYWRIGHT_ENABLED`
- `PLAYWRIGHT_TIMEOUT_MS`
- `CHROME_COOKIES_ENABLED`
- `CHROME_USER_DATA_DIR`
- `CHROME_PROFILE_NAME` / `CHROME_PROFILE_DIRECTORY`
- `CHROME_TIMEOUT_MS`
- `SUBPAGE_FETCH_ENABLED`
- `SUBPAGE_MAX_COUNT`
- `SEARCH_SNIPPET_ENABLED`
- `SEARCH_SNIPPET_MAX_LINES`

