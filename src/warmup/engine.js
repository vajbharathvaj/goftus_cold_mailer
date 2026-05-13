const { EventEmitter } = require("events");
const { sendEmail } = require("../services/mailerSendService");
const { getTodayDate, readWarmupState, writeWarmupState } = require("./state");

const progressEmitter = new EventEmitter();
progressEmitter.setMaxListeners(200);

const WARMUP_TEMPLATES = [
  {
    subject: "Quick question",
    body: "Hey, do you have 5 minutes to catch up this week?",
  },
  {
    subject: "Following up",
    body: "Just wanted to check in - how are things going on your end?",
  },
  {
    subject: "re: our chat",
    body: "Good speaking with you. Let me know if you need anything.",
  },
  {
    subject: "Thoughts?",
    body: "Would love to get your take on this when you get a chance.",
  },
  {
    subject: "Quick update",
    body: "Just a heads up - making some progress on my end. More soon.",
  },
  {
    subject: "Checking in",
    body: "Hope things are going well. Let me know if you need anything from me.",
  },
  {
    subject: "One quick thing",
    body: "Meant to ask you this earlier - do you have a moment this week?",
  },
  {
    subject: "Still on for this?",
    body: "Just confirming we are still good to connect. Let me know.",
  },
  {
    subject: "Hey",
    body: "Been a while - hope everything is going well on your side.",
  },
  {
    subject: "Any update?",
    body: "Circling back on this - let me know when you get a chance.",
  },
];

const AI_SUBJECT_SUFFIXES = ["", " - quick note", " - checking in", " - follow-up", " (quick)"];
const AI_BODY_OPENERS = ["Hi there,", "Hey,", "Hello,", "Quick note,", "Hope you are doing well,"];
const AI_BODY_CLOSERS = [
  "Thanks!",
  "Appreciate it.",
  "Talk soon.",
  "Cheers.",
  "Looking forward to your thoughts.",
  "No rush on this.",
];
const AI_BODY_EXTRAS = [
  "Wanted to keep this thread warm.",
  "Sharing this as a quick touchpoint.",
  "Sending a short follow-up from my side.",
  "Thought I would check in briefly.",
  "Keeping this light and simple.",
  "Just making sure this reached you.",
];

let warmupRunInProgress = false;

function parseDelayMs(rawValue, fallbackMs) {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    return fallbackMs;
  }
  return Math.max(0, parsed);
}

function getWarmupDelayRangeMs() {
  const minDefault = 5000;
  const maxDefault = 10000;
  const minMs = parseDelayMs(process.env.WARMUP_MIN_DELAY_MS, minDefault);
  const maxMs = parseDelayMs(process.env.WARMUP_MAX_DELAY_MS, maxDefault);
  const low = Math.min(minMs, maxMs);
  const high = Math.max(minMs, maxMs);
  return {
    minMs: Math.min(low, 10000),
    maxMs: Math.min(high, 10000),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function randomInt(min, max) {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function shuffle(values = []) {
  const next = [...values];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(0, index);
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function emitProgress(event) {
  progressEmitter.emit("progress", event);
}

function subscribeProgress(listener) {
  progressEmitter.on("progress", listener);
  return () => progressEmitter.off("progress", listener);
}

function isWarmupRunning() {
  return warmupRunInProgress;
}

function getDailyVolumeFromSeeds(seedEmails = []) {
  const normalizedSeeds = Array.isArray(seedEmails)
    ? seedEmails
        .map((item) => String(item || "").trim().toLowerCase())
        .filter(Boolean)
    : [];
  return Math.max(0, Math.min(40, normalizedSeeds.length));
}

function pickNonRepeatingIndex(maxLength, lastIndex) {
  if (maxLength <= 1) {
    return 0;
  }
  let next = randomInt(0, maxLength - 1);
  while (next === lastIndex) {
    next = randomInt(0, maxLength - 1);
  }
  return next;
}

function buildRecipientPlan(seedEmails = [], targetCount = 0) {
  const normalizedSeeds = shuffle(
    seedEmails
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean)
  );
  if (normalizedSeeds.length === 0 || targetCount < 1) {
    return [];
  }
  if (normalizedSeeds.length === 1) {
    return [normalizedSeeds[0]];
  }

  const plan = [];
  let cursor = 0;
  while (plan.length < targetCount) {
    let candidate = normalizedSeeds[cursor % normalizedSeeds.length];
    if (plan.length > 0 && candidate === plan[plan.length - 1] && normalizedSeeds.length > 1) {
      cursor += 1;
      candidate = normalizedSeeds[cursor % normalizedSeeds.length];
    }
    plan.push(candidate);
    cursor += 1;
  }
  return plan;
}

function buildAiVariant(template, usedFingerprints = new Set()) {
  let attempts = 0;
  while (attempts < 20) {
    attempts += 1;
    const subjectSuffix = AI_SUBJECT_SUFFIXES[randomInt(0, AI_SUBJECT_SUFFIXES.length - 1)];
    const opener = AI_BODY_OPENERS[randomInt(0, AI_BODY_OPENERS.length - 1)];
    const extra = AI_BODY_EXTRAS[randomInt(0, AI_BODY_EXTRAS.length - 1)];
    const closer = AI_BODY_CLOSERS[randomInt(0, AI_BODY_CLOSERS.length - 1)];

    const subject = `${template.subject}${subjectSuffix}`.trim();
    const body = [opener, template.body, extra, closer].join("\n\n").trim();
    const fingerprint = `${subject}||${body}`;
    if (!usedFingerprints.has(fingerprint)) {
      usedFingerprints.add(fingerprint);
      return { subject, body };
    }
  }

  const fallbackSubject = `${template.subject} ${new Date().toISOString().slice(11, 19)}`.trim();
  const fallbackBody = `${template.body}\n\n${AI_BODY_CLOSERS[randomInt(0, AI_BODY_CLOSERS.length - 1)]}`;
  return { subject: fallbackSubject, body: fallbackBody };
}

async function waitWithProgress(delayMs) {
  let remainingSeconds = Math.max(0, Math.ceil(delayMs / 1000));
  while (remainingSeconds > 0) {
    emitProgress({
      type: "waiting",
      seconds: remainingSeconds,
    });
    const chunk = 1;
    await sleep(chunk * 1000);
    remainingSeconds -= chunk;
  }
}

function updateHistory(history = [], today, sent) {
  const nextHistory = Array.isArray(history) ? [...history] : [];
  const existingIndex = nextHistory.findIndex((item) => String(item?.date || "").trim() === today);
  if (existingIndex >= 0) {
    nextHistory[existingIndex] = {
      date: today,
      sent,
      replies: Number.isFinite(Number(nextHistory[existingIndex]?.replies)) ? Number(nextHistory[existingIndex].replies) : 0,
    };
  } else {
    nextHistory.push({
      date: today,
      sent,
      replies: 0,
    });
  }
  return nextHistory;
}

async function runWarmupSession() {
  if (warmupRunInProgress) {
    return {
      skipped: true,
      reason: "run already in progress",
    };
  }

  warmupRunInProgress = true;
  try {
    const state = await readWarmupState();
    const today = getTodayDate();
    if (state.lastRunDate === today) {
      return {
        skipped: true,
        reason: "already ran today",
      };
    }

    const dailyVolume = getDailyVolumeFromSeeds(state.seedEmails);
    const recipients = buildRecipientPlan(state.seedEmails, dailyVolume);
    const usedCopyFingerprints = new Set();
    let lastTemplateIndex = -1;
    let sentCount = 0;

    for (let index = 0; index < recipients.length; index += 1) {
      const recipient = recipients[index];
      const templateIndex = pickNonRepeatingIndex(WARMUP_TEMPLATES.length, lastTemplateIndex);
      lastTemplateIndex = templateIndex;
      const template = WARMUP_TEMPLATES[templateIndex];
      const aiCopy = buildAiVariant(template, usedCopyFingerprints);
      emitProgress({
        type: "sending",
        to: recipient,
        count: index + 1,
        total: recipients.length,
      });

      try {
        await sendEmail({
          to: recipient,
          subject: aiCopy.subject,
          text: aiCopy.body,
        });
        sentCount += 1;
        console.log(`[warmup] Sent to ${recipient} (${index + 1} of ${recipients.length})`);
      } catch (error) {
        console.warn(`[warmup] Send failed to ${recipient}: ${error.message}`);
      }

      if (index < recipients.length - 1) {
        const { minMs, maxMs } = getWarmupDelayRangeMs();
        const delayMs = randomInt(minMs, maxMs);
        await waitWithProgress(delayMs);
      }
    }

    const nextVolume = dailyVolume;
    const updatedState = {
      ...state,
      todaySentCount: sentCount,
      lastRunDate: today,
      currentDailyVolume: nextVolume,
      history: updateHistory(state.history, today, sentCount),
    };
    await writeWarmupState(updatedState);

    if (sentCount === 0) {
      emitProgress({
        type: "error",
        message: "All sends failed",
      });
    }

    emitProgress({
      type: "done",
      sent: sentCount,
      nextVolume,
    });

    return {
      sent: sentCount,
      dailyVolume,
      nextVolume,
    };
  } finally {
    warmupRunInProgress = false;
  }
}

module.exports = {
  runWarmupSession,
  subscribeProgress,
  isWarmupRunning,
};
