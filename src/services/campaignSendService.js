const fs = require("fs/promises");
const path = require("path");
const { normalizeRecipientEmail } = require("./campaignStorage");
const { MAILER_FIELD_ORDER } = require("./mailerDocService");
const { sendEmail } = require("./mailerSendService");
const {
  normalizeDraft,
  normalizeDraftPreserveLines,
  normalizeSubject,
  validateDraft,
  validateSubject,
  validatePhraseSlot,
  validateFactTrace,
  OPT_OUT_LINE,
} = require("../utils/contentRules");

const STORAGE_ROOT = path.resolve(__dirname, "../../storage/campaigns");
const DEFAULT_EMAIL_TEMPLATE_PATH = path.resolve(__dirname, "../../email_template.md");

function compact(value) {
  return String(value || "").trim();
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

function resolveRecipientEmail(explicitEmail, sourceRow = {}) {
  return normalizeRecipientEmail(
    firstNonEmpty(
      explicitEmail,
      sourceRow.contactEmail,
      sourceRow.ContactEmail,
      sourceRow.email,
      sourceRow.Email,
      sourceRow.emailAddress,
      sourceRow.EmailAddress,
      sourceRow.workEmail,
      sourceRow.WorkEmail,
      sourceRow.businessEmail,
      sourceRow.BusinessEmail
    )
  );
}

function toFirstName(value) {
  const normalized = compact(value).replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  const parts = normalized.split(" ").filter(Boolean);
  return parts[0] || "";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeOpeningGreeting(text, recipientName) {
  let output = String(text || "").trim();
  if (!output) {
    return output;
  }

  const name = compact(recipientName);
  if (!name) {
    return output;
  }

  const escapedName = escapeRegExp(name);
  const greetingPrefixPattern = new RegExp(`^hi\\s+${escapedName}\\b`, "i");
  const lineBreakNormalized = output.replace(/\r\n/g, "\n");
  const lines = lineBreakNormalized.split("\n");
  if (lines.length >= 2) {
    const first = compact(lines[0]);
    const second = compact(lines[1]);
    const firstTail = first.replace(greetingPrefixPattern, "").trim();
    const firstIsGreetingOnly =
      !firstTail ||
      /^[-–—,.:;!?]+$/.test(firstTail) ||
      /^â€”$/.test(firstTail) ||
      /^â€"$/i.test(firstTail);
    const secondStartsWithSameGreeting = greetingPrefixPattern.test(second);
    if (firstIsGreetingOnly && secondStartsWithSameGreeting) {
      lines.shift();
      output = lines.join("\n").trim();
    }
  }

  const lowered = output.toLowerCase();
  const greetingLead = `hi ${name.toLowerCase()}`;
  if (lowered.startsWith(greetingLead)) {
    const secondGreetingIndex = lowered.indexOf(greetingLead, greetingLead.length);
    if (secondGreetingIndex > -1 && secondGreetingIndex < 80) {
      output = `Hi ${name} ` + output.slice(secondGreetingIndex + greetingLead.length).trimStart();
    }
  }
  return output.trim();
}

function stripKnownSignature(text) {
  let output = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!output) {
    return output;
  }

  output = output.replace(
    /\s*(?:best regards|kind regards|regards|thanks|sincerely)\s*,?\s*bharatvaj\s*goftus team\b/gi,
    ""
  );
  output = output.replace(
    /\s*(?:best regards|kind regards|regards|thanks|sincerely)\s*,?\s*[\n ]+\s*bharatvaj\s*[\n ]+\s*goftus team\s*$/i,
    ""
  );
  output = output.replace(/\s*(?:best regards|kind regards|regards|thanks|sincerely)\s*,?\s*$/i, "");
  return output.trim();
}

function normalizeBodySpacing(text) {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""));

  const normalized = [];
  let previousWasBlank = false;
  for (const line of lines) {
    const isBlank = line.trim().length < 1;
    if (isBlank) {
      if (!previousWasBlank) {
        normalized.push("");
      }
      previousWasBlank = true;
      continue;
    }
    normalized.push(line);
    previousWasBlank = false;
  }

  return normalized.join("\n").trim();
}

function resolveRecipientName(sourceRow = {}, email = "") {
  const directName = firstNonEmpty(
    sourceRow.firstName,
    sourceRow.FirstName,
    sourceRow.firstname,
    sourceRow.contactName,
    sourceRow.ContactName,
    sourceRow.fullName,
    sourceRow.FullName,
    sourceRow.name,
    sourceRow.Name
  );
  if (directName) {
    return toFirstName(directName);
  }

  const localPart = compact(email).split("@")[0] || "";
  if (!localPart) {
    return "";
  }
  const normalized = localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
  return normalized[0] || "";
}

function buildFinalEmailBody(recipientName, generatedBody) {
  const greetingName = compact(recipientName) || "there";
  const body = normalizeBodySpacing(stripKnownSignature(normalizeOpeningGreeting(generatedBody, greetingName)));
  const hasGreetingAlready = new RegExp(`^hi\\s+${escapeRegExp(greetingName)}\\b`, "i").test(body);
  if (hasGreetingAlready) {
    return [body, "", "Best regards,", "Bharatvaj", "Goftus Team"].join("\n");
  }
  return [`Hi ${greetingName},`, "", body, "", "Best regards,", "Bharatvaj", "Goftus Team"].join("\n");
}

function buildFallbackSubject(mailerFields = {}) {
  const companyToken = firstNonEmpty(mailerFields.companyName, mailerFields.targetPersona, mailerFields.industry)
    .replace(/[^A-Za-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)[0];
  const fallback = companyToken ? `${companyToken} workflow note` : "quick workflow note";
  return normalizeSubject(fallback);
}

function buildFallbackDraft(mailerFields = {}) {
  const company = firstNonEmpty(mailerFields.companyName, "your team");
  const operationalArea = firstNonEmpty(mailerFields.operationalArea, mailerFields.industry, "operations");
  const pain = firstNonEmpty(
    mailerFields.painHypothesis,
    mailerFields.prospectContextDetails,
    "manual follow up and handoffs"
  );
  const service = firstNonEmpty(
    mailerFields.yourServiceAngle,
    mailerFields.productOrService,
    "automation workflows and AI-assisted follow-up"
  );
  const deliverable = firstNonEmpty(mailerFields.frontEndOfferDeliverable, "a one page workflow outline");
  const objection = firstNonEmpty(mailerFields.objectionToPreHandle, "you already have a process in place");
  const outcome = firstNonEmpty(mailerFields.primaryOutcome, "faster handoffs and clearer ownership");

  const body = [
    `Noticed ${company} teams in ${operationalArea} often get blocked by ${pain}.`,
    `That usually leads to slow follow up, missed timing, and extra manual work.`,
    `We build ${service} so the team can move from lead to action with less friction.`,
    `A practical first step is ${deliverable}, focused on the exact bottlenecks slowing execution.`,
    `Even when ${objection}, this usually helps prioritize quick wins toward ${outcome}.`,
    `Want me to send a short outline for ${company}?`,
    OPT_OUT_LINE,
  ].join("\n");

  return normalizeDraft(body);
}

function templateCompanyProcess(mailerFields = {}) {
  return firstNonEmpty(
    mailerFields.operationalArea,
    mailerFields.painHypothesis,
    mailerFields.industry ? `${mailerFields.industry} operations` : ""
  );
}

function templateHardProblem(mailerFields = {}) {
  return firstNonEmpty(
    mailerFields.painHypothesis,
    "manual handoffs and follow-up delays"
  );
}

function templateSolutionLine(mailerFields = {}) {
  return firstNonEmpty(
    mailerFields.yourServiceAngle,
    mailerFields.productOrService,
    "We build lightweight automations and internal tools that remove those bottlenecks without adding more admin work."
  );
}

function templateAssetName(mailerFields = {}) {
  return firstNonEmpty(
    mailerFields.frontEndOfferDeliverable,
    "workflow outline"
  );
}

function fillTemplateFallback(template, { recipientName = "", mailerFields = {} } = {}) {
  const firstName = compact(recipientName) || "there";
  const company = firstNonEmpty(mailerFields.companyName, "your team");
  const process = templateCompanyProcess(mailerFields);
  const hardProblem = templateHardProblem(mailerFields);
  const solutionLine = templateSolutionLine(mailerFields);
  const assetName = templateAssetName(mailerFields);

  const filled = String(template || "").replace(/\[([^\]]+)\]/g, (_match, rawToken) => {
    const token = compact(rawToken).toLowerCase();
    if (!token) {
      return "";
    }
    if (token.includes("firstname")) {
      return firstName;
    }
    if (token.includes("company")) {
      return company;
    }
    if (token.includes("business process")) {
      return process || "handling daily operations";
    }
    if (token.includes("hardest problem") || token.includes("hard problem")) {
      return `the hardest issue right now is ${hardProblem}`;
    }
    if (token.includes("slap them with solution") || token.includes("solution")) {
      return solutionLine;
    }
    if (token.includes("assetname")) {
      return assetName;
    }
    return firstNonEmpty(hardProblem, process, company);
  });

  return normalizeDraftPreserveLines(filled);
}

function isUsableDraft(draftResult) {
  const normalized = normalizeDraft(draftResult?.draft);
  if (!normalized) {
    return false;
  }
  const compliance = draftResult?.compliance || validateDraft(normalized);
  if (compliance.ok) {
    return true;
  }
  return compliance.words >= 55 && normalized.endsWith(OPT_OUT_LINE);
}

function isUsableSubject(subjectResult) {
  const normalized = normalizeSubject(subjectResult?.subject);
  if (!normalized) {
    return false;
  }
  const compliance = subjectResult?.compliance || validateSubject(normalized);
  return compliance.ok || compliance.words >= 2;
}

function hasUnresolvedTemplateToken(value) {
  const text = String(value || "");
  if (/\[[^\]]+\]/.test(text)) return true;
  // Also catch unfilled {curly_brace} slots from the reward-style template
  if (/\{[a-z][a-z0-9_\s]{1,40}\}/.test(text)) return true;
  return false;
}

function isUsableTemplateDraft(draftResult) {
  const normalized = normalizeDraft(draftResult?.draft);
  if (!normalized) {
    return false;
  }
  if (hasUnresolvedTemplateToken(normalized)) {
    return false;
  }
  const words = normalized.split(/\s+/).filter(Boolean).length;
  return words >= 25;
}

function resolveMailerFieldsFromSourceRow(sourceRow = {}, websiteUrl = "") {
  const row = sourceRow && typeof sourceRow === "object" && !Array.isArray(sourceRow) ? sourceRow : {};
  const fields = {};
  for (const key of MAILER_FIELD_ORDER) {
    fields[key] = compact(row[key]);
  }
  fields.websiteUrl = compact(websiteUrl || row.websiteUrl || row.WebsiteUrl || row.website || row.url);
  return fields;
}

function hasReusableMailerFields(mailerFields = {}) {
  const requiredKeys = ["companyName", "painHypothesis", "yourServiceAngle"];
  return requiredKeys.every((key) => compact(mailerFields[key]));
}

class CampaignSendService {
  constructor({
    mailerDocService,
    contentService,
    reviewFetchService = null,
    ruleEngine = null,
    sendEmailFn = sendEmail,
    preferCombinedGeneration = true,
    emailTemplatePath = DEFAULT_EMAIL_TEMPLATE_PATH,
  }) {
    this.mailerDocService = mailerDocService;
    this.contentService = contentService;
    this.reviewFetchService = reviewFetchService;
    this.ruleEngine = ruleEngine;
    this.sendEmailFn = typeof sendEmailFn === "function" ? sendEmailFn : sendEmail;
    this.preferCombinedGeneration = Boolean(preferCombinedGeneration);
    this.emailTemplatePath = compact(emailTemplatePath) || DEFAULT_EMAIL_TEMPLATE_PATH;
    this.emailTemplatePromise = null;
  }

  resolveTemplateSlots(template, { mailerFields = {}, engineResult = {}, recipientName = "", yourName = "Bharatvaj" } = {}) {
    const blockageLine = engineResult.hedged
      ? `the gap I'd guess at is ${compact(engineResult.blockage)}`
      : compact(engineResult.blockage);

    let resolved = String(template || "")
      .replace(/\{firstName\}/g, compact(recipientName) || "there")
      .replace(/\{companyName\}/g, compact(mailerFields.companyName))
      .replace(/\{topStrengthPhrase\}/g, compact(mailerFields.topStrengthPhrase) || "what you have built")
      .replace(/\{secondaryStrength\}/g, compact(mailerFields.secondaryStrength) || "one key capability")
      .replace(/\{differentiator\}/g, compact(mailerFields.differentiator) || "your approach")
      .replace(/\{competitorFrame\}/g, compact(mailerFields.competitorFrame) || "others in this space")
      .replace(/\{customerType\}/g, compact(mailerFields.customerType) || "platforms like yours")
      .replace(/\{blockage\}/g, blockageLine)
      .replace(/\{benefit1\}/g, compact(engineResult.benefit1))
      .replace(/\{benefit2\}/g, compact(engineResult.benefit2))
      .replace(/\{yourName\}/g, compact(yourName) || "Bharatvaj");

    if (engineResult.register === "enterprise") {
      resolved = resolved.replace(/\nYou don't need help with the hard part\. This is just the next gear\.\n/g, "\n");
    }

    return resolved.trim();
  }

  async readEmailTemplate() {
    if (!this.emailTemplatePromise) {
      this.emailTemplatePromise = fs
        .readFile(this.emailTemplatePath, "utf8")
        .then((value) => String(value || "").trim())
        .catch(() => "");
    }
    return this.emailTemplatePromise;
  }

  async buildPreviewForRow({
    campaignId,
    rowNumber,
    websiteUrl,
    jinaContent,
    sourceRow,
    contactEmail,
    draftIterations = 1,
    abortSignal,
  }) {
    const recipientEmail = resolveRecipientEmail(contactEmail, sourceRow);

    // Step 1: Resolve mailer fields
    const reusableMailerFields = resolveMailerFieldsFromSourceRow(sourceRow, websiteUrl);
    let tableOnlyMode = false;
    let mailerFields;
    if (hasReusableMailerFields(reusableMailerFields)) {
      mailerFields = reusableMailerFields;
    } else {
      try {
        mailerFields = await this.mailerDocService.buildMailerFieldsForCampaignRow({
          rowNumber,
          websiteUrl,
          jinaContent,
          sourceRow,
          abortSignal,
        });
      } catch (error) {
        if (error.isTableFallback) {
          tableOnlyMode = true;
          mailerFields = reusableMailerFields;
        } else {
          throw error;
        }
      }
    }
    const recipientName = resolveRecipientName(sourceRow, recipientEmail);

    // Step 2: Fetch reviews (best-effort)
    let reviewResult = { reviewText: "", reviewThemesNegative: {}, reviewSignal: "none" };
    if (this.reviewFetchService) {
      try {
        reviewResult = await this.reviewFetchService.fetchReviews(
          mailerFields.companyName,
          mailerFields.industry,
          abortSignal
        );
      } catch (_error) {
        // best-effort; continue without review signal
      }
    }

    // Step 3: Run rule engine
    let engineResult = { blockage: "", benefit1: "", benefit2: "", confidence: "LOW", register: "peer", layer: "fallback", hedged: false };
    if (this.ruleEngine) {
      const isTech = mailerFields.prospectIsTechOrAutomation === "true" || mailerFields.prospectIsTechOrAutomation === true;
      engineResult = this.ruleEngine.run({
        reviewThemesNegative: reviewResult.reviewThemesNegative || {},
        reviewSignal: reviewResult.reviewSignal || "none",
        industry: mailerFields.industry || "",
        prospectIsTechOrAutomation: isTech,
        servicesCount: parseInt(String(mailerFields.servicesCount || "1"), 10) || 1,
        sizeBucket: mailerFields.sizeBucket || "mid",
        jinaContent: String(jinaContent || ""),
      });
    }

    // Step 4: Pre-resolve every template slot in code
    const template = await this.readEmailTemplate();
    const resolvedTemplate = this.resolveTemplateSlots(template, {
      mailerFields,
      engineResult,
      recipientName,
      yourName: "Bharatvaj",
    });

    // Step 5: Model lightly rephrases the pre-resolved template
    let draft = resolvedTemplate;
    if (resolvedTemplate && typeof this.contentService.generateDraftFromTemplate === "function") {
      try {
        const result = await this.contentService.generateDraftFromTemplate({
          template: resolvedTemplate,
          abortSignal,
        });
        if (result.draft && !hasUnresolvedTemplateToken(result.draft)) {
          draft = result.draft;
        }
      } catch (_error) {
        // fall back to pre-resolved template
      }
    }

    // Step 6: Validate phrase slots against source content
    const phraseCheck1 = validatePhraseSlot(mailerFields.topStrengthPhrase, jinaContent);
    const phraseCheck2 = validatePhraseSlot(mailerFields.secondaryStrength, jinaContent);

    // Step 7: Fact trace — proper nouns in draft must exist in extracted fields
    const factCheck = validateFactTrace(draft, mailerFields);

    // Step 8: Self-critique (cheap Ollama call with Y/N questions)
    let critiqueResult = { ok: true };
    if (typeof this.contentService.performSelfCritique === "function") {
      try {
        critiqueResult = await this.contentService.performSelfCritique(draft, { abortSignal });
      } catch (_error) {
        // best-effort
      }
    }

    // Step 9: Subject generation
    let finalSubjectResult = null;
    try {
      const subjectResult = await this.contentService.generateSubject(mailerFields, draft, { abortSignal });
      if (isUsableSubject(subjectResult)) {
        finalSubjectResult = subjectResult;
      }
    } catch (_error) {
      // ignore; fall through to fallback
    }
    if (!finalSubjectResult) {
      const fallbackSubject = buildFallbackSubject(mailerFields);
      finalSubjectResult = {
        subject: fallbackSubject,
        compliance: validateSubject(fallbackSubject),
        attempts: 1,
      };
    }

    // Step 10: Confidence routing — LOW confidence or failed validation → needs_review
    const validationOk = phraseCheck1.ok && phraseCheck2.ok && factCheck.ok && critiqueResult.ok;
    const needsReview = tableOnlyMode || engineResult.confidence === "LOW" || !validationOk;

    return {
      ok: true,
      campaignId,
      rowNumber,
      to: recipientEmail,
      recipientName: recipientName || "there",
      subject: finalSubjectResult.subject,
      generatedBody: draft,
      body: draft,
      mailerFields,
      engineResult,
      reviewSignal: reviewResult.reviewSignal,
      engineConfidence: engineResult.confidence,
      needsReview,
      tableOnlyMode,
      draftIterations: 1,
      compliance: {
        phraseSlots: { topStrength: phraseCheck1, secondaryStrength: phraseCheck2 },
        factTrace: factCheck,
        selfCritique: critiqueResult,
        subject: finalSubjectResult.compliance,
      },
    };
  }

  async sendPreparedEmail({ campaignId, rowNumber, to, subject, body, senderEmail = "", senderName = "", mailerFields = null }) {
    const recipientEmail = normalizeRecipientEmail(to);
    if (!recipientEmail) {
      throw new Error("Recipient email is required");
    }

    const finalSubject = compact(subject);
    const finalBody = String(body || "").trim();
    if (!finalSubject || !finalBody) {
      throw new Error("Subject and body are required before sending");
    }

    const info = await this.sendEmailFn({
      to: recipientEmail,
      subject: finalSubject,
      text: finalBody,
      senderEmail,
      senderName,
    });

    const sentAt = new Date().toISOString();
    await this.writeSendRecord({
      campaignId,
      rowNumber,
      to: recipientEmail,
      subject: finalSubject,
      body: finalBody,
      messageId: info.messageId,
      accepted: info.accepted || [],
      rejected: info.rejected || [],
      sentAt,
      mailerFields,
      sender: info.sender || null,
    });

    return {
      ok: true,
      campaignId,
      rowNumber,
      to: recipientEmail,
      subject: finalSubject,
      body: finalBody,
      messageId: info.messageId,
      accepted: info.accepted || [],
      rejected: info.rejected || [],
      sender: info.sender || null,
      sentAt,
    };
  }

  async writeSendRecord(record) {
    const targetDir = path.join(STORAGE_ROOT, record.campaignId);
    await fs.mkdir(targetDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `send-row-${record.rowNumber}-${stamp}.json`;
    await fs.writeFile(path.join(targetDir, fileName), JSON.stringify(record, null, 2));
  }
}

module.exports = {
  CampaignSendService,
  buildFinalEmailBody,
  resolveRecipientEmail,
  resolveRecipientName,
  buildFallbackDraft,
  buildFallbackSubject,
};



