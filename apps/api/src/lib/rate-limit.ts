/**
 * M6.3a + M6.4 + M6.6 服务端 rate limit（spec §5.1 + §6 + M6.6 §5-§6）。
 *
 * M6.3a 三个公开函数 + 两个常量：
 * - sha256Identifier(input) — hex 截 16 字符的 sha256（admin_token / wx_code 不入 D1）
 * - checkRateLimit(d1, identifier, type, now?, config?) — 查窗口内 failed count，> 阈值返 locked + retry_after
 * - recordAttempt(d1, identifier, type, succeeded, now) — INSERT 一行
 *
 * 阈值：MAX_FAILURES=5 / WINDOW_MS=900_000（15 分钟）。常量 export 供测试 & 文档。
 *
 * M6.4：阈值提取到 wrangler vars（LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS）。
 *   readRateLimitConfig(env) 读 env + 缺/非法 fallback DEFAULT_RATE_LIMIT_CONFIG。
 *   checkRateLimit 加可选 config 参数（向后兼容：now 第 4 默认参数，config 第 5 可选）。
 *
 * M6.6：加 per-IP 维度消除"换 token 绕过"攻击面。
 *   - getClientIp(req) — 读 CF-Connecting-IP header，缺则 "unknown"
 *   - sha256ClientIp(ip) — 镜像 sha256Identifier 签名；"unknown" 短路返 UNKNOWN_IP_HASH
 *   - checkRateLimitByIp(d1, clientIpHash, type, ...) — 镜像 checkRateLimit 签名，SQL WHERE client_ip = ?
 *   - checkRateLimitDual(d1, identifier, clientIpHash, type, ...) — 串两次 + 合并；任一锁即整体锁
 *   - recordAttempt 签名加 clientIpHash 必填参数（向后兼容破坏 — Task 2 改）
 *
 * 不主动清理 login_attempt：单 identifier 15min 最多 5 行，5000 用户 = 25k 行/15min，索引足够。
 * M6.4 task 3 加 cron DELETE WHERE created_at < ? 清理 24h 前数据。
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

/** M6.4: rate limit 配置（env 注入路径） */
export interface RateLimitConfig {
  maxFailures: number;
  windowMs: number;
}

/** M6.4: 默认 rate limit 配置（不变行为；env 缺/非法 fallback 此值） */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxFailures: MAX_FAILURES,
  windowMs: WINDOW_MS,
};

/**
 * M6.4: 从 env 读 rate limit 配置（缺失或非法值 fallback 默认）。
 * - LOGIN_MAX_ATTEMPTS 缺 / 非数字 / ≤ 0 → fallback default maxFailures
 * - LOGIN_WINDOW_MS 缺 / 非数字 / ≤ 0 → fallback default windowMs
 */
export function readRateLimitConfig(
  envLike: { LOGIN_MAX_ATTEMPTS?: string; LOGIN_WINDOW_MS?: string },
): RateLimitConfig {
  const parse = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    maxFailures: parse(envLike.LOGIN_MAX_ATTEMPTS, MAX_FAILURES),
    windowMs: parse(envLike.LOGIN_WINDOW_MS, WINDOW_MS),
  };
}

/**
 * M6.6: 读 CF-Connecting-IP header，缺则返 "unknown"。
 * CF 边缘节点自动注入，client 不可伪造（生产 100% 注入）。
 * dev/miniflare 需 mock 头部。
 * HTTP/2 规范 header 名小写；req.headers.get 大小写不敏感。
 */
export function getClientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "unknown";
}

/**
 * M6.6: "unknown" IP 固定 hash（缺 header 请求共享 bucket — 防御性合并）。
 * 16 字符固定值，与 sha256Identifier 16 字符 hex 截断同模式。
 */
export const UNKNOWN_IP_HASH = "unknown000000000"; // 16 字符固定 (unknown=7 + 9 个 0)

/**
 * M6.6: 完整 IP 字符串 sha256 截 16 字符（v4/v6 不区分）。
 * 镜像 sha256Identifier 签名；"unknown" 短路返 UNKNOWN_IP_HASH（不重新计算）。
 * PII-safe：与 identifier 字段同模式，不存明文 IP。
 */
export async function sha256ClientIp(ip: string): Promise<string> {
  if (ip === "unknown") return UNKNOWN_IP_HASH;
  const bytes = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
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
 * retry_after = ceil((oldest_failed_created_at + config.windowMs - now) / 1000)
 *   — 即最早失败行"出窗口"剩余秒数。
 *
 * M6.4 改签名：now 第 4 默认参数（向后兼容），config 第 5 可选（默认 DEFAULT_RATE_LIMIT_CONFIG）。
 * 旧调用方 checkRateLimit(d1, id, type, now) 不破坏；新调用方可传 config 注入阈值/窗口。
 */
export async function checkRateLimit(
  d1: D1Database,
  identifier: string,
  type: AttemptType,
  now: number = Date.now(),
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
): Promise<RateLimitResult> {
  const since = now - config.windowMs;
  const countRow = await d1
    .prepare(
      `SELECT COUNT(*) AS c FROM login_attempt
       WHERE identifier = ? AND attempt_type = ? AND succeeded = 0
         AND created_at > ?`,
    )
    .bind(identifier, type, since)
    .first<{ c: number }>();
  const failedCount = countRow?.c ?? 0;
  if (failedCount < config.maxFailures) {
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
  const retryAfter = Math.max(0, Math.ceil((oldest + config.windowMs - now) / 1000));
  return { locked: true, retry_after: retryAfter };
}

/**
 * M6.6: per-IP 维度限流查询（镜像 checkRateLimit 签名）。
 * SQL WHERE client_ip = ?（vs checkRateLimit 的 WHERE identifier = ?）。
 * 其他逻辑完全相同：succeeded=0 / created_at > since / 5 阈值 / oldest 出窗口 retry_after。
 */
export async function checkRateLimitByIp(
  d1: D1Database,
  clientIpHash: string,
  type: AttemptType,
  now: number = Date.now(),
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
): Promise<RateLimitResult> {
  const since = now - config.windowMs;
  const countRow = await d1
    .prepare(
      `SELECT COUNT(*) AS c FROM login_attempt
       WHERE client_ip = ? AND attempt_type = ? AND succeeded = 0
         AND created_at > ?`,
    )
    .bind(clientIpHash, type, since)
    .first<{ c: number }>();
  const failedCount = countRow?.c ?? 0;
  if (failedCount < config.maxFailures) {
    return { locked: false, retry_after: 0 };
  }
  const minRow = await d1
    .prepare(
      `SELECT MIN(created_at) AS m FROM login_attempt
       WHERE client_ip = ? AND attempt_type = ? AND succeeded = 0
         AND created_at > ?`,
    )
    .bind(clientIpHash, type, since)
    .first<{ m: number | null }>();
  const oldest = minRow?.m ?? now;
  const retryAfter = Math.max(0, Math.ceil((oldest + config.windowMs - now) / 1000));
  return { locked: true, retry_after: retryAfter };
}

/**
 * M6.6: 双层独立限流（per-token AND per-IP）。
 * Promise.all 并发 2 次 SQL（< 10ms 总耗时）。
 * 任一维度锁 → 整体锁（retry_after = 锁维度的 retry_after，保守 = max）。
 */
export async function checkRateLimitDual(
  d1: D1Database,
  identifier: string,
  clientIpHash: string,
  type: AttemptType,
  now: number = Date.now(),
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
): Promise<RateLimitResult> {
  const [tokenResult, ipResult] = await Promise.all([
    checkRateLimit(d1, identifier, type, now, config),
    checkRateLimitByIp(d1, clientIpHash, type, now, config),
  ]);
  if (tokenResult.locked) return tokenResult;
  if (ipResult.locked) return ipResult;
  return { locked: false, retry_after: 0 };
}

/**
 * 记一条 login attempt（成功或失败都记 — 失败用于 rate limit 窗口计数）。
 *
 * M6.6 改签名：加 clientIpHash 第 5 必填参数（per-IP 限流数据源）。
 * - clientIpHash：来自 getClientIp(req) → sha256ClientIp(ip)；缺 header 传 UNKNOWN_IP_HASH
 * - 不设默认值：调用方必须显式表达"已知 IP"或"unknown"
 * - INSERT SQL 加 client_ip 列（M6.6 migration 0008 加列）
 */
export async function recordAttempt(
  d1: D1Database,
  identifier: string,
  type: AttemptType,
  succeeded: boolean,
  clientIpHash: string,
  now: number = Date.now(),
): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO login_attempt (id, identifier, attempt_type, succeeded, client_ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(ulid(), identifier, type, succeeded ? 1 : 0, clientIpHash, now)
    .run();
}
