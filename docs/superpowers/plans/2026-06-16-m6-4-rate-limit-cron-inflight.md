# Plan: M6.4 — Rate-Limit Vars + Cron Cleanup + Inflight Promise

- **Spec**：`docs/superpowers/specs/2026-06-16-m6-4-rate-limit-cron-inflight-design.md`（commit `6887eb9`）
- **日期**：2026-06-16
- **复杂度**：Small-Medium（4 task × 2 包 + 8 新增用例 + 主线程直接做）
- **Mock-first 边界**：D1 全 mock-first（miniflare）/ miniprogram fetchImpl + wx login mock — 无新边界

---

## 1. Requirements Restatement

把 M6.3a/M6.3c 阶段已发现的 3 个 mock-first 已知 limitation 收口：(1) `fetchWithRefresh` 401 inflight 共享；(2) rate-limit 阈值 vars 配置化；(3) `login_attempt` 表 cron 清理 + 索引。

**核心交付**：

| # | 包 | 文件 | 内容 |
|---|---|---|---|
| 1 | apps/miniprogram | `lib/api.ts` | 模块级 `inflightEnsureJwt` Map + `__clearInflightEnsureJwt` + 改 `fetchWithRefresh` 12 行 |
| 2 | apps/miniprogram | `test/api.test.ts` | +3 用例（inflight 共享）|
| 3 | apps/api | `src/lib/rate-limit.ts` | 新 `RateLimitConfig` + `DEFAULT_RATE_LIMIT_CONFIG` + `readRateLimitConfig(env)` + 改 `checkRateLimit` 签名（加 config 参数）|
| 4 | apps/api | `src/routes/auth.ts` | 2 处 `checkRateLimit` 调用加 `readRateLimitConfig(env)` 参数 |
| 5 | apps/api | `src/types.ts` | Env 加 3 可选字段（LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS / CRON_SECRET）|
| 6 | apps/api | `wrangler.jsonc` | vars 块加 3 个 var + 注释 |
| 7 | apps/api | `migrations/0007_login_attempt_created_at_index.sql` | 新（CREATE INDEX 单列 created_at）|
| 8 | apps/api | `migrations/0007_login_attempt_created_at_index.down.sql` | 新（DROP INDEX）|
| 9 | apps/api | `src/routes/cron.ts` | 新 `cronRoute.CLEANUP_LOGIN_ATTEMPTS` handler |
| 10 | apps/api | `src/index.ts` | 挂 `app.post("/cron/cleanup-login-attempts", ...)` |
| 11 | apps/api | `test/lib/rate-limit.test.ts` | +2 用例（config 注入）|
| 12 | apps/api | `test/routes/cron.test.ts` | 新 3 用例（happy / 401 缺 token / 401 错 token）|

**不交付**（推到 M6.5+）：rate-limit IP 维度 / D1 token-level mutex / session_key envelope encryption / Cloudflare scheduled handler wrap。

**新增用例**：8（mini 3 + api 2 + api 3 = 8）。**累计 213**（205 + 8）。

---

## 2. Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| miniprogram fetch wrapper | `apps/miniprogram/lib/api.ts:83-104` `fetchWithRefresh` | 加模块级 `Map<string, Promise<string>>` 共享 inflight（`.finally(() => delete)` 清缓存）|
| miniprogram test stub reset | `apps/miniprogram/lib/chat-storage.ts` `__setJwtStorageImpl` 模式 | 新 `__clearInflightEnsureJwt` 内部 helper（`@internal` 导出）给单测 reset |
| server rate-limit 函数 | `apps/api/src/lib/rate-limit.ts:44-75` `checkRateLimit` | 加可选 config 参数（向后兼容：default = `DEFAULT_RATE_LIMIT_CONFIG`）|
| Env 默认值兜底 | （新模式，仿 env.JWT_SECRET ?? "" 模式）| `parse(raw, fallback)` — 非法/缺省 fallback，不 throw |
| server route 注册 | `apps/api/src/index.ts:48-53` Hono `app.method(...)` | `app.post("/cron/cleanup-login-attempts", (c) => cronRoute.X(c.req.raw, c.env))` |
| D1 migration 命名 | `apps/api/migrations/0005_login_attempt.sql` | `0007_login_attempt_created_at_index.sql` + 同名 `.down.sql` |
| 路由 try/catch 兜底 | `apps/api/src/routes/auth.ts:53-62` `handleHttpError` | 401 显式 `Response.json({ error, message }, { status })`（不走 throw）|
| D1 mock test | `apps/api/test/lib/user.test.ts:15-41` `makeFakeDB({first, all, run})` | 复用现有 fake DB 模式 |
| miniflare bundle test | `apps/api/test/routes/auth.test.ts` | `applyMigrations` 加载 0001-0006 + 0007（task 3 加）|

---

## 3. Files to Change

| File | Action | Why |
|---|---|---|
| `apps/miniprogram/lib/api.ts` | UPDATE | 新增 `inflightEnsureJwt` Map + `__clearInflightEnsureJwt` + 改 `fetchWithRefresh` 12 行（spec §5.1）|
| `apps/miniprogram/test/api.test.ts` | UPDATE | +3 用例（spec §9.2 inflight 3 用例，含修正后的 wx.login 控制 fixture）|
| `apps/api/src/lib/rate-limit.ts` | UPDATE | 新 `RateLimitConfig` + `DEFAULT_RATE_LIMIT_CONFIG` + `readRateLimitConfig(env)` + 改 `checkRateLimit` 签名（spec §5.2）|
| `apps/api/src/routes/auth.ts` | UPDATE | 导入 `readRateLimitConfig` + 2 处 `checkRateLimit` 调用加 config 参数 |
| `apps/api/src/types.ts` | UPDATE | Env 加 3 可选字段（spec §5.2 Env 类型扩展）|
| `apps/api/wrangler.jsonc` | UPDATE | vars 块加 3 个 var（LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS / CRON_SECRET）+ 注释 |
| `apps/api/migrations/0007_login_attempt_created_at_index.sql` | CREATE | 7 行（`CREATE INDEX idx_login_attempt_created_at ON login_attempt(created_at)`）|
| `apps/api/migrations/0007_login_attempt_created_at_index.down.sql` | CREATE | 1 行（`DROP INDEX IF EXISTS idx_login_attempt_created_at`）|
| `apps/api/src/routes/cron.ts` | CREATE | 50 行（含 JSDoc）— `cronRoute.CLEANUP_LOGIN_ATTEMPTS` handler |
| `apps/api/src/index.ts` | UPDATE | +2 行（导入 `cronRoute` + 挂 `app.post("/cron/cleanup-login-attempts", ...)`）|
| `apps/api/test/lib/rate-limit.test.ts` | UPDATE | +2 用例（`readRateLimitConfig` fallback default + env 注入；`checkRateLimit(config)` 注入）|
| `apps/api/test/routes/cron.test.ts` | CREATE | 3 用例（happy / 401 缺 token / 401 错 token）|
| `docs/superpowers/specs/2026-06-16-m6-4-rate-limit-cron-inflight-design.md` | （已建）| spec 已 commit `6887eb9` |
| `docs/superpowers/plans/2026-06-16-m6-4-rate-limit-cron-inflight.md` | （本文件）| plan artifact |
| `docs/superpowers/state-m6-4.md` | CREATE | 收尾归档（main thread 写）|
| `README.md` | UPDATE | M6.4 节（main thread 写）|

**总计**：5 新建（0007 .sql + .down.sql + routes/cron.ts + test/routes/cron.test.ts + state-m6-4.md）+ 1 新建 spec（已存在）+ 7 修改 + 1 plan = 14 改动 + 1 plan + 1 spec。

---

## 4. Tasks (4 task / 2 checkpoint)

### Phase 1 — 主线程直接实施（3 task / CP-1）

按 M6.3b/c 教训，本 spec **不派 subagent**，主线程直接做（4 task + 2 包 改动，估 1.5-2 天）。

**Task 1: miniprogram fetchWithRefresh inflight 共享 + 3 tests**
- Action: 改 `apps/miniprogram/lib/api.ts`（spec §5.1 完整代码）：
  - 新模块级 `const inflightEnsureJwt = new Map<string, Promise<string>>()`
  - 新 `@internal` export `function __clearInflightEnsureJwt(): void`
  - 改 `fetchWithRefresh` 实现：用 `inflightEnsureJwt.get/set` 共享 inflight，`.finally(() => delete)` 清缓存
- 改 `apps/miniprogram/test/api.test.ts` +3 用例（追加到 `describe("fetchWithRefresh (M6.3a)")` 后新 `describe("fetchWithRefresh (M6.4) — inflight promise 共享")`）：
  1. **3 并发 401 → `wxLoginMock` 只调 1 次**（spec §9.2 修正版 fixture：手动 resolveWxLogin + `await new Promise(r => setTimeout(r, 0))` 让 3 个都进入 inflight await）
  2. **串行：先 1 个 401 → refresh 完成 → 再触发 401 → ensureJwt 调第 2 次**（验证 `.finally` 清缓存）
  3. **不同 baseUrl 互不影响**（A + B 并发 401 → `wxLoginMock` 调 2 次）
- beforeEach 加 `__clearInflightEnsureJwt()` reset
- Mirror: 现有 `wxLoginMock` + `wxRequestMock` + `__setJwtStorageImpl` 模式（`test/api.test.ts:269-413`）
- Validate: `pnpm -F miniprogram test test/api.test.ts` 26 旧 + 3 新 = 29 全绿（miniprogram 累计 29 + 3 = 32）

**Task 2: api rate-limit vars 配置化 + 2 tests**
- Action: 改 `apps/api/src/lib/rate-limit.ts`（spec §5.2 完整代码）：
  - 新 `RateLimitConfig` interface + `DEFAULT_RATE_LIMIT_CONFIG` 常量
  - 新 `readRateLimitConfig(envLike)` 纯函数（缺失/非法 → fallback default）
  - 改 `checkRateLimit` 签名加可选 `config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG` 参数（向后兼容）
  - 内部用 `config.maxFailures` / `config.windowMs` 替换硬编码 `MAX_FAILURES` / `WINDOW_MS`
- 改 `apps/api/src/routes/auth.ts`：
  - import 加 `readRateLimitConfig`
  - 2 处 `checkRateLimit(env.DB, ..., type)` → `checkRateLimit(env.DB, ..., type, readRateLimitConfig(env))`
- 改 `apps/api/src/types.ts`：Env 加 3 可选字段
- 改 `apps/api/wrangler.jsonc` vars 块加 3 个 var：
  - `LOGIN_MAX_ATTEMPTS: "5"` + 注释
  - `LOGIN_WINDOW_MS: "900000"` + 注释
  - `CRON_SECRET: "dev-cron-secret-change-me-in-production"` + 注释
- 改 `apps/api/test/lib/rate-limit.test.ts` +2 用例：
  1. `readRateLimitConfig({})` 缺 env → 返 `DEFAULT_RATE_LIMIT_CONFIG`
  2. `readRateLimitConfig({ LOGIN_MAX_ATTEMPTS: "3" })` → `{ maxFailures: 3, ... }`
  3. `readRateLimitConfig({ LOGIN_MAX_ATTEMPTS: "abc" })`（非法）→ fallback 5
  4. `checkRateLimit(env.DB, id, type, { maxFailures: 2, windowMs: ... })` → 2 次失败后第 3 次 lock
- Mirror: 现有 `apps/api/test/lib/rate-limit.test.ts` 6 用例（保留作回归）+ `routes/auth.ts:53-62` `handleHttpError` 模式
- Validate: `pnpm -F api test test/lib/rate-limit.test.ts` 6 旧 + 2 新 = 8 全绿（api 累计 98 + 2 = 100）

**Task 3: api login_attempt cron cleanup + 3 tests**
- Action:
  1. 新 `apps/api/migrations/0007_login_attempt_created_at_index.sql`（spec §5.3 migration 完整 SQL）
  2. 新 `apps/api/migrations/0007_login_attempt_created_at_index.down.sql`（`DROP INDEX`）
  3. 新 `apps/api/src/routes/cron.ts`（spec §5.3 handler 完整代码）：
     - 验证 `Authorization: Bearer <CRON_SECRET>` → 否则 401 UNAUTHORIZED
     - `const now = Date.now(); const cutoff = now - 24 * 60 * 60 * 1000`
     - `DELETE FROM login_attempt WHERE created_at < ?` → 返 `{ deleted, cutoff }`
     - try/catch 500 兜底
  4. 改 `apps/api/src/index.ts`：
     - `import { cronRoute } from "./routes/cron.js"`
     - `app.post("/cron/cleanup-login-attempts", (c) => cronRoute.CLEANUP_LOGIN_ATTEMPTS(c.req.raw, c.env))`
  5. 新 `apps/api/test/routes/cron.test.ts` 3 用例：
     - happy: `Authorization: Bearer <CRON_SECRET>` + miniflare D1 mock DELETE → 返 `{ deleted: N, cutoff }`
     - 401 缺 token: 无 Authorization header → 401
     - 401 错 token: `Authorization: Bearer wrong` → 401
- Mirror: 现有 `routes/auth.ts` handler 模式 + D1 `prepare/bind/run` 模式
- miniflare test setup: 复用 `applyMigrations` 自动加载 0001-0007（task 3 自身保证 0007 已建）
- Validate: `pnpm -F api test test/routes/cron.test.ts` 3 用例绿（api 累计 100 + 3 = 103）

**CP-1 验证（3 task 完成后）**：
```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m6-4-rate-limit-cron-inflight
pnpm -r typecheck
pnpm -r test
```
期望：205 旧 + 8 新 = **213 全绿** + 5 包 typecheck 全绿

---

### Phase 2 — 主线程收尾（Task 4 / CP-2）

**Task 4: state-m6-4.md + README + merge to master + worktree 清理 + 独立 CP-2 验证**
- Action: 仿 `state-m6-3c.md` 模板写 `docs/superpowers/state-m6-4.md` 11 sections（commit 汇总 / 测试矩阵 / 与 spec 偏差 / 实施 concern / dev 验证缺口 / CP-5 真接路径 / 下一步建议 / 主线程接管）
- 改 `README.md` 加 M6.4 节（inflight / rate-limit vars / cron 行为描述 + 213 测试 + YAGNI 限制）
- merge `worktree-m6-4-rate-limit-cron-inflight` → master with `--no-ff`
- `worktree remove --force` + `branch -d`
- 主仓库跑 `pnpm -r test` + `pnpm -r typecheck` 独立 CP-2 验证
- Validate: master HEAD 含 merge commit + worktree 清理 + 213 用例全绿 + 5 包 typecheck 全绿

---

## 5. Validation

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m6-4-rate-limit-cron-inflight

# CP-1（3 task 完成后）
pnpm -r typecheck
pnpm -r test
# 期望 205 旧 + 8 新 = 213 全绿

# CP-2（合并后，主仓库跑）
cd /Users/Mark/cc_project/unequal
pnpm -r typecheck
pnpm -r test
# 期望 213 全绿

# 增量测试（task 局部验证，不全跑）
pnpm -F miniprogram test test/api.test.ts       # task 1: 26 旧 + 3 新 = 29
pnpm -F api test test/lib/rate-limit.test.ts   # task 2: 6 旧 + 2 新 = 8
pnpm -F api test test/routes/cron.test.ts      # task 3: 3 新
```

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| 跨 2 包改动（miniprogram + api）主线程上下文负担 | 中 | M6.3b/c 教训应用：主线程直接做避免 subagent stall；3 task 不算大 |
| Task 1 inflight promise 内存泄漏 | 极低 | `.finally(() => delete)` 立即清；baseUrl 最多 1-2 个；key 隔离 |
| Task 2 `checkRateLimit` 签名破坏旧调用方 | 低 | 可选 config 参数（不传走 default）；全仓 grep `checkRateLimit(` 验证仅 auth.ts 两处 |
| Task 2 非法 env 把所有人锁死 | 极低 | `readRateLimitConfig` parse 失败 fallback default（不 throw）|
| Task 3 cron endpoint 被外部滥用 | 低 | `CRON_SECRET` Bearer 验证；CP-5 升级到 wrangler secret put |
| Task 3 索引加在已大表慢 | 极低 | user 表当前 0-几千行；migration 应用秒级 |
| Task 3 mock-first 不验 cron 触发 | 低 | endpoint 单元测试覆盖 DELETE 逻辑 + secret 验证；CP-5 接 scheduled handler 时再验 |
| Task 3 24h 阈值硬编码 | 低 | 24h 留足 rate-limit 窗口（15min）分析余量；不抽 env（YAGNI）|
| 3 task 顺序（mini inflight → api rate-limit → api cron）| 极低 | mini 最简单先做（建信心）→ api 配置化（基础设施）→ api cron（最复杂）|

**最高风险**：跨 2 包改动主线程上下文负担。Mitigation：M6.3b/c 教训应用（避免 subagent stall）+ 3 task 边界 + 每 task 完成后立即 commit + 跑该 task 局部测试（不全跑 pnpm -r）。

---

## 7. Acceptance

- [ ] 8 新增用例全绿（mini 3 + api 2 + api 3 = 8）
- [ ] 累计 213 用例全绿
- [ ] 5 包 typecheck 全绿
- [ ] 主线程独立 CP-2 验证（trust but verify）
- [ ] state-m6-4.md 11 sections 完整
- [ ] README M6.4 节就位
- [ ] merge to master + worktree 清理 + branch 删除
- [ ] 0 production console.log（api / miniprogram）
- [ ] wrangler.jsonc vars 加 3 个（LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS / CRON_SECRET）
- [ ] 0007 migration 加单列 created_at 索引

**dev 验证缺口**（推到 CP-5 真接 Cloudflare）：
- 真实 Cloudflare Cron Trigger 触发（方案 A scheduled handler）— M6.4 范围不强制
- 真实 external cron 触发（方案 B GitHub Actions / launchd）— M6.4 范围不强制
- 真实 wrangler vars 注入（vs mock env 对象字面量）— CP-5 真接后验
- 真实 wx.login 真机上 3 个并发 fetch 行为 — CP-5 真机验证
- 真实 D1 大表加索引性能 — 当前 user 表 0-几千行无影响；CP-5 时若数据量增再评估

---

## 8. Implementation Notes

### 8.1 Subagent 分配

**M6.3b/c 教训应用**：
- 1 subagent 范围 < 3 task → 主线程直接做更稳
- 1 subagent 范围 ≥ 3 task → 可派 subagent 但需小心
- 跨 2 包改动 → 优先主线程

M6.4 3 task（实施）+ 1 task（收尾）跨 2 包（miniprogram + api），**决策主线程直接做**（避免 subagent stall 风险 + 跨包改动主线程能 handle 上下文）。

### 8.2 Commit 节奏（4 commit + 1 merge = 5 总）

```
1. feat(mini): M6.4 task 1 — fetchWithRefresh 共享 inflight promise + 3 tests
2. feat(api):  M6.4 task 2 — rate-limit 阈值提取到 wrangler vars + 2 tests
3. feat(api):  M6.4 task 3 — login_attempt cron cleanup (0007 index + routes/cron.ts + CRON_SECRET)
4. docs:       M6.4 state-m6-4.md + README M6.4 节
merge:        worktree-m6-4-rate-limit-cron-inflight → master --no-ff
```

### 8.3 验证顺序

1. **CP-1**（task 1-3 完成后）：`pnpm -r typecheck` + `pnpm -r test` → 期望 205 旧 + 8 新 = 213 全绿
2. **CP-2**（合并后，主线程独立）：`pnpm -r test` + `pnpm -r typecheck` → 期望 213 全绿
3. **CP-5**（推到真接 Cloudflare 时）：真实 cron trigger + 真实 vars 注入 + 真实 wx.login 并发验证

### 8.4 ECC 引用

- `tdd-workflow` (ECC) — 8 用例 RED → GREEN → REFACTOR
- `subagent-driven-development` (ECC) — **本 plan 决策主线程直接做**（M6.3b/c 教训）
- `code-review` / `typescript-review` — api.ts 改 12 行 + rate-limit.ts 改 ~25 行 + cron.ts 新文件 + wrangler.jsonc 改 vars
- `verification-before-completion` (Superpowers) — CP-1/2 验证

### 8.5 Worktree 路径

按 M6.3c 模式：`.claude/worktrees/m6-4-rate-limit-cron-inflight`，分支 `worktree-m6-4-rate-limit-cron-inflight`。
