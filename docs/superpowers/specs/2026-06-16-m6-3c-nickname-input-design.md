# M6.3c — Nickname Input 组件

**版本**: 2026-06-16
**前置**: M6.3b session_key 存 D1（已 merge `367b10f`）
**范围**: M6.3c — miniprogram 端用 2024 微信主推 `nickname-input` 组件收集 nickname，server 端 PATCH /user/nickname 写 user.nickname

---

## 1. Requirements

| # | 现状 | 目标 |
|---|---|---|
| 1 | user.nickname 字段留 NULL | 通过 PATCH /user/nickname 写入 user.nickname |
| 2 | miniprogram 无昵称引导 | chat 页 onLoad 首次弹 modal（editable=true）让 user 填昵称 |
| 3 | 仅 1 次 modal | 用 wx.setStorageSync 标志，永远 true（PATCH 失败也置）|

**为什么 YAGNI 精简**（区别于原 spec §"M6.3c Deferred" 的范围）：
- ❌ 不做 wx.getUserProfile（已 deprecated 2022）→ Q1 选 B nickname-input
- ❌ 不做 AES-128-CBC 解密（B 方案不需要 encryptedData + session_key 解密）
- ❌ 不做 avatar_url 字段（B 方案 user 不传头像，默认灰头足够）
- ❌ 不做 /auth/wx-user-info endpoint
- ❌ 不做 settings 页（改昵称功能推 M6.3c+）

---

## 2. Patterns to Mirror

| 类别 | 来源 | 复用方式 |
|---|---|---|
| verifyAuth jwt | `apps/api/src/lib/auth.ts:41-65` | 新 endpoint 调 `verifyAuth(request, env)` 拿 identity |
| 路由 try/catch | `apps/api/src/routes/auth.ts:45-54` `handleHttpError` | 新 endpoint 走同模式 |
| D1 prepare/bind | `apps/api/src/lib/user.ts` | UPDATE user SET nickname = ? WHERE id = ? |
| miniprogram fetch wrapper | `apps/miniprogram/lib/api.ts:106-187` | `updateNickname` 仿 `renameSession` 模式（PATCH + buildHeaders 自动 jwt）|
| miniprogram storage helper | `apps/miniprogram/lib/chat-storage.ts`（现有 session_id 模式）| `hasShownNicknameModal` + `setShownNicknameModal` 仿同模式 |
| miniprogram chat 页面 onLoad | `apps/miniprogram/pages/chat/chat.ts:62-68` | M6.3c 在 onLoad 后追加 `if (!hasShownNicknameModal()) this.promptNickname()` |
| wx.showModal 范式 | `apps/miniprogram/pages/chat/chat.ts:145` | editable=true + cancelText="跳过" + confirmText="保存" |

---

## 3. Architecture Overview

3 步串行（server → miniprogram lib → miniprogram UI）：

```
User 打开 chat 页
   ↓ onLoad
if (!hasShownNicknameModal())  ← wx.getStorageSync 读标志
   ↓
wx.showModal({ editable: true, cancelText: "跳过" })
   ↓
user 填昵称 + confirm
   ↓
updateNickname(nickname)  ← PATCH /user/nickname 带 jwt
   ↓
PATCH /user/nickname
   ↓ verifyAuth(jwt) → userId
UPDATE user SET nickname = ? WHERE id = userId
   ↓
setShownNicknameModal()  ← wx.setStorageSync 写标志
```

跳过路径：
```
user 跳过（cancel）
   ↓
setShownNicknameModal()  ← 标志置 true，下次不再弹
```

---

## 4. Files to Change

| 文件 | 动作 | 内容 |
|---|---|---|
| `apps/api/src/routes/user.ts` | CREATE | `userRoute.UPDATE_NICKNAME(request, env)` — 验 jwt + 验 nickname + UPDATE |
| `apps/api/src/index.ts` | UPDATE | 挂 `app.patch("/user/nickname", ...)` |
| `apps/api/test/routes/user.test.ts` | CREATE | 5 用例（200 happy / 401 缺 jwt / 400 缺 nickname / 400 过长 / 400 空）|
| `apps/miniprogram/lib/api.ts` | UPDATE | 新 `updateNickname(nickname, opts)` helper |
| `apps/miniprogram/lib/api.test.ts` | UPDATE | +1 用例（happy + error 透传）|
| `apps/miniprogram/lib/chat-storage.ts` | UPDATE | 新 `hasShownNicknameModal` + `setShownNicknameModal` helpers |
| `apps/miniprogram/test/chat-storage.test.ts`（如有）| UPDATE | +2 用例 |
| `apps/miniprogram/pages/chat/chat.ts` | UPDATE | onLoad 后追加 `if (!hasShownNicknameModal()) this.promptNickname()` + `promptNickname` method |
| `apps/miniprogram/pages/chat/chat.test.ts`（如有）| UPDATE | +1 mock 用例（首次进入调 promptNickname / 已设不再调）|
| `docs/superpowers/specs/2026-06-16-m6-3c-nickname-input-design.md` | CREATE | 本文档 |
| `docs/superpowers/state-m6-3c.md` | CREATE | 收尾归档（main thread 写）|

**总计**：2 新建 + 6 修改 + 1 spec。

---

## 5. API Spec

### 5.1 `PATCH /user/nickname`

**Request**：
```http
PATCH /user/nickname
Authorization: Bearer <jwt>     # miniprogram 现有 jwt
Content-Type: application/json

{ "nickname": "张三" }
```

**Response（200）**：
```json
{ "nickname": "张三" }
```

**错误**：
| 触发 | Status | Code | Body |
|---|---|---|---|
| 缺 / 错 jwt | 401 | MISSING_BEARER / INVALID_JWT | 走 verifyAuth |
| 缺 nickname 字段 | 400 | MISSING_NICKNAME | `{ error: "MISSING_NICKNAME", message: "..." }` |
| nickname 空字符串 | 400 | NICKNAME_EMPTY | `{ error: "NICKNAME_EMPTY", message: "..." }` |
| nickname > 20 字符 | 400 | NICKNAME_TOO_LONG | `{ error: "NICKNAME_TOO_LONG", message: "..." }` |
| admin 模式试图改 nickname | 400 | ADMIN_CANNOT_SET_NICKNAME | `{ error: "ADMIN_CANNOT_SET_NICKNAME", message: "..." }` |
| D1 写失败 | 500 | INTERNAL | `{ error: "internal", detail: ... }` |

### 5.2 路由实现（伪代码）

```typescript
// apps/api/src/routes/user.ts
import { verifyAuth, HttpError } from "../lib/auth.js";
import type { Env } from "../types.js";

interface UpdateNicknameRequestBody {
  nickname?: unknown;
}

const NICKNAME_MAX_LENGTH = 20;

export const userRoute = {
  async UPDATE_NICKNAME(request: Request, env: Env): Promise<Response> {
    try {
      // 1. 鉴权（verifyAuth 内部已 throw 401）
      const identity = await verifyAuth(request, env);

      // 2. admin 模式不允许
      if (identity.isAdmin) {
        return Response.json(
          { error: "ADMIN_CANNOT_SET_NICKNAME", message: "Admin cannot set nickname" },
          { status: 400 },
        );
      }

      // 3. body 解析
      let body: UpdateNicknameRequestBody;
      try {
        body = (await request.json()) as UpdateNicknameRequestBody;
      } catch {
        return Response.json(
          { error: "INVALID_JSON", message: "Body must be JSON" },
          { status: 400 },
        );
      }

      // 4. nickname 验证
      const nickname = typeof body.nickname === "string" ? body.nickname.trim() : "";
      if (!body.nickname) {
        return Response.json(
          { error: "MISSING_NICKNAME", message: "Missing 'nickname' field" },
          { status: 400 },
        );
      }
      if (!nickname) {
        return Response.json(
          { error: "NICKNAME_EMPTY", message: "Nickname cannot be empty" },
          { status: 400 },
        );
      }
      if (nickname.length > NICKNAME_MAX_LENGTH) {
        return Response.json(
          {
            error: "NICKNAME_TOO_LONG",
            message: `Nickname exceeds ${NICKNAME_MAX_LENGTH} characters`,
          },
          { status: 400 },
        );
      }

      // 5. 写 D1
      await env.DB
        .prepare("UPDATE user SET nickname = ? WHERE id = ?")
        .bind(nickname, identity.userId)
        .run();

      return Response.json({ nickname });
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.code, message: err.message },
          { status: err.status },
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: "internal", detail: msg }, { status: 500 });
    }
  },
};
```

### 5.3 挂载到 index.ts

```typescript
// apps/api/src/index.ts
import { userRoute } from "./routes/user.js";

app.patch("/user/nickname", (c) => userRoute.UPDATE_NICKNAME(c.req.raw, c.env));
```

### 5.4 miniprogram helper

```typescript
// apps/miniprogram/lib/api.ts 新增
export async function updateNickname(
  nickname: string,
  opts: ApiOptions = {},
): Promise<void> {
  const baseUrl = opts.baseUrl ?? "http://localhost:8787";
  const f = getFetch(opts);
  const res = await f(`${baseUrl}/user/nickname`, {
    method: "PATCH",
    headers: buildHeaders(opts),  // 自动带 jwt via storage
    body: JSON.stringify({ nickname }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`/user/nickname ${res.status}: ${body.error ?? "unknown"}`);
  }
}
```

### 5.5 miniprogram storage helper

```typescript
// apps/miniprogram/lib/chat-storage.ts 新增
const NICKNAME_MODAL_SHOWN_KEY = "unequal:nickname_modal_shown_v1";

/** 首次昵称 modal 是否已弹过（不论填/跳过） */
export function hasShownNicknameModal(): boolean {
  // @ts-expect-error wx 全局类型 mock-first 缺失
  return wx.getStorageSync(NICKNAME_MODAL_SHOWN_KEY) === true;
}

/** 标记首次昵称 modal 已弹过 */
export function setShownNicknameModal(): void {
  // @ts-expect-error wx 全局类型 mock-first 缺失
  wx.setStorageSync(NICKNAME_MODAL_SHOWN_KEY, true);
}
```

### 5.6 miniprogram chat 页面 onLoad 触发

```typescript
// apps/miniprogram/pages/chat/chat.ts
import {
  hasShownNicknameModal,
  setShownNicknameModal,
} from "../../lib/chat-storage.js";
import { updateNickname } from "../../lib/api.js";

onLoad() {
  // M6.1: 加载 session_id
  const sid = loadCurrentSessionId();
  if (sid) this.setData({ sessionId: sid });

  // M6.3c: 首次昵称 modal（仅弹 1 次）
  if (!hasShownNicknameModal()) {
    void this.promptNickname();
  }
},

async promptNickname() {
  // @ts-expect-error wx 全局类型 mock-first 缺失
  const res = await wx.showModal({
    title: "请输入昵称",
    editable: true,             // 显示输入框
    placeholderText: "1-20 字符（可跳过）",
    confirmText: "保存",
    cancelText: "跳过",
  });
  if (res.confirm && res.content?.trim()) {
    try {
      await updateNickname(res.content.trim());
      // @ts-expect-error wx 全局类型 mock-first 缺失
      wx.showToast({ title: "昵称已保存", icon: "success" });
    } catch {
      // @ts-expect-error wx 全局类型 mock-first 缺失
      wx.showToast({ title: "保存失败", icon: "none" });
    }
  }
  // 不论填/跳过，标志置 true（避免反复弹）
  setShownNicknameModal();
},
```

---

## 6. Data Model

**0 migration 改动** — M0-M1 `0001_init.sql` 已留 `user.nickname TEXT` 字段。直接 UPDATE。

---

## 7. Error Handling

### 7.1 Server-side

| 触发 | 行为 |
|---|---|
| 401 鉴权失败 | 走 verifyAuth → throw HttpError → try/catch 返 401 |
| 400 缺/空/过长 nickname | 显式 return Response.json 400 |
| 400 admin 模式 | 显式 return Response.json 400 |
| 500 D1 写失败 | try/catch 兜底 → handleHttpError 500 |
| nickname 合法但 userId 不存在（userId race）| UPDATE 0 row 静默 — 不 throw（idempotent）|

### 7.2 Client-side

| 触发 | 行为 |
|---|---|
| 首次进入 chat | 弹 modal，user 填/跳过 |
| PATCH 200 | 标志置 true + showToast 成功 |
| PATCH 4xx/5xx | 标志置 true（避免反复弹）+ showToast 失败 |
| 第二次进入 chat | 标志 true → 不再弹 |
| user 改主意想再填 | **不支持**（M6.3c 不做 settings 页）— 推 M6.3c+ |

---

## 8. Mock-first Boundaries

| 组件 | 测试方式 | 真接路径 |
|---|---|---|
| D1 user.nickname UPDATE | miniflare in-memory D1 | CP-5 wrangler d1 migrations apply |
| PATCH /user/nickname 路由 | miniflare bundle + jwt 注入 | CP-5 真接 Cloudflare |
| updateNickname helper | fetchImpl 注入（mock 200/400）| CP-5 真 wx + 真 /user/nickname |
| chat-storage helper | 内存 mock wx.getStorageSync / setStorageSync | CP-5 真 wx storage |
| chat.ts onLoad 触发 | mock wx.showModal + mock updateNickname | CP-5 微信开发者工具真机 |

**无新 mock 边界** — 全复用 M6.1/M6.2/M6.3a/M6.3b 已建立的 mock-first 基础设施。

---

## 9. Testing Strategy

### 9.1 用例分布（约 9 新增）

| 文件 | 新增 | 内容 |
|---|---|---|
| `apps/api/test/routes/user.test.ts`（新建）| 5 | PATCH 200 happy / 401 缺 jwt / 400 缺 nickname / 400 过长 / 400 空 |
| `apps/miniprogram/lib/api.test.ts` | 1 | updateNickname happy + error 透传（mock fetchImpl）|
| `apps/miniprogram/test/chat-storage.test.ts`（新建）| 2 | hasShownNicknameModal false/true + setShownNicknameModal 写 |
| `apps/miniprogram/test/chat.test.ts`（新建）| 1 | onLoad 首次调 promptNickname / 已设不再调（mock wx.showModal + storage）|

合计：9 新增 → 194 + 9 = **203 用例**

### 9.2 关键 fixture

```typescript
// apps/api/test/routes/user.test.ts
it("PATCH /user/nickname 200: jwt 合法 + nickname 合法 → DB 写入", async () => {
  // setup: 先 /auth/wx-login 拿 jwt + 创建 user
  // PATCH /user/nickname { nickname: "张三" } → 200 { nickname: "张三" }
  // SELECT user.nickname → "张三"
});

it("PATCH /user/nickname 401: 缺 jwt → MISSING_BEARER", async () => {
  // 不带 Authorization header → 401
});

it("PATCH /user/nickname 400: nickname 21 字符 → NICKNAME_TOO_LONG", async () => {
  // PATCH { nickname: "a".repeat(21) } → 400
});

// apps/miniprogram/test/chat-storage.test.ts
it("hasShownNicknameModal 返 false 当 storage 无 key", () => {
  // wx.getStorageSync 返 undefined → false
});

it("setShownNicknameModal 写 storage key", () => {
  // 调 helper → wx.setStorageSync(key, true) 被调
});
```

---

## 10. ECC Components

| 组件 | 用法 |
|---|---|
| `superpowers:brainstorming` | M6.3c spec 设计（Q1 API 选 B / Q2 主动 modal / 5 区块 design）|
| `superpowers:using-superpowers` | entry dispatcher |
| ECC `plan` skill | M6.3c plan 编写 |
| `tdd-workflow` (ECC) | 9 用例 RED → GREEN → REFACTOR |
| `subagent-driven-development` (ECC) | 1 subagent × 4 task（按 M6.3b 教训：跨 2 包范围略大，可派 SA1）|
| `feedback_subagent_heartbeat_monitoring` | M6.3b 教训：1 subagent 范围 < 3 task 时主线程直接做更稳；M6.3c 4 task 是边界 |
| `using-git-worktrees` | 已建立 `.claude/worktrees/m6-3c-nickname-input` |
| `verification-before-completion` | CP-1 验证 + 主线程 CP-2 独立验证 |
| `code-review` / `typescript-review` | routes/user.ts 新文件 + chat.ts 改 5-10 行触发 |

**ECC TypeScript rules 已加载**：coding-style（strict type / interfaces）/ testing（vitest + AAA）/ security（nickname XSS 防 — 仅展示不渲染 HTML，react text-escape）。

---

## 11. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| 跨包改动（server + miniprogram 2 包）subagent stall | 中 | M6.3b 教训：1 subagent 范围 < 3 task 主线程做更稳；M6.3c 4 task 略超边界，可考虑拆 2 subagent（1 server / 1 miniprogram）或主线程直接做 |
| nickname-input editable=true 微信版本兼容 | 低 | 2024 微信主推，旧版本自动降级（不显示输入框）— 不影响核心流程 |
| wx.showModal editable 字段 UI 不一致 | 中 | dev 真验（CP-5）— 微信不同版本 placeholderText / 键盘行为有差异 |
| nickname 含特殊字符（emoji / 中英混）长度计算 | 低 | JS `.length` UTF-16 code unit，emoji = 2 unit。1-20 字符容许少量 emoji |
| XSS 风险（nickname 渲染到页面）| 极低 | miniprogram text 元素不解析 HTML，{{nickname}} 自动转义 |
| PATCH 失败但 modal 标志 true | 中 | user 视角：modal 不再弹但 nickname 仍 NULL；user 误以为已保存。Acceptable（M6.3c 主动 modal 1 次性 + 不做 settings 页）|
| admin 模式误调 | 中 | spec §7 加 `ADMIN_CANNOT_SET_NICKNAME` 400 防止（AUTH_MODE=admin_token 时 isAdmin=true → 拒）|
| chat 页面 onLoad 时机（user 已登录但 ensureJwt 失败）| 低 | onLoad 不依赖 ensureJwt；modal 与 jwt 并行（PATCH 401 → showToast 失败）|

**最高风险**：跨包改动 subagent stall。Mitigation：M6.3b 教训 + 1 subagent × 4 task 边界，主线程直接做更稳（避免 stall 风险）。

---

## 12. Acceptance Criteria

- [ ] 9 新增用例全绿（user 5 + api 1 + storage 2 + chat 1 = 9）
- [ ] 累计 203 用例全绿
- [ ] 5 包 typecheck 全绿
- [ ] 主线程独立 CP-2 验证
- [ ] state-m6-3c.md 收尾文档
- [ ] merge to master + worktree 清理 + branch 删除
- [ ] 0 production console.log

**dev 验证缺口**（推到 CP-5 真接 Cloudflare + 微信真机）：
- 微信开发者工具真机：首次打开 chat → 弹 modal → 填昵称 → 后端 DB 写入 + storage 标志 true
- 第二次打开 chat → 不再弹 modal
- 跳过 modal → 标志置 true + DB nickname 仍 NULL

---

## 13. M6.3c+ Deferred（不在本 spec）

- 改昵称 / settings 页（user 改主意想再填）
- avatar 字段 + 默认头像 URL
- wx.getUserInfo unionid（需企业认证）
- wx.getUserProfile 集成（已 deprecated，跳过）
- /auth/wx-user-info endpoint（AES-CBC 解密，B 方案不需要）

---

## 14. Implementation Notes

### 14.1 Plan 拆分（按 M6.3b 教训：主线程直接做更稳）

M6.3b 教训：1 subagent × 3 task 时 stall 风险高（read 阶段 5-10 min 卡住）。M6.3c 4 task 略多 + 跨 2 包，subagent 范围更大但风险更高。

**M6.3c 决策**：**主线程直接做**（避免 subagent stall 风险 + 跨 2 包改动主线程能 handle）。

预计 30-40 min 实施。

### 14.2 Commit 节奏（4 commit + 1 merge = 5 总）

```
feat(api):  M6.3c task 1 — routes/user.ts PATCH /user/nickname + 5 tests
feat(mini): M6.3c task 2 — lib/api.ts updateNickname + 1 test
feat(mini): M6.3c task 3 — lib/chat-storage.ts nickname modal helpers + 2 tests
feat(mini): M6.3c task 4 — pages/chat/chat.ts onLoad 触发 modal + 1 test
docs:       M6.3c state-m6-3c.md 收尾 + README M6.3c 节
merge:      worktree-m6-3c-nickname-input → master --no-ff
```

### 14.3 验证顺序

1. **CP-1**（task 1-4 完成后）：`pnpm -r typecheck` + `pnpm -r test` → 期望 194 旧 + 9 新 = 203 全绿
2. **CP-2**（合并后，主线程独立）：`pnpm -r test` + `pnpm -r typecheck` + 确认 merge commit + worktree 清理
3. **CP-5**（推到真接 Cloudflare 时）：微信开发者工具真机首次 chat → modal → 填昵称 → DB 写入 + 跳过路径验证

### 14.4 ECC 引用

- `tdd-workflow` (ECC) — 9 用例 RED → GREEN → REFACTOR
- `subagent-driven-development` (ECC) — **本 spec 决策主线程直接做**（M6.3b stall 教训）
- `code-review` / `typescript-review` — routes/user.ts 新文件 + chat.ts 改 5-10 行
- `verification-before-completion` (Superpowers) — CP-1/2 验证
