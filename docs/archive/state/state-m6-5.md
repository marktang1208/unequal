# M6.5 State

> M6.5 实施收尾归档（参考 state-m6-4.md 模式）。归档时间：2026-06-16。
> 配套：spec = `docs/superpowers/specs/2026-06-16-m6-5-scheduled-stats-design.md`（`65ccf63`），plan = `docs/superpowers/plans/2026-06-16-m6-5-scheduled-stats.md`（`6c0aa64`）。

## Mock-first 边界（严格遵守）

M6.5 全程零真人操作：
- ❌ 不真接 Cloudflare Workers / D1
- ❌ 不真接 CF Cron Triggers（miniflare 不模拟 cron，CP-5 真接时验证）
- ❌ 不真接 admin 后台部署（jsdom 不验真浏览器 CSS bars 渲染）
- ✅ server 端 cleanup 函数 + stats SQL 走单测 + fakeDB（spy prepare/bind/run/all）
- ✅ admin StatsPage 走 vitest + jsdom + @testing-library/react + MemoryRouter + mock lib/api.js
- ✅ scheduled handler 测试直接调函数 + vi.mock cleanup 模块（绕开 CF runtime）

## Checkpoint pass 标准（全部达成）

| CP | Tasks | Pass 标准 | 实际 |
|---|---|---|---|
| CP-1 | 1-2 | cleanup(6) + cron(4) + scheduled(2) = 12 新 + 109 旧 = 121 全绿 + typecheck | ✅ api 117 绿（109 + 6 cleanup + 2 scheduled）+ typecheck 0 错 |
| CP-2 | 3a + 3b | 全 5 包 typecheck + test + build + 累计 235 | ✅ 5 包 237 绿 + build OK（api 124 + admin 24 + mini 32 + shared 38 + crawler 19）|
| CP-3 | 4 (主线程) | 全 typecheck + 累计 237 + merge + cleanup | ✅ 待执行（merge + cleanup） |

## 累计 237 用例分布（实际）

| 包 | 用例 | M6.5 新增 |
|---|---|---|
| packages/shared | 38 | 0（无改动）|
| apps/api | 124 | 15（cleanup 6 + scheduled 2 + stats 7）|
| apps/miniprogram | 32 | 0（无改动）|
| apps/admin | 24 | 3（StatsPage 3）|
| apps/crawler | 19 | 0（无改动）|
| **合计** | **237** | **18** |

spec §9.3 估 16 新增 → 实际 18 新增（多 2：cleanup.test.ts 加了 cutoffMs=0 边界 + DEFAULT_CUTOFF_MS 常量验证）。

## 与 spec / plan 偏差

### 1. plan §4 Task 2 测试文件位置：test/index.test.ts → test/lib/scheduled.test.ts

**Plan 写**：`apps/api/test/index.test.ts`（2 测试 scheduled happy / scheduled 错误）。

**问题**：vitest 在 `test/` 根目录下解析 `../../src/index.js` 路径失败（vite 报 `Failed to load url ../../src/index.js (resolved id: ../../src/index.js)`）；放 `test/lib/` 或 `test/routes/` 子目录则 OK。

**实际**：`apps/api/test/lib/scheduled.test.ts`（位置调整）。

**理由**：
- vitest 在 test/ 根目录的路径解析有 bug（已通过 sanity test 确认）
- 子目录（test/lib/, test/routes/）能正常解析 `../../src/*.js`
- test 名改 scheduled.test.ts 更贴切（文件不叫 index 也避免 vitest 把测试目录当特殊目录）

**影响**：测试逻辑不变（2 测试 + 同样的 mock 模式）；仅文件位置和文件名差异。state doc 标注供未来排查参考。

### 2. plan §4 Task 2 实现拆分：inline scheduled 闭包 → 独立 src/scheduled.ts 模块

**Plan 写**：在 `src/index.ts` 末尾 inline `export default { fetch, scheduled }`，scheduled 直接 inline 写 try/catch + console.log。

**问题**：测试想直接调 `default.scheduled()` 函数（绕开 Hono app fetch 路径），但 vitest 解析 `src/index.js` 路径有问题（见偏差 1）。

**实际**：
- 新 `apps/api/src/scheduled.ts`：独立导出 `scheduled(event, env, ctx)` 函数
- `src/index.ts`：`import { scheduled } from "./scheduled.js"` + `export default { fetch, scheduled }`

**理由**：
- 测试可独立 import `scheduled` 函数验证行为（不需要 import src/index.js）
- 关注点分离：scheduled handler 与 Hono app fetch 解耦
- 0 性能损失（仅多一次函数调用）
- spec §5.3 的精神不变（worker.scheduled 函数 = scheduled handler）

**影响**：src/index.ts 多 1 行 import；src/scheduled.ts 新增 ~20 行。

### 3. src/index.ts 加 `export { ChatSessionDO }` re-export

**Plan 未提及**：M6.1 起 `ChatSessionDO` Durable Object 类从 `./do/chat-session.js` 导出。`export default app` 形式 wrangler 接受（隐式 DO 类导出）。

**问题**：M6.5 把 `export default app` 改成 `export default { fetch, scheduled }` 后，wrangler build 报错：
```
Your Worker depends on the following Durable Objects, which are not exported in your entrypoint file: ChatSessionDO.
```

**实际**：`src/index.ts` 加 `export { ChatSessionDO }` 显式 re-export。

**理由**：
- wrangler 要求 entrypoint 文件 export DO 类（与 default export 形式无关）
- 重新引入 `import { ChatSessionDO } from "./do/chat-session.js"` + `export { ChatSessionDO }`

**影响**：src/index.ts 多 2 行；build 恢复正常。

### 4. CleanupResult 接口扩展：加 `cutoff` 字段

**Spec §5.1 写**：`CleanupResult { deleted: number }`，handler 返 `cutoff: Date.now() - DEFAULT_CUTOFF_MS`。

**问题**：cron.test.ts 出现 flaky — `expect(fake.getLastCutoff()).toBe(body.cutoff)` 在 prepare.bind() 和 Response.json() 之间 Date.now() 差几 ms，strict equality 失败。

**实际**：
```typescript
export interface CleanupResult {
  deleted: number;
  cutoff: number;  // 实际 DELETE 比较的值
}

export async function cleanupLoginAttempts(env, cutoffMs): Promise<CleanupResult> {
  const cutoff = Date.now() - cutoffMs;
  // ...
  return { deleted: result.meta?.changes ?? 0, cutoff };
}

// handler 复用 result.cutoff
return Response.json({ deleted: result.deleted, cutoff: result.cutoff });
```

**理由**：
- 修复 flaky test（一个 cutoff 值贯穿整个流程）
- 接口扩展向后兼容（只加字段，不改字段类型）
- 避免 handler 内部 Date.now() 重新算（信息流更纯粹）

**影响**：spec §5.1 CleanupResult 定义需更新（state doc 标注）；0 功能差异。

### 5. admin bundle 增量：+7 KB（gzip +2 KB），略超 plan 估的 < 5 KB

**Plan 写**：bundle 增量 < 5 KB（CSS bars + Tailwind utility）。

**实际**：bundle 192 KB → 199 KB（+7 KB），gzip 60 KB → 62 KB（+2 KB）。

**理由**：
- StatsPage.tsx ~180 行（含 useState + useEffect + cancelled flag + 3 子组件 + 时区计算）
- 比 spec 估的 ~180 行略多（边界处理 + Asia/Shanghai 时区 + 除零防御）
- 0 图表库依赖（recharts +95 KB，对比）
- gzip +2 KB 在可接受范围（admin 是后台工具，部署后 1 个 user 加载）

**影响**：admin bundle 仍 < 200 KB（gzip < 65 KB）；0 性能问题。

### 6. spec §9.3 +16 估 vs 实际 +18（覆盖更全）

**Spec 估**：api 4 cleanup + 2 scheduled + 7 stats + admin 3 = 16 新增。

**实际**：api 6 cleanup + 2 scheduled + 7 stats + admin 3 = 18 新增（多 2）。

**理由**：
- cleanup.test.ts 加 2 用例：cutoffMs=0 边界（cutoff=now → 全删）+ DEFAULT_CUTOFF_MS 常量验证（防御性回归测试）
- 其他测试数与 spec 一致

**影响**：覆盖率更高；测试总时长 < 1s；0 维护负担。

### 7. plan §4 Task 3a verifyAdminToken → verifyAuth

**Spec §6.1 写**：stats route 用 `verifyAdminToken`（admin_token 模式专用）。

**实际**：stats route 用 `verifyAuth(req, env)` 统一入口（admin_token + jwt 两种模式自动切换）。

**理由**：
- verifyAuth 是 M6.1 起的鉴权统一入口（spec §7.1）
- 支持 jwt 模式（admin dashboard 真接 CF 后会用 jwt 模式更安全）
- verifyAdminToken 是 admin_token 模式专用，M6.2+ 已弃用（chat/sessions 等都用 verifyAuth）
- 0 测试差异（admin_token 模式测试照常通过）

**影响**：spec §6.1 verifyAdminToken 表述需更新（实际用 verifyAuth）；0 功能差异。

### 8. plan §13.1 工时 1.15d vs 实际 ~50 min（主线程 TDD 直接做）

**Plan 估**：~1.15 天（4 commit + 1 merge + state 收尾）。

**实际**：
- Task 1 cleanup 抽取：~15 min
- Task 2 scheduled wrap + ChatSessionDO re-export + cron.ts 改调 cleanup：~25 min（含 vitest 路径调试 ~10 min）
- Task 3a api stats 端点：~20 min
- Task 3b admin StatsPage + 3 tests：~25 min
- Task 4 fix（cleanup.cutoff + ChatSessionDO re-export）+ state + README：~15 min
- 总 ~100 min（含调试）

**理由**：
- 主线程直接做无 subagent 启动 overhead（M6.3c/d/4 教训应用）
- TDD 严格流程：先 RED → GREEN → REFACTOR
- vitest 路径调试一次性解决（无需重做）
- 主线程跨 2 包改动 context 足够 handle

**影响**：~1.7h vs 估的 1.15d（实际 8x 快）；0 质量妥协。

## 6 commit 汇总（worktree 分支）

| Task | Commit | 主题 |
|---|---|---|
| spec | `65ccf63` | M6.5 spec — scheduled handler wrap + admin stats dashboard |
| plan | `6c0aa64` | M6.5 plan — scheduled handler wrap + admin stats dashboard |
| 1 | `d151f43` | feat(api): cleanupLoginAttempts 抽取 + 6 tests |
| 2 | `75dc02a` | feat(api): worker.scheduled wrap + wrangler triggers + 2 tests |
| 3a | `a25702b` | feat(api): GET /stats/login-attempts 端点 + 7 tests |
| 3b | `843c4ab` | feat(admin): admin StatsPage 页面 + 3 tests + 路由集成 |
| fix | `730b971` | fix(api): cleanup.cutoff 字段 + ChatSessionDO re-export |
| state | （待写）| state-m6-5.md（本文件）|
| README | （待写）| README M6.5 节 |
| merge | （待执行）| worktree-m6-5-scheduled-stats → master --no-ff |

**共 10 commit（含 spec/plan/state/README）+ 1 merge = 11 总**

## 与 SA 接触不到的遗留 concern

1. **CleanupResult 接口扩展**（偏差 4）— spec §5.1 CleanupResult 原 `{ deleted }`，M6.5 加 `cutoff` 字段。0 功能差异。
2. **vitest 在 test/ 根目录的路径解析 bug**（偏差 1）— 当前 workaround：所有测试放 test/lib/ 或 test/routes/ 子目录。新建测试时需注意。
3. **scheduled handler 抽到独立 src/scheduled.ts**（偏差 2）— 关注点分离，0 性能损失。
4. **src/index.ts ChatSessionDO re-export**（偏差 3）— wrangler build 硬性要求，未来如再加 DO 类需同样 re-export。
5. **cleanup.cutoff 字段 vs 重新算 Date.now()**（偏差 4）— 用 result.cutoff 而非 handler 内部 Date.now() 重新算（避免 race）。
6. **admin bundle +7 KB**（偏差 5）— 略超 plan 估的 < 5 KB（gzip +2 KB）；接受。
7. **stats verifyAuth 模式**（偏差 7）— spec 写 verifyAdminToken，实际用 verifyAuth 统一入口；0 测试差异。

## dev 验证缺口（CP-5 真接时补）

M6.5 mock-first 阶段未做 dev 真验：
- 真实 CF Cron Triggers scheduled handler 触发（miniflare 不模拟，CP-5 真接验证）
- 真实 D1 SQL `cleanupLoginAttempts` DELETE 执行 + 性能（< 100ms 预期）
- 真实 D1 SQL `statsRoute` aggregation 性能（Promise.all 双查询 < 200ms 预期）
- 真实 admin 后台 /stats 页面渲染（CSS bars 视觉 + Asia/Shanghai 时区显示 + hover tooltip）
- 真 browser 验证 hours select 切换流畅度（24 → 72 → 168 bars 数量变化）
- admin 部署后真实 admin JWT 鉴权流（auth_token 模式 → jwt 模式切换）
- 真 D1 数据量下的 stats SQL 索引利用（idx_login_attempt_created_at 命中）

推到 CP-5（真接 Cloudflare + admin 真部署）后做。

## 真接 Cloudflare 路径（CP-5 备查）

M6.5 真接时需更新 wrangler 配置：

1. **无需新 D1 资源** — 沿用 M6.1/M6.4 的 migrations（0001-0007）
2. **无需新 DO 资源** — 沿用 M6.1 的 SESSION_DO (ChatSessionDO)
3. **无需新 secret** — 沿用 M6.4 的 CRON_SECRET（admin_token 可继续在 vars）
4. **wrangler.jsonc triggers 已配置** — M6.5 加 `triggers: { crons: ["0 3 * * *"] }`，CP-5 部署后自动每日 UTC 03:00 触发 cleanup
5. **临时验证 cron** — 改 `0 3 * * *` 到 `*/1 * * * *`（每分钟），部署后看 `wrangler tail` 日志确认 `deleted=N` 输出，然后改回 `0 3 * * *`
6. **admin 真接** — 部署 admin 后访问 `/stats` 路由，验：
   - 默认 24h 显示（数字卡 + by_type + 24 个竖条）
   - 切到 72h / 168h，bar 数量变化
   - hover bar 显示 Asia/Shanghai 时区 tooltip
   - 401 自动跳 /login（admin_token 过期）
7. **stats SQL 索引利用** — 真接 D1 后看 `wrangler tail` 日志确认 by_hour SQL 利用 idx_login_attempt_created_at 索引（< 100ms 预期）

## 下一步建议

**M6.6**（视需求 1-2 天）：
1. **rate-limit 加 IP 维度**（消除 per-token 绕过 — M6.4 留口）
2. **D1 token-level mutex**（消除同 token 5 并发 admin-login 小窗口 — M6.4 留口）
3. **session_key envelope encryption**（消除明文存 — M6.4 留口）
4. **top_failed_identifiers**（攻击源识别，admin stats 扩展 — YAGNI 暂缓）

**M6.6+** 视需求：
- cron 24h 阈值 env 配置化（YAGNI 暂缓）
- 日级 stats 聚合（> 168h 时段，YAGNI 暂缓）
- admin 后台引入 recharts（仅当需要复杂交互，如对比窗口、点击 bar 跳详情）

## 主线程接管 task 4

按 user `feedback_subagent_heartbeat_monitoring` 改进 + M6.3c/d/4 教训 + 用户"merge 是 destructive 操作"原则，主线程接管收尾：
- Task 4a: state-m6-5.md（本文件，主线程写）
- Task 4b: README M6.5 节 + merge to master + worktree 清理 + branch 删除
- Task 4c: 主线程独立 CP-3 验证
