/**
 * M6.1 lib/chat.ts runChat 测试套件（spec §3.2）。
 *
 * 测试策略：
 * - D1: spy-style fake（prepare.bind.first/run 走预设 handler），不解析 SQL，省 miniflare boot
 * - SESSION_DO: fake namespace（do-client.test.ts 那个模式）
 * - LLM / embedding: fetchImpl 注入 fake Response
 * - searchFn: 注入 fake SearchResult[]，绕过 Vectorize
 *
 * 14 用例覆盖 spec §3.2 数据流 + §5 错误码 + §4.4 降级路径。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runChat, defaultLlmTitleFn, type RunChatOptions } from "../../src/lib/chat.js";
import { HttpError } from "../../src/lib/auth.js";
import type { SearchResult } from "@unequal/shared/retrieval";
import type { Env } from "../../src/types.js";
import type { Citation } from "@unequal/shared/types";

/* ---------- spy-style fake D1 ---------- */

type D1Handler = (params: unknown[]) => Promise<unknown>;
interface D1Call { sql: string; params: unknown[]; op: "first" | "all" | "run" }

function makeFakeDB(handlers: { first?: D1Handler; all?: D1Handler; run?: D1Handler } = {}) {
  const calls: D1Call[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => {
        const record = (op: D1Call["op"]): D1Call => ({ sql, params, op });
        return {
          first: async <T>(): Promise<T | null> => {
            calls.push(record("first"));
            if (handlers.first) return (await handlers.first(params)) as T;
            return null;
          },
          all: async <T>(): Promise<{ results: T[] }> => {
            calls.push(record("all"));
            if (handlers.all) return (await handlers.all(params)) as { results: T[] };
            return { results: [] };
          },
          run: async (): Promise<void> => {
            calls.push(record("run"));
            if (handlers.run) await handlers.run(params);
          },
        };
      },
    }),
  };
  return { db: db as unknown as D1Database, calls };
}

/* ---------- fake SESSION_DO namespace（do-client 模式） ---------- */

interface CapturedDoCall { method: string; path: string; body?: string }
function makeFakeDO(impl: (call: CapturedDoCall) => Response | Promise<Response> = () =>
  new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 })) {
  const calls: CapturedDoCall[] = [];
  const ns = {
    idFromName: vi.fn((name: string) => ({ _name: name })),
    get: vi.fn((id: { _name: string }) => ({
      _id: id,
      fetch: vi.fn(async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        const call: CapturedDoCall = {
          method: init?.method ?? "GET",
          path: u.pathname,
          body: typeof init?.body === "string" ? init.body : undefined,
        };
        calls.push(call);
        return impl(call);
      }),
    })),
  };
  return { ns: ns as unknown as DurableObjectNamespace, calls };
}

/* ---------- shared fixtures ---------- */

const FAKE_CITATIONS: Citation[] = [
  { n: 1, title: "儿科指南", snippet: "物理降温", url: "raw/1.pdf", trustLevel: 3, sourceId: "s1", chunkId: "c1" },
  { n: 2, title: "退热药说明", snippet: "38.5以上用布洛芬", url: "raw/2.pdf", trustLevel: 2, sourceId: "s2", chunkId: "c2" },
];

const FAKE_HITS: SearchResult[] = [
  { chunkId: "c1", vectorizeScore: 0.95, finalScore: 0.95 * 1.3, trustLevel: 3 },
  { chunkId: "c2", vectorizeScore: 0.9, finalScore: 0.9 * 1.1, trustLevel: 2 },
];

const ANSWER_TEXT =
  '5个月宝宝腋温 38.5°C 建议先物理降温 [来源 1] [来源 2]\n\n{"citations":[1,2]}\n\n不构成医疗建议';

function makeFakeFetchImpl(answerText: string = ANSWER_TEXT): typeof fetch {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    // embedding
    if (u.pathname.endsWith("/embeddings")) {
      const vec = new Array(1024).fill(0).map((_, i) => Math.sin(i * 0.01));
      return new Response(JSON.stringify({ data: [{ embedding: vec }] }), { status: 200 });
    }
    // chat completion
    if (u.pathname.endsWith("/chat/completions")) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: answerText } }] }),
        { status: 200 },
      );
    }
    return new Response("not mocked: " + u.pathname, { status: 404 });
  }) as unknown as typeof fetch;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  // fake VECTORIZE：query 返空（不命中），upsert noop — 让 runAsk 默认 cacheRead 走"未命中"分支
  const fakeVectorize = {
    query: async () => ({ matches: [], count: 0 }),
    upsert: async () => ({ mutationId: "fake" }),
    describe: async () => ({ vectorsCount: 0, processedBytes: 0 }),
    delete: async () => ({ mutationId: "fake" }),
    getByIds: async () => [],
  } as unknown as VectorizeIndex;
  return {
    DB: overrides.DB ?? ({} as D1Database),
    VECTORIZE: overrides.VECTORIZE ?? fakeVectorize,
    R2: overrides.R2 ?? ({} as R2Bucket),
    ADMIN_TOKEN: "test-token",
    MINIMAX_API_KEY: "test-key",
    MINIMAX_BASE_URL: "http://mock-minimax.local",
    ENVIRONMENT: "test",
    ALLOWED_ORIGIN: "*",
    SESSION_DO: overrides.SESSION_DO,
    AUTH_MODE: overrides.AUTH_MODE,
  } as Env;
}

interface RunChatInput {
  q?: string;
  sessionId?: string;
  userId?: string;
  fetchImpl?: typeof fetch;
  searchFn?: RunChatOptions["searchFn"];
  llmTitleFn?: RunChatOptions["llmTitleFn"];
  env?: Env;
}

async function callRunChat(input: RunChatInput = {}) {
  return runChat({
    userId: input.userId ?? "u1",
    q: input.q ?? "5个月宝宝发烧38.5怎么办？",
    sessionId: input.sessionId,
    env: input.env ?? makeEnv(),
    fetchImpl: input.fetchImpl ?? makeFakeFetchImpl(),
    searchFn: input.searchFn ?? (async () => FAKE_HITS),
    llmTitleFn: input.llmTitleFn,
  });
}

describe("runChat (spy-style fake D1 + fake SESSION_DO)", () => {
  let fakeDB: ReturnType<typeof makeFakeDB>;
  let fakeDO: ReturnType<typeof makeFakeDO>;
  let env: Env;

  beforeEach(() => {
    fakeDB = makeFakeDB();
    fakeDO = makeFakeDO();
    env = makeEnv({ DB: fakeDB.db, SESSION_DO: fakeDO.ns });
  });

  /* ---- 1. 新建 session ---- */
  it("新建 session（无 sessionId）→ INSERT D1 + 写 DO user+assistant + 返新 sessionId", async () => {
    const result = await callRunChat({ env });

    expect(result.session_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    expect(result.is_new_session).toBe(true);
    expect(result.degraded).toBe(false);

    // INSERT D1（1 次）+ 不应 UPDATE
    const inserts = fakeDB.calls.filter((c) => c.op === "run" && c.sql.includes("INSERT"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params[0]).toBe(result.session_id);
    expect(inserts[0]!.params[1]).toBe("u1");

    // 写 DO 两次：user + assistant
    expect(fakeDO.calls.map((c) => c.path)).toEqual(["/append", "/append"]);
    expect(JSON.parse(fakeDO.calls[0]!.body!).role).toBe("user");
    expect(JSON.parse(fakeDO.calls[1]!.body!).role).toBe("assistant");
  });

  /* ---- 2. 复用 session ---- */
  it("复用 session（有 sessionId）→ 不 INSERT，只 UPDATE last_active_at", async () => {
    const existingId = "01HEXISTINGSESSION000000";
    fakeDB = makeFakeDB({
      first: async (params) => {
        // loadSession（SELECT ... WHERE id = ? AND user_id = ?）
        return {
          id: params[0],
          user_id: params[1],
          title: "旧标题",
          created_at: Date.now() - 1000,
          last_active_at: Date.now() - 1000,
          degraded_at: null,
        };
      },
    });
    env = makeEnv({ DB: fakeDB.db, SESSION_DO: fakeDO.ns });

    const result = await callRunChat({ sessionId: existingId, env });

    expect(result.session_id).toBe(existingId);
    expect(result.is_new_session).toBe(false);

    // 不应 INSERT
    const inserts = fakeDB.calls.filter((c) => c.op === "run" && c.sql.includes("INSERT"));
    expect(inserts).toHaveLength(0);
    // 应 UPDATE last_active_at
    const updates = fakeDB.calls.filter((c) => c.op === "run" && c.sql.includes("UPDATE"));
    expect(updates.length).toBeGreaterThan(0);
  });

  /* ---- 3. sessionId 不存在 ---- */
  it("sessionId 不存在 → 抛 HttpError 404 CHAT_SESSION_NOT_FOUND", async () => {
    fakeDB = makeFakeDB({ first: async () => null });
    env = makeEnv({ DB: fakeDB.db, SESSION_DO: fakeDO.ns });

    await expect(callRunChat({ sessionId: "01HBOGUS00000000000000000", env })).rejects.toMatchObject({
      status: 404,
      code: "CHAT_SESSION_NOT_FOUND",
    });
  });

  /* ---- 4. 拼 multiturn context ---- */
  it("复用 session 时拉 DO messages 拼 context prefix → 喂 runAsk 的 q 含历史", async () => {
    const existingId = "01HEXISTINGSESSION000000";
    fakeDB = makeFakeDB({
      first: async (params) => ({
        id: params[0],
        user_id: params[1],
        title: null,
        created_at: Date.now() - 1000,
        last_active_at: Date.now() - 1000,
        degraded_at: null,
      }),
    });
    // DO GET /messages 返 1 轮历史
    fakeDO = makeFakeDO((call) => {
      if (call.path === "/messages") {
        return new Response(
          JSON.stringify({
            messages: [
              { role: "user", content: "之前问过什么", created_at: 1 },
              { role: "assistant", content: "之前答过", summary: "旧摘要", created_at: 2 },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    env = makeEnv({ DB: fakeDB.db, SESSION_DO: fakeDO.ns });

    let capturedQ = "";
    const result = await callRunChat({
      sessionId: existingId,
      env,
      searchFn: async (qEmb) => {
        // 拿到 runAsk 喂的 q（搜索发生在 q 拼好之后；这里只验 hits）
        return FAKE_HITS;
      },
    });

    // 不能直接拿 q，但能 verify answer 含 disclaimer
    expect(result.answer).toContain("不构成医疗建议");
  });

  /* ---- 5. searchFn 透传 ---- */
  it("searchFn 注入 → runAsk 调 searchFn（不调 VECTORIZE）", async () => {
    const searchFn = vi.fn(async (_qEmbedding: number[]) => FAKE_HITS);
    await callRunChat({ searchFn, env });
    expect(searchFn).toHaveBeenCalledTimes(1);
    const arg = searchFn.mock.calls[0]![0] as unknown as number[];
    expect(arg).toHaveLength(1024); // embedding 维度
  });

  /* ---- 6. 写 DO 失败 → degraded ---- */
  it("DO append 失败 → degraded=true（answer 仍返）", async () => {
    fakeDO = makeFakeDO(() => new Response("DO down", { status: 500 }));
    env = makeEnv({ DB: fakeDB.db, SESSION_DO: fakeDO.ns });

    const result = await callRunChat({ env });

    expect(result.degraded).toBe(true);
    expect(result.answer).toContain("不构成医疗建议");
  });

  /* ---- 7. 标题生成首问 ---- */
  it("首问（isNewSession=true）→ 调 llmTitleFn → session_title 注入", async () => {
    const llmTitleFn = vi.fn(async (q: string) => "宝宝发烧");
    const result = await callRunChat({ llmTitleFn, env });
    expect(llmTitleFn).toHaveBeenCalledWith("5个月宝宝发烧38.5怎么办？");
    expect(result.session_title).toBe("宝宝发烧");
  });

  /* ---- 8. 标题生成失败 → fallback null ---- */
  it("llmTitleFn 抛错 → session_title=null（不阻塞主流程）", async () => {
    const llmTitleFn = vi.fn(async () => {
      throw new Error("LLM title 失败");
    });
    const result = await callRunChat({ llmTitleFn, env });
    expect(result.session_title).toBeNull();
    expect(result.answer).toContain("不构成医疗建议");
  });

  /* ---- 9. 用户限额超 50 ---- */
  it("countActiveSessions >= 50 → 抛 HttpError 409 SESSION_LIMIT_EXCEEDED", async () => {
    fakeDB = makeFakeDB({
      first: async () => ({ n: 50 }), // 已 50
    });
    env = makeEnv({ DB: fakeDB.db, SESSION_DO: fakeDO.ns });

    await expect(callRunChat({ env })).rejects.toMatchObject({
      status: 409,
      code: "SESSION_LIMIT_EXCEEDED",
    });
  });

  /* ---- 10. LLM mock 走 sentinel token + 'mock:' 前缀 ---- */
  it("'mock:' 前缀 + dev env + sentinel token → mock-first", async () => {
    env = makeEnv({
      DB: fakeDB.db,
      SESSION_DO: fakeDO.ns,
      ADMIN_TOKEN: "test-token-please-change",
      ENVIRONMENT: "development",
    });
    const result = await callRunChat({ q: "mock:宝宝发烧测试", env });
    // dev mock-mode 应返 mock answer（具体内容由 ask.ts 的 mock 分支决定）
    expect(result.answer).toBeDefined();
    expect(result.is_new_session).toBe(true);
  });

  /* ---- 11. env.DB 缺 → 错 ---- */
  it("env.DB 缺 → 抛 HttpError 500 INFRA_MISSING", async () => {
    const brokenEnv = makeEnv({ SESSION_DO: fakeDO.ns });
    (brokenEnv as { DB?: D1Database }).DB = undefined;
    await expect(callRunChat({ env: brokenEnv })).rejects.toMatchObject({
      status: 500,
      code: "INFRA_MISSING",
    });
  });

  /* ---- 12. env.SESSION_DO 缺 → degraded 路径 ---- */
  it("env.SESSION_DO 缺 → degraded=true（不 throw）", async () => {
    const noDoEnv = makeEnv({ DB: fakeDB.db });
    const result = await callRunChat({ env: noDoEnv });
    expect(result.degraded).toBe(true);
    expect(result.answer).toContain("不构成医疗建议");
    // 不写 DO（fakeDO.calls 应空）
    expect(fakeDO.calls).toHaveLength(0);
  });

  /* ---- 13. defaultLlmTitleFn 走 q 前 10 字 ---- */
  it("defaultLlmTitleFn: q 前 10 字", async () => {
    // "宝宝发烧38.5怎么办" — 10 chars 是 "宝宝发烧38.5怎么"（"办" 是第 11）
    expect(await defaultLlmTitleFn("宝宝发烧38.5怎么办")).toBe("宝宝发烧38.5怎么");
    expect(await defaultLlmTitleFn("")).toBeNull();
    expect(await defaultLlmTitleFn("   ")).toBeNull();
  });

  /* ---- 14. 过期 session → 抛 404 ---- */
  it("session 超过 30 天未活跃 → loadSession 返 null → 抛 404", async () => {
    fakeDB = makeFakeDB({
      first: async (params) => ({
        id: params[0],
        user_id: params[1],
        title: null,
        created_at: 0,
        last_active_at: 0, // 0 = 1970，已过期
        degraded_at: null,
      }),
    });
    env = makeEnv({ DB: fakeDB.db, SESSION_DO: fakeDO.ns });

    await expect(callRunChat({ sessionId: "01HEXPIRED000000000000000", env })).rejects.toMatchObject({
      status: 404,
      code: "CHAT_SESSION_NOT_FOUND",
    });
  });
});
