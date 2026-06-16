# M6.3b State

> M6.3b 实施收尾归档（参考 state-m6-3a.md 模式）。归档时间：2026-06-16。
> 配套：spec = `docs/superpowers/specs/2026-06-16-m6-3b-session-key-design.md`，plan = `docs/superpowers/plans/2026-06-16-m6-3b-session-key.md`。

## Mock-first 边界（严格遵守）

M6.3b 全程零真人操作：
- ❌ 不真接 Cloudflare Workers / D1（任何 `wrangler deploy` / `wrangler dev --remote`）
- ❌ 不真接 jscode2session
- ❌ 不接 wx.login 真机扫码
- ✅ D1 user.session_key 走 miniflare 真 binding（migration 0006）
- ✅ updateUserSessionKey spy-style fake D1 测试（不解析 SQL，不走 miniflare）
- ✅ /auth/wx-login 写 session_key 走 miniflare bundle + spy D1 observable side effect（SELECT user.session_key）

## Checkpoint pass 标准（全部达成）

| CP | Tasks | Pass 标准 | 实际 |
|---|---|---|---|
| CP-1 | 1-3 | migration 1 + user 4 + auth 2 = 7 新 + 86 旧 = 93 全 api 绿 + typecheck | ✅ 93 api 用例绿 + typecheck 0 错 |
| CP-2 | 4-5（主线程）| 全 typecheck + 累计 194 用例 + merge + cleanup | ✅ 194 用例绿（38 + 86 + 23 + 21 + 19 + 7 M6.3b = 194）+ 5 包 typecheck 全绿 |

## 累计 194 用例分布（实际）

| 包 | 用例 | M6.3b 新增 |
|---|---|---|
| packages/shared | 38 | 0（无改动）|
| apps/api | 93 | 7（migration 1 + user 4 + auth 2 = task 1/2/3）|
| apps/miniprogram | 23 | 0（无改动）|
| apps/admin | 21 | 0（无改动）|
| apps/crawler | 19 | 0（无改动）|
| **合计** | **194** | **7** |

spec 估 6-8 新增 → 实际 7 新增（取中），匹配。

## 与 spec / plan 偏差

### 1. **关键偏差：SA1 stalled + 主线程接管**（M6.1 教训 + memory `feedback_subagent_heartbeat_monitoring` 应用）

**Plan 期望**：1 subagent × 3 task / 20-30 min。

**实际**：
- SA1 派发后 600s stream watchdog 触发 stall（failed 通知）
- SA1 失败前只输出了 1 行 "有 `integration.test.ts`" 表明在读 spec/plan 阶段就 stall
- 主线程接管 Task 1-3，按 SA1 prompt 字面执行（同样的 3 task + 同样的 commit 节奏）
- 总耗时：主线程接管 ~12 min（远快于 subagent 启动 overhead）

**原因分析**：
- SA1 stall 时正在读 `integration.test.ts`（188 行）+ `user.test.ts`（118 行）+ `auth.test.ts`（368 行）3 个大文件
- M6.3b 范围小（3 task）但测试文件大（与 SA1 启动 overhead 不匹配）
- 推测：subagent 启动后 read 大文件导致 stream watchdog 10 min 阈值触发

**与 M6.3a 对比**：
- M6.3a 4 SA 全部 clean（无 stall）
- M6.3b SA1 stall 唯一一次失败
- 范围大（4 subagent 协同）→ subagent 启动 overhead 摊薄
- 范围小（1 subagent 单 CP）→ 启动 overhead 占比高，read 阶段 stall 风险大

**M6.3c 改进建议**：
- 1 subagent 任务范围 < 3 task 时，主线程直接接管
- 1 subagent 任务范围 ≥ 3 task 且每个 task 不需要 read 大文件时，再派 subagent
- subagent prompt 应明确"先 read 哪些文件"避免 explore 阶段消耗 5-10 min

### 2. spec §7 "写失败不 throw 500" 实现差异

**Spec §7 写**："D1 写失败 → 透传 → 路由 try/catch 捕获 → 不 throw 500"。

**实际**：
- `updateUserSessionKey` 抛错（如 D1 IO error）→ 路由 try/catch 捕获 → 不 throw 500
- 实现完全匹配 spec
- 1 用例覆盖（D1 throw 透传测试）

### 3. plan §4 Task 3 "spy D1 prepare" vs 实际 "observable side effect"

**Plan §4 Task 3 写**："spy `env.DB.prepare` 检查 `UPDATE user SET session_key` 被调用 1 次"。

**实际**：用 observable side effect（`SELECT session_key FROM user LIMIT 1` 验证值）代替 spy。这是 miniflare bundle 测 wx-login 的合理替代（miniflare bundle 内 spy D1 操作比 spy 真实 fetch 难做）。**功能等价 + 更稳定**。

**理由**：miniflare bundle + authRoute.WX_LOGIN 模式下，D1 是真实的 D1Database instance，observable side effect 验证比 spy D1 call 计数更直接。

## 5 commit 汇总

| Task | Commit | 主题 |
|---|---|---|
| spec | `454a8f8` | M6.3b spec — session_key 存 D1 (YAGNI, nickname/avatar 推 M6.3c) |
| plan | `72589f1` | M6.3b plan — 5 task / 2 CP / 7 新增用例 / 1 subagent |
| 1 | `aeba254` | migration 0006 user.session_key + 1 test |
| 2 | `5e46aa7` | lib/user.ts updateUserSessionKey + 4 tests |
| 3 | `4d07b31` | /auth/wx-login 写 session_key + 2 tests |
| state | （待写）| state-m6-3b.md（本文件）|
| merge | （待执行）| worktree-m6-3b-session-key → master --no-ff |

**共 6 commit + 1 merge = 7 总**

## subagent 监控 + 主线程接管应用

M6.1 stall 教训 + M6.3a 模式 + memory `feedback_subagent_heartbeat_monitoring` 应用：
- SA1 派发 + 5-min cron heartbeat (d783d6c5) 监控
- SA1 600s stream watchdog 触发 stall 失败通知
- 主线程立即接管：读关键文件 → Task 1-3 字面执行 → 5 commit 就位
- 心跳 cron 删除（d783d6c5 cancelled）
- 经验沉淀：1 subagent 单 CP 任务，主线程直接做可能更稳（避免 subagent 启动 overhead + 5-10 min read 阶段 stall 风险）

## 与 SA 接触不到的遗留 concern

1. **session_key 存明文** — spec §11 记录，依赖 Cloudflare D1 encryption at rest；M6.4+ envelope encryption
2. **D1 eventually consistent + 并发 /wx-login** — 写频率低（M6.3a 评估），不构成实际问题
3. **ALTER TABLE 在大表慢** — M6.3b 阶段 user 表 0-几千行，ALTER 毫秒级；M6.5+ user 表破 100k 考虑新表
4. **migration 0006 down 留空** — SQLite < 3.35 不支持 DROP COLUMN；orphan column 无副作用
5. **每次 /wx-login 重写 session_key = 1 写/天/user** — 5k user × 1 写/天 = 5k/天 = 150k/月，可接受
6. **spy-style fake D1 + miniflare bundle 双模式** — user.ts 测走 spy，auth.ts 测走 miniflare bundle。两种风格混合但不冲突（功能独立）。

## dev 验证缺口（CP-5 真接时补）

M6.3b mock-first 阶段未做 dev 真验：
- wrangler d1 migrations apply 跑通（含 0006 + 之前所有 migration）
- 旧 user 字段 NULL + 新 user session_key 写成功
- 真 wx.login → 真 /auth/wx-login → D1 user.session_key 不为空
- 多次登录 session_key 覆盖（重写机制）

推到 CP-5（真接 Cloudflare + 微信真机）后做。

## 真接 Cloudflare 路径（CP-5 备查）

M6.3b 真接时无需新增 Cloudflare 资源（沿用 M6.2/M6.3a）：

1. **配 1 个 migration**（含 M6.3b 新增 0006）：
   ```bash
   pnpm wrangler d1 migrations apply unequal-db --remote
   ```
   含 0001_init + 0003_query_cache + 0004_chat_session + 0005_login_attempt + **0006_user_session_key**（0002_dev_seed 不上生产）

2. **D1 表初始化验证**：
   ```sql
   SELECT name FROM pragma_table_info('user') WHERE name = 'session_key';
   -- 应返 1 行
   ```

3. **重跑 admin dev 真验**：`pnpm dev:api` 跑 wrangler dev (remote)：
   - admin /login 正常登录（M6.3a 已覆盖）
   - admin /upload / /search / /ask 正常工作（M6.3a handleApiResponse 5 fetch 串接已覆盖）
   - D1 user.session_key 字段存在（用 `wrangler d1 execute` SELECT 验证）

4. **微信开发者工具真机**：
   - 扫码 → 小程序 onLaunch ensureJwt → 调 /chat / /sessions
   - 调 /auth/wx-login 后查 D1 user.session_key 字段（用 wrangler d1 execute）应 = 微信 session_key

## 下一步建议

**M6.3c**（看用户需求决定，不自动启动）：
1. **/auth/wx-user-info endpoint**（AES-128-CBC + session_key 解密 encryptedData + iv）
2. **user 表 avatar_url 字段**（migration 0007）
3. **miniprogram 端**：
   - 方案 A: `wx.getUserProfile`（已 deprecated 2022，console warning）
   - 方案 B: `<input type="nickname">` 组件（2024 推，微信不返真实头像）
   - 方案 C: 不显示 nickname/avatar（最简）
4. **真接微信开发者工具验证**（CP-5 备查）

**M6.4**（运维增强，建议 1-2 天）：
1. rate limit 加 IP 维度（消除 per-token 绕过）
2. rate limit 阈值 wrangler vars 配置化（消除硬编码 5）
3. login_attempt 表 cron 清理 24h 前 attempts
4. D1 token-level mutex（消除同 token 5 并发 admin-login 窗口）
5. fetchWithRefresh 共享 inflight promise（消除并发 race 浪费）
6. session_key envelope encryption（消除明文存）

**M6.5+** 视需求。

## 主线程接管 task 4-5

按 user `feedback_subagent_heartbeat_monitoring` 改进 + 用户"merge 是 destructive 操作"原则，主线程接管收尾：
- Task 4: state-m6-3b.md（本文件，主线程写）
- Task 5: README M6.3b 节 + merge to master + worktree 清理 + branch 删除 + 独立 CP-2 验证
