# Campaign Enrichment Plan

## Goal

When the user clicks `Find Nature`, the app should enrich the uploaded spreadsheet for the requested number of rows and save both the original upload and an enriched output file.

## Current Flow

1. The frontend reads the selected `.csv`, `.xls`, or `.xlsx` file and converts it to base64.
2. The browser sends the file payload plus the requested `count` to `POST /api/campaigns`.
3. The backend saves the original file under `storage/campaigns/<campaign-id>/`.
4. The backend reads the first worksheet and detects:
   - a website column
   - an optional LinkedIn column
5. For the first `count` data rows:
   - the website URL is normalized
   - `https://r.jina.ai/<website-url>` is fetched
   - the Jina response is reduced to plain text
   - the cleaned text is stored in `jina_content`
   - any error is stored in `jina_error`
6. If a LinkedIn URL exists for the row:
   - LinkedIn enrichment runs through the separate search-based flow documented in `linkedin_enrichment.md`
   - `linkedin_content`, `linkedin_description`, and `linkedin_error` are filled
7. The backend writes an enriched spreadsheet beside the original file.
8. The API returns campaign metadata and row-level results for the frontend dashboard.

## Saved Output

Each campaign folder contains:

- the original uploaded spreadsheet
- `metadata.json`
- the enriched spreadsheet (`<original-stem>-enriched.<ext>`)
- any generated mailer docs for selected rows

## Spreadsheet Columns Added

- `jina_content`
- `jina_error`
- `linkedin_content`
- `linkedin_description`
- `linkedin_error`

## Row-Level Result Returned To The UI

For each processed row, the backend returns:

- `rowNumber`
- `websiteUrl`
- `status`
- `jinaContent`
- `jinaError`
- `linkedInUrl`
- `linkedInContent`
- `linkedInDescription`
- `linkedInError`
- `sourceRow`

## Why This Approach

- The backend owns all file handling, so the browser stays simple.
- Jina is reliable for turning full website pages into readable text.
- The spreadsheet is the durable source of truth after enrichment.
- The UI can show a preview immediately without the user opening the saved file.
