import { describe, it, expect } from "vitest";
import { signJwt, verifyJwt } from "../../src/lib/jwt.js";

const SECRET = "test-jwt-secret-must-be-32-bytes-long-aaaaaaaaaa";

describe("jwt (CP-6)", () => {
  it("sign + verify roundtrip admin", async () => {
    const token = await signJwt({ userId: "u1", scope: "admin", secret: SECRET });
    const payload = await verifyJwt({ token, secret: SECRET });
    expect(payload.sub).toBe("u1");
    expect(payload.scope).toBe("admin");
  });

  it("sign + verify roundtrip user", async () => {
    const token = await signJwt({ userId: "u2", scope: "user", secret: SECRET });
    const payload = await verifyJwt({ token, secret: SECRET });
    expect(payload.sub).toBe("u2");
    expect(payload.scope).toBe("user");
  });

  it("wrong secret → throws", async () => {
    const token = await signJwt({ userId: "u1", scope: "admin", secret: SECRET });
    await expect(
      verifyJwt({ token, secret: "different-secret-also-32-bytes-aaaaa" }),
    ).rejects.toThrow();
  });

  it("tampered token → throws", async () => {
    const token = await signJwt({ userId: "u1", scope: "admin", secret: SECRET });
    const tampered = token.slice(0, -3) + "xxx";
    await expect(verifyJwt({ token: tampered, secret: SECRET })).rejects.toThrow();
  });
});