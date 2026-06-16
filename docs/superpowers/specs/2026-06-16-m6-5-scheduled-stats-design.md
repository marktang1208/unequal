# M6.5 — Scheduled Handler Wrap + Admin Stats Dashboard

**版本**: 2026-06-16
**前置**: M6.4 rate-limit vars + cron cleanup + inflight promise（已 merge `a0c81be`）
**范围**: M6.5 — 2 项运维增强：(1) scheduled handler 真接 Cloudflare Cron Triggers；(2) admin 端 login_attempt 可视化 dashboard

---

## 1. Requirements

| # | 现状 | 目标 |
|---|---|---|
| 1 | M6.4 只做了 HTTP `POST /cron/cleanup-login-attempts`（CP-5 决策点：wrangler cron / external cron 二选一）| 抽 `cleanupLoginAttempts(env, cutoffMs)` 内部函数 + 加 worker.scheduled handler + wrangler `triggers.crons` → 真接 CF 后 cron 自动跑 |
| 2 | login_attempt 表只增，无可视化（CP-3 排查靠 D1 SQL 直查）| 新 `GET /stats/login-attempts?hours=24`（admin JWT 鉴权）+ admin `/stats` 页面（数字卡 + 类型分布 + 24h CSS bars）|

**为什么 YAGNI 精简**（区别于 state-m6-4.md "下一步建议" 全 6 项）：
- ❌ 不做 `top_failed_identifiers`（YAGNI：by_hour + by_type 已能看出 attack pattern，加 SQL + UI 复杂度不值）
- ❌ 不做 day 级聚合（>168h 才需要；admin 看 7d 已够）
- ❌ 不上图表库（recharts +95KB vs CSS bars 0KB；admin 是运维工具，CSS bars 够用）
- ❌ 不做 scheduled handler 鉴权（CF Cron Triggers 是控制面触发，不暴露公网）
- ✅ 只做能 mock-first 完整覆盖 + 真接 Cloudflare 后立刻有真实价值的 2 项

---

## 2. Patterns to Mirror

| 类别 | 来源 | 复用方式 |
|---|---|---|
| 内部 lib 函数 | `apps/api/src/lib/rate-limit.ts` `checkRateLimit` 模式 | 抽 `cleanupLoginAttempts(env, cutoffMs): Promise<{ deleted: number }>` 独立测试 |
| Hono route handler | `apps/api/src/routes/cron.ts:22-50` `cronRoute.CLEANUP_LOGIN_ATTEMPTS` | HTTP 端点改调 `cleanupLoginAttempts`（不再 inline SQL） |
| Worker scheduled handler | Cloudflare Workers 文档：`{ fetch, scheduled }` default export | wrap 当前 `export default app` 为 `{ fetch: app.fetch.bind(app), scheduled }` |
| D1 SQL aggregation | `apps/api/src/routes/ask.ts` 双查询模式 | stats 用两次 `Promise.all` 并发（by_type + by_hour） |
| admin JWT 鉴权 | `apps/api/src/routes/auth.ts` `verifyAdminToken` | statsRoute GET 复用同一 helper |
| admin `authedJson` helper | `apps/admin/src/lib/api.ts:189-204` | 新 `getLoginAttemptStats(hours)` 用同一 helper |
| admin page 模式 | `apps/admin/src/pages/ChatSim.tsx` useEffect + fetch + 错误处理 | StatsPage 复用同一模式 |
| mock-first 边界标注 | state-m6-4.md §"mock-first 边界" 章节 | state-m6-5.md 复用同结构 |

---

## 3. Architecture Overview

2 项独立但耦合（admin UI 消费 api 端点）：

```
─── Task 1 (#4 scheduled handler wrap) ───────────────────────────
apps/api/src/lib/cleanup.ts  ← 抽 cleanupLoginAttempts(env, cutoffMs)
  ↓ 调
apps/api/src/routes/cron.ts  ← CLEANUP_LOGIN_ATTEMPTS HTTP 端点改调 cleanup 函数
  ↓ 调（同样）
apps/api/src/index.ts  ← export default { fetch, scheduled }
                           scheduled handler 调 cleanup 函数
  ↓ 配
apps/api/wrangler.jsonc  ← triggers.crons = ["0 3 * * *"]  // 每日 UTC 03:00

─── Task 2 (#5 login_attempt stats dashboard) ────────────────────
admin StatsPage (/stats 路由)
  ↓ useEffect([hours])
apps/admin/src/lib/api.ts  ← getLoginAttemptStats(hours)
  ↓ fetch /api/stats/login-attempts?hours=24
apps/api/src/routes/stats.ts  ← GET /stats/login-attempts
  ↓ verifyAdminToken (401 if invalid)
  ↓ parse hours → clampHours(raw, [1, 168])
  ↓
D1 Promise.all 并发:
  ├─ by_type:  SELECT attempt_type, SUM(CASE succeeded WHEN 0 THEN 1 ELSE 0 END) AS failed,
  │            SUM(CASE WHEN succeeded=1 THEN 1 ELSE 0 END) AS succeeded
  │            FROM login_attempt WHERE created_at > cutoff GROUP BY attempt_type
  └─ by_hour:  SELECT (created_at/3600000)*3600000 AS hour_ts,
               SUM(CASE succeeded WHEN 0 THEN 1 ELSE 0 END) AS failed,
               SUM(CASE WHEN succeeded=1 THEN 1 ELSE 0 END) AS succeeded
               FROM login_attempt WHERE created_at > cutoff GROUP BY hour_ts ORDER BY hour_ts ASC
  ↓
buildStats(hours, cutoff, byTypeRows, byHourRows)  ← 补 0 缺失桶
  ↓
Return LoginAttemptStats JSON
  ↓
admin StatsPage: 4 数字卡 + by_type 表格 + 24/72/168h CSS bars（Asia/Shanghai 时区）
```

---

## 4. Files to Change

### 新建（10 个 = 7 代码 + 3 文档）

| 文件 | 行数 | 内容 |
|---|---|---|
| `apps/api/src/lib/cleanup.ts` | ~30 | `cleanupLoginAttempts(env, cutoffMs)` + `DEFAULT_CUTOFF_MS = 86_400_000` |
| `apps/api/test/lib/cleanup.test.ts` | ~120 | 4 测试（happy / empty / cutoff 边界 / D1 throws）|
| `apps/api/src/routes/stats.ts` | ~120 | `statsRoute.GET_LOGIN_ATTEMPTS` handler + `clampHours` + `buildStats` + types |
| `apps/api/test/routes/stats.test.ts` | ~180 | 7 测试（happy empty / happy mixed / 跨小时 / 401 / hours clamp / hours=1 / hours 缺省）|
| `apps/api/test/index.test.ts` | ~60 | 2 测试（scheduled happy / scheduled 错误）|
| `apps/admin/src/pages/StatsPage.tsx` | ~180 | 4 数字卡 + by_type TypeRow + HourBars CSS bars |
| `apps/admin/src/pages/StatsPage.test.tsx` | ~100 | 3 测试（渲染+数据 / 切换 hours / 错误态）|
| `docs/superpowers/specs/2026-06-16-m6-5-scheduled-stats-design.md` | — | 本文档 |
| `docs/superpowers/plans/2026-06-16-m6-5-scheduled-stats.md` | — | 实施计划（commit 拆分 + CP 节点）|
| `docs/superpowers/state-m6-5.md` | — | 收尾归档（主线程写）|

### 修改（7 个）

| 文件 | 改动 | 内容 |
|---|---|---|
| `apps/api/src/routes/cron.ts` | UPDATE | inline DELETE SQL 删除，改 `cleanupLoginAttempts(env, DEFAULT_CUTOFF_MS)` 调用 |
| `apps/api/src/index.ts` | UPDATE | `export default app` → `{ fetch, scheduled }`；加 `app.get("/stats/login-attempts", ...)` |
| `apps/api/wrangler.jsonc` | UPDATE | +3 行 `triggers.crons = ["0 3 * * *"]` |
| `apps/api/test/routes/cron.test.ts` | UPDATE | happy path 测试断言不变（仍走 fakeDB），4 测试保留 |
| `apps/admin/src/lib/api.ts` | UPDATE | +15 行 `getLoginAttemptStats(hours)` helper + `LoginAttemptStats` interface |
| `apps/admin/src/App.tsx` | UPDATE | +3 行（import + route `<Route path="/stats">` + nav `<Link to="/stats">`）|
| `README.md` | UPDATE | +M6.5 状态节（行为示例 + 测试矩阵）|

**总计**：10 新建 + 7 修改 = 17 改动文件。

---

## 5. Task 1: Scheduled Handler Wrap

### 5.1 `cleanupLoginAttempts` 函数抽取

**位置**: `apps/api/src/lib/cleanup.ts`（新文件，~30 行）

```typescript
import type { Env } from "../types.js";

export interface CleanupResult {
  deleted: number;
}

/**
 * M6.5 抽取：login_attempt 表清理逻辑（与 transport 分离）。
 *
 * 被 cronRoute.CLEANUP_LOGIN_ATTEMPTS (HTTP) 和 worker.scheduled (CF Cron Triggers) 共用。
 *
 * 注意：login_attempt.created_at 是 INTEGER（unix ms），cutoff 也用 INTEGER，
 * 保证 SQL `<` 比较语义正确。
 */
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
```

### 5.2 `cronRoute` 改动（改 inline SQL → 调 cleanup）

```typescript
import { cleanupLoginAttempts, DEFAULT_CUTOFF_MS } from "../lib/cleanup.js";

export const cronRoute = {
  async CLEANUP_LOGIN_ATTEMPTS(request: Request, env: Env): Promise<Response> {
    const auth = request.headers.get("Authorization");
    const expected = `Bearer ${env.CRON_SECRET ?? ""}`;
    if (auth !== expected) {
      return Response.json(
        { error: "UNAUTHORIZED", message: "Invalid or missing CRON_SECRET" },
        { status: 401 }
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
```

**测试保留**：`apps/api/test/routes/cron.test.ts` 现有 4 测试（happy / empty / 401 missing / 401 wrong）行为不变，断言不变（仍走 fakeDB 端到端）。

### 5.3 worker.scheduled handler wrap

**`apps/api/src/index.ts` 末尾**：

```typescript
import { cleanupLoginAttempts, DEFAULT_CUTOFF_MS } from "./lib/cleanup.js";

// 替换原 export default app：
export default {
  fetch: app.fetch.bind(app),
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    try {
      const result = await cleanupLoginAttempts(env, DEFAULT_CUTOFF_MS);
      console.log(`[cron] cleanup-login-attempts: deleted=${result.deleted}`);
    } catch (err) {
      console.error("[cron] cleanup-login-attempts failed:", err);
      // 不 re-throw：CF Workers scheduled handler 抛错会触发告警，但 cleanup 失败不需要 page
    }
  },
};
```

### 5.4 wrangler `triggers.crons`

**`apps/api/wrangler.jsonc`** (+3 行)：

```jsonc
"triggers": {
  "crons": ["0 3 * * *"]
}
```

**cron 表达式说明**：
- `0 3 * * *` = 每日 UTC 03:00 触发
- UTC 时间（Cron Triggers 用 UTC，与本地时区无关）
- 凌晨低峰期，对用户无感知

### 5.5 关键决策

| 决策 | 选项 | 选择 | 理由 |
|---|---|---|---|
| cleanup 窗口 | 24h / 7d / 30d | **24h**（与 M6.4 一致）| 最小变更；7d 也是合理但无强需求 |
| scheduled 触发频率 | 每小时 / 每日 / 每周 | **每日**（`0 3 * * *`）| login_attempt 数据量低，无需小时级；每周太粗 |
| scheduled handler 鉴权 | 不加 / 加 CRON_SECRET | **不加** | CF Cron Triggers 是控制面触发，不暴露公网 |
| HTTP `/cron/cleanup-login-attempts` 端点 | 保留 / 废弃 | **保留** | scheduled 是主路径，HTTP 备用（外部 cron 兼容） |

### 5.6 测试覆盖

**`apps/api/test/lib/cleanup.test.ts`**（4 测试）:
1. `happy path: 3-old-2-new → { deleted: 3 }` — fakeDB stub meta.changes=3
2. `空表 → { deleted: 0 }` — fakeDB stub meta.changes=0
3. `cutoffMs 边界: 0 / Infinity / 负数` — cutoff=0 删全部，cutoff=Infinity 删 0
4. `D1 throws → cleanup throws` — env.DB.prepare throws，向上抛

**`apps/api/test/index.test.ts`**（2 测试）:
1. `scheduled happy: 调 cleanup + console.log "deleted=N"` — spy cleanupLoginAttempts + spy console.log
2. `scheduled 错误: cleanup throws → console.error, 不 re-throw` — mock cleanup throws，验证 console.error 被调 + 没有向上抛

---

## 6. Task 2: Admin Stats Dashboard

### 6.1 API 端点 `GET /stats/login-attempts`

**位置**: `apps/api/src/routes/stats.ts`（新文件，~120 行）

**鉴权**: `verifyAdminToken` (Bearer JWT，admin 角色)

**Query 参数**:
- `hours` (可选，默认 24，clamp 到 [1, 168])

**响应 schema**:
```typescript
export interface LoginAttemptStats {
  window_hours: number;       // echo 回传给前端的 clamp 后值
  cutoff: number;             // unix ms cutoff
  total_failed: number;
  total_succeeded: number;
  by_type: {
    admin:   { failed: number; succeeded: number };
    wx_code: { failed: number; succeeded: number };
  };
  by_hour: Array<{
    hour_ts: number;          // hour 起始 unix ms
    failed: number;
    succeeded: number;
  }>;                         // length === window_hours
}
```

**实现结构**:
```typescript
export const statsRoute = {
  async GET_LOGIN_ATTEMPTS(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const hours = clampHours(Number(url.searchParams.get("hours") ?? "24"));
    const cutoff = Date.now() - hours * 3_600_000;

    try {
      const [byTypeRes, byHourRes] = await Promise.all([
        env.DB.prepare(BY_TYPE_SQL).bind(cutoff).all(),
        env.DB.prepare(BY_HOUR_SQL).bind(cutoff).all(),
      ]);
      return Response.json(
        buildStats(hours, cutoff, byTypeRes.results as any[], byHourRes.results as any[])
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[stats] login-attempts query failed:", detail);
      return Response.json({ error: "internal", detail }, { status: 500 });
    }
  },
};

function clampHours(raw: number): number {
  if (!Number.isFinite(raw)) return 24;
  return Math.max(1, Math.min(168, Math.floor(raw)));
}

function buildStats(
  hours: number,
  cutoff: number,
  byTypeRows: Array<{ attempt_type: string; failed: number; succeeded: number }>,
  byHourRows: Array<{ hour_ts: number; failed: number; succeeded: number }>
): LoginAttemptStats {
  // 补 0 缺失桶（确保 by_hour.length === hours）
  // hour_ts = UTC 整点 unix ms（与 SQL `(created_at/3600000)*3600000` 一致）
  const buckets = new Map<number, { failed: number; succeeded: number }>();
  for (const row of byHourRows) {
    buckets.set(row.hour_ts, { failed: row.failed, succeeded: row.succeeded });
  }
  const now = Date.now();
  const currentHourTs = Math.floor(now / 3_600_000) * 3_600_000;
  const byHour = [];
  for (let i = hours - 1; i >= 0; i--) {
    const hour_ts = currentHourTs - i * 3_600_000;
    byHour.push({ hour_ts, ...(buckets.get(hour_ts) ?? { failed: 0, succeeded: 0 }) });
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

  return { window_hours: hours, cutoff, total_failed, total_succeeded, by_type, by_hour: byHour };
}
```

**SQL**:
```sql
-- by_type
SELECT attempt_type,
       SUM(CASE WHEN succeeded = 0 THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN succeeded = 1 THEN 1 ELSE 0 END) AS succeeded
FROM login_attempt
WHERE created_at > ?
GROUP BY attempt_type;

-- by_hour (利用 idx_login_attempt_created_at 索引)
SELECT (created_at / 3600000) * 3600000 AS hour_ts,
       SUM(CASE WHEN succeeded = 0 THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN succeeded = 1 THEN 1 ELSE 0 END) AS succeeded
FROM login_attempt
WHERE created_at > ?
GROUP BY hour_ts
ORDER BY hour_ts ASC;
```

### 6.2 路由挂载

**`apps/api/src/index.ts`** (+1 行)：
```typescript
app.get("/stats/login-attempts", (c) => statsRoute.GET_LOGIN_ATTEMPTS(c.req.raw, c.env));
```

### 6.3 admin `getLoginAttemptStats` helper

**`apps/admin/src/lib/api.ts`** (+15 行)：
```typescript
export interface LoginAttemptStats {
  window_hours: number;
  cutoff: number;
  total_failed: number;
  total_succeeded: number;
  by_type: {
    admin: { failed: number; succeeded: number };
    wx_code: { failed: number; succeeded: number };
  };
  by_hour: Array<{ hour_ts: number; failed: number; succeeded: number }>;
}

export async function getLoginAttemptStats(hours: number): Promise<LoginAttemptStats> {
  return authedJson<LoginAttemptStats>(`/stats/login-attempts?hours=${hours}`, { method: "GET" });
}
```

### 6.4 admin `StatsPage` 设计

**位置**: `apps/admin/src/pages/StatsPage.tsx`（新文件，~180 行）

**结构**:
```tsx
import { useEffect, useState } from "react";
import { getLoginAttemptStats, type LoginAttemptStats } from "../lib/api.js";

const HOURS_OPTIONS = [
  { value: 24, label: "最近 24h" },
  { value: 72, label: "最近 72h" },
  { value: 168, label: "最近 7d" },
];

export default function StatsPage() {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<LoginAttemptStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getLoginAttemptStats(hours)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((err) => {
        if (!cancelled) { setError(err instanceof Error ? err.message : String(err)); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, [hours]);

  const total = (data?.total_failed ?? 0) + (data?.total_succeeded ?? 0);
  const failureRate = total > 0 ? ((data!.total_failed / total) * 100).toFixed(1) : "0.0";

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">登录尝试统计</h2>
        <select
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
          className="rounded border border-gray-300 px-3 py-1 text-sm"
        >
          {HOURS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </header>

      {loading && <p className="text-sm text-gray-500">加载中…</p>}
      {error && <p className="text-sm text-red-600">stats failed: {error}</p>}

      {data && (
        <>
          {/* 4 数字卡 */}
          <div className="grid grid-cols-4 gap-4">
            <StatCard label="失败" value={data.total_failed} color="red" />
            <StatCard label="成功" value={data.total_succeeded} color="green" />
            <StatCard label="失败率" value={`${failureRate}%`} />
            <StatCard label="总尝试" value={total} />
          </div>

          {/* by_type 分布 */}
          <div className="rounded border border-gray-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-semibold">类型分布</h3>
            <TypeRow label="Admin login" data={data.by_type.admin} />
            <TypeRow label="Wx code" data={data.by_type.wx_code} />
          </div>

          {/* by_hour CSS bars */}
          <div className="rounded border border-gray-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-semibold">每小时分布（UTC+8）</h3>
            {data.by_hour.some((h) => h.failed + h.succeeded > 0) ? (
              <HourBars hours={data.by_hour} />
            ) : (
              <p className="text-sm text-gray-500">暂无登录尝试</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function StatCard({ label, value, color }: { label: string; value: number | string; color?: "red" | "green" }) {
  const colorClass = color === "red" ? "text-red-600" : color === "green" ? "text-green-600" : "text-gray-900";
  return (
    <div className="rounded border border-gray-200 bg-white p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${colorClass}`}>{value}</div>
    </div>
  );
}

function TypeRow({ label, data }: { label: string; data: { failed: number; succeeded: number } }) {
  const total = data.failed + data.succeeded;
  const failedPct = total > 0 ? (data.failed / total) * 100 : 0;
  return (
    <div className="mb-2 last:mb-0">
      <div className="flex justify-between text-xs">
        <span>{label}</span>
        <span className="text-gray-500">
          failed={data.failed} succeeded={data.succeeded}
        </span>
      </div>
      <div className="mt-1 flex h-4 overflow-hidden rounded bg-gray-100">
        <div className="bg-red-500" style={{ width: `${failedPct}%` }} />
        <div className="bg-green-500" style={{ width: `${100 - failedPct}%` }} />
      </div>
    </div>
  );
}

function HourBars({ hours }: { hours: Array<{ hour_ts: number; failed: number; succeeded: number }> }) {
  const max = Math.max(1, ...hours.map((h) => h.failed + h.succeeded));
  return (
    <div className="flex h-32 items-end gap-1">
      {hours.map((h) => {
        const total = h.failed + h.succeeded;
        const failedPct = (h.failed / max) * 100;
        const succeededPct = (h.succeeded / max) * 100;
        const label = new Date(h.hour_ts).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour: "2-digit",
          minute: "2-digit",
        });
        return (
          <div
            key={h.hour_ts}
            className="flex flex-1 flex-col justify-end"
            title={`${label} (UTC+8): failed=${h.failed} succeeded=${h.succeeded}`}
          >
            {total > 0 && (
              <>
                <div className="bg-red-500" style={{ height: `${failedPct}%` }} />
                <div className="bg-green-500" style={{ height: `${succeededPct}%` }} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

### 6.5 路由 + nav 集成

**`apps/admin/src/App.tsx`** (+3 行)：
- import 加 `import StatsPage from "./pages/StatsPage.js";`
- nav 加 `<Link to="/stats">统计</Link>` (在 nav 列表中)
- routes 加 `<Route path="/stats" element={<RequireAuth><StatsPage /></RequireAuth>} />`

---

## 7. 数据流

### 7.1 流 A：admin query stats

```
admin StatsPage useEffect([hours])
  ↓
getLoginAttemptStats(hours)
  ↓ fetch /api/stats/login-attempts?hours=24
  Authorization: Bearer <admin_jwt>
  ↓
api GET /stats/login-attempts
  ↓ verifyAdminToken (401 if invalid)
  ↓ parse hours query → clampHours(24, [1, 168])
  ↓ cutoff = Date.now() - hours * 3_600_000
  ↓
D1 Promise.all 并发:
  ├─ by_type:  SELECT attempt_type, SUM(CASE...) FROM login_attempt WHERE created_at > cutoff GROUP BY attempt_type
  └─ by_hour:  SELECT (created_at/3600000)*3600000 AS hour_ts, SUM(...) FROM login_attempt WHERE created_at > cutoff GROUP BY hour_ts ORDER BY hour_ts ASC
  ↓
buildStats(hours, cutoff, byTypeRows, byHourRows)  ← 补 0 缺失桶
  ↓
Return LoginAttemptStats JSON
  ↓
admin StatsPage: setState(data) + re-render
  ├─ StatCard × 4 (失败 / 成功 / 失败率 / 总尝试)
  ├─ TypeRow × 2 (admin / wx_code)
  └─ HourBars (24/72/168 个竖条 + Asia/Shanghai tooltip)
```

### 7.2 流 B：scheduled cleanup

```
CF Cron Trigger (每日 UTC 03:00 "0 3 * * *")
  ↓
worker.scheduled(event, env, ctx)
  ↓ try {
    result = await cleanupLoginAttempts(env, DEFAULT_CUTOFF_MS = 86_400_000)
    ↓
    D1: DELETE FROM login_attempt WHERE created_at < (Date.now() - 86_400_000)
    ↓
    console.log `[cron] cleanup-login-attempts: deleted=${result.deleted}`
  } catch (err) {
    console.error("[cron] cleanup-login-attempts failed:", err)
  }
```

---

## 8. 错误处理

### 8.1 api stats endpoint

| 场景 | 状态码 | 响应 | 日志 |
|---|---|---|---|
| 缺/无效 admin_token | 401 | `{ error: "UNAUTHORIZED" }` (verifyAdminToken 内) | — |
| `hours` 缺省 / NaN / ≤0 / >168 | 200 | clamp 到合法值后正常返回 | — |
| D1 by_type 查询失败 | 500 | `{ error: "internal", detail }` | `console.error("[stats] by_type failed:", err)` |
| D1 by_hour 查询失败 | 500 | `{ error: "internal", detail }` | `console.error("[stats] by_hour failed:", err)` |
| by_hour 部分桶缺失 | 200 | 后端补 0（`by_hour.length === hours`） | — |

### 8.2 scheduled handler

| 场景 | 行为 |
|---|---|
| `cleanupLoginAttempts` 成功 | `console.log("[cron] cleanup-login-attempts: deleted=N")` |
| `cleanupLoginAttempts` throws | `console.error("[cron] cleanup-login-attempts failed:", err)` + **不 re-throw**（防 worker panic） |
| `env.DB` 不可用 | throws → 同上 catch 兜底 |

**不鉴权**（明确决策）：CF Cron Triggers 是 Cloudflare 控制面触发，不暴露公网 HTTP，不需要 CRON_SECRET 校验。

### 8.3 admin StatsPage

| 场景 | UI |
|---|---|
| fetch 401 | `handleApiResponse` 自动清 token + `window.location.href = "/login"` |
| fetch 500 | `setError("stats failed: 500 ...")` + 红字提示 |
| fetch network error | `setError(err.message)` + 红字提示 |
| data 为 null + loading | "加载中…" |
| `by_hour` 全 0（无数据） | bars 区显示"暂无登录尝试"占位文字 |
| `by_hour` max = 0（除零防御）| `Math.max(1, ...)` 双保险 + bars 高度永远 ≥1px |
| 切换 hours | 立即 setLoading(true) + 重新 fetch（不等上一次返回，cancelled flag 防止 race）|

---

## 9. 测试策略

### 9.1 TDD 流程（每 commit 都走）
1. RED：先写测试 + 跑 vitest → 红
2. GREEN：最小实现让测试绿
3. REFACTOR：抽函数 / 清理重复

### 9.2 Mock-first 边界

| 组件 | Mock 方式 | 不能 mock（CP-5 真接） |
|---|---|---|
| `cleanupLoginAttempts` | vitest fakeDB（spy prepare/bind/run） | 真 D1 SQL 执行 + DELETE 性能 |
| `cronRoute` HTTP | fakeDB + fake fetch + auth header mock | 真 Hono routing |
| `scheduled` handler | 直接调用 default.scheduled + spy cleanupLoginAttempts | 真 CF Cron Triggers 触发时机 |
| `statsRoute` SQL 两次查询 | fakeDB stub rows（byType + byHour） | 真 D1 SQL 执行计划 + Promise.all 真实并发 |
| `verifyAdminToken` | mock jwt verify（已有覆盖） | 真 jwt 签名验证 |
| admin `getLoginAttemptStats` | `vi.spyOn(global, "fetch")` | 真网络 + 真 CORS |
| admin `StatsPage` | mock fetch + render | 真 DOM 滚动 + 真 hover |

### 9.3 累计测试矩阵

| 文件 | 测试数 | 覆盖 |
|---|---|---|
| `apps/api/test/lib/cleanup.test.ts` (新) | 4 | happy / empty / cutoff 边界 / D1 throws |
| `apps/api/test/index.test.ts` (新) | 2 | scheduled happy / scheduled 错误 |
| `apps/api/test/routes/stats.test.ts` (新) | 7 | happy empty / happy mixed / 跨小时 / 401 / hours clamp / hours=1 / hours 缺省 |
| `apps/admin/src/pages/StatsPage.test.tsx` (新) | 3 | 渲染+数据 / 切换 hours / 错误态 |
| `apps/api/test/routes/cron.test.ts` (改, 4 保持) | 4 | HTTP auth + 调 cleanup，行为不变 |

**累计**：M6.5 = **16 新测试** + 0 改测试

**仓库总累计**：M6.4 收尾 219 → M6.5 后 **235**

| 包 | M6.5 增量 | 累计 |
|---|---|---|
| api | 4 + 2 + 7 = 13 | 122 |
| admin | 3 | 24 |
| shared / mini / crawler | 0 | 89 |
| **总计** | **16** | **235** |

---

## 10. Acceptance Criteria（M6.5 完成定义）

| AC | 命令 | 预期 |
|---|---|---|
| AC-1 cleanup 4 测试 | `cd apps/api && pnpm vitest run test/lib/cleanup.test.ts` | 4/4 绿 |
| AC-2 scheduled 2 测试 | `cd apps/api && pnpm vitest run test/index.test.ts` | 2/2 绿 |
| AC-3 stats 7 测试 | `cd apps/api && pnpm vitest run test/routes/stats.test.ts` | 7/7 绿 |
| AC-4 StatsPage 3 测试 | `cd apps/admin && pnpm vitest run src/pages/StatsPage.test.tsx` | 3/3 绿 |
| AC-5 api 包全绿 | `cd apps/api && pnpm vitest run` | 13/13 绿（M6.5 累计） |
| AC-6 admin 包全绿 | `cd apps/admin && pnpm vitest run` | 24/24 绿 |
| AC-7 api typecheck | `cd apps/api && pnpm typecheck` | 0 error |
| AC-8 admin typecheck | `cd apps/admin && pnpm typecheck` | 0 error |
| AC-9 admin build | `cd apps/admin && pnpm build` | 成功，bundle 增量 < 5KB（无图表库） |
| AC-10 全量 5 包验证（merge 前） | `pnpm -r test && pnpm -r typecheck && pnpm -r build` | 全绿 |

**M6.5 完成 = AC-1 ~ AC-10 全绿 + state-m6-5.md 已写 + merge 到 master**

---

## 11. CP-5 真接路径

state-m6-5.md 会标注以下项**必须 CP-5 真接验证**：

| 项 | CP-5 验证方式 |
|---|---|
| 真 D1 SQL `cleanupLoginAttempts` 执行 | 临时改 cron 到 `*/1 * * * *` 触发，看 `wrangler tail` 日志确认 `deleted=N` |
| 真 CF Cron Triggers scheduled 触发 | 等下一次 03:00 UTC（或临时改 cron），看 worker 日志 |
| 真 D1 SQL stats 聚合性能 | admin 访问 /stats，CF Workers analytics 看 duration < 200ms |
| 真 admin 部署 + 数据流入 | 部署 admin → 访问 /stats → 数字卡 + bars 渲染 |

---

## 12. 风险与回滚

### 12.1 风险点

| 风险 | 缓解 |
|---|---|
| commit 2 改 `export default app` → `{ fetch, scheduled }` 可能破坏 Worker 部署 | typecheck AC-7 兜底；fail 则回滚 commit 2 |
| commit 3a 加 `/stats` 路由挂载影响其他 route | typecheck + cron/auth 等已有 route 测试保持绿 |
| admin CSS bars 渲染异常（移动端 / 横屏） | 不优化移动端（admin 是桌面工具）；真接视觉验证 |
| scheduled handler 本地 miniflare 跑不起来 | dev 不验证 scheduled，靠 AC-2 单元测试 + CP-5 真接 |

### 12.2 回滚策略（每 commit 独立可回滚）

```bash
# 任何 commit 失败，回滚到上一 commit
git reset --hard HEAD~1

# merge 失败，回到 master
git checkout master && git branch -D worktree-m6-5-scheduled-stats
```

每个 commit 内部 TDD 已保证"测试先红→绿"，所以回滚到上一 commit 必然是稳定状态。

---

## 13. 实施计划

### 13.1 Commit 拆分（4 commit + 1 merge）

| # | 内容 | 估时 | 验证 |
|---|---|---|---|
| 1 | `cleanup.ts` 抽取 + 4 测试 + `cron.ts` 改调 cleanup | 0.10d | cleanup(4) + cron(4) 绿 |
| 2 | worker.scheduled wrap + 2 测试 + wrangler triggers | 0.15d | index(2) + cleanup(4) + cron(4) = 10 绿；**🛑 CP-1** |
| 3a | `stats.ts` + 7 测试 + index 挂载 | 0.25d | stats(7) 绿 + cron 不破 |
| 3b | admin `StatsPage` + 3 测试 + 路由集成 + api helper | 0.50d | StatsPage(3) 绿 + admin typecheck/build；**🛑 CP-2** |
| 4 | `state-m6-5.md` + `README.md` | 0.10d | — |
| merge | worktree → master | 0.05d | AC-10 全量验证 |

**总 ~1.15d**（比 M6.4 估的 1d 多 2h，主要在 admin StatsPage CSS bars）。

### 13.2 工作流

按 M6.4 模式：
- spec 文档 commit → plan 文档 commit → 实施 commits → state doc commit → merge
- 使用 worktree `.claude/worktrees/m6-5-scheduled-stats` 隔离开发
- 主线程直接执行（M6.3c/d/4 教训：subagent 监控成本高，长任务适合主线程）

---

## 14. 累计测试 + 文件清单

### 14.1 仓库测试累计（M6.5 后）

| 包 | 累计 |
|---|---|
| shared | 38 |
| api | 122 (+13) |
| miniprogram | 32 |
| admin | 24 (+3) |
| crawler | 19 |
| **总计** | **235** |

### 14.2 文件清单

**新建 (7 代码)**:
- `apps/api/src/lib/cleanup.ts` (~30 行)
- `apps/api/src/routes/stats.ts` (~120 行)
- `apps/api/test/lib/cleanup.test.ts` (~120 行)
- `apps/api/test/routes/stats.test.ts` (~180 行)
- `apps/api/test/index.test.ts` (~60 行)
- `apps/admin/src/pages/StatsPage.tsx` (~180 行)
- `apps/admin/src/pages/StatsPage.test.tsx` (~100 行)

**修改 (7)**:
- `apps/api/src/routes/cron.ts` (~-5 行 inline SQL)
- `apps/api/src/index.ts` (~+12 行 wrap export + stats 挂载)
- `apps/api/wrangler.jsonc` (+3 行 triggers)
- `apps/api/test/routes/cron.test.ts` (微调)
- `apps/admin/src/lib/api.ts` (+15 行 helper + types)
- `apps/admin/src/App.tsx` (+3 行 import + route + nav)
- `README.md` (+M6.5 状态节)

**文档 (3)**:
- `docs/superpowers/specs/2026-06-16-m6-5-scheduled-stats-design.md` (本文档)
- `docs/superpowers/plans/2026-06-16-m6-5-scheduled-stats.md`
- `docs/superpowers/state-m6-5.md`

**总计**：10 新建（7 代码 + 3 文档） + 7 修改 = 17 改动文件。

---

**Spec 完成。请审阅。**
