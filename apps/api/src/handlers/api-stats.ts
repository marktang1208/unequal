/**
 * api-stats handler（CP-6 Phase 3 完整实现）
 * GET /api-stats-login-attempts
 *
 * admin auth + login_attempt 聚合统计
 */

import {
  errorResponse,
  jsonResponse,
  optionsResponse,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";
import { requireAdmin } from "../lib/auth-admin.js";
import { whereQuery, COLLECTIONS } from "../lib/db.js";
import type { LoginAttempt } from "@unequal/shared/types";

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  const auth = await requireAdmin(event, env);
  if (!auth.ok) return auth.response;

  // 聚合 login_attempt：总成功 + 总失败 + 近 24h
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