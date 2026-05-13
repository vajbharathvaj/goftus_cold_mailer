const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSearchSnippetQuery,
  combinePageContent,
  extractInternalLinks,
  extractSearchSnippetText,
  fetchWebsiteContent,
  isChromeRunning,
  isBlockedResponse,
} = require("../src/services/websiteFetchService");

test("isBlockedResponse detects blocked and suspiciously short payloads", () => {
  assert.equal(isBlockedResponse("Access Denied. Reference #1234"), true);
  assert.equal(isBlockedResponse("ok"), true);
  assert.equal(
    isBlockedResponse(
      "Acme provides field operations software for service teams with dispatch automation, route visibility, and reporting workflows that improve SLA compliance."
    ),
    false
  );
});

test("extractInternalLinks keeps only useful internal links and excludes skipped paths", () => {
  const homepageText = [
    "https://example.com/about",
    "https://example.com/blog",
    "https://example.com/services?ref=home",
    "https://example.com/team).",
    "https://example.com/privacy",
    "https://other-site.com/about",
    "https://example.com/who-we-are",
  ].join("\n");

  assert.deepEqual(extractInternalLinks(homepageText, "https://example.com/"), [
    "https://example.com/about",
    "https://example.com/services?ref=home",
    "https://example.com/team",
    "https://example.com/who-we-are",
  ]);
});

test("combinePageContent merges cleaned homepage and sub-pages into sectioned text", () => {
  const homepageText =
    "# Acme\nAcme builds **dispatch software** for distributed teams and improves SLA visibility across operations workflows.";
  const subPages = [
    {
      url: "https://example.com/about",
      text: "About [Acme](https://example.com) details how the team supports service organizations with tooling and advisory.",
    },
    {
      url: "https://example.com/team",
      text: "Short",
    },
  ];

  const combined = combinePageContent(homepageText, subPages);

  assert.match(combined, /--- Homepage ---/);
  assert.match(combined, /Acme builds dispatch software/);
  assert.match(combined, /--- \/about ---/);
  assert.doesNotMatch(combined, /https:\/\/example\.com/);
  assert.doesNotMatch(combined, /--- \/team ---/);
});

test("buildSearchSnippetQuery combines domain and company name", () => {
  assert.equal(
    buildSearchSnippetQuery("realestate.com.au", "Realestate"),
    'site:realestate.com.au OR "Realestate" company description'
  );
});

test("extractSearchSnippetText pulls concise company context from search text", () => {
  const raw = [
    "Title: search",
    "URL Source: https://html.duckduckgo.com/html/?q=site%3Arealestate.com.au",
    "Markdown Content:",
    "Realestate.com.au is one of Australia's leading property websites helping buyers, renters, and sellers navigate listings and market data.",
    "About 10,200 results",
  ].join("\n");
  const snippet = extractSearchSnippetText(raw, { domain: "realestate.com.au", companyName: "Realestate", maxLines: 2 });
  assert.match(snippet, /leading property websites/i);
});

test("fetchWebsiteContent uses only chrome profile mono layer", async () => {
  await assert.rejects(
    () =>
      fetchWebsiteContent("https://www.realestate.com.au/", {
        chromeProfileEnabled: false,
        requestTimeoutMs: 5000,
      }),
    /chrome_profile failed/i
  );
});

test("isChromeRunning returns a boolean", () => {
  assert.equal(typeof isChromeRunning(), "boolean");
});
