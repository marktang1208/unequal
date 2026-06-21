/**
 * CloudPusher 单元测试（mock fetch）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CloudPusher, PushError } from "../../server/cloud-pusher.js";

function makeMockFetch(responses: Array<{ status: number; body?: unknown }>): typeof fetch {
  let callIdx = 0;
  return (async (_input: any, _init?: any) => {
    const r = responses[callIdx++];
    if (!r) throw new Error(`unexpected call #${callIdx}`);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("CloudPusher (CP-7-C T8)", () => {
  beforeEach(() => {
    vi.useRealTimers();  // 防止 sleep 卡住
  });

  it("happy: 200 → 返 source_id + document_id", async () => {
    const fetch = makeMockFetch([{ status: 200, body: { source_id: "01KSRC", document_id: "01KDOC" } }]);
    const pusher = new CloudPusher({ fetchImpl: fetch, backoffBase5xxMs: 1, backoffBase429Ms: 1 });
    const r = await pusher.push({
      markdown: "# Test",
      source_meta: { url: "local://a.md", type: "md", trust_level: 1 },
      document_meta: { title: "a.md" },
      chunks: [{ content: "Test", embedding: [0.1], idx: 0, token_count: 4 }],
    });
    expect(r.source_id).toBe("01KSRC");
    expect(r.document_id).toBe("01KDOC");
  });

  it("401 → PushError (AuthError, no retry)", async () => {
    const fetch = makeMockFetch([{ status: 401, body: { error: "UNAUTHORIZED" } }]);
    const pusher = new CloudPusher({ fetchImpl: fetch, backoffBase5xxMs: 1, backoffBase429Ms: 1 });
    try {
      await pusher.push({
        markdown: "x",
        source_meta: { url: "y", type: "md", trust_level: 1 },
        document_meta: { title: "y" },
        chunks: [],
      });
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PushError);
      expect((err as PushError).code).toBe("AuthError");
      expect((err as PushError).retryable).toBe(false);
    }
  });

  it("5xx 重试 2 次（退避 1s/3s）→ 第 3 次 200", async () => {
    vi.useFakeTimers();
    const fetch = makeMockFetch([
      { status: 500 },
      { status: 500 },
      { status: 500 },  // 超过 2 次重试 → 抛
    ]);
    const pusher = new CloudPusher({ fetchImpl: fetch, backoffBase5xxMs: 1, backoffBase429Ms: 1 });
    const result = pusher.push({
      markdown: "x",
      source_meta: { url: "y", type: "md", trust_level: 1 },
      document_meta: { title: "y" },
      chunks: [],
    }).then(
      () => ({ kind: "resolved" as const, value: null }),
      (e) => ({ kind: "rejected" as const, value: e }),
    );
    // 推进时间让重试 sleep 完成
    await vi.runAllTimersAsync();
    const r = await result;
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.value).toBeInstanceOf(PushError);
      expect((r.value as PushError).code).toBe("ServerError");
    }
    vi.useRealTimers();
  });

  it("429 重试 3 次（退避 5s/10s/20s）→ 第 4 次 200", async () => {
    vi.useFakeTimers();
    const fetch = makeMockFetch([
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { status: 429 },  // 超过 3 次重试 → 抛
    ]);
    const pusher = new CloudPusher({ fetchImpl: fetch, backoffBase5xxMs: 1, backoffBase429Ms: 1 });
    const result = pusher.push({
      markdown: "x",
      source_meta: { url: "y", type: "md", trust_level: 1 },
      document_meta: { title: "y" },
      chunks: [],
    }).then(
      () => ({ kind: "resolved" as const, value: null }),
      (e) => ({ kind: "rejected" as const, value: e }),
    );
    await vi.runAllTimersAsync();
    const r = await result;
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.value).toBeInstanceOf(PushError);
      expect((r.value as PushError).code).toBe("RateLimit");
    }
    vi.useRealTimers();
  });

  it("5xx 1 次 + 200 1 次 → 成功（重试 1 次 work）", async () => {
    vi.useFakeTimers();
    const fetch = makeMockFetch([
      { status: 500 },
      { status: 200, body: { source_id: "S1", document_id: "D1" } },
    ]);
    const pusher = new CloudPusher({ fetchImpl: fetch, backoffBase5xxMs: 1, backoffBase429Ms: 1 });
    const promise = pusher.push({
      markdown: "x",
      source_meta: { url: "y", type: "md", trust_level: 1 },
      document_meta: { title: "y" },
      chunks: [],
    });
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(r.source_id).toBe("S1");
    vi.useRealTimers();
  });

  it("网络错误 (fetch reject) → PushError (NetworkError)", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const pusher = new CloudPusher({ fetchImpl: fetch as any, backoffBase5xxMs: 1, backoffBase429Ms: 1 });
    try {
      await pusher.push({
        markdown: "x",
        source_meta: { url: "y", type: "md", trust_level: 1 },
        document_meta: { title: "y" },
        chunks: [],
      });
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PushError);
      expect((err as PushError).code).toBe("NetworkError");
    }
  });

  it("推送前不去重（v1 不做；T8 注释了）", async () => {
    // 简化：不去重，每次都 push
    const fetch = makeMockFetch([{ status: 200, body: { source_id: "S1", document_id: "D1" } }]);
    const pusher = new CloudPusher({ fetchImpl: fetch, backoffBase5xxMs: 1, backoffBase429Ms: 1 });
    await pusher.push({
      markdown: "x",
      source_meta: { url: "y", type: "md", trust_level: 1 },
      document_meta: { title: "y" },
      chunks: [],
    });
    // T8 去重逻辑写到 T9 StatusStore markDone + 推前查 cloud_source_id
    // v1 暂不实现（用户取消 retry 后人工判断）
  });
});
