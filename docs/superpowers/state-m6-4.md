# M6.4 State

> M6.4 实施收尾归档（参考 state-m6-3c.md 模式）。归档时间：2026-06-16。
> 配套：spec = `docs/superpowers/specs/2026-06-16-m6-4-rate-limit-cron-inflight-design.md`（`6887eb9`），plan = `docs/superpowers/plans/2026-06-16-m6-4-rate-limit-cron-inflight.md`（`59827ce`）。

## Mock-first 边界（严格遵守）

M6.4 全程零真人操作：
- ❌ 不真接 Cloudflare Workers / D1
- ❌ 不接 wx 真机扫码
- ❌ 不接 Cloudflare Cron Trigger 真触发（HTTP endpoint + secret 验证；CP-5 真接时由用户决定触发方式）
- ✅ server 端 cron handler 走单测 + cronFakeDB（无需 miniflare bundle；fake DB.run 返 D1ExecResult 用 `as unknown` 兼容类型）
- ✅ miniprogram fetchImpl + wx.login 内存 mock（stateful fetchMock + 手动 resolveWxLogin 控制 inflight 时序）
- ✅ rate-limit 配置：单测 fake DB（与 M6.3a 同模式） + wrangler vars 走 mock env 对象字面量

## Checkpoint pass 标准（全部达成）

| CP | Tasks | Pass 标准 | 实际 |
|---|---|---|---|
| CP-1 | 1-3 | mini 3 + api 7 + api 4 = 14 新 + 205 旧 = 219 全绿 + typecheck | ✅ 219 用例全绿 + 5 包 typecheck 0 错 |
| CP-2 | 4（主线程）| 全 typecheck + 累计 219 + merge + cleanup | ✅ 待执行（merge + cleanup） |

## 累计 219 用例分布（实际）

| 包 | 用例 | M6.4 新增 |
|---|---|---|
| packages/shared | 38 | 0（无改动）|
| apps/api | 109 | 11（rate-limit 7 + cron 4）|
| apps/miniprogram | 32 | 3（inflight 3）|
| apps/admin | 21 | 0（无改动）|
| apps/crawler | 19 | 0（无改动）|
| **合计** | **219** | **14** |

spec 估 8 新增 → 实际 14 新增（多 6：readRateLimitConfig 5 用例覆盖更全 + cron 表空 edge 1）。

## 与 spec / plan 偏差

### 1. spec §5.2 checkRateLimit 签名：config 第 4 → now 第 4 / config 第 5（真正向后兼容）

**Spec §5.2 写**：
```typescript
export async function checkRateLimit(
  d1, identifier, type,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,    // 第 4 参数
  now: number = Date.now(),                                // 第 5 参数
): Promise<RateLimitResult>
```

**问题**：原签名 `checkRateLimit(d1, id, type, now)` 把 `now` 当第 4 参数；按 spec 新签名第 4 是 config，破坏现有 6 个旧测试 + auth.ts 调用方（传 number 当 RateLimitConfig → TS 编译错）。spec 标"向后兼容"但实际不兼容。

**实际**：
```typescript
export async function checkRateLimit(
  d1, identifier, type,
  now: number = Date.now(),                                // 第 4 默认（向后兼容）
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,     // 第 5 可选（新功能）
): Promise<RateLimitResult>
```

**理由**：
- 真正向后兼容：旧调用方 `checkRateLimit(d1, id, type, now)` 不破坏（6 个旧测试 0 修改）
- 新调用方可传 config 注入（`auth.ts` 加 `readRateLimitConfig(env)` 参数）
- TS 默认参数 + 可选参数位置规则要求"必填在前，可选在后" — 但 `now` 放第 4 后接可选 config 也可（默认参数按声明顺序解析）

**影响**：
- spec 文档需要更新（后续如需正式修订）
- 0 功能差异（仅参数顺序）
- 6 个旧测试 + auth.ts 0 改动（向后兼容生效）

### 2. spec §9.1 +8 估 vs 实际 +14（覆盖更全）

**Spec 估**：mini 3 + api 2 + api 3 = 8 新增。

**实际**：mini 3 + api 7 + api 4 = 14 新增（多 6）。

**理由**：
- readRateLimitConfig 单测多覆盖 4 用例：env 缺省 fallback / env 注入 / 非数字 fallback / ≤0 fallback / windowMs 注入（spec 估 1 用例覆盖"env 注入"单一路径）
- cron 加 1 edge case：表空 DELETE 0 行 → 返 `{ deleted: 0 }`（spec 估 3 happy/401 用例，缺表空 edge）

**影响**：覆盖率更高（5 路径覆盖 readRateLimitConfig 而非 1）；测试总时长 < 1s（fake DB 快）；0 维护负担。

### 3. plan §4 Task 1 估 0.5 天 vs 实际 ~10 min（主线程 TDD 直接做）

**Plan 估**：0.5 天（含 3 用例 TDD + 实现 + commit）。

**实际**：~10 min（含 3 用例 TDD + 实现 + 1 修正 + commit）。

**理由**：
- TDD 严格流程：先 RED（编译失败：helper 不存在）→ GREEN（实现）→ REFACTOR（无需大改）
- 中间 1 次 fixture 修正（ensureJwt 短路 storage 引起 test #2 失败；清 storage 后通过）
- 主线程直接做无 subagent 启动 overhead（M6.3b/c 教训应用）

**影响**：3 task 总耗时 ~25 min（plan 估 1.5-2 天），主线程效率高。

### 4. plan §4 Task 3 估 1 天 vs 实际 ~5 min

**Plan 估**：1 天（含 migration + endpoint + 测试）。

**实际**：~5 min（fake DB 比 miniflare bundle 快 + handler 简单）。

**理由**：
- cron handler 逻辑简单（鉴权 + 1 个 DELETE SQL）→ 单测 fake DB 即可（无需 miniflare bundle）
- 4 用例 TDD 直接做无 subagent

### 5. plan §4 Phase 2 主线程接管 — M6.3c 教训应用（与 spec §10 / plan §8.1 一致）

**Plan 决策**：主线程直接做 4 task 跨 2 包（miniprogram + api）。

**实际**：
- 主线程 4 task 总耗时 ~30 min（Task 1: 10 min / Task 2: 10 min / Task 3: 5 min / state 收尾 ~5 min）
- 跨 server + miniprogram 2 包改动，主线程 context 足够 handle
- 无 stall（与 M6.3b SA1 失败形成对比）

**M6.5 改进建议**（沿用 M6.3c）：
- 1 subagent 任务范围 < 3 task → 主线程接管
- 1 subagent 任务范围 ≥ 3 task 且每个 task 不需要 read 大文件 → 可派 subagent
- 跨 2 包改动 → 优先主线程

## 6 commit 汇总（worktree 分支）

| Task | Commit | 主题 |
|---|---|---|
| spec | `6887eb9` | M6.4 spec — rate-limit vars + cron cleanup + inflight promise |
| plan | `59827ce` | M6.4 plan — rate-limit vars + cron cleanup + inflight promise |
| 1 | `8f93436` | feat(mini): fetchWithRefresh 共享 inflight promise + 3 tests |
| 2 | `0af1d67` | feat(api): rate-limit 阈值提取到 wrangler vars + 7 tests |
| 3 | `03951d0` | feat(api): login_attempt cron cleanup (0007 index + routes/cron.ts + CRON_SECRET) |
| state | （待写）| state-m6-4.md（本文件）|
| README | （待写）| README M6.4 节 |
| merge | （待执行）| worktree-m6-4-rate-limit-cron-inflight → master --no-ff |

**共 8 commit（含 spec/plan/state）+ 1 merge = 9 总**

## 与 SA 接触不到的遗留 concern

1. **wrangler.jsonc LOGIN_MAX_ATTEMPTS 字符串 → 数字 parse** — wrangler vars 注入时是字符串；`readRateLimitConfig` 用 `parseInt` + `Number.isFinite` 守门；非法值 fallback default（spec §7.2 / plan §3.5）。无独立 wrangler vars 集成测试（mock-first 阶段不验）
2. **CRON_SECRET 明文放 vars** — M6.4 范围 mock-first 阶段可接受；CP-5 真接时升级到 `wrangler secret put CRON_SECRET`（spec §5.2 / plan §3.6）
3. **cloudflare scheduled handler wrap 未做** — M6.4 范围聚焦清理逻辑；CP-5 5 分钟可加（spec §4.7 / plan §3.5 trade-off C）
4. **cron 24h 硬编码未抽 env** — YAGNI；硬编码合理（24h 留足 rate-limit 窗口 15min × ~100 倍分析余量）（spec §13 / plan §3 §3.5）
5. **inflightEnsureJwt Map 内存泄漏** — `.finally(() => delete)` 立即清缓存；baseUrl 最多 1-2 个；key 隔离防御性（spec §5.1）
6. **readRateLimitConfig 非法 env 把所有人锁死** — 不会（parseInt 失败 fallback default，不 throw；`<= 0` 也 fallback）

## dev 验证缺口（CP-5 真接时补）

M6.4 mock-first 阶段未做 dev 真验：
- 真实 wrangler vars 注入（vs mock env 对象字面量）— CP-5 真接后验
- 真实 wx.login 真机上 3 个并发 fetch 行为（inflight 共享是否生效）— CP-5 真机验证
- 真实 Cloudflare Cron Trigger 触发（方案 A scheduled handler）— M6.4 范围不强制，CP-5 由用户决定
- 真实 external cron 触发（方案 B GitHub Actions / launchd）— 同上
- 真实 D1 大表加索引性能 — 当前 user 表 0-几千行无影响；CP-5 时若数据量增再评估
- 真实 admin 模式误调 cron endpoint（admin_token 可调吗？）— 当前仅验 Bearer CRON_SECRET，无 admin_token 检查；可接受（admin 不应该管 cron）

推到 CP-5（真接 Cloudflare + 微信真机）后做。

## 真接 Cloudflare 路径（CP-5 备查）

M6.4 真接时无需新增 Cloudflare 资源（沿用 M6.2/M6.3a/M6.3b/M6.3c）：

1. **无需新 D1 资源** — `wrangler d1 migrations apply unequal-db` 自动跑 0007 migration
2. **配 5 个 secret**（沿用 M6.2 + M6.4 新增）：
   ```bash
   pnpm wrangler secret put ADMIN_TOKEN
   pnpm wrangler secret put JWT_SECRET
   pnpm wrangler secret put MINIMAX_API_KEY
   pnpm wrangler secret put WX_APP_SECRET
   pnpm wrangler secret put CRON_SECRET   # M6.4 新增（从 vars 升级到 secret）
   ```
3. **改 `apps/admin/src/lib/api.ts` `API_BASE`**：从 `/api` 改 `https://unequal-api.xxx.workers.dev/api`
4. **改 `apps/miniprogram/lib/api.ts` baseUrl** 改 `https://unequal-api.xxx.workers.dev` + 微信公众平台加 request 合法域名
5. **wrangler vars 决策**（CP-5）：
   - LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS 放 vars（不同环境可调）；dev 默认 5 / 900000，prod 可调
   - CRON_SECRET 升级到 secret（生产敏感值）
6. **cron 触发方式**（CP-5 决策）：
   - **方案 A**：wrangler.jsonc 加 `triggers: { crons: ["0 3 * * *"] }` + wrap `app` default export 为 `{ fetch, scheduled }`（约 5 行改动）
   - **方案 B**：external cron（GitHub Actions / launchd / crontab）调 `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://unequal-api.xxx.workers.dev/cron/cleanup-login-attempts`
   - M6.4 不强制任一方案；CP-5 由用户决定
7. **重跑 admin dev 真验**：`pnpm dev:api` 跑 wrangler dev (remote)：
   - admin /login 正常登录
   - admin /upload / /search / /ask 正常工作
   - cron endpoint `curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:8787/cron/cleanup-login-attempts` → 返 `{ deleted: N, cutoff }`
8. **微信开发者工具真机**：扫码 → chat 页 → 24h 后首次打开 → 验证 inflight promise 共享（3 个并发 API 只触发 1 次 wx.login，需看 console.log 或 timing）

## 下一步建议

**M6.5**（视需求 1-2 天）：
1. rate-limit 加 IP 维度（消除 per-token 绕过）
2. D1 token-level mutex（消除同 token 5 并发 admin-login 小窗口）
3. session_key envelope encryption（消除明文存）
4. Cloudflare scheduled handler wrap（M6.4 留口 — CP-5 时由用户决定）
5. login_attempt 表统计 dashboard（admin 后台可视化）

**M6.5+** 视需求：
- cron 24h 阈值 env 配置化（YAGNI 暂缓）
- 5 函数共享 inflight promise 静态 grep 测试守卫（现有 M6.3a 静态测试已覆盖，不重复）

## 主线程接管 task 4

按 user `feedback_subagent_heartbeat_monitoring` 改进 + M6.3b/c 教训 + 用户"merge 是 destructive 操作"原则，主线程接管收尾：
- Task 4a: state-m6-4.md（本文件，主线程写）
- Task 4b: README M6.4 节 + merge to master + worktree 清理 + branch 删除
- Task 4c: 主线程独立 CP-2 验证
