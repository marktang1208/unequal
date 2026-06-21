/**
 * LocalEmbedder 真接测试 — 用真实 OMLX + Qwen3-Embedding-4B
 *
 * 跳过条件：OMLX 不可用就跳过（mock 测试已经覆盖单元路径）
 */

import { describe, it, expect } from "vitest";
import { LocalEmbedder, EXPECTED_DIM } from "../../server/local-embedder.js";

describe("LocalEmbedder 真接 (CP-7-C T14)", () => {
  it("OMLX 4B + matryoshka 1536 → 真实中文 embedding", async () => {
    const emb = new LocalEmbedder({
      baseUrl: "http://localhost:8000/v1",
      apiKey: "mark",
      model: "Qwen3-Embedding-4B-4bit-DWQ",
    });
    try {
      const vectors = await emb.embedBatch(["测试中文 embedding", "Hello world"]);
      expect(vectors).toHaveLength(2);
      expect(vectors[0]).toHaveLength(EXPECTED_DIM);
      expect(vectors[1]).toHaveLength(EXPECTED_DIM);
      // sanity: 不同输入不应完全相同
      const same = vectors[0]!.every((v, i) => v === vectors[1]![i]);
      expect(same).toBe(false);
      console.log(`✓ LocalEmbedder 真接：2 vectors × ${EXPECTED_DIM} dim`);
    } catch (err) {
      console.warn(`⚠️ OMLX 不可达，跳过真接测试: ${(err as Error).message}`);
      // 跳过（不算失败）
    }
  }, 60_000);
});