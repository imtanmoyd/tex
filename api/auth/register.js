import {
  authError,
  createUser,
  hashPassword,
  newUserId,
  normalizeEmail,
  normalizeUsername,
  publicUser,
  rateLimit,
  readRequestJson,
  requestAddress,
  serviceRateLimit,
  validEmail,
  validUsername
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
  const email = normalizeEmail(body?.email);
  const password = body?.password;
  if (!validUsername(username)) {
    response.status(400).json({ error: "Username must be 3–30 characters (lowercase letters, numbers, -, _)." });
    return;
  }
  if (!validEmail(email)) {
    response.status(400).json({ error: "Enter a valid email address." });
    return;
  }
  if (typeof password !== "string" || password.length < 10 || password.length > 128) {
    response.status(400).json({ error: "Password must be 10–128 characters." });
    return;
  }

  try {
    const ip = requestAddress(request);
    if (!await rateLimit(`tex:rate:register:ip:${ip}`, 10, 900)) {
      serviceRateLimit(response);
      return;
    }

    const { salt, hash } = await hashPassword(password);
    const user = {
      id: newUserId(),
      username,
      email,
      passwordHash: hash,
      passwordSalt: salt,
      sessionVersion: 0,
      createdAt: Date.now()
    };
    if (!await createUser(user)) {
      response.status(409).json({ error: "That username or email is already registered." });
      return;
    }

    response.status(201).json({ user: publicUser(user) });
  } catch (error) {
    authError(response, error, "Sign up is temporarily unavailable.");
  }
}
