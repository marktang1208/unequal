# M6.6 — Rate-Limit 加 IP 维度

**版本**: 2026-06-16
**前置**: M6.5 scheduled handler wrap + admin stats dashboard（已 merge `e31377f`）
**范围**: 1 项 M6.3a 留口加固 — rate-limit 在 per-token 维度基础上加 per-IP 维度（双层独立，任一锁则整体锁）

---

## 1. Requirements

| # | 现状 | 目标 |
|---|---|---|
| 1 | M6.3a 限流按 `sha256(token).slice(0,16)` 标识符，attacker 轮换 wrong-token N 次每次不同 identifier → 永远不触发锁定 | 加 per-IP 维度（`sha256(CF-Connecting-IP).slice(0,16)`），与 per-token 维度独立计数 |
| 2 | `login_attempt` 表仅 `identifier` 列（无 IP 维度）| 加 `client_ip TEXT` 列存 IP hash（不存明文）+ 复合索引 `(client_ip, attempt_type, created_at DESC)` |
| 3 | `checkRateLimit(d1, identifier, type, now, config)` 单维度查询 | 加 `checkRateLimitByIp(d1, clientIpHash, type, now, config)` 镜像签名 + `checkRateLimitDual(d1, identifier, clientIpHash, type, now, config)` 串两次合并 |
| 4 | `/auth/admin-login` + `/auth/wx-login` 调 `checkRateLimit`（per-token only）| 改调 `checkRateLimitDual`，加 `getClientIp(req)` 解析 `CF-Connecting-IP` header |

**为什么 YAGNI 精简**（区别于 state-m6-5.md §"下一步建议" 全 4 项）：

- ✅ 只做 ① rate-limit 加 IP 维度（真实攻击面，0 schema 风险）
- ❌ 不做 ② session_key envelope encryption（需 key management + migration 兼容老数据，独立 1.5d，单独 spec）
- ❌ 不做 ③ D1 token-level mutex（同 token 5 并发窗口窄，DO 已有 inflight 缓解，价值低）
- ❌ 不做 ④ top_failed_identifiers / top_offending_ips（YAGNI：admin /stats dashboard 已有 by_hour + by_type）

---

## 2. Patterns to Mirror

| 类别 | 来源 | 复用方式 |
|---|---|---|
| 哈希 helper | `apps/api/src/lib/rate-limit.ts:66-73` `sha256Identifier` | 新 `sha256ClientIp(ip)` 镜像签名 + 同样 16 字符 hex 截断 |
| 单维度 checkRateLimit | `apps/api/src/lib/rate-limit.ts:83-115` `checkRateLimit` | 新 `checkRateLimitByIp` 镜像签名 + SQL 改 `WHERE client_ip = ?` |
| rate-limit SQL 模式 | `idx_login_attempt_lookup(identifier, attempt_type, created_at DESC)` 索引 | 新 `idx_login_attempt_client_ip(client_ip, attempt_type, created_at DESC)` 镜像 |
| Wrangler vars 配置 | `readRateLimitConfig(env)` 不变 | M6.6 不加新 env（IP 来自 header 而非 env） |
| auth route 调用 | `apps/api/src/routes/auth.ts:88-99, 168-182` 调 `checkRateLimit` | 改调 `checkRateLimitDual`，加 `clientIpHash` 参数 |
| attempt record 模式 | `apps/api/src/lib/rate-limit.ts:120-134` `recordAttempt(d1, id, type, succeeded, now)` | 改签名加 `clientIpHash` 第 6 参数（向后兼容靠测试 helper 包裹） |
| migration 模式 | `migrations/0007_login_attempt_created_at_index.sql` | `0008_login_attempt_client_ip.sql` 镜像：ALTER TABLE + CREATE INDEX |

---

## 3. Architecture Overview

1 项核心改动（双层限流）— 2 个新 lib 函数 + 1 个 migration + 2 处 auth route 调用：

```
─── 核心层（apps/api/src/lib/rate-limit.ts）─────────────────────
新 helper:
  getClientIp(req: Request): string  ← 读 CF-Connecting-IP header，缺则 "unknown"
  sha256ClientIp(ip: string): Promise<string>  ← 完整 IP sha256 截 16 字符

新镜像函数:
  checkRateLimitByIp(d1, clientIpHash, type, now?, config?)  ← SQL WHERE client_ip = ?

新组合函数:
  checkRateLimitDual(d1, identifier, clientIpHash, type, now?, config?)
    ├─ checkRateLimit(...)        ← 现有 per-token 维度（签名不变）
    └─ checkRateLimitByIp(...)    ← 新 per-IP 维度
    → 任一 locked → 整体 locked（retry_after = max(两维度)）

改 recordAttempt(d1, id, type, succeeded, clientIpHash, now)  ← 加 clientIpHash 必填参数

─── 数据层（migrations/0008）───────────────────────────────────
ALTER TABLE login_attempt ADD COLUMN client_ip TEXT;     ← 旧行 NULL
CREATE INDEX idx_login_attempt_client_ip
  ON login_attempt(client_ip, attempt_type, created_at DESC);

─── 路由层（apps/api/src/routes/auth.ts）─────────────────────
WX_LOGIN:
  const clientIp = getClientIp(request)
  const clientIpHash = await sha256ClientIp(clientIp)
  const rateCheck = await checkRateLimitDual(
    env.DB, codeIdentifier, clientIpHash, "wx_code", Date.now(), readRateLimitConfig(env)
  )
  ...
  await recordAttempt(env.DB, codeIdentifier, "wx_code", false, clientIpHash)

ADMIN_LOGIN: 镜像（type="admin"）
```

**关键设计原则**：
- ✅ `checkRateLimit` 签名零变化（向后兼容 109+ 旧测试）
- ✅ recordAttempt 旧 5 个测试调用方手动加第 6 参数（一次性改完）
- ✅ retry_after 合并语义：`max(per_token_retry, per_ip_retry)`（任一先解锁即解锁）
- ✅ client_ip 存 hash 不存明文（PII-safe，与 identifier 字段同模式）
- ✅ "unknown" IP bucket 防御：CF 异常下所有 IP 共享 bucket，但生产 100% 注入 header

---

## 4. Files to Change

### 新建（2 个）

| 文件 | 用途 | 预估行数 |
|---|---|---|
| `apps/api/migrations/0008_login_attempt_client_ip.sql` | ALTER TABLE + CREATE INDEX | 8 |
| `apps/api/migrations/0008_login_attempt_client_ip.down.sql` | DROP INDEX + 旧 SQLite 无 DROP COLUMN → 留空 | 3 |

### 修改（4 个）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `apps/api/src/lib/rate-limit.ts` | +1 helper getClientIp + 1 helper sha256ClientIp + 1 函数 checkRateLimitByIp + 1 函数 checkRateLimitDual + 1 常量 UNKNOWN_IP_HASH + 改 recordAttempt 签名 | +50 / -3 |
| `apps/api/src/routes/auth.ts` | WX_LOGIN 改 checkRateLimitDual + recordAttempt 加 clientIpHash；ADMIN_LOGIN 镜像 | +8 / -3 |
| `apps/api/test/lib/rate-limit.test.ts` | 7 旧测试改 recordAttempt 调用加 clientIpHash 参数 + 11 新测试（ByIp 3 + Dual 4 + getClientIp 3 + sha256ClientIp 1） | +120 / -7 |
| `apps/api/test/routes/auth.test.ts` | 3 新测试（per-IP 锁 1 + per-token 锁 1 + 双层未锁 1） | +30 / -0 |

### 不改（沿用 M6.5）

- ✅ `apps/api/src/routes/cron.ts` — M6.4 cleanup SQL 仍按 `created_at` 删，0 改动
- ✅ `apps/api/src/routes/stats.ts` — M6.5 SQL 仍按 `attempt_type, created_at` 聚合，0 改动（暂不加 top_offending_ips，YAGNI）
- ✅ `apps/api/wrangler.jsonc` — 0 新 env
- ✅ `apps/api/src/index.ts` — 0 改动
- ✅ 其他包（admin / miniprogram / crawler / shared）— 0 改动

---

## 5. Task 1: Helper Functions（`getClientIp` + `sha256ClientIp`）

### 5.1 `getClientIp(req: Request): string`

```typescript
/**
 * M6.6: 读 CF-Connecting-IP header，缺则返 "unknown"。
 * CF 边缘节点自动注入，client 不可伪造（生产 100% 注入）。
 * dev/miniflare 需 mock 头部。
 */
export function getClientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "unknown";
}
```

### 5.2 `sha256ClientIp(ip: string): Promise<string>`

```typescript
/**
 * M6.6: 完整 IP 字符串 sha256 截 16 字符（v4/v6 不区分）。
 * 与 sha256Identifier 镜像签名；PII-safe（同 PII-safe 模式）。
 */
export async function sha256ClientIp(ip: string): Promise<string> {
  if (ip === "unknown") return UNKNOWN_IP_HASH;
  const bytes = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export const UNKNOWN_IP_HASH = "unknown00000000"; // 16 字符固定
```

### 5.3 关键决策

- ❌ 不读 `X-Forwarded-For`（client 可伪造；CF 自动注入 CF-Connecting-IP 已够）
- ❌ 不做 IPv6 /64 prefix 折叠（边缘场景；YAGNI；同 /64 子网换 IP 攻击者需 SLAAC/VPN 成本高）
- ✅ "unknown" 走固定 hash（不重新计算）— 缺 header 请求共享同一 bucket，防御性合并

---

## 6. Task 2: `checkRateLimitByIp` + `checkRateLimitDual`

### 6.1 `checkRateLimitByIp(d1, clientIpHash, type, now?, config?)`

```typescript
/**
 * M6.6: per-IP 维度限流查询（镜像 checkRateLimit 签名）。
 * SQL WHERE client_ip = ?（vs checkRateLimit 的 WHERE identifier = ?）
 * 其他逻辑完全相同：succeeded=0 / created_at > since / 5 阈值。
 */
export async function checkRateLimitByIp(
  d1: D1Database,
  clientIpHash: string,
  type: AttemptType,
  now: number = Date.now(),
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
): Promise<RateLimitResult> {
  const since = now - config.windowMs;
  const countRow = await d1
    .prepare(
      `SELECT COUNT(*) AS c FROM login_attempt
       WHERE client_ip = ? AND attempt_type = ? AND succeeded = 0
         AND created_at > ?`,
    )
    .bind(clientIpHash, type, since)
    .first<{ c: number }>();
  const failedCount = countRow?.c ?? 0;
  if (failedCount < config.maxFailures) {
    return { locked: false, retry_after: 0 };
  }
  const minRow = await d1
    .prepare(
      `SELECT MIN(created_at) AS m FROM login_attempt
       WHERE client_ip = ? AND attempt_type = ? AND succeeded = 0
         AND created_at > ?`,
    )
    .bind(clientIpHash, type, since)
    .first<{ m: number | null }>();
  const oldest = minRow?.m ?? now;
  const retryAfter = Math.max(0, Math.ceil((oldest + config.windowMs - now) / 1000));
  return { locked: true, retry_after: retryAfter };
}
```

### 6.2 `checkRateLimitDual(d1, identifier, clientIpHash, type, now?, config?)`

```typescript
/**
 * M6.6: 双层独立限流（per-token AND per-IP）。
 * 任一维度锁 → 整体锁（retry_after = max(两维度)）。
 * 串行查询（D1 边缘 < 5ms × 2 = 10ms，远低于 HTTP 30s 超时）。
 */
export async function checkRateLimitDual(
  d1: D1Database,
  identifier: string,
  clientIpHash: string,
  type: AttemptType,
  now: number = Date.now(),
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
): Promise<RateLimitResult> {
  const [tokenResult, ipResult] = await Promise.all([
    checkRateLimit(d1, identifier, type, now, config),
    checkRateLimitByIp(d1, clientIpHash, type, now, config),
  ]);
  if (tokenResult.locked) return tokenResult;
  if (ipResult.locked) return ipResult;
  return { locked: false, retry_after: 0 };
}
```

### 6.3 关键决策

- ✅ `Promise.all` 并发而非串行（2 次 SQL 节省 ~5ms）
- ✅ 任一锁即整体锁（"AND" 语义：per-token 通过 AND per-IP 通过才不锁）
- ✅ `retry_after = max(两维度)`（保守：最久解锁时间 = 实际解锁时间）
- ✅ `checkRateLimit` 签名零变化（向后兼容 109+ 旧测试）
- ✅ `checkRateLimitByIp` 接受 `UNKNOWN_IP_HASH`（"unknown" bucket 查询：所有缺 IP 请求共享）

---

## 7. Task 3: `recordAttempt` 扩展 + auth route 改造

### 7.1 `recordAttempt` 签名扩展

```typescript
// M6.6 改：加 clientIpHash 第 6 必填参数
export async function recordAttempt(
  d1: D1Database,
  identifier: string,
  type: AttemptType,
  succeeded: boolean,
  clientIpHash: string,   // M6.6: 新增必填
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

### 7.2 auth.ts 改动（2 处）

**WX_LOGIN**:
```typescript
// 加：获取 client IP + hash
const clientIp = getClientIp(request);
const clientIpHash = await sha256ClientIp(clientIp);

// 改：checkRateLimit → checkRateLimitDual
const rateCheck = await checkRateLimitDual(
  env.DB, codeIdentifier, clientIpHash, "wx_code", Date.now(), readRateLimitConfig(env),
);

// 改：recordAttempt 加 clientIpHash 第 5 参数
await recordAttempt(env.DB, codeIdentifier, "wx_code", false, clientIpHash);
```

**ADMIN_LOGIN**: 镜像（type="admin"）

### 7.3 关键决策

- ✅ `clientIpHash` 必填（不设默认值）— 调用方显式表达"已知 IP"或"unknown"
- ❌ 不向后兼容旧 `recordAttempt(id, type, succeeded, now)` 签名（旧 5 测试手动改）
- ❌ 不做批量迁移（migration 0008 上线后旧 attempt.client_ip = NULL 即可）

---

## 8. Task 4: `migrations/0008_login_attempt_client_ip.sql`

```sql
-- M6.6: 加 client_ip 列（per-IP 限流数据源）
-- 存 sha256(ip).slice(0,16) 不存明文（防 PII）
-- 可空：M6.6 上线前的旧 attempt 行 client_ip = NULL
ALTER TABLE login_attempt ADD COLUMN client_ip TEXT;

-- 新索引：per-IP 限流查询 (client_ip, attempt_type, created_at) 复合
CREATE INDEX IF NOT EXISTS idx_login_attempt_client_ip
  ON login_attempt(client_ip, attempt_type, created_at DESC);
```

`0008_login_attempt_client_ip.down.sql`:
```sql
-- SQLite < 3.35 不支持 DROP COLUMN
-- DOWN: 仅 drop index（不影响 client_ip 列；orphan column 无副作用）
DROP INDEX IF EXISTS idx_login_attempt_client_ip;
```

---

## 9. 数据流

### 9.1 流 A: per-IP 锁（同 IP 5 不同 token — **新场景**）

```
T0: attacker IP 1.2.3.4 调 /auth/admin-login { admin_token: "wrong-1" }
    → getClientIp → "1.2.3.4"
    → sha256ClientIp("1.2.3.4") → "ip1hash"
    → checkRateLimitDual:
        per-token("wrong-1-hash"): COUNT=0 → not locked
        per-ip("ip1hash"):         COUNT=0 → not locked
    → not locked → verifyAdminToken → 401
    → recordAttempt(id="wrong-1-hash", type="admin", succeeded=false, clientIpHash="ip1hash")
    → D1: INSERT (id, identifier="wrong-1-hash", attempt_type="admin", succeeded=0, client_ip="ip1hash", created_at=T0)

T0+1s: IP 1.2.3.4 调 { admin_token: "wrong-2" } → recordAttempt ("wrong-2-hash", "ip1hash")
T0+2s: { "wrong-3" } → recordAttempt ("wrong-3-hash", "ip1hash")
T0+3s: { "wrong-4" } → recordAttempt ("wrong-4-hash", "ip1hash")
T0+4s: { "wrong-5" } → recordAttempt ("wrong-5-hash", "ip1hash")
  → 5 行 client_ip="ip1hash"

T0+5s: { "wrong-6" }
    → checkRateLimitDual:
        per-token("wrong-6-hash"): COUNT=0 → not locked
        per-ip("ip1hash"):         COUNT=5 (succeeded=0) → **LOCKED, retry_after=900**
    → 429 RATE_LIMITED { retry_after: 900 }
    ✅ per-IP 维度生效（旧版 per-token 永远不锁）
```

### 9.2 流 B: per-token 锁（5 同 token 不同 IP — 旧行为保留）

```
T0: IP 1.2.3.4 { "wrong-1" } → recordAttempt ("wrong-1-hash", "ip1hash")
T0+1s: IP 2.3.4.5 { "wrong-1" } → recordAttempt ("wrong-1-hash", "ip2hash")
T0+2s: IP 3.4.5.6 { "wrong-1" } → recordAttempt ("wrong-1-hash", "ip3hash")
T0+3s: IP 4.5.6.7 { "wrong-1" } → recordAttempt ("wrong-1-hash", "ip4hash")
T0+4s: IP 5.6.7.8 { "wrong-1" } → recordAttempt ("wrong-1-hash", "ip5hash")
  → 5 行 identifier="wrong-1-hash"，client_ip 各不同

T0+5s: IP 6.7.8.9 { "wrong-1" }
    → checkRateLimitDual:
        per-token("wrong-1-hash"): COUNT=5 → **LOCKED, retry_after=900**
        per-ip("ip6hash"):         COUNT=0 → not locked
    → 429 RATE_LIMITED
    ✅ per-token 维度保留（M6.3a 旧行为不变）
```

### 9.3 流 C: 双层未锁

```
T0: IP 1.2.3.4 { "wrong-1" }
    → checkRateLimitDual:
        per-token("wrong-1-hash"): COUNT=0
        per-ip("ip1hash"):         COUNT=0
    → not locked → verifyAdminToken → 401
    → recordAttempt
    → 行 identifier="wrong-1-hash", client_ip="ip1hash"
```

### 9.4 流 D: "unknown" IP（无 CF header — dev/test）

```
req 无 CF-Connecting-IP header
  → getClientIp → "unknown"
  → sha256ClientIp("unknown") → UNKNOWN_IP_HASH = "unknown00000000"
  → checkRateLimitDual:
      per-token: COUNT=0 → not locked
      per-ip("unknown00000000"): COUNT=0 → not locked (dev 无 attempt 行)
  → not locked → 正常流程
  → recordAttempt(clientIpHash="unknown00000000")
  → 所有 dev/test 请求共享 "unknown00000000" bucket（生产无此场景）
```

---

## 10. 错误处理

### 10.1 getClientIp 异常

- 缺 `CF-Connecting-IP` header → 返 `"unknown"`（非 throw；与现有 HttpError 模式一致）
- 多次空 header 合并到 UNKNOWN_IP_HASH bucket（防御性）

### 10.2 sha256ClientIp 异常

- 几乎不可能 throw（Web Crypto 内置）；即使 throw 也仅影响该次限流（异常透传由调用方 handleHttpError 兜底返 500）

### 10.3 checkRateLimitDual 异常

- 任一 SQL 失败 throw → 透传（与现有 checkRateLimit 一致，handleHttpError 兜底 500）
- 不做"per-token SQL 失败降级 per-IP 锁"（YAGNI；统一 500 行为）

### 10.4 recordAttempt 异常

- D1 写入失败 throw → 透传（auth.ts 既有 500 处理）
- 不做"attempt 失败不阻断"逻辑（与现有行为一致）

### 10.5 migration 0008 异常

- ALTER TABLE 失败（极小概率）→ wrangler migrations apply 报 4xx/5xx → 部署阻断
- 重复应用 → `IF NOT EXISTS` 索引保护；ALTER COLUMN NOT EXISTS 报错但 migration 工具幂等

---

## 11. 测试策略

### 11.1 TDD 流程（每 commit 都走）

**Task 1 commit 顺序**（先 helper，再镜像函数，再组合，再改 recordAttempt，最后改 auth）：

```
Task 1a: 写 getClientIp + sha256ClientIp + UNKNOWN_IP_HASH 测试（5 用例）→ 写实现
Task 1b: 写 checkRateLimitByIp 测试（3 用例）→ 写实现
Task 1c: 写 checkRateLimitDual 测试（4 用例）→ 写实现
Task 1d: 改 recordAttempt 签名 → 改 7 旧测试调用方
Task 1e: 改 auth.ts WX_LOGIN + ADMIN_LOGIN → 加 3 新测试
Task 1f: 加 migration 0008 → 不需新测试（migration 自身不逻辑）
```

**RED → GREEN → REFACTOR** 严格走 ECC `tdd-workflow` skill。

### 11.2 Mock-first 边界

- ✅ D1 用 fakeDB pattern（spy prepare/bind/run/all；M6.3a 既有模式）
- ✅ CF-Connecting-IP header 在 fake req.headers mock
- ❌ 不验 miniflare 真 IP 注入（CP-5 真接时验）
- ❌ 不验 D1 SQL 索引命中（CP-5 真接时 EXPLAIN）

### 11.3 累计测试矩阵

| 测试文件 | 现有 | 新增 | 累计 |
|---|---|---|---|
| `apps/api/test/lib/rate-limit.test.ts` | 7 | 11 (ByIp 3 + Dual 4 + getClientIp 3 + sha256ClientIp 1) | 18 |
| `apps/api/test/routes/auth.test.ts` | 18 | 3 (per-IP 锁 1 + per-token 锁 1 + 双层未锁 1) | 21 |
| 其他包 | 212 | 0 | 212 |
| **累计** | **237** | **+14** | **251** |

---

## 12. Acceptance Criteria（M6.6 完成定义）

### 12.1 功能 AC

| # | 标准 |
|---|---|
| AC-1 | `getClientIp(req)` 在 `CF-Connecting-IP` header 存在时返回该值；缺则返回 `"unknown"`（大小写不敏感）|
| AC-2 | `sha256ClientIp(ip)` 返 16 字符 hex；同输入多次调用结果一致（deterministic）|
| AC-3 | `UNKNOWN_IP_HASH = "unknown00000000"` 16 字符固定值 |
| AC-4 | `checkRateLimitByIp` 镜像 `checkRateLimit` 行为，仅 SQL `WHERE client_ip = ?` 不同 |
| AC-5 | `checkRateLimitDual` 任一维度锁即整体锁；retry_after = max(两维度) |
| AC-6 | `recordAttempt` 新签名加 `clientIpHash` 必填参数；DB INSERT 写 `client_ip` 列 |
| AC-7 | `authRoute.WX_LOGIN` + `authRoute.ADMIN_LOGIN` 改调 `checkRateLimitDual`，加 `getClientIp` + `sha256ClientIp` |
| AC-8 | migration 0008 加 `client_ip` 列 + `idx_login_attempt_client_ip` 复合索引 |

### 12.2 测试 AC

| # | 标准 |
|---|---|
| AC-9 | `pnpm -F api test` 全绿（**251 用例**：237 旧 + 14 新）|
| AC-10 | 5 包 `pnpm -r typecheck` 全绿 |
| AC-11 | `pnpm -F api build`（wrangler dry-run）成功 |

### 12.3 Dev 验证 AC（CP-5 真接时补）

- 真实 CF 边缘注入 `CF-Connecting-IP` 行为（miniflare 不模拟）
- 真实 D1 SQL `checkRateLimitByIp` 索引命中（< 5ms 预期）
- 真实 D1 ALTER TABLE + CREATE INDEX 性能（mock-first 不验）

### 12.4 文档 AC

| # | 标准 |
|---|---|
| AC-12 | `docs/superpowers/state-m6-6.md` 收尾（含 8 偏差 + 7 遗留 + 7 dev 验证缺口 + 累计 251 + 下一步建议）|
| AC-13 | `README.md` 加 M6.6 节（per-IP 锁新行为 + 测试矩阵 + mock-first 限制）|

---

## 13. CP-5 真接路径

M6.6 真接 Cloudflare 0 新增资源：

1. **无需新 secret** — 沿用 M6.2 + M6.4（JWT_SECRET / WX_APP_SECRET / CRON_SECRET）
2. **无需新 D1** — `wrangler d1 migrations apply unequal-db` 自动跑 0008
3. **无需新 env** — 沿用 M6.4 LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS
4. **wrangler.jsonc 0 改** — IP 来自 header 而非 env
5. **真 CF 自动注入** — `CF-Connecting-IP: 1.2.3.4` header 透明注入（不可伪造，CF 边缘节点权威源）
6. **本地 dev 真验**：
   ```bash
   pnpm dev:api  # 跑 wrangler dev
   # 验 per-IP 锁
   for token in wrong1 wrong2 wrong3 wrong4 wrong5 wrong6; do
     curl -X POST http://localhost:8787/auth/admin-login \
       -H "CF-Connecting-IP: 1.2.3.4" \
       -H "Content-Type: application/json" \
       -d "{\"admin_token\":\"$token\"}" -w "\n%{http_code}\n"
   done
   # 1-5: 401 / 6: 429 RATE_LIMITED { retry_after: 900 }
   ```
7. **生产监控**：`/stats/login-attempts` 路由可加 `top_offending_ips` 扩展（**YAGNI 暂缓**）

---

## 14. 风险与回滚

### 14.1 风险点

| 风险 | 缓解 | 严重度 |
|---|---|---|
| `client_ip` 列缺（无 CF header）→ "unknown" bucket 合并攻击 | "unknown" 仅在 CF 异常或测试用；生产 100% 注入 | LOW（CF 异常 ≠ 攻击）|
| admin 误锁 UX：admin 输 5 次错 token 锁本机 IP 15min | 可接受折中（等 15min / 换 IP / VPN）| MEDIUM（admin 是低频操作）|
| per-IP 计数跨 attempt_type 混算？ | SQL 仍带 `attempt_type = ?`；admin / wx_code 独立 5/15min | LOW（已设计避免）|
| migration 0008 旧行 client_ip = NULL | `checkRateLimitByIp` SQL `WHERE client_ip = ?`，NULL ≠ 任何 hash → 0 命中 | LOW（安全）|
| D1 表变胖 50%（client_ip 16 字符 + 索引） | 5x 用户量 50k 行 / 15min = 800 KB / 15min；cron 24h 清理后 < 2 MB | LOW |
| `checkRateLimitDual` 跑 2 次 SQL 性能 | D1 边缘 < 5ms/次 → 2 次 < 10ms（远低于 HTTP 30s 超时）；`Promise.all` 并发 | LOW |
| `recordAttempt` 签名破坏 5 旧测试 | 一次性改完，CI 全绿 | LOW（已知）|
| `getClientIp` 大小写敏感性 | HTTP/2 规范 header 名小写；`req.headers.get` 大小写不敏感（CF runtime 行为）| LOW |

### 14.2 回滚策略（每 commit 独立可回滚）

| Commit | 回滚方式 | 影响 |
|---|---|---|
| Task 1a (helper) | `git revert` | 0（纯函数，0 副作用）|
| Task 1b (checkRateLimitByIp) | `git revert` | 0（未被调用）|
| Task 1c (checkRateLimitDual) | `git revert` | 0（未被调用）|
| Task 1d (recordAttempt 改签名) | `git revert` | 旧 5 测试签名恢复，0 行为变化 |
| Task 1e (auth.ts 改调) | `git revert` | 双层限流回退到单层（per-token only），攻击面恢复 |
| Task 1f (migration 0008) | `wrangler d1 migrations apply --rollback 0008` | 删 client_ip 列（旧 0 引用）|

---

## 15. 实施计划

### 15.1 Commit 拆分（5 commit + 1 merge = 6 总）

| # | Commit | 主题 | 测试增量 |
|---|---|---|---|
| 1 | spec | `docs: M6.6 spec — rate-limit 加 IP 维度` | 0 |
| 2 | plan | `docs: M6.6 plan — rate-limit 加 IP 维度` | 0 |
| 3 | Task 1a-c | `feat(api): rate-limit helpers (getClientIp + sha256ClientIp + checkRateLimitByIp + checkRateLimitDual) + 11 tests` | +11 |
| 4 | Task 1d | `refactor(api): recordAttempt 签名加 clientIpHash 必填参数` | 0（5 旧测试改完）|
| 5 | Task 1e | `feat(api): auth.ts 改调 checkRateLimitDual + migration 0008 + 3 tests` | +3 |
| 6 | state | `docs: M6.6 state-m6-6.md 收尾 + README M6.6 节` | 0 |
| 7 | merge | `worktree-m6-6-rate-limit-ip → master --no-ff` | — |

**共 7 commit（含 spec/plan/state/README）+ 1 merge = 8 总**

### 15.2 工作流

- **worktree 隔离**：`git worktree add .claude/worktrees/m6-6-rate-limit-ip -b worktree-m6-6-rate-limit-ip`
- **主线程直接做**（M6.3c/d/4 教训应用）：M6.6 范围聚焦 1 包（api only），主线程 context 足够 handle
- **TDD 严格走**：`tdd-workflow` skill RED → GREEN → REFACTOR
- **CP-1/CP-2/CP-3**：
  - CP-1: 5 commit 内全绿测试
  - CP-2: 14 新增测试全过
  - CP-3: 主线程独立 typecheck + build
- **merge**：user 显式 `merge --no-ff`（destructive 操作，主线程不擅自动）

---

## 16. 累计测试 + 文件清单

### 16.1 仓库测试累计（M6.6 后）

| 包 | 现有 | M6.6 | 累计 |
|---|---|---|---|
| shared | 38 | 0 | 38 |
| api | 124 | +14 | **138** |
| miniprogram | 32 | 0 | 32 |
| admin | 24 | 0 | 24 |
| crawler | 19 | 0 | 19 |
| **累计** | **237** | **+14** | **251** |

### 16.2 文件清单（M6.6 后）

| 类型 | 文件 | 状态 |
|---|---|---|
| 新代码 | `apps/api/migrations/0008_login_attempt_client_ip.sql` | NEW |
| 新代码 | `apps/api/migrations/0008_login_attempt_client_ip.down.sql` | NEW |
| 改代码 | `apps/api/src/lib/rate-limit.ts` | +50 / -3 |
| 改代码 | `apps/api/src/routes/auth.ts` | +8 / -3 |
| 改测试 | `apps/api/test/lib/rate-limit.test.ts` | +120 / -7 |
| 改测试 | `apps/api/test/routes/auth.test.ts` | +30 / -0 |
| 新文档 | `docs/superpowers/specs/2026-06-16-m6-6-rate-limit-ip-design.md` | NEW（本文件）|
| 新文档 | `docs/superpowers/plans/2026-06-16-m6-6-rate-limit-ip.md` | NEW（plan 阶段）|
| 新文档 | `docs/superpowers/state-m6-6.md` | NEW（state 阶段）|
| 改文档 | `README.md` | +50 / -0 |

**共 6 个文件改动（4 代码 + 2 测试）+ 4 个文档（3 新 + 1 改）= 10 总**

---

## 附录 A：关键设计决策记录

| # | 决策 | 理由 | 拒绝方案 |
|---|---|---|---|
| D-1 | 双层独立（per-token + per-IP 各自 1 次 SQL）| 真解决"换 token 5 次"绕过 | 复合 key（不解决：5 token = 5 不同 key）；单 SQL OR（复杂度高）|
| D-2 | `Promise.all` 并发 2 次 SQL | 节省 ~5ms（vs 串行）| 串行（简单但慢 5ms）|
| D-3 | `retry_after = max(两维度)` | 保守：最久解锁 = 实际解锁 | min（乐观，attacker 可继续重试）|
| D-4 | `client_ip` 存 hash 不存明文 | PII-safe；与 identifier 同模式 | 明文（GDPR 风险）|
| D-5 | "unknown" IP 走固定 UNKNOWN_IP_HASH | 所有缺 header 请求共享 bucket（防御性合并）| 重新计算 hash（每次不同，分散攻击面）|
| D-6 | `clientIpHash` 必填参数（无默认值）| 调用方显式表达"已知 IP"或"unknown" | 可选默认（隐式行为，易错）|
| D-7 | 0 新 env（IP 来自 header）| CF 透明注入，wrangler 0 改 | 新 env 配置 proxy 链（YAGNI）|
| D-8 | migration 0008 down 仅 DROP INDEX | SQLite < 3.35 不支持 DROP COLUMN；orphan client_ip 列无副作用 | DOWN 也删列（破坏向后兼容）|
| D-9 | `getClientIp` 仅读 CF-Connecting-IP | CF 权威源，不可伪造 | 读 X-Forwarded-For（可伪造）|
| D-10 | 完整 IP 字符串 sha256（v4/v6 不区分）| 最简；与 sha256Identifier 同模式 | IPv6 /64 prefix 折叠（边缘场景，30+ 行额外代码）|
