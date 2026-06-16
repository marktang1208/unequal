# Plan: M6.7 — Session Key Envelope Encryption

- **Spec**：`docs/superpowers/specs/2026-06-16-m6-7-session-key-envelope-design.md`（commit `c19d566`）
- **日期**：2026-06-16
- **复杂度**：Small-Medium（1 lib + 1 migration + 3 改 + 13 新增用例 + 主线程直接做）
- **Mock-first 边界**：Web Crypto + fake D1 — 3 项 CP-5 真接项已标注

---

## 1. Requirements Restatement

把 M6.3b 留口的 session_key 明文存收口：envelope encryption（DEK 加密 + KEK 加密 DEK）。KEK 来自 `env.KEK_SECRET`（wrangler secret put），从不落库；D1 只存 ciphertext + wrapped_dek。

**核心交付**：

| # | 包 | 文件 | 内容 |
|---|---|---|---|
| 1 | apps/api | `src/lib/envelope.ts` | 新 `encryptEnvelope(plaintext, env)` + `decryptEnvelope(ct_b64, dek_b64, env)` + 内部 `deriveKek` + base64 helper |
| 2 | apps/api | `migrations/0009_user_session_key_envelope.sql` | ALTER TABLE user ADD session_key_ct + session_key_dek |
| 3 | apps/api | `migrations/0009_user_session_key_envelope.down.sql` | 留空（SQLite < 3.35 不支持 DROP COLUMN）|
| 4 | apps/api | `src/lib/user.ts` | 改 `updateUserSessionKey` 签名加 env 必填参数；新 `readUserSessionKey` 函数（透明 fallback 老明文）|
| 5 | apps/api | `src/routes/auth.ts` | `updateUserSessionKey` 调用加 env 参数（1 行）|
| 6 | apps/api | `src/types.ts` | Env interface 加 `KEK_SECRET?: string` 字段 |
| 7 | apps/api | `test/lib/envelope.test.ts` | 新 8 用例（encrypt happy / decrypt happy / 往返 / KEK 缺失 / 不同 plaintext / tamper / 错误 KEK / base64 round-trip）|
| 8 | apps/api | `test/lib/user.test.ts` | 4 旧测试改 updateUserSessionKey 4 参数 + 5 新测试（写密文 / 空字符串 / 新密文读 / 老明文 fallback / decrypt 失败）|

**不交付**（推到 M6.7+ / YAGNI）：
- KEK version + 多 KEK 兜底（M6.8 候选；KEK 备份到密码管理器够用）
- Active batch migration（lazy 设计 0 主动迁移；老 user 重 login 自然变密文）
- D1 token-level mutex（窄场景，价值低）
- top_offending_ips（YAGNI）
- scrypt/argon2 KEK 派生（KEK 不存表 brute-force 无意义）

**新增用例**：13（envelope 8 + user 5 = 13）。**累计 264**（251 + 13）。

---

## 2. Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| Web Crypto helper | `apps/api/src/lib/rate-limit.ts:66-73` `sha256Identifier` | envelope.ts 用 `crypto.subtle.encrypt/decrypt` AES-GCM + `crypto.getRandomValues` 生成 nonce/DEK；与 M6.6 同一栈 |
| secrets 管理 | `apps/api/src/lib/auth-jwt.ts:14-30` `env.JWT_SECRET` | envelope.ts 读 `env.KEK_SECRET`；与 JWT_SECRET / WX_APP_SECRET / CRON_SECRET 同模式（wrangler secret put）|
| 写失败不阻断 | `apps/api/src/routes/auth.ts:131-135` `updateUserSessionKey` try/catch | M6.7 同样 try/catch（KEK 缺失 / D1 错误不阻断 jwt 签发）|
| 迁移透明 | `M6.6 fake DB COUNT/MIN SQL 按 client_ip vs identifier 关键字解析` | `readUserSessionKey` 按 `session_key_ct IS NULL` fallback 旧明文 |
| fakeDB 模式 | `apps/api/test/lib/rate-limit.test.ts:15-41` makeFakeDB | envelope 单元测试纯函数（不依赖 D1），user 单元测试 fakeDB 模式 |
| 错误处理 | `apps/api/src/routes/auth.ts:54-63` `handleHttpError` | envelope 抛 `Error("KEK_SECRET not configured")` 透传 → 500（如有调用方）|
| migration 模式 | `migrations/0006_user_session_key.sql` | `0009_user_session_key_envelope.sql` 镜像：ALTER TABLE ADD 2 列 |

---

## 3. Files to Change

### 新建（4 个）

| 文件 | 内容 | 预估行数 |
|---|---|---|
| `apps/api/migrations/0009_user_session_key_envelope.sql` | ALTER TABLE ADD session_key_ct + session_key_dek | 6 |
| `apps/api/migrations/0009_user_session_key_envelope.down.sql` | 留空（SQLite < 3.35 不支持 DROP COLUMN）| 3 |
| `apps/api/src/lib/envelope.ts` | encryptEnvelope + decryptEnvelope + 内部 deriveKek + importKey + concatBytes + base64 helper | ~80 |
| `apps/api/test/lib/envelope.test.ts` | 8 新测试 | ~120 |

### 修改（4 个）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `apps/api/src/lib/user.ts` | updateUserSessionKey 签名加 env 必填 + 改写密文路径；新 readUserSessionKey | +60 / -10 |
| `apps/api/src/routes/auth.ts` | updateUserSessionKey 调用加 env | +1 / -1 |
| `apps/api/src/types.ts` | Env interface 加 `KEK_SECRET?: string` 字段 | +1 / -0 |
| `apps/api/test/lib/user.test.ts` | 4 旧测试改 updateUserSessionKey 4 参数 + 5 新测试 | +50 / -8 |

### 不改（沿用 M6.6）

- ✅ `apps/api/wrangler.jsonc` — KEK_SECRET 是 secret 不写 vars
- ✅ `apps/api/src/lib/auth-jwt.ts` — 0 改动
- ✅ `apps/api/src/lib/rate-limit.ts` — 0 改动
- ✅ `apps/api/src/routes/cron.ts` / `stats.ts` — 0 改动
- ✅ 其他包（admin / miniprogram / crawler / shared）— 0 改动

---

## 4. Tasks (3 task / 2 checkpoint)

### Phase 1 — 主线程直接实施（2 task / CP-1 + CP-2）

按 M6.3c/d/4/5/6 教训应用，本 plan **不派 subagent**，主线程直接做（1 包 + 30-60 min 估时）。

**Task 1: envelope.ts lib + 8 tests**

- Action 1.1: 写 8 个 envelope 测试（RED）：
  
  ```typescript
  describe("envelope.encryptEnvelope / decryptEnvelope (M6.7)", () => {
    it("encrypt happy: 返 ciphertext + wrappedDek 都非空 base64", async () => { /* ... */ });
    it("decrypt happy: ciphertext + wrappedDek → 还原 plaintext", async () => { /* ... */ });
    it("往返: encrypt → decrypt 还原任意 plaintext（空 / 普通 / emoji / 中文 / 长串）", async () => { /* ... */ });
    it("KEK 缺失: env.KEK_SECRET=undefined → throw 'KEK_SECRET not configured'", async () => { /* ... */ });
    it("KEK 缺失（空字符串）: env.KEK_SECRET='' → throw", async () => { /* ... */ });
    it("不同 plaintext 两次 encrypt → 不同 ciphertext（DEK 随机）", async () => { /* ... */ });
    it("decrypt 失败: 篡改 ciphertext 1 byte → throw 'envelope decrypt failed'", async () => { /* ... */ });
    it("decrypt 失败: 错误 KEK → throw", async () => { /* ... */ });
  });
  ```

- Action 1.2: 写 envelope.ts 实现（GREEN，spec §5 完整代码）：
  ```typescript
  export interface EnvelopeCipher {
    ciphertext: string;  // base64(nonce_12B || encrypted_data + 16B tag)
    wrappedDek: string;  // base64(nonce_12B || wrapped_DEK + 16B tag)
  }
  export async function encryptEnvelope(plaintext: string, env: { KEK_SECRET?: string }): Promise<EnvelopeCipher>;
  export async function decryptEnvelope(ct_b64: string, dek_b64: string, env: { KEK_SECRET?: string }): Promise<string>;
  // 内部 helper: deriveKek(env) → CryptoKey; importKey(raw) → CryptoKey;
  //              concatBytes(a, b) → Uint8Array; encodeBase64/decodeBase64
  ```
  - 关键：DEK 32 字节随机，nonce 12 字节（96-bit AES-GCM 推荐），KEK 派生 SHA-256 截 32 字节

- Mirror: `apps/api/src/lib/rate-limit.ts:66-73` `sha256Identifier` Web Crypto 模式；spec §5 完整代码
- Validate:
  ```bash
  pnpm -F api test test/lib/envelope.test.ts    # 8 新绿
  pnpm -F api typecheck
  ```
  期望：8 绿 + typecheck 0 错
  🛑 **CP-1**: envelope 8 绿 + typecheck 0 错

**Task 2: user.ts 改 + auth.ts 改 + types.ts 改 + migration 0009 + 5 user tests**

- Action 2.1: 写 5 个 user 测试 + 改 4 旧 user 测试（RED）：
  
  ```typescript
  // 改 4 旧测试：updateUserSessionKey 改 4 参数（加 env）
  await updateUserSessionKey(d1, userId, "session-key", { KEK_SECRET: "test-kek" });

  // 新 5 测试：
  describe("user.updateUserSessionKey (M6.7) envelope 写路径", () => {
    it("写密文: D1 收到 ciphertext/wrappedDek 写入新列，session_key=NULL", async () => { /* fakeDB 验 SQL */ });
    it("session_key 空字符串: skip（不抛）", async () => { /* ... */ });
  });

  describe("user.readUserSessionKey (M6.7) envelope 读路径", () => {
    it("新 user: 解 envelope 返 plaintext", async () => { /* ... */ });
    it("老 user: session_key_ct=NULL 时返旧明文（lazy fallback）", async () => { /* ... */ });
    it("decrypt 失败: try/catch 返 null + console.warn（不抛）", async () => { /* ... */ });
  });
  ```

- Action 2.2: 改 `apps/api/src/lib/user.ts`（spec §6 完整代码）：
  - `updateUserSessionKey(d1, userId, sessionKey, env)` 签名加 env 必填参数
  - 改 SQL：`UPDATE user SET session_key_ct = ?, session_key_dek = ?, session_key = NULL WHERE id = ?`
  - 新 `readUserSessionKey(d1, userId, env)` 函数：SELECT 3 列 + decryptEnvelope 或 fallback 明文 + try/catch

- Action 2.3: 改 `apps/api/src/routes/auth.ts`（spec §6.3）：
  - `updateUserSessionKey(env.DB, user.id, wxRes.session_key, env)` 加 env 参数

- Action 2.4: 改 `apps/api/src/types.ts`：
  - Env interface 加 `KEK_SECRET?: string` 字段

- Action 2.5: 新建 2 个 migration 文件（spec §8 SQL）：
  ```sql
  -- 0009_user_session_key_envelope.sql
  ALTER TABLE user ADD COLUMN session_key_ct TEXT;
  ALTER TABLE user ADD COLUMN session_key_dek TEXT;
  ```
  ```sql
  -- 0009_user_session_key_envelope.down.sql
  -- 留空（SQLite < 3.35 不支持 DROP COLUMN）
  ```

- Mirror: 现有 `apps/api/src/lib/user.ts:69-79` `updateUserSessionKey` 模式；现有 `auth.ts:131-135` try/catch
- Validate:
  ```bash
  pnpm -F api test test/lib/user.test.ts         # 4 旧 + 5 新 = 9 绿
  pnpm -F api test test/lib/envelope.test.ts     # 8 绿（Task 1）
  pnpm -F api test test/routes/auth.test.ts     # 13 绿（typecheck AC 兜底 + 现有 test）
  pnpm -F api test                                # 全跑（api 151 绿）
  pnpm -r typecheck                               # 5 包全绿
  pnpm -F api build                               # wrangler dry-run OK
  ```
  期望：api 151 绿 + typecheck 0 错 + build 成功
  🛑 **CP-2**: api 包全绿 + 5 包 typecheck + build

### Phase 2 — 主线程收尾（Task 3 / CP-3）

**Task 3: state-m6-7.md 收尾 + README M6.7 节**

- Action 3.1: 写 `docs/superpowers/state-m6-7.md`（参考 `state-m6-6.md` 10 sections）：
  1. mock-first 边界
  2. CP-1/CP-2/CP-3 pass 记录
  3. 累计 264 测试
  4. 偏差记录（预计 2-3 偏差：spec §14.1 commit 节奏 / 派生算法 hardcode / 老 user fallback 行为）
  5. 4 commit 汇总（worktree 分支）
  6. 与 SA 接触不到的遗留 concern
  7. dev 验证缺口（CP-5 真接时补）
  8. 真接 Cloudflare 路径
  9. 下一步建议
  10. 主线程接管 task 3 原因

- Action 3.2: 改 `README.md`：
  - 在 M6.6 节后加 M6.7 节（~50 行）
  - 标题：M6.7 状态
  - 内容：envelope encryption 新行为 + 4 数据流路径 + 测试矩阵 + mock-first 限制 + CP-5 真接 KEK_SECRET 注入 + KEK 备份 P0 告警

- Action 3.3: 清理 worktree + merge to master + branch 删除：
  ```bash
  cd .claude/worktrees/m6-7-envelope
  git checkout master && cd ../../
  git merge --no-ff worktree-m6-7-envelope -m "Merge branch 'worktree-m6-7-envelope': M6.7 — session-key envelope encryption"
  git worktree remove .claude/worktrees/m6-7-envelope
  git branch -D worktree-m6-7-envelope
  ```
  🛑 **CP-3**: 主仓库独立验证（用户 destructive 操作：merge --no-ff + worktree 清理）

- Validate（CP-3）:
  ```bash
  cd /Users/Mark/cc_project/unequal
  pnpm -r typecheck    # 5 包全绿
  pnpm -r test         # 264 全绿
  ```

---

## 5. Validation

```bash
# Worktree 隔离开发
cd /Users/Mark/cc_project/unequal
git worktree add .claude/worktrees/m6-7-envelope -b worktree-m6-7-envelope
cd .claude/worktrees/m6-7-envelope

# CP-1（Task 1 完成后）
pnpm -F api test test/lib/envelope.test.ts    # 8 绿
pnpm -F api typecheck                            # 0 错

# CP-2（Task 2 完成后）
pnpm -r typecheck                                # 5 包全绿
pnpm -r test                                     # 5 包全绿（api 151 + admin 24 + mini 32 + shared 38 + crawler 19 = 264）
pnpm -F api build                                # wrangler dry-run OK

# CP-3（merge 后，主仓库跑）
cd /Users/Mark/cc_project/unequal
pnpm -r typecheck
pnpm -r test
# 期望 264 全绿

# 增量测试（task 局部验证，不全跑）
pnpm -F api test test/lib/envelope.test.ts     # task 1: 8 绿
pnpm -F api test test/lib/user.test.ts          # task 2: 9 绿（4 旧 + 5 新）
```

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `recordAttempt` 签名破坏 4 旧 user 测试 | 中 | 一次性改完（Task 2 集中改），typecheck AC 兜底 |
| `auth.ts` updateUserSessionKey 4 参数改：typecheck fail | 中 | Task 2 Action 2.3 同步改 1 行；typecheck AC 兜底 |
| envelope AES-GCM 性能（真接后）| 低 | CF Workers AES-GCM < 1ms（CP-5 验）|
| KEK 派生算法 hardcode SHA-256（未来换 scrypt 需迁移）| 极低 | YAGNI；spec §D-5 决策记录 |
| Web Crypto 在 miniflare / Node 18+ 行为差异 | 极低 | 0 已知差异（miniflare v3+ / Node 18+ 全支持 AES-GCM）|
| KEK 丢失（生产 KEK_SECRET 误删/重生成）| 中（HIGH 严重度）| spec §13.1 列 HIGH；KEK 强制备份到 1Password/Bitwarden；CP-5 流程 doc 强提示；M6.8 KEK version 兜底候选 |
| 跨 1 包主线程上下文负担 | 极低 | 改动仅 apps/api，0 跨包；主线程 2 task 边界清晰 |
| Task 1-2 顺序依赖（envelope lib → user.ts 调用）| 极低 | 严格按依赖顺序：先写 envelope lib（Task 1）→ 改 user.ts 调用（Task 2）|
| 0 production console.log（除 envelope decrypt 失败 console.warn）| 极低 | decrypt 失败 console.warn 是监控必需，不计入 |

**最高风险**：KEK 丢失（HIGH 严重度，spec §13.1）。Mitigation：KEK 强制密码管理器备份 + doc 强提示 + M6.8 KEK version 兜底。

---

## 7. Acceptance

- [ ] 13 新增用例全绿（envelope 8 + user 5 = 13）
- [ ] 累计 264 用例全绿（api 151 + admin 24 + mini 32 + shared 38 + crawler 19 = 264）
- [ ] 5 包 typecheck 全绿
- [ ] wrangler build 成功
- [ ] 主线程独立 CP-3 验证（trust but verify）
- [ ] state-m6-7.md 10 sections 完整
- [ ] README M6.7 节就位
- [ ] merge to master + worktree 清理 + branch 删除
- [ ] 0 production console.log（除 decrypt 失败 console.warn — 监控必需）
- [ ] migration 0009 加 `session_key_ct` + `session_key_dek` 列
- [ ] wrangler.jsonc 0 改（KEK_SECRET 是 secret，不写 vars）
- [ ] types.ts Env 加 `KEK_SECRET?: string` 字段

**dev 验证缺口**（推到 CP-5 真接 Cloudflare）：
- 真实 CF Workers 注入 `env.KEK_SECRET` 行为
- 真实 D1 ALTER TABLE 2 列性能（mock-first 不验）
- 真实 Web Crypto AES-GCM 性能（< 1ms 预期）
- KEK 备份到 1Password / Bitwarden 流程验证
- 真实老 user（M6.3b 上线后）重 login 后 session_key 变密文行为
- decrypt 失败率监控（生产 0 预期；> 0 即 P0 alert）

---

## 8. Implementation Notes

### 8.1 Subagent 分配

**M6.3c/d/4/5/6 教训应用**：
- 1 subagent 范围 < 3 task → 主线程直接做更稳
- 1 subagent 范围 ≥ 3 task → 可派 subagent 但需小心
- 跨 2 包改动 → 优先主线程

M6.7 3 task（实施）+ 1 task（收尾）跨 **1 包**（api only），**决策主线程直接做**：
- 30-60 min 工作量，主线程上下文能 handle
- 1 包改动主线程能保持一致性
- 避免 subagent stall 风险（M6.3c 教训）

### 8.2 Commit 节奏（4 commit + 1 merge = 5 总）

```
1. feat(api): M6.7 task 1 — envelope encryption lib (encryptEnvelope + decryptEnvelope + deriveKek) + 8 tests
              [🛑 CP-1: envelope 8 绿 + typecheck 0 错]
2. feat(api): M6.7 task 2 — user.ts 改写密文 + readUserSessionKey + auth.ts 调用加 env + migration 0009 + 5 tests
              [🛑 CP-2: api 151 绿 + 5 包 typecheck + build OK]
3. docs: M6.7 state-m6-7.md 收尾 + README M6.7 节
merge: worktree-m6-7-envelope → master --no-ff
       [🛑 CP-3: 主仓库独立验证 264 绿]
```

注：Task 1 内部 2 action（1.1-1.2）合成 1 commit（8 测试 + 实现同步发布）。Task 2 5 action（2.1-2.5）合成 1 commit（user.ts 改 + auth.ts 改 + types.ts 改 + migration + 5 测试 同步发布）。Task 3 收尾独立 commit。

### 8.3 验证顺序

每 task 完成后立即跑该 task 局部测试 + typecheck：
- Task 1 → `pnpm -F api test test/lib/envelope.test.ts` + typecheck
- Task 2 → `pnpm -F api test test/lib/user.test.ts` + 全 `pnpm -F api test` + 5 包 typecheck + build
- Task 3 → 主仓库全跑（merge 后）

### 8.4 ECC 引用

- **`tdd-workflow` skill**：Task 1-2 严格 RED → GREEN → REFACTOR
  - Task 1: 8 测试先写（RED）→ 写 envelope.ts（GREEN）→ 重构（REFACTOR）
  - Task 2: 5 测试先写 + 4 旧测试改（RED）→ 改 user.ts + auth.ts + types.ts + migration（GREEN）→ 重构（REFACTOR）
- **`verification-before-completion` skill**：CP-1/CP-2/CP-3 验证前必须跑命令
- **`brainstorming` skill**：已走完（spec `c19d566`）

### 8.5 Worktree 路径

- **创建**：`git worktree add .claude/worktrees/m6-7-envelope -b worktree-m6-7-envelope`
- **开发**：`cd .claude/worktrees/m6-7-envelope`
- **清理**：`git worktree remove .claude/worktrees/m6-7-envelope` + `git branch -D worktree-m6-7-envelope`
- **merge**：主仓库 master，`git merge --no-ff worktree-m6-7-envelope -m "..."`

### 8.6 mock-first 边界明确

- ✅ envelope 单元测试纯函数（不依赖 D1，env mock）
- ✅ user 单元测试 fakeDB 模式（与 M6.6 rate-limit 一致）
- ❌ 不验 Web Crypto 内部行为（依赖浏览器/CF runtime）
- ❌ 不验 D1 base64 编码存储细节（fakeDB spy 不解析 SQL）
- ❌ 不验真实 CF `env.KEK_SECRET` 注入行为（CP-5 真接时验）
- ❌ 不验真实 D1 ALTER TABLE 2 列性能（mock-first 不验）
- ❌ 不验真实 Web Crypto AES-GCM 性能（CP-5 真接时验）

---

## 9. 累计测试 + 文件清单

### 9.1 仓库测试累计（M6.7 后）

| 包 | 现有 | M6.7 | 累计 |
|---|---|---|---|
| shared | 38 | 0 | 38 |
| api | 138 | +13 | **151** |
| miniprogram | 32 | 0 | 32 |
| admin | 24 | 0 | 24 |
| crawler | 19 | 0 | 19 |
| **累计** | **251** | **+13** | **264** |

### 9.2 文件清单（M6.7 后）

| 类型 | 文件 | 状态 |
|---|---|---|
| 新代码 | `apps/api/migrations/0009_user_session_key_envelope.sql` | NEW |
| 新代码 | `apps/api/migrations/0009_user_session_key_envelope.down.sql` | NEW |
| 新代码 | `apps/api/src/lib/envelope.ts` | NEW |
| 改代码 | `apps/api/src/lib/user.ts` | +60 / -10 |
| 改代码 | `apps/api/src/routes/auth.ts` | +1 / -1 |
| 改代码 | `apps/api/src/types.ts` | +1 / -0 |
| 改测试 | `apps/api/test/lib/user.test.ts` | +50 / -8 |
| 新测试 | `apps/api/test/lib/envelope.test.ts` | +120 / -0 |
| 新文档 | `docs/superpowers/specs/2026-06-16-m6-7-session-key-envelope-design.md` | NEW（已 commit `c19d566`）|
| 新文档 | `docs/superpowers/plans/2026-06-16-m6-7-session-key-envelope.md` | NEW（本文件）|
| 新文档 | `docs/superpowers/state-m6-7.md` | NEW（state 阶段）|
| 改文档 | `README.md` | +50 / -0 |

**共 3 文件改动（1 代码 + 1 路由 + 1 types）+ 1 新 lib + 1 新 migration + 2 新测试 + 1 改测试 + 4 文档（3 新 + 1 改）= 13 总**
