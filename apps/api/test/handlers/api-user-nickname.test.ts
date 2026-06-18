/**
 * api-user-nickname handler 单测（CP-7-B）
 *
 * 覆盖：
 * - happy: 改 nickname
 * - 401: 无 Authorization
 * - 400: missing nickname / empty / > 30 chars / 非 string
 * - 404: user 不存在
 * - 200: OPTIONS 预检
 * - 405: 错误 method
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/db.js", () => ({
  COLLECTIONS: { user: "user" },
  getById: vi.fn(),
  update: vi.fn(),
  whereQuery: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  count: vi.fn(),
  newId: vi.fn(() => "01HNEWID"),
  getAllByFilter: vi.fn(),
}));

vi.mock("../../src/lib/env.js", () => ({
  getEnv: () => ({
    JWT_SECRET: "test-jwt-secret-must-be-32-bytes-long-aaaaaaaaaa",
    ALLOWED_ORIGIN: "*",
  }),
}));

import { getById, update } from "../../src/lib/db.js";
import { main } from "../../src/handlers/api-user-nickname.js";
import { signJwt } from "../../src/lib/jwt.js";
import type { HttpTriggerEvent } from "../../src/lib/handler-utils.js";

const SECRET = "test-jwt-secret-must-be-32-bytes-long-aaaaaaaaaa";

function makeEvent(opts: {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}): HttpTriggerEvent {
  return {
    httpMethod: opts.method ?? "PATCH",
    path: "/api-user-nickname",
    headers: opts.headers ?? {},
    queryString: {},
    body: opts.body ?? null,
    isBase64Encoded: false,
  };
}

async function makeJwt(userId: string): Promise<string> {
  return signJwt({ userId, scope: "user", secret: SECRET });
}

describe("api-user-nickname (CP-7-B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy: PATCH with valid jwt + nickname → 200 + update called", async () => {
    const jwt = await makeJwt("01HUSER");
    vi.mocked(getById).mockResolvedValue({
      _id: "01HUSER",
      id: "01HUSER",
      wxOpenid: "wx_openid_123",
      createdAt: 1000,
    } as unknown as Awaited<ReturnType<typeof getById>>);
    vi.mocked(update).mockResolvedValue(undefined);

    const res = await main(
      makeEvent({
        method: "PATCH",
        headers: { authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ nickname: "张三" }),
      }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ ok: true, user_id: "01HUSER", nickname: "张三" });
    expect(getById).toHaveBeenCalledWith("user", "01HUSER");
    expect(update).toHaveBeenCalledWith(
      "user",
      "01HUSER",
      expect.objectContaining({ nickname: "张三" }),
    );
  });

  it("update 不改 wxOpenid/createdAt（只更新 nickname）", async () => {
    const jwt = await makeJwt("01HUSER");
    vi.mocked(getById).mockResolvedValue({
      _id: "01HUSER",
      id: "01HUSER",
      wxOpenid: "wx_openid_123",
      createdAt: 1000,
    } as unknown as Awaited<ReturnType<typeof getById>>);
    vi.mocked(update).mockResolvedValue(undefined);

    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ nickname: "新昵称" }),
      }),
    );
    expect(res.statusCode).toBe(200);
    const updateArg = vi.mocked(update).mock.calls[0]![2]!;
    expect(updateArg).toEqual({ nickname: "新昵称" });
    expect(updateArg).not.toHaveProperty("wxOpenid");
    expect(updateArg).not.toHaveProperty("createdAt");
  });

  it("401: no Authorization header → AUTH_FAILED", async () => {
    const res = await main(
      makeEvent({ body: JSON.stringify({ nickname: "张三" }) }),
    );
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("AUTH_FAILED");
  });

  it("401: invalid jwt → AUTH_FAILED", async () => {
    const res = await main(
      makeEvent({
        headers: { authorization: "Bearer not.valid" },
        body: JSON.stringify({ nickname: "张三" }),
      }),
    );
    expect(res.statusCode).toBe(401);
  });

  it("400: missing nickname in body → INVALID_REQUEST", async () => {
    const jwt = await makeJwt("01HUSER");
    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${jwt}` },
        body: JSON.stringify({}),
      }),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("INVALID_REQUEST");
  });

  it("400: empty nickname → INVALID_REQUEST", async () => {
    const jwt = await makeJwt("01HUSER");
    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ nickname: "   " }),
      }),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("INVALID_REQUEST");
  });

  it("400: nickname > 30 chars → INVALID_REQUEST", async () => {
    const jwt = await makeJwt("01HUSER");
    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ nickname: "x".repeat(31) }),
      }),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.message).toMatch(/30/);
  });

  it("400: nickname 不是 string → INVALID_REQUEST", async () => {
    const jwt = await makeJwt("01HUSER");
    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ nickname: 123 }),
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it("404: user not found → NOT_FOUND", async () => {
    const jwt = await makeJwt("01HUSER");
    vi.mocked(getById).mockResolvedValue(null);

    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ nickname: "张三" }),
      }),
    );
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("NOT_FOUND");
    expect(update).not.toHaveBeenCalled();
  });

  it("200: OPTIONS preflight → 204", async () => {
    const res = await main(makeEvent({ method: "OPTIONS" }));
    expect(res.statusCode).toBe(204);
  });

  it("405: GET method → METHOD_NOT_ALLOWED", async () => {
    const res = await main(makeEvent({ method: "GET" }));
    expect(res.statusCode).toBe(405);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("METHOD_NOT_ALLOWED");
  });

  it("nickname trim: '  张三  ' → '张三'", async () => {
    const jwt = await makeJwt("01HUSER");
    vi.mocked(getById).mockResolvedValue({
      _id: "01HUSER",
      id: "01HUSER",
      wxOpenid: "wx",
      createdAt: 1000,
    } as unknown as Awaited<ReturnType<typeof getById>>);
    vi.mocked(update).mockResolvedValue(undefined);

    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ nickname: "  张三  " }),
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.nickname).toBe("张三");
  });
});