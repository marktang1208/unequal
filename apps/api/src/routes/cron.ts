/**
 * M6.4 cron 清理（spec §5.3 + plan §4 Task 3）。
 *
 * POST /cron/cleanup-login-attempts
 * Authorization: Bearer <env.CRON_SECRET>
 *
 * 行为：
 * - 验 Authorization header == `Bearer ${env.CRON_SECRET}` → 否则 401 UNAUTHORIZED
 * - DELETE FROM login_attempt WHERE created_at < (now - 24h)
 * - 返 { deleted: N, cutoff: timestamp }
 *
 * 为什么 HTTP endpoint 而非 Cloudflare scheduled handler：
 * - 测试 mock 简单（fetchImpl + Authorization header 注入）
 * - 与现有 Hono app fetch 路径一致（不引入 ScheduledController 类型）
 * - 触发方式灵活（CP-5 真接时可选：wrangler scheduled handler / external cron / launchd）
 * - 缺点：CP-5 时需用户决定实际触发方式（M6.4 范围内不强制做 scheduled handler）
 */
import type { Env } from "../types.js";

const CLEANUP_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 小时

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

    const now = Date.now();
    const cutoff = now - CLEANUP_THRESHOLD_MS;
    try {
      const result = await env.DB
        .prepare("DELETE FROM login_attempt WHERE created_at < ?")
        .bind(cutoff)
        .run();
      return Response.json({
        deleted: result.meta.changes ?? 0,
        cutoff,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: "internal", detail: msg }, { status: 500 });
    }
  },
};
