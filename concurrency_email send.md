# Concurrency and Email Sending (MD Review)

This summary is based on all project Markdown files outside `node_modules`.

## Concurrency Handling

### 1. Campaign run model is queue-based by row

- Rows move through statuses like `queued`, `fetching`, `generating_mail`, `generating_preview`, `ready`, `sent`, `failed`, and `paused`.
- Processing is described as row-by-row progression with a shared campaign state in `metadata.json`.
- The run continues to next row when a row reaches `ready`; it does not wait for send.

### 2. Pause/resume is cooperative (not mid-row interrupt)

- `POST /api/campaigns/:id/pause` and `POST /api/campaigns/:id/resume` are used by UI specs.
- The loop checks campaign state between rows; pause takes effect after current row finishes.
- UI polling is specified as `GET /api/campaigns/:id` every 2 seconds.

### 3. Verification flow adds async wait points

- In the Chrome profile spec, bot challenge detection pauses that row and sends SSE event `verification_required`.
- UI calls `POST /api/campaigns/:id/resume-row` (or skip) to continue.
- This is a controlled wait, not parallel fan-out.

### 4. Website fetch fallback is sequential

- Layer order is explicit and tried in sequence:
  1. `jina`
  2. `playwright`
  3. `google_cache`
  4. `chrome_profile` or `chrome_cookies` (depending on doc/version)
  5. `search_snippet`
- Sub-page enrichment is also sequential and capped (typically 1-2 pages in docs).

### 5. Planned vs current notes from docs

- UI specs (`new_change.md`, `coldmailbot-ui-spec.md`) include future ideas like bulk send.
- Bulk send is marked as phase/future and described as sequential with delays, not concurrent blasts.
- `mono layer startegy.md` describes a mode that removes multi-layer fallback and forces a single Chrome-profile path for specific retry flows.

## Email Sending Handling

### 1. Send pipeline is 3-step

1. `POST /api/campaigns/mailer-doc`
2. `POST /api/campaigns/send-preview`
3. `POST /api/campaigns/send`

### 2. Providers

- Docs describe provider selection between:
  - Gmail SMTP via Nodemailer
  - Resend API
- Env keys documented:
  - `MAIL_PROVIDER`
  - Gmail: `GMAIL_USER`, `GMAIL_APP_PASS`, `GMAIL_FROM`, `GMAIL_FROM_NAME`
  - Resend: `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_REPLY_TO`
  - pacing: `MAILER_SEND_DELAY_MS`

### 3. Gmail behavior (mailer.md)

- Uses SMTP `smtp.gmail.com:587`.
- Auth via Google App Password.
- Shows startup connection verify pattern.
- Describes random delay (3-5 min) per send to mimic manual pacing.

### 4. Persistence and status tracking

- Preview step writes `email_to`, `email_subject`, `email_generated_body`, `email_body`, `email_previewed_at`, `email_status=preview_ready`.
- Send step writes `email_sent_at`, `email_message_id`, `email_status=sent`; on error sets `email_status=send_failed` and `email_error`.
- Per-send audit JSON file is documented: `send-row-<row>-<timestamp>.json`.

### 5. Operator model

- Send is row-level and user-triggered in current flow docs.
- Run/enrichment continues independently; ready rows can be sent later.
- Specs explicitly avoid bulk multi-recipient blast behavior.
