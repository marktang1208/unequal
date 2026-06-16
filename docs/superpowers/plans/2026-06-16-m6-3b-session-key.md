# Plan: M6.3b — Session Key 存 D1

- **Spec**：`docs/superpowers/specs/2026-06-16-m6-3b-session-key-design.md`（commit `454a8f8`）
- **日期**：2026-06-16
- **复杂度**：Small（1 包单点改动 + 1 subagent × 3 task）
- **Mock-first 边界**：D1 全 mock-first（miniflare in-memory）/ jscode2session fetchImpl 注入（沿用 M6.2）— 无新边界

---

## 1. Requirements Restatement

把 `/auth/wx-login` 拿到的 `session_key` 写入 D1 `user` 表，给未来的 `/auth/wx-user-info` AES-CBC 解密留口。

**核心交付**：

| # | 文件 | 内容 |
|---|---|---|
| 1 | migration 0006 | user 表加 `session_key TEXT` 字段 |
| 2 | `lib/user.ts` | 新 `updateUserSessionKey(d1, userId, sessionKey)` 函数 |
| 3 | `routes/auth.ts` | `/auth/wx-login` 在 findOrCreateUser 后调 updateUserSessionKey，try/catch 隔离 |
| 4 | 6-8 新增用例 | user.ts 4 + auth.ts 2 + migration 1-2 = 7-8 |

**不交付**（推到 M6.3c）：nickname 解密 / avatar_url / `/auth/wx-user-info` / miniprogram 端任何改动。

**新增用例**：约 7（取中 6-8）。**累计 194**（187 + 7）。

---

## 2. Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| Migration 双向 | `apps/api/migrations/0005_login_attempt.{sql,down.sql}` | `.sql` 真实 schema + `.down.sql` 兜底（M6.3b 0006 down 用 `SELECT 1` 占位 + 注释说明 SQLite < 3.35 不支持 DROP COLUMN）|
| D1 prepare/bind | `apps/api/src/lib/user.ts:37-52` | `d1.prepare(sql).bind(...).first<Row>() / .run()` |
| 错误守门 | `apps/api/src/lib/user.ts:34-36` `if (!openid) throw` | sessionKey 空时 `return` skip（不 throw）|
| 路由 try/catch | `apps/api/src/routes/auth.ts:45-54` `handleHttpError` | 写失败 try/catch 隔离，不 throw 500 |
| miniflare D1 测试 | `apps/api/test/lib/user.test.ts`（M6.2 SA3）| `applyD1Migrations` + `getMiniflareBindings` |
| 现有 UserRow interface | `apps/api/src/lib/user.ts:4-9` | `UserRow` 暂不加 session_key 字段（write-only from server side；read 时用 raw SQL 取出）|
| 路由 import 模式 | `apps/api/src/routes/auth.ts:11-19` | 加 `import { updateUserSessionKey } from "../lib/user.js"` |
| spec/plan 位置 | `docs/superpowers/specs/2026-06-16-m6-3b-session-key-design.md` | 写 plan 到 `docs/superpowers/plans/2026-06-16-m6-3b-session-key.md`（同 pattern）|

---

## 3. Files to Change

| File | Action | Why |
|---|---|---|
| `apps/api/migrations/0006_user_session_key.sql` | CREATE | `ALTER TABLE user ADD COLUMN session_key TEXT` |
| `apps/api/migrations/0006_user_session_key.down.sql` | CREATE | `SELECT 1;` 占位 + 注释说明 SQLite < 3.35 不支持 DROP COLUMN |
| `apps/api/src/lib/user.ts` | UPDATE | 新 `updateUserSessionKey(d1, userId, sessionKey)` 函数 |
| `apps/api/src/lib/user.test.ts` | UPDATE | +4 用例（写入 / 覆盖 / 空 skip / D1 throw 透传）|
| `apps/api/src/routes/auth.ts` | UPDATE | `/auth/wx-login` 在 findOrCreateUser 后调 updateUserSessionKey + try/catch |
| `apps/api/src/routes/auth.test.ts` | UPDATE | +2 用例（成功路径 spy / 失败路径不调）|
| `apps/api/test/integration.test.ts`（可能新文件）| UPDATE/CREATE | +1-2 用例（migration 加载后字段存在 / 旧 user 字段 NULL）|
| `docs/superpowers/specs/2026-06-16-m6-3b-session-key-design.md` | （已建）| spec 已 commit `454a8f8` |
| `docs/superpowers/plans/2026-06-16-m6-3b-session-key.md` | （本文件）| plan artifact |
| `docs/superpowers/state-m6-3b.md` | CREATE | 收尾归档（main thread 写）|
| `README.md` | UPDATE | M6.3b 节（main thread 写）|

**总计**：4 新建 + 4 修改 + 1 plan + 1 spec（已存在）。

---

## 4. Tasks (5 task / 2 checkpoint)

### Phase 1 — Server session_key 落库（SA1, CP-1）

**Task 1: migration 0006 user.session_key 字段**
- Action: 写 `apps/api/migrations/0006_user_session_key.sql`：`ALTER TABLE user ADD COLUMN session_key TEXT;`
- Mirror: `apps/api/migrations/0005_login_attempt.sql` 风格
- 写 `apps/api/migrations/0006_user_session_key.down.sql`：`SELECT 1;` + 注释（SQLite < 3.35 不支持 DROP COLUMN）
- 写 `apps/api/test/integration.test.ts` +1 用例：applyD1Migrations 含 0006 后 `PRAGMA table_info(user)` 含 `session_key` 字段
- Validate: `pnpm -F api test test/integration.test.ts` 1 用例绿

**Task 2: lib/user.ts updateUserSessionKey + 4 用例**
- Action: 在 `apps/api/src/lib/user.ts` 新增函数：
  ```typescript
  export async function updateUserSessionKey(
    d1: D1Database,
    userId: string,
    sessionKey: string,
  ): Promise<void> {
    if (!sessionKey) return;
    await d1
      .prepare(`UPDATE user SET session_key = ? WHERE id = ?`)
      .bind(sessionKey, userId)
      .run();
  }
  ```
- 写 `apps/api/src/lib/user.test.ts` +4 用例：
  1. 写入新 user — `SELECT session_key FROM user WHERE id = ?` 返写入值
  2. 覆盖旧 session_key — 先写 A 再写 B → 终值 B
  3. 空 sessionKey skip — `updateUserSessionKey(d1, userId, "")` 不写（user.session_key 仍为 NULL）
  4. D1 throw 透传 — mock D1 UPDATE 抛错 → 函数 throw
- Validate: `pnpm -F api test test/lib/user.test.ts` 4 旧（M6.2/6.3a 加起来）+ 4 新 = 8 全绿

**Task 3: /auth/wx-login 写 session_key + 2 用例**
- Action: 改 `apps/api/src/routes/auth.ts`：
  - 加 import `updateUserSessionKey`
  - 在 `findOrCreateUser` 之后、`signJwt` 之前插入：
    ```typescript
    try {
      await updateUserSessionKey(env.DB, user.id, wxRes.session_key);
    } catch {
      // 写失败不阻断登录
    }
    ```
- 写 `apps/api/src/routes/auth.test.ts` +2 用例：
  1. /wx-login 成功路径 → spy `env.DB.prepare` 检查 `UPDATE user SET session_key` 被调用 1 次
  2. /wx-login 失败路径（jscode2session 抛 INVALID_CODE）→ spy 验证不调 D1 UPDATE
- Validate: `pnpm -F api test test/routes/auth.test.ts` 8 旧 + 2 新 = 10 全绿

**CP-1 验证（SA1 完成后）**：
```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m6-3b-session-key
pnpm -F api typecheck
pnpm -F api test
```
期望：86 旧 + 7 新（migration 1 + user 4 + auth 2）= 93 全绿

---

### Phase 2 — 主线程收尾（CP-2）

**Task 4: state-m6-3b.md 收尾文档**
- Action: 写 `docs/superpowers/state-m6-3b.md` 仿 `state-m6-3a.md` 模板（11 sections：commit 汇总 / 测试矩阵 / 与 spec 偏差 / 实施 concern / dev 验证缺口 / CP-5 真接路径 / 下一步建议 / 主线程接管）
- Mirror: `docs/superpowers/state-m6-3a.md` 模板
- Validate: 文件存在 + 11 sections 完整

**Task 5: README M6.3b 节 + merge to master + worktree 清理 + 独立 CP-2 验证**
- Action: 改 `README.md` 加 M6.3b 节（session_key 描述 + 1 行 "nickname/avatar 推 M6.3c" + 194 测试）；merge `worktree-m6-3b-session-key` → master with `--no-ff`；`worktree remove --force` + `branch -d`；主仓库跑 `pnpm -r test` + `pnpm -r typecheck` 独立验证
- Validate: master HEAD 含 merge commit + worktree list 只剩主仓库 + 194 用例全绿 + 5 包 typecheck 全绿

---

## 5. Validation

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m6-3b-session-key

# CP-1（SA1 完成后）
pnpm -F api typecheck
pnpm -F api test
# 期望 86 旧 + 7 新 = 93 全绿

# CP-2（合并后，主仓库跑）
cd /Users/Mark/cc_project/unequal
pnpm -r typecheck
pnpm -r test
# 期望 194 用例全绿
```

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| session_key 存明文，DB 泄漏 = 全部暴露 | 低 | D1 production encryption at rest by Cloudflare；M6.4+ envelope encryption |
| ALTER TABLE 在大表慢（user 表当前 0-几千行）| 极低 | M6.3b 阶段 user 表 0-几千行，ALTER 毫秒级；M6.5+ user 表破 100k 考虑新表 + 数据迁移 |
| migration 0006 down 留空（SQLite < 3.35 不支持 DROP COLUMN）| 低 | 注释说明 orphan column 无副作用；M6.3a 0005 同模式 |
| 写失败不 throw 500 = session_key 不可用但 user 不感知 | 中 | 监控（M6.4+）；当前 D1 写失败率 < 0.01% 不会触发 |
| 每次 /wx-login 重写 session_key = 1 写/天/user | 低 | 5000 user × 1 写/天 = 5k 写/天 = 150k/月，可接受 |
| Race condition：2 个并发 /wx-login 同 user | 极低 | D1 SQLite single-writer 串行；last-write-wins |
| jscode2session 偶尔返空 session_key | 极低 | `if (!sessionKey) return` skip 兜底 |
| SA1 派发时主线程 race（与 4 SA 模式相同）| 低 | 范围小（1 subagent 3 task），M6.3a 4 SA 已验证 subagent 模式稳定；不强制 heartbeat（任务 5-7 min 完成）|

**最高风险**：session_key 存明文 = 安全妥协。Mitigation：依赖 Cloudflare D1 encryption at rest + M6.4+ envelope encryption。

---

## 7. Acceptance

- [ ] 7 新增用例全绿（user.ts 4 + auth.ts 2 + migration 1 + 1 buffer 视实际调整）
- [ ] 累计 194 测试全绿
- [ ] 5 包 typecheck 全绿
- [ ] 主线程独立 CP-2 验证（trust but verify）
- [ ] state-m6-3b.md 11 sections 完整
- [ ] README M6.3b 节就位
- [ ] merge to master + worktree 清理 + branch 删除
- [ ] 0 production console.log

**dev 验证缺口**（推到 CP-5 真接 Cloudflare）：
- wrangler d1 migrations apply 跑通（含 0006 + 之前所有）
- 旧 user 字段 NULL + 新 user session_key 写成功
- 真 wx.login → 真 /auth/wx-login → D1 user.session_key 不为空

---

## 8. Implementation Notes

### 8.1 Subagent 分配（1 subagent）

| Subagent | 范围 | Task 数 | 预估时间 |
|---|---|---|---|
| SA1 server | Task 1-3（migration + lib + route）| 3 task | 20-30 min |

**不并行**（范围小，单 subagent 即可）。

**主线程接管**（destructive / 收尾）：
- Task 4-5：state 文档 / README / merge / worktree 清理 / branch 删除 / 独立 CP-2 验证

### 8.2 Commit 节奏（4 commit + 1 merge = 5 总）

```
feat(api):  M6.3b task 1 — migration 0006 user.session_key + 1 test
feat(api):  M6.3b task 2 — lib/user.ts updateUserSessionKey + 4 tests
feat(api):  M6.3b task 3 — /auth/wx-login 写 session_key + 2 tests
docs:       M6.3b state-m6-3b.md 收尾 + README M6.3b 节
merge:      worktree-m6-3b-session-key → master --no-ff
```

### 8.3 验证顺序

1. **CP-1**（SA1 完成后）：`pnpm -F api test` + typecheck → 期望 86 旧 + 7 新 = 93 全绿
2. **CP-2**（合并后，主线程独立）：`pnpm -r test` → 期望 194 全绿
3. **CP-5**（推到真接 Cloudflare 时）：wrangler d1 migrations apply + 旧 user 字段 NULL + 新 user session_key 写成功

### 8.4 ECC 引用

- `tdd-workflow` (ECC) — 7 用例 RED → GREEN → REFACTOR
- `subagent-driven-development` (ECC) — SA1 单 subagent
- `code-review` / `typescript-review` — user.ts / auth.ts 改 5-10 行
- `verification-before-completion` (Superpowers) — CP-1/2 验证
