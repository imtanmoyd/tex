import { authError, getAuthConfig, getSessionToken, redisCommand, verifySessionToken } from "../../server/auth.js";

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.status(405).json({ error: "Use GET." });
    return;
  }

  try {
    const { jwtSecret } = getAuthConfig();
    const payload = verifySessionToken(getSessionToken(request) || "", jwtSecret);
    if (!payload) {
      response.status(401).json({ error: "Sign in to continue." });
      return;
    }

    const raw = await redisCommand("GET", `tex:auth:user:${payload.sub}`);
    if (typeof raw !== "string") {
      response.status(401).json({ error: "Sign in to continue." });
      return;
    }
    const user = JSON.parse(raw);
    if (payload.ver !== (user.sessionVersion || 0)) {
      response.status(401).json({ error: "Sign in to continue." });
      return;
    }
    response.status(200).json({
      user: { username: user.username, email: user.email },
      expiresAt: payload.exp * 1000
    });
  } catch (error) {
    authError(response, error, "Session check is temporarily unavailable.");
  }
}
