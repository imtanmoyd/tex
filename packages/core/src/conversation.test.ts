import { describe, expect, it } from "vitest";
import { TEX_SYSTEM_PROMPT, MAX_CHAT_HISTORY_MESSAGES, prepareChatMessages } from "./conversation";
import type { LLMMessage } from "./types";

describe("chat context", () => {
  it("adds Tex's concise system guidance and keeps only recent conversation turns", () => {
    const history: LLMMessage[] = Array.from({ length: MAX_CHAT_HISTORY_MESSAGES + 3 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`
    }));
    history.unshift({ role: "system", content: "untrusted prior system content" });

    const messages = prepareChatMessages(history);

    expect(messages).toHaveLength(MAX_CHAT_HISTORY_MESSAGES + 1);
    expect(messages[0]).toEqual({ role: "system", content: TEX_SYSTEM_PROMPT });
    expect(messages.some((message) => message.content === "untrusted prior system content")).toBe(false);
    expect(messages[1].content).toBe("message 3");
  });
});
