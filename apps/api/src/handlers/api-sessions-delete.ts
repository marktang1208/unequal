/**
 * api-sessions-delete handler（CP-6 Phase 3 + CP-7-B bugfix）
 * DELETE /api-sessions-delete?id=...
 *
 * CP-7-B bugfix：原 `getById` 查 CloudBase `_id`，但 caller 传的是 schema `id`（list 返的）。
 * 改用 `whereQuery({id})` 查 schema 字段；remove 用 CloudBase `_id`。
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
import { whereQuery, remove, COLLECTIONS } from "../lib/db.js";
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

  // 查 schema id；list 返的就是 schema id
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

  // remove 用 CloudBase _id
  await remove(COLLECTIONS.chatSession, session._id);
  return jsonResponse({ ok: true, id });
}
