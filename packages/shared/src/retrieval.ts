/**
 * CP-6: 暴力 cosine 向量检索（in code，替代 CF Vectorize）
 *
 * 适用规模：< 1万 chunks 暴力搜索亚秒级（spec §4）。
 * 超出规模考虑：HNSW / 腾讯 VectorDB（YAGNI 标记）。
 *
 * fetchChunksByUser 是注入的回调 —— 让测试可控 mock；生产实现从 CloudBase DB 拉所有该 user 的 chunks。
 */

import type { TrustLevel } from "./types.js";

export const DEFAULT_TRUST_WEIGHTS: Record<TrustLevel, number> = {
  0: 1.0,
  1: 1.0,
  2: 1.1,
  3: 1.3,
};

export interface ChunkWithEmbedding {
  id: string;
  documentId: string;
  sourceId: string;
  userId: string;
  idx: number;
  content: string;
  embedding: number[];
  tokenCount: number;
  trustLevel: TrustLevel;
  createdAt: number;
}

export interface SearchOptions {
  fetchChunksByUser: (userId: string) => Promise<ChunkWithEmbedding[]>;
  userId: string;
  queryVector: number[];
  topK: number;
  scoreThreshold?: number;
  trustWeightMap?: Record<TrustLevel, number>;
  /** 多召回数量（默认 topK * 4 给 trust 加权留余量） */
  recallMultiplier?: number;
}

export interface SearchResult {
  chunkId: string;
  vectorizeScore: number;
  finalScore: number;
  trustLevel: TrustLevel;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function searchChunks(opts: SearchOptions): Promise<SearchResult[]> {
  const weights = opts.trustWeightMap ?? DEFAULT_TRUST_WEIGHTS;

  // 拉所有 user chunks（生产实现带分页；test mock 简单）
  const chunks = await opts.fetchChunksByUser(opts.userId);

  // 计算每 chunk cosine + trust 加权
  const scored: SearchResult[] = [];
  for (const c of chunks) {
    let score: number;
    try {
      score = cosineSimilarity(opts.queryVector, c.embedding);
    } catch {
      // 维度不一致 → 跳过该 chunk（防御）
      continue;
    }
    const weight = weights[c.trustLevel] ?? 1.0;
    scored.push({
      chunkId: c.id,
      vectorizeScore: score,
      finalScore: score * weight,
      trustLevel: c.trustLevel,
    });
  }

  // score threshold 过滤
  const filtered = opts.scoreThreshold !== undefined
    ? scored.filter((s) => s.finalScore >= opts.scoreThreshold!)
    : scored;

  // 排序 + 截断
  filtered.sort((a, b) => b.finalScore - a.finalScore);
  return filtered.slice(0, opts.topK);
}