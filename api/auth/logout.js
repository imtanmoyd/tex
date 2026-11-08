import { setSessionCookie } from "../../server/auth.js";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.status(405).json({ error: "Use POST." });
    return;
  }
  setSessionCookie(response, "");
  response.status(200).json({ ok: true });
}
