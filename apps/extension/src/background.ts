import { createProvider, MAX_CHAT_OUTPUT_TOKENS } from "@tex/core";
import type { AssistantSettings, LLMContentPart, LLMMessage, ProviderName, SkinName } from "@tex/core";
import {
  getEngineStatus,
  isEngineUnavailable,
  requestEngineJson,
  shouldUseEngine,
  streamEngineChat
} from "./engine";

const SETTINGS_KEY = "assistant:settings";
const SECRET_KEY = "assistant:provider-key";
const ERROR_LOG_KEY = "assistant:errors";

const DEFAULT_SETTINGS: AssistantSettings = {
  apiProvider: "gemini",
  provider: "openai",
  apiKey: "",
  hasApiKey: false,
  model: "gemini-2.5-flash",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  theme: "dark",
  skin: "nova",
  hotkey: "Alt+Shift+F",
  disabledSites: []
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSkinName(value: unknown): value is SkinName {
  return value === "nova" || value === "mika" || value === "orbit" || value === "echo";
}

async function loadSettings(includeSecret = false): Promise<AssistantSettings> {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, SECRET_KEY]);
  const partial = isRecord(stored[SETTINGS_KEY]) ? stored[SETTINGS_KEY] : {};
  const apiKey = typeof stored[SECRET_KEY] === "string" ? stored[SECRET_KEY] : "";
  const settings: AssistantSettings = {
    ...DEFAULT_SETTINGS,
    provider: partial.provider === "anthropic" ? "anthropic" : "openai",
    model: typeof partial.model === "string" ? partial.model : DEFAULT_SETTINGS.model,
    baseUrl: typeof partial.baseUrl === "string" ? partial.baseUrl : DEFAULT_SETTINGS.baseUrl,
    theme: partial.theme === "light" ? "light" : "dark",
    skin: isSkinName(partial.skin) ? partial.skin : "nova",
    hotkey: typeof partial.hotkey === "string" ? partial.hotkey : DEFAULT_SETTINGS.hotkey,
    disabledSites: Array.isArray(partial.disabledSites)
      ? partial.disabledSites.filter((site): site is string => typeof site === "string")
      : []
  };
  const storedApiProvider = partial.apiProvider === "gemini" || partial.apiProvider === "openrouter" || partial.apiProvider === "custom"
    ? partial.apiProvider
    : "gemini";
  const presetProvider: ProviderName = storedApiProvider === "custom" && typeof partial.provider === "string"
    ? (partial.provider === "anthropic" ? "anthropic" : "openai")
    : "openai";
  settings.apiProvider = storedApiProvider;
  settings.provider = presetProvider;
  settings.hasApiKey = Boolean(apiKey);
  settings.apiKey = includeSecret ? apiKey : "";
  return settings;
}

async function saveSettings(value: unknown): Promise<AssistantSettings> {
  if (!isRecord(value)) throw new Error("Settings payload must be an object.");
  const current = await loadSettings(true);
  const provider = value.provider === "anthropic" ? "anthropic" : value.provider === "openai" ? "openai" : current.provider;
  const apiProvider = value.apiProvider === "gemini" || value.apiProvider === "openrouter" || value.apiProvider === "custom"
    ? value.apiProvider
    : current.apiProvider;
  const theme = value.theme === "light" ? "light" : value.theme === "dark" ? "dark" : current.theme;
  const skin = isSkinName(value.skin) ? value.skin : current.skin;
  const next: AssistantSettings = {
    ...current,
    provider,
    apiProvider,
    theme,
    skin,
    model: typeof value.model === "string" && value.model.trim() ? value.model.trim() : current.model,
    baseUrl: typeof value.baseUrl === "string" && value.baseUrl.trim() ? value.baseUrl.trim() : current.baseUrl,
    hotkey: typeof value.hotkey === "string" && value.hotkey.trim() ? value.hotkey.trim() : current.hotkey,
    disabledSites: Array.isArray(value.disabledSites)
      ? value.disabledSites.filter((site): site is string => typeof site === "string").map((site) => site.trim()).filter(Boolean)
      : current.disabledSites,
    apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : current.apiKey
  };
  const parsedBaseUrl = new URL(next.baseUrl);
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new Error("Provider base URL must use HTTP or HTTPS.");
  }
  if (parsedBaseUrl.username || parsedBaseUrl.password || parsedBaseUrl.search || parsedBaseUrl.hash) {
    throw new Error("Provider base URL cannot contain credentials, query parameters, or a fragment.");
  }
  if (next.apiKey.length > 8192 || next.model.length > 200 || next.hotkey.length > 80) {
    throw new Error("A settings value exceeds the supported length.");
  }
  await chrome.storage.local.set({
    [SETTINGS_KEY]: { ...next, apiKey: "", hasApiKey: Boolean(next.apiKey) },
    [SECRET_KEY]: next.apiKey
  });
  return { ...next, hasApiKey: Boolean(next.apiKey) };
}

async function appendError(value: { message: string; stack?: string }): Promise<void> {
  const existing = await chrome.storage.local.get(ERROR_LOG_KEY);
  const errors = Array.isArray(existing[ERROR_LOG_KEY]) ? existing[ERROR_LOG_KEY] : [];
  const next = [...errors, { ...value, timestamp: Date.now() }].slice(-50);
  await chrome.storage.local.set({ [ERROR_LOG_KEY]: next });
}

function openVoicePage(): Promise<chrome.tabs.Tab> {
  return chrome.tabs.create({ url: chrome.runtime.getURL("options.html#voice") });
}

function engineSiteHost(senderUrl: string | undefined): string | undefined {
  if (!senderUrl) return undefined;
  try {
    const url = new URL(senderUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRecord(message) || typeof message.type !== "string") return;
  const privilegedTypes = [
    "assistant:settings-get",
    "assistant:settings-save",
    "assistant:site-toggle",
    "assistant:clear-data",
    "assistant:engine-status",
    "assistant:memory-list",
    "assistant:memory-create",
    "assistant:memory-update",
    "assistant:memory-delete",
    "assistant:memory-export",
    "assistant:memory-forget"
  ];
  if (privilegedTypes.includes(message.type) && !sender.url?.startsWith(chrome.runtime.getURL(""))) {
    sendResponse({ ok: false, error: "This operation is available only in Tex extension pages." });
    return true;
  }
  const respond = async (operation: () => Promise<unknown>) => {
    try {
      sendResponse({ ok: true, value: await operation() });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      sendResponse({ ok: false, error: normalized.message });
      await appendError({ message: normalized.message, stack: normalized.stack });
    }
  };

  switch (message.type) {
    case "assistant:settings-get":
      void respond(() => loadSettings(true));
      return true;
    case "assistant:settings-save":
      void respond(() => saveSettings(message.settings));
      return true;
    case "assistant:settings-open":
      void respond(async () => chrome.runtime.openOptionsPage());
      return true;
    case "assistant:engine-status":
      void respond(getEngineStatus);
      return true;
    case "assistant:memory-list":
      void respond(async () => {
        const query = new URLSearchParams();
        if (typeof message.query === "string" && message.query.trim()) query.set("query", message.query.trim());
        if (typeof message.siteHost === "string" && message.siteHost.trim()) query.set("siteHost", message.siteHost.trim());
        const suffix = query.toString();
        return requestEngineJson(`/memory${suffix ? `?${suffix}` : ""}`);
      });
      return true;
    case "assistant:memory-create":
      void respond(async () => {
        if (
          (message.kind !== "fact" && message.kind !== "site_note") ||
          typeof message.content !== "string"
        ) throw new Error("A memory kind and content are required.");
        const payload = {
          kind: message.kind,
          content: message.content,
          ...(typeof message.siteHost === "string" ? { siteHost: message.siteHost } : {})
        };
        return requestEngineJson("/memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      });
      return true;
    case "assistant:memory-update":
      void respond(async () => {
        if (typeof message.id !== "string" || !message.id) throw new Error("A memory ID is required.");
        const payload: Record<string, string> = {};
        if (typeof message.content === "string") payload.content = message.content;
        if (typeof message.siteHost === "string") payload.siteHost = message.siteHost;
        if (Object.keys(payload).length === 0) throw new Error("A memory update is required.");
        return requestEngineJson(`/memory/${encodeURIComponent(message.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      });
      return true;
    case "assistant:memory-delete":
      void respond(async () => {
        if (typeof message.id !== "string" || !message.id) throw new Error("A memory ID is required.");
        return requestEngineJson(`/memory/${encodeURIComponent(message.id)}`, { method: "DELETE" });
      });
      return true;
    case "assistant:memory-export":
      void respond(async () => requestEngineJson("/memory/export"));
      return true;
    case "assistant:memory-forget":
      void respond(async () => requestEngineJson("/memory", { method: "DELETE" }));
      return true;
    case "assistant:open-voice":
      void respond(openVoicePage);
      return true;
    case "assistant:site-toggle":
      void respond(async () => {
        if (typeof message.hostname !== "string" || !message.hostname) throw new Error("A site hostname is required.");
        const settings = await loadSettings(true);
        const disabled = new Set(settings.disabledSites);
        if (disabled.has(message.hostname)) disabled.delete(message.hostname);
        else disabled.add(message.hostname);
        return saveSettings({ ...settings, disabledSites: [...disabled] });
      });
      return true;
    case "assistant:error-log":
      void respond(async () => {
        if (!isRecord(message.error) || typeof message.error.message !== "string") throw new Error("An error message is required.");
        await appendError({
          message: message.error.message.slice(0, 1000),
          stack: typeof message.error.stack === "string" ? message.error.stack.slice(0, 5000) : undefined
        });
        return null;
      });
      return true;
    case "assistant:clear-data":
      void respond(async () => {
        await chrome.storage.local.clear();
        return null;
      });
      return true;
    default:
      return;
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "push-to-talk") {
    void openVoicePage().catch(async (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      await appendError({ message: normalized.message, stack: normalized.stack });
    });
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "assistant-stream") return;
  const controller = new AbortController();
  let connected = true;
  let started = false;
  port.onDisconnect.addListener(() => {
    connected = false;
    controller.abort();
  });

  port.onMessage.addListener((message: unknown) => {
    if (!isRecord(message) || message.type !== "assistant:stream" || started) return;
    started = true;
    void (async () => {
      try {
        const settings = await loadSettings(true);
        const isLocalOpenAI = settings.provider === "openai" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(settings.baseUrl).hostname);
        if (!Array.isArray(message.messages)) throw new Error("The conversation is invalid.");
        const conversation: LLMMessage[] = message.messages.flatMap((item): LLMMessage[] => {
          if (!isRecord(item) || (typeof item.content !== "string" && !Array.isArray(item.content))) return [];
          if (item.role !== "user" && item.role !== "assistant" && item.role !== "system") return [];
          if (typeof item.content === "string") return [{ role: item.role, content: item.content }];
          const content = item.content.flatMap((part): LLMContentPart[] => {
            if (!isRecord(part)) return [];
            if (part.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }];
            if (part.type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
              return [{ type: "image_url", image_url: { url: part.image_url.url } }];
            }
            return [];
          });
          return [{ role: item.role, content }];
        });
        if (conversation.length === 0) throw new Error("There are no messages to send.");
        const plainMessages = conversation.filter(
          (item): item is LLMMessage & { content: string } => typeof item.content === "string"
        );
        if (plainMessages.length === conversation.length) {
          const engineStatus = await getEngineStatus();
          if (shouldUseEngine(engineStatus, true)) {
            try {
              await streamEngineChat(
                {
                  ...(typeof message.conversationId === "string" && message.conversationId
                    ? { conversationId: message.conversationId }
                    : {}),
                  siteHost: engineSiteHost(port.sender?.url),
                  messages: plainMessages.map(({ role, content }) => ({ role, content }))
                },
                controller.signal,
                (text) => {
                  if (connected) port.postMessage({ type: "chunk", text });
                }
              );
              if (connected) port.postMessage({ type: "done" });
              return;
            } catch (error) {
              if (controller.signal.aborted) return;
              if (!isEngineUnavailable(error)) throw error;
            }
          }
        }
        if (!settings.apiKey && !isLocalOpenAI) {
          throw new Error(plainMessages.length !== conversation.length
            ? "Image attachments require an extension provider key; the local engine currently accepts text-only chat."
            : "No provider is configured in the local engine or extension Settings.");
        }
        const provider = createProvider(settings.provider);
        for await (const text of provider.stream(conversation, {
          apiKey: settings.apiKey,
          model: settings.model,
          baseUrl: settings.baseUrl,
          maxOutputTokens: MAX_CHAT_OUTPUT_TOKENS,
          signal: controller.signal
        })) {
          if (connected) port.postMessage({ type: "chunk", text });
        }
        if (connected) port.postMessage({ type: "done" });
      } catch (error) {
        if (controller.signal.aborted) return;
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (connected) port.postMessage({ type: "error", error: normalized.message });
        await appendError({ message: normalized.message, stack: normalized.stack });
      }
    })();
  });
});
