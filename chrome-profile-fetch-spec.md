# Real Chrome Profile Fetch — Full Implementation Spec

## What This Does

Launches your real installed Chrome with your existing profile and cookies.
Navigates to the target site visibly so you can see what is happening.
Handles three things automatically:

1. **Cookie consent popups** — clicks "Accept necessary/required" only, never "Accept all"
2. **Bot verification challenges** — pauses the run, alerts the dashboard UI, waits for you to solve it manually, then continues when you click Continue
3. **Auto-scroll** — scrolls the page to trigger lazy-loaded content before extracting text

Chrome stays open and visible the entire time so you can see every page load.

---

## Architecture

```
Campaign row hits Layer 4
  │
  ▼
Launch YOUR real Chrome (visible, with your profile)
  │
  ▼
Navigate to target URL
  │
  ├─ Cookie consent popup detected?
  │    → find and click "accept required/necessary" button only
  │    → never click "accept all"
  │
  ├─ Bot challenge / CAPTCHA detected?
  │    → pause the row
  │    → send alert to dashboard UI via SSE
  │    → dashboard shows popup: "Verification needed on <domain> — solve it in Chrome then click Continue"
  │    → wait for user to click Continue in dashboard
  │    → dashboard calls POST /api/campaigns/:id/resume-row
  │    → continue extraction
  │
  ├─ Auto-scroll the page
  │    → scroll in steps to trigger lazy content
  │    → wait briefly between scrolls
  │
  ▼
Extract page text
  │
  ▼
Return content → sub-page discovery → combine → store
```

---

## Layer Position

This replaces the current Layer 4 entirely:

```
Layer 1: Jina
Layer 2: Playwright headless Chromium
Layer 3: Google Cache via Jina
Layer 4: Real Chrome Profile (visible, with verification handling)  ← THIS SPEC
Layer 5: Search snippet fallback
Layer 6: fetch_blocked
```

---

## Part 1 — Chrome Profile Launch

### How Playwright Connects To Your Real Chrome

Playwright's `launchPersistentContext` connects to your existing Chrome installation
and uses your real profile — all your cookies, saved sessions, and browser history.

```javascript
// src/services/chromeProfileFetchService.js

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const DEFAULT_TIMEOUT_MS = 30000;
const SCROLL_STEPS = 8;
const SCROLL_STEP_DELAY_MS = 400;
const VERIFICATION_POLL_INTERVAL_MS = 2000;
const VERIFICATION_MAX_WAIT_MS = 300000; // 5 minutes max wait for user

/**
 * Resolves Chrome executable and user data dir from env or auto-detection.
 */
function resolveChromeConfig() {
  const executablePath =
    process.env.CHROME_EXECUTABLE_PATH ||
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  const userDataDir =
    process.env.CHROME_USER_DATA_DIR ||
    path.join(
      process.env.LOCALAPPDATA,
      'Google', 'Chrome', 'User Data'
    );

  const profileName = process.env.CHROME_PROFILE_NAME || 'Default';

  if (!fs.existsSync(executablePath)) {
    throw new Error(
      `Chrome not found at: ${executablePath}\n` +
      `Set CHROME_EXECUTABLE_PATH in your .env`
    );
  }

  if (!fs.existsSync(userDataDir)) {
    throw new Error(
      `Chrome user data not found at: ${userDataDir}\n` +
      `Set CHROME_USER_DATA_DIR in your .env`
    );
  }

  return { executablePath, userDataDir, profileName };
}
```

---

## Part 2 — Cookie Consent Handler

Detects and dismisses cookie consent popups by clicking only
"accept required" or "accept necessary" — never "accept all".

```javascript
/**
 * Detects cookie consent popup and clicks the minimal acceptance button.
 * Never clicks "Accept All" — only "Accept Required/Necessary/Essential".
 *
 * @returns {boolean} true if a consent popup was found and handled
 */
async function handleCookieConsent(page) {
  // Selectors for "accept required/necessary/essential" buttons
  // Ordered from most specific to least specific
  const ACCEPT_REQUIRED_SELECTORS = [
    // Text-based matches (most reliable)
    'button:has-text("Accept required")',
    'button:has-text("Accept necessary")',
    'button:has-text("Accept essential")',
    'button:has-text("Necessary only")',
    'button:has-text("Essential only")',
    'button:has-text("Reject all")',       // "Reject all" = reject tracking = accept only required
    'button:has-text("Decline")',
    'button:has-text("Decline all")',
    'button:has-text("No, thanks")',
    'button:has-text("Save preferences")',
    // Common consent framework IDs / classes
    '#onetrust-reject-all-handler',
    '#onetrust-accept-btn-handler',        // only if no reject button found
    '[data-testid="reject-all"]',
    '[data-testid="accept-necessary"]',
    '.cc-deny',
    '.cookie-reject',
    '.decline-cookies',
    '[aria-label*="necessary"]',
    '[aria-label*="required"]',
  ];

  // Selectors we explicitly AVOID (accept all tracking)
  const AVOID_SELECTORS = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Allow all")',
    'button:has-text("I agree")',
    'button:has-text("Agree to all")',
  ];

  // Check if a consent popup is visible at all
  const consentContainerSelectors = [
    '#onetrust-consent-sdk',
    '#cookieConsent',
    '.cookie-consent',
    '.cookie-banner',
    '.gdpr-banner',
    '[class*="cookie"]',
    '[id*="cookie"]',
    '[class*="consent"]',
    '[id*="consent"]',
    '[class*="gdpr"]',
  ];

  let consentVisible = false;
  for (const sel of consentContainerSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        consentVisible = true;
        break;
      }
    } catch { /* continue */ }
  }

  if (!consentVisible) return false;

  console.log('[chrome-profile] Cookie consent popup detected');

  // Try each accept-required selector in order
  for (const sel of ACCEPT_REQUIRED_SELECTORS) {
    // Skip if this matches an avoid selector
    const isAvoid = AVOID_SELECTORS.some(avoid =>
      sel.toLowerCase().includes(avoid.toLowerCase().replace('button:has-text("', '').replace('")', ''))
    );
    if (isAvoid) continue;

    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        console.log(`[chrome-profile] Clicked consent button: ${sel}`);
        await page.waitForTimeout(800);
        return true;
      }
    } catch { /* try next */ }
  }

  console.log('[chrome-profile] Consent popup found but no matching button — skipping');
  return false;
}
```

---

## Part 3 — Bot Challenge Detection

Detects CAPTCHAs, Cloudflare challenges, and other verification pages.

```javascript
/**
 * Returns true if the current page looks like a bot challenge.
 */
async function isBotChallenge(page) {
  const html = await page.evaluate(() =>
    document.documentElement?.outerHTML || ''
  ).catch(() => '');

  const text = await page.evaluate(() =>
    document.body?.innerText || ''
  ).catch(() => '');

  const lower = (html + text).toLowerCase();

  return (
    // Cloudflare
    lower.includes('cf-browser-verification') ||
    lower.includes('checking your browser') ||
    lower.includes('cf_chl_') ||
    lower.includes('ray id:') ||
    // reCAPTCHA / hCaptcha
    lower.includes('recaptcha') ||
    lower.includes('hcaptcha') ||
    lower.includes('g-recaptcha') ||
    // Generic CAPTCHA
    lower.includes('captcha') ||
    lower.includes('prove you are human') ||
    lower.includes('please verify') ||
    lower.includes('are you a robot') ||
    lower.includes('security check') ||
    lower.includes('unusual traffic') ||
    // Akamai
    lower.includes('reference #') ||
    lower.includes('access denied') ||
    // DataDome
    lower.includes('datadome') ||
    lower.includes('device verification')
  );
}
```

---

## Part 4 — Auto Scroll

Scrolls the page in steps to trigger lazy-loaded content (images, text sections, infinite scroll).

```javascript
/**
 * Scrolls the page from top to bottom in SCROLL_STEPS increments.
 * Pauses briefly between each step to allow lazy content to load.
 */
async function autoScroll(page) {
  await page.evaluate(async (steps, delayMs) => {
    const totalHeight = document.body.scrollHeight;
    const stepSize = Math.floor(totalHeight / steps);

    for (let i = 0; i <= steps; i++) {
      window.scrollTo(0, stepSize * i);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    // Scroll back to top
    window.scrollTo(0, 0);
  }, SCROLL_STEPS, SCROLL_STEP_DELAY_MS);
}
```

---

## Part 5 — Verification Pause and Resume

When a bot challenge is detected, the system:
1. Pauses the current row
2. Sends a Server-Sent Event (SSE) to the dashboard
3. Dashboard shows a popup with a Continue button
4. Waits for `POST /api/campaigns/:id/resume-row` from the dashboard
5. Continues extraction

### Backend — Verification State Manager

```javascript
// src/services/verificationStateService.js

/**
 * Stores pending verification requests.
 * Key: campaignId-rowIndex
 * Value: { resolve, reject, domain, timestamp }
 */
const pendingVerifications = new Map();

/**
 * Pauses a row and waits for the user to click Continue in the UI.
 * Resolves when resume-row is called, rejects on timeout.
 *
 * @param {string} campaignId
 * @param {number} rowIndex
 * @param {string} domain
 * @param {Function} notifyUI - function to send SSE event to dashboard
 */
export async function waitForManualVerification(campaignId, rowIndex, domain, notifyUI) {
  const key = `${campaignId}-${rowIndex}`;

  console.log(`[verification] Pausing row ${rowIndex} for manual verification on ${domain}`);

  // Notify the dashboard UI
  notifyUI({
    type: 'verification_required',
    campaignId,
    rowIndex,
    domain,
    message: `Bot verification detected on ${domain}. Solve it in Chrome then click Continue.`,
  });

  // Wait for user to click Continue
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingVerifications.delete(key);
      reject(new Error(`Verification timeout after 5 minutes for ${domain}`));
    }, VERIFICATION_MAX_WAIT_MS);

    pendingVerifications.set(key, {
      resolve: () => {
        clearTimeout(timeout);
        pendingVerifications.delete(key);
        resolve();
      },
      reject: (err) => {
        clearTimeout(timeout);
        pendingVerifications.delete(key);
        reject(err);
      },
      domain,
      timestamp: Date.now(),
    });
  });
}

/**
 * Called by POST /api/campaigns/:id/resume-row
 * Unblocks the waiting row.
 */
export function resumeVerification(campaignId, rowIndex) {
  const key = `${campaignId}-${rowIndex}`;
  const pending = pendingVerifications.get(key);

  if (!pending) {
    throw new Error(`No pending verification found for campaign ${campaignId} row ${rowIndex}`);
  }

  console.log(`[verification] User resumed row ${rowIndex} for ${pending.domain}`);
  pending.resolve();
}

/**
 * Returns all currently pending verifications.
 */
export function getPendingVerifications() {
  return Array.from(pendingVerifications.entries()).map(([key, val]) => ({
    key,
    domain: val.domain,
    waitingSinceMs: Date.now() - val.timestamp,
  }));
}
```

### Backend — New API Endpoints

Add to `src/server.js`:

```javascript
import { resumeVerification, getPendingVerifications } from './services/verificationStateService.js';

// SSE endpoint — dashboard connects here to receive real-time events
// including verification_required alerts
app.get('/api/campaigns/:id/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Register this response as the SSE channel for this campaign
  campaignSseClients.set(req.params.id, res);

  req.on('close', () => {
    campaignSseClients.delete(req.params.id);
  });
});

// Called by dashboard Continue button
app.post('/api/campaigns/:id/resume-row', (req, res) => {
  const { rowIndex } = req.body;
  try {
    resumeVerification(req.params.id, rowIndex);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Helper to send SSE event to dashboard
const campaignSseClients = new Map();

export function notifyCampaignUI(campaignId, event) {
  const client = campaignSseClients.get(campaignId);
  if (client) {
    client.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
```

---

## Part 6 — Main Chrome Profile Fetch Function

Puts all parts together:

```javascript
/**
 * Layer 4: Fetches a URL using your real Chrome profile.
 * Chrome is always visible. Handles consent, bot challenges, and scroll.
 *
 * @param {string} url
 * @param {object} options
 * @param {string} options.campaignId
 * @param {number} options.rowIndex
 * @param {Function} options.notifyUI
 */
export async function fetchViaRealChromeProfile(url, options = {}) {
  if (!options.chromeProfileEnabled) {
    throw new Error('Chrome profile layer disabled');
  }

  const { executablePath, userDataDir, profileName } = resolveChromeConfig();
  const timeoutMs = parseInt(process.env.CHROME_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  // Launch your real Chrome with your profile — always visible (headless: false)
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: false,                        // always visible
    args: [
      `--profile-directory=${profileName}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled', // hide automation flag
    ],
    ignoreDefaultArgs: ['--enable-automation'], // removes "Chrome is controlled by automation" bar
    viewport: { width: 1280, height: 800 },
    timeout: timeoutMs,
  });

  const page = await context.newPage();

  try {
    // Step 1: Navigate to target URL
    console.log(`[chrome-profile] Navigating to ${url}`);
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    // Small initial wait for page to settle
    await page.waitForTimeout(1500);

    // Step 2: Handle cookie consent popup
    await handleCookieConsent(page);

    // Step 3: Check for bot challenge
    if (await isBotChallenge(page)) {
      console.log(`[chrome-profile] Bot challenge detected on ${url}`);

      // Notify dashboard and wait for user to solve it
      await waitForManualVerification(
        options.campaignId,
        options.rowIndex,
        new URL(url).hostname,
        options.notifyUI || (() => {})
      );

      // User clicked Continue — wait for page to settle after verification
      await page.waitForTimeout(2000);

      // Check again — if still challenged, fail this layer
      if (await isBotChallenge(page)) {
        throw new Error(`Still blocked after manual verification on ${new URL(url).hostname}`);
      }

      // Handle any consent popup that appeared post-verification
      await handleCookieConsent(page);
    }

    // Step 4: Auto-scroll to load lazy content
    await autoScroll(page);

    // Step 5: Extract content
    const { rawText, links, html } = await page.evaluate((origin) => {
      // Remove noise elements before extracting
      ['nav', 'footer', 'script', 'style', 'noscript', 'header', 'aside'].forEach(tag => {
        document.querySelectorAll(tag).forEach(el => el.remove());
      });

      return {
        rawText: document.body?.innerText || '',
        links: Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.href)
          .filter(h => typeof h === 'string' && h.startsWith(origin)),
        html: document.documentElement?.outerHTML || '',
      };
    }, new URL(url).origin);

    // Final blocked check on extracted content
    if (isBlockedResponse(rawText)) {
      throw new Error('Chrome profile returned blocked/access-denied content');
    }

    if (rawText.trim().length < 100) {
      throw new Error('Chrome profile returned insufficient content');
    }

    console.log(`[chrome-profile] Successfully extracted ${rawText.length} chars from ${url}`);

    return {
      text: cleanText(rawText),
      links: links,
      source: 'chrome_profile',
    };

  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}
```

---

## Part 7 — Dashboard UI Changes

### SSE Connection On Page Load

```javascript
// In campaign.js — connect to SSE stream when campaign is active

let campaignEventSource = null;

function connectCampaignEvents(campaignId) {
  if (campaignEventSource) {
    campaignEventSource.close();
  }

  campaignEventSource = new EventSource(`/api/campaigns/${campaignId}/events`);

  campaignEventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleCampaignEvent(data);
  };

  campaignEventSource.onerror = () => {
    // Reconnect after 3 seconds
    setTimeout(() => connectCampaignEvents(campaignId), 3000);
  };
}

function handleCampaignEvent(event) {
  if (event.type === 'verification_required') {
    showVerificationPopup(event);
  }
}
```

### Verification Popup Component

```javascript
function showVerificationPopup({ campaignId, rowIndex, domain, message }) {
  // Remove any existing popup
  document.getElementById('verification-popup')?.remove();

  const popup = document.createElement('div');
  popup.id = 'verification-popup';
  popup.innerHTML = `
    <div class="verification-overlay">
      <div class="verification-modal">
        <div class="verification-icon">⚠</div>
        <h3>Verification Required</h3>
        <p class="verification-domain">${domain}</p>
        <p class="verification-message">${message}</p>
        <div class="verification-steps">
          <div class="step">1. Look at the Chrome window that opened</div>
          <div class="step">2. Complete the verification or CAPTCHA</div>
          <div class="step">3. Click Continue below when done</div>
        </div>
        <div class="verification-actions">
          <button
            class="btn-verification-continue"
            onclick="continueAfterVerification('${campaignId}', ${rowIndex})"
          >
            ✓ Continue
          </button>
          <button
            class="btn-verification-skip"
            onclick="skipVerificationRow('${campaignId}', ${rowIndex})"
          >
            Skip This Row
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(popup);

  // Also update the row status in queue to show ⚠ Awaiting Verification
  updateRowStatus(rowIndex, 'awaiting_verification');
}

async function continueAfterVerification(campaignId, rowIndex) {
  const res = await fetch(`/api/campaigns/${campaignId}/resume-row`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rowIndex }),
  });

  if (res.ok) {
    document.getElementById('verification-popup')?.remove();
    updateRowStatus(rowIndex, 'processing');
  }
}

async function skipVerificationRow(campaignId, rowIndex) {
  // Tell backend to skip this row and move to next
  await fetch(`/api/campaigns/${campaignId}/skip-row`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rowIndex }),
  });

  document.getElementById('verification-popup')?.remove();
}
```

### Verification Popup CSS

```css
.verification-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.verification-modal {
  background: var(--bg-surface);
  border: 1px solid var(--amber);
  border-radius: var(--radius-lg);
  padding: 32px;
  max-width: 480px;
  width: 90%;
  text-align: center;
}

.verification-icon {
  font-size: 48px;
  margin-bottom: 16px;
  color: var(--amber);
}

.verification-modal h3 {
  font-family: var(--font-mono);
  color: var(--amber);
  font-size: 18px;
  margin-bottom: 8px;
}

.verification-domain {
  font-family: var(--font-mono);
  color: var(--text-secondary);
  font-size: 13px;
  margin-bottom: 16px;
}

.verification-steps {
  background: var(--bg-elevated);
  border-radius: var(--radius-md);
  padding: 16px;
  margin: 20px 0;
  text-align: left;
}

.verification-steps .step {
  font-size: 13px;
  color: var(--text-secondary);
  padding: 4px 0;
  font-family: var(--font-mono);
}

.verification-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 20px;
}

.btn-verification-continue {
  background: var(--amber);
  color: #000;
  border: none;
  padding: 10px 24px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 14px;
  cursor: pointer;
  font-weight: 600;
}

.btn-verification-skip {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
  padding: 10px 24px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 14px;
  cursor: pointer;
}
```

---

## Part 8 — Row Status Addition

Add `awaiting_verification` to your existing status badge component:

```
awaiting_verification → amber pulse  ⚠  Awaiting Verification
```

In the queue display, when a row hits verification:
```
⚠  8  Helios Corp   helios.com   ⚠ Awaiting Verification   [popup is open]
```

---

## Part 9 — .env Additions

```env
# ── Real Chrome Profile (Layer 4) ───────────────────────────

CHROME_PROFILE_ENABLED=true

# Leave blank for auto-detection
CHROME_EXECUTABLE_PATH=
CHROME_USER_DATA_DIR=
CHROME_PROFILE_NAME=Default
CHROME_TIMEOUT_MS=30000
```

Auto-detection uses `LOCALAPPDATA` Windows env var — no manual path needed unless
Chrome is installed in a non-standard location.

---

## Part 10 — Update Layer Orchestrator

```javascript
import { fetchViaRealChromeProfile } from './chromeProfileFetchService.js';

const layers = [
  { name: 'jina',           fn: () => fetchViaJina(targetUrl, options) },
  { name: 'playwright',     fn: () => fetchViaPlaywright(targetUrl, options) },
  { name: 'google_cache',   fn: () => fetchViaGoogleCache(targetUrl, options) },
  {
    name: 'chrome_profile',
    fn: () => fetchViaRealChromeProfile(targetUrl, {
      ...options,
      chromeProfileEnabled: options.chromeProfileEnabled,
      campaignId: options.campaignId,
      rowIndex: options.rowIndex,
      notifyUI: options.notifyUI,         // SSE sender function
    }),
  },
  { name: 'search_snippet', fn: () => fetchViaSearchSnippet(targetUrl, options) },
];
```

---

## Implementation Checklist

```
□ Create src/services/chromeProfileFetchService.js
    □ resolveChromeConfig()
    □ handleCookieConsent()
    □ isBotChallenge()
    □ autoScroll()
    □ fetchViaRealChromeProfile()

□ Create src/services/verificationStateService.js
    □ waitForManualVerification()
    □ resumeVerification()
    □ getPendingVerifications()

□ Update src/server.js
    □ GET  /api/campaigns/:id/events       (SSE stream)
    □ POST /api/campaigns/:id/resume-row   (Continue button)
    □ POST /api/campaigns/:id/skip-row     (Skip button)
    □ notifyCampaignUI() helper

□ Update src/services/websiteFetchService.js
    □ Import fetchViaRealChromeProfile
    □ Replace chrome_cookies layer with chrome_profile

□ Update public/campaign.js
    □ connectCampaignEvents() on campaign start
    □ handleCampaignEvent() dispatcher
    □ showVerificationPopup()
    □ continueAfterVerification()
    □ skipVerificationRow()
    □ awaiting_verification row status

□ Update public/styles/campaign.css
    □ .verification-overlay
    □ .verification-modal
    □ .verification-steps
    □ .btn-verification-continue
    □ .btn-verification-skip

□ Add CHROME_PROFILE_ENABLED=true to .env

□ Test: site that accepts cookies → confirm popup dismissed automatically
□ Test: site with CAPTCHA → confirm dashboard popup appears → solve → confirm continues
□ Test: normal site → confirm scroll works and content is richer than without scroll
□ Test: Chrome auto-detection → confirm finds chrome.exe without manual path
```

---

## Summary

| Scenario | What Happens |
|---|---|
| Normal site | Chrome opens visibly, loads page, scrolls, extracts text |
| Cookie consent popup | Auto-clicks "accept required/necessary" — never "accept all" |
| Bot challenge / CAPTCHA | Dashboard shows amber popup, Chrome window is visible for you to solve, Continue button resumes |
| Verification timeout (5 min) | Row marked failed, campaign continues to next row |
| Skip clicked | Row skipped immediately, campaign moves on |
| Content extracted | Stored as `jina_fetch_method=chrome_profile` in spreadsheet |
