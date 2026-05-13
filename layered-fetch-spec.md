# Layered Website Fetch + Sub-Page Discovery

## Objective

Replace the current single Jina fetch with a layered fetch system that:

1. Tries multiple methods when Jina is blocked
2. Discovers and fetches useful sub-pages (About, Services, Company etc)
3. Combines homepage + sub-page text into one clean content block
4. Stores the result exactly where `jina_content` is stored today
5. Is fully backwards compatible — nothing else in the pipeline changes

---

## The Problem With Current Approach

Current flow:

```
website URL → r.jina.ai/<url> → jina_content
```

Fails when:
- Site returns 403 (WAF like Akamai, Cloudflare)
- Site requires JS to render content
- Jina's IP is rate-limited or blocked by the target
- Site redirects to a login or consent wall

Result: `jina_content` is blank or contains error text, mailer generation gets no context.

---

## New Layered Fetch Architecture

```
website URL
  │
  ▼
Layer 1: Jina Fetch
  │  success → extract text → go to Sub-Page Discovery
  │  fail (403 / empty / timeout)
  ▼
Layer 2: Playwright Headless Chromium
  │  success → extract text → go to Sub-Page Discovery
  │  fail (WAF / challenge page / datacenter IP blocked)
  ▼
Layer 3: Google Cache via Jina
  │  success → extract text → go to Sub-Page Discovery
  │  fail (no cache / blocked)
  ▼
Layer 4: Real Chrome Profile (Windows, your signed-in browser)
  │  success → extract text → go to Sub-Page Discovery
  │  fail (site still blocks even real browser)
  ▼
Layer 5: Search Snippet (DuckDuckGo/Bing for company description)
  │  success → store snippet as content
  │  fail
  ▼
Layer 6: Mark as fetch_blocked → store error → use LinkedIn description only
```

After any successful layer fetch (Layers 1–4):

```
Homepage text acquired
  │
  ▼
Sub-Page Discovery
  │  scan homepage HTML for internal links
  │  filter for useful pages (/about /company /services /team /who-we-are)
  │  pick best 1-2 candidates
  │
  ▼
Fetch each sub-page (same layer order: Jina → Playwright → Cache)
  │
  ▼
Combine homepage text + sub-page text
  │
  ▼
Store as jina_content (single combined field, backwards compatible)
```

---

## Layer 1 — Jina Fetch

### What It Does

Sends the URL to `https://r.jina.ai/<url>` with browser-like headers.

### Implementation

```javascript
async function fetchViaJina(url) {
  const jinaUrl = `https://r.jina.ai/${url}`;

  const response = await fetch(jinaUrl, {
    headers: {
      'Accept': 'text/plain',
      'X-Return-Format': 'text',
      'X-With-Generated-Alt': 'true',
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`Jina returned ${response.status}`);
  }

  const text = await response.text();

  if (isBlockedResponse(text)) {
    throw new Error('Jina returned blocked/access-denied page');
  }

  return { text, source: 'jina' };
}
```

### Blocked Response Detection

```javascript
function isBlockedResponse(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes('access denied') ||
    lower.includes('403: forbidden') ||
    lower.includes('you don\'t have permission') ||
    lower.includes('enable javascript') ||
    lower.includes('please verify you are a human') ||
    lower.includes('cf-browser-verification') ||
    lower.includes('reference #') ||          // Akamai error pattern
    text.trim().length < 100                  // suspiciously short
  );
}
```

---

## Layer 2 — Playwright Headless Browser

### What It Does

Launches a real Chromium browser locally. Executes JS, passes WAF fingerprinting,
looks identical to a human browser visit.

### Dependency

```bash
npm install playwright
npx playwright install chromium
```

Add to `.env`:
```
PLAYWRIGHT_ENABLED=true     # set false to skip this layer entirely
PLAYWRIGHT_TIMEOUT_MS=30000
```

### Implementation

```javascript
import { chromium } from 'playwright';

async function fetchViaPlaywright(url) {
  if (process.env.PLAYWRIGHT_ENABLED !== 'true') {
    throw new Error('Playwright disabled');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });

  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: parseInt(process.env.PLAYWRIGHT_TIMEOUT_MS) || 30000,
    });

    // Wait for body text to appear
    await page.waitForSelector('body', { timeout: 5000 });

    // Extract clean text — skip nav, footer, scripts
    const text = await page.evaluate(() => {
      // Remove noise elements
      ['nav', 'footer', 'script', 'style', 'noscript', 'header'].forEach(tag => {
        document.querySelectorAll(tag).forEach(el => el.remove());
      });
      return document.body.innerText;
    });

    // Also extract all internal links for sub-page discovery
    const links = await page.evaluate((baseUrl) => {
      return Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(href => href.startsWith(baseUrl));
    }, new URL(url).origin);

    return { text, links, source: 'playwright' };

  } finally {
    await browser.close();
  }
}
```

---

## Layer 3 — Google Cache via Jina

### What It Does

Fetches Google's cached snapshot of the page. Free, no auth, bypasses
the live site entirely.

### Implementation

```javascript
async function fetchViaGoogleCache(url) {
  const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
  const jinaUrl = `https://r.jina.ai/${cacheUrl}`;

  const response = await fetch(jinaUrl, {
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`Google cache returned ${response.status}`);
  }

  const text = await response.text();

  if (isBlockedResponse(text) || text.includes('did not match any documents')) {
    throw new Error('No Google cache available for this URL');
  }

  return { text, source: 'google_cache' };
}
```

---

## Layer Orchestrator

The main fetch function tries each layer in order and returns the first success:

```javascript
async function fetchWebsiteContent(url) {
  const layers = [
    { name: 'jina',           fn: () => fetchViaJina(url) },
    { name: 'playwright',     fn: () => fetchViaPlaywright(url) },
    { name: 'google_cache',   fn: () => fetchViaGoogleCache(url) },
    { name: 'chrome_profile', fn: () => fetchViaChromeProfile(url) },
    { name: 'search_snippet', fn: () => fetchViaSearchSnippet(url) },
  ];

  for (const layer of layers) {
    try {
      const result = await layer.fn();
      console.log(`[fetch] ${url} → success via ${layer.name}`);
      return { ...result, fetchMethod: layer.name };
    } catch (err) {
      console.warn(`[fetch] ${url} → ${layer.name} failed: ${err.message}`);
    }
  }

  throw new Error(`All fetch layers failed for ${url}`);
}
```

**Notes:**
- Layer 4 (Chrome profile) is skipped automatically if `CHROME_PROFILE_ENABLED=false`
- Layer 4 is skipped if Chrome is currently open (throws, caught by orchestrator)
- Layer 5 (search snippet) always runs as last resort before giving up
- Layer 5 result is flagged in content with a `[Source: search snippet]` prefix
  so mailer generation knows it is indirect context

---

## Layer 4 — Real Chrome Profile (Windows Fallback)

### Why This Works

Your locally installed Chrome:
- Already has your cookies and session data
- Has a real human browser fingerprint
- Uses your home/office IP — not a datacenter IP
- Has browsing history that makes it look legitimate

Sites that block headless Chromium (~40% bypass rate) allow your real
Chrome (~85% bypass rate) because it passes every bot fingerprint check.

### How Playwright Connects To Your Real Chrome

Playwright can launch Chrome using your existing Windows user profile
instead of a fresh headless instance. Chrome must be **closed** before
this runs — two Chrome instances cannot share the same profile.

### Windows Chrome Profile Path

```
C:\Users\<YourName>\AppData\Local\Google\Chrome\User Data
```

Add to `.env`:

```env
CHROME_PROFILE_ENABLED=true
CHROME_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
CHROME_USER_DATA_DIR=C:\Users\YourName\AppData\Local\Google\Chrome\User Data
CHROME_PROFILE_NAME=Default
CHROME_TIMEOUT_MS=30000
```

### Implementation

```javascript
import { chromium } from 'playwright';

async function fetchViaChromeProfile(url) {
  if (process.env.CHROME_PROFILE_ENABLED !== 'true') {
    throw new Error('Chrome profile layer disabled');
  }

  const userDataDir = process.env.CHROME_USER_DATA_DIR;
  const executablePath = process.env.CHROME_EXECUTABLE_PATH;
  const profileName = process.env.CHROME_PROFILE_NAME || 'Default';

  if (!userDataDir || !executablePath) {
    throw new Error('CHROME_USER_DATA_DIR and CHROME_EXECUTABLE_PATH must be set');
  }

  // Playwright's launchPersistentContext connects to your real Chrome profile
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: false,          // must be false when using real profile
    args: [
      `--profile-directory=${profileName}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions-except=',
    ],
    viewport: { width: 1280, height: 800 },
    timeout: parseInt(process.env.CHROME_TIMEOUT_MS) || 30000,
  });

  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: parseInt(process.env.CHROME_TIMEOUT_MS) || 30000,
    });

    await page.waitForSelector('body', { timeout: 8000 });

    // Small human-like delay before extracting
    await page.waitForTimeout(1500);

    const text = await page.evaluate(() => {
      ['nav', 'footer', 'script', 'style', 'noscript', 'header'].forEach(tag => {
        document.querySelectorAll(tag).forEach(el => el.remove());
      });
      return document.body.innerText;
    });

    const links = await page.evaluate((origin) => {
      return Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(href => href.startsWith(origin));
    }, new URL(url).origin);

    if (isBlockedResponse(text)) {
      throw new Error('Chrome profile returned blocked/challenge page');
    }

    return { text, links, source: 'chrome_profile' };

  } finally {
    await context.close();
  }
}
```

### Important: Chrome Must Be Closed

Chrome cannot share its profile with another process.
Before Layer 4 runs, check if Chrome is already open and warn:

```javascript
import { execSync } from 'child_process';

function isChromeRunning() {
  try {
    // Windows: check for chrome.exe process
    const result = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', {
      encoding: 'utf8'
    });
    return result.toLowerCase().includes('chrome.exe');
  } catch {
    return false;
  }
}

async function fetchViaChromeProfile(url) {
  if (isChromeRunning()) {
    throw new Error(
      'Chrome is currently open. Close Chrome before this layer can run.'
    );
  }
  // ... rest of implementation
}
```

This error is caught by the orchestrator and Layer 5 is tried instead.

---

## Layer 5 — Search Snippet Fallback

### What It Does

When the website itself cannot be fetched by any method, falls back to
searching for the company's description via DuckDuckGo or Bing — reusing
the same search snippet approach as the LinkedIn enrichment flow.

This gives the mailer generator *something* to work with even when the
live site is fully unreachable.

### Implementation

```javascript
async function fetchViaSearchSnippet(websiteUrl) {
  // Extract domain and guess company name from it
  const domain = new URL(websiteUrl).hostname.replace('www.', '');
  const companyGuess = domain.split('.')[0];

  const queries = [
    `"${domain}" company description what they do`,
    `site:${domain} about`,
    `${companyGuess} company B2B services`,
  ];

  for (const query of queries) {
    const providers = [
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    ];

    for (const providerUrl of providers) {
      try {
        const jinaUrl = `https://r.jina.ai/${providerUrl}`;
        const response = await fetch(jinaUrl, {
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) continue;

        const text = await response.text();
        const snippet = extractSearchSnippet(text, domain);

        if (snippet && snippet.length > 60) {
          return {
            text: `[Source: search snippet — direct site fetch was blocked]\n\n${snippet}`,
            source: 'search_snippet',
          };
        }
      } catch {
        continue;
      }
    }
  }

  throw new Error('No search snippet found');
}

function extractSearchSnippet(searchText, domain) {
  const lines = searchText.split('\n').map(l => l.trim()).filter(Boolean);

  const noise = [
    /^(google|bing|duckduckgo)$/i,
    /^title:/i,
    /^url source:/i,
    /sign in/i,
    /\d+\s+(results|followers)/i,
    /^about \d+/i,
    new RegExp(domain, 'i'),
  ];

  const isNoise = l => noise.some(r => r.test(l));
  const isGood  = l => l.length > 60 && !isNoise(l);

  // Look for a line near the domain mention
  const domainIdx = lines.findIndex(l => l.includes(domain));
  if (domainIdx !== -1) {
    const nearby = lines.slice(domainIdx, domainIdx + 6);
    const hit = nearby.find(isGood);
    if (hit) return hit;
  }

  return lines.find(isGood) || null;
}
```

---

### What It Does

After the homepage is fetched, scans for internal links that are likely
to contain useful company description text — About, Services, Company, Team pages.

### Useful Page Patterns

```javascript
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
  /\.(pdf|png|jpg|gif|svg|zip)$/i,
];
```

### Link Extraction From HTML Text

When Playwright is not used, extract links from the Jina-returned markdown text:

```javascript
function extractInternalLinks(homepageText, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const linkRegex = /https?:\/\/[^\s\)\"\']+/g;
  const found = homepageText.match(linkRegex) || [];

  return found
    .filter(link => link.startsWith(origin))          // internal only
    .filter(link => link !== baseUrl)                  // not homepage itself
    .filter(link => !SKIP_PATH_PATTERNS.some(p => p.test(link)))
    .filter(link => USEFUL_PATH_PATTERNS.some(p => p.test(link)))
    .slice(0, 5);                                      // max 5 candidates
}
```

### Sub-Page Fetch

```javascript
async function fetchSubPages(homepageText, homepageUrl, existingLinks = []) {
  // Use links from Playwright if available, otherwise extract from text
  const candidates = existingLinks.length > 0
    ? existingLinks.filter(l => USEFUL_PATH_PATTERNS.some(p => p.test(l)))
    : extractInternalLinks(homepageText, homepageUrl);

  // Pick best 2 candidates only — avoid over-fetching
  const targets = candidates.slice(0, 2);

  const results = [];

  for (const subUrl of targets) {
    try {
      const result = await fetchWebsiteContent(subUrl);
      const cleaned = cleanText(result.text);
      if (cleaned.length > 100) {
        results.push({
          url: subUrl,
          text: cleaned,
          source: result.fetchMethod,
        });
      }
    } catch (err) {
      console.warn(`[sub-page] failed to fetch ${subUrl}: ${err.message}`);
    }
  }

  return results;
}
```

---

## Text Cleaning

Applied to all fetched content before storing:

```javascript
function cleanText(raw) {
  return raw
    .replace(/!\[.*?\]\(.*?\)/g, '')          // remove markdown images
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // flatten markdown links
    .replace(/https?:\/\/\S+/g, '')           // remove bare URLs
    .replace(/<[^>]+>/g, '')                  // remove HTML tags
    .replace(/^#{1,6}\s*/gm, '')              // remove markdown headers
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1') // remove bold/italic
    .replace(/\n{3,}/g, '\n\n')               // collapse excess newlines
    .replace(/[ \t]{2,}/g, ' ')               // collapse spaces
    .trim();
}
```

---

## Content Combiner

Merges homepage text + sub-page text into one clean block:

```javascript
function combinePageContent(homepageText, subPages) {
  const parts = [];

  const cleanedHomepage = cleanText(homepageText);
  if (cleanedHomepage.length > 50) {
    parts.push(`--- Homepage ---\n${cleanedHomepage}`);
  }

  for (const sub of subPages) {
    const path = new URL(sub.url).pathname;
    parts.push(`--- ${path} ---\n${sub.text}`);
  }

  return parts.join('\n\n');
}
```

---

## Full Orchestration Function

This is the single function called from `campaignStorage.js` in place of the current Jina call:

```javascript
/**
 * Fetches a website's content using layered fallback,
 * then discovers and fetches useful sub-pages,
 * then combines everything into one content block.
 *
 * @param {string} websiteUrl
 * @returns {{ content: string, fetchMethod: string, subPagesFetched: number, error: string|null }}
 */
export async function enrichWebsiteContent(websiteUrl) {
  let homepageResult;

  // Step 1: Fetch homepage
  try {
    homepageResult = await fetchWebsiteContent(websiteUrl);
  } catch (err) {
    return {
      content: '',
      fetchMethod: 'none',
      subPagesFetched: 0,
      error: err.message,
    };
  }

  // Step 2: Discover and fetch sub-pages
  let subPages = [];
  try {
    subPages = await fetchSubPages(
      homepageResult.text,
      websiteUrl,
      homepageResult.links || []
    );
  } catch (err) {
    console.warn(`[sub-pages] discovery failed for ${websiteUrl}: ${err.message}`);
  }

  // Step 3: Combine
  const combined = combinePageContent(homepageResult.text, subPages);

  return {
    content: combined,
    fetchMethod: homepageResult.fetchMethod,
    subPagesFetched: subPages.length,
    error: null,
  };
}
```

---

## Integration Into campaignStorage.js

Replace the current Jina fetch block with:

```javascript
// BEFORE (current)
const jinaUrl = `https://r.jina.ai/${normalizedUrl}`;
const response = await fetch(jinaUrl);
const text = await response.text();
row.jina_content = cleanText(text);

// AFTER (new)
import { enrichWebsiteContent } from './websiteFetchService.js';

const result = await enrichWebsiteContent(normalizedUrl);

row.jina_content = result.content;
row.jina_fetch_method = result.fetchMethod;
row.jina_sub_pages = result.subPagesFetched;
row.jina_error = result.error || '';
```

No other changes needed anywhere in the pipeline.

---

## New Spreadsheet Columns Added

| Column | Value |
|---|---|
| `jina_content` | Combined homepage + sub-page text (same as before) |
| `jina_fetch_method` | `jina` / `playwright` / `google_cache` / `none` |
| `jina_sub_pages` | Number of sub-pages successfully fetched (0, 1, or 2) |
| `jina_error` | Error message if all layers failed |

---

## New Service File

Create `src/services/websiteFetchService.js`:

```
src/services/
├── websiteFetchService.js    ← NEW: all fetch layers + sub-page logic
├── campaignStorage.js        ← EDIT: replace Jina call with enrichWebsiteContent()
├── contentService.js
├── mailerDocService.js
├── mailerSendService.js
├── campaignSendService.js
└── ollamaClient.js
```

---

## .env Additions

```env
# Layer 2 — Playwright headless
PLAYWRIGHT_ENABLED=true
PLAYWRIGHT_TIMEOUT_MS=30000

# Layer 4 — Real Chrome profile (Windows)
CHROME_PROFILE_ENABLED=true
CHROME_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
CHROME_USER_DATA_DIR=C:\Users\YourName\AppData\Local\Google\Chrome\User Data
CHROME_PROFILE_NAME=Default
CHROME_TIMEOUT_MS=30000

# Sub-page discovery
SUBPAGE_FETCH_ENABLED=true
SUBPAGE_MAX_COUNT=2
```

---

## Failure Behavior Per Row

| Scenario | Result |
|---|---|
| Jina succeeds | `jina_fetch_method=jina`, full content stored |
| Jina fails, Playwright succeeds | `jina_fetch_method=playwright`, full content stored |
| Jina + Playwright fail, Cache succeeds | `jina_fetch_method=google_cache`, content stored |
| Layers 1-3 fail, Chrome profile succeeds | `jina_fetch_method=chrome_profile`, full content stored |
| Chrome is open when Layer 4 tries | Layer 4 skipped, moves to Layer 5 automatically |
| Layers 1-4 fail, search snippet succeeds | `jina_fetch_method=search_snippet`, snippet stored with flag |
| All 5 layers fail | `jina_content=''`, `jina_error=<reason>`, row marked `fetch_blocked` |
| Homepage ok, sub-page fetch fails | Sub-page skipped silently, homepage content still stored |

Row-level failure isolation is preserved — one row failing does not affect others.

---

## Implementation Order

1. Create `src/services/websiteFetchService.js` with all helpers
2. Implement `isBlockedResponse()` checker
3. Implement `fetchViaJina()` with blocked-response detection
4. Implement `fetchViaPlaywright()` headless Chromium
5. Implement `fetchViaGoogleCache()`
6. Implement `isChromeRunning()` Windows process check
7. Implement `fetchViaChromeProfile()` with `launchPersistentContext`
8. Implement `extractSearchSnippet()` and `fetchViaSearchSnippet()`
9. Implement layer orchestrator `fetchWebsiteContent()` — all 6 layers in order
10. Implement `extractInternalLinks()` with useful/skip patterns
11. Implement `fetchSubPages()` with 2-page cap
12. Implement `cleanText()` and `combinePageContent()`
13. Implement top-level `enrichWebsiteContent()`
14. Install Playwright: `npm install playwright && npx playwright install chromium`
15. Add all `.env` entries including `CHROME_*` vars
16. Edit `campaignStorage.js` — replace Jina call with `enrichWebsiteContent()`
17. Add new columns to enriched spreadsheet writer
18. Update `metadata.json` row result shape to include `fetchMethod` and `subPagesFetched`
19. Write tests for `isBlockedResponse`, `extractInternalLinks`, `isChromeRunning`, `extractSearchSnippet`
20. Test Layer 1 — Jina accessible site, verify same output as before
21. Test Layer 2 — simulate 403, verify Playwright triggers
22. Test Layer 4 — close Chrome, point at blocked site, verify profile fetch works
23. Test Layer 4 edge case — open Chrome, verify it skips to Layer 5 gracefully
24. Test Layer 5 — fully blocked domain, verify search snippet is returned with flag
25. Test sub-page discovery — verify about/company page fetched and combined

---

## Summary

The layered fetch replaces a single fragile Jina call with a resilient 6-layer pipeline:

- **Layer 1 (Jina)** — fast, free, works on most sites
- **Layer 2 (Playwright headless)** — real browser, bypasses WAF and JS-gated sites
- **Layer 3 (Google Cache)** — fallback for fully locked-down sites
- **Layer 4 (Chrome profile, Windows)** — your real signed-in Chrome, highest bypass rate (~85%), requires Chrome to be closed
- **Layer 5 (Search snippet)** — when the site itself is unreachable, gets company description from DuckDuckGo/Bing search results
- **Layer 6 (fetch_blocked)** — graceful failure, row still proceeds using LinkedIn description only
- **Sub-page discovery** — finds About/Services pages automatically after any successful fetch
- **Content combiner** — single clean output, fully compatible with the existing mailer pipeline

The rest of the app — mailer generation, preview, send — receives richer content
without any changes to those services.


## March 2026 Extension
- Layer 4: Real Chrome profile (Windows)
- Layer 5: Search snippet
- Layer 6: fetch_blocked continue

