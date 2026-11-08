export type AssistantState = "idle" | "hover" | "listening" | "thinking" | "speaking" | "sleeping" | "notification";
export type ThemeName = "dark" | "light";
export type ProviderName = "openai" | "anthropic";
export type ApiProvider = "gemini" | "openrouter" | "custom";
export type SkinName = "nova" | "mika" | "orbit" | "echo";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status?: "streaming" | "error";
}

export interface ChatThread {
  id: string;
  title: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface WidgetPosition {
  x: number;
  y: number;
}

export interface AssistantSettings {
  apiProvider: ApiProvider;
  provider: ProviderName;
  apiKey: string;
  hasApiKey?: boolean;
  model: string;
  baseUrl: string;
  theme: ThemeName;
  skin: SkinName;
  hotkey: string;
  disabledSites: string[];
}

export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string | LLMContentPart[];
}

export interface StreamOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}
