import { describe, it, expect } from "vitest";
import { signJwt, verifyJwt } from "../../src/lib/auth-jwt.js";

const SECRET = "test-secret-at-least-32-bytes-long-xxx";

describe("auth-jwt (HS256 + 24h)", () => {
  it("sign → verify 合法 token", async () => {
    const token = await signJwt({ userId: "u1", isAdmin: false }, SECRET);
    const got = await verifyJwt(token, SECRET);
    expect(got.userId).toBe("u1");
    expect(got.isAdmin).toBe(false);
  });

  it("过期 token → 抛 HttpError 401 JWT_EXPIRED", async () => {
    // 用过去时间戳（手搓一个过期 token）
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(SECRET);
    const expired = await new SignJWT({ userId: "u1", isAdmin: false })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("unequal-api")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)  // 2 小时前签发
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)  // 1 小时前过期
      .sign(key);
    await expect(verifyJwt(expired, SECRET)).rejects.toMatchObject({
      status: 401, code: "JWT_EXPIRED",
    });
  });

  it("篡改 token → 抛 HttpError 401 INVALID_JWT", async () => {
    const token = await signJwt({ userId: "u1", isAdmin: false }, SECRET);
    const tampered = token.slice(0, -3) + "xxx"; // 改后 3 字符
    await expect(verifyJwt(tampered, SECRET)).rejects.toMatchObject({
      status: 401, code: "INVALID_JWT",
    });
  });

  it("缺 userId claim → 抛 HttpError 401 INVALID_JWT_CLAIMS", async () => {
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(SECRET);
    const noClaims = await new SignJWT({ isAdmin: false })  // 缺 userId
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("unequal-api")
      .setIssuedAt()
      .setExpirationTime("24h")
      .sign(key);
    await expect(verifyJwt(noClaims, SECRET)).rejects.toMatchObject({
      status: 401, code: "INVALID_JWT_CLAIMS",
    });
  });
});