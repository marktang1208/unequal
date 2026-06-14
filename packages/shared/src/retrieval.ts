import type { TrustLevel } from "./types.js";

export const DEFAULT_TRUST_WEIGHTS: Record<TrustLevel, number> = {
  0: 1.0,
  1: 1.0,
  2: 1.1,
  3: 1.3,
};

export interface SearchOptions {
  vectorize: VectorizeIndex;
  userId: string;
  queryVector: number[];
  topK: number;
  trustWeightMap?: Record<TrustLevel, number>;
}

export interface SearchResult {
  chunkId: string;
  vectorizeScore: number;
  finalScore: number;
  trustLevel: TrustLevel;
}

export async function searchChunks(opts: SearchOptions): Promise<SearchResult[]> {
  const weights = opts.trustWeightMap ?? DEFAULT_TRUST_WEIGHTS;

  const res = await opts.vectorize.query(opts.queryVector, {
    topK: Math.max(opts.topK * 4, 20),  // 多召回一些，给 trust 加权留余量
    returnMetadata: true,
    filter: {
      user_id: opts.userId,
      trust_level: { $gte: 0 },
    },
  });

  const matches = res.matches ?? [];

  const weighted: SearchResult[] = matches
    .map((m) => {
      const tl = (m.metadata?.trust_level ?? 0) as TrustLevel;
      const weight = weights[tl] ?? 1.0;
      return {
        chunkId: m.id,
        vectorizeScore: m.score,
        finalScore: m.score * weight,
        trustLevel: tl,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, opts.topK);

  return weighted;
}
