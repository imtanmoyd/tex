import { createStore, type StoreApi } from "zustand/vanilla";

const API_BASE = "/api/auth";

export interface AuthUser {
  username: string;
  email: string;
}

export interface AuthSession {
  user: AuthUser;
  expiresAt: number;
}

export interface AuthState {
  session: AuthSession | null;
  loading: boolean;
  error: string | null;
  isAuthenticated: boolean;
  initialize: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  resetPassword: (email: string, code: string, password: string) => Promise<void>;
  clearError: () => void;
}

async function apiRequest(path: string, body?: unknown): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) throw new Error(`The auth server replied with an empty response (${response.status}).`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`The auth server replied with an invalid response (${response.status}).`);
  }
}

async function readError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = await parseJson<{ error?: string }>(response);
    return new Error(body.error || fallback);
  } catch (error) {
    return error instanceof Error ? error : new Error(fallback);
  }
}

export function createAuthStore(): StoreApi<AuthState> {
  return createStore<AuthState>((set) => ({
    session: null,
    loading: true,
    error: null,
    isAuthenticated: false,

    async initialize() {
      try {
        const response = await apiRequest("/session");
        if (response.status === 401) {
          set({ session: null, loading: false, error: null, isAuthenticated: false });
          return;
        }
        if (!response.ok) throw await readError(response, "Session check failed.");
        const session = await parseJson<AuthSession>(response);
        set({ session, loading: false, error: null, isAuthenticated: true });
      } catch (error) {
        set({
          session: null,
          loading: false,
          error: error instanceof Error ? error.message : "Session check failed.",
          isAuthenticated: false
        });
      }
    },

    async login(username: string, password: string) {
      set({ loading: true, error: null });
      try {
        const response = await apiRequest("/login", { username, password });
        if (!response.ok) throw await readError(response, "Sign in failed.");
        const session = await parseJson<AuthSession>(response);
        set({ session, loading: false, error: null, isAuthenticated: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Sign in failed.";
        set({ loading: false, error: message });
        throw error instanceof Error ? error : new Error(message);
      }
    },

    async register(username: string, email: string, password: string) {
      set({ loading: true, error: null });
      try {
        const response = await apiRequest("/register", { username, email, password });
        if (!response.ok) throw await readError(response, "Sign up failed.");
        await parseJson<{ user: AuthUser }>(response);
        set({ loading: false, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Sign up failed.";
        set({ loading: false, error: message });
        throw error instanceof Error ? error : new Error(message);
      }
    },

    async logout() {
      set({ loading: true, error: null });
      try {
        const response = await apiRequest("/logout", {});
        if (!response.ok) throw await readError(response, "Sign out failed.");
        set({ session: null, loading: false, error: null, isAuthenticated: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Sign out failed.";
        set({ session: null, loading: false, error: message, isAuthenticated: false });
        throw error instanceof Error ? error : new Error(message);
      }
    },

    async requestPasswordReset(email: string) {
      set({ loading: true, error: null });
      try {
        const response = await apiRequest("/reset-request", { email });
        const body = await parseJson<{ sent?: boolean; error?: string }>(response);
        if (!response.ok || !body.sent) throw new Error(body.error || "Could not send a reset code.");
        set({ loading: false, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Reset request failed.";
        set({ loading: false, error: message });
        throw error instanceof Error ? error : new Error(message);
      }
    },

    async resetPassword(email: string, code: string, password: string) {
      set({ loading: true, error: null });
      try {
        const response = await apiRequest("/reset-confirm", { email, code, password });
        if (!response.ok) throw await readError(response, "Password reset failed.");
        await parseJson<{ ok: boolean }>(response);
        set({ loading: false, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Password reset failed.";
        set({ loading: false, error: message });
        throw error instanceof Error ? error : new Error(message);
      }
    },

    clearError() {
      set({ error: null });
    }
  }));
}
