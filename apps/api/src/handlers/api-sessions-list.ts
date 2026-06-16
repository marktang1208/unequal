/**
 * api-sessions-list handler（CP-6 Phase 3 完整实现）
 * GET /api-sessions-list
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

  const sessions = await whereQuery<ChatSession>(
    COLLECTIONS.chatSession,
    { userId },
    { orderBy: { field: "updatedAt", direction: "desc" }, limit: 50 },
  );

  return jsonResponse({
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      messageCount: s.messages.length,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
  });
}