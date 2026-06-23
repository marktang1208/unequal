/**
 * api-auth-me handler (M7-D)
 *
 * GET /api-auth-me
 * - JWT auth (user scope)
 * - 返 { user_id, nickname, createdAt, sessionCount, totalMessages, isolation }
 *   供 minipgm settings 页展示
 *
 * 字段：
 * - user_id: ULID（云端 _id）— 用于 settings 页显示"我的 ID"
 * - nickname: 微信昵称（M6.3c 加，未填则 undefined）
 * - createdAt: 注册时间（epoch ms）
 * - sessionCount: 当前 user 的 chat session 数
 * - totalMessages: 所有 session 的 message 总数
 * - isolation: 文案，提示"你的数据只对你可见"
 */

import {
  errorResponse,
  jsonResponse,
  optionsResponse,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";
import { verifyJwt } from "../lib/jwt.js";
import { getById, whereQuery, COLLECTIONS } from "../lib/db.js";
import type { User, ChatSession } from "@unequal/shared/types";

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

  // 查 user
  const user = await getById<User>(COLLECTIONS.user, userId);
  if (!user) {
    return errorResponse("NOT_FOUND", `user ${userId} not found`, 404);
  }

  // 查 session 列表（统计）
  const sessions = await whereQuery<ChatSession>(
    COLLECTIONS.chatSession,
    { userId },
    { limit: 1000 },
  );
  const sessionCount = sessions.length;
  const totalMessages = sessions.reduce((s, sess) => s + (sess.messages?.length ?? 0), 0);

  return jsonResponse({
    user_id: user._id,
    nickname: user.nickname ?? null,
    created_at: user.createdAt,
    session_count: sessionCount,
    total_messages: totalMessages,
    isolation: "你的对话历史、知识库内容只对你可见。登出后其他用户无法查看这些数据。",
  });
}
