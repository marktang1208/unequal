# Plan: M6.3a — Auth Hardening

- **Spec**：`docs/superpowers/specs/2026-06-16-m6-3a-auth-hardening-design.md`（commit `67edfde`）
- **日期**：2026-06-16
- **复杂度**：Medium（3 子系统并行 + 18 新增测试 + 主线程收尾）
- **Mock-first 边界**：D1 全 mock-first（miniflare in-memory）/ wx.login fetchImpl 注入 / admin LoginPage 429 jsdom fake timer — 无新 mock 边界

---

## 1. Requirements Restatement

M6.2 收尾（merge `3f6b07f`）留下 3 个生产前必须堵的口。Spec 把 M6.3 拆为 M6.3a（安全收口）+ M6.3b（用户体验），本 plan 只做 M6.3a：

**核心交付**：

| # | 子系统 | 交付物 |
|---|---|---|
| A | server rate limit | migration 0005 `login_attempt` + `lib/rate-limit.ts` + `/auth/admin-login` + `/auth/wx-login` 改造 |
| B | admin 9 路由 RequireAuth | `App.tsx` 9 路由 + catch-all `*` 全包 + `LoginPage` 429 倒计时 + `lib/api.ts` 401 navigate |
| C | client 401 refresh | `miniprogram/lib/api.ts` `fetchWithRefresh` wrapper + chat/sessions/ask 全走 + ensureJwt 失败处理 |

**不交付**（推到 M6.3b）：session_key 存 D1 + wx.getUserInfo 解密 nickname/avatar。

**新增用例**：18 个（rate-limit 6 + auth route 3 + admin App 3 + LoginPage 2 + miniprogram api 4）。**累计 182**。

---

## 2. Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| HttpError | `apps/api/src/lib/auth.ts:4-13` | `throw new HttpError(429, "RATE_LIMITED", "...")` 复用 M6.2 错误类型 |
| Route try/catch | `apps/api/src/routes/auth.ts:45-54` `handleHttpError` | 新增 429 case 在 `handleHttpError` 不需要 throw，路由内显式 return Response.json（带 retry_after）|
| D1 prepare/bind | `apps/api/src/lib/user.ts:37-52` | `d1.prepare(sql).bind(...).first<Row>() / .run()` 模式 |
| Migration | `apps/api/migrations/0001_init.sql:1-7` | `CREATE TABLE IF NOT EXISTS` + `CHECK` 约束 + 索引 |
| ULID | `apps/api/src/lib/user.ts:45` `ulid()` | login_attempt.id 用同包 |
| sha256 | Web Crypto `crypto.subtle.digest('SHA-256', ...)` | admin_token identifier hash（Workers + miniflare + Node 都内置）|
| miniprogram fetch wrapper | `apps/miniprogram/lib/api.ts:36-71` `wxRequestAsFetch` + `getFetch` | `fetchWithRefresh` 包现有 `getFetch`，复用 wx-request 适配 |
| ensureJwt 复用 | `apps/miniprogram/lib/auth.ts` M6.2 已建 | `fetchWithRefresh` 内 401 → 调 `ensureJwt` 拿新 jwt（无需新写 ensureJwt）|
| admin RequireAuth | `apps/admin/src/App.tsx:19-28` | 直接复用 HOC，包剩余 8 路由（`/chat-sim` M6.2 已包）|
| admin LoginPage 状态 | `apps/admin/src/pages/LoginPage.tsx:6-9` | `useState` 三件套（token / submitting / error），M6.3a 加 `lockedUntil` 第 4 state |
| admin api handleApiResponse | （新建） | 包装 fetch 返回值，401 → clearToken + window.location |
| jsdom fake timer | `apps/admin/src/pages/LoginPage.test.tsx`（M6.2 SA4）| `vi.useFakeTimers()` + `vi.advanceTimersByTime(1000)` 跑倒计时 |
| miniflare D1 测试 | `apps/api/test/lib/user.test.ts`（M6.2 SA3）| `applyD1Migrations` + `getMiniflareBindings`（参考 M6.1/6.2 已建 setup）|
| state 收尾文档 | `docs/superpowers/state-m6-2.md:1-30` | 仿照 M6.2 state 模板（11 sections 汇总）|

---

## 3. Files to Change

| File | Action | Why |
|---|---|---|
| `apps/api/migrations/0005_login_attempt.sql` | CREATE | login_attempt 表 + idx |
| `apps/api/migrations/0005_login_attempt.down.sql` | CREATE | DROP（双向 migration）|
| `apps/api/src/lib/rate-limit.ts` | CREATE | `sha256Identifier` + `checkRateLimit` + `recordAttempt` 三个函数 |
| `apps/api/src/lib/rate-limit.test.ts` | CREATE | 6 用例：sha256 一致性 / 4 次失败不锁 / 5 次锁 / 16min 解锁 / wx_code 同表 / retry_after |
| `apps/api/src/routes/auth.ts` | UPDATE | `/auth/admin-login` + `/auth/wx-login` 改造（rate limit pre-check + record attempt）|
| `apps/api/src/routes/auth.test.ts` | UPDATE | +3 用例：admin 5+1=429 / wx INVALID_CODE 5+1=429 / 429 body retry_after |
| `apps/admin/src/App.tsx` | UPDATE | 9 路由 + catch-all 全包 RequireAuth（仅 /login 公开）|
| `apps/admin/src/App.test.tsx` | CREATE | 3 用例：无 token 跳 /login / /login 公开 / 9 个 RequireAuth 实例 |
| `apps/admin/src/pages/LoginPage.tsx` | UPDATE | 加 `lockedUntil` state + 倒计时 setInterval + 429 error 分支 |
| `apps/admin/src/pages/LoginPage.test.tsx` | UPDATE | +2 用例：429 显示倒计时 / 倒计时归零按钮可点 |
| `apps/admin/src/lib/api.ts` | UPDATE | 新 `handleApiResponse` wrapper（401 → clearToken + window.location.href）|
| `apps/miniprogram/lib/api.ts` | UPDATE | 新 `fetchWithRefresh` wrapper，chat/sessions/ask/rename/delete 5 函数全走 |
| `apps/miniprogram/lib/api.test.ts` | UPDATE | +4 用例：401 refresh 透明 / wx.login 失败原 401 / 第二次 401 拒死循环 / 5 函数共享 |
| `docs/superpowers/specs/2026-06-16-m6-3a-auth-hardening-design.md` | （已建）| spec 已 commit `67edfde` |
| `docs/superpowers/plans/2026-06-16-m6-3a-auth-hardening.md` | （本文件）| plan artifact |
| `docs/superpowers/state-m6-3a.md` | CREATE | 收尾归档（main thread 写）|
| `README.md` | UPDATE | M6.3a 节（main thread 写）|

**总计**：7 新建 + 7 修改 + 1 plan artifact + 1 spec artifact（已存在）。

---

## 4. Tasks (13 task / 4 checkpoint)

### Phase 1 — Server rate limit（SA1, CP-1）

**Task 1: migration 0005 login_attempt 表 + 索引**
- Action: 写 `apps/api/migrations/0005_login_attempt.sql`（id/identifier/attempt_type/succeeded/created_at + CHECK 约束 + idx）+ `0005_login_attempt.down.sql`（DROP）
- Mirror: `apps/api/migrations/0001_init.sql:1-7` 风格
- Validate: `pnpm -F api db:reset`（或 miniflare applyMigrations）跑通 + 表存在

**Task 2: lib/rate-limit.ts + 6 用例**
- Action: 写 `lib/rate-limit.ts`：
  - `sha256Identifier(input: string): string` — `crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))` → hex 截 16
  - `checkRateLimit(d1, identifier, type, now=Date.now()): { locked: boolean, retry_after: number }` — COUNT failed attempts in 15min
  - `recordAttempt(d1, identifier, type, succeeded, now=Date.now()): Promise<void>` — INSERT 行
  - 常量 `WINDOW_MS=900_000`, `MAX_FAILURES=5`
- Mirror: `apps/api/src/lib/user.ts:37-52` D1 模式
- Validate: `pnpm -F api test test/lib/rate-limit.test.ts` 6 用例全绿

**Task 3: /auth/admin-login 加 rate limit + 1 用例**
- Action: 在 `routes/auth.ts:124` `verifyAdminToken` 之前插 pre-check，admin 验证后 `recordAttempt`
- Mirror: `routes/auth.ts:45-54` handleHttpError 模式（429 显式 return 不 throw，因为要带 retry_after）
- Validate: `pnpm -F api test test/routes/auth.test.ts` 5 旧 + 1 新 = 6 用例全绿

**Task 4: /auth/wx-login 加 rate limit (INVALID_CODE 路径) + 2 用例**
- Action: 在 `routes/auth.ts:48-50` jscode2session 抛 INVALID_CODE 时记 failed attempt（identifier=sha256(code).slice(0,16), type='wx_code'）；下次相同 code（罕见，5min 内）若还失败则 429
- Mirror: 同 Task 3
- Validate: `pnpm -F api test test/routes/auth.test.ts` +2 用例全绿（admin 旧 5 + 1 = 6 + wx 2 = 8 总）

**CP-1 验证（SA1 完成后）**：
```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m6-3a-auth-hardening
pnpm -F api typecheck              # 全绿
pnpm -F api test                    # 77 旧 + 9 新（rate-limit 6 + auth route 3）= 86 全绿
```

---

### Phase 2 — Admin RequireAuth 全包（SA2, CP-2）

**Task 5: App.tsx 9 路由 + catch-all 全包 RequireAuth + 3 用例**
- Action: 改 `App.tsx` routes（spec §5.5 完整代码），9 protected + catch-all 包 RequireAuth，仅 `/login` 公开
- Mirror: `App.tsx:76-83` 现有 `/chat-sim` 包裹
- Validate: `pnpm -F admin test test/App.test.tsx` 3 用例全绿

**Task 6: LoginPage.tsx 429 倒计时 + 2 用例**
- Action: 加 `lockedUntil: number | null` state；`useEffect` 监听 `lockedUntil` 启动 1s 间隔 setInterval 更新 `countdown: number`；`countdown===0` 时清 `lockedUntil`；submit 时若 `countdown > 0` 直接 disable + return
- Mirror: `LoginPage.tsx:6-30` 现有 useState + onSubmit 模式
- Validate: `pnpm -F admin test test/pages/LoginPage.test.tsx` 4 旧 + 2 新 = 6 用例全绿 + `pnpm -F admin build` 成功

**Task 7: admin lib/api.ts handleApiResponse 401 handler**
- Action: 新 `handleApiResponse(res: Response): Response` — 401 时 `localStorage.removeItem("admin_token")` + `window.location.href = "/login"`；所有 adminLogin 之外的 fetch 调用（无）暂时不需要包（admin 仅 adminLogin 一个 endpoint，且 LoginPage 已显式处理 429/401）
- **简化决策**（与 spec §5.4 略调）：admin 端没其它 fetch 端点，handleApiResponse 暂不挂载，留作 admin 其他 fetch 出现时的复用件。Task 7 缩为"建 lib 函数 + 1 jsdom 用例验证"。
- Mirror: M6.2 adminLogin 错误处理
- Validate: `pnpm -F admin typecheck` 全绿 + 1 用例（handleApiResponse 401 clear token）全绿

**CP-2 验证（SA2 完成后）**：
```bash
pnpm -F admin typecheck             # 全绿
pnpm -F admin test                  # 12 旧 + 5 新（App 3 + LoginPage 2 - handleApiResponse 1 用例并入 LoginPage 测试）= 17 全绿
pnpm -F admin build                 # 成功
```

**Task 7 简化说明**：spec §5.4 描述的 "所有 admin fetch 调用统一包 handleApiResponse" 在当前 admin 代码下不必要（admin 仅 adminLogin 一个调用点且 LoginPage 显式 catch）。主线程 review SA2 完成后确认无遗漏即接受此简化；如发现遗漏需再发补充 task。

---

### Phase 3 — Client 401 refresh（SA3, CP-3）

**Task 8: miniprogram fetchWithRefresh wrapper + 4 用例**
- Action: 新 `apps/miniprogram/lib/api.ts` 内部 `fetchWithRefresh(url, init, opts, isRetry=false)` — 401 + 非 retry → 调 `ensureJwt(baseUrl, fetchImpl)` 拿新 jwt → 用新 jwt 重发原 request 1 次；wx.login 失败或 /auth/wx-login 失败 → 返回原 401
- Mirror: `apps/miniprogram/lib/api.ts:36-71` `wxRequestAsFetch` + `getFetch`
- Validate: `pnpm -F miniprogram test test/lib/api.test.ts` 14 旧 + 4 新 = 18 全绿

**Task 9: miniprogram 5 函数全走 fetchWithRefresh**
- Action: 改 `chat` / `listSessions` / `renameSession` / `deleteSession` / `ask` 5 函数把 `getFetch(opts)` 替换为 `fetchWithRefresh(url, init, opts)`
- Mirror: 现有 5 函数结构（不改 URL / method / body，只换 fetch 入口）
- Validate: `pnpm -F miniprogram typecheck` 全绿

**Task 10: ensureJwt 失败处理**
- Action: 改 `apps/miniprogram/lib/auth.ts` `ensureJwt` 在 wx.login 抛错时（reject） — 现有 M6.2 实现应已 throw，验证 + 加 1 miniprogram test 用例覆盖
- Mirror: 现有 M6.2 ensureJwt 路径
- Validate: `pnpm -F miniprogram test test/auth.test.ts` 4 旧 + 1 新 = 5 全绿

**CP-3 验证（SA3 完成后）**：
```bash
pnpm -F miniprogram typecheck       # 全绿
pnpm -F miniprogram test            # 18 旧 + 5 新 = 23 全绿
```

---

### Phase 4 — 主线程收尾（CP-4）

**Task 11: state-m6-3a.md 收尾文档**
- Action: 写 `docs/superpowers/state-m6-3a.md` 仿 `state-m6-2.md` 模板（11 sections：commit 汇总 / 测试矩阵 / 6 deviations / 10 unimplemented / ECC 组件 / CP 验证表 / dev 验证缺口 / CP-5 真接路径 / 下一步建议）
- Mirror: `docs/superpowers/state-m6-2.md:1-30` 模板
- Validate: 文件存在 + 11 sections 完整

**Task 12: README M6.3a 节 + merge to master + worktree 清理**
- Action: 改 `README.md` 加 M6.3a 节（auth hardening 描述 + 3 项要点 + 179 测试）；merge `worktree-m6-3a-auth-hardening` → master with `--no-ff`；`worktree remove` + `branch -d`
- Validate: master HEAD 含 merge commit + worktree list 只剩主仓库 + 分支已删

**Task 13: 主线程独立 CP-4 验证**
- Action: 切回主仓库，跑：
  ```bash
  pnpm -r typecheck                  # 5 包全绿
  pnpm -r test                       # 累计 182 全绿
  pnpm -F admin build                # 成功
  ```
- Validate: 命令全过 + 输出数字对得上（86 api + 23 miniprogram + 17 admin + 38 shared + 19 crawler = 183 — 注：实际 182 由 spec 给定，差异允许 ±1 但需在 state 文档说清）

---

## 5. Validation

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m6-3a-auth-hardening

# CP-1（SA1 后）
pnpm -F api typecheck
pnpm -F api test

# CP-2（SA2 后）
pnpm -F admin typecheck
pnpm -F admin test
pnpm -F admin build

# CP-3（SA3 后）
pnpm -F miniprogram typecheck
pnpm -F miniprogram test

# CP-4（主线程收尾后，主仓库跑）
cd /Users/Mark/cc_project/unequal
pnpm -r typecheck
pnpm -r test
pnpm -F admin build
```

**期望**：182 测试全绿（rate-limit 6 + auth route 3 + admin App 3 + LoginPage 2 + miniprogram api 4 + miniprogram auth 1 = 18 新增；旧 164 累加）。

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| 401 refresh 死循环（refresh 自己 401）| 中 | `isRetry` flag 强制最多 retry 1 次（spec §5.3 / §7.2 已明确）|
| sha256 在 Workers / miniflare / Node 行为不一致 | 低 | Web Crypto 跨 runtime 标准 API；Task 2 用例在 miniflare 跑验证 |
| admin window.location 跳转破坏 react-router state | 低 | Task 7 简化决策：当前 admin 无其它 fetch 调用，handleApiResponse 不挂载，避免无谓 state 破坏 |
| miniprogram fetchWithRefresh 并发 race（多请求同时 401）| 中 | M6.3a 接受浪费（每个请求各自 refresh）；M6.4 优化（共享 inflight promise）|
| RequireAuth 全包 catch-all `*` 闪屏 | 低 | 用户接受（M6.2 /chat-sim 同体验）|
| 锁定阈值 5 太严/太松 | 中 | M6.3a 硬编码 5；M6.4 提取 wrangler vars 配置 |
| login_attempt 表增长 | 低 | 5000 用户 × 5 行/15min = 25k/15min，索引足够；M6.5+ cron 清理 |
| 429 wx_code identifier 撞 hash 误锁 | 极低 | sha256 truncated 16 hex chars = 64 bits 碰撞概率 2^-32，实际不会 |
| SA1/SA2/SA3 并发 commit 冲突 | 中 | 3 个 subagent 改不同文件（api/admin/miniprogram 互不重叠），commit 间无冲突 |
| Task 7 简化决策可能遗漏 | 低 | 主线程 review SA2 完成后独立 grep 确认无 fetch 漏包；遗漏则补 1 task |

---

## 7. Acceptance

- [ ] 18 新增用例全绿
- [ ] 累计 182 测试全绿
- [ ] 5 包 typecheck 全绿
- [ ] `pnpm -F admin build` 成功
- [ ] migration 0005 双向 up/down 跑通 miniflare
- [ ] 主线程独立 CP-4 验证（不靠 subagent 自报）
- [ ] state-m6-3a.md 11 sections 完整
- [ ] README M6.3a 节就位
- [ ] merge to master + worktree 清理 + branch 删除

**dev 验证缺口**（推到 CP-5 真接 Cloudflare + 微信真机）：
- admin LoginPage 真暴力 6 次收 429 + 倒计时跑完
- 9 admin 路由真无 token 跳 /login
- miniprogram 真机让 jwt 过期 → 调 /chat 透明刷新

---

## 8. Implementation Notes

### 8.1 Subagent 分配（3 个并行）

| Subagent | 任务 | 预估时间 | 强制 commit |
|---|---|---|---|
| SA1 server | Task 1-4（rate limit 4 任务）| 30 min | 4 commit |
| SA2 admin | Task 5-7（RequireAuth 3 任务）| 20 min | 3 commit |
| SA3 miniprogram | Task 8-10（401 refresh 3 任务）| 25 min | 3 commit |

**主线程接管**（destructive / 收尾）：
- Task 11-12-13：state 文档 / README / merge / worktree 清理 / branch 删除 / 独立 CP-4 验证
- 按 `feedback_subagent_heartbeat_monitoring`：每 subagent 单 CP 完成后主线程立即 grep commit 验证，10min 无 commit 主动 abort

### 8.2 Commit 节奏（11 commit + 1 merge = 12 总）

```
feat(api):  M6.3a A1 — migration 0005 login_attempt + idx
feat(api):  M6.3a A2 — lib/rate-limit (sha256 + check + record) + 6 tests
feat(api):  M6.3a A3 — /auth/admin-login rate limit + 1 test
feat(api):  M6.3a A4 — /auth/wx-login rate limit (INVALID_CODE 路径) + 2 tests
feat(admin): M6.3a B1 — App.tsx 9 路由 + catch-all 全包 RequireAuth + 3 tests
feat(admin): M6.3a B2 — LoginPage 429 倒计时 + 2 tests
feat(admin): M6.3a B3 — lib/api.ts handleApiResponse 401 handler + 1 test
feat(mini):  M6.3a C1 — fetchWithRefresh wrapper + 4 tests
feat(mini):  M6.3a C2 — chat/sessions/ask 全走 wrapper
feat(mini):  M6.3a C3 — ensureJwt 失败处理 + 1 test
docs:       M6.3a state-m6-3a.md 收尾 + README M6.3a 节
merge:      worktree-m6-3a-auth-hardening → master --no-ff
```

### 8.3 Task 7 简化决策说明（与 spec §5.4 的偏差）

spec §5.4 描述 "所有 admin fetch 调用统一包 handleApiResponse"。本 plan 在 Task 7 缩小范围：
- **原因**：当前 admin 仅有 `adminLogin` 一个 fetch 调用，且 `LoginPage` 在 onSubmit 的 catch 块显式处理 `err.message`（已能展示 401 错误），handleApiResponse 在 admin 端没有实际挂载点
- **保留**：建 `handleApiResponse` 作为 lib 函数 + 1 jsdom 用例验证（建好不用 = 备件）
- **风险**：主线程 review SA2 完成后 grep 确认无遗漏；如有遗漏补 1 task

### 8.4 验证顺序

1. **CP-1**（SA1 完成后）：`pnpm -F api test` + typecheck
2. **CP-2**（SA2 完成后）：`pnpm -F admin test` + `pnpm -F admin build`
3. **CP-3**（SA3 完成后）：`pnpm -F miniprogram test` + typecheck
4. **CP-4**（合并后）：主线程独立 `pnpm -r test` + `pnpm -r typecheck` + `pnpm -F admin build`
5. **CP-5**（推到 M6.3b 之后 / 真接 Cloudflare 时）：admin LoginPage 真暴力 / miniprogram 真机 jwt 过期

### 8.5 ECC 引用

- `tdd-workflow` (ECC) — 18 用例 RED → GREEN → REFACTOR
- `subagent-driven-development` (ECC) — SA1/SA2/SA3 并行
- `code-review` / `typescript-review` — rate-limit.ts / fetchWithRefresh / RequireAuth diff
- `security-reviewer` (ECC) — rate-limit 实施（OWASP A07）
- `verification-before-completion` (Superpowers) — CP-1/2/3/4 验证
