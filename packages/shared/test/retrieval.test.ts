import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  searchChunks,
  DEFAULT_TRUST_WEIGHTS,
  type ChunkWithEmbedding,
} from "../src/retrieval.js";

describe("cosineSimilarity (CP-6)", () => {
  it("identical vectors → 1.0", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it("orthogonal vectors → 0", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  it("opposite vectors → -1", () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1);
  });

  it("scaled vectors → same similarity", () => {
    expect(cosineSimilarity([2, 0, 0], [5, 0, 0])).toBeCloseTo(1.0);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1.0);
  });

  it("different length → throws", () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow();
  });

  it("zero vector → 0 (not NaN)", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

describe("searchChunks (CP-6 brute-force)", () => {
  const makeChunk = (
    id: string,
    embedding: number[],
    trustLevel: 0 | 1 | 2 | 3 = 0,
  ): ChunkWithEmbedding => ({
    id,
    documentId: `doc-${id}`,
    sourceId: `src-${id}`,
    userId: "user1",
    idx: 0,
    content: `content-${id}`,
    embedding,
    tokenCount: 10,
    trustLevel,
    createdAt: 0,
  });

  const queryVec = [1, 0, 0, 0];

  it("returns top-K sorted by finalScore desc", async () => {
    const chunks: ChunkWithEmbedding[] = [
      makeChunk("low", [0, 1, 0, 0]),
      makeChunk("high", [1, 0, 0, 0]),
      makeChunk("mid", [0.7, 0.7, 0, 0]),
    ];

    const result = await searchChunks({
      fetchChunksByUser: async () => chunks,
      userId: "user1",
      queryVector: queryVec,
      topK: 2,
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.chunkId).toBe("high");
    expect(result[1]?.chunkId).toBe("mid");
    expect(result[0]?.finalScore).toBeGreaterThan(result[1]?.finalScore ?? 0);
  });

  it("trust weighting: trustLevel=3 ranks higher than trustLevel=0 with same vector", async () => {
    const chunks: ChunkWithEmbedding[] = [
      makeChunk("low-trust", [1, 0, 0, 0], 0),
      makeChunk("high-trust", [1, 0, 0, 0], 3),
    ];

    const result = await searchChunks({
      fetchChunksByUser: async () => chunks,
      userId: "user1",
      queryVector: queryVec,
      topK: 2,
    });

    expect(result[0]?.chunkId).toBe("high-trust");
    expect(result[0]?.finalScore).toBeCloseTo(1.3);
    expect(result[1]?.chunkId).toBe("low-trust");
    expect(result[1]?.finalScore).toBeCloseTo(1.0);
  });

  it("score threshold filters low-score chunks", async () => {
    const chunks: ChunkWithEmbedding[] = [
      makeChunk("match", [1, 0, 0, 0]),
      makeChunk("near-match", [0.6, 0.8, 0, 0]),
    ];

    const result = await searchChunks({
      fetchChunksByUser: async () => chunks,
      userId: "user1",
      queryVector: queryVec,
      topK: 5,
      scoreThreshold: 0.7,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.chunkId).toBe("match");
  });

  it("empty chunks → empty result", async () => {
    const result = await searchChunks({
      fetchChunksByUser: async () => [],
      userId: "user1",
      queryVector: queryVec,
      topK: 5,
    });
    expect(result).toEqual([]);
  });

  it("topK truncates to requested size", async () => {
    const chunks: ChunkWithEmbedding[] = Array.from({ length: 100 }, (_, i) =>
      makeChunk(`c${i}`, [1, 0, 0, 0]),
    );

    const result = await searchChunks({
      fetchChunksByUser: async () => chunks,
      userId: "user1",
      queryVector: queryVec,
      topK: 10,
    });

    expect(result).toHaveLength(10);
  });

  it("default trust weights are monotonic non-decreasing", () => {
    expect(DEFAULT_TRUST_WEIGHTS[0]).toBeLessThanOrEqual(DEFAULT_TRUST_WEIGHTS[1]);
    expect(DEFAULT_TRUST_WEIGHTS[1]).toBeLessThanOrEqual(DEFAULT_TRUST_WEIGHTS[2]);
    expect(DEFAULT_TRUST_WEIGHTS[2]).toBeLessThanOrEqual(DEFAULT_TRUST_WEIGHTS[3]);
  });
});

describe("searchChunks M7-B source 过滤", () => {
  const makeChunkWithType = (
    id: string,
    embedding: number[],
    sourceType: string,
    sourceId: string = `src-${id}`,
  ): ChunkWithEmbedding => ({
    id,
    documentId: `doc-${id}`,
    sourceId,
    sourceType,
    userId: "user1",
    idx: 0,
    content: `content-${id}`,
    embedding,
    tokenCount: 10,
    trustLevel: 2,
    createdAt: 0,
  });

  const queryVec = [1, 0, 0, 0];

  it("sourceTypes: 限定只搜 pdf → 排除 webpage chunk", async () => {
    const chunks = [
      makeChunkWithType("pdf1", [1, 0, 0, 0], "pdf"),
      makeChunkWithType("web1", [1, 0, 0, 0], "webpage"),
      makeChunkWithType("xhs1", [1, 0, 0, 0], "xiaohongshu"),
    ];

    const result = await searchChunks({
      fetchChunksByUser: async () => chunks,
      userId: "user1",
      queryVector: queryVec,
      topK: 5,
      sourceTypes: ["pdf"],
    });

    expect(result.map((r) => r.chunkId)).toEqual(["pdf1"]);
  });

  it("sourceTypes: 多选 [pdf, xiaohongshu] → 两者都返", async () => {
    const chunks = [
      makeChunkWithType("pdf1", [1, 0, 0, 0], "pdf"),
      makeChunkWithType("web1", [1, 0, 0, 0], "webpage"),
      makeChunkWithType("xhs1", [1, 0, 0, 0], "xiaohongshu"),
    ];

    const result = await searchChunks({
      fetchChunksByUser: async () => chunks,
      userId: "user1",
      queryVector: queryVec,
      topK: 5,
      sourceTypes: ["pdf", "xiaohongshu"],
    });

    expect(result.map((r) => r.chunkId).sort()).toEqual(["pdf1", "xhs1"]);
  });

  it("excludeSourceIds: 排除指定 source 的所有 chunk", async () => {
    const chunks = [
      makeChunkWithType("keep1", [1, 0, 0, 0], "webpage", "src-keep"),
      makeChunkWithType("bad1", [1, 0, 0, 0], "webpage", "src-bad"),
      makeChunkWithType("bad2", [1, 0, 0, 0], "pdf", "src-bad"),
    ];

    const result = await searchChunks({
      fetchChunksByUser: async () => chunks,
      userId: "user1",
      queryVector: queryVec,
      topK: 5,
      excludeSourceIds: ["src-bad"],
    });

    expect(result.map((r) => r.chunkId)).toEqual(["keep1"]);
  });

  it("sourceTypes + excludeSourceIds 组合: AND 关系", async () => {
    const chunks = [
      makeChunkWithType("pdf-keep", [1, 0, 0, 0], "pdf", "src-a"),
      makeChunkWithType("pdf-bad", [1, 0, 0, 0], "pdf", "src-b"),
      makeChunkWithType("web-keep", [1, 0, 0, 0], "webpage", "src-a"),
    ];

    const result = await searchChunks({
      fetchChunksByUser: async () => chunks,
      userId: "user1",
      queryVector: queryVec,
      topK: 5,
      sourceTypes: ["pdf"],
      excludeSourceIds: ["src-b"],
    });

    // pdf + 非 src-b → 只有 pdf-keep
    expect(result.map((r) => r.chunkId)).toEqual(["pdf-keep"]);
  });

  it("sourceTypes 为空数组 = 不过滤（兼容）", async () => {
    const chunks = [
      makeChunkWithType("pdf1", [1, 0, 0, 0], "pdf"),
      makeChunkWithType("web1", [1, 0, 0, 0], "webpage"),
    ];

    const result = await searchChunks({
      fetchChunksByUser: async () => chunks,
      userId: "user1",
      queryVector: queryVec,
      topK: 5,
      sourceTypes: [],
    });

    expect(result).toHaveLength(2);
  });

  it("chunk.sourceType 缺失但 sourceTypes 已设 → 排除（防误匹配）", async () => {
    const chunks = [
      makeChunkWithType("typed", [1, 0, 0, 0], "pdf"),
      { ...makeChunkWithType("untyped", [1, 0, 0, 0], "webpage"), sourceType: undefined },
    ];

    const result = await searchChunks({
      fetchChunksByUser: async () => chunks,
      userId: "user1",
      queryVector: queryVec,
      topK: 5,
      sourceTypes: ["pdf"],
    });

    // untyped 没 sourceType → 排除
    expect(result.map((r) => r.chunkId)).toEqual(["typed"]);
  });
});

describe("searchChunks M7-A recency 加权", () => {
  const queryVec = [1, 0, 0, 0];
  const now = Date.now();
  const dayMs = 1000 * 60 * 60 * 24;

  it("recencyHalfLifeDays=0 → 不衰减（与原行为一致）", async () => {
    const chunks = [
      { id: "old", documentId: "d", sourceId: "s", userId: "u", idx: 0, content: "", embedding: [1, 0, 0, 0], tokenCount: 10, trustLevel: 2 as const, createdAt: now - 365 * dayMs },
      { id: "new", documentId: "d", sourceId: "s", userId: "u", idx: 0, content: "", embedding: [1, 0, 0, 0], tokenCount: 10, trustLevel: 2 as const, createdAt: now },
    ];
    const result = await searchChunks({
      fetchChunksByUser: async () => chunks,
      userId: "u",
      queryVector: queryVec,
      topK: 5,
      recencyHalfLifeDays: 0,
    });
    // 不衰减 → old 和 new 同分（按 stability 决定；这里都是 trustLevel=2 weight=1.1 → 同分）
    expect(result).toHaveLength(2);
  });

  it("recencyHalfLifeDays=30 → 30 天前的 chunk 分数减半", async () => {
    const chunks = [
      { id: "old", documentId: "d", sourceId: "s", userId: "u", idx: 0, content: "", embedding: [1, 0, 0, 0], tokenCount: 10, trustLevel: 2 as const, createdAt: now - 30 * dayMs },
      { id: "new", documentId: "d", sourceId: "s", userId: "u", idx: 0, content: "", embedding: [1, 0, 0, 0], tokenCount: 10, trustLevel: 2 as const, createdAt: now },
    ];
    const result = await searchChunks({
      fetchChunksByUser: async () => chunks,
      userId: "u",
      queryVector: queryVec,
      topK: 5,
      recencyHalfLifeDays: 30,
    });
    // 期望 new 排第一（recency 1.0 vs 0.5）
    expect(result[0]?.chunkId).toBe("new");
    expect(result[1]?.chunkId).toBe("old");
    // new 分数 ≈ 1.0 × 1.1 = 1.1；old 分数 ≈ 0.5 × 1.1 = 0.55
    const newScore = result[0]?.finalScore ?? 0;
    const oldScore = result[1]?.finalScore ?? 0;
    expect(newScore / oldScore).toBeCloseTo(2, 0); // ratio = 2.0
  });

  it("recency 加权与 trust 加权叠加：new + high-trust > old + low-trust", async () => {
    const chunks = [
      { id: "old-low", documentId: "d", sourceId: "s", userId: "u", idx: 0, content: "", embedding: [1, 0, 0, 0], tokenCount: 10, trustLevel: 0 as const, createdAt: now - 60 * dayMs },
      { id: "new-high", documentId: "d", sourceId: "s", userId: "u", idx: 0, content: "", embedding: [1, 0, 0, 0], tokenCount: 10, trustLevel: 3 as const, createdAt: now },
    ];
    const result = await searchChunks({
      fetchChunksByUser: async () => chunks,
      userId: "u",
      queryVector: queryVec,
      topK: 5,
      recencyHalfLifeDays: 30,
    });
    // new-high: cosine 1.0 × trust 1.3 × recency 1.0 = 1.3
    // old-low:  cosine 1.0 × trust 1.0 × recency 0.25 = 0.25
    expect(result[0]?.chunkId).toBe("new-high");
    expect((result[0]?.finalScore ?? 0) > (result[1]?.finalScore ?? 0)).toBe(true);
  });
});