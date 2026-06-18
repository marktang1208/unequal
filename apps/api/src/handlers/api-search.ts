/**
 * api-search handler（CP-6 Phase 4 完整实现）
 * GET /api-search?q=...
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
import { createMiniMaxEmbedder } from "@unequal/shared/embedding";
import { searchChunks, type ChunkWithEmbedding } from "@unequal/shared/retrieval";
import { COLLECTIONS, type CollectionName } from "../lib/collections.js";
import { getAllByFilter } from "../lib/db.js";
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

  // embed query
  const embed = createMiniMaxEmbedder({
    apiKey: env.MINIMAX_API_KEY,
    baseUrl: env.MINIMAX_BASE_URL,
    model: "embo-01",
  });
  const queryVec = (await embed.embed([q]))[0] ?? [];

  // fetch chunks for user
  const chunks = await getAllByFilter<Chunk>(
    COLLECTIONS.chunk as CollectionName,
    { userId: env.DEFAULT_USER_ID },
  );
  const chunksWithEmb: ChunkWithEmbedding[] = chunks.map((c) => ({
    id: c.id,
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
  });

  return jsonResponse({
    query: q,
    results: results.map((r) => ({
      chunkId: r.chunkId,
      score: r.finalScore,
      trustLevel: r.trustLevel,
    })),
  });
}