/**
 * M6.5 GET /stats/login-attempts（spec §6.1 + plan §4 Task 3a）。
 *
 * 鉴权：admin JWT (走 verifyAuth 统一入口，支持 admin_token + jwt 两种模式)
 * Query: hours (可选，默认 24, clamp 到 [1, 168])
 *
 * SQL 两次查询并发 (Promise.all):
 * - by_type: 按 attempt_type 聚合 failed/succeeded
 * - by_hour: 按 hour 整点 (created_at/3600000)*3600000 聚合
 *
 * 后端 buildStats 补 0 缺失桶（确保 by_hour.length === window_hours），
 * 用 UTC 整点对齐（与 SQL `(created_at/3600000)*3600000` 一致）。
 */
import type { Env } from "../types.js";
import { verifyAuth, HttpError } from "../lib/auth.js";

export interface LoginAttemptStats {
  window_hours: number;
  cutoff: number;
  total_failed: number;
  total_succeeded: number;
  by_type: {
    admin: { failed: number; succeeded: number };
    wx_code: { failed: number; succeeded: number };
  };
  by_hour: Array<{
    hour_ts: number;
    failed: number;
    succeeded: number;
  }>;
}

const BY_TYPE_SQL = `
SELECT attempt_type,
       SUM(CASE WHEN succeeded = 0 THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN succeeded = 1 THEN 1 ELSE 0 END) AS succeeded
FROM login_attempt
WHERE created_at > ?
GROUP BY attempt_type
`.trim();

const BY_HOUR_SQL = `
SELECT (created_at / 3600000) * 3600000 AS hour_ts,
       SUM(CASE WHEN succeeded = 0 THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN succeeded = 1 THEN 1 ELSE 0 END) AS succeeded
FROM login_attempt
WHERE created_at > ?
GROUP BY hour_ts
ORDER BY hour_ts ASC
`.trim();

export function clampHours(raw: number): number {
  if (!Number.isFinite(raw)) return 24;
  return Math.max(1, Math.min(168, Math.floor(raw)));
}

export function buildStats(
  hours: number,
  cutoff: number,
  byTypeRows: Array<{ attempt_type: string; failed: number; succeeded: number }>,
  byHourRows: Array<{ hour_ts: number; failed: number; succeeded: number }>,
): LoginAttemptStats {
  // 补 0 缺失桶（确保 by_hour.length === hours）
  // hour_ts = UTC 整点 unix ms（与 SQL `(created_at/3600000)*3600000` 一致）
  const buckets = new Map<number, { failed: number; succeeded: number }>();
  for (const row of byHourRows) {
    buckets.set(row.hour_ts, { failed: row.failed, succeeded: row.succeeded });
  }
  const now = Date.now();
  const currentHourTs = Math.floor(now / 3_600_000) * 3_600_000;
  const byHour: Array<{ hour_ts: number; failed: number; succeeded: number }> = [];
  for (let i = hours - 1; i >= 0; i--) {
    const hour_ts = currentHourTs - i * 3_600_000;
    byHour.push({
      hour_ts,
      ...(buckets.get(hour_ts) ?? { failed: 0, succeeded: 0 }),
    });
  }

  // 聚合 total + by_type
  const by_type = {
    admin: { failed: 0, succeeded: 0 },
    wx_code: { failed: 0, succeeded: 0 },
  };
  for (const row of byTypeRows) {
    if (row.attempt_type === "admin" || row.attempt_type === "wx_code") {
      by_type[row.attempt_type] = { failed: row.failed, succeeded: row.succeeded };
    }
  }
  const total_failed = by_type.admin.failed + by_type.wx_code.failed;
  const total_succeeded = by_type.admin.succeeded + by_type.wx_code.succeeded;

  return {
    window_hours: hours,
    cutoff,
    total_failed,
    total_succeeded,
    by_type,
    by_hour: byHour,
  };
}

export const statsRoute = {
  async GET_LOGIN_ATTEMPTS(request: Request, env: Env): Promise<Response> {
    // 鉴权：admin JWT (走统一入口)
    try {
      await verifyAuth(request, env);
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.code, message: err.message },
          { status: err.status },
        );
      }
      throw err;
    }

    // parse hours query
    const url = new URL(request.url);
    const hoursRaw = Number(url.searchParams.get("hours") ?? "24");
    const hours = clampHours(hoursRaw);
    const cutoff = Date.now() - hours * 3_600_000;

    try {
      const [byTypeRes, byHourRes] = await Promise.all([
        env.DB.prepare(BY_TYPE_SQL).bind(cutoff).all(),
        env.DB.prepare(BY_HOUR_SQL).bind(cutoff).all(),
      ]);
      const stats = buildStats(
        hours,
        cutoff,
        byTypeRes.results as Array<{ attempt_type: string; failed: number; succeeded: number }>,
        byHourRes.results as Array<{ hour_ts: number; failed: number; succeeded: number }>,
      );
      return Response.json(stats);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[stats] login-attempts query failed:", detail);
      return Response.json({ error: "internal", detail }, { status: 500 });
    }
  },
};
