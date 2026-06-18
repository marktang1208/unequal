# CP-7-B — handler 后端补全 + [N] 引用解析

**版本**：2026-06-18
**前置**：CP-7-A 已 merge（commit `65fae87`）；minipgm 7 caller 全调 cloudCall；143 master + 11 CP-7-A = **154 tests** 全绿
**范围**：apps/api 后端 2 个 handler 补全（renameSession + updateNickname）+ api-chat.ts 答案中 `[N]` 内联标记解析 + minipgm chat 页 message-bubble 富文本化

> **真接路径**：本 spec 完成后，CP-7 真接（minipgm 5 步验证）能跑通全 7 caller（之前 renameSession + updateNickname 会 404 阻塞真接验证）。

---

## 1. Requirements

| # | 现状 | 目标 |
|---|---|---|
| R-1 | api-router 13 handler 缺 `api-sessions-rename` 和 `api-user-nickname` —— minipgm `renameSession` / `updateNickname` 走 callFunction → api-router 返 404 | 新建 2 个 handler 接 HANDLER_MAP，PATCH 路径，PATCH query id + body title / body nickname |
| R-2 | api-chat 返 `answer`（含 `[N]` 内联）+ `citations`（top-5 全集，无视 LLM 是否引用）| api-chat 后端解析 `[N]` → `citedNums: number[]` + `citations` 改为 LLM 实际引用的子集 |
| R-3 | minipgm `message-bubble` 用 `<text>{{text}}</text>` 直接显示 answer 全文，`[N]` 不可点击 | chat.ts 解析 answer → `segments: Array<{text, citeN?}>` 传给 message-bubble；wxml 用 `wx:for` 渲染 `[N]` 为 `<text class="cite-num" data-cite-n bindtap>` |
| R-4 | minipgm caller `renameSession` / `updateNickname` 当前 cloudCall httpMethod 未明（cloudCall 走 POST 默认）| caller 改 `httpMethod: "PATCH"` |

**YAGNI 精简**（spec 显式不做）：
- ❌ 不做富文本 → citation-card scrollTo 联动（先做简单 `wx.showToast` 标红；scrollToCard 推 CP-7-C/D）
- ❌ 不做 message-bubble 解析的 SSR/缓存（CP-7 真接阶段再说）
- ❌ 不做 renameSession 软删恢复（admin history 列表已隐含支持；超出 scope）
- ❌ 不做 updateNickname avatar / 其他 profile 字段（spec 仅 nickname）
- ❌ 不做 api-router 动态加载（CP-6 静态 import + HANDLER_MAP 不变）

---

## 2. Patterns to Mirror

| 类别 | 来源 | 复用方式 |
|---|---|---|
| Handler 骨架 | `apps/api/src/handlers/api-sessions-delete.ts`（47 行 — OPTIONS + JWT + query 校验 + getById + 权限校验 + update/remove） | rename / nickname handler 同模板，简化（rename = update；nickname = getById+update） |
| JWT 鉴权 | `apps/api/src/handlers/api-sessions-delete.ts:24-32` `verifyJwt + payload.sub` | 2 个新 handler 同模板 |
| 错误码 | `errorResponse("NOT_FOUND", ..., 404)` / `"FORBIDDEN", ..., 403` / `"INVALID_REQUEST", ..., 400` / `"AUTH_FAILED", ..., 401`（CP-6 全套） | 2 个新 handler 同模板 |
| DB 操作 | `apps/api/src/lib/db.ts:21-23` `getById` / `update`（已有） | rename / nickname 直接用 |
| 内联引用解析 | `apps/api/src/handlers/api-ask.ts:45-58` `parseCitationsJson` + `stripCitationsJson`（CP-2 旧 JSON 块格式） | chat 改用 `/\[\d+\]/g` 正则解析（适配 LLM 输出格式变化） |
| minipgm 解析 | `apps/miniprogram/lib/api.ts` caller typed wrapper（CP-7-A） | 2 个新 caller 改 `httpMethod: "PATCH"`；不改函数签名 |
| 组件数据 | `apps/miniprogram/components/citation-card/citation-card.ts` 接收 `citation: Citation` prop | message-bubble 增加 `segments` 数据 + wxml `wx:for` |

---

## 3. Architecture Overview

```
─── 后端（apps/api/src/handlers/）────────────────────────────
新建 api-sessions-rename.ts（PATCH /api-sessions-rename?id=...）：
  1. OPTIONS → 204
  2. JWT verify → userId
  3. query id 校验 + body title trim 校验（>0, ≤100）
  4. getById chatSession → 不存在 404 / 非本人 403
  5. update(_id, { title: title.trim(), updatedAt: Date.now() })
  6. 返 { ok: true, id, title }

新建 api-user-nickname.ts（PATCH /api-user-nickname）：
  1. OPTIONS → 204
  2. JWT verify → userId（payload.sub = CloudBase _id）
  3. body nickname trim 校验（>0, ≤30）
  4. getById user(_id) → 不存在 404
  5. update(_id, { nickname: nickname.trim() })
  6. 返 { ok: true, user_id, nickname }

改 api-chat.ts（chat 答案 [N] 解析）：
  现有：return { answer, citations: top5, session_id, session_title, is_new_session }
  改为：return { answer, citedNums: number[], citations: subset, session_id, session_title, is_new_session }
  - 正则 /\[\d+\]/g → 去重保序 → 过滤越界（>top.length 或 <1）→ citedNums
  - citations 改按 citedNums 顺序映射 top（保留 retrieval 顺序，不按数字重排）

改 index.ts：
  +2 import + 2 HANDLER_MAP 条目（sessions-rename / user-nickname）

─── minipgm caller（apps/miniprogram/lib/api.ts）─────────────
renameSession(id, title): Promise<void>:
  改 cloudCall({ path: "/api-sessions-rename", httpMethod: "PATCH", query: { id }, body: { title }, jwt })

updateNickname(nickname): Promise<void>:
  改 cloudCall({ path: "/api-user-nickname", httpMethod: "PATCH", body: { nickname }, jwt })

─── minipgm 前端（pages/chat/chat.ts + components/message-bubble/）──
chat.ts:
  接 chat resp → parseAnswerSegments(answer): Array<{type: "text"|"cite", text?: string, n?: number}>
  把 segments 传给 message-bubble（新增 prop）

message-bubble.ts:
  + data.segments: Segment[]（新增 prop）
  + 接收完整 citations（已有 prop）
  + onCiteTap(e) → n = e.currentTarget.dataset.citeN → citation = citations[n - 1]
                  → wx.showToast({ title: citation?.title ?? "未知引用", icon: "none" })

message-bubble.wxml:
  <view class="bubble">
    <block wx:for="{{segments}}" wx:key="index">
      <text wx:if="{{item.type === 'text'}}">{{item.text}}</text>
      <text wx:elif="{{item.type === 'cite'}}"
            class="cite-num"
            data-cite-n="{{item.n}}"
            bindtap="onCiteTap">[{{item.n}}]</text>
    </block>
  </view>

onCiteTap 用 data-cite-n 查找 citations[n-1]（题目用 message-bubble.ts 已有 citations prop；无需新 prop 传）。

─── 共享解析 helper（apps/miniprogram/lib/）──────────────────
新建 lib/citation-parser.ts:
  parseAnswerSegments(answer: string): Array<Segment>
  复用同样的 /\[\d+\]/g 逻辑（前端后端一致；测试覆盖两端）
```

---

## 4. Data Flow

### 4.1 renameSession

```
minipgm history 页 promptRename
  → trim + 校验非空
  → renameSession(id, title)
    → cloudCall({ path: "/api-sessions-rename", httpMethod: "PATCH",
                   query: { id }, body: { title }, jwt })
      → wx.cloud.callFunction({ name: "api-router", data: { func: "api-sessions-rename", ... } })
        → api-router main(event) → HANDLER_MAP["api-sessions-rename"].main(event)
          → api-sessions-rename.ts:
            1. OPTIONS → 204
            2. verifyJwt → userId
            3. getQuery id + parseJsonBody title → 校验
            4. getById(chatSession, id) → 校验 ownership
            5. update(_id, { title: title.trim(), updatedAt: now })
            6. jsonResponse({ ok: true, id, title })
        → CloudBase 返 { statusCode: 200, body: '{"ok":true,"id":"...","title":"新标题"}' }
  → throw nothing（200）
  → history.refresh() 重新拉列表
```

### 4.2 updateNickname

```
minipgm chat 页 nickname 输入弹窗
  → trim + 校验非空
  → updateNickname(nickname)
    → cloudCall({ path: "/api-user-nickname", httpMethod: "PATCH",
                   body: { nickname }, jwt })
      → wx.cloud.callFunction → api-router → api-user-nickname
        → 1. verifyJwt → userId（payload.sub = CloudBase _id）
        → 2. parseJsonBody nickname → trim 校验
        → 3. getById(user, userId) → 不存在 404
        → 4. update(_id, { nickname: nickname.trim() })
        → 5. jsonResponse({ ok: true, user_id, nickname })
  → wx.showToast({ title: "昵称已更新" })
```

### 4.3 api-chat [N] 解析

```
LLM 输出 answer: "宝宝发烧可能由病毒感染引起 [1] [2]。建议..."
  ↓ api-chat handler
解析 /\[\d+\]/g → ["1", "2"] → 去重 → [1, 2]
  ↓ 校验
1 ≤ n ≤ top.length（top=5）→ 全部保留 → citedNums = [1, 2]
  ↓ 映射
citations = [
  { n: 1, title: "...", snippet: "...", trustLevel: 3, chunkId: "..." },
  { n: 2, title: "...", snippet: "...", trustLevel: 2, chunkId: "..." },
]
（按 citedNums 顺序，不重排）

返 { answer: "宝宝发烧可能由病毒感染引起 [1] [2]。建议...",
     citedNums: [1, 2],
     citations: [...],  // 上面 2 项
     session_id, session_title, is_new_session }

  ↓ minipgm chat.ts
parseAnswerSegments(answer) → [
  { type: "text", text: "宝宝发烧可能由病毒感染引起 " },
  { type: "cite", n: 1 },
  { type: "text", text: " " },
  { type: "cite", n: 2 },
  { type: "text", text: "。建议..." },
]

  ↓ message-bubble 渲染
<text>宝宝发烧可能由病毒感染引起 </text>
<text class="cite-num" bindtap>[1]</text>
<text> </text>
<text class="cite-num" bindtap>[2]</text>
<text>。建议...</text>

  ↓ user 点击 [1]
onCiteTap → wx.showToast({ title: citation[0].title }) → 显示《疫苗指南》
```

---

## 5. API Contracts

### 5.1 `PATCH /api-sessions-rename?id={sessionId}`

**Request**：
- Headers：`Authorization: Bearer <jwt>`
- Query：`id` (required, string, ULID)
- Body：`{ "title": string }`

**Response 200**：
```json
{ "ok": true, "id": "01HSESSION...", "title": "新标题" }
```

**Error**：
- 400 `INVALID_REQUEST` — missing id / empty title / title > 100 chars / non-string body
- 401 `AUTH_FAILED` — invalid JWT
- 403 `FORBIDDEN` — session.userId !== payload.sub
- 404 `NOT_FOUND` — session not found
- 500 `INTERNAL_ERROR` — DB error

### 5.2 `PATCH /api-user-nickname`

**Request**：
- Headers：`Authorization: Bearer <jwt>`
- Body：`{ "nickname": string }`

**Response 200**：
```json
{ "ok": true, "user_id": "01HUSER...", "nickname": "张三" }
```

**Error**：
- 400 `INVALID_REQUEST` — missing nickname / empty / > 30 chars
- 401 `AUTH_FAILED` — invalid JWT
- 404 `NOT_FOUND` — user record not found（理论上 wx-login 后必存在）
- 500 `INTERNAL_ERROR`

### 5.3 `POST /api-chat`（改）

**Response 200**（新增 `citedNums`，`citations` 改 subset）：
```json
{
  "answer": "宝宝发烧可能由病毒感染引起 [1] [2]。建议...",
  "citedNums": [1, 2],
  "citations": [
    { "n": 1, "title": "《疫苗指南》", "snippet": "...", "trustLevel": 3, "chunkId": "..." },
    { "n": 2, "title": "《儿科手册》", "snippet": "...", "trustLevel": 2, "chunkId": "..." }
  ],
  "session_id": "01HSESSION...",
  "session_title": "...",
  "is_new_session": false
}
```

**边界**：
- answer 无 [N] → `citedNums: []`, `citations: []`（不是 top-5 空，是 LLM 没引）
- 越界 [9] → 丢弃（不报错）
- 重复 [1][1] → 去重保 first 出现位置
- 乱序 [3][1] → citedNums = [3, 1]，citations 按 citedNums 顺序映射（[3] 对应 top[2]，[1] 对应 top[0]）

---

## 6. Error Handling

| Error 类 | 触发条件 | 响应 |
|---|---|---|
| `INVALID_REQUEST` | body 缺失 / 字段非 string / trim 后空 / 超长 | 400 + 明确 message |
| `AUTH_FAILED` | JWT verify 失败 / scope 不匹配 | 401 |
| `FORBIDDEN` | session.userId !== jwt.sub | 403（renameSession）|
| `NOT_FOUND` | getById 返 null | 404 |
| `INTERNAL_ERROR` | DB 调用抛异常 | 500 + 不泄露内部细节 |

---

## 7. Testing Strategy

### 7.1 后端单测（apps/api/test/handlers/）

每个新 handler 独立 test 文件：

**`api-sessions-rename.test.ts` — 8 用例**：
- happy：PATCH with valid jwt + id + title → 200 + update 被调
- 401：no auth header → AUTH_FAILED
- 401：invalid jwt → AUTH_FAILED
- 400：missing id query → INVALID_REQUEST
- 400：empty title in body → INVALID_REQUEST
- 400：title > 100 chars → INVALID_REQUEST
- 404：session not found → NOT_FOUND
- 403：session.userId !== jwt.sub → FORBIDDEN
- 200：OPTIONS preflight → 204

**`api-user-nickname.test.ts` — 8 用例**：
- happy：PATCH with valid jwt + nickname → 200 + update 被调
- 401：no auth → AUTH_FAILED
- 400：missing nickname → INVALID_REQUEST
- 400：empty nickname → INVALID_REQUEST
- 400：nickname > 30 chars → INVALID_REQUEST
- 404：user not found → NOT_FOUND
- 200：OPTIONS preflight → 204
- update 字段校验：只更新 nickname（不动 wxOpenid/createdAt）

**`api-chat.test.ts` 扩展 +6 用例**（现有 0 用例 → 6 新增）：
- happy [1][3] → citedNums=[1,3], citations=2 项
- happy [1][2][3][4][5] 全引 → citations=5 项
- 越界 [9] → citedNums=[9] 但 citations=[]（越界被过滤）
- 重复 [1][1][1] → citedNums=[1]（去重）
- 0 个 → citedNums=[], citations=[]
- 乱序 [3][1] → citedNums=[3,1], citations 按 [3,1] 顺序映射

### 7.2 minipgm 单测（apps/miniprogram/test/）

**`citation-parser.test.ts` NEW — 6 用例**：与后端 [N] 解析对称覆盖

**`api.test.ts` 改**：renameSession / updateNickname mock 断言加 `httpMethod: "PATCH"`

**`message-bubble.test.ts` UPDATE +5 用例**：
- render text-only answer（无 [N]）→ 1 text segment
- render [1] answer → 1 cite segment with data-cite-n="1"
- render [1][2] → 2 cite segments
- onCiteTap → 找对 citations[0].title → 调 wx.showToast
- onCiteTap with invalid n → 静默（不 toast 或 toast "未知引用"）

### 7.3 集成测试

- 无独立集成测试（handler 单测覆盖；CP-7 真接阶段跑 E2E）

---

## 8. Migration / Rollout

无 DB schema 变化（chatSession / user 已存在）；无 env var 变化；无 secret 变化。

**后端**：handler 文件加 + index.ts 改 3 行 → 部署 api-router（`tcb fn deploy api-router --force`）
**minipgm**：api.ts + message-bubble.ts/.wxml + 新 citation-parser.ts → 微信开发者工具上传

---

## 9. Open Questions

无。spec 决策点 D-1~D-5 已在 §10 显式列出。

---

## 10. Design Decisions

### D-1: renameSession 改 title 之外是否也改 updatedAt？

**选项**：
- A：改 title + updatedAt（让 history 列表按更新时间排序时新标题排前）
- B：只改 title（updatedAt 不变，避免破坏现有排序逻辑）
- C：改 title + 触发 listSessions 缓存失效

**决策**：**A**。理由：rename 是 user 行为，updatedAt 自然更新。history 列表已按 updatedAt desc 排序（D-2 不变）。

### D-2: renameSession 是否允许改 messages / createdAt？

**决策**：**不允许**。YAGNI — 当前 UI 只暴露 title 编辑。handler 只允许 `{ title, updatedAt }` patch。

### D-3: updateNickname 不存在时返 404 还是 upsert？

**决策**：**404**。理由：wx-login 已创建 user record；理论上不该不存在。若存在用户被删的边缘场景，404 比 upsert 安全（避免重建空 user 引发其他逻辑问题）。

### D-4: api-chat [N] 解析后 citations 顺序？

**选项**：
- A：按 citedNums 数字顺序（[3][1] → citations[0]=原 [3], citations[1]=原 [1]）
- B：按 retrieval top 顺序（[3][1] → citations[0]=原 [1] top[0], citations[1]=原 [3] top[2]）

**决策**：**A**。理由：citedNums 顺序就是 LLM 答案中引用出现的顺序，与用户阅读流一致；top 顺序用户不可见。

### D-5: message-bubble cite 点击行为？

**选项**：
- A：`wx.showToast({ title: citation.title })` 简单标红
- B：scrollToView 对应 citation-card（需 message-bubble 接收 citations prop + 算 offset）
- C：navigateTo 到独立引用详情页

**决策**：**A**。理由：CP-7-B 范围最小化；B 需要 bubble 接收完整 citations + 算 layout，C 需要新页。B/C 推 CP-7-C/D。

### D-6: parseAnswerSegments 在前端还是后端？

**选项**：
- A：前端解析（chat.ts 解析后传给 message-bubble）
- B：后端解析并返 segments 数组
- C：双端都解析（前端展示用，后端 sanity-check）

**决策**：**A**。理由：answer 文本已存在 response 中，前端解析 0 网络开销；后端解析需新增字段；citations 已是结构化数据。

### D-7: citation-parser.ts 共享 helper？

**选项**：
- A：新建 `apps/miniprogram/lib/citation-parser.ts` 独立模块
- B：内联在 message-bubble.ts 内（私有函数）
- C：放 shared 包

**决策**：**A**。理由：chat.ts 和 message-bubble 都可能需要；独立模块便于测试；不放 shared 因为仅前端用。

---

## 11. Acceptance Criteria

### AC 后端

- [ ] AC-1 `api-sessions-rename.ts` 接到 HANDLER_MAP；PATCH 路径 + JWT + 校验 + 权限 + update 全跑通
- [ ] AC-2 `api-user-nickname.ts` 接到 HANDLER_MAP；PATCH 路径 + JWT + 校验 + update 全跑通
- [ ] AC-3 api-chat.ts 解析 `[N]` 标记，返 `citedNums` + 改 `citations` 为 subset
- [ ] AC-4 2 个新 handler 单测各 8 用例 + api-chat [N] 解析 6 用例 = **22 新增**
- [ ] AC-5 `pnpm -F api test` 全绿
- [ ] AC-6 `pnpm -r typecheck` 5 包全绿

### AC minipgm

- [ ] AC-7 `renameSession` / `updateNickname` caller 改 `httpMethod: "PATCH"`
- [ ] AC-8 `citation-parser.ts` 新建 + 6 用例
- [ ] AC-9 `message-bubble.ts/.wxml` 支持 segments 渲染 + onCiteTap → wx.showToast
- [ ] AC-10 message-bubble test +5 用例 + api.test.ts 改 mock
- [ ] AC-11 `pnpm -F miniprogram test` 全绿
- [ ] AC-12 `pnpm -F miniprogram build` 成功（typecheck 已含）

### AC 累计

- [ ] AC-13 后端 + minipgm 总增 **+33 用例**（api +22：rename 8 + nickname 8 + chat[N] 6；minipgm +11：citation-parser 6 + message-bubble +5；api.test.ts 改 mock 不增不减）
- [ ] AC-14 `pnpm -r typecheck` 全绿
- [ ] AC-15 `pnpm -r test` 全绿（**累计 187+** — 154 + 33）
- [ ] AC-16 `pnpm -F admin build` 成功
- [ ] AC-17 0 新增 secret / var / DB schema
- [ ] AC-18 docs/cp7-b-* + state-cp7-b.md + README 同步

---

## 12. Out of Scope

- CP-7 真接验证（user 操作；spec 阻塞点消除后由 user 跑）
- CP-7-C deploy 流程内化（独立项目）
- CP-7-D LLM model 跨 handler 一致性 smoke（独立项目）
- 富文本 scrollToCard / navigateTo（推到 CP-7-C/D）
- 实时多端 nickname 同步（无需；前端 onLaunch 拉一次即可）

---

## 13. References

- **CP-7-A spec / plan / state**（cloudCall 统一化，cloudCall 已支持 PATCH method）
- **CP-6 state**（api-router + HANDLER_MAP + DB layer 已就位）
- **CP-3 / M2 spec**（api-ask [N] 旧 JSON 块解析参考；chat 改用 inline `[N]`）
- **`apps/api/src/handlers/api-sessions-delete.ts`**（rename / nickname 模板）
- **`apps/api/src/handlers/api-ask.ts:45-58`**（citation parsing 参考 — 旧格式）
- **`apps/miniprogram/components/message-bubble/`**（当前 text bubble 模板）
- **`apps/miniprogram/components/citation-card/`**（citations 渲染参考）