import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getSessionMessages,
  appendMessage,
  resetSession,
  type SessionDOEnv,
} from "../../src/lib/do-client.js";

/**
 * Fake DO namespace：用 vi.fn() 替代 idFromName + get，让单元测不依赖 workerd
 * （spec §6.2 提到 vi.mock('cloudflare:durable-objects') 在 vitest 不稳，
 *  所以走 fake namespace 模式 — 跟 ask.ts 走 fetchImpl 注入一个思路）。
 *
 * stub.fetch = fetchImpl 直接引用（生产 stub.fetch 行为就是转发到 DO fetch，
 * 测试里我们转发到 fetchImpl），do-client 调 stub.fetch(url, init) 实际就是
 * fetchImpl(url, init)，让 fetchImpl 注入能控返回。
 */
function makeFakeNamespace(fetchImpl: typeof fetch) {
  return {
    idFromName: vi.fn((name: string) => ({ _name: name })),
    get: vi.fn((id: { _name: string }) => ({
      _id: id,
      fetch: fetchImpl,
    })),
  };
}

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function captureFetch(): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("do-client (fake namespace + fetchImpl injection)", () => {
  let ns: ReturnType<typeof makeFakeNamespace>;
  let env: SessionDOEnv;

  beforeEach(() => {
    const { fetchImpl, calls } = captureFetch();
    ns = makeFakeNamespace(fetchImpl);
    env = { SESSION_DO: ns as unknown as DurableObjectNamespace, fetchImpl };
    // stash calls on env for assertion
    (env as unknown as { __calls: CapturedCall[] }).__calls = calls;
  });

  it("getSessionMessages: idFromName('session:u1:s1') + GET /messages → 返 parse 后的 messages", async () => {
    const fakeMessages = [
      { role: "user", content: "你好", created_at: 1 },
      { role: "assistant", content: "你好!", summary: "greet", created_at: 2 },
    ];
    (env.fetchImpl as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: fakeMessages }), { status: 200 }),
    );

    const got = await getSessionMessages(env, "u1", "s1");

    expect(ns.idFromName).toHaveBeenCalledWith("session:u1:s1");
    const stub = ns.get.mock.results[0]!.value as { fetch: ReturnType<typeof vi.fn> };
    expect(stub.fetch).toHaveBeenCalledTimes(1);
    const callUrl = (stub.fetch.mock.calls[0] as [string, RequestInit?])[0];
    expect(callUrl).toBe("https://do/messages");
    expect(got).toEqual(fakeMessages);
  });

  it("appendMessage: POST /append with JSON body → 返 {id, count}", async () => {
    (env.fetchImpl as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, id: "msg-1", count: 3 }), { status: 200 }),
    );

    const got = await appendMessage(env, "u1", "s1", {
      role: "user",
      content: "那 38.5 以下呢？",
    });

    expect(ns.idFromName).toHaveBeenCalledWith("session:u1:s1");
    const stub = ns.get.mock.results[0]!.value as { fetch: ReturnType<typeof vi.fn> };
    const [callUrl, callInit] = stub.fetch.mock.calls[0] as [string, RequestInit];
    expect(callUrl).toBe("https://do/append");
    expect(callInit.method).toBe("POST");
    expect((callInit.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const sentBody = JSON.parse(callInit.body as string) as {
      role: string;
      content: string;
      summary?: string;
    };
    expect(sentBody).toEqual({ role: "user", content: "那 38.5 以下呢？" });
    expect(got).toEqual({ id: "msg-1", count: 3 });
  });

  it("resetSession: POST /reset → 返 void", async () => {
    (env.fetchImpl as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, count: 0 }), { status: 200 }),
    );

    await expect(resetSession(env, "u1", "s1")).resolves.toBeUndefined();

    expect(ns.idFromName).toHaveBeenCalledWith("session:u1:s1");
    const stub = ns.get.mock.results[0]!.value as { fetch: ReturnType<typeof vi.fn> };
    const [callUrl, callInit] = stub.fetch.mock.calls[0] as [string, RequestInit];
    expect(callUrl).toBe("https://do/reset");
    expect(callInit.method).toBe("POST");
  });

  it("多 user 多 session namespace 隔离（不同 name 不串）", async () => {
    // 用 mockImplementation 每次新建 Response（mockResolvedValue 复用同一个 body 会被 .json() 二次消费报 "Body is unusable"）
    (env.fetchImpl as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );

    await getSessionMessages(env, "alice", "s1");
    await getSessionMessages(env, "alice", "s2");
    await getSessionMessages(env, "bob", "s1");
    await getSessionMessages(env, "bob", "s2");

    const names = ns.idFromName.mock.calls.map((c) => c[0]);
    expect(names).toEqual([
      "session:alice:s1",
      "session:alice:s2",
      "session:bob:s1",
      "session:bob:s2",
    ]);
    // 每次都新拿 stub — 4 次 get 调用
    expect(ns.get).toHaveBeenCalledTimes(4);
  });
});
