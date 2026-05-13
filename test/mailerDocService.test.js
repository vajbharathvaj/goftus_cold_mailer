const test = require("node:test");
const assert = require("node:assert/strict");

const { MailerDocService } = require("../src/services/mailerDocService");

function createService(rawOutput) {
  return new MailerDocService({
    ollamaClient: {
      generate: async () => rawOutput,
    },
  });
}

test("buildMailerFieldsForCampaignRow parses wrapped JSON from mailer model", async () => {
  const service = createService(
    [
      "Here you go:",
      "```json",
      JSON.stringify({
        mailerFields: {
          companyName: "Acme Realty",
          industry: "Real Estate",
          targetPersona: "Operations Manager",
          painHypothesis: "Leads are dropping due to delayed follow-up.",
          yourServiceAngle: "Automated lead triage and rapid outreach.",
        },
      }),
      "```",
    ].join("\n")
  );

  const result = await service.buildMailerFieldsForCampaignRow({
    rowNumber: 12,
    websiteUrl: "https://www.acme-realty.example",
    jinaContent: "Sample content",
    sourceRow: {},
  });

  assert.equal(result.companyName, "Acme Realty");
  assert.equal(result.industry, "Real Estate");
  assert.equal(result.targetPersona, "Operations Manager");
  assert.equal(result.websiteUrl, "https://www.acme-realty.example");
});

test("buildMailerFieldsForCampaignRow falls back to key-value output", async () => {
  const service = createService(
    [
      "companyName: Skyline Homes",
      "industry: Real Estate",
      "targetPersona: Sales Director",
      "painHypothesis: Follow-ups are inconsistent.",
      "yourServiceAngle: AI-assisted outreach sequencing.",
    ].join("\n")
  );

  const result = await service.buildMailerFieldsForCampaignRow({
    rowNumber: 5,
    websiteUrl: "https://www.skyline-homes.example",
    jinaContent: "Sample content",
    sourceRow: {},
  });

  assert.equal(result.companyName, "Skyline Homes");
  assert.equal(result.industry, "Real Estate");
  assert.equal(result.targetPersona, "Sales Director");
  assert.equal(result.websiteUrl, "https://www.skyline-homes.example");
});

test("buildMailerFieldsForCampaignRow tolerates non-json output and still returns normalized fields", async () => {
  const service = createService("I could not format this as JSON.");
  const result = await service.buildMailerFieldsForCampaignRow({
    rowNumber: 9,
    websiteUrl: "https://www.riverstone.example",
    jinaContent: "Sample content",
    sourceRow: {
      companyName: "Riverstone Group",
      linkedInDescription: "Real estate investment and management firm.",
      Trigger: "Recently expanded to two new markets.",
    },
  });

  assert.equal(result.companyName, "Riverstone Group");
  assert.equal(result.websiteUrl, "https://www.riverstone.example");
  assert.equal(result.linkedInSummary, "Real estate investment and management firm.");
  assert.equal(result.prospectContextDetails, "Recently expanded to two new markets.");
});
