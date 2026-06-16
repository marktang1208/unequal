import { describe, it, expect } from "vitest";
import { loadEnvForTest, resetEnv, getEnv } from "../../src/lib/env.js";

describe("env loading (CP-6)", () => {
  it("throws if required secrets missing", () => {
    resetEnv();
    expect(() =>
      loadEnvForTest({
        // 故意缺 KEK_SECRET_V1
        ADMIN_TOKEN: "x",
        JWT_SECRET: "x",
        MINIMAX_API_KEY: "x",
        ENVIRONMENT: "test",
        ALLOWED_ORIGIN: "*",
        ADMIN_IP_ALLOWLIST: "127.0.0.1",
        MINIMAX_BASE_URL: "https://api.test/v1",
        DEFAULT_USER_ID: "u1",
      }),
    ).toThrow(/KEK_SECRET_V1/);
  });

  it("throws if required vars missing", () => {
    resetEnv();
    expect(() =>
      loadEnvForTest({
        ADMIN_TOKEN: "x",
        JWT_SECRET: "x",
        MINIMAX_API_KEY: "x",
        KEK_SECRET_V1: "x",
        // 缺 ENVIRONMENT / ALLOWED_ORIGIN / ADMIN_IP_ALLOWLIST / MINIMAX_BASE_URL / DEFAULT_USER_ID
      }),
    ).toThrow();
  });

  it("returns full env when all required present", () => {
    resetEnv();
    const env = loadEnvForTest({
      ADMIN_TOKEN: "admin-tok",
      JWT_SECRET: "jwt-secret-32-bytes-min-aaaaaaaaa",
      MINIMAX_API_KEY: "sk-test",
      KEK_SECRET_V1: "kek-secret-32-bytes-min-aaaaaaaaa",
      ENVIRONMENT: "production",
      ALLOWED_ORIGIN: "*",
      ADMIN_IP_ALLOWLIST: "127.0.0.1,::1",
      MINIMAX_BASE_URL: "https://api.test/v1",
      DEFAULT_USER_ID: "u1",
      LOGIN_MAX_ATTEMPTS: "10",
      LOGIN_WINDOW_MS: "600000",
      KEK_CURRENT_VERSION: "2",
    });

    expect(env.ADMIN_TOKEN).toBe("admin-tok");
    expect(env.ENVIRONMENT).toBe("production");
    expect(env.LOGIN_MAX_ATTEMPTS).toBe(10);
    expect(env.LOGIN_WINDOW_MS).toBe(600000);
    expect(env.KEK_CURRENT_VERSION).toBe("2");
  });

  it("caches env result on getEnv", () => {
    resetEnv();
    loadEnvForTest({
      ADMIN_TOKEN: "x",
      JWT_SECRET: "x",
      MINIMAX_API_KEY: "x",
      KEK_SECRET_V1: "x",
      ENVIRONMENT: "test",
      ALLOWED_ORIGIN: "*",
      ADMIN_IP_ALLOWLIST: "127.0.0.1",
      MINIMAX_BASE_URL: "https://api.test/v1",
      DEFAULT_USER_ID: "u1",
    });

    const e1 = getEnv();
    const e2 = getEnv();
    expect(e1).toBe(e2);  // 同一引用
  });
});