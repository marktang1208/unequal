# Plan: M6.8 — KEK Version + Multi-KEK Fallback

- **Spec**：`docs/superpowers/specs/2026-06-16-m6-8-kek-version-design.md`（commit `0175ab8`）
- **日期**：2026-06-16
- **复杂度**：Small（1 lib 改 + 1 user.ts 改 + 1 migration + 9 新增用例 + 主线程直接做）
- **Mock-first 边界**：Web Crypto + fake D1 — 3 项 CP-5 真接项已标注

---

## 1. Requirements Restatement

把 M6.7 留口的 KEK 丢失 HIGH 严重度收口：加 KEK version 字段（表列） + 多 KEK env 变量（KEK_SECRET_V1, V2, ...）+ fallback 遍历所有 env KEK 试解。

**核心交付**：

| # | 包 | 文件 | 内容 |
|---|---|---|---|
| 1 | apps/api | `migrations/0010_user_session_key_kek_version.sql` | ALTER TABLE user ADD session_key_kek_version + idx_user_kek_version |
| 2 | apps/api | `migrations/0010_user_session_key_kek_version.down.sql` | DROP INDEX |
| 3 | apps/api | `src/lib/envelope.ts` | 改 `deriveKek(env, version)` + `encryptEnvelope/decryptEnvelope` 签名加 version + 新 `tryDecryptWithAnyKek` + `getAllKekVersions` |
| 4 | apps/api | `src/lib/user.ts` | `updateUserSessionKey` 写 `session_key_kek_version` + `readUserSessionKey` 用 `tryDecryptWithAnyKek` |
| 5 | apps/api | `src/types.ts` | Env interface 加 4 字段（KEK_SECRET_V1/V2/V3/KEK_CURRENT_VERSION）|
| 6 | apps/api | `test/lib/envelope.test.ts` | 8 旧测试改 3 参数签名 + 5 新测试 |
| 7 | apps/api | `test/lib/user.test.ts` | 3 新测试（写 version / read fallback / KEK 全缺失）|
| 8 | apps/api | `test/routes/auth.test.ts` | applyMigrations 列表加 0010 + 1 新测试（version=1 写入）|

**不交付**（推到 M6.8+ / YAGNI）：
- 主动重 wrap DEK 工具（admin 批量 V1→V2 迁移）— fallback 链 V1 仍可读
- KEK 自动轮换调度（cron 触发）— admin 手动 wrangler secret put
- 复杂 KEK version 统计查询（admin 排查用基础 SQL 够）
- KEK 自动 health check（env 不全 → 启动报警）— M6.8 范围聚焦 fallback 恢复

**新增用例**：9（envelope 5 + user 3 + auth 1 = 9）。**累计 272**（263 + 9）。

---

## 2. Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| Web Crypto 助手 | `apps/api/src/lib/envelope.ts:142-155` `deriveKek` | `deriveKek(env, version)` 加 version 参数；env.KEK_SECRET_V{version} 取 secret |
| secrets 管理 | `apps/api/src/lib/envelope.ts` 读 `env.KEK_SECRET` | 多 env 变量 `env.KEK_SECRET_V1, V2, ...`；M6.7 KEK_SECRET 重命名为 KEK_SECRET_V1 |
| 写失败不阻断 | `apps/api/src/routes/auth.ts:130-137` `updateUserSessionKey` try/catch | M6.8 同样 try/catch（KEK 缺失 / D1 错误不阻断 jwt 签发）|
| 迁移透明 | `M6.7 readUserSessionKey` fallback 老明文 | M6.8 readUserSessionKey fallback 多个 KEK |
| fakeDB 模式 | `apps/api/test/lib/rate-limit.test.ts:15-41` makeFakeDB | envelope 单元测试纯函数；user 单元测试 fakeDB 模式 |
| 错误处理 | `apps/api/src/lib/envelope.ts:13` throw "envelope decrypt failed" | M6.8 保留 + `tryDecryptWithAnyKek` fallback 包裹 |
| migration 模式 | `migrations/0009_user_session_key_envelope.sql` | `0010_user_session_key_kek_version.sql` 镜像：ALTER TABLE ADD 列 + CREATE INDEX |
| Object.keys 扫描 | 标准 JS | `getAllKekVersions` 扫描 `KEK_SECRET_V*` 模式 |

---

## 3. Files to Change

### 新建（2 个）

| 文件 | 内容 | 预估行数 |
|---|---|---|
| `apps/api/migrations/0010_user_session_key_kek_version.sql` | ALTER TABLE ADD session_key_kek_version + CREATE INDEX | 6 |
| `apps/api/migrations/0010_user_session_key_kek_version.down.sql` | DROP INDEX | 3 |

### 修改（5 个）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `apps/api/src/lib/envelope.ts` | deriveKek 加 version + 新 tryDecryptWithAnyKek + getAllKekVersions + encrypt/decrypt 签名加 version | +50 / -10 |
| `apps/api/src/lib/user.ts` | updateUserSessionKey 写 version + readUserSessionKey 用 tryDecryptWithAnyKek | +15 / -5 |
| `apps/api/src/types.ts` | Env 加 4 字段 | +4 / -0 |
| `apps/api/test/lib/envelope.test.ts` | 8 旧测试改签名 + 5 新测试 | +80 / -10 |
| `apps/api/test/lib/user.test.ts` | 3 新测试 | +50 / -5 |
| `apps/api/test/routes/auth.test.ts` | applyMigrations 加 0010 + 1 新测试 | +20 / -5 |

### 不改（沿用 M6.7）

- ✅ `apps/api/wrangler.jsonc` — KEK_SECRET_V* 是 secret 不写 vars
- ✅ `apps/api/src/lib/auth-jwt.ts` — 0 改动
- ✅ `apps/api/src/lib/rate-limit.ts` — 0 改动
- ✅ `apps/api/src/routes/cron.ts` / `stats.ts` — 0 改动
- ✅ 其他包（admin / miniprogram / crawler / shared）— 0 改动

---

## 4. Tasks (2 task / 2 checkpoint)

### Phase 1 — 主线程直接实施（2 task / CP-1 + CP-2）

按 M6.3c/d/4/5/6/7 教训应用，本 plan **不派 subagent**，主线程直接做（1 包 + ~30 min 估时）。

**Task 1: envelope.ts 改 + user.ts 改 + types.ts 改 + migration 0010 + 5 envelope 新测试 + 3 user 新测试**

- Action 1.1: 改 `apps/api/src/lib/envelope.ts`（spec §5 完整代码）：
  - `deriveKek(env, version: number)` 签名加 version；读 `env.KEK_SECRET_V${version}`；缺失 throw "KEK_SECRET_V{N} not configured"
  - `encryptEnvelope(plaintext, env, version: number)` 签名加 version
  - `decryptEnvelope(ct_b64, dek_b64, env, version: number)` 签名加 version
  - 新 `tryDecryptWithAnyKek(ct_b64, dek_b64, env)` 遍历 env 所有 KEK 试解
  - 新 `getAllKekVersions(env)` 扫描 env 找 KEK_SECRET_V* 变量
  - EnvelopeCipher interface 不变；NONCE_BYTES / DEK_BYTES 常量不变

- Action 1.2: 改 8 旧 envelope 测试签名加 version 参数（RED → GREEN）：

  ```typescript
  // 8 旧测试：所有 encryptEnvelope/decryptEnvelope 调用加 version 第 3 参数
  await encryptEnvelope("plaintext-session", env, 1);  // 加 version
  await decryptEnvelope(ciphertext, wrappedDek, env, 1);  // 加 version
  ```

- Action 1.3: 写 5 新 envelope 测试（RED → GREEN）：

  ```typescript
  describe("envelope.getAllKekVersions (M6.8)", () => {
    it("扫描 env 找 V1, V2, V3 跳 V4（无）", () => {
      expect(getAllKekVersions({
        KEK_SECRET_V1: "x", KEK_SECRET_V2: "y", KEK_SECRET_V3: "z", OTHER: "noise",
      })).toEqual([1, 2, 3]);
    });
    it("env 无 KEK → 返 []", () => {
      expect(getAllKekVersions({})).toEqual([]);
    });
  });

  describe("envelope.tryDecryptWithAnyKek (M6.8) fallback", () => {
    it("fallback 成功: V1 写入 → V1 缺失 → V2 存在 → 用 V2 解出", async () => {
      const env1 = { KEK_SECRET_V1: "kek-one" };
      const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext", env1, 1);
      const env2 = { KEK_SECRET_V2: "kek-two" };  // V1 缺失
      const decrypted = await tryDecryptWithAnyKek(ciphertext, wrappedDek, env2);
      expect(decrypted).toBe("plaintext");
    });
    it("fallback 全失败: 所有 KEK 都缺 → throw 'no KEK configured' 或 'all KEKs failed'", async () => {
      await expect(tryDecryptWithAnyKek("xxx", "yyy", {})).rejects.toThrow();
    });
    it("多 KEK 轮换: V1 写入 + V2 写入 → 两个 ciphertext 都能解", async () => {
      const env1 = { KEK_SECRET_V1: "k1" };
      const env2 = { KEK_SECRET_V1: "k1", KEK_SECRET_V2: "k2" };
      const a = await encryptEnvelope("same", env1, 1);
      const b = await encryptEnvelope("same", env2, 2);
      expect(a.ciphertext).not.toBe(b.ciphertext);
      expect(await tryDecryptWithAnyKek(a.ciphertext, a.wrappedDek, env2)).toBe("same");
      expect(await tryDecryptWithAnyKek(b.ciphertext, b.wrappedDek, env2)).toBe("same");
    });
  });
  ```

- Action 1.4: 改 `apps/api/src/lib/user.ts`（spec §5.3 + §5.4 完整代码）：
  - `updateUserSessionKey` 加 `session_key_kek_version = currentVersion` 列
  - `readUserSessionKey` 用 `tryDecryptWithAnyKek` 替代直接 `decryptEnvelope`
  - SELECT 加 `session_key_kek_version` 列
  - 1st try row.session_key_kek_version → 失败 → fallback `tryDecryptWithAnyKek`

- Action 1.5: 改 `apps/api/src/types.ts` 加 4 字段（spec §5.5）：

  ```typescript
  KEK_SECRET_V1?: string;
  KEK_SECRET_V2?: string;
  KEK_SECRET_V3?: string;
  KEK_CURRENT_VERSION?: string;
  ```

- Action 1.6: 写 3 新 user 测试（RED → GREEN）：

  ```typescript
  // 改 1 测试：updateUserSessionKey 写 version
  it("写 version: env.KEK_CURRENT_VERSION='2' → 写 session_key_kek_version=2", async () => {
    await updateUserSessionKey(d1, "user_1", "key", { KEK_SECRET_V2: "k2", KEK_CURRENT_VERSION: "2" });
    const updates = fakeDB.calls.filter(c => c.op === "run" && c.sql.includes("session_key_kek_version"));
    expect(updates[0]!.params).toContain(2);  // version=2 写入
  });
  // 改 1 测试：readUserSessionKey 1st try V1 fail → fallback V2 成功
  it("readUserSessionKey fallback: V1 写入 → env.KEK_SECRET_V1 缺失 → V2 存在 → 解出", async () => { /* ... */ });
  // 新 1 测试：readUserSessionKey 全失败
  it("readUserSessionKey 全失败: 所有 KEK 缺失 → 返 null + console.error", async () => { /* ... */ });
  ```

- Action 1.7: 新建 2 个 migration 文件（spec §5.6）：

  ```sql
  -- 0010_user_session_key_kek_version.sql
  ALTER TABLE user ADD COLUMN session_key_kek_version INTEGER NOT NULL DEFAULT 1;
  CREATE INDEX IF NOT EXISTS idx_user_kek_version ON user(session_key_kek_version);
  ```

  ```sql
  -- 0010_user_session_key_kek_version.down.sql
  DROP INDEX IF EXISTS idx_user_kek_version;
  ```

- Mirror: `apps/api/src/lib/envelope.ts:142-155` `deriveKek` 模式；`apps/api/src/lib/user.ts:69-79` `updateUserSessionKey` 模式
- Validate:
  ```bash
  pnpm -F api test test/lib/envelope.test.ts    # 8 旧 + 5 新 = 13 绿
  pnpm -F api test test/lib/user.test.ts        # 12 旧 + 3 新 = 15 绿
  pnpm -F api typecheck
  ```
  期望：28 绿 + typecheck 0 错
  🛑 **CP-1**: envelope 13 + user 15 绿 + typecheck 0 错

**Task 2: auth.test.ts applyMigrations 加 0010 + 1 新测试 + 全 api test 验证**

- Action 2.1: 改 `apps/api/test/routes/auth.test.ts`（spec §6.3）：
  - applyMigrations 列表加 `0010_user_session_key_kek_version.sql`
  - 1 新测试："POST /auth/wx-login 200: 成功后 D1 user.session_key_kek_version=1 写入"
  - env 加 `KEK_SECRET_V1: "test-kek-32-bytes-long-please-please-xxx"`

- Action 2.2: 改 `apps/api/src/routes/auth.ts` 0 改（updateUserSessionKey 签名不变，env 已含 KEK_CURRENT_VERSION）

- Mirror: 现有 `auth.test.ts:43-57` applyMigrations 模式；M6.7 "session_key_ct 写入" 测试
- Validate:
  ```bash
  pnpm -F api test test/routes/auth.test.ts    # 13 旧 + 1 新 = 14 绿
  pnpm -F api test                              # 全 159 绿
  pnpm -r typecheck                             # 5 包全绿
  pnpm -F api build                             # wrangler dry-run OK
  ```
  期望：api 159 绿 + 5 包 typecheck + build 成功
  🛑 **CP-2**: api 159 绿 + 5 包 typecheck + build

### Phase 2 — 主线程收尾（Task 3 / CP-3）

**Task 3: state-m6-8.md 收尾 + README M6.8 节 + merge**

- Action 3.1: 写 `docs/superpowers/state-m6-8.md`（参考 `state-m6-7.md` 10 sections）：
  1. mock-first 边界
  2. CP pass
  3. 累计 272
  4. 偏差（预计 1-2）
  5. commit 汇总
  6. 遗留 concern
  7. dev 验证缺口
  8. CP-5 真接
  9. 下一步建议
  10. 主线程接管原因

- Action 3.2: 改 `README.md`：
  - 在 M6.7 节后加 M6.8 节（~50 行）
  - 标题：M6.8 状态
  - 内容：KEK version + multi-KEK fallback 新行为 + 5 路径示例 + 测试矩阵 + 6 限制 + CP-5 真接迁移步骤

- Action 3.3: 清理 worktree + merge to master + branch 删除：
  ```bash
  cd .claude/worktrees/m6-8-kek-version
  git checkout master && cd ../../
  git merge --no-ff worktree-m6-8-kek-version -m "Merge branch 'worktree-m6-8-kek-version': M6.8 — KEK version + multi-KEK fallback"
  git worktree remove .claude/worktrees/m6-8-kek-version
  git branch -D worktree-m6-8-kek-version
  ```
  🛑 **CP-3**: 主仓库独立验证

- Validate（CP-3）:
  ```bash
  cd /Users/Mark/cc_project/unequal
  pnpm -r typecheck    # 5 包全绿
  pnpm -r test         # 272 全绿
  ```

---

## 5. Validation

```bash
# Worktree 隔离开发
cd /Users/Mark/cc_project/unequal
git worktree add .claude/worktrees/m6-8-kek-version -b worktree-m6-8-kek-version
cd .claude/worktrees/m6-8-kek-version

# CP-1（Task 1 完成后）
pnpm -F api test test/lib/envelope.test.ts    # 13 绿（8 旧 + 5 新）
pnpm -F api test test/lib/user.test.ts         # 15 绿（12 旧 + 3 新）
pnpm -F api typecheck                          # 0 错

# CP-2（Task 2 完成后）
pnpm -r typecheck                              # 5 包全绿
pnpm -r test                                   # 5 包全绿（api 159 + admin 24 + mini 32 + shared 38 + crawler 19 = 272）
pnpm -F api build                              # wrangler dry-run OK

# CP-3（merge 后，主仓库跑）
cd /Users/Mark/cc_project/unequal
pnpm -r typecheck
pnpm -r test
# 期望 272 全绿

# 增量测试（task 局部验证，不全跑）
pnpm -F api test test/lib/envelope.test.ts     # task 1: 13 绿
pnpm -F api test test/lib/user.test.ts          # task 1: 15 绿
pnpm -F api test test/routes/auth.test.ts      # task 2: 14 绿
```

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **所有 KEK 都丢**（env.KEK_SECRET_V* 全被删/重生成）| 低（HIGH 严重度）| 兜底已无 — 老 user 数据全不可解；**多 secret 备份到 1Password** 是最后防线 |
| `deriveKek` v1 → v2 重命名破坏老 data | 中 | migration 0010 老行 DEFAULT 1；KEK 重命名同步在 CP-5 流程 |
| fallback 性能（N KEK × decrypt） | 低 | D1 < 5ms × 3 KEK = 15ms（可接受）|
| fallback 静默错误（用错误 KEK 巧合解出）| 极低 | AES-GCM 16-byte auth tag 拒绝 99.999...% 错误 |
| env.KEK_CURRENT_VERSION 配错 | 低 | 写时 throw → auth.ts try/catch 兜底 |
| migration 老行 version=1 + 老 KEK 重命名 | 低 | DEFAULT 1 兼容；M6.7 KEK 重命名 V1 同步 |
| N KEK 增长无界 | 极低 | 当前 N ≤ 3 预期 |
| 跨 1 包主线程上下文 | 极低 | 0 跨包；主线程 2 task 边界清晰 |

**最高风险**：所有 KEK 都丢（HIGH 严重度）。Mitigation：KEK 强制密码管理器备份（CP-5 流程 doc 强提示）。

---

## 7. Acceptance

- [ ] 9 新增用例全绿（envelope 5 + user 3 + auth 1 = 9）
- [ ] 累计 272 用例全绿（api 159 + admin 24 + mini 32 + shared 38 + crawler 19 = 272）
- [ ] 5 包 typecheck 全绿
- [ ] wrangler build 成功
- [ ] 主线程独立 CP-3 验证
- [ ] state-m6-8.md 完整
- [ ] README M6.8 节
- [ ] merge + cleanup
- [ ] 0 production console.log（除 readUserSessionKey fallback console.warn + 全失败 console.error — 监控必需）

**dev 验证缺口**（推到 CP-5 真接）：
- 真实 CF Workers 注入 `env.KEK_SECRET_V1` / `env.KEK_CURRENT_VERSION` 行为
- 真实多 KEK 轮换流程（admin 文档演练）
- 真实老 user（M6.7 上线后）重 login 后 session_key_kek_version 升到 currentVersion
- 真实 KEK 丢失场景（env.KEK_SECRET_V1 误删 → 老 user fallback 恢复）
- 真实多 KEK 性能（D1 3 次 fallback 查询 < 15ms）

---

## 8. Implementation Notes

### 8.1 Subagent 分配

**M6.3c/d/4/5/6/7 教训应用**：1 包 + 2 task → 主线程直接做更稳。

M6.8 2 task（实施）+ 1 task（收尾）跨 **1 包**（api only），主线程直接做：
- 30 min 工作量
- 0 跨包一致性风险
- 避免 subagent stall

### 8.2 Commit 节奏（4 commit + 1 merge = 5 总）

```
1. feat(api): M6.8 task 1 — KEK version + multi-KEK fallback (envelope.ts + user.ts + types.ts + migration 0010) + 8 envelope tests
              [🛑 CP-1: envelope 13 + user 15 绿 + typecheck 0 错]
2. feat(api): M6.8 task 2 — auth.test.ts applyMigrations 加 0010 + 1 新测试（version=1 写入）
              [🛑 CP-2: api 159 绿 + 5 包 typecheck + build OK]
3. docs: M6.8 state-m6-8.md 收尾 + README M6.8 节
merge: worktree-m6-8-kek-version → master --no-ff
       [🛑 CP-3: 主仓库独立验证 272 绿]
```

注：Task 1 内部 7 action 合成 1 commit（envelope + user + types + migration 改完 + 5 + 3 测试同步发布）。Task 2 独立 1 commit（auth test 改 + 1 新测试）。

### 8.3 验证顺序

- Task 1 → `pnpm -F api test test/lib/envelope.test.ts test/lib/user.test.ts` + typecheck
- Task 2 → `pnpm -F api test test/routes/auth.test.ts` + 全 `pnpm -F api test` + 5 包 typecheck + build
- Task 3 → 主仓库全跑（merge 后）

### 8.4 ECC 引用

- **`tdd-workflow` skill**：Task 1-2 严格 RED → GREEN → REFACTOR
- **`verification-before-completion` skill**：CP-1/CP-2/CP-3 验证前必须跑命令
- **`brainstorming` skill**：已走完（spec `0175ab8`）

### 8.5 Worktree 路径

- 创建：`git worktree add .claude/worktrees/m6-8-kek-version -b worktree-m6-8-kek-version`
- 清理：`git worktree remove .claude/worktrees/m6-8-kek-version` + `git branch -D`
- merge：主仓库 `git merge --no-ff worktree-m6-8-kek-version -m "..."`

### 8.6 mock-first 边界

- ✅ envelope 单元测试纯函数（env mock）
- ✅ user 单元测试 fakeDB 模式
- ❌ 不验 Web Crypto 行为
- ❌ 不验 D1 ALTER TABLE 性能
- ❌ 不验真实 CF `KEK_SECRET_V*` secret 注入
- ❌ 不验真实多 KEK 轮换流程（CP-5 真接时演练）

---

## 9. 累计测试 + 文件清单

### 9.1 仓库测试累计（M6.8 后）

| 包 | 现有 | M6.8 | 累计 |
|---|---|---|---|
| shared | 38 | 0 | 38 |
| api | 150 | +9 | **159** |
| miniprogram | 32 | 0 | 32 |
| admin | 24 | 0 | 24 |
| crawler | 19 | 0 | 19 |
| **累计** | **263** | **+9** | **272** |

### 9.2 文件清单（M6.8 后）

| 类型 | 文件 | 状态 |
|---|---|---|
| 新代码 | `apps/api/migrations/0010_user_session_key_kek_version.sql` | NEW |
| 新代码 | `apps/api/migrations/0010_user_session_key_kek_version.down.sql` | NEW |
| 改代码 | `apps/api/src/lib/envelope.ts` | +50 / -10 |
| 改代码 | `apps/api/src/lib/user.ts` | +15 / -5 |
| 改代码 | `apps/api/src/types.ts` | +4 / -0 |
| 改测试 | `apps/api/test/lib/envelope.test.ts` | +80 / -10 |
| 改测试 | `apps/api/test/lib/user.test.ts` | +50 / -5 |
| 改测试 | `apps/api/test/routes/auth.test.ts` | +20 / -5 |
| 新文档 | `docs/superpowers/specs/2026-06-16-m6-8-kek-version-design.md` | NEW（已 commit `0175ab8`）|
| 新文档 | `docs/superpowers/plans/2026-06-16-m6-8-kek-version.md` | NEW（本文件）|
| 新文档 | `docs/superpowers/state-m6-8.md` | NEW（state 阶段）|
| 改文档 | `README.md` | +50 / -0 |

**共 3 文件改动（1 lib + 1 user + 1 types）+ 1 新 migration + 3 改测试 + 4 文档 = 12 总**
