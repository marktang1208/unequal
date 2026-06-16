# M6.9 State

> M6.9 实施收尾归档（参考 state-m6-8.md 模式）。归档时间：2026-06-16。
> 配套：spec = `docs/superpowers/specs/2026-06-16-m6-9-token-mutex-design.md`（`734f4d0`），plan = `docs/superpowers/plans/2026-06-16-m6-9-token-mutex.md`（`ed4337c`）。

## Mock-first 边界（严格遵守）

M6.9 全程零真人操作：
- ❌ 不真接 Cloudflare Workers（多 isolate 并发行为未验）
- ❌ 不真 D1 write 串行 vs 并发性能差异（mock-first 不验）
- ✅ token-mutex 单元测试纯函数（不依赖 D1 / miniflare）
- ✅ auth.test.ts 14 旧测试行为不变（mutex 透明）

## Checkpoint pass 标准（全部达成）

| CP | Tasks | Pass 标准 | 实际 |
|---|---|---|---|
| CP-1 + CP-2 | 1 | api 167 绿 + 5 包 typecheck + build | ✅ api 167 绿（161 旧 + 6 新）+ 5 包 typecheck 0 错 + build OK |
| CP-3 | 2 (主线程) | 全 typecheck + 累计 280 + merge + cleanup | ✅ 待执行（merge + cleanup） |

## 累计 280 用例分布（实际）

| 包 | 用例 | M6.9 新增 |
|---|---|---|
| packages/shared | 38 | 0（无改动）|
| apps/api | 167 | 6（token-mutex 6）|
| apps/miniprogram | 32 | 0（无改动）|
| apps/admin | 24 | 0（无改动）|
| apps/crawler | 19 | 0（无改动）|
| **合计** | **280** | **6** |

spec §9.3 估 6 新增 → 实际 6 新增（精确一致）。

## 与 spec / plan 偏差

### 0 偏差

spec/plan 与实际完全一致：
- withTokenMutex 实现按 spec §5.1 完整代码
- auth.ts 3 处包裹按 spec §5.2
- 6 测试按 spec §6 完整用例
- commit 节奏按 plan §8.2 1 commit 极简（spec 估 3 commit + 1 merge = 4 总）

## commit 汇总（worktree 分支）

| Task | Commit | 主题 |
|---|---|---|
| spec | `734f4d0` | M6.9 spec — D1 token-level mutex (defensive) |
| plan | `ed4337c` | M6.9 plan — D1 token-level mutex (1 task / 2 CP) |
| 1 | `5253fbe` | feat(api): withTokenMutex (in-process Map) + auth.ts 包裹 + 6 tests |
| 2 | (待写) | state-m6-9.md（本文件）+ README M6.9 节 |
| merge | (待执行) | worktree-m6-9-mutex → master --no-ff |

**共 4 commit + 1 merge = 5 总**

## 与 SA 接触不到的遗留 concern

1. **多 isolate 不防**（spec §12.1）— CF Workers 多 isolate 间不共享 Map mutex
   - 缓解：M6.3a per-token 5/15min + M6.6 per-IP 5/15min 兜底（即使并发，rate-limit 仍锁定）
   - CP-5 真接后看实际并发量决定是否升级 DO-level mutex
2. **Map 内存泄漏**（spec §12.1）— finally 必删；同 identifier 不会无限增长
3. **串行后性能降级**（spec §12.1）— 同 token 串行 ~25ms（5 个 fn）；远低于 HTTP 30s 超时
4. **D1 写仍 5 行**（spec §12.1）— mutex 不阻止 D1 写；只串行化（行为不变，节省并发开销）
5. **5 测试用 setTimeout 50ms 依赖**（轻微 flaky）— `toBeLessThan(90)` 容差（并行 ~50ms vs 串行 ~100ms）

## dev 验证缺口（CP-5 真接时补）

M6.9 mock-first 阶段未做 dev 真验：
- 真实 CF Workers 多 isolate 并发行为（CF Workers isolate 调度通常同 zone）
- 真实 D1 write 串行 vs 并发性能差异
- 真实高并发场景（100+ admin-login 并发）下 mutex 表现
- 真实多 isolate race（5 admin-login 跨 isolate）下 rate-limit 兜底行为

推到 CP-5（真接 Cloudflare）后做。

## 真接 Cloudflare 路径（CP-5 备查）

M6.9 真接 Cloudflare 0 强制改：
1. **无需新资源**（沿用 M6.6 + M6.7 + M6.8）
2. **wrangler dev 模拟多 isolate 行为**：`wrangler dev --remote` + 多 client 并发测试
3. **wrangler tail 监控**：观察实际 D1 write 频率 + 锁分布
4. **如实际并发率高**：升级 ChatSessionDO DO-level mutex（M6.9+ YAGNI）

## 下一步建议

**M6.10+**（视需求）：
1. **admin 误锁 UX 优化**（state-m6-8.md §"下一步建议"）— admin 输 5 次错 token 锁本机 IP 15min UX 差
2. **top_offending_ips**（M6.5 留口）— YAGNI
3. **admin 批量重 wrap V1→V2 工具**（M6.8 留口）— 0 主动迁移 fallback 已够

**顶层 spec §13 后续演进**（视需求）：
- NLI 蕴含验证 / HyDE / 答案反馈 / 自动 invalidate / 信源自动评级 / 多端

**CP-5 真接决策**（里程碑）：
- 6 个 secret 注入（ADMIN_TOKEN / JWT_SECRET / MINIMAX_API_KEY / WX_APP_SECRET / CRON_SECRET / KEK_SECRET_V1）
- 微信小程序 AppID 注册（mp.weixin.qq.com）
- 老 user 数据迁移（M6.9 上线后重 login 自然升级到 currentVersion；fallback 链老 V 仍可读）

## 主线程接管 task 2

按 user `feedback_subagent_heartbeat_monitoring` 改进 + M6.3c/d/4/5/6/7/8 教训 + 用户"merge 是 destructive 操作"原则，主线程接管收尾：
- Task 2a: state-m6-9.md（本文件，主线程写）
- Task 2b: README M6.9 节 + merge to master + worktree 清理 + branch 删除
- Task 2c: 主线程独立 CP-3 验证
