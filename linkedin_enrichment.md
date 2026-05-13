# LinkedIn Enrichment Flow

## Goal

When a campaign row includes a LinkedIn URL, `Find Nature` should fill a short, usable LinkedIn description without attempting to scrape the protected LinkedIn page directly.

## Current Strategy

The app does not request the LinkedIn page itself. Instead, it searches for that LinkedIn target and extracts the description from search-result text.

## Step By Step

1. Detect the LinkedIn column in the uploaded sheet.
2. Normalize the LinkedIn URL to a search target such as:
   - `linkedin.com/in/person-slug`
   - `linkedin.com/company/company-slug`
3. Build a broader query first when possible:
   - profile example: `site:linkedin.com/in/ "Bharatvaj Ganesan"`
   - company example: `site:linkedin.com/company/ "Acme"`
4. Add narrower fallbacks:
   - `site:<normalized-target>`
   - `"<normalized-target>"`
5. For each query, build search-provider URLs in this order:
   - DuckDuckGo HTML
   - Bing
   - Google
6. Wrap each provider URL with `https://r.jina.ai/`.
7. Fetch the Jina URL, which returns readable text instead of raw search HTML.
8. Clean the returned text:
   - remove links
   - remove basic markdown and HTML noise
   - collapse repeated whitespace
9. Extract the best LinkedIn description line from the cleaned text.

## What The Extractor Ignores

The extractor drops common wrapper lines such as:

- `Title: ...`
- `URL Source: ...`
- `Markdown Content: ...`
- `Warning: ...`
- `No results found for ...`
- `Search only for ...`
- `Showing results for ...`
- `Remove unnecessary punctuation`
- divider-only lines like `=====`
- search-engine chrome such as `DuckDuckGo`, `Bing`, `Images`, `Videos`

## Stored Columns

The enriched spreadsheet receives:

- `linkedin_content`: the cleaned search-result text used for extraction
- `linkedin_description`: the selected description snippet
- `linkedin_error`: the row-level failure message when no usable snippet is found

## Reuse In Mailer Generation

When the user clicks `Generate Mailer Doc`, the mailer-doc generator prefers:

1. `linkedInDescription`
2. `linkedin_description`
3. any existing LinkedIn summary fields from the source row

That value is loaded into the `LinkedIn Summary` field in the Mailer form and included in the generated Word document.
