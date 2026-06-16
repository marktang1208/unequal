/**
 * api-cron-cleanup handler（CP-6 Phase 6 完整实现）
 * 定时触发器调用（每日 03:00 UTC），清理超期 login_attempt
 *
 * 流程：
 * 1. 算 cutoff = now - LOGIN_WINDOW_MS
 * 2. 查 login_attempt where(createdAt < cutoff) 列出待删 ids
 * 3. 逐个 remove（独立 try/catch）
 * 4. 返 { deleted: N, errors: [...] }
 */

import {
  errorResponse,
  jsonResponse,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";
import { whereQuery, remove, COLLECTIONS } from "../lib/db.js";
import type { LoginAttempt } from "@unequal/shared/types";

interface CleanupResponse {
  deleted: number;
  cutoff: number;
  errors?: string[];
}

export async function main(_event: unknown): Promise<HttpTriggerResponse> {
  const env = getEnv();

  const now = Date.now();
  const cutoff = now - env.LOGIN_WINDOW_MS;

  // 1. 列待删 ids
  const stale = await whereQuery<LoginAttempt>(
    COLLECTIONS.loginAttempt,
    {},
    { limit: 1000 },
  );
  const staleIds = stale.filter((a) => a.createdAt < cutoff).map((a) => a._id);

  // 2. 逐个 remove
  const errors: string[] = [];
  let deleted = 0;
  for (const id of staleIds) {
    try {
      await remove(COLLECTIONS.loginAttempt, id);
      deleted++;
    } catch (err) {
      errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const response: CleanupResponse = {
    deleted,
    cutoff,
    errors: errors.length > 0 ? errors : undefined,
  };
  return jsonResponse(response);
}

// 静默 ignore unused 参数
void errorResponse;