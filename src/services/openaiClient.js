const OpenAI = require("openai");

class OpenAIClient {
  constructor({ apiKey, model = "gpt-4o-mini", timeoutMs = 60000, baseUrl }) {
    this.client = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
      timeout: timeoutMs,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
    this.model = model;
  }

  async generate({ system, prompt, options = {} }) {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });

    const params = {
      model: this.model,
      messages,
      max_tokens: options.num_predict || 1000,
      temperature: options.temperature ?? 0.7,
    };

    const completion = await this.client.chat.completions.create(params);
    return completion.choices[0]?.message?.content || "";
  }
}

module.exports = { OpenAIClient };
