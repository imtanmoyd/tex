import { describe, expect, it } from "vitest";
import {
  authKey,
  createSessionToken,
  hashPassword,
  normalizeEmail,
  normalizeUsername,
  newResetCode,
  validEmail,
  validUsername,
  verifyPassword,
  verifySessionToken
} from "./auth.js";

describe("web auth primitives", () => {
  it("normalizes and validates account identifiers", () => {
    expect(normalizeUsername("  Tex_User ")).toBe("tex_user");
    expect(normalizeEmail("  USER@example.com ")).toBe("user@example.com");
    expect(validUsername("tex_user")).toBe(true);
    expect(validUsername("bad name")).toBe(false);
    expect(validEmail("user@example.com")).toBe(true);
    expect(validEmail("not-an-email")).toBe(false);
  });

  it("hashes passwords with a per-password salt and verifies them safely", async () => {
    const first = await hashPassword("a-long-password");
    const second = await hashPassword("a-long-password");
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe("a-long-password");
    await expect(verifyPassword("a-long-password", first.salt, first.hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", first.salt, first.hash)).resolves.toBe(false);
  });

  it("signs expiring sessions and rejects tampered or expired tokens", () => {
    const now = 1_800_000_000_000;
    const { token, expiresAt } = createSessionToken(
      { id: "user-1", username: "tex", email: "tex@example.com" },
      "a-test-secret-that-is-long-enough",
      now
    );
    expect(verifySessionToken(token, "a-test-secret-that-is-long-enough", now)?.sub).toBe("user-1");
    expect(verifySessionToken(`${token.slice(0, -1)}x`, "a-test-secret-that-is-long-enough", now)).toBeNull();
    expect(verifySessionToken(token, "a-different-secret-that-is-long", now)).toBeNull();
    expect(verifySessionToken(token, "a-test-secret-that-is-long-enough", expiresAt)).toBeNull();
  });

  it("does not place raw account identifiers in datastore keys", () => {
    const key = authKey("email", "private@example.com");
    expect(key).not.toContain("private@example.com");
    expect(key).toMatch(/^tex:auth:email:[a-f0-9]{64}$/);
  });

  it("generates fixed-length numeric reset codes", () => {
    expect(newResetCode()).toMatch(/^\d{6}$/);
  });
});
