import { describe, it, expect, beforeAll } from "vitest";
import { verifyAdminToken, verifyAuth } from "../src/lib/auth.js";

describe("verifyAdminToken", () => {
  it("returns ok when token matches", () => {
    expect(verifyAdminToken("Bearer secret", "secret")).toEqual({ ok: true });
  });

  it("returns error on missing header", () => {
    expect(verifyAdminToken(undefined, "secret")).toEqual({
      ok: false,
      status: 401,
      message: "Missing Authorization header",
    });
  });

  it("returns error on wrong token", () => {
    expect(verifyAdminToken("Bearer wrong", "secret")).toEqual({
      ok: false,
      status: 401,
      message: "Invalid token",
    });
  });

  it("returns error on non-Bearer scheme", () => {
    expect(verifyAdminToken("Basic secret", "secret")).toEqual({
      ok: false,
      status: 401,
      message: "Invalid token",
    });
  });
});

/**
 * M6.2 verifyAuth 新增 4 用例（spec §3.1 + §3.6）。
 *
 * 覆盖：
 * - admin_token 合法 Bearer → admin identity
 * - jwt 合法 Bearer → user identity（用 signJwt 签，避免耦合 verifyJwt 自身）
 * - jwt 缺 Bearer → MISSING_BEARER（401）
 * - jwt 篡改 → INVALID_JWT（401，透传自 auth-jwt）
 */
describe("verifyAuth (admin_token + jwt 分支)", () => {
  const ENV_ADMIN = "test-admin-token-please-change";
  const ENV_JWT = "test-jwt-secret-at-least-32-bytes-long-xxx";
  let signedToken: string;

  beforeAll(async () => {
    const { signJwt } = await import("../src/lib/auth-jwt.js");
    signedToken = await signJwt(
      { userId: "01HUSER000000000000000000", isAdmin: false },
      ENV_JWT,
    );
  });

  function makeRequest(authHeader?: string): Request {
    return new Request("https://do/test", {
      headers: authHeader ? { Authorization: authHeader } : {},
    });
  }

  it("AUTH_MODE=admin_token + 合法 Bearer → 返 admin identity", async () => {
    const env = {
      AUTH_MODE: "admin_token",
      ADMIN_TOKEN: ENV_ADMIN,
      JWT_SECRET: "",
    };
    const got = await verifyAuth(makeRequest(`Bearer ${ENV_ADMIN}`), env);
    expect(got.userId).toBe("01H0000000000000000000000");
    expect(got.isAdmin).toBe(true);
  });

  it("AUTH_MODE=jwt + 合法 Bearer jwt → 返 user identity", async () => {
    const env = {
      AUTH_MODE: "jwt",
      ADMIN_TOKEN: "",
      JWT_SECRET: ENV_JWT,
    };
    const got = await verifyAuth(makeRequest(`Bearer ${signedToken}`), env);
    expect(got.userId).toBe("01HUSER000000000000000000");
    expect(got.isAdmin).toBe(false);
  });

  it("AUTH_MODE=jwt + 缺 Bearer → 抛 HttpError 401 MISSING_BEARER", async () => {
    const env = {
      AUTH_MODE: "jwt",
      ADMIN_TOKEN: "",
      JWT_SECRET: ENV_JWT,
    };
    await expect(verifyAuth(makeRequest(), env)).rejects.toMatchObject({
      status: 401,
      code: "MISSING_BEARER",
    });
  });

  it("AUTH_MODE=jwt + 篡改 jwt → 抛 HttpError 401 INVALID_JWT", async () => {
    const env = {
      AUTH_MODE: "jwt",
      ADMIN_TOKEN: "",
      JWT_SECRET: ENV_JWT,
    };
    const tampered = signedToken.slice(0, -3) + "xxx";
    await expect(
      verifyAuth(makeRequest(`Bearer ${tampered}`), env),
    ).rejects.toMatchObject({
      status: 401,
      code: "INVALID_JWT",
    });
  });
});
