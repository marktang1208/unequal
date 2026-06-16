# M6.4 — Rate-Limit Vars + Cron Cleanup + Inflight Promise

**版本**: 2026-06-16
**前置**: M6.3c nickname-input 组件（已 merge `1247a32`）
**范围**: M6.4 — 3 项运维增强：(1) `fetchWithRefresh` 共享 inflight promise；(2) rate-limit 阈值提取到 wrangler vars；(3) login_attempt 表 cron 清理 + created_at 索引

---

## 1. Requirements

| # | 现状 | 目标 |
|---|---|---|
| 1 | `fetchWithRefresh` 401 时每个并发独立调 `ensureJwt`（浪费 wx.login + 200-500ms）| 模块级 `Map<string, Promise<string>>` 共享 inflight；同 baseUrl 并发 401 → 1 次 wx.login |
| 2 | rate-limit `MAX_FAILURES=5 / WINDOW_MS=900_000` 硬编码 | 提取到 `env.LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS`（可选 var，缺省走 default）|
| 3 | `login_attempt` 表只增不减 + 现有索引不优化 `DELETE WHERE created_at < ?` | 0007 migration 加 `created_at` 单列索引 + 新 `POST /cron/cleanup-login-attempts` HTTP endpoint（CRON_SECRET 鉴权）|

**为什么 YAGNI 精简**（区别于 state-m6-3c.md "下一步建议" 的全 6 项）：
- ❌ 不做 rate-limit 加 IP 维度（防御类，mock-first 测不出攻击场景）→ 推 M6.5+
- ❌ 不做 D1 token-level mutex（需新建 DO 类，攻击窗口小，性价比低）→ 推 M6.5+
- ❌ 不做 session_key envelope encryption（mock-first 验不出加密场景）→ 推 M6.5+
- ✅ 只做能 mock-first 完整覆盖 + 真接 Cloudflare 后立刻有真实价值的 3 项

---

## 2. Patterns to Mirror

| 类别 | 来源 | 复用方式 |
|---|---|---|
| miniprogram fetch wrapper | `apps/miniprogram/lib/api.ts:83-104` `fetchWithRefresh` | 加模块级 `Map<string, Promise<string>>` 共享 inflight |
| miniprogram test stub reset | `apps/miniprogram/lib/chat-storage.ts` `__setJwtStorageImpl` 模式 | 新 `__clearInflightEnsureJwt` 内部 helper 给单测 reset |
| server rate-limit 函数 | `apps/api/src/lib/rate-limit.ts:44-75` `checkRateLimit` | 加可选 config 参数（向后兼容）+ 抽 `readRateLimitConfig(env)` |
| server route 注册 | `apps/api/src/index.ts:48-53` Hono app.route | 新 `app.post("/cron/cleanup-login-attempts", ...)` |
| D1 migration 命名 | `apps/api/migrations/0005_login_attempt.sql` | 新 `0007_login_attempt_created_at_index.sql` |
| wrangler vars | `apps/api/wrangler.jsonc` `vars` 块 | 加 3 个 var（LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS / CRON_SECRET）|

---

## 3. Architecture Overview

3 项独立，互不依赖：

```
─── Task 1 (#5 inflight promise) ─────────────────────────────────
User 打开小程序 → 3 个 API 并发 → 3 个 401
  ↓
fetchWithRefresh #1: 401 → ensureJwt() inflight promise P 创建
fetchWithRefresh #2: 401 → 复用 P
fetchWithRefresh #3: 401 → 复用 P
  ↓
P 完成（仅 1 次 wx.login + 1 次 /auth/wx-login）
  ↓
3 个 retry 用新 jwt 并发重发
  ↓
inflightEnsureJwt.delete(baseUrl)  ← .finally 立即清

─── Task 2 (#2 rate-limit vars) ──────────────────────────────────
Admin / WX login handler
  ↓
readRateLimitConfig(env)  ← 读 LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS，缺省 fallback
  ↓
checkRateLimit(env.DB, identifier, type, config)
  ↓
config.maxFailures / config.windowMs 替换硬编码

─── Task 3 (#3 cron cleanup) ─────────────────────────────────────
Cloudflare Cron Trigger OR external cron (CP-5 决策)
  ↓
POST /cron/cleanup-login-attempts
  Authorization: Bearer <CRON_SECRET>
  ↓
verify Authorization == `Bearer ${env.CRON_SECRET}`
  ↓
DELETE FROM login_attempt WHERE created_at < (now - 24h)
  利用 idx_login_attempt_created_at 索引
  ↓
返 { deleted: N, cutoff: timestamp }
```

---

## 4. Files to Change

| 文件 | 动作 | 内容 |
|---|---|---|
| `apps/miniprogram/lib/api.ts` | UPDATE | 新增模块级 `inflightEnsureJwt` Map + `__clearInflightEnsureJwt` + 改 `fetchWithRefresh` 12 行 |
| `apps/miniprogram/test/api.test.ts` | UPDATE | +3 用例（inflight 3）|
| `apps/api/src/lib/rate-limit.ts` | UPDATE | 新 `RateLimitConfig` interface + `DEFAULT_RATE_LIMIT_CONFIG` + `readRateLimitConfig(env)` + 改 `checkRateLimit` 签名（加 config 参数）|
| `apps/api/src/routes/auth.ts` | UPDATE | 导入 `readRateLimitConfig` + 2 处 `checkRateLimit` 调用加 config 参数 |
| `apps/api/src/types.ts` | UPDATE | Env 加 3 可选字段（LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS / CRON_SECRET）|
| `apps/api/wrangler.jsonc` | UPDATE | `vars` 块加 3 个 var + 注释 |
| `apps/api/migrations/0007_login_attempt_created_at_index.sql` | CREATE | 7 行（CREATE INDEX）|
| `apps/api/migrations/0007_login_attempt_created_at_index.down.sql` | CREATE | 1 行（DROP INDEX）|
| `apps/api/src/routes/cron.ts` | CREATE | 50 行（含 JSDoc）— `cronRoute.CLEANUP_LOGIN_ATTEMPTS` handler |
| `apps/api/src/index.ts` | UPDATE | +2 行（导入 `cronRoute` + 挂 `app.post("/cron/cleanup-login-attempts", ...)`）|
| `apps/api/test/lib/rate-limit.test.ts` | UPDATE | +2 用例（config 注入）|
| `apps/api/test/routes/cron.test.ts` | CREATE | 3 用例（happy / 401 缺 token / 401 错 token）|
| `docs/superpowers/specs/2026-06-16-m6-4-rate-limit-cron-inflight-design.md` | CREATE | 本文档 |
| `docs/superpowers/state-m6-4.md` | CREATE | 收尾归档（主线程写）|

**总计**：5 新建（0007 .sql + .down.sql + routes/cron.ts + test/routes/cron.test.ts + state-m6-4.md）+ 1 新建 spec + 7 修改 = 13 改动文件 + 1 spec 文档。

---

## 5. API Spec

### 5.1 Task 1 — `fetchWithRefresh` inflight 共享

**变更位置**：`apps/miniprogram/lib/api.ts:83-104`

**新增模块级状态**：
```typescript
// 模块级 inflight cache：key = baseUrl，value = inflight ensureJwt promise
// 跨 fetchWithRefresh 调用共享，同 baseUrl 并发 401 只触发 1 次 wx.login
const inflightEnsureJwt = new Map<string, Promise<string>>();

/** @internal 测试桩：清空 inflight cache（仅单测用） */
export function __clearInflightEnsureJwt(): void {
  inflightEnsureJwt.clear();
}
```

**新 fetchWithRefresh 实现**：
```typescript
export async function fetchWithRefresh(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  opts: ApiOptions,
  isRetry = false,
): Promise<ResponseLike> {
  const f = getFetch(opts);
  const res = await f(url, init);
  if (res.status !== 401 || isRetry) return res;

  // 401 + 非 retry → 共享 inflight ensureJwt
  const baseUrl = opts.baseUrl ?? "http://localhost:8787";
  let inflight = inflightEnsureJwt.get(baseUrl);
  if (!inflight) {
    inflight = ensureJwt(baseUrl, opts.fetchImpl).finally(() => {
      inflightEnsureJwt.delete(baseUrl);
    });
    inflightEnsureJwt.set(baseUrl, inflight);
  }

  let newJwt: string;
  try {
    newJwt = await inflight;
  } catch {
    // ensureJwt 失败（原 wx.login fail / /auth/wx-login fail）→ 透传原 401
    return res;
  }

  const newInit: typeof init = {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${newJwt}` },
  };
  return await fetchWithRefresh(url, newInit, opts, true);
}
```

**关键不变量**：
- Map key = `baseUrl`（不是 opts） — 同 baseUrl 共享；不同 baseUrl 独立（防御性）
- `.finally(() => delete)` 立即清缓存 — 失败也清，避免 stale promise 阻塞下次 refresh
- 失败透传 — ensureJwt 抛错时 `catch` 兜底返原 401（保持 M6.3a 行为）
- 死循环拦截 — `isRetry` 参数仍在（M6.3a 已有）

### 5.2 Task 2 — rate-limit vars 配置化

**变更位置**：`apps/api/src/lib/rate-limit.ts`

**新增导出**：
```typescript
export interface RateLimitConfig {
  maxFailures: number;
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxFailures: MAX_FAILURES,
  windowMs: WINDOW_MS,
};

/**
 * 从 env 读 rate limit 配置（缺失或非法值 fallback 默认）。
 */
export function readRateLimitConfig(
  envLike: { LOGIN_MAX_ATTEMPTS?: string; LOGIN_WINDOW_MS?: string },
): RateLimitConfig {
  const parse = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    maxFailures: parse(envLike.LOGIN_MAX_ATTEMPTS, MAX_FAILURES),
    windowMs: parse(envLike.LOGIN_WINDOW_MS, WINDOW_MS),
  };
}
```

**改 checkRateLimit 签名**（向后兼容）：
```typescript
export async function checkRateLimit(
  d1: D1Database,
  identifier: string,
  type: AttemptType,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  // ... 内部用 config.maxFailures / config.windowMs 替换硬编码 ...
}
```

`recordAttempt` 不改（不查窗口）。

**调用方改动**（`apps/api/src/routes/auth.ts` 2 处）：
```typescript
const config = readRateLimitConfig(env);
// WX_LOGIN (line 88)
const rateCheck = await checkRateLimit(env.DB, codeIdentifier, "wx_code", config);
// ADMIN_LOGIN (line 170)
const rateCheck = await checkRateLimit(env.DB, adminIdentifier, "admin", config);
```

**Env 类型扩展**（`apps/api/src/types.ts`）：
```typescript
// M6.4: rate limit 配置（可选；缺省走 lib/rate-limit.ts 默认值）
LOGIN_MAX_ATTEMPTS?: string;
LOGIN_WINDOW_MS?: string;
CRON_SECRET?: string;
```

**wrangler.jsonc vars 块加 3 个**：
```jsonc
"vars": {
  // ... 现有 5 个 vars ...
  // M6.4: rate limit 配置
  "LOGIN_MAX_ATTEMPTS": "5",
  "LOGIN_WINDOW_MS": "900000",
  // M6.4: cron cleanup 鉴权（M6.4 放 vars；CP-5 真接时改 wrangler secret put）
  "CRON_SECRET": "dev-cron-secret-change-me-in-production"
}
```

### 5.3 Task 3 — cron cleanup endpoint

**新增 migration**（`apps/api/migrations/0007_login_attempt_created_at_index.sql`）：
```sql
-- M6.4: cron DELETE WHERE created_at < ? 的索引
-- 配合 cron handler：DELETE FROM login_attempt WHERE created_at < ?
-- 现有 idx_login_attempt_lookup(identifier, attempt_type, created_at DESC)
-- 复合索引第一列是 identifier，不优化单列 created_at 比较

CREATE INDEX IF NOT EXISTS idx_login_attempt_created_at
  ON login_attempt(created_at);
```

**新增 handler**（`apps/api/src/routes/cron.ts`）：
```typescript
import type { Env } from "../types.js";

const CLEANUP_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

export const cronRoute = {
  async CLEANUP_LOGIN_ATTEMPTS(request: Request, env: Env): Promise<Response> {
    // 鉴权：Bearer CRON_SECRET
    const auth = request.headers.get("Authorization");
    const expected = `Bearer ${env.CRON_SECRET ?? ""}`;
    if (auth !== expected) {
      return Response.json(
        { error: "UNAUTHORIZED", message: "Invalid or missing CRON_SECRET" },
        { status: 401 },
      );
    }

    const now = Date.now();
    const cutoff = now - CLEANUP_THRESHOLD_MS;
    try {
      const result = await env.DB
        .prepare("DELETE FROM login_attempt WHERE created_at < ?")
        .bind(cutoff)
        .run();
      return Response.json({
        deleted: result.meta.changes ?? 0,
        cutoff,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: "internal", detail: msg }, { status: 500 });
    }
  },
};
```

**挂载**（`apps/api/src/index.ts`）：
```typescript
import { cronRoute } from "./routes/cron.js";
// ...
app.post("/cron/cleanup-login-attempts", (c) => cronRoute.CLEANUP_LOGIN_ATTEMPTS(c.req.raw, c.env));
```

**Cron 触发方式决策**（CP-5 由用户决定，M6.4 范围不强制）：
- 选项 A：Cloudflare scheduled handler（需 wrap `app` default export 为 `{ fetch, scheduled }`，约 5 行改动）
- 选项 B：external cron（GitHub Actions / launchd / crontab）调 HTTP endpoint
- 选项 C：手动 `curl`（CP-5 之前）

**为什么 M6.4 不强制 A**：wrap app export 是 breaking change（Hono app 直接 default export），mock-first 阶段不引入；CP-5 5 分钟就能加。

---

## 6. Data Model

**1 新 migration**：
- `0007_login_attempt_created_at_index.sql` — `CREATE INDEX idx_login_attempt_created_at ON login_attempt(created_at)`
- 0 表结构变化（仅加索引）

**为什么不抽 `cron_enabled` / `cleanup_threshold_ms` 到 env**：
- 24h 硬编码合理（rate-limit 窗口 15min × ~100 倍覆盖分析余量）
- YAGNI — 用户没要求灰度调整 cleanup 阈值
- 与 `readRateLimitConfig` 设计哲学对齐：缺省走 default，不强制 env

---

## 7. Error Handling

### 7.1 Task 1 — miniprogram inflight

| 触发 | 行为 |
|---|---|
| 同 baseUrl 并发 401 → ensureJwt inflight | 共享同一 promise；仅 1 次 wx.login + /auth/wx-login |
| ensureJwt 成功 | `.finally` 清缓存；retry 用新 jwt |
| ensureJwt 失败 | `.finally` 清缓存；原 401 透传给 caller（caller 决定 mock-first fallback）|
| 第二次仍 401（refresh 后）| `isRetry=true` 终止递归；透传 401 |
| 跨 baseUrl 并发 | 不同 Map key，互不影响（防御性）|

### 7.2 Task 2 — server rate-limit

| 触发 | 行为 |
|---|---|
| `LOGIN_MAX_ATTEMPTS` 缺 / 非数字 / ≤ 0 | fallback `MAX_FAILURES=5`（不 throw）|
| `LOGIN_WINDOW_MS` 缺 / 非数字 / ≤ 0 | fallback `WINDOW_MS=900_000` |
| checkRateLimit 调用不传 config | 自动用 `DEFAULT_RATE_LIMIT_CONFIG`（向后兼容）|
| 非法 env 把所有人锁死 | 不会（fallback default）|

### 7.3 Task 3 — server cron cleanup

| 触发 | 行为 |
|---|---|
| 401 缺 / 错 Authorization | 返 401 UNAUTHORIZED（不暴露 CRON_SECRET）|
| 500 D1 DELETE 失败 | try/catch 兜底返 500 + detail |
| D1 0 row 删除（表空 / 全新）| 返 `{ deleted: 0, cutoff }` 不报错 |
| 并发 cron 触发 | 同时 DELETE — SQLite 写锁序列化，最终一致 |

---

## 8. Mock-first Boundaries

| 组件 | 测试方式 | 真接路径 |
|---|---|---|
| `inflightEnsureJwt` Map | 内存 Map + `__clearInflightEnsureJwt` 注入 reset | CP-5 真 wx 走同样代码路径 |
| `ensureJwt` 并发 | `vi.fn` 计数 + `wx.login` mock | CP-5 真机上 3 个并发 fetch 行为一致 |
| `readRateLimitConfig` | 纯函数 + env 对象字面量 | CP-5 真 env 注入（wrangler vars）|
| `checkRateLimit(config)` | miniflare D1 + config 注入 | CP-5 wrangler vars 注入 |
| 0007 索引 | miniflare 自动 apply migration | CP-5 `wrangler d1 migrations apply unequal-db` |
| cron HTTP endpoint | miniflare bundle + Authorization header 注入 | CP-5 真接 Cloudflare |
| cron 触发 | **mock-first 不验**（手动 `curl` 即可验 DELETE 逻辑）| CP-5 scheduled handler 或 external cron |
| 24h 阈值 | 硬编码 `CLEANUP_THRESHOLD_MS`；不抽 env（YAGNI）| 同上 |

---

## 9. Testing Strategy

### 9.1 用例分布（8 新增 → 累计 213）

| 文件 | 新增 | 内容 |
|---|---|---|
| `apps/miniprogram/test/api.test.ts` | 3 | inflight promise: 3 并发共享 / cleanup 后再触发 / 不同 baseUrl 隔离 |
| `apps/api/test/lib/rate-limit.test.ts` | 2 | readRateLimitConfig fallback default + env 注入；checkRateLimit config 参数注入 |
| `apps/api/test/routes/cron.test.ts` | 3 | happy / 401 缺 token / 401 错 token |

合计：3 + 2 + 3 = **8 新增** → 205 + 8 = **213 用例**

### 9.2 关键 fixture

```typescript
// apps/miniprogram/test/api.test.ts (新增 describe)
describe("fetchWithRefresh (M6.4) — inflight promise 共享", () => {
  beforeEach(() => {
    __clearInflightEnsureJwt();   // 重置 module-level Map
    // ... 现有 reset ...
  });

  it("3 并发 401 → wx.login 只调 1 次（inflight promise 共享）", async () => {
    // 关键：第一个 fetchWithRefresh 调 ensureJwt（创建 inflight promise 调 wx.login pending），
    // 第二个 / 第三个 fetchWithRefresh 直接复用 inflight promise，不调 wx.login。
    let resolveWxLogin: ((v: { code: string }) => void) | null = null;
    wxLoginMock.mockImplementation(({ success }: any) => {
      // 不自动 resolve，让第一个 ensureJwt 卡在 pending；3 个 fetchWithRefresh 都进入 inflight await
      resolveWxLogin = success;
    });
    const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
      if (input === "http://localhost:8787/auth/wx-login") {
        return new Response(JSON.stringify({ token: "new_jwt", ... }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 });
    });

    // 并发 3 个 fetchWithRefresh（不 await，先让 3 个都进入 inflight await 状态）
    const p1 = fetchWithRefresh("http://localhost:8787/ask", { method: "POST", headers: { authorization: "Bearer old" } }, { baseUrl: "http://localhost:8787", fetchImpl: fetchMock });
    const p2 = fetchWithRefresh("http://localhost:8787/chat", { method: "POST", headers: { authorization: "Bearer old" } }, { baseUrl: "http://localhost:8787", fetchImpl: fetchMock });
    const p3 = fetchWithRefresh("http://localhost:8787/sessions", { method: "GET", headers: { authorization: "Bearer old" } }, { baseUrl: "http://localhost:8787", fetchImpl: fetchMock });

    // 让 microtask queue 跑 — 3 个 fetchWithRefresh 都已触发 ensureJwt 并 await inflight
    await new Promise((r) => setTimeout(r, 0));
    // 关键：wxLoginMock 此时只被调 1 次（第一个 ensureJwt 调，inflight promise 创建）
    expect(wxLoginMock).toHaveBeenCalledTimes(1);

    // resolve wx.login → inflight promise 完成 → 3 个 fetchWithRefresh 各自 retry
    resolveWxLogin!({ code: "code_3" });
    await Promise.all([p1, p2, p3]);

    // 最终 wxLoginMock 仍只 1 次（其他 2 个直接复用 inflight）
    expect(wxLoginMock).toHaveBeenCalledTimes(1);
    // /auth/wx-login 也只 1 次
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:8787/auth/wx-login", expect.any(Object));
  });

  it("串行：先 1 个 401 → refresh 完成 → 再触发 401 → ensureJwt 调第 2 次", async () => {
    let wxLoginCount = 0;
    wxLoginMock.mockImplementation(({ success }: any) => {
      wxLoginCount++;
      success({ code: `code_${wxLoginCount}` });
    });
    // ... 类似 setup ...

    await fetchWithRefresh("http://localhost:8787/ask", { ... }, opts);
    expect(wxLoginCount).toBe(1);
    __clearInflightEnsureJwt();   // 模拟 cleanup 后场景
    await fetchWithRefresh("http://localhost:8787/chat", { ... }, opts);
    expect(wxLoginCount).toBe(2);  // inflight 已清，第二次重新触发
  });

  it("不同 baseUrl 互不影响", async () => {
    let wxLoginCount = 0;
    wxLoginMock.mockImplementation(({ success }: any) => {
      wxLoginCount++;
      success({ code: `code_${wxLoginCount}` });
    });
    // ... 并发 baseUrl A 和 baseUrl B 的 fetchWithRefresh ...
    // 期望 wxLoginCount = 2（不同 baseUrl 不共享）
  });
});

// apps/api/test/lib/rate-limit.test.ts (新增 describe)
describe("readRateLimitConfig (M6.4)", () => {
  it("env 缺省 → fallback DEFAULT_RATE_LIMIT_CONFIG", () => {
    expect(readRateLimitConfig({})).toEqual(DEFAULT_RATE_LIMIT_CONFIG);
  });
  it("env 注入 LOGIN_MAX_ATTEMPTS='3' → 用 3", () => {
    expect(readRateLimitConfig({ LOGIN_MAX_ATTEMPTS: "3" }).maxFailures).toBe(3);
  });
  it("env 注入 LOGIN_MAX_ATTEMPTS='abc'（非法）→ fallback 5", () => {
    expect(readRateLimitConfig({ LOGIN_MAX_ATTEMPTS: "abc" }).maxFailures).toBe(5);
  });
});

describe("checkRateLimit (M6.4) config 注入", () => {
  it("config maxFailures=2 → 2 次失败后第 3 次 lock", async () => {
    // ... miniflare D1 + recordAttempt × 2 + checkRateLimit({ maxFailures: 2, windowMs: ... }) ...
    // 期望 locked: true
  });
});

// apps/api/test/routes/cron.test.ts (新建)
describe("cronRoute.CLEANUP_LOGIN_ATTEMPTS (M6.4)", () => {
  it("happy: Bearer CRON_SECRET + D1 mock DELETE → 返 { deleted, cutoff }", async () => {
    // ... miniflare D1 + recordAttempt 几条老数据 + Authorization header + DELETE 验 deleted ...
  });
  it("401: 缺 Authorization header", async () => {
    const res = await cronRoute.CLEANUP_LOGIN_ATTEMPTS(new Request("http://x/cron/cleanup-login-attempts", { method: "POST" }), env);
    expect(res.status).toBe(401);
  });
  it("401: Bearer 错 secret", async () => {
    const req = new Request("http://x/cron/cleanup-login-attempts", { method: "POST", headers: { Authorization: "Bearer wrong" } });
    const res = await cronRoute.CLEANUP_LOGIN_ATTEMPTS(req, env);
    expect(res.status).toBe(401);
  });
});
```

---

## 10. ECC Components

| 组件 | 用法 |
|---|---|
| `superpowers:brainstorming` | M6.4 spec 设计（6 区块 design + 范围选择 + 方案选择）|
| `superpowers:using-superpowers` | entry dispatcher |
| ECC `plan` skill | M6.4 plan 编写 |
| `tdd-workflow` (ECC) | 8 用例 RED → GREEN → REFACTOR |
| `feedback_subagent_heartbeat_monitoring` | M6.3b/c 教训应用：1 subagent 范围 < 3 task 主线程做；M6.4 4 task 跨 2 包 → 主线程直接做 |
| `verification-before-completion` | CP-1 + 主线程 CP-2 独立验证 |
| `code-review` / `typescript-review` | api.ts 改 12 行 + rate-limit.ts 改 ~25 行 + cron.ts 新文件 + wrangler.jsonc 改 vars |

**ECC TypeScript rules 已加载**：coding-style（strict type / interfaces / immutable）/ testing（vitest + AAA）/ security（不暴露 CRON_SECRET）。

---

## 11. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Task 2 `checkRateLimit` 签名破坏旧调用方 | 低 | 可选 config 参数（不传走 default）；全仓 grep `checkRateLimit(` 验证仅 auth.ts 两处 |
| Task 3 cron endpoint 被外部滥用 | 低 | `CRON_SECRET` 验证；CP-5 升级到 wrangler secret put |
| Task 3 索引加在已大表慢 | 极低 | user 表当前 0-几千行，login_attempt 同期；migration 应用秒级 |
| Task 1 inflight map 内存泄漏 | 极低 | `.finally(() => delete)` 立即清；baseUrl 最多 1-2 个 |
| 跨 2 包改动（miniprogram + api）subagent stall | 中 | M6.3b 教训 + 主线程直接做 4 task |
| Task 3 cron 24h 阈值过长 / 过短 | 低 | 24h 留足 rate-limit 窗口（15min）分析余量；不抽 env |
| Task 3 mock-first 不验 cron 触发 | 低 | endpoint 单元测试覆盖 DELETE 逻辑 + secret 验证；CP-5 接 scheduled handler 时再验 |
| Task 2 非法 env 把所有人锁死 | 极低 | readRateLimitConfig fallback default（不 throw）|
| wrangler vars 字符串解析（"5" vs 5）| 极低 | parseInt 显式转换；Number.isFinite 守门 |

**最高风险**：跨 2 包改动 subagent stall。Mitigation：M6.3b/c 教训应用，主线程直接做 4 task 跨 2 包（miniprogram + api），无 stall 风险。

---

## 12. Acceptance Criteria

- [ ] **3 task 4 commit + 1 merge = 5 总**，主线程直接做
- [ ] **+8 新增用例全绿**（mini 3 + api 5）→ **累计 213 用例全绿**
- [ ] **5 包 typecheck 全绿**（无 V1 装饰器 / 无 `any` 警告）
- [ ] **`pnpm -r build` 成功**（admin 静态资源不变）
- [ ] **wrangler.jsonc vars** 加 3 个（LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS / CRON_SECRET）
- [ ] **0 production console.log**（api / miniprogram）
- [ ] **`docs/superpowers/state-m6-4.md`** 收尾归档
- [ ] **README M6.4 状态节**（仿 M6.3c 格式）
- [ ] **merge to master --no-ff** + worktree 清理 + branch 删除

**dev 验证缺口**（推到 CP-5 真接 Cloudflare）：
- 真实 Cloudflare Cron Trigger 触发（方案 A scheduled handler）— M6.4 范围不强制
- 真实 external cron 触发（方案 B GitHub Actions / launchd）— M6.4 范围不强制
- 真实 wrangler vars 注入（vs mock env 对象字面量）— CP-5 真接后验
- 真实 wx.login 真机上 3 个并发 fetch 行为 — CP-5 真机验证
- 真实 D1 大表加索引性能 — 当前 user 表 0-几千行，无影响；CP-5 时若数据量增再评估

---

## 13. M6.4+ Deferred（不在本 spec）

| 项目 | 推后原因 |
|---|---|
| rate-limit 加 IP 维度 | 防御类，mock-first 测不出攻击场景 → M6.5+ |
| D1 token-level mutex | 攻击窗口小（需 5 并发 admin-login）+ 需新建 DO 类 → M6.5+ |
| session_key envelope encryption | mock-first 验不出加密场景 → M6.5+ |
| Cloudflare scheduled handler wrap | M6.4 范围聚焦清理逻辑；CP-5 5 分钟可加 |
| cron 24h 阈值 env 配置化 | YAGNI；硬编码合理 |
| 5 函数共享 inflight 静态 grep 测试 | 现有 M6.3a 静态测试已覆盖，不重复 |

---

## 14. Implementation Notes

### 14.1 Plan 拆分（按 M6.3c 教训：主线程直接做）

M6.3c 教训：1 subagent × 3 task 时 stall 风险高。M6.4 4 task 跨 2 包（miniprogram + api），**主线程直接做** 避免 stall 风险。

预计 1.5-2 天实施：
- Task 1 (#5): 0.5 天
- Task 2 (#2): 0.5 天
- Task 3 (#3): 1 天（含 migration + 新 endpoint + 测试）
- Task 4 (state): 0.5 天（主线程收尾）

### 14.2 Commit 节奏（4 commit + 1 merge = 5 总）

```
feat(mini): M6.4 task 1 — fetchWithRefresh 共享 inflight promise + 3 tests
feat(api):  M6.4 task 2 — rate-limit 阈值提取到 wrangler vars + 2 tests
feat(api):  M6.4 task 3 — login_attempt cron cleanup (0007 index + routes/cron.ts + CRON_SECRET)
docs:       M6.4 state-m6-4.md + README M6.4 节
merge:      worktree-m6-4-... → master --no-ff
```

### 14.3 验证顺序

1. **CP-1**（task 1-3 完成后）：`pnpm -r typecheck` + `pnpm -r test` → 期望 205 旧 + 8 新 = 213 全绿
2. **CP-2**（合并后，主线程独立）：`pnpm -r test` + `pnpm -r typecheck` + 确认 merge commit + worktree 清理
3. **CP-5**（真接 Cloudflare）：真实 cron trigger + 真实 vars 注入 + 真实 wx.login 并发验证

### 14.4 ECC 引用

- `tdd-workflow` (ECC) — 8 用例 RED → GREEN → REFACTOR
- `subagent-driven-development` (ECC) — **本 spec 决策主线程直接做**（M6.3c 教训）
- `code-review` / `typescript-review` — api.ts 改 12 行 + rate-limit.ts 改 ~25 行 + cron.ts 新文件 + wrangler.jsonc 改 vars
- `verification-before-completion` (Superpowers) — CP-1/2 验证

### 14.5 Worktree 路径

按 M6.3c 模式：`.claude/worktrees/m6-4-rate-limit-cron-inflight`，分支 `worktree-m6-4-rate-limit-cron-inflight`。
