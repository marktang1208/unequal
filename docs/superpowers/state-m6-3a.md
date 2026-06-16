# M6.3a State

> M6.3a 实施收尾归档（参考 state-m6-2.md / state-m6-1.md 模式）。归档时间：2026-06-16。
> 配套：spec = `docs/superpowers/specs/2026-06-16-m6-3a-auth-hardening-design.md`，plan = `docs/superpowers/plans/2026-06-16-m6-3a-auth-hardening.md`。

## Mock-first 边界（严格遵守）

M6.3a 全程零真人操作：
- ❌ 不真接 Cloudflare Workers / D1（任何 `wrangler deploy` / `wrangler dev --remote`）
- ❌ 不真接 jscode2session（任何真 AppID / AppSecret）
- ❌ 不接 wx.login 真机扫码
- ❌ 不真触发 rate limit 5 次连续失败（jsdom fake timer + miniflare in-memory D1 模拟）
- ✅ D1 login_attempt 表走 miniflare 真 binding（migration 0005）
- ✅ rate limit sha256 走 Web Crypto subtle.digest（Workers + Node + miniflare 都内置）
- ✅ admin LoginPage 429 倒计时走 vi.useFakeTimers
- ✅ miniprogram fetchWithRefresh 走 fetchImpl 注入 mock 401/200 切换
- ✅ admin handleApiResponse 401 navigate 走 vi.spyOn(globalThis, "fetch") + Object.defineProperty(window, "location")

## Checkpoint pass 标准（全部达成）

| CP | Tasks | Pass 标准 | 实际 |
|---|---|---|---|
| CP-1 | SA1 1-4 | rate-limit 6 + auth route 3 = 9 新 + 77 旧 = 86 全 api 绿 | ✅ 86 api 用例绿 + typecheck 绿 |
| CP-2 | SA2 5-7 + SA4 11a-11b | admin App 3 + LoginPage 2 + handleApiResponse 1 + 5 fetch 串接 3 = 9 新 + 12 旧 = 21 全 admin 绿 + build 成功 | ✅ 21 admin 用例绿 + typecheck 绿 + build 成功 195.67 kB |
| CP-3 | SA3 8-10 | miniprogram api 4 + auth 1 = 5 新 + 18 旧 = 23 全 miniprogram 绿 | ✅ 23 miniprogram 用例绿 + typecheck 绿 |
| CP-4 | 11-13（主线程）| 全 typecheck + 累计 187 用例绿 + build | ✅ 187 用例绿（38 shared + 86 api + 23 miniprogram + 21 admin + 19 crawler，比 spec 估 182 多 5）|

## 累计 187 用例分布（实际）

| 包 | 用例 | 文件 | M6.3a 新增 |
|---|---|---|---|
| packages/shared | 38 | 7 | 0（无改动）|
| apps/api | 86 | 14 | 9（rate-limit 6 + auth route 3 = A2 6 + A3 1 + A4 2）|
| apps/miniprogram | 23 | 2 | 5（api 4 + auth 1 = C1 4 + C3 1）|
| apps/admin | 21 | 5 | 9（App 3 + LoginPage 2 + handleApiResponse 1 + D2 3 串接）|
| apps/crawler | 19 | 5 | 0（无改动）|
| **合计** | **187** | **49** | **23** |

spec 估 18 新增 → 实际 23 新增（多 5：admin D2 串接 3 + SA1/SA3 边界扩展 2）。

## 与 spec / plan 偏差

### 1. SA3 Task 10 新测试改覆盖 /auth/wx-login 5xx 而非 wx.login fail（task 10 实施触发）

**Plan §4 Task 10 写**：wx.login 抛错时 ensureJwt throw → 加 1 用例。

**实际偏差**：wx.login fail 路径已被 M6.2 旧 #4 测试覆盖（`ensureJwt 失败 / wx.login 抛错 → 原 401 透传`）。

**实际方案**：新测试覆盖 /auth/wx-login 5xx server error 路径（与 fetchWithRefresh 的 catch 块强相关，是 spec §7.2 "Refresh /auth/wx-login 429 → 原 401 透传" 的非 429 姐妹路径）。同时 5xx 路径在 spec/plan 隐式未覆盖，加这条作为边界扩展。

**理由**：与 SA3 报告一致 — 选更有价值的边界覆盖，0 偏差成本。

### 2. SA3 Task 8 wrapper 标 @internal 导出 + 静态 grep 测试（task 8 实施触发）

**Plan §4 Task 8 写**：fetchWithRefresh 内部函数，5 函数共享走静态 grep 验证。

**实际偏差**：SA3 决定 `fetchWithRefresh` 标 `@internal` 导出，让 Task 8 行为测试直接调它，Task 9 串接时静态 grep 验证仍保留。

**理由**：
- wrapper 此时还未被 ask/chat 等函数接入（Task 9 才接），直接 export 让 Task 8 commit 独立绿
- JSDoc `@internal` 标注让 IDE 警告 + 防止生产代码误调
- 静态 grep 测试 仍守住"5 函数共享 wrapper" 防回退

**与 spec 兼容**：spec §5.3 描述 fetchWithRefresh 但未禁止 export，行为一致。

### 3. SA1 wx INVALID_CODE 加 pre-check（与 plan Task 4 一致、与 spec §5.2 简化版有歧义）

**Spec §5.2 写**：先调 jscode2session → 失败记 attempt（仅记）。

**Plan §4 Task 4 写**：下次同 code 若仍失败 → checkRateLimit 锁定（隐含 pre-check）。

**实际方案**：同时实现 pre-check + on-failure recordAttempt（与 plan 文字一致、与 admin 路径对称、与 spec 简化版等价 + 更优）。

**理由**：pre-check 节省一次 jscode2session 远程调用，attacker 行为影响一致（都被拒）。

### 4. **重要偏差：plan §8.3 简化决策的事实错误**（主线程裁定）

**Plan §8.3 写**："当前 admin 仅 adminLogin 一个 fetch 调用，且 LoginPage 在 onSubmit 的 catch 块显式处理 err.message，handleApiResponse 在 admin 端没有实际挂载点"。

**事实**：`apps/admin/src/lib/api.ts` 实际有 8 个 fetch 调用，其中 5 个认证调用（uploadFile / search / ask / authedJson / crawlUrl）—— 全部未包 handleApiResponse。SA2 grep 验证。

**后果**（如不补）：jwt 24h 过期后 admin 在 upload/search/ask/chat/crawlUrl 收 401 不会自动跳 /login —— spec §5.4/§7.3 "所有 admin fetch 调用统一包 handleApiResponse" 承诺未兑现。

**裁定**：派 SA4（Task 11a + 11b）补 task：
- D1 commit `518c4b0` — 5 fetch 串接 `const resp = handleApiResponse(await fetch(...))`
- D2 commit `e1c37b7` — 3 测试覆盖（ask mock 401 / authedJson 通过 chat 覆盖 / 5 正则 grep 防回退）
- handleApiResponse doc-comment 从"备件保留"改为"必须 wrap"作为未来回退 visible warning

**经验教训**：plan §8.3 简化决策前应 grep 验证事实前提。"看起来简单" ≠ "实际简单"。M6.4 spec / plan 写前必跑一次 sanity check。

## 12 commit 汇总

| Task | Commit | 主题 |
|---|---|---|
| spec | `003d574` | M6.3a spec — auth hardening (rate limit + RequireAuth 全包 + 401 refresh) |
| spec | `67edfde` | spec §5.5 explicit admin 9 routes + catch-all RequireAuth code |
| plan | `bb99c27` | M6.3a plan — 13 task / 4 CP / 18 新增用例 / 3 subagent 并行 |
| A1 | `142da84` | migration 0005 login_attempt + idx |
| A2 | `d757061` | lib/rate-limit (sha256 + check + record) + 6 tests |
| A3 | `df9046e` | /auth/admin-login rate limit + 1 test |
| A4 | `17feba1` | /auth/wx-login rate limit (INVALID_CODE 路径) + 2 tests |
| B1 | `1bb960c` | App.tsx 9 路由 + catch-all 全包 RequireAuth + 3 tests |
| B2 | `e59c4a4` | LoginPage 429 倒计时 + 2 tests |
| B3 | `5e51dc8` | lib/api.ts handleApiResponse 401 handler + 1 test |
| C1 | `4c8cb61` | fetchWithRefresh wrapper + 4 tests |
| C2 | `e85fcbc` | chat/sessions/ask 全走 wrapper |
| C3 | `2f402d4` | ensureJwt 失败处理 + 1 test |
| D1 | `518c4b0` | handleApiResponse 串到 5 个认证 fetch |
| D2 | `e1c37b7` | handleApiResponse 5 fetch 串接测试 + 3 tests |
| state | （待写）| state-m6-3a.md（本文件）|
| merge | （待执行）| worktree-m6-3a-auth-hardening → master --no-ff |

**共 16 commit + 1 merge = 17 总**

## subagent 监控应用

M6.1 stall 教训 + `feedback_subagent_heartbeat_monitoring` memory 应用：
- 4 subagent 派发（SA1 + SA2 + SA3 + SA4）
- SA1+SA2+SA3 一次 3 并行（心率 5min cron 监控）
- SA2 完成后发现偏差 A 立即派 SA4 补 task
- 主线程接管 Task 11-13 收尾（state / README / merge / 清理 / 独立 verify）
- 全程无 stream watchdog stall（最长 subagent 13.5 min，3 SA 都干净完成）

## 与 SA 接触不到的遗留 concern

1. **per-token rate limit 攻击者换 wrong-token 绕过** — spec §11 风险 4 + M6.4 加 IP 维度消除
2. **D1 eventually consistent + 同 token 5 并发 admin-login 窗口** — SA1 报告 #2，M6.4 加 token-level mutex 或乐观锁
3. **login_attempt 表无清理策略** — spec §6/§11 已记录 M6.5+ 加 cron 清理
4. **fetchWithRefresh 并发 race** — spec §11 风险 6，每个 401 各自 refresh（功能正确但浪费），M6.4 共享 inflight promise
5. **grep 测试维护成本** — D2 5 正则需随 admin API 增长同步更新（CI 错误信息会提示具体漏的函数）
6. **staticState handleApiResponse 副作用测试局限** — `window.location.href = "/login"` 在测试中用 `Object.defineProperty` mock，生产 react-router 行为被绕过（spec 注释明确"强刷绕过 react-router 避免 race"，这是设计意图非 bug）
7. **Task 11 收尾留主线程** — SA4 仅做 D1+D2，未做归档/收尾

## dev 验证缺口（CP-5 真接时补）

M6.3a mock-first 阶段未做 dev 真验：
- admin LoginPage 真实暴力 6 次收 429 + 倒计时跑完
- 9 admin 路由真无 token 跳 /login
- miniprogram 真机让 jwt 过期 → 调 /chat 透明刷新
- admin upload/search/ask/chat/crawlUrl 真实 401 跳 /login（CP-5 验证 handleApiResponse 串接生效）

推到 CP-5（真接 Cloudflare + 微信真机）后做。

## 真接 Cloudflare 路径（CP-5 备查）

M6.3a 真接时无需新增 Cloudflare 资源（沿用 M6.2）：

1. **配 2 个 migration**（含 M6.3a 新增 0005）：
   ```bash
   pnpm wrangler d1 migrations apply unequal-db --remote
   ```
   含 0001_init + 0003_query_cache + 0004_chat_session + **0005_login_attempt**（0002_dev_seed 不上生产）

2. **D1 表初始化验证**：
   ```sql
   SELECT name FROM sqlite_master WHERE type='table' AND name='login_attempt';
   -- 应返 1 行
   ```

3. **重跑 admin dev 真验**：`pnpm dev:api` 跑 wrangler dev (remote)：
   - admin /login 输错 admin_token 5 次 → 第 6 次收 429 + 倒计时
   - 倒计时归零后输对 → 成功登录
   - admin 跳到 /upload，让 jwt 过期（修改 wrangler vars JWT_SECRET）→ 收 401 → 自动跳 /login
   - 9 admin 路由无 token 跳 /login

4. **微信开发者工具真机**：
   - 扫码 → 小程序 onLaunch ensureJwt → 调 /chat / /sessions 走真鉴权
   - 让 jwt 过期（修改 wrangler vars JWT_SECRET）→ 调 /chat 收 401 → 透明 wx.login + retry

## 下一步建议

M6.3b（用户没明确建议，推迟到拿到真实 nickname 需求时再做）：
1. session_key 存 D1（migration 0006）— `findOrCreateUser` 接 session_key 参数
2. wx.getUserInfo 解密 nickname/avatar（migration 0007）— 新 endpoint /auth/wx-user-info，AES-128-CBC + session_key 解密
3. 微信 `wx.getUserProfile` 2022 后 deprecated 调研

M6.4（运维增强，建议 1-2 天）：
1. rate limit 加 IP 维度（消除 per-token 绕过）
2. rate limit 阈值 wrangler vars 配置化（消除硬编码 5）
3. login_attempt 表 cron 清理 24h 前 attempts
4. D1 token-level mutex（消除同 token 5 并发 admin-login 窗口）
5. fetchWithRefresh 共享 inflight promise（消除并发 race 浪费）

M6.5+ 视需求。

## 主线程接管 task 11-13

按 user `feedback_subagent_heartbeat_monitoring` 改进 + 用户"merge 是 destructive 操作"原则，主线程接管收尾：
- Task 11: state-m6-3a.md（本文件，主线程写）
- Task 12: README M6.3a 节 + merge to master + worktree 清理 + branch 删除
- Task 13: 主线程独立 CP-4 验证（已提前到 pre-merge，本文件 §"Checkpoint pass 标准" 显示 187 用例绿 + 5 包 typecheck + admin build 成功）
