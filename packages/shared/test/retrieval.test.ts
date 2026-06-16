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