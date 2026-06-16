/**
 * M6.4 cron 清理 + M6.5 cleanup 函数抽取（spec §5.1-§5.2 + plan §4 Task 1）。
 *
 * POST /cron/cleanup-login-attempts
 * Authorization: Bearer <env.CRON_SECRET>
 *
 * 行为：
 * - 验 Authorization header == `Bearer ${env.CRON_SECRET}` → 否则 401 UNAUTHORIZED
 * - 调 cleanupLoginAttempts(env, DEFAULT_CUTOFF_MS) 删 24h 前的 login_attempt 行
 * - 返 { deleted: N, cutoff: timestamp }
 *
 * M6.5 改动：inline DELETE SQL 删除，改调 lib/cleanup.ts 的 cleanupLoginAttempts 函数。
 * 抽出后 HTTP handler (cronRoute) 和 worker.scheduled 共用同一 SQL 逻辑。
 */
import type { Env } from "../types.js";
import { cleanupLoginAttempts, DEFAULT_CUTOFF_MS } from "../lib/cleanup.js";

export const cronRoute = {
  async CLEANUP_LOGIN_ATTEMPTS(request: Request, env: Env): Promise<Response> {
    // 鉴权：Bearer CRON_SECRET（防止外部恶意触发）
    const auth = request.headers.get("Authorization");
    const expected = `Bearer ${env.CRON_SECRET ?? ""}`;
    if (auth !== expected) {
      return Response.json(
        { error: "UNAUTHORIZED", message: "Invalid or missing CRON_SECRET" },
        { status: 401 },
      );
    }

    try {
      const result = await cleanupLoginAttempts(env, DEFAULT_CUTOFF_MS);
      return Response.json({
        deleted: result.deleted,
        cutoff: Date.now() - DEFAULT_CUTOFF_MS,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: "internal", detail: msg }, { status: 500 });
    }
  },
};
