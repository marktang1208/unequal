/**
 * api-search handler（CP-6 Phase 4 完整实现 + M7-B source 过滤）
 * GET /api-search?q=...&topK=10&sourceType=pdf,webpage&excludeSourceIds=id1,id2
 *
 * admin auth + MiniMax embedding + brute-force cosine via shared/retrieval
 */

import {
  errorResponse,
  getQuery,
  jsonResponse,
  optionsResponse,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";
import { requireAdmin } from "../lib/auth-admin.js";
// CP-7-D #2: 走 factory（不再 import createMiniMaxEmbedder）
import { getEmbedder } from "../lib/llm-provider.js";
import { searchChunks, type ChunkWithEmbedding } from "@unequal/shared/retrieval";
import { COLLECTIONS, type CollectionName } from "../lib/collections.js";
import { whereQuery } from "../lib/db.js";
import type { Chunk } from "@unequal/shared/types";

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  const auth = await requireAdmin(event, env);
  if (!auth.ok) return auth.response;

  const q = getQuery(event, "q");
  if (!q) {
    return errorResponse("INVALID_REQUEST", "Missing 'q' query param", 400);
  }

  const topK = parseInt(getQuery(event, "topK") ?? "10", 10);

  // M7-B: source 过滤参数（逗号分隔）
  const sourceTypesRaw = getQuery(event, "sourceType");
  const sourceTypes = sourceTypesRaw
    ? sourceTypesRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const excludeSourceIdsRaw = getQuery(event, "excludeSourceIds");
  const excludeSourceIds = excludeSourceIdsRaw
    ? excludeSourceIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  // embed query
  // CP-7-D #2: 走 factory；model 在 factory 内读 env.EMBED_MODEL
  const embed = getEmbedder();
  const queryVec = (await embed.embed([q]))[0] ?? [];

  // fetch chunks for user
  // CloudBase 单次回包 1MB 上限；chunk 平均 87KB（1536 floats + content），1MB / 87KB ≈ 12 chunks 安全上限。
  // 留 1.5x buffer → limit=8（与 api-ask 对齐）。暴力 cosine 架构在 production 1963 chunks 下不 work — v2 上向量 DB
  const chunks = await whereQuery<Chunk>(
    COLLECTIONS.chunk as CollectionName,
    { userId: env.DEFAULT_USER_ID },
    { limit: 8 },
  );
  if (chunks.length === 8) {
    // eslint-disable-next-line no-console
    console.warn(`[api-search] chunk retrieval hit 8 limit; user ${env.DEFAULT_USER_ID} has more chunks (production 1963) - retrieval 准确度受限; v2 需上向量 DB`);
  }
  const chunksWithEmb: ChunkWithEmbedding[] = chunks.map((c) => ({
    id: c.id,
    _id: c._id,
    documentId: c.documentId,
    sourceId: c.sourceId,
    userId: c.userId,
    idx: c.idx,
    content: c.content,
    embedding: c.embedding,
    tokenCount: c.tokenCount,
    trustLevel: c.trustLevel,
    createdAt: c.createdAt,
  }));

  const results = await searchChunks({
    fetchChunksByUser: async () => chunksWithEmb,
    userId: env.DEFAULT_USER_ID,
    queryVector: queryVec,
    topK,
    ...(sourceTypes ? { sourceTypes } : {}),
    ...(excludeSourceIds ? { excludeSourceIds } : {}),
  });

  return jsonResponse({
    query: q,
    filters: {
      ...(sourceTypes ? { sourceTypes } : {}),
      ...(excludeSourceIds ? { excludeSourceIds } : {}),
    },
    results: results.map((r) => ({
      chunkId: r.chunkId,
      score: r.finalScore,
      trustLevel: r.trustLevel,
    })),
  });
}