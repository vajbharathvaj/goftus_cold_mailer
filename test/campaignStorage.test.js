const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CampaignStorage,
  buildJinaReaderUrl,
  buildLinkedInQueries,
  buildLinkedInSearchUrls,
  buildSearchNameFromLinkedInUrl,
  detectEmailColumn,
  detectLinkedInColumn,
  detectWebsiteColumn,
  extractLinkedInDescriptionFromText,
  extractPlainTextFromJinaResponse,
  getLinkedInPathParts,
  normalizeLinkedInSearchTarget,
  normalizeRecipientEmail,
  normalizeWebsiteUrl,
  resolveLinkedInEntityInfo,
} = require("../src/services/campaignStorage");

test("CampaignStorage rotates proxies in round-robin order", () => {
  const storage = new CampaignStorage({
    proxyList: ["proxy-one:8080", "http://proxy-two:8080", "https://proxy-three:8080"],
  });

  assert.equal(storage.getNextProxy(), "http://proxy-one:8080");
  assert.equal(storage.getNextProxy(), "http://proxy-two:8080");
  assert.equal(storage.getNextProxy(), "https://proxy-three:8080");
  assert.equal(storage.getNextProxy(), "http://proxy-one:8080");
});

test("normalizeWebsiteUrl adds https when missing", () => {
  assert.equal(normalizeWebsiteUrl("example.com"), "https://example.com/");
});

test("buildJinaReaderUrl prefixes the target url", () => {
  assert.equal(buildJinaReaderUrl("https://example.com/"), "https://r.jina.ai/https://example.com/");
});

test("normalizeLinkedInSearchTarget returns host and path without trailing slash", () => {
  assert.equal(
    normalizeLinkedInSearchTarget("https://www.linkedin.com/in/bharatvaj-ganesan-68a31332a/"),
    "linkedin.com/in/bharatvaj-ganesan-68a31332a"
  );
});

test("getLinkedInPathParts splits the path into meaningful segments", () => {
  assert.deepEqual(getLinkedInPathParts("https://www.linkedin.com/company/acme/"), ["company", "acme"]);
});

test("resolveLinkedInEntityInfo collapses company subpages to the company root", () => {
  assert.deepEqual(resolveLinkedInEntityInfo("https://www.linkedin.com/company/acme/about/"), {
    host: "linkedin.com",
    pathParts: ["company", "acme", "about"],
    segment: "company",
    slug: "acme",
    target: "linkedin.com/company/acme",
  });
});

test("buildSearchNameFromLinkedInUrl converts the slug into a readable name", () => {
  assert.equal(
    buildSearchNameFromLinkedInUrl("https://www.linkedin.com/in/bharatvaj-ganesan-68a31332a/"),
    "Bharatvaj Ganesan"
  );
});

test("buildLinkedInQueries prefers a broad name query before narrow fallbacks", () => {
  const queries = buildLinkedInQueries("https://www.linkedin.com/in/bharatvaj-ganesan-68a31332a/");
  assert.deepEqual(queries, [
    'site:linkedin.com/in/ "Bharatvaj Ganesan"',
    "site:linkedin.com/in/bharatvaj-ganesan-68a31332a",
    '"linkedin.com/in/bharatvaj-ganesan-68a31332a"',
    "site:linkedin.com/in bharatvaj ganesan",
  ]);
});

test("buildLinkedInSearchUrls creates provider urls for each query", () => {
  const urls = buildLinkedInSearchUrls("https://www.linkedin.com/company/acme/");
  assert.equal(urls.length, 12);
  assert.match(urls[0], /^https:\/\/html\.duckduckgo\.com\/html\/\?q=/);
  assert.match(urls[1], /^https:\/\/www\.bing\.com\/search\?q=/);
  assert.match(urls[2], /^https:\/\/www\.google\.com\/search\?q=/);
});

test("buildLinkedInQueries uses company queries for company urls with extra path segments", () => {
  const queries = buildLinkedInQueries("https://www.linkedin.com/company/acme/about/");
  assert.deepEqual(queries, [
    'site:linkedin.com/company/ "Acme"',
    "site:linkedin.com/company/acme",
    '"linkedin.com/company/acme"',
    "site:linkedin.com/company acme",
  ]);
});

test("detectWebsiteColumn and detectLinkedInColumn tolerate formatting noise", () => {
  const rows = [
    {
      "Website ": "https://example.com",
      "LinkedIn URL": "https://www.linkedin.com/company/acme/",
    },
  ];

  assert.equal(detectWebsiteColumn(rows), "Website ");
  assert.equal(detectLinkedInColumn(rows), "LinkedIn URL");
});

test("detectEmailColumn finds common email headers", () => {
  const rows = [{ "Contact Email": "person@example.com" }];
  assert.equal(detectEmailColumn(rows), "Contact Email");
});

test("normalizeRecipientEmail trims and lowercases", () => {
  assert.equal(normalizeRecipientEmail("  PERSON@Example.COM "), "person@example.com");
});

test("extractPlainTextFromJinaResponse removes links and markdown wrappers", () => {
  const raw = [
    "Title: Example",
    "[Home](https://example.com)",
    "<https://example.com/pricing>",
    "Visit https://example.com/docs for details.",
    "<p>Plain paragraph</p>",
  ].join("\n");

  assert.equal(
    extractPlainTextFromJinaResponse(raw),
    ["Title: Example", "Home", "Visit for details.", "Plain paragraph"].join("\n")
  );
});

test("extractLinkedInDescriptionFromText prefers the About section", () => {
  const text = [
    "Title: profile",
    "About",
    "Operations leader helping distributed service teams standardize dispatch, reporting, and field execution.",
  ].join("\n");

  assert.equal(
    extractLinkedInDescriptionFromText(text, "https://www.linkedin.com/in/bharatvaj-ganesan-68a31332a/"),
    "Operations leader helping distributed service teams standardize dispatch, reporting, and field execution."
  );
});

test("extractLinkedInDescriptionFromText finds a search snippet near the target", () => {
  const text = [
    "linkedin.com/in/bharatvaj-ganesan-68a31332a",
    "Bharatvaj Ganesan leads operations improvement programs focused on service delivery and workflow visibility.",
  ].join("\n");

  assert.equal(
    extractLinkedInDescriptionFromText(text, "https://www.linkedin.com/in/bharatvaj-ganesan-68a31332a/"),
    "Bharatvaj Ganesan leads operations improvement programs focused on service delivery and workflow visibility."
  );
});

test("extractLinkedInDescriptionFromText ignores DuckDuckGo title metadata", () => {
  const text = [
    "Title: site:linkedin.com/in/bharatvaj-ganesan-68a31332a description at DuckDuckGo",
    "Bharatvaj Ganesan helps service organizations build cleaner dispatch workflows and reporting routines.",
  ].join("\n");

  assert.equal(
    extractLinkedInDescriptionFromText(text, "https://www.linkedin.com/in/bharatvaj-ganesan-68a31332a/"),
    "Bharatvaj Ganesan helps service organizations build cleaner dispatch workflows and reporting routines."
  );
});

test("extractLinkedInDescriptionFromText ignores cached snapshot warnings", () => {
  const text = [
    "Warning: This is a cached snapshot of the original page, consider retry with caching opt-out.",
    "Experienced operator who builds scalable account and delivery processes across regional teams.",
  ].join("\n");

  assert.equal(
    extractLinkedInDescriptionFromText(text, "https://www.linkedin.com/in/bharatvaj-ganesan-68a31332a/"),
    "Experienced operator who builds scalable account and delivery processes across regional teams."
  );
});

test("extractLinkedInDescriptionFromText ignores no-results wrapper lines", () => {
  const text = [
    "No results found for site:linkedin.com/in/bharatvaj-ganesan-68a31332a description",
    "Bharatvaj Ganesan specializes in operations systems, dispatch discipline, and process visibility.",
  ].join("\n");

  assert.equal(
    extractLinkedInDescriptionFromText(text, "https://www.linkedin.com/in/bharatvaj-ganesan-68a31332a/"),
    "Bharatvaj Ganesan specializes in operations systems, dispatch discipline, and process visibility."
  );
});

test("extractLinkedInDescriptionFromText ignores divider-only lines", () => {
  const text = [
    "=====================================================================================",
    "Bharatvaj Ganesan builds repeatable service delivery processes for growing teams.",
  ].join("\n");

  assert.equal(
    extractLinkedInDescriptionFromText(text, "https://www.linkedin.com/in/bharatvaj-ganesan-68a31332a/"),
    "Bharatvaj Ganesan builds repeatable service delivery processes for growing teams."
  );
});

test("extractLinkedInDescriptionFromText ignores instruction noise", () => {
  const text = [
    "Remove unnecessary punctuation",
    "Bharatvaj Ganesan provides operating discipline for customer-facing delivery teams.",
  ].join("\n");

  assert.equal(
    extractLinkedInDescriptionFromText(text, "https://www.linkedin.com/in/bharatvaj-ganesan-68a31332a/"),
    "Bharatvaj Ganesan provides operating discipline for customer-facing delivery teams."
  );
});

test("extractLinkedInDescriptionFromText ignores javascript and blob wrapper noise", () => {
  const text = [
    "[Rewards](javascript:void(0))[![Image 1: Profile Picture](blob:)](javascript:void(0))",
    "Operations leader helping distributed service teams standardize dispatch and execution quality.",
  ].join("\n");

  const cleaned = extractPlainTextFromJinaResponse(text);
  assert.equal(
    extractLinkedInDescriptionFromText(cleaned, "https://www.linkedin.com/in/akilkuhan/"),
    "Operations leader helping distributed service teams standardize dispatch and execution quality."
  );
});

test("extractLinkedInDescriptionFromText prefers snippet from the target profile result over other people", () => {
  const text = [
    'site:linkedin.com/in/ "Akilkuhan"',
    "https://uk.linkedin.com › in › akilkuhan",
    "Akil Kuhan - MSc Marketing Graduate - LinkedIn",
    "MSC Marketing Graduate | Digital Marketing & Performance Marketing | Open to International Opportunities.",
    "https://uk.linkedin.com › in › kunal-kushwaha",
    "Kunal Kushwaha - LinkedIn",
    "Teaching millions how to code and helping businesses scale. Kunal Kushwaha is a Senior Developer Advocate.",
  ].join("\n");

  assert.equal(
    extractLinkedInDescriptionFromText(text, "https://www.linkedin.com/in/akilkuhan/"),
    "MSC Marketing Graduate | Digital Marketing & Performance Marketing | Open to International Opportunities."
  );
});

test("extractLinkedInDescriptionFromText does not fall through to another person when first target block has no snippet", () => {
  const text = [
    'site:linkedin.com/in/ "Akilkuhan"',
    "https://uk.linkedin.com › in › akilkuhan",
    "Akil Kuhan - LinkedIn",
    "https://uk.linkedin.com › in › kunal-kushwaha",
    "Kunal Kushwaha - LinkedIn",
    "Teaching millions how to code and helping businesses scale. Kunal Kushwaha is a Senior Developer Advocate.",
  ].join("\n");

  assert.equal(extractLinkedInDescriptionFromText(text, "https://www.linkedin.com/in/akilkuhan/"), "");
});

test("extractLinkedInDescriptionFromText rejects human-verification challenge text", () => {
  const text = [
    "Please solve the challenge below to continue",
    "Verify",
    "Bing",
  ].join("\n");

  assert.equal(extractLinkedInDescriptionFromText(text, "https://www.linkedin.com/in/akilkuhan/"), "");
});
