# CP-7-B — handler 后端补全 + [N] 引用解析 + minipgm 富文本 收尾

**完成日期**：2026-06-18
**Spec**：`docs/superpowers/specs/2026-06-18-cp7-b-handler-citations-design.md`（commit `f10e7b6`，已批准 + amend）
**Plan**：`docs/superpowers/plans/2026-06-18-cp7-b-handler-citations.md`（commit `0308c95`）

---

## 1. 摘要

补齐 2 个缺失 handler（renameSession + updateNickname），api-chat 答案 `[N]` 内联标记解析（`citedNums` subset），minipgm message-bubble 富文本化（`[N]` 可点击）。**204 tests 全绿**（CP-7-A 后 154 + CP-7-B 净 +50：api +33 / minipgm +17）。

**核心成果**：

- **后端 2 新 handler**：
  - `api-sessions-rename.ts`：PATCH /api-sessions-rename?id={id} body={title} → 改 chatSession.title + updatedAt
  - `api-user-nickname.ts`：PATCH /api-user-nickname body={nickname} → 改 user.nickname（不动 wxOpenid/createdAt）
- **api-chat [N] 解析**：
  - `parseAnswerSegments(answer, topLength)` helper（export 出便于单测）
  - `citedNums: number[]` 字段（去重保 first；可含越界 debug）
  - `citations` 改 LLM 实际引用的子集（按 citedNums 顺序映射 topChunks）
- **minipgm 富文本**：
  - `lib/citation-parser.ts` 共享 helper（与后端 `parseAnswerSegments` 对称）
  - `message-bubble` 加 `segments` prop + `onCiteTap` → `wx.showToast(citations[n-1].title)`
  - wxml `wx:for` 渲染 text + cite-n
  - `.cite-num` 蓝色 + 浅蓝背景样式
- **顺手修 CP-7-A 遗留 bug**：`deleteSession` path param 风格与 handler query 不一致 → 真接 400；改 query 风格

**重要 caveat**：mock-first 实施；真实 CloudBase callFunction 协议 + api-router 兼容性需 CP-7 真接验证。

---

## 2. 资源清单

### 2.1 后端改动（2 新代码 + 1 改 handler + 1 改 index + 3 新测试）

| 文件 | 状态 | 行数变化 |
|---|---|---|
| `apps/api/src/handlers/api-sessions-rename.ts` | NEW | +65 行 |
| `apps/api/src/handlers/api-user-nickname.ts` | NEW | +57 行 |
| `apps/api/src/handlers/api-chat.ts` | UPDATE | 211 → 244 行（+parseAnswerSegments + citedNums + citations subset）|
| `apps/api/src/index.ts` | UPDATE | +2 import + 2 HANDLER_MAP 行 |
| `apps/api/test/handlers/api-sessions-rename.test.ts` | NEW | +177 行（12 用例）|
| `apps/api/test/handlers/api-user-nickname.test.ts` | NEW | +234 行（12 用例）|
| `apps/api/test/handlers/api-chat.test.ts` | NEW | +71 行（9 用例）|

### 2.2 minipgm 改动（1 新 helper + 1 改 caller + 3 改 component + 1 改 page + 3 改/新测试）

| 文件 | 状态 | 行数变化 |
|---|---|---|
| `apps/miniprogram/lib/citation-parser.ts` | NEW | +56 行 |
| `apps/miniprogram/lib/api.ts` | UPDATE | rename / nickname / delete 3 caller 改 path/query/method |
| `apps/miniprogram/components/message-bubble/message-bubble.ts` | UPDATE | +segments prop + onCiteTap method |
| `apps/miniprogram/components/message-bubble/message-bubble.wxml` | UPDATE | 富文本 segments wx:for 渲染 |
| `apps/miniprogram/components/message-bubble/message-bubble.wxss` | UPDATE | +.cite-num 样式 |
| `apps/miniprogram/pages/chat/chat.ts` | UPDATE | MessageItem +segments + parseAnswerSegments |
| `apps/miniprogram/pages/chat/chat.wxml` | UPDATE | message-bubble +segments prop |
| `apps/miniprogram/test/citation-parser.test.ts` | NEW | +91 行（11 用例）|
| `apps/miniprogram/test/message-bubble.test.ts` | NEW | +152 行（6 用例）|
| `apps/miniprogram/test/api.test.ts` | UPDATE | 3 caller mock 断言改 |

### 2.3 文档（3 新 + 2 改）

| 文件 | 状态 |
|---|---|
| `docs/cp7-b-citations-setup.md` | NEW（~165 行）|
| `docs/superpowers/specs/2026-06-18-cp7-b-handler-citations-design.md` | NEW（commit `f10e7b6`）|
| `docs/superpowers/plans/2026-06-18-cp7-b-handler-citations.md` | NEW（commit `0308c95`）|
| `README.md` | UPDATE（+CP-7-B 状态节）|
| `docs/superpowers/state-cp7-a.md` | UPDATE（§6.4 CP-7-B 标 ✅）|
| `docs/superpowers/state-cp7-b.md` | NEW（本文件）|

### 2.4 不改（沿用 CP-7-A / CP-6）

- ✅ `apps/admin/` — 0 改动（admin 仍走 HTTP gateway；不调 minipgm-only handler）
- ✅ `apps/crawler/` — 0 改动
- ✅ `packages/shared/` — 0 改动（解析逻辑各自在 api-chat.ts 和 citation-parser.ts）
- ✅ CloudBase api-router dispatch logic — 0 改动（仅 HANDLER_MAP 加 2 条目）
- ✅ `apps/api/src/lib/db.ts` / `lib/jwt.ts` / `lib/handler-utils.ts` — 0 改动

---

## 3. Secrets + Vars（无变化）

- 0 新增 secret
- 0 新增 var
- 0 移除 secret / var

CP-7-B 是纯前端 + 纯后端实现，不动 CloudBase env 配置。

---

## 4. 测试结果

### 4.1 累计测试矩阵

| 包 | CP-7-A 末 | CP-7-B | 累计 | 状态 |
|---|---|---|---|---|
| shared | 49 | 0 | 49 | 无变化 |
| api | 30 | +33 (rename 12 + nickname 12 + chat[N] 9) | **63** | ✅ |
| miniprogram | 32 | +17 (citation-parser 11 + message-bubble 6) | **49** | ✅ |
| admin | 24 | 0 | 24 | 无变化 |
| crawler | 19 | 0 | 19 | 无变化 |
| **累计** | **154** | **+50 净** | **204** | ✅ |

注：api 实际 +33（spec/plan 估 +22），因为 chat[N] 解析测试覆盖更细（9 用例 vs 估 6）；minipgm 实际 +17（plan 估 +11），因为 citation-parser 11 用例 + message-bubble 6 用例都全展开。

### 4.2 typecheck / build

- `pnpm -r typecheck` — 5 包全绿 ✅
- `pnpm -F admin build` — 成功（202.97 kB JS / 15.67 kB CSS）✅
- 无 lint 警告

---

## 5. 关键决策

### 5.1 实施时决策

| Decision | 选择 | 理由 |
|---|---|---|
| deleteSession 路径风格 | query `?id=` | 修 CP-7-A 遗留 bug；handler `getQuery(event, "id")` 期望 query |
| citedNums 包含越界数字 | 是 | 调试友好；前端按需过滤 |
| helper 是否过滤越界 | 不过滤 | caller (handler) 决定 subset；helper 单纯去重保序 |
| message-bubble cite 点击 | wx.showToast | 简单标红；scrollToCard 推 CP-7-C/D |
| 解析在前端 | 是 | answer 已存在 response 中；0 网络开销；message-bubble 纯展示 |
| updateNickname 不存在 | 404 | 不 upsert；wx-login 后必存在 |
| rename 改 title 外是否改 updatedAt | 改 | rename 是 user 行为；history 列表按 updatedAt 排序 |

### 5.2 与 spec/plan 的偏差

| 项 | Spec/Plan 估 | 实际 | 差异原因 |
|---|---|---|---|
| api-chat [N] 测试用例数 | 6 | 9 | helper 内部边界覆盖展开（happy / 全引 / 越界 / 重复 / 0 个 / 乱序 / 混合 / top=0 / 非数字）|
| citation-parser 测试用例数 | 6 | 11 | `extractCitedNums` 单独 4 用例 + parseAnswerSegments 7 用例 |
| message-bubble 测试用例数 | 5 | 6 | segments 默认值 + props 默认值分开 2 用例 |

总用例比 plan 多 +6（仍可控）。

---

## 6. 限制 / 教训 / 下一步

### 6.1 限制（mock-first 已知）

- **真实 wx.cloud.callFunction 协议未在 CI 跑**：mock-first；CP-7 真接阶段再验
- **真实 CloudBase api-router 兼容性未验**：server handler 端到端真接验证推 CP-7
- **admin 端不走新 handler**：admin 仍走 HTTP gateway；minipgm-only handler 对 admin 无影响

### 6.2 风险评估

| 风险 | 缓解 | 严重度 |
|---|---|---|
| LLM 输出格式不稳定（[N] vs JSON 块 vs 其他） | API-ASK 仍用旧 JSON 块解析（不影响 chat）；CP-7-D 可统一 | LOW |
| 越界数字未在 helper 过滤 | handler 内过滤；citedNums 包含越界供 debug | LOW |
| message-bubble 渲染性能（长答案 → 多 segments） | 答案通常 < 500 字，segments < 20 项 | LOW |
| PATCH method 在 api-router 验证 | handler 内 405 check；本地测试覆盖 | LOW |
| deleteSession 改 query 风格影响 CP-7 真接 | 真接前已修；AC-7a 覆盖 | LOW |

### 6.3 CP-7-B 教训（给后续 checkpoint）

1. **plan vs 实际代码差异**（plan §P-1~P-6）：写 plan 时才发现 cloud-call.ts 已存在、deleteSession path param 风格 bug、helper 边界。教训：写 plan 必读实际代码（CP-7-A 教训延续）。
2. **测试期望与实现细节不一致**：`parseAnswerSegments` 正则 split 行为（`[abc]` 不 split vs `[0]` split 后兜底）容易写错测试期望。教训：写完测试立即跑 RED → GREEN 验证期望正确。
3. **Component mock 模式**：`Component({...})` 是 wx 全局，vitest 需 mock globalThis。教训：minipgm component 测试统一模式（已在 citation-parser.ts 文档化）。
4. **worktree 不继承 untracked 文件**（CP-7-A lesson #4 延续）：admin CloudBaseCallTest.tsx 仍 untracked，跑全包测试前需 cp。教训：是否考虑 `git add -N` 让 untracked 暂存？或 worktree 加 `--recurse-submodules`？留作基础设施改进。
5. **mock 返回类型严格**：`getById<T>` 默认 `Record<string, unknown>`，mock 返值需 cast `as unknown as Awaited<ReturnType<typeof getById>>`。教训：mock helper 函数返回类型严格时，统一 cast helper。

### 6.4 下一步建议

1. **CP-7 真接验证**（user 操作）：
   - 微信开发者工具导入 apps/miniprogram（替换 AppID）
   - 编译 → onLaunch → 5 步真机验证
   - 验证：全 7 caller 走 callFunction + 401 refresh 行为 + inflight share + [N] 解析
2. **CP-7-C 候选**：deploy 流程内化 env vars push（`tcb fn deploy --force` 重置 vars 自动化）
3. **CP-7-D 候选**：LLM model 跨 handler 一致性 smoke（api-ask + api-chat 用统一 model name）+ 引用解析格式统一（chat 改用 [N] 还是 ask 改回 JSON 块？）

---

## 7. Commit 汇总

| # | Commit | 主题 |
|---|---|---|
| 1 | `f10e7b6` | docs: CP-7-B spec — handler 后端补全 + [N] 引用解析 + minipgm 富文本 |
| 2 | `0308c95` | docs: CP-7-B plan — handler 后端补全 + [N] 引用解析 + minipgm 富文本 |
| 3 | `aaf538a` | feat(api): CP-7-B — api-sessions-rename + api-user-nickname handlers + api-chat [N] 解析 |
| 4 | `fb486c6` | feat(miniprogram): CP-7-B — citation-parser + caller path/method 改 + message-bubble 富文本 |
| 5 | (待) | docs: CP-7-B — state + README + setup.md + state-cp7-a.md §6.4 |

**共 5 commit + 1 merge = 6 总**

---

## 8. CP-7 真接路径

CP-7-B 完成后，CP-7 真接验证能跑通全 7 caller（之前 rename + nickname 会 404）：

1. **miniprogram 真机验证**：
   - 替换 `apps/miniprogram/project.config.json` 的 appid（user 已注册）
   - 微信开发者工具导入 apps/miniprogram
   - 编译 → 验证 `wx.cloud.init ok`
   - onLaunch → ensureJwt → /api-auth-wx-login callFunction 成功
   - chat tab → /api-chat callFunction → 返 RAG 答案 + 解析后的 citations + segments
   - history tab → /api-sessions-list callFunction → 返 sessions
   - 长按 session → promptRename → /api-sessions-rename PATCH callFunction → 改 title + 列表刷新
   - 删除 session → /api-sessions-delete DELETE callFunction → 软删
   - nickname-input → /api-user-nickname PATCH callFunction → 改 nickname
2. **[N] 富文本验证**：
   - 答案含 [1] [2] → 渲染蓝色 [N] + click showToast 显示引用标题
   - 答案无 [N] → 空 citations + 纯文本显示
3. **401 refresh 行为验证**（CP-7-A 验证过的）：
   - 模拟 jwt 过期（清 storage）
   - 触发任意 caller → 401 → ensureJwt → retry → 200
   - 3 并发 401 → 1 次 ensureJwt（inflight share）
4. **ApiError 边界验证**：
   - 触发 404 / 500 → caller 收到 ApiError
   - 网络断 → ApiError(0, NETWORK_ERROR)

---

## 9. References

- **Spec**：`docs/superpowers/specs/2026-06-18-cp7-b-handler-citations-design.md`
- **Plan**：`docs/superpowers/plans/2026-06-18-cp7-b-handler-citations.md`
- **Setup 文档**：`docs/cp7-b-citations-setup.md`
- **README**：`README.md` §"CP-7-B 状态"
- **CP-7-A state**：`docs/superpowers/state-cp7-a.md`（cloudCall 统一化前置）
- **CP-6 state**：`docs/superpowers/state-cp6.md`（api-router + HANDLER_MAP 基础）