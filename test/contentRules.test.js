const test = require("node:test");
const assert = require("node:assert/strict");

const {
  OPT_OUT_LINE,
  normalizeDraft,
  normalizeDraftPreserveLines,
  normalizeSubject,
  parseStructuredEmailOutput,
  parseVariantsOutput,
  validateDraft,
  validateSubject,
} = require("../src/utils/contentRules");

test("normalizeDraft strips wrapping punctuation and markdown links", () => {
  const value = ' "Hello [team](https://example.com)  " ';
  assert.equal(normalizeDraft(value), "Hello team");
});

test("normalizeDraftPreserveLines keeps paragraph breaks", () => {
  const value = ' "Hi [team](https://example.com)\n\n  next line  " ';
  assert.equal(normalizeDraftPreserveLines(value), "Hi team\n\nnext line");
});

test("normalizeSubject strips subject prefixes and punctuation", () => {
  assert.equal(normalizeSubject("Subject: Dispatch notes?!"), "Dispatch notes");
});

test("validateDraft accepts a compliant draft", () => {
  const draft = [
    "Noticed Acme is adding new depots while dispatch teams still juggle SLA updates across email and spreadsheets.",
    "That usually creates handoff delays when priorities shift mid-day.",
    "I put together a 1-page dispatch review that maps where response time slips and where alerts can be tightened without replacing your current tools.",
    "It takes 2 minutes to review and may surface one quick fix for the team.",
    "Want me to send it over?",
    OPT_OUT_LINE,
  ].join(" ");

  const result = validateDraft(draft);
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test("validateDraft flags links, greetings, and missing opt-out line", () => {
  const draft = "Hi team, review this at https://example.com and let me know what you think.";
  const result = validateDraft(draft);

  assert.equal(result.ok, false);
  assert.match(result.violations.join(" | "), /must not include links/i);
  assert.match(result.violations.join(" | "), /must not include a greeting/i);
  assert.match(result.violations.join(" | "), /must end with exact opt-out line/i);
});

test("validateSubject accepts a compliant subject", () => {
  const result = validateSubject("Dispatch notes");
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test("validateSubject rejects sales language and punctuation", () => {
  const result = validateSubject("Free demo!");
  assert.equal(result.ok, false);
  assert.match(result.violations.join(" | "), /must not contain punctuation characters/i);
  assert.match(result.violations.join(" | "), /contains disallowed phrase/i);
  assert.match(result.violations.join(" | "), /contains sales or marketing term/i);
});

test("parseStructuredEmailOutput parses the required format", () => {
  const parsed = parseStructuredEmailOutput(
    ["Result", "Success", "Subject", "Dispatch notes", "Body", "The body goes here."].join("\n")
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, "Success");
  assert.equal(parsed.subject, "Dispatch notes");
  assert.equal(parsed.body, "The body goes here.");
});

test("parseVariantsOutput parses fenced json", () => {
  const parsed = parseVariantsOutput(
    [
      "```json",
      JSON.stringify({
        variants: [
          { subject: "Ops notes", body: "Body A" },
          { subject: "Dispatch review", body: "Body B" },
          { subject: "Route followup", body: "Body C" },
        ],
      }),
      "```",
    ].join("\n")
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.variants.length, 3);
  assert.equal(parsed.variants[1].subject, "Dispatch review");
});
