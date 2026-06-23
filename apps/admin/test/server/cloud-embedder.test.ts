/**
 * CloudEmbedder 单元测试（mock fetch）
 */

import { describe, it, expect, vi } from "vitest";
import { CloudEmbedder, type CloudEmbedderOptions } from "@unequal/local-llm";

function makeMockFetch(responses: Array<{ status: number; body?: unknown }>): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[i++];
    if (!r) throw new Error(`unexpected call #${i}`);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
}

describe("CloudEmbedder (CP-7-C T72)", () => {
  it("happy: 200 → 1536 维 vectors (MiniMax {vectors: [...]} schema)", async () => {
    const fetchImpl = makeMockFetch([{
      status: 200,
      body: { vectors: [new Array(1536).fill(0.1), new Array(1536).fill(0.2)] },
    }]);
    const e = new CloudEmbedder({ apiKey: "k", fetchImpl });
    const v = await e.embedBatch(["a", "b"]);
    expect(v).toHaveLength(2);
    expect(v[0]).toHaveLength(1536);
  });

  it("dim 不匹配 → EmbedError (DimensionMismatch)", async () => {
    const fetchImpl = makeMockFetch([{
      status: 200,
      body: { vectors: [new Array(768).fill(0.1)] },
    }]);
    const e = new CloudEmbedder({ apiKey: "k", fetchImpl });
    try {
      await e.embedBatch(["a"]);
      expect.fail("should throw");
    } catch (err: any) {
      expect(err.code).toBe("DimensionMismatch");
    }
  });

  it("401 → EmbedError (OMLX_Unavailable, 沿用 error code)", async () => {
    const fetchImpl = makeMockFetch([{ status: 401 }]);
    const e = new CloudEmbedder({ apiKey: "k", fetchImpl });
    try {
      await e.embedBatch(["a"]);
      expect.fail();
    } catch (err: any) {
      expect(err.code).toBe("OMLX_Unavailable");  // 复用 code 让 orchestrator 走 fallback
    }
  });

  it("500 → EmbedError (Unknown)", async () => {
    const fetchImpl = makeMockFetch([{ status: 500 }]);
    const e = new CloudEmbedder({ apiKey: "k", fetchImpl });
    try {
      await e.embedBatch(["a"]);
      expect.fail();
    } catch (err: any) {
      expect(err.code).toBe("Unknown");
    }
  });

  it("网络错 → EmbedError (OMLX_Unavailable)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as any;
    const e = new CloudEmbedder({ apiKey: "k", fetchImpl });
    try {
      await e.embedBatch(["a"]);
      expect.fail();
    } catch (err: any) {
      expect(err.code).toBe("OMLX_Unavailable");
    }
  });

  it("空数组 → 返空（不调 SDK）", async () => {
    const fetchImpl = vi.fn();
    const e = new CloudEmbedder({ apiKey: "k", fetchImpl: fetchImpl as any });
    const v = await e.embedBatch([]);
    expect(v).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // zhenjie5: MiniMax embo-01 真实 schema 校验（v1 误用 OpenAI 格式导致 embed 全错）
  // request: { model, type: "query", texts: [...] }
  // response: { vectors: number[][] }
  it("MiniMax embo-01 schema: 请求用 texts+type, 响应取 vectors", async () => {
    let capturedBody: any = null;
    let capturedHeaders: any = null;
    const fetchImpl = (async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      capturedHeaders = init.headers;
      return new Response(JSON.stringify({
        vectors: [new Array(1536).fill(0.5), new Array(1536).fill(0.7)],
      }), { status: 200 });
    }) as typeof fetch;
    const e = new CloudEmbedder({ apiKey: "sk-test-key", fetchImpl });
    const v = await e.embedBatch(["hello", "world"]);
    expect(capturedBody.model).toBe("embo-01");
    expect(capturedBody.type).toBe("query");
    expect(capturedBody.texts).toEqual(["hello", "world"]);
    expect(capturedBody.input).toBeUndefined(); // 不能含 OpenAI 字段
    expect(capturedHeaders.Authorization).toBe("Bearer sk-test-key");
    expect(v).toHaveLength(2);
    expect(v[0]).toHaveLength(1536);
  });

  // zhenjie5: 大批 chunks (1520) 必须分批，否则 MiniMax 返 null vectors
  it("大批 chunks (250) → 自动分批 100/batch", async () => {
    let callCount = 0;
    const sizes: number[] = [];
    const fetchImpl = (async (_url: string, init: any) => {
      callCount++;
      const body = JSON.parse(init.body);
      sizes.push(body.texts.length);
      // 模拟 MiniMax: vectors 长度 == 请求 texts 长度
      const n = body.texts.length;
      return new Response(JSON.stringify({
        vectors: Array.from({ length: n }, () => new Array(1536).fill(0.1)),
      }), { status: 200 });
    }) as typeof fetch;
    const e = new CloudEmbedder({ apiKey: "k", fetchImpl });
    const texts = Array.from({ length: 250 }, (_, i) => `text-${i}`);
    const v = await e.embed(texts);
    expect(callCount).toBe(3); // 100 + 100 + 50
    expect(sizes).toEqual([100, 100, 50]);
    expect(v).toHaveLength(250);
  });

  // zhenjie5: MiniMax 偶尔返 null vectors（超限/超时），应抛 EmbedError
  it("vectors=null → EmbedError Unknown", async () => {
    const fetchImpl = makeMockFetch([{ status: 200, body: { vectors: null } }]);
    const e = new CloudEmbedder({ apiKey: "k", fetchImpl });
    try {
      await e.embedBatch(["a"]);
      expect.fail("should throw");
    } catch (err: any) {
      expect(err.code).toBe("Unknown");
      expect(err.message).toMatch(/null vectors/);
    }
  });
});