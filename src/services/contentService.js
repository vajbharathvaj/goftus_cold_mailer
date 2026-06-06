const {
  buildSystemPrompt,
  buildDraftPrompt,
  buildSubjectPrompt,
  buildCombinedPrompt,
  buildVariantsPrompt,
  buildTemplateDraftPrompt,
} = require("../prompts/contentPrompts");
const {
  validateDraft,
  validateSubject,
  normalizeDraft,
  normalizeDraftPreserveLines,
  normalizeSubject,
  parseStructuredEmailOutput,
  parseVariantsOutput,
} = require("../utils/contentRules");

const VARIANT_LABELS = ["A", "B", "C"];

class ContentService {
  constructor({ ollamaClient }) {
    this.ollamaClient = ollamaClient;
  }

  async generateDraft(lead, { abortSignal } = {}) {
    const raw = await this.ollamaClient.generate({
      system: buildSystemPrompt(),
      prompt: buildDraftPrompt(lead),
      options: { abortSignal },
    });

    return {
      draft: normalizeDraft(raw),
      compliance: validateDraft(raw),
      attempts: 1,
    };
  }

  async generateDraftFromTemplate({ lead, recipientName = "", template = "", websiteContent = "", abortSignal } = {}) {
    const raw = await this.ollamaClient.generate({
      system: buildSystemPrompt(),
      prompt: buildTemplateDraftPrompt({
        lead,
        recipientName,
        template,
        websiteContent,
      }),
      options: { abortSignal },
    });

    return {
      draft: normalizeDraftPreserveLines(raw),
      compliance: validateDraft(raw),
      attempts: 1,
    };
  }

  async generateSubject(lead, draftBody = "", { abortSignal } = {}) {
    const raw = await this.ollamaClient.generate({
      system: buildSystemPrompt(),
      prompt: buildSubjectPrompt(lead, draftBody),
      options: { abortSignal },
    });

    return {
      subject: normalizeSubject(raw),
      compliance: validateSubject(raw),
      attempts: 1,
    };
  }

  async generateContent(lead, { abortSignal } = {}) {
    const raw = await this.ollamaClient.generate({
      system: buildSystemPrompt(),
      prompt: buildCombinedPrompt(lead),
      options: { abortSignal },
    });
    const parsed = parseStructuredEmailOutput(raw);

    if (!parsed.ok || parsed.status !== "Success") {
      const body = normalizeDraft(raw);
      return {
        subject: "N A",
        body,
        compliance: {
          draft: {
            ok: false,
            normalized: body,
            words: 0,
            sentenceCount: 0,
            violations: ["model did not return the required Result/Success/Subject/Body format"],
          },
          subject: {
            ok: false,
            normalized: "",
            words: 0,
            violations: ["model did not return a valid structured subject"],
          },
        },
        attempts: { draft: 1, subject: 1 },
        requiresHumanReview: false,
      };
    }

    return {
      subject: normalizeSubject(parsed.subject),
      body: normalizeDraft(parsed.body),
      compliance: {
        draft: validateDraft(parsed.body),
        subject: validateSubject(parsed.subject),
      },
      attempts: { draft: 1, subject: 1 },
      requiresHumanReview: false,
    };
  }

  async generateVariants(lead, { abortSignal } = {}) {
    const raw = await this.ollamaClient.generate({
      system: buildSystemPrompt(),
      prompt: buildVariantsPrompt(lead),
      options: { abortSignal },
    });
    const parsed = parseVariantsOutput(raw);

    return {
      variants: parsed.ok
        ? parsed.variants.map((item, index) => ({
            label: VARIANT_LABELS[index] || String(index + 1),
            subject: normalizeSubject(item.subject),
            body: normalizeDraft(item.body),
            compliance: {
              subject: validateSubject(item.subject),
              draft: validateDraft(item.body),
            },
          }))
        : [],
      attempts: 1,
      requiresHumanReview: false,
    };
  }
}

module.exports = { ContentService };
