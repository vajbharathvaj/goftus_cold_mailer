const DISALLOWED_PHRASES = ["free", "guaranteed", "limited time", "act now", "click here", "—"];
const SUBJECT_SALES_TERMS = [
  "proposal",
  "demo",
  "services",
  "boost",
  "scale",
  "quick call",
  "meeting",
  "schedule",
  "calendar",
  "book",
  "discount",
  "trial",
  "free trial",
  "partnership",
];

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function contextValue(lead) {
  return compact(lead.prospectContextDetails) || compact(lead.linkedInSummary) || compact(lead.companyDescription);
}

function operationalValue(lead) {
  return compact(lead.operationalArea) || compact(lead.industry);
}

function deliverableValue(lead) {
  return compact(lead.frontEndOfferDeliverable) || `1-page ${compact(lead.industry).toLowerCase()} review`;
}

function objectionValue(lead) {
  return compact(lead.objectionToPreHandle) || "you may already have an internal process in place";
}

function serviceValue(lead) {
  return compact(lead.yourServiceAngle) || compact(lead.productOrService) || "a service that removes manual work";
}

function painTriggerValue(lead) {
  return compact(lead.painTrigger) || compact(lead.painHypothesis);
}

function proofPointValue(lead) {
  return compact(lead.primaryOutcome) || "mention a brief real example from our own past work, without assuming the prospect has the same numbers";
}

function buildSystemPrompt() {
  return "Write concise B2B cold emails. Plain text only. Follow the required format exactly. Avoid hype, sales language, filler, and polished marketing language. Keep the tone natural, human, and simple. Never use em dashes (—) anywhere in the output.";
}

function buildDraftPrompt(lead) {
  const optOutLine = "If not relevant, reply \"no\" and I won't follow up.";
  return [
    "You are an expert cold email copywriter but should sound like human. Write one cold email body that gets replies.",
    "",
    "HARD RULES:",
    "- Plain text only. No links, no greeting, no signature, no subject line.",
    "- 70-110 words total.",
    "- No corporate phrases, no buzzwords, no polished marketing tone.",
    "- Do NOT invent numbers, savings, or metrics about the prospect.",
    "- This is a cold outbound pitch to the company about our service.",
    "- Sound like a real person typed this quickly, not a marketing team.",
    `- Avoid these phrases entirely: ${DISALLOWED_PHRASES.join(", ")}.`,
    "",
    "STRUCTURE (follow this order):",
    "1. HOOK (1 sentence): Open with the pain trigger and name the specific friction they feel right now.",
    "2. FRICTION (1 sentence): Agitate it briefly with a real cost like time, missed deals, or stress.",
    "3. OFFER (1-2 sentences): Explain what we do as the direct relief. Make it specific to their operational area.",
    "4. PROOF (1 sentence): Give one short first-person example from our own past work. Never present it as their result.",
    "5. PRE-HANDLE (1 sentence): Neutralize the most likely objection before they raise it.",
    `6. CTA + OPT-OUT: End with a soft yes/no question, then on a new line: ${optOutLine}`,
    "",
    "PAIN TRIGGER GUIDANCE:",
    "- The pain trigger is the single sharpest emotional or operational frustration this persona feels.",
    "- Lead with it directly. Do not warm up to it.",
    "- Use their language, not ours.",
    "",
    "INPUTS:",
    `Company: ${compact(lead.companyName)}`,
    `Target persona / role: ${compact(lead.targetPersona)}`,
    `Pain trigger: ${painTriggerValue(lead)}`,
    `Context of target customer: ${contextValue(lead)}`,
    `Operational area: ${operationalValue(lead)}`,
    `Our service: automation,ai,workflows,everthing under automations,cloud development,deatabase orgnaisation any work related to their pain `,
    `Products in their website: ${compact(lead.productOrService)},${compact(lead.yourServiceAngle)}`,
    `Deliverable we provide: This should be the most advanced automation solution right now for that pain `,
    `Effort / time constraint: ${compact(lead.timeOrEffortConstraint) || "takes 2 minutes to review"}`,
    `Most likely objection: ${objectionValue(lead)}`,
    `Our proof point: ${proofPointValue(lead)}`,
    "use the context,and pain trigger and derivate the mail after a good analysis",
    "REPLY RATE CHECKLIST (apply before finishing):",
    "- Does line 1 name their pain without preamble? If not, rewrite it.",
    "- Is every sentence easy to scan quickly? If not, cut it down.",
    "- Would a busy person understand the offer in 10 seconds? If not, simplify.",
    "- Does it sound human rather than automated? If not, rewrite.",
    "- Is the CTA a simple yes/no question? If not, change it.",
    "",
    "Return only the email body. Nothing else.",
  ].join("\n");
}

function buildSubjectPrompt(lead, draftBody) {
  return [
    "Write one subject line.",
    "Rules: 2-6 words, internal-note feel, no punctuation, no sales language.",
    `Avoid: ${DISALLOWED_PHRASES.join(", ")}, ${SUBJECT_SALES_TERMS.join(", ")}.`,
    "",
    `Company: ${compact(lead.companyName)}`,
    `Role: ${compact(lead.targetPersona)}`,
    `Context: ${contextValue(lead)}`,
    draftBody ? `Email body: ${compact(draftBody)}` : "",
    "",
    "Return only the subject.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCombinedPrompt(lead) {
  const optOutLine = "If not relevant, reply \"no\" and I won't follow up.";
  return [
    "Output exactly:",
    "Result",
    "Success",
    "Subject",
    "<one subject line>",
    "Body",
    "<email body>",
    "",
    "Subject: 2-6 words, no punctuation, no sales terms.",
    "Body: 70-110 words, plain text, no links, no greeting, no signature, one yes/no CTA. use the  their company name with person name",
    "Body: this is a cold outbound pitch to the target company about our service.",
    "Body: clearly connect our service to their current context or friction.",
    "Body: do not invent prospect-side numbers or metrics.",
    "Body: if you mention proof, make it a short first-person example from our own past work only.",
    "Body: keep the tone human, simple, and lightly conversational.",
    `Body final line: ${optOutLine}`,
    "",
    `Company: ${compact(lead.companyName)}`,
    `Role: ${compact(lead.targetPersona)}`,
    `Context: ${contextValue(lead)}`,
    `Operational area: ${operationalValue(lead)}`,
    `Our service: ${serviceValue(lead)}`,
    `Product or service: ${compact(lead.productOrService)}`,
    `Deliverable: ${deliverableValue(lead)}`,
    `Constraint: ${compact(lead.timeOrEffortConstraint) || "takes 2 minutes to review"}`,
    `Objection: ${objectionValue(lead)}`,
    `Our proof point: ${proofPointValue(lead)}`,
  ].join("\n");
}

function buildVariantsPrompt(lead) {
  const optOutLine = "If not relevant, reply \"no\" and I won't follow up.";
  return [
    "Return valid JSON only:",
    '{ "variants": [ { "subject": "...", "body": "..." }, { "subject": "...", "body": "..." }, { "subject": "...", "body": "..." } ] }',
    "",
    "Each variant must follow the same rules as the main email:",
    "- subject: 2-6 words, no punctuation, no sales language",
    `- body: 70-110 words, plain text, and end with: ${optOutLine}`,
    "- body: it is a cold outbound pitch about our service",
    "- body: make the service relevant to the company's current context or friction",
    "- body: do not invent prospect-side numbers or internal metrics",
    "- body: any proof point must be framed as our own prior project example in first person",
    "- body: keep the tone natural, human, and simple",
    "",
    `Company: ${compact(lead.companyName)}`,
    `Role: ${compact(lead.targetPersona)}`,
    `Context: ${contextValue(lead)}`,
    `Operational area: ${operationalValue(lead)}`,
    `Our service: ${serviceValue(lead)}`,
    `Product or service: ${compact(lead.productOrService)}`,
    `Deliverable: ${deliverableValue(lead)}`,
    `Constraint: ${compact(lead.timeOrEffortConstraint) || "takes 2 minutes to review"}`,
    `Objection: ${objectionValue(lead)}`,
    `Our proof point: ${proofPointValue(lead)}`,
  ].join("\n");
}

function buildTemplateDraftPrompt({ template = "" } = {}) {
  return [
    "Lightly rephrase the following cold email to sound natural and human.",
    "Do not change any names, companies, numbers, or factual details.",
    "Keep every paragraph in the same order.",
    "Plain text only. No brackets, no curly braces, no code fences, no explanations.",
    "Return only the rephrased email. Do not add or remove any section.",
    "",
    String(template || "").trim(),
  ].join("\n");
}

module.exports = {
  buildSystemPrompt,
  buildDraftPrompt,
  buildSubjectPrompt,
  buildCombinedPrompt,
  buildVariantsPrompt,
  buildTemplateDraftPrompt,
  DISALLOWED_PHRASES,
  SUBJECT_SALES_TERMS,
};
