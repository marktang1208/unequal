# M6.7 — Session Key Envelope Encryption

**版本**: 2026-06-16
**前置**: M6.6 rate-limit 加 IP 维度（已 merge `aa62caa`）
**范围**: 1 项 M6.3b 留口加固 — session_key 改 envelope encryption（Web Crypto AES-256-GCM，每条数据独立 DEK，KEK 来自 wrangler secret）

---

## 1. Requirements

| # | 现状 | 目标 |
|---|---|---|
| 1 | M6.3b 写 `session_key` 明文到 D1 `user` 表（依赖 CF D1 encryption at rest 黑盒信任） | envelope encryption：DEK 加密 session_key + KEK 加密 DEK；D1 只存 ciphertext + wrapped_dek；KEK 从 env 注入不落库 |
| 2 | 未来 PII 隐私审计 / GDPR 合规 / KEK 轮换 0 准备 | envelope 模式让 KEK 轮换只需 re-wrap DEK（不重加密所有 session_key）|
| 3 | 0 读取调用方（M6.3b 写而未读）| 读路径实现：透明 fallback 老明文（lazy 迁移），写时新 user 永不再存明文 |

**为什么 YAGNI 精简**（区别于 state-m6-6.md §"下一步建议"）：

- ❌ 不做 D1 token-level mutex（窄场景，价值低）
- ❌ 不做 admin `/stats` 加 top_offending_ips（YAGNI）
- ❌ 不做 active batch migration（lazy 设计 0 主动迁移；老 user 重 login 自然变密文）
- ❌ 不做 KEK version + 多 KEK 兜底（M6.7 范围聚焦单 KEK；未来需轮换时再做）
- ✅ 只做 envelope encryption（真实 PII 价值，0 新依赖，1.5d → 实测 30-60 min）

---

## 2. Patterns to Mirror

| 类别 | 来源 | 复用方式 |
|---|---|---|
| Web Crypto 助手 | `apps/api/src/lib/rate-limit.ts:66-73` `sha256Identifier` 用 `crypto.subtle.digest` | `envelope.ts` 用 `crypto.subtle.encrypt` AES-GCM + `crypto.getRandomValues` 生成 nonce/DEK |
| secrets 管理 | `apps/api/src/lib/auth-jwt.ts` 读 `env.JWT_SECRET` | `envelope.ts` 读 `env.KEK_SECRET`；与 JWT_SECRET / WX_APP_SECRET / CRON_SECRET 同模式（wrangler secret put）|
| 写失败不阻断 | `apps/api/src/routes/auth.ts:131-135` `updateUserSessionKey` try/catch | M6.7 同样 try/catch（KEK 缺失 / D1 错误不阻断 jwt 签发）|
| 迁移透明 | `M6.6 假 DB COUNT/MIN SQL 按 client_ip vs identifier 关键字解析` | readUserSessionKey 按 `session_key_ct IS NULL` fallback 旧明文 |
| 错误处理 | `apps/api/src/routes/auth.ts:54-63` `handleHttpError` | envelope 抛 `Error("KEK_SECRET not configured")` 透传 → 500（如有调用方）|
| migration 模式 | `migrations/0006_user_session_key.sql` | `0009_user_session_key_envelope.sql` 镜像：ALTER TABLE 加 2 列 |

---

## 3. Architecture Overview

1 项核心改动（envelope encryption）— 1 个新 lib + 1 migration + 1 改 user.ts + 1 改 auth.ts：

```
─── 核心层（apps/api/src/lib/envelope.ts）─────────────────────
新 helper（Web Crypto AES-256-GCM）:
  encryptEnvelope(plaintext, env) → { ciphertext, wrappedDek }
    ├─ DEK = crypto.getRandomValues(32)  // 随机 32 字节
    ├─ nonce1 = crypto.getRandomValues(12)  // 96-bit nonce
    ├─ ciphertext = AES-GCM-encrypt(DEK, nonce1, plaintext)  // 含 16-byte auth tag
    ├─ KEK = SHA-256(env.KEK_SECRET).slice(0, 32)  // 32 字节 raw key
    ├─ nonce2 = crypto.getRandomValues(12)
    └─ wrappedDek = AES-GCM-encrypt(KEK, nonce2, DEK)

  decryptEnvelope(ciphertext_b64, wrappedDek_b64, env) → plaintext
    ├─ 反序列化 ct_bytes = base64Decode(ciphertext) → [nonce1, encrypted_data+tag]
    ├─ 反序列化 dek_bytes = base64Decode(wrappedDek) → [nonce2, wrapped_DEK+tag]
    ├─ KEK = SHA-256(env.KEK_SECRET).slice(0, 32)
    ├─ DEK = AES-GCM-decrypt(KEK, nonce2, wrapped_DEK+tag)  // 可能抛（KEK 错 / tamper）
    └─ plaintext = AES-GCM-decrypt(DEK, nonce1, encrypted_data+tag)

  KEK 派生：env.KEK_SECRET 任意长度 → SHA-256 截 32 字节 raw key

─── 数据层（migrations/0009）───────────────────────────────────
ALTER TABLE user ADD COLUMN session_key_ct TEXT;     -- 新密文列
ALTER TABLE user ADD COLUMN session_key_dek TEXT;    -- wrapped DEK 列
-- 旧 session_key TEXT 列保留（M6.3b 写入的明文，lazy 迁移透明 fallback）

─── 路由层（apps/api/src/lib/user.ts）─────────────────────────
改 updateUserSessionKey(d1, userId, sessionKey, env):
  if (!sessionKey) return
  { ciphertext, wrappedDek } = await encryptEnvelope(sessionKey, env)
  D1 UPDATE user
    SET session_key_ct = ?, session_key_dek = ?, session_key = NULL
    WHERE id = ?
  -- session_key = NULL 避免明密共存

新 readUserSessionKey(d1, userId, env) → string | null:
  row = SELECT session_key_ct, session_key_dek, session_key FROM user WHERE id = ?
  if row.session_key_ct:
    return await decryptEnvelope(row.session_key_ct, row.session_key_dek, env)
  return row.session_key  // 老 user 明文 fallback

─── 路由层（apps/api/src/routes/auth.ts）─────────────────────
改 1 处：updateUserSessionKey(env.DB, user.id, wxRes.session_key) → 加 env
  await updateUserSessionKey(env.DB, user.id, wxRes.session_key, env)
```

**关键设计原则**：
- ✅ Web Crypto AES-256-GCM（0 新依赖，CF Workers / miniflare / Node 18+ 内置）
- ✅ KEK 从不落库（env 注入，wrangler secret put）
- ✅ 每条数据独立 DEK（KEK 轮换成本低：只 re-wrap DEK，不重加密所有 ciphertext）
- ✅ 写时 session_key=NULL（避免明密共存，安全）
- ✅ 读路径 lazy 兼容老明文（0 主动迁移，老 user 重 login 后自然变密文）
- ❌ 不做 KEK version + 多 KEK（M6.7 范围聚焦单 KEK；未来轮换时再做）
- ❌ 不做 KEK 派生 scrypt/argon2（SHA-256 足够；KEK 不存表 brute-force 无意义）

---

## 4. Files to Change

### 新建（2 个）

| 文件 | 内容 | 预估行数 |
|---|---|---|
| `apps/api/migrations/0009_user_session_key_envelope.sql` | ALTER TABLE ADD session_key_ct + session_key_dek | 6 |
| `apps/api/migrations/0009_user_session_key_envelope.down.sql` | 留空（SQLite < 3.35 不支持 DROP COLUMN）| 3 |
| `apps/api/src/lib/envelope.ts` | encryptEnvelope + decryptEnvelope + 内部 KEK 派生 helper | ~80 |

### 修改（4 个）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `apps/api/src/lib/user.ts` | updateUserSessionKey 签名加 env 必填参数 + 改写密文路径；新 readUserSessionKey 函数 | +60 / -10 |
| `apps/api/src/routes/auth.ts` | updateUserSessionKey 调用加 env | +1 / -1 |
| `apps/api/src/types.ts` | Env interface 加 `KEK_SECRET?: string` 字段 | +1 / -0 |
| `apps/api/test/lib/user.test.ts` | 4 旧测试改 updateUserSessionKey 4 参数签名 + 5 新测试 | +50 / -8 |

### 新建测试（1 个）

| 文件 | 内容 | 预估行数 |
|---|---|---|
| `apps/api/test/lib/envelope.test.ts` | 8 新测试 | +120 / -0 |

### 不改（沿用 M6.6）

- ✅ `apps/api/wrangler.jsonc` — KEK_SECRET 是 secret 不写 vars
- ✅ `apps/api/src/lib/auth-jwt.ts` — 0 改动
- ✅ `apps/api/src/lib/rate-limit.ts` — 0 改动
- ✅ `apps/api/src/lib/cron.ts` / `routes/cron.ts` / `routes/stats.ts` — 0 改动
- ✅ 其他包（admin / miniprogram / crawler / shared）— 0 改动

---

## 5. Task 1: `envelope.ts` 新 lib（encrypt + decrypt + KEK 派生）

### 5.1 `encryptEnvelope(plaintext, env) → EnvelopeCipher`

```typescript
/**
 * M6.7: 加密 session_key 返回 ciphertext + wrapped_dek（base64 字符串）。
 * 每调用生成新 DEK + 2 个 96-bit nonce（DEK/KEK 各 1）。
 * ciphertext = base64(nonce_12B || AES-GCM-encrypted_data+16B-tag)
 * wrappedDek = base64(nonce_12B || AES-GCM-wrapped_DEK+16B-tag)
 */
export interface EnvelopeCipher {
  ciphertext: string;
  wrappedDek: string;
}

const NONCE_BYTES = 12;
const DEK_BYTES = 32;

export async function encryptEnvelope(
  plaintext: string,
  env: { KEK_SECRET?: string },
): Promise<EnvelopeCipher> {
  const kek = await deriveKek(env);

  // 1. 随机 DEK + DEK 加密 plaintext
  const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
  const nonce1 = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ctBytes = new TextEncoder().encode(plaintext);
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce1 },
    await importKey(dek),
    ctBytes,
  );
  const ciphertext = encodeBase64(concatBytes(nonce1, new Uint8Array(ctBuf)));

  // 2. KEK 加密 DEK
  const nonce2 = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const dekBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce2 },
    kek,
    dek,
  );
  const wrappedDek = encodeBase64(concatBytes(nonce2, new Uint8Array(dekBuf)));

  return { ciphertext, wrappedDek };
}
```

### 5.2 `decryptEnvelope(ciphertext_b64, wrappedDek_b64, env) → string`

```typescript
/**
 * M6.7: 解密 envelope。失败 throw Error("envelope decrypt failed")（KEK 错 / tamper / 格式坏）。
 * 错误由调用方 try/catch 决定是否阻断（如 auth.ts 写失败不阻断登录）。
 */
export async function decryptEnvelope(
  ciphertext_b64: string,
  wrappedDek_b64: string,
  env: { KEK_SECRET?: string },
): Promise<string> {
  const kek = await deriveKek(env);

  // 1. 解 wrappedDek → DEK
  const dekBytes = decodeBase64(wrappedDek_b64);
  const nonce2 = dekBytes.slice(0, NONCE_BYTES);
  const wrappedDekData = dekBytes.slice(NONCE_BYTES);
  let dek: ArrayBuffer;
  try {
    dek = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce2 },
      kek,
      wrappedDekData,
    );
  } catch {
    throw new Error("envelope decrypt failed");
  }

  // 2. 解 ciphertext → plaintext
  const ctRaw = decodeBase64(ciphertext_b64);
  const nonce1 = ctRaw.slice(0, NONCE_BYTES);
  const ctData = ctRaw.slice(NONCE_BYTES);
  let ptBuf: ArrayBuffer;
  try {
    ptBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce1 },
      await importKey(new Uint8Array(dek)),
      ctData,
    );
  } catch {
    throw new Error("envelope decrypt failed");
  }

  return new TextDecoder().decode(ptBuf);
}
```

### 5.3 内部 helper

```typescript
async function deriveKek(env: { KEK_SECRET?: string }): Promise<CryptoKey> {
  if (!env.KEK_SECRET) {
    throw new Error("KEK_SECRET not configured");
  }
  const raw = new TextEncoder().encode(env.KEK_SECRET);
  const hash = await crypto.subtle.digest("SHA-256", raw);
  // hash 是 32 字节 AES-256 key
  return crypto.subtle.importKey(
    "raw",
    hash,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
```

### 5.4 关键决策

- ✅ `deriveKek` SHA-256 截 32 字节（env 任意长度 secret 统一 raw key；足够安全）
- ✅ nonce 12 字节（AES-GCM 推荐 96-bit；crypto.getRandomValues 密码学安全）
- ✅ DEK 32 字节（AES-256）
- ✅ `ciphertext` / `wrappedDek` 串行化：base64(nonce || AES-GCM-output)（含 16-byte auth tag）
- ❌ 不存 metadata（algorithm / version）— M6.7 单一算法 AES-256-GCM；如换算法需数据迁移
- ❌ 不做 KEK version 字段（M6.7 范围聚焦单 KEK；未来轮换时再加）

---

## 6. Task 2: `user.ts` 改 + `auth.ts` 改 + `types.ts` 改

### 6.1 `user.ts` 改 `updateUserSessionKey`

```typescript
/**
 * M6.3b 写 session_key（spec §1/§5/§6）。
 * M6.7 改：写 envelope 密文（session_key_ct + session_key_dek）；旧 session_key 列置 NULL。
 * 写失败不阻断（auth.ts try/catch 兜底）。
 *
 * 错误：
 * - sessionKey 空字符串 → skip
 * - KEK_SECRET 缺失 → throw "KEK_SECRET not configured"（auth.ts 透传，不阻断）
 * - encrypt / D1 错误 → 透传
 */
export async function updateUserSessionKey(
  d1: D1Database,
  userId: string,
  sessionKey: string,
  env: { KEK_SECRET?: string },
): Promise<void> {
  if (!sessionKey) return;
  const { ciphertext, wrappedDek } = await encryptEnvelope(sessionKey, env);
  await d1
    .prepare(
      `UPDATE user SET session_key_ct = ?, session_key_dek = ?, session_key = NULL
       WHERE id = ?`,
    )
    .bind(ciphertext, wrappedDek, userId)
    .run();
}
```

### 6.2 `user.ts` 新 `readUserSessionKey`

```typescript
/**
 * M6.7 读 session_key（透明兼容明文）。
 * 新 user：解 envelope 返 plaintext。
 * 老 user（session_key_ct=NULL）：返旧明文 row.session_key。
 * 失败：try/catch 兜底返 null + console.warn。
 *
 * 当前 0 调用方（M6.3b 写而未读）；未来 /auth/wx-user-info 解密用。
 */
export async function readUserSessionKey(
  d1: D1Database,
  userId: string,
  env: { KEK_SECRET?: string },
): Promise<string | null> {
  const row = await d1
    .prepare(
      `SELECT session_key_ct, session_key_dek, session_key
       FROM user WHERE id = ?`,
    )
    .bind(userId)
    .first<{ session_key_ct: string | null; session_key_dek: string | null; session_key: string | null }>();
  if (!row) return null;

  // 新 user：解 envelope
  if (row.session_key_ct && row.session_key_dek) {
    try {
      return await decryptEnvelope(row.session_key_ct, row.session_key_dek, env);
    } catch (err) {
      console.warn(`[envelope] readUserSessionKey decrypt failed for user ${userId}:`, err);
      return null;
    }
  }

  // 老 user：fallback 明文（M6.3b 写入的；M6.7 上线前 user）
  return row.session_key;
}
```

### 6.3 `auth.ts` 改 1 处

```typescript
// M6.7 改：加 env 参数
await updateUserSessionKey(env.DB, user.id, wxRes.session_key, env);
```

### 6.4 `types.ts` Env 加 1 字段

```typescript
export interface Env {
  // ... 现有字段
  KEK_SECRET?: string;  // M6.7: envelope encryption KEK（wrangler secret put 注入）
}
```

### 6.5 关键决策

- ✅ `env` 参数显式传（不全局读 process.env；与现有 user.ts 风格一致）
- ✅ 写时 session_key=NULL（避免明密共存；老 user 重 login 后新行自动 NULL 旧列）
- ✅ 读路径懒 fallback（0 主动迁移）
- ✅ decrypt 失败 try/catch 返 null（admin 排查看到 null 即"明文或损坏"）
- ❌ 不在 readUserSessionKey 抛错（透传给调用方决定）
- ❌ 不做 batch re-encrypt migration（lazy 设计）

---

## 7. Task 3: 测试（envelope.test.ts + user.test.ts）

### 7.1 `apps/api/test/lib/envelope.test.ts` 新 8 测试

```typescript
describe("envelope.encryptEnvelope / decryptEnvelope (M6.7)", () => {
  it("encrypt happy: 返 ciphertext + wrappedDek 都非空 base64", async () => {
    const env = { KEK_SECRET: "test-kek-secret-32-bytes-long-please-please" };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext-session", env);
    expect(ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(wrappedDek).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(wrappedDek.length).toBeGreaterThan(0);
  });

  it("decrypt happy: ciphertext + wrappedDek → 还原 plaintext", async () => {
    const env = { KEK_SECRET: "test-kek-secret-32-bytes-long-please-please" };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext-session", env);
    const decrypted = await decryptEnvelope(ciphertext, wrappedDek, env);
    expect(decrypted).toBe("plaintext-session");
  });

  it("往返: encrypt → decrypt 还原任意 plaintext", async () => {
    const env = { KEK_SECRET: "k" };  // 短 KEK 也应能 round-trip
    const samples = [
      "",
      "abc",
      "session_key_🦊_emoji",
      "中文 + special chars: !@#$%^&*()",
      "x".repeat(1000),
    ];
    for (const s of samples) {
      const { ciphertext, wrappedDek } = await encryptEnvelope(s, env);
      const decrypted = await decryptEnvelope(ciphertext, wrappedDek, env);
      expect(decrypted).toBe(s);
    }
  });

  it("KEK 缺失: env.KEK_SECRET=undefined → throw 'KEK_SECRET not configured'", async () => {
    await expect(encryptEnvelope("x", {})).rejects.toThrow("KEK_SECRET not configured");
    await expect(decryptEnvelope("aGVsbG8=", "d29ybGQ=", {})).rejects.toThrow("KEK_SECRET not configured");
  });

  it("KEK 缺失（空字符串）: env.KEK_SECRET='' → throw", async () => {
    await expect(encryptEnvelope("x", { KEK_SECRET: "" })).rejects.toThrow("KEK_SECRET not configured");
  });

  it("不同 plaintext 两次 encrypt → 不同 ciphertext（DEK 随机）", async () => {
    const env = { KEK_SECRET: "k" };
    const a = await encryptEnvelope("same-plaintext", env);
    const b = await encryptEnvelope("same-plaintext", env);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
  });

  it("decrypt 失败: 篡改 ciphertext 1 byte → throw 'envelope decrypt failed'", async () => {
    const env = { KEK_SECRET: "k" };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext", env);
    // 篡改 ciphertext 中间 1 byte
    const tampered = ciphertext.slice(0, 10) + (ciphertext[10] === "A" ? "B" : "A") + ciphertext.slice(11);
    await expect(decryptEnvelope(tampered, wrappedDek, env)).rejects.toThrow("envelope decrypt failed");
  });

  it("decrypt 失败: 错误 KEK → throw", async () => {
    const env1 = { KEK_SECRET: "k1" };
    const env2 = { KEK_SECRET: "k2" };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext", env1);
    await expect(decryptEnvelope(ciphertext, wrappedDek, env2)).rejects.toThrow("envelope decrypt failed");
  });
});
```

### 7.2 `user.test.ts` 改 + 加 5 测试

```typescript
// 4 旧测试：updateUserSessionKey 改 4 参数（加 env）
await updateUserSessionKey(d1, userId, "session-key", { KEK_SECRET: "test-kek" });

// 5 新测试：
describe("user.updateUserSessionKey (M6.7) envelope 写路径", () => {
  it("写密文: D1 收到 ciphertext/wrappedDek 写入新列，session_key=NULL", async () => {
    // fakeDB 验证 INSERT SQL 包含 3 列：session_key_ct, session_key_dek, session_key=NULL
  });

  it("session_key 空字符串: skip（不抛）", async () => { /* ... */ });
});

describe("user.readUserSessionKey (M6.7) envelope 读路径", () => {
  it("新 user: 解 envelope 返 plaintext", async () => { /* ... */ });
  it("老 user: session_key_ct=NULL 时返旧明文（lazy fallback）", async () => { /* ... */ });
  it("decrypt 失败: try/catch 返 null + console.warn（不抛）", async () => { /* ... */ });
});
```

### 7.3 关键决策

- ✅ fakeDB 模式（与 M6.6 rate-limit 既有模式一致）
- ✅ envelope 测试不依赖 D1（纯函数，env 参数 mock）
- ✅ 8 envelope 测试 + 5 user 测试 = 13 新增（精确）
- ❌ 不验 base64 padding 细节（依赖 Web Crypto + 简单 base64 wrapper）

---

## 8. 数据流

### 8.1 流 A — 写新数据（新 user / 老 user 重 login）

```
1. /auth/wx-login 成功
2. wxRes.session_key = "wx_abc..."
3. await updateUserSessionKey(env.DB, user.id, "wx_abc...", env)
4. encryptEnvelope("wx_abc...", env):
   ├─ DEK = random(32)
   ├─ nonce1 = random(12)
   ├─ ct = AES-GCM(DEK, nonce1, "wx_abc...")  // 16 + 16 + 12 = plaintext_len + 28 bytes
   ├─ KEK = SHA-256(env.KEK_SECRET)[:32]
   ├─ nonce2 = random(12)
   └─ wrappedDek = AES-GCM(KEK, nonce2, DEK)  // 32 + 16 = 48 bytes
5. ciphertext_b64 = base64(nonce1 + ct)
6. wrappedDek_b64 = base64(nonce2 + wrappedDek)
7. D1: UPDATE user SET session_key_ct=?, session_key_dek=?, session_key=NULL WHERE id=?
8. ✅ 写成功（D1 持久化密文 + 清空旧明文）
```

### 8.2 流 B — 读密文（新 user / admin 排查）

```
1. readUserSessionKey(d1, userId, env)
2. row = SELECT session_key_ct, session_key_dek, session_key FROM user WHERE id=?
3. row.session_key_ct = "..."，row.session_key_dek = "..."
4. decryptEnvelope(row.session_key_ct, row.session_key_dek, env):
   ├─ ctBytes = base64Decode(row.session_key_ct)
   ├─ nonce1 = ctBytes[0:12], ctData = ctBytes[12:]
   ├─ KEK = SHA-256(env.KEK_SECRET)[:32]
   ├─ dekBytes = base64Decode(row.session_key_dek)
   ├─ nonce2 = dekBytes[0:12], wrappedDek = dekBytes[12:]
   ├─ DEK = AES-GCM-decrypt(KEK, nonce2, wrappedDek)  // 可能 throw
   ├─ plaintext = AES-GCM-decrypt(DEK, nonce1, ctData)
   └─ return "wx_abc..."
5. ✅ 读成功
```

### 8.3 流 C — 读明文（老 user，session_key_ct=NULL）

```
1. readUserSessionKey(d1, userId, env)
2. row.session_key_ct = NULL
3. → return row.session_key  // "wx_old_plaintext..."
4. ✅ 透明 fallback（M6.3b 写入的明文保留）
```

### 8.4 流 D — KEK 缺失（dev 忘设）

```
1. env.KEK_SECRET = undefined / ""
2. updateUserSessionKey(...):
   ├─ encryptEnvelope 抛 "KEK_SECRET not configured"
   └─ auth.ts 已有 try/catch（行 131-135）→ catch 吞掉，不阻断 jwt 签发
3. ✅ 登录仍成功，但 session_key 没写入
4. console.warn（或 noop）：生产 KEK 缺失应该是 P0 alert（监控）
```

### 8.5 流 E — decrypt 失败（KEK 错 / tamper）

```
1. readUserSessionKey(d1, userId, env_wrong_kek)
2. decryptEnvelope throw "envelope decrypt failed"
3. readUserSessionKey try/catch → console.warn + return null
4. ✅ 读返 null（不抛）；admin 排查看到 null 即"明文或损坏"
```

---

## 9. 错误处理

| 错误场景 | 抛错？ | 调用方行为 |
|---|---|---|
| `encryptEnvelope`: env.KEK_SECRET 缺失 | ✅ throw "KEK_SECRET not configured" | auth.ts try/catch 兜底，不阻断登录 |
| `encryptEnvelope`: Web Crypto 失败（极小概率） | ✅ throw | auth.ts 透传（5xx） |
| `decryptEnvelope`: KEK 错 / tamper / ciphertext 坏 | ✅ throw "envelope decrypt failed" | readUserSessionKey try/catch 返 null + console.warn |
| `updateUserSessionKey`: D1 UPDATE 失败 | ✅ throw | auth.ts try/catch 兜底（同 M6.3b 行为）|
| `updateUserSessionKey`: sessionKey 空字符串 | ❌ 不抛，skip | 微信偶尔返空 session_key（M6.3b 行为）|
| `readUserSessionKey`: user 不存在 | ❌ 不抛，返 null | 调用方决定 |
| `readUserSessionKey`: 老 user 读明文 | ❌ 不抛，返 row.session_key | 透明 fallback |

---

## 10. 测试策略

### 10.1 TDD 流程（每 commit 都走）

```
Task 1: 写 envelope.test.ts 8 测试（RED）→ 写 envelope.ts（GREEN）→ REFACTOR
Task 2: 写 user.test.ts 5 新测试（RED）→ 改 user.ts + auth.ts + types.ts（GREEN）→ REFACTOR
Task 3: 加 migration 0009 → 不需新测试
```

### 10.2 Mock-first 边界

- ✅ envelope 单元测试纯函数（不依赖 D1，env mock）
- ✅ user 单元测试 fakeDB 模式（与 M6.6 rate-limit 一致）
- ❌ 不验 Web Crypto 内部行为（依赖浏览器/CF runtime）
- ❌ 不验 D1 base64 编码存储细节（fakeDB spy 不解析 SQL）

### 10.3 累计测试矩阵

| 测试文件 | 现有 | 新增 | 累计 |
|---|---|---|---|
| `apps/api/test/lib/envelope.test.ts` | 0 | 8 | 8 |
| `apps/api/test/lib/user.test.ts` | 4 | 5 | 9 |
| `apps/api/test/lib/rate-limit.test.ts` | 18 | 0 | 18 |
| `apps/api/test/routes/auth.test.ts` | 13 | 0 | 13 |
| 其他 api 测试 | 89 | 0 | 89 |
| 其他包 | 113 | 0 | 113 |
| **累计** | **251** | **+13** | **264** |

---

## 11. Acceptance Criteria（M6.7 完成定义）

### 11.1 功能 AC

| # | 标准 |
|---|---|
| AC-1 | `envelope.ts` 提供 `encryptEnvelope` + `decryptEnvelope` + 内部 `deriveKek` |
| AC-2 | `encryptEnvelope` 返 `{ ciphertext, wrappedDek }`，均非空 base64 |
| AC-3 | `decryptEnvelope` 还原 plaintext（往返测试通过） |
| AC-4 | `deriveKek` KEK_SECRET 缺失时 throw "KEK_SECRET not configured" |
| AC-5 | `updateUserSessionKey` 写密文路径：session_key_ct + session_key_dek 写入，session_key=NULL |
| AC-6 | `readUserSessionKey` 新 user 解 envelope 返 plaintext |
| AC-7 | `readUserSessionKey` 老 user fallback 旧明文（session_key_ct=NULL 时）|
| AC-8 | `readUserSessionKey` decrypt 失败 try/catch 返 null + console.warn |
| AC-9 | `auth.ts` WX_LOGIN 调 `updateUserSessionKey` 加 env 参数 |
| AC-10 | `types.ts` Env 加 `KEK_SECRET?: string` 字段 |
| AC-11 | `migration/0009` 加 `session_key_ct` + `session_key_dek` 列 |

### 11.2 测试 AC

| # | 标准 |
|---|---|
| AC-12 | `pnpm -F api test` 全绿（**151 用例**：138 旧 + 13 新）|
| AC-13 | 5 包 `pnpm -r typecheck` 全绿 |
| AC-14 | `pnpm -F api build`（wrangler dry-run）成功 |

### 11.3 Dev 验证 AC（CP-5 真接时补）

- 真实 CF Workers 注入 `env.KEK_SECRET` 行为
- 真实 D1 ALTER TABLE 2 列性能（mock-first 不验）
- 真实 Web Crypto AES-GCM 性能（< 5ms 预期，CP-5 验）

### 11.4 文档 AC

| # | 标准 |
|---|---|
| AC-15 | `docs/archive/state/state-m6-7.md` 收尾 |
| AC-16 | `README.md` 加 M6.7 节 |

---

## 12. CP-5 真接路径

M6.7 真接 Cloudflare 1 新增资源（secret）：

1. **新 secret 注入**（P0 备份到密码管理器）：
   ```bash
   pnpm wrangler secret put KEK_SECRET
   # 提示：输入 ≥ 32 字节随机串（建议 `openssl rand -hex 32`）
   # 立即保存到 1Password / Bitwarden（KEK 丢失 = 老 user 密文全废）
   ```
2. **migration 自动跑**：`wrangler d1 migrations apply unequal-db`（0009）
3. **wrangler.jsonc 0 改**（KEK_SECRET 是 secret，不写 vars）
4. **types.ts 已含 KEK_SECRET 字段**（CF runtime 透明注入）
5. **本地 dev 真验**：
   ```bash
   pnpm dev:api  # 跑 wrangler dev，自动读 .dev.vars（wrangler 默认）
   # .dev.vars 加：
   # KEK_SECRET = "dev-kek-32-bytes-long-please-please"
   curl -X POST http://localhost:8787/auth/wx-login -H "Content-Type: application/json" -d '{"code":"mock_code"}'
   # 验 D1 user.session_key_ct/wrappedDek 写入，session_key=NULL
   pnpm wrangler d1 execute unequal-db --local --command "SELECT id, session_key_ct, session_key_dek, session_key FROM user"
   ```
6. **生产监控**：`/stats/login-attempts` 可加"envelope 写入失败率"指标（YAGNI 暂缓）
7. **P0 告警**：KEK_SECRET 缺失 / decrypt 失败率 > 0（CF Workers Analytics 配 alert）

---

## 13. 风险与回滚

### 13.1 风险点

| 风险 | 缓解 | 严重度 |
|---|---|---|
| **KEK 丢失**：env.KEK_SECRET 误删/重生成 → 老 user 密文全不可解 | KEK 强制备份到密码管理器；doc 强提示；未来加 KEK version + 多 KEK 兜底 | HIGH |
| **KEK 弱密钥**：dev 设 8 字符弱密钥 | doc 提示 ≥ 32 字节；启动时 check 长度 < 32 console.warn（不阻断）| MEDIUM |
| **decrypt 失败**：KEK 错 / ciphertext 坏 → throw | readUserSessionKey try/catch 返 null + console.warn；admin 排查看到 null 即"明文或损坏" | LOW |
| **bundle 增 0**（Web Crypto 内置）| 0 | LOW |
| **D1 行大小**：每 user +2 列 ~80 字节 base64 → 实际 ~60 字节 | user 表 < 几千行，总增 < 几百 KB | LOW |
| **migration 老行 NULL**：M6.7 上线前 user session_key_ct=NULL | readUserSessionKey 透明 fallback 旧明文；老 user 重 login 后自然变密文 | LOW |
| **KEK 派生算法变更**：SHA-256 → scrypt 之类 | 派生算法 hardcode；如换需数据迁移（YAGNI）| LOW |
| **写失败不阻断**（KEK 缺失 / D1 错误）| auth.ts 已有 try/catch | LOW（与 M6.3b 一致）|
| **Web Crypto 在 miniflare / Node 18+ 行为差异** | 0 已知差异（miniflare v3+ / Node 18+ 全支持 AES-GCM）| LOW |

### 13.2 回滚策略（每 commit 独立可回滚）

| Commit | 回滚方式 | 影响 |
|---|---|---|
| Task 1 (envelope.ts) | `git revert` | 0 副作用（lib 函数未引用）|
| Task 2 (user.ts + auth.ts + types.ts) | `git revert` + `wrangler d1 migrations apply --rollback 0009` | updateUserSessionKey 退到 M6.3b 明文路径（auth.ts 老代码）；types.ts Env 删 KEK_SECRET |
| Task 3 (migration 0009) | `wrangler d1 migrations apply --rollback 0009` | 删 2 列（orphan 列无副作用）|

**最严重回滚场景**：KEK 丢失（生产）+ 老 user 重 login → ciphertext 写入 + 后续 decrypt 失败
**缓解**：KEK 强制密码管理器备份；KEK version + 多 KEK 兜底（M6.7+ 未来项）

---

## 14. 实施计划

### 14.1 Commit 拆分（4 commit + 1 merge = 5 总）

| # | Commit | 主题 | 测试增量 |
|---|---|---|---|
| 1 | spec | `docs: M6.7 spec — session-key envelope encryption` | 0 |
| 2 | plan | `docs: M6.7 plan — session-key envelope encryption` | 0 |
| 3 | Task 1+2+3 合并 | `feat(api): M6.7 — envelope encryption + 13 tests` | +13 |
| 4 | state + README | `docs: M6.7 state-m6-7.md 收尾 + README M6.7 节` | 0 |
| merge | `worktree-m6-7-envelope → master --no-ff` | — |

**共 4 commit + 1 merge = 5 总**

### 14.2 工作流

- **worktree 隔离**：`git worktree add .claude/worktrees/m6-7-envelope -b worktree-m6-7-envelope`
- **主线程直接做**（M6.3c/d/4/5/6 教训应用）：M6.7 范围聚焦 1 包（api only），主线程 context 足够 handle
- **TDD 严格走**：`tdd-workflow` skill RED → GREEN → REFACTOR
- **CP-1/CP-2/CP-3**：
  - CP-1: 1 commit 内全绿测试
  - CP-2: 主线程独立 typecheck + build
  - CP-3: 主仓库独立验证（merge 后）

### 14.3 验证顺序

每 task 完成后立即跑该 task 局部测试 + typecheck：
- Task 1 → `pnpm -F api test test/lib/envelope.test.ts` + typecheck
- Task 2 → `pnpm -F api test test/lib/user.test.ts` + 全 `pnpm -F api test` + 5 包 typecheck + build
- Task 3 → 主仓库全跑（merge 后）

---

## 15. 累计测试 + 文件清单

### 15.1 仓库测试累计（M6.7 后）

| 包 | 现有 | M6.7 | 累计 |
|---|---|---|---|
| shared | 38 | 0 | 38 |
| api | 138 | +13 | **151** |
| miniprogram | 32 | 0 | 32 |
| admin | 24 | 0 | 24 |
| crawler | 19 | 0 | 19 |
| **累计** | **251** | **+13** | **264** |

### 15.2 文件清单（M6.7 后）

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
| 新文档 | `docs/superpowers/specs/2026-06-16-m6-7-session-key-envelope-design.md` | NEW（本文件）|
| 新文档 | `docs/archive/plans/2026-06-16-m6-7-session-key-envelope.md` | NEW（plan 阶段）|
| 新文档 | `docs/archive/state/state-m6-7.md` | NEW（state 阶段）|
| 改文档 | `README.md` | +50 / -0 |

**共 3 文件改动（1 代码 + 1 路由 + 1 types）+ 1 新 lib + 1 新 migration + 2 新测试 + 2 测试改动 + 4 文档 = 13 总**

---

## 附录 A：关键设计决策记录

| # | 决策 | 理由 | 拒绝方案 |
|---|---|---|---|
| D-1 | Web Crypto AES-256-GCM（0 依赖）| CF Workers / miniflare / Node 18+ 内置；与 M6.6 sha256Identifier 同栈；0 bundle 增 | jose JWE（多 1 序列化层）；libsodium（+150KB bundle）|
| D-2 | KEK 来自 `env.KEK_SECRET`（wrangler secret put）| 与 JWT_SECRET / WX_APP_SECRET / CRON_SECRET 同模式 | wrangler.jsonc vars（明文不生产）；CF Secrets Store（YAGNI 复杂）|
| D-3 | 真 envelope：每条数据独立 DEK + wrappedDek 存表 | KEK 轮换只 re-wrap DEK（不重加密 N 行 ciphertext）| 单 KEK 直接加密（轮换成本 N×UPDATE）|
| D-4 | Lazy 老数据兼容：写时加密 + 读时 fallback 明文 | 0 主动 migration；老 user 重 login 后自然变密文 | Active batch migration（启动阻塞 N×UPDATE）|
| D-5 | KEK 派生：SHA-256(env.KEK_SECRET)[:32] | env 任意长度 secret 统一 32 字节 raw key；简单 | scrypt/argon2（KEK 不存表 brute-force 无意义）|
| D-6 | 写时 `session_key=NULL` | 避免明密共存（安全原则）| 保留旧明文（lazy fallback 仍读，不影响）|
| D-7 | `decryptEnvelope` 失败 throw + `readUserSessionKey` try/catch 返 null | 调用方决定行为；admin 排查看到 null 即"明文或损坏" | decrypt 失败返原 ciphertext（无意义）；throw 透传（admin 排查 5xx）|
| D-8 | base64 串行化：`nonce_12B || AES-GCM-output` | 简单；自包含（nonce + tag + ciphertext）| 单独存 nonce 列（浪费空间）；JSON 序列化（解析成本）|
| D-9 | `env` 参数显式传 | 与 user.ts 既有风格一致 | 全局读 process.env（CF Workers 无 process）|
| D-10 | 0 KEK version + 多 KEK | M6.7 范围聚焦单 KEK；未来轮换时再做 | 提前抽象（YAGNI）|
