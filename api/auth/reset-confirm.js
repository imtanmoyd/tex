import {
  authError,
  findUserByEmail,
  hashPassword,
  hashResetCode,
  normalizeEmail,
  rateLimit,
  readRequestJson,
  requestAddress,
  resetUserPassword,
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
  const { code, password } = body || {};
  if (!validEmail(email)) {
    response.status(400).json({ error: "Enter a valid email address." });
    return;
  }
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    response.status(400).json({ error: "Enter the 6-digit reset code." });
    return;
  }
  if (typeof password !== "string" || password.length < 10 || password.length > 128) {
    response.status(400).json({ error: "Password must be 10–128 characters." });
    return;
  }

  try {
    const ip = requestAddress(request);
    if (!await rateLimit(`tex:rate:reset-confirm:ip:${ip}`, 10, 900)
      || !await rateLimit(`tex:rate:reset-confirm:email:${email}`, 5, 900)) {
      serviceRateLimit(response);
      return;
    }

    const user = await findUserByEmail(email);
    if (!user) {
      response.status(400).json({ error: "The reset code is invalid or expired." });
      return;
    }
    const { salt, hash } = await hashPassword(password);
    const updated = await resetUserPassword(user, hashResetCode(email, code), salt, hash);
    if (!updated) {
      response.status(400).json({ error: "The reset code is invalid or expired." });
      return;
    }
    response.status(200).json({ ok: true });
  } catch (error) {
    authError(response, error, "Password reset is temporarily unavailable.");
  }
}
