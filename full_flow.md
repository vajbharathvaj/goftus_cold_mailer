# Cold Mailbot Full Flow (Start to End)

## 1) What This Project Does

Cold Mailbot is a local Node.js application for AI-assisted B2B outbound outreach.

It supports three connected workflows:

1. Generate cold email content (draft, subject, full output, variants) with Ollama.
2. Upload and enrich campaign spreadsheets with website research text.
3. Turn a selected campaign row into a mailer document, email preview, and live send.

---

## 2) Stack

- Backend: Node.js, Express
- AI generation: Ollama (`/api/generate`)
- Validation: Zod + custom content rules
- Spreadsheet handling: `xlsx`
- Mailer document generation: `docx`
- Email delivery: Gmail SMTP (Nodemailer) or Resend API
- Optional browser automation for LinkedIn search mode: `puppeteer-core`

---

## 3) Project Structure

- `src/server.js` - Express app, route wiring, service composition
- `src/config.js` - env parsing and defaults
- `src/services/contentService.js` - draft/subject/full/variants generation
- `src/services/ollamaClient.js` - streamed Ollama client
- `src/services/campaignStorage.js` - campaign upload, enrichment, metadata/excel updates
- `src/services/mailerDocService.js` - structured mailer fields + `.docx` generation
- `src/services/mailerSendService.js` - Gmail/Resend send provider
- `src/services/campaignSendService.js` - preview and send orchestration
- `src/utils/contentRules.js` - normalization, compliance checks, output parsing
- `src/prompts/contentPrompts.js` - prompt templates and disallowed terms
- `src/schemas/contentSchemas.js` - request validation schemas
- `public/` - frontend dashboard (`index.html`, `app.js`, `styles.css`)
- `storage/campaigns/` - all saved campaign files and send records
- `test/` - node test suite

---

## 4) Setup and Start

1. Install dependencies:

```bash
npm install
```

2. Copy env template:

```bash
copy .env.example .env
```

3. Set critical env values:
- Ollama URL/model (`OLLAMA_BASE_URL`, `OLLAMA_MODEL`)
- Mail provider config (`GMAIL_*` or `RESEND_*`)

4. Start app:

```bash
npm run dev
```

5. Open:
- `http://localhost:3000`

---

## 5) Configuration Flow (`.env`)

Core:
- `PORT`
- `REQUEST_TIMEOUT_MS`

Ollama:
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`
- `OLLAMA_MAILER_MODEL`
- generation tuning (`OLLAMA_*`, `OLLAMA_MAILER_*`)
- optional think mode (`OLLAMA_THINK`, `OLLAMA_MAILER_THINK`)

Campaign fetch:
- `PROXY_LIST` (round-robin proxy pool)
- `LINKEDIN_FETCH_MODE` (`jina` or `chrome_profile`)
- Chrome profile options (`CHROME_*`)

Mail sending:
- `MAIL_PROVIDER` (`gmail`, `resend`, or empty for auto-detect)
- Gmail: `GMAIL_USER`, `GMAIL_APP_PASS`, `GMAIL_FROM`, `GMAIL_FROM_NAME`
- Resend: `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_REPLY_TO`
- `MAILER_SEND_DELAY_MS`

---

## 6) Server Startup Sequence

When `src/server.js` starts:

1. Loads config.
2. Creates two Ollama clients:
- general content client (`OLLAMA_MODEL`)
- mailer-field client (`OLLAMA_MAILER_MODEL`)
3. Constructs services (`ContentService`, `CampaignStorage`, `MailerDocService`, `MailerSendService`, `CampaignSendService`).
4. If mail service is configured, verifies connection on boot.
5. Serves static frontend from `public/`.
6. Exposes API routes.

---

## 7) Frontend Flow

UI has two tabs:

1. `The Mailer`
- lead form
- buttons: health, draft, subject, variants, full generate
- compliance + raw JSON panels
- send preview card

2. `Campaign`
- spreadsheet upload
- row count + draft iteration controls
- `Find Nature` action
- campaign row cards
- excel preview table
- one-click row workflow: `Generate + Preview + Send`

Campaign ID is persisted in local storage so latest progress can reload on refresh.

---

## 8) API Endpoints and Runtime Behavior

### Health and Content

- `GET /health`
- `POST /api/content/draft`
- `POST /api/content/subject`
- `POST /api/content/generate`
- `POST /api/content/variants`

Input is validated by Zod. Generation happens via Ollama prompts. Output is normalized and compliance-checked (word limits, no links, no greeting/signature, disallowed phrases, subject constraints, required opt-out line).

### Campaign Data

- `POST /api/campaigns`
- `GET /api/campaigns/latest`
- `GET /api/campaigns/:campaignId`
- `GET /api/campaigns/:campaignId/preview`

### Mailer Doc + Send

- `POST /api/campaigns/mailer-doc`
- `POST /api/campaigns/send-preview`
- `POST /api/campaigns/send`

All request bodies are schema-validated before service execution.

---

## 9) Campaign Upload and Enrichment Flow

Triggered by `Find Nature`:

1. Browser reads file and sends base64 payload + `count`.
2. Backend creates `storage/campaigns/campaign-<timestamp>-<id>/`.
3. Saves original file.
4. Reads first worksheet rows.
5. Detects:
- website column (required)
- email column (optional)
- LinkedIn column is detected by helpers, but active enrichment currently focuses on website only.
6. For first `count` rows:
- normalize website URL
- fetch `https://r.jina.ai/<website-url>`
- clean response to readable text
- write `jina_content` or `jina_error`
- initialize/keep `email_status`
7. Writes enriched spreadsheet (`<name>-enriched.<ext>`).
8. Writes `metadata.json` with row results and summary counts.
9. Returns campaign summary + row-level result payload for UI cards.

Added/managed destination columns include:
- `jina_content`, `jina_error`
- `linkedin_content`, `linkedin_description`, `linkedin_error` (present in schema/output model)
- `email_status`, `email_to`, `email_subject`, `email_generated_body`, `email_body`, `email_previewed_at`, `email_sent_at`, `email_message_id`, `email_error`

---

## 10) Row Action: Generate + Preview + Send

From a campaign row card:

### Step A: `POST /api/campaigns/mailer-doc`

1. Sends campaign row data (`websiteUrl`, `jinaContent`, `sourceRow`).
2. Mailer model returns structured JSON fields.
3. Fields are normalized/fallback-enriched (company name inference, LinkedIn summary preference chain, etc.).
4. A `.docx` file is generated (`mailer-row-<row>.docx`, non-overwriting suffix if needed).
5. Row is updated in enriched excel + metadata (`email_status=completed`).
6. UI form is filled with generated mailer fields.

### Step B: `POST /api/campaigns/send-preview`

1. Resolves recipient email from explicit input or known source row email columns.
2. Rebuilds mailer fields for current row.
3. Generates draft body (optionally repeated by `draftIterations`).
4. Generates subject from lead + draft body.
5. Builds final outbound email body:
- greeting: `Hi <firstName|there>,`
- generated body
- signature block (`Best regards, Bharathvaj, Goftus Team`)
6. Saves preview data to enriched excel (`email_to`, `email_subject`, `email_generated_body`, `email_body`, `email_previewed_at`, `email_status=preview_ready`).
7. Returns preview payload to UI.

### Step C: `POST /api/campaigns/send`

1. Validates `to`, `subject`, `body`.
2. Sends using configured provider:
- Resend (API)
- or Gmail SMTP (Nodemailer)
3. Writes per-send JSON record: `send-row-<row>-<timestamp>.json`.
4. Updates enriched excel (`email_sent_at`, `email_message_id`, `email_status=sent`, clear `email_error`).
5. On failure: sets `email_status=send_failed`, stores `email_error`.

---

## 11) Ollama Interaction Details

`OllamaClient` streams `/api/generate` output line-by-line and concatenates `response` tokens.

If `think` is configured and fails/times out or is unsupported, it retries once without `think`.

Timeouts are enforced with `AbortController`.

---

## 12) Data Persistence Model

Per campaign folder:

- original uploaded spreadsheet
- enriched spreadsheet
- `metadata.json`
- `mailer-row-*.docx` files
- `send-row-*.json` send logs

`metadata.json` tracks:
- file names, worksheet, processed row counts
- success/failure counts
- per-row enrichment results
- row-level email status context

The enriched spreadsheet becomes the durable operational state for preview/send progress.

---

## 13) LinkedIn Status in Current Implementation

The codebase includes LinkedIn query builders, search URL builders, extraction logic, and tests.

However, in active campaign row enrichment (`saveUpload` flow), LinkedIn enrichment is intentionally disabled and website enrichment is the primary active path.

---

## 14) Validation and Tests

`npm test` uses Node test runner and currently passes.

Coverage includes:
- content normalization/validation/parsing
- campaign helper logic (URL normalization, query building, text extraction filters)
- send helper logic (recipient/email/name/body wrapper behavior)

---

## 15) End-to-End Operator Runbook

1. Start Ollama and this app.
2. Open dashboard.
3. Upload campaign file and choose row count.
4. Run `Find Nature` to enrich website content and create campaign artifacts.
5. Open a row and click `Generate + Preview + Send`.
6. System creates mailer doc, builds preview, writes preview into excel, then sends email.
7. Confirm row status (`completed`, `preview_ready`, `sent`, or `send_failed`) in UI and excel preview.
8. Check campaign folder for `.docx` and send JSON audit file.

---

## 16) Known Constraints

- Quality depends on selected Ollama models.
- Website enrichment depends on Jina fetch success and target site accessibility.
- LinkedIn flow utilities exist but are not currently active in main row enrichment path.
- Sending requires valid provider credentials and sender/domain configuration.
