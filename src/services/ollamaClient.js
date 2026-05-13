const { TextDecoder } = require("util");

let generationCounter = 0;

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const decoder = new TextDecoder();
    const mergedOptions = { ...this.generationOptions, ...options };
    const generationId = `gen-${++generationCounter}`;

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
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
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { OllamaClient };
