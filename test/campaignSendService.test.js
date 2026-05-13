const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  CampaignSendService,
  buildFinalEmailBody,
  buildFallbackDraft,
  buildFallbackSubject,
  resolveRecipientEmail,
  resolveRecipientName,
} = require("../src/services/campaignSendService");

test("resolveRecipientEmail prefers explicit email and normalizes it", () => {
  assert.equal(resolveRecipientEmail(" PERSON@Example.COM ", { Email: "other@example.com" }), "person@example.com");
});

test("resolveRecipientEmail falls back to source row email fields", () => {
  assert.equal(resolveRecipientEmail("", { "ignored": "x", ContactEmail: "lead@example.com" }), "lead@example.com");
});

test("resolveRecipientName prefers the first name from source row", () => {
  assert.equal(resolveRecipientName({ ContactName: "Bharatvaj Ganesan" }, "lead@example.com"), "Bharatvaj");
});

test("buildFinalEmailBody wraps the generated content with greeting and signature", () => {
  assert.equal(
    buildFinalEmailBody("Bharatvaj", "Here is the generated body."),
    ["Hi Bharatvaj,", "", "Here is the generated body.", "", "Best regards,", "Bharatvaj", "Goftus Team"].join("\n")
  );
});

test("buildFinalEmailBody deduplicates repeated greeting lines from template output", () => {
  const mojibakeDash = "\u00e2\u20ac\u201d";
  const body = buildFinalEmailBody(
    "Machiel",
    `Hi Machiel ${mojibakeDash}\nHi Machiel ${mojibakeDash} saw Bluebird is focused on SaaS recruitment.\nWe build lightweight automations.`
  );

  assert.match(body, /^Hi Machiel\s*(?:-|â€”|â€")\s+saw Bluebird is focused on SaaS recruitment\./i);
  assert.doesNotMatch(body, /\nHi Machiel\s*(?:-|â€”|â€")\nHi Machiel\s*(?:-|â€”|â€")/i);
});

test("buildFinalEmailBody removes duplicate signature and extra spacing", () => {
  const raw =
    "Hi Olivier — saw Naos International is focused on executive search.\n\nWould you like me to send over a brief overview? Yes or no? Best regards, Bharatvaj Goftus Team\n\n\nBest regards,\nBharatvaj\nGoftus Team";
  const body = buildFinalEmailBody("Olivier", raw);

  assert.equal((body.match(/Best regards,/gi) || []).length, 1);
  assert.doesNotMatch(body, /\n{3,}/);
  assert.match(body, /Yes or no\?/);
});

test("buildFallbackDraft generates a usable body with opt-out line", () => {
  const draft = buildFallbackDraft({
    companyName: "Northstar Realty",
    operationalArea: "leasing operations",
    painHypothesis: "manual lead routing delays follow-up",
    yourServiceAngle: "automation workflows and lead handoff logic",
  });
  assert.match(draft, /Northstar Realty/i);
  assert.match(draft, /If not relevant, reply "no" and I won't follow up\.$/);
});

test("buildFallbackSubject generates a short safe subject", () => {
  const subject = buildFallbackSubject({ companyName: "Northstar Realty" });
  assert.equal(subject, "Northstar workflow note");
});

test("buildPreviewForRow falls back when model returns broken draft and subject", async () => {
  const service = new CampaignSendService({
    mailerDocService: {
      buildMailerFieldsForCampaignRow: async () => ({
        companyName: "Northstar Realty",
        operationalArea: "leasing operations",
        painHypothesis: "manual lead routing delays follow-up",
        yourServiceAngle: "automation workflows",
      }),
    },
    contentService: {
      generateDraft: async () => ({
        draft: "",
        compliance: { ok: false, words: 0, violations: ["empty"] },
      }),
      generateSubject: async () => ({
        subject: "",
        compliance: { ok: false, words: 0, violations: ["empty"] },
      }),
    },
    sendEmailFn: async () => ({ messageId: "test", accepted: [], rejected: [] }),
    emailTemplatePath: path.join(os.tmpdir(), "coldmailbot-nonexistent-template.md"),
  });

  const preview = await service.buildPreviewForRow({
    campaignId: "campaign-1",
    rowNumber: 2,
    websiteUrl: "https://northstar.example",
    jinaContent: "sample",
    sourceRow: { ContactName: "Alex Brown", ContactEmail: "alex@example.com" },
    contactEmail: "alex@example.com",
    draftIterations: 1,
  });

  assert.equal(preview.subject, "Northstar workflow note");
  assert.match(preview.generatedBody, /If not relevant, reply "no" and I won't follow up\.$/);
  assert.match(preview.body, /^Hi Alex,/);
});

test("buildPreviewForRow reuses source row mailer fields and skips duplicate mailer-doc generation", async () => {
  let mailerDocCalls = 0;
  const service = new CampaignSendService({
    mailerDocService: {
      buildMailerFieldsForCampaignRow: async () => {
        mailerDocCalls += 1;
        throw new Error("mailer-doc should not be called when fields already exist");
      },
    },
    contentService: {
      generateDraft: async (mailerFields) => {
        const draft = buildFallbackDraft(mailerFields);
        return {
          draft,
          compliance: { ok: true, words: 80, violations: [] },
        };
      },
      generateSubject: async () => ({
        subject: "Dispatch notes",
        compliance: { ok: true, words: 2, violations: [] },
      }),
    },
    sendEmailFn: async () => ({ messageId: "test", accepted: [], rejected: [] }),
    emailTemplatePath: path.join(os.tmpdir(), "coldmailbot-nonexistent-template.md"),
  });

  const preview = await service.buildPreviewForRow({
    campaignId: "campaign-2",
    rowNumber: 3,
    websiteUrl: "https://northstar.example",
    jinaContent: "sample",
    sourceRow: {
      companyName: "Northstar Realty",
      websiteUrl: "https://northstar.example",
      industry: "Real Estate",
      targetPersona: "Operations Manager",
      companyDescription: "Northstar handles residential portfolio operations.",
      prospectContextDetails: "Growing lead volume across regions.",
      operationalArea: "Lead routing",
      painHypothesis: "manual lead routing delays follow-up",
      yourServiceAngle: "automation workflows",
      ContactName: "Jamie",
      ContactEmail: "jamie@example.com",
    },
    contactEmail: "jamie@example.com",
    draftIterations: 1,
  });

  assert.equal(mailerDocCalls, 0);
  assert.equal(preview.mailerFields.companyName, "Northstar Realty");
  assert.match(preview.body, /^Hi Jamie(?:,|\s*[-â€”])/i);
});

test("buildPreviewForRow uses template draft generation when template is configured", async () => {
  const templatePath = path.join(os.tmpdir(), `coldmailbot-template-${Date.now()}.md`);
  await fs.writeFile(
    templatePath,
    [
      "Hi [FirstName] -",
      "Hi [FirstName] - saw [Company] is [their business process].",
      "We build lightweight automations and internal tools that remove those bottlenecks.",
      "I made a quick [AssetName] for [Company] - want me to send it?",
    ].join("\n"),
    "utf8"
  );

  let fallbackDraftCalls = 0;
  const service = new CampaignSendService({
    mailerDocService: {
      buildMailerFieldsForCampaignRow: async () => ({
        companyName: "Northstar Realty",
        operationalArea: "leasing operations",
        painHypothesis: "manual lead routing delays follow-up",
        yourServiceAngle: "automation workflows",
      }),
    },
    contentService: {
      generateDraftFromTemplate: async () => ({
        draft:
          "Hi Jamie -\nHi Jamie - saw Northstar Realty is handling leasing operations.\nWe build lightweight automations and internal tools that remove those bottlenecks without adding admin work.\nI made a quick workflow outline for Northstar Realty - want me to send it?",
        compliance: { ok: false, words: 42, violations: [] },
      }),
      generateDraft: async () => {
        fallbackDraftCalls += 1;
        return {
          draft: "",
          compliance: { ok: false, words: 0, violations: ["empty"] },
        };
      },
      generateSubject: async () => ({
        subject: "Northstar workflow note",
        compliance: { ok: true, words: 3, violations: [] },
      }),
    },
    sendEmailFn: async () => ({ messageId: "test", accepted: [], rejected: [] }),
    emailTemplatePath: templatePath,
  });

  const preview = await service.buildPreviewForRow({
    campaignId: "campaign-3",
    rowNumber: 4,
    websiteUrl: "https://northstar.example",
    jinaContent: "sample",
    sourceRow: { ContactName: "Jamie", ContactEmail: "jamie@example.com" },
    contactEmail: "jamie@example.com",
    draftIterations: 1,
  });

  await fs.rm(templatePath, { force: true });

  assert.equal(fallbackDraftCalls, 0);
  assert.match(preview.generatedBody, /Northstar Realty is handling leasing operations/i);
  assert.match(preview.body, /^Hi Jamie(?:,|\s*[-â€”])/i);
});

