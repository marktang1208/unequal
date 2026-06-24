# Plan: M6.5 — Scheduled Handler Wrap + Admin Stats Dashboard

- **Spec**：`docs/superpowers/specs/2026-06-16-m6-5-scheduled-stats-design.md`（commit `65ccf63`）
- **日期**：2026-06-16
- **复杂度**：Small-Medium（4 task × 2 包 + 16 新增用例 + 主线程直接做）
- **Mock-first 边界**：D1 全 mock-first / admin fetch mock — 4 项 CP-5 真接项已标注

---

## 1. Requirements Restatement

把 M6.4 留下的 2 个 mock-first 已知 limitation 收口：(1) scheduled handler 真接 Cloudflare Cron Triggers；(2) login_attempt 表 admin 可视化 dashboard。

**核心交付**：

| # | 包 | 文件 | 内容 |
|---|---|---|---|
| 1 | apps/api | `src/lib/cleanup.ts` | 新 `cleanupLoginAttempts(env, cutoffMs)` + `DEFAULT_CUTOFF_MS = 86_400_000` |
| 2 | apps/api | `test/lib/cleanup.test.ts` | 新 4 用例（happy / empty / cutoff 边界 / D1 throws）|
| 3 | apps/api | `src/routes/cron.ts` | 改：inline DELETE SQL 删除，改调 `cleanupLoginAttempts(env, DEFAULT_CUTOFF_MS)` |
| 4 | apps/api | `src/index.ts` | 改：`export default app` → `{ fetch, scheduled }`；加 `app.get("/stats/login-attempts", ...)` |
| 5 | apps/api | `wrangler.jsonc` | 改：+3 行 `triggers.crons = ["0 3 * * *"]` |
| 6 | apps/api | `test/routes/cron.test.ts` | 改：4 测试保留（happy path 行为不变，仍走 fakeDB 端到端）|
| 7 | apps/api | `test/index.test.ts` | 新 2 用例（scheduled happy / scheduled 错误）|
| 8 | apps/api | `src/routes/stats.ts` | 新 `statsRoute.GET_LOGIN_ATTEMPTS` handler + `clampHours` + `buildStats` + types |
| 9 | apps/api | `test/routes/stats.test.ts` | 新 7 用例（happy empty / happy mixed / 跨小时 / 401 / hours clamp / hours=1 / hours 缺省）|
| 10 | apps/admin | `src/lib/api.ts` | 改：+15 行 `getLoginAttemptStats(hours)` helper + `LoginAttemptStats` interface |
| 11 | apps/admin | `src/pages/StatsPage.tsx` | 新 ~180 行：4 数字卡 + by_type TypeRow + HourBars CSS bars |
| 12 | apps/admin | `src/pages/StatsPage.test.tsx` | 新 3 用例（渲染+数据 / 切换 hours / 错误态）|
| 13 | apps/admin | `src/App.tsx` | 改：+3 行（import + `<Route path="/stats">` + `<Link to="/stats">`）|

**不交付**（推到 M6.5+ / YAGNI）：
- `top_failed_identifiers`（YAGNI：by_hour + by_type 已能看出 attack pattern）
- day 级聚合（>168h 才需要；admin 看 7d 已够）
- recharts / chart.js（CSS bars 0KB vs recharts +95KB；admin 是运维视图）
- scheduled handler 鉴权（CF Cron Triggers 是控制面触发，不暴露公网）

**新增用例**：16（api 4 + api 2 + api 7 + admin 3 = 16）。**累计 235**（219 + 16）。

---

## 2. Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| 内部 lib 函数 | `apps/api/src/lib/rate-limit.ts:21-32` `DEFAULT_RATE_LIMIT_CONFIG` + `readRateLimitConfig` 模式 | `cleanupLoginAttempts(env, cutoffMs)` 抽 lib 函数 + `DEFAULT_CUTOFF_MS` 常量 + 测试覆盖 D1 fakeDB |
| Hono route handler | `apps/api/src/routes/cron.ts:22-50` `cronRoute.CLEANUP_LOGIN_ATTEMPTS` | `cronRoute.CLEANUP_LOGIN_ATTEMPTS` 改调 cleanup 函数（不再 inline SQL）|
| Cloudflare Workers scheduled handler | CF 官方文档：`{ fetch, scheduled }` default export | wrap `app` 为 `{ fetch: app.fetch.bind(app), scheduled: ... }` |
| wrangler triggers | `apps/api/wrangler.jsonc` `vars` 块 | 加 `triggers.crons = ["0 3 * * *"]` 块（同级 vars/compatibility_flags）|
| D1 SQL aggregation | `apps/api/src/routes/ask.ts` 双查询模式 | `Promise.all([byType, byHour])` 并发；hour_ts 用 UTC 整点对齐 `(created_at/3600000)*3600000` |
| SQL 后处理 | （新模式，仿 lib/cleanup 思路）| `buildStats()` 补 0 缺失桶（确保 `by_hour.length === window_hours`）|
| admin JWT 鉴权 | `apps/api/src/routes/auth.ts` `verifyAdminToken` | `statsRoute.GET_LOGIN_ATTEMPTS` 复用同一 helper |
| admin `authedJson` helper | `apps/admin/src/lib/api.ts:189-204` | `getLoginAttemptStats(hours)` 用同一 helper |
| admin page useEffect + fetch | `apps/admin/src/pages/ChatSim.tsx:41-43` | `useEffect([hours])` + cancelled flag 防 race |
| mock-first 边界标注 | `docs/superpowers/state-m6-4.md` "mock-first 边界" 章节 | state-m6-5.md 复用同结构（CP-5 真接 4 项明确列出）|

---

## 3. Files to Change

| File | Action | Why |
|---|---|---|
| `apps/api/src/lib/cleanup.ts` | CREATE | `cleanupLoginAttempts(env, cutoffMs)` + `DEFAULT_CUTOFF_MS`（spec §5.1）|
| `apps/api/test/lib/cleanup.test.ts` | CREATE | 4 测试（spec §5.6 + §9.3 列表）|
| `apps/api/src/routes/cron.ts` | UPDATE | inline DELETE SQL 删除，改调 cleanup 函数（spec §5.2）|
| `apps/api/src/index.ts` | UPDATE | `export default app` → `{ fetch, scheduled }`；加 `app.get("/stats/login-attempts", ...)`（spec §5.3 + §6.2）|
| `apps/api/wrangler.jsonc` | UPDATE | +3 行 `triggers.crons`（spec §5.4）|
| `apps/api/test/routes/cron.test.ts` | UPDATE | 4 测试保留（happy path 行为不变，仍走 fakeDB 端到端）|
| `apps/api/test/index.test.ts` | CREATE | 2 测试（scheduled happy / scheduled 错误，spec §5.6）|
| `apps/api/src/routes/stats.ts` | CREATE | `statsRoute.GET_LOGIN_ATTEMPTS` + `clampHours` + `buildStats` + types（spec §6.1）|
| `apps/api/test/routes/stats.test.ts` | CREATE | 7 测试（spec §9.3 列表）|
| `apps/admin/src/lib/api.ts` | UPDATE | +15 行 `getLoginAttemptStats(hours)` helper + `LoginAttemptStats` interface（spec §6.3）|
| `apps/admin/src/pages/StatsPage.tsx` | CREATE | 4 数字卡 + by_type TypeRow + HourBars CSS bars（spec §6.4）|
| `apps/admin/src/pages/StatsPage.test.tsx` | CREATE | 3 测试（spec §9.3 列表）|
| `apps/admin/src/App.tsx` | UPDATE | +3 行（import + `<Route path="/stats">` + nav `<Link to="/stats">`，spec §6.5）|
| `README.md` | UPDATE | +M6.5 状态节（main thread 写）|
| `docs/superpowers/specs/2026-06-16-m6-5-scheduled-stats-design.md` | （已建）| spec 已 commit `65ccf63` |
| `docs/superpowers/plans/2026-06-16-m6-5-scheduled-stats.md` | （本文件）| plan artifact |
| `docs/superpowers/state-m6-5.md` | CREATE | 收尾归档（main thread 写）|

**总计**：7 新建（4 代码 + 1 plan + 1 spec + 1 state）+ 7 修改 = 14 改动 + 3 docs = 17 文件。

---

## 4. Tasks (4 task / 2 checkpoint)

### Phase 1 — 主线程直接实施（3 task / CP-1）

按 M6.3c/d 教训，本 spec **不派 subagent**，主线程直接做（4 task + 2 包 改动，估 1.15 天）。

**Task 1: api cleanup 函数抽取 + 4 tests**

- Action 1.1: 新 `apps/api/src/lib/cleanup.ts`（spec §5.1 完整代码）：
  ```typescript
  import type { Env } from "../types.js";

  export interface CleanupResult {
    deleted: number;
  }

  export const DEFAULT_CUTOFF_MS = 24 * 60 * 60 * 1000;

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

- Action 1.2: 新 `apps/api/test/lib/cleanup.test.ts` 4 用例（`describe("cleanupLoginAttempts")`）：
  1. **happy path: 3-old-2-new → { deleted: 3 }**（fakeDB stub meta.changes=3；验 SQL bind 参数 + 返回值）
  2. **空表 → { deleted: 0 }**（fakeDB stub meta.changes=0）
  3. **cutoffMs 边界**: `cutoffMs=0` → cutoff=now → 全部 deleted；`cutoffMs=Infinity` → cutoff=-Infinity → 0 deleted；`cutoffMs=-1` → cutoff=now+1 → 0 deleted
  4. **D1 throws → cleanup throws**（fakeDB prepare throws，向上抛）

- Action 1.3: 改 `apps/api/src/routes/cron.ts`（spec §5.2 完整代码）：
  - import 加 `import { cleanupLoginAttempts, DEFAULT_CUTOFF_MS } from "../lib/cleanup.js";`
  - 删除 inline `const CLEANUP_THRESHOLD_MS = 24 * 60 * 60 * 1000;`（保留 `DEFAULT_CUTOFF_MS` 引用）
  - 删 inline `env.DB.prepare(...).bind(cutoff).run()` → 改为 `const result = await cleanupLoginAttempts(env, DEFAULT_CUTOFF_MS);`
  - try/catch 兜底逻辑不变
  - 响应 schema 保持 `{ deleted, cutoff }`（与 M6.4 行为一致，向后兼容）

- Action 1.4: 改 `apps/api/test/routes/cron.test.ts`：
  - 4 测试保留（happy / happy empty / 401 missing / 401 wrong）
  - happy 测试断言不变（仍走 fakeDB 端到端，验证 `deleted: N, cutoff: <unix_ms>`）
  - 无需改 fakeDB（cleanup 函数走同一 fakeDB）

- Mirror: 现有 `apps/api/src/routes/cron.ts` + `apps/api/test/lib/rate-limit.test.ts:15-41` fakeDB 模式
- Validate:
  ```bash
  pnpm -F api test test/lib/cleanup.test.ts    # 4 新
  pnpm -F api test test/routes/cron.test.ts    # 4 旧（保持绿）
  ```
  期望：4 + 4 = 8 绿（api 累计 109 + 4 = 113）

**Task 2: api worker.scheduled wrap + wrangler triggers + 2 tests**

- Action 2.1: 改 `apps/api/src/index.ts` 末尾（spec §5.3 完整代码）：
  - import 加 `import { cleanupLoginAttempts, DEFAULT_CUTOFF_MS } from "./lib/cleanup.js";`
  - import 加 `import { statsRoute } from "./routes/stats.js";`（同时挂 stats 路由，避免下一 task 再改 index.ts）
  - `export default app;` → 替换为：
    ```typescript
    export default {
      fetch: app.fetch.bind(app),
      async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
        try {
          const result = await cleanupLoginAttempts(env, DEFAULT_CUTOFF_MS);
          console.log(`[cron] cleanup-login-attempts: deleted=${result.deleted}`);
        } catch (err) {
          console.error("[cron] cleanup-login-attempts failed:", err);
        }
      },
    };
    ```
  - 加 `app.get("/stats/login-attempts", (c) => statsRoute.GET_LOGIN_ATTEMPTS(c.req.raw, c.env));`（route 挂载）

- Action 2.2: 改 `apps/api/wrangler.jsonc`（spec §5.4）：
  - 在 `vars` 块同级加 `triggers: { crons: ["0 3 * * *"] }` 块（+3 行）
  - 注意：triggers 是 wrangler 顶层字段，不是 vars 子项

- Action 2.3: 新 `apps/api/test/index.test.ts` 2 用例（`describe("scheduled handler")`）：
  1. **scheduled happy: 调 cleanup + console.log "deleted=N"**——直接 import default 然后调 `default.scheduled(fakeEvent, fakeEnv, fakeCtx)`；spy `cleanupLoginAttempts` 返 `{ deleted: 5 }`；spy `console.log` 验证被调 + 含 "deleted=5"
  2. **scheduled 错误: cleanup throws → console.error, 不 re-throw**——mock `cleanupLoginAttempts` throws Error("D1 down")；调 scheduled；验证 console.error 被调 + 函数 return undefined（不抛）

- Mirror: Hono `app.fetch.bind(app)` 模式；CF Workers `scheduled(event, env, ctx)` 签名
- Validate:
  ```bash
  pnpm -F api test test/index.test.ts    # 2 新
  pnpm -F api test    # 全跑（确保 wrap export default 不破 Hono）
  pnpm -F api typecheck
  ```
  期望：4 cleanup + 4 cron + 2 index = **10 绿 + typecheck 0 错**
  🛑 **CP-1**: api 累计 113 + 2 = **115 绿**（api 包）

**Task 3a: api stats 端点 + 7 tests**

- Action 3a.1: 新 `apps/api/src/routes/stats.ts`（spec §6.1 完整代码）：
  - `export interface LoginAttemptStats`（5 字段：window_hours, cutoff, total_failed, total_succeeded, by_type, by_hour）
  - `BY_TYPE_SQL` 常量（spec §6.1 SQL 块）
  - `BY_HOUR_SQL` 常量
  - `clampHours(raw)` 纯函数：NaN → 24；clamp 到 [1, 168]；floor
  - `buildStats(hours, cutoff, byTypeRows, byHourRows)` 纯函数：
    - 用 `currentHourTs = Math.floor(now / 3_600_000) * 3_600_000` 算 UTC 整点
    - 从 `currentHourTs - (hours-1)*3_600_000` 到 `currentHourTs` 循环 hours 次
    - 每桶查 buckets Map，缺则补 `{failed: 0, succeeded: 0}`
    - 聚合 total_failed/total_succeeded + by_type
  - `statsRoute.GET_LOGIN_ATTEMPTS(req, env)`:
    - `verifyAdminToken(req, env)` → 401 if invalid
    - parse hours query → clampHours
    - Promise.all 两次查询
    - 返 `Response.json(buildStats(...))`
    - try/catch 500 + console.error

- Action 3a.2: 新 `apps/api/test/routes/stats.test.ts` 7 用例：
  1. **happy empty**: 空表 → `{ total_failed: 0, total_succeeded: 0, by_type: { admin: {0,0}, wx_code: {0,0} }, by_hour: 24 桶全 0 }`
  2. **happy mixed**: 24h 内混合 admin/wx_code × failed/succeeded → 正确聚合
  3. **跨小时聚合**: created_at 散落在 3 个不同 hour → by_hour 正确按 hour 分桶（关键测试：验 SQL hour_ts 算式）
  4. **401 missing token**: 无 Authorization → 401
  5. **hours clamp**: `hours=999` → clamp 到 168；`hours=0` → clamp 到 1；`hours=-5` → clamp 到 1；`hours=abc` → fallback 24
  6. **hours=1 边界**: by_hour 长度 === 1（验补 0 逻辑）
  7. **hours 缺省**: 不传 query → 默认 24（验 default 参数）

- Mirror: 现有 `apps/api/src/routes/ask.ts` 双查询模式 + `cron.ts` 401 鉴权模式 + `apps/api/test/lib/rate-limit.test.ts` fakeDB 模式
- Validate:
  ```bash
  pnpm -F api test test/routes/stats.test.ts    # 7 新
  pnpm -F api typecheck
  ```
  期望：7 绿 + typecheck 0 错（api 累计 115 + 7 = **122 绿**）

**Task 3b: admin StatsPage + 3 tests + 路由集成（独立 commit，可与 3a 合并或拆开）**

- Action 3b.1: 改 `apps/admin/src/lib/api.ts`（spec §6.3）：
  - export `interface LoginAttemptStats`（与 api 包 schema 完全一致）
  - export `async function getLoginAttemptStats(hours)`：用 `authedJson<LoginAttemptStats>(`/stats/login-attempts?hours=${hours}`, { method: "GET" })`

- Action 3b.2: 新 `apps/admin/src/pages/StatsPage.tsx`（spec §6.4 完整代码）：
  - imports: `useState, useEffect` + `getLoginAttemptStats, LoginAttemptStats`
  - `HOURS_OPTIONS = [{24, "最近 24h"}, {72, "最近 72h"}, {168, "最近 7d"}]`
  - `StatsPage()` 主组件：hours state + data/loading/error state + useEffect 调 getLoginAttemptStats（cancelled flag 防 race）
  - `StatCard({label, value, color?})` 子组件：白底卡片 + 颜色数字
  - `TypeRow({label, data})` 子组件：横向 bar（failed 红 + succeeded 绿，按百分比 width）
  - `HourBars({hours})` 子组件：flex 横排竖条（每条按 max 比例），`title` 属性显示 tooltip（Asia/Shanghai 时区）
  - 主组件 render: header (select 切换 hours) + 4 StatCard + by_type 表格 + by_hour 区（有数据渲染 bars，无数据显示"暂无登录尝试"）

- Action 3b.3: 改 `apps/admin/src/App.tsx`（spec §6.5）：
  - import 加 `import StatsPage from "./pages/StatsPage.js";`
  - nav `<Link to="/stats">统计</Link>`（加在 nav 列表最后）
  - routes 加 `<Route path="/stats" element={<RequireAuth><StatsPage /></RequireAuth>} />`（在 protected routes 列表中）

- Action 3b.4: 新 `apps/admin/src/pages/StatsPage.test.tsx` 3 用例（`describe("StatsPage")`）：
  1. **初始渲染 + 加载 + 数据填充**:
     - mock `getLoginAttemptStats` 返 stub `{ total_failed: 3, total_succeeded: 5, by_type: {...}, by_hour: [{hour_ts, failed:1, succeeded:2}, ...] }`
     - render `<StatsPage />`
     - 等待 loading → 渲染数字卡 "3" "5" + by_type 数据 + bars
  2. **切换 hours 触发重新 fetch**:
     - mock `getLoginAttemptStats` spy
     - render → 初始调 hours=24
     - 改 `<select>` 值到 72
     - 验证 spy 被第二次调，参数 hours=72
  3. **错误态**:
     - mock `getLoginAttemptStats` reject Error("401")
     - render → loading → error 红字 "401"

- Mirror: `apps/admin/src/pages/ChatSim.tsx` useEffect + cancelled flag 模式 + `apps/admin/src/pages/LoginPage.test.tsx` 测试模式（mock fetch + render）
- Validate:
  ```bash
  pnpm -F admin test src/pages/StatsPage.test.tsx    # 3 新
  pnpm -F admin typecheck
  pnpm -F admin build                              # bundle 增量 < 5KB
  ```
  期望：3 绿 + typecheck 0 错 + build 成功（admin 累计 21 + 3 = **24 绿**）

🛑 **CP-2**: Task 3a + 3b 完成后
```bash
cd .claude/worktrees/m6-5-scheduled-stats
pnpm -r typecheck    # 5 包全绿
pnpm -r test         # 5 包全绿（api 122 + admin 24 + mini 32 + shared 38 + crawler 19 = 235）
```
期望 **235 全绿**

---

### Phase 2 — 主线程收尾（Task 4 / CP-3）

**Task 4: state-m6-5.md + README + merge to master + worktree 清理 + 独立 CP-3 验证**

- Action 4.1: 仿 `state-m6-4.md` 模板写 `docs/superpowers/state-m6-5.md` 11 sections：
  1. mock-first 边界（与 M6.4 对比）
  2. CP pass 记录（CP-1 api 10 绿 / CP-2 全量 235 绿 / CP-3 独立验证）
  3. 累计用例表（M6.4 → M6.5：219 → 235）
  4. 偏差记录（与 spec 任何偏差，含 commit 顺序调整 / 行数偏差 / 命名变更等）
  5. commit 汇总（4 commit + 1 merge）
  6. 实施 concern（debug 过程 / 性能 / 边界踩坑）
  7. dev 验证缺口（4 项 CP-5 真接）
  8. CP-5 真接路径（4 项验证清单）
  9. 下一步建议（M6.6+ candidate 列表）
  10. 主线程接管说明（subagent 不派原因）
  11. 文件总览（新建/修改各 N 个）

- Action 4.2: 改 `README.md` 加 M6.5 节：
  - 行为示例：`curl -H "Authorization: Bearer <jwt>" /api/stats/login-attempts?hours=24`
  - 响应 schema 示例（截断版）
  - 测试矩阵（api 13 + admin 3 = 16 新 / 235 累计）
  - mock-first 限制（4 项 CP-5 真接标注）
  - scheduled handler 启用说明（triggers.crons 部署后每日 03:00 UTC 触发）

- Action 4.3: merge `worktree-m6-5-scheduled-stats` → master with `--no-ff`
- Action 4.4: `worktree remove --force` + `branch -d`
- Action 4.5: 主仓库跑 `pnpm -r test` + `pnpm -r typecheck` 独立 CP-3 验证
- Validate: master HEAD 含 merge commit + worktree 清理 + 235 用例全绿 + 5 包 typecheck 全绿

---

## 5. Validation

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m6-5-scheduled-stats

# CP-1（Task 2 完成后，api 包内）
pnpm -F api test              # 期望 4 cleanup + 4 cron + 2 index = 10 绿
pnpm -F api typecheck         # 期望 0 错

# CP-2（Task 3a + 3b 完成后）
pnpm -r typecheck             # 5 包全绿
pnpm -r test                  # 5 包全绿（api 122 + admin 24 + mini 32 + shared 38 + crawler 19 = 235）

# CP-3（合并后，主仓库跑）
cd /Users/Mark/cc_project/unequal
pnpm -r typecheck
pnpm -r test
# 期望 235 全绿

# 增量测试（task 局部验证，不全跑）
pnpm -F api test test/lib/cleanup.test.ts          # task 1: 4 新
pnpm -F api test test/routes/cron.test.ts          # task 1: 4 旧（保持）
pnpm -F api test test/index.test.ts                # task 2: 2 新
pnpm -F api test test/routes/stats.test.ts          # task 3a: 7 新
pnpm -F admin test src/pages/StatsPage.test.tsx    # task 3b: 3 新
```

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Task 2 wrap `export default app` → `{ fetch, scheduled }` 破坏 Hono Worker 部署 | 中 | typecheck AC 兜底；CF Worker runtime 接受 `{ fetch, scheduled }` 是标准模式 |
| Task 3a SQL aggregation 性能 | 低 | 24h 数据量级 10²-10³ rows + idx_login_attempt_created_at（M6.4 加）索引覆盖；CP-5 真接验 |
| Task 3b admin StatsPage CSS bars 渲染异常（移动端/横屏）| 低 | 不优化移动端（admin 是桌面工具）；真接视觉验证 |
| Task 3b useEffect + cancelled flag race condition | 低 | 复用 ChatSim.tsx 已有模式（成熟）；3 测试覆盖 initial + change + error |
| Task 2 miniflare 不模拟 Cron Triggers | 中 | index.test.ts 直接调 `default.scheduled()` 函数（绕开 CF runtime），mock cleanup + console.log；CP-5 真接验触发时机 |
| 跨 2 包改动（api + admin）主线程上下文负担 | 中 | M6.3c/d 教训应用：主线程直接做避免 subagent stall；4 task 边界 + 每 task 立即 commit |
| 4 commit 顺序依赖（task 1 → 2 → 3a → 3b）| 极低 | 严格按依赖顺序：cleanup 函数先抽 → scheduled 用 cleanup → stats 端点 → stats UI |
| Task 3b admin bundle 增量超预期 | 低 | CSS bars 用 Tailwind 现成 utility，无新依赖；build 检查增量 < 5KB |
| 时区显示错误（UTC vs Asia/Shanghai）| 极低 | `toLocaleString` + `timeZone: "Asia/Shanghai"` 显式指定；test 通过 + 真接视觉确认 |
| top_failed_identifiers 后续需求 | 低 | YAGNI；当前 by_hour + by_type 已能看出 attack pattern；M6.6+ 加 |

**最高风险**：Task 2 wrap export default 改动 + Task 3a/3b 跨包。Mitigation：M6.3c/d 教训应用（避免 subagent stall）+ 每 task 完成后立即 commit + 跑该 task 局部测试。

---

## 7. Acceptance

- [ ] 16 新增用例全绿（api 4 + api 2 + api 7 + admin 3 = 16）
- [ ] 累计 235 用例全绿（api 122 + admin 24 + mini 32 + shared 38 + crawler 19）
- [ ] 5 包 typecheck 全绿
- [ ] 主线程独立 CP-3 验证（trust but verify）
- [ ] state-m6-5.md 11 sections 完整
- [ ] README M6.5 节就位
- [ ] merge to master + worktree 清理 + branch 删除
- [ ] 0 production console.log（api / admin）—— scheduled handler 用 console.log/error 是 CF Worker 日志约定，**不计入**
- [ ] wrangler.jsonc 加 `triggers.crons = ["0 3 * * *"]`
- [ ] admin bundle 增量 < 5KB（无图表库）

**dev 验证缺口**（推到 CP-5 真接 Cloudflare）：
- 真实 Cloudflare Cron Trigger 触发（每日 UTC 03:00）— 改 cron 到 `*/1 * * * *` 临时验证后改回
- 真 D1 SQL `cleanupLoginAttempts` DELETE 执行 + 性能 — 24h 数据量 < 100ms
- 真 D1 SQL `statsRoute` aggregation 性能（Promise.all 双查询）— < 200ms
- 真 admin 部署 + /stats 页面渲染（CSS bars 视觉）— Chrome/Safari 真浏览器验证
- 真 Asia/Shanghai 时区显示（jsdom 默认 host TZ，CP-5 时浏览器验证）

---

## 8. Implementation Notes

### 8.1 Subagent 分配

**M6.3c/d/4 教训应用**：
- 1 subagent 范围 < 3 task → 主线程直接做更稳
- 1 subagent 范围 ≥ 3 task → 可派 subagent 但需小心
- 跨 2 包改动 → 优先主线程

M6.5 4 task（实施）+ 1 task（收尾）跨 2 包（api + admin），**决策主线程直接做**：
- 1.15 天工作量，主线程上下文能 handle
- 跨包改动主线程能保持一致性（不用 subagent 心智 context）
- 避免 subagent stall 风险（M6.3c 教训）

### 8.2 Commit 节奏（4 commit + 1 merge = 5 总）

```
1. feat(api): M6.5 task 1 — cleanupLoginAttempts 抽取 + 4 tests (cron.ts 改调 cleanup)
2. feat(api): M6.5 task 2 — worker.scheduled wrap + wrangler triggers + 2 tests
              [🛑 CP-1: api 10 绿 + typecheck 0 错]
3. feat(api): M6.5 task 3a — GET /stats/login-attempts 端点 + 7 tests
4. feat(admin): M6.5 task 3b — admin StatsPage 页面 + 3 tests + 路由集成
              [🛑 CP-2: 5 包 typecheck 全绿 + 235 测试全绿]
5. docs: M6.5 state-m6-5.md + README M6.5 节
merge: worktree-m6-5-scheduled-stats → master --no-ff
       [🛑 CP-3: 主仓库独立验证]
```

注：Task 3a + 3b 可以合并为 1 commit（api + admin 同步发），也可拆 2 commit（api 先 / admin 后）。**决策拆 2 commit**：
- commit 3a 完成后 api 包独立可测（api 122 绿）
- commit 3b 完成后 admin 包独立可测（admin 24 绿）
- rollback 粒度细
- 与 M6.4 commit 风格一致

### 8.3 验证顺序

1. **CP-1**（Task 2 完成后）：`pnpm -F api test` + `pnpm -F api typecheck` → 期望 10 绿 + 0 错
2. **CP-2**（Task 3a + 3b 完成后）：`pnpm -r test` + `pnpm -r typecheck` → 期望 235 全绿
3. **CP-3**（合并后，主线程独立）：`pnpm -r test` + `pnpm -r typecheck` → 期望 235 全绿
4. **CP-5**（推到真接 Cloudflare 时）：
   - 改 cron 到 `*/1 * * * *` → 触发一次 → 改回 `0 3 * * *`
   - 部署 admin → 访问 `/stats` → 验视觉 + 数据流入
   - `wrangler tail` 看 scheduled handler 日志

### 8.4 ECC 引用

- `tdd-workflow` (ECC) — 16 用例 RED → GREEN → REFACTOR（4 + 2 + 7 + 3）
- `subagent-driven-development` (ECC) — **本 plan 决策主线程直接做**（M6.3c/d 教训）
- `code-review` / `typescript-review` — cleanup.ts 新文件 + cron.ts 改 ~5 行 + index.ts 改 ~15 行 + stats.ts 新文件 + StatsPage.tsx 新文件 + App.tsx 改 ~3 行 + wrangler.jsonc 改 3 行
- `verification-before-completion` (Superpowers) — CP-1/2/3 验证
- `superpowers:brainstorming` — 已完成（§1-§7 + spec commit `65ccf63`）

### 8.5 Worktree 路径

按 M6.3c/d/4 模式：`.claude/worktrees/m6-5-scheduled-stats`，分支 `worktree-m6-5-scheduled-stats`。

### 8.6 mock-first 边界明确

| 组件 | Mock 方式 | CP-5 真接项 |
|---|---|---|
| `cleanupLoginAttempts` | fakeDB spy prepare/bind/run | 真 D1 DELETE 性能（< 100ms）|
| `cronRoute` HTTP | fakeDB + Authorization header mock | 真 Hono routing + 真 CRON_SECRET |
| `scheduled` handler | 直接调 `default.scheduled()` + spy cleanupLoginAttempts | 真 CF Cron Trigger 触发时机 |
| `statsRoute` SQL aggregation | fakeDB stub rows（两次查询）| 真 D1 SQL 执行计划 + Promise.all 真并发（< 200ms）|
| `verifyAdminToken` | mock jwt verify（已有） | 真 jwt 签名验证 |
| admin `getLoginAttemptStats` | `vi.spyOn(global, "fetch")` | 真网络请求 + CORS |
| admin `StatsPage` | mock fetch + render | 真 DOM 滚动 + hover + 时区显示 |

---

**Plan 完成。请审阅 → 批准 → 实施。**
