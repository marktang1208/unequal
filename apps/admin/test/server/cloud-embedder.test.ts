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
  it("happy: 200 → 1536 维 vectors", async () => {
    const fetchImpl = makeMockFetch([{
      status: 200,
      body: { data: [{ embedding: new Array(1536).fill(0.1) }, { embedding: new Array(1536).fill(0.2) }] },
    }]);
    const e = new CloudEmbedder({ apiKey: "k", fetchImpl });
    const v = await e.embedBatch(["a", "b"]);
    expect(v).toHaveLength(2);
    expect(v[0]).toHaveLength(1536);
  });

  it("dim 不匹配 → EmbedError (DimensionMismatch)", async () => {
    const fetchImpl = makeMockFetch([{
      status: 200,
      body: { data: [{ embedding: new Array(768).fill(0.1) }] },
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
});