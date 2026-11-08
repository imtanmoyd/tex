const ENGINE_BASE_URL = "http://127.0.0.1:8765";

type JsonObject = Record<string, unknown>;
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface EngineStatus {
  connected: boolean;
  configured: boolean;
  providers: string[];
  message: string;
}

export interface EngineChatRequest {
  conversationId?: string;
  siteHost?: string;
  messages: Array<{ role: string; content: string }>;
}

export class EngineRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "EngineRequestError";
  }
}

export class EngineStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineStreamError";
  }
}

export class EngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

interface EngineEvent {
  event: string;
  data: JsonObject;
}

export async function getEngineStatus(fetcher: Fetcher = fetch): Promise<EngineStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetchAuthenticated(
      "/providers/status",
      { method: "GET" },
      controller.signal,
      fetcher
    );
    if (!response.ok) throw await responseError(response);
    const body = await response.json() as { providers?: unknown };
    if (!Array.isArray(body.providers)) {
      throw new EngineStreamError("The local engine returned an invalid provider status.");
    }
    const providers = body.providers.flatMap((provider) => {
      if (!isRecord(provider) || typeof provider.name !== "string" || provider.configured !== true) return [];
      return [provider.name];
    });
    const configured = providers.length > 0;
    return {
      connected: true,
      configured,
      providers,
      message: configured
        ? `Local engine connected (${providers.join(", ")}).`
        : "Local engine connected; no provider is configured, so extension mode remains active."
    };
  } catch (error) {
    return {
      connected: false,
      configured: false,
      providers: [],
      message: errorMessage(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestEngineJson(
  path: string,
  init: RequestInit = {},
  fetcher: Fetcher = fetch
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchAuthenticated(path, init, controller.signal, fetcher);
    if (!response.ok) throw await responseError(response);
    if (response.status === 204) return null;
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function isEngineUnavailable(error: unknown): boolean {
  if (error instanceof EngineUnavailableError) return true;
  return error instanceof EngineRequestError
    && [401, 403, 503].includes(error.statusCode);
}

export function shouldUseEngine(status: EngineStatus, textOnly: boolean): boolean {
  return status.connected && status.configured && textOnly;
}

export async function streamEngineChat(
  payload: EngineChatRequest,
  signal: AbortSignal,
  onChunk: (text: string) => void,
  fetcher: Fetcher = fetch
): Promise<void> {
  const response = await fetchAuthenticated(
    "/chat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    },
    signal,
    fetcher
  );
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new EngineStreamError("The local engine returned no chat stream.");

  let completed = false;
  try {
    for await (const event of readEvents(response.body, signal)) {
      if (event.event === "token" && typeof event.data.text === "string") {
        onChunk(event.data.text);
      } else if (event.event === "error") {
        throw new EngineStreamError(
          typeof event.data.error === "string"
            ? event.data.error
            : "The local engine could not complete the request."
        );
      } else if (event.event === "done") {
        completed = true;
        return;
      }
    }
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof EngineStreamError) throw error;
    throw new EngineStreamError(errorMessage(error));
  }
  if (!completed) throw new EngineStreamError("The local engine stream closed unexpectedly.");
}

async function fetchAuthenticated(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
  fetcher: Fetcher
): Promise<Response> {
  const token = await getStartupToken(signal, fetcher);
  const headers = new Headers(init.headers);
  headers.set("X-Tex-Token", token);
  try {
    return await fetcher(`${ENGINE_BASE_URL}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof TypeError) {
      throw new EngineUnavailableError("The local engine is not reachable.");
    }
    throw error;
  }
}

async function getStartupToken(signal: AbortSignal, fetcher: Fetcher): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(`${ENGINE_BASE_URL}/bootstrap`, {
      method: "GET",
      cache: "no-store",
      signal
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof TypeError) {
      throw new EngineUnavailableError("The local engine is not reachable.");
    }
    throw error;
  }
  if (!response.ok) throw await responseError(response);
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.token !== "string" || body.token.length < 32) {
    throw new EngineStreamError("The local engine returned an invalid startup token.");
  }
  return body.token;
}

async function responseError(response: Response): Promise<EngineRequestError> {
  if (response.status === 403) {
    return new EngineRequestError(
      "The local engine rejected this extension origin. Check TEX_EXTENSION_ID.",
      response.status
    );
  }
  return new EngineRequestError(
    `The local engine request failed (${response.status}).`,
    response.status
  );
}

async function* readEvents(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<EngineEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let finished = false;

  const dispatch = (): EngineEvent | null => {
    if (data.length === 0) {
      event = "message";
      return null;
    }
    const value: unknown = JSON.parse(data.join("\n"));
    if (!isRecord(value)) throw new EngineStreamError("The local engine sent malformed SSE data.");
    const result = { event, data: value };
    event = "message";
    data = [];
    return result;
  };

  try {
    while (true) {
      if (signal.aborted) throw new DOMException("The response was stopped.", "AbortError");
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) {
          const parsed = dispatch();
          if (parsed) yield parsed;
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim() || "message";
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).trimStart());
        }
      }
      if (done) {
        finished = true;
        if (buffer) {
          if (buffer.startsWith("event:")) event = buffer.slice(6).trim() || "message";
          else if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
        }
        const parsed = dispatch();
        if (parsed) yield parsed;
        return;
      }
    }
  } finally {
    if (!finished) await reader.cancel();
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  if (error instanceof EngineRequestError || error instanceof EngineUnavailableError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "The local engine check timed out.";
  return error instanceof Error ? error.message : String(error);
}
