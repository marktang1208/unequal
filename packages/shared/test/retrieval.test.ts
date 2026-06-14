import { describe, it, expect, vi } from "vitest";
import { searchChunks } from "../src/retrieval.js";

describe("searchChunks", () => {
  const fakeVectorize = {
    query: vi.fn(),
  };

  it("queries Vectorize with user filter, applies trust_level weighting, returns topK", async () => {
    fakeVectorize.query.mockResolvedValueOnce({
      matches: [
        { id: "c1", score: 0.9, metadata: { trust_level: 3 } },
        { id: "c2", score: 0.85, metadata: { trust_level: 0 } },
        { id: "c3", score: 0.8, metadata: { trust_level: 2 } },
        { id: "c4", score: 0.7, metadata: { trust_level: 1 } },
      ],
    });

    const results = await searchChunks({
      vectorize: fakeVectorize as unknown as VectorizeIndex,
      userId: "u1",
      queryVector: [0.1, 0.2, 0.3],
      topK: 3,
    });

    expect(fakeVectorize.query).toHaveBeenCalledWith([0.1, 0.2, 0.3], {
      topK: 20,
      returnMetadata: true,
      filter: { user_id: "u1", trust_level: { $gte: 0 } },
    });

    // 应用 trust_level 加权：c1=0.9*1.3=1.17, c2=0.85*1.0=0.85, c3=0.8*1.1=0.88, c4=0.7*1.0=0.7
    // 排序后 top3: c1 (1.17), c3 (0.88), c2 (0.85)
    expect(results.map((r) => r.chunkId)).toEqual(["c1", "c3", "c2"]);
    expect(results[0]?.finalScore).toBeCloseTo(1.17, 2);
  });

  it("returns empty array when no matches", async () => {
    fakeVectorize.query.mockResolvedValueOnce({ matches: [] });

    const results = await searchChunks({
      vectorize: fakeVectorize as unknown as VectorizeIndex,
      userId: "u1",
      queryVector: [0.1],
      topK: 5,
    });

    expect(results).toEqual([]);
  });

  it("respects custom trustWeightMap", async () => {
    fakeVectorize.query.mockResolvedValueOnce({
      matches: [{ id: "c1", score: 1.0, metadata: { trust_level: 3 } }],
    });

    const results = await searchChunks({
      vectorize: fakeVectorize as unknown as VectorizeIndex,
      userId: "u1",
      queryVector: [0.1],
      topK: 5,
      trustWeightMap: { 0: 1, 1: 1, 2: 1, 3: 1 },  // 全 1，等于不加权
    });

    expect(results[0]?.finalScore).toBe(1.0);
  });
});
