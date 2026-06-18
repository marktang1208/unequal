/**
 * api-sessions-get handler（CP-6 Phase 3 + CP-7-B bugfix）
 * GET /api-sessions-get?id=...
 *
 * CP-7-B bugfix：原 `getById` 查 CloudBase `_id`，但 sessions-list 返的 `id` 是 schema 字段
 * （api-chat handler 显式 `session.id = newId()`），两者是不同的 ULID。改用 `whereQuery({id})`
 * 查 schema 字段，与 list 返的 id 对齐。
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
import { verifyJwt } from "../lib/jwt.js";
import { whereQuery, COLLECTIONS } from "../lib/db.js";
import type { ChatSession } from "@unequal/shared/types";

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  // JWT auth
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  let userId: string;
  try {
    const payload = await verifyJwt({ token, secret: env.JWT_SECRET });
    userId = payload.sub;
  } catch {
    return errorResponse("AUTH_FAILED", "Invalid JWT", 401);
  }

  const id = getQuery(event, "id");
  if (!id) {
    return errorResponse("INVALID_REQUEST", "Missing 'id' query param", 400);
  }

  // 查 schema id（不是 CloudBase _id）；list 返的就是 schema id
  const sessions = await whereQuery<ChatSession>(
    COLLECTIONS.chatSession,
    { id },
    { limit: 1 },
  );
  const session = sessions[0];
  if (!session) {
    return errorResponse("NOT_FOUND", `Session ${id} not found`, 404);
  }
  if (session.userId !== userId) {
    return errorResponse("FORBIDDEN", "Not your session", 403);
  }

  return jsonResponse(session);
}
