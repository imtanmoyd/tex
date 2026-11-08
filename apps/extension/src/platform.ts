import type {
  ExtensionMessage,
  HotkeyAdapter,
  MessagingAdapter,
  PlatformAdapter,
  StorageAdapter
} from "@tex/core";

class ChromeStorageAdapter implements StorageAdapter {
  async get<T>(key: string): Promise<T | undefined> {
    const values = await chrome.storage.local.get(key);
    return values[key] as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  }

  async remove(keys: string | string[]): Promise<void> {
    await chrome.storage.local.remove(keys);
  }

  async clear(): Promise<void> {
    await chrome.storage.local.clear();
  }

  watch<T>(key: string, listener: (value: T | undefined) => void): () => void {
    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === "local" && Object.hasOwn(changes, key)) listener(changes[key].newValue as T | undefined);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }
}

interface StreamPortMessage {
  type: "chunk" | "done" | "error";
  text?: string;
  error?: string;
}

class ChromeMessagingAdapter implements MessagingAdapter {
  send<TResponse>(message: ExtensionMessage): Promise<TResponse> {
    return chrome.runtime.sendMessage(message) as Promise<TResponse>;
  }

  stream(
    message: ExtensionMessage,
    handlers: {
      onChunk: (text: string) => void;
      onDone: () => void;
      onError: (error: Error) => void;
    }
  ): () => void {
    const port = chrome.runtime.connect({ name: "assistant-stream" });
    let finished = false;
    port.onMessage.addListener((response: StreamPortMessage) => {
      if (response.type === "chunk" && response.text) handlers.onChunk(response.text);
      if (response.type === "done") {
        finished = true;
        handlers.onDone();
        port.disconnect();
      }
      if (response.type === "error") {
        finished = true;
        handlers.onError(new Error(response.error || "The assistant request failed."));
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      if (finished) return;
      finished = true;
      const reason = chrome.runtime.lastError?.message;
      handlers.onError(new Error(reason || "The assistant connection closed unexpectedly."));
    });
    port.postMessage(message);
    return () => {
      if (finished) return;
      finished = true;
      port.postMessage({ type: "assistant:stream-cancel" });
      port.disconnect();
    };
  }
}

class ChromeHotkeyAdapter implements HotkeyAdapter {
  onPushToTalk(handler: () => void, shortcut = "Alt+Shift+F"): () => void {
    const keys = shortcut.toLowerCase().split("+").map((key) => {
      const normalized = key.trim();
      if (normalized === "control") return "ctrl";
      if (normalized === "command" || normalized === "cmd") return "meta";
      return normalized;
    });
    const key = keys[keys.length - 1];
    const listener = (event: KeyboardEvent) => {
      const modifiersMatch =
        event.altKey === keys.includes("alt") &&
        event.ctrlKey === keys.includes("ctrl") &&
        event.metaKey === keys.includes("meta") &&
        event.shiftKey === keys.includes("shift");
      if (event.key.toLowerCase() !== key || !modifiersMatch || event.repeat) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }
}

export const extensionPlatform: PlatformAdapter = {
  storage: new ChromeStorageAdapter(),
  messaging: new ChromeMessagingAdapter(),
  hotkeys: new ChromeHotkeyAdapter()
};
