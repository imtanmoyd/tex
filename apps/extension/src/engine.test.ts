import { describe, expect, it, vi } from "vitest";
import {
  EngineRequestError,
  EngineUnavailableError,
  getEngineStatus,
  isEngineUnavailable,
  shouldUseEngine,
  streamEngineChat
} from "./engine";

const TOKEN = "startup-token-that-is-long-enough-to-be-valid";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("local engine bridge", () => {
  it("bootstraps a fresh token and reports configured providers without caching secrets", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: TOKEN }))
      .mockResolvedValueOnce(jsonResponse({
        providers: [
          { name: "openrouter", configured: true },
          { name: "ollama", configured: false }
        ]
      }));

    const status = await getEngineStatus(fetcher);

    expect(status).toEqual({
      connected: true,
      configured: true,
      providers: ["openrouter"],
      message: "Local engine connected (openrouter)."
    });
    expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:8765/bootstrap");
    expect(fetcher.mock.calls[1][0]).toBe("http://127.0.0.1:8765/providers/status");
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("X-Tex-Token")).toBe(TOKEN);
  });

  it("reports an offline engine so the caller can stay in extension mode", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));

    await expect(getEngineStatus(fetcher)).resolves.toMatchObject({
      connected: false,
      configured: false,
      message: "The local engine is not reachable."
    });
  });

  it("translates SSE tokens and posts the per-process token only in a header", async () => {
    const sse = [
      'event: meta\ndata: {"provider":"groq","model":"test-model","conversationId":"chat-1"}',
      'event: token\ndata: {"text":"Hello"}',
      'event: done\ndata: {}',
      ""
    ].join("\n\n");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: TOKEN }))
      .mockResolvedValueOnce(new Response(sse, {
        headers: { "Content-Type": "text/event-stream" }
      }));
    const chunks: string[] = [];

    await streamEngineChat(
      {
        conversationId: "chat-1",
        siteHost: "example.com",
        messages: [{ role: "user", content: "Hi" }]
      },
      new AbortController().signal,
      (chunk) => chunks.push(chunk),
      fetcher
    );

    expect(chunks).toEqual(["Hello"]);
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("X-Tex-Token")).toBe(TOKEN);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      conversationId: "chat-1",
      siteHost: "example.com",
      messages: [{ role: "user", content: "Hi" }]
    });
  });

  it("falls back only for engine availability failures", () => {
    expect(isEngineUnavailable(new EngineUnavailableError("offline"))).toBe(true);
    expect(isEngineUnavailable(new EngineRequestError("unavailable", 503))).toBe(true);
    expect(isEngineUnavailable(new EngineRequestError("invalid request", 400))).toBe(false);
  });

  it("uses the engine only when connected, configured, and the request is text-only", () => {
    const status = {
      connected: true,
      configured: true,
      providers: ["groq"],
      message: "ready"
    };

    expect(shouldUseEngine(status, true)).toBe(true);
    expect(shouldUseEngine({ ...status, configured: false }, true)).toBe(false);
    expect(shouldUseEngine({ ...status, connected: false }, true)).toBe(false);
    expect(shouldUseEngine(status, false)).toBe(false);
  });
});
