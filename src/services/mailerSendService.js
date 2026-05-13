function compact(value) {
  return String(value || "").trim();
}

function getMailerConfig() {
  return {
    brevoApiKey: compact(process.env.BREVO_API_KEY),
    brevoFrom: compact(process.env.BREVO_FROM),
    brevoFromName: compact(process.env.BREVO_FROM_NAME) || "Cold Mailbot",
    brevoReplyTo: compact(process.env.BREVO_REPLY_TO),
  };
}

function getMissingMailerVars(config) {
  const missing = [];
  if (!config.brevoApiKey) {
    missing.push("BREVO_API_KEY");
  }
  if (!config.brevoFrom) {
    missing.push("BREVO_FROM");
  }
  return missing;
}

function isMailerConfigured() {
  const provider = compact(process.env.MAIL_PROVIDER || "brevo").toLowerCase();
  if (provider !== "brevo") {
    return false;
  }
  const config = getMailerConfig();
  return getMissingMailerVars(config).length === 0;
}

async function verifyMailer() {
  const provider = compact(process.env.MAIL_PROVIDER || "brevo").toLowerCase();
  if (provider !== "brevo") {
    throw new Error(`Mailer verification failed: unsupported MAIL_PROVIDER=${provider}. Use brevo.`);
  }
  const config = getMailerConfig();
  const missing = getMissingMailerVars(config);
  if (missing.length > 0) {
    throw new Error(`Mailer verification failed: missing env vars ${missing.join(", ")}`);
  }
  console.log(`Brevo mailer configured: ${config.brevoFrom}`);
}

async function sendEmail({ to, subject, text, replyTo } = {}) {
  const provider = compact(process.env.MAIL_PROVIDER || "brevo").toLowerCase();
  if (provider !== "brevo") {
    throw new Error(`Unsupported MAIL_PROVIDER=${provider}. This app is configured for Brevo only.`);
  }
  const recipient = compact(to);
  const finalSubject = compact(subject);
  const finalText = String(text || "").trim();
  const config = getMailerConfig();
  const finalReplyTo = compact(replyTo) || config.brevoReplyTo || config.brevoFrom;

  if (!recipient || !finalSubject || !finalText) {
    throw new Error("sendEmail requires to, subject, and text");
  }
  const missing = getMissingMailerVars(config);
  if (missing.length > 0) {
    throw new Error(`Brevo mailer is not configured. Missing env vars: ${missing.join(", ")}`);
  }

  const payload = {
    sender: {
      email: config.brevoFrom,
      name: config.brevoFromName,
    },
    to: [{ email: recipient }],
    subject: finalSubject,
    textContent: finalText,
    replyTo: {
      email: finalReplyTo,
    },
  };

  let response;
  try {
    response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": config.brevoApiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new Error(`Failed to call Brevo API for ${recipient}: ${error.message}`);
  }

  let data = {};
  try {
    data = await response.json();
  } catch (_error) {
    data = {};
  }
  if (!response.ok) {
    throw new Error(`Brevo send failed for ${recipient}: ${data.message || response.status}`);
  }

  const messageId = compact(data.messageId);
  console.log(`[mailer] sent via brevo messageId=${messageId} to=${recipient}`);
  return {
    messageId,
    accepted: [recipient],
    rejected: [],
  };
}

module.exports = {
  sendEmail,
  verifyMailer,
  isMailerConfigured,
};
