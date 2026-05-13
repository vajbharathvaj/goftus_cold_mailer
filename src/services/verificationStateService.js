const DEFAULT_VERIFICATION_MAX_WAIT_MS = 5 * 60 * 1000;

class VerificationSkippedError extends Error {
  constructor(message = "Verification skipped by user") {
    super(message);
    this.name = "VerificationSkippedError";
    this.code = "VERIFICATION_SKIPPED";
  }
}

const pendingVerifications = new Map();

function toRowNumber(rowValue) {
  const parsed = Number.parseInt(rowValue, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("rowIndex/rowNumber must be a positive integer");
  }
  return parsed;
}

function keyFor(campaignId, rowNumber) {
  return `${String(campaignId || "").trim()}-${rowNumber}`;
}

async function waitForManualVerification({
  campaignId,
  rowNumber,
  domain = "",
  notifyUI = null,
  maxWaitMs = DEFAULT_VERIFICATION_MAX_WAIT_MS,
}) {
  const normalizedCampaignId = String(campaignId || "").trim();
  const normalizedRowNumber = toRowNumber(rowNumber);
  if (!normalizedCampaignId) {
    throw new Error("campaignId is required for manual verification flow");
  }

  const key = keyFor(normalizedCampaignId, normalizedRowNumber);
  const normalizedDomain = String(domain || "").trim();
  const waitMs = Number.isFinite(Number(maxWaitMs)) ? Math.max(1000, Number(maxWaitMs)) : DEFAULT_VERIFICATION_MAX_WAIT_MS;

  if (typeof notifyUI === "function") {
    await Promise.resolve(
      notifyUI({
        type: "verification_required",
        campaignId: normalizedCampaignId,
        rowNumber: normalizedRowNumber,
        rowIndex: normalizedRowNumber,
        domain: normalizedDomain,
        message: `Bot verification detected on ${normalizedDomain || "target domain"}. Solve it in Chrome then click Continue.`,
      })
    );
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingVerifications.delete(key);
      reject(new Error(`Verification timeout after ${waitMs}ms${normalizedDomain ? ` for ${normalizedDomain}` : ""}`));
    }, waitMs);

    pendingVerifications.set(key, {
      campaignId: normalizedCampaignId,
      rowNumber: normalizedRowNumber,
      domain: normalizedDomain,
      timestamp: Date.now(),
      resolve: () => {
        clearTimeout(timeout);
        pendingVerifications.delete(key);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timeout);
        pendingVerifications.delete(key);
        reject(error);
      },
    });
  });
}

function resumeVerification(campaignId, rowValue) {
  const normalizedCampaignId = String(campaignId || "").trim();
  const normalizedRowNumber = toRowNumber(rowValue);
  const key = keyFor(normalizedCampaignId, normalizedRowNumber);
  const pending = pendingVerifications.get(key);
  if (!pending) {
    throw new Error(`No pending verification found for campaign ${normalizedCampaignId} row ${normalizedRowNumber}`);
  }
  pending.resolve();
  return {
    ok: true,
    campaignId: normalizedCampaignId,
    rowNumber: normalizedRowNumber,
  };
}

function skipVerification(campaignId, rowValue) {
  const normalizedCampaignId = String(campaignId || "").trim();
  const normalizedRowNumber = toRowNumber(rowValue);
  const key = keyFor(normalizedCampaignId, normalizedRowNumber);
  const pending = pendingVerifications.get(key);
  if (!pending) {
    throw new Error(`No pending verification found for campaign ${normalizedCampaignId} row ${normalizedRowNumber}`);
  }
  pending.reject(new VerificationSkippedError("Verification skipped by user"));
  return {
    ok: true,
    campaignId: normalizedCampaignId,
    rowNumber: normalizedRowNumber,
  };
}

function getPendingVerifications() {
  return Array.from(pendingVerifications.values()).map((item) => ({
    campaignId: item.campaignId,
    rowNumber: item.rowNumber,
    rowIndex: item.rowNumber,
    domain: item.domain,
    waitingSinceMs: Date.now() - item.timestamp,
  }));
}

module.exports = {
  DEFAULT_VERIFICATION_MAX_WAIT_MS,
  VerificationSkippedError,
  getPendingVerifications,
  resumeVerification,
  skipVerification,
  waitForManualVerification,
};
