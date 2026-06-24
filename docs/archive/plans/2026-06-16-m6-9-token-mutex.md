# Plan: M6.9 — D1 Token-Level Mutex (Defensive)

- **Spec**：`docs/superpowers/specs/2026-06-16-m6-9-token-mutex-design.md`（commit `734f4d0`）
- **日期**：2026-06-16
- **复杂度**：Trivial（1 lib 新 + 1 改 + 6 新测试 + 主线程直接做 ~15 min）
- **Mock-first 边界**：纯 in-process Map 单元测试，不验 D1 / miniflare / 多 isolate

---

## 1. Requirements Restatement

把 M6.3a 留口的"同 token 5 并发 admin-login 小窗口"防御性加固：in-process Map + withTokenMutex helper 串行化同 identifier 的 recordAttempt 块。

**核心交付**：

| # | 包 | 文件 | 内容 |
|---|---|---|---|
| 1 | apps/api | `src/lib/token-mutex.ts` | 新 `withTokenMutex<T>(identifier, fn) → Promise<T>` + module-level `inflight: Map<string, Promise>` |
| 2 | apps/api | `test/lib/token-mutex.test.ts` | 新 6 用例（同 id 串行 / 不同 id 并行 / throw / 清理 / 链式 / 高并发）|
| 3 | apps/api | `src/routes/auth.ts` | WX_LOGIN + ADMIN_LOGIN 共 3 处 recordAttempt 包 withTokenMutex |

**不交付**（推到 M6.9+ / YAGNI）：
- DO-level cross-isolate mutex（额外 namespace 成本 + init 延迟）
- backoff / retry（同 token 单 isolate 几乎无并发）
- Admin 误锁 UX 优化（M6.10 单独 spec）

**新增用例**：6。**累计 280**（274 + 6）。

---

## 2. Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| inflight promise | `apps/miniprogram/lib/api.ts` M6.4 `inflightEnsureJwt: Map<string, Promise<string>>` | token-mutex.ts `Map<string, Promise>` 串行化（同模式）|
| Map 自动清理 | `apps/miniprogram/lib/api.ts` M6.4 `.finally(() => delete)` | token-mutex.ts `finally` 清理 Map entry |
| auth route 调用 | `apps/api/src/routes/auth.ts:114, 189, 196` `recordAttempt` | M6.9 加 mutex 包裹 |
| 失败处理 | `apps/api/src/routes/auth.ts:131-135` try/catch | M6.9 withTokenMutex throw 透传，try/catch 兜底 |

---

## 3. Files to Change

### 新建（2 个）

| 文件 | 内容 | 预估行数 |
|---|---|---|
| `apps/api/src/lib/token-mutex.ts` | `withTokenMutex<T>(identifier, fn) → Promise<T>` + module-level `inflight: Map<string, Promise>` | ~30 |
| `apps/api/test/lib/token-mutex.test.ts` | 6 新测试 | ~80 |

### 修改（1 个）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `apps/api/src/routes/auth.ts` | WX_LOGIN + ADMIN_LOGIN 3 处 recordAttempt 包 withTokenMutex | +6 / -3 |

### 不改（沿用 M6.8）

- ✅ `apps/api/src/lib/rate-limit.ts` — 0 改动
- ✅ `apps/api/src/lib/envelope.ts` — 0 改动
- ✅ `apps/api/src/lib/user.ts` — 0 改动
- ✅ `apps/api/wrangler.jsonc` — 0 改
- ✅ 其他包 — 0 跨包

---

## 4. Tasks (1 task / 2 checkpoint)

### Phase 1 — 主线程直接实施（1 task / CP-1 + CP-2）

按 M6.3c/d/4/5/6/7/8 教训应用，本 plan **不派 subagent**，主线程直接做（1 包 + ~15 min 估时）。

**Task 1: token-mutex.ts 新 lib + auth.ts 包 + 6 tests**

- Action 1.1: 写 6 token-mutex 测试（RED）：

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
      expect(Date.now() - start).toBeLessThan(100);
    });

    it("fn throw: mutex 释放 + throw 透传", async () => {
      await expect(
        withTokenMutex("id1", async () => { throw new Error("boom"); }),
      ).rejects.toThrow("boom");
      const start = Date.now();
      await withTokenMutex("id1", () => Promise.resolve());
      expect(Date.now() - start).toBeLessThan(10);  // 立即执行
    });

    it("map 自动清理: fn 完成后 entry 删除（间接验）", async () => {
      await withTokenMutex("cleanup-test", () => Promise.resolve());
      const p = withTokenMutex("cleanup-test", () => Promise.resolve());
      await p;
      // 后续同 id 立即执行（map 已清）
      const start = Date.now();
      await withTokenMutex("cleanup-test", () => Promise.resolve());
      expect(Date.now() - start).toBeLessThan(10);
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

- Action 1.2: 写 token-mutex.ts 实现（GREEN，spec §5.1 完整代码）：

  ```typescript
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

- Action 1.3: 改 `apps/api/src/routes/auth.ts` 3 处包裹（保持现有 14 测试绿）：

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

- Mirror: `apps/miniprogram/lib/api.ts` M6.4 `inflightEnsureJwt` 模式；现有 `auth.ts` try/catch
- Validate:
  ```bash
  pnpm -F api test test/lib/token-mutex.test.ts    # 6 新绿
  pnpm -F api test test/routes/auth.test.ts         # 14 旧绿（行为不变）
  pnpm -F api test                                   # 167 全绿
  pnpm -r typecheck                                  # 5 包全绿
  pnpm -F api build                                  # wrangler dry-run OK
  ```
  期望：6 新 + 14 旧 = 20 绿 + 5 包 typecheck + build 成功
  🛑 **CP-1 + CP-2**: api 167 绿 + 5 包 typecheck + build

### Phase 2 — 主线程收尾（Task 2 / CP-3）

**Task 2: state-m6-9.md 收尾 + README M6.9 节 + worktree merge**

- Action 2.1: 写 `docs/superpowers/state-m6-9.md`（10 sections）
- Action 2.2: 改 `README.md`（M6.9 节 ~20 行：in-process Map + 6 限制 + 价值低说明）
- Action 2.3: worktree merge + cleanup

---

## 5. Validation

```bash
# Worktree 隔离
git worktree add .claude/worktrees/m6-9-mutex -b worktree-m6-9-mutex
cd .claude/worktrees/m6-9-mutex

# CP-1 + CP-2（Task 1 完成后）
pnpm -F api test test/lib/token-mutex.test.ts    # 6 新
pnpm -F api test                                  # 167 全绿
pnpm -r typecheck                                 # 5 包全绿
pnpm -F api build                                 # wrangler dry-run OK

# CP-3（merge 后）
cd /Users/Mark/cc_project/unequal
pnpm -r test                                      # 280 全绿
pnpm -r typecheck
```

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| 多 isolate 不防 | 中（YAGNI）| CF Workers 单 isolate 内有效；多 isolate 靠 rate-limit（M6.3a + M6.6）兜底；CP-5 观察实际并发决定是否升级 |
| Map 内存泄漏 | 极低 | finally 必删 |
| 串行后性能降级 | 低 | 同 token 串行 ~25ms（5 个 fn）；远低于 HTTP 30s 超时 |
| D1 写仍 5 行 | 设计预期 | mutex 不阻止 D1 写；只串行化（行为不变）|

**最高风险**：多 isolate 不防。Mitigation：M6.9 是防御性代码；CP-5 观察后决定。

---

## 7. Acceptance

- [ ] 6 新增用例全绿
- [ ] 累计 280 用例全绿（api 167 + admin 24 + mini 32 + shared 38 + crawler 19）
- [ ] 5 包 typecheck 全绿
- [ ] wrangler build 成功
- [ ] 主线程独立 CP-3 验证
- [ ] state-m6-9.md 完整
- [ ] README M6.9 节
- [ ] merge + cleanup

**dev 验证缺口**（CP-5）：
- 真实 CF Worker 多 isolate 并发行为
- 真实 D1 write 串行 vs 并发性能差异

---

## 8. Implementation Notes

### 8.1 Subagent 分配

M6.9 1 task 1 包 → 主线程直接做（~15 min）。

### 8.2 Commit 节奏（3 commit + 1 merge = 4 总）

```
1. feat(api): M6.9 task 1 — withTokenMutex (in-process Map) + auth.ts 包裹 + 6 tests
              [🛑 CP-1 + CP-2: api 167 绿 + 5 包 typecheck + build]
2. docs: M6.9 state-m6-9.md 收尾 + README M6.9 节
merge: worktree-m6-9-mutex → master --no-ff
       [🛑 CP-3: 主仓库独立验证 280 绿]
```

注：1 commit 包含 token-mutex.ts + auth.ts + 6 测试同步发布（极简实现 1 commit 即可）。

### 8.3 Worktree 路径

- 创建：`git worktree add .claude/worktrees/m6-9-mutex -b worktree-m6-9-mutex`
- 清理：`git worktree remove .claude/worktrees/m6-9-mutex` + `git branch -D`
- merge：`git merge --no-ff worktree-m6-9-mutex -m "..."`

### 8.4 mock-first 边界

- ✅ token-mutex 单元测试纯函数（不依赖 D1 / miniflare）
- ❌ 不验 D1 write 串行 vs 并发差异
- ❌ 不验真实 CF Worker 多 isolate 并发
