/**
 * api-stats handler（CP-6 Phase 3 完整实现）
 * GET /api-stats-login-attempts
 *
 * admin auth + login_attempt 聚合统计
 */

import {
  errorResponse,
  getClientIp,
  jsonResponse,
  optionsResponse,
  parseJsonBody,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";
import { verifyJwt } from "../lib/jwt.js";
import { whereQuery, COLLECTIONS } from "../lib/db.js";
import type { LoginAttempt } from "@unequal/shared/types";

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  // admin auth: Authorization: Bearer $ADMIN_TOKEN OR JWT
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return errorResponse("AUTH_FAILED", "Missing Authorization header", 401);
  }

  let isAdmin = false;
  if (token === env.ADMIN_TOKEN) {
    isAdmin = true;
  } else {
    try {
      const payload = await verifyJwt({ token, secret: env.JWT_SECRET });
      isAdmin = payload.scope === "admin";
    } catch {
      // fall through
    }
  }
  if (!isAdmin) {
    return errorResponse("AUTH_FAILED", "Not admin", 403);
  }

  // 聚合 login_attempt：总成功 + 总失败 + 近 24h
  void getClientIp(event); // 保留 IP 上下文（如未来按 IP 聚合）
  void parseJsonBody;       // 保留引用避免 lint warn

  const now = Date.now();
  const last24h = now - 24 * 60 * 60 * 1000;

  const allAttempts = await whereQuery<LoginAttempt>(COLLECTIONS.loginAttempt, {}, { limit: 1000 });
  const totalSuccess = allAttempts.filter((a) => a.success).length;
  const totalFailed = allAttempts.filter((a) => !a.success).length;
  const last24hAttempts = allAttempts.filter((a) => a.createdAt >= last24h).length;
  const last24hFailed = allAttempts.filter((a) => a.createdAt >= last24h && !a.success).length;

  return jsonResponse({
    total: allAttempts.length,
    totalSuccess,
    totalFailed,
    last24h: last24hAttempts,
    last24hFailed,
    timestamp: now,
  });
}