# CP-6 — CloudBase 全量迁移

**版本**：2026-06-17
**前置**：CP-5 真接 Cloudflare（commit `f623f66`）已部署但用户网络阻所有 CF 域（GFW / DNS 污染），**v0 不可达**；本 spec 把后端全量迁移到微信云开发 CloudBase 国内可达
**范围**：apps/api 全部重写为 CloudBase 云函数；apps/miniprogram / apps/admin 仅换 apiBaseUrl；v0 CF 资源封存保留（不销毁）；本地 vector DB 同步架构记 [[project-future-local-vector-db-sync]] 备未来扩展

> **不是部署 spec** — 是架构迁移 spec。结构借鉴 CP-5 spec + M6.10 spec。

---

## 1. Requirements

| # | 现状 | 目标 |
|---|---|---|
| R-1 | apps/api 部署在 CF Workers；用户网络阻 workers.dev，admin / mini-program 不可达 | apps/api 全量迁 CloudBase 云函数，国内可达 |
| R-2 | D1 SQL（9 表，schema 已建无数据） | CloudBase 云数据库 NoSQL（9 个 collection，1:1 映射）|
| R-3 | Vectorize 内置向量索引 | 代码实现 brute-force cosine in 云函数（YAGNI ANN，< 1万 chunk 内足够）|
| R-4 | R2 存储原文件 | CloudBase 云存储 |
| R-5 | Durable Object（chat session）| CloudBase DB collection + 内存缓存（无 DO 等价物）|
| R-6 | Cron Trigger `0 3 * * *` | CloudBase 定时触发器 |
| R-7 | 5 secrets + vars 在 wrangler.jsonc | 4 secrets + 8 vars 在 CloudBase 控制台（CRON_SECRET / WX_APP_SECRET 不再需要）|
| R-8 | mini-program `apiBaseUrl = https://unequal-api.yydsnews.workers.dev` | `apiBaseUrl = https://<appid>.<region>.app.tcloudbase.com/api-*`（region 用户在 CloudBase 控制台创建环境时选定，如 `ap-shanghai` / `ap-guangzhou` / `ap-beijing`） |
| R-9 | 微信小程序登录走 jscode2session（需 WX_APP_SECRET）| CloudBase `wx.cloud.callFunction` 自动注入 WX_CONTEXT.openid，**免 jscode2session** |
| R-10 | v0 CF 部署完成 | v0 封存：git tag `v0-cf-archived` + CF 资源保留（不销毁）+ README 标 archived |

**YAGNI 精简**（spec 显式不做）：
- ❌ 不做 mini-program 真机验证（cp-7 范围）
- ❌ 不做 custom domain / ICP 备案（已 ruled out）
- ❌ 不做 ANN 向量索引（HNSW / IVF）（< 1万 chunk 不需要）
- ❌ 不做 CloudBase 事务回滚（部分失败用 try/catch + 报告）
- ❌ 不做外部 APM（Datadog / Sentry / Grafana）（CloudBase 控制台监控够）
- ❌ 不做 KEK 轮换（M6.8 留口）
- ❌ 不做本地 vector DB 同步架构（[[project-future-local_vector_db_sync]] 备未来）
- ❌ 不迁移 v0 数据（v0 无真实数据，仅 schema）

---

## 2. 架构 / 组件映射

### 2.1 整体架构

```
┌─────────────────────────────┐
│  微信小程序（家长端）         │
│  - wx.cloud.callFunction     │
│    （自动 WX_CONTEXT.openid）│
│  - 或 wx.request HTTP触发器  │
└──────────┬──────────────────┘
           │ 微信内部网络，无 GFW
┌──────────┴──────────────────┐
│  微信云开发 CloudBase        │
│  - HTTP 触发器 (~13 个函数)  │
│  - 云数据库 (NoSQL 9 coll)   │
│  - 云存储 (对象存储)          │
│  - 定时触发器                │
└──────────┬──────────────────┘
           │
   ┌───────┴────────┬──────────┬──────────┐
   │ CloudBase DB    │ Storage  │ 外部 API  │
   │ (NoSQL docs)    │          │ MiniMax   │
   │                 │          │ LLM + embd│
   └─────────────────┴──────────┴──────────┘

admin 后台（浏览器）：HTTPS → CloudBase HTTP 触发器 → admin_token + ADMIN_IP_ALLOWLIST

封存（frozen v0）：
┌─────────────────────────────┐
│  CF Worker (https://unequal-api.yydsnews.workers.dev) │
│  资源保留运行（成本 ¥0）       │
│  代码 tag: v0-cf-archived     │
└─────────────────────────────┘
```

### 2.2 核心组件映射表

| 组件 | v0 (CF) | v1 (CloudBase) | 改动成本 |
|---|---|---|---|
| Workers | CF Workers | CloudBase 云函数 | 重写 SDK 调用 |
| D1 (SQL) | D1 SQLite | CloudBase NoSQL 9 collection | **重写所有 query** |
| Vectorize | CF Vectorize | 代码实现 cosine in handler | 重写 search 逻辑 |
| R2 | R2 bucket | CloudBase 云存储 | 重写 SDK |
| Durable Object | DO (chat session) | DB collection + 缓存 | 重写 session 逻辑 |
| Cron Trigger | `0 3 * * *` | CloudBase 定时触发器 | 配置迁移 |
| wrangler secret | `wrangler secret put` | CloudBase 控制台 env | 重新注入 4 secrets |
| Vars | wrangler.jsonc vars | CloudBase 控制台 env | 重新设 8 vars |

### 2.3 CloudBase 函数列表（13 个，对应 v0 routes）

| 函数 | 触发器 | 对应 v0 route | 备注 |
|---|---|---|---|
| `api-ask` | HTTP | POST /ask | RAG 问答 |
| `api-upload` | HTTP | POST /upload | 文件上传入库 |
| `api-ingest` | HTTP (admin) | POST /ingest | 爬虫回写 |
| `api-search` | HTTP (admin) | GET /search | 向量检索 |
| `api-chat` | HTTP | POST /chat | 多轮会话 |
| `api-sessions-list` | HTTP | GET /sessions | 列出会话 |
| `api-sessions-get` | HTTP | GET /sessions/:id | 读单会话 |
| `api-sessions-delete` | HTTP | DELETE /sessions/:id | 删会话 |
| `api-stats` | HTTP (admin) | GET /stats/login-attempts | 统计 |
| `api-auth-wx-login` | wx.cloud.callFunction | POST /auth/wx-login | mini-program 登录（自动 WX_CONTEXT）|
| `api-auth-admin-login` | HTTP | POST /auth/admin-login | admin 登录 |
| `api-cron-cleanup` | 定时触发器 | POST /cron/cleanup-login-attempts | 每日 03:00 |
| `api-health` | HTTP | GET /health | 存活 |

### 2.4 触发器分层

| 触发器 | 何时用 | WX_CONTEXT |
|---|---|---|
| **HTTP 触发器** | admin 浏览器 + wx.request 调用 | 不带（需手动传 openid） |
| **wx.cloud.callFunction** | 微信小程序原生调用 | **自动带 openid/appid** |
| **定时触发器** | cron 触发 | 无 |

**设计取舍**：
- mini-program 业务接口（ask/chat/upload）用 HTTP 触发器（admin + miniprogram 共用一套）
- mini-program 登录用 `wx.cloud.callFunction`（自动 openid，免鉴权调用）
- admin 走 HTTP 触发器（admin_token + IP allowlist）

---

## 3. 数据模型：D1 SQL → CloudBase NoSQL

### 3.1 D1 → CloudBase collection 映射

| D1 表 (v0) | CloudBase 集合 (v1) | 文档结构变化 |
|---|---|---|
| `source` | `source` collection | 同字段 + 加 `user_id` |
| `document` | `document` collection | `parsed_text` → 移到云存储，doc 只留 `parsed_text_path` + `preview_snippet` |
| `chunk` | `chunk` collection | **嵌入 `embedding: [number]`**（1536 维）|
| `query_cache` | `query_cache` collection | 同字段 |
| `chat_session` | `chat_session` collection | 同字段 |
| `user` | `user` collection | 同字段 |
| `user_session_key` | `user_session_key` collection | 同字段 |
| `login_attempt` | `login_attempt` collection | 同字段 |
| `crawl_job` | `crawl_job` collection | 同字段 |

**9 个 collection，1:1 映射 SQL 表**（MongoDB 通用模式，不嵌数组）。

### 3.2 关键设计决策

**(a) `chunk` 嵌入 vector**：
```
chunk doc = {
  _id: "01H...",
  document_id: "01H...",
  source_id: "01H...",
  user_id: "01H...",
  idx: 5,
  content: "5个月宝宝发烧38.5...",
  embedding: [0.012, -0.034, ...1536 floats...],
  token_count: 87,
  created_at: 1718400000000
}
```
- 单 chunk doc ~14KB（content 1KB + embedding 6KB + 元数据 1KB）
- CloudBase doc 限制 1MB（远不到）
- vector search 暴力 in code（§4 详细）

**(b) `parsed_text` 移到云存储**：
```
document doc = {
  _id, source_id, user_id, title,
  raw_path: "raw/01H.../aap-fever.pdf",
  parsed_text_path: "parsed/01H.../aap-fever.md",  // 可选
  preview_snippet: "前 200 字...",
  created_at
}
```
parsed_text 走云存储，避免 collection doc 撑爆。

**(c) ID 策略**：沿用 v0 ULID 风格字符串 ID（不依赖 CloudBase auto-id），方便跨平台迁移 + 调试。

**(d) 多用户准备**：v0 单用户，亲友圈场景短期也单用户；但 collection 加 `user_id` 字段（=默认用户常量），未来扩多用户无需迁移。

### 3.3 Index 设计（CloudBase 基础 field index）

| Collection | Index 字段 | 用途 |
|---|---|---|
| `chunk` | `document_id` / `source_id` / `user_id` | vector search 过滤 + 按文档/源过滤 |
| `document` | `source_id` | 列文档 |
| `chat_session` | `user_id` | 列用户会话 |
| `login_attempt` | `client_ip_hash` | rate limit 查询 |
| `user_session_key` | `user_id` | 取 session key |
| `crawl_job` | `source_id` + `status` | 查 pending jobs |

**注意**：CloudBase 不能建 `embedding` 索引 —— vector search 必须 brute-force in code。

### 3.4 v0 → v1 数据迁移

**实际无需迁移**：v0 CF D1 仅 schema（migrations apply 后），**无真实数据**；admin 还没上传过文件，用户没问过问题。

未来如 v0 意外有数据，手动 export D1 + 写转换脚本 import CloudBase 即可。**不做自动化迁移工具**（YAGNI，概率低）。

### 3.5 SQL → NoSQL 查询语义变化

| v0 (SQL) | v1 (NoSQL) |
|---|---|
| `SELECT * FROM chunk WHERE document_id = ?` | `db.collection('chunk').where({document_id}).get()` |
| `JOIN source ON chunk.source_id = source.id` | 两次 `get()` + JS 关联 / denormalize 到 chunk doc |
| `ORDER BY idx LIMIT N` | `.orderBy('idx','asc').limit(N)` |
| `INSERT ... ON CONFLICT DO NOTHING` | `.add()` 默认行为（不存在则创建）|
| `GROUP BY / COUNT / SUM` | `.aggregate().group()` 或 JS reduce |

**denormalize 选择**：把常用 join 字段（`source.title` / `source.account`）复制到 `chunk` doc，**避免 95% 的 join**。source 更新时 chunk 批量更新（接受，因 source 极少更新）。

---

## 4. Vector Search 实现（brute-force in code）

### 4.1 核心算法

```typescript
// packages/shared/src/vector-search.ts
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function vectorSearch(
  db: CloudBaseDB,
  userId: string,
  queryEmbedding: number[],
  topK: number = 20,
  scoreThreshold: number = 0.5,
): Promise<ScoredChunk[]> {
  const chunks = await getAllChunksByUser(db, userId);
  return chunks
    .map(c => ({ chunk: c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
    .filter(s => s.score >= scoreThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
```

### 4.2 性能预估

| Chunks 数 | cosine 计算 | 内存 (embedding 6KB/chunk) |
|---|---|---|
| 100 | ~1ms | 0.6MB |
| 1000 | ~10ms | 6MB |
| 5000 | ~50ms | 30MB |
| 10000 | ~100ms | 60MB |

亲友圈规模（< 1000 chunks）性能完全够。

### 4.3 CloudBase 分页兜底

```typescript
async function getAllChunksByUser(db, userId) {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    const res = await db.collection('chunk').where({user_id: userId}).skip(offset).limit(PAGE).get();
    all.push(...res.data);
    if (res.data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}
```

### 4.4 Top-K 截断（沿用 v0 流程）

```
1. q → MiniMax embedding → 向量 q
2. brute-force cosine → top-K(20) 召回
3. score threshold 过滤（默认 0.5）
4. 截断 → top-K(5)
5. 把 5 个 chunk 拼成 context，附引用编号 [1]..[5]
6. MiniMax chat：system prompt + context + 用户问题 → 回答
7. 回答里出现的 [来源 N] → 前端映射到引用卡片
```

**v0 vs v1 差异**：v0 用 Vectorize ANN；v1 暴力精确。最近邻对 ≤1万 chunk 无精度差。

### 4.5 缓存策略（YAGNI 标记）

| 策略 | 何时用 | 复杂度 |
|---|---|---|
| **不做缓存**（默认） | < 1000 chunks | 0 |
| CloudBase 内存缓存（函数实例复用） | 1000-10000 chunks | 中 |
| 预计算 HNSW index 存云存储 | > 10000 chunks | 高 |
| 切腾讯云 VectorDB | > 100000 chunks | 厂商切换 |

初始不做任何缓存。等真慢了再优化。

---

## 5. 接入层（mini-program + admin + 鉴权）

### 5.1 apiBaseUrl 改动

| 端 | v0 URL | v1 URL |
|---|---|---|
| mini-program | `https://unequal-api.yydsnews.workers.dev` | `https://<appid>.ap-shanghai.app.tcloudbase.com/api-*` |
| admin (本地 dev) | 同上 | 同上（`VITE_API_BASE_URL` env）|
| admin (生产) | 同上 | 同上（admin 静态托管到 CloudBase 后，跨域自动）|

**mini-program 改动**：`apps/miniprogram/app.ts:7` 单行改 URL。

**admin 改动**：`apps/admin/.env.production` 配 `VITE_API_BASE_URL`；admin 代码本身不改。

### 5.2 鉴权分层

| 调用方 | 鉴权机制 | 实现 |
|---|---|---|
| **mini-program 用户** | `wx.cloud.callFunction` → CloudBase WX_CONTEXT.openid | 函数内 `event.openid`（CloudBase 自动注入；具体字段路径需 smoke 验证：`event.userInfo.openId` 或 `event.openid`） |
| **admin (浏览器)** | `Authorization: Bearer $ADMIN_TOKEN` + `ADMIN_IP_ALLOWLIST` 双层 | HTTP 触发器读 header + `X-Real-IP` |
| **crawler (本地)** | `Authorization: Bearer $ADMIN_TOKEN` | 同 admin 机制（crawler 在用户 Mac，IP 在 allowlist） |

### 5.3 ADMIN_IP_ALLOWLIST 适配

| 维度 | v0 | v1 |
|---|---|---|
| IP 来源 header | `CF-Connecting-IP` | CloudBase：`X-Real-IP` / `X-Forwarded-For`（**需 smoke 验证实际 header 名**） |
| 白名单检查代码 | M6.10 `parseAdminIpAllowlist` + `isAdminIpAllowed` | **同代码直接复用**（string equality） |
| 存储位置 | `wrangler.jsonc` vars | CloudBase 控制台 env（同名 `ADMIN_IP_ALLOWLIST`） |

**代码复用**：M6.10 admin IP allowlist 逻辑 0 改动；只需确认 CloudBase 实际 IP 透传 header 名。

**风险**：如 header 名不同，1 行 `req.headers['x-real-ip']` 改 header 名即可。

### 5.4 微信小程序登录简化

v0 流程：mini-program → `wx.login()` → code → backend `/auth/wx-login` → backend 调 `jscode2session` (需 `WX_APP_SECRET`) → 拿 openid 存 user 表

v1 流程：mini-program → `wx.cloud.callFunction({name: 'api-auth-wx-login'})` → CloudBase 函数 event 自动含 `openid`（WX_CONTEXT） → 直接用 `event.userInfo.openId` → 存 user 表 + 返 JWT

**secret 减少**：`WX_APP_SECRET` 不再需要（CloudBase 自动处理）。`CRON_SECRET` 也不需要（CloudBase 定时触发器自带鉴权）。

### 5.5 secrets + env 最终清单（v1）

**4 secrets**（CloudBase 控制台）：
- `ADMIN_TOKEN`（openssl rand）
- `JWT_SECRET`（openssl rand）
- `MINIMAX_API_KEY`（platform.MiniMax.io）
- `KEK_SECRET_V1`（openssl rand）

**env vars**（CloudBase 控制台）：
- `ENVIRONMENT=production`
- `ALLOWED_ORIGIN=*`
- `ADMIN_IP_ALLOWLIST=<你的 IPv6>`（同 v0）
- `MINIMAX_BASE_URL=https://api.MiniMax.chat/v1`
- `DEFAULT_USER_ID=01H0000000000000000000000`
- `LOGIN_MAX_ATTEMPTS=5`
- `LOGIN_WINDOW_MS=900000`
- `KEK_CURRENT_VERSION=1`

**删除的 v0 env**：`WX_APP_ID`（CloudBase 配在小程序端）/ `AUTH_MODE`（CloudBase 永远 JWT）

---

## 6. Ingest 路径（admin 上传 + crawler 改造）

### 6.1 Ingest 流程

```
┌────────────────────────┐
│ 文件 (PDF/Word/TXT/MD) │
│ 或 crawler 抓的网页内容 │
└──────────┬─────────────┘
           ↓ HTTP POST /upload 或 /ingest
┌──────────┴──────────────────────────────┐
│ 云函数 api-upload / api-ingest           │
│                                          │
│ 1. 鉴权（admin_token + IP allowlist）    │
│ 2. 解析（mammoth / pdf-parse / 原始）    │
│ 3. 分块（chunking.ts, ~500 chars + overlap）│
│ 4. 对每 chunk：                           │
│    a. MiniMax embedding API → 1536-dim    │
│    b. 上传原文件到云存储                  │
│    c. insert source / document / chunk    │
│ 5. 返 { source_id, document_id, chunks: N }│
└──────────────────────────────────────────┘
```

### 6.2 SDK 调用差异

| 操作 | v0 (CF) | v1 (CloudBase) |
|---|---|---|
| 上传文件 | `env.R2.put(key, body)` | `cloudbase.uploadFile({cloudPath, filePath})` |
| 写 source doc | `env.DB.prepare("INSERT ...").run()` | `db.collection('source').add({data: {...}})` |
| 读 chunks for search | `env.DB.prepare("SELECT ...").all()` | `db.collection('chunk').where({...}).skip().limit().get()` |

**关键 SDK**：`@cloudbase/node-sdk`（Node.js，v0 wrangler 类型不再适用）

### 6.3 文件存储路径设计

```
云存储：
raw/<user_id>/<doc_id>/          — 原文件（PDF / docx）
parsed/<user_id>/<doc_id>.md     — 解析后纯文本（可选，避免 collection doc 过大）

DB collection `document`：
{
  _id, source_id, user_id, title,
  raw_path: "raw/01H.../aap-fever.pdf",
  parsed_text_path: "parsed/01H.../aap-fever.md",  // 可选
  preview_snippet: "前 200 字...",
  created_at
}
```

### 6.4 Crawler 改造

v0：CLI 跑在本地，POST 到 `https://unequal-api.yydsnews.workers.dev/ingest` 带 `Authorization: Bearer $CRON_SECRET`

v1：CLI 代码不变（仍在 `apps/crawler/`），**仅改 2 处配置**：
- `apiBaseUrl` env：`https://<appid>.ap-shanghai.app.tcloudbase.com/api-ingest`
- auth header：`Authorization: Bearer $ADMIN_TOKEN`（替代 CRON_SECRET）

**crawler 自身代码 0 改动**。

### 6.5 `packages/shared/` 影响

| 文件 | v0 | v1 | 改动 |
|---|---|---|---|
| `chunking.ts` | 文本分块 | 同 | 0 改动 |
| `embedding.ts` | `createMiniMaxEmbedder()` 接口 | 同（仍调 MiniMax API） | 0 改动 |
| `retrieval.ts` | v0 调 CF Vectorize | **重写**：调 CloudBase DB + JS cosine | **重写**（§4）|
| `prompt.ts` | 提示词拼装 | 同 | 0 改动 |
| `types.ts` | D1 SQL 类型 + Env interface | **重写**：CloudBase 文档类型 + Env 简化 | **重写** |

### 6.6 部分失败恢复

**场景**：1 个文件 5 个 chunk；embedding API 在第 3 个 chunk 失败。

**处理**：每 chunk 独立 try/catch；失败的 chunk 跳过 + 记录 error；最后返 `{chunks_inserted: 4, chunks_failed: 1, errors: [...]}`。

**事务回滚**：YAGNI 标记。

### 6.7 已知限制

- CloudBase HTTP 触发器 body 限制 4MB；超大文件留 v2 用 presigned URL 直传云存储
- Embedding 串行调用 1/chunk；100 chunks × 200ms = 20s；batch input 优化留 v2

---

## 7. 错误处理 / 测试 / 监控

### 7.1 错误分类 + 处理策略

| 错误类别 | 触发场景 | 用户感知 | 后端动作 |
|---|---|---|---|
| 鉴权失败 | admin_token 错 / IP 不在 allowlist | 401 / 403 | 返标准 JSON |
| CloudBase 配额 | 函数超免费额度 | 503 | 返 `{error: "QUOTA_EXCEEDED"}` |
| MiniMax API 失败 | 网络断 / key 失效 / rate limit | 500 + 降级 | try/catch + 返通用回答 |
| Embedding dim 不匹配 | 模型换 | 500 + log | 启动时硬验证（防运行才发现）|
| chunk 内容为空 | 空文件 | 400 | ingest 前预校验 |
| CloudBase timeout | 函数 > 60s | 504 | 长任务拆小（v2 优化）|

**统一错误响应格式**：
```typescript
interface ApiError {
  error: string;        // "AUTH_FAILED" | "QUOTA_EXCEEDED" | ...
  message: string;      // 中文友好提示
  retry_after?: number;
  details?: unknown;    // dev 环境用
}
```

### 7.2 测试策略（3 层）

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单元测试 | vitest（同 v0） | `packages/shared/*` 纯函数 + handler 独立逻辑 |
| 集成测试 | `@cloudbase/node-sdk` mock + 内存 DB | cloud function handler 端到端（无网络调 MiniMax） |
| E2E 烟测 | curl + CloudBase HTTP 触发器 URL | 6 步 smoke（沿用 v0 §8） |

**关键变化**：v0 集成测试用 `@cloudflare/vitest-pool-workers`（Miniflare）；v1 用 `@cloudbase/node-sdk` mock。

**E2E 6 步 smoke**：
1. GET /health
2. POST /auth/admin-login → JWT
3. POST /upload（小 MD）→ { document_id, chunks: N }
4. GET /search?q=... → results
5. POST /ask → answer + citations
6. GET /stats/login-attempts

### 7.3 启动时硬验证

```typescript
// 云函数入口硬校验
const EMBEDDING_DIM = 1536;
const EXPECTED_KMS_KEYS = ['KEK_SECRET_V1'];

async function validateEmbeddingDim() {
  const testEmb = await embed(['test']);
  if (testEmb[0].length !== EMBEDDING_DIM) {
    throw new Error(`Embedding dim mismatch: expected ${EMBEDDING_DIM}, got ${testEmb[0].length}`);
  }
}

for (const k of EXPECTED_KMS_KEYS) {
  if (!process.env[k]) throw new Error(`${k} not configured`);
}
```

**好处**：部署后立即发现配置错误，不等用户第一次问问题。

### 7.4 监控（v1 简化）

| 监控项 | 工具 | 频率 |
|---|---|---|
| CloudBase 函数调用次数 | CloudBase 控制台 | 实时 |
| CloudBase 配额余量 | CloudBase 控制台 | 实时 |
| MiniMax API 用量 | platform.MiniMax.io dashboard | 实时 |
| 错误率 | CloudBase 函数日志 + grep `error` | 每天 |

**不做**（YAGNI / 超规模）：Datadog / Sentry / Grafana / 告警自动通知 / Performance 监控。

---

## 8. 成本估算 + Rollback + 封存 v0 实施

### 8.1 成本估算（亲友圈规模）

| 项目 | 费用 |
|---|---|
| CloudBase 免费额度 | ¥0（云函数 1000 次/天 + DB 2GB + 存储 5GB + CDN 5GB；亲友圈远不到）|
| MiniMax API | ¥0（年卡覆盖） |
| 域名 | ¥0（不买） |
| ICP 备案 | ¥0（不做，CloudBase 走微信内部网络） |
| 微信小程序个人认证 | ¥30/年（已付） |
| CF 封存资源保留 | ¥0 |

**月总成本**：**¥0**

### 8.2 Rollback 策略

**触发条件**：v1 部署失败 / v1 严重 bug / v1 不可达。

**Rollback 5 分钟**：

```bash
# 1. 改 mini-program apiBaseUrl 指回 v0
# 编辑 apps/miniprogram/app.ts:7
apiBaseUrl: "https://unequal-api.yydsnews.workers.dev",

# 2. 改 admin apiBaseUrl 指回 v0
# 编辑 apps/admin/.env.production
VITE_API_BASE_URL=https://unequal-api.yydsnews.workers.dev

# 3. CloudBase 控制台 disable api-cron-cleanup 定时触发器

# 4. commit + push（问用户）
```

**v0 资源保留**：CF Worker + D1 + Vectorize + R2 不动；admin_token + IP allowlist 同 v0；admin 走 VPN 访问。

### 8.3 封存 v0 实施清单

| # | 动作 |
|---|---|
| 1 | `git tag v0-cf-archived f623f66` |
| 2 | `git tag -m "CP-5 真接 Cloudflare 收尾版本；后续 cp-6 走 CloudBase 全量迁移"` |
| 3 | README.md 加 "v0 封存" 段（链向 state-cp5.md + 部署 URL） |
| 4 | `docs/superpowers/state-cp5.md` 加 "封存归档" 附录 |
| 5 | CF 资源**保留**（不销毁）|
| 6 | v0 commit + tag 推到 remote（如有）+ 问用户 |

**封存 ≠ 删除**：CF Worker URL 仍可达（admin VPN），代码 tag 可 checkout。

### 8.4 v0 销毁决策点

| 选项 | 何时 |
|---|---|
| **保留**（默认）| v1 部署失败需 rollback；新人参考 v0 设计 |
| **销毁** | v1 稳定运行 1 个月+；明确不再回 v0 |

**v1 收尾时 + 1 个月**让用户决策是否销毁 v0。

### 8.5 v1 收尾 + 移交 checklist（11 项）

1. CloudBase 环境创建 + 13 个函数部署
2. 4 secrets + 8 vars 注入
3. collection 创建 + index 建立
4. 9 个集合初始 schema
5. HTTP 触发器 URL 配到 mini-program + admin
6. 6 步 smoke 全过
7. 启动时硬验证（embedding dim + KEK 存在）
8. state-cp6.md 收尾
9. README v1 段
10. 封存 v0 tag 推到 remote
11. `git push` 问用户

---

## 9. Acceptance Criteria

### 9.1 功能 AC

- [ ] AC-1: 13 个 CloudBase 函数部署 + 触发器配
- [ ] AC-2: 4 secrets + 8 vars 注入 CloudBase 控制台
- [ ] AC-3: 9 个 collection 创建 + index 建立
- [ ] AC-4: 启动时硬验证通过（embedding dim = 1536 + KEK_SECRET_V1 存在）
- [ ] AC-5: mini-program `apiBaseUrl` 改 v1 URL
- [ ] AC-6: admin `VITE_API_BASE_URL` 改 v1 URL
- [ ] AC-7: 6 步 smoke 全过（curl CloudBase HTTP 触发器）
- [ ] AC-8: wx.cloud.callFunction 路径在 mock 测试中可调（cp-7 真机验证）
- [ ] AC-9: ADMIN_IP_ALLOWLIST 真实生效（curlbin 旁路验证 → 403）

### 9.2 关闭 AC

- [ ] AC-10: crawler 代码 0 改动，仅 env 配（apiBaseUrl + ADMIN_TOKEN）
- [ ] AC-11: v0 资源保留（CF Worker + D1 + Vectorize + R2）
- [ ] AC-12: v0 git tag `v0-cf-archived` 创建

### 9.3 文档 AC

- [ ] AC-13: `docs/superpowers/state-cp6.md` 收尾（含真实 CloudBase URL + smoke 输出 + 已知 issue）
- [ ] AC-14: README v1 段 + v0 封存段
- [ ] AC-15: `state-cp5.md` 加 "封存归档" 附录
- [ ] AC-16: `docs/superpowers/plans/2026-06-17-cp6-cloudbase-migration.md`（plan 文件，本 spec 通过后由 plan skill 生成）

### 9.4 dev 验证 AC（cp-6 之外）

- mini-program 真机扫码（cp-7 范围）
- CloudBase 定时触发器实际执行（cp-7+ 验证）

---

## 10. YAGNI / Explicit Non-Goals

- ❌ Mini-program 真机验证 → cp-7
- ❌ Custom domain / ICP 备案
- ❌ ANN 向量索引（HNSW / IVF）
- ❌ CloudBase 事务回滚
- ❌ 外部 APM（Datadog / Sentry / Grafana）
- ❌ KEK 轮换（M6.8 留口）
- ❌ 本地 vector DB 同步架构（[[project-future-local_vector_db_sync]]）
- ❌ v0 数据迁移（无数据）
- ❌ Presigned URL 直传云存储（4MB 内 HTTP 触发器足够）
- ❌ Embedding batch input（v2 优化）
- ❌ 单元测试新增（cp-6 主要重写，测试覆盖随实现自然展开）

---

## 11. References

- **Spec 1**：`docs/superpowers/specs/2026-06-16-cp5-real-cloudflare-design.md` (commit `863014a`)
- **Spec 2**：`docs/superpowers/state-cp5.md`（CP-5 收尾 + 封存附录待加）
- **Plan**：`docs/superpowers/plans/2026-06-16-cp5-real-cloudflare.md` (commit `2ecdc14`)
- **M6.10 spec**：`docs/superpowers/specs/2026-06-16-m6-10-admin-allowlist-design.md`（ADMIN_IP_ALLOWLIST 来源）
- **M6.3a state**：`docs/superpowers/state-m6-3a.md`（rate-limit / login_attempt 行为）
- **M6.8 spec**：`docs/superpowers/specs/2026-06-16-m6-9-token-mutex-design.md`（KEK fallback 行为）
- **项目 README**：`README.md`（v1 / v0 状态段待加）
- **Tencent CloudBase 文档**：https://docs.cloudbase.net/

---

## 附录 A：封存归档（写到 state-cp5.md）

CP-6 收尾时给 `state-cp5.md` 加如下附录：

```markdown
## 附录 X：v0 封存归档（2026-06-17）

cp-6 CloudBase 全量迁移完成后，v0 CF 部署进入封存状态。

- **git tag**：`v0-cf-archived` (commit `f623f66`)
- **CF 资源保留**：Worker / D1 / Vectorize / R2 均不销毁
- **回滚路径**：改 mini-program + admin apiBaseUrl 指回 `https://unequal-api.yydsnews.workers.dev`（5 分钟）
- **决策点**：v1 稳定运行 1 个月+ 后，让用户决策是否销毁 v0 资源

详见 `docs/superpowers/specs/2026-06-17-cp6-cloudbase-migration-design.md`
```

---

## 附录 B：wx.cloud.callFunction 与 HTTP 触发器选择

**为什么不全用 wx.cloud.callFunction**？
- admin 浏览器调用必须用 HTTP 触发器（admin 不是 mini-program）
- crawler CLI 调用也用 HTTP 触发器（不是 mini-program）
- 业务接口（ask/chat/upload）需 admin + mini-program 共用 → HTTP 触发器

**为什么不全用 HTTP 触发器**？
- mini-program 登录需要 WX_CONTEXT.openid（CloudBase 自动注入）
- HTTP 触发器不带 WX_CONTEXT，需手动传 openid 给后端
- 用 wx.cloud.callFunction 拿 openid 后，再调 HTTP 触发器带 openid → 2 次调用
- 或：直接用 wx.cloud.callFunction 做登录（自动 openid，1 次调用）

**结论**：混合使用：
- `api-auth-wx-login` 用 `wx.cloud.callFunction`（拿 openid）
- 其他业务接口用 HTTP 触发器（统一 admin + mini-program 调用路径）