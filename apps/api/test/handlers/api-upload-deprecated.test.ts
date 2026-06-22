/**
 * api-upload handler 测试 — DEPRECATED since CP-7-C T15
 *
 * 验证：所有 method（除 OPTIONS）返 410 GONE + 新路径说明
 * 计划：minipgm v2 上传稳定后整个 file + index.ts 注册一起删
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const testEnv = {
  ADMIN_TOKEN: "admin-token-test",
  JWT_SECRET: "test-jwt-secret-must-be-32-bytes-long-aaaaaaaaaa",
  MINIMAX_API_KEY: "sk-test",
  KEK_SECRET_V1: "kek-secret-32-bytes-min-aaaaaaaaaaaa",
  ENVIRONMENT: "test",
  ALLOWED_ORIGIN: "*",
  ADMIN_IP_ALLOWLIST: "127.0.0.1",
  MINIMAX_BASE_URL: "https://api.test/v1",
  DEFAULT_USER_ID: "u1",
  KEK_CURRENT_VERSION: "1",
};

vi.mock("../../src/lib/env.js", () => ({
  getEnv: () => testEnv,
}));

import { main } from "../../src/handlers/api-upload.js";

function makeEvent(method: string): Parameters<typeof main>[0] {
  return {
    httpMethod: method,
    path: "/api-upload",
    headers: {},
    body: null,
    queryString: {},
    isBase64Encoded: false,
  } as unknown as Parameters<typeof main>[0];
}

describe("api-upload handler DEPRECATED (CP-7-C T15)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POST → 410 GONE + message 提新路径", async () => {
    const res = await main(makeEvent("POST"));
    expect(res.statusCode).toBe(410);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("GONE");
    expect(body.message).toMatch(/api-ingest/);
    expect(body.message).toMatch(/content.*title.*url/);
  });

  it("GET → 410 GONE", async () => {
    const res = await main(makeEvent("GET"));
    expect(res.statusCode).toBe(410);
    expect(JSON.parse(res.body).error).toBe("GONE");
  });

  it("PUT → 410 GONE", async () => {
    const res = await main(makeEvent("PUT"));
    expect(res.statusCode).toBe(410);
  });

  it("OPTIONS → CORS preflight 通过（不返 410）", async () => {
    const res = await main(makeEvent("OPTIONS"));
    expect(res.statusCode).toBe(204);
  });
});
