# CP-7-B 引用解析与 PATCH handler — Setup 文档

**完成日期**：2026-06-18
**Spec**：`docs/superpowers/specs/2026-06-18-cp7-b-handler-citations-design.md`
**Plan**：`docs/superpowers/plans/2026-06-18-cp7-b-handler-citations.md`
**State**：`docs/superpowers/state-cp7-b.md`

---

## 1. 改了什么

3 个子系统：

### 1.1 后端（apps/api）

**新增 2 个 handler**（接 api-router 13 → 15）：

| Handler | 路径 | 用途 |
|---|---|---|
| `api-sessions-rename.ts` | PATCH /api-sessions-rename?id={id} body={title} | 改 chatSession.title + updatedAt |
| `api-user-nickname.ts` | PATCH /api-user-nickname body={nickname} | 改 user.nickname（不动 wxOpenid/createdAt）|

**改造 1 个 handler**：

| Handler | 改造 |
|---|---|
| `api-chat.ts` | 加 `parseAnswerSegments(answer, topLength)` helper；返 `citedNums: number[]` + `citations` 改为 LLM 实际引用的子集（按 citedNums 顺序）|

### 1.2 minipgm caller（apps/miniprogram/lib/api.ts）

3 caller 改路径风格：

| Caller | 旧路径 | 新路径 | Method |
|---|---|---|---|
| `renameSession(id, title)` | `/sessions/${id}` (path param) | `/api-sessions-rename?id={id}` | PATCH |
| `updateNickname(nickname)` | `/user/nickname` | `/api-user-nickname` | PATCH |
| `deleteSession(id)` | `/api-sessions-delete/${id}` (path param) | `/api-sessions-delete?id={id}` | DELETE |

**修 CP-7-A 遗留**：原 `deleteSession` 用 path param 但 handler `getQuery(event, "id")` 期望 query，真接时 400。

### 1.3 minipgm 前端富文本

**新建 helper**：`apps/miniprogram/lib/citation-parser.ts`

```ts
import { parseAnswerSegments, extractCitedNums } from "../../lib/citation-parser.js";

const segments = parseAnswerSegments("宝宝发烧 [1] [2] 严重");
// → [
//     { type: "text", text: "宝宝发烧 " },
//     { type: "cite", n: 1 },
//     { type: "cite", n: 2 },
//     { type: "text", text: " 严重" },
//   ]
```

**改造组件**：`apps/miniprogram/components/message-bubble/`
- 新增 `segments: Segment[]` prop（默认 `[]`）
- 新增 `onCiteTap(e)` method → `wx.showToast(citations[n-1].title)`
- wxml: assistant 消息用 `wx:for="{{segments}}"` 渲染 text / cite-n
- wxss: `.cite-num` 蓝色 + 浅蓝背景

**调用方**：`pages/chat/chat.ts`
- `MessageItem` 加 `segments?` 字段
- `callChat` 内 `parseAnswerSegments(resp.answer)` → 传给 message-bubble

---

## 2. 解析规则

### 2.1 后端 `api-chat.parseAnswerSegments(answer, topLength)`

```ts
const matches = answer.match(/\[\d+\]/g) ?? [];
// 1. 提取所有 [数字]
// 2. 去重保 first 出现位置
// 3. 返回 { rawNums, citedNums }
```

**关键不变量**：
- citedNums 包含越界数字（`n > topLength` 或 `n < 1`）—— 由调用方决定 subset
- 调用方（api-chat handler）过滤越界后映射到 `citations` subset

### 2.2 前端 `parseAnswerSegments(answer)`

```ts
const re = /(\[\d+\])/g;
const parts = answer.split(re); // split with capture 保 separator
// 1. 按 [\d+] 切分
// 2. 奇数段 → text；偶数段（[N]）→ cite
// 3. 非数字 [abc] 不 split，整段保留为 text
// 4. [0] split 后 cite 段 n=0 → 当 text 兜底
```

**关键不变量**：
- segments 数组保原文顺序（text → cite → text → cite → ...）
- n >= 1 才视为 cite；n < 1 / 非数字 → text

### 2.3 端到端对齐

| 阶段 | 输出 |
|---|---|
| LLM 答案 | `"宝宝发烧 [1] [2] 严重"` |
| 后端 `citedNums` | `[1, 2]`（去重保 first） |
| 后端 `citations` | `[{n: 1, ...}, {n: 2, ...}]`（subset，按 citedNums 顺序）|
| 前端 `segments` | `[{text: "宝宝发烧 "}, {cite: 1}, {cite: 2}, {text: " 严重"}]` |
| 前端渲染 | 文本 [1] 文本 [2] 文本（[N] 可点击） |

---

## 3. 测试指南

### 3.1 后端 handler 测试

```bash
pnpm -F api test api-sessions-rename api-user-nickname api-chat
```

测试位置：`apps/api/test/handlers/`：
- `api-sessions-rename.test.ts` (12 用例) — happy / 401 / 400 / 403 / 404 / OPTIONS / 405 / trim
- `api-user-nickname.test.ts` (12 用例) — happy / 401 / 400 / 404 / OPTIONS / 405 / 字段校验 / trim
- `api-chat.test.ts` (9 用例) — [N] 解析 helper 全覆盖

### 3.2 minipgm 测试

```bash
pnpm -F miniprogram test citation-parser message-bubble api
```

- `citation-parser.test.ts` (11 用例) — 解析 helper
- `message-bubble.test.ts` (6 用例) — segments prop + onCiteTap
- `api.test.ts` — 3 caller mock 断言改 path/query/method

---

## 4. UI 行为

### 4.1 渲染

assistant 消息：
```
宝宝发烧 [1] [2] 严重
         ↑  ↑    ↑ 蓝色背景，可点击
```

user 消息：纯文本，无 `[N]` 解析（向后兼容）。

### 4.2 点击 `[N]`

- 找 `citations[n-1]` → `wx.showToast({ title: citation.title, icon: "none" })`
- 越界或空 citations → toast "未知引用"
- duration 1500ms

### 4.3 scrollToCard（推迟到 CP-7-C/D）

当前 `[N]` 点击仅显示 toast，不滚动到对应 citation-card。
如需 scrollToCard 行为，推到 CP-7-C/D 单独项目。

---

## 5. Mock 模式

### 5.1 后端 handler

用 `vi.mock("../../src/lib/db.js")` 注入 mock getById / update（避免真连 CloudBase）：

```ts
vi.mock("../../src/lib/db.js", () => ({
  COLLECTIONS: { chatSession: "chat_session" },
  getById: vi.fn(),
  update: vi.fn(),
  // ...
}));
```

mock 返回值需 cast `as unknown as Awaited<ReturnType<typeof getById>>`（getById 默认 `Record<string, unknown>` 类型太严）。

### 5.2 minipgm message-bubble

用 `vi.fn()` 替换全局 `wx` + `Component`，捕获 opts：

```ts
const mockWx = { showToast: vi.fn() };
const mockComponent = vi.fn();
(globalThis as unknown as { wx: typeof mockWx }).wx = mockWx;
(globalThis as unknown as { Component: (opts: ComponentOpts) => void }).Component = mockComponent;
await import("../components/message-bubble/message-bubble.js");
const opts = mockComponent.mock.calls[0]![0] as ComponentOpts;
```

---

## 6. 迁移路径

无 DB schema 变化；无 env var 变化；无 secret 变化。

**后端**：handler 文件加 + index.ts 改 3 行 → 部署 api-router
**minipgm**：api.ts + message-bubble + 新 citation-parser.ts → 微信开发者工具上传

---

## 7. 真接验证路径

CP-7-B 完成后，CP-7 真接验证能跑通全 7 caller（之前 rename + nickname 会 404）：

1. 替换 apps/miniprogram/project.config.json 的 appid
2. 微信开发者工具导入 apps/miniprogram
3. onLaunch → ensureJwt → /api-auth-wx-login callFunction 成功
4. chat tab → /api-chat callFunction → 返 RAG 答案 + 解析后的 citations
5. history tab → /api-sessions-list callFunction → 返 sessions
6. 长按 session → promptRename → /api-sessions-rename PATCH callFunction → 改 title
7. 删除 session → /api-sessions-delete DELETE callFunction → 软删
8. nickname-input → /api-user-nickname PATCH callFunction → 改 nickname

详细真接路径见 `docs/superpowers/state-cp7-b.md` §8。

---

## 8. References

- **Spec**：`docs/superpowers/specs/2026-06-18-cp7-b-handler-citations-design.md`
- **Plan**：`docs/superpowers/plans/2026-06-18-cp7-b-handler-citations.md`
- **State**：`docs/superpowers/state-cp7-b.md`
- **CP-7-A**：`docs/superpowers/state-cp7-a.md`（cloudCall 统一化前置）
- **CP-6**：`docs/superpowers/state-cp6.md`（api-router + HANDLER_MAP 基础）