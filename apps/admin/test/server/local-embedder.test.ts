/**
 * LocalEmbedder 单元测试（mock openai 模块）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock openai 模块
const mockCreate = vi.fn();
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      embeddings = { create: mockCreate };
      constructor(_opts: any) {}
    },
    APIConnectionError: class APIConnectionError extends Error {
      constructor(msg: string) { super(msg); this.name = "APIConnectionError"; }
    },
  };
});

import { LocalEmbedder, EmbedError, EXPECTED_DIM } from "../../server/local-embedder.js";

describe("LocalEmbedder (CP-7-C T6)", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("happy: 3 texts → 3×1536 矩阵", async () => {
    mockCreate.mockResolvedValue({
      data: [
        { embedding: new Array(EXPECTED_DIM).fill(0.1), index: 0 },
        { embedding: new Array(EXPECTED_DIM).fill(0.2), index: 1 },
        { embedding: new Array(EXPECTED_DIM).fill(0.3), index: 2 },
      ],
    });
    const emb = new LocalEmbedder();
    const r = await emb.embedBatch(["a", "b", "c"]);
    expect(r).toHaveLength(3);
    expect(r[0]).toHaveLength(EXPECTED_DIM);
    expect(r[0]?.[0]).toBe(0.1);
  });

  it("空数组 → 返空（不调 SDK）", async () => {
    const emb = new LocalEmbedder();
    const r = await emb.embedBatch([]);
    expect(r).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("维度不匹配 (1024) → EmbedError (DimensionMismatch)", async () => {
    mockCreate.mockResolvedValue({
      data: [{ embedding: new Array(1024).fill(0.1), index: 0 }],
    });
    const emb = new LocalEmbedder();
    try {
      await emb.embedBatch(["a"]);
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbedError);
      expect((err as EmbedError).code).toBe("DimensionMismatch");
    }
  });

  it("OMLX 不可用 (APIConnectionError) → EmbedError (OMLX_Unavailable)", async () => {
    const openai = await import("openai");
    mockCreate.mockRejectedValue(new (openai as any).APIConnectionError("ECONNREFUSED 127.0.0.1:11434"));
    const emb = new LocalEmbedder();
    try {
      await emb.embedBatch(["a"]);
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbedError);
      expect((err as EmbedError).code).toBe("OMLX_Unavailable");
    }
  });

  it("OOM (message 含 'out of memory') → EmbedError (OOM)", async () => {
    mockCreate.mockRejectedValue(new Error("server returned 500: out of memory while embedding"));
    const emb = new LocalEmbedder();
    try {
      await emb.embedBatch(["a"]);
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbedError);
      expect((err as EmbedError).code).toBe("OOM");
    }
  });

  it("未知错误 (401) → EmbedError (Unknown)", async () => {
    mockCreate.mockRejectedValue(new Error("401 unauthorized"));
    const emb = new LocalEmbedder();
    try {
      await emb.embedBatch(["a"]);
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbedError);
      expect((err as EmbedError).code).toBe("Unknown");
    }
  });
});
