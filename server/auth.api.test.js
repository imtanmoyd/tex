import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import login from "../api/auth/login.js";
import logout from "../api/auth/logout.js";
import register from "../api/auth/register.js";
import resetConfirm from "../api/auth/reset-confirm.js";
import resetRequest from "../api/auth/reset-request.js";
import session from "../api/auth/session.js";

const database = new Map();
let emailedCode = "";

function responseMock() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    }
  };
}

function request(path, body, headers = {}) {
  return {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    body
  };
}

async function mockFetch(input, init) {
  const url = new URL(String(input));
  if (url.hostname === "redis.test") {
    const command = JSON.parse(init.body);
    const [operation, ...args] = command;
    let result;
    if (operation === "EVAL") {
      const [script, keyCountValue, ...rest] = args;
      const keyCount = Number(keyCountValue);
      const keys = rest.slice(0, keyCount);
      const values = rest.slice(keyCount);
      if (script.includes("redis.call('INCR'")) {
        const key = keys[0];
        const count = Number(database.get(key) || 0) + 1;
        database.set(key, count);
        result = count;
      } else if (script.includes("redis.call('EXISTS', KEYS[1])")) {
        if (database.has(keys[0]) || database.has(keys[1])) {
          result = 0;
        } else {
          database.set(keys[0], values[0]);
          database.set(keys[1], values[0]);
          database.set(keys[2], values[1]);
          result = 1;
        }
      } else {
        const entry = JSON.parse(database.get(keys[0]) || "null");
        const now = Number(values[0]);
        const user = JSON.parse(database.get(keys[1]) || "null");
        if (!entry || entry.expiresAt <= now || entry.hash !== values[1] || !user) {
          result = 0;
        } else {
          user.passwordSalt = values[2];
          user.passwordHash = values[3];
          user.sessionVersion = (user.sessionVersion || 0) + 1;
          database.set(keys[1], JSON.stringify(user));
          database.delete(keys[0]);
          result = 1;
        }
      }
    } else if (operation === "GET") {
      result = database.get(args[0]) ?? null;
    } else if (operation === "SET") {
      database.set(args[0], args[1]);
      result = "OK";
    } else if (operation === "DEL") {
      result = database.delete(args[0]) ? 1 : 0;
    } else {
      throw new Error(`Unexpected Redis command: ${operation}`);
    }
    return new Response(JSON.stringify({ result }), { status: 200 });
  }

  if (url.hostname === "api.resend.com") {
    const message = JSON.parse(init.body);
    emailedCode = message.text.match(/\b\d{6}\b/)?.[0] || "";
    return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
  }
  throw new Error(`Unexpected request: ${url.hostname}`);
}

beforeEach(() => {
  database.clear();
  emailedCode = "";
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.test");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
  vi.stubEnv("TEX_JWT_SECRET", "test-signing-secret-that-is-at-least-32-characters");
  vi.stubEnv("RESEND_API_KEY", "test-email-token");
  vi.stubEnv("TEX_AUTH_FROM_EMAIL", "Tex <no-reply@example.com>");
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("web auth routes", () => {
  it("registers, signs in with an HttpOnly cookie, restores the session, and signs out", async () => {
    const registration = responseMock();
    await register(request("register", {
      username: "Tex_User",
      email: "TEX@example.com",
      password: "a-very-long-password"
    }), registration);

    expect(registration.statusCode).toBe(201);
    expect(registration.body.user).toEqual({ username: "tex_user", email: "tex@example.com" });

    const loginResponse = responseMock();
    await login(request("login", { username: "tex_user", password: "a-very-long-password" }), loginResponse);
    expect(loginResponse.statusCode).toBe(200);
    expect(loginResponse.body.token).toBeUndefined();
    const cookie = loginResponse.headers["Set-Cookie"];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const sessionResponse = responseMock();
    await session(request("session", undefined, { cookie: cookie.split(";")[0] }), sessionResponse);
    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.body.user.username).toBe("tex_user");

    const logoutResponse = responseMock();
    await logout(request("logout", {}), logoutResponse);
    expect(logoutResponse.statusCode).toBe(200);
    expect(logoutResponse.headers["Set-Cookie"]).toContain("Max-Age=0");
  });

  it("sends a one-time email code, resets the password atomically, and rejects code reuse", async () => {
    const registration = responseMock();
    await register(request("register", {
      username: "tex_user",
      email: "tex@example.com",
      password: "old-long-password"
    }), registration);
    expect(registration.statusCode).toBe(201);
    const signedInBeforeReset = responseMock();
    await login(request("login", { username: "tex_user", password: "old-long-password" }), signedInBeforeReset);
    const cookieBeforeReset = signedInBeforeReset.headers["Set-Cookie"].split(";")[0];

    const resetRequestResponse = responseMock();
    await resetRequest(request("reset-request", { email: "TEX@example.com" }), resetRequestResponse);
    expect(resetRequestResponse.statusCode).toBe(202);
    expect(resetRequestResponse.body).toEqual({ sent: true });
    expect(emailedCode).toMatch(/^\d{6}$/);

    const resetResponse = responseMock();
    await resetConfirm(request("reset-confirm", {
      email: "tex@example.com",
      code: emailedCode,
      password: "new-long-password"
    }), resetResponse);
    expect(resetResponse.statusCode).toBe(200);

    const oldSessionResponse = responseMock();
    await session(request("session", undefined, { cookie: cookieBeforeReset }), oldSessionResponse);
    expect(oldSessionResponse.statusCode).toBe(401);

    const reusedCodeResponse = responseMock();
    await resetConfirm(request("reset-confirm", {
      email: "tex@example.com",
      code: emailedCode,
      password: "another-long-password"
    }), reusedCodeResponse);
    expect(reusedCodeResponse.statusCode).toBe(400);

    const oldPasswordResponse = responseMock();
    await login(request("login", { username: "tex_user", password: "old-long-password" }), oldPasswordResponse);
    expect(oldPasswordResponse.statusCode).toBe(401);

    const newPasswordResponse = responseMock();
    await login(request("login", { username: "tex_user", password: "new-long-password" }), newPasswordResponse);
    expect(newPasswordResponse.statusCode).toBe(200);
  });

  it("refuses registration until durable auth settings are configured", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = responseMock();
    await register(request("register", {
      username: "tex_user",
      email: "tex@example.com",
      password: "a-very-long-password"
    }), result);
    expect(result.statusCode).toBe(503);
    expect(result.body.error).toContain("temporarily unavailable");
    expect(log).toHaveBeenCalledOnce();
  });
});
