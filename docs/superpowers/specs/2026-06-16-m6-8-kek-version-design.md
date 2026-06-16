# M6.8 — KEK Version + Multi-KEK Fallback

**版本**: 2026-06-16
**前置**: M6.7 session-key envelope encryption（已 merge `e6375b9`）
**范围**: 1 项 M6.7 留口加固 — KEK version 字段 + 多 KEK env 变量 + fallback 遍历，解决 KEK 丢失 HIGH 严重度

---

## 1. Requirements

| # | 现状 | 目标 |
|---|---|---|
| 1 | M6.7 单 KEK：env.KEK_SECRET 误删/重生成 → 老 user 密文全不可解（HIGH 严重度）| 加 KEK version 字段（migration 0010）+ 多 KEK env 变量（KEK_SECRET_V1, V2, ...）+ fallback 遍历所有 env KEK 试解 |
| 2 | 0 KEK version 字段（envelope 不知用哪个 KEK 解）| 表加 `session_key_kek_version INTEGER DEFAULT 1` 列；读时按 version 选 KEK |
| 3 | KEK 错无 fallback（env.KEK_SECRET_V{N} 缺失直接抛）| `tryDecryptWithAnyKek` 遍历 env KEK_SECRET_V* 试解（last resort）|

**为什么 YAGNI 精简**（区别于 state-m6-7.md §"下一步建议"）：

- ❌ 不做主动重 wrap DEK 工具（admin 批量把 V1 升 V2）— YAGNI；fallback 链 V1 仍可读即可
- ❌ 不做 KEK 自动轮换调度（cron 触发）— admin 手动 wrangler secret put + KEK_CURRENT_VERSION 改即可
- ❌ 不做 KEK version 索引上的复杂查询（如按 version 统计）— M6.8 范围聚焦 fallback 恢复
- ✅ 只做 KEK version 字段 + 多 KEK env + fallback 遍历（解决 KEK 丢失 HIGH 严重度）

---

## 2. Patterns to Mirror

| 类别 | 来源 | 复用方式 |
|---|---|---|
| Web Crypto 助手 | `apps/api/src/lib/envelope.ts:142-155` `deriveKek` | `deriveKek(env, version)` 加 version 参数；env.KEK_SECRET_V{version} 取 secret |
| secrets 管理 | `apps/api/src/lib/envelope.ts` 读 `env.KEK_SECRET` | 多个 env 变量 `env.KEK_SECRET_V1, V2, ...`；与 M6.7 单 secret 模式兼容（M6.7 KEK_SECRET 重命名为 KEK_SECRET_V1）|
| 写失败不阻断 | `apps/api/src/routes/auth.ts:130-137` `updateUserSessionKey` try/catch | M6.8 同样 try/catch（KEK 缺失 / D1 错误不阻断 jwt 签发）|
| 迁移透明 | `M6.7 readUserSessionKey` fallback 老明文 | M6.8 readUserSessionKey fallback 多个 KEK（懒兼容）|
| fakeDB 模式 | `apps/api/test/lib/rate-limit.test.ts:15-41` makeFakeDB | envelope 单元测试纯函数（不依赖 D1），user 单元测试 fakeDB 模式 |
| 错误处理 | `apps/api/src/lib/envelope.ts:13` throw "envelope decrypt failed" | M6.8 保留 + 加 `tryDecryptWithAnyKek` fallback 包裹 |
| migration 模式 | `migrations/0009_user_session_key_envelope.sql` | `0010_user_session_key_kek_version.sql` 镜像：ALTER TABLE ADD 列 + CREATE INDEX |

---

## 3. Architecture Overview

1 项核心改动（KEK version + 多 KEK fallback）— 1 个 migration + 1 lib 改 + 1 user.ts 改 + 1 types.ts 改 + 2 测试改：

```
─── 核心层（apps/api/src/lib/envelope.ts）─────────────────────
改 deriveKek(env) → deriveKek(env, version: number):
  env_key = env[`KEK_SECRET_V${version}`]
  if (!env_key) throw `KEK_SECRET_V${version} not configured`
  hash = SHA-256(env_key)[:32]
  return AES-256 CryptoKey

新 tryDecryptWithAnyKek(ct_b64, dek_b64, env) → string:
  for version of getAllKekVersions(env):
    try:
      return decryptEnvelope(ct_b64, dek_b64, env, version)
    catch:
      continue  // 该 KEK 错/缺失，试下一个
  throw "all KEKs failed to decrypt"

新 getAllKekVersions(env) → number[]:
  // 扫描 env 找 KEK_SECRET_V* 变量，返回版本号数组
  return [1, 2, 3]  // 例如

改 encryptEnvelope/decryptEnvelope 签名：
  encryptEnvelope(plaintext, env, version: number)
  decryptEnvelope(ct_b64, dek_b64, env, version: number)

─── 数据层（migrations/0010）───────────────────────────────────
ALTER TABLE user ADD COLUMN session_key_kek_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_user_kek_version ON user(session_key_kek_version);

─── 路由层（apps/api/src/lib/user.ts）─────────────────────────
改 updateUserSessionKey:
  currentVersion = parseInt(env.KEK_CURRENT_VERSION ?? "1", 10)
  if (!Number.isFinite(currentVersion) || currentVersion < 1) currentVersion = 1
  { ciphertext, wrappedDek } = await encryptEnvelope(sessionKey, env, currentVersion)
  D1 UPDATE user SET
    session_key_ct = ?, session_key_dek = ?,
    session_key_kek_version = ?,  -- 新增
    session_key = NULL
  WHERE id = ?

改 readUserSessionKey（用 tryDecryptWithAnyKek 替代 decryptEnvelope）:
  row = SELECT session_key_ct, session_key_dek, session_key, session_key_kek_version
  if row.session_key_ct:
    return await tryDecryptWithAnyKek(row.session_key_ct, row.session_key_dek, env)
    // 1st try: row.session_key_kek_version
    // 2nd try: 其他 KEK 兜底
    // 失败 → try/catch 返 null + console.warn

─── 路由层（apps/api/src/routes/auth.ts）─────────────────────
0 改（updateUserSessionKey 签名不变；env 已含 KEK_CURRENT_VERSION + KEK_SECRET_V*）

─── types.ts Env 加 4 字段 ─────────────────────────────────────
KEK_SECRET_V1?: string;       // M6.8: V1 KEK（M6.7 KEK_SECRET 兼容改 V1）
KEK_SECRET_V2?: string;       // M6.8: V2 KEK（未来轮换加）
KEK_SECRET_V3?: string;       // ...
KEK_CURRENT_VERSION?: string; // M6.8: current KEK version（默认 "1"）
```

**关键设计原则**：
- ✅ KEK version 存表列（不动 envelope 序列化，向后兼容 M6.7 老 data = version 1）
- ✅ 多 KEK env 变量（KEK_SECRET_V1, V2, ...）— 与现有 5 个 secret 同模式
- ✅ fallback 遍历所有 env KEK 试（last resort）— KEK 丢失仍可恢复
- ✅ 写时 currentVersion（默认 1）— env 改 KEK_CURRENT_VERSION 即可启用新 KEK
- ✅ 0 主动重 wrap DEK 工具（admin 后台延后）
- ❌ 不做 envelope serialization 变（避免 migration 数据迁移）

---

## 4. Files to Change

### 新建（1 个 + 1 down）

| 文件 | 内容 | 预估行数 |
|---|---|---|
| `apps/api/migrations/0010_user_session_key_kek_version.sql` | ALTER TABLE ADD session_key_kek_version + CREATE INDEX | 6 |
| `apps/api/migrations/0010_user_session_key_kek_version.down.sql` | DROP INDEX | 3 |

### 修改（4 个）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `apps/api/src/lib/envelope.ts` | deriveKek 加 version 参数 + 新 tryDecryptWithAnyKek + 新 getAllKekVersions + encryptEnvelope/decryptEnvelope 签名加 version | +50 / -10 |
| `apps/api/src/lib/user.ts` | updateUserSessionKey 写 session_key_kek_version + readUserSessionKey 用 tryDecryptWithAnyKek | +15 / -5 |
| `apps/api/src/types.ts` | Env 加 4 字段（KEK_SECRET_V1/V2/V3/KEK_CURRENT_VERSION）| +4 / -0 |
| `apps/api/test/lib/envelope.test.ts` | 8 旧测试加 version 参数 + 5 新测试（fallback 成功/全失败/多 KEK 轮换/getAllKekVersions 扫描/version 不匹配）| +80 / -10 |
| `apps/api/test/lib/user.test.ts` | 写 version 测试 + readUserSessionKey fallback + KEK 全部缺失 | +50 / -5 |
| `apps/api/test/routes/auth.test.ts` | applyMigrations 加 0010 + 1 新测试验 version=1 写入 | +20 / -5 |

### 不改（沿用 M6.7）

- ✅ `apps/api/wrangler.jsonc` — KEK_SECRET_V* 是 secret 不写 vars
- ✅ `apps/api/src/lib/auth-jwt.ts` — 0 改动
- ✅ `apps/api/src/lib/rate-limit.ts` — 0 改动
- ✅ `apps/api/src/routes/cron.ts` / `stats.ts` — 0 改动
- ✅ 其他包（admin / miniprogram / crawler / shared）— 0 改动

---

## 5. Task 1: envelope.ts 改 + user.ts 改 + types.ts 改 + migration 0010

### 5.1 `envelope.ts` 改 `deriveKek` + 新 helpers

```typescript
/** M6.8: KEK 派生（按 version 选 secret） */
async function deriveKek(env: { [key: string]: unknown }, version: number): Promise<CryptoKey> {
  const envKey = `KEK_SECRET_V${version}`;
  const secret = env[envKey] as string | undefined;
  if (!secret) {
    throw new Error(`${envKey} not configured`);
  }
  const raw = new TextEncoder().encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", raw);
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** M6.8: 扫描 env 找所有 KEK version */
export function getAllKekVersions(env: { [key: string]: unknown }): number[] {
  const versions: number[] = [];
  for (const key of Object.keys(env)) {
    const match = key.match(/^KEK_SECRET_V(\d+)$/);
    if (match) versions.push(parseInt(match[1]!, 10));
  }
  return versions.sort((a, b) => a - b);
}

/** M6.8: fallback 遍历所有 KEK 试解（last resort） */
export async function tryDecryptWithAnyKek(
  ciphertext_b64: string,
  wrappedDek_b64: string,
  env: { [key: string]: unknown },
): Promise<string> {
  const versions = getAllKekVersions(env);
  if (versions.length === 0) {
    throw new Error("no KEK configured");
  }
  for (const v of versions) {
    try {
      return await decryptEnvelope(ciphertext_b64, wrappedDek_b64, env, v);
    } catch {
      continue;  // 该 KEK 错/缺失，试下一个
    }
  }
  throw new Error("all KEKs failed to decrypt");
}
```

### 5.2 `envelope.ts` 改 `encryptEnvelope` / `decryptEnvelope` 签名

```typescript
export async function encryptEnvelope(
  plaintext: string,
  env: { [key: string]: unknown },  // 扩 type
  version: number,
): Promise<EnvelopeCipher> {
  const kek = await deriveKek(env, version);
  // ... 其余不变
}

export async function decryptEnvelope(
  ciphertext_b64: string,
  wrappedDek_b64: string,
  env: { [key: string]: unknown },
  version: number,
): Promise<string> {
  const kek = await deriveKek(env, version);
  // ... 其余不变
}
```

### 5.3 `user.ts` 改 `updateUserSessionKey` 写 version

```typescript
export async function updateUserSessionKey(
  d1: D1Database,
  userId: string,
  sessionKey: string,
  env: { [key: string]: unknown },
): Promise<void> {
  if (!sessionKey) return;
  // M6.8: 解析 currentVersion（默认 1；非法 fallback 1）
  const currentVersion = parseInt(env.KEK_CURRENT_VERSION as string ?? "1", 10);
  const version = Number.isFinite(currentVersion) && currentVersion >= 1 ? currentVersion : 1;
  const { ciphertext, wrappedDek } = await encryptEnvelope(sessionKey, env, version);
  await d1
    .prepare(
      `UPDATE user SET
        session_key_ct = ?, session_key_dek = ?,
        session_key_kek_version = ?,  -- M6.8 新增
        session_key = NULL
       WHERE id = ?`,
    )
    .bind(ciphertext, wrappedDek, version, userId)
    .run();
}
```

### 5.4 `user.ts` 改 `readUserSessionKey` 用 `tryDecryptWithAnyKek`

```typescript
export async function readUserSessionKey(
  d1: D1Database,
  userId: string,
  env: { [key: string]: unknown },
): Promise<string | null> {
  const row = await d1
    .prepare(
      `SELECT session_key_ct, session_key_dek, session_key, session_key_kek_version
       FROM user WHERE id = ?`,
    )
    .bind(userId)
    .first<{
      session_key_ct: string | null;
      session_key_dek: string | null;
      session_key: string | null;
      session_key_kek_version: number | null;
    }>();
  if (!row) return null;

  if (row.session_key_ct && row.session_key_dek) {
    try {
      // M6.8: 1st try 优先用 row.session_key_kek_version；失败 fallback 遍历所有 KEK
      if (row.session_key_kek_version) {
        try {
          return await decryptEnvelope(row.session_key_ct, row.session_key_dek, env, row.session_key_kek_version);
        } catch {
          console.warn(`[envelope] primary KEK V${row.session_key_kek_version} failed, fallback for user ${userId}`);
        }
      }
      return await tryDecryptWithAnyKek(row.session_key_ct, row.session_key_dek, env);
    } catch (err) {
      console.warn(`[envelope] all KEKs failed for user ${userId}:`, err);
      return null;
    }
  }

  return row.session_key;  // 老明文 fallback
}
```

### 5.5 `types.ts` Env 加 4 字段

```typescript
// M6.8: KEK version + multi-KEK fallback
KEK_SECRET_V1?: string;       // V1 KEK（M6.7 KEK_SECRET 重命名）
KEK_SECRET_V2?: string;       // V2 KEK（未来轮换加）
KEK_SECRET_V3?: string;       // V3 KEK（...）
KEK_CURRENT_VERSION?: string; // current KEK version（默认 "1"）
```

### 5.6 `migrations/0010_user_session_key_kek_version.sql`

```sql
-- M6.8: 加 session_key_kek_version 列
-- DEFAULT 1：M6.7 老行 = version 1（M6.7 KEK 重命名为 V1 后兼容）
-- NOT NULL：M6.8 上线后所有新行必填

ALTER TABLE user ADD COLUMN session_key_kek_version INTEGER NOT NULL DEFAULT 1;

-- 索引：读路径按 version 过滤（admin 排查 / 批量重 wrap 工具用）
CREATE INDEX IF NOT EXISTS idx_user_kek_version
  ON user(session_key_kek_version);
```

### 5.7 关键决策

- ✅ KEK version 存表列（不动 envelope 序列化，向后兼容 M6.7）
- ✅ 多 KEK env 变量（KEK_SECRET_V*）— 与现有 5 个 secret 同模式
- ✅ fallback 遍历所有 env KEK 试（last resort）
- ✅ 1st try 优先用 row.session_key_kek_version（快速路径）
- ✅ 写时 currentVersion 默认 1（env.KEK_CURRENT_VERSION 可改）
- ❌ 不做 envelope serialization 变（避免 migration 数据迁移）
- ❌ 不做 admin 批量重 wrap 工具（M6.8+ YAGNI）
- ❌ 不做 KEK 自动轮换调度（admin 手动 wrangler secret put）

---

## 6. Task 2: 测试（envelope 5 + user 3 + auth 1 = 9 新增）

### 6.1 `envelope.test.ts` 8 旧 + 5 新

```typescript
// 8 旧测试：encryptEnvelope/decryptEnvelope 改 3 参数（加 version）
await encryptEnvelope("x", env, 1);
await decryptEnvelope(ct, dek, env, 1);

// 5 新测试：
describe("envelope.getAllKekVersions (M6.8)", () => {
  it("扫描 env 找 V1, V2, V3 跳 V4（无）", () => {
    expect(getAllKekVersions({
      KEK_SECRET_V1: "x", KEK_SECRET_V2: "y", KEK_SECRET_V3: "z",
      OTHER: "noise",
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
    // 模拟 V1 丢失，加 V2
    const env2 = { KEK_SECRET_V2: "kek-two" };
    const decrypted = await tryDecryptWithAnyKek(ciphertext, wrappedDek, env2);
    expect(decrypted).toBe("plaintext");
  });
  it("fallback 全失败: 所有 KEK 都缺 → throw 'all KEKs failed'", async () => {
    await expect(tryDecryptWithAnyKek("xxx", "yyy", {})).rejects.toThrow(/no KEK configured|all KEKs/);
  });
  it("多 KEK 轮换: V1 写入 → V2 写入（不同 DEK）→ 两个 ciphertext 都能解", async () => {
    const env1 = { KEK_SECRET_V1: "k1" };
    const env2 = { KEK_SECRET_V1: "k1", KEK_SECRET_V2: "k2" };
    const a = await encryptEnvelope("same", env1, 1);
    const b = await encryptEnvelope("same", env2, 2);
    expect(a.ciphertext).not.toBe(b.ciphertext);  // 不同 KEK → 不同 wrappedDek
    expect(await tryDecryptWithAnyKek(a.ciphertext, a.wrappedDek, env2)).toBe("same");
    expect(await tryDecryptWithAnyKek(b.ciphertext, b.wrappedDek, env2)).toBe("same");
  });
});
```

### 6.2 `user.test.ts` 写 version 测试 + read fallback

```typescript
// 改：updateUserSessionKey 写 version 验证
it("写 version: env.KEK_CURRENT_VERSION='2' → 写 session_key_kek_version=2", async () => {
  await updateUserSessionKey(d1, "user_1", "key", { KEK_SECRET_V2: "k2", KEK_CURRENT_VERSION: "2" });
  // 验 SQL 包含 session_key_kek_version=2
});
// 改：readUserSessionKey 1st try V1 fail → fallback V2 成功
it("readUserSessionKey fallback: V1 写入 → env.KEK_SECRET_V1 缺失 → V2 存在 → 解出", async () => { /* ... */ });
// 新：readUserSessionKey 全失败
it("readUserSessionKey 全失败: 所有 KEK 缺失 → 返 null + console.error", async () => { /* ... */ });
```

### 6.3 `auth.test.ts` applyMigrations 加 0010 + 1 新测试

```typescript
// applyMigrations 列表加 0010_user_session_key_kek_version.sql
for (const f of [
  "0001_init.sql", "0005_login_attempt.sql", "0006_user_session_key.sql",
  "0008_login_attempt_client_ip.sql", "0009_user_session_key_envelope.sql",
  "0010_user_session_key_kek_version.sql",  // M6.8 新增
]) { /* ... */ }

// 1 新测试：session_key_kek_version=1 写入
it("POST /auth/wx-login 200: 成功后 D1 user.session_key_kek_version=1 写入", async () => {
  // env 加 KEK_SECRET_V1
  // SELECT 验 session_key_kek_version=1
});
```

---

## 7. 数据流

### 7.1 流 A — 写新数据（KEK_CURRENT_VERSION=1，M6.7 兼容）

```
1. /auth/wx-login 成功
2. updateUserSessionKey(env.DB, user.id, "wx_abc...", env):
   ├─ currentVersion = parseInt("1", 10) = 1
   ├─ encryptEnvelope("wx_abc...", env, 1):
   │   ├─ deriveKek(env, 1) = SHA-256(env.KEK_SECRET_V1)[:32]
   │   ├─ DEK, nonce1, ciphertext = AES-GCM(...)
   │   └─ wrappedDek = AES-GCM(kek, nonce2, DEK)
   └─ D1 UPDATE user SET
        session_key_ct=..., session_key_dek=..., session_key_kek_version=1, session_key=NULL
3. ✅ 写成功（version 标记为 1）
```

### 7.2 流 B — 读 V1 老 user（happy）

```
1. readUserSessionKey(d1, userId, env)
2. row.session_key_ct=..., session_key_kek_version=1
3. 1st try: decryptEnvelope(ct, dek, env, 1)
   ├─ deriveKek(env, 1) = SHA-256(env.KEK_SECRET_V1)[:32]  // 存在
   └─ plaintext = AES-GCM-decrypt(DEK, ...)  // 成功
4. ✅ return plaintext
```

### 7.3 流 C — 读 V1 但 env.KEK_SECRET_V1 误删（fallback）

```
1. row.session_key_kek_version=1
2. 1st try: decryptEnvelope(ct, dek, env, 1)
   ├─ deriveKek(env, 1) = throw "KEK_SECRET_V1 not configured"
   └─ catch → console.warn("[envelope] primary KEK V1 failed, fallback")
3. 2nd try: tryDecryptWithAnyKek(ct, dek, env)
   ├─ getAllKekVersions(env) = [2, 3]  // V1 缺失
   ├─ decryptEnvelope(ct, dek, env, 2)  // 用 V2 试解
   │   ├─ deriveKek(env, 2) = SHA-256(env.KEK_SECRET_V2)[:32]  // 存在
   │   └─ plaintext = AES-GCM-decrypt(...)  // 失败（V2 加密的 wrappedDek 解不出 V1 加密的）
   ├─ decryptEnvelope(ct, dek, env, 3)  // V3 同样失败
   └─ throw "all KEKs failed to decrypt"
4. readUserSessionKey catch → console.error + return null
5. ⚠️ 真实 V1 数据真的丢失（fallback 也救不回）— 监控必需
```

### 7.4 流 D — 写时 KEK_CURRENT_VERSION 错配

```
env.KEK_CURRENT_VERSION = "5"（实际只 V1-V3）
1. encryptEnvelope(plaintext, env, 5):
   ├─ deriveKek(env, 5) = throw "KEK_SECRET_V5 not configured"
2. updateUserSessionKey 透传 throw
3. auth.ts try/catch 兜底
4. ✅ 登录仍成功，session_key 不写
```

### 7.5 流 E — KEK 轮换（admin）

```
1. 注入新 KEK: pnpm wrangler secret put KEK_SECRET_V2
2. 启用: pnpm wrangler secret put KEK_CURRENT_VERSION (值="2")
3. CF Workers 重启 → 读新 env
4. 新 user / 老 user 重 login → 用 V2 写（version=2）
5. 老 user 仍 V1（不主动重 wrap）— fallback 链 V1 仍可读
6. （可选）admin 工具批量重 wrap V1 → V2（M6.8+ YAGNI）
```

---

## 8. 错误处理

| 错误场景 | 抛错？ | 调用方行为 |
|---|---|---|
| `encryptEnvelope`: env.KEK_SECRET_V{version} 缺失 | ✅ throw "KEK_SECRET_V{N} not configured" | auth.ts try/catch 兜底 |
| `encryptEnvelope`: env.KEK_CURRENT_VERSION 非数字 | ❌ 不抛，fallback version=1 | 0 业务影响 |
| `decryptEnvelope`: KEK 错 / tamper | ✅ throw "envelope decrypt failed" | readUserSessionKey 1st try 失败 → fallback 试 |
| `tryDecryptWithAnyKek`: 所有 KEK 都失败 | ✅ throw "all KEKs failed to decrypt" | readUserSessionKey 返 null + console.error |
| `updateUserSessionKey`: D1 UPDATE 失败 | ✅ throw | auth.ts try/catch 兜底 |
| `readUserSessionKey`: 老 user fallback 明文 | ❌ 不抛，返 row.session_key | 透明 fallback |
| `readUserSessionKey`: row 不存在 | ❌ 不抛，返 null | 调用方决定 |
| `getAllKekVersions`: env 无 KEK | ❌ 不抛，返 [] | tryDecryptWithAnyKek throw "no KEK configured" |

---

## 9. 测试策略

### 9.1 TDD 流程

```
Task 1: 改 envelope 签名（RED：8 旧测试 fail）→ 改 envelope 实现（GREEN）→ REFACTOR
        改 user.ts 签名（RED：旧测试 fail）→ 改 user.ts 实现（GREEN）→ REFACTOR
Task 2: 加 5 envelope 新测试 + 3 user 新测试 + 1 auth 新测试
        改 auth.test.ts applyMigrations 列表加 0010
```

### 9.2 Mock-first 边界

- ✅ envelope 单元测试纯函数（env mock）
- ✅ user 单元测试 fakeDB 模式
- ❌ 不验 Web Crypto 行为
- ❌ 不验 D1 ALTER TABLE 性能
- ❌ 不验真实 CF `KEK_SECRET_V*` secret 注入

### 9.3 累计测试矩阵

| 测试文件 | 现有 | 新增 | 累计 |
|---|---|---|---|
| `apps/api/test/lib/envelope.test.ts` | 8 | 5 | 13 |
| `apps/api/test/lib/user.test.ts` | 12 | 3 | 15 |
| `apps/api/test/routes/auth.test.ts` | 13 | 1 | 14 |
| 其他包 | 226 | 0 | 226 |
| 其他 api 测试 | 89 | 0 | 89 |
| **累计** | **263** | **+9** | **272** |

---

## 10. Acceptance Criteria（M6.8 完成定义）

### 10.1 功能 AC

| # | 标准 |
|---|---|
| AC-1 | `envelope.ts` 提供 `encryptEnvelope(plaintext, env, version)` + `decryptEnvelope(ct_b64, dek_b64, env, version)` + `tryDecryptWithAnyKek` + `getAllKekVersions` |
| AC-2 | `deriveKek(env, version)` 按 `env.KEK_SECRET_V{version}` 派生；缺失 throw "KEK_SECRET_V{N} not configured" |
| AC-3 | `tryDecryptWithAnyKek` 遍历 env 所有 KEK 试解；全失败 throw "all KEKs failed to decrypt" |
| AC-4 | `getAllKekVersions` 扫描 env 找 `KEK_SECRET_V*` 变量返回版本数组 |
| AC-5 | `updateUserSessionKey` 写 `session_key_kek_version = currentVersion`（默认 1）|
| AC-6 | `readUserSessionKey` 1st try row.session_key_kek_version → 失败 fallback tryDecryptWithAnyKek |
| AC-7 | `types.ts` Env 加 4 字段（KEK_SECRET_V1/V2/V3/KEK_CURRENT_VERSION）|
| AC-8 | `migration/0010` 加 `session_key_kek_version INTEGER NOT NULL DEFAULT 1` + 索引 |

### 10.2 测试 AC

| # | 标准 |
|---|---|
| AC-9 | `pnpm -F api test` 全绿（**159 用例**：150 旧 + 9 新）|
| AC-10 | 5 包 `pnpm -r typecheck` 全绿 |
| AC-11 | `pnpm -F api build`（wrangler dry-run）成功 |

### 10.3 Dev 验证 AC（CP-5 真接时补）

- 真实 CF Workers 注入 `env.KEK_SECRET_V1` / `env.KEK_CURRENT_VERSION` 行为
- 真实多 KEK 轮换流程（admin 文档演练）
- 真实老 user（M6.7 上线后）重 login 后 session_key_kek_version 升到 currentVersion

### 10.4 文档 AC

| # | 标准 |
|---|---|
| AC-12 | `docs/superpowers/state-m6-8.md` 收尾 |
| AC-13 | `README.md` 加 M6.8 节 |

---

## 11. CP-5 真接路径

M6.8 真接 Cloudflare 1 关键迁移：

1. **M6.7 KEK 迁移**（P0）：
   ```bash
   # 1. 把 M6.7 KEK 重命名为 V1
   # 旧：pnpm wrangler secret put KEK_SECRET
   # 新：pnpm wrangler secret put KEK_SECRET_V1  (同值)
   # 旧：pnpm wrangler secret delete KEK_SECRET  (如 M6.7 还在用)
   # 2. 配 KEK_CURRENT_VERSION
   pnpm wrangler secret put KEK_CURRENT_VERSION
   # 提示：输入 "1"
   ```
2. **未来轮换**：
   ```bash
   pnpm wrangler secret put KEK_SECRET_V2
   pnpm wrangler secret put KEK_CURRENT_VERSION  # 值="2"
   # 0 主动重 wrap；老 user 仍 V1，fallback 链 V1 仍可读
   ```
3. **migration 自动跑**：`wrangler d1 migrations apply unequal-db`（0010）
4. **wrangler.jsonc 0 改**（KEK_SECRET_V* 是 secret）
5. **KEK 备份文档化**：所有 KEK_SECRET_V* 必须备份到 1Password（任何 V 丢失都需 admin 恢复）

---

## 12. 风险与回滚

### 12.1 风险点

| 风险 | 缓解 | 严重度 |
|---|---|---|
| **所有 KEK 都丢**（env.KEK_SECRET_V* 全被删/重生成）| 兜底已无 — 老 user 数据全不可解；**多 secret 备份到 1Password** 是最后防线 | HIGH |
| **env.KEK_CURRENT_VERSION 配错** | 写时 throw → auth.ts try/catch 兜底，登录仍成功但 session_key 不写 | LOW |
| **fallback 性能**（N 个 KEK 试解密 N 次）| D1 < 5ms × 3 KEK = 15ms（可接受）；N > 5 考虑缓存 | LOW |
| **fallback 静默错误**（用错误 KEK 巧合解密成功）| AES-GCM 16-byte auth tag 拒绝 99.999...% 错误 | LOW |
| **migration 老行 version=1** | DEFAULT 1 + M6.7 KEK 重命名为 V1 兼容 | LOW |
| **env 0 KEK** | write 抛 "KEK_SECRET_V1 not configured" — auth.ts try/catch 兜底 | LOW |
| **N KEK 增长无界** | 当前预期 N ≤ 3；N > 5 加限制 | LOW |
| **bundle 增 0** | 0 | LOW |

### 12.2 回滚策略

| Commit | 回滚方式 | 影响 |
|---|---|---|
| Task 1 (envelope + user + types + migration) | `git revert` + `wrangler d1 migrations apply --rollback 0010` | envelope 退到 M6.7 单 KEK；migration 删 1 列 + 1 索引 |
| Task 2 (测试) | `git revert` | 9 测试退到 263 |

**最严重回滚场景**：M6.8 部署时 KEK_CURRENT_VERSION="2" 但 KEK_SECRET_V2 未注入 → 新 user 写失败（已有 fallback，登录仍成功）。
**缓解**：M6.8 部署 checklist 强提示"V1 + CURRENT_VERSION=1 先保留，V2 部署完成后再改"。

---

## 13. 实施计划

### 13.1 Commit 拆分（3 commit + 1 merge = 4 总）

| # | Commit | 主题 | 测试增量 |
|---|---|---|---|
| 1 | spec | `docs: M6.8 spec — KEK version + multi-KEK fallback` | 0 |
| 2 | plan | `docs: M6.8 plan — KEK version + multi-KEK fallback` | 0 |
| 3 | Task 1+2 合并 | `feat(api): M6.8 — KEK version + fallback + 9 tests` | +9 |
| 4 | state + README | `docs: M6.8 state-m6-8.md 收尾 + README M6.8 节` | 0 |
| merge | `worktree-m6-8-kek-version → master --no-ff` | — |

**共 4 commit + 1 merge = 5 总**

### 13.2 工作流

- **worktree 隔离**：`git worktree add .claude/worktrees/m6-8-kek-version -b worktree-m6-8-kek-version`
- **主线程直接做**（M6.3c/d/4/5/6/7 教训应用）：1 包改动 + 2 task，~30 min
- **TDD 严格走**：先改 envelope 签名（8 旧测试 fail）→ 改实现 → 加 5 新测试
- **CP-1/CP-2/CP-3**：
  - CP-1: Task 1 完成（envelope 签名改完 + 旧测试绿 + 5 新测试绿）
  - CP-2: Task 2 完成（user 3 新 + auth 1 新 + 全 api 绿 + typecheck + build）
  - CP-3: merge 后主仓库独立验证

---

## 14. 累计测试 + 文件清单

### 14.1 仓库测试累计（M6.8 后）

| 包 | 现有 | M6.8 | 累计 |
|---|---|---|---|
| shared | 38 | 0 | 38 |
| api | 150 | +9 | **159** |
| miniprogram | 32 | 0 | 32 |
| admin | 24 | 0 | 24 |
| crawler | 19 | 0 | 19 |
| **累计** | **263** | **+9** | **272** |

### 14.2 文件清单（M6.8 后）

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
| 新文档 | `docs/superpowers/specs/2026-06-16-m6-8-kek-version-design.md` | NEW（本文件）|
| 新文档 | `docs/superpowers/plans/2026-06-16-m6-8-kek-version.md` | NEW（plan 阶段）|
| 新文档 | `docs/superpowers/state-m6-8.md` | NEW（state 阶段）|
| 改文档 | `README.md` | +50 / -0 |

**共 3 文件改动（1 代码 + 1 user + 1 types）+ 1 新 migration + 3 改测试 + 4 文档 = 12 总**

---

## 附录 A：关键设计决策记录

| # | 决策 | 理由 | 拒绝方案 |
|---|---|---|---|
| D-1 | KEK version 存表列（`session_key_kek_version INTEGER`）| envelope 序列化不变；M6.7 老 data 自动 = version 1；admin 排查 D1 直接看列 | wrappedDek 前缀加 version byte（migration 成本）；多 KEK env 试序（无 version 显式）|
| D-2 | 多 env 变量 `KEK_SECRET_V1, V2, V3, ...` | 与现有 5 secret 同模式；wrangler secret put 清晰；N ≤ 3 可控 | 1 JSON env（CF secret JSON 解析报错风险）；current + historical 分离（轮换逻辑复杂）|
| D-3 | fallback 遍历所有 env KEK 试（last resort）| KEK 丢失仍可恢复（admin 重设 KEK 后老 user 仍能读）| 严格按 version 抛错（依赖 admin 手动重 wrap）|
| D-4 | 写时 currentVersion 默认 1（env.KEK_CURRENT_VERSION 可改）| 0 配置默认 V1（M6.7 兼容）；env 改即可启用新 KEK | 强制配 env（破坏 dev 体验）|
| D-5 | 1st try 优先用 row.session_key_kek_version（快速路径）| happy path 1 次解密；fallback 仅 1st try 失败触发 | 直接 fallback（性能 0 影响但 happy path 多余）|
| D-6 | 0 主动重 wrap DEK 工具 | admin 后台延后；fallback 链 V1 仍可读 | YAGNI |
| D-7 | env `Object.keys` 扫描 `KEK_SECRET_V*` 模式 | 简单、动态；N KEK 不需改代码 | 写死 V1, V2, V3（不灵活）|
| D-8 | 派生算法 hardcode SHA-256（沿用 M6.7）| env 任意长度 secret 统一 32 字节 raw key | scrypt/argon2（KEK 不存表 brute-force 无意义）|
