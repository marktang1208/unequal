import { ulid } from "ulid";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const CACHE_HIT_THRESHOLD = 0.92;

export interface CacheIOContext {
  d1: D1Database;
  vectorize: VectorizeIndex;
  userId: string;
  q: string;
  qEmbedding: number[];
}

export interface CachedAsk {
  answer: string;
  verified: number[];
}

export function hashQ(q: string): string {
  return cyrb53(q).toString(16).padStart(16, "0").slice(0, 16);
}

function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 写缓存：D1 query_cache + Vectorize 指针 */
export async function writeCache(
  ctx: CacheIOContext & {
    answer: string;
    verified: number[];
  },
): Promise<void> {
  const id = ulid();
  const now = Date.now();
  const expires = now + CACHE_TTL_MS;
  const f32 = new Float32Array(ctx.qEmbedding);
  const bytes = new Uint8Array(f32.buffer);

  await ctx.d1
    .prepare(
      `INSERT INTO query_cache (id, user_id, q, q_embedding, answer, verified, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      ctx.userId,
      ctx.q,
      bytes,
      ctx.answer,
      JSON.stringify(ctx.verified),
      now,
      expires,
    )
    .run();

  await ctx.vectorize.upsert([
    {
      id: `cache_${id}`,
      values: ctx.qEmbedding,
      metadata: {
        is_cached: true,
        cache_id: id,
        user_id: ctx.userId,
        q_hash: hashQ(ctx.q),
      },
    },
  ]);
}

/** 读缓存：Vectorize top1 命中 + 阈值 + 未过期 */
export async function readCache(ctx: CacheIOContext): Promise<CachedAsk | null> {
  const hits = await ctx.vectorize.query(ctx.qEmbedding, {
    topK: 1,
    returnMetadata: true,
    filter: { user_id: ctx.userId, is_cached: true },
  });
  const top = hits.matches?.[0];
  if (!top || top.score < CACHE_HIT_THRESHOLD) return null;

  const cacheId = top.metadata?.cache_id as string | undefined;
  if (!cacheId) return null;

  const row = await ctx.d1
    .prepare(`SELECT answer, verified, expires_at FROM query_cache WHERE id = ?`)
    .bind(cacheId)
    .first<{ answer: string; verified: string; expires_at: number }>();

  if (!row) return null;
  if (row.expires_at < Date.now()) return null;

  return {
    answer: row.answer,
    verified: JSON.parse(row.verified) as number[],
  };
}
