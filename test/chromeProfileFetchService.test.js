const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { resolveChromeConfig } = require("../src/services/chromeProfileFetchService");

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

test("resolveChromeConfig falls back to an available profile when configured profile is missing", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cold-mailbot-profile-"));
  const chromeExecutablePath = path.join(tempRoot, "chrome.exe");
  const chromeUserDataDir = path.join(tempRoot, "User Data");
  const profileOneDir = path.join(chromeUserDataDir, "Profile 1");
  const localStatePath = path.join(chromeUserDataDir, "Local State");

  const originalEnv = {
    CHROME_EXECUTABLE_PATH: process.env.CHROME_EXECUTABLE_PATH,
    CHROME_USER_DATA_DIR: process.env.CHROME_USER_DATA_DIR,
    CHROME_PROFILE_NAME: process.env.CHROME_PROFILE_NAME,
    CHROME_PROFILE_DIRECTORY: process.env.CHROME_PROFILE_DIRECTORY,
  };

  try {
    await fs.writeFile(chromeExecutablePath, "");
    await fs.mkdir(profileOneDir, { recursive: true });
    await fs.writeFile(localStatePath, JSON.stringify({ profile: { last_used: "Profile 8" } }), "utf8");

    process.env.CHROME_EXECUTABLE_PATH = chromeExecutablePath;
    process.env.CHROME_USER_DATA_DIR = chromeUserDataDir;
    process.env.CHROME_PROFILE_NAME = "Profile 8";
    process.env.CHROME_PROFILE_DIRECTORY = "Profile 8";

    const config = resolveChromeConfig({});
    assert.equal(config.profileName, "Profile 1");
    assert.equal(config.userDataDir, chromeUserDataDir);
    assert.equal(config.executablePath, chromeExecutablePath);
  } finally {
    restoreEnv("CHROME_EXECUTABLE_PATH", originalEnv.CHROME_EXECUTABLE_PATH);
    restoreEnv("CHROME_USER_DATA_DIR", originalEnv.CHROME_USER_DATA_DIR);
    restoreEnv("CHROME_PROFILE_NAME", originalEnv.CHROME_PROFILE_NAME);
    restoreEnv("CHROME_PROFILE_DIRECTORY", originalEnv.CHROME_PROFILE_DIRECTORY);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
