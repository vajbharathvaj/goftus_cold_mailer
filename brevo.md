# Brevo Integration Plan for Cold Mailbot

## 1) How this bot currently works

### High-level flow

1. User uploads an Excel/CSV campaign file in the UI (`public/app.js`).
2. Backend creates a campaign and stores rows in `storage/campaigns/<campaignId>/metadata.json` via `CampaignStorage`.
3. Campaign processing enriches each row with website/LinkedIn data and marks row states (`queued`, `fetching`, `ready`, `failed`, etc.).
4. Email generation is manual per row:
   - `POST /api/campaigns/send-preview` builds `to/subject/body`.
   - `POST /api/campaigns/send` sends the prepared email.
5. Send results are persisted:
   - Row columns like `email_status`, `email_sent_at`, `email_message_id`, `email_error`.
   - JSON audit record: `send-row-<row>-<timestamp>.json`.

### Current sender implementation

- `src/services/mailerSendService.js` now sends through Brevo transactional API (`https://api.brevo.com/v3/smtp/email`).
- Startup check in `src/server.js` calls `verifyMailer()` and exits if sender config is invalid.
- The same sender is reused by:
  - Campaign send (`/api/campaigns/send`)
  - Warmup sends (`src/warmup/engine.js`)
  - Auto-replies (`src/warmup/replies.js`)
  - Campaign completion notification emails (`src/server.js`)

## 2) Goal for Brevo

Replace Gmail SMTP sending with Brevo API sending while keeping the rest of the app behavior unchanged:

- Keep existing API routes and UI unchanged.
- Keep row status and metadata writes unchanged.
- Keep warmup/reply flows working with same function signature (`sendEmail({ to, subject, text, replyTo })`).

## 3) Recommended integration approach

### Step A: Add Brevo env variables

Add these to `.env`:

```env
MAIL_PROVIDER=brevo
BREVO_API_KEY=your_brevo_v3_key
BREVO_FROM=sender@yourdomain.com
BREVO_FROM_NAME=Cold Mailbot
BREVO_REPLY_TO=reply@yourdomain.com
```

### Step B: Keep one sender interface

Do not change callers. Keep this shape:

```js
sendEmail({ to, subject, text, replyTo })
```

and return:

```js
{
  messageId: "...",
  accepted: [...],
  rejected: [...]
}
```

### Step C: Brevo-only sender inside `mailerSendService.js`

Use Brevo transactional API (`POST https://api.brevo.com/v3/smtp/email`) as the only send provider.
Keep the same exported function signatures so no caller changes are needed.

### Step D: Verify on startup

`verifyMailer()` should validate Brevo required env vars:

- `BREVO_API_KEY`
- `BREVO_FROM`

For Brevo, a lightweight verification is env validation plus optional token test request.

## 4) Brevo API mapping

Map current fields to Brevo payload:

```json
{
  "sender": { "email": "BREVO_FROM", "name": "BREVO_FROM_NAME" },
  "to": [{ "email": "recipient@example.com" }],
  "subject": "Subject",
  "textContent": "Plain text body",
  "replyTo": { "email": "BREVO_REPLY_TO or runtime replyTo" }
}
```

Headers:

- `api-key: <BREVO_API_KEY>`
- `content-type: application/json`

Response handling:

- Success: capture Brevo response message id into `messageId`.
- Failure: throw clear provider-specific error message.

## 5) Files to change for implementation

1. `src/services/mailerSendService.js`
   - Brevo-only send implementation.
   - Keep exported API unchanged.
2. `src/config.js` (optional but cleaner)
   - Parse `MAIL_PROVIDER` and Brevo envs centrally.
3. `.env.example`
   - Add Brevo vars and provider selection comment.
4. `README.md` (optional)
   - Add quick setup notes for Brevo.

No route changes required in `src/server.js`.

## 6) Rollout plan

1. Add Brevo-only sender implementation.
2. Test `/health` startup verification.
3. Test single row send from UI.
4. Test warmup send.
5. Test reply-check auto-reply.
6. Set `MAIL_PROVIDER=brevo` in production.

## 7) Risks and controls

- Risk: Brevo reject due to unverified sender domain.
  - Control: verify sender/domain in Brevo before testing.
- Risk: behavior drift in send return format.
  - Control: normalize Brevo response to existing `{ messageId, accepted, rejected }`.
- Risk: rate limits during bulk send.
  - Control: keep existing UI pacing and `MAILER_SEND_DELAY_MS` behavior.

## 8) Acceptance criteria

- Campaign send route works unchanged (`/api/campaigns/send`).
- `email_status` transitions still: `preview_ready` -> `sent` or `send_failed`.
- Send audit JSON files still written.
- Warmup and auto-reply flows still send successfully.
- No UI changes needed for provider migration.
