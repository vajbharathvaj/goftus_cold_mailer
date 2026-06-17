const fs = require("fs");
const path = require("path");

const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = "gemma3:4b";

const mailerFields = {
  companyName: "Deep Value",
  websiteUrl: "https://deepvalue.com",
  industry: "fintech algorithmic trading",
  targetPersona: "Head of Trading",
  companyDescription: "Deep Value is an investment firm specializing in long-duration investments within the fintech and cryptocurrency sectors, leveraging expertise in automated trading.",
  linkedInSummary: "",
  prospectContextDetails: "Historical development of world-class trading algorithms and floor-wide access to NYSE parity allocations.",
  operationalArea: "Algorithmic Trading",
  painHypothesis: "The firm's reliance on manual floor broker coordination for parity allocations creates inefficiencies.",
  yourServiceAngle: "Automated algorithmic solutions for real-time parity access.",
  productOrService: "AI-powered algorithmic trading platform",
  primaryOutcome: "Increased trading efficiency and market access.",
  frontEndOfferDeliverable: "Customized algorithmic trading strategy implementation",
  timeOrEffortConstraint: "takes 2 minutes to review",
  objectionToPreHandle: "Concerns about the complexity of integrating new technology.",
  topStrengthPhrase: "Proven algorithmic trading expertise and market access.",
  secondaryStrength: "Custom algorithmic strategy development",
  differentiator: "Real-time parity access through automated algorithms.",
  competitorFrame: "Traditional floor broker services",
  customerType: "Buy-Side Trading Firms",
  blockage: "Manual coordination with floor brokers for NYSE parity allocations.",
  benefit1: "Reduced operational costs associated with floor broker fees.",
  benefit2: "Improved market access and trading opportunities.",
};

async function ollamaGenerate(system, prompt, numPredict = 600) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      system,
      prompt,
      options: { temperature: 0.3, top_p: 0.85, top_k: 40, repeat_penalty: 1.15, num_predict: numPredict },
    }),
  });
  const json = await res.json();
  return (json.response || "").trim();
}

async function run() {
  const template = fs.readFileSync(path.resolve(__dirname, "../email_template.md"), "utf8").trim();
  const f = mailerFields;

  const templatePrompt = [
    "You are writing one cold outreach email from a strict template.",
    "Replace every [ ... ] placeholder and every {variable} slot using the provided context fields.",
    "Keep the same line order and overall structure from the template.",
    "Return plain text only. No brackets, no curly braces, no code fences, no notes.",
    "Return only the filled email once. Do not repeat any paragraph, sentence, or section.",
    "",
    "TEMPLATE VARIABLE MAPPING:",
    `- {top_strength_phrase} → ${f.topStrengthPhrase}`,
    `- {secondary_strength} → ${f.secondaryStrength}`,
    `- {differentiator} → ${f.differentiator}`,
    `- {competitor_frame} → ${f.competitorFrame}`,
    `- {customer_type} → ${f.customerType}`,
    `- {blockage} → ${f.blockage}`,
    `- {benefit_1} → ${f.benefit1}`,
    `- {benefit_2} → ${f.benefit2}`,
    `- {company} → ${f.companyName}`,
    `- {first_name} → there`,
    "",
    "Context:",
    `Company: ${f.companyName}`,
    `Industry: ${f.industry}`,
    `Target persona: ${f.targetPersona}`,
    `Company context: ${f.prospectContextDetails}`,
    `Operational area: ${f.operationalArea}`,
    `Pain hypothesis: ${f.painHypothesis}`,
    `Service angle: ${f.yourServiceAngle}`,
    `Primary outcome: ${f.primaryOutcome}`,
    `Objection to pre-handle: ${f.objectionToPreHandle}`,
    "",
    "Template:",
    template,
    "",
    "Return only the final filled email body. Do not repeat any section.",
  ].join("\n");

  const subjectPrompt = [
    "Write one subject line.",
    "Rules: 2-6 words, internal-note feel, no punctuation, no sales language.",
    `Company: ${f.companyName}`,
    `Role: ${f.targetPersona}`,
    `Context: ${f.prospectContextDetails}`,
    "",
    "Return only the subject.",
  ].join("\n");

  console.log("=== STEP 1: generating email body from template ===\n");
  const body = await ollamaGenerate(
    "Write concise B2B cold emails. Plain text only. Never use em dashes anywhere.",
    templatePrompt,
    600
  );
  console.log(body);

  console.log("\n\n=== STEP 2: generating subject line ===\n");
  const subject = await ollamaGenerate(
    "Write concise B2B cold email subject lines. Plain text only.",
    subjectPrompt,
    30
  );
  console.log(subject);

  console.log("\n\n=== FINAL EMAIL ===\n");
  console.log(`Subject: ${subject}`);
  console.log("");
  console.log(body);
}

run().catch(console.error);
