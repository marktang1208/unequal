# M6.10 — Admin IP Allowlist

**版本**: 2026-06-16
**前置**: M6.9 D1 token-level mutex (defensive)（已 merge `33c8db4`）
**范围**: 1 项 admin 误锁 UX 优化 — `env.ADMIN_IP_ALLOWLIST` 白名单 IP 跳过 /auth/admin-login 的 rate-limit（M6.6 per-IP 锁）

---

## 1. Requirements

| # | 现状 | 目标 |
|---|---|---|
| 1 | admin 输错 5 次 admin_token → per-IP 锁本机 IP 15min（用户体验差）| `env.ADMIN_IP_ALLOWLIST` 静态 IP 列表，admin IP 跳过 rate-limit |
| 2 | per-token 限流仍生效（防御 5 错锁）| 仅 per-IP 跳过；per-token 仍锁（双层独立）|

**价值评估**：
- admin 是低频操作（每天 ~10 次）；误锁 15min 成本低
- 价值低但 UX 改善；admin 静态 IP 已知时低成本
- 失败模式：admin 配错白名单（dev 默认空 = 行为不变）

**为什么 YAGNI 精简**：
- ❌ 不做 admin 手动 unlock endpoint（admin 仍可等 15min；新增 endpoint 价值低）
- ❌ 不做阈值从 5 提到 10（安全降低；与攻击者面同）
- ✅ 只做 IP 白名单（env 配置；admin 静态 IP 即可解锁）

---

## 2. Patterns to Mirror

| 类别 | 来源 | 复用方式 |
|---|---|---|
| env 配置 | `apps/api/wrangler.jsonc` `vars` 块（M6.4 LOGIN_MAX_ATTEMPTS 等）| `env.ADMIN_IP_ALLOWLIST` 是 vars（comma-separated IP 列表）|
| IP 解析 | `apps/api/src/lib/rate-limit.ts` `readRateLimitConfig` | `parseAdminIpAllowlist` 类似 `parseInt fallback` 模式 |
| auth route 调用 | `apps/api/src/routes/auth.ts:171-182` checkRateLimitDual 前置 | M6.10 加白名单 check 前置 |

---

## 3. Architecture Overview

1 项核心改动（IP 白名单）— 1 新 lib + 1 改 auth.ts + 1 改 types.ts：

```
─── 核心层（apps/api/src/lib/admin-ip-allowlist.ts）────────────
新 parseAdminIpAllowlist(env) → string[]:
  if (!env.ADMIN_IP_ALLOWLIST) return []
  return env.ADMIN_IP_ALLOWLIST.split(",").map(s => s.trim()).filter(s => s.length > 0)

新 isAdminIpAllowed(clientIp, allowlist) → boolean:
  return allowlist.includes(clientIp)

─── 路由层（apps/api/src/routes/auth.ts）─────────────────────
ADMIN_LOGIN 改：
  const clientIp = getClientIp(request)
  const allowlist = parseAdminIpAllowlist(env)
  const isAdminIp = isAdminIpAllowed(clientIp, allowlist)
  
  if (!isAdminIp) {
    // 白名单外：正常 rate-limit
    rateCheck = await checkRateLimitDual(...)
  } else {
    // 白名单内：跳过 rate-limit
    rateCheck = { locked: false, retry_after: 0 }
  }
  if (rateCheck.locked) { /* 429 ... */ }
  // verifyAdminToken ... 同 M6.6

─── types.ts Env 加 1 字段 ────────────────────────────────────
ADMIN_IP_ALLOWLIST?: string  // M6.10: admin IP 白名单（comma-separated；空 = 行为不变）
```

**关键设计原则**：
- ✅ 仅 /auth/admin-login 受影响（wx-login 不变 — 微信小程序是普通用户）
- ✅ 白名单空 = 行为不变（向后兼容 M6.6）
- ✅ ADMIN_IP_ALLOWLIST 未设 = 白名单空 = 行为不变
- ✅ per-token 限流仍生效（白名单仅跳过 per-IP 限流）
- ✅ 0 新依赖 / 0 schema 改动
- ❌ 不做 IPv6 CIDR 范围（白名单通常 1-5 个 IP；comma-separated 够用）

---

## 4. Files to Change

### 新建（2 个）

| 文件 | 内容 | 预估行数 |
|---|---|---|
| `apps/api/src/lib/admin-ip-allowlist.ts` | `parseAdminIpAllowlist` + `isAdminIpAllowed` | ~20 |
| `apps/api/test/lib/admin-ip-allowlist.test.ts` | 5 测试 | ~50 |

### 修改（2 个）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `apps/api/src/routes/auth.ts` | ADMIN_LOGIN 加白名单 check 前置 | +6 / -2 |
| `apps/api/src/types.ts` | Env 加 `ADMIN_IP_ALLOWLIST?: string` | +1 / -0 |

### 不改（沿用 M6.9）

- ✅ `apps/api/src/lib/rate-limit.ts` — 0 改动
- ✅ `apps/api/src/lib/token-mutex.ts` — 0 改动
- ✅ `apps/api/src/lib/envelope.ts` — 0 改动
- ✅ `apps/api/wrangler.jsonc` — 0 改（env.ADMIN_IP_ALLOWLIST 是 vars，运行时注入）
- ✅ 其他包 — 0 跨包

---

## 5. Task 1: `admin-ip-allowlist.ts` 新 lib + auth.ts 改 + types.ts 改 + 7 tests

### 5.1 `admin-ip-allowlist.ts` 实现

```typescript
/**
 * M6.10: admin IP 白名单（spec §5）。
 * 解决：admin 输错 5 次错 admin_token 锁本机 IP 15min UX 差。
 *
 * 配置：env.ADMIN_IP_ALLOWLIST = "1.2.3.4,5.6.7.8,127.0.0.1"
 * 行为：白名单 IP 跳过 /auth/admin-login 的 checkRateLimitDual
 *
 * 失败：未设 / 空 → 白名单空 → 行为不变（正常限流）
 */

export function parseAdminIpAllowlist(env: { ADMIN_IP_ALLOWLIST?: string }): string[] {
  if (!env.ADMIN_IP_ALLOWLIST) return [];
  return env.ADMIN_IP_ALLOWLIST.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

export function isAdminIpAllowed(clientIp: string, allowlist: string[]): boolean {
  return allowlist.includes(clientIp);
}
```

### 5.2 `auth.ts` 改 1 处

```typescript
import { parseAdminIpAllowlist, isAdminIpAllowed } from "../lib/admin-ip-allowlist.js";

// ADMIN_LOGIN 内部（在 clientIpHash 后）：
const clientIp = getClientIp(request);
const adminAllowlist = parseAdminIpAllowlist(env);
const isAdminIp = isAdminIpAllowed(clientIp, adminAllowlist);

let rateCheck = { locked: false, retry_after: 0 };
if (!isAdminIp) {
  rateCheck = await checkRateLimitDual(
    env.DB, adminIdentifier, clientIpHash, "admin", Date.now(), readRateLimitConfig(env),
  );
}
if (rateCheck.locked) {
  return Response.json(
    {
      error: "RATE_LIMITED",
      message: "Too many failed admin login attempts. Try again later.",
      retry_after: rateCheck.retry_after,
    },
    { status: 429 },
  );
}
```

### 5.3 `types.ts` Env 加 1 字段

```typescript
// M6.10: admin IP 白名单（comma-separated；空 = 行为不变）
ADMIN_IP_ALLOWLIST?: string;
```

### 5.4 关键决策

- ✅ `clientIp` 明文（getClientIp 返）— 白名单是 admin 配置的明文 IP
- ✅ 白名单空 / undefined = 行为不变（向后兼容 M6.6）
- ✅ 仅 /auth/admin-login 受影响（wx-login 不变）
- ✅ per-token 限流仍生效（白名单仅跳过 per-IP）
- ❌ 不做 IPv6 CIDR 范围（白名单通常 1-5 个 IP；comma-separated 够用）
- ❌ 不做白名单动态更新（YAGNI；wrangler vars restart 即可）

---

## 6. Task 2: 测试（5 新增 admin-ip-allowlist + 2 新增 auth）

### 6.1 `admin-ip-allowlist.test.ts` 5 新增

```typescript
describe("admin-ip-allowlist.parseAdminIpAllowlist (M6.10)", () => {
  it("env 未设 → 返 []", () => {
    expect(parseAdminIpAllowlist({})).toEqual([]);
  });
  it("env.ADMIN_IP_ALLOWLIST = '' → 返 []", () => {
    expect(parseAdminIpAllowlist({ ADMIN_IP_ALLOWLIST: "" })).toEqual([]);
  });
  it("env.ADMIN_IP_ALLOWLIST = '1.2.3.4' → 返 ['1.2.3.4']", () => {
    expect(parseAdminIpAllowlist({ ADMIN_IP_ALLOWLIST: "1.2.3.4" })).toEqual(["1.2.3.4"]);
  });
  it("env.ADMIN_IP_ALLOWLIST = '1.2.3.4,5.6.7.8,127.0.0.1' → 返 3 个", () => {
    expect(parseAdminIpAllowlist({ ADMIN_IP_ALLOWLIST: "1.2.3.4,5.6.7.8,127.0.0.1" })).toEqual(["1.2.3.4", "5.6.7.8", "127.0.0.1"]);
  });
  it("env.ADMIN_IP_ALLOWLIST = '1.2.3.4, 5.6.7.8, , ' → trim + filter 空 → 2 个", () => {
    expect(parseAdminIpAllowlist({ ADMIN_IP_ALLOWLIST: "1.2.3.4, 5.6.7.8, , " })).toEqual(["1.2.3.4", "5.6.7.8"]);
  });
});

describe("admin-ip-allowlist.isAdminIpAllowed (M6.10)", () => {
  it("命中: clientIp 在白名单 → true", () => {
    expect(isAdminIpAllowed("1.2.3.4", ["1.2.3.4", "5.6.7.8"])).toBe(true);
  });
  it("未命中: clientIp 不在白名单 → false", () => {
    expect(isAdminIpAllowed("9.9.9.9", ["1.2.3.4", "5.6.7.8"])).toBe(false);
  });
  it("空白名单 → false", () => {
    expect(isAdminIpAllowed("1.2.3.4", [])).toBe(false);
  });
});
```

### 6.2 `auth.test.ts` 2 新增

```typescript
// 1. admin IP 在白名单: 5 次错不锁（跳过 rate-limit）
it("admin IP 白名单: 5 次错 admin_token 不锁（env.ADMIN_IP_ALLOWLIST 含 client IP）", async () => {
  const env = { ..., ADMIN_IP_ALLOWLIST: "1.2.3.4" };
  // 5 次错 token → 全部 401（不应 429）
  for (let i = 0; i < 5; i++) {
    const res = await authRoute.ADMIN_LOGIN(req_with_cf_connecting_ip_1_2_3_4, env);
    expect(res.status).toBe(401);
  }
  // 第 6 次：仍 401（per-token 不锁；admin 限流已跳过）
  const res6 = await authRoute.ADMIN_LOGIN(req_with_cf_connecting_ip_1_2_3_4, env);
  expect(res6.status).toBe(401);  // 不是 429
});

// 2. admin IP 不在白名单: 5 次错后锁（per-IP 限流）
it("admin IP 不在白名单: 5 次错 admin_token → 第 6 次 429", async () => {
  const env = { ..., ADMIN_IP_ALLOWLIST: "1.2.3.4" };
  // 5 次错 token → 全部 401
  for (let i = 0; i < 5; i++) {
    const res = await authRoute.ADMIN_LOGIN(req_with_cf_connecting_ip_9_9_9_9, env);
    expect(res.status).toBe(401);
  }
  // 第 6 次：429（per-IP 限流生效）
  const res6 = await authRoute.ADMIN_LOGIN(req_with_cf_connecting_ip_9_9.9.9, env);
  expect(res6.status).toBe(429);
});
```

---

## 7. 数据流

### 7.1 流 A — admin IP 在白名单

```
1. /auth/admin-login 调（client CF-Connecting-IP: 1.2.3.4）
2. clientIp = "1.2.3.4"
3. allowlist = parseAdminIpAllowlist(env) = ["1.2.3.4", "5.6.7.8", "127.0.0.1"]
4. isAdminIp = isAdminIpAllowed("1.2.3.4", allowlist) = true
5. skip checkRateLimitDual → rateCheck = { locked: false }
6. verifyAdminToken → admin 输入错 → 401
7. recordAttempt(per-token 仍锁)
8. 输错 5 次后：per-token 限流可能 lock；per-IP 跳过
9. ✅ admin IP 不锁（用户友好）
```

### 7.2 流 B — admin IP 不在白名单

```
1. /auth/admin-login 调（client CF-Connecting-IP: 9.9.9.9）
2. allowlist = ["1.2.3.4", "5.6.7.8", "127.0.0.1"]
3. isAdminIp = isAdminIpAllowed("9.9.9.9", allowlist) = false
4. checkRateLimitDual(...)  // 正常限流
5. 输错 5 次后 429（与 M6.6 行为一致）
```

### 7.3 流 C — 白名单未设

```
1. env.ADMIN_IP_ALLOWLIST = undefined
2. allowlist = parseAdminIpAllowlist(env) = []
3. isAdminIp = isAdminIpAllowed(clientIp, []) = false
4. checkRateLimitDual(...)  // 正常限流
5. 与 M6.6 行为一致
```

---

## 8. 错误处理

| 错误场景 | 行为 |
|---|---|
| env.ADMIN_IP_ALLOWLIST 未设 | allowlist = [] → 行为不变 |
| env.ADMIN_IP_ALLOWLIST = "" | allowlist = [] → 行为不变 |
| env.ADMIN_IP_ALLOWLIST = ",," | filter 空 → [] → 行为不变 |
| clientIp 不在白名单 | 正常限流 |
| clientIp 在白名单 | 跳过 per-IP 限流（per-token 仍锁）|

---

## 9. 测试策略

### 9.1 TDD 流程

```
Task 1: 写 5 admin-ip-allowlist 测试（RED）→ 写 lib（GREEN）→ 改 auth.ts（保持 16 旧绿）→ 加 2 auth tests（验证白名单行为）
Task 2: 5 admin-ip-allowlist tests + 2 auth tests + typecheck + build
```

### 9.2 Mock-first 边界

- ✅ admin-ip-allowlist 单元测试纯函数（不依赖 D1 / miniflare）
- ✅ auth.test.ts 已有 14 测试行为不变（per-token 限流 + envelope 落库测试）
- ❌ 不验 IPv6 CIDR（白名单通常 1-5 个 IP；YAGNI）
- ❌ 不验 admin 配错白名单场景（admin 责任）

### 9.3 累计测试矩阵

| 测试文件 | 现有 | 新增 | 累计 |
|---|---|---|---|
| `apps/api/test/lib/admin-ip-allowlist.test.ts` | 0 | 5 | 5 |
| `apps/api/test/routes/auth.test.ts` | 14 | 2 | 16 |
| 其他包 | 266 | 0 | 266 |
| **累计** | **280** | **+7** | **287** |

---

## 10. Acceptance Criteria

### 10.1 功能 AC

| # | 标准 |
|---|---|
| AC-1 | `admin-ip-allowlist.ts` 提供 `parseAdminIpAllowlist(env)` + `isAdminIpAllowed(clientIp, allowlist)` |
| AC-2 | parseAdminIpAllowlist 解析 comma-separated 列表（trim + filter 空）|
| AC-3 | isAdminIpAllowed O(N) 简单 contains 检查 |
| AC-4 | 白名单空 / undefined → isAdminIp = false → 正常限流（行为不变）|
| AC-5 | `auth.ts` ADMIN_LOGIN 加白名单 check 前置；wx-login 不变 |
| AC-6 | `types.ts` Env 加 `ADMIN_IP_ALLOWLIST?: string` 字段 |

### 10.2 测试 AC

| # | 标准 |
|---|---|
| AC-7 | `pnpm -F api test` 全绿（**174 用例**：167 旧 + 7 新）|
| AC-8 | 5 包 `pnpm -r typecheck` 全绿 |

### 10.3 Dev 验证 AC（CP-5 真接时补）

- 真实 CF Workers 注入 `env.ADMIN_IP_ALLOWLIST` 行为
- 真实 admin IP 跨多个 IP 池场景

### 10.4 文档 AC

| # | 标准 |
|---|---|
| AC-9 | `docs/superpowers/state-m6-10.md` 收尾 |
| AC-10 | `README.md` 加 M6.10 节 |

---

## 11. CP-5 真接路径

M6.10 真接 Cloudflare 0 强制改：

1. **新 var 注入**（非敏感 IP）：
   ```bash
   pnpm wrangler vars set ADMIN_IP_ALLOWLIST "1.2.3.4,5.6.7.8"
   # 或 wrangler secret put（同 vars 行为）
   ```
2. **dev 需设** `127.0.0.1` 才能本地 admin 调试
3. **监控**：429 错误率突增可能白名单误删

---

## 12. 风险与回滚

### 12.1 风险点

| 风险 | 缓解 | 严重度 |
|---|---|---|
| **白名单 IP 误配**（如 dev 设成攻击者 IP）| admin 责任配 env；dev 默认空 = 行为不变 | MEDIUM |
| **静态 IP 变更**（dev 切换网络）| admin 需手动更新 env；CP-5 流程文档强提示 | LOW |
| **白名单绕过 per-token 限流**（5 错仍锁 per-token）| 设计预期；per-token 限流独立 | LOW |
| **IPv6 白名单**（CF 真接可能 IPv6）| O(N) includes 仍工作；YAGNI CIDR | LOW |

### 12.2 回滚策略

| Commit | 回滚方式 | 影响 |
|---|---|---|
| Task 1 (admin-ip-allowlist + auth + types) | `git revert` | ADMIN_LOGIN 退到无白名单（行为不变） |

---

## 13. 实施计划

### 13.1 Commit 拆分（3 commit + 1 merge = 4 总）

| # | Commit | 主题 | 测试增量 |
|---|---|---|---|
| 1 | spec | `docs: M6.10 spec — admin IP allowlist` | 0 |
| 2 | plan | `docs: M6.10 plan — admin IP allowlist (1 task / 2 CP)` | 0 |
| 3 | Task 1 合并 | `feat(api): M6.10 — admin IP allowlist + auth.ts 包裹 + 7 tests` | +7 |
| 4 | state + README | `docs: M6.10 state-m6-10.md 收尾 + README M6.10 节` | 0 |
| merge | `worktree-m6-10-admin-allowlist → master --no-ff` | — |

**共 4 commit + 1 merge = 5 总**

### 13.2 工作流

- worktree 隔离 + 1 包改动 + ~20 min 主线程直接做
- TDD 严格走：5 + 2 测试先写（RED）→ 写实现（GREEN）

---

## 14. 累计测试 + 文件清单

### 14.1 仓库测试累计（M6.10 后）

| 包 | 现有 | M6.10 | 累计 |
|---|---|---|---|
| shared | 38 | 0 | 38 |
| api | 167 | +7 | **174** |
| miniprogram | 32 | 0 | 32 |
| admin | 24 | 0 | 24 |
| crawler | 19 | 0 | 19 |
| **累计** | **280** | **+7** | **287** |

### 14.2 文件清单（M6.10 后）

| 类型 | 文件 | 状态 |
|---|---|---|
| 新代码 | `apps/api/src/lib/admin-ip-allowlist.ts` | NEW |
| 改代码 | `apps/api/src/routes/auth.ts` | +6 / -2 |
| 改代码 | `apps/api/src/types.ts` | +1 / -0 |
| 新测试 | `apps/api/test/lib/admin-ip-allowlist.test.ts` | +50 / -0 |
| 改测试 | `apps/api/test/routes/auth.test.ts` | +40 / -0 |
| 新文档 | `docs/superpowers/specs/2026-06-16-m6-10-admin-allowlist-design.md` | NEW（本文件）|
| 新文档 | `docs/superpowers/plans/2026-06-16-m6-10-admin-allowlist.md` | NEW |
| 新文档 | `docs/superpowers/state-m6-10.md` | NEW |
| 改文档 | `README.md` | +30 / -0 |

**共 1 lib 新 + 2 改代码 + 1 新测试 + 1 改测试 + 4 文档 = 9 总**

---

## 附录 A：关键设计决策记录

| # | 决策 | 理由 | 拒绝方案 |
|---|---|---|---|
| D-1 | `env.ADMIN_IP_ALLOWLIST` comma-separated | 与现有 CRON_SECRET 等 env 一致；CF Workers vars 支持 | 单 IP（多 IP 场景成本高）；CIDR（实现复杂） |
| D-2 | 仅 /auth/admin-login 受影响 | wx-login 是普通用户，不需要白名单 | 全 /auth/*（wx-login 不需要）|
| D-3 | 白名单空 / undefined = 行为不变 | 向后兼容 M6.6 | 强制要求配白名单（dev 体验差）|
| D-4 | per-token 限流仍生效 | 白名单仅跳过 per-IP；防御 5 错 token | 同时跳过 per-token（安全降低）|
| D-5 | `clientIp` 明文（非 hash）做白名单匹配 | 白名单是 admin 配置的明文 IP | hash 后匹配（admin 需记 hash 值）|
| D-6 | 0 新 schema / 0 新 secret / 0 跨包 | 与 M6.6 防御性加固节奏一致 | 复杂 admin 工具 / unlock endpoint |
