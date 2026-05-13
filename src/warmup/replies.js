const Imap = require("imap");
const { sendEmail } = require("../services/mailerSendService");
const { getTodayDate, readWarmupState, writeWarmupState } = require("./state");

const BASE_REPLY_MESSAGES = [
  "Thanks for getting back to me!",
  "Appreciated, talk soon.",
  "Will do, thanks!",
  "Great, speak soon.",
  "Thanks - will follow up shortly.",
];

const REPLY_VARIATIONS = [
  "",
  " Really appreciate it.",
  " Noted on my side.",
  " Will keep you posted.",
  " Thanks again for the quick response.",
];

function compact(value) {
  return String(value || "").trim();
}

function extractEmailAddress(fromValue) {
  const raw = compact(fromValue);
  if (!raw) {
    return "";
  }
  const bracketMatch = raw.match(/<([^>]+)>/);
  if (bracketMatch && bracketMatch[1]) {
    return compact(bracketMatch[1]).toLowerCase();
  }
  const directMatch = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return directMatch ? compact(directMatch[0]).toLowerCase() : "";
}

function connectImap() {
  return new Promise((resolve, reject) => {
    const user = compact(process.env.GMAIL_USER);
    const password = compact(process.env.GMAIL_APP_PASS);
    if (!user || !password) {
      reject(new Error("Gmail IMAP is not configured (GMAIL_USER/GMAIL_APP_PASS missing)"));
      return;
    }

    const imap = new Imap({
      user,
      password,
      host: "imap.gmail.com",
      port: 993,
      tls: true,
      tlsOptions: {
        rejectUnauthorized: false,
      },
    });

    imap.once("ready", () => resolve(imap));
    imap.once("error", (error) => reject(error));
    imap.connect();
  });
}

function openInbox(imap) {
  return new Promise((resolve, reject) => {
    imap.openBox("INBOX", false, (error, box) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(box);
    });
  });
}

function searchMessages(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (error, results) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Array.isArray(results) ? results : []);
    });
  });
}

function fetchHeaders(imap, uids) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(uids) || uids.length === 0) {
      resolve([]);
      return;
    }

    const messages = [];
    const fetcher = imap.fetch(uids, {
      bodies: "HEADER.FIELDS (FROM SUBJECT TO DATE TO)",
      markSeen: false,
    });

    fetcher.on("message", (message) => {
      let uid = null;
      let headerRaw = "";

      message.on("attributes", (attributes) => {
        uid = Number(attributes?.uid) || null;
      });

      message.on("body", (stream) => {
        stream.on("data", (chunk) => {
          headerRaw += chunk.toString("utf8");
        });
      });

      message.once("end", () => {
        const parsedHeader = Imap.parseHeader(headerRaw || "");
        messages.push({
          uid,
          from: compact(parsedHeader?.from?.[0]),
          to: compact(parsedHeader?.to?.[0]),
          subject: compact(parsedHeader?.subject?.[0]),
          date: compact(parsedHeader?.date?.[0]),
        });
      });
    });

    fetcher.once("error", (error) => reject(error));
    fetcher.once("end", () => resolve(messages));
  });
}

function markSeen(imap, uid) {
  return new Promise((resolve, reject) => {
    if (!uid) {
      resolve();
      return;
    }
    imap.addFlags(uid, "\\Seen", (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeImap(imap) {
  return new Promise((resolve) => {
    if (!imap) {
      resolve();
      return;
    }
    const finalize = () => resolve();
    imap.once("end", finalize);
    try {
      imap.end();
    } catch (_error) {
      resolve();
    }
  });
}

function pickNonRepeatingReply(lastIndex) {
  if (BASE_REPLY_MESSAGES.length <= 1) {
    return 0;
  }
  let nextIndex = Math.floor(Math.random() * BASE_REPLY_MESSAGES.length);
  while (nextIndex === lastIndex) {
    nextIndex = Math.floor(Math.random() * BASE_REPLY_MESSAGES.length);
  }
  return nextIndex;
}

function buildReplyMessage(replyIndex) {
  const base = BASE_REPLY_MESSAGES[replyIndex] || BASE_REPLY_MESSAGES[0];
  const variation = REPLY_VARIATIONS[Math.floor(Math.random() * REPLY_VARIATIONS.length)] || "";
  return `${base}${variation}`.trim();
}

function applyRepliesToHistory(state, replyCount) {
  const today = getTodayDate();
  const history = Array.isArray(state.history) ? [...state.history] : [];
  const index = history.findIndex((item) => compact(item?.date) === today);
  if (index >= 0) {
    history[index] = {
      date: today,
      sent: Number.isFinite(Number(history[index]?.sent)) ? Number(history[index].sent) : 0,
      replies: (Number.isFinite(Number(history[index]?.replies)) ? Number(history[index].replies) : 0) + replyCount,
    };
  } else {
    history.push({
      date: today,
      sent: 0,
      replies: replyCount,
    });
  }
  return history;
}

async function checkReplies() {
  const targetAddress = compact(process.env.GMAIL_FROM).toLowerCase();
  if (!targetAddress) {
    throw new Error("GMAIL_FROM is required for reply checks");
  }

  let imap = null;
  let repliesFound = 0;
  let repliedTo = 0;
  let lastReplyIndex = -1;

  try {
    imap = await connectImap();
    await openInbox(imap);

    const sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const searchDate = sinceDate.toDateString();
    const uids = await searchMessages(imap, ["UNSEEN", ["TO", targetAddress], ["SINCE", searchDate]]);
    const headers = await fetchHeaders(imap, uids);

    const recentHeaders = headers.filter((item) => {
      const toAddress = extractEmailAddress(item.to);
      if (toAddress && toAddress !== targetAddress) {
        return false;
      }
      const parsedDate = Date.parse(item.date);
      if (!Number.isFinite(parsedDate)) {
        return true;
      }
      return parsedDate >= Date.now() - 24 * 60 * 60 * 1000;
    });

    repliesFound = recentHeaders.length;
    for (const message of recentHeaders) {
      const fromAddress = extractEmailAddress(message.from);
      if (!fromAddress) {
        continue;
      }

      const replyIndex = pickNonRepeatingReply(lastReplyIndex);
      lastReplyIndex = replyIndex;
      const replyText = buildReplyMessage(replyIndex);
      const replySubject = /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject || "Quick follow up"}`;

      try {
        await sendEmail({
          to: fromAddress,
          subject: replySubject,
          text: replyText,
        });
        await markSeen(imap, message.uid);
        repliedTo += 1;
        console.log(`[warmup] Replied to ${fromAddress}`);
      } catch (error) {
        console.warn(`[warmup] Reply send failed for ${fromAddress}: ${error.message}`);
      }
    }

    if (repliedTo > 0) {
      const state = await readWarmupState();
      await writeWarmupState({
        ...state,
        history: applyRepliesToHistory(state, repliedTo),
      });
    }

    return {
      repliesFound,
      repliedTo,
    };
  } finally {
    await closeImap(imap);
  }
}

module.exports = {
  checkReplies,
};
