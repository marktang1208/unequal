import { describe, it, expect, vi, beforeEach } from "vitest";
import { ask, chat, listSessions, renameSession, deleteSession, adminLogin } from "../lib/api.js";
import { __setJwtStorageImpl } from "../lib/chat-storage.js";
import type { AskResponse, ChatResponse, SessionsListResponse } from "../lib/types.js";

// Mock wx 全局（miniflare/node 没 wx；chat-storage.ts 默认 impl 调 wx.getStorageSync）
(globalThis as { wx?: unknown }).wx = {
  login: vi.fn(),
  request: vi.fn(),
  getStorageSync: vi.fn(),
  setStorageSync: vi.fn(),
  removeStorageSync: vi.fn(),
};

describe("ask()", () => {
  const happy: AskResponse = {
    answer: "5个月宝宝发烧 38.5 [来源 1] [来源 3]\n\n以上信息...不构成医疗建议。",
    disclaimer: "以上信息...不构成医疗建议。具体情况请咨询专业儿科医生。",
    citations: [
      { n: 1, title: "美国儿科学会育儿百科", snippet: "三个月以下...", url: "raw/.../aap.pdf", trustLevel: 3, sourceId: "01H...", chunkId: "01H..." },
      { n: 3, title: "崔玉涛", snippet: "婴儿发烧...", url: "raw/.../cui.html", trustLevel: 2, sourceId: "01H...", chunkId: "01H..." },
    ],
    cached: false,
  };

  it("happy: 200 + JSON → 返回 AskResponse", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      expect(input).toBe("http://localhost:8787/ask");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ q: "test" });
      return new Response(JSON.stringify(happy), { status: 200, headers: { "content-type": "application/json" } });
    };

    const res = await ask("test", { fetchImpl: fetchMock });
    expect(res.citations.length).toBe(2);
    expect(res.citations[0]?.n).toBe(1);
    expect(res.cached).toBe(false);
  });

  it("带 token: Authorization header 设置正确", async () => {
    let capturedAuth: string | null = null;
    const fetchMock: typeof fetch = async (input, init) => {
      capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
      return new Response(JSON.stringify(happy), { status: 200 });
    };

    await ask("test", { token: "abc123", fetchImpl: fetchMock });
    expect(capturedAuth).toBe("Bearer abc123");
  });

  it("400: 抛 Error 含状态码 + error 字段", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "Missing or empty 'q' field" }), { status: 400 });

    await expect(ask("", { fetchImpl: fetchMock })).rejects.toThrow(/400.*Missing or empty/);
  });

  it("500: 抛 Error 含 'internal' 字段", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "internal", detail: "boom" }), { status: 500 });

    await expect(ask("test", { fetchImpl: fetchMock })).rejects.toThrow(/500.*internal/);
  });
});

/* ---------- M6.1 /chat + /sessions 4 个 mock 用例 ---------- */

const SAMPLE_CHAT: ChatResponse = {
  answer: "宝宝发烧 38.5 物理降温 [来源 1]\n\n不构成医疗建议。",
  disclaimer: "不构成医疗建议。",
  citations: [{ n: 1, title: "儿科指南", trust_level: 3, chunk_id: "c1" }],
  session_id: "01HNEWULIDSESSION000000000",
  session_title: "宝宝发烧",
  is_new_session: true,
  cached: false,
  degraded: false,
};

describe("chat()", () => {
  it("happy: POST /chat 200 + JSON → 返 ChatResponse（无 session_id → 服务端新建）", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      expect(input).toBe("http://localhost:8787/chat");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init?.body as string);
      expect(body.q).toBe("5个月宝宝发烧");
      expect(body.session_id).toBeUndefined();
      return new Response(JSON.stringify(SAMPLE_CHAT), { status: 200, headers: { "content-type": "application/json" } });
    };
    const res = await chat({ q: "5个月宝宝发烧" }, { fetchImpl: fetchMock });
    expect(res.session_id).toBe("01HNEWULIDSESSION000000000");
    expect(res.is_new_session).toBe(true);
    expect(res.citations[0]?.n).toBe(1);
  });

  it("带 session_id 复用: POST /chat body 含 session_id", async () => {
    let capturedBody: unknown;
    const fetchMock: typeof fetch = async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string);
      const follow: ChatResponse = { ...SAMPLE_CHAT, is_new_session: false, session_id: "01HEXIST00000000000000000" };
      return new Response(JSON.stringify(follow), { status: 200 });
    };
    const res = await chat({ q: "那 38.5 以下呢？", session_id: "01HEXIST00000000000000000" }, { fetchImpl: fetchMock });
    expect((capturedBody as { session_id?: string }).session_id).toBe("01HEXIST00000000000000000");
    expect(res.is_new_session).toBe(false);
  });
});

describe("listSessions()", () => {
  it("GET /sessions 200 → 返 sessions[]", async () => {
    const sample: SessionsListResponse = {
      sessions: [
        { id: "01HAAA00000000000000000001", user_id: "u1", title: "宝宝发烧", created_at: 100, last_active_at: 200, degraded_at: null },
        { id: "01HAAA00000000000000000002", user_id: "u1", title: "辅食添加", created_at: 50, last_active_at: 150, degraded_at: null },
      ],
    };
    const fetchMock: typeof fetch = async (input, init) => {
      expect(input).toBe("http://localhost:8787/sessions");
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify(sample), { status: 200 });
    };
    const res = await listSessions({ fetchImpl: fetchMock });
    expect(res.sessions).toHaveLength(2);
    expect(res.sessions[0]!.title).toBe("宝宝发烧");
  });
});

describe("renameSession() / deleteSession()", () => {
  it("PATCH /sessions/:id 200 → 返 ok", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      expect(input).toBe("http://localhost:8787/sessions/01HSESSIONID000000000000");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init?.body as string)).toEqual({ title: "新标题" });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await expect(renameSession("01HSESSIONID000000000000", "新标题", { fetchImpl: fetchMock })).resolves.toBeUndefined();
  });

  it("DELETE /sessions/:id 200 → 返 ok", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      expect(input).toBe("http://localhost:8787/sessions/01HSESSIONID000000000000");
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await expect(deleteSession("01HSESSIONID000000000000", { fetchImpl: fetchMock })).resolves.toBeUndefined();
  });
});

/* ---------- M6.2 admin login + jwt header injection ---------- */

describe("adminLogin() (miniprogram 端)", () => {
  it("POST /auth/admin-login 200 → 返 { token, user_id, is_admin: true }", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      expect(input).toBe("http://localhost:8787/auth/admin-login");
      expect(JSON.parse(init?.body as string)).toEqual({ admin_token: "test-token-please-change" });
      return new Response(
        JSON.stringify({ token: "eyJ.admin.jwt", user_id: "01H0000000000000000000000", is_admin: true, expires_in: 86400 }),
        { status: 200 },
      );
    };
    const res = await adminLogin("test-token-please-change", { fetchImpl: fetchMock });
    expect(res.is_admin).toBe(true);
    expect(res.token).toBe("eyJ.admin.jwt");
  });
});

describe("ask() 带 jwt（storage 自动注入 Authorization）", () => {
  let storage: Record<string, string> = {};
  beforeEach(() => {
    storage = {};
    __setJwtStorageImpl(
      (k) => storage[k] ?? "",
      (k, v) => { storage[k] = v; },
    );
  });

  it("storage 有 jwt → Authorization header 含 Bearer jwt", async () => {
    storage["unequal:jwt"] = "stored_jwt_token";
    let capturedAuth: string | null = null;
    const fetchMock: typeof fetch = async (_input, init) => {
      capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
      return new Response(
        JSON.stringify({ answer: "ok", disclaimer: "", citations: [], cached: false }),
        { status: 200 },
      );
    };
    await ask("test", { fetchImpl: fetchMock });
    expect(capturedAuth).toBe("Bearer stored_jwt_token");
  });

  it("storage 无 jwt → 无 Authorization header（mock-first 行为）", async () => {
    let capturedAuth: string | null = "placeholder";
    const fetchMock: typeof fetch = async (_input, init) => {
      capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
      return new Response(
        JSON.stringify({ answer: "ok", disclaimer: "", citations: [], cached: false }),
        { status: 200 },
      );
    };
    await ask("test", { fetchImpl: fetchMock });
    expect(capturedAuth).toBeNull();
  });
});

describe("chat() 带 jwt", () => {
  let storage: Record<string, string> = {};
  beforeEach(() => {
    storage = {};
    __setJwtStorageImpl(
      (k) => storage[k] ?? "",
      (k, v) => { storage[k] = v; },
    );
  });

  it("storage 有 jwt → Authorization header 含 Bearer jwt", async () => {
    storage["unequal:jwt"] = "stored_jwt_token";
    let capturedAuth: string | null = null;
    const fetchMock: typeof fetch = async (_input, init) => {
      capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
      return new Response(
        JSON.stringify({
          answer: "ok",
          citations: [],
          session_id: "01H",
          session_title: "t",
          is_new_session: true,
          cached: false,
          degraded: false,
        }),
        { status: 200 },
      );
    };
    await chat({ q: "test" }, { fetchImpl: fetchMock });
    expect(capturedAuth).toBe("Bearer stored_jwt_token");
  });
});

describe("401 from /ask → throw 让 caller 决定（M6.2 暂不重试）", () => {
  it("ask() 401 → throw Error 含 401 + error code", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 });
    await expect(ask("test", { fetchImpl: fetchMock })).rejects.toThrow(/401.*UNAUTHORIZED/);
  });
});
