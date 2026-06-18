/**
 * api-sessions-rename handler（CP-7-B + bugfix）
 * PATCH /api-sessions-rename?id={sessionId}
 *
 * Body: { title: string }
 * Auth: JWT user/admin scope
 *
 * 改 chatSession.title + updatedAt；owner 校验。
 *
 * CP-7-B bugfix：原 `getById` 查 CloudBase `_id`，caller 传的是 schema `id`。
 * 改用 `whereQuery({id})` 查 schema 字段；update 用 CloudBase `_id`。
 */

import {
  errorResponse,
  getQuery,
  jsonResponse,
  optionsResponse,
  parseJsonBody,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";
import { verifyJwt } from "../lib/jwt.js";
import { whereQuery, update, COLLECTIONS } from "../lib/db.js";
import type { ChatSession } from "@unequal/shared/types";

const MAX_TITLE_LEN = 100;

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);
  if (event.httpMethod !== "PATCH") {
    return errorResponse("METHOD_NOT_ALLOWED", "Only PATCH is allowed", 405);
  }

  // JWT auth
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  let userId: string;
  try {
    const payload = await verifyJwt({ token, secret: env.JWT_SECRET });
    if (payload.scope !== "user" && payload.scope !== "admin") {
      return errorResponse("AUTH_FAILED", "Invalid scope", 401);
    }
    userId = payload.sub;
  } catch {
    return errorResponse("AUTH_FAILED", "Invalid JWT", 401);
  }

  // 参数校验
  const id = getQuery(event, "id");
  if (!id) {
    return errorResponse("INVALID_REQUEST", "Missing 'id' query param", 400);
  }
  const body = parseJsonBody<{ title?: unknown }>(event);
  if (!body || typeof body.title !== "string") {
    return errorResponse("INVALID_REQUEST", "Missing or invalid 'title' in body", 400);
  }
  const title = body.title.trim();
  if (!title) {
    return errorResponse("INVALID_REQUEST", "Empty 'title'", 400);
  }
  if (title.length > MAX_TITLE_LEN) {
    return errorResponse("INVALID_REQUEST", `'title' exceeds ${MAX_TITLE_LEN} chars`, 400);
  }

  // ownership 校验（查 schema id；list 返的就是 schema id）
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

  // update 用 CloudBase _id
  await update(COLLECTIONS.chatSession, session._id, {
    title,
    updatedAt: Date.now(),
  });

  return jsonResponse({ ok: true, id, title });
}