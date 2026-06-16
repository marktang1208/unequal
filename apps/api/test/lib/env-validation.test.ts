import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadEnvForTest,
  resetEnv,
  validateEmbeddingDim,
} from "../../src/lib/env.js";

// Mock MiniMax embedding to avoid real API call
vi.mock("@unequal/shared/embedding", () => ({
  createMiniMaxEmbedder: () => ({
    embed: async (_texts: string[]) => [new Array(1536).fill(0.1)],
  }),
}));

describe("validateEmbeddingDim (CP-6 启动时硬验证)", () => {
  beforeEach(() => {
    resetEnv();
    delete process.env.ENVIRONMENT;
  });

  it("production env + dim 1536 → 验证通过", async () => {
    loadEnvForTest({
      ADMIN_TOKEN: "x",
      JWT_SECRET: "x",
      MINIMAX_API_KEY: "sk-test",
      KEK_SECRET_V1: "x",
      ENVIRONMENT: "production",
      ALLOWED_ORIGIN: "*",
      ADMIN_IP_ALLOWLIST: "127.0.0.1",
      MINIMAX_BASE_URL: "https://api.test/v1",
      DEFAULT_USER_ID: "u1",
    });
    await expect(validateEmbeddingDim()).resolves.toBeUndefined();
  });

  it("non-production env → 跳过（不抛错）", async () => {
    loadEnvForTest({
      ADMIN_TOKEN: "x",
      JWT_SECRET: "x",
      MINIMAX_API_KEY: "sk-test",
      KEK_SECRET_V1: "x",
      ENVIRONMENT: "development",
      ALLOWED_ORIGIN: "*",
      ADMIN_IP_ALLOWLIST: "127.0.0.1",
      MINIMAX_BASE_URL: "https://api.test/v1",
      DEFAULT_USER_ID: "u1",
    });
    await expect(validateEmbeddingDim()).resolves.toBeUndefined();
  });
});