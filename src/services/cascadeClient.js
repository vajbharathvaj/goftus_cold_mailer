const EXHAUSTION_MESSAGES = ["rate limit", "quota", "billing", "insufficient_quota", "rate_limit_exceeded"];
const EXHAUSTION_STATUSES = new Set([429, 402]);

function isExhausted(error) {
  if (!error) return false;
  if (EXHAUSTION_STATUSES.has(error.status || error.statusCode || 0)) return true;
  const msg = String(error.message || error.code || "").toLowerCase();
  return EXHAUSTION_MESSAGES.some((kw) => msg.includes(kw));
}

class CascadeClient {
  constructor({ tiers }) {
    // tiers: [{ name, label, model, client, costPer1kTokens }]
    // client is null for the table-fallback tier
    this.tiers = Array.isArray(tiers) ? tiers : [];
    this.currentTierIndex = 0;
    this.tierStats = this.tiers.map((t) => ({
      name: t.name,
      tokensUsed: 0,
      errors: 0,
      lastError: null,
    }));
    this._listeners = [];
  }

  get currentTier() {
    return this.tiers[this.currentTierIndex] || null;
  }

  getStatus() {
    return {
      currentTier: this.currentTier?.name || "table",
      tiers: this.tiers.map((t, i) => {
        const stats = this.tierStats[i] || {};
        const costPer1k = t.costPer1kTokens || 0;
        return {
          name: t.name,
          label: t.label,
          model: t.model || "",
          active: i === this.currentTierIndex,
          available: Boolean(t.client),
          tokensUsed: stats.tokensUsed || 0,
          estimatedCostUsd: parseFloat(((stats.tokensUsed || 0) / 1000 * costPer1k).toFixed(4)),
          errors: stats.errors || 0,
          lastError: stats.lastError || null,
        };
      }),
    };
  }

  switchToTier(name) {
    const idx = this.tiers.findIndex((t) => t.name === name);
    if (idx < 0) throw new Error(`Unknown model tier: ${name}`);
    this.currentTierIndex = idx;
    this._emit();
  }

  onTierChange(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter((l) => l !== fn); };
  }

  _emit() {
    const status = this.getStatus();
    this._listeners.forEach((fn) => fn(status));
  }

  async generate(params) {
    for (let i = this.currentTierIndex; i < this.tiers.length; i++) {
      const tier = this.tiers[i];

      if (!tier.client) {
        // Signal table-only fallback
        const err = new Error("TABLE_FALLBACK: all cloud tiers exhausted");
        err.isTableFallback = true;
        throw err;
      }

      try {
        const result = await tier.client.generate(params);
        // Approximate token tracking (4 chars ≈ 1 token)
        const approxTokens = Math.ceil(
          ((params.system?.length || 0) + (params.prompt?.length || 0) + (result?.length || 0)) / 4
        );
        if (this.tierStats[i]) this.tierStats[i].tokensUsed += approxTokens;

        if (i !== this.currentTierIndex) {
          this.currentTierIndex = i;
          this._emit();
        }
        return result;
      } catch (error) {
        if (this.tierStats[i]) {
          this.tierStats[i].errors += 1;
          this.tierStats[i].lastError = error.message || String(error);
        }

        if (isExhausted(error) && i + 1 < this.tiers.length) {
          const nextTier = this.tiers[i + 1];
          console.warn(`[cascade] ${tier.name} exhausted — escalating to ${nextTier.name}`);
          this.currentTierIndex = i + 1;
          this._emit();
          continue;
        }

        throw error;
      }
    }

    const err = new Error("TABLE_FALLBACK: all cloud tiers exhausted");
    err.isTableFallback = true;
    throw err;
  }
}

module.exports = { CascadeClient };
