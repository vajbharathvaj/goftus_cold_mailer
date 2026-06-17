const { OpenAIClient } = require("../src/services/openaiClient");
const { ContentService } = require("../src/services/contentService");
const { MailerDocService } = require("../src/services/mailerDocService");
const { CampaignSendService } = require("../src/services/campaignSendService");
const reviewFetchService = require("../src/services/reviewFetchService");
const ruleEngine = require("../src/services/ruleEngine");
const fs = require("fs");

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error("Set OPENAI_API_KEY env var first.");
  process.exit(1);
}

const meta = JSON.parse(fs.readFileSync("./storage/campaigns/campaign-1781542660499-1d4001e4/metadata.json", "utf8"));
const row = meta.rows.find(r => (r.websiteUrl || "").includes("locusrobotics"));

const sourceRow = {
  companyName: "Locus Robotics",
  websiteUrl: row.websiteUrl,
  contactName: "Christopher Colom",
  industry: row.sourceRow["Industry"] || "Warehouse Automation / Robotics",
  targetPersona: row.sourceRow["Job title"] || "VP of Customer Success",
  companySize: row.sourceRow["Company size"] || "",
  firstName: row.sourceRow["First name"] || "Christopher",
};
const jinaContent = row.sourceRow.jina_content || row.jinaContent || "";

async function runModel(modelId, label) {
  const client = new OpenAIClient({ apiKey: API_KEY, model: modelId, timeoutMs: 90000 });
  const contentService = new ContentService({ ollamaClient: client });
  const mailerDocService = new MailerDocService({ ollamaClient: client });
  const svc = new CampaignSendService({ mailerDocService, contentService, reviewFetchService, ruleEngine });

  const preview = await svc.buildPreviewForRow({
    campaignId: "campaign-1781542660499-1d4001e4",
    rowNumber: row.rowNumber,
    websiteUrl: row.websiteUrl,
    jinaContent,
    sourceRow,
    contactEmail: row.contactEmail,
  });

  const divider = "=".repeat(60);
  console.log(`\n${divider}`);
  console.log(`MODEL: ${label} (${modelId})`);
  console.log(divider);

  const mf = preview.mailerFields;
  console.log("\n--- Mailer Fields ---");
  ["topStrengthPhrase","secondaryStrength","differentiator","competitorFrame","customerType","prospectIsTechOrAutomation","sizeBucket"].forEach(k => console.log(`${k}: ${mf[k]}`));

  console.log("\n--- Rule Engine ---");
  const e = preview.engineResult;
  console.log(`Layer: ${e.layer} | Confidence: ${e.confidence} | Register: ${e.register}`);
  console.log(`Blockage: ${e.blockage}`);
  console.log(`Benefit1: ${e.benefit1}`);
  console.log(`Benefit2: ${e.benefit2}`);

  console.log(`\nNeeds Review: ${preview.needsReview}`);
  console.log(`\n--- Subject ---\n${preview.subject}`);
  console.log(`\n--- Email ---\n${preview.body}`);

  const c = preview.compliance;
  console.log("\n--- Compliance ---");
  console.log(`Phrase slots OK: topStrength=${c.phraseSlots?.topStrength?.ok} secondaryStrength=${c.phraseSlots?.secondaryStrength?.ok}`);
  console.log(`Fact trace OK: ${c.factTrace?.ok}`);
  console.log(`Self-critique OK: ${c.selfCritique?.ok} | dashes=${c.selfCritique?.hasDashes} | claimsLacks=${c.selfCritique?.claimsCompanyLacks} | grammar=${c.selfCritique?.isGrammatical}`);

  return preview;
}

(async () => {
  const model1 = process.env.MODEL1 || "gpt-4o-mini";
  const model2 = process.env.MODEL2 || "gpt-4o";

  console.log(`Running comparison: ${model1}  vs  ${model2}`);
  console.log(`Row: Christopher Colom — Locus Robotics`);

  const [r1, r2] = await Promise.all([
    runModel(model1, "GPT-4o-mini"),
    runModel(model2, "GPT-4o (large)"),
  ]);

  console.log("\n" + "=".repeat(60));
  console.log("SIDE-BY-SIDE SUMMARY");
  console.log("=".repeat(60));
  console.log(`Needs Review:  mini=${r1.needsReview}   large=${r2.needsReview}`);
  console.log(`Confidence:    mini=${r1.engineConfidence}   large=${r2.engineConfidence}`);
})().catch(err => { console.error(err.message); process.exit(1); });
