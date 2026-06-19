/**
 * api-debug-chunks handler（CP-7-B round 9 临时调试）
 * GET /api-debug-chunks?user_id=xxx&limit=500
 *
 * admin only。dump 该 user 的 chunks
 * limit 复现 chat handler 的查询条件
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
import { whereQuery, COLLECTIONS } from "../lib/db.js";
import type { Chunk } from "@unequal/shared/types";

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  const auth = await requireAdmin(event, env);
  if (!auth.ok) return auth.response;

  const userId = getQuery(event, "user_id");
  if (!userId) {
    return errorResponse("INVALID_REQUEST", "Missing user_id", 400);
  }
  const limit = parseInt(getQuery(event, "limit") ?? "500", 10);

  // 复现 chat handler 的精确 query：whereQuery({ userId }, { limit: 500 })
  const chunks = await whereQuery<Chunk>(COLLECTIONS.chunk, { userId }, { limit });

  const summary = chunks.map((c) => ({
    id: c.id,
    _id: c._id,
    documentId: c.documentId,
    userId: c.userId,
    idx: c.idx,
    contentLen: c.content?.length ?? 0,
    contentPreview: c.content?.slice(0, 60) ?? "",
    embeddingLen: c.embedding?.length ?? 0,
  }));

  return jsonResponse({
    queriedUserId: userId,
    queryLimit: limit,
    total: chunks.length,
    chunks: summary,
  });
}
