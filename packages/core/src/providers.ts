import type { ApiProvider, AssistantSettings, LLMMessage, ProviderName, StreamOptions } from "./types";

export interface LLMProvider {
  stream(messages: LLMMessage[], options: StreamOptions): AsyncIterable<string>;
}

async function* readSse(response: Response, parse: (data: string) => string | null, signal?: AbortSignal) {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Provider request failed (${response.status}): ${body.slice(0, 500)}`);
  }
  if (!response.body) throw new Error("Provider returned an empty response stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("The response was stopped.", "AbortError");
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const text = parse(data);
        if (text) yield text;
      }
      if (done) {
        if (buffer.startsWith("data:")) {
          const data = buffer.slice(5).trim();
          if (data && data !== "[DONE]") {
            const text = parse(data);
            if (text) yield text;
          }
        }
        break;
      }
    }
  } finally {
    if (signal?.aborted) await reader.cancel();
    reader.releaseLock();
  }
}

export class OpenAICompatibleProvider implements LLMProvider {
  async *stream(messages: LLMMessage[], options: StreamOptions): AsyncIterable<string> {
    const base = options.baseUrl.replace(/\/+$/, "");
    const endpoint = base.endsWith("/chat/completions") ? base : `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: options.model,
        messages,
        stream: true,
        ...(options.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {})
      }),
      signal: options.signal
    });
    yield* readSse(response, (data) => {
      const payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      return payload.choices?.[0]?.delta?.content ?? null;
    }, options.signal);
  }
}

export class AnthropicProvider implements LLMProvider {
  async *stream(messages: LLMMessage[], options: StreamOptions): AsyncIterable<string> {
    const base = options.baseUrl.replace(/\/+$/, "");
    const endpoint = base.endsWith("/messages") ? base : `${base.endsWith("/v1") ? base : `${base}/v1`}/messages`;
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    const anthropicMessages = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: typeof message.content === "string" ? message.content : message.content.map((part) => {
          if (part.type === "text") return { type: "text", text: part.text };
          const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(part.image_url.url);
          if (!match) throw new Error("Anthropic image attachments must be base64 data URLs.");
          return {
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] }
          };
        })
      }));
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-api-key": options.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: options.maxOutputTokens ?? 2048,
        stream: true,
        ...(system ? { system } : {}),
        messages: anthropicMessages
      }),
      signal: options.signal
    });
    yield* readSse(response, (data) => {
      const payload = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string } };
      return payload.type === "content_block_delta" && payload.delta?.type === "text_delta"
        ? payload.delta.text ?? null
        : null;
    }, options.signal);
  }
}

export function createProvider(provider: ProviderName): LLMProvider {
  return provider === "anthropic" ? new AnthropicProvider() : new OpenAICompatibleProvider();
}

export const API_PRESETS: Record<ApiProvider, { provider: ProviderName; baseUrl: string; model: string }> = {
  gemini: { provider: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash" },
  openrouter: { provider: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
  custom: { provider: "openai", baseUrl: "", model: "" }
};

export function defaultSettingsForApiProvider(apiProvider: ApiProvider): AssistantSettings {
  const preset = API_PRESETS[apiProvider];
  return {
    apiProvider,
    provider: preset.provider,
    apiKey: "",
    hasApiKey: false,
    model: preset.model,
    baseUrl: preset.baseUrl,
    theme: "dark",
    skin: "nova",
    hotkey: "Alt+Shift+F",
    disabledSites: []
  };
}
