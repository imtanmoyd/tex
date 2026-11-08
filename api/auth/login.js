import {
  authError,
  createSessionToken,
  findUserByUsername,
  getAuthConfig,
  normalizeUsername,
  publicUser,
  rateLimit,
  readRequestJson,
  requestAddress,
  serviceRateLimit,
  setSessionCookie,
  validUsername,
  verifyPassword
} from "../../server/auth.js";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.status(405).json({ error: "Use POST." });
    return;
  }

  let body;
  try {
    body = await readRequestJson(request);
  } catch {
    response.status(400).json({ error: "Invalid request body." });
    return;
  }

  const username = normalizeUsername(body?.username);
  const password = body?.password;
  if (!validUsername(username) || typeof password !== "string" || password.length > 128) {
    response.status(400).json({ error: "Enter a valid username and password." });
    return;
  }

  try {
    const ip = requestAddress(request);
    if (!await rateLimit(`tex:rate:login:ip:${ip}`, 30, 900)
      || !await rateLimit(`tex:rate:login:user:${username}`, 10, 900)) {
      serviceRateLimit(response);
      return;
    }

    const user = await findUserByUsername(username);
    const valid = user
      ? await verifyPassword(password, user.passwordSalt, user.passwordHash)
      : await verifyPassword(password, "0".repeat(32), "0".repeat(128));
    if (!user || !valid) {
      response.status(401).json({ error: "Invalid username or password." });
      return;
    }

    const { jwtSecret } = getAuthConfig();
    const session = createSessionToken(user, jwtSecret);
    setSessionCookie(response, session.token);
    response.status(200).json({ user: publicUser(user), expiresAt: session.expiresAt });
  } catch (error) {
    authError(response, error, "Sign in is temporarily unavailable.");
  }
}
