const { addToBlocklist } = require("./blocklistStorage");

const SUPPRESSION_PATTERNS = [
  /\bnot a fit\b/i,
  /\bnot interested\b/i,
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\bplease remove\b/i,
  /\bstop (?:emailing|contacting)\b/i,
  /\btake me off\b/i,
  /\bopt.?out\b/i,
  /\bno thanks\b/i,
  /\bno thank you\b/i,
  /\bdon'?t (?:email|contact) me\b/i,
  /\bdo not (?:email|contact)\b/i,
  /\bclose the file\b/i,
];

function isSuppressionReply(subject, body) {
  const text = `${String(subject || "")} ${String(body || "")}`;
  return SUPPRESSION_PATTERNS.some((pattern) => pattern.test(text));
}

async function processSuppression(emailAddresses) {
  const emails = Array.isArray(emailAddresses) ? emailAddresses : [];
  let suppressed = 0;
  for (const email of emails) {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized || !normalized.includes("@")) continue;
    try {
      await addToBlocklist(normalized);
      suppressed += 1;
      console.log(`[suppression] blocked ${normalized}`);
    } catch (err) {
      console.warn(`[suppression] failed to block ${normalized}: ${err.message}`);
    }
  }
  return suppressed;
}

module.exports = { isSuppressionReply, processSuppression };
