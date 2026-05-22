const { DISALLOWED_PHRASES, SUBJECT_SALES_TERMS } = require("../prompts/contentPrompts");

const LINK_REGEX = /\bhttps?:\/\/\S+|\bwww\.\S+/i;
const SENTENCE_SPLIT_REGEX = /(?<=[.!?])\s+/;
const FLUFF_OPENER_REGEX = /\b(?:i\s+)?hope\s+(?:you(?:'re|\s+are)|all(?:'s|\s+is))\s+well\b/i;
const SUBJECT_PREFIX_REGEX = /^\s*subject\s*:/i;
const SUBJECT_PUNCTUATION_REGEX = /[^\p{L}\p{N}\s]/u;
const SIGNATURE_REGEX = /\b(?:best regards|regards|sincerely)\b|\[(?:your name|your title|your company)\]/i;
const GREETING_REGEX = /^(?:hi|hello)\b/i;
const SUBJECT_PROMOTIONAL_TERMS = ["checklist", "guide", "free", "template", "ebook", "webinar"];
const GENERIC_BODY_PHRASES = [
  "presents unique challenges",
  "operational considerations",
  "we've observed",
  "we've been",
  "we have been",
  "we're seeing",
  "i see your",
  "many teams",
  "many companies",
  "operations managers grapple",
  "struggle to",
  "in today's world",
  "we've found",
];
const VENDOR_PITCH_PHRASES = [
  "this creates new operational considerations",
  "our solution",
  "we provide",
  "we offer",
  "i'm offering",
  "i am offering",
  "could benefit from",
  "aligns with your current tms",
  "quick wins",
  "can improve",
  "platform",
  "cutting-edge",
  "innovative",
];
const OPT_OUT_LINE = "If not relevant, reply \"no\" and I won't follow up.";
const CTA_PREFIX_REGEX = /^(?:want me to send|should i send it over|worth sending)\b/i;

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeDraft(value) {
  return normalizeWhitespace(
    String(value || "")
      .replace(/^["'`\s]+|["'`\s]+$/g, "")
      .replace(/^\s*[-*]\s+/gm, "")
      .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
  );
}

function normalizeDraftPreserveLines(value) {
  const lines = String(value || "")
    .replace(/^["'`\s]+|["'`\s]+$/g, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s+/, "").replace(/[ \t]+/g, " ").trim());

  const normalized = [];
  let previousBlank = false;
  for (const line of lines) {
    const isBlank = line.length < 1;
    if (isBlank) {
      if (!previousBlank) {
        normalized.push("");
      }
      previousBlank = true;
      continue;
    }
    normalized.push(line);
    previousBlank = false;
  }

  return normalized.join("\n").trim();
}

function normalizeSubject(value) {
  return normalizeWhitespace(
    String(value || "")
      .replace(/^subject\s*:\s*/i, "")
      .replace(/[!?]/g, "")
      .replace(/^["'`\s]+|["'`\s]+$/g, "")
  );
}

function countWords(value) {
  if (!String(value || "").trim()) {
    return 0;
  }
  return String(value).trim().split(/\s+/).length;
}

function splitSentences(value) {
  return normalizeWhitespace(value)
    .split(SENTENCE_SPLIT_REGEX)
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findDisallowedPhrases(value) {
  const lower = String(value || "").toLowerCase();
  return DISALLOWED_PHRASES.filter((phrase) => new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i").test(lower));
}

function findPhraseMatches(value, phrases) {
  const lower = String(value || "").toLowerCase();
  return phrases.filter((phrase) => new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i").test(lower));
}

function parseStructuredEmailOutput(value) {
  const input = String(value || "").replace(/\r\n/g, "\n").trim();
  const match = input.match(/^Result\s*\n(Success|Fail)\s*\nSubject\s*\n([^\n]+?)\nBody\s*\n([\s\S]+)$/);
  if (!match) {
    return {
      ok: false,
      status: "",
      subject: "",
      body: "",
      violations: ["must use exactly Result, Subject, and Body sections in the required order"],
    };
  }
  return {
    ok: true,
    status: match[1].trim(),
    subject: match[2].trim(),
    body: match[3].trim(),
    violations: [],
  };
}

function parseVariantsOutput(value) {
  const input = String(value || "").trim();
  const unfenced = input.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const candidate = unfenced.includes("{") && unfenced.includes("}")
    ? unfenced.slice(unfenced.indexOf("{"), unfenced.lastIndexOf("}") + 1)
    : unfenced;
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.variants)) {
      return { ok: false, variants: [], violations: ["must be JSON with a top-level variants array"] };
    }
    if (parsed.variants.length !== 3) {
      return { ok: false, variants: [], violations: ["variants array must contain exactly 3 items"] };
    }
    const normalized = parsed.variants.map((item) => ({
      subject: typeof item?.subject === "string" ? item.subject.trim() : "",
      body: typeof item?.body === "string" ? item.body.trim() : "",
    }));
    if (normalized.some((item) => !item.subject || !item.body)) {
      return { ok: false, variants: [], violations: ["each variant must include non-empty subject and body strings"] };
    }
    return { ok: true, variants: normalized, violations: [] };
  } catch (_error) {
    return { ok: false, variants: [], violations: ["must be valid JSON only"] };
  }
}

function validateDraft(draft) {
  const normalized = normalizeDraft(draft);
  const violations = [];
  const words = countWords(normalized);
  const sentences = splitSentences(normalized);
  const blocked = findDisallowedPhrases(normalized);
  const genericMatches = findPhraseMatches(normalized, GENERIC_BODY_PHRASES);
  const vendorPitchMatches = findPhraseMatches(normalized, VENDOR_PITCH_PHRASES);

  if (words < 70) {
    violations.push(`must be at least 70 words (current: ${words})`);
  }
  if (words > 110) {
    violations.push(`must be 110 words or fewer (current: ${words})`);
  }
  if (SUBJECT_PREFIX_REGEX.test(normalized)) {
    violations.push("must not include a subject line in the email body");
  }
  if (LINK_REGEX.test(normalized)) {
    violations.push("must not include links");
  }
  if (FLUFF_OPENER_REGEX.test(normalized)) {
    violations.push("must not use fluff openers like 'hope you are well'");
  }
  if (GREETING_REGEX.test(normalized)) {
    violations.push("must not include a greeting like Hi or Hello");
  }
  if (blocked.length > 0) {
    violations.push(`contains disallowed phrase(s): ${blocked.join(", ")}`);
  }
  if (genericMatches.length > 0) {
    violations.push(`contains generic phrasing: ${genericMatches.join(", ")}`);
  }
  if (vendorPitchMatches.length > 0) {
    violations.push(`contains vendor pitch phrasing: ${vendorPitchMatches.join(", ")}`);
  }
  if (SIGNATURE_REGEX.test(normalized)) {
    violations.push("must not include a signature in the email body");
  }
  if (!normalized.endsWith(OPT_OUT_LINE)) {
    violations.push(`must end with exact opt-out line: ${OPT_OUT_LINE}`);
  }
  if (sentences.length >= 2) {
    const ctaSentence = sentences[sentences.length - 2];
    if (!CTA_PREFIX_REGEX.test(ctaSentence)) {
      violations.push("must end with a yes or no send-style CTA like 'Want me to send it?'");
    }
  }
  if (/\bwhat(?:'|’)?s your current process\b/i.test(normalized)) {
    violations.push("must not ask open-ended CTA questions like what's your current process");
  }

  return {
    ok: violations.length === 0,
    normalized,
    words,
    sentenceCount: sentences.length,
    violations,
  };
}

function validateSubject(subject) {
  const raw = String(subject || "");
  const normalized = normalizeSubject(subject);
  const violations = [];
  const words = countWords(normalized);
  const blocked = findDisallowedPhrases(normalized);
  const promotionalTerms = SUBJECT_PROMOTIONAL_TERMS.filter((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(raw));
  const salesTerms = SUBJECT_SALES_TERMS.filter((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(raw));

  if (words < 2 || words > 6) {
    violations.push(`must contain 2 to 6 words (current: ${words})`);
  }
  if (/[^\p{L}\p{N}\s]/u.test(raw)) {
    violations.push("must not contain punctuation characters");
  }
  if (/[!?]/.test(raw)) {
    violations.push("must not contain exclamation or question marks");
  }
  if (blocked.length > 0) {
    violations.push(`contains disallowed phrase(s): ${blocked.join(", ")}`);
  }
  if (promotionalTerms.length > 0) {
    violations.push(`contains promotional term(s): ${promotionalTerms.join(", ")}`);
  }
  if (salesTerms.length > 0) {
    violations.push(`contains sales or marketing term(s): ${salesTerms.join(", ")}`);
  }
  if (/^notes regarding\b/i.test(normalized)) {
    violations.push("must not use memo-like subject phrasing such as 'Notes regarding'");
  }
  if (normalized && normalized === normalized.toUpperCase() && /[A-Z]/.test(normalized)) {
    violations.push("must not be all caps");
  }
  if (/[{}[\]]/.test(raw)) {
    violations.push("must not contain personalization tokens");
  }

  return {
    ok: violations.length === 0,
    normalized,
    words,
    violations,
  };
}

module.exports = {
  normalizeDraft,
  normalizeDraftPreserveLines,
  normalizeSubject,
  validateDraft,
  validateSubject,
  countWords,
  splitSentences,
  parseStructuredEmailOutput,
  parseVariantsOutput,
  OPT_OUT_LINE,
};
