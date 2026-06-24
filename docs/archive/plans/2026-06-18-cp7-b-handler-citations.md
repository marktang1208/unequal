# CP-7-B Plan — handler 后端补全 + [N] 引用解析 + minipgm 富文本

**Spec**：`docs/superpowers/specs/2026-06-18-cp7-b-handler-citations-design.md`（commit `f10e7b6`，已批准 + amend）
**复杂度**：Medium（2 新 handler / 1 改 handler / 1 改 caller / 1 改 component / 1 新 helper / 0 schema / 0 env）
**预计**：主线程 3-5h（参考 CP-7-A M6.3c/d 经验）

---

## ⚠️ Spec vs 实际代码差异（写 plan 时发现）

| 项 | Spec 设想 | 实际代码 | Plan 调整 |
|---|---|---|---|
| `deleteSession` caller | 不动 | **CP-7-A 遗留 bug**：用 path param `/api-sessions-delete/${id}` 但 handler 用 `getQuery(event, "id")` → 真接 400 | **顺手修**：改 query 风格（spec 已加 R-5 / AC-7a）|
| `message-bubble` 当前 props | text + citations + role + cached | 4 props；新增 `segments` 不破坏现有 | 加 segments prop，wxml 替换 `{{text}}` → `{{segments}}` 渲染 |
| api-chat handler test | 0 现有用例 | 0（chat 端到端靠 admin ChatSim + minipgm 真接）| 新建 test file，与 api-ask 风格一致 |
| api-chat `parseCitationsJson` 是旧 JSON 块 | spec 写 chat 解析 inline `[N]` | api-ask 用旧 JSON 块；chat 当前不解析（直传 answer）| 新写 `parseAnswerSegments` 在 api-chat.ts 局部；不与 api-ask 共享（chat/ask 格式不同）|
| minipgm `citation-parser.ts` | 共享 helper | chat.ts 解析后传 segments 给 bubble | 新建 `apps/miniprogram/lib/citation-parser.ts`，导出 `parseAnswerSegments` |
| api-router PATCH method 支持 | 默认支持 | CORS 允许 PATCH 但无显式 method check | handler 内 `if (event.httpMethod !== "PATCH") return 405` |

**影响**：工作量比 spec 估的稍大（+1 deleteSession caller 修复 + 1 message-bubble 替换 + 2 handler 405 检查），但仍是单 PR 可完成。

---

## Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| Handler 骨架 | `apps/api/src/handlers/api-sessions-delete.ts:1-46`（OPTIONS + JWT + getQuery + getById + 权限 + update/remove） | 新 2 handler 同模板；rename = update，nickname = getById+update |
| Auth 检查 | `apps/api/src/handlers/api-sessions-delete.ts:24-32` `verifyJwt + payload.sub` | 2 新 handler 同模板；nickname 不需 ownership check（userId 直接从 JWT 取）|
| Error codes | `errorResponse("NOT_FOUND" \| "FORBIDDEN" \| "INVALID_REQUEST" \| "AUTH_FAILED", ..., statusCode)`（CP-6 全套） | 新 handler 同模板 |
| DB layer | `apps/api/src/lib/db.ts:21-23, 70-72` `getById` + `update`（已有） | 新 handler 直接用 |
| Inline citation parsing | `apps/api/src/handlers/api-ask.ts:45-58` `parseCitationsJson` + `stripCitationsJson`（旧 JSON 块格式） | chat 改用 `/\[\d+\]/g` 正则；chat 不 strip（保留原 answer）|
| Method routing | api-router `index.ts:97-103` 仅 dispatch `main(event)`；method check 在 handler 内 | 新 handler 内 `if (event.httpMethod !== "PATCH") return errorResponse("METHOD_NOT_ALLOWED", ..., 405)` |
| minipgm caller | `apps/miniprogram/lib/api.ts:60-90` cloudCall typed wrapper | rename / nickname / deleteSession 3 caller 改 path/query/httpMethod |
| minipgm 富文本解析 | 无现有（chat 直接显示 text）| 新建 `lib/citation-parser.ts` 独立模块 + 测试 |
| Component 改造 | `apps/miniprogram/components/citation-card/citation-card.ts:6-19` prop + tap handler | message-bubble 加 segments prop + onCiteTap |

---

## Files to Change

| File | Action | Why |
|---|---|---|
| `apps/api/src/handlers/api-sessions-rename.ts` | NEW（~50 行）| PATCH /api-sessions-rename?id=...&body={title} — 改 chatSession title + updatedAt |
| `apps/api/src/handlers/api-user-nickname.ts` | NEW（~45 行）| PATCH /api-user-nickname body={nickname} — 改 user nickname |
| `apps/api/src/handlers/api-chat.ts` | UPDATE（211 → ~225 行）| 加 `parseAnswerSegments` + `citedNums` + 改 `citations` 为 subset |
| `apps/api/src/index.ts` | UPDATE（+2 import + 2 HANDLER_MAP 行）| 注册新 2 handler |
| `apps/api/test/handlers/api-sessions-rename.test.ts` | NEW（~150 行）| 8 用例 |
| `apps/api/test/handlers/api-user-nickname.test.ts` | NEW（~140 行）| 8 用例 |
| `apps/api/test/handlers/api-chat.test.ts` | NEW（~180 行）| 6 用例 [N] 解析 |
| `apps/miniprogram/lib/citation-parser.ts` | NEW（~30 行）| parseAnswerSegments 共享 helper |
| `apps/miniprogram/lib/api.ts` | UPDATE（140 → ~150 行）| rename / nickname / deleteSession 3 caller 改 path/query |
| `apps/miniprogram/components/message-bubble/message-bubble.ts` | UPDATE（+segments prop + onCiteTap method）| 富文本化 |
| `apps/miniprogram/components/message-bubble/message-bubble.wxml` | UPDATE（替换 text 渲染为 segments `wx:for`）| 富文本化 |
| `apps/miniprogram/components/message-bubble/message-bubble.wxss` | UPDATE（+ .cite-num 样式）| 高亮 + tap feedback |
| `apps/miniprogram/pages/chat/chat.ts` | UPDATE（callChat 内 parseAnswerSegments → 传给 bubble）| 接 parse 后的 segments |
| `apps/miniprogram/test/citation-parser.test.ts` | NEW（~100 行）| 6 用例 |
| `apps/miniprogram/test/api.test.ts` | UPDATE（rename + nickname + deleteSession mock 断言改 path/query/method）| 3 caller 测试改 mock |
| `apps/miniprogram/test/message-bubble.test.ts` | NEW（~120 行）| 5 用例 富文本渲染 + onCiteTap |
| `docs/cp7-b-citations-setup.md` | NEW（~120 行）| 解析规则 + 测试指南 + UI 行为 |
| `README.md` | UPDATE | +CP-7-B 节 |
| `docs/superpowers/state-cp7-b.md` | NEW（~250 行）| commit 汇总 + 教训 + 真接路径 |

**共 5 改代码 + 3 新代码 + 5 新测试 + 2 改测试 + 3 新/改文档 = 18 总**

---

## Tasks

### Task 1: `api-sessions-rename.ts` 后端 handler（RED-GREEN-REFACTOR）

- **Action**：
  1. 写 `apps/api/test/handlers/api-sessions-rename.test.ts` 8 用例（RED）：
     - happy
     - 401 no auth
     - 401 invalid jwt
     - 400 missing id
     - 400 empty title
     - 400 title > 100
     - 404 session not found
     - 403 not owner
     - 200 OPTIONS preflight
     - 405 wrong method（GET/POST）
  2. 实现 `apps/api/src/handlers/api-sessions-rename.ts`（GREEN）：
     - OPTIONS → 204
     - JWT verify → userId
     - method check PATCH else 405
     - query id + body title trim 校验（>0, ≤100）
     - getById(chatSession, id) → 不存在 404 / 非本人 403
     - update(_id, { title: title.trim(), updatedAt: Date.now() })
     - 返 { ok: true, id, title }
  3. 注册到 `apps/api/src/index.ts` HANDLER_MAP
  4. 跑测试（GREEN）— 10 用例全绿
  5. REFACTOR：清理冗余

- **Mirror**：`apps/api/src/handlers/api-sessions-delete.ts:1-46`
- **Validate**：`pnpm -F api test api-sessions-rename`

---

### Task 2: `api-user-nickname.ts` 后端 handler（RED-GREEN-REFACTOR）

- **Action**：
  1. 写 `apps/api/test/handlers/api-user-nickname.test.ts` 8 用例（RED）：
     - happy
     - 401 no auth
     - 400 missing nickname
     - 400 empty nickname
     - 400 nickname > 30
     - 404 user not found
     - 200 OPTIONS preflight
     - 405 wrong method
  2. 实现 `apps/api/src/handlers/api-user-nickname.ts`（GREEN）：
     - OPTIONS → 204
     - JWT verify → userId
     - method check PATCH else 405
     - body nickname trim 校验（>0, ≤30）
     - getById(user, userId) → 不存在 404（userId = CloudBase `_id`）
     - update(_id, { nickname: nickname.trim() })
     - 返 { ok: true, user_id, nickname }
  3. 注册到 `apps/api/src/index.ts` HANDLER_MAP
  4. 跑测试（GREEN）— 9 用例全绿
  5. REFACTOR

- **Mirror**：`apps/api/src/handlers/api-auth-wx-login.ts:52-78`（user lookup 模式）+ `api-sessions-delete.ts:1-46`（handler 骨架）
- **Validate**：`pnpm -F api test api-user-nickname`

---

### Task 3: api-chat [N] 解析（RED-GREEN-REFACTOR）

- **Action**：
  1. 写 `apps/api/test/handlers/api-chat.test.ts` 6 用例（RED）：
     - happy [1][3] → citedNums=[1,3], citations=2 项
     - happy 全引 [1][2][3][4][5] → citations=5 项
     - 越界 [9] → citedNums=[9] but citations=[]（越界被过滤）
     - 重复 [1][1][1] → citedNums=[1]（去重）
     - 0 个 → citedNums=[], citations=[]
     - 乱序 [3][1] → citedNums=[3,1], citations 按 [3,1] 顺序映射
  2. 实现 api-chat.ts 内 `parseAnswerSegments` + 改 ChatResponse（GREEN）：
     - 正则 `/\[\d+\]/g` → 去重保 first → 过滤越界（1 ≤ n ≤ top.length）
     - `citations` 按 `citedNums` 顺序映射（不按数字重排）
     - 改 ChatResponse interface 加 `citedNums: number[]`
  3. 跑测试（GREEN）— 6 用例全绿
  4. REFACTOR

- **Mirror**：`apps/api/src/handlers/api-ask.ts:45-58` 旧 JSON 块解析参考（格式不同）
- **Validate**：`pnpm -F api test api-chat`

---

### Task 4: minipgm caller 调整 + citation-parser

- **Action**：
  1. 写 `apps/miniprogram/test/citation-parser.test.ts` 6 用例（RED）
  2. 新建 `apps/miniprogram/lib/citation-parser.ts`：`parseAnswerSegments(answer): Segment[]`（GREEN）
  3. 改 `apps/miniprogram/lib/api.ts`：
     - `renameSession`: cloudCall `{ path: "/api-sessions-rename", httpMethod: "PATCH", query: { id }, body: { title }, jwt }`
     - `updateNickname`: cloudCall `{ path: "/api-user-nickname", httpMethod: "PATCH", body: { nickname }, jwt }`
     - `deleteSession`: cloudCall `{ path: "/api-sessions-delete", httpMethod: "DELETE", query: { id }, jwt }`（修 CP-7-A 遗留）
  4. 改 `apps/miniprogram/test/api.test.ts`：3 caller mock 断言改 path/query/httpMethod
  5. 跑测试（GREEN）— 6 + 既有 全绿
  6. REFACTOR

- **Mirror**：`apps/miniprogram/lib/api.ts:78-95` 现有 caller 模板
- **Validate**：`pnpm -F miniprogram test citation-parser + api`

---

### Task 5: message-bubble 富文本化

- **Action**：
  1. 写 `apps/miniprogram/test/message-bubble.test.ts` 5 用例（RED）：
     - render text-only → 1 text segment
     - render [1] → 1 cite segment with data-cite-n="1"
     - render [1][2] → 2 cite segments
     - onCiteTap → 找对 citations[0].title → 调 wx.showToast
     - onCiteTap invalid n → 静默或 toast "未知引用"
  2. 改 `message-bubble.ts`：
     - + `segments: Segment[]` prop（默认值 []）
     - + `onCiteTap(e)` method：data-cite-n → citations[n-1] → wx.showToast
  3. 改 `message-bubble.wxml`：替换 `<view class="bubble-text">{{text}}</view>` 为 segments `wx:for`
  4. 改 `message-bubble.wxss`：+ `.cite-num { color, cursor, hover }`
  5. 改 `apps/miniprogram/pages/chat/chat.ts`：callChat 内 `parseAnswerSegments(resp.answer)` → 传 `segments` 给 bubble
  6. 跑测试（GREEN）— 5 用例全绿
  7. REFACTOR

- **Mirror**：`apps/miniprogram/components/citation-card/citation-card.ts:6-19` prop + tap 模式
- **Validate**：`pnpm -F miniprogram test message-bubble`

---

### Task 6: 文档 + state

- **Action**：
  1. 写 `docs/cp7-b-citations-setup.md`：解析规则 + 测试指南 + UI 行为
  2. 更新 `README.md` 加 CP-7-B 节（参考 CP-7-A 状态节）
  3. 写 `docs/superpowers/state-cp7-b.md`：commit 汇总 + 教训 + 真接路径
  4. 更新 `docs/superpowers/state-cp7-a.md` §6.4 把 CP-7-B 标记 ✅

- **Validate**：commit 后阅读 docs 无 placeholder / TBD

---

## Validation

```bash
# Task 1-3 验证（后端）
pnpm -F api test api-sessions-rename api-user-nickname api-chat

# Task 4 验证（caller 改后）
pnpm -F miniprogram test citation-parser api

# Task 5 验证（前端富文本）
pnpm -F miniprogram test message-bubble

# 最终累计
pnpm -r typecheck       # 5 包全绿
pnpm -r test            # 期望 187+ 用例（154 + 33）
pnpm -F admin build     # 成功
```

---

## Decision Points

### DP-1: chat 解析后 citations 为空时返 `citedNums: []` 还是省略？

**选项**：
- A：始终返 `citedNums: []`（显式空数组）
- B：`citedNums` 字段在空时省略

**Plan 决策**：**A**（显式）。理由：前端好处理（无需 `resp.citedNums ?? []`）；caller 一致。

### DP-2: message-bubble segments prop 默认值？

**选项**：
- A：`value: []` 空数组默认（向后兼容现有 user 消息）
- B：required prop（无默认，强制 caller 传）

**Plan 决策**：**A**。理由：现有 user 消息无 answer（只有 q 文本），需 default []；避免 caller 漏传。

### DP-3: onCiteTap 时 citations[n-1] 越界？

**选项**：
- A：静默（不 toast）
- B：toast "未知引用"

**Plan 决策**：**B**。理由：调试友好；用户能看到反馈。

### DP-4: `parseAnswerSegments` 在 chat.ts 还是 message-bubble.ts？

**选项**：
- A：chat.ts 解析（caller 解析后传 segments）
- B：message-bubble.ts 解析（bubble 接 text 自解析）

**Plan 决策**：**A**（spec D-6）。理由：message-bubble 是纯展示组件；解析逻辑在 chat 业务层。

### DP-5: api-router PATCH method 显式 check 还是依赖 handler？

**选项**：
- A：handler 内 `if (event.httpMethod !== "PATCH") return 405`
- B：api-router 自动分发 method 不匹配 → 404

**Plan 决策**：**A**。理由：handler 自描述；与 sessions-delete / sessions-get 一致（这些 GET handler 也只接 GET）。

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Mock 改造漏 caller (rename / nickname / delete 3 caller) | LOW | AC-7 + AC-7a 显式列 3 caller；Task 4 拆子步骤验证 |
| [N] 解析与 api-ask 旧格式不一致 | LOW | api-chat.ts 局部 helper；不与 api-ask 共享 |
| message-bubble segments 渲染破坏现有 user 消息显示 | LOW | DP-2 default []；user 消息 text 不变（不传 segments → 渲染空）|
| updateNickname 404 边界（user record 不存在）| LOW | spec D-3 选 404；AC 覆盖；理论 0 触发 |
| deleteSession 改 path 风格影响现有 caller 测试 | LOW | api.test.ts 1 个 mock 断言改；Task 4 子步骤 |
| PATCH method 未在 api-router 验证 | LOW | Task 1/2 method check；本地测试覆盖 |
| minipgm `wx.cloud.callFunction` 真接时 query 参数传递 | LOW | rawCall 已支持 query field（CP-7-A 已 work）；CP-7 真接验证 |

---

## Acceptance

### AC 后端

- [ ] AC-1 `api-sessions-rename.ts` 接到 HANDLER_MAP；PATCH + JWT + 校验 + 权限 + update 全跑通
- [ ] AC-2 `api-user-nickname.ts` 接到 HANDLER_MAP；PATCH + JWT + 校验 + update 全跑通
- [ ] AC-3 api-chat.ts 解析 `[N]` 标记，返 `citedNums` + `citations` 为 subset
- [ ] AC-4 3 个 handler test 文件 8+8+6 = 22 用例
- [ ] AC-5 `pnpm -F api test` 全绿

### AC minipgm

- [ ] AC-6 `citation-parser.ts` 新建 + 6 用例
- [ ] AC-7 `renameSession` / `updateNickname` caller 改 `httpMethod: "PATCH"`
- [ ] AC-7a `deleteSession` caller 改 query 风格（修 CP-7-A 遗留）
- [ ] AC-8 `message-bubble` 富文本化 + 5 用例
- [ ] AC-9 `chat.ts` 解析 answer → segments → 传 bubble
- [ ] AC-10 `api.test.ts` 3 caller mock 断言改
- [ ] AC-11 `pnpm -F miniprogram test` 全绿

### AC 累计 + 文档

- [ ] AC-12 总增 +33 用例（api +22 / minipgm +11）；累计 187
- [ ] AC-13 `pnpm -r typecheck` 5 包全绿
- [ ] AC-14 `pnpm -r test` 全绿
- [ ] AC-15 `pnpm -F admin build` 成功
- [ ] AC-16 `docs/cp7-b-citations-setup.md` 完成
- [ ] AC-17 README + state-cp7-b.md 完成
- [ ] AC-18 state-cp7-a.md §6.4 CP-7-B 标 ✅

---

## Commit 拆分（6 commit + 1 merge = 7 总）

| # | Commit | 主题 | 测试增量 |
|---|---|---|---|
| 1 | spec | `docs: CP-7-B spec — handler 后端补全 + [N] 引用解析 + minipgm 富文本` | 0（已 commit `f10e7b6`）|
| 2 | plan | `docs: CP-7-B plan — handler 后端补全 + [N] 引用解析 + minipgm 富文本` | 0（本文件 commit）|
| 3 | Task 1+2 | `feat(api): CP-7-B — api-sessions-rename + api-user-nickname handlers + index.ts 注册` | +18 |
| 4 | Task 3 | `feat(api): CP-7-B — api-chat 答案 [N] 解析 (citedNums subset)` | +6 |
| 5 | Task 4+5 | `feat(miniprogram): CP-7-B — citation-parser + caller path/method 改 + message-bubble 富文本` | +11（净调整：6 + 5 + 改 mock 0 净增）|
| 6 | docs | `docs: CP-7-B — state + README + setup.md + state-cp7-a.md §6.4 标完成` | 0 |
| merge | `worktree-cp7-b-handlers → master --no-ff` | — |

**共 7 commit + 1 merge = 8 总**

---

## 工作流

- worktree 隔离：`/Users/Mark/cc_project/unequal/.worktrees/cp7-b-handlers` + branch `cp7-b-handlers`（已创建）
- 双包改动（api + miniprogram）
- TDD 严格走：3+1+1 = 5 test 文件先写（RED）→ 实现（GREEN）→ 改 caller/wxml（保持现有测试绿）→ REFACTOR
- 主线程直接做（参考 CP-7-A M6.3c/d 经验，~3-5h 总耗时）
- 每个 Task 完跑 `pnpm -F <pkg> test <name>` 验证
- 最终全包 `pnpm -r typecheck` + `pnpm -r test` + `pnpm -F admin build`

---

## 累计测试 + 文件清单

### 仓库测试累计（CP-7-B 后）

| 包 | master | CP-7-A | CP-7-B | 累计 |
|---|---|---|---|---|
| shared | 47 | 0 | 0 | 47 |
| api | 23 | 0 | +22 (rename 8 + nickname 8 + chat[N] 6) | **45** |
| miniprogram | 30 | +3 | +11 (citation-parser 6 + message-bubble 5) -3 mock 改 0 净 | **41** |
| admin | 24 | 0 | 0 | 24 |
| crawler | 19 | 0 | 0 | 19 |
| **累计** | **143** | **+11** | **+33** | **187** |

注：api 包 master 实际 30（cp6-archived 后累计），state-cp7-a §4.1 已记录。

### 文件清单（CP-7-B 后）

| 类型 | 文件 | 状态 |
|---|---|---|
| 新代码 | `apps/api/src/handlers/api-sessions-rename.ts` | NEW（~50 行）|
| 新代码 | `apps/api/src/handlers/api-user-nickname.ts` | NEW（~45 行）|
| 改代码 | `apps/api/src/handlers/api-chat.ts` | 211 → ~225 行（+parseAnswerSegments + citedNums）|
| 改代码 | `apps/api/src/index.ts` | +2 import + 2 HANDLER_MAP 行 |
| 新代码 | `apps/miniprogram/lib/citation-parser.ts` | NEW（~30 行）|
| 改代码 | `apps/miniprogram/lib/api.ts` | 140 → ~150 行（3 caller 改 path/query/method）|
| 改代码 | `apps/miniprogram/components/message-bubble/message-bubble.ts` | +segments prop + onCiteTap |
| 改代码 | `apps/miniprogram/components/message-bubble/message-bubble.wxml` | 替换 text 渲染为 segments wx:for |
| 改代码 | `apps/miniprogram/components/message-bubble/message-bubble.wxss` | +.cite-num 样式 |
| 改代码 | `apps/miniprogram/pages/chat/chat.ts` | callChat 内 parse + 传 segments |
| 新测试 | `apps/api/test/handlers/api-sessions-rename.test.ts` | NEW（~150 行，8 用例）|
| 新测试 | `apps/api/test/handlers/api-user-nickname.test.ts` | NEW（~140 行，8 用例）|
| 新测试 | `apps/api/test/handlers/api-chat.test.ts` | NEW（~180 行，6 用例）|
| 新测试 | `apps/miniprogram/test/citation-parser.test.ts` | NEW（~100 行，6 用例）|
| 改测试 | `apps/miniprogram/test/api.test.ts` | 3 caller mock 断言改 |
| 新测试 | `apps/miniprogram/test/message-bubble.test.ts` | NEW（~120 行，5 用例）|
| 新文档 | `docs/cp7-b-citations-setup.md` | NEW（~120 行）|
| 新文档 | `docs/superpowers/state-cp7-b.md` | NEW（~250 行）|
| 改文档 | `README.md` | +CP-7-B 节 |
| 改文档 | `docs/superpowers/state-cp7-a.md` | §6.4 CP-7-B 标 ✅ |

**共 5 改代码 + 3 新代码 + 5 新测试 + 2 改测试 + 4 文档 = 19 总**

---

## 附录 A：Plan 与 Spec 关键差异

| # | Spec | Plan 调整 | 理由 |
|---|---|---|---|
| P-1 | 不提 deleteSession 修复 | **加 R-5 / AC-7a**：deleteSession 改 query 风格 | CP-7-A 遗留 path param vs query 不一致 bug；真接 400 |
| P-2 | message-bubble 加 segments prop | **Plan DP-2** 默认值 [] 决策 | 现有 user 消息无 answer，default [] 向后兼容 |
| P-3 | PATCH method handler 内检查 | **Plan DP-5** handler 内 405 检查 | 与 sessions-delete / sessions-get 模式一致 |
| P-4 | 6 + 5 + 6 + 8 + 8 = 33 用例 | **一致** | 同 spec AC-13 |
| P-5 | api-chat 解析不与 api-ask 共享 | **Plan 强化** chat/ask 格式不同（[N] inline vs JSON 块）；不共享 | 避免错误耦合 |
| P-6 | onCiteTap 行为 | **Plan DP-3** 越界时 toast "未知引用" | 调试友好；用户能看到反馈 |