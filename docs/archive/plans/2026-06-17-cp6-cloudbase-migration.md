# Plan: CP-6 — CloudBase 全量迁移

- **Spec**：`docs/superpowers/specs/2026-06-17-cp6-cloudbase-migration-design.md`（commit `0301f7a`）
- **日期**：2026-06-17
- **复杂度**：**Large**（apps/api 全重写 + 13 handlers + 9 collections + 数据模型重构；用户预估 1-2 周）
- **执行模式**：主线程直接做（不适合派 subagent — CloudBase SDK 是新栈，无 background knowledge 可借鉴；context 集中反而有利）

> **不是部署 spec** — 是迁移 spec。结构借鉴 CP-5 plan 但侧重点不同（代码重构 + 数据迁移，不是 wrangler 命令）。

---

## 1. Requirements Restatement

把 apps/api 全量从 CF Workers 迁到微信云开发 CloudBase，让 miniprogram 用户（国内家长）能可达到。封存 v0 CF 部署（保留不销毁，作为 fallback）。

**核心交付**：

| # | 包 | 内容 |
|---|---|---|
| 1 | `apps/api/` | 全重写为 CloudBase 云函数（Node.js + `@cloudbase/node-sdk`）|
| 2 | `apps/api/src/handlers/` | 13 个 handler 文件（`api-*.ts`） |
| 3 | `apps/api/src/lib/db.ts` | CloudBase DB helpers（collection access + 通用 query）|
| 4 | `apps/api/src/lib/storage.ts` | CloudBase 云存储 helpers |
| 5 | `apps/api/src/lib/env.ts` | env 加载 + 启动时硬验证（embedding dim + KEK）|
| 6 | `apps/api/src/lib/admin-ip-allowlist.ts` | M6.10 代码迁移（string equality，0 逻辑改动）|
| 7 | `packages/shared/src/types.ts` | 重写（CloudBase 文档类型 + 简化 Env）|
| 8 | `packages/shared/src/retrieval.ts` | 重写（brute-force cosine + CloudBase DB fetch）|
| 9 | `apps/miniprogram/app.ts:7` | 单行 apiBaseUrl 改 CloudBase URL |
| 10 | `apps/admin/.env.production` | 配 `VITE_API_BASE_URL=CloudBase URL` |
| 11 | `docs/superpowers/state-cp5.md` | 加 "封存归档" 附录（spec 附录 A）|
| 12 | `README.md` | 加 v1 段 + v0 封存段 |
| 13 | git tag | `v0-cf-archived` at `f623f66` |
| 14 | `docs/superpowers/state-cp6.md` | cp-6 收尾文档 |

**不交付**（spec §10 YAGNI）：
- mini-program 真机验证（cp-7）
- ANN 向量索引
- CloudBase 事务回滚
- 外部 APM
- KEK 轮换
- 本地 vector DB 同步架构（[[project-future-local_vector_db_sync]] 备未来）
- v0 数据迁移（无数据）

**新增测试**：handlers 集成测试（mock SDK）；具体数量 Phase 1 后定。

---

## 2. Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| Handler 结构 | `apps/api/src/routes/*.ts`（v0 CF handlers） | handler 接 request → 业务逻辑 → 返 JSON；trace + status code |
| Env 加载 | `apps/api/src/types.ts:1-35` Env interface（v0） | 重写：CloudBase 控制台 env → process.env + 硬验证 |
| Admin IP allowlist | `apps/api/src/lib/admin-ip-allowlist.ts` | M6.10 代码直接复制，**0 逻辑改动**（string equality）|
| Rate limit | `apps/api/src/lib/rate-limit.ts` | 同 admin-ip-allowlist 策略：直接复制，env 读取改 process.env |
| Embedder 接口 | `packages/shared/src/embedding.ts:1-50` | `createMiniMaxEmbedder()` 接口保持不变 |
| Chunking | `packages/shared/src/chunking.ts` | 0 改动（纯函数，平台无关）|
| 测试结构 | `apps/api/test/` vitest | 沿用 vitest，集成测试用 SDK mock（替代 Miniflare）|

---

## 3. Files to Change

### 3.1 新建（多）

| 文件 | 内容 | 预估行数 |
|---|---|---|
| `apps/api/src/handlers/api-ask.ts` | RAG 问答 handler | ~80 |
| `apps/api/src/handlers/api-upload.ts` | 文件上传 handler | ~120 |
| `apps/api/src/handlers/api-ingest.ts` | 爬虫回写 handler | ~80 |
| `apps/api/src/handlers/api-search.ts` | 向量检索 handler | ~60 |
| `apps/api/src/handlers/api-chat.ts` | 多轮会话 handler | ~100 |
| `apps/api/src/handlers/api-sessions-list.ts` | 列出会话 | ~30 |
| `apps/api/src/handlers/api-sessions-get.ts` | 读单会话 | ~40 |
| `apps/api/src/handlers/api-sessions-delete.ts` | 删会话 | ~30 |
| `apps/api/src/handlers/api-stats.ts` | admin 统计 | ~50 |
| `apps/api/src/handlers/api-auth-wx-login.ts` | wx.cloud.callFunction 登录 | ~50 |
| `apps/api/src/handlers/api-auth-admin-login.ts` | admin HTTP 登录 | ~80 |
| `apps/api/src/handlers/api-cron-cleanup.ts` | 定时清理 login_attempt | ~50 |
| `apps/api/src/handlers/api-health.ts` | 存活检查 | ~20 |
| `apps/api/src/lib/db.ts` | CloudBase DB helpers（get/add/update/where）| ~100 |
| `apps/api/src/lib/storage.ts` | CloudBase 云存储 helpers（uploadFile, getTempFileURL）| ~60 |
| `apps/api/src/lib/env.ts` | env 加载 + 启动时硬验证 | ~80 |
| `apps/api/src/lib/cloudbase.ts` | `@cloudbase/node-sdk` init 单例 | ~30 |
| `apps/api/src/lib/handler-utils.ts` | HTTP trigger 通用工具（parse body, parse query, JSON response）| ~80 |
| `apps/api/src/lib/admin-ip-allowlist.ts` | M6.10 代码迁移（env 改 process.env） | ~25 |
| `apps/api/test/handlers/api-auth-admin-login.test.ts` | admin login handler 测试 | ~60 |
| `apps/api/test/handlers/api-upload.test.ts` | upload handler 测试（mock SDK） | ~80 |
| `apps/api/test/handlers/api-search.test.ts` | search handler 测试 | ~50 |
| `apps/api/test/lib/retrieval.test.ts` | retrieval.ts brute-force cosine 测试 | ~80 |

### 3.2 修改（重写）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `packages/shared/src/types.ts` | 重写：CloudBase 文档类型 + 简化 Env | ~120 |
| `packages/shared/src/retrieval.ts` | 重写：brute-force cosine + CloudBase DB | ~100 |
| `apps/api/src/index.ts` | 重写：HTTP trigger 入口分发 | ~50 |
| `apps/miniprogram/app.ts:7` | 单行 apiBaseUrl 改 CloudBase URL | +1 / -1 |
| `apps/admin/.env.production` | 加 `VITE_API_BASE_URL` | +1 |
| `README.md` | 加 v1 段 + v0 封存段 | +60 / -0 |

### 3.3 删除（v0 CF 残留）

| 文件 | 原因 |
|---|---|
| `apps/api/wrangler.jsonc` | 不再用 CF，删（git 历史保留） |
| `apps/api/migrations/*.sql` | 不再用 D1，删（git 历史保留） |
| `apps/api/src/lib/minimax.ts` | v0 用 MiniMax base URL 调用；v1 改用 shared embedding 模块 |
| `apps/api/test/integration.test.ts` | Miniflare-based，v1 不适用；删 |

### 3.4 不改

- ✅ `apps/admin/src/`（admin UI 代码不动，仅 env 配置）
- ✅ `apps/miniprogram/pages/`（小程序 UI 代码不动）
- ✅ `apps/crawler/src/`（crawler 代码 0 改动，仅 env 配置 URL + token）
- ✅ `packages/shared/src/chunking.ts`（纯函数）
- ✅ `packages/shared/src/embedding.ts`（MiniMax API 接口不变）
- ✅ `packages/shared/src/prompt.ts`（纯模板字符串）

---

## 4. Tasks（8 phases）

### Phase 1 — Foundation（~1 天）

**目标**：CloudBase SDK 接好，env 验证框架跑通，retrieval/types 重写完。

#### Task 1.1: 项目结构调整
- Action 1.1.1: `cd apps/api && pnpm add @cloudbase/node-sdk`（添加 SDK 依赖）
- Action 1.1.2: 删 `apps/api/wrangler.jsonc` + `apps/api/migrations/`（用 git rm）
- Action 1.1.3: 删 `apps/api/test/integration.test.ts`（Miniflare 不适用）
- Action 1.1.4: 新建 `apps/api/src/lib/cloudbase.ts`（SDK init 单例）
- Action 1.1.5: 新建 `apps/api/src/lib/env.ts`（env 加载 + 启动时硬验证）
- Action 1.1.6: 新建 `apps/api/src/lib/handler-utils.ts`（HTTP trigger 通用工具）

Mirror: v0 `apps/api/src/types.ts:1-35` Env interface 简化版
Validate:
```bash
pnpm -F api typecheck    # 0 error
pnpm -F api build        # 0 error
```

#### Task 1.2: 启动时硬验证
- Action 1.2.1: 在 `lib/env.ts` 写 `validateEmbeddingDim()` + `validateKekSecrets()`
- Action 1.2.2: 在 `src/index.ts` 入口跑一次验证（启动期 fail-fast）

Mirror: spec §7.3
Validate: 故意设错 dim env → 启动 throw；修正后正常启动

#### Task 1.3: types.ts + retrieval.ts 重写
- Action 1.3.1: 重写 `packages/shared/src/types.ts`（CloudBase 文档类型 + 简化 Env）
- Action 1.3.2: 重写 `packages/shared/src/retrieval.ts`（brute-force cosine + CloudBase DB fetch）
- Action 1.3.3: 新建 `packages/shared/test/retrieval.test.ts`（cosine 计算 + top-K 排序测试）

Mirror: spec §3 + §4
Validate:
```bash
pnpm -F shared test test/retrieval.test.ts   # 至少 5 个测试通过
pnpm -F shared typecheck                    # 0 error
```

🛑 **CP-1**: Phase 1 全绿，shared 库可被 v1 handler 引用

### Phase 2 — Data Layer + Handlers 骨架（~1 天）

**目标**：9 个 collection schema 设计 + index 创建脚本 + 13 handler 骨架（每个 handler 文件框架 + TODO 标记）

#### Task 2.1: Collection schema 设计
- Action 2.1.1: 新建 `apps/api/src/lib/collections.ts`（9 个 collection name 常量 + 文档类型）
- Action 2.1.2: 新建 `apps/api/migrations-cloudbase/01-init-collections.json`（初始 collection 配置）
- Action 2.1.3: 新建 `apps/api/migrations-cloudbase/02-indexes.json`（field index 配置，spec §3.3）

Mirror: v0 `apps/api/migrations/0001_init.sql` 等 SQL schema
Validate:
```bash
# 部署到 CloudBase 测试环境后：
# 1. 9 collection 全部可见
# 2. 6+ field index 创建成功
```

#### Task 2.2: db.ts + storage.ts helpers
- Action 2.2.1: 新建 `apps/api/src/lib/db.ts`（getCollection, add, get, whereQuery, update, remove 通用函数）
- Action 2.2.2: 新建 `apps/api/src/lib/storage.ts`（uploadFile, getTempFileURL, deleteFile）

Mirror: v0 `apps/api/src/lib/ask.ts` 等 routes 直接 DB 调用模式
Validate:
```bash
pnpm -F api typecheck
pnpm -F api test test/lib/db.test.ts test/lib/storage.test.ts
```

#### Task 2.3: 13 个 handler 文件骨架
- Action 2.3.1: 创建 13 个 handler 文件（每个 ~10-30 行骨架：export async function handler(event, context) { /* TODO */ }）
- Action 2.3.2: 修改 `apps/api/src/index.ts`（HTTP trigger 入口分发：route event.path → handler）

Mirror: v0 `apps/api/src/routes/*.ts` handler 签名风格
Validate:
```bash
pnpm -F api typecheck    # 0 error（handler 签名正确）
pnpm -F api build        # 0 error
```

🛑 **CP-2**: 13 handler 骨架部署到 CloudBase 后，HTTP trigger URL 可达但返 501 Not Implemented

### Phase 3 — Auth + 简单 Read Handlers（~1 天）

**目标**：admin-login / wx-login / health / stats / sessions CRUD 5+3 = 8 个 handler 实现。

#### Task 3.1: admin-ip-allowlist.ts 迁移
- Action 3.1.1: 复制 v0 `apps/api/src/lib/admin-ip-allowlist.ts` 到 v1
- Action 3.1.2: env 读取从 `env.ADMIN_IP_ALLOWLIST` 改为 `process.env.ADMIN_IP_ALLOWLIST`
- Action 3.1.3: 新建 `apps/api/test/lib/admin-ip-allowlist.test.ts`（沿用 v0 测试用例）

Mirror: `apps/api/src/lib/admin-ip-allowlist.ts` v0（M6.10）
Validate:
```bash
pnpm -F api test test/lib/admin-ip-allowlist.test.ts   # 5+ 测试通过
```

#### Task 3.2: api-auth-admin-login handler
- Action 3.2.1: 实现 admin token 验证 + JWT 签发
- Action 3.2.2: 集成 admin-ip-allowlist（白名单 IP 跳过 rate-limit）
- Action 3.2.3: 集成 rate-limit（M6.3a per-IP + per-token）
- Action 3.2.4: 写 `apps/api/test/handlers/api-auth-admin-login.test.ts`

Mirror: v0 `apps/api/src/routes/auth.ts:171-182` ADMIN_LOGIN + M6.3a rate-limit 集成
Validate:
```bash
pnpm -F api test test/handlers/api-auth-admin-login.test.ts
```

#### Task 3.3: api-auth-wx-login handler (wx.cloud.callFunction)
- Action 3.3.1: 实现 WX_CONTEXT.openid 提取（验证 `event.openid` vs `event.userInfo.openId`）
- Action 3.3.2: user collection 查找/创建 + JWT 签发
- Action 3.3.3: 写集成测试（mock SDK + mock WX_CONTEXT）

Mirror: v0 `apps/api/src/routes/auth.ts` wx-login
Validate:
```bash
pnpm -F api test test/handlers/api-auth-wx-login.test.ts
```

#### Task 3.4: 简单 read handlers
- Action 3.4.1: api-health：返 `{ok: true, version}`（无 DB）
- Action 3.4.2: api-stats：admin auth + D1 读 login_attempt 统计
- Action 3.4.3: api-sessions-list/get/delete：admin auth 或 JWT auth + user_id 过滤
- Action 3.4.4: 写 4 个测试文件

Mirror: v0 routes/health.ts / stats.ts / sessions.ts
Validate:
```bash
pnpm -F api test test/handlers/api-health.test.ts \
                    test/handlers/api-stats.test.ts \
                    test/handlers/api-sessions-list.test.ts \
                    test/handlers/api-sessions-get.test.ts \
                    test/handlers/api-sessions-delete.test.ts
```

🛑 **CP-3**: 8 handler 实现 + 8 测试全绿；admin login + 简单 read 端到端在 CloudBase 测试环境跑通

### Phase 4 — Write Handlers + Vector Search（~2 天）

**目标**：upload + ingest + search 3 个核心 write/read handler 完整实现。

#### Task 4.1: api-upload handler
- Action 4.1.1: multipart 解析（PDF / Word / TXT / MD）
- Action 4.1.2: 分块（用 shared/chunking.ts）
- Action 4.1.3: 每 chunk 调 MiniMax embedding + 写 chunk collection（带 embedding）
- Action 4.1.4: 上传原文件到云存储
- Action 4.1.5: 写 source / document collection（带 preview_snippet）
- Action 4.1.6: 部分失败 try/catch + 返 `{chunks_inserted, chunks_failed, errors}`
- Action 4.1.7: 写测试（mock SDK + mock embedding）

Mirror: v0 `apps/api/src/routes/upload.ts`
Validate:
```bash
pnpm -F api test test/handlers/api-upload.test.ts
```

#### Task 4.2: api-ingest handler
- Action 4.2.1: 接 crawler POST（admin auth + ADMIN_TOKEN）
- Action 4.2.2: 复用 upload 的 chunk + embedding 流程（不含文件上传）
- Action 4.2.3: 写测试

Mirror: v0 `apps/api/src/routes/ingest.ts`
Validate:
```bash
pnpm -F api test test/handlers/api-ingest.test.ts
```

#### Task 4.3: api-search handler
- Action 4.3.1: 接 query string
- Action 4.3.2: MiniMax embedding query
- Action 4.3.3: 调 shared/retrieval.ts vectorSearch
- Action 4.3.4: 返 `{results: [ScoredChunk]}`
- Action 4.3.5: 写测试（mock retrieval + mock embedding）

Mirror: v0 `apps/api/src/routes/search.ts` + shared/retrieval.ts v1
Validate:
```bash
pnpm -F api test test/handlers/api-search.test.ts
```

🛑 **CP-4**: 3 handler 完整实现 + CloudBase 测试环境真实上传 → search 召回成功

### Phase 5 — Chat + Ask Handlers（~2 天）

**目标**：api-ask + api-chat 2 个最复杂 handler 实现。

#### Task 5.1: api-ask handler
- Action 5.1.1: MiniMax embedding query
- Action 5.1.2: 调 retrieval vectorSearch top-K(20)
- Action 5.1.3: 拼 context + system prompt + 用户问题
- Action 5.1.4: 调 MiniMax chat completion
- Action 5.1.5: 解析 [来源 N] 引用 → 返 answer + citations
- Action 5.1.6: 写测试（mock MiniMax + mock retrieval）

Mirror: v0 `apps/api/src/routes/ask.ts` + `packages/shared/src/prompt.ts`
Validate:
```bash
pnpm -F api test test/handlers/api-ask.test.ts
```

#### Task 5.2: api-chat handler（多轮）
- Action 5.2.1: 接 session_id + user_message
- Action 5.2.2: chat_session collection 查/建 session
- Action 5.2.3: 取历史 messages + 加新 message
- Action 5.2.4: 调 retrieval（user_id 过滤）
- Action 5.2.5: 调 MiniMax chat with messages
- Action 5.2.6: 持久化 messages 到 chat_session
- Action 5.2.7: 写测试

Mirror: v0 `apps/api/src/routes/chat.ts`
Validate:
```bash
pnpm -F api test test/handlers/api-chat.test.ts
```

🛑 **CP-5**: 2 handler 完整实现 + CloudBase 测试环境完整 RAG 链路验证

### Phase 6 — Cron + 启动验证（~0.5 天）

**目标**：api-cron-cleanup handler + 启动时硬验证通过。

#### Task 6.1: api-cron-cleanup handler
- Action 6.1.1: 删 login_attempt 早于 window 的记录
- Action 6.1.2: 配置 CloudBase 定时触发器（每日 03:00 UTC）
- Action 6.1.3: 写测试

Mirror: v0 `apps/api/src/routes/cron.ts`
Validate:
```bash
pnpm -F api test test/handlers/api-cron-cleanup.test.ts
```

#### Task 6.2: 启动时硬验证集成测试
- Action 6.2.1: 写集成测试：故意设错 dim → 启动 throw
- Action 6.2.2: 故意删 KEK_SECRET_V1 env → 启动 throw
- Action 6.2.3: 修正后正常启动

Mirror: spec §7.3
Validate:
```bash
pnpm -F api test test/lib/env-validation.test.ts
```

🛑 **CP-6**: cron handler + 启动时硬验证 + CloudBase 定时触发器配置

### Phase 7 — Frontend 接入 + 6 步 Smoke（~0.5 天）

**目标**：mini-program + admin apiBaseUrl 切到 CloudBase URL + 端到端 smoke。

#### Task 7.1: apiBaseUrl 改动
- Action 7.1.1: 改 `apps/miniprogram/app.ts:7`（apiBaseUrl → CloudBase HTTP 触发器 URL）
- Action 7.1.2: 改 `apps/admin/.env.production`（`VITE_API_BASE_URL=CloudBase URL`）

Mirror: v0 `apps/miniprogram/app.ts:7` 单行 + `apps/admin/.env.production` 新增
Validate:
```bash
grep apiBaseUrl apps/miniprogram/app.ts apps/admin/.env.production
# 都应含 CloudBase URL（不是 workers.dev）
```

#### Task 7.2: 6 步 smoke（CloudBase HTTP 触发器 URL）
- Action 7.2.1: 用 plan §CP-3 验证同样的 6 步：
  ```
  API="https://<appid>.<region>.app.tcloudbase.com/api"
  TOKEN="<ADMIN_TOKEN>"

  curl -sf $API-health
  curl -sf -X POST $API-auth-admin-login ...
  curl -sf -X POST $API-upload -F file=@...
  curl -sf "$API-search?q=..."
  curl -sf -X POST $API-ask ...
  curl -sf $API-stats-login-attempts ...
  ```
- Action 7.2.2: 每步贴输出到 state-cp6.md §6

Mirror: v0 spec §8
Validate:
- 6 步全 200
- upload → search 召回 ≥1 chunk（验证 D-6）
- admin auth 链路完整（验证 D-1）

#### Task 7.3: 关闭 deferred 项验证
- Action 7.3.1: D-1 admin auth 链路：smoke step 2-6 全 200
- Action 7.3.2: D-3 rate-limit：旁路跑错误 token 6 次 → 第 6 次 429
- Action 7.3.3: D-4 ADMIN_IP_ALLOWLIST：旁路从非 allowlist IP 调 /auth/admin-login → 403
- Action 7.3.4: D-6 Vectorize 远端：smoke step 3-4（upload → search 召回成功）

🛑 **CP-7**: 6 步 smoke 全过 + 4 项 deferred 验证全通过

### Phase 8 — 封存 v0 + state-cp6 + commit（~0.5 天）

**目标**：v0 封存归档 + cp-6 收尾文档 + 全部 commit。

#### Task 8.1: 封存 v0 实施
- Action 8.1.1: `git tag v0-cf-archived f623f66`
- Action 8.1.2: `git tag -m "CP-5 真接 Cloudflare 收尾版本；cp-6 走 CloudBase 全量迁移"`
- Action 8.1.3: 改 `state-cp5.md` 加 "封存归档" 附录（spec 附录 A）
- Action 8.1.4: 改 `README.md` 加 v1 段 + v0 封存段

Mirror: spec §8.3
Validate:
```bash
git tag --list "v0-cf-archived"  # 输出含 v0-cf-archived
git show v0-cf-archived --stat   # 显示 commit f623f66 内容
```

#### Task 8.2: state-cp6.md 收尾
- Action 8.2.1: 写 `docs/superpowers/state-cp6.md`（11 sections）：
  - §1 摘要（CloudBase URL + 13 函数列表）
  - §2 资源清单（9 collection + 4 secrets + 8 vars）
  - §3 secrets/vars 注入清单
  - §4 collection + index 创建
  - §5 handler 实现清单（13 个）
  - §6 smoke 6 步输出
  - §7 关闭 deferred 项
  - §8 commit hash 列表
  - §9 已知 issue / 风险
  - §10 cp-7 计划项
  - §11 References
- Action 8.2.2: 改 README 加 CP-6 节（v1 状态 + v0 封存链接）
- Action 8.2.3: commit + push（问用户）

Mirror: v0 `docs/superpowers/state-cp5.md` 结构
Validate:
```bash
git log --oneline -10  # 见 cp-6 commit hash
git remote -v          # 确认 remote（如有）
```

🛑 **CP-8**: cp-6 收尾文档 + 封存归档 + 全部 commit

---

## 5. Validation

### 5.1 全局验证（Phase 8 后）

```bash
# 1. 单元 + 集成测试
pnpm -r test            # 所有包测试全绿

# 2. 类型检查
pnpm -r typecheck       # 所有包 typecheck 0 error

# 3. 6 步 smoke（CloudBase URL）
API="https://<appid>.<region>.app.tcloudbase.com/api"
TOKEN="<ADMIN_TOKEN>"
# (6 个 curl 命令，spec §8.4)

# 4. v0 封存
git tag --list "v0-cf-archived"
git show v0-cf-archived --stat | head

# 5. 启动时硬验证
# 故意设错 EMBEDDING_DIM → 启动 throw
# 故意删 KEK_SECRET_V1 → 启动 throw
```

### 5.2 累计测试矩阵

| 包 | 测试增量 | 累计（v0 + cp-6） |
|---|---|---|
| `packages/shared` | +5 (retrieval) | 38 + 5 = 43 |
| `apps/api` | +20 (handlers + lib) | 167 + 20 = 187 |
| `apps/admin` | 0 | 24 |
| `apps/miniprogram` | 0 | 32 |
| `apps/crawler` | 0 | 19 |
| **累计** | +25 | 312 |

### 5.3 关闭 deferred 项（spec §9.2 + §10.2）

| 项 | 验证 |
|---|---|
| D-1 admin auth 链路 | Phase 7 smoke |
| D-3 rate-limit | Phase 7 旁路 |
| D-4 ADMIN_IP_ALLOWLIST | Phase 7 旁路 |
| D-6 Vectorize 远端 | Phase 7 smoke |

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **WX_CONTEXT.openid 字段路径不确定**（`event.openid` vs `event.userInfo.openId`）| 中 | Phase 3 Task 3.3 smoke 验证；如不对，1 行代码改 |
| **CloudBase HTTP 触发器 body 大小限制 4MB**（upload 超大 PDF 失败）| 中 | Phase 4 限制单文件 4MB；超文件留 v2 |
| **Embedding 1536 维假设**（MiniMax 实际可能不同）| 低 | 启动时硬验证（Phase 6 Task 6.2）；不符则调 dim + migration apply |
| **CloudBase SDK 行为差异**（vs CF Workers 的 Event/Context API）| 中 | Phase 1 Task 1.1 仔细读 SDK 文档；Phase 3 handler 测试 |
| **R2 → CloudBase Storage SDK 差异**（stream / multipart 处理）| 中 | Phase 4 Task 4.1.4 提前研究；如差异大，调整 upload 流程 |
| **Cron trigger 配置**（CloudBase 控制台 UI 操作）| 低 | Phase 6 Task 6.1.2 截图记录步骤 |
| **Admin IPv6 动态失效**（同 CP-5） | 中 | 沿用 CP-5 §9 SOP；admin 换网络时手动更新 ADMIN_IP_ALLOWLIST |
| **crawler 调 HTTP 触发器 401**（admin token 错 / IP 不在白名单）| 低 | Phase 4 Task 4.2 验证；crawler 在用户 Mac（IP 在 allowlist）|

**最高风险**：WX_CONTEXT.openid 字段路径（spec 已标 risk，Phase 3 必须 smoke 验证）。

---

## 7. Acceptance Criteria

### 7.1 功能 AC

- [ ] AC-1: 13 个 CloudBase 函数部署 + 触发器配
- [ ] AC-2: 4 secrets + 8 vars 注入 CloudBase 控制台
- [ ] AC-3: 9 个 collection 创建 + 6+ index 建立
- [ ] AC-4: 启动时硬验证通过（embedding dim + KEK_SECRET_V1 存在）
- [ ] AC-5: mini-program `apiBaseUrl` 改 v1 URL
- [ ] AC-6: admin `VITE_API_BASE_URL` 改 v1 URL
- [ ] AC-7: 6 步 smoke 全过
- [ ] AC-8: wx.cloud.callFunction 路径 mock 测试可调（cp-7 真机验证）
- [ ] AC-9: ADMIN_IP_ALLOWLIST 真实生效（旁路 → 403）
- [ ] AC-10: crawler 仅改 env 即通（代码 0 改动）

### 7.2 关闭 AC

- [ ] AC-11: v0 资源保留（CF Worker + D1 + Vectorize + R2）
- [ ] AC-12: v0 git tag `v0-cf-archived` 创建
- [ ] AC-13: D-1 / D-3 / D-4 / D-6 全通过

### 7.3 文档 AC

- [ ] AC-14: `docs/superpowers/state-cp6.md` 收尾
- [ ] AC-15: README v1 段 + v0 封存段
- [ ] AC-16: `state-cp5.md` 加 "封存归档" 附录
- [ ] AC-17: `docs/superpowers/plans/2026-06-17-cp6-cloudbase-migration.md`（本文件）committed

### 7.4 测试 AC

- [ ] AC-18: 累计 312 用例全绿（287 v0 + 25 cp-6 新增）
- [ ] AC-19: 5 包 typecheck 全绿

### 7.5 推送 AC

- [ ] AC-20: `git push` 前得到口头确认（destructive 操作原则）

---

## 8. Implementation Notes

### 8.1 Subagent 分配

CP-6 1 大任务 8 phases → **主线程直接做**（不适合派 subagent）：
- 上下文集中有利（CloudBase SDK 新栈，无 background knowledge 可借鉴）
- 13 handlers + shared 重写，需要全局视野
- Phase 间有强依赖（Phase 2 依赖 Phase 1，Phase 5 依赖 Phase 4）

### 8.2 Commit 节奏（预估 8-10 commit）

```
1. chore(api): CP-6 — CloudBase SDK init + env loader + handler 骨架
2. refactor(shared): types.ts + retrieval.ts 重写（CloudBase NoSQL + brute-force cosine）
3. feat(api): CP-6 — auth handlers (admin-login + wx-login) + IP allowlist 迁移
4. feat(api): CP-6 — read handlers (health + stats + sessions CRUD)
5. feat(api): CP-6 — write handlers (upload + ingest + search)
6. feat(api): CP-6 — chat + ask handlers (完整 RAG + 多轮)
7. feat(api): CP-6 — cron cleanup handler + 启动时硬验证
8. docs: CP-6 state-cp6.md 收尾 + README v1/v0 段 + 封存归档
9. chore: git tag v0-cf-archived at f623f66
```

**总 9 commit + 0 merge**（master 直接做，与 CP-5 一致）。

### 8.3 时序

- **Phase 1** 1 天（基础）
- **Phase 2** 1 天（data layer + 骨架）
- **Phase 3** 1 天（auth + 简单 read）
- **Phase 4** 2 天（write + vector search）
- **Phase 5** 2 天（chat + ask）
- **Phase 6** 0.5 天（cron + 验证）
- **Phase 7** 0.5 天（接入 + smoke）
- **Phase 8** 0.5 天（封存 + 收尾）

**总 8.5 天**（约 1.5 周，与用户预估 1-2 周一致）。

### 8.4 阻塞 / 时序

- 用户阻塞 1：CloudBase 环境创建（首次需注册腾讯云账号 + 开通 CloudBase + 实名认证，约 1 天）
- 用户阻塞 2：4 secrets 注入（你生成 openssl hex + 提供 MiniMax key + 知道 ADMIN_IP_ALLOWLIST 值）
- 用户阻塞 3：9 collection 手动在 CloudBase 控制台创建 + index 配置（或写脚本一次性创建）
- 用户阻塞 4：13 个函数手动部署（或写 deployment script 一次性部署）

主线程不能代为做 CloudBase 控制台操作 → 需要用户分阶段在控制台操作，主线程跑命令/写代码。

### 8.5 CloudBase 控制台操作清单（用户做）

| 步骤 | 动作 |
|---|---|
| 1 | 注册腾讯云账号 + 实名认证（如未做）|
| 2 | 开通 CloudBase（创建环境，选 region：`ap-shanghai` 推荐）|
| 3 | 在 CloudBase 控制台创建 9 个 collection（按 schema）|
| 4 | 在 CloudBase 控制台配置 6+ field index（spec §3.3）|
| 5 | 创建 13 个云函数（每个 import handler 代码）|
| 6 | 配置 HTTP 触发器（每个函数暴露 URL）|
| 7 | 配置定时触发器（api-cron-cleanup 每日 03:00 UTC）|
| 8 | 配置 4 secrets + 8 vars（CloudBase 函数配置）|

或更优：写一个 deployment script（Node.js + CloudBase SDK + open API）一次完成 #3-7。我可在 Phase 2 后写。

### 8.6 mock-first 边界（cp-6 打破 mock-first）

- ✅ 不做 CloudBase 事务回滚（YAGNI）
- ✅ 不做 ANN 向量索引（brute-force in code）
- ✅ 不做 mini-program 真机（cp-7 范围）
- ✅ 不做 presigned URL 直传云存储（v2）
- ❌ 全验：admin auth + IP allowlist + RAG 链路 + vector search + storage upload + cron

### 8.7 下一步（cp-7 候选）

1. **Mini-program 真机验证**（需注册 AppID 时同时做）
2. **Custom domain + ICP 备案**（如果你最终想用；当前 spec ruled out）
3. **WE_APP_SECRET 注入**（已不需要，CloudBase 自动处理 — 标 done）
4. **重跑 deferred smoke**（D-1 / D-3 / D-4 / D-6）—— cp-6 内已包含
5. **KEK 轮换演练**（M6.8 留口；cp-8）
6. **v0 资源销毁决策点**（v1 稳定运行 1 个月+ 后让用户决定）

---

## 9. Rollback Strategy

如 cp-6 迁移中途 abort：

```bash
# 1. 改 mini-program apiBaseUrl 指回 v0
# 编辑 apps/miniprogram/app.ts:7
apiBaseUrl: "https://unequal-api.yydsnews.workers.dev",

# 2. 改 admin apiBaseUrl 指回 v0
# 编辑 apps/admin/.env.production
VITE_API_BASE_URL=https://unequal-api.yydsnews.workers.dev

# 3. CloudBase 控制台 disable 所有云函数触发器 + 定时触发器

# 4. commit + push（问用户）
```

**v0 资源保留**：CF Worker + D1 + Vectorize + R2 不动；admin_token + IP allowlist 同 v0；admin 走 VPN 访问。

**可逆性**：
- CloudBase 资源可销毁（也保留作为另一个 staging 环境）
- 代码回滚通过 `git revert` 完整可逆
- v0 数据继续保留为 reference

---

## 10. References

- **Spec**：`docs/superpowers/specs/2026-06-17-cp6-cloudbase-migration-design.md`（commit `0301f7a`）
- **CP-5 spec / plan / state**：`docs/superpowers/{specs,plans,state-cp5.md}/2026-06-16-cp5-*`
- **M6.10 spec**：`docs/superpowers/specs/2026-06-16-m6-10-admin-allowlist-design.md`（ADMIN_IP_ALLOWLIST 代码来源）
- **M6.3a state**：`docs/superpowers/state-m6-3a.md`（rate-limit 行为）
- **M6.8 spec**：`docs/superpowers/specs/2026-06-16-m6-9-token-mutex-design.md`（KEK fallback 行为）
- **项目 README**：`README.md`（v1 / v0 状态段待加）
- **腾讯 CloudBase 文档**：https://docs.cloudbase.net/
- **Tencent CloudBase Node SDK**：https://docs.cloudbase.net/api-reference/server/node-sdk.html

---

**🛑 CP 总结**：CP-1（基础）→ CP-2（data + 骨架）→ CP-3（auth + 简单 read）→ CP-4（write + vector search）→ CP-5（chat + ask）→ CP-6（cron + 硬验证）→ CP-7（接入 + smoke）→ CP-8（封存 + 收尾）。

**等待用户确认**："proceed" / "modify: [改动]" / "skip phase X" / "answer risk X"。