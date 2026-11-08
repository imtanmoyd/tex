import {
  authError,
  authKey,
  findUserByEmail,
  hasResetEmailConfig,
  hashResetCode,
  newResetCode,
  newResetEntry,
  normalizeEmail,
  rateLimit,
  readRequestJson,
  redisCommand,
  requestAddress,
  sendResetEmail,
  serviceRateLimit,
  validEmail
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

  const email = normalizeEmail(body?.email);
  if (!validEmail(email)) {
    response.status(400).json({ error: "Enter a valid email address." });
    return;
  }

  try {
    if (!hasResetEmailConfig()) {
      response.status(503).json({ error: "Password reset email is not configured for this deployment." });
      return;
    }

    const ip = requestAddress(request);
    if (!await rateLimit(`tex:rate:reset:ip:${ip}`, 10, 900)
      || !await rateLimit(`tex:rate:reset:email:${email}`, 3, 900)) {
      serviceRateLimit(response);
      return;
    }

    const user = await findUserByEmail(email);
    if (user) {
      const code = newResetCode();
      const key = authKey("reset", email);
      const entry = newResetEntry(hashResetCode(email, code));
      await redisCommand("SET", key, JSON.stringify(entry), "EX", "900");
      try {
        await sendResetEmail(email, code);
      } catch (error) {
        await redisCommand("DEL", key);
        throw error;
      }
    }

    response.status(202).json({ sent: true });
  } catch (error) {
    authError(response, error, "Password reset is temporarily unavailable.");
  }
}
