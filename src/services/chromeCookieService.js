const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("node:child_process");

function compact(value) {
  return String(value || "").trim();
}

function resolveUserDataDir(options = {}) {
  const explicit = compact(options.userDataDir || process.env.CHROME_USER_DATA_DIR);
  if (explicit) {
    return explicit;
  }
  const localAppData = compact(process.env.LOCALAPPDATA);
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not available. Set CHROME_USER_DATA_DIR explicitly.");
  }
  return path.join(localAppData, "Google", "Chrome", "User Data");
}

function resolveProfileName(options = {}) {
  return compact(options.profileName || process.env.CHROME_PROFILE_NAME || process.env.CHROME_PROFILE_DIRECTORY) || "Default";
}

function getLocalStatePath(options = {}) {
  const base = resolveUserDataDir(options);
  const localStatePath = path.join(base, "Local State");
  if (!fs.existsSync(localStatePath)) {
    throw new Error(
      `Chrome Local State not found at: ${localStatePath}. Set CHROME_USER_DATA_DIR to the correct Chrome user data path.`
    );
  }
  return localStatePath;
}

function getCookiesDbPath(options = {}) {
  const profileName = resolveProfileName(options);
  const base = resolveUserDataDir(options);

  const newPath = path.join(base, profileName, "Network", "Cookies");
  if (fs.existsSync(newPath)) {
    return newPath;
  }

  const oldPath = path.join(base, profileName, "Cookies");
  if (fs.existsSync(oldPath)) {
    return oldPath;
  }

  throw new Error(
    `Chrome Cookies database not found. Looked in: ${newPath} and ${oldPath}. Check CHROME_USER_DATA_DIR and CHROME_PROFILE_NAME.`
  );
}

function unprotectDataWithWindowsDpapi(encrypted) {
  if (process.platform !== "win32") {
    throw new Error("Chrome cookie extraction currently supports Windows only.");
  }
  const encryptedBase64 = Buffer.from(encrypted).toString("base64");
  const script =
    "$ErrorActionPreference='Stop';" +
    "Add-Type -AssemblyName System.Security | Out-Null;" +
    "$bytes=[Convert]::FromBase64String($env:DPAPI_INPUT);" +
    "$scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser;" +
    "$out=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,$scope);" +
    "[Console]::Out.Write([Convert]::ToBase64String($out));";

  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        ...process.env,
        DPAPI_INPUT: encryptedBase64,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const normalized = compact(output);
    if (!normalized) {
      throw new Error("DPAPI returned an empty decrypted payload.");
    }
    return Buffer.from(normalized, "base64");
  } catch (error) {
    const message = compact(error?.stderr || error?.message || "Unknown DPAPI error");
    throw new Error(`DPAPI decryption failed: ${message}`);
  }
}

function getMasterKey(options = {}) {
  const localStatePath = getLocalStatePath(options);
  const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
  const encryptedKeyB64 = localState?.os_crypt?.encrypted_key;
  if (!encryptedKeyB64) {
    throw new Error("Could not find os_crypt.encrypted_key in Chrome Local State.");
  }

  const encryptedKeyWithPrefix = Buffer.from(encryptedKeyB64, "base64");
  if (encryptedKeyWithPrefix.length <= 5) {
    throw new Error("Chrome encrypted key is malformed.");
  }

  const encryptedKey = encryptedKeyWithPrefix.slice(5);
  return unprotectDataWithWindowsDpapi(encryptedKey);
}

function decryptCookieValue(encryptedValue, masterKey) {
  if (!encryptedValue || encryptedValue.length === 0) {
    return "";
  }

  const encryptedBuffer = Buffer.isBuffer(encryptedValue) ? encryptedValue : Buffer.from(encryptedValue);
  const prefix = encryptedBuffer.slice(0, 3).toString("utf8");

  if (prefix === "v10" || prefix === "v11") {
    try {
      const nonce = encryptedBuffer.slice(3, 15);
      const ciphertext = encryptedBuffer.slice(15, encryptedBuffer.length - 16);
      const authTag = encryptedBuffer.slice(encryptedBuffer.length - 16);

      const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, nonce);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const utf8Value = decrypted.toString("utf8");
      if (!utf8Value.includes("\uFFFD")) {
        return utf8Value;
      }
      // Some cookies contain bytes that are not valid UTF-8. Keep raw bytes via latin1.
      return decrypted.toString("latin1");
    } catch (_error) {
      return "";
    }
  }

  try {
    return encryptedBuffer.toString("utf8");
  } catch (_error) {
    return "";
  }
}

function copyCookiesDb(options = {}) {
  const sourcePath = getCookiesDbPath(options);
  const tempPath = path.join(os.tmpdir(), `coldmailbot-cookies-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  fs.copyFileSync(sourcePath, tempPath);
  return tempPath;
}

function sanitizeCookiePart(value) {
  return String(value || "")
    .replace(/[\r\n]/g, "")
    .replace(/\u0000/g, "")
    .trim();
}

function queryCookiesForDomain(tempDbPath, domain) {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (error) {
    throw new Error(`better-sqlite3 is required for cookie extraction: ${error.message}`);
  }

  const db = new Database(tempDbPath, { readonly: true });
  try {
    return db
      .prepare(
        `
      SELECT
        name,
        encrypted_value,
        path,
        expires_utc
      FROM cookies
      WHERE host_key = @domain
         OR host_key = @dotDomain
         OR host_key LIKE @likeDomain
      ORDER BY length(path) DESC, creation_utc ASC
    `
      )
      .all({
        domain,
        dotDomain: `.${domain}`,
        likeDomain: `%.${domain}`,
      });
  } finally {
    db.close();
  }
}

async function getChromeCookiesForUrl(url, options = {}) {
  const { hostname } = new URL(url);
  const domain = hostname.replace(/^www\./i, "");

  const masterKey = getMasterKey(options);
  const tempDbPath = copyCookiesDb(options);

  try {
    const rows = queryCookiesForDomain(tempDbPath, domain);
    if (rows.length === 0) {
      throw new Error(`No cookies found for domain: ${domain}. Visit this site in Chrome first.`);
    }

    const cookiePairs = [];
    for (const row of rows) {
      const name = sanitizeCookiePart(row.name);
      const value = sanitizeCookiePart(decryptCookieValue(row.encrypted_value, masterKey));
      if (value && name) {
        cookiePairs.push(`${name}=${value}`);
      }
    }

    if (cookiePairs.length === 0) {
      throw new Error(`Found ${rows.length} cookies for ${domain}, but none could be decrypted.`);
    }

    console.log(`[chrome-cookies] ${domain} -> ${cookiePairs.length} cookies extracted`);
    return cookiePairs.join("; ");
  } finally {
    try {
      fs.unlinkSync(tempDbPath);
    } catch (_error) {
      // ignore cleanup errors
    }
  }
}

function checkChromeCookieAvailability(options = {}) {
  try {
    if (process.platform !== "win32") {
      return { available: false, reason: "Chrome cookie extraction currently supports Windows only." };
    }

    getLocalStatePath(options);
    getCookiesDbPath(options);
    try {
      require.resolve("better-sqlite3");
    } catch (_error) {
      return { available: false, reason: "better-sqlite3 is not installed." };
    }
    return { available: true };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

module.exports = {
  checkChromeCookieAvailability,
  getChromeCookiesForUrl,
};
