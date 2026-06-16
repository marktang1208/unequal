# Plan: M6.3c — Nickname Input 组件

- **Spec**：`docs/superpowers/specs/2026-06-16-m6-3c-nickname-input-design.md`（commit `8883e4a`）
- **日期**：2026-06-16
- **复杂度**：Small（4 task × 2 包 + 9 新增用例 + 主线程直接做）
- **Mock-first 边界**：D1 全 mock-first（miniflare）/ miniprogram fetchImpl + wx storage 内存 mock — 无新边界

---

## 1. Requirements Restatement

把 miniprogram 端 user.nickname 字段从 NULL 通过主动 modal 引导填入（2024 微信 `nickname-input` 组件替代 deprecated `wx.getUserProfile`），server 端新增 PATCH /user/nickname 写 user.nickname。

**核心交付**：

| # | 包 | 文件 | 内容 |
|---|---|---|---|
| 1 | apps/api | `routes/user.ts`（新建）| `userRoute.UPDATE_NICKNAME` — 验 jwt + 验 nickname（1-20 字符）+ UPDATE |
| 2 | apps/api | `index.ts` | 挂 `app.patch("/user/nickname", ...)` |
| 3 | apps/api | `test/routes/user.test.ts`（新建）| 5 用例 |
| 4 | apps/miniprogram | `lib/api.ts` | 新 `updateNickname(nickname, opts)` helper |
| 5 | apps/miniprogram | `lib/chat-storage.ts` | 新 `hasShownNicknameModal` + `setShownNicknameModal` |
| 6 | apps/miniprogram | `pages/chat/chat.ts` | onLoad 触发 modal + `promptNickname` method |

**不交付**（推到 M6.3c+ / M6.4+）：avatar 字段 / settings 页 / wx.getUserProfile 集成 / AES-CBC 解密。

**新增用例**：9（user 5 + api 1 + storage 2 + chat 1）。**累计 203**（194 + 9）。

---

## 2. Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| Hono 路由挂载 | `apps/api/src/index.ts`（已建，1 import + app.get/post 风格）| `import { userRoute } from "./routes/user.js"; app.patch("/user/nickname", (c) => userRoute.UPDATE_NICKNAME(c.req.raw, c.env))` |
| 路由 try/catch + handleHttpError | `apps/api/src/routes/auth.ts:45-54` | 显式 `Response.json({ error, message }, { status })`（不走 throw HttpError 因为有 6 个不同 error code）|
| 鉴权 | `apps/api/src/lib/auth.ts:41-65` `verifyAuth` | `await verifyAuth(request, env)` 拿 `AuthIdentity { userId, isAdmin }` |
| D1 prepare/bind | `apps/api/src/lib/user.ts` | `d1.prepare(sql).bind(...).run()` |
| miniprogram PATCH helper | `apps/miniprogram/lib/api.ts:190-202` `renameSession` | `method: "PATCH"`, `headers: buildHeaders(opts)` 自动 jwt |
| miniprogram storage helper | `apps/miniprogram/lib/chat-storage.ts:23-39`（M6.1 session_id 模式）| `wx.getStorageSync(key)` / `wx.setStorageSync(key, value)` + `// @ts-expect-error wx 全局` |
| chat onLoad | `apps/miniprogram/pages/chat/chat.ts:62-68` | onLoad 末尾追加 `if (!hasShownNicknameModal()) void this.promptNickname()` |
| wx.showModal 范式 | `apps/miniprogram/pages/chat/chat.ts:145` | `editable: true, cancelText: "跳过", confirmText: "保存"` |
| spy-style fake D1 | `apps/api/test/lib/user.test.ts:15-41` | `makeFakeDB({first, all, run})` 模式（user.test.ts 5 用例）|

---

## 3. Files to Change

| File | Action | Why |
|---|---|---|
| `apps/api/src/routes/user.ts` | CREATE | `userRoute.UPDATE_NICKNAME` 路由（spec §5.2 完整实现）|
| `apps/api/src/index.ts` | UPDATE | 加 `import { userRoute }` + `app.patch("/user/nickname", ...)` |
| `apps/api/test/routes/user.test.ts` | CREATE | 5 用例（200 happy / 401 缺 jwt / 400 缺 nickname / 400 过长 / 400 空）|
| `apps/miniprogram/lib/api.ts` | UPDATE | 加 `updateNickname` helper（spec §5.4）|
| `apps/miniprogram/lib/api.test.ts` | UPDATE | +1 用例（happy + error 透传）|
| `apps/miniprogram/lib/chat-storage.ts` | UPDATE | 加 `hasShownNicknameModal` + `setShownNicknameModal`（spec §5.5）|
| `apps/miniprogram/test/chat-storage.test.ts` | CREATE | 2 用例（storage 状态读写）|
| `apps/miniprogram/pages/chat/chat.ts` | UPDATE | onLoad 加 modal 触发 + `promptNickname` method |
| `apps/miniprogram/test/chat.test.ts` | CREATE | 1 用例（onLoad 首次调 promptNickname / 已设不再调）|
| `docs/superpowers/specs/2026-06-16-m6-3c-nickname-input-design.md` | （已建）| spec 已 commit `8883e4a` |
| `docs/superpowers/plans/2026-06-16-m6-3c-nickname-input.md` | （本文件）| plan artifact |
| `docs/superpowers/state-m6-3c.md` | CREATE | 收尾归档（main thread 写）|
| `README.md` | UPDATE | M6.3c 节（main thread 写）|

**总计**：4 新建 + 5 修改 + 1 plan + 1 spec（已存在）。

---

## 4. Tasks (5 task / 2 checkpoint)

### Phase 1 — 主线程直接实施（4 task / CP-1）

按 M6.3b stall 教训，本 spec **不派 subagent**，主线程直接做（4 task + 2 包 改动，估 30-40 min）。

**Task 1: server PATCH /user/nickname + 5 tests**
- Action: 写 `apps/api/src/routes/user.ts`（spec §5.2 完整代码）+ 改 `apps/api/src/index.ts` 挂路由
- Mirror: `routes/auth.ts:45-54` handleHttpError 模式 + `lib/auth.ts:41-65` verifyAuth
- 写 `apps/api/test/routes/user.test.ts` 5 用例（参考 `auth.test.ts` miniflare bundle 模式 + 复用 `applyMigrations` 加载 0001+0005+0006）：
  1. PATCH 200 happy: 先 /auth/wx-login 拿 jwt + PATCH /user/nickname → 200 + SELECT user.nickname = "张三"
  2. PATCH 401 缺 jwt: 不带 Authorization → 401 MISSING_BEARER
  3. PATCH 400 缺 nickname: body {} → 400 MISSING_NICKNAME
  4. PATCH 400 过长: nickname = "a".repeat(21) → 400 NICKNAME_TOO_LONG
  5. PATCH 400 空: nickname = "   " (trim 后空) → 400 NICKNAME_EMPTY
- Validate: `pnpm -F api test test/routes/user.test.ts` 5 用例绿

**Task 2: miniprogram updateNickname helper + 1 test**
- Action: 改 `apps/miniprogram/lib/api.ts` 加 `updateNickname` 函数（spec §5.4）
- 写 `apps/miniprogram/lib/api.test.ts` +1 用例：mock fetchImpl 返 200 / 400 → 函数 happy / 抛错
- Mirror: `lib/api.ts:190-202` renameSession 模式
- Validate: `pnpm -F miniprogram test test/lib/api.test.ts` 14 旧 + 1 新 = 15 全绿

**Task 3: miniprogram chat-storage helpers + 2 tests**
- Action: 改 `apps/miniprogram/lib/chat-storage.ts` 加 `hasShownNicknameModal` + `setShownNicknameModal`（spec §5.5）
- 写 `apps/miniprogram/test/chat-storage.test.ts` 2 用例：
  1. hasShownNicknameModal 返 false 当 storage 无 key（mock wx.getStorageSync 返 undefined）
  2. setShownNicknameModal 写 storage key = "unequal:nickname_modal_shown_v1" + value true
- Mirror: 现有 session_id storage 模式
- Validate: `pnpm -F miniprogram test test/chat-storage.test.ts` 2 用例绿

**Task 4: miniprogram chat.ts onLoad 触发 modal + 1 test**
- Action: 改 `apps/miniprogram/pages/chat/chat.ts`：
  - import `hasShownNicknameModal, setShownNicknameModal` from chat-storage
  - import `updateNickname` from api
  - onLoad 末尾追加 `if (!hasShownNicknameModal()) void this.promptNickname()`
  - 加 `promptNickname` async method（spec §5.6 完整代码）
- 写 `apps/miniprogram/test/chat.test.ts` 1 用例（mock wx.showModal + storage + updateNickname）：
  1. onLoad 首次进入（storage flag false）→ promptNickname 被调
  2. onLoad 第二次（storage flag true）→ promptNickname 不被调
- Mirror: chat.ts:62-68 onLoad + chat.ts:145 wx.showModal
- Validate: `pnpm -F miniprogram test test/chat.test.ts` 1 用例绿

**CP-1 验证（4 task 完成后）**：
```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m6-3c-nickname-input
pnpm -r typecheck
pnpm -r test
```
期望：194 旧 + 9 新 = 203 全绿 + 5 包 typecheck 全绿

---

### Phase 2 — 主线程收尾（Task 5 / CP-2）

**Task 5: state-m6-3c.md + README + merge to master + worktree 清理 + 独立 CP-2 验证**
- Action: 仿 `state-m6-3b.md` 模板写 `docs/superpowers/state-m6-3c.md` 11 sections（commit 汇总 / 测试矩阵 / 与 spec 偏差 / 实施 concern / dev 验证缺口 / CP-5 真接路径 / 下一步建议 / 主线程接管）
- 改 `README.md` 加 M6.3c 节（nickname 描述 + 行为 + 203 测试 + YAGNI 限制）
- merge `worktree-m6-3c-nickname-input` → master with `--no-ff`
- `worktree remove --force` + `branch -d`
- 主仓库跑 `pnpm -r test` + `pnpm -r typecheck` 独立 CP-2 验证
- Validate: master HEAD 含 merge commit + worktree 清理 + 203 用例全绿 + 5 包 typecheck 全绿

---

## 5. Validation

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m6-3c-nickname-input

# CP-1（4 task 完成后）
pnpm -r typecheck
pnpm -r test
# 期望 194 旧 + 9 新 = 203 全绿

# CP-2（合并后，主仓库跑）
cd /Users/Mark/cc_project/unequal
pnpm -r typecheck
pnpm -r test
# 期望 203 全绿
```

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| 跨 2 包改动（server + miniprogram）主线程上下文负担 | 中 | M6.3b 教训应用：主线程直接做避免 subagent stall；4 task 不算大 |
| nickname-input editable=true 微信版本兼容 | 低 | 2024 微信主推，旧版本自动降级（不显示输入框）— 不影响核心流程 |
| wx.showModal editable 字段 UI 不一致 | 中 | dev 真验（CP-5）— 微信不同版本 placeholderText / 键盘行为有差异 |
| PATCH 失败但 modal 标志 true | 中 | user 视角：modal 不再弹但 nickname 仍 NULL；user 误以为已保存。Acceptable（M6.3c 主动 modal 1 次性）|
| admin 模式误调（isAdmin=true user 调 PATCH）| 中 | spec §7 加 `ADMIN_CANNOT_SET_NICKNAME` 400 防止 |
| chat.ts onLoad 时机（user 已登录但 ensureJwt 失败）| 低 | onLoad 不依赖 ensureJwt；modal 与 jwt 并行（PATCH 401 → showToast 失败）|
| miniprogram 测试用 jsdom 还是 miniflare | 低 | 用 miniflare 真实 wx API mock 模式（同 M6.1 chat-storage.test.ts）|
| test/chat.test.ts 复杂度 | 中 | mock wx.showModal + storage + updateNickname 3 个 mock，参考 M6.1 chat-storage.test.ts 模式 |
| 4 task 顺序（task 1 server → 2/3/4 miniprogram）| 极低 | server 先做 → miniprogram helper 依赖 server 端（API）→ UI 触发 |
| 主线程 context 消耗 | 中 | 4 task × 2 包 改动总文件 9 个，主线程 context 足够（M6.3a 4 SA + M6.3b 3 task 都未超）|

**最高风险**：跨 2 包改动主线程 context 负担。Mitigation：M6.3b 教训（避免 subagent stall）+ 4 task 边界 + 每 task 完成后立即 commit + 跑该 task 局部测试（不全跑 pnpm -r）。

---

## 7. Acceptance

- [ ] 9 新增用例全绿（user 5 + api 1 + storage 2 + chat 1 = 9）
- [ ] 累计 203 用例全绿
- [ ] 5 包 typecheck 全绿
- [ ] 主线程独立 CP-2 验证（trust but verify）
- [ ] state-m6-3c.md 11 sections 完整
- [ ] README M6.3c 节就位
- [ ] merge to master + worktree 清理 + branch 删除
- [ ] 0 production console.log（wx.showToast 不算 production console）

**dev 验证缺口**（推到 CP-5 真接 Cloudflare + 微信真机）：
- 微信开发者工具真机：首次打开 chat → 弹 modal → 填昵称 → DB user.nickname 写入
- 第二次打开 chat → 不再弹 modal
- 跳过 modal → storage 标志 true + DB nickname 仍 NULL

---

## 8. Implementation Notes

### 8.1 Subagent 分配

**M6.3b stall 教训应用**：
- 1 subagent 范围 < 3 task → 主线程直接做更稳
- 1 subagent 范围 ≥ 3 task → 可派 subagent 但需小心

M6.3c 4 task 跨 2 包，**决策主线程直接做**（避免 subagent stall 风险 + 跨包改动主线程能 handle 上下文）。

### 8.2 Commit 节奏（4 commit + 1 merge = 5 总）

```
feat(api):  M6.3c task 1 — routes/user.ts PATCH /user/nickname + 5 tests
feat(mini): M6.3c task 2 — lib/api.ts updateNickname + 1 test
feat(mini): M6.3c task 3 — lib/chat-storage.ts nickname modal helpers + 2 tests
feat(mini): M6.3c task 4 — pages/chat/chat.ts onLoad 触发 modal + 1 test
docs:       M6.3c state-m6-3c.md 收尾 + README M6.3c 节
merge:      worktree-m6-3c-nickname-input → master --no-ff
```

### 8.3 验证顺序

1. **CP-1**（task 1-4 完成后）：`pnpm -r typecheck` + `pnpm -r test` → 期望 194 旧 + 9 新 = 203 全绿
2. **CP-2**（合并后，主线程独立）：`pnpm -r test` + `pnpm -r typecheck` → 期望 203 全绿
3. **CP-5**（推到真接 Cloudflare 时）：微信开发者工具真机首次 chat → modal → 填昵称 → DB 写入 + 跳过路径验证

### 8.4 ECC 引用

- `tdd-workflow` (ECC) — 9 用例 RED → GREEN → REFACTOR
- `subagent-driven-development` (ECC) — **本 spec 决策主线程直接做**（M6.3b stall 教训）
- `code-review` / `typescript-review` — routes/user.ts 新文件 + chat.ts 改 5-10 行
- `verification-before-completion` (Superpowers) — CP-1/2 验证
