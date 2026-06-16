# M6.3a — Auth Hardening（rate limit + RequireAuth 全包 + 401 refresh）

**版本**: 2026-06-16
**前置**: M6.2 wx.login + JWT（已 merge `3f6b07f`）
**范围**: M6.3 拆分后的 a 部分 — 3 项独立安全收口；用户体验项（session_key + userInfo）推 M6.3b。

---

## 1. Requirements

M6.2 收尾后留下 3 个生产前必须堵的口：

| # | 来源 | 现状 | 目标 |
|---|---|---|---|
| A | M6.2 admin LoginPage 无防爆破 | 任意人可暴力遍历 admin_token | 5 次 / 15min 锁定，返 429 + retry_after |
| B | M6.2 admin App.tsx 仅 `/chat-sim` 被 RequireAuth | 8 admin 路由（upload/sources/documents/search/ask/crawl×3）仍走 M3 dev fallback | 9 路由全包 RequireAuth（仅 `/login` 公开）|
| C | M6.2 jwt 24h 过期，client 无 refresh | 用户每天需手动重登（小程序）/ admin token 过期直接 401 | miniprogram 透明 wx.login + retry；admin 跳 /login 强刷 |

**为什么 a/b 拆分**：M6.3 原列 5 项，其中 session_key 存 D1 + wx.getUserInfo 解密 nickname/avatar 是用户体验提升（mock-first 阶段 nickname=NULL 不阻塞功能），且涉及 AES-CBC 解密 + 微信 `wx.getUserProfile` deprecated 调研，独立 spec 更合理。M6.3a 仅做"M6.2 不做就不能上生产"的 3 项。

---

## 2. Patterns to Mirror

| 类别 | 来源 | 复用方式 |
|---|---|---|
| Error 类型 | `apps/api/src/lib/auth.ts:4-13` `HttpError` | rate limit 用 `throw new HttpError(429, "RATE_LIMITED", "...")` |
| 路由 try/catch 模式 | `apps/api/src/routes/auth.ts:45-54` `handleHttpError` | `/auth/admin-login` 改造继续用同模式 |
| D1 query 模式 | `apps/api/src/lib/user.ts` `findOrCreateUser` | login_attempt 查询用 prepared statement + `.bind()` |
| ULID 生成 | `packages/shared/src/ulid.ts` | login_attempt.id |
| sha256 hash | Web Crypto `crypto.subtle.digest('SHA-256', ...)` | admin_token identifier hash（Workers 内置，无需依赖） |
| fetchImpl 注入 | `apps/api/src/lib/wx.ts:13` `Jscode2SessionOptions.fetchImpl` | miniprogram `fetchWithRefresh` 也接 fetchImpl 注入（测试用） |
| miniprogram fetch wrapper | `apps/miniprogram/lib/api.ts:36-71` `wxRequestAsFetch` + `getFetch` | 新 `fetchWithRefresh` 包一层 401 处理 |
| admin RequireAuth HOC | `apps/admin/src/App.tsx:19-28` | 直接复用，包剩余 8 路由 |
| jsdom 单测 | `apps/admin/src/pages/LoginPage.test.tsx`（M6.2 SA4 建立）| LoginPage 429 倒计时测试同模式 |

---

## 3. Architecture Overview

3 子系统独立可并行：

```
┌─────────────────────────────────────────────────────────┐
│ A: server rate limit                                    │
│   migration 0005 → login_attempt table                  │
│   routes/auth.ts → 改造 /auth/admin-login + /auth/wx-login │
│   lib/rate-limit.ts → 新建（checkRateLimit + recordAttempt）│
├─────────────────────────────────────────────────────────┤
│ B: admin RequireAuth 全包                               │
│   admin/src/App.tsx → 9 路由全包，仅 /login 公开        │
├─────────────────────────────────────────────────────────┤
│ C: client 401 refresh                                   │
│   miniprogram/lib/api.ts → 新 fetchWithRefresh wrapper  │
│   admin/src/lib/api.ts → 401 → navigate("/login")       │
└─────────────────────────────────────────────────────────┘
```

3 项**几乎完全独立**（A 仅 server / B 仅 admin client / C 双 client），可分配给 3 个 subagent 并行执行。

---

## 4. Files to Change

| 文件 | 动作 | 内容 |
|---|---|---|
| `apps/api/migrations/0005_login_attempt.sql` | CREATE | login_attempt 表 + index |
| `apps/api/migrations/0005_login_attempt.down.sql` | CREATE | DROP TABLE |
| `apps/api/src/lib/rate-limit.ts` | CREATE | `checkRateLimit` + `recordAttempt` + `sha256Identifier` |
| `apps/api/src/lib/rate-limit.test.ts` | CREATE | 6 用例 |
| `apps/api/src/routes/auth.ts` | UPDATE | `/auth/admin-login` + `/auth/wx-login` 加 rate limit |
| `apps/api/src/routes/auth.test.ts` | UPDATE | +3 用例（admin 429 / wx 429 / retry_after 正确） |
| `apps/api/src/types.ts` | UPDATE（可能）| 无新字段（rate-limit 用现有 DB） |
| `apps/admin/src/App.tsx` | UPDATE | 9 路由全包 RequireAuth + catch-all `*` 包（仅 /login 公开） |
| `apps/admin/src/App.test.tsx` | CREATE | 3 用例（无 token → 9 路由全跳 /login / /login 公开 / RequireAuth 实例数 = 9） |
| `apps/admin/src/pages/LoginPage.tsx` | UPDATE | 收 429 显示倒计时 + 倒计时按钮恢复 |
| `apps/admin/src/pages/LoginPage.test.tsx` | UPDATE | +2 用例（429 倒计时显示 / 归零按钮可点） |
| `apps/admin/src/lib/api.ts` | UPDATE | `getApiFetch` 单点 401 → `window.location.href = "/login"` + clearToken |
| `apps/miniprogram/lib/api.ts` | UPDATE | 新 `fetchWithRefresh` wrapper，chat / sessions / ask 全走 |
| `apps/miniprogram/lib/api.test.ts` | UPDATE | +4 用例 |
| `docs/superpowers/specs/2026-06-16-m6-3a-auth-hardening-design.md` | CREATE | 本文档 |

**总计**：4 新建 / 9 修改 / 2 新建测试文件 / 1 spec。

---

## 5. API Spec

### 5.1 `/auth/admin-login` 改造

**Request**（不变）：
```http
POST /auth/admin-login
Content-Type: application/json

{ "admin_token": "<token>" }
```

**新增 pre-check（在 verifyAdminToken 之前）**：
```
1. identifier = sha256(admin_token).hex().slice(0, 16)
2. failedCount = SELECT COUNT(*) FROM login_attempt
                 WHERE identifier=? AND succeeded=0 AND attempt_type='admin'
                   AND created_at > now - 900_000
3. if failedCount >= 5:
     oldest = SELECT MIN(created_at) FROM login_attempt
              WHERE identifier=? AND succeeded=0 AND attempt_type='admin'
                AND created_at > now - 900_000
     retry_after = ceil((oldest + 900_000 - now) / 1000)
     return 429 { error: "RATE_LIMITED", retry_after }
4. 验 admin_token → INSERT login_attempt(id=ulid, identifier, attempt_type='admin',
                                          succeeded=1/0, created_at=now)
5. 成功 → 返 jwt（不变）；失败 → 401 INVALID_ADMIN_TOKEN（不变）
```

**Response（rate limited）**：
```json
HTTP/1.1 429 Too Many Requests
Content-Type: application/json

{ "error": "RATE_LIMITED", "message": "...", "retry_after": 723 }
```

### 5.2 `/auth/wx-login` 改造

**与 admin-login 同模式**，区别：
- `identifier = wx_openid`（已经是 hash，无需 sha256）
- `attempt_type = 'wx'`
- **仅在 jscode2session 失败后记 failed attempt**（jscode2session 自身网络错不计；防 wx.login 接口被刷）
- 阈值同：5 次 / 15min

**注意**：wx_openid 在 jscode2session 成功后才知道。所以 rate limit 顺序：
```
1. 先调 jscode2session（无 rate limit 拦截，因为还没有 identifier）
2. 失败（INVALID_CODE）→ 用 hash(code) 作 fallback identifier 记 failed attempt
   （防止有人用同一个无效 code 反复刷）
3. 成功 → 用 wx_openid 作 identifier
   - 查 failedCount（其他人用同 openid 失败？通常不会，但留口）
   - INSERT succeeded=1
```

**简化**：因 wx_openid 仅在成功后才有，且 jscode2session 失败的 code 本身就是一次性的（微信 5min 过期），刷攻击价值低。**M6.3a 中 wx rate limit 仅在 INVALID_CODE 时记 failed attempt（identifier = sha256(code).slice(0, 16)，type='wx_code'），不在成功路径计数**。这避免了 race condition 设计。

### 5.3 miniprogram 401 refresh wrapper

新 `apps/miniprogram/lib/api.ts` `fetchWithRefresh`：
```typescript
async function fetchWithRefresh(
  url: string,
  init: RequestInit,
  opts: ApiOptions,
  isRetry = false,
): Promise<ResponseLike> {
  const f = getFetch(opts);
  const res = await f(url, init);
  if (res.status !== 401 || isRetry) return res;
  // 401 + 非 retry → 触发刷新
  try {
    const newJwt = await ensureJwt(opts.baseUrl ?? "http://localhost:8787",
                                    opts.fetchImpl);
    // 重试原 request 1 次
    const newInit = {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${newJwt}` },
    };
    return await fetchWithRefresh(url, newInit, opts, true);
  } catch (refreshErr) {
    // wx.login 失败或 /auth/wx-login 失败 → 原 401 抛出
    return res;
  }
}
```

`ensureJwt` 已在 M6.2 `apps/miniprogram/lib/auth.ts` 实现 — wx.login 拿 code → POST /auth/wx-login → saveJwt → return jwt。

`chat` / `listSessions` / `renameSession` / `deleteSession` / `ask` 5 函数全走 `fetchWithRefresh`（替换现 `getFetch` 直调）。

### 5.4 admin 401 navigate

`apps/admin/src/lib/api.ts` 加 `handleApiResponse`：
```typescript
function handleApiResponse(res: Response): Response {
  if (res.status === 401) {
    localStorage.removeItem("admin_token");
    // 用 window.location 强刷绕过 react-router（避免 RequireAuth race）
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
  }
  return res;
}
```

所有 admin fetch 调用统一包：`handleApiResponse(await fetch(...))`。

### 5.5 admin App.tsx routing changes

9 protected routes + catch-all 全包 RequireAuth，仅 `/login` 公开：

```tsx
// 公开（已 M6.2 建立）
<Route path="/login" element={<LoginPage />} />

// 9 protected routes（M6.2 仅包 /chat-sim，M6.3a 全包）
<Route path="/upload"            element={<RequireAuth><Upload /></RequireAuth>} />
<Route path="/sources"           element={<RequireAuth><Sources /></RequireAuth>} />
<Route path="/documents"         element={<RequireAuth><Documents /></RequireAuth>} />
<Route path="/search"            element={<RequireAuth><SearchTest /></RequireAuth>} />
<Route path="/ask"               element={<RequireAuth><AskTest /></RequireAuth>} />
<Route path="/chat-sim"          element={<RequireAuth><ChatSim /></RequireAuth>} />
<Route path="/crawl"             element={<RequireAuth><CrawlPage /></RequireAuth>} />
<Route path="/crawl/xiaohongshu" element={<RequireAuth><XiaohongshuCrawlPage /></RequireAuth>} />
<Route path="/crawl/wechat-mp"   element={<RequireAuth><WechatMpCrawlPage /></RequireAuth>} />

// catch-all — 也包（M6.2 是裸 Upload，M6.3a 加 RequireAuth 避免侧门）
<Route path="*" element={<RequireAuth><Upload /></RequireAuth>} />
```

**为什么 catch-all 也包**：M6.2 路由 `path="*"` fallback 到 `<Upload />` 但没包 RequireAuth，等于"任何未知 path → 进 Upload"是个侧门。M6.3a 修复。

---

## 6. Data Model

### Migration 0005 `login_attempt`

```sql
-- 0005_login_attempt.sql
CREATE TABLE login_attempt (
  id          TEXT PRIMARY KEY,
  identifier  TEXT NOT NULL,                    -- sha256(admin_token).slice(0,16) | sha256(wx_code).slice(0,16) | wx_openid
  attempt_type TEXT NOT NULL CHECK (attempt_type IN ('admin', 'wx_code')),
  succeeded   INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  created_at  INTEGER NOT NULL                  -- Unix ms
);

CREATE INDEX idx_login_attempt_lookup
  ON login_attempt(identifier, attempt_type, created_at DESC);

-- 0005_login_attempt.down.sql
DROP INDEX IF EXISTS idx_login_attempt_lookup;
DROP TABLE IF EXISTS login_attempt;
```

**为什么不存 IP / UA**：mock-first 阶段 Cloudflare CF-Connecting-IP 头可信，但 admin 真接 dev 阶段不一定经 CF（localhost），simpler is better — per-token / per-code rate limit 已足够防爆破。**M6.4 可加 IP 维度**。

**清理策略**：不主动清理，依赖索引 `created_at DESC` 性能。锁定窗口 15min，单 admin 失败 5 行/15min，单 code 失败 1 行，5000 用户 × 5 行 = 25k 行/15min，量小。**M6.5+ 可加 cron 清理 24h 前的 attempts**。

---

## 7. Error Handling

### 7.1 Server-side

| 触发 | Status | Code | Body |
|---|---|---|---|
| admin 5 次 / 15min 失败 | 429 | RATE_LIMITED | `{ error, retry_after, message }` |
| wx_code 5 次 / 15min INVALID_CODE | 429 | RATE_LIMITED | `{ error, retry_after, message }` |
| admin token 错（不达阈值） | 401 | INVALID_ADMIN_TOKEN | （M6.2 不变）|
| INVALID_CODE（不达阈值） | 401 | INVALID_CODE | （M6.2 不变）|

### 7.2 Client-side（miniprogram）

| 场景 | 处理 |
|---|---|
| 任意路由 401（jwt 过期） | 触发 fetchWithRefresh → wx.login + /auth/wx-login + retry |
| Refresh wx.login 失败 | 原 401 透传给 caller |
| Refresh /auth/wx-login 429 | 原 401 透传 + ensureJwt 抛 429 给 caller |
| Refresh 后第二次 401 | 不再 retry，原 401 透传（避免死循环）|

### 7.3 Client-side（admin）

| 场景 | 处理 |
|---|---|
| 任意路由 401（jwt 过期）| clearToken + `window.location.href = "/login"` 强刷 |
| /login 收 429 | 显示倒计时 `锁定中 {retry_after}s` + 按钮禁用 |
| 倒计时归零 | 按钮恢复 + 计时清空 |

---

## 8. Mock-first Boundaries

| 组件 | 测试方式 | 真接路径 |
|---|---|---|
| D1 login_attempt | miniflare in-memory D1（M6.1 已有 setup） | CP-5 wrangler d1 migrations apply |
| sha256 hash | Web Crypto subtle.digest（Workers + jsdom + Node 都内置） | 原生 |
| miniprogram fetchWithRefresh | fetchImpl 注入 + mock 401/200 切换 | wx.request 真实运行 |
| admin LoginPage 429 倒计时 | jsdom fake timer + mock fetch 返 429 | 真接 Cloudflare 后真触发 |
| admin window.location 跳转 | jsdom mock `window.location.href` setter | 浏览器原生 |

**无新增 mock 边界**——全复用 M6.1/M6.2 已建立的 mock-first 基础设施。

---

## 9. Testing Strategy

### 9.1 用例分布（约 15 新增）

| 包 | 文件 | 新增 | 内容 |
|---|---|---|---|
| api | `lib/rate-limit.test.ts` | 6 | sha256 一致性 / 4 次失败不锁 / 5 次失败锁 / 锁定后 16min 解锁 / wx_code 同表独立计数 / retry_after 计算正确 |
| api | `routes/auth.test.ts` | 3 | admin-login 5+1 = 429 / wx-login INVALID_CODE 5+1 = 429 / 429 body 含 retry_after |
| admin | `App.test.tsx` | 3 | 无 token → /upload 跳 /login / /login 公开 / 验 RequireAuth 实例数（grep render output） |
| admin | `pages/LoginPage.test.tsx` | 2 | 429 显示倒计时 / 倒计时归零按钮可点 |
| miniprogram | `lib/api.test.ts` | 4 | 401 → 透明 refresh + retry / wx.login 失败 → 原 401 / 第二次 401 不死循环 / 5 函数共享 wrapper（chat 验证） |

**合计**：18 新增（不是 15 — spec §5 估算偏低，调整为 18 用例）

**最终**：164（M6.2 收尾）+ 18 = **182 用例**

### 9.2 关键 fixture

```typescript
// lib/rate-limit.test.ts
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM login_attempt").run();
});

it("5 次失败 → 第 6 次 429", async () => {
  for (let i = 0; i < 5; i++) {
    await recordAttempt(env.DB, "tokenhash", "admin", false);
  }
  const result = await checkRateLimit(env.DB, "tokenhash", "admin");
  expect(result.locked).toBe(true);
  expect(result.retry_after).toBeGreaterThan(0);
});

it("16min 解锁", async () => {
  vi.setSystemTime(new Date("2026-06-16T10:00:00Z"));
  for (let i = 0; i < 5; i++) {
    await recordAttempt(env.DB, "tokenhash", "admin", false);
  }
  vi.setSystemTime(new Date("2026-06-16T10:16:00Z"));
  const result = await checkRateLimit(env.DB, "tokenhash", "admin");
  expect(result.locked).toBe(false);
});
```

---

## 10. ECC Components

| 组件 | 用法 |
|---|---|
| `superpowers:brainstorming` | 本 spec 设计阶段（5 区块决策 + 用户认可）|
| `superpowers:using-superpowers` | entry dispatcher |
| ECC `plan` skill | 下一步 M6.3a plan 编写（替代 disabled `superpowers:writing-plans`）|
| `tdd-workflow` (ECC) | 6 + 3 + 3 + 2 + 4 用例 RED → GREEN → REFACTOR |
| `subagent-driven-development` (ECC) | 3 个 subagent 并行（SA1 server / SA2 admin / SA3 miniprogram）|
| `feedback_subagent_heartbeat_monitoring` | 每 subagent 单 task + cron 心跳 5min |
| `using-git-worktrees` | 已建立 `.claude/worktrees/m6-3a-auth-hardening` |
| `verification-before-completion` | CP-1（A）/ CP-2（B）/ CP-3（C）/ CP-4（merge）|
| `code-review` / `typescript-review` | rate-limit.ts / fetchWithRefresh / RequireAuth diff 必触发 |
| `security-reviewer` (ECC) | rate-limit 实施触发（防爆破 = OWASP A07）|

**ECC TypeScript rules 已加载**：
- `coding-style.md` → 严格 type、interfaces、no any、Zod 验证（rate-limit input 不需要 Zod，simple primitive）
- `testing.md` → vitest + AAA + descriptive name
- `security.md` → 不硬编码 secret（sha256 用 Web Crypto）
- `patterns.md` → Custom hook 模式（admin 不引新 hook，复用 RequireAuth）

---

## 11. Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| sha256 在 Workers 与 Node 行为不一致 | 低 | 中 | Web Crypto 标准 API，rate-limit.test.ts 在 miniflare 跑验证 |
| 401 refresh 死循环（refresh 自己 401）| 中 | 高 | `isRetry` flag 强制最多 retry 1 次 + ensureJwt 抛 429 时不二次 refresh |
| admin window.location 跳转破坏 react-router state | 低 | 低 | jsdom 测试 mock window.location；prod 强刷接受（jwt 过期场景不需要保留 state）|
| 锁定阈值 5 太严 / 太松 | 中 | 低 | 5 是 OWASP 推荐起点，可在 wrangler vars 配置化（M6.3a 先硬编码，M6.4 提取配置）|
| login_attempt 表无限增长 | 低 | 低 | 单用户 5 失败/15min × 5000 用户 = 25k/15min，索引性能足够；M6.5+ 加 cron 清理 |
| miniprogram fetchWithRefresh 并发 race（多请求同时 401）| 中 | 中 | 加锁机制太复杂；简单实现：每个请求各自 refresh，多余 wx.login 调用浪费但功能正确；M6.4 优化 |
| RequireAuth 全包后 /upload 等页面初次进入闪屏 | 中 | 低 | RequireAuth useEffect 跳转有 1 帧空白；用户接受（与 M6.2 /chat-sim 体验一致）|
| 429 wx_code identifier 用 sha256(code) 有人撞 hash 误锁 | 极低 | 极低 | sha256 撞概率 2^-64 with truncation，业务可忽略 |

**最高风险**：401 refresh 死循环 → 已有 `isRetry` 双保险。

---

## 12. Acceptance Criteria

- [ ] 18 新增用例全绿（rate-limit 6 + auth route 3 + admin App 3 + admin LoginPage 2 + miniprogram api 4）
- [ ] 累计 182 测试全绿（packages/shared 38 + apps/api 86 + apps/miniprogram 22 + apps/crawler 19 + apps/admin 17）
- [ ] `pnpm -r typecheck` 全绿
- [ ] `pnpm -F admin build` 成功
- [ ] migration 0005 双向（up + down）跑通 miniflare
- [ ] 主线程独立 verification：typecheck + test + build（不靠 subagent 自报）
- [ ] state-m6-3a.md 收尾文档（含 mock-first 边界 / dev 验证缺口 / CP-5 真接补丁）
- [ ] merge to master + worktree 清理 + branch 删除

**dev 验证缺口（CP-5 真接 Cloudflare 时补）**：
- admin LoginPage 真实暴力 6 次收 429 + 倒计时跑完
- 9 admin 路由真无 token 跳 /login
- miniprogram 真机让 jwt 过期 → 调 /chat 透明刷新

---

## 13. M6.3b Deferred（不在本 spec）

下次 brainstorm 单独写：

1. **session_key 存 D1**
   - migration 0006: user 表加 `session_key TEXT, session_key_updated_at INTEGER`
   - `findOrCreateUser` 接 session_key 参数
   - `/auth/wx-login` 调 jscode2session 后写 session_key

2. **wx.getUserInfo 解密 nickname/avatar**
   - 新 endpoint `/auth/wx-user-info`：接 encryptedData + iv，AES-128-CBC + session_key 解密 + verify watermark
   - migration 0007: user 表加 `avatar_url TEXT`
   - miniprogram `getUserProfile` → encryptedData → POST → 更新 user 表
   - **调研项**：微信 2022 后默认返 "微信用户"，需调用 `wx.getUserProfile` 主动询问授权（已 deprecated 警告但仍可用），或走 `nickname-input` 组件让用户手填

---

## 14. Implementation Notes

### 14.1 Plan 拆分（3 subagent 可并行）

| Subagent | 范围 | Task 数 | 预估时间 |
|---|---|---|---|
| SA1 | A 服务端 rate limit（migration + lib + route + 9 用例）| 4 task | 30 min |
| SA2 | B admin RequireAuth 全包 + LoginPage 429（3 路由测 + 2 LoginPage 测）| 3 task | 20 min |
| SA3 | C client 401 refresh（miniprogram fetchWithRefresh 4 用例 + admin 401 handler）| 3 task | 25 min |

**主线程接管**：CP 验证 / state 文档 / merge / worktree 清理（destructive）

### 14.2 Commit 节奏

每 task 一个 commit：
- `feat(api): M6.3a A1 — migration 0005 login_attempt`
- `feat(api): M6.3a A2 — lib/rate-limit + 6 tests`
- `feat(api): M6.3a A3 — /auth/admin-login rate limit + 1 test`
- `feat(api): M6.3a A4 — /auth/wx-login rate limit + 2 tests`
- `feat(admin): M6.3a B1 — App.tsx 9 路由全包 + 3 tests`
- `feat(admin): M6.3a B2 — LoginPage 429 倒计时 + 2 tests`
- `feat(admin): M6.3a B3 — lib/api.ts 401 navigate handler`
- `feat(miniprogram): M6.3a C1 — fetchWithRefresh wrapper + 4 tests`
- `feat(miniprogram): M6.3a C2 — chat/sessions/ask 全走 wrapper`
- `feat(miniprogram): M6.3a C3 — ensureJwt 失败处理`
- `docs: state-m6-3a 收尾 + README + merge`

**约 11 commit**（与 M6.2 的 13 commit 同量级）

### 14.3 验证顺序

1. CP-1（SA1 完成后）：`pnpm -F api test` + typecheck 全绿
2. CP-2（SA2 完成后）：`pnpm -F admin test` + `pnpm -F admin build` 成功
3. CP-3（SA3 完成后）：`pnpm -F miniprogram test` + typecheck 全绿
4. CP-4（合并后）：主线程独立 `pnpm -r test` + `pnpm -r typecheck` + `pnpm -F admin build`
5. CP-5（M6.3b 之前不验）：真接 Cloudflare dev verification（admin LoginPage 真暴力 / miniprogram 真机 jwt 过期）
