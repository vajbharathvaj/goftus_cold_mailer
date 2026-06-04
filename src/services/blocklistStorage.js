const fs = require("fs/promises");
const path = require("path");

const BLOCKLIST_FILE = path.resolve(__dirname, "../../storage/blocklist.json");

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function readBlocklist() {
  try {
    const data = await fs.readFile(BLOCKLIST_FILE, "utf8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeBlocklist(entries) {
  await fs.mkdir(path.dirname(BLOCKLIST_FILE), { recursive: true });
  await fs.writeFile(BLOCKLIST_FILE, JSON.stringify(entries, null, 2), "utf8");
}

async function addToBlocklist(email, name = "") {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("Email is required");
  const list = await readBlocklist();
  if (list.some((e) => e.email === normalized)) {
    return list;
  }
  list.push({ email: normalized, name: String(name || "").trim(), addedAt: new Date().toISOString() });
  await writeBlocklist(list);
  return list;
}

async function removeFromBlocklist(email) {
  const normalized = normalizeEmail(email);
  const list = await readBlocklist();
  const filtered = list.filter((e) => e.email !== normalized);
  await writeBlocklist(filtered);
  return filtered;
}

module.exports = { readBlocklist, addToBlocklist, removeFromBlocklist };
