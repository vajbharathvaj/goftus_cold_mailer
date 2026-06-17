"use strict";

const { chromium } = require("playwright");
const {
  resolveChromeConfig,
  prepareMirroredUserDataDir,
  isDefaultChromeUserDataDir,
  fetchViaRealChromeProfile,
} = require("./chromeProfileFetchService");

class SharedBrowserSession {
  constructor() {
    this.context = null;
    this._profileName = null;
  }

  isOpen() {
    return Boolean(this.context);
  }

  async open(options = {}) {
    if (this.context) return;

    const { executablePath, userDataDir, profileName } = resolveChromeConfig(options);
    const mirrorUserDataDir =
      String(options.chromeAutomationUserDataDir || process.env.CHROME_AUTOMATION_USER_DATA_DIR || "").trim() ||
      require("path").resolve(process.cwd(), ".chrome-automation-shared");

    const forceMirror = (() => {
      const raw = String(options.chromeForceMirrorProfile ?? process.env.CHROME_FORCE_MIRROR_PROFILE ?? "true")
        .trim()
        .toLowerCase();
      return !["0", "false", "no", "off"].includes(raw);
    })();

    let launchDir = userDataDir;
    if (forceMirror && isDefaultChromeUserDataDir(userDataDir)) {
      console.log(`[shared-browser] mirroring profile source=${userDataDir} profile=${profileName}`);
      launchDir = await prepareMirroredUserDataDir({
        sourceUserDataDir: userDataDir,
        profileName,
        mirrorUserDataDir,
      });
      console.log(`[shared-browser] mirror ready dir=${launchDir}`);
    }

    const headless =
      String(options.chromeHeadless ?? process.env.CHROME_HEADLESS ?? "true")
        .trim()
        .toLowerCase() === "true";
    const timeoutMs = Math.max(
      1000,
      Number.parseInt(options.chromeTimeoutMs || process.env.CHROME_TIMEOUT_MS, 10) || 30000
    );

    this.context = await chromium.launchPersistentContext(launchDir, {
      executablePath,
      headless,
      args: [
        `--profile-directory=${profileName}`,
        "--window-size=1280,800",
        "--window-position=0,0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-popup-blocking",
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      viewport: { width: 1280, height: 800 },
      timeout: timeoutMs,
    });
    this._profileName = profileName;
    console.log(`[shared-browser] session open profile=${profileName} headless=${headless}`);
  }

  async close() {
    const ctx = this.context;
    this.context = null;
    this._profileName = null;
    if (ctx) {
      console.log("[shared-browser] closing session");
      await ctx.close().catch(() => {});
      console.log("[shared-browser] session closed");
    }
  }

  async fetchRow(url, options = {}) {
    if (!this.context) {
      throw new Error("SharedBrowserSession is not open");
    }
    return fetchViaRealChromeProfile(url, {
      ...options,
      sharedContext: this.context,
      chromeProfileEnabled: true,
    });
  }
}

module.exports = { SharedBrowserSession };
