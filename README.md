# Cold Mailbot

Local Node.js service for:

- generating B2B cold email drafts and subject lines with Ollama
- enriching campaign spreadsheets from website and LinkedIn search data
- generating mailer field documents for selected campaign rows

## Stack

- Node.js + Express
- Ollama
- Zod
- XLSX
- docx

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy env values:

```bash
copy .env.example .env
```

3. Start Ollama and make sure your configured model exists.

Optional: set rotating proxies for campaign fetch calls in `.env`:

```env
PROXY_LIST=http://user:pass@proxy1:port,http://user:pass@proxy2:port,proxy3:port
```

Optional: use your logged-in Chrome profile for LinkedIn search fetches:

```env
LINKEDIN_FETCH_MODE=chrome_profile
CHROME_USER_DATA_DIR=C:\Users\<you>\AppData\Local\Google\Chrome\User Data
CHROME_PROFILE_DIRECTORY=Default
CHROME_HEADLESS=false
```

Optional: speed-focused campaign defaults (target lower per-row latency):

```env
PROFILE_SEARCH_ONLY=false
PREVIEW_USE_COMBINED_GENERATION=true
PIPELINE_STAGE_TIMEOUT_MS=90000
REQUEST_TIMEOUT_MS=90000
```

4. Start the app:

```bash
npm run dev
```

5. Open:

`http://localhost:3000`

## Main Routes

- `GET /health`
- `POST /api/content/draft`
- `POST /api/content/subject`
- `POST /api/content/generate`
- `POST /api/content/variants`
- `POST /api/campaigns`
- `POST /api/campaigns/mailer-doc`
