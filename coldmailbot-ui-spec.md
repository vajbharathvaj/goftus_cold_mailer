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
┌──────────────────────────────────────────────────────────────────┐
│  RUN  campaign-1748291023-abc  ●  RUNNING           [ ⏸ Pause ] │
│  ──────────────────────────────────────────────────────────────  │
│  Progress  ████████████░░░░░░░░░░░░░░  8 / 20 rows              │
│  Started 2 min ago · ETA ~4 min · 0 failed                      │
│──────────────────────────────────────────────────────────────────│
│  QUEUE                                                           │
│                                                                  │
│  ✓  1  Acme Corp          acme.com          Done     0.8s       │
│  ✓  2  Beta Industries    betaind.io        Done     1.1s       │
│  ✓  3  Coda Systems       codasys.com       Done     2.3s       │
│  ✓  4  Deltaforge         deltaforge.net    Done     0.9s       │
│  ✓  5  Everline           everline.co       Done     1.4s       │
│  ✓  6  Flink Labs         flink.io          Done     1.2s       │
│  ✓  7  Gantry Tech        gantry.tech       Done     0.7s       │
│  ▶  8  Helios Corp        helios.com      ● Fetching...         │  ← active row, pulsing
│  ○  9  Ironside           ironside.io       Queued              │
│  ○ 10  Jetform            jetform.co        Queued              │
│     ...                                                          │
└──────────────────────────────────────────────────────────────────┘
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
- Status indicator:
  - `○ Queued` — grey
  - `● Fetching...` — cyan with pulse dot (active row only)
  - `✓ Done` — green + duration in ms/s
  - `✗ Failed` — red + hover shows error tooltip
  - `⏸ Paused` — amber (row was being processed when paused)
- Clicking any completed row expands inline preview (see 2.3)

**Pause / Resume:**
- `⏸ Pause` button in header — immediately halts after current row finishes
- Button changes to `▶ Resume` when paused
- Paused state persists in `metadata.json` so page refresh restores it
- Resume continues from the next unprocessed row

**Stop:**
- Long-press `⏸ Pause` or separate `■ Stop` button (appears on hover of pause)
- Stops run permanently, marks campaign as `stopped`

---

### 2.3 Row Inline Expand (Replaces Card Modal)

Clicking a completed row in the queue expands it inline:

```
┌──────────────────────────────────────────────────────────────────┐
│  ▼  8  Helios Corp        helios.com          ✓ Done    1.2s    │
│  ──────────────────────────────────────────────────────────────  │
│  WEBSITE CONTENT                              [ Copy ] [ ↓ ]    │
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
│  [ Generate + Preview + Send → ]                                 │
└──────────────────────────────────────────────────────────────────┘
```

- Smooth accordion animation open/close
- `Read more / Read less` toggle for long content
- Copy icon on content blocks
- `Generate + Preview + Send` CTA at the bottom — primary action button

---

### 2.4 Send Flow Inline (Per Row)

When `Generate + Preview + Send` is clicked on an expanded row:

#### Phase A — Generating

```
  [ ● Generating mailer fields... ]
```

Inline spinner with text. Button is replaced, not disabled.

#### Phase B — Preview Card

Appears inline below the row expand:

```
┌──────────────────────────────────────────────────────────────────┐
│  EMAIL PREVIEW                                        [ Edit ]   │
│  ──────────────────────────────────────────────────────────────  │
│  To:       contact@helios.com                                    │
│  Subject:  Quick question about your supply chain visibility     │
│                                                                  │
│  Hi Sarah,                                                       │
│                                                                  │
│  Managing visibility across your supply chain...                 │
│  [Read more]                                                     │
│                                                                  │
│  Best regards,                                                   │
│  Bharathvaj, Goftus Team                                         │
│  ──────────────────────────────────────────────────────────────  │
│  [ ✗ Discard ]                        [ ✓ Send Email → ]        │
└──────────────────────────────────────────────────────────────────┘
```

- `To` field is editable inline if email was not in spreadsheet
- `Subject` is editable inline
- Body is read-only in preview but `[ Edit ]` button opens it as textarea
- `Send Email` — primary cyan button
- `Discard` — ghost red button

#### Phase C — Sent Confirmation

```
  ✓  Email sent to contact@helios.com   · Message ID: <abc123>   [ View Log ]
```

Row status badge in queue updates to `✉ Sent` in green.

#### Phase D — Send Failed

```
  ✗  Send failed: 535 Authentication failed   [ Retry ] [ Check Config ]
```

Row status updates to `✗ Failed` in red.

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
      "status": "done | failed | queued | processing | paused",
      "durationMs": 1200,
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
Queued     →  grey pill       ○ Queued
Processing →  cyan pulse      ● Fetching...
Done       →  green pill      ✓ Done
Failed     →  red pill        ✗ Failed
Paused     →  amber pill      ⏸ Paused
Sent       →  green outline   ✉ Sent
Preview    →  cyan outline    ◎ Preview Ready
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
5. Queue row component (all status states)
6. Polling loop (`GET /api/campaigns/:id` every 2s)
7. Pause / Resume buttons + backend endpoints
8. Row inline expand + accordion
9. Send preview card inline
10. Run summary panel + download button
11. Campaign history panel
12. Mailer page polish
13. Animation pass (pulse, slide, accordion)
14. Final QA — overflow, mobile-safe layout, keyboard nav

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
