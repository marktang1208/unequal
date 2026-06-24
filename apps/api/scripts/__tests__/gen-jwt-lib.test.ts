/**
 * gen-jwt-lib.test.ts — TDD for signJwt (P7 follow-up #3)
 *
 * 覆盖 6 cases:
 *   1. 基础 sign: sub + scope + secret → JWT string (3 段, . 分隔)
 *   2. JWT payload 解码: sub / scope / iss / exp / iat 都在
 *   3. issuer 默认 "unequal-api"
 *   4. issuer override → payload.iss = override 值
 *   5. ttl 短 (60s) → exp - iat ≈ 60s
 *   6. 错误: sub / scope / secret 任一为空 → throw
 */

import { describe, it, expect } from "vitest";
import { decodeJwt } from "jose";
import { signJwt } from "../gen-jwt-lib.js";

const TEST_SECRET = "test-secret-at-least-32-bytes-long-for-hs256-ok";

describe("signJwt (P7 #3)", () => {
  it("基础 sign: sub + scope + secret → 3 段 JWT (header.payload.signature)", async () => {
    const jwt = await signJwt({
      sub: "01KVCZ2JRBAGF3MY75D7KEY4RZ",
      scope: "user",
      secret: TEST_SECRET,
    });
    expect(jwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("JWT payload 解码: sub / scope / iss / iat / exp 都在", async () => {
    const jwt = await signJwt({
      sub: "01KVCZ2JRBAGF3MY75D7KEY4RZ",
      scope: "user",
      secret: TEST_SECRET,
    });
    const payload = decodeJwt(jwt);
    expect(payload.sub).toBe("01KVCZ2JRBAGF3MY75D7KEY4RZ");
    expect(payload.scope).toBe("user");
    expect(payload.iss).toBe("unequal-api"); // 默认
    expect(payload.iat).toBeGreaterThan(0);
    expect(payload.exp).toBeGreaterThan(payload.iat!);
  });

  it("issuer 默认 'unequal-api'", async () => {
    const jwt = await signJwt({
      sub: "01H0000000000000000000000",
      scope: "user",
      secret: TEST_SECRET,
    });
    expect(decodeJwt(jwt).iss).toBe("unequal-api");
  });

  it("issuer override → payload.iss = override 值", async () => {
    const jwt = await signJwt({
      sub: "01H0000000000000000000000",
      scope: "user",
      secret: TEST_SECRET,
      issuer: "custom-issuer",
    });
    expect(decodeJwt(jwt).iss).toBe("custom-issuer");
  });

  it("ttl 短 (60s) → exp - iat ≈ 60s (允许 ±2s 误差)", async () => {
    const jwt = await signJwt({
      sub: "01H0000000000000000000000",
      scope: "user",
      secret: TEST_SECRET,
      ttl: "60s",
    });
    const payload = decodeJwt(jwt);
    const ttl = payload.exp! - payload.iat!;
    expect(ttl).toBeGreaterThanOrEqual(58);
    expect(ttl).toBeLessThanOrEqual(62);
  });

  it("错误: sub 空 → throw", async () => {
    await expect(
      signJwt({ sub: "", scope: "user", secret: TEST_SECRET }),
    ).rejects.toThrow(/sub is required/);
  });

  it("错误: scope 空 → throw", async () => {
    await expect(
      signJwt({ sub: "01H0000000000000000000000", scope: "", secret: TEST_SECRET }),
    ).rejects.toThrow(/scope is required/);
  });

  it("错误: secret 空 → throw", async () => {
    await expect(
      signJwt({ sub: "01H0000000000000000000000", scope: "user", secret: "" }),
    ).rejects.toThrow(/secret is required/);
  });
});