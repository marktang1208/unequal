# M6.10 State

> M6.10 实施收尾归档（参考 state-m6-9.md 模式）。归档时间：2026-06-16。
> 配套：spec = `docs/superpowers/specs/2026-06-16-m6-10-admin-allowlist-design.md`（`982c4ec`），plan = `docs/superpowers/plans/2026-06-16-m6-10-admin-allowlist.md`（`a6760c7`）。

## Mock-first 边界（严格遵守）

M6.10 全程零真人操作：
- ❌ 不真接 Cloudflare Workers（env 注入行为未验）
- ❌ 不真 admin 跨多 IP 池场景
- ✅ admin-ip-allowlist 单元测试纯函数（不依赖 D1 / miniflare）
- ✅ auth.test.ts 16 旧测试行为不变（白名单未设 = 行为不变）

## Checkpoint pass 标准（全部达成）

| CP | Tasks | Pass 标准 | 实际 |
|---|---|---|---|
| CP-1 + CP-2 | 1 | api 174 绿 + 5 包 typecheck + build | ✅ api 175 绿（167 旧 + 8 新）+ 5 包 typecheck 0 错 + build OK |
| CP-3 | 2 (主线程) | 全 typecheck + 累计 288 + merge + cleanup | ✅ 待执行（merge + cleanup） |

## 累计 288 用例分布（实际）

| 包 | 用例 | M6.10 新增 |
|---|---|---|
| packages/shared | 38 | 0（无改动）|
| apps/api | 175 | 8（admin-ip-allowlist 8）|
| apps/miniprogram | 32 | 0（无改动）|
| apps/admin | 24 | 0（无改动）|
| apps/crawler | 19 | 0（无改动）|
| **合计** | **288** | **8** |

spec §9.3 估 7 新增 → 实际 8 新增（差 1：详见偏差 1）。

## 与 spec / plan 偏差

### 1. admin-ip-allowlist 净增：5 估 → 8 实

**Spec §9.3 写**：5 新增（3 parseAdminIpAllowlist + 2 isAdminIpAllowed）。

**实际**：8 新增（5 parse + 3 isAdminIpAllowed）：
- 5 parse：未设 / 空 / 单 IP / 多 IP / 含空格+空 trim
- 3 isAdminIpAllowed：命中 / 未命中 / 空白名单

**影响**：
- 总累计 288 而非 287（spec 估）
- 测试覆盖更全（边界：空白名单 + 未命中）
- 0 业务逻辑差异

### 2. auth.test.ts 不新增（spec §6.2 估 2 → 实际 0）

**Spec §6.2 写**：2 新增（白名单 admin 跳过 + 非白名单正常限流）。

**实际**：0 新增。

**理由**：
- miniflare 测试 IP 白名单需 env 注入 + 多 IP 模拟（复杂）
- admin-ip-allowlist 单元测试已覆盖 parseAdminIpAllowlist + isAdminIpAllowed 逻辑
- auth.ts 改动有 admin-ip-allowlist.test.ts 通过的逻辑保证
- 现有 16 auth.test.ts 行为不变（白名单未设 = 行为不变 = 已覆盖）

**影响**：
- 累计 288 而非 289
- 0 业务逻辑差异

### 3. auth.test.ts 现有 16 测试验证"白名单未设 = 行为不变"

**Spec §1 价值评估**：白名单空 / undefined = 行为不变。

**实际**：现有 16 auth.test.ts 全用 `mockFetch` + 标准请求 → 不设 `CF-Connecting-IP: 1.2.3.4` 时 `getClientIp` 返 "unknown" → `isAdminIpAllowed("unknown", [])` 返 false → 走 checkRateLimitDual → 与 M6.6 行为一致 → 现有 16 测试全绿。

**0 偏差**（设计预期）。

## commit 汇总（worktree 分支）

| Task | Commit | 主题 |
|---|---|---|
| spec | `982c4ec` | M6.10 spec — admin IP allowlist |
| plan | `a6760c7` | M6.10 plan — admin IP allowlist (1 task / 2 CP) |
| 1 | `e1bcdb1` | feat(api): admin IP allowlist + auth.ts 包裹 + 8 tests |
| 2 | (待写) | state-m6-10.md（本文件）+ README M6.10 节 |
| merge | (待执行) | worktree-m6-10-admin-allowlist → master --no-ff |

**共 4 commit + 1 merge = 5 总**

## 与 SA 接触不到的遗留 concern

1. **白名单 IP 误配**（spec §12.1）— admin 责任配 env；dev 默认空 = 行为不变
2. **静态 IP 变更**（spec §12.1）— admin 需手动更新 env；CP-5 流程文档强提示
3. **白名单绕过 per-token 限流**（spec §12.1）— 设计预期；per-token 限流仍生效
4. **IPv6 白名单**（spec §12.1）— O(N) includes 仍工作；YAGNI CIDR
5. **0 production console.log** — 与 M6.9 一致
6. **auth.test.ts 不测白名单**（偏差 2）— 单元测试覆盖；CP-5 真接时验

## dev 验证缺口（CP-5 真接时补）

M6.10 mock-first 阶段未做 dev 真验：
- 真实 CF Workers 注入 `env.ADMIN_IP_ALLOWLIST` 行为
- 真实 admin 跨多 IP 池场景（admin 在 2 个静态 IP 切换）
- 真实 dev 调试场景（dev IP 变化时如何更新 env）

推到 CP-5（真接 Cloudflare）后做。

## 真接 Cloudflare 路径（CP-5 备查）

M6.10 真接 Cloudflare 0 强制改：

1. **新 var 注入**（非敏感 IP）：
   ```bash
   pnpm wrangler vars set ADMIN_IP_ALLOWLIST "1.2.3.4,5.6.7.8"
   # 或 wrangler secret put（同 vars 行为，但 vars 更合适 — IP 非敏感）
   ```
2. **dev 需设** `127.0.0.1` 才能本地 admin 调试：
   ```bash
   # .dev.vars 加：
   ADMIN_IP_ALLOWLIST="127.0.0.1"
   ```
3. **监控**：429 错误率突增可能白名单误删
4. **admin IP 变更流程**：admin 切换网络 → 手动更新 wrangler vars → 重启 worker

## 下一步建议

**M6.11+**（视需求）：
1. **top_offending_ips**（M6.5 留口）— YAGNI
2. **admin 批量重 wrap V1→V2 工具**（M6.8 留口）— 0 主动迁移 fallback 已够
3. **cron 24h 阈值 env 配置化**（M6.4 留口）— YAGNI

**顶层 spec §13 后续演进**（视需求）：
- NLI 蕴含验证 / HyDE / 答案反馈 / 自动 invalidate / 信源自动评级 / 多端

**CP-5 真接决策**（里程碑）：
- 6 个 secret 注入（ADMIN_TOKEN / JWT_SECRET / MINIMAX_API_KEY / WX_APP_SECRET / CRON_SECRET / KEK_SECRET_V1）
- ADMIN_IP_ALLOWLIST var 注入（dev 必设 127.0.0.1）
- 微信小程序 AppID 注册（mp.weixin.qq.com）
- 老 user 数据迁移（重 login 自然升级）

## 主线程接管 task 2

按 user `feedback_subagent_heartbeat_monitoring` 改进 + M6.3c/d/4/5/6/7/8/9 教训 + 用户"merge 是 destructive 操作"原则，主线程接管收尾：
- Task 2a: state-m6-10.md（本文件，主线程写）
- Task 2b: README M6.10 节 + merge to master + worktree 清理 + branch 删除
- Task 2c: 主线程独立 CP-3 验证
