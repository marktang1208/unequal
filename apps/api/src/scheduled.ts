/**
 * M6.5 worker scheduled handler 模块（spec §5.3 + plan §4 Task 2）。
 *
 * 拆出独立模块的原因：
 * - 测试可独立 import { scheduled } 验证行为（不需要 import src/index.js）
 * - vitest 在 test/ 根目录解析 ../../src/index.js 有路径问题
 * - 关注点分离：scheduled handler 与 Hono app fetch 解耦
 *
 * index.ts 调用：`export default { fetch: app.fetch.bind(app), scheduled }`。
 */
import type { Env } from "./types.js";
import { cleanupLoginAttempts, DEFAULT_CUTOFF_MS } from "./lib/cleanup.js";

export async function scheduled(
  _event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  try {
    const result = await cleanupLoginAttempts(env, DEFAULT_CUTOFF_MS);
    console.log(`[cron] cleanup-login-attempts: deleted=${result.deleted}`);
  } catch (err) {
    console.error("[cron] cleanup-login-attempts failed:", err);
    // 不 re-throw：CF Workers scheduled handler 抛错会触发告警，但 cleanup 失败不需要 page
  }
}
