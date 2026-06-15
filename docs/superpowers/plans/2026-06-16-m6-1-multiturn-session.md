# Plan: M6.1 多轮会话 + Durable Objects

- **Spec**：`docs/superpowers/specs/2026-06-16-m6-1-multiturn-session-design.md`
- **日期**：2026-06-16
- **复杂度**：Large（架构扩展 + 5 包协同）
- **Mock-first 边界**：M6.1 沿用 M0-M5 模式（无真 Cloudflare / 无真 wx.login）。DO 用 miniflare 真 stub 在 integration 测；单元测 `vi.mock('cloudflare:durable-objects')`。

---

## 1. Requirements Restatement

把「单轮问答 + admin 全局共享」升级到「多 session 独立 + DO 持久化 + D1 session 列表 + 小程序双 tab + admin 多 session ChatSim」。

**核心交付**：
- D1 `chat_session` 表（migration 0004）
- Durable Object `ChatSessionDO`（一个 session 一个 instance，state.storage 兜底）
- 4 个新 API 端点：`/chat` / `GET /sessions` / `PATCH /sessions/:id` / `DELETE /sessions/:id`
- `verifyAuth()` 抽象（M6.1 阶段只支持 `admin_token` 模式，jwt 模式返 501）
- 多轮上下文拼接：3 轮 × 50 字 LLM 摘要
- 小程序双 Tab：「对话」+「历史」
- admin ChatSim 升级：多 session 切换 + 重命名
- 52 新 vitest 用例

**不交付**（推到 M6.2）：wx.login / JWT / admin 登录 / session 软删回收站 / session 自动归档 cron / 单 session 限速。

---

## 2. Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| Migration | `apps/api/migrations/0001_init.sql` / `0003_query_cache.sql` | `CREATE TABLE IF NOT EXISTS` + 索引命名 `chat_session_user_active_idx`；M6.1 用 `0004_chat_session.sql` |
| Auth | `apps/api/src/lib/auth.ts:3` | `verifyAdminToken(header, expected)`；M6.1 在外层加 `verifyAuth(req, env)` 包装 |
| Route | `apps/api/src/routes/ask.ts:45` | `{ async POST(req, env): Response }` 对象；先验 token → 解析 body → 调 lib → Response.json |
| Lib test hooks | `apps/api/src/lib/ask.ts:14-21` | `RunAskOptions { q, env, fetchImpl?, searchFn?, cacheRead?, cacheWrite? }`；M6.1 `RunChatOptions` 同样模式 |
| LLM mock | `apps/api/src/routes/ask.ts:52-71` | dev env + sentinel token + `mock:` 前缀三连击；M6.1 chat 复用同一组 fixture |
| D1 access | `apps/api/src/lib/ask.ts:154-175` | `env.DB.prepare(sql).bind(...).all()`；in-memory mock 用 `better-sqlite3` |
| miniprogram page | `apps/miniprogram/pages/chat/chat.ts` + `apps/miniprogram/lib/api.ts` | 已有 chat 页 + api.ts；M6.1 改 chat 页持 session_id + 加 history 页 |
| admin ChatSim | `apps/admin/src/pages/ChatSim.tsx:15-44` | useState + `ask()` + 消息列表；M6.1 升级为多 session state |
| wrangler config | `apps/api/wrangler.jsonc:1-37` | vars + D1 + Vectorize + R2；M6.1 加 `durable_objects` + `migrations`（DO 入口 class 部署） |
| Vitest setup | `apps/api/vitest.config.ts` | miniflare 跑 D1 / Vectorize / R2 binding；M6.1 加 DO binding |
| Test injection | `apps/api/src/routes/ask.ts:91-113` | `__hits` / `__cacheHit` / `__noCache` test-only body 字段；M6.1 chat 同样 |
| ULID | 现有 user.id / source.id / document.id 风格 | `ulid()` npm 包（2KB）；M6.1 session_id 同 |

---

## 3. Files to Change

| File | Action | Why |
|---|---|---|
| `apps/api/migrations/0004_chat_session.sql` | CREATE | 新表 chat_session |
| `apps/api/migrations/0004_chat_session.down.sql` | CREATE | down：DROP TABLE |
| `packages/shared/src/multiturn.ts` | CREATE | buildMultiturnPrefix + groupIntoRounds + ChatMessage 类型 |
| `packages/shared/src/chat-types.ts` | CREATE | ChatSessionRow / ChatSessionDTO / ChatRequest / ChatResponse 类型 |
| `packages/shared/src/index.ts` | UPDATE | 导出 multiturn + chat-types |
| `packages/shared/package.json` | UPDATE | 添 `ulid` dep |
| `packages/shared/test/multiturn.test.ts` | CREATE | 12 用例：拼接 / 截断 / fallback / round 分组 |
| `apps/api/src/do/chat-session.ts` | CREATE | Durable Object class |
| `apps/api/src/lib/do-client.ts` | CREATE | getSessionMessages / appendMessage / resetSession 包装 stub |
| `apps/api/src/lib/auth.ts` | UPDATE | 加 `verifyAuth(req, env)` 包装 |
| `apps/api/src/lib/chat.ts` | CREATE | runChat 核心：拼 context + 调 RAG + 写回 DO + D1 列表维护 |
| `apps/api/src/lib/sessions.ts` | CREATE | listSessions / renameSession / deleteSession |
| `apps/api/src/routes/chat.ts` | CREATE | POST /chat route |
| `apps/api/src/routes/sessions.ts` | CREATE | GET/PATCH/DELETE /sessions route |
| `apps/api/src/index.ts` | UPDATE | 挂载 /chat + /sessions + /sessions/:id |
| `apps/api/wrangler.jsonc` | UPDATE | 加 durable_objects + migrations（ChatSessionDO class） |
| `apps/api/test/lib/chat.test.ts` | CREATE | 14 用例：拼 context / 调 RAG / 写回 / 错误 |
| `apps/api/test/lib/sessions.test.ts` | CREATE | 10 用例：list / patch / delete / 限额 / 过期 |
| `apps/api/test/lib/do-client.test.ts` | CREATE | 4 用例：stub mock 调 |
| `apps/api/test/routes/chat.test.ts` | CREATE | 4 用例：HTTP 路径 / 鉴权 / 错误码 |
| `apps/api/test/routes/sessions.test.ts` | CREATE | 4 用例：HTTP 路径 |
| `apps/api/test/integration/chat-flow.test.ts` | CREATE | 4 端到端用例（miniflare 真 DO） |
| `apps/api/test/helpers/d1.ts` | UPDATE | 添 chat_session 表到 in-memory mock schema |
| `apps/api/test/helpers/do.ts` | CREATE | miniflare DO stub 工厂（用 `getMiniflare().getDurableObjectStorage`） |
| `apps/miniprogram/lib/api.ts` | UPDATE | 加 `chat()` + `listSessions()` + `renameSession()` + `deleteSession()` + types |
| `apps/miniprogram/lib/chat-storage.ts` | CREATE | 持久化当前 session_id（wx.setStorageSync） |
| `apps/miniprogram/pages/chat/chat.ts` | UPDATE | 持 session_id 状态 + 调 /chat |
| `apps/miniprogram/pages/history/history.ts` | UPDATE | 拉 /sessions 列表 + 切换 / 重命名 / 删除 |
| `apps/miniprogram/app.json` | UPDATE | 加 chat / history tabBar |
| `apps/miniprogram/test/api.test.ts` | UPDATE | 加 4 /chat 用例（mock 返） |
| `apps/admin/src/lib/api.ts` | UPDATE | 加 `chat()` / `listSessions()` / `renameSession()` / `deleteSession()` |
| `apps/admin/src/pages/ChatSim.tsx` | UPDATE | 多 session state：当前 session + 列表 + 切换 + 重命名 + 删除 |
| `apps/admin/src/pages/ChatSim.test.tsx` | CREATE | 4 jsdom 用例：session 切换 / 重命名 UI / 删除 |
| `docs/wechat-miniprogram-setup.md` | UPDATE | 加 M6.1 双 tab 说明 |
| `README.md` | UPDATE | 加 M6.1 状态节（仿 M2-M5 state 节） |
| `docs/superpowers/state-m6-1.md` | CREATE | M6.1 实施收尾归档（仿 state-m5.md） |

---

## 4. Tasks (15 task / 4 checkpoint)

### Phase 1 — shared 库 + migration（CP-1）

**Task 1: Migration 0004 chat_session**
- Action: 写 `apps/api/migrations/0004_chat_session.sql` + `.down.sql`（按 migration 0001 风格：CREATE TABLE + INDEX）
- Mirror: `apps/api/migrations/0001_init.sql:1-7`
- Validate: `pnpm -F api exec wrangler d1 migrations list 0004_chat_session` 模拟运行 OK（无 D1 binding 不报错为「skipped」）

**Task 2: shared multiturn + chat-types + 12 用例**
- Action: 写 `packages/shared/src/multiturn.ts`（buildMultiturnPrefix + groupIntoRounds + summarize）+ `chat-types.ts`（ChatMessage / ChatSessionRow / ChatRequest / ChatResponse）+ 12 vitest 用例
- Mirror: `apps/api/src/lib/ask.ts:14-21` 类型 + `packages/shared/src/prompt.ts` zod 风格
- Validate: `pnpm -F shared test` — 12 新用例全绿

### Phase 2 — Durable Object + DO client（CP-1）

**Task 3: ChatSessionDO**
- Action: 写 `apps/api/src/do/chat-session.ts`：class implements DurableObject，`state.blockConcurrencyWhile` 启动时 load messages，`/append` `/list` `/reset` 三 endpoint
- Mirror: Cloudflare DOs 官方模板
- Validate: `pnpm -F api typecheck` 绿

**Task 4: do-client 包装 + 4 mock 单测**
- Action: 写 `apps/api/src/lib/do-client.ts`（getSessionMessages / appendMessage / resetSession）+ 4 vitest 用例（`vi.mock('cloudflare:durable-objects')`）
- Mirror: `apps/api/src/lib/cache.ts:1-30` 简单 async 包装风格
- Validate: `pnpm -F api test lib/do-client.test.ts` — 4 用例全绿

### Phase 3 — /chat endpoint（CP-2）

**Task 5: auth.ts 加 verifyAuth**
- Action: 在 `apps/api/src/lib/auth.ts` 加 `verifyAuth(req, env)`，M6.1 实现 `admin_token` 分支，`jwt` 分支返 501
- Mirror: `apps/api/src/lib/auth.ts:3-11` 现有 verifyAdminToken
- Validate: `pnpm -F api typecheck`

**Task 6: lib/chat.ts runChat**
- Action: 写 `apps/api/src/lib/chat.ts`：复用 `runAsk` 核心 RAG + 拼 context prefix + DO 写回 + D1 chat_session 维护 + LLM 标题生成
- Mirror: `apps/api/src/lib/ask.ts:32-143` 整体结构
- Validate: `pnpm -F api test lib/chat.test.ts` — 14 用例全绿（拼 context 4 + 调 RAG 2 + 写回 2 + 限额 2 + 错误 4）

**Task 7: routes/chat.ts + 挂载**
- Action: 写 `apps/api/src/routes/chat.ts`（按 ask.ts 模式）+ `index.ts` 挂 `POST /chat` + `wrangler.jsonc` 加 durable_objects binding
- Mirror: `apps/api/src/routes/ask.ts:45-126` 完整 route 模式
- Validate: `pnpm -F api test routes/chat.test.ts` — 4 用例全绿 + typecheck

**Task 8: wrangler.jsonc DO 配置**
- Action: 加 `durable_objects` 数组（`SESSION_DO` binding + `class_name: "ChatSessionDO"`）+ `migrations` 数组（tag `v1` + new_sqlite_classes）
- Mirror: `apps/api/wrangler.jsonc:11-19` 现有 d1 / vectorize 配置
- Validate: `pnpm -F api exec wrangler types`（或手动 typecheck）无报错

### Phase 4 — /sessions CRUD（CP-2）

**Task 9: lib/sessions.ts + 3 routes + 10 用例**
- Action: 写 `apps/api/src/lib/sessions.ts`（listSessions / renameSession / deleteSession + 限额 / 过期判定）+ `apps/api/src/routes/sessions.ts`（GET / PATCH /:id / DELETE /:id）+ `index.ts` 挂载 + 10 vitest 用例
- Mirror: `apps/api/src/lib/ask.ts:154-175` D1 query 风格
- Validate: `pnpm -F api test lib/sessions.test.ts routes/sessions.test.ts` — 10+4=14 用例全绿

### Phase 5 — admin ChatSim 升级（CP-2）

**Task 10: admin api.ts 扩 4 函数 + ChatSim 升级**
- Action: `apps/admin/src/lib/api.ts` 加 `chat()` / `listSessions()` / `renameSession()` / `deleteSession()` + `ChatSim.tsx` 升级：当前 session state + session 列表 + 切换 + 重命名 input + 删除 button
- Mirror: `apps/admin/src/lib/api.ts` 现有 ask() + `apps/admin/src/pages/ChatSim.tsx:15-44` 状态管理
- Validate: `pnpm -F admin test ChatSim.test.tsx` — 4 jsdom 用例全绿 + `pnpm -F admin build` 成功

**Task 11: admin dev 真验**
- Action: `pnpm -F admin dev` + curl `POST /chat` mock 数据 + 浏览器开 `/chat-sim` 真切 session + 重命名 + 删除（M3-realdeploy 教训应用）
- Mirror: state-m5.md §dev verification
- Validate: dev server 4 endpoints 返 200（chat / sessions / sessions/:id GET PATCH DELETE）

### Phase 6 — 小程序双 tab（CP-3）

**Task 12: miniprogram api.ts 扩 + chat-storage**
- Action: `apps/miniprogram/lib/api.ts` 加 `chat()` / `listSessions()` / `renameSession()` / `deleteSession()` + types + `chat-storage.ts`（wx.setStorageSync 持久 session_id）+ `api.test.ts` 加 4 mock 用例
- Mirror: `apps/miniprogram/lib/api.ts` 现有 ask()
- Validate: `pnpm -F miniprogram test` — 4 新用例全绿 + typecheck

**Task 13: miniprogram 双 tab UI**
- Action: 改 `pages/chat/chat.ts` 持 session_id state + 调 /chat + 失败降级到「mock:」前缀；改 `pages/history/history.ts` 拉 /sessions 列表 + 切换 + 重命名弹窗 + 删除确认；改 `app.json` 加 tabBar
- Mirror: 现有 `pages/chat/chat.ts` 风格 + tabBar 微信文档
- Validate: `pnpm -F miniprogram dev` 真走新建 → 多轮 → 切 session（mock-first dev 模式）

### Phase 7 — 收尾（CP-3 + CP-4）

**Task 14: integration test + 全 typecheck + build**
- Action: 写 `apps/api/test/integration/chat-flow.test.ts`（4 端到端用例：miniflare 真 DO + 真 D1 + mock LLM） + 跑全 typecheck + 全 build + 累计 125 用例（M0-M5 = 73 + M6.1 = 52）
- Mirror: `apps/api/test/integration.test.ts`（已存在）
- Validate: `pnpm -r typecheck` + `pnpm -F api test` + `pnpm -F admin build` + `pnpm -F miniprogram build` + integration 4 用例全绿

**Task 15: 文档 + state 收尾**
- Action: 写 `docs/superpowers/state-m6-1.md`（仿 state-m5.md：mock-first 边界 + CP pass 表 + 与 spec 偏差 + commit 汇总 + 测试矩阵 + ECC 组件 + 真接 Cloudflare 路径）+ 更新 `README.md` + 更新 `docs/wechat-miniprogram-setup.md`
- Mirror: `docs/superpowers/state-m5.md` 整体结构
- Validate: state-m6-1.md commit + README diff

### Checkpoint 总结

| CP | Tasks | Pass 标准 |
|---|---|---|
| CP-1 | 1-4 | shared 12 + do-client 4 = 16 用例 + typecheck |
| CP-2 | 5-11 | chat 14 + sessions 14 + ChatSim 4 = 32 用例 + admin dev 验 |
| CP-3 | 12-14 | miniprogram 4 + integration 4 = 8 用例 + 全 typecheck + build |
| CP-4 | 15 | 收尾文档 + 累计 125 用例全绿 |

---

## 5. Validation

```bash
# 全 typecheck
pnpm -r typecheck

# 全测试
pnpm -F shared test          # 26 + 12 = 38
pnpm -F api test              # 20 + 52 = 72
pnpm -F miniprogram test      # 4 + 4 = 8
pnpm -F crawler test          # 19 (无变化)
pnpm -F admin test            # 4 + 4 = 8
# 累计：M0-M5 73 + M6.1 52 = 125 用例

# 全 build
pnpm -F admin build
pnpm -F miniprogram build
# apps/api 无 build（M0-M1 沿用 wrangler dev）

# dev verification（M3-realdeploy 教训）
pnpm -F api dev               # miniflare 真 DO
curl -X POST http://localhost:8787/chat \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"q":"5个月宝宝发烧38.5怎么办？"}'
# 预期：200 + session_id 返

pnpm -F admin dev             # 浏览器开 /chat-sim
# 真走：新建 session → 多轮 → 切换 → 重命名 → 删除

pnpm -F miniprogram dev       # 微信开发者工具真走双 tab
```

---

## 6. Risks

| 风险 | Likelihood | Mitigation |
|---|---|---|
| Durable Object 启动慢影响 /chat 延迟 | LOW | DO 全球唯一 instance 延迟 < 10ms；miniflare 本地测 ≤ 50ms |
| DO state.storage 体积随 message 增长 | MEDIUM | 50 / session 截断 + 200 标记 archived（spec §4.3） |
| `vi.mock('cloudflare:durable-objects')` 在 vitest 不稳 | MEDIUM | Task 4 验证失败 → 改用 `vi.mock('../src/do/chat-session.js')` 单测 DO class 本身，集成测走 miniflare |
| 50 个 session D1 单 user 索引够用 | LOW | `chat_session_user_active_idx (user_id, last_active_at DESC)`；user 数 < 100 时 < 1ms |
| LLM 标题生成首问多耗一次 | LOW | 失败 fallback 空 title；M6.2 优化为异步批生成 |
| 限额超 50 用户被挡 409 | LOW | 错误码 + 引导删会话；不主动提醒 |
| 旧 /ask 路由被 /chat 替换 / 共存 | LOW | 共存（M6.1 spec §1.2）：/ask 单轮 + /chat 多轮；v2 决定 |
| miniflare 测 DO binding 配置复杂 | MEDIUM | Task 14 留 1 天 buffer；失败回退到 `wrangler dev` 手动验 |
| 微信小程序 tabBar 加后样式影响 | LOW | 复用现有 chat / source-detail / history（M3 已加 history） |

---

## 7. Acceptance

- [ ] migration 0004 写好 + down 写好
- [ ] 15 task 全部 commit（m6-1-multiturn-session 分支）
- [ ] CP-1/2/3/4 全部 pass
- [ ] 125 用例全绿（73 M0-M5 + 52 M6.1）
- [ ] `pnpm -r typecheck` 全绿
- [ ] `pnpm -F admin build` + `pnpm -F miniprogram build` 成功
- [ ] admin dev 验真：`/chat-sim` 走完新建 → 多轮 → 切 → 重命名 → 删除
- [ ] miniprogram dev 验真：双 tab 走完新建 → 多轮 → 切
- [ ] wrangler.jsonc 加 durable_objects 不破坏现有 `wrangler dev`
- [ ] M6.1 spec §7.1 三个切换点（verifyAuth / AUTH_MODE / getToken）留好接口
- [ ] state-m6-1.md commit
- [ ] README 加 M6.1 状态节
- [ ] no `console.log` 留在生产代码
- [ ] 没有 hardcoded secrets
- [ ] 合并 master 后 worktree 清理

---

## 8. ECC 组件使用（M6.1 计划）

| 组件 | 用途 |
|---|---|
| `superpowers:brainstorming` | 10 轮澄清 + 1 visual companion UI 选项 + 7 节设计展示 |
| `superpowers:writing-plans`（屏蔽）→ ECC `plan` | 本 plan 文档 |
| ECC `subagent-driven-development` | 15 task × (implementer + combined reviewer) 派发（M5 模式） |
| `superpowers:using-git-worktrees` | `.claude/worktrees/m6-1-multiturn-session` |
| `superpowers:verification-before-completion` | CP-1/2/3/4 验证 |
| `superpowers:finishing-a-development-branch` | merge to master + 清理 worktree + 删分支 |
| `superpowers:systematic-debugging` | 失败时启用（DO 测不稳 / LLM mock 不匹配） |
| `code-review` / react-review / typescript-review | Task 7 / 9 / 10 / 13 改 API + UI 触发 |
| `cloudflare` / `durable-objects` / `workers-best-practices` | Task 3 / 4 / 8 DO 集成 + wrangler config 触发 |

未触发：`marketing-campaign` / `frontend-design` / `mcp-builder`（无视觉设计 / 无 mcp / 无营销）。

---

## 9. 实施流程（参考 M5 实际模式）

1. 建 worktree：`git worktree add .claude/worktrees/m6-1-multiturn-session -b m6-1-multiturn-session`
2. 切 worktree 工作
3. 派 9 个实施 task（Phase 1-2 = task 1-4 / Phase 3-4 = task 5-9 / Phase 5-6 = task 10-13 / Phase 7 = task 14-15）
4. 每个 task = (implementer subagent + combined reviewer subagent)
5. CP-1 → CP-2 → CP-3 → CP-4 验证
6. merge to master (no-ff) + 清理 worktree + 删分支
7. 写 state-m6-1.md 收尾

预计 3-4 天工作量（按 M5 = 12 task / 73 用例 1.5 天估算）。

---

## 10. M6.2 衔接（不实施，仅 spec 留接口）

M6.1 → M6.2 不需要重构：
- 路由层不动
- `verifyAuth()` 唯一鉴权入口
- `getToken()` 唯一小程序端 token 入口
- `AUTH_MODE` wrangler var 唯一切换

M6.2 spec 范围：
- wx.login + jscode2session 真接（或 mock-first 留双模式）
- /auth/wx-login 端点
- JWT 签发 / 验证 / 刷新（jose 库，HS256，24h）
- 小程序 token 持久化
- admin 登录页
