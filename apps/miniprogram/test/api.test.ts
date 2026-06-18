/**
 * CP-7-A 7 caller typed wrapper 测试（spec §7.2 / plan Task 3）。
 *
 * Mock-first：所有 caller 走 cloudCall<T>，测试用 __setCloudCallImpl 注入 fakeFn。
 * 不再依赖 fetchImpl + globalThis.wx.request。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ask,
  chat,
  listSessions,
  renameSession,
  deleteSession,
  adminLogin,
  updateNickname,
} from "../lib/api.js";
import { __setJwtStorageImpl } from "../lib/chat-storage.js";
import {
  ApiError,
  __setCloudCallImpl,
  __resetCloudCallImpl,
  __clearInflightRefresh,
  type CloudCallFn,
} from "../lib/cloud-call.js";

let mockCloudCall: ReturnType<typeof vi.fn>;
let storage: Record<string, string>;

beforeEach(() => {
  __clearInflightRefresh();
  __resetCloudCallImpl();
  storage = {};
  __setJwtStorageImpl(
    (k) => storage[k] ?? "",
    (k, v) => { storage[k] = v; },
  );
  mockCloudCall = vi.fn();
  __setCloudCallImpl(mockCloudCall as unknown as CloudCallFn);
});

afterEach(() => {
  vi.restoreAllMocks();
  __clearInflightRefresh();
  __resetCloudCallImpl();
});

describe("ask()", () => {
  const happy = {
    answer: "5个月宝宝发烧 38.5 [来源 1]",
    disclaimer: "不构成医疗建议",
    citations: [{ n: 1, title: "儿科指南", snippet: "...", url: "raw/aap.pdf", trustLevel: 3, sourceId: "01H", chunkId: "01H" }],
    cached: false,
  };

  it("happy: cloudCall POST /api-ask → return typed body", async () => {
    mockCloudCall.mockResolvedValue({ statusCode: 200, body: happy });
    const res = await ask("5个月宝宝发烧");
    expect(res.citations.length).toBe(1);
    expect(res.cached).toBe(false);
    expect(mockCloudCall).toHaveBeenCalledTimes(1);
    const callArg = mockCloudCall.mock.calls[0][0];
    expect(callArg.path).toBe("/api-ask");
    expect(callArg.httpMethod).toBe("POST");
    expect(callArg.body).toEqual({ q: "5个月宝宝发烧" });
  });

  it("storage 有 jwt → cloudCall 拿到 jwt", async () => {
    storage["unequal:jwt"] = "stored_jwt";
    mockCloudCall.mockResolvedValue({ statusCode: 200, body: happy });
    await ask("test");
    const callArg = mockCloudCall.mock.calls[0][0];
    expect(callArg.jwt).toBe("stored_jwt");
  });

  it("storage 无 jwt → cloudCall 不传 jwt", async () => {
    mockCloudCall.mockResolvedValue({ statusCode: 200, body: happy });
    await ask("test");
    const callArg = mockCloudCall.mock.calls[0][0];
    expect(callArg.jwt).toBeUndefined();
  });
});

describe("chat()", () => {
  const happy = {
    answer: "宝宝发烧 38.5",
    disclaimer: "不构成医疗建议",
    citations: [{ n: 1, title: "儿科指南", trust_level: 3, chunk_id: "c1" }],
    session_id: "01HNEWULIDSESSION000000000",
    session_title: "宝宝发烧",
    is_new_session: true,
    cached: false,
    degraded: false,
  };

  it("happy: 无 session_id → cloudCall POST /api-chat", async () => {
    mockCloudCall.mockResolvedValue({ statusCode: 200, body: happy });
    const res = await chat({ q: "5个月宝宝发烧" });
    expect(res.session_id).toBe("01HNEWULIDSESSION000000000");
    expect(res.is_new_session).toBe(true);
    const callArg = mockCloudCall.mock.calls[0][0];
    expect(callArg.path).toBe("/api-chat");
    expect(callArg.httpMethod).toBe("POST");
    expect(callArg.body).toEqual({ q: "5个月宝宝发烧" });
  });

  it("带 session_id → body 含 session_id", async () => {
    mockCloudCall.mockResolvedValue({ statusCode: 200, body: { ...happy, session_id: "01HEXIST", is_new_session: false } });
    await chat({ q: "那 38.5 以下呢？", session_id: "01HEXIST" });
    const callArg = mockCloudCall.mock.calls[0][0];
    expect(callArg.body).toEqual({ q: "那 38.5 以下呢？", session_id: "01HEXIST" });
  });
});

describe("listSessions()", () => {
  it("GET /api-sessions-list → 返 sessions[]", async () => {
    const sample = {
      sessions: [
        { id: "01HAAA1", title: "宝宝发烧", messageCount: 2, createdAt: 100, updatedAt: 200 },
        { id: "01HAAA2", title: "辅食添加", messageCount: 4, createdAt: 50, updatedAt: 150 },
      ],
    };
    mockCloudCall.mockResolvedValue({ statusCode: 200, body: sample });
    const res = await listSessions();
    expect(res.sessions).toHaveLength(2);
    expect(res.sessions[0]!.title).toBe("宝宝发烧");
    const callArg = mockCloudCall.mock.calls[0][0];
    expect(callArg.path).toBe("/api-sessions-list");
    expect(callArg.httpMethod).toBe("GET");
  });
});

describe("renameSession() / deleteSession()", () => {
  it("renameSession: PATCH /sessions/:id → return ok", async () => {
    mockCloudCall.mockResolvedValue({ statusCode: 200, body: null });
    await renameSession("01HSESSION", "新标题");
    const callArg = mockCloudCall.mock.calls[0][0];
    expect(callArg.path).toBe("/sessions/01HSESSION");
    expect(callArg.httpMethod).toBe("PATCH");
    expect(callArg.body).toEqual({ title: "新标题" });
  });

  it("deleteSession: DELETE /api-sessions-delete/:id → return ok", async () => {
    mockCloudCall.mockResolvedValue({ statusCode: 200, body: null });
    await deleteSession("01HSESSION");
    const callArg = mockCloudCall.mock.calls[0][0];
    expect(callArg.path).toBe("/api-sessions-delete/01HSESSION");
    expect(callArg.httpMethod).toBe("DELETE");
  });
});

describe("updateNickname()", () => {
  it("PATCH /user/nickname → return ok", async () => {
    mockCloudCall.mockResolvedValue({ statusCode: 200, body: { nickname: "张三" } });
    await updateNickname("张三");
    const callArg = mockCloudCall.mock.calls[0][0];
    expect(callArg.path).toBe("/user/nickname");
    expect(callArg.httpMethod).toBe("PATCH");
    expect(callArg.body).toEqual({ nickname: "张三" });
  });
});

describe("adminLogin()", () => {
  it("POST /api-auth-admin-login → 返 admin jwt", async () => {
    mockCloudCall.mockResolvedValue({
      statusCode: 200,
      body: { token: "eyJ.admin.jwt", user_id: "01H0000000000000000000000", is_admin: true, expires_in: 86400 },
    });
    const res = await adminLogin("test-token-please-change");
    expect(res.is_admin).toBe(true);
    expect(res.token).toBe("eyJ.admin.jwt");
    const callArg = mockCloudCall.mock.calls[0][0];
    expect(callArg.path).toBe("/api-auth-admin-login");
    expect(callArg.httpMethod).toBe("POST");
    expect(callArg.body).toEqual({ admin_token: "test-token-please-change" });
    // adminLogin 不依赖 jwt（无 jwt header）
    expect(callArg.jwt).toBeUndefined();
  });
});

describe("caller 抛 ApiError 透传", () => {
  it("cloudCall throw ApiError → caller rethrow", async () => {
    mockCloudCall.mockRejectedValue(new ApiError(404, "NOT_FOUND", "session not found"));
    await expect(listSessions()).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
      message: "session not found",
    });
  });

  it("5xx → caller rethrow ApiError", async () => {
    mockCloudCall.mockRejectedValue(new ApiError(500, "INTERNAL", "boom"));
    await expect(chat({ q: "x" })).rejects.toMatchObject({ statusCode: 500 });
  });
});

/* ---------- CP-7-A 静态验证：7 caller 全调 cloudCall ---------- */
describe("7 caller 全调 cloudCall (CP-7-A 静态验证)", () => {
  it("7 个 caller 体内都调 cloudCall（不再走 fetchWithRefresh / getFetch）", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const apiPath = path.resolve(__dirname, "../lib/api.ts");
    const src = readFileSync(apiPath, "utf8");

    const fnNames = ["ask", "chat", "listSessions", "renameSession", "deleteSession", "updateNickname", "adminLogin"];
    for (const fn of fnNames) {
      const fnMatch = src.match(new RegExp(`export async function ${fn}\\b[\\s\\S]*?\\n\\}`));
      expect(fnMatch, `${fn} function body not found`).not.toBeNull();
      const body = fnMatch![0];
      expect(body.includes("cloudCall"), `${fn} should call cloudCall`).toBe(true);
    }
    // dead code 全删（精确匹配 function 定义，非注释字符串）
    expect(src).not.toMatch(/^function wxRequestAsFetch\b|^export async function fetchWithRefresh\b|^export function __clearInflightEnsureJwt\b|^function getFetch\b|^function buildHeaders\b|^const inflightEnsureJwt\b/m);
  });
});