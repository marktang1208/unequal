# CP-7-B — handler 后端补全 + [N] 引用解析 + minipgm 富文本 收尾

**完成日期**：2026-06-18（CP-7-B merge）/ 2026-06-19（bug fix + 真接 prep 收尾）
**Spec**：`docs/superpowers/specs/2026-06-18-cp7-b-handler-citations-design.md`（commit `f10e7b6`，已批准 + amend）
**Plan**：`docs/superpowers/plans/2026-06-18-cp7-b-handler-citations.md`（commit `0308c95`）
**真接 prep 状态**：9 commit + 1 merge，CloudBase 端到端 smoke PASS（详见 §9）
**Tag**：`cp7-b-archived`

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
6. **🆕 真接 prep 发现 pre-existing CP-6 bug（最关键）**：
   - `api-sessions-list` 返 `s.id`（schema 字段，api-chat 显式 `session.id = newId()`）
   - `api-sessions-get` / `api-sessions-delete` / CP-7-B `api-sessions-rename` 用 `getById` 查的是 CloudBase `_id`
   - 两个是不同的 ULID → getById 总返 null → 404
   - **mock-first 测试隐藏了 bug**（CP-6 时代 sessions-get/delete 没单元测试；CP-7-B 我新写的 rename 测试 mock `getById` 返值时也用了错误 ID）
   - **真接 smoke 才暴露**：PATCH /api-sessions-rename 直接返 404
   - 教训：**写新 handler 复制旧 handler 模式时，必须验证 ID 字段语义**；**handler 缺单元测试 = bug 隐藏到真接**
   - 修复：3 handler 改 `whereQuery({id}, {limit:1})` 查 schema 字段；update/remove 用 `session._id`
7. **🆕 CloudBase deploy 行为变化（CLI 3.5.7）**：
   - `tcb fn deploy --all --force` **只更新函数代码**，env vars 不会被更新
   - 必须单独跑 `tcb config update fn <name>` 才能推 env vars
   - deploy:secrets.ts（CP-6 时代写）的 deploy 步骤只更新代码，不更新 config → smoke 显示 12 vars 注入成功但实际函数只有 7 vars
   - 修复：deploy:secrets.ts 需改为先 `tcb fn deploy --all --force` 再 `tcb config update fn --all`；CP-7-C 候选可顺手修
   - 教训：**deploy 工具的"成功"提示需验证实际行为**（deploy:secrets 当时是工作的，CLI 升级后变 silently broken）
8. **🆕 gateway URL 调用模式**：
   - 正确：`https://{envId}-{appid}.ap-shanghai.app.tcloudbase.com/{funcName}` + HTTP body = handler 期望的 JSON 直接传
   - 错误：HTTP body 套 wrapper `{"httpMethod":"POST", "body":"{...}", ...}` → gateway 不解析 wrapper，wrapper 当作 handler 的 body
   - 错误：`/api-router/{funcName}` 双层 → event.path 是 `/api-router/api-sessions-rename` 不会被 funcName 匹配
   - 教训：CloudBase HTTP trigger 文档明确但首次用容易混淆

### 6.4 下一步建议

1. **CP-7 真接验证**（user 操作）：
   - 微信开发者工具导入 apps/miniprogram（替换 AppID）
   - 编译 → onLaunch → 5+1 步真机验证
   - 验证：全 7 caller 走 callFunction + 401 refresh 行为 + inflight share + [N] 解析 + 修复后的 session CRUD
2. **CP-7 真接后补完**：
   - 真接 state 文档 `docs/superpowers/state-cp7-zhenjie.md`（参考 state-cp6 §8 格式）
   - `git tag cp7-zhenjie-archived master`
   - README "CP-7-B 限制" 改 "已真接验证 PASS"（待真接完成）
3. **CP-7-C 候选**：deploy 流程内化 env vars push（修 deploy:secrets.ts + deploy:clean.ts 适配 CLI 3.5.7 行为变化）
4. **CP-7-D 候选**：LLM model 跨 handler 一致性 smoke（api-ask + api-chat 用统一 model name）+ 引用解析格式统一（chat 改用 [N] 还是 ask 改回 JSON 块？）
5. **🆕 补 sessions-get / sessions-delete 单元测试**（防 CP-6 时代 bug 复发）：mock `whereQuery` 返 `[]` / `[{...session}]` 覆盖 404/200/403 三种

---

## 7. Commit 汇总

| # | Commit | 主题 |
|---|---|---|
| 1 | `f10e7b6` | docs: CP-7-B spec — handler 后端补全 + [N] 引用解析 + minipgm 富文本 |
| 2 | `0308c95` | docs: CP-7-B plan — handler 后端补全 + [N] 引用解析 + minipgm 富文本 |
| 3 | `aaf538a` | feat(api): CP-7-B — api-sessions-rename + api-user-nickname handlers + api-chat [N] 解析 |
| 4 | `fb486c6` | feat(miniprogram): CP-7-B — citation-parser + caller path/method 改 + message-bubble 富文本 |
| 5 | `2897bab` | docs: CP-7-B — state + README + setup.md + state-cp7-a.md §6.4 标完成 |
| 6 | `db843c0` | merge: CP-7-B → master |
| 7 | `34e1d95` | docs: CP-7 真接验证 checklist |
| 8 | `864610e` | fix: cloudbaserc.json envId → unequal-d4ggf7rwg82e0900b（CP-7 真接 prep） |
| 9 | `94968ed` | **fix(api): CP-7-B bugfix — sessions handlers 查 schema id 非 CloudBase _id** |

**共 9 commit + 1 merge = 10 总**

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

## 9. CP-7 真接 prep 收尾（2026-06-19 真接验证发现 + bug fix）

### 9.1 真接 prep 步骤执行记录

| # | 步骤 | 结果 |
|---|---|---|
| 1 | 修 `cloudbaserc.json` envId → `unequal-d4ggf7rwg82e0900b`（d8g4 已注销）| ✅ commit `864610e` |
| 2 | 重打 api-router bundle（含 CP-7-B 新 handler）| ✅ 327862 行（CP-6 时 327739，+123）|
| 3 | `tcb fn deploy api-router` 上传新代码 | ✅ Nodejs20.19 / 256MB / 30s / installDependency: true |
| 4 | 跑 `pnpm -F api deploy:secrets` 注入 4 secrets + IP allowlist | ⚠️ **silently 失败**：CLI 3.5.7 行为变化，`fn deploy --all --force` 只更新代码，不更新 env vars |
| 5 | 单独跑 `tcb config update fn api-router` 推 12 vars | ✅ 12 vars 注入成功 |
| 6 | smoke `/api-health` → 200 | ✅ |
| 7 | smoke `/api-auth-admin-login` → 200 + JWT | ✅ |
| 8 | smoke `/api-sessions-list` → 1 session | ✅ |
| 9 | smoke `/api-sessions-rename` (CP-7-B new) → **404 NOT_FOUND** | ❌ **发现 pre-existing CP-6 bug** |
| 10 | 修 3 sessions handler (`getById` → `whereQuery({id})`) + 1 test mock | ✅ commit `94968ed`，api 63/63 GREEN |
| 11 | 重打 bundle + deploy | ✅ |
| 12 | 单独推 smoke config (12 vars) | ✅ |
| 13 | 重跑 smoke：rename / delete / get (deleted) | ✅✅✅ |
| 14 | smoke `/api-user-nickname` (admin scope) → 404 (admin 不在 user collection) | ⚠️ 预期：user scope 真接会 work |

### 9.2 Bug 根因（pre-existing CP-6）

```ts
// api-sessions-list.ts
sessions.map((s) => ({ id: s.id, ... }))  // s.id = schema 字段（api-chat 显式 newId()）

// api-sessions-rename.ts (我 CP-7-B 写的) — 复制了 sessions-delete 的错误模式
const session = await getById<ChatSession>(COLLECTIONS.chatSession, id);  // 查 CloudBase _id
// id="01KVD..." 是 schema id（list 返的），不是 _id → getById 返 null → 404
```

`getById` 查的是 CloudBase `_id`（`add()` 函数自动生成的 ULID），而 list 返的 `id` 是 schema 字段（api-chat handler 显式 `session.id = newId()`）。**两个不同的 ULID**。

### 9.3 修复（commit `94968ed`）

3 handler 改 `whereQuery({id}, {limit:1})` 查 schema 字段；update/remove 用 `session._id`（CloudBase doc id）：

```ts
// 修复后（sessions-rename.ts）
const sessions = await whereQuery<ChatSession>(
  COLLECTIONS.chatSession,
  { id },                    // schema 字段
  { limit: 1 },
);
const session = sessions[0];
if (!session) return errorResponse("NOT_FOUND", ...);
if (session.userId !== userId) return errorResponse("FORBIDDEN", ...);
await update(COLLECTIONS.chatSession, session._id, { title, updatedAt: Date.now() });
```

### 9.4 真接 prep 工具链发现

#### gateway URL 正确模式
```bash
# ✅ 正确：HTTP body = handler 期望的 JSON 直接传
curl -X POST "${GATEWAY}/api-auth-admin-login" \
  -H 'Content-Type: application/json' \
  -d '{"token":"<ADMIN_TOKEN>"}'

# ❌ 错误：HTTP body 套 wrapper (CP-7 真接 checklist 早期版本误以为是这样)
curl -X POST "${GATEWAY}/api-router" \
  -d '{"httpMethod":"POST","path":"/api-auth-admin-login","body":"{\"token\":\"...\"}","headers":{},"queryString":{},"isBase64Encoded":false}'
# gateway 不解析 wrapper，wrapper 直接当 event.body，handler 解析后 body.token 是 undefined
```

#### deploy 两步走
```bash
# Step 1: 推代码
tcb fn deploy api-router -e unequal-d4ggf7rwg82e0900b
# Step 2: 推 env vars（deploy 不会自动推 config）
tcb --config-file cloudbaserc.smoke.json config update fn api-router -e unequal-d4ggf7rwg82e0900b
# Step 2 会出现 "Override update" prompt → Enter 选 Override
```

**deploy:secrets.ts bug**（commit `864610e` 同期发现但未修）：脚本用 `tcb fn deploy --all --force` 期望推 code + config，**实际只推 code**。需修脚本为 deploy + config update 两步。CP-7-C 候选可顺手修。

#### admin login 走 body 不是 header
```bash
# ✅ POST /api-auth-admin-login body: {token}
# ❌ 不是 Authorization: Bearer <token>（api-auth-wx-login 才是）
```

### 9.5 真接 prep 资源记录

| 资源 | 值 | 来源 |
|---|---|---|
| CloudBase env | `unequal-d4ggf7rwg82e0900b` | d4gg 个人版（state-cp6 §9.1）|
| CloudBase appid (URL) | `1444590671` | 数字 ID，URL 必填 |
| CloudBase region | `ap-shanghai` | |
| Gateway URL | `https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com` | |
| Mini-program AppID | `wxf5b8ce05a977f0c6` | 微信真实 AppID |
| Mini-program cloudEnvId | `unequal-d4ggf7rwg82e0900b` | app.ts globalData |
| Mini-program apiBaseUrl | `https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com` | app.ts globalData |
| Mini-project | `apps/miniprogram` | 微信开发者工具导入路径 |
| 9 CloudBase collections | source / document / chunk / query_cache / chat_session / user / user_session_key / login_attempt / crawl_job | state-cp6 已建 |
| 4 secrets | ADMIN_TOKEN / JWT_SECRET / MINIMAX_API_KEY / KEK_SECRET_V1 | deploy:secrets 注入 |
| 8 env vars | ALLOWED_ORIGIN / DEFAULT_USER_ID / ENVIRONMENT / KEK_CURRENT_VERSION / LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS / MINIMAX_BASE_URL / ADMIN_IP_ALLOWLIST | cloudbaserc.smoke.json 注入 |
| Smoke test admin token | `***REMOVED***` | dev sentinel（state-cp6 §4）|

### 9.6 真接 prep 后端 smoke 全绿

| 端点 | HTTP | 验证结果 |
|---|---|---|
| GET /api-health | 200 | `{"ok":true,"environment":"production"}` |
| POST /api-auth-admin-login | 200 | `{jwt, user_id:"01H0000...", is_admin:true, expires_in:86400}` |
| GET /api-sessions-list | 200 | 1 session: `01KVD0N4KZZ3DQTYDXAPFBY9EH` title="宝宝不爱吃饭怎么办" |
| PATCH /api-sessions-rename?id=... | 200 | `{ok:true, id, title:"CP-7-B smoke test"}` ✅ **bug fix verified** |
| DELETE /api-sessions-delete?id=... | 200 | `{ok:true, id}` ✅ **bug fix verified** |
| GET /api-sessions-get?id=... (deleted) | 404 | `{error:"NOT_FOUND", message:"Session ... not found"}` ✅ |
| PATCH /api-user-nickname (admin) | 404 | `{error:"NOT_FOUND", message:"User ... not found"}` ⚠️ 预期：admin 不在 user collection |

### 9.7 真实微信端 5+1 步（user 操作）— 待 user 真接

按 `docs/superpowers/cp7-zhenjie-checklist.md` §C / §D 跑。

预估工时：30-60 min（首次部署 + 真机扫码 + 5+1 步验证）。

---

## 10. References

- **Spec**：`docs/superpowers/specs/2026-06-18-cp7-b-handler-citations-design.md`
- **Plan**：`docs/superpowers/plans/2026-06-18-cp7-b-handler-citations.md`
- **Setup 文档**：`docs/cp7-b-citations-setup.md`
- **README**：`README.md` §"CP-7-B 状态"
- **CP-7-A state**：`docs/superpowers/state-cp7-a.md`（cloudCall 统一化前置）
- **CP-6 state**：`docs/superpowers/state-cp6.md`（api-router + HANDLER_MAP 基础）