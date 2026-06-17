const path = require("path");
const { OllamaClient } = require("../src/services/ollamaClient");
const { ContentService } = require("../src/services/contentService");
const { MailerDocService } = require("../src/services/mailerDocService");
const { CampaignSendService } = require("../src/services/campaignSendService");
const reviewFetchService = require("../src/services/reviewFetchService");
const ruleEngine = require("../src/services/ruleEngine");

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "gemma3:4b";

const row = {
  rowNumber: 1,
  websiteUrl: "https://deepvalue.com",
  contactEmail: "",
  jinaContent: `Deep Value is an investment firm that engages in long duration investments within the fintech and cryptocurrency sectors, with a background in high volume automated trading of US equities and proprietary trading of cryptocurrencies. Following the sale of its trading business, Deep Value now functions as an investment vehicle managing a portfolio of equity holdings and other assets.

Historically, the company was known for developing world-class trading algorithms, contributing between one to two percent of overall equity trading volume to US stock markets daily. Deep Value also provided a FAST Parity Service, giving buy-side firms floor-wide access to NYSE parity allocations via custom algorithmic strategies through Floor brokers.

The company was founded in 2005 and is based in Chicago, Illinois. Deep Value has offices in Chicago, Toronto, New York, London, Bangalore and Chennai.`,
  sourceRow: {
    website: "https://deepvalue.com",
    companyName: "Deep Value",
    email: "",
  },
};

async function main() {
  const ollamaClient = new OllamaClient({
    baseUrl: OLLAMA_BASE_URL,
    model: MODEL,
    timeoutMs: 60000,
  });

  const contentService = new ContentService({ ollamaClient });
  const mailerDocService = new MailerDocService({ ollamaClient });
  const campaignSendService = new CampaignSendService({
    mailerDocService,
    contentService,
    reviewFetchService,
    ruleEngine,
  });

  console.log("=== Step 1: Extracting mailer fields from jinaContent ===\n");
  const preview = await campaignSendService.buildPreviewForRow({
    campaignId: "campaign-1782000000000-deepvalue",
    rowNumber: row.rowNumber,
    websiteUrl: row.websiteUrl,
    jinaContent: row.jinaContent,
    sourceRow: row.sourceRow,
    contactEmail: row.contactEmail,
  });

  console.log("=== RULE ENGINE RESULT ===");
  console.log(JSON.stringify(preview.engineResult, null, 2));
  console.log("\n=== REVIEW SIGNAL:", preview.reviewSignal, "===");
  console.log("=== CONFIDENCE:", preview.engineConfidence, "===");
  console.log("=== NEEDS REVIEW:", preview.needsReview, "===");
  console.log("\n=== SUBJECT ===\n" + preview.subject);
  console.log("\n=== GENERATED EMAIL ===\n" + preview.body);
  console.log("\n=== COMPLIANCE ===");
  console.log(JSON.stringify(preview.compliance, null, 2));
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
