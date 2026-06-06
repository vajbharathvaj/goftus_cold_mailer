const fs = require("fs/promises");
const path = require("path");
const { Document, HeadingLevel, Packer, Paragraph, TextRun } = require("docx");

const STORAGE_ROOT = path.resolve(__dirname, "../../storage/campaigns");
const CONTENT_INPUT_LIMIT = 12000;
const MAILER_FIELD_ORDER = [
  "companyName",
  "websiteUrl",
  "industry",
  "targetPersona",
  "companyDescription",
  "linkedInSummary",
  "prospectContextDetails",
  "operationalArea",
  "painHypothesis",
  "yourServiceAngle",
  "productOrService",
  "primaryOutcome",
  "frontEndOfferDeliverable",
  "timeOrEffortConstraint",
  "objectionToPreHandle",
];

const MAILER_FIELD_LABELS = {
  companyName: "Company Name",
  websiteUrl: "Website URL",
  industry: "Industry",
  targetPersona: "Target Persona",
  companyDescription: "Company Description",
  linkedInSummary: "LinkedIn Summary",
  prospectContextDetails: "Trigger Detail",
  operationalArea: "Operational Area",
  painHypothesis: "Pain Hypothesis",
  yourServiceAngle: "Service Angle",
  productOrService: "Product / Service",
  primaryOutcome: "Primary Outcome",
  frontEndOfferDeliverable: "Front-End Deliverable",
  timeOrEffortConstraint: "Time / Effort Constraint",
  objectionToPreHandle: "Objection",
};

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncatePromptContent(value) {
  const normalized = String(value || "").trim();
  if (normalized.length <= CONTENT_INPUT_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, CONTENT_INPUT_LIMIT)}\n\n[truncated for prompt]`;
}

function extractJsonObject(value) {
  const input = String(value || "").trim();
  if (!input) {
    throw new Error("Mailer model did not return a JSON object");
  }
  const candidates = [];
  const seen = new Set();
  const pushCandidate = (candidate) => {
    const normalized = String(candidate || "").trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  const stripFenceWrapper = (text) => {
    const trimmed = String(text || "").trim();
    if (!trimmed.startsWith("```")) {
      return trimmed;
    }
    const lines = trimmed.split(/\r?\n/);
    if (lines.length < 2) {
      return trimmed;
    }
    if (lines[0].trim().startsWith("```")) {
      lines.shift();
    }
    if (lines.length > 0 && lines[lines.length - 1].trim() === "```") {
      lines.pop();
    }
    return lines.join("\n").trim();
  };

  const looksLikeMailerFields = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return false;
    }
    return MAILER_FIELD_ORDER.some((key) => Object.prototype.hasOwnProperty.call(obj, key));
  };

  const unwrapMailerObject = (obj) => {
    if (looksLikeMailerFields(obj)) {
      return obj;
    }
    const wrappedKeys = ["mailerFields", "fields", "output", "data"];
    for (const key of wrappedKeys) {
      const nested = obj?.[key];
      if (looksLikeMailerFields(nested)) {
        return nested;
      }
    }
    return null;
  };

  const tryParseCandidate = (candidate) => {
    const text = String(candidate || "").trim();
    if (!text) {
      return null;
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") {
        try {
          const reparsed = JSON.parse(parsed);
          return unwrapMailerObject(reparsed);
        } catch (_error) {
          return null;
        }
      }
      return unwrapMailerObject(parsed);
    } catch (_error) {
      return null;
    }
  };

  const extractCodeBlocks = (text) => {
    const blocks = [];
    const regex = /```(?:json|javascript|js)?\s*([\s\S]*?)```/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
      blocks.push(String(match[1] || "").trim());
    }
    return blocks;
  };

  const findBalancedJsonObjects = (text, limit = 12) => {
    const source = String(text || "");
    const snippets = [];
    let start = source.indexOf("{");
    while (start >= 0 && snippets.length < limit) {
      let depth = 0;
      let inString = false;
      let escape = false;
      let end = -1;
      for (let index = start; index < source.length; index += 1) {
        const ch = source[index];
        if (inString) {
          if (escape) {
            escape = false;
            continue;
          }
          if (ch === "\\") {
            escape = true;
            continue;
          }
          if (ch === "\"") {
            inString = false;
          }
          continue;
        }
        if (ch === "\"") {
          inString = true;
          continue;
        }
        if (ch === "{") {
          depth += 1;
          continue;
        }
        if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            end = index;
            break;
          }
        }
      }
      if (end > start) {
        snippets.push(source.slice(start, end + 1));
      }
      start = source.indexOf("{", start + 1);
    }
    return snippets;
  };

  const parseKeyValueFallback = (text) => {
    const source = String(text || "");
    const fields = {};
    let hits = 0;
    const escapeRegex = (raw) => String(raw || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const key of MAILER_FIELD_ORDER) {
      const aliases = [key, MAILER_FIELD_LABELS[key]].filter(Boolean);
      let match = null;
      for (const alias of aliases) {
        const pattern = new RegExp(`^[\\s>*-]*["']?${escapeRegex(alias)}["']?\\s*[:=-]\\s*(.+)$`, "im");
        match = source.match(pattern);
        if (match) {
          break;
        }
      }
      if (!match) {
        continue;
      }
      let valueText = String(match[1] || "").trim();
      const quoted = valueText.match(/^"(.*)"$|^'(.*)'$/);
      if (quoted) {
        valueText = String(quoted[1] || quoted[2] || "").trim();
      }
      fields[key] = valueText;
      hits += 1;
    }
    return hits >= 2 ? fields : null;
  };

  pushCandidate(input);
  pushCandidate(stripFenceWrapper(input));
  for (const block of extractCodeBlocks(input)) {
    pushCandidate(block);
  }

  for (const candidate of candidates) {
    const parsed = tryParseCandidate(candidate);
    if (parsed) {
      return JSON.stringify(parsed);
    }
    for (const snippet of findBalancedJsonObjects(candidate)) {
      const parsedSnippet = tryParseCandidate(snippet);
      if (parsedSnippet) {
        return JSON.stringify(parsedSnippet);
      }
    }
  }

  const fallback = parseKeyValueFallback(stripFenceWrapper(input));
  if (fallback) {
    return JSON.stringify(fallback);
  }

  throw new Error("Mailer model did not return a JSON object");
}

function safeSourceRow(sourceRow) {
  if (!sourceRow || typeof sourceRow !== "object" || Array.isArray(sourceRow)) {
    return {};
  }
  return Object.fromEntries(Object.entries(sourceRow).map(([key, value]) => [key, compact(value)]));
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = compact(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function inferCompanyName(sourceRow, websiteUrl) {
  const direct = firstNonEmpty(
    sourceRow.companyName,
    sourceRow.CompanyName,
    sourceRow.company,
    sourceRow.Company,
    sourceRow.name,
    sourceRow.Name
  );
  if (direct) {
    return direct;
  }
  try {
    const host = new URL(websiteUrl).hostname.replace(/^www\./i, "");
    const stem = host.split(".")[0] || host;
    return stem
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  } catch (_error) {
    return "";
  }
}

function buildSystemPrompt() {
  return "You convert website research into structured B2B outreach briefing fields. Return JSON only. Use concise professional language. If a field is unknown, return an empty string.";
}

function buildPrompt({ rowNumber, websiteUrl, jinaContent, sourceRow }) {
  return [
    "Fill the following outreach fields for one B2B prospect from the provided research.",
    "Return valid JSON only with exactly these keys:",
    JSON.stringify(MAILER_FIELD_ORDER, null, 2),
    "",
    "FIELD GUIDANCE:",
    "- industry: Name the specific sub-niche, not a broad category (e.g. 'freight brokerage', 'dental practice management', 'B2B SaaS for HR teams'). Avoid generic labels like 'technology' or 'services'.",
    "- painHypothesis: The most important field. Write ONE sharp, specific sentence naming a concrete operational problem this company faces RIGHT NOW.",
    "  How to derive it:",
    "  Step 1 — Identify the most common operational pain for companies in this exact niche.",
    "  Step 2 — Find specific signals in the website text: what do they do manually, what scale they are at, what process gaps are visible.",
    "  Step 3 — Combine both into a single observation personalised to THIS company, not a generic industry statement.",
    "  Write as a direct observation, e.g. 'They are managing [X] manually across [Y]' or 'Their [process] likely bottlenecks at [specific stage]'.",
    "  Do NOT write a question. Do NOT use vague phrases like 'struggle with growth' or 'face challenges'.",
    "- prospectContextDetails: One specific trigger or signal visible on the website that makes NOW the right time to reach out — recent growth, new product launch, team expansion, rebranding.",
    "- operationalArea: The exact business function where the pain lives (e.g. 'sales ops', 'client onboarding', 'procurement'). One short phrase.",
    "- companyDescription: 1-2 sentences — what they do, who they serve, how they work.",
    "- targetPersona: The role most responsible for this pain (e.g. 'Head of Operations', 'Founder', 'VP of Sales'). Be specific.",
    "",
    `Selected row: ${rowNumber}`,
    `Website URL: ${websiteUrl}`,
    "",
    "Source row values:",
    JSON.stringify(sourceRow, null, 2),
    "",
    "Enriched website text:",
    truncatePromptContent(jinaContent),
  ].join("\n");
}

function normalizeMailerFields(parsed, websiteUrl, sourceRow) {
  const normalized = {};
  for (const key of MAILER_FIELD_ORDER) {
    normalized[key] = compact(parsed?.[key]);
  }
  normalized.websiteUrl = compact(websiteUrl);
  normalized.companyName = firstNonEmpty(normalized.companyName, inferCompanyName(sourceRow, websiteUrl));
  normalized.linkedInSummary = firstNonEmpty(
    sourceRow.linkedInDescription,
    sourceRow.linkedin_description,
    sourceRow.linkedInSummary,
    sourceRow.LinkedInSummary,
    normalized.linkedInSummary
  );
  normalized.companyDescription = firstNonEmpty(normalized.companyDescription, sourceRow.companyDescription, sourceRow.Description);
  normalized.prospectContextDetails = firstNonEmpty(
    normalized.prospectContextDetails,
    sourceRow.prospectContextDetails,
    sourceRow.Trigger,
    sourceRow.TriggerDetail
  );
  return normalized;
}

class MailerDocService {
  constructor({ ollamaClient }) {
    this.ollamaClient = ollamaClient;
  }

  async buildMailerFieldsForCampaignRow({ rowNumber, websiteUrl, jinaContent, sourceRow, abortSignal } = {}) {
    const cleanSourceRow = safeSourceRow(sourceRow);
    const raw = await this.ollamaClient.generate({
      system: buildSystemPrompt(),
      prompt: buildPrompt({ rowNumber, websiteUrl, jinaContent, sourceRow: cleanSourceRow }),
      options: { abortSignal },
    });

    let parsed = {};
    try {
      parsed = JSON.parse(extractJsonObject(raw));
    } catch (error) {
      console.warn(
        `[mailer-doc] row=${rowNumber} non-json model output; using fallback normalization: ${error.message}`
      );
    }

    return normalizeMailerFields(parsed, websiteUrl, cleanSourceRow);
  }

  async generateForCampaignRow({ campaignId, rowNumber, websiteUrl, jinaContent, sourceRow, abortSignal } = {}) {
    const mailerFields = await this.buildMailerFieldsForCampaignRow({
      rowNumber,
      websiteUrl,
      jinaContent,
      sourceRow,
      abortSignal,
    });
    const targetDir = path.join(STORAGE_ROOT, campaignId);
    await fs.mkdir(targetDir, { recursive: true });
    const docFileName = await this.resolveDocFileName(targetDir, rowNumber);
    const docPath = path.join(targetDir, docFileName);
    await fs.writeFile(docPath, await this.buildDocBuffer({ campaignId, rowNumber, mailerFields }));

    return {
      ok: true,
      campaignId,
      rowNumber,
      docFileName,
      mailerFields,
    };
  }

  async resolveDocFileName(targetDir, rowNumber) {
    const baseName = `mailer-row-${rowNumber}`;
    let attempt = 0;
    while (true) {
      const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
      const fileName = `${baseName}${suffix}.docx`;
      try {
        await fs.access(path.join(targetDir, fileName));
        attempt += 1;
      } catch (_error) {
        return fileName;
      }
    }
  }

  async buildDocBuffer({ campaignId, rowNumber, mailerFields }) {
    const children = [
      new Paragraph({ text: "Mailer Field Output", heading: HeadingLevel.TITLE }),
      new Paragraph({
        children: [
          new TextRun({ text: `Campaign: ${campaignId}`, bold: true }),
          new TextRun({ text: ` | Row: ${rowNumber}` }),
        ],
      }),
      new Paragraph({ text: "" }),
    ];

    for (const key of MAILER_FIELD_ORDER) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: MAILER_FIELD_LABELS[key], bold: true })],
          heading: HeadingLevel.HEADING_2,
        })
      );
      children.push(new Paragraph({ text: mailerFields[key] || "" }));
    }

    const document = new Document({
      sections: [{ properties: {}, children }],
    });

    return Packer.toBuffer(document);
  }
}

module.exports = {
  MAILER_FIELD_ORDER,
  MAILER_FIELD_LABELS,
  MailerDocService,
};
