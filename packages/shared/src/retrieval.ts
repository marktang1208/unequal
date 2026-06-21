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
  /** CloudBase 自动生成的 doc ID（见 Chunk._id 注释） */
  _id?: string;
  documentId: string;
  sourceId: string;
  /** M7-B: source 类型（webpage/pdf/xiaohongshu/wechat-mp 等），用于过滤 */
  sourceType?: string;
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
  /** M7-B: 限定 sourceType（如 ["pdf","webpage"]）；undefined = 不过滤 */
  sourceTypes?: string[];
  /** M7-B: 排除这些 sourceId；undefined = 不排除 */
  excludeSourceIds?: string[];
  /** M7-A: 时间衰减半衰期（天）；新文章 boost。0 或 undefined = 不衰减 */
  recencyHalfLifeDays?: number;
}

/** M7-A: 时间衰减权重（指数衰减） */
function recencyWeight(createdAt: number, halfLifeDays: number, nowMs: number): number {
  if (halfLifeDays <= 0) return 1.0;
  const ageDays = (nowMs - createdAt) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1.0;
  return Math.pow(0.5, ageDays / halfLifeDays);
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
  const now = Date.now();
  const halfLife = opts.recencyHalfLifeDays ?? 0; // 默认不衰减（CP-7 行为不变）

  // 拉所有 user chunks（生产实现带分页；test mock 简单）
  const chunks = await opts.fetchChunksByUser(opts.userId);

  // M7-B: source 过滤（先过滤再算 cosine，省 CPU）
  const filtered = chunks.filter((c) => {
    if (opts.sourceTypes && opts.sourceTypes.length > 0) {
      if (!c.sourceType || !opts.sourceTypes.includes(c.sourceType)) return false;
    }
    if (opts.excludeSourceIds && opts.excludeSourceIds.length > 0) {
      if (opts.excludeSourceIds.includes(c.sourceId)) return false;
    }
    return true;
  });

  // 计算每 chunk cosine + trust + recency 加权
  const scored: SearchResult[] = [];
  for (const c of filtered) {
    let score: number;
    try {
      score = cosineSimilarity(opts.queryVector, c.embedding);
    } catch {
      // 维度不一致 → 跳过该 chunk（防御）
      continue;
    }
    const trustW = weights[c.trustLevel] ?? 1.0;
    const recencyW = recencyWeight(c.createdAt, halfLife, now);
    scored.push({
      chunkId: c._id ?? c.id,
      vectorizeScore: score,
      // M7-A: 加权组合 = cosine × trust × recency
      finalScore: score * trustW * recencyW,
      trustLevel: c.trustLevel,
    });
  }

  // score threshold 过滤
  const final = opts.scoreThreshold !== undefined
    ? scored.filter((s) => s.finalScore >= opts.scoreThreshold!)
    : scored;

  // 排序 + 截断
  final.sort((a, b) => b.finalScore - a.finalScore);
  return final.slice(0, opts.topK);
}