/**
 * api-auth-me handler 单测 (M7-D)
 *
 * 覆盖：
 * - happy: GET + valid jwt → 200 + user info + session/message count
 * - 401: 无 Authorization / 无效 jwt
 * - 404: user 不存在
 * - 204: OPTIONS 预检
 * - nickname 为空 → 返 null
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/db.js", () => ({
  COLLECTIONS: { user: "user", chatSession: "chat_session" },
  getById: vi.fn(),
  whereQuery: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
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

import { getById, whereQuery } from "../../src/lib/db.js";
import { main } from "../../src/handlers/api-auth-me.js";
import { signJwt } from "../../src/lib/jwt.js";
import type { HttpTriggerEvent } from "../../src/lib/handler-utils.js";

const SECRET = "test-jwt-secret-must-be-32-bytes-long-aaaaaaaaaa";

function makeEvent(opts: {
  method?: string;
  headers?: Record<string, string>;
}): HttpTriggerEvent {
  return {
    httpMethod: opts.method ?? "GET",
    path: "/api-auth-me",
    headers: opts.headers ?? {},
    queryString: {},
    body: null,
    isBase64Encoded: false,
  };
}

async function makeJwt(userId: string): Promise<string> {
  return signJwt({ userId, scope: "user", secret: SECRET });
}

describe("api-auth-me (M7-D)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy: GET + valid jwt → 200 + user info + session count", async () => {
    const jwt = await makeJwt("01HUSER001");
    vi.mocked(getById).mockResolvedValue({
      _id: "01HUSER001",
      id: "01HUSER001",
      wxOpenid: "wx_openid_123",
      nickname: "宝宝妈",
      createdAt: 1700000000000,
    } as unknown as Awaited<ReturnType<typeof getById>>);
    // whereQuery 在 db 层会按 userId filter；mock 只返当前 user 的 sessions
    vi.mocked(whereQuery).mockResolvedValue([
      {
        _id: "s1",
        userId: "01HUSER001",
        messages: [{ role: "user" }, { role: "assistant" }],
      },
      {
        _id: "s2",
        userId: "01HUSER001",
        messages: [{ role: "user" }],
      },
    ] as unknown as Awaited<ReturnType<typeof whereQuery>>);

    const res = await main(
      makeEvent({ headers: { authorization: `Bearer ${jwt}` } }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user_id).toBe("01HUSER001");
    expect(body.nickname).toBe("宝宝妈");
    expect(body.created_at).toBe(1700000000000);
    expect(body.session_count).toBe(2);
    expect(body.total_messages).toBe(3); // 2 + 1
    expect(body.isolation).toMatch(/只对你可见/);
  });

  it("401: 无 Authorization → AUTH_FAILED", async () => {
    const res = await main(makeEvent({}));
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("AUTH_FAILED");
  });

  it("401: 无效 jwt → AUTH_FAILED", async () => {
    const res = await main(
      makeEvent({ headers: { authorization: "Bearer invalid.token.here" } }),
    );
    expect(res.statusCode).toBe(401);
  });

  it("404: user 不存在", async () => {
    const jwt = await makeJwt("01HNONEXIST");
    vi.mocked(getById).mockResolvedValue(null);
    vi.mocked(whereQuery).mockResolvedValue([]);

    const res = await main(
      makeEvent({ headers: { authorization: `Bearer ${jwt}` } }),
    );
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("NOT_FOUND");
  });

  it("204: OPTIONS 预检", async () => {
    const res = await main(makeEvent({ method: "OPTIONS" }));
    expect(res.statusCode).toBe(204);
  });

  it("nickname undefined → 返 null（不是 undefined）", async () => {
    const jwt = await makeJwt("01HNEWUSER");
    vi.mocked(getById).mockResolvedValue({
      _id: "01HNEWUSER",
      id: "01HNEWUSER",
      createdAt: 1700000000000,
      // 没有 nickname 字段
    } as unknown as Awaited<ReturnType<typeof getById>>);
    vi.mocked(whereQuery).mockResolvedValue([]);

    const res = await main(
      makeEvent({ headers: { authorization: `Bearer ${jwt}` } }),
    );
    const body = JSON.parse(res.body);
    expect(body.nickname).toBeNull();
  });
});