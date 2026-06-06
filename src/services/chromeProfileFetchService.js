const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { execSync } = require("node:child_process");
const { chromium } = require("playwright");

const DEFAULT_TIMEOUT_MS = 30000;
const SCROLL_STEPS = 8;
const SCROLL_STEP_DELAY_MS = 400;
const PROFILE_SEARCH_WAIT_MS = 10000;
const PROFILE_SEARCH_WINDOW_WIDTH = 960;
const PROFILE_SEARCH_WINDOW_HEIGHT = 900;

function compact(value) {
  return String(value || "").trim();
}

function normalizeAbortReason(reason, fallback = "Campaign stop requested") {
  const message = compact(reason?.message || reason);
  return message || fallback;
}

function randomInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

async function waitRandomDelay(minMs = 250, maxMs = 2000) {
  const delayMs = randomInt(minMs, maxMs);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return delayMs;
}

function normalizeGoogleResultTarget(rawUrl) {
  const normalized = compact(rawUrl);
  if (!normalized) {
    return "";
  }
  try {
    const parsed = new URL(normalized);
    const isGoogleHost = /(^|\.)google\./i.test(parsed.hostname);
    if (isGoogleHost && parsed.pathname === "/url") {
      const qParam = compact(parsed.searchParams.get("q") || parsed.searchParams.get("url"));
      if (/^https?:\/\//i.test(qParam)) {
        return qParam;
      }
    }
    return normalized;
  } catch (_error) {
    return "";
  }
}

function getLastUsedProfile(userDataDir) {
  try {
    const localStatePath = path.join(userDataDir, "Local State");
    if (!fs.existsSync(localStatePath)) {
      return "";
    }
    const parsed = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
    return compact(parsed?.profile?.last_used);
  } catch (_error) {
    return "";
  }
}

function listChromeProfileDirectories(userDataDir) {
  try {
    if (!userDataDir || !fs.existsSync(userDataDir)) {
      return [];
    }
    return fs
      .readdirSync(userDataDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => compact(entry.name))
      .filter((name) => name === "Default" || /^Profile \d+$/i.test(name));
  } catch (_error) {
    return [];
  }
}

function isDefaultChromeUserDataDir(userDataDir) {
  const localAppData = compact(process.env.LOCALAPPDATA);
  if (!localAppData) {
    return false;
  }
  const defaultPath = path.resolve(path.join(localAppData, "Google", "Chrome", "User Data"));
  const targetPath = path.resolve(String(userDataDir || ""));
  return defaultPath.toLowerCase() === targetPath.toLowerCase();
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch (_error) {
    return false;
  }
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function isLockedMirrorCopyError(error) {
  const code = String(error?.code || "").toUpperCase();
  return ["EBUSY", "EPERM", "EACCES", "ETXTBSY"].includes(code);
}

function shouldSkipMirrorCopy(relativePath) {
  const rel = toPosixPath(relativePath).toLowerCase();
  if (!rel) {
    return false;
  }
  const baseName = rel.split("/").pop() || "";
  if (
    [
      "singletonlock",
      "singletonsocket",
      "singletoncookie",
      "lock",
      "lockfile",
      "current session",
      "current tabs",
      "current session-journal",
      "current tabs-journal",
    ].includes(baseName)
  ) {
    return true;
  }
  return (
    rel === "network/cookies" ||
    rel === "network/cookies-journal" ||
    rel.endsWith("/network/cookies") ||
    rel.endsWith("/network/cookies-journal")
  );
}

function buildMirrorSessionId() {
  const now = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `session-${now}-${process.pid}-${rand}`;
}

async function pruneMirrorSessions(rootDir, { keep = 6, excludeDir = "" } = {}) {
  if (!rootDir || keep < 0) {
    return;
  }
  let entries;
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch (_error) {
    return;
  }

  const sessionDirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !String(entry.name || "").startsWith("session-")) {
      continue;
    }
    const fullPath = path.join(rootDir, entry.name);
    if (excludeDir && path.resolve(fullPath) === path.resolve(excludeDir)) {
      continue;
    }
    try {
      const stat = await fsp.stat(fullPath);
      sessionDirs.push({ fullPath, mtimeMs: stat.mtimeMs || 0 });
    } catch (_error) {
      // Ignore stale entries we cannot stat.
    }
  }

  sessionDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const overflow = sessionDirs.slice(Math.max(0, keep));
  for (const item of overflow) {
    try {
      await fsp.rm(item.fullPath, { recursive: true, force: true });
    } catch (error) {
      if (!isLockedMirrorCopyError(error)) {
        // Ignore cleanup-only errors and keep fetch flow running.
      }
    }
  }
}

async function copyDirectoryBestEffort(sourceDir, targetDir, baseDir = sourceDir) {
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  let copiedFiles = 0;
  let skippedFiles = 0;

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const relativePath = path.relative(baseDir, sourcePath);
    if (shouldSkipMirrorCopy(relativePath)) {
      skippedFiles += 1;
      continue;
    }
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await fsp.mkdir(targetPath, { recursive: true });
      const nested = await copyDirectoryBestEffort(sourcePath, targetPath, baseDir);
      copiedFiles += nested.copiedFiles;
      skippedFiles += nested.skippedFiles;
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    try {
      await fsp.copyFile(sourcePath, targetPath);
      copiedFiles += 1;
    } catch (error) {
      if (isLockedMirrorCopyError(error)) {
        skippedFiles += 1;
        continue;
      }
      throw error;
    }
  }

  return { copiedFiles, skippedFiles };
}

async function prepareMirroredUserDataDir({ sourceUserDataDir, profileName, mirrorUserDataDir }) {
  const sourceProfilePath = path.join(sourceUserDataDir, profileName);
  if (!(await pathExists(sourceProfilePath))) {
    throw new Error(`Source profile not found for mirroring: ${sourceProfilePath}`);
  }
  await fsp.mkdir(mirrorUserDataDir, { recursive: true });

  const mirrorSessionDir = path.join(mirrorUserDataDir, buildMirrorSessionId());
  await fsp.mkdir(mirrorSessionDir, { recursive: true });
  const targetProfilePath = path.join(mirrorSessionDir, profileName);
  try {
    await fsp.cp(sourceProfilePath, targetProfilePath, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: (srcPath) => {
        const rel = path.relative(sourceProfilePath, srcPath);
        return !shouldSkipMirrorCopy(rel);
      },
    });
  } catch (error) {
    if (!isLockedMirrorCopyError(error)) {
      throw error;
    }
    await fsp.mkdir(targetProfilePath, { recursive: true });
    const copyStats = await copyDirectoryBestEffort(sourceProfilePath, targetProfilePath, sourceProfilePath);
    if (copyStats.copiedFiles < 1) {
      throw new Error("Profile mirror fallback copied 0 files");
    }
  }

  const localStateSource = path.join(sourceUserDataDir, "Local State");
  if (await pathExists(localStateSource)) {
    try {
      await fsp.copyFile(localStateSource, path.join(mirrorSessionDir, "Local State"));
    } catch (error) {
      if (!isLockedMirrorCopyError(error)) {
        throw error;
      }
    }
  }

  const firstRunSource = path.join(sourceUserDataDir, "First Run");
  if (await pathExists(firstRunSource)) {
    try {
      await fsp.copyFile(firstRunSource, path.join(mirrorSessionDir, "First Run"));
    } catch (error) {
      if (!isLockedMirrorCopyError(error)) {
        throw error;
      }
    }
  }

  await pruneMirrorSessions(mirrorUserDataDir, { keep: 6, excludeDir: mirrorSessionDir });
  return mirrorSessionDir;
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

function resolveChromeConfig(options = {}) {
  const localAppData = compact(process.env.LOCALAPPDATA);
  const candidates = [
    compact(options.chromeExecutablePath || process.env.CHROME_EXECUTABLE_PATH),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate)) || "";
  if (!executablePath) {
    throw new Error("Chrome executable not found. Set CHROME_EXECUTABLE_PATH in .env.");
  }

  const userDataDir =
    compact(options.chromeUserDataDir || process.env.CHROME_USER_DATA_DIR) ||
    (localAppData ? path.join(localAppData, "Google", "Chrome", "User Data") : "");
  if (!userDataDir || !fs.existsSync(userDataDir)) {
    throw new Error("Chrome user data dir not found. Set CHROME_USER_DATA_DIR in .env.");
  }

  const explicitProfileFromEnv = compact(process.env.CHROME_PROFILE_NAME || process.env.CHROME_PROFILE_DIRECTORY);
  const profileFromOptions = compact(options.chromeProfileName);
  const autoDetectedProfile = getLastUsedProfile(userDataDir);
  const shouldAutoDetect = !explicitProfileFromEnv && (!profileFromOptions || profileFromOptions.toLowerCase() === "default");
  const requestedProfileName = shouldAutoDetect
    ? autoDetectedProfile || "Default"
    : profileFromOptions || explicitProfileFromEnv || autoDetectedProfile || "Default";
  const requestedProfileDirPath = path.join(userDataDir, requestedProfileName);
  let profileName = requestedProfileName;
  if (!fs.existsSync(requestedProfileDirPath)) {
    const availableProfiles = listChromeProfileDirectories(userDataDir);
    const fallbackProfile = [autoDetectedProfile, "Default", ...availableProfiles].find((candidate) =>
      fs.existsSync(path.join(userDataDir, candidate))
    );
    if (fallbackProfile) {
      profileName = fallbackProfile;
    } else {
      throw new Error(
        `Chrome profile directory not found: ${requestedProfileDirPath}. Available profiles: ${
          availableProfiles.length ? availableProfiles.join(", ") : "none"
        }. Set CHROME_PROFILE_NAME to a valid profile folder (e.g. Default, Profile 1).`
      );
    }
  }

  return {
    executablePath,
    userDataDir,
    profileName,
  };
}

function normalizeSelectorText(value) {
  return compact(value).toLowerCase();
}

function isUnsafeConsentText(value) {
  const text = normalizeSelectorText(value);
  return (
    text.includes("accept all") ||
    text.includes("allow all") ||
    text.includes("agree to all") ||
    text === "i agree"
  );
}

async function clickIfVisible(page, selector) {
  const locator = page.locator(selector).first();
  const count = await locator.count();
  if (count < 1) {
    return false;
  }
  if (!(await locator.isVisible().catch(() => false))) {
    return false;
  }
  const label = await locator.innerText().catch(() => selector);
  if (isUnsafeConsentText(label)) {
    return false;
  }
  await locator.click({ timeout: 1500 }).catch(() => {});
  return true;
}

async function clickIfVisibleAny(page, selector) {
  const locator = page.locator(selector).first();
  const count = await locator.count();
  if (count < 1) {
    return false;
  }
  if (!(await locator.isVisible().catch(() => false))) {
    return false;
  }
  await locator.click({ timeout: 1500 }).catch(() => {});
  return true;
}

async function handleCookieConsent(page) {
  const containerSelectors = [
    "#onetrust-consent-sdk",
    "#cookieConsent",
    ".cookie-consent",
    ".cookie-banner",
    ".gdpr-banner",
    '[class*="cookie"]',
    '[id*="cookie"]',
    '[class*="consent"]',
    '[id*="consent"]',
    '[class*="gdpr"]',
  ];

  let consentVisible = false;
  for (const selector of containerSelectors) {
    const node = page.locator(selector).first();
    if ((await node.count().catch(() => 0)) > 0 && (await node.isVisible().catch(() => false))) {
      consentVisible = true;
      break;
    }
  }
  if (!consentVisible) {
    return false;
  }

  const selectors = [
    'button:has-text("Accept required")',
    'button:has-text("Accept necessary")',
    'button:has-text("Accept essential")',
    'button:has-text("Necessary only")',
    'button:has-text("Essential only")',
    'button:has-text("Reject all")',
    'button:has-text("Decline")',
    'button:has-text("Decline all")',
    'button:has-text("No, thanks")',
    'button:has-text("Save preferences")',
    "#onetrust-reject-all-handler",
    '[data-testid="reject-all"]',
    '[data-testid="accept-necessary"]',
    ".cc-deny",
    ".cookie-reject",
    ".decline-cookies",
    '[aria-label*="necessary"]',
    '[aria-label*="required"]',
  ];

  for (const selector of selectors) {
    if (await clickIfVisible(page, selector)) {
      await page.waitForTimeout(800).catch(() => {});
      return true;
    }
  }
  return false;
}

async function handleAcceptAllCookieConsent(page) {
  const containerSelectors = [
    "#onetrust-consent-sdk",
    "#cookieConsent",
    ".cookie-consent",
    ".cookie-banner",
    ".gdpr-banner",
    '[class*="cookie"]',
    '[id*="cookie"]',
    '[class*="consent"]',
    '[id*="consent"]',
    '[class*="gdpr"]',
    "form[action*='consent']",
  ];

  let consentVisible = false;
  for (const selector of containerSelectors) {
    const node = page.locator(selector).first();
    if ((await node.count().catch(() => 0)) > 0 && (await node.isVisible().catch(() => false))) {
      consentVisible = true;
      break;
    }
  }
  if (!consentVisible) {
    return false;
  }

  const selectors = [
    'button:has-text("Accept all")',
    'button:has-text("Allow all")',
    'button:has-text("I agree")',
    "#L2AGLb",
    '[aria-label*="Accept all"]',
    '[data-testid*="accept-all"]',
    '[id*="accept"][id*="all"]',
    ".cc-allow",
    ".cookie-accept-all",
  ];

  for (const selector of selectors) {
    if (await clickIfVisibleAny(page, selector)) {
      await page.waitForTimeout(800).catch(() => {});
      return true;
    }
  }
  return false;
}

async function clickPopupDismissLocator(page, selector) {
  const locator = page.locator(selector);
  const count = Math.min(8, await locator.count().catch(() => 0));
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    const isVisible = await candidate.isVisible().catch(() => false);
    if (!isVisible) {
      continue;
    }
    const shouldSkip = await candidate
      .evaluate((node) => {
        const text = String(
          node?.textContent ||
            node?.getAttribute?.("aria-label") ||
            node?.getAttribute?.("title") ||
            node?.getAttribute?.("value") ||
            ""
        )
          .trim()
          .toLowerCase();
        const cookieContainer = node.closest(
          '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i]'
        );
        if (cookieContainer) {
          return true;
        }
        if (
          text.includes("accept all") ||
          text.includes("allow all") ||
          text.includes("agree") ||
          text.includes("consent")
        ) {
          return true;
        }
        return false;
      })
      .catch(() => true);
    if (shouldSkip) {
      continue;
    }
    await candidate.click({ timeout: 1200 }).catch(() => {});
    await page.waitForTimeout(350).catch(() => {});
    return true;
  }
  return false;
}

async function closeNonCookiePopups(page, log = () => {}, label = "page") {
  const selectors = [
    '[role="dialog"] button[aria-label*="close" i]',
    '[role="dialog"] [aria-label*="close" i]',
    '[aria-modal="true"] button[aria-label*="close" i]',
    '[class*="modal" i] button[aria-label*="close" i]',
    '[class*="popup" i] button[aria-label*="close" i]',
    '[id*="modal" i] button[aria-label*="close" i]',
    '[id*="popup" i] button[aria-label*="close" i]',
    '[role="dialog"] button:has-text("Close")',
    '[role="dialog"] button:has-text("Dismiss")',
    '[role="dialog"] button:has-text("No thanks")',
    '[role="dialog"] button:has-text("Not now")',
    '[role="dialog"] button:has-text("Maybe later")',
    '[aria-modal="true"] button:has-text("Close")',
    '[aria-modal="true"] button:has-text("Dismiss")',
    '[aria-modal="true"] button:has-text("No thanks")',
    '[aria-modal="true"] button:has-text("Not now")',
    '[class*="modal" i] button:has-text("Close")',
    '[class*="popup" i] button:has-text("Close")',
    '[class*="overlay" i] button:has-text("Close")',
    '[data-testid*="close" i]',
    'button[aria-label="Close"]',
    'button[aria-label="Dismiss"]',
    'button[title="Close"]',
    ".modal-close",
    ".popup-close",
    ".close-modal",
    ".close-popup",
    ".newsletter-close",
    '[class*="close" i][role="button"]',
  ];

  let closedCount = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.press("Escape").catch(() => {});
    let closedInAttempt = false;
    for (const selector of selectors) {
      const clicked = await clickPopupDismissLocator(page, selector);
      if (clicked) {
        closedCount += 1;
        closedInAttempt = true;
        break;
      }
    }
    if (!closedInAttempt) {
      break;
    }
  }

  if (closedCount > 0) {
    log(`profile-search-only ${label} non-cookie popups closed=${closedCount}`);
  }
  return closedCount;
}

function analyzeProtectionSignals({ html = "", text = "", title = "", url = "", documentStatus = 0 } = {}) {
  const normalizedHtml = String(html || "");
  const normalizedText = String(text || "");
  const normalizedTitle = String(title || "");
  const normalizedUrl = String(url || "");
  const normalizedStatus = Number.isFinite(Number(documentStatus)) ? Number(documentStatus) : 0;
  const lower = `${normalizedTitle}\n${normalizedText}\n${normalizedHtml}\n${normalizedUrl}`.toLowerCase();
  const textLen = normalizedText.trim().length;
  const htmlLen = normalizedHtml.trim().length;
  const sparseShell = textLen < 160 && htmlLen < 6000;

  const hasCloudflareChallenge =
    lower.includes("cf-browser-verification") ||
    lower.includes("cf_chl_") ||
    lower.includes("checking your browser") ||
    lower.includes("ray id:") ||
    lower.includes("cf-ray");
  const hasDataDomeChallenge = lower.includes("datadome");
  const hasKasadaMarker =
    lower.includes("window.kpsdk") ||
    lower.includes("x-kpsdk") ||
    lower.includes("kp_uidz") ||
    /\/ips\.js(?:[?&]|$)/i.test(lower);
  const hasCaptchaWord = /\bcaptcha\b/i.test(lower);
  const hasCaptchaWidget =
    lower.includes("g-recaptcha") ||
    lower.includes("hcaptcha") ||
    lower.includes("recaptcha/api.js") ||
    lower.includes("data-sitekey");
  const hasStrongChallengePhrase =
    lower.includes("please verify you are a human") ||
    lower.includes("prove you are human") ||
    lower.includes("are you a robot") ||
    lower.includes("unusual traffic") ||
    lower.includes("security check") ||
    lower.includes("device verification");
  const hasBlockedPhrase =
    lower.includes("access denied") ||
    lower.includes("403: forbidden") ||
    lower.includes("you don't have permission") ||
    lower.includes("request blocked");

  const isKasadaProtected = hasKasadaMarker && (normalizedStatus === 429 || sparseShell || hasBlockedPhrase);
  const requiresHumanVerification =
    !isKasadaProtected &&
    (hasCloudflareChallenge ||
      hasDataDomeChallenge ||
      ((hasCaptchaWidget || hasCaptchaWord) && (hasStrongChallengePhrase || hasBlockedPhrase)) ||
      (hasStrongChallengePhrase && sparseShell));

  return {
    requiresHumanVerification,
    isKasadaProtected,
    hasBlockedPhrase,
    hasKasadaMarker,
    textLen,
    htmlLen,
    documentStatus: normalizedStatus,
  };
}

async function getProtectionSignals(page, { documentStatus = 0 } = {}) {
  const payload = await page
    .evaluate(() => ({
      html: document.documentElement?.outerHTML || "",
      text: document.body?.innerText || "",
      title: document.title || "",
      url: window.location.href || "",
    }))
    .catch(() => ({ html: "", text: "", title: "", url: "" }));
  return analyzeProtectionSignals({
    ...payload,
    documentStatus,
  });
}

async function isBotChallenge(page, options = {}) {
  const signals = await getProtectionSignals(page, options);
  return signals.requiresHumanVerification;
}

async function autoScroll(page) {
  await page.evaluate(
    async ({ steps, delayMs }) => {
      const totalHeight = Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0,
        window.innerHeight
      );
      const stepSize = Math.max(1, Math.floor(totalHeight / steps));
      for (let index = 0; index <= steps; index += 1) {
        window.scrollTo(0, stepSize * index);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      window.scrollTo(0, 0);
    },
    { steps: SCROLL_STEPS, delayMs: SCROLL_STEP_DELAY_MS }
  );
}

async function randomHumanScrollDownAndBackTop(page, options = {}) {
  const minScrolls = Math.max(1, Number.parseInt(options.minScrolls, 10) || 3);
  const maxScrolls = Math.max(minScrolls, Number.parseInt(options.maxScrolls, 10) || 7);
  const minStepPx = Math.max(50, Number.parseInt(options.minStepPx, 10) || 220);
  const maxStepPx = Math.max(minStepPx, Number.parseInt(options.maxStepPx, 10) || 620);
  const minDelayMs = Math.max(80, Number.parseInt(options.minDelayMs, 10) || 180);
  const maxDelayMs = Math.max(minDelayMs, Number.parseInt(options.maxDelayMs, 10) || 700);
  const scrollCount = randomInt(minScrolls, maxScrolls);
  const viewport = page.viewportSize() || { width: 1280, height: 800 };
  const maxX = Math.max(120, viewport.width - 40);
  const maxY = Math.max(120, viewport.height - 40);
  const minY = Math.max(80, Math.floor(maxY * 0.3));

  for (let index = 0; index < scrollCount; index += 1) {
    const targetX = randomInt(80, maxX);
    const targetY = randomInt(minY, maxY);
    const moveSteps = randomInt(8, 24);
    const distance = randomInt(minStepPx, maxStepPx);
    await page.mouse.move(targetX, targetY, { steps: moveSteps }).catch(() => {});
    await page.mouse.wheel(0, distance).catch(() => {});
    // Keep a scrollBy fallback so scrolling still happens if wheel is swallowed by an element.
    await page
      .evaluate((delta) => {
        window.scrollBy({ top: delta, left: 0, behavior: "smooth" });
      }, Math.max(40, Math.floor(distance * 0.12)))
      .catch(() => {});
    await page.waitForTimeout(randomInt(minDelayMs, maxDelayMs)).catch(() => {});
  }

  await page.mouse.move(randomInt(80, maxX), randomInt(60, Math.max(80, Math.floor(maxY * 0.25))), {
    steps: randomInt(10, 24),
  }).catch(() => {});
  await page
    .evaluate(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
    })
    .catch(() => {});
  await page.waitForTimeout(randomInt(minDelayMs, maxDelayMs)).catch(() => {});

  return scrollCount;
}

async function findFirstGoogleResultUrl(page) {
  return page.evaluate(() => {
    const normalizeGoogleTarget = (rawUrl) => {
      const value = String(rawUrl || "").trim();
      if (!value) {
        return "";
      }
      try {
        const parsed = new URL(value);
        const isGoogleHost = /(^|\.)google\./i.test(parsed.hostname);
        if (isGoogleHost && parsed.pathname === "/url") {
          const qParam = String(parsed.searchParams.get("q") || parsed.searchParams.get("url") || "").trim();
          if (/^https?:\/\//i.test(qParam)) {
            return qParam;
          }
        }
        return value;
      } catch (_error) {
        return "";
      }
    };

    const candidateAnchors = Array.from(document.querySelectorAll("#search a[href], a[href]"));
    for (const anchor of candidateAnchors) {
      const href = normalizeGoogleTarget(anchor.href);
      if (!href || !/^https?:\/\//i.test(href)) {
        continue;
      }
      const lower = href.toLowerCase();
      if (
        lower.includes("google.com/search?") ||
        lower.includes("accounts.google.com") ||
        lower.includes("policies.google.com") ||
        lower.includes("/preferences?") ||
        lower.includes("/settings?")
      ) {
        continue;
      }
      // Prefer visible result cards that actually have a heading.
      if (anchor.closest("#search") && anchor.querySelector("h3")) {
        return href;
      }
    }
    return "";
  });
}

async function openFirstGoogleResult(page, { timeoutMs, log }) {
  const firstResultUrlRaw = await findFirstGoogleResultUrl(page);
  const firstResultUrl = normalizeGoogleResultTarget(firstResultUrlRaw);
  if (!firstResultUrl) {
    throw new Error("Could not find a first result link on the search page");
  }

  log(`profile-search-only opening first result url=${firstResultUrl}`);
  // Use a trusted Playwright click first. Some redirect chains/popup flows are gated on trusted user gestures.
  const candidates = page.locator("#search a[href]:has(h3), a[href]:has(h3)");
  const candidateCount = Math.min(await candidates.count().catch(() => 0), 25);
  let clickedWithTrustedGesture = false;
  for (let index = 0; index < candidateCount; index += 1) {
    const anchor = candidates.nth(index);
    const href = normalizeGoogleResultTarget(await anchor.getAttribute("href").catch(() => ""));
    if (!href || href !== firstResultUrl) {
      continue;
    }

    const popupPromise = page.context().waitForEvent("page", { timeout: 4500 }).catch(() => null);
    await anchor.scrollIntoViewIfNeeded().catch(() => {});
    await anchor.click({ button: "left", delay: 60, timeout: timeoutMs }).catch(() => {});
    clickedWithTrustedGesture = true;

    const popup = await popupPromise;
    if (popup) {
      await popup.bringToFront().catch(() => {});
      await popup.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
      await popup.waitForLoadState("load", { timeout: timeoutMs }).catch(() => {});
      return popup;
    }
    await page.waitForTimeout(900).catch(() => {});
    if (!/google\./i.test(page.url())) {
      await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
      await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => {});
      await page.bringToFront().catch(() => {});
      return page;
    }
    break;
  }

  if (clickedWithTrustedGesture) {
    log("profile-search-only trusted click did not navigate away from Google; trying fallback click path");
  }

  const popupPromise = page.context().waitForEvent("page", { timeout: 2500 }).catch(() => null);
  const clicked = await page.evaluate((url) => {
    const normalizeGoogleTarget = (rawUrl) => {
      const value = String(rawUrl || "").trim();
      if (!value) {
        return "";
      }
      try {
        const parsed = new URL(value);
        const isGoogleHost = /(^|\.)google\./i.test(parsed.hostname);
        if (isGoogleHost && parsed.pathname === "/url") {
          const qParam = String(parsed.searchParams.get("q") || parsed.searchParams.get("url") || "").trim();
          if (/^https?:\/\//i.test(qParam)) {
            return qParam;
          }
        }
        return value;
      } catch (_error) {
        return "";
      }
    };

    const anchors = Array.from(document.querySelectorAll("#search a[href], a[href]"));
    const found = anchors.find((anchor) => normalizeGoogleTarget(anchor.href) === url);
    if (!found) {
      return false;
    }
    found.scrollIntoView({ block: "center", inline: "center" });
    found.click();
    return true;
  }, firstResultUrl);

  if (clicked) {
    const popup = await popupPromise;
    if (popup) {
      await popup.bringToFront().catch(() => {});
      await popup.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
      await popup.waitForLoadState("load", { timeout: timeoutMs }).catch(() => {});
      return popup;
    }
    if (!/google\./i.test(page.url())) {
      await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
      await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => {});
      await page.bringToFront().catch(() => {});
      return page;
    }
  }

  // Fallback when click does not navigate due to page script restrictions.
  await page.goto(firstResultUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => {});
  await page.bringToFront().catch(() => {});
  return page;
}

async function waitForRedirectSettle(page, { timeoutMs, log, label = "page" } = {}) {
  const settleTimeoutMs = Math.max(1000, Math.min(timeoutMs || DEFAULT_TIMEOUT_MS, 15000));
  const pollMs = 250;
  const stableWindowMs = 1750;
  const deadline = Date.now() + settleTimeoutMs;
  let lastUrl = compact(page.url()) || "about:blank";
  let lastChangeAt = Date.now();

  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs).catch(() => {});
    const currentUrl = compact(page.url()) || "about:blank";
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      lastChangeAt = Date.now();
      continue;
    }
    if (Date.now() - lastChangeAt >= stableWindowMs && currentUrl !== "about:blank") {
      break;
    }
  }

  await page.waitForLoadState("domcontentloaded", { timeout: settleTimeoutMs }).catch(() => {});
  await page.waitForLoadState("load", { timeout: settleTimeoutMs }).catch(() => {});
  log(`profile-search-only ${label} redirect settle url=${compact(page.url()) || "about:blank"}`);
}

async function findAboutLinkUrl(page, baseUrl) {
  const safeBaseUrl = compact(baseUrl);
  if (!safeBaseUrl) {
    return "";
  }
  let origin = "";
  try {
    origin = new URL(safeBaseUrl).origin;
  } catch (_error) {
    return "";
  }

  return page
    .evaluate(({ expectedOrigin, currentUrl }) => {
      const normalizeSpace = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
      const toAbsolute = (value) => {
        try {
          return new URL(String(value || "").trim(), currentUrl).toString();
        } catch (_error) {
          return "";
        }
      };

      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const candidates = [];
      for (const [index, anchor] of anchors.entries()) {
        const hrefRaw = anchor.getAttribute("href") || anchor.href;
        const href = toAbsolute(hrefRaw);
        if (!href || !/^https?:\/\//i.test(href)) {
          continue;
        }

        let parsed;
        try {
          parsed = new URL(href);
        } catch (_error) {
          continue;
        }

        if (parsed.origin !== expectedOrigin) {
          continue;
        }

        const path = normalizeSpace(parsed.pathname || "");
        if (!path || path === "/") {
          continue;
        }
        if (/privacy|cookie|terms|policy/.test(path)) {
          continue;
        }

        const text = normalizeSpace(anchor.textContent || "");
        const ariaLabel = normalizeSpace(anchor.getAttribute("aria-label") || "");
        const title = normalizeSpace(anchor.getAttribute("title") || "");
        const combinedLabel = `${text} ${ariaLabel} ${title}`.trim();
        const matchesAboutText =
          /\babout\b/.test(combinedLabel) ||
          combinedLabel.includes("about us") ||
          combinedLabel.includes("our story") ||
          combinedLabel.includes("who we are");
        const matchesAboutPath =
          /\/about(?:[/?#]|$)/i.test(parsed.pathname) ||
          /\/about-us(?:[/?#]|$)/i.test(parsed.pathname) ||
          /\/our-story(?:[/?#]|$)/i.test(parsed.pathname) ||
          /\/who-we-are(?:[/?#]|$)/i.test(parsed.pathname);
        if (!matchesAboutText && !matchesAboutPath) {
          continue;
        }

        let score = 0;
        if (matchesAboutText) {
          score += 3;
        }
        if (matchesAboutPath) {
          score += 3;
        }
        if (path === "/about" || path === "/about-us") {
          score += 2;
        }
        if (text === "about" || text === "about us") {
          score += 2;
        }
        candidates.push({ href, score, index });
      }

      candidates.sort((a, b) => b.score - a.score || a.index - b.index);
      return candidates[0]?.href || "";
    }, { expectedOrigin: origin, currentUrl: page.url() })
    .catch(() => "");
}

async function findServicesLinkUrl(page, baseUrl) {
  const safeBaseUrl = compact(baseUrl);
  if (!safeBaseUrl) {
    return "";
  }
  let origin = "";
  try {
    origin = new URL(safeBaseUrl).origin;
  } catch (_error) {
    return "";
  }

  return page
    .evaluate(({ expectedOrigin, currentUrl }) => {
      const normalizeSpace = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
      const toAbsolute = (value) => {
        try {
          return new URL(String(value || "").trim(), currentUrl).toString();
        } catch (_error) {
          return "";
        }
      };

      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const candidates = [];
      for (const [index, anchor] of anchors.entries()) {
        const hrefRaw = anchor.getAttribute("href") || anchor.href;
        const href = toAbsolute(hrefRaw);
        if (!href || !/^https?:\/\//i.test(href)) {
          continue;
        }

        let parsed;
        try {
          parsed = new URL(href);
        } catch (_error) {
          continue;
        }

        if (parsed.origin !== expectedOrigin) {
          continue;
        }

        const path = normalizeSpace(parsed.pathname || "");
        if (!path || path === "/") {
          continue;
        }
        if (/privacy|cookie|terms|policy|careers|jobs|blog|news|press/.test(path)) {
          continue;
        }

        const text = normalizeSpace(anchor.textContent || "");
        const ariaLabel = normalizeSpace(anchor.getAttribute("aria-label") || "");
        const title = normalizeSpace(anchor.getAttribute("title") || "");
        const combinedLabel = `${text} ${ariaLabel} ${title}`.trim();
        const matchesServicesText =
          /\bservices?\b/.test(combinedLabel) ||
          /\bproducts?\b/.test(combinedLabel) ||
          /\bsolutions?\b/.test(combinedLabel) ||
          /\bofferings?\b/.test(combinedLabel) ||
          /\bcapabilities\b/.test(combinedLabel) ||
          /\bfeatures?\b/.test(combinedLabel) ||
          combinedLabel.includes("what we do") ||
          combinedLabel.includes("what we offer");
        const matchesServicesPath =
          /\/services?(?:[/?#]|$)/i.test(parsed.pathname) ||
          /\/products?(?:[/?#]|$)/i.test(parsed.pathname) ||
          /\/solutions?(?:[/?#]|$)/i.test(parsed.pathname) ||
          /\/offerings?(?:[/?#]|$)/i.test(parsed.pathname) ||
          /\/capabilities(?:[/?#]|$)/i.test(parsed.pathname) ||
          /\/features?(?:[/?#]|$)/i.test(parsed.pathname);
        if (!matchesServicesText && !matchesServicesPath) {
          continue;
        }

        let score = 0;
        if (matchesServicesText) {
          score += 3;
        }
        if (matchesServicesPath) {
          score += 3;
        }
        if (path === "/services" || path === "/products" || path === "/solutions") {
          score += 2;
        }
        if (text === "services" || text === "products" || text === "solutions") {
          score += 2;
        }
        candidates.push({ href, score, index });
      }

      candidates.sort((a, b) => b.score - a.score || a.index - b.index);
      return candidates[0]?.href || "";
    }, { expectedOrigin: origin, currentUrl: page.url() })
    .catch(() => "");
}

async function openLinkFromCurrentPage(page, targetUrl, { timeoutMs, log, label }) {
  const safeUrl = compact(targetUrl);
  if (!safeUrl) {
    throw new Error(`Cannot open ${label || "link"}: missing URL`);
  }

  const popupPromise = page.context().waitForEvent("page", { timeout: 2500 }).catch(() => null);
  const clicked = await page
    .evaluate((url) => {
      const toAbsolute = (value) => {
        try {
          return new URL(String(value || "").trim(), window.location.href).toString();
        } catch (_error) {
          return "";
        }
      };
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const found = anchors.find((anchor) => toAbsolute(anchor.getAttribute("href") || anchor.href) === url);
      if (!found) {
        return false;
      }
      found.scrollIntoView({ block: "center", inline: "center" });
      found.click();
      return true;
    }, safeUrl)
    .catch(() => false);

  if (clicked) {
    const popup = await popupPromise;
    if (popup) {
      await popup.bringToFront().catch(() => {});
      await popup.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
      await popup.waitForLoadState("load", { timeout: timeoutMs }).catch(() => {});
      return popup;
    }

    await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
    await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => {});
    await page.bringToFront().catch(() => {});
    return page;
  }

  log(`profile-search-only ${label || "link"} click fallback using goto url=${safeUrl}`);
  await page.goto(safeUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => {});
  await page.bringToFront().catch(() => {});
  return page;
}

async function hardReloadIgnoringCache(page, { timeoutMs, log, label = "page" } = {}) {
  await page.bringToFront().catch(() => {});
  await page.mouse.click(160, 160).catch(() => {});
  let keyboardAttempted = false;
  try {
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.keyboard.press("KeyR", { delay: 80 });
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    keyboardAttempted = true;
    log(`profile-search-only ${label} hard reload keyboard shortcut sent (Ctrl+Shift+R)`);
  } catch (error) {
    log(`profile-search-only ${label} keyboard hard reload skipped: ${error.message}`);
  }
  if (!keyboardAttempted) {
    try {
      await page.keyboard.down("Control");
      await page.keyboard.press("F5", { delay: 80 });
      await page.keyboard.up("Control");
      log(`profile-search-only ${label} fallback keyboard shortcut sent (Ctrl+F5)`);
    } catch (error) {
      log(`profile-search-only ${label} fallback keyboard shortcut skipped: ${error.message}`);
    }
  }

  let cdpReloaded = false;
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Network.enable").catch(() => {});
    await session.send("Network.setCacheDisabled", { cacheDisabled: true }).catch(() => {});
    await session.send("Page.reload", { ignoreCache: true });
    cdpReloaded = true;
    log(`profile-search-only ${label} hard reload executed (Ctrl+Shift+R equivalent)`);
  } catch (error) {
    log(`profile-search-only ${label} hard reload skipped: ${error.message}`);
  }

  if (!cdpReloaded) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => {});
    log(`profile-search-only ${label} reload fallback executed`);
  }
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
  await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => {});
  console.log("HARD REFRESHED");
}

async function maximizeChromeWindow(page, log = () => {}) {
  try {
    const session = await page.context().newCDPSession(page);
    const { windowId } = await session.send("Browser.getWindowForTarget");
    if (windowId) {
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "maximized" },
      });
      log("profile-search-only window maximized");
      return true;
    }
  } catch (error) {
    log(`profile-search-only window maximize skipped: ${error.message}`);
  }
  return false;
}

async function buildPageTextSnapshot(page) {
  const snapshot = await page
    .evaluate(() => ({
      title: document.title || "",
      url: window.location.href || "",
      rawText: document.body?.innerText || "",
    }))
    .catch(() => ({ title: "", url: "", rawText: "" }));

  const rawText = String(snapshot?.rawText || "");
  return {
    title: String(snapshot?.title || "").trim(),
    url: String(snapshot?.url || "").trim(),
    rawText,
    text: cleanText(rawText),
  };
}

function cleanText(raw) {
  return String(raw || "")
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function isBlockedResponse(text) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  const textLen = raw.trim().length;
  const sparseText = textLen < 250;
  const hasCaptcha = /\bcaptcha\b/i.test(lower);
  const hasVerificationContext =
    lower.includes("verify") ||
    lower.includes("human") ||
    lower.includes("robot") ||
    lower.includes("security check") ||
    lower.includes("unusual traffic");
  const looksLikeSearchShell =
    lower.includes("title: google search") ||
    lower.includes("google search\n===============") ||
    lower.includes("if you're having trouble accessing google search") ||
    lower.includes("our systems have detected unusual traffic") ||
    lower.includes("to continue, please verify") ||
    (lower.includes("url source:") && lower.includes("markdown content:") && lower.includes("google search"));
  const hasStrongChallengeMarker =
    lower.includes("cf-browser-verification") ||
    lower.includes("checking your browser before accessing") ||
    lower.includes("attention required!") ||
    lower.includes("please verify you are a human");
  const hasGenericBlockedMarker =
    lower.includes("access denied") ||
    lower.includes("403: forbidden") ||
    lower.includes("you don't have permission") ||
    lower.includes("enable javascript") ||
    lower.includes("reference #");
  return (
    hasStrongChallengeMarker ||
    looksLikeSearchShell
      || (sparseText && hasGenericBlockedMarker)
      || (sparseText && hasCaptcha && hasVerificationContext)
  );
}

function normalizeAbsoluteUrl(input, baseUrl = "") {
  const raw = compact(input);
  if (!raw) {
    return "";
  }
  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch (_error) {
    return "";
  }
}

function isNameResolutionError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("err_name_not_resolved") || message.includes("name not resolved");
}

function buildNavigationCandidates(url) {
  const primary = normalizeAbsoluteUrl(url);
  if (!primary) {
    return [];
  }
  const candidates = [primary];
  try {
    const parsed = new URL(primary);
    const hostname = compact(parsed.hostname).toLowerCase();
    if (hostname.startsWith("www.")) {
      parsed.hostname = hostname.replace(/^www\./, "");
    } else {
      parsed.hostname = `www.${hostname}`;
    }
    const alternate = parsed.toString();
    if (alternate && alternate !== primary) {
      candidates.push(alternate);
    }
  } catch (_error) {
    // Ignore malformed alternate candidate and keep the primary URL only.
  }
  return candidates;
}

function isSameDomainOrSubdomain(hostname, targetHostname) {
  const host = compact(hostname).toLowerCase();
  const target = compact(targetHostname).toLowerCase();
  if (!host || !target) {
    return false;
  }
  return host === target || host.endsWith(`.${target}`) || target.endsWith(`.${host}`);
}

function shouldSkipPath(url) {
  return (
    /\/blog/i.test(url) ||
    /\/news/i.test(url) ||
    /\/press/i.test(url) ||
    /\/careers/i.test(url) ||
    /\/jobs/i.test(url) ||
    /\/login/i.test(url) ||
    /\/signup/i.test(url) ||
    /\/register/i.test(url) ||
    /\/terms/i.test(url) ||
    /\/privacy/i.test(url) ||
    /\/cookie/i.test(url) ||
    /\/support/i.test(url) ||
    /\/faq/i.test(url) ||
    /\.(pdf|png|jpg|jpeg|gif|svg|zip)$/i.test(url)
  );
}

async function fetchViaRealChromeProfile(url, options = {}) {
  if (!options.chromeProfileEnabled) {
    throw new Error("Chrome profile layer disabled");
  }

  const abortSignal = options.abortSignal || null;
  const assertNotAborted = () => {
    if (abortSignal?.aborted) {
      const error = new Error(normalizeAbortReason(abortSignal.reason));
      error.name = "AbortError";
      throw error;
    }
  };
  assertNotAborted();

  const targetUrl = normalizeAbsoluteUrl(url);
  if (!targetUrl) {
    throw new Error("Invalid URL for chrome profile layer");
  }

  const { executablePath, userDataDir, profileName } = resolveChromeConfig(options);
  const timeoutMs = Math.max(1000, Number.parseInt(options.chromeTimeoutMs, 10) || DEFAULT_TIMEOUT_MS);
  const debugHoldMs = Math.max(0, Number.parseInt(options.chromeDebugHoldMs || process.env.CHROME_PROFILE_DEBUG_HOLD_MS, 10) || 0);
  const allowWhileOpen = String(options.chromeAllowWhileOpen || process.env.CHROME_PROFILE_ALLOW_WHILE_OPEN || "")
    .trim()
    .toLowerCase();
  const rowNumber = Number.parseInt(options.rowNumber, 10);
  const profileSearchOnly = String(options.profileSearchOnly || "").trim().toLowerCase() === "true" || options.profileSearchOnly === true;
  const profileSearchWaitMs = Math.max(
    1000,
    Number.parseInt(options.profileSearchWaitMs || process.env.CHROME_PROFILE_SEARCH_WAIT_MS, 10) || PROFILE_SEARCH_WAIT_MS
  );
  const launchHeadless =
    String(options.chromeHeadless ?? process.env.CHROME_HEADLESS ?? "false")
      .trim()
      .toLowerCase() === "true";
  const profileWindowWidth = Math.max(
    640,
    Number.parseInt(options.profileWindowWidth || process.env.CHROME_PROFILE_SEARCH_WINDOW_WIDTH, 10) ||
      PROFILE_SEARCH_WINDOW_WIDTH
  );
  const profileWindowHeight = Math.max(
    480,
    Number.parseInt(options.profileWindowHeight || process.env.CHROME_PROFILE_SEARCH_WINDOW_HEIGHT, 10) ||
      PROFILE_SEARCH_WINDOW_HEIGHT
  );
  const forceMirrorProfile = (() => {
    const raw = String(options.chromeForceMirrorProfile ?? process.env.CHROME_FORCE_MIRROR_PROFILE ?? "true")
      .trim()
      .toLowerCase();
    if (["0", "false", "no", "off"].includes(raw)) {
      return false;
    }
    return true;
  })();
  const mirrorUserDataDir =
    compact(options.chromeAutomationUserDataDir || process.env.CHROME_AUTOMATION_USER_DATA_DIR) ||
    path.resolve(process.cwd(), ".chrome-automation-runtime");
  const rowLabel = Number.isFinite(rowNumber) ? String(rowNumber) : "-";
  const log = (message) => console.log(`[chrome-profile][row=${rowLabel}] ${message}`);
  let targetHost = new URL(targetUrl).hostname.toLowerCase();
  let effectiveTargetUrl = targetUrl;
  let targetDocumentStatus = 0;
  const trackTargetDocumentStatus = (response) => {
    try {
      if (response.request().resourceType() !== "document") {
        return;
      }
      const responseHost = new URL(response.url()).hostname.toLowerCase();
      if (!isSameDomainOrSubdomain(responseHost, targetHost)) {
        return;
      }
      targetDocumentStatus = response.status();
    } catch (_error) {
      // Ignore response parsing errors and continue fetch flow.
    }
  };

  const allowWhileOpenEnabled = ["1", "true", "yes", "on"].includes(allowWhileOpen);
  let launchUserDataDir = userDataDir;
  const shouldMirrorFromDefault = forceMirrorProfile && isDefaultChromeUserDataDir(userDataDir);
  // Mirrored profile mode does not attach to the live user profile, so it can run while Chrome stays open.
  const bypassRunningChromeGuard = profileSearchOnly || allowWhileOpenEnabled || shouldMirrorFromDefault;
  if (isChromeRunning() && !bypassRunningChromeGuard) {
    throw new Error(
      "Chrome is currently running. Close all Chrome windows first so the real profile can be used reliably. " +
        "If you need this to run with Chrome open, set CHROME_PROFILE_ALLOW_WHILE_OPEN=true."
    );
  }
  if (shouldMirrorFromDefault) {
    log(`default chrome user-data-dir detected; preparing mirrored profile dir=${mirrorUserDataDir}`);
    try {
      launchUserDataDir = await prepareMirroredUserDataDir({
        sourceUserDataDir: userDataDir,
        profileName,
        mirrorUserDataDir,
      });
      log(`profile mirror ready source=${userDataDir} mirrored=${launchUserDataDir} profile=${profileName}`);
    } catch (error) {
      throw new Error(`Failed to mirror Chrome profile for automation: ${error.message}`);
    }
  }

  let context;
  let abortHandler = null;
  try {
    context = await chromium.launchPersistentContext(launchUserDataDir, {
      executablePath,
      headless: launchHeadless,
      args: [
        `--profile-directory=${profileName}`,
        `--window-size=${profileWindowWidth},${profileWindowHeight}`,
        "--window-position=0,0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-popup-blocking",
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      viewport: { width: profileWindowWidth, height: profileWindowHeight },
      timeout: timeoutMs,
    });
    if (abortSignal) {
      abortHandler = () => {
        context.close().catch(() => {});
      };
      abortSignal.addEventListener("abort", abortHandler, { once: true });
      assertNotAborted();
    }
  } catch (error) {
    const message = String(error?.message || "");
    if (/DevTools remote debugging requires a non-default data directory/i.test(message)) {
      throw new Error(
        "Chrome blocked remote debugging on the default profile directory. " +
          "Enable mirrored profile launch with CHROME_FORCE_MIRROR_PROFILE=true (default) " +
          `and set CHROME_AUTOMATION_USER_DATA_DIR (current mirror dir: ${mirrorUserDataDir}).`
      );
    }
    throw error;
  }

  log(
    `context launched profile=${profileName} headless=${launchHeadless} timeoutMs=${timeoutMs} debugHoldMs=${debugHoldMs} userDataDir=${launchUserDataDir}`
  );
  let page = await context.newPage();
  context.on("response", trackTargetDocumentStatus);
  try {
    assertNotAborted();
    log(`new page created initialUrl=${compact(page.url()) || "about:blank"}`);
    if (profileSearchOnly) {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(targetUrl)}`;
      log(`profile-search-only mode enabled; opening searchUrl=${searchUrl}`);
      await page.bringToFront().catch(() => {});
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      const acceptedAllCookies = await handleAcceptAllCookieConsent(page);
      log(`profile-search-only cookie scan acceptAll=${acceptedAllCookies}`);
      const resultPage = await openFirstGoogleResult(page, { timeoutMs, log });
      await resultPage.bringToFront().catch(() => {});
      log("profile-search-only waiting fixed 2000ms before hard refresh");
      await resultPage.waitForTimeout(2000);
      await hardReloadIgnoringCache(resultPage, { timeoutMs, log, label: "destination page" });
      await maximizeChromeWindow(resultPage, log);
      await closeNonCookiePopups(resultPage, log, "destination page(before cookies)");
      const acceptedAllCookiesOnResult = await handleAcceptAllCookieConsent(resultPage);
      log(`profile-search-only destination cookie scan acceptAll=${acceptedAllCookiesOnResult}`);
      await closeNonCookiePopups(resultPage, log, "destination page(after cookies)");
      const randomScrollCount = await randomHumanScrollDownAndBackTop(resultPage, {});
      log(`profile-search-only random scroll on destination page completed count=${randomScrollCount} and reset to top`);
      const effectiveProfileSearchWaitMs = Math.max(10000, profileSearchWaitMs);
      log(`profile-search-only mode waiting waitMs=${effectiveProfileSearchWaitMs}`);
      await resultPage.waitForTimeout(effectiveProfileSearchWaitMs);
      assertNotAborted();
      const homepageSnapshot = await buildPageTextSnapshot(resultPage);
      log(
        `profile-search-only homepage snapshot captured url=${homepageSnapshot.url} textLen=${homepageSnapshot.text.length}`
      );
      const profileSearchProtectionSignals = await getProtectionSignals(resultPage, {
        documentStatus: targetDocumentStatus,
      });
      log(
        `profile-search-only protection check status=${targetDocumentStatus || 0} kasada=${profileSearchProtectionSignals.isKasadaProtected} humanVerification=${profileSearchProtectionSignals.requiresHumanVerification}`
      );
      if (profileSearchProtectionSignals.isKasadaProtected) {
        throw new Error(`Kasada protected website blocked automated fetch on ${targetHost}`);
      }

      const servicesUrl = await findServicesLinkUrl(resultPage, homepageSnapshot.url || targetUrl);
      let aboutPageSnapshot = null;
      const aboutUrl = await findAboutLinkUrl(resultPage, homepageSnapshot.url || targetUrl);
      if (aboutUrl) {
        log(`profile-search-only about link found url=${aboutUrl}`);
        const aboutSectionDelayMs = await waitRandomDelay(250, 2000);
        log(`profile-search-only random delay before opening about section delayMs=${aboutSectionDelayMs}`);
        const aboutPage = await openLinkFromCurrentPage(resultPage, aboutUrl, {
          timeoutMs,
          log,
          label: "about link",
        });
        await aboutPage.bringToFront().catch(() => {});
        await closeNonCookiePopups(aboutPage, log, "about page(before cookies)");
        const acceptedAllCookiesOnAbout = await handleAcceptAllCookieConsent(aboutPage);
        log(`profile-search-only about cookie scan acceptAll=${acceptedAllCookiesOnAbout}`);
        await closeNonCookiePopups(aboutPage, log, "about page(after cookies)");
        const aboutScrollCount = await randomHumanScrollDownAndBackTop(aboutPage, {});
        log(`profile-search-only random scroll on about page completed count=${aboutScrollCount} and reset to top`);
        aboutPageSnapshot = await buildPageTextSnapshot(aboutPage);
        log(
          `profile-search-only about snapshot captured url=${aboutPageSnapshot.url} textLen=${aboutPageSnapshot.text.length}`
        );
      } else {
        log("profile-search-only about link not found on homepage");
      }

      const combinedTextSections = [homepageSnapshot.text];
      if (aboutPageSnapshot?.text) {
        combinedTextSections.push(`About Page:\n${aboutPageSnapshot.text}`);
      }
      let servicesPageSnapshot = null;
      if (servicesUrl) {
        log(`profile-search-only services link found url=${servicesUrl}`);
        const aboutUrlNormalized = normalizeAbsoluteUrl(aboutUrl, homepageSnapshot.url || targetUrl);
        const servicesUrlNormalized = normalizeAbsoluteUrl(servicesUrl, homepageSnapshot.url || targetUrl);
        if (
          aboutPageSnapshot &&
          servicesUrlNormalized &&
          aboutUrlNormalized &&
          servicesUrlNormalized === aboutUrlNormalized
        ) {
          servicesPageSnapshot = aboutPageSnapshot;
          log("profile-search-only services link matched about link; reusing about snapshot");
        } else {
          const servicesSectionDelayMs = await waitRandomDelay(250, 2000);
          log(`profile-search-only random delay before opening services section delayMs=${servicesSectionDelayMs}`);
          const servicesPage = await openLinkFromCurrentPage(resultPage, servicesUrl, {
            timeoutMs,
            log,
            label: "services link",
          });
          await servicesPage.bringToFront().catch(() => {});
          await closeNonCookiePopups(servicesPage, log, "services page(before cookies)");
          const acceptedAllCookiesOnServices = await handleAcceptAllCookieConsent(servicesPage);
          log(`profile-search-only services cookie scan acceptAll=${acceptedAllCookiesOnServices}`);
          await closeNonCookiePopups(servicesPage, log, "services page(after cookies)");
          const servicesScrollCount = await randomHumanScrollDownAndBackTop(servicesPage, {});
          log(
            `profile-search-only random scroll on services page completed count=${servicesScrollCount} and reset to top`
          );
          servicesPageSnapshot = await buildPageTextSnapshot(servicesPage);
          log(
            `profile-search-only services snapshot captured url=${servicesPageSnapshot.url} textLen=${servicesPageSnapshot.text.length}`
          );
        }
      } else {
        log("profile-search-only services link not found on homepage");
      }
      if (servicesPageSnapshot?.text) {
        combinedTextSections.push(`Services Page:\n${servicesPageSnapshot.text}`);
      }
      const combinedRawTextSections = [homepageSnapshot.rawText];
      if (aboutPageSnapshot?.rawText) {
        combinedRawTextSections.push(aboutPageSnapshot.rawText);
      }
      if (servicesPageSnapshot?.rawText) {
        combinedRawTextSections.push(servicesPageSnapshot.rawText);
      }
      const combinedText = combinedTextSections.filter(Boolean).join("\n\n");
      const combinedRawText = combinedRawTextSections.filter(Boolean).join("\n\n");
      const snapshotEntries = [
        {
          pageType: "homepage",
          url: homepageSnapshot.url,
          title: homepageSnapshot.title,
          textLength: homepageSnapshot.text.length,
          rawTextLength: homepageSnapshot.rawText.length,
          text: homepageSnapshot.text,
        },
      ];
      if (aboutPageSnapshot) {
        snapshotEntries.push({
          pageType: "about",
          url: aboutPageSnapshot.url,
          title: aboutPageSnapshot.title,
          textLength: aboutPageSnapshot.text.length,
          rawTextLength: aboutPageSnapshot.rawText.length,
          text: aboutPageSnapshot.text,
        });
      }
      if (servicesPageSnapshot) {
        snapshotEntries.push({
          pageType: "services",
          url: servicesPageSnapshot.url,
          title: servicesPageSnapshot.title,
          textLength: servicesPageSnapshot.text.length,
          rawTextLength: servicesPageSnapshot.rawText.length,
          text: servicesPageSnapshot.text,
        });
      }
      log("profile-search-only mode completed");
      return {
        text: combinedText,
        links: [],
        source: "chrome_profile_search_test",
        profileSearchSnapshot: {
          searchedUrl: targetUrl,
          destinationUrl: homepageSnapshot.url,
          destinationTitle: homepageSnapshot.title,
          entries: snapshotEntries,
          homepageUrl: homepageSnapshot.url,
          homepageTitle: homepageSnapshot.title,
          homepageTextLength: homepageSnapshot.text.length,
          homepageRawTextLength: homepageSnapshot.rawText.length,
          homepageText: homepageSnapshot.text,
          aboutPageUrl: aboutPageSnapshot?.url || "",
          aboutPageTitle: aboutPageSnapshot?.title || "",
          aboutPageTextLength: aboutPageSnapshot?.text.length || 0,
          aboutPageRawTextLength: aboutPageSnapshot?.rawText.length || 0,
          aboutPageText: aboutPageSnapshot?.text || "",
          servicesPageUrl: servicesPageSnapshot?.url || "",
          servicesPageTitle: servicesPageSnapshot?.title || "",
          servicesPageTextLength: servicesPageSnapshot?.text.length || 0,
          servicesPageRawTextLength: servicesPageSnapshot?.rawText.length || 0,
          servicesPageText: servicesPageSnapshot?.text || "",
          extractedAt: new Date().toISOString(),
          textLength: combinedText.length,
          rawTextLength: combinedRawText.length,
          text: combinedText,
        },
      };
    }

    log(`navigating to targetUrl=${targetUrl}`);
    // Always use a dedicated tab for target navigation so URL rendering is deterministic.
    await page.bringToFront().catch(() => {});

    const navigationCandidates = buildNavigationCandidates(targetUrl);
    let navigationSucceeded = false;
    let lastNavigationError = null;
    for (let index = 0; index < navigationCandidates.length; index += 1) {
      const candidateUrl = navigationCandidates[index];
      try {
        targetDocumentStatus = 0;
        const waitUntilMode = launchHeadless ? "domcontentloaded" : "load";
        log(`navigation attempt target=${candidateUrl} waitUntil=${waitUntilMode}`);
        await page.goto(candidateUrl, { waitUntil: waitUntilMode, timeout: timeoutMs });
        log(`navigation completed currentUrl=${compact(page.url()) || "about:blank"}`);
        if (compact(page.url()).toLowerCase() === "about:blank") {
          log(`navigation remained about:blank for ${candidateUrl}, retrying waitUntil=domcontentloaded`);
          await page.goto(candidateUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
          log(`navigation domcontentloaded completed currentUrl=${compact(page.url()) || "about:blank"}`);
        }
        if (compact(page.url()).toLowerCase() === "about:blank") {
          throw new Error(`Chrome profile did not navigate to ${candidateUrl} (still about:blank)`);
        }
        const navigatedUrl = normalizeAbsoluteUrl(page.url()) || candidateUrl;
        effectiveTargetUrl = navigatedUrl;
        targetHost = new URL(navigatedUrl).hostname.toLowerCase();
        navigationSucceeded = true;
        break;
      } catch (error) {
        lastNavigationError = error;
        const dnsFailure = isNameResolutionError(error);
        log(
          `navigation failed target=${candidateUrl} dnsFailure=${dnsFailure} message=${String(error?.message || "unknown error")}`
        );
        const hasMoreCandidates = index < navigationCandidates.length - 1;
        if (!(dnsFailure && hasMoreCandidates)) {
          break;
        }
      }
    }
    if (!navigationSucceeded) {
      throw lastNavigationError || new Error("Chrome profile navigation failed");
    }
    log(`navigation committed finalUrl=${page.url()} effectiveTargetUrl=${effectiveTargetUrl}`);

    // Close leftover blank tabs so only the target website tab remains visible.
    let closedBlankTabs = 0;
    for (const extraPage of context.pages()) {
      if (extraPage === page) {
        continue;
      }
      if (compact(extraPage.url()).toLowerCase() === "about:blank") {
        await extraPage.close().catch(() => {});
        closedBlankTabs += 1;
      }
    }
    log(`blank tab cleanup closed=${closedBlankTabs} remainingTabs=${context.pages().length}`);
    if (!launchHeadless) {
      // networkidle waits for all trackers/analytics to go quiet — skip in headless (saves 0–12s).
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 12000) }).catch(() => {});
    }
    await page.waitForTimeout(launchHeadless ? 200 : 1200);
    assertNotAborted();
    log(`post-navigation wait complete headless=${launchHeadless}`);

    await closeNonCookiePopups(page, log, "target page(before cookies)");
    log("cookie consent scan started");
    const consentHandled = await handleCookieConsent(page);
    log(`cookie consent scan finished handled=${consentHandled}`);
    await closeNonCookiePopups(page, log, "target page(after cookies)");

    const protectionBeforeExtract = await getProtectionSignals(page, {
      documentStatus: targetDocumentStatus,
    });
    if (protectionBeforeExtract.isKasadaProtected) {
      throw new Error(`Kasada protected website blocked automated fetch on ${targetHost}`);
    }
    const botChallengeBefore = protectionBeforeExtract.requiresHumanVerification;
    log(
      `bot challenge check(before extract) detected=${botChallengeBefore} status=${targetDocumentStatus || 0} kasada=${protectionBeforeExtract.isKasadaProtected}`
    );
    if (botChallengeBefore) {
      log("bot challenge detected; manual verification flow disabled, continuing extraction");
    }

    const extractPagePayload = async () =>
      page.evaluate((origin) => ({
        rawText: document.body?.innerText || "",
        links: Array.from(document.querySelectorAll("a[href]"))
          .map((anchor) => anchor.href)
          .filter((href) => typeof href === "string" && href.startsWith(origin)),
      }), new URL(effectiveTargetUrl).origin);

    if (!launchHeadless) {
      // Auto-scroll simulates human browsing — not needed in headless (saves 3.2s).
      log(`auto-scroll started steps=${SCROLL_STEPS} stepDelayMs=${SCROLL_STEP_DELAY_MS}`);
      await autoScroll(page);
      log("auto-scroll completed");
    } else {
      log("auto-scroll skipped (headless mode)");
    }
    let { rawText, links } = await extractPagePayload();
    log(`extract payload #1 textLen=${String(rawText || "").trim().length} links=${Array.isArray(links) ? links.length : 0}`);
    const protectionAfterExtract = await getProtectionSignals(page, {
      documentStatus: targetDocumentStatus,
    });
    if (protectionAfterExtract.isKasadaProtected) {
      throw new Error(`Kasada protected website blocked automated fetch on ${targetHost}`);
    }

    const blockedBeforeRetry = isBlockedResponse(rawText);
    log(`blocked-content check #1 blocked=${blockedBeforeRetry}`);
    if (blockedBeforeRetry) {
      log("blocked content detected; skipping manual verification retry");
    }

    const blockedFinal = isBlockedResponse(rawText);
    log(`blocked-content check final blocked=${blockedFinal}`);
    if (blockedFinal) {
      throw new Error("Chrome profile returned blocked/access-denied content");
    }
    if (String(rawText || "").trim().length < 100) {
      log(`final content too short len=${String(rawText || "").trim().length}`);
      throw new Error("Chrome profile returned insufficient content");
    }

    const cleanedLinks = Array.from(
      new Set(
        (Array.isArray(links) ? links : [])
          .map((link) => normalizeAbsoluteUrl(link, effectiveTargetUrl))
          .filter((link) => link && !shouldSkipPath(link))
      )
    );
    log(`link cleanup finished internalLinks=${cleanedLinks.length}`);
    const cleanedText = cleanText(rawText);
    log(`success cleanedTextLen=${cleanedText.length} source=chrome_profile`);

    // Collect subpages in the same browser session — zero extra Chrome launches.
    const inlineSubPages = [];
    const subPageMaxCount = Math.max(0, Number.parseInt(options.subPageMaxCount, 10) || 0);
    if (subPageMaxCount > 0 && cleanedLinks.length > 0) {
      const USEFUL_SUB_PATTERNS = [
        /\/about/i, /\/company/i, /\/who-we-are/i, /\/our-story/i,
        /\/services/i, /\/what-we-do/i, /\/solutions/i, /\/team/i,
        /\/mission/i, /\/vision/i, /\/product/i, /\/platform/i,
      ];
      const subPageCandidates = cleanedLinks
        .filter((link) => USEFUL_SUB_PATTERNS.some((p) => p.test(link)))
        .slice(0, subPageMaxCount);
      log(`inline-subpages candidates=${subPageCandidates.length} max=${subPageMaxCount}`);
      for (const subUrl of subPageCandidates) {
        assertNotAborted();
        let subPage = null;
        try {
          subPage = await context.newPage();
          await subPage.goto(subUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
          await handleCookieConsent(subPage);
          const subSnap = await buildPageTextSnapshot(subPage);
          if (subSnap.text.length > 100) {
            inlineSubPages.push({ url: subUrl, text: subSnap.text, source: "chrome_profile" });
            log(`inline-subpages fetched url=${subUrl} textLen=${subSnap.text.length}`);
          }
        } catch (subError) {
          log(`inline-subpages failed url=${subUrl} err=${subError?.message || "unknown"}`);
        } finally {
          await subPage?.close().catch(() => {});
        }
      }
    }

    return {
      text: cleanedText,
      links: cleanedLinks,
      subPages: inlineSubPages,
      source: "chrome_profile",
    };
  } finally {
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
    if (debugHoldMs > 0) {
      log(`debug hold started holdMs=${debugHoldMs}`);
      await page.waitForTimeout(debugHoldMs).catch(() => {});
      log("debug hold completed");
    }
    context.off("response", trackTargetDocumentStatus);
    log("closing chrome persistent context");
    await context.close().catch(() => {});
    log("context closed");
  }
}

module.exports = {
  autoScroll,
  fetchViaRealChromeProfile,
  findFirstGoogleResultUrl,
  findAboutLinkUrl,
  findServicesLinkUrl,
  closeNonCookiePopups,
  handleAcceptAllCookieConsent,
  handleCookieConsent,
  hardReloadIgnoringCache,
  isBotChallenge,
  buildPageTextSnapshot,
  maximizeChromeWindow,
  openLinkFromCurrentPage,
  openFirstGoogleResult,
  randomHumanScrollDownAndBackTop,
  resolveChromeConfig,
  waitRandomDelay,
};
