/**
 * M6.3a 服务端 rate limit（spec §5.1 + §6）。
 *
 * 三个公开函数 + 两个常量：
 * - sha256Identifier(input) — hex 截 16 字符的 sha256（admin_token / wx_code 不入 D1）
 * - checkRateLimit(d1, identifier, type, now) — 查窗口内 failed count，> 阈值返 locked + retry_after
 * - recordAttempt(d1, identifier, type, succeeded, now) — INSERT 一行
 *
 * 阈值：MAX_FAILURES=5 / WINDOW_MS=900_000（15 分钟）。常量 export 供测试 & 文档。
 *
 * 不主动清理 login_attempt：单 identifier 15min 最多 5 行，5000 用户 = 25k 行/15min，索引足够。
 * M6.5+ 可加 cron 清理 24h 前的行。
 */
import { ulid } from "ulid";
import type { D1Database } from "@cloudflare/workers-types";

export const WINDOW_MS = 900_000;
export const MAX_FAILURES = 5;

export type AttemptType = "admin" | "wx_code";

export interface RateLimitResult {
  locked: boolean;
  retry_after: number; // 秒；未锁时为 0
}

/**
 * 把 admin_token / wx_code 哈希成 16 字符 hex（spec §5.1 step 1）。
 * Web Crypto 跨 runtime 行为一致：Workers / miniflare / Node 18+ 都内置。
 */
export async function sha256Identifier(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * 查窗口内 failed attempts，> 阈值返 locked。
 * retry_after = ceil((oldest_failed_created_at + WINDOW_MS - now) / 1000) — 即最早失败行"出窗口"剩余秒数。
 */
export async function checkRateLimit(
  d1: D1Database,
  identifier: string,
  type: AttemptType,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const since = now - WINDOW_MS;
  const countRow = await d1
    .prepare(
      `SELECT COUNT(*) AS c FROM login_attempt
       WHERE identifier = ? AND attempt_type = ? AND succeeded = 0
         AND created_at > ?`,
    )
    .bind(identifier, type, since)
    .first<{ c: number }>();
  const failedCount = countRow?.c ?? 0;
  if (failedCount < MAX_FAILURES) {
    return { locked: false, retry_after: 0 };
  }
  // 锁 → 计算 oldest failed 何时出窗口
  const minRow = await d1
    .prepare(
      `SELECT MIN(created_at) AS m FROM login_attempt
       WHERE identifier = ? AND attempt_type = ? AND succeeded = 0
         AND created_at > ?`,
    )
    .bind(identifier, type, since)
    .first<{ m: number | null }>();
  const oldest = minRow?.m ?? now;
  const retryAfter = Math.max(0, Math.ceil((oldest + WINDOW_MS - now) / 1000));
  return { locked: true, retry_after: retryAfter };
}

/**
 * 记一条 login attempt（成功或失败都记 — 失败用于 rate limit 窗口计数）。
 */
export async function recordAttempt(
  d1: D1Database,
  identifier: string,
  type: AttemptType,
  succeeded: boolean,
  now: number = Date.now(),
): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO login_attempt (id, identifier, attempt_type, succeeded, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(ulid(), identifier, type, succeeded ? 1 : 0, now)
    .run();
}
