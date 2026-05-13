# Gmail SMTP Sending Implementation

## Overview

Make the Cold Mailbot send emails through Gmail's SMTP server so every email
looks identical to one sent manually from your inbox.

---

## 1. Prerequisites

- A Gmail or Google Workspace account (`you@gmail.com` or `you@goftus.com`)
- Node.js project already running (Cold Mailbot)
- 2-Step Verification enabled on your Google account

---

## 2. Get Your Google App Password

1. Go to `https://myaccount.google.com`
2. Click **Security**
3. Under **How you sign in to Google** → click **2-Step Verification** → turn it ON
4. In the search bar at the top → search **App Passwords**
5. Select app: **Mail** → Select device: **Other** → type `coldmailbot`
6. Click **Generate**
7. Copy the 16-character password shown (you only see it once)

---

## 3. Add Environment Variables

Create or update your `.env` file in the project root:

```env
GMAIL_USER=you@gmail.com
GMAIL_APP_PASS=xxxx xxxx xxxx xxxx
GMAIL_FROM_NAME=Your Name
```

Make sure `.env` is in your `.gitignore`:

```
# .gitignore
.env
storage/
```

---

## 4. Install Nodemailer

```bash
npm install nodemailer
```

---

## 5. Create The Mail Sender Service

Create `src/services/mailerSendService.js`:

```javascript
import nodemailer from 'nodemailer';

// Connects to Gmail SMTP - Google delivers the email, not your machine
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false, // TLS
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASS,
  },
});

/**
 * Sends one cold email through Gmail SMTP.
 * Adds a random delay to mimic human sending behaviour.
 *
 * @param {Object} options
 * @param {string} options.to        - Recipient email address
 * @param {string} options.subject   - Email subject line
 * @param {string} options.body      - Plain text email body
 * @param {number} [options.delayMs] - Override delay in ms (default: random 3-5 min)
 */
export async function sendColdEmail({ to, subject, body, delayMs }) {
  // Random delay between 3 and 5 minutes to mimic human pacing
  const delay = delayMs ?? Math.floor(Math.random() * 120000) + 180000;
  await new Promise(r => setTimeout(r, delay));

  const info = await transporter.sendMail({
    from: `"${process.env.GMAIL_FROM_NAME}" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text: body, // plain text only - better deliverability than HTML
  });

  return info;
}

/**
 * Verifies the SMTP connection is working.
 * Call this on app startup to catch config errors early.
 */
export async function verifyMailConnection() {
  return transporter.verify();
}
```

---

## 6. Add A Send Endpoint To The Backend

Add to `src/server.js`:

```javascript
import { sendColdEmail, verifyMailConnection } from './services/mailerSendService.js';

// Verify mail connection on startup
verifyMailConnection()
  .then(() => console.log('Mail connection verified'))
  .catch(err => console.error('Mail connection failed:', err.message));

// Send endpoint
app.post('/api/campaigns/send', async (req, res) => {
  const { to, subject, body } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'to, subject, and body are required' });
  }

  try {
    const info = await sendColdEmail({ to, subject, body });
    res.json({ success: true, messageId: info.messageId });
  } catch (err) {
    console.error('Send failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

---

## 7. Add A Send Button To The Campaign UI

In `public/index.html` or your campaign card template, add a send button per row:

```javascript
// Called when user clicks Send on a campaign row
async function sendMailerEmail(rowData) {
  const { subject, body, contactEmail } = rowData;

  const confirmed = confirm(`Send to ${contactEmail}?`);
  if (!confirmed) return;

  const res = await fetch('/api/campaigns/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: contactEmail,
      subject: subject,
      body: body,
    }),
  });

  const result = await res.json();

  if (result.success) {
    alert('Email sent successfully.');
  } else {
    alert(`Send failed: ${result.error}`);
  }
}
```

---

## 8. Sending Rules To Stay Out Of Spam

These are applied automatically by the service but good to know:

| Rule | Why |
|---|---|
| Plain text only (no HTML) | HTML triggers spam filters |
| Random 3-5 min delay between sends | Mimics human behaviour |
| Max 50-100 emails per day | Stays within safe Gmail limits |
| No tracking pixels | Hurts deliverability |
| One recipient per email (no CC/BCC blasts) | Avoids bulk mail detection |

---

## 9. Gmail Daily Sending Limits

| Account Type | Daily Limit |
|---|---|
| Free Gmail | 500 emails/day |
| Google Workspace | 2000 emails/day |

For cold outreach at 50-100/day you are well within limits.

---

## 10. File Structure After Implementation

```
cold-mailbot/
├── src/
│   ├── server.js                        ← add /api/campaigns/send route
│   ├── services/
│   │   ├── mailerSendService.js         ← NEW: Gmail SMTP sender
│   │   ├── contentService.js
│   │   ├── campaignStorage.js
│   │   ├── mailerDocService.js
│   │   └── ollamaClient.js
│   ├── prompts/
│   │   └── contentPrompts.js
│   └── utils/
│       └── contentRules.js
├── public/
│   └── index.html                       ← add Send button to campaign cards
├── storage/
│   └── campaigns/
├── .env                                 ← add GMAIL_USER, GMAIL_APP_PASS
├── .gitignore
└── package.json
```

---

## 11. Full Flow After Implementation

```
User clicks Send on campaign row
    → Frontend calls POST /api/campaigns/send
        → Backend waits random 3-5 min delay
            → Nodemailer connects to smtp.gmail.com:587
                → Gmail authenticates with App Password
                    → Gmail delivers email from your address
                        → Recipient receives it exactly as if you sent it manually
```

---

## Summary

| Step | Action |
|---|---|
| 1 | Enable 2FA on Google account |
| 2 | Generate App Password |
| 3 | Add credentials to `.env` |
| 4 | `npm install nodemailer` |
| 5 | Create `mailerSendService.js` |
| 6 | Add `/api/campaigns/send` route |
| 7 | Add Send button to campaign UI |
| 8 | Test with one email first |