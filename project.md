# Cold Mailbot Project

## What This Project Does

Cold Mailbot is a local Node.js application for AI-assisted B2B cold outreach.

It currently does three main jobs:

1. Generate cold email content in the browser using a local Ollama model.
2. Enrich uploaded campaign spreadsheets with website and LinkedIn research.
3. Generate a structured mailer `.docx` file for a selected campaign row.

The app is built to run locally, with a simple dashboard frontend and an Express backend.

## Core Product Flows

### 1. Mailer Flow

The `The Mailer` section in the frontend lets the user enter lead details and generate:

- a draft body
- a subject line
- a combined structured output
- three content variants

The backend sends prompt instructions to Ollama and returns:

- generated copy
- compliance validation
- raw API output for inspection

The current prompts are designed to:

- pitch the user’s service to the target company
- avoid spammy language
- avoid invented prospect-side metrics
- use first-person proof only from the sender’s own prior work
- sound more human and less polished/marketing-heavy

### 2. Campaign Enrichment Flow

The `Campaign` section accepts:

- a spreadsheet file (`.csv`, `.xls`, `.xlsx`)
- a row count

When the user clicks `Find Nature`:

1. The frontend uploads the file and count to the backend.
2. The backend saves the original file under `storage/campaigns/<campaign-id>/`.
3. The backend reads the first worksheet.
4. It detects a website column and an optional LinkedIn column.
5. For the requested number of rows:
   - it fetches website content through `https://r.jina.ai/<website-url>`
   - it cleans the returned content into readable plain text
   - it stores that text in `jina_content`
   - it stores any website fetch error in `jina_error`
6. If a LinkedIn URL exists:
   - it does not fetch LinkedIn directly
   - it builds search queries based on the LinkedIn URL
   - it tries DuckDuckGo HTML, Bing, and Google search URLs
   - those search URLs are fetched through `https://r.jina.ai/`
   - the cleaned search text is scanned for a usable LinkedIn description
   - it stores:
     - `linkedin_content`
     - `linkedin_description`
     - `linkedin_error`
7. The backend writes an enriched spreadsheet beside the original upload.
8. The frontend shows compact row cards with previews and `Read more` toggles.

### 3. Mailer Doc Flow

Each successful campaign row has a `Generate Mailer Doc` action.

When clicked:

1. The frontend sends the selected row data to `POST /api/campaigns/mailer-doc`.
2. The backend uses a dedicated mailer Ollama client.
3. Ollama returns structured JSON for the mailer fields.
4. The backend normalizes those fields.
5. A `.docx` file is generated and saved in the campaign folder.
6. The generated values are loaded back into the `Mailer` form in the UI.

The saved document name does not overwrite prior files. It uses:

- `mailer-row-2.docx`
- `mailer-row-2-2.docx`
- `mailer-row-2-3.docx`

and so on.

## Frontend

The frontend is a static dashboard served from `public/`.

### Current UI Structure

- Left sidebar with:
  - `The Mailer`
  - `Campaign`
- `The Mailer` view with:
  - lead input form
  - sample data loader
  - buttons for health, draft, subject, variants, and full generation
  - result panels for subject, body, compliance, variants, and raw response
- `Campaign` view with:
  - spreadsheet upload field
  - count input
  - `Find Nature` button
  - saved campaign summary
  - enriched row cards

### Current UX Improvements Already Added

- compact campaign cards
- `Read more` / `Read less` for long enriched text
- direct `Generate Mailer Doc` action from each successful row
- fixed horizontal overflow issues in the dashboard layout and JSON panels

## Backend

The backend is an Express server in `src/server.js`.

### Current API Routes

- `GET /health`
- `POST /api/content/draft`
- `POST /api/content/subject`
- `POST /api/content/generate`
- `POST /api/content/variants`
- `POST /api/campaigns`
- `POST /api/campaigns/mailer-doc`

### Main Backend Modules

- `src/services/contentService.js`
  - handles email generation with Ollama
- `src/services/campaignStorage.js`
  - handles spreadsheet saving, enrichment, and metadata
- `src/services/mailerDocService.js`
  - handles row-to-mailer-field generation and `.docx` output
- `src/services/ollamaClient.js`
  - handles requests to the local Ollama server
- `src/utils/contentRules.js`
  - validates subject/body output against formatting and anti-spam rules
- `src/prompts/contentPrompts.js`
  - defines the content-generation prompts

## Data Saved On Disk

Campaign runs are stored in:

- `storage/campaigns/<campaign-id>/`

Each campaign folder can contain:

- the original uploaded spreadsheet
- `metadata.json`
- the enriched spreadsheet
- generated mailer `.docx` files

## What Has Been Implemented So Far

### Product / Workflow Work

- Built the local content-generation service.
- Added the dashboard with `The Mailer` and `Campaign` sections.
- Added spreadsheet upload and row-count based enrichment.
- Added website enrichment through Jina.
- Added LinkedIn enrichment using search-provider URLs plus Jina-cleaned search text.
- Added extraction and filtering to avoid noisy search wrapper lines.
- Added campaign result cards in the frontend.
- Added row-level `Generate Mailer Doc`.
- Added automatic mailer field loading back into the frontend.
- Added non-overwriting `.docx` file naming.

### Prompt / Copy Work

- Tightened prompts to avoid generic sales language.
- Shifted the draft prompt toward a clearer outbound service pitch.
- Added stronger instructions to avoid inventing metrics about the prospect.
- Added first-person proof framing from the sender’s own prior work.
- Replaced the draft prompt with a more structured hook / friction / offer / proof / objection / CTA format.

### UI Work

- Added sidebar navigation.
- Added campaign upload UI.
- Added cleaner campaign result rendering instead of raw JSON.
- Added content previews with expand/collapse.
- Fixed horizontal scrolling caused by layout overflow and long JSON output.

### Reliability / Parsing Work

- Added LinkedIn query building for both personal and company LinkedIn URLs.
- Fixed company URL handling so paths like `/company/acme/about/` normalize to `/company/acme`.
- Added filtering for noisy search output such as:
  - `Title: ...`
  - `Warning: ...`
  - `No results found for ...`
  - divider-only lines
  - instruction noise like `Remove unnecessary punctuation`

### Test / Project Recovery Work

- Recreated the project after the repo contents were lost.
- Restored the missing frontend styling and project docs.
- Rebuilt the automated tests for content rules and campaign enrichment helpers.
- Regenerated `package-lock.json`.
- Verified the rebuilt project with passing tests.

## Current Test Status

The project currently includes automated tests for:

- content normalization and validation rules
- structured output parsing
- campaign enrichment helper functions
- LinkedIn search-query and extraction helpers

At the current state, the test suite is passing.

## Current Constraints / Known Gaps

- LinkedIn enrichment depends on search-engine result text and may still vary by provider behavior.
- The mailer doc generator expects Ollama to return valid JSON for the required fields.
- The frontend does not yet expose a direct download button for enriched files or generated `.docx` files.
- The prompt model behavior still depends on the installed Ollama model quality.

## Summary

This project is now a working local outreach assistant that:

- researches a list of companies from a spreadsheet
- enriches the data with website and LinkedIn context
- turns a selected row into a structured mailer brief
- generates cold email content aimed at pitching the user’s service

The foundation is in place for the next phase, which would be improving prompt quality further, tightening extraction accuracy, and adding more operator-friendly export and review tools.
