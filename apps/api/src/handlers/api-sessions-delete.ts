/**
 * api-sessions-delete handler（CP-6 Phase 3 完整实现）
 * DELETE /api-sessions-delete?id=...
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
import { getById, remove, COLLECTIONS } from "../lib/db.js";
import type { ChatSession } from "@unequal/shared/types";

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

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

  const session = await getById<ChatSession>(COLLECTIONS.chatSession, id);
  if (!session) {
    return errorResponse("NOT_FOUND", `Session ${id} not found`, 404);
  }
  if (session.userId !== userId) {
    return errorResponse("FORBIDDEN", "Not your session", 403);
  }

  await remove(COLLECTIONS.chatSession, id);
  return jsonResponse({ ok: true, id });
}