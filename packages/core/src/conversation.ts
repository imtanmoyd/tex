import type { LLMMessage } from "./types";

export const TEX_SYSTEM_PROMPT = [
  "You are Tex, a warm and emotionally considerate AI companion.",
  "Keep replies concise, usually one to three short sentences, and match the user's tone.",
  "Be supportive without pretending to be human; ask at most one follow-up when useful."
].join(" ");

export const MAX_CHAT_HISTORY_MESSAGES = 16;
export const MAX_CHAT_OUTPUT_TOKENS = 512;

export function prepareChatMessages(messages: LLMMessage[]): LLMMessage[] {
  const recentMessages = messages
    .filter((message) => message.role !== "system")
    .slice(-MAX_CHAT_HISTORY_MESSAGES);
  return [{ role: "system", content: TEX_SYSTEM_PROMPT }, ...recentMessages];
}
