import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const AUTH_PREFIX = "tex:auth:";
const SESSION_COOKIE = "tex_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function getAuthConfig() {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, TEX_JWT_SECRET } = process.env;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN || !TEX_JWT_SECRET || TEX_JWT_SECRET.length < 32) {
    throw new Error("Auth storage and signing secrets are not configured.");
  }
  return {
    redisUrl: UPSTASH_REDIS_REST_URL.replace(/\/+$/, ""),
    redisToken: UPSTASH_REDIS_REST_TOKEN,
    jwtSecret: TEX_JWT_SECRET
  };
}

export async function readRequestJson(request) {
  if (typeof request.json === "function") return request.json();
  if (typeof request.body === "string") return JSON.parse(request.body);
  if (request.body && typeof request.body === "object") return request.body;
  throw new Error("Request body is not JSON.");
}

export function requestHeader(request, name) {
  const headers = request.headers;
  if (typeof headers?.get === "function") return headers.get(name);
  const value = headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : null;
}

export async function redisCommand(...command) {
  const { redisUrl, redisToken } = getAuthConfig();
  const response = await fetch(redisUrl, {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
    headers: {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    console.error("Tex auth datastore returned an invalid response", response.status);
    throw new Error("The auth datastore returned an invalid response.");
  }
  if (!response.ok || payload.error) {
    console.error("Tex auth datastore request failed", response.status);
    throw new Error("The auth datastore request failed.");
  }
  return payload.result;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function authKey(type, value) {
  return `${AUTH_PREFIX}${type}:${digest(value)}`;
}

export function normalizeUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function validUsername(value) {
  return /^[a-z0-9_-]{3,30}$/.test(value);
}

export function validEmail(value) {
  return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

export async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = await scrypt(password, salt, 64, { N: 2 ** 15, maxmem: 64 * 1024 * 1024 });
  return { salt, hash: Buffer.from(hash).toString("hex") };
}

export async function verifyPassword(password, salt, expectedHash) {
  const { hash } = await hashPassword(password, salt);
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(hash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function findUserByUsername(username) {
  const id = await redisCommand("GET", authKey("username", username));
  if (typeof id !== "string") return null;
  const user = await redisCommand("GET", `${AUTH_PREFIX}user:${id}`);
  return typeof user === "string" ? JSON.parse(user) : null;
}

export async function findUserByEmail(email) {
  const id = await redisCommand("GET", authKey("email", email));
  if (typeof id !== "string") return null;
  const user = await redisCommand("GET", `${AUTH_PREFIX}user:${id}`);
  return typeof user === "string" ? JSON.parse(user) : null;
}

export async function createUser(user) {
  const script = [
    "if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then",
    "  return 0",
    "end",
    "redis.call('SET', KEYS[1], ARGV[1])",
    "redis.call('SET', KEYS[2], ARGV[1])",
    "redis.call('SET', KEYS[3], ARGV[2])",
    "return 1"
  ].join("\n");
  return Number(await redisCommand(
    "EVAL",
    script,
    "3",
    authKey("username", user.username),
    authKey("email", user.email),
    `${AUTH_PREFIX}user:${user.id}`,
    user.id,
    JSON.stringify(user)
  )) === 1;
}

export async function resetUserPassword(user, candidateHash, salt, hash, now = Date.now()) {
  const script = [
    "local raw = redis.call('GET', KEYS[1])",
    "if not raw then return 0 end",
    "local entry = cjson.decode(raw)",
    "if entry.expiresAt <= tonumber(ARGV[1]) or entry.hash ~= ARGV[2] then return 0 end",
    "local userRaw = redis.call('GET', KEYS[2])",
    "if not userRaw then return 0 end",
    "local account = cjson.decode(userRaw)",
    "account.passwordSalt = ARGV[3]",
    "account.passwordHash = ARGV[4]",
    "account.sessionVersion = (account.sessionVersion or 0) + 1",
    "redis.call('SET', KEYS[2], cjson.encode(account))",
    "redis.call('DEL', KEYS[1])",
    "return 1"
  ].join("\n");
  return Number(await redisCommand(
    "EVAL",
    script,
    "2",
    authKey("reset", user.email),
    `${AUTH_PREFIX}user:${user.id}`,
    String(now),
    candidateHash,
    salt,
    hash
  )) === 1;
}

export function newResetCode() {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashResetCode(email, code) {
  const { jwtSecret } = getAuthConfig();
  return createHmac("sha256", jwtSecret).update(`${email}:${code}`).digest("hex");
}

export function createSessionToken(user, secret, now = Date.now()) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    sub: user.id,
    username: user.username,
    email: user.email,
    ver: user.sessionVersion || 0,
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS
  });
  const input = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(input).digest("base64url");
  return { token: `${input}.${signature}`, expiresAt: now + SESSION_TTL_SECONDS * 1000 };
}

export function verifySessionToken(token, secret, now = Date.now()) {
  const [header, payload, signature, extra] = token.split(".");
  if (!header || !payload || !signature || extra) return null;
  const input = `${header}.${payload}`;
  const expected = createHmac("sha256", secret).update(input).digest();
  let actual;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const metadata = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    if (metadata.alg !== "HS256" || metadata.typ !== "JWT") return null;
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof body.sub !== "string" || typeof body.exp !== "number" || body.exp <= Math.floor(now / 1000)
      || typeof body.ver !== "number") return null;
    return body;
  } catch {
    return null;
  }
}

export function getSessionToken(request) {
  const cookie = requestHeader(request, "cookie") || "";
  const value = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!value) return null;
  try {
    return decodeURIComponent(value.slice(SESSION_COOKIE.length + 1));
  } catch {
    return null;
  }
}

export function setSessionCookie(response, token) {
  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=${token ? SESSION_TTL_SECONDS : 0}${secure ? "; Secure" : ""}`
  );
}

export function publicUser(user) {
  return { username: user.username, email: user.email };
}

export function newUserId() {
  return randomUUID();
}

export function newResetEntry(hash) {
  return {
    hash,
    expiresAt: Date.now() + 15 * 60 * 1000
  };
}

export async function rateLimit(key, limit, seconds) {
  const script = [
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "return count"
  ].join("\n");
  const count = Number(await redisCommand("EVAL", script, "1", key, String(seconds)));
  return count <= limit;
}

export function requestAddress(request) {
  const forwarded = requestHeader(request, "x-forwarded-for");
  const value = forwarded?.split(",").map((part) => part.trim()).filter(Boolean).at(-1);
  return value || requestHeader(request, "x-real-ip") || "unknown";
}

export async function sendResetEmail(email, code) {
  const { RESEND_API_KEY, TEX_AUTH_FROM_EMAIL } = process.env;
  if (!RESEND_API_KEY || !TEX_AUTH_FROM_EMAIL) {
    throw new Error("Password reset email is not configured for this deployment.");
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: TEX_AUTH_FROM_EMAIL,
      to: [email],
      subject: "Your Tex password reset code",
      text: `Your Tex password reset code is ${code}. It expires in 15 minutes. If you did not request this, you can ignore this email.`
    })
  });
  if (!response.ok) {
    console.error("Tex password reset email delivery failed", response.status);
    throw new Error("The password reset email could not be delivered.");
  }
}

export function hasResetEmailConfig() {
  return Boolean(process.env.RESEND_API_KEY && process.env.TEX_AUTH_FROM_EMAIL);
}

export function authError(response, error, fallback) {
  console.error(fallback, error instanceof Error ? error.name : "Unknown error");
  response.status(503).json({ error: fallback });
}

export function serviceRateLimit(response) {
  response.status(429).json({ error: "Too many attempts. Please wait a few minutes and try again." });
}

export function sessionTtlSeconds() {
  return SESSION_TTL_SECONDS;
}
