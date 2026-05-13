# Cold Mailbot — Production UI Specification

## Inspiration & Design Direction

**Primary inspiration:** Apify — dense data, real-time actor runs, row-level status, pause/resume controls.
**Secondary inspiration:** Linear, Raycast — keyboard-first, fast, no wasted space.

**Aesthetic direction:** Industrial-dark utilitarian. Not a generic SaaS dashboard. Think mission control.

- Background: near-black `#0D0F12` with subtle grid texture
- Accent: electric cyan `#00E5FF` for active states, progress, CTAs
- Secondary accent: amber `#F59E0B` for warnings, paused state
- Danger: `#EF4444` for failures
- Success: `#22C55E` for sent/completed
- Surface cards: `#161B22` with `1px` border `#2A2F38`
- Font display: `IBM Plex Mono` — monospaced, technical, readable
- Font body: `DM Sans` — clean contrast to mono headers
- Motion: subtle — row slide-ins, progress bar pulses, status badge transitions

---

## Global Layout

```
┌─────────────────────────────────────────────────────────────┐
│  SIDEBAR (240px fixed)  │  MAIN CONTENT AREA (flex-grow)    │
│                         │                                    │
│  Logo + version         │  Top bar: breadcrumb + actions    │
│  ─────────────          │  ────────────────────────────────  │
│  The Mailer             │  Page content                      │
│  Campaign               │                                    │
│  ─────────────          │                                    │
│  Status indicators      │                                    │
│  (Ollama health)        │                                    │
│  (Mail provider)        │                                    │
└─────────────────────────────────────────────────────────────┘
```

### Sidebar Details

- Logo: `COLDMAILBOT` in IBM Plex Mono, small `v1.0` badge in cyan
- Nav items: icon + label, active state = cyan left border + background highlight
- Bottom of sidebar:
  - `● Ollama` — green dot if healthy, red if not
  - `● Mail` — green if SMTP verified, amber if unconfigured
  - Clicking either opens a status tooltip inline

---

## Page 1 — The Mailer

No changes to core functionality. UI polish only:

- Input fields: dark surface, cyan focus ring, monospaced placeholder text
- Generate buttons: ghost style with cyan border, fills on hover
- Result panels: collapsible, monospaced output text, copy-to-clipboard icon top right
- Compliance badge: inline pill — green `PASS` or red `FAIL` with rule count
- Send preview card: appears below generation result, shows final assembled email

---

## Page 2 — Campaign (Full Redesign)

This is the core of the spec. Every section below is a new component.

---

### 2.1 Upload Zone

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   ⬆  Drop spreadsheet here or click to upload      │
│      .csv  .xls  .xlsx  accepted                   │
│                                                     │
│   Rows to process: [ 10 ▼ ]   [ Start Run → ]      │
│                                                     │
└─────────────────────────────────────────────────────┘
```

- Drag-and-drop with dashed cyan border on drag-over
- File accepted state: shows filename + row count detected + green checkmark
- Row count: dropdown or number input, max capped at detected row count
- `Start Run` button: disabled until file is loaded
- On click: button text changes to `Initialising...` then transitions to Run Console

---

### 2.2 Run Console (Replaces Basic Progress)

Appears immediately after `Start Run` is clicked. This is the centerpiece of the redesign.

```
┌──────────────────────────────────────────────────────────────────────┐
│  RUN  campaign-1748291023-abc  ●  RUNNING             [ ⏸ Pause ]   │
│  ────────────────────────────────────────────────────────────────    │
│  Progress  ████████████░░░░░░░░░░░░░░  8 / 20 rows                  │
│  Started 2 min ago · ETA ~4 min · 0 failed                          │
│──────────────────────────────────────────────────────────────────────│
│  QUEUE                                                               │
│                                                                      │
│  ✉  1  Acme Corp        acme.com       Ready          [ Send → ]    │
│  ✉  2  Beta Industries  betaind.io     Sent ✓                       │
│  ✉  3  Coda Systems     codasys.com    Ready          [ Send → ]    │
│  ✉  4  Deltaforge       deltaforge.net Ready          [ Send → ]    │
│  ✗  5  Everline         everline.co    Failed         [hover: err]  │
│  ✉  6  Flink Labs       flink.io       Ready          [ Send → ]    │
│  ✉  7  Gantry Tech      gantry.tech    Ready          [ Send → ]    │
│  ▶  8  Helios Corp      helios.com   ● Generating preview...        │  ← active, pulsing
│  ○  9  Ironside         ironside.io    Queued                        │
│  ○ 10  Jetform          jetform.co     Queued                        │
│     ...                                                              │
└──────────────────────────────────────────────────────────────────────┘
```

#### Run Console Behavior

**Status badge (top right of header):**
- `● RUNNING` — cyan pulse animation
- `⏸ PAUSED` — amber, static
- `✓ COMPLETE` — green
- `✗ STOPPED` — red

**Progress bar:**
- Filled in cyan
- Animates smoothly as each row completes
- Shows `X / Y rows` beside it
- Shows ETA calculated from average row processing time

**Queue rows:**

Each row has:
- Row number
- Company name (from spreadsheet)
- Website URL (truncated if long)
- Status indicator — cycles automatically through these stages per row:
  - `○ Queued` — grey, waiting
  - `● Fetching website...` — cyan pulse dot, Jina enrichment running
  - `● Generating mail info...` — cyan pulse dot, mailer fields being built by Ollama
  - `● Generating preview...` — cyan pulse dot, email body + subject being assembled
  - `✉ Ready  [ Send → ]` — cyan outline, preview is ready, Send button visible inline
  - `✉ Sent` — green, email was sent manually by user
  - `✗ Failed` — red, hover shows error tooltip
  - `⏸ Paused` — amber, paused mid-run

**The run does not stop at `Ready` — it moves to the next row automatically.**
The `[ Send → ]` button stays on each completed row so the user can send at any time independently.

- Clicking any row at `Ready` or `Sent` state expands the inline preview (see 2.3)

**Pause / Resume:**
- `⏸ Pause` button in header — immediately halts after current row finishes
- Button changes to `▶ Resume` when paused
- Paused state persists in `metadata.json` so page refresh restores it
- Resume continues from the next unprocessed row

**Stop:**
- Long-press `⏸ Pause` or separate `■ Stop` button (appears on hover of pause)
- Stops run permanently, marks campaign as `stopped`

---

### 2.3 Row Inline Expand

Clicking any row at `Ready` or `Sent` state expands it inline as an accordion:

```
┌──────────────────────────────────────────────────────────────────┐
│  ▼  8  Helios Corp      helios.com      ✉ Ready   [ Send → ]    │
│  ──────────────────────────────────────────────────────────────  │
│                                                                  │
│  WEBSITE CONTENT                              [ Copy ]           │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Helios Corp is a B2B SaaS platform for supply chain...     │  │
│  │ [Read more]                                                │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LINKEDIN DESCRIPTION                                            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Supply chain visibility for mid-market manufacturers.      │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  GENERATED MAILER FIELDS                                         │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Company:      Helios Corp                                  │  │
│  │ Persona:      Head of Operations                           │  │
│  │ Pain Trigger: Manual tracking across 3+ systems            │  │
│  │ Proof Point:  Cut reporting time by 60% for similar client │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  EMAIL PREVIEW                                      [ Edit ]     │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ To:      contact@helios.com                                │  │
│  │ Subject: Quick question about your supply chain setup      │  │
│  │                                                            │  │
│  │ Hi Sarah,                                                  │  │
│  │                                                            │  │
│  │ Managing visibility across multiple systems eats time...   │  │
│  │ [Read more]                                                │  │
│  │                                                            │  │
│  │ Best regards,                                              │  │
│  │ Bharathvaj, Goftus Team                                    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  [ ✗ Discard Preview ]                  [ ✓ Send Email → ]      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Expand behavior:**
- Smooth accordion animation open/close
- `Read more / Read less` toggle on long content blocks
- Copy icon on each content block
- `To` and `Subject` fields are editable inline
- `[ Edit ]` on preview body opens it as an editable textarea
- `[ Send → ]` fires immediately — no page navigation
- After send: inline confirmation replaces send button:
  ```
  ✓  Sent to contact@helios.com · Message ID: <abc123>   [ View Log ]
  ```
- Row status in queue updates to `✉ Sent` green

---

### 2.4 Per-Row Automatic Pipeline

Each row runs through these stages automatically without any user interaction needed:

#### Stage 1 — Fetching
```
▶  8  Helios Corp   helios.com   ● Fetching website...
```
Calls `r.jina.ai` for website content. Duration shown live in ms.

#### Stage 2 — Generating Mail Info
```
▶  8  Helios Corp   helios.com   ● Generating mail info...
```
Calls `POST /api/campaigns/mailer-doc` — Ollama builds structured mailer fields.

#### Stage 3 — Generating Preview
```
▶  8  Helios Corp   helios.com   ● Generating preview...
```
Calls `POST /api/campaigns/send-preview` — assembles subject, body, greeting, signature.

#### Stage 4 — Ready (Pipeline complete, run moves on)
```
✉  8  Helios Corp   helios.com   Ready        [ Send → ]
```
- Run **does not pause here** — next row starts immediately
- `[ Send → ]` button stays on this row permanently until sent
- Clicking the row expands full inline preview (see 2.3)

#### Stage 5 — Sent (after user manually clicks Send)
```
✉  8  Helios Corp   helios.com   Sent ✓
```

#### Stage 5 (alt) — Failed
```
✗  8  Helios Corp   helios.com   Failed       [hover: error message]
```
Failed rows show error on hover. A `[ Retry ]` option appears inside the expanded row.

---

### 2.5 Future: Bulk Send Feature (Phase 2 — not in this spec)

A `Start Sending` button will appear in the run summary after all rows reach `Ready`.

This will send all `Ready` rows sequentially with human-mimicking delays (3-8 min between each).

This is **not part of the current implementation** — placeholder only.

---

### 2.5 Run Summary Panel

Shown after run completes or is stopped:

```
┌──────────────────────────────────────────────────────────────────┐
│  RUN COMPLETE                                                    │
│  ──────────────────────────────────────────────────────────────  │
│  20 rows processed · 18 enriched · 2 failed · 3m 42s total      │
│                                                                  │
│  [ ↓ Download Enriched Excel ]   [ Start New Run ]              │
└──────────────────────────────────────────────────────────────────┘
```

- Download button for enriched spreadsheet (currently missing from UI)
- `Start New Run` resets the upload zone

---

### 2.6 Campaign History (Sidebar or Collapsible Panel)

Below the run console, a collapsible section:

```
  PREVIOUS RUNS  ▾

  campaign-abc  ·  20 rows  ·  18 ok  ·  Mar 6 14:22  [ Load ]
  campaign-xyz  ·  10 rows  ·  10 ok  ·  Mar 5 09:11  [ Load ]
```

- `Load` restores that campaign's row cards and send status
- Shows last 5 campaigns

---

## Pause / Resume — Technical Implementation Notes

### Frontend

- `Find Nature` becomes `Start Run` — calls `POST /api/campaigns` as before
- New button `Pause` calls `POST /api/campaigns/:id/pause`
- New button `Resume` calls `POST /api/campaigns/:id/resume`
- Frontend polls `GET /api/campaigns/:id` every 2 seconds during a run to update queue rows
- On page reload: reads `campaignId` from localStorage, calls `GET /api/campaigns/latest` to restore state

### Backend

New fields in `metadata.json`:

```json
{
  "status": "running | paused | completed | stopped | failed",
  "pausedAtRow": 8,
  "resumeFromRow": 9,
  "rows": [
    {
      "index": 1,
      "status": "queued | fetching | generating_mail | generating_preview | ready | sent | failed | paused",
      "durationMs": 1200,
      "emailTo": "contact@helios.com",
      "emailSubject": "Quick question about your supply chain setup",
      "emailBody": "Hi Sarah, ...",
      "mailerFields": { "companyName": "Helios Corp", "painTrigger": "..." },
      "jinaContent": "Helios Corp is a B2B SaaS...",
      "linkedInDescription": "Supply chain visibility for...",
      "error": null
    }
  ]
}
```

New API endpoints:

```
POST /api/campaigns/:id/pause    → sets status=paused, records pausedAtRow
POST /api/campaigns/:id/resume   → sets status=running, continues from resumeFromRow
GET  /api/campaigns/:id          → returns full metadata for polling
```

### Pause Mechanism

The enrichment loop in `campaignStorage.js` checks a shared flag after each row:

```javascript
for (let i = resumeFromRow; i < rows.length; i++) {
  if (campaign.status === 'paused') {
    await updateMetadata(campaignId, { pausedAtRow: i });
    break;
  }
  await processRow(rows[i]);
}
```

This means pause takes effect after the current row finishes — never mid-row.

---

## Component File Structure

```
public/
├── index.html              ← shell, font imports, CSS vars
├── styles/
│   ├── base.css            ← reset, CSS variables, typography
│   ├── layout.css          ← sidebar, main area, top bar
│   ├── campaign.css        ← run console, queue rows, expand cards
│   ├── mailer.css          ← mailer form, result panels
│   └── animations.css      ← pulse, slide-in, accordion
├── app.js                  ← router, tab switching, global state
├── campaign.js             ← upload, run control, polling, queue render
├── mailer.js               ← mailer form handlers, result render
└── send.js                 ← preview card, send action, status update
```

---

## CSS Variables (Design Tokens)

```css
:root {
  /* backgrounds */
  --bg-base:        #0D0F12;
  --bg-surface:     #161B22;
  --bg-elevated:    #1E2530;
  --bg-hover:       #252C38;

  /* borders */
  --border-subtle:  #2A2F38;
  --border-active:  #00E5FF44;

  /* text */
  --text-primary:   #E8EDF2;
  --text-secondary: #8892A0;
  --text-muted:     #4A5568;

  /* accents */
  --cyan:           #00E5FF;
  --cyan-dim:       #00E5FF22;
  --amber:          #F59E0B;
  --green:          #22C55E;
  --red:            #EF4444;

  /* typography */
  --font-mono:      'IBM Plex Mono', monospace;
  --font-body:      'DM Sans', sans-serif;

  /* spacing */
  --radius-sm:      4px;
  --radius-md:      8px;
  --radius-lg:      12px;
}
```

---

## Status Badge Component

Used everywhere — queue rows, run header, campaign history:

```
Queued              →  grey pill        ○  Queued
Fetching            →  cyan pulse       ●  Fetching website...
Generating mail     →  cyan pulse       ●  Generating mail info...
Generating preview  →  cyan pulse       ●  Generating preview...
Ready               →  cyan outline     ✉  Ready          [ Send → ]
Sent                →  green solid      ✉  Sent ✓
Failed              →  red pill         ✗  Failed
Paused              →  amber pill       ⏸  Paused
```

---

## Animations

```css
/* Active row pulse */
@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.3; }
}

/* Row slide in on complete */
@keyframes row-complete {
  from { background: var(--cyan-dim); }
  to   { background: transparent; }
}

/* Progress bar fill */
@keyframes progress-fill {
  from { width: var(--prev-width); }
  to   { width: var(--next-width); }
}

/* Accordion expand */
@keyframes accordion-open {
  from { max-height: 0; opacity: 0; }
  to   { max-height: 600px; opacity: 1; }
}
```

---

## What Is NOT Changing

- All backend API logic stays the same
- Ollama integration stays the same
- File storage structure stays the same
- Mailer doc generation stays the same
- Gmail SMTP send logic stays the same

This spec is **frontend only** — no backend changes except the three new pause/resume/status endpoints.

---

## Implementation Order

1. CSS variables + base styles + fonts
2. Sidebar layout + health indicators
3. Upload zone component
4. Run console shell (header + progress bar)
5. Queue row component — all status states including pipeline stages
6. Per-row automatic pipeline: fetch → generate mail → generate preview → ready
7. Polling loop (`GET /api/campaigns/:id` every 2s during run)
8. Pause / Resume buttons + backend endpoints
9. Row inline expand accordion — shows all 4 data blocks
10. Send button per row — fires independently of run
11. Sent / Failed state updates inline
12. Run summary panel + download enriched Excel button
13. Campaign history panel
14. Mailer page polish
15. Animation pass (pulse stages, slide-in, accordion)
16. Final QA — overflow, state restore on refresh, keyboard nav

---

## Deliverable

A fully working replacement of `public/index.html`, `public/app.js`, and `public/styles.css` (or equivalent split files) that:

- looks and feels like a production outreach tool
- shows real-time row-by-row progress
- supports pause and resume mid-run
- handles per-row send flow inline
- exposes enriched file download
- restores state on page refresh
- runs entirely off the existing Express backend with three new endpoints added
