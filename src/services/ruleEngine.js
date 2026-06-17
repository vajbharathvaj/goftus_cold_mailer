const TABLE_A = {
  response_time: {
    blockage: "lead and enquiry follow-up",
    benefit1: "respond to every enquiry in minutes",
    benefit2: "stop warm leads going cold",
  },
  scheduling: {
    blockage: "booking and scheduling",
    benefit1: "fill the calendar without phone tag",
    benefit2: "cut no-shows with auto-reminders",
  },
  support: {
    blockage: "customer support response",
    benefit1: "answer common questions instantly",
    benefit2: "escalate only what needs a human",
  },
  onboarding: {
    blockage: "new-customer onboarding",
    benefit1: "get customers to value faster",
    benefit2: "reduce early churn",
  },
  billing_admin: {
    blockage: "billing and admin follow-up",
    benefit1: "clean up invoicing touchpoints",
    benefit2: "fewer disputes and chase-ups",
  },
  comms: {
    blockage: "status updates and client comms",
    benefit1: "proactive updates with no manual effort",
    benefit2: "fewer any-news emails",
  },
  followthrough: {
    blockage: "follow-up and pipeline hygiene",
    benefit1: "nothing slips between stages",
    benefit2: "consistent multi-touch follow-up",
  },
};

const TABLE_B = {
  "real estate": {
    small: { blockage: "speed-to-lead and portal follow-up", benefit1: "reply to portal leads instantly", benefit2: "route to the right agent" },
    mid:   { blockage: "lead routing and handoff consistency", benefit1: "every lead gets a reply in minutes", benefit2: "no deals lost to slow handoffs" },
  },
  "ecommerce": {
    small: { blockage: "support and returns handling", benefit1: "instant order-status answers", benefit2: "automate returns intake" },
    mid:   { blockage: "post-purchase flow and support triage", benefit1: "resolve support tickets faster", benefit2: "retain more customers post-purchase" },
  },
  "clinic": {
    small: { blockage: "intake and scheduling", benefit1: "online intake with less front-desk load", benefit2: "auto-remind and rebook no-shows" },
    mid:   { blockage: "recall management and no-show reduction", benefit1: "fill gaps in the schedule automatically", benefit2: "improve recall rates without staff overhead" },
  },
  "saas": {
    small: { blockage: "trial-to-paid follow-up", benefit1: "convert more trials with timely nudges", benefit2: "instant support as you grow" },
    mid:   { blockage: "onboarding and support at scale", benefit1: "get users to value faster", benefit2: "deflect repetitive support tickets" },
  },
  "marketing agency": {
    small: { blockage: "lead qualification and inbound triage", benefit1: "qualify inbound automatically", benefit2: "free up time for billable work" },
    mid:   { blockage: "reporting and client updates", benefit1: "auto-generate client reports", benefit2: "fewer manual status emails" },
  },
  "logistics": {
    small: { blockage: "quote handling and turnaround", benefit1: "faster quote turnaround", benefit2: "automate shipping docs" },
    mid:   { blockage: "exception processing and order-status comms", benefit1: "proactive order updates", benefit2: "fewer manual exception calls" },
  },
  "manufacturing": {
    small: { blockage: "RFQ intake and response", benefit1: "respond to RFQs faster", benefit2: "proactive order updates to buyers" },
    mid:   { blockage: "order-status comms and doc processing", benefit1: "customers get updates without asking", benefit2: "reduce admin on order management" },
  },
  "legal": {
    small: { blockage: "client intake and document collection", benefit1: "intake clients faster", benefit2: "chase documents automatically" },
    mid:   { blockage: "document collection and follow-up at scale", benefit1: "matter-ready faster", benefit2: "fewer manual chasers per engagement" },
  },
  "accounting": {
    small: { blockage: "client intake and document collection", benefit1: "onboard clients without the paper chase", benefit2: "fewer reminder calls per engagement" },
    mid:   { blockage: "document collection and deadline comms", benefit1: "automate document requests", benefit2: "clients submit on time" },
  },
  "restaurant": {
    small: { blockage: "reservations and feedback follow-up", benefit1: "capture bookings 24/7", benefit2: "auto-request and route reviews" },
    mid:   { blockage: "booking management and review response", benefit1: "fill tables with less admin", benefit2: "protect online reputation automatically" },
  },
  "education": {
    small: { blockage: "enrolment enquiries and nurture", benefit1: "answer admissions instantly", benefit2: "nurture leads to enrolment" },
    mid:   { blockage: "onboarding sequences and student comms", benefit1: "get students started faster", benefit2: "reduce drop-off in the first week" },
  },
  "fintech": {
    small: { blockage: "onboarding and KYC follow-up", benefit1: "smoother onboarding flow", benefit2: "instant answers to common questions" },
    mid:   { blockage: "support triage and compliance comms", benefit1: "deflect routine support", benefit2: "faster compliance touchpoints" },
  },
  "home services": {
    small: { blockage: "quote requests and scheduling", benefit1: "respond to every job request fast", benefit2: "book and remind automatically" },
    mid:   { blockage: "job coordination and customer comms", benefit1: "crews always have the right info", benefit2: "customers get real-time updates" },
  },
  "fitness": {
    small: { blockage: "enquiry follow-up and trial conversion", benefit1: "convert trial enquiries without manual outreach", benefit2: "re-engage lapsing members" },
    mid:   { blockage: "retention and win-back automation", benefit1: "trigger retention sequences automatically", benefit2: "win back churned members at scale" },
  },
};

// Table C: signals are tested against jinaContent
const TABLE_C = [
  {
    signal: /book a demo|schedule a demo|free trial|start for free|get started free/i,
    blockage: "demo and trial lead handling",
    benefit1: "qualify and route demo requests fast",
    benefit2: "follow up before leads cool",
  },
  {
    signal: /partner(?:s| program| ecosystem| integrations)|marketplace|reseller/i,
    blockage: "partner and RFP intake",
    benefit1: "speed up partner and RFP responses",
    benefit2: "nothing stuck in an inbox",
  },
  {
    signal: /self.?serv|sign.?up (?:free|now|today)|get started in minutes|onboard yourself/i,
    blockage: "onboarding and support triage at scale",
    benefit1: "get users to value faster",
    benefit2: "deflect repetitive tickets",
  },
  {
    signal: /enterprise|talk to sales|contact sales|custom pricing|sales team/i,
    blockage: "sales-ops and internal reporting",
    benefit1: "automatic CRM hygiene",
    benefit2: "faster internal reporting",
  },
];

const TABLE_C_DEFAULT = {
  blockage: "demo and trial lead handling",
  benefit1: "qualify and route demo requests fast",
  benefit2: "follow up before leads cool",
};

// Industry aliases → TABLE_B keys
const INDUSTRY_MAP = [
  [/real.?estate|property|realtor|agent/i, "real estate"],
  [/ecommerc|dtc|direct.to.consumer|online.?shop|online.?store/i, "ecommerce"],
  [/retail(?! tech)|shop|store(?! app)/i, "ecommerce"],
  [/clinic|dental|medic|health(?! tech)|therap|wellness|hospital|physio/i, "clinic"],
  [/saas|software.as|subscription.?software/i, "saas"],
  [/marketing.?agenc|creative.?agenc|digital.?agenc|pr.?agenc/i, "marketing agency"],
  [/logistic|freight|3pl|shipping|transport(?!ation software)/i, "logistics"],
  [/manufactur|industrial|factory|fabricat/i, "manufacturing"],
  [/legal|law firm|attorney|solicitor|barrister/i, "legal"],
  [/account|bookkeep|tax (?:firm|advisor)|cpa\b|audit/i, "accounting"],
  [/restaur|cafe|coffee.?shop|food.?service|hospitality|hotel|resort/i, "restaurant"],
  [/education|school|training|coaching|tutoring|e.?learning/i, "education"],
  [/fintech|trading|investment|crypto|blockchain|algorithmic/i, "fintech"],
  [/home.?service|trades|plumb|electric|hvac|landscap|cleaning/i, "home services"],
  [/fitness|gym|yoga|pilates|wellness.?studio/i, "fitness"],
];

const TECH_AUTOMATION_PATTERN =
  /\b(?:software|saas|ai\b|machine.?learning|automation|robotics|devops|dev.?tool|api.?platform|cloud.?platform|data.?platform|it.?service)\b/i;

function normalizeIndustry(industry) {
  const text = String(industry || "");
  for (const [pattern, key] of INDUSTRY_MAP) {
    if (pattern.test(text)) return key;
  }
  return null;
}

function detectSizeBucket(facts) {
  const raw = String(facts.sizeBucket || "").toLowerCase();
  if (/large|enterprise/.test(raw)) return "large";
  if (/mid|medium/.test(raw)) return "mid";
  if (/small|solo|micro/.test(raw)) return "small";
  const svcCount = Number.parseInt(facts.servicesCount, 10);
  if (Number.isFinite(svcCount)) {
    if (svcCount >= 10) return "large";
    if (svcCount >= 3) return "mid";
  }
  return "small";
}

function getStrongestNegativeTheme(reviewThemesNegative) {
  if (!reviewThemesNegative || typeof reviewThemesNegative !== "object") return null;
  let best = null;
  let bestCount = 0;
  for (const [theme, count] of Object.entries(reviewThemesNegative)) {
    if (Number(count) >= 2 && Number(count) > bestCount && TABLE_A[theme]) {
      best = theme;
      bestCount = Number(count);
    }
  }
  return best;
}

function runTableC(jinaContent) {
  const text = String(jinaContent || "");
  for (const entry of TABLE_C) {
    if (entry.signal.test(text)) {
      return { blockage: entry.blockage, benefit1: entry.benefit1, benefit2: entry.benefit2 };
    }
  }
  return { ...TABLE_C_DEFAULT };
}

function run(facts) {
  const {
    prospectIsTechOrAutomation,
    reviewThemesNegative = {},
    reviewSignal = "none",
    servicesCount,
    sizeBucket: rawSizeBucket,
    industry = "",
    jinaContent = "",
  } = facts || {};

  const sizeBucket = detectSizeBucket({ servicesCount, sizeBucket: rawSizeBucket });

  const isTech =
    prospectIsTechOrAutomation === true ||
    String(prospectIsTechOrAutomation).toLowerCase() === "true" ||
    TECH_AUTOMATION_PATTERN.test(String(industry));

  // 1. ICP GUARD — tech/AI/automation prospect
  if (isTech) {
    const tableC = runTableC(jinaContent);
    return {
      ...tableC,
      confidence: "HIGH",
      register: sizeBucket === "large" ? "enterprise" : "peer",
      layer: "C",
      hedged: false,
    };
  }

  // 5. SIZE OVERRIDE — large companies route to internal-ops or disqualify
  if (sizeBucket === "large") {
    const tableC = runTableC(jinaContent);
    return {
      ...tableC,
      confidence: "MEDIUM",
      register: "enterprise",
      layer: "C",
      hedged: false,
    };
  }

  // 2. EVIDENCE LAYER — reviews exist with strong negative signal
  const strongestTheme = getStrongestNegativeTheme(reviewThemesNegative);
  if (strongestTheme) {
    const entry = TABLE_A[strongestTheme];
    return {
      blockage: entry.blockage,
      benefit1: entry.benefit1,
      benefit2: entry.benefit2,
      confidence: "HIGH",
      register: "peer",
      layer: "A",
      hedged: false,
    };
  }

  // 3. SERVICE-MIX HEURISTIC
  const svcCount = Number.parseInt(servicesCount, 10);
  if (Number.isFinite(svcCount) && svcCount >= 3 && sizeBucket === "small") {
    return {
      blockage: "enquiry routing and triage across services",
      benefit1: "every enquiry reaches the right person fast",
      benefit2: "no leads lost between service lines",
      confidence: "MEDIUM",
      register: "peer",
      layer: "B",
      hedged: false,
    };
  }

  // 4. FALLBACK LAYER — industry × size
  const industryKey = normalizeIndustry(industry);
  const tableB = industryKey ? TABLE_B[industryKey] : null;
  if (tableB) {
    const entry = tableB[sizeBucket] || tableB.small;
    if (entry) {
      return {
        blockage: entry.blockage,
        benefit1: entry.benefit1,
        benefit2: entry.benefit2,
        confidence: "LOW",
        register: "peer",
        layer: "B",
        hedged: true,
      };
    }
  }

  // Generic fallback
  return {
    blockage: "manual follow-up and workflow handoffs",
    benefit1: "move leads to action faster",
    benefit2: "less time on repetitive coordination",
    confidence: "LOW",
    register: "peer",
    layer: "B",
    hedged: true,
  };
}

module.exports = { run, TABLE_A, TABLE_B, TABLE_C, normalizeIndustry };
