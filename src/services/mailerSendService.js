function compact(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return compact(value).toLowerCase();
}

function getDomainFromEmail(value) {
  const email = normalizeEmail(value);
  const index = email.lastIndexOf("@");
  if (index < 1 || index >= email.length - 1) {
    return "";
  }
  return email.slice(index + 1);
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

async function callBrevoApi({ path, method = "GET", apiKey = "", body = null } = {}) {
  let response;
  try {
    response = await fetch(`https://api.brevo.com${path}`, {
      method,
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new Error(`Failed to call Brevo API ${path}: ${error.message}`);
  }

  let data = {};
  try {
    data = await response.json();
  } catch (_error) {
    data = {};
  }

  if (!response.ok) {
    throw new Error(data.message || `${response.status}`);
  }
  return data;
}

function normalizeSender(sender = {}) {
  const email = compact(sender.email);
  const domain = getDomainFromEmail(email);
  return {
    id: Number.isFinite(Number(sender.id)) ? Number(sender.id) : null,
    name: compact(sender.name),
    email,
    domain,
    active: sender.active !== false,
    ips: Array.isArray(sender.ips) ? sender.ips : [],
  };
}

async function listSenders() {
  const provider = compact(process.env.MAIL_PROVIDER || "brevo").toLowerCase();
  if (provider !== "brevo") {
    throw new Error(`Unsupported MAIL_PROVIDER=${provider}. This app is configured for Brevo only.`);
  }
  const config = getMailerConfig();
  const missing = getMissingMailerVars(config);
  if (missing.length > 0) {
    throw new Error(`Brevo mailer is not configured. Missing env vars: ${missing.join(", ")}`);
  }
  const data = await callBrevoApi({
    path: "/v3/senders",
    method: "GET",
    apiKey: config.brevoApiKey,
  });
  const senders = Array.isArray(data?.senders) ? data.senders : [];
  return senders.map((item) => normalizeSender(item)).filter((item) => Boolean(item.email));
}

async function resolveSelectedSender({ config, senderEmail = "", senderName = "" } = {}) {
  const requestedEmail = compact(senderEmail);
  if (!requestedEmail) {
    return {
      email: config.brevoFrom,
      name: config.brevoFromName,
      domain: getDomainFromEmail(config.brevoFrom),
      source: "default",
    };
  }

  const senders = await listSenders();
  const matched = senders.find((item) => normalizeEmail(item.email) === normalizeEmail(requestedEmail));
  if (!matched) {
    throw new Error(`Selected sender is not available in Brevo: ${requestedEmail}`);
  }
  if (!matched.active) {
    throw new Error(`Selected sender is inactive in Brevo: ${matched.email}`);
  }

  return {
    email: matched.email,
    name: compact(senderName) || matched.name || config.brevoFromName,
    domain: matched.domain,
    source: "selected",
  };
}

async function sendEmail({ to, subject, text, replyTo, senderEmail, senderName } = {}) {
  const provider = compact(process.env.MAIL_PROVIDER || "brevo").toLowerCase();
  if (provider !== "brevo") {
    throw new Error(`Unsupported MAIL_PROVIDER=${provider}. This app is configured for Brevo only.`);
  }
  const recipient = compact(to);
  const finalSubject = compact(subject);
  const finalText = String(text || "").trim();
  const config = getMailerConfig();

  if (!recipient || !finalSubject || !finalText) {
    throw new Error("sendEmail requires to, subject, and text");
  }
  const missing = getMissingMailerVars(config);
  if (missing.length > 0) {
    throw new Error(`Brevo mailer is not configured. Missing env vars: ${missing.join(", ")}`);
  }
  const selectedSender = await resolveSelectedSender({ config, senderEmail, senderName });
  const finalReplyTo = compact(replyTo) || config.brevoReplyTo || selectedSender.email;

  const payload = {
    sender: {
      email: selectedSender.email,
      name: selectedSender.name,
    },
    to: [{ email: recipient }],
    subject: finalSubject,
    textContent: finalText,
    replyTo: {
      email: finalReplyTo,
    },
  };

  let data = {};
  try {
    data = await callBrevoApi({
      path: "/v3/smtp/email",
      method: "POST",
      apiKey: config.brevoApiKey,
      body: payload,
    });
  } catch (error) {
    throw new Error(`Brevo send failed for ${recipient}: ${error.message}`);
  }

  const messageId = compact(data.messageId);
  console.log(
    `[mailer] sent via brevo messageId=${messageId} to=${recipient} sender=${selectedSender.email} domain=${selectedSender.domain}`
  );
  return {
    messageId,
    accepted: [recipient],
    rejected: [],
    sender: {
      email: selectedSender.email,
      name: selectedSender.name,
      domain: selectedSender.domain,
    },
  };
}

module.exports = {
  sendEmail,
  verifyMailer,
  isMailerConfigured,
  listSenders,
};
