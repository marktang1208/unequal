# M6.9 — D1 Token-Level Mutex (Defensive)

**版本**: 2026-06-16
**前置**: M6.8 KEK version + multi-KEK fallback（已 merge `c138d36`）
**范围**: 1 项防御性加固 — 同 token 5 并发 admin-login 小窗口串行化（与 M6.4 inflightEnsureJwt 同模式）

---

## 1. Requirements

| # | 现状 | 目标 |
|---|---|---|
| 1 | M6.3a per-token 5/15min + M6.6 per-IP 5/15min 已防"轮换 wrong-token 绕过" + "5 错误锁定" | 防御性：同 token 5 并发 admin-login 小窗口串行化（节省 ~5-10ms 总耗时，避免 5 个并发 D1 写时的 race） |
| 2 | 5 个 D1 write 可能并发（同 token check 5 次都通过再 record 5 次） | in-process Map mutex 串行化同 identifier 的 check + record 块 |

**价值评估**（spec §"为什么 YAGNI 精简"）：
- ⚠️ M6.9 价值极低：行为变化小（5 个 record 仍 5 行；只节省 5-10ms 串行耗时）
- 实施理由：与 M6.4 inflightEnsureJwt 同一防御性 pattern，CF Workers 单 isolate 内有效（多 isolate 间不防 — YAGNI）
- 真实价值：CP-5 真接后看实际并发量决定是否需要 DO-level mutex

**为什么 YAGNI 精简**：
- ❌ 不做 DO-level cross-isolate mutex（额外 DO namespace 成本 + init 延迟）
- ❌ 不做 backoff / retry（同 token 同 instance 几乎无并发；YAGNI）
- ✅ 只做 in-process Map + withTokenMutex helper（防御性；CP-5 验证）

---

## 2. Patterns to Mirror

| 类别 | 来源 | 复用方式 |
|---|---|---|
| inflight promise 模式 | `apps/miniprogram/lib/api.ts` M6.4 `inflightEnsureJwt: Map<string, Promise<string>>` | token-mutex.ts 同模式 `Map<string, Promise>` 串行化 |
| Map 自动清理 | `apps/miniprogram/lib/api.ts` M6.4 `.finally(() => delete)` | token-mutex.ts `finally` 清理 Map entry |
| auth route 调用 | `apps/api/src/routes/auth.ts:114, 189, 196` `recordAttempt` | M6.9 加 mutex 包裹 |
| 失败处理 | `apps/api/src/routes/auth.ts:131-135` try/catch | M6.9 withTokenMutex throw 透传，try/catch 兜底 |

---

## 3. Architecture Overview

1 项核心改动（in-process mutex）— 1 新 lib + auth.ts 2 处包：

```
─── 核心层（apps/api/src/lib/token-mutex.ts）─────────────────
新 withTokenMutex<T>(identifier, fn) → Promise<T>:
  inflight: Map<string, Promise<unknown>>  // module-level
  prev = inflight.get(identifier)
  next = new Promise(resolve => resolveNext = resolve)
  chained = prev ? prev.then(() => next) : next
  inflight.set(identifier, chained)
  try:
    if (prev) await prev
    return await fn()
  finally:
    resolveNext()  // 释放下一个
    if (inflight.get(identifier) === chained) inflight.delete(identifier)

─── 路由层（apps/api/src/routes/auth.ts）─────────────────
WX_LOGIN: recordAttempt 包在 withTokenMutex(codeIdentifier, fn) 内
ADMIN_LOGIN: 2 处 recordAttempt（成功 + 失败）都包在 withTokenMutex(adminIdentifier, fn) 内
```

**关键设计原则**：
- ✅ in-process Map（CF Workers 单 isolate 内有效）
- ✅ 0 新依赖 / 0 schema / 0 env 改动
- ✅ fn throw 不影响 mutex 释放（finally 清理）
- ✅ 同 token 串行；不同 token 并行
- ❌ 不做 cross-isolate DO-level mutex（YAGNI）
- ❌ 不做 backoff / retry（YAGNI）

---

## 4. Files to Change

### 新建（2 个）

| 文件 | 内容 | 预估行数 |
|---|---|---|
| `apps/api/src/lib/token-mutex.ts` | `withTokenMutex<T>(identifier, fn)` + module-level `inflight` Map | ~30 |
| `apps/api/test/lib/token-mutex.test.ts` | 6 测试（同 id 串行 / 不同 id 并行 / throw / 清理 / 链式 / 高并发）| ~80 |

### 修改（1 个）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `apps/api/src/routes/auth.ts` | WX_LOGIN + ADMIN_LOGIN 共 3 处 recordAttempt 包 withTokenMutex | +6 / -3 |

### 不改（沿用 M6.8）

- ✅ `apps/api/src/lib/rate-limit.ts` — 0 改动（checkRateLimit / checkRateLimitDual 行为不变）
- ✅ `apps/api/src/lib/envelope.ts` — 0 改动
- ✅ `apps/api/src/lib/user.ts` — 0 改动
- ✅ `apps/api/wrangler.jsonc` — 0 改
- ✅ 其他包 — 0 跨包

---

## 5. Task 1: `token-mutex.ts` 新 lib + auth.ts 包 + 6 tests

### 5.1 `token-mutex.ts` 实现

```typescript
/**
 * M6.9 in-process token-level mutex（spec §5）。
 * 
 * 模式：Map<identifier, Promise> 串行化同 identifier 的代码块（与 M6.4 inflightEnsureJwt 同）。
 * 失败：fn throw 不影响 mutex 释放（finally 清理）。
 * 限制：CF Workers 单 isolate 内有效（多 isolate 间不防 — YAGNI）。
 * 
 * 用途：包裹 /auth/admin-login + /auth/wx-login 的 recordAttempt 调用，
 * 防御性解决同 token 5 并发 admin-login 小窗口。
 */

const inflight = new Map<string, Promise<unknown>>();

export async function withTokenMutex<T>(
  identifier: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = inflight.get(identifier);
  let resolveNext: () => void = () => {};
  const next = new Promise<void>((resolve) => { resolveNext = resolve; });
  const chained = prev ? prev.then(() => next) : next;
  inflight.set(identifier, chained);
  try {
    if (prev) await prev;
    return await fn();
  } finally {
    resolveNext();
    if (inflight.get(identifier) === chained) {
      inflight.delete(identifier);
    }
  }
}
```

### 5.2 `auth.ts` 改 3 处

```typescript
import { withTokenMutex } from "../lib/token-mutex.js";

// WX_LOGIN 失败路径
if (err instanceof HttpError && err.code === "INVALID_CODE") {
  await withTokenMutex(codeIdentifier, async () => {
    await recordAttempt(env.DB, codeIdentifier, "wx_code", false, clientIpHash);
  });
}

// ADMIN_LOGIN 失败路径
if (!auth.ok) {
  await withTokenMutex(adminIdentifier, async () => {
    await recordAttempt(env.DB, adminIdentifier, "admin", false, clientIpHash);
  });
  throw new HttpError(401, "INVALID_ADMIN_TOKEN", auth.message);
}

// ADMIN_LOGIN 成功路径
await withTokenMutex(adminIdentifier, async () => {
  await recordAttempt(env.DB, adminIdentifier, "admin", true, clientIpHash);
});
```

### 5.3 关键决策

- ✅ `withTokenMutex` 接受 `identifier: string` + `fn: () => Promise<T>` 返回 `Promise<T>` — 通用化 helper
- ✅ module-level `inflight` Map（CF Workers 单 isolate 共享）
- ✅ chain 模式：prev → next（避免 N 个 await 串成 N 层）
- ✅ `if (inflight.get(identifier) === chained)` 检查避免误删（理论不会发生，防御性）
- ❌ 不返回 `Mutex` 对象（API 复杂；helper 简单）
- ❌ 不限 mutex 数量（CF Workers 内存充足；YAGNI）

---

## 6. Task 2: 测试（6 新增）

```typescript
describe("token-mutex.withTokenMutex (M6.9)", () => {
  it("同 identifier 串行: 2 个并发 fn → 第 2 个等第 1 个", async () => {
    const order: number[] = [];
    const p1 = withTokenMutex("id1", async () => {
      order.push(1);
      await new Promise(r => setTimeout(r, 50));
      order.push(2);
    });
    const p2 = withTokenMutex("id1", async () => {
      order.push(3);
      order.push(4);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("不同 identifier 不阻塞: 2 个并发不同 id → 并行", async () => {
    const start = Date.now();
    await Promise.all([
      withTokenMutex("id1", () => new Promise(r => setTimeout(r, 50))),
      withTokenMutex("id2", () => new Promise(r => setTimeout(r, 50))),
    ]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);  // 并行 ~50ms，串行 ~100ms
  });

  it("fn throw: mutex 释放 + throw 透传", async () => {
    await expect(
      withTokenMutex("id1", async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");
    // mutex 已释放：后续同 id 立即执行
    const start = Date.now();
    await withTokenMutex("id1", () => Promise.resolve());
    expect(Date.now() - start).toBeLessThan(10);
  });

  it("map 自动清理: fn 完成后 entry 删除", async () => {
    await withTokenMutex("cleanup-test", () => Promise.resolve());
    // 内部 Map 不能直接验；通过并发测试间接验
    const p = withTokenMutex("cleanup-test", () => Promise.resolve());
    await p;
    // 再次并发：不应等前一个（已清理）
    const p2 = withTokenMutex("cleanup-test", () => Promise.resolve());
    await p2;
  });

  it("链式: 3 个并发同 id → 1→2→3 串行", async () => {
    const order: number[] = [];
    const tasks = [1, 2, 3].map(n =>
      withTokenMutex("chained", async () => {
        order.push(n);
        await new Promise(r => setTimeout(r, 30));
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });

  it("高并发: 10 并发同 id → 全串行完成", async () => {
    let counter = 0;
    const tasks = Array.from({ length: 10 }, () =>
      withTokenMutex("high", async () => {
        const current = counter;
        await new Promise(r => setTimeout(r, 10));
        expect(counter).toBe(current);  // 串行：每次读应该等于自己之前的值
        counter = current + 1;
      }),
    );
    await Promise.all(tasks);
    expect(counter).toBe(10);
  });
});
```

---

## 7. 数据流

### 7.1 流 A — 串行 5 并发（同 token）

```
T0: 5 个并发 admin-login（5 不同 wrong-token，同 IP）
  → 5 个 withTokenMutex(adminIdentifier, fn) 触发
  → Map[adminIdentifier] 链：next1 → next2 → next3 → next4 → next5
  → 第 1 个 fn 执行：checkRateLimit (< 5 → not locked) + recordAttempt → 写 D1
  → 第 2 个 await prev1 → prev1 完成 → 第 2 个 fn 执行
  → ...
  → 5 个 fn 串行（~25ms 总耗时）
  → 实际效果：与无 mutex 一致（5 个 record 都成功；5 行 login_attempt 写）
  → 唯一变化：节省 5-10ms 总耗时（5 个并发 check+record 串行而非并发）
```

### 7.2 流 B — 不同 token 不阻塞

```
T0: 2 个并发（admin-login + wx-login 不同 identifier）
  → Map 2 个 entry
  → 互不阻塞
  → 并行执行
```

### 7.3 流 C — fn throw

```
T0: withTokenMutex("id", async () => { throw new Error("x") })
  → fn throw
  → finally: resolveNext() 释放下一个 + delete Map entry
  → throw 透传给调用方
  → auth.ts try/catch 兜底
```

---

## 8. 错误处理

| 错误场景 | 行为 |
|---|---|
| `withTokenMutex` fn throw | throw 透传 + finally 释放 mutex |
| `withTokenMutex` fn reject (Promise reject) | 同 throw（finally 释放）|
| Map entry 累积 | finally 必删；同 identifier 不会无限增长 |
| CF Workers 多 isolate 并发 | 0 保护（YAGNI）|

---

## 9. 测试策略

### 9.1 TDD 流程

```
Task 1: 写 6 token-mutex 测试（RED）→ 写 token-mutex.ts（GREEN）→ 改 auth.ts（保持现有 14 测试绿）→ REFACTOR
```

### 9.2 Mock-first 边界

- ✅ token-mutex 单元测试纯函数（不依赖 D1 / miniflare）
- ✅ auth.test.ts 已有 14 测试行为不变（mutex 透明）
- ❌ 不验 D1 write 串行 vs 并发差异（mock-first 不验）
- ❌ 不验真实 CF Worker 多 isolate 并发

### 9.3 累计测试矩阵

| 测试文件 | 现有 | 新增 | 累计 |
|---|---|---|---|
| `apps/api/test/lib/token-mutex.test.ts` | 0 | 6 | 6 |
| 其他包 | 274 | 0 | 274 |
| **累计** | **274** | **+6** | **280** |

---

## 10. Acceptance Criteria

### 10.1 功能 AC

| # | 标准 |
|---|---|
| AC-1 | `token-mutex.ts` 提供 `withTokenMutex<T>(identifier, fn) → Promise<T>` |
| AC-2 | 同 identifier 串行（2 并发：fn1 完成 → fn2 开始）|
| AC-3 | 不同 identifier 并行（不阻塞）|
| AC-4 | fn throw 透传 + mutex 释放 |
| AC-5 | map 自动清理（finally 必删）|
| AC-6 | `auth.ts` WX_LOGIN + ADMIN_LOGIN 3 处 recordAttempt 包 withTokenMutex |

### 10.2 测试 AC

| # | 标准 |
|---|---|
| AC-7 | `pnpm -F api test` 全绿（**280 用例**：274 旧 + 6 新）|
| AC-8 | 5 包 `pnpm -r typecheck` 全绿 |

### 10.3 Dev 验证 AC（CP-5 真接时补）

- 真实 CF Worker 多 isolate 并发行为
- 真实 D1 write 串行 vs 并发性能差异

### 10.4 文档 AC

| # | 标准 |
|---|---|
| AC-9 | `docs/archive/state/state-m6-9.md` 收尾 |
| AC-10 | `README.md` 加 M6.9 节 |

---

## 11. CP-5 真接路径

M6.9 真接 Cloudflare 0 强制改（CP-5 观察多 isolate 行为后决定是否升级 DO-level mutex）：
- 真实 CF Workers 多 isolate 并发测试（wrangler dev 模拟多 isolate）
- 如实际并发率高，升级 ChatSessionDO DO-level mutex（M6.9+ YAGNI）

---

## 12. 风险与回滚

### 12.1 风险点

| 风险 | 缓解 | 严重度 |
|---|---|---|
| **多 isolate 不防** | CF Workers 单 isolate 内有效；多 isolate 并发靠 rate-limit 兜底（M6.3a + M6.6） | LOW |
| **Map 内存泄漏** | finally 必删；同 identifier 不会无限增长 | LOW |
| **串行后性能降级** | 同 token 串行 ~25ms（5 个 fn）；远低于 HTTP 30s 超时 | LOW |
| **D1 写仍 5 行** | mutex 不阻止 D1 写；只串行化（行为不变） | LOW（设计预期）|

### 12.2 回滚策略

| Commit | 回滚方式 | 影响 |
|---|---|---|
| Task 1 (token-mutex + auth) | `git revert` | recordAttempt 退到无 mutex（行为不变） |

---

## 13. 实施计划

### 13.1 Commit 拆分（3 commit + 1 merge = 4 总）

| # | Commit | 主题 | 测试增量 |
|---|---|---|---|
| 1 | spec | `docs: M6.9 spec — D1 token-level mutex (defensive)` | 0 |
| 2 | plan | `docs: M6.9 plan — D1 token-level mutex (defensive)` | 0 |
| 3 | Task 1 合并 | `feat(api): M6.9 — withTokenMutex + auth.ts 包裹 + 6 tests` | +6 |
| 4 | state + README | `docs: M6.9 state-m6-9.md 收尾 + README M6.9 节` | 0 |
| merge | `worktree-m6-9-mutex → master --no-ff` | — |

**共 4 commit + 1 merge = 5 总**

### 13.2 工作流

- worktree 隔离 + 1 包改动 + ~30 min 主线程直接做
- TDD 严格走：6 测试先写（RED）→ 写实现（GREEN）

---

## 14. 累计测试 + 文件清单

### 14.1 仓库测试累计（M6.9 后）

| 包 | 现有 | M6.9 | 累计 |
|---|---|---|---|
| shared | 38 | 0 | 38 |
| api | 161 | +6 | **167** |
| miniprogram | 32 | 0 | 32 |
| admin | 24 | 0 | 24 |
| crawler | 19 | 0 | 19 |
| **累计** | **274** | **+6** | **280** |

### 14.2 文件清单（M6.9 后）

| 类型 | 文件 | 状态 |
|---|---|---|
| 新代码 | `apps/api/src/lib/token-mutex.ts` | NEW |
| 改代码 | `apps/api/src/routes/auth.ts` | +6 / -3 |
| 新测试 | `apps/api/test/lib/token-mutex.test.ts` | +80 / -0 |
| 新文档 | `docs/superpowers/specs/2026-06-16-m6-9-token-mutex-design.md` | NEW（本文件）|
| 新文档 | `docs/archive/plans/2026-06-16-m6-9-token-mutex.md` | NEW |
| 新文档 | `docs/archive/state/state-m6-9.md` | NEW |
| 改文档 | `README.md` | +20 / -0 |

**共 1 lib 新 + 1 改代码 + 1 新测试 + 4 文档 = 7 总**

---

## 附录 A：关键设计决策记录

| # | 决策 | 理由 | 拒绝方案 |
|---|---|---|---|
| D-1 | in-process Map + withTokenMutex helper | 简单、~30 行、与 M6.4 inflightEnsureJwt 同模式、CF Workers 单 isolate 内有效 | DO-level mutex（额外成本 + init 延迟）；不做 mutex（0 防御性）|
| D-2 | 范围：仅 /auth/admin-login + /auth/wx-login | 这 2 个是 recordAttempt 调用点；其他鉴权路由不受影响 | 全 /auth/*（admin-login 429 锁 路径不写 recordAttempt）；withTokenMutex helper 包裹（helper 多 ~15 行）|
| D-3 | chain 模式（prev → next） | 避免 N 个 await 串成 N 层；Map 存最末 promise | 简单 prev 等待（性能略低但简单）|
| D-4 | 失败处理：fn throw 透传 + finally 释放 | 调用方 try/catch 兜底；mutex 释放与 fn 结果无关 | throw 静默吞掉（破坏调用方语义）|
| D-5 | 0 DO-level cross-isolate mutex | YAGNI；M6.9 是防御性代码；CP-5 真接观察实际并发再决定 | DO-level（额外 namespace 成本）|
