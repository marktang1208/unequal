/**
 * M6.5 cleanup 函数抽取（spec §5.1 + plan §4 Task 1）。
 *
 * login_attempt 表清理逻辑（与 transport 分离）：
 * - 被 cronRoute.CLEANUP_LOGIN_ATTEMPTS (HTTP) 和 worker.scheduled (CF Cron Triggers) 共用
 * - 测试用 vitest fakeDB 验 SQL，CP-5 真接 D1 验性能
 *
 * 注意：login_attempt.created_at 是 INTEGER（unix ms），cutoff 也用 INTEGER，
 * 保证 SQL `<` 比较语义正确。
 */
import type { Env } from "../types.js";

export interface CleanupResult {
  deleted: number;
}

export const DEFAULT_CUTOFF_MS = 24 * 60 * 60 * 1000; // 24h，与 M6.4 cron.ts 一致

export async function cleanupLoginAttempts(
  env: Env,
  cutoffMs: number
): Promise<CleanupResult> {
  const cutoff = Date.now() - cutoffMs;
  const result = await env.DB.prepare(
    `DELETE FROM login_attempt WHERE created_at < ?`
  ).bind(cutoff).run();
  return { deleted: result.meta?.changes ?? 0 };
}
