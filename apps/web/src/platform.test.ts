import { afterEach, describe, expect, it, vi } from "vitest";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web platform chat", () => {
  it("isolates browser chat data by signed-in account", async () => {
    const localStorage = new MemoryStorage();
    vi.stubGlobal("localStorage", localStorage);
    const { setWebAccountNamespace, webPlatform } = await import("./platform");
    const legacyThreads = [{ id: "legacy" }];
    localStorage.setItem("tex.web.assistant:threads", JSON.stringify(legacyThreads));

    setWebAccountNamespace("alice");
    expect(await webPlatform.storage.get("assistant:threads")).toEqual(legacyThreads);
    await webPlatform.storage.set("assistant:threads", [{ id: "alice" }]);
    await webPlatform.storage.set("assistant:position", { x: 1, y: 2 });

    setWebAccountNamespace("bob");
    expect(await webPlatform.storage.get("assistant:threads")).toBeUndefined();
    expect(await webPlatform.storage.get("assistant:position")).toEqual({ x: 1, y: 2 });
    await webPlatform.storage.set("assistant:threads", [{ id: "bob" }]);
    await webPlatform.storage.clear();
    expect(await webPlatform.storage.get("assistant:threads")).toBeUndefined();

    setWebAccountNamespace("alice");
    expect(await webPlatform.storage.get("assistant:threads")).toEqual([{ id: "alice" }]);
    setWebAccountNamespace(null);
  });

  it("streams concise chat directly to the configured provider and persists settings locally", async () => {
    const localStorage = new MemoryStorage();
    vi.stubGlobal("localStorage", localStorage);
    const chunks: string[] = [];
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
        max_tokens: number;
      };
      expect(request.messages[0].role).toBe("system");
      expect(request.messages[0].content).toContain("one to three short sentences");
      expect(request.max_tokens).toBe(512);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hey there!"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { webPlatform } = await import("./platform");
    const settings = {
      apiProvider: "custom" as const,
      provider: "openai" as const,
      apiKey: "test-provider-key",
      model: "test-model",
      baseUrl: "https://api.example.test/v1",
      theme: "dark" as const,
      skin: "nova" as const,
      hotkey: "Alt+Shift+F",
      disabledSites: []
    };
    await webPlatform.storage.set("assistant:settings", settings);

    await new Promise<void>((resolve, reject) => {
      webPlatform.messaging.stream({
        type: "assistant:stream",
        messages: [{ role: "user", content: "I had a hard day." }]
      }, {
        onChunk: (text) => chunks.push(text),
        onDone: resolve,
        onError: reject
      });
    });

    expect(await webPlatform.storage.get("assistant:settings")).toEqual(settings);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-provider-key" })
      })
    );
    expect(chunks.join("")).toBe("Hey there!");
  });
});
