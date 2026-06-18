/**
 * api-user-nickname handler（CP-7-B）
 * PATCH /api-user-nickname
 *
 * Body: { nickname: string }
 * Auth: JWT user scope
 *
 * 改 user.nickname；不存在 → 404（不 upsert，spec D-3）。
 */

import {
  errorResponse,
  jsonResponse,
  optionsResponse,
  parseJsonBody,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";
import { verifyJwt } from "../lib/jwt.js";
import { getById, update, COLLECTIONS } from "../lib/db.js";

const MAX_NICKNAME_LEN = 30;

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
  const body = parseJsonBody<{ nickname?: unknown }>(event);
  if (!body || typeof body.nickname !== "string") {
    return errorResponse("INVALID_REQUEST", "Missing or invalid 'nickname' in body", 400);
  }
  const nickname = body.nickname.trim();
  if (!nickname) {
    return errorResponse("INVALID_REQUEST", "Empty 'nickname'", 400);
  }
  if (nickname.length > MAX_NICKNAME_LEN) {
    return errorResponse("INVALID_REQUEST", `'nickname' exceeds ${MAX_NICKNAME_LEN} chars`, 400);
  }

  // user lookup by _id (JWT sub = CloudBase _id)
  const user = await getById(COLLECTIONS.user, userId);
  if (!user) {
    return errorResponse("NOT_FOUND", `User ${userId} not found`, 404);
  }

  // 只更新 nickname（不动 wxOpenid/createdAt）
  await update(COLLECTIONS.user, userId, { nickname });

  return jsonResponse({ ok: true, user_id: userId, nickname });
}