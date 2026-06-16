# Plan: M6.10 — Admin IP Allowlist

- **Spec**：`docs/superpowers/specs/2026-06-16-m6-10-admin-allowlist-design.md`（commit `982c4ec`）
- **日期**：2026-06-16
- **复杂度**：Trivial（1 lib 新 + 2 改 + 7 新测试 + ~15 min 主线程直接做）
- **Mock-first 边界**：纯函数 + fake req.headers mock CF-Connecting-IP

---

## 1. Requirements Restatement

admin 误锁 UX 优化：`env.ADMIN_IP_ALLOWLIST` 静态 IP 列表，admin IP 跳过 /auth/admin-login 的 rate-limit（M6.6 per-IP 锁）；per-token 限流仍生效。

**核心交付**：

| # | 包 | 文件 | 内容 |
|---|---|---|---|
| 1 | apps/api | `src/lib/admin-ip-allowlist.ts` | 新 `parseAdminIpAllowlist(env)` + `isAdminIpAllowed(clientIp, allowlist)` |
| 2 | apps/api | `src/routes/auth.ts` | ADMIN_LOGIN 加白名单 check 前置；wx-login 不变 |
| 3 | apps/api | `src/types.ts` | Env 加 `ADMIN_IP_ALLOWLIST?: string` |
| 4 | apps/api | `test/lib/admin-ip-allowlist.test.ts` | 新 5 用例（parse 5 + isAllowed 3） |
| 5 | apps/api | `test/routes/auth.test.ts` | 2 新增（白名单 admin 跳过 + 非白名单正常限流）|

**不交付**（推到 M6.10+ / YAGNI）：
- admin 手动 unlock endpoint（M6.9 mutex 防御已够；新增 endpoint 价值低）
- 阈值从 5 提到 10（安全降低；与攻击者面同）
- IPv6 CIDR 范围（白名单通常 1-5 个 IP；comma-separated 够用）
- 白名单动态更新（wrangler vars restart 即可）

**新增用例**：7（5 admin-ip-allowlist + 2 auth）。**累计 287**（280 + 7）。

---

## 2. Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| env 配置 | `apps/api/wrangler.jsonc` `vars` 块 | `env.ADMIN_IP_ALLOWLIST` 是 vars（comma-separated）|
| 简单解析 | `apps/api/src/lib/rate-limit.ts:48-60` `readRateLimitConfig` | parseAdminIpAllowlist 类似 split + trim + filter |
| auth route 前置 | `apps/api/src/routes/auth.ts:171-182` checkRateLimitDual | M6.10 加白名单 check 前置 |

---

## 3. Files to Change

### 新建（2 个）

| 文件 | 内容 | 预估行数 |
|---|---|---|
| `apps/api/src/lib/admin-ip-allowlist.ts` | `parseAdminIpAllowlist` + `isAdminIpAllowed` | ~20 |
| `apps/api/test/lib/admin-ip-allowlist.test.ts` | 5 测试（parse 5 + isAllowed 3） | ~50 |

### 修改（3 个）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `apps/api/src/routes/auth.ts` | ADMIN_LOGIN 加白名单 check 前置 | +6 / -2 |
| `apps/api/src/types.ts` | Env 加 `ADMIN_IP_ALLOWLIST?: string` | +1 / -0 |
| `apps/api/test/routes/auth.test.ts` | 2 新增（白名单 + 非白名单） | +40 / -0 |

### 不改（沿用 M6.9）

- ✅ `apps/api/src/lib/rate-limit.ts` — 0 改动
- ✅ `apps/api/src/lib/token-mutex.ts` — 0 改动
- ✅ `apps/api/src/lib/envelope.ts` — 0 改动
- ✅ `apps/api/wrangler.jsonc` — 0 改（env.ADMIN_IP_ALLOWLIST 是 vars）
- ✅ 其他包 — 0 跨包

---

## 4. Tasks (1 task / 2 checkpoint)

### Phase 1 — 主线程直接实施（1 task / CP-1 + CP-2）

按 M6.3c/d/4/5/6/7/8/9 教训应用，主线程直接做（1 包 + ~15 min）。

**Task 1: admin-ip-allowlist.ts 新 + auth.ts 改 + types.ts 改 + 7 tests**

- Action 1.1: 写 5 admin-ip-allowlist 测试（RED）：

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

- Action 1.2: 写 admin-ip-allowlist.ts 实现（GREEN）：

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

- Action 1.3: 改 `apps/api/src/types.ts`：

  ```typescript
  // M6.10: admin IP 白名单（comma-separated；空 = 行为不变）
  ADMIN_IP_ALLOWLIST?: string;
  ```

- Action 1.4: 改 `apps/api/src/routes/auth.ts` ADMIN_LOGIN 路径：

  ```typescript
  import { parseAdminIpAllowlist, isAdminIpAllowed } from "../lib/admin-ip-allowlist.js";

  // 在 clientIpHash 后，rate-limit 前：
  const clientIp = getClientIp(request);  // 已存在
  const adminAllowlist = parseAdminIpAllowlist(env);
  const isAdminIp = isAdminIpAllowed(clientIp, adminAllowlist);

  let rateCheck = { locked: false, retry_after: 0 };
  if (!isAdminIp) {
    rateCheck = await checkRateLimitDual(
      env.DB, adminIdentifier, clientIpHash, "admin", Date.now(), readRateLimitConfig(env),
    );
  }
  if (rateCheck.locked) { /* 429 ... */ }
  ```

- Action 1.5: 改 `apps/api/test/routes/auth.test.ts` 加 2 新测试（白名单 admin 跳过 + 非白名单正常限流）：

  ```typescript
  it("admin IP 白名单: env.ADMIN_IP_ALLOWLIST 含 client IP → 5 次错不锁（跳过 per-IP 限流）", async () => {
    // 5 次错 token → 全部 401（per-token 不锁因不同 token；5 个不同 wrong-token）
    // 第 6 次：仍 401（per-IP 已跳过，admin IP 不锁）
  });

  it("admin IP 不在白名单: 5 次错 admin_token → 第 6 次 429（per-IP 限流生效）", async () => {
    // 5 次错 token → 全部 401
    // 第 6 次：429
  });
  ```

- Mirror: `apps/api/src/lib/rate-limit.ts:48-60` `readRateLimitConfig` 模式；现有 `auth.ts` rate-limit 前置
- Validate:
  ```bash
  pnpm -F api test test/lib/admin-ip-allowlist.test.ts    # 5 新绿
  pnpm -F api test test/routes/auth.test.ts               # 14 旧 + 2 新 = 16 绿
  pnpm -F api test                                       # 174 全绿
  pnpm -r typecheck                                      # 5 包全绿
  pnpm -F api build                                      # wrangler dry-run OK
  ```
  期望：5 + 2 新 + 14 旧 = 21 绿 + 5 包 typecheck + build
  🛑 **CP-1 + CP-2**: api 174 绿 + 5 包 typecheck + build

### Phase 2 — 主线程收尾（Task 2 / CP-3）

**Task 2: state-m6-10.md 收尾 + README M6.10 节 + worktree merge**

- Action 2.1: 写 `docs/superpowers/state-m6-10.md`（10 sections）
- Action 2.2: 改 `README.md`（M6.10 节 ~30 行）
- Action 2.3: worktree merge + cleanup

---

## 5. Validation

```bash
# Worktree 隔离
git worktree add .claude/worktrees/m6-10-admin-allowlist -b worktree-m6-10-admin-allowlist
cd .claude/worktrees/m6-10-admin-allowlist

# CP-1 + CP-2（Task 1 完成后）
pnpm -F api test test/lib/admin-ip-allowlist.test.ts    # 5
pnpm -F api test test/routes/auth.test.ts               # 16
pnpm -F api test                                       # 174
pnpm -r typecheck                                      # 5 包全绿
pnpm -F api build

# CP-3（merge 后）
cd /Users/Mark/cc_project/unequal
pnpm -r test                                           # 287 全绿
```

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| 白名单 IP 误配 | 中 | admin 责任配 env；dev 默认空 = 行为不变 |
| 静态 IP 变更 | 低 | admin 需手动更新 env；CP-5 流程文档强提示 |
| 白名单绕过 per-token 限流 | 设计预期 | per-token 限流仍生效（防御 5 错 token）|
| IPv6 白名单 | 低 | O(N) includes 仍工作；YAGNI CIDR |

**最高风险**：白名单 IP 误配。Mitigation：dev 默认空 + 文档强提示。

---

## 7. Acceptance

- [ ] 7 新增用例全绿
- [ ] 累计 287 用例全绿（api 174 + admin 24 + mini 32 + shared 38 + crawler 19）
- [ ] 5 包 typecheck 全绿
- [ ] wrangler build 成功
- [ ] 主线程独立 CP-3 验证
- [ ] state-m6-10.md 完整
- [ ] README M6.10 节
- [ ] merge + cleanup

**dev 验证缺口**（CP-5）：
- 真实 CF Workers 注入 `env.ADMIN_IP_ALLOWLIST` 行为
- 真实 admin 跨多 IP 池场景

---

## 8. Implementation Notes

### 8.1 Subagent 分配

M6.10 1 task 1 包 → 主线程直接做（~15 min）。

### 8.2 Commit 节奏（3 commit + 1 merge = 4 总）

```
1. feat(api): M6.10 — admin IP allowlist (parseAdminIpAllowlist + isAdminIpAllowed) + auth.ts 包裹 + 7 tests
              [🛑 CP-1 + CP-2: api 174 绿 + 5 包 typecheck + build]
2. docs: M6.10 state-m6-10.md 收尾 + README M6.10 节
merge: worktree-m6-10-admin-allowlist → master --no-ff
       [🛑 CP-3: 主仓库独立验证 287 绿]
```

注：1 commit 包含 lib + auth + types + 5 + 2 测试同步发布（极简）。

### 8.3 Worktree 路径

- 创建：`git worktree add .claude/worktrees/m6-10-admin-allowlist -b worktree-m6-10-admin-allowlist`
- 清理：`git worktree remove .claude/worktrees/m6-10-admin-allowlist` + `git branch -D`
- merge：`git merge --no-ff worktree-m6-10-admin-allowlist -m "..."`

### 8.4 mock-first 边界

- ✅ admin-ip-allowlist 单元测试纯函数（不依赖 D1 / miniflare）
- ❌ 不验 admin 跨多 IP 池场景
- ❌ 不验 IPv6 CIDR 范围
