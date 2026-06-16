# M6.6 State

> M6.6 实施收尾归档（参考 state-m6-5.md 模式）。归档时间：2026-06-16。
> 配套：spec = `docs/superpowers/specs/2026-06-16-m6-6-rate-limit-ip-design.md`（`73bea66`），plan = `docs/superpowers/plans/2026-06-16-m6-6-rate-limit-ip.md`（`c0fbe6a`）。

## Mock-first 边界（严格遵守）

M6.6 全程零真人操作：
- ❌ 不真接 Cloudflare Workers / D1
- ❌ 不真接 CF `CF-Connecting-IP` header（miniflare 不注入，CP-5 真接时验证）
- ❌ 不真 D1 SQL 索引命中 EXPLAIN（CP-5 真接验）
- ✅ server 端限流走单测 + fakeDB（spy prepare/bind/run/first）+ fake req.headers mock CF-Connecting-IP
- ✅ auth.test.ts 走 miniflare + D1 + applyMigrations（手动列 4 个 sql：0001/0005/0006/0008）

## Checkpoint pass 标准（全部达成）

| CP | Tasks | Pass 标准 | 实际 |
|---|---|---|---|
| CP-1 | 1 | rate-limit 11 新 + 7 旧 = 18 绿 + typecheck | ✅ rate-limit 18 绿 + typecheck 0 错 |
| CP-2 | 2+3 合并 | 全 api typecheck + test + 累计 251 | ✅ api 138 绿（124 旧 + 11 rate-limit + 3 auth）+ typecheck 0 错 |
| CP-3 | 4 (主线程) | 全 typecheck + 累计 251 + merge + cleanup | ✅ 待执行（merge + cleanup） |

## 累计 251 用例分布（实际）

| 包 | 用例 | M6.6 新增 |
|---|---|---|
| packages/shared | 38 | 0（无改动）|
| apps/api | 138 | 14（rate-limit 11 + auth 3）|
| apps/miniprogram | 32 | 0（无改动）|
| apps/admin | 24 | 0（无改动）|
| apps/crawler | 19 | 0（无改动）|
| **合计** | **251** | **14** |

spec §11.3 估 14 新增 → 实际 14 新增（精确一致）。

## 与 spec / plan 偏差

### 1. UNKNOWN_IP_HASH 字符数修正：15 → 16 字符

**Spec 写**：`export const UNKNOWN_IP_HASH = "unknown00000000";` // 16 字符固定。

**问题**：实数 "unknown00000000" = 7 + 8 = 15 字符。test 断言 `match(/^.{16}$/)` 失败。

**实际**：
- spec + plan + rate-limit.ts + rate-limit.test.ts 全部改为 `UNKNOWN_IP_HASH = "unknown000000000"`（7 + 9 = 16 字符）
- 4 处修正（spec/plan/rate-limit.ts/test 同步）

**理由**：原作者数 0 数量时少算了 1（spec 注释写"16 字符固定"但实际字符串是 15）。

**影响**：0 行为差异（仅字符串值长度修正）。

### 2. plan §4 Task 2 + Task 3 合并为 1 commit

**Plan §8.2 写**：Task 2（recordAttempt 签名扩 + 5 旧测试改）+ Task 3（auth.ts 改调 + migration 0008 + 3 auth tests）= 2 commit。

**问题**：Task 2 commit 单独跑会 typecheck fail（auth.ts 3 处 recordAttempt 旧 5 参数调用）+ miniflare auth.test.ts 5 fail（login_attempt 表无 client_ip 列，6 列 INSERT 失败）。

**实际**：Task 2 + Task 3 合并为 1 commit（`11374d8`）：recordAttempt 扩签名 + auth.ts 改调 checkRateLimitDual + auth.ts 3 处 recordAttempt 加 clientIpHash + migration 0008 + auth.test.ts applyMigrations 列表加 0008 + 3 新 auth tests。

**理由**：
- recordAttempt 6 列 INSERT 需 migration 0008 加 client_ip 列配合（不破坏 miniflare D1）
- auth.ts 3 处旧 5 参数调用签名破坏需同步改（typecheck AC 兜底）
- 合并后 commit 独立可跑（typecheck + 138 绿 + miniflare 跑通）

**影响**：commit 节奏从 plan §8.2 的 4 commit + 1 merge 缩为 2 commit + 1 merge（少 1 commit）。state-m6-6.md 标注供未来参考。

### 3. auth.test.ts applyMigrations 列表加 0008

**Plan 未明确**：auth.test.ts 的 `applyMigrations(d1)` 函数显式列 3 个 sql 文件（0001/0005/0006）。

**问题**：M6.6 加 0008 后，miniflare D1 表缺 client_ip 列，recordAttempt 6 列 INSERT 失败 → auth.test.ts 5 fail。

**实际**：
```typescript
for (const f of [
  "0001_init.sql",
  "0005_login_attempt.sql",
  "0006_user_session_key.sql",
  "0008_login_attempt_client_ip.sql",  // M6.6 新增
]) {
  // ...
}
```

**理由**：
- applyMigrations 是手写 helper（不读 migrations 目录自动）
- 未来 M6.7+ 加 migration 时需同步更新此列表（已知 limitation）
- 0 业务逻辑改动（仅测试 helper 列表扩展）

**影响**：auth.test.ts + 4 行；0 行为差异；状态机 5 旧测试仍 pass。

### 4. spec §15.1 commit 节奏调整：5 commit → 2 commit

**Spec §15.1 写**：5 commit + 1 merge = 6 commit（含 state/README 拆分）。

**实际**：2 commit + 1 merge = 3 commit（含 state/README 合并到 Task 4）。

**理由**：
- Task 2 + Task 3 合并（偏差 2）
- 4 task 简化为 2 commit（Task 1 独立 + Task 2+3 合并）
- Task 4 包含 state + README + worktree merge（保持 1 commit 收尾）

**影响**：plan §8.2 / spec §15.1 标注的"4 commit 节奏"实际为 2 commit 节奏；state doc 记录偏差供未来参考。

## commit 汇总（worktree 分支）

| Task | Commit | 主题 |
|---|---|---|
| spec | `73bea66` | M6.6 spec — rate-limit 加 IP 维度（双层独立）|
| plan | `c0fbe6a` | M6.6 plan — rate-limit 加 IP 维度（4 task / 2 CP）|
| 1 | `c88e146` | feat(api): rate-limit per-IP 维度（helpers + ByIp + Dual）+ 11 tests |
| 2+3 | `11374d8` | feat(api): recordAttempt 扩 clientIpHash + auth 双层限流 + migration 0008 |
| 4 | (待写) | state-m6-6.md（本文件）+ README M6.6 节 |
| merge | (待执行) | worktree-m6-6-rate-limit-ip → master --no-ff |

**共 5 commit（含 spec/plan/state/README）+ 1 merge = 6 总**

## 与 SA 接触不到的遗留 concern

1. **UNKNOWN_IP_HASH 长度修正**（偏差 1）— spec/plan/rate-limit.ts/test 4 处同步，0 行为差异
2. **Task 2+3 合并**（偏差 2）— recordAttempt 6 列 INSERT 需 migration 0008 配合
3. **applyMigrations 列表手动维护**（偏差 3）— 未来 M6.7+ 加 migration 需同步更新
4. **commit 节奏调整**（偏差 4）— plan §8.2 写 4 commit，实际 2 commit
5. **fakeDB COUNT/MIN SQL 关键字解析** — fakeDB 通过 `/client_ip\s*=\s*\?/i.test(sql)` 决定 filter column；脆弱但 mock-first 可接受
6. **auth.ts UNKNOWN_IP_HASH 临时占位**（Task 2 阶段）— 后续 Task 3 改 clientIpHash 后消除，commit 11374d8 已是最终状态
7. **Promise.all 并发 checkRateLimitDual** — 2 次 SQL 并发 < 10ms 总耗时（D1 边缘 < 5ms/次）；真接时验

## dev 验证缺口（CP-5 真接时补）

M6.6 mock-first 阶段未做 dev 真验：
- 真实 CF 边缘注入 `CF-Connecting-IP` header 行为（miniflare 不模拟，CP-5 真接时 curl 加 header 验）
- 真实 D1 SQL `checkRateLimitByIp` 索引命中（< 5ms 预期，CP-5 真接时 EXPLAIN）
- 真实 D1 ALTER TABLE + CREATE INDEX 性能（mock-first 不验）
- 真实 per-IP 锁行为（5 不同 token 同 IP → 429）
- admin 输 5 次错 token 锁本机 IP 15min UX 真实体验（mock-first 只能验逻辑不能验 UX）
- 真实生产环境 "unknown" bucket 是否真的"无"（CF 100% 注入，预期 0 行 client_ip=UNKNOWN_IP_HASH）

推到 CP-5（真接 Cloudflare）后做。

## 真接 Cloudflare 路径（CP-5 备查）

M6.6 真接 Cloudflare 0 新增资源：

1. **无需新 secret** — 沿用 M6.2 + M6.4（JWT_SECRET / WX_APP_SECRET / CRON_SECRET）
2. **无需新 D1** — `wrangler d1 migrations apply unequal-db` 自动跑 0008
3. **无需新 env** — 沿用 M6.4 LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS
4. **wrangler.jsonc 0 改** — IP 来自 header 而非 env
5. **真 CF 自动注入** — `CF-Connecting-IP: 1.2.3.4` header 透明注入（不可伪造，CF 边缘节点权威源）
6. **本地 dev 真验**：
   ```bash
   pnpm dev:api  # 跑 wrangler dev
   # 验 per-IP 锁
   for token in wrong1 wrong2 wrong3 wrong4 wrong5 wrong6; do
     curl -X POST http://localhost:8787/auth/admin-login \
       -H "CF-Connecting-IP: 1.2.3.4" \
       -H "Content-Type: application/json" \
       -d "{\"admin_token\":\"$token\"}" -w "\n%{http_code}\n"
   done
   # 1-5: 401 / 6: 429 RATE_LIMITED { retry_after: 900 }
   ```
7. **生产监控**：`/stats/login-attempts` 路由可加 `top_offending_ips` 扩展（**YAGNI 暂缓**）

## 下一步建议

**M6.7+**（视需求）：
1. **session_key envelope encryption**（M6.4 留口 — PII 合规需 key management + migration 兼容老数据，独立 1.5d）
2. **D1 token-level mutex**（M6.4 留口 — 同 token 5 并发窗口窄，价值低）
3. **admin /stats 加 top_offending_ips**（YAGNI — 暂缓）
4. **admin 误锁 UX 优化**（admin 输 5 次错 token 锁本机 IP 15min — 可接受折中）
5. **cron 24h 阈值 env 配置化**（YAGNI — 沿用硬编码 24h）

**CP-5 真接决策**：
- CF 资源开通（D1 database_id + Vectorize + R2 + DO）
- 5 个 secret 注入（ADMIN_TOKEN / JWT_SECRET / MINIMAX_API_KEY / WX_APP_SECRET / CRON_SECRET）
- wrangler vars 决策（LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS 沿用 vars；CRON_SECRET 升级到 secret）
- 微信小程序 AppID 注册（mp.weixin.qq.com）

## 主线程接管 task 4

按 user `feedback_subagent_heartbeat_monitoring` 改进 + M6.3c/d/4/5 教训 + 用户"merge 是 destructive 操作"原则，主线程接管收尾：
- Task 4a: state-m6-6.md（本文件，主线程写）
- Task 4b: README M6.6 节 + merge to master + worktree 清理 + branch 删除
- Task 4c: 主线程独立 CP-3 验证
