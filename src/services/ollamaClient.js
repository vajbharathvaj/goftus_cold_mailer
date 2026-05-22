const { TextDecoder } = require("util");

let generationCounter = 0;

function isFetchConnectionFailure(error) {
  return error && error.name === "TypeError" && /fetch failed/i.test(String(error.message || ""));
}

function buildOllamaConnectionError({ baseUrl, action, error }) {
  const causeMessage = String(error?.cause?.message || "").trim();
  const suffix = causeMessage ? ` (${causeMessage})` : "";
  const wrapped = new Error(
    `Cannot reach Ollama at ${baseUrl} while ${action}. Start Ollama with "ollama serve" and ensure the model is available.${suffix}`
  );
  wrapped.cause = error;
  return wrapped;
}

function normalizeAbortReason(reason, fallback = "Request aborted") {
  const message = String(reason?.message || reason || "").trim();
  return message || fallback;
}

class OllamaClient {
  constructor({ baseUrl, model, timeoutMs, generationOptions = {}, think, keepAlive }) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.generationOptions = generationOptions;
    this.think = think;
    this.keepAlive = keepAlive;
  }

  async generate({ system, prompt, options = {} }) {
    try {
      return await this.generateWithThink({ system, prompt, options, think: this.think });
    } catch (error) {
      if (error.name === "AbortError") {
        const abortMessage = normalizeAbortReason(error.message, "Request aborted");
        if (/campaign stop requested/i.test(abortMessage)) {
          throw new Error(abortMessage);
        }
      }
      const shouldRetryWithoutThink =
        Boolean(this.think) &&
        (error.name === "AbortError" || /think value .* is not supported/i.test(error.message || ""));

      if (!shouldRetryWithoutThink) {
        if (error.name === "AbortError") {
          throw new Error(`Ollama request timed out after ${this.timeoutMs}ms`);
        }
        throw error;
      }

      try {
        return await this.generateWithThink({ system, prompt, options, think: undefined });
      } catch (retryError) {
        if (retryError.name === "AbortError") {
          throw new Error(
            `Ollama request timed out after ${this.timeoutMs}ms, then timed out again after retrying without think`
          );
        }
        throw retryError;
      }
    }
  }

  async generateWithThink({ system, prompt, options = {}, think }) {
    const { abortSignal = null, ...generationOverrides } = options || {};
    if (abortSignal?.aborted) {
      const aborted = new Error(normalizeAbortReason(abortSignal.reason, "Campaign stop requested"));
      aborted.name = "AbortError";
      throw aborted;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Ollama request timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    let abortHandler = null;
    if (abortSignal) {
      abortHandler = () => controller.abort(abortSignal.reason || new Error("Campaign stop requested"));
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
    const decoder = new TextDecoder();
    const mergedOptions = { ...this.generationOptions, ...generationOverrides };
    const generationId = `gen-${++generationCounter}`;

    try {
      let response;
      try {
        response = await fetch(`${this.baseUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: this.model,
            stream: true,
            system,
            prompt,
            ...(think ? { think } : {}),
            ...(this.keepAlive ? { keep_alive: this.keepAlive } : {}),
            options: mergedOptions,
          }),
        });
      } catch (error) {
        if (isFetchConnectionFailure(error)) {
          throw buildOllamaConnectionError({ baseUrl: this.baseUrl, action: "generating content", error });
        }
        throw error;
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Ollama request failed (${response.status}): ${body}`);
      }
      if (!response.body) {
        throw new Error("Ollama response did not include a readable stream");
      }

      const reader = response.body.getReader();
      let buffer = "";
      let visibleText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        while (buffer.includes("\n")) {
          const newlineIndex = buffer.indexOf("\n");
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) {
            continue;
          }

          let payload;
          try {
            payload = JSON.parse(line);
          } catch (_error) {
            console.warn(`[ollama] skipping malformed stream line generationId=${generationId}`);
            continue;
          }

          if (typeof payload.response === "string") {
            visibleText += payload.response;
          }
        }
      }

      const trailing = buffer.trim();
      if (trailing) {
        try {
          const payload = JSON.parse(trailing);
          if (typeof payload.response === "string") {
            visibleText += payload.response;
          }
        } catch (_error) {
          console.warn(`[ollama] trailing stream chunk was incomplete generationId=${generationId}`);
        }
      }

      if (!visibleText.trim()) {
        throw new Error("Ollama response missing text output");
      }
      return visibleText.trim();
    } finally {
      clearTimeout(timer);
      if (abortSignal && abortHandler) {
        abortSignal.removeEventListener("abort", abortHandler);
      }
    }
  }

  async warmup() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          prompt: "warmup",
          stream: false,
          ...(this.keepAlive ? { keep_alive: this.keepAlive } : {}),
          options: {
            num_predict: 1,
            temperature: 0,
          },
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Warmup failed (${response.status}): ${body}`);
      }
      await response.json().catch(() => ({}));
      return true;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Warmup timed out after ${this.timeoutMs}ms`);
      }
      if (isFetchConnectionFailure(error)) {
        throw buildOllamaConnectionError({ baseUrl: this.baseUrl, action: "warming up model", error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async unload() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          prompt: "",
          stream: false,
          keep_alive: 0,
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Unload failed (${response.status}): ${body}`);
      }
      await response.json().catch(() => ({}));
      return true;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Unload timed out after ${this.timeoutMs}ms`);
      }
      if (isFetchConnectionFailure(error)) {
        throw buildOllamaConnectionError({ baseUrl: this.baseUrl, action: "unloading model", error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { OllamaClient };
