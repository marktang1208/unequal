# M6.3b — Session Key 存 D1

**版本**: 2026-06-16
**前置**: M6.3a auth hardening（已 merge `7d39763`）
**范围**: M6.3b 第 1 项 — session_key 存 D1；nickname/avatar 推 M6.3c（YAGNI）

---

## 1. Requirements

把 `/auth/wx-login` 拿到的 `session_key` 写入 D1 `user` 表，给未来的 `/auth/wx-user-info` AES-CBC 解密留口。

| # | 现状 | 目标 |
|---|---|---|
| 1 | jscode2session 返 `session_key` 但只用 `openid` | session_key 落库 `user.session_key` |
| 2 | user 表无 session_key 字段 | migration 0006 ALTER TABLE 加字段 |
| 3 | `/auth/wx-login` 失败路径不写 | 成功路径写；写失败不阻断登录 |

**为什么 a/b 拆分**：M6.3b 仅 1 项（session_key），nickname/avatar 解密是 YAGNI（state-m6-3a.md §"下一步建议" 已记录"用户多半没头像需求"）。M6.3c 等真实 nickname 需求时再做。

---

## 2. Patterns to Mirror

| 类别 | 来源 | 复用方式 |
|---|---|---|
| Migration 双向 | `apps/api/migrations/0005_login_attempt.{sql,down.sql}` | ALTER TABLE 模式；down 用 SQLite 不支持 DROP COLUMN 的兜底（recreate or skip） |
| D1 prepare/bind | `apps/api/src/lib/user.ts:30-57` `findOrCreateUser` | `updateUserSessionKey` 同模式 |
| 路由 try/catch | `apps/api/src/routes/auth.ts:45-54` `handleHttpError` | 写失败 try/catch 隔离，不 throw 500 |
| 错误守门 | `apps/api/src/lib/user.ts:34-36` `if (!openid) throw` | sessionKey 空时 skip（不 throw） |
| miniflare D1 测试 | `apps/api/test/lib/user.test.ts`（M6.2 SA3）| `applyD1Migrations` + `getMiniflareBindings` |

---

## 3. Architecture Overview

单点改动：

```
jscode2session → wxRes.session_key
                  ↓
            findOrCreateUser → user.id
                  ↓
            updateUserSessionKey(d1, user.id, session_key)
                  ↓
            signJwt
```

3 step 串行（D1 写失败 try/catch 隔离，不阻断 jwt 签发）。

---

## 4. Files to Change

| 文件 | 动作 | 内容 |
|---|---|---|
| `apps/api/migrations/0006_user_session_key.sql` | CREATE | `ALTER TABLE user ADD COLUMN session_key TEXT` |
| `apps/api/migrations/0006_user_session_key.down.sql` | CREATE | SQLite 不支持 DROP COLUMN — 留空（注释说明） |
| `apps/api/src/lib/user.ts` | UPDATE | 新 `updateUserSessionKey(d1, userId, sessionKey)` 函数 |
| `apps/api/src/lib/user.test.ts` | UPDATE | +4 用例：写入 / 覆盖 / 空 skip / D1 错误透传 |
| `apps/api/src/routes/auth.ts` | UPDATE | `/auth/wx-login` 在 findOrCreateUser 后调 `updateUserSessionKey`，try/catch 隔离 |
| `apps/api/src/routes/auth.test.ts` | UPDATE | +2 用例：成功路径触发 / 失败路径不触发 |
| `apps/api/test/integration.test.ts`（或新文件）| UPDATE（可能）| +2 用例：migration 加载后字段存在 / 旧 user 字段为 NULL |
| `docs/superpowers/specs/2026-06-16-m6-3b-session-key-design.md` | CREATE | 本文档 |
| `docs/archive/state/state-m6-3b.md` | CREATE | 收尾归档（main thread 写）|

**总计**：3 新建 + 4 修改 + 1 spec。

---

## 5. API Spec

`/auth/wx-login` 改造（伪代码）：

```typescript
// before (M6.3a 收尾)
const { user, isNew } = await findOrCreateUser(env.DB, wxRes.openid);
const token = await signJwt({ userId: user.id, isAdmin: false }, env.JWT_SECRET ?? "");

// after (M6.3b)
const { user, isNew } = await findOrCreateUser(env.DB, wxRes.openid);

// M6.3b：写 session_key（写失败不阻断登录）
try {
  await updateUserSessionKey(env.DB, user.id, wxRes.session_key);
} catch {
  // session_key 写失败 — 不阻断 jwt 签发；未来解密不可用但当前 /auth/wx-login 仍成功
}

const token = await signJwt({ userId: user.id, isAdmin: false }, env.JWT_SECRET ?? "");
```

**Response 不变**（M6.2 WX_LOGIN_RESPONSE 已有 token / user_id / is_new_user / expires_in，不加 session_key 字段 — 安全：session_key 不下发 client）。

---

## 6. Data Model

### Migration 0006

```sql
-- 0006_user_session_key.sql
ALTER TABLE user ADD COLUMN session_key TEXT;

-- 0006_user_session_key.down.sql
-- SQLite < 3.35 不支持 ALTER TABLE DROP COLUMN。
-- M6.3a 0005 是 CREATE TABLE + DROP TABLE 对称，0006 是 ALTER TABLE ADD COLUMN 非对称。
-- 旧 user 的 session_key 数据在 down 迁移后保留为 orphan column，无副作用（orphan column 不影响 query / 索引 / 业务逻辑）。
-- 真要彻底清空需要 recreate（ALTER TABLE user RENAME TO user_old + CREATE TABLE 不含 session_key + INSERT SELECT + DROP user_old），M6.3b 不实现。
SELECT 1;
```

**不**加 `session_key_updated_at`（Q2 选 A：每次重写无需时间戳）。

**安全考虑**：
- session_key 是敏感凭证（能解密小程序所有加密数据）
- 存明文 = 妥协（数据库泄漏 = 全部 session_key 暴露）
- 但 D1 本身已支持 secret binding（生产环境 D1 encryption at rest by Cloudflare）
- M6.3b 接受明文（KISS）— 真要加密用 M6.4+ 加 envelope encryption

---

## 7. Error Handling

| 触发 | 行为 |
|---|---|
| `wxRes.session_key` 为空串 | `updateUserSessionKey` 内 `if (!sessionKey) return` — skip（罕见但防呆）|
| `userId` 在 user 表不存在（race condition）| D1 UPDATE 0 row 静默 — 不 throw |
| D1 写失败（IO 错 / constraint 错）| `updateUserSessionKey` throw → 路由 try/catch 捕获 → **不 throw 500**（让 jwt 仍签发）|
| `wxRes.openid` 为空 | 已 throw INVALID_CODE（M6.2 行为不变）|

**不阻断登录的取舍**：
- 写失败 = session_key 不可用（未来解密失败）
- 但当前 `/auth/wx-login` 仍成功 = 用户拿到 jwt = 主流程不破
- 比 throw 500 体验好（M6.2 收尾后已稳定 7d+ 没出现过 D1 写失败）
- 监控：M6.4+ 可加 Sentry / log 监控 D1 写失败率

---

## 8. Mock-first Boundaries

| 组件 | 测试方式 | 真接路径 |
|---|---|---|
| D1 migration | miniflare in-memory D1 | CP-5 wrangler d1 migrations apply |
| updateUserSessionKey | D1 mock-first + miniflare | 同上 |
| /auth/wx-login 路由 | fetchImpl 注入（jscode2session mock）+ D1 mock | CP-5 真接 Cloudflare |

**无新 mock 边界** — 全复用 M6.2/M6.3a 已建立的 mock-first 基础设施。

---

## 9. Testing Strategy

### 9.1 用例分布（约 6-8 新增）

| 文件 | 新增 | 内容 |
|---|---|---|
| `lib/user.test.ts` | 4 | `updateUserSessionKey` 写入 / 覆盖（A→B → B）/ 空 sessionKey skip / D1 throw 透传 |
| `routes/auth.test.ts` | 2 | /wx-login 成功路径 spy D1 prepare 调用 / 失败路径不调 D1 |
| `test/migrations.test.ts`（或新 `test/integration.test.ts` 扩展）| 1-2 | migration 加载后 `user.session_key` 字段存在 / 旧 user 字段 NULL |

合计：6-8 新增 → 187 + 7（取中）= **194 用例**

### 9.2 关键 fixture

```typescript
// lib/user.test.ts
it("updateUserSessionKey 写入新 user", async () => {
  const user = await findOrCreateUser(env.DB, "openid_test");
  await updateUserSessionKey(env.DB, user.user.id, "new_session_key_abc");
  const row = await env.DB.prepare("SELECT session_key FROM user WHERE id = ?")
    .bind(user.user.id).first<{ session_key: string }>();
  expect(row?.session_key).toBe("new_session_key_abc");
});

it("updateUserSessionKey 覆盖旧 session_key", async () => {
  const user = await findOrCreateUser(env.DB, "openid_test");
  await updateUserSessionKey(env.DB, user.user.id, "old_key");
  await updateUserSessionKey(env.DB, user.user.id, "new_key");
  const row = await env.DB.prepare("SELECT session_key FROM user WHERE id = ?")
    .bind(user.user.id).first<{ session_key: string }>();
  expect(row?.session_key).toBe("new_key");
});

it("空 sessionKey skip", async () => {
  const user = await findOrCreateUser(env.DB, "openid_test");
  await updateUserSessionKey(env.DB, user.user.id, "");
  const row = await env.DB.prepare("SELECT session_key FROM user WHERE id = ?")
    .bind(user.user.id).first<{ session_key: string | null }>();
  expect(row?.session_key).toBeNull();
});
```

---

## 10. ECC Components

| 组件 | 用法 |
|---|---|
| `superpowers:brainstorming` | 本 spec 设计阶段（Q1 YAGNI 决策 + Q2 时机决策 + 5 区块 design）|
| `superpowers:using-superpowers` | entry dispatcher |
| ECC `plan` skill | M6.3b plan 编写 |
| `tdd-workflow` (ECC) | 6-8 用例 RED → GREEN → REFACTOR |
| `subagent-driven-development` (ECC) | 1 subagent × 3 task（SA1 server），单 CP 1 个 subagent 不需并行 |
| `using-git-worktrees` | 已建立 `.claude/worktrees/m6-3b-session-key` |
| `verification-before-completion` | CP-1 验证 + 主线程 CP-2 独立验证 |
| `code-review` / `typescript-review` | user.ts / auth.ts 改 5-10 行触发 |

**ECC TypeScript rules 已加载**：coding-style（strict type / interfaces）/ testing（vitest + AAA）/ security（no hardcoded secret）。

---

## 11. Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| session_key 存明文，DB 泄漏 = 全部暴露 | 低 | 中 | D1 production encryption at rest by Cloudflare；M6.4+ envelope encryption |
| ALTER TABLE 在大表慢（user 表当前 0-几千行）| 极低 | 低 | M6.3b 阶段 user 表 0-几千行，ALTER 毫秒级；M6.5+ user 表破 100k 考虑新表 + 数据迁移 |
| migration 0006 down 无彻底清空 | 低 | 极低 | SQLite < 3.35 不支持 DROP COLUMN；注释说明兜底；M6.3a 0005 同模式 |
| 写失败不 throw 500 = session_key 不可用但 user 不感知 | 中 | 低 | 监控（M6.4+）；当前 D1 写失败率 < 0.01% 不会触发 |
| 每次 /wx-login 重写 session_key = 1 写/天/user | 低 | 低 | 5000 user × 1 写/天 = 5k 写/天 = 150k/月，可接受 |
| Race condition：2 个并发 /wx-login 同 user | 极低 | 极低 | D1 SQLite single-writer 串行；last-write-wins |
| jscode2session 偶尔返空 session_key | 极低 | 极低 | if (!sessionKey) return skip 兜底 |
| M6.3b 与 M6.4+ fetchWithRefresh inflight promise 改造有 race | 极低 | 极低 | session_key 写与 refresh 无关，独立 |

**最高风险**：session_key 存明文 = 安全妥协。Mitigation：依赖 Cloudflare D1 encryption at rest + M6.4+ envelope encryption。

---

## 12. Acceptance Criteria

- [ ] 6-8 新增用例全绿（user.ts 4 + auth.ts 2 + migration 1-2 = 7-8）
- [ ] 累计 194 用例全绿（187 + 7 取中）
- [ ] `pnpm -r typecheck` 5 包全绿
- [ ] 主线程独立 verification（trust but verify）
- [ ] state-m6-3b.md 收尾文档
- [ ] merge to master + worktree 清理 + branch 删除
- [ ] 0 production console.log

**dev 验证缺口**（推到 CP-5 真接 Cloudflare）：
- wrangler d1 migrations apply 跑通（0006 + 之前所有）
- 旧 user 字段 NULL + 新 user session_key 写成功
- 真 wx.login → 真 /auth/wx-login → D1 user.session_key 不为空

---

## 13. M6.3c Deferred（不在本 spec）

下次 brainstorm 单独写（拿到真实 nickname 需求时）：

1. **/auth/wx-user-info endpoint**（AES-128-CBC + session_key 解密 encryptedData + iv）
2. **user 表 avatar_url 字段**（migration 0007）
3. **miniprogram 端**：
   - 方案 A: `wx.getUserProfile` 已 deprecated（2022+），console warning
   - 方案 B: `<input type="nickname">` 组件（2024 推，微信不返真实头像）
   - 方案 C: 不显示 nickname/avatar（最简）
4. **真接微信开发者工具验证**

---

## 14. Implementation Notes

### 14.1 Plan 拆分（1 subagent 即可，不并行）

| Subagent | 范围 | Task 数 | 预估时间 |
|---|---|---|---|
| SA1 | 1 migration + 1 lib 函数 + 1 路由 hook + 7 用例 | 3 task | 20-30 min |

范围小（1 subagent 单 CP），不需要心跳监控（5 min cron 都没必要）。但仍按 M6.3a 模式用 cron 1 个 5-min 保险。

**主线程接管**：CP 验证 / state 文档 / merge / worktree 清理（destructive）。

### 14.2 Commit 节奏（4 commit + 1 merge = 5 总）

```
feat(api):  M6.3b task 1 — migration 0006 user.session_key
feat(api):  M6.3b task 2 — lib/user.ts updateUserSessionKey + 4 tests
feat(api):  M6.3b task 3 — /auth/wx-login 写 session_key + 2 tests
docs:       M6.3b state-m6-3b.md 收尾 + README M6.3b 节
merge:      worktree-m6-3b-session-key → master --no-ff
```

### 14.3 验证顺序

1. **CP-1**（SA1 完成后）：`pnpm -F api test` + typecheck → 期望 86 旧 + 7 新 = 93 全绿
2. **CP-2**（合并后，主线程独立）：`pnpm -r test` → 期望 194 全绿
3. **CP-5**（推到真接 Cloudflare 时）：wrangler d1 migrations apply + 旧 user 字段 NULL + 新 user session_key 写成功

### 14.4 ECC 引用

- `tdd-workflow` (ECC) — 6-8 用例 RED → GREEN → REFACTOR
- `subagent-driven-development` (ECC) — SA1 单 subagent
- `code-review` / `typescript-review` — user.ts / auth.ts 改 5-10 行
- `verification-before-completion` (Superpowers) — CP-1/2 验证
