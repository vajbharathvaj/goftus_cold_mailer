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
    if (token.includes("observation") || token.includes("pain point") || token.includes("pain")) {
      return firstNonEmpty(hardProblem, process, "handling manual processes with no automation layer");
    }
    if (token.includes("days") || token.includes("hours") || token.includes("time")) {
      return firstNonEmpty(mailerFields.timeOrEffortConstraint, "several hours per week");
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
  return /\[[^\]]+\]/.test(String(value || ""));
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
    sendEmailFn = sendEmail,
    preferCombinedGeneration = true,
    emailTemplatePath = DEFAULT_EMAIL_TEMPLATE_PATH,
  }) {
    this.mailerDocService = mailerDocService;
    this.contentService = contentService;
    this.sendEmailFn = typeof sendEmailFn === "function" ? sendEmailFn : sendEmail;
    this.preferCombinedGeneration = Boolean(preferCombinedGeneration);
    this.emailTemplatePath = compact(emailTemplatePath) || DEFAULT_EMAIL_TEMPLATE_PATH;
    this.emailTemplatePromise = null;
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

    const reusableMailerFields = resolveMailerFieldsFromSourceRow(sourceRow, websiteUrl);
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
      } catch (_error) {
        mailerFields = reusableMailerFields;
      }
    }
    const recipientName = resolveRecipientName(sourceRow, recipientEmail);
    let draftResult = null;
    let finalSubjectResult = null;
    let templateDraftAccepted = false;
    const template = await this.readEmailTemplate();

    if (template && typeof this.contentService.generateDraftFromTemplate === "function") {
      try {
        draftResult = await this.contentService.generateDraftFromTemplate({
          lead: mailerFields,
          recipientName,
          template,
          websiteContent: jinaContent,
          abortSignal,
        });
        templateDraftAccepted = isUsableTemplateDraft(draftResult);
      } catch (_error) {
        // Template generation is preferred but optional.
      }
    }

    if (!templateDraftAccepted && !isUsableDraft(draftResult) && template) {
      const templateFallbackDraft = fillTemplateFallback(template, {
        recipientName,
        mailerFields,
      });
      if (templateFallbackDraft) {
        draftResult = {
          draft: templateFallbackDraft,
          compliance: validateDraft(templateFallbackDraft),
          attempts: (Number(draftResult?.attempts) || 0) + 1,
        };
        templateDraftAccepted = isUsableTemplateDraft(draftResult);
      }
    }

    if (
      !templateDraftAccepted &&
      !isUsableDraft(draftResult) &&
      this.preferCombinedGeneration &&
      typeof this.contentService.generateContent === "function"
    ) {
      try {
        const combinedResult = await this.contentService.generateContent(mailerFields, { abortSignal });
        const combinedBody = normalizeDraft(combinedResult?.body);
        const combinedSubject = normalizeSubject(combinedResult?.subject);

        if (combinedBody) {
          draftResult = {
            draft: combinedBody,
            compliance: combinedResult?.compliance?.draft || validateDraft(combinedBody),
            attempts: Number(combinedResult?.attempts?.draft) || 1,
          };
        }
        if (combinedSubject) {
          finalSubjectResult = {
            subject: combinedSubject,
            compliance: combinedResult?.compliance?.subject || validateSubject(combinedSubject),
            attempts: Number(combinedResult?.attempts?.subject) || 1,
          };
        }
      } catch (_error) {
        // Combined generation is an optimization path; fall back to split generation below.
      }
    }

    if (!templateDraftAccepted && !isUsableDraft(draftResult)) {
      for (let attempt = 0; attempt < draftIterations; attempt += 1) {
        try {
          draftResult = await this.contentService.generateDraft(mailerFields, { abortSignal });
        } catch (_error) {
          // Fall through to retry or fallback draft below.
        }
      }
      if (!isUsableDraft(draftResult)) {
        try {
          draftResult = await this.contentService.generateDraft(mailerFields, { abortSignal });
        } catch (_error) {
          // Ignore retry failure and fall back below.
        }
      }
      if (!isUsableDraft(draftResult)) {
        const fallbackDraft = buildFallbackDraft(mailerFields);
        draftResult = {
          draft: fallbackDraft,
          compliance: validateDraft(fallbackDraft),
          attempts: (Number(draftResult?.attempts) || 0) + 1,
        };
      }
    }

    if (!isUsableSubject(finalSubjectResult)) {
      let subjectResult = null;
      try {
        subjectResult = await this.contentService.generateSubject(mailerFields, draftResult.draft, { abortSignal });
        finalSubjectResult = subjectResult;
      } catch (_error) {
        // Fall through to fallback subject.
      }
      if (!isUsableSubject(finalSubjectResult)) {
        const fallbackSubject = buildFallbackSubject(mailerFields);
        finalSubjectResult = {
          subject: fallbackSubject,
          compliance: validateSubject(fallbackSubject),
          attempts: (Number(subjectResult?.attempts) || 0) + 1,
        };
      }
    }

    const previewBody = buildFinalEmailBody(recipientName, draftResult.draft);

    return {
      ok: true,
      campaignId,
      rowNumber,
      to: recipientEmail,
      recipientName: recipientName || "there",
      subject: finalSubjectResult.subject,
      generatedBody: draftResult.draft,
      body: previewBody,
      mailerFields,
      draftIterations,
      compliance: {
        draft: draftResult.compliance,
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



