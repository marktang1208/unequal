/**
 * api-sessions-rename handler 单测（CP-7-B）
 *
 * 覆盖：
 * - happy: 改 title + updatedAt
 * - 401: 无 Authorization / 无效 JWT
 * - 400: missing id / empty title / title > 100 / body 非 string
 * - 403: session.userId !== jwt.sub
 * - 404: session 不存在
 * - 200: OPTIONS 预检
 * - 405: 错误 method（GET / POST）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db 模块（避免真连 CloudBase）
vi.mock("../../src/lib/db.js", () => ({
  COLLECTIONS: { chatSession: "chat_session" },
  getById: vi.fn(),
  update: vi.fn(),
  whereQuery: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  count: vi.fn(),
  newId: vi.fn(() => "01HNEWID"),
  getAllByFilter: vi.fn(),
}));

// Mock env（提供 JWT_SECRET）
vi.mock("../../src/lib/env.js", () => ({
  getEnv: () => ({
    JWT_SECRET: "test-jwt-secret-must-be-32-bytes-long-aaaaaaaaaa",
    ALLOWED_ORIGIN: "*",
    MINIMAX_API_KEY: "sk-test",
  }),
}));

import { getById, update, whereQuery } from "../../src/lib/db.js";
import { main } from "../../src/handlers/api-sessions-rename.js";
import { signJwt } from "../../src/lib/jwt.js";
import type { HttpTriggerEvent } from "../../src/lib/handler-utils.js";

const SECRET = "test-jwt-secret-must-be-32-bytes-long-aaaaaaaaaa";

function makeEvent(opts: {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: string | null;
}): HttpTriggerEvent {
  return {
    httpMethod: opts.method ?? "PATCH",
    path: "/api-sessions-rename",
    headers: opts.headers ?? {},
    queryString: opts.query ?? {},
    body: opts.body ?? null,
    isBase64Encoded: false,
  };
}

async function makeJwt(userId: string): Promise<string> {
  return signJwt({ userId, scope: "user", secret: SECRET });
}

describe("api-sessions-rename (CP-7-B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy: PATCH with valid jwt + id + title → 200 + update called", async () => {
    const jwt = await makeJwt("01HUSER");
    vi.mocked(whereQuery).mockResolvedValue([{
      _id: "01HSESSION",
      id: "01HSESSION",
      userId: "01HUSER",
      title: "旧标题",
      messages: [],
      createdAt: 1000,
      updatedAt: 1000,
    }] as unknown as Awaited<ReturnType<typeof whereQuery>>);
    vi.mocked(update).mockResolvedValue(undefined);

    const res = await main(
      makeEvent({
        method: "PATCH",
        headers: { authorization: `Bearer ${jwt}` },
        query: { id: "01HSESSION" },
        body: JSON.stringify({ title: "新标题" }),
      }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ ok: true, id: "01HSESSION", title: "新标题" });
    expect(whereQuery).toHaveBeenCalledWith("chat_session", { id: "01HSESSION" }, expect.objectContaining({ limit: 1 }));
    expect(update).toHaveBeenCalledWith(
      "chat_session",
      "01HSESSION",
      expect.objectContaining({
        title: "新标题",
        updatedAt: expect.any(Number),
      }),
    );
  });

  it("401: no Authorization header → AUTH_FAILED", async () => {
    const res = await main(
      makeEvent({
        query: { id: "01HSESSION" },
        body: JSON.stringify({ title: "新" }),
      }),
    );
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("AUTH_FAILED");
  });

  it("401: invalid jwt → AUTH_FAILED", async () => {
    const res = await main(
      makeEvent({
        headers: { authorization: "Bearer not.a.valid.jwt" },
        query: { id: "01HSESSION" },
        body: JSON.stringify({ title: "新" }),
      }),
    );
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("AUTH_FAILED");
  });

  it("400: missing id query param → INVALID_REQUEST", async () => {
    const jwt = await makeJwt("01HUSER");
    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ title: "新" }),
      }),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.message).toMatch(/id/);
  });

  it("400: empty title in body → INVALID_REQUEST", async () => {
    const jwt = await makeJwt("01HUSER");
    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${jwt}` },
        query: { id: "01HSESSION" },
        body: JSON.stringify({ title: "   " }),
      }),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("INVALID_REQUEST");
  });

  it("400: title > 100 chars → INVALID_REQUEST", async () => {
    const jwt = await makeJwt("01HUSER");
    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${jwt}` },
        query: { id: "01HSESSION" },
        body: JSON.stringify({ title: "x".repeat(101) }),
      }),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.message).toMatch(/100/);
  });

  it("404: session not found → NOT_FOUND", async () => {
    const jwt = await makeJwt("01HUSER");
    vi.mocked(whereQuery).mockResolvedValue([]);

    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${jwt}` },
        query: { id: "01HNOTFOUND" },
        body: JSON.stringify({ title: "新" }),
      }),
    );
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("NOT_FOUND");
    expect(update).not.toHaveBeenCalled();
  });

  it("403: session.userId !== jwt.sub → FORBIDDEN", async () => {
    const jwt = await makeJwt("01HUSER_A");
    vi.mocked(whereQuery).mockResolvedValue([{
      _id: "01HSESSION",
      id: "01HSESSION",
      userId: "01HUSER_B",
      title: "他人会话",
      messages: [],
      createdAt: 1000,
      updatedAt: 1000,
    }] as unknown as Awaited<ReturnType<typeof whereQuery>>);

    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${jwt}` },
        query: { id: "01HSESSION" },
        body: JSON.stringify({ title: "新" }),
      }),
    );
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("FORBIDDEN");
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

  it("405: POST method → METHOD_NOT_ALLOWED", async () => {
    const res = await main(makeEvent({ method: "POST" }));
    expect(res.statusCode).toBe(405);
  });

  it("title trimmed: '  新标题  ' → title='新标题'", async () => {
    const jwt = await makeJwt("01HUSER");
    vi.mocked(whereQuery).mockResolvedValue([{
      _id: "01HSESSION",
      id: "01HSESSION",
      userId: "01HUSER",
      title: "旧",
      messages: [],
      createdAt: 1000,
      updatedAt: 1000,
    }] as unknown as Awaited<ReturnType<typeof whereQuery>>);
    vi.mocked(update).mockResolvedValue(undefined);

    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${jwt}` },
        query: { id: "01HSESSION" },
        body: JSON.stringify({ title: "  新标题  " }),
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.title).toBe("新标题");
    expect(update).toHaveBeenCalledWith(
      "chat_session",
      "01HSESSION",
      expect.objectContaining({ title: "新标题" }),
    );
  });
});