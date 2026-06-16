# Plan: M6.6 — Rate-Limit 加 IP 维度

- **Spec**：`docs/superpowers/specs/2026-06-16-m6-6-rate-limit-ip-design.md`（commit `73bea66`）
- **日期**：2026-06-16
- **复杂度**：Small（4 task × 1 包 + 14 新增用例 + 主线程直接做）
- **Mock-first 边界**：D1 全 mock-first / fake req 头部 mock — 3 项 CP-5 真接项已标注

---

## 1. Requirements Restatement

把 M6.3a 留口的 per-token 限流绕过收口：attacker 轮换 wrong-token N 次绕过限流。引入 per-IP 维度与 per-token 维度独立计数，任一维度锁即整体锁。

**核心交付**：

| # | 包 | 文件 | 内容 |
|---|---|---|---|
| 1 | apps/api | `src/lib/rate-limit.ts` | +1 helper `getClientIp` + 1 helper `sha256ClientIp` + 1 常量 `UNKNOWN_IP_HASH` + 1 函数 `checkRateLimitByIp` + 1 函数 `checkRateLimitDual` + 改 `recordAttempt` 签名加 `clientIpHash` |
| 2 | apps/api | `test/lib/rate-limit.test.ts` | 7 旧测试改 recordAttempt 调用 + 11 新测试（getClientIp 3 + sha256ClientIp 1 + ByIp 3 + Dual 4）|
| 3 | apps/api | `src/routes/auth.ts` | WX_LOGIN + ADMIN_LOGIN 改调 `checkRateLimitDual`，加 `getClientIp` + `sha256ClientIp` 调用，`recordAttempt` 加 `clientIpHash` |
| 4 | apps/api | `migrations/0008_login_attempt_client_ip.sql` | ALTER TABLE 加 `client_ip TEXT` 列 + CREATE INDEX `idx_login_attempt_client_ip` |
| 5 | apps/api | `migrations/0008_login_attempt_client_ip.down.sql` | DROP INDEX（SQLite < 3.35 不支持 DROP COLUMN，down 仅删索引）|
| 6 | apps/api | `test/routes/auth.test.ts` | 3 新测试（per-IP 锁 1 + per-token 锁 1 + 双层未锁 1）|

**不交付**（推到 M6.6+ / YAGNI）：
- session_key envelope encryption（需 key management + migration 兼容老数据，独立 1.5d，单独 spec）
- D1 token-level mutex（同 token 5 并发窗口窄，DO 已有 inflight 缓解，价值低）
- top_offending_ips（YAGNI：admin /stats dashboard 已有 by_hour + by_type）
- IPv6 /64 prefix 折叠（边缘场景，攻击者需 SLAAC/VPN 成本高）
- `X-Forwarded-For` 兜底（client 可伪造；CF 自动注入 CF-Connecting-IP 已够）
- 跨包改动（admin / miniprogram / crawler / shared 0 改动）

**新增用例**：14（rate-limit 11 + auth 3 = 14）。**累计 251**（237 + 14）。

---

## 2. Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| 哈希 helper | `apps/api/src/lib/rate-limit.ts:66-73` `sha256Identifier` | `sha256ClientIp(ip)` 镜像签名 + 同样 16 字符 hex 截断；`UNKNOWN_IP_HASH` 固定 16 字符常量化 |
| 单维度 checkRateLimit | `apps/api/src/lib/rate-limit.ts:83-115` `checkRateLimit` | `checkRateLimitByIp` 镜像签名，SQL 改 `WHERE client_ip = ?`（vs `WHERE identifier = ?`）；retry_after 计算完全相同 |
| Promise.all 并发 | `apps/api/src/routes/ask.ts` 双查询模式 | `checkRateLimitDual` 内 `Promise.all([checkRateLimit, checkRateLimitByIp])` 节省 ~5ms |
| migration ALTER + INDEX | `migrations/0007_login_attempt_created_at_index.sql` | 0008 镜像：先 ALTER TABLE 加列，再 CREATE INDEX IF NOT EXISTS 加复合索引 |
| fakeDB pattern | `apps/api/test/lib/rate-limit.test.ts:15-41` | spy prepare/bind/run/first；新 ByIp/Dual 测试沿用同一 fakeDB 模式 |
| 错误处理 | `apps/api/src/routes/auth.ts:54-63` `handleHttpError` | WX_LOGIN/ADMIN_LOGIN 已有 try/catch + handleHttpError 兜底 500，0 改动 |
| HTTP header 读取 | 标准 `Request.headers.get(name)` | `getClientIp` 用 `req.headers.get("CF-Connecting-IP")` — HTTP/2 规范 header 名小写，`headers.get` 大小写不敏感 |

---

## 3. Files to Change

### 新建（2 个）

| 文件 | 内容 | 预估行数 |
|---|---|---|
| `apps/api/migrations/0008_login_attempt_client_ip.sql` | `ALTER TABLE login_attempt ADD COLUMN client_ip TEXT;` + `CREATE INDEX idx_login_attempt_client_ip ON login_attempt(client_ip, attempt_type, created_at DESC);` | 8 |
| `apps/api/migrations/0008_login_attempt_client_ip.down.sql` | `DROP INDEX IF EXISTS idx_login_attempt_client_ip;` | 3 |

### 修改（4 个）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `apps/api/src/lib/rate-limit.ts` | +1 helper getClientIp + 1 helper sha256ClientIp + 1 常量 UNKNOWN_IP_HASH + 1 函数 checkRateLimitByIp + 1 函数 checkRateLimitDual + 改 recordAttempt 签名加 clientIpHash 必填 | +50 / -3 |
| `apps/api/src/routes/auth.ts` | WX_LOGIN 改 checkRateLimitDual + recordAttempt 加 clientIpHash；ADMIN_LOGIN 镜像 | +8 / -3 |
| `apps/api/test/lib/rate-limit.test.ts` | 7 旧测试改 recordAttempt 调用加 clientIpHash + 11 新测试 | +120 / -7 |
| `apps/api/test/routes/auth.test.ts` | 3 新测试 | +30 / -0 |

### 不改（沿用 M6.5）

- ✅ `apps/api/src/routes/cron.ts` — M6.4 cleanup SQL 仍按 `created_at` 删，0 改动
- ✅ `apps/api/src/routes/stats.ts` — M6.5 SQL 仍按 `attempt_type, created_at` 聚合，0 改动
- ✅ `apps/api/wrangler.jsonc` — 0 新 env
- ✅ `apps/api/src/index.ts` — 0 改动（无新路由挂载）
- ✅ `apps/api/src/scheduled.ts` — 0 改动（cron handler 不涉及限流）
- ✅ 其他包（admin / miniprogram / crawler / shared）— 0 改动

---

## 4. Tasks (4 task / 2 checkpoint)

### Phase 1 — 主线程直接实施（3 task / CP-1）

按 M6.3c/d/4/5 教训应用，本 spec **不派 subagent**，主线程直接做（4 task + 1 包 改动，估 30-60 min）。

**Task 1: rate-limit IP 维度（helpers + ByIp + Dual + 11 tests）**

- Action 1.1: 改 `apps/api/src/lib/rate-limit.ts`（spec §5 + §6 完整代码）：
  - 加常量 `export const UNKNOWN_IP_HASH = "unknown00000000";` （16 字符固定）
  - 加 helper `getClientIp(req: Request): string` — 读 `CF-Connecting-IP` header，缺则 `"unknown"`
  - 加 helper `sha256ClientIp(ip: string): Promise<string>` — 镜像 `sha256Identifier` 签名，`ip === "unknown"` 短路返 `UNKNOWN_IP_HASH`，否则 sha256 截 16 字符
  - 加函数 `checkRateLimitByIp(d1, clientIpHash, type, now?, config?)` — 镜像 `checkRateLimit` 签名，SQL 改 `WHERE client_ip = ?`（vs `WHERE identifier = ?`）
  - 加函数 `checkRateLimitDual(d1, identifier, clientIpHash, type, now?, config?)` — `Promise.all([checkRateLimit, checkRateLimitByIp])` 并发，任一 lock → 整体 lock，retry_after = 锁维度的 retry_after
  - **不改 `recordAttempt` 签名**（Task 2 再改）

- Action 1.2: 加 11 新测试到 `apps/api/test/lib/rate-limit.test.ts`（沿用现有 `describe("rate-limit")` 结构，加 4 个新 describe block）：
  
  **getClientIp (3 用例)**:
  1. **有 CF-Connecting-IP header** → 返该值（如 `"1.2.3.4"`）
  2. **缺 CF-Connecting-IP header** → 返 `"unknown"`
  3. **大小写不敏感** — header 名 `"cf-connecting-ip"`（小写）也能读（CF runtime 行为）
  
  **sha256ClientIp (1 用例)**:
  1. **确定性输出**：同 IP 多次调用返同结果；不同 IP 返不同结果；`"unknown"` 短路返 `UNKNOWN_IP_HASH`
  
  **checkRateLimitByIp (3 用例)**:
  1. **happy**：2 行 old + 1 行 new（clientIpHash 匹配）→ COUNT=2，not locked
  2. **锁**：5 行 failed 都在窗口内 → COUNT=5，locked + retry_after > 0
  3. **clientIpHash 不匹配 → not locked**（0 命中）
  
  **checkRateLimitDual (4 用例)**:
  1. **双层未锁**：per-token COUNT=2，per-ip COUNT=2 → not locked
  2. **per-token 锁**：per-token COUNT=5，per-ip COUNT=2 → locked，retry_after = per-token 的 retry_after
  3. **per-IP 锁**：per-token COUNT=2，per-ip COUNT=5 → locked，retry_after = per-IP 的 retry_after
  4. **双层都锁**：per-token COUNT=5，per-ip COUNT=5 → locked，retry_after = max(两维度)
  
  **fakeDB pattern**：镜像现有 spy prepare/bind/run/first 模式（`apps/api/test/lib/rate-limit.test.ts:15-41` 现有实现）

- Mirror: `apps/api/src/lib/rate-limit.ts:66-73, 83-115` 现有 `sha256Identifier` + `checkRateLimit` 模式；fakeDB 模式参考 `apps/api/test/lib/rate-limit.test.ts:15-41`
- Validate:
  ```bash
  pnpm -F api test test/lib/rate-limit.test.ts    # 7 旧 + 11 新 = 18 绿
  ```
  期望：18 绿（api 累计 124 + 11 = 135）
  🛑 **CP-1**: rate-limit 测试全绿 + typecheck 0 错

**Task 2: recordAttempt 签名扩展（加 clientIpHash 必填 + 5 旧测试改）**

- Action 2.1: 改 `apps/api/src/lib/rate-limit.ts` `recordAttempt` 函数（spec §7.1 完整代码）：
  ```typescript
  export async function recordAttempt(
    d1: D1Database,
    identifier: string,
    type: AttemptType,
    succeeded: boolean,
    clientIpHash: string,    // M6.6: 新增必填（第 6 参数）
    now: number = Date.now(),
  ): Promise<void> {
    await d1
      .prepare(
        `INSERT INTO login_attempt (id, identifier, attempt_type, succeeded, client_ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(ulid(), identifier, type, succeeded ? 1 : 0, clientIpHash, now)
      .run();
  }
  ```
  - 关键：clientIpHash 是**必填**（不设默认值），调用方必须显式传 `"unknown00000000"` 或真实 hash
  - INSERT SQL 加 `client_ip` 列（第 5 个 ?）
  - 函数注释更新：说明 clientIpHash 来源（getClientIp → sha256ClientIp）

- Action 2.2: 改 7 个旧测试的 `recordAttempt` 调用方（`apps/api/test/lib/rate-limit.test.ts`）：
  - 7 处调用加第 6 参数 `"ip1hash"`（统一测试 helper）
  - 测试断言不变（fakeDB spy 不区分第 6 参数值，只验"INSERT 被调"）
  - 0 行为变化：所有 7 旧测试仍绿

- Mirror: 现有 `recordAttempt` 签名 + INSERT SQL 模式
- Validate:
  ```bash
  pnpm -F api test test/lib/rate-limit.test.ts    # 18 绿（11 新 + 7 旧，0 行为变化）
  pnpm -F api typecheck
  ```
  期望：18 绿 + typecheck 0 错

**Task 3: auth.ts 改调 checkRateLimitDual + migration 0008 + 3 tests**

- Action 3.1: 新建 `apps/api/migrations/0008_login_attempt_client_ip.sql`（spec §8 完整 SQL）：
  ```sql
  -- M6.6: 加 client_ip 列（per-IP 限流数据源）
  ALTER TABLE login_attempt ADD COLUMN client_ip TEXT;
  CREATE INDEX IF NOT EXISTS idx_login_attempt_client_ip
    ON login_attempt(client_ip, attempt_type, created_at DESC);
  ```

- Action 3.2: 新建 `apps/api/migrations/0008_login_attempt_client_ip.down.sql`：
  ```sql
  -- SQLite < 3.35 不支持 DROP COLUMN；orphan client_ip 列无副作用
  DROP INDEX IF EXISTS idx_login_attempt_client_ip;
  ```

- Action 3.3: 改 `apps/api/src/routes/auth.ts`（spec §7.2 完整代码）：
  - import 加：`getClientIp, sha256ClientIp, checkRateLimitDual`（替换原 `checkRateLimit`）
  - **WX_LOGIN** 改 2 处：
    ```typescript
    // 加：getClientIp + sha256ClientIp（在 sha256Identifier 之后）
    const clientIp = getClientIp(request);
    const clientIpHash = await sha256ClientIp(clientIp);
    // 改：checkRateLimit → checkRateLimitDual
    const rateCheck = await checkRateLimitDual(
      env.DB, codeIdentifier, clientIpHash, "wx_code", Date.now(), readRateLimitConfig(env),
    );
    // 改：recordAttempt 加 clientIpHash（第 5 参数）
    await recordAttempt(env.DB, codeIdentifier, "wx_code", false, clientIpHash);
    ```
  - **ADMIN_LOGIN** 镜像 WX_LOGIN（type="admin"，adminIdentifier）
  - `handleHttpError` 不动（429 显式 return 仍走 Response.json）

- Action 3.4: 加 3 新测试到 `apps/api/test/routes/auth.test.ts`（沿用现有 `describe("POST /auth/admin-login")` + `describe("POST /auth/wx-login")` 结构）：
  
  **per-IP 锁 (1 用例)**:
  1. **admin-login per-IP 锁**：5 行同 clientIpHash 不同 identifier → 第 6 次 429 RATE_LIMITED（fake req headers mock `"CF-Connecting-IP": "1.2.3.4"`）
  
  **per-token 锁 (1 用例)**:
  2. **admin-login per-token 锁**：5 行同 identifier 不同 clientIpHash → 第 6 次 429（旧行为回归）
  
  **双层未锁 (1 用例)**:
  3. **admin-login 双层未锁**：2 行同 identifier + 2 行同 clientIpHash（部分重叠）→ 第 3 次 not locked，正常 401
  
  fake req 构造：
  ```typescript
  const req = new Request("http://localhost/auth/admin-login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "1.2.3.4",
    },
    body: JSON.stringify({ admin_token: "wrong-1" }),
  });
  ```

- Mirror: 现有 `auth.ts:88-99, 168-182` 调用模式；现有 `apps/api/test/routes/auth.test.ts` fake req 构造
- Validate:
  ```bash
  pnpm -F api test test/routes/auth.test.ts    # 18 旧 + 3 新 = 21 绿
  pnpm -F api test                             # 138 全绿（api 124 + 11 + 3 = 138）
  pnpm -F api typecheck
  pnpm -F api build                            # wrangler dry-run OK
  ```
  期望：138 绿 + typecheck 0 错 + build 成功
  🛑 **CP-2**: api 包全绿 + 5 包 typecheck + build

### Phase 2 — 主线程收尾（Task 4 / CP-3）

**Task 4: state-m6-6.md 收尾 + README M6.6 节**

- Action 4.1: 写 `docs/superpowers/state-m6-6.md`（参考 `state-m6-5.md` 11 sections）：
  1. mock-first 边界
  2. CP-1/CP-2/CP-3 pass 记录
  3. 累计 251 测试
  4. 偏差记录（spec 计划 vs 实际，预计 5-8 偏差）
  5. 5 commit 汇总（worktree 分支）
  6. 与 SA 接触不到的遗留 concern
  7. dev 验证缺口（CP-5 真接时补）
  8. 真接 Cloudflare 路径
  9. 下一步建议
  10. 主线程接管 task 4 原因

- Action 4.2: 改 `README.md`：
  - 在 M6.5 节后加 M6.6 节（~50 行）
  - 标题：M6.6 状态
  - 内容：per-IP 锁新行为 + 双层合并语义 + CF-Connecting-IP 来源 + 测试矩阵 + mock-first 限制

- Action 4.3: 清理 worktree + merge to master + branch 删除：
  ```bash
  cd .claude/worktrees/m6-6-rate-limit-ip
  git checkout master && cd ../../
  git merge --no-ff worktree-m6-6-rate-limit-ip -m "Merge branch 'worktree-m6-6-rate-limit-ip': M6.6 — rate-limit 加 IP 维度"
  git worktree remove .claude/worktrees/m6-6-rate-limit-ip
  git branch -D worktree-m6-6-rate-limit-ip
  ```
  🛑 **CP-3**: 主仓库独立验证（用户 destructive 操作：merge --no-ff + worktree 清理）

- Validate（CP-3）:
  ```bash
  cd /Users/Mark/cc_project/unequal
  pnpm -r typecheck    # 5 包全绿
  pnpm -r test         # 251 全绿
  ```

---

## 5. Validation

```bash
# Worktree 隔离开发
cd /Users/Mark/cc_project/unequal
git worktree add .claude/worktrees/m6-6-rate-limit-ip -b worktree-m6-6-rate-limit-ip
cd .claude/worktrees/m6-6-rate-limit-ip

# CP-1（Task 1 + 2 完成后）
pnpm -F api test test/lib/rate-limit.test.ts    # 18 绿（11 新 + 7 旧）
pnpm -F api typecheck                            # 0 错

# CP-2（Task 3 完成后）
pnpm -r typecheck                                # 5 包全绿
pnpm -r test                                     # 5 包全绿（api 138 + admin 24 + mini 32 + shared 38 + crawler 19 = 251）
pnpm -F api build                                # wrangler dry-run OK

# CP-3（merge 后，主仓库跑）
cd /Users/Mark/cc_project/unequal
pnpm -r typecheck
pnpm -r test
# 期望 251 全绿

# 增量测试（task 局部验证，不全跑）
pnpm -F api test test/lib/rate-limit.test.ts    # task 1+2: 18 绿
pnpm -F api test test/routes/auth.test.ts       # task 3: 21 绿
```

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `recordAttempt` 签名破坏 7 旧测试 | 中 | 一次性改完（Task 2 集中改），typecheck AC 兜底 |
| `getClientIp` 大小写敏感性 | 低 | HTTP/2 规范 header 名小写；`req.headers.get` 行为大小写不敏感（CF runtime / miniflare 一致）；新测试覆盖 |
| checkRateLimitDual 跑 2 次 SQL 性能 | 低 | D1 边缘 < 5ms/次 → 2 次 < 10ms（远低于 HTTP 30s 超时）；`Promise.all` 并发 |
| "unknown" IP bucket 合并攻击 | 低 | 仅在 CF 异常或 dev/test 用；生产 100% 注入 CF-Connecting-IP |
| admin 误锁 UX：admin 输 5 次错 token 锁本机 IP 15min | 中 | 可接受折中（等 15min / 换 IP / VPN）；admin 是低频操作 |
| migration 0008 旧行 client_ip = NULL | 低 | `checkRateLimitByIp` SQL `WHERE client_ip = ?`，NULL ≠ 任何 hash → 0 命中，安全 |
| D1 表变胖 50%（client_ip 16 字符 + 索引） | 极低 | 5x 用户量 50k 行 / 15min = 800 KB / 15min；cron 24h 清理后 < 2 MB |
| 跨 1 包主线程上下文负担 | 极低 | 改动仅 apps/api，0 跨包；主线程 4 task 边界清晰 |
| Task 1-3 顺序依赖（limit func → recordAttempt → auth route）| 低 | 严格按依赖顺序：先写新 lib 函数（Task 1）→ 改 recordAttempt 签名（Task 2）→ 改 auth route 调用（Task 3）|
| mock-first 不验 CF 真实 IP 注入 | 中 | CP-5 真接验 `CF-Connecting-IP: 1.2.3.4` header 行为；真 D1 索引命中 EXPLAIN |

**最高风险**：recordAttempt 签名破坏 7 旧测试。Mitigation：Task 2 一次性改完，typecheck AC 兜底。

---

## 7. Acceptance

- [ ] 14 新增用例全绿（rate-limit 11 + auth 3 = 14）
- [ ] 累计 251 用例全绿（api 138 + admin 24 + mini 32 + shared 38 + crawler 19 = 251）
- [ ] 5 包 typecheck 全绿
- [ ] wrangler build 成功
- [ ] 主线程独立 CP-3 验证（trust but verify）
- [ ] state-m6-6.md 10 sections 完整
- [ ] README M6.6 节就位
- [ ] merge to master + worktree 清理 + branch 删除
- [ ] 0 production console.log（无新增）
- [ ] migration 0008 加 `client_ip` 列 + `idx_login_attempt_client_ip` 复合索引
- [ ] wrangler.jsonc 0 改（沿用 M6.5）

**dev 验证缺口**（推到 CP-5 真接 Cloudflare）：
- 真实 CF 边缘注入 `CF-Connecting-IP` 行为（miniflare 不模拟）
- 真实 D1 SQL `checkRateLimitByIp` 索引命中（< 5ms 预期）
- 真实 D1 ALTER TABLE + CREATE INDEX 性能（mock-first 不验）
- 真实 per-IP 锁行为（curl 加 `-H "CF-Connecting-IP: 1.2.3.4"` 验 5 token 锁）

---

## 8. Implementation Notes

### 8.1 Subagent 分配

**M6.3c/d/4/5 教训应用**：
- 1 subagent 范围 < 3 task → 主线程直接做更稳
- 1 subagent 范围 ≥ 3 task → 可派 subagent 但需小心
- 跨 2 包改动 → 优先主线程

M6.6 4 task（实施）+ 1 task（收尾）跨 **1 包**（api only），**决策主线程直接做**：
- 30-60 min 工作量，主线程上下文能 handle
- 1 包改动主线程能保持一致性
- 避免 subagent stall 风险（M6.3c 教训）

### 8.2 Commit 节奏（4 commit + 1 merge = 5 总）

```
1. feat(api): M6.6 task 1 — rate-limit helpers (getClientIp + sha256ClientIp + checkRateLimitByIp + checkRateLimitDual) + 11 tests
              [🛑 CP-1: rate-limit 18 绿（11 新 + 7 旧）]
2. refactor(api): M6.6 task 2 — recordAttempt 签名加 clientIpHash 必填参数 + 7 旧测试改
3. feat(api): M6.6 task 3 — auth.ts 改调 checkRateLimitDual + migration 0008 + 3 tests
              [🛑 CP-2: api 138 绿 + 5 包 typecheck + build OK]
4. docs: M6.6 state-m6-6.md 收尾 + README M6.6 节
merge: worktree-m6-6-rate-limit-ip → master --no-ff
       [🛑 CP-3: 主仓库独立验证 251 绿]
```

注：Task 1 内部 4 个 action（1.1-1.2）合成 1 commit（11 测试 + helpers + ByIp + Dual 同步发布）。Task 2 改 recordAttempt 签名是独立 commit（清晰边界）。Task 3 改 auth + migration + 3 测试 合成 1 commit（auth 改造必带 migration 才能 work）。

### 8.3 验证顺序

每 task 完成后立即跑该 task 局部测试 + typecheck：
- Task 1 → `pnpm -F api test test/lib/rate-limit.test.ts` + typecheck
- Task 2 → 同上（18 绿 + 0 行为变化）
- Task 3 → `pnpm -F api test test/routes/auth.test.ts` + 全 `pnpm -F api test` + 5 包 typecheck + build
- Task 4 → 主仓库全跑（merge 后）

### 8.4 ECC 引用

- **`tdd-workflow` skill**：Task 1-3 严格 RED → GREEN → REFACTOR
  - Task 1: 11 测试先写（RED）→ 写 helpers + ByIp + Dual（GREEN）→ 重构（REFACTOR）
  - Task 2: 0 新测试，5 旧测试改 + typecheck（GREEN）
  - Task 3: 3 测试先写（RED）→ 改 auth.ts + 新 migration（GREEN）→ 重构（REFACTOR）
- **`verification-before-completion` skill**：CP-1/CP-2/CP-3 验证前必须跑命令
- **`brainstorming` skill**：已走完（spec `73bea66`）

### 8.5 Worktree 路径

- **创建**：`git worktree add .claude/worktrees/m6-6-rate-limit-ip -b worktree-m6-6-rate-limit-ip`
- **开发**：`cd .claude/worktrees/m6-6-rate-limit-ip`
- **清理**：`git worktree remove .claude/worktrees/m6-6-rate-limit-ip` + `git branch -D worktree-m6-6-rate-limit-ip`
- **merge**：主仓库 master，`git merge --no-ff worktree-m6-6-rate-limit-ip -m "..."`

### 8.6 mock-first 边界明确

- ✅ D1 SQL 用 fakeDB spy（prepar e/bind/run/first）
- ✅ CF-Connecting-IP header 在 fake req.headers mock
- ❌ 不验 miniflare 真 IP 注入（CP-5 真接时验）
- ❌ 不验 D1 SQL 索引命中（CP-5 真接时 EXPLAIN）
- ❌ 不验 D1 ALTER TABLE + CREATE INDEX 性能（mock-first 不验）
- ❌ 不验真实 per-IP 锁行为（curl + CF 真接时验）

---

## 9. 累计测试 + 文件清单

### 9.1 仓库测试累计（M6.6 后）

| 包 | 现有 | M6.6 | 累计 |
|---|---|---|---|
| shared | 38 | 0 | 38 |
| api | 124 | +14 | **138** |
| miniprogram | 32 | 0 | 32 |
| admin | 24 | 0 | 24 |
| crawler | 19 | 0 | 19 |
| **累计** | **237** | **+14** | **251** |

### 9.2 文件清单（M6.6 后）

| 类型 | 文件 | 状态 |
|---|---|---|
| 新代码 | `apps/api/migrations/0008_login_attempt_client_ip.sql` | NEW |
| 新代码 | `apps/api/migrations/0008_login_attempt_client_ip.down.sql` | NEW |
| 改代码 | `apps/api/src/lib/rate-limit.ts` | +50 / -3 |
| 改代码 | `apps/api/src/routes/auth.ts` | +8 / -3 |
| 改测试 | `apps/api/test/lib/rate-limit.test.ts` | +120 / -7 |
| 改测试 | `apps/api/test/routes/auth.test.ts` | +30 / -0 |
| 新文档 | `docs/superpowers/specs/2026-06-16-m6-6-rate-limit-ip-design.md` | NEW（已 commit `73bea66`）|
| 新文档 | `docs/superpowers/plans/2026-06-16-m6-6-rate-limit-ip.md` | NEW（本文件）|
| 新文档 | `docs/superpowers/state-m6-6.md` | NEW（state 阶段）|
| 改文档 | `README.md` | +50 / -0 |

**共 4 文件改动（2 代码 + 2 测试）+ 2 新 migration + 4 文档（3 新 + 1 改）= 10 总**
