# P3-7: 本地 Crawler + 手动推送闭环（admin MacBook → CloudBase /api-ingest）

**日期**：2026-06-22
**作者**：Mark + Claude (brainstorming 协作)
**状态**：✅ Design approved（5 节全部 user confirmed）
**Tag**：`cp7-p3-7-crawler-manual-push`
**前置**：
- admin-upload v2.3 spec (commit 5e63e41)
- state-arch-v2.3.md (admin 端不 embed，API 端自己 embed，5 状态机)
- CP-7-C #2 ingest_proxy 鉴权（requireIngestProxy 已在 apps/api/src/lib/auth-admin.ts）
- CP-7-D LLM Provider 抽象（commit ff77dd3，admin 端已部分实装）
- cp7-c4 db.add() 自动填 schema id（commit）

---

## 1. 摘要

admin MacBook **本地电脑**实现爬虫 + PDF 解析 + 产 markdown + chunks + embedding。**通过配置控制本地模型 vs 云端模型**（LLM Provider 抽象）。**本地 SQLite 暂存**后，admin **手动批量推送**数据到 CloudBase（`/api-ingest` 走 `X-Ingest-Proxy-Secret`）。

**3 种触发方式**（admin 每天任选）：
1. **每日定时**（launchd 凌晨 3 点全量跑）
2. **CLI 手动**（`pnpm -F crawler start --source=xhs --limit=10`）
3. **UI 启动**（admin-upload "补推列表" 页加 "启动爬虫" 按钮）

**核心范围增量**（vs admin-upload v2.3 已实现的单文件 happy path）：
- crawler 端：不直推云，**改写本地 SQLite**（替代现有 `apps/crawler/src/ingest.ts`）
- LLM Provider：抽到 `packages/local-llm/` 共享包，admin + crawler 同源
- admin UI：补推列表加 `source` 列（"upload" / "crawler"） + 启动爬虫按钮
- 失败处理：单条手动重试（不自动重试 5xx）
- launchd 集成：每日定时 plist + 失败回查

**不在范围**：
- minipgm 内增加任何上传入口（终端用户上传另议）
- `/api-ingest` v2 schema 实施（架构 v2.3 §5 描述，**当前 P3-7 不实装**）
- `/api-upload` v3 复活（仍 410 GONE）

---

## 2. 决策摘要

| 决策点 | 选择 | 原因 |
|---|---|---|
| **Crawler 推云方式** | 本地暂存 + 手动推（不直推） | 用户决策：先 review 再推 |
| **本地暂存表** | 复用 `local_ingest` + `source` 列 | 1 张表管 2 来源，UI 统一 |
| **鉴权** | `X-Ingest-Proxy-Secret` | 与 crawler / admin 现有路径对齐 |
| **手动推送粒度** | 过滤 + 批量选 + 批量推 | admin 体验最佳 |
| **爬虫触发** | 3 种全支持（每日定时 / CLI / UI） | 用户每天自己选 |
| **LLM Provider 抽象** | 抽 `packages/local-llm/` 共享包 | admin + crawler 同源，一份代码 |
| **手动推送 UI** | 补推列表加 source 列 | 不增新页面 |
| **失败处理** | 单条手动重试（不自动重试 5xx） | 避免 token 暴增 |
| **每日定时颗粒度** | 每天 1 个固定点全量跑 | 凌晨 3 点，可控 |
| **测试范围** | 单元 + 集成 + 真接 三套全跑 | 覆盖最全 |

---

## 3. 架构

### 3.1 总览

```
                    MacBook (本地)                              CloudBase (ap-shanghai)
                    ════════════════                            ══════════════════════

   触发源 (3 种)
   ├─ ① 每日定时 (launchd, 凌晨 3 点) ──┐
   ├─ ② CLI 手动 (pnpm -F crawler start --source=X) ──┐
   └─ ③ UI 启动 (admin-upload "启动爬虫" 按钮) ──────┤
                                                    ▼
                                        apps/crawler (src/main.ts)
                                        ├─ parser (cheerio / mineru / mammoth)
                                        ├─ LocalEmbedderV2 (本地 OMLX bge-m3)
                                        └─ ingest-sqlite (新): 不直推云 ──┐
                                                                              │
                                                                              ▼
                                                        ┌──────────────────────────┐
                                                        │ CloudPusher (复用 admin) │
                                                        │   header: X-Ingest-      │
                                                        │   Proxy-Secret           │
                                                        └──────────────────────────┘
                                                                              │
                                                                              │ (P3-7 关键:
                                                                              │  这一步改为手动)
                                                                              ▼
                                              local_ingest 表 (SQLite, .tmp/)
                                              ├─ source = 'crawler' / 'upload'
                                              ├─ status (pending/parsing/chunking/pushing/done/failed)
                                              ├─ markdown + chunks_json
                                              ├─ cloud_source_id? / cloud_document_id? (推送后回填)
                                              └─ error_code? / error_message? / retry_count
                                                                              ▲
                                                                              │ (admin 手动推送)
                                                                              │
                                              ┌───────────────────────────────┴──────┐
                                              │ admin-upload UI "补推列表" 页         │
                                              │ ├─ 过滤 source=crawler                │
                                              │ ├─ 勾选 N 条                          │
                                              │ ├─ (可选) 改 trust_level               │
                                              │ ├─ 点"批量推送"                       │
                                              │ └─ 后台 N 个 CloudPusher.push          │
                                              └───────────────────────────────────────┘
                                                                              │
                                                                              │ CloudPusher.push
                                                                              ▼
                                              /api-ingest (POST, X-Ingest-Proxy-Secret)
                                                  → 自己 chunk + embed (架构 v2.3)
                                                  → 返 { source_id, document_id, chunks_inserted }
                                                  → 5 状态机 (api-ingest 内)
                                                                              │
                                                                       (回填 cloud_source_id)
                                                                              │
                                              ┌───────────────────────────────┘
                                              │
                                              ▼
                                          local_ingest.status = 'done'

   LLM Provider 共享包
   ┌─────────────────────────────────────────────────────────────────────┐
   │ packages/local-llm/  (P3-7 新增)                                     │
   │ ├─ provider.ts (createEmbedder / createChat, env 驱动)              │
   │ ├─ local-embedder.ts (OMLX bge-m3)                                  │
   │ ├─ cloud-embedder.ts (MiniMax embo-01)                              │
   │ ├─ local-chat.ts (OMLX Qwen3.6 35B-A3B)                             │
   │ ├─ cloud-chat.ts (MiniMax abab)                                     │
   │ ├─ config.ts (env 解析)                                              │
   │ └─ types.ts (Embedder / Chat interface)                              │
   │                                                                     │
   │ admin server/llm-provider.ts → re-export from @unequal/local-llm   │
   │ crawler src/embedder.ts → use @unequal/local-llm                    │
   └─────────────────────────────────────────────────────────────────────┘

   定时任务 (launchd, 每日凌晨 3 点)
   └─ pnpm -F crawler start --full-scan --source=all
       → 跑完入 SQLite, status=pending, admin 早上点推送
```

### 3.2 关键设计点

1. **crawler 不直推云** —— P3-7 核心改动（crawler 现在 `apps/crawler/src/ingest.ts` 是直推云的）
2. **共享包 `packages/local-llm`** —— admin + crawler 都依赖同一份 LLM Provider 抽象
3. **local_ingest 表复用 + source 列** —— 一张表管两个来源
4. **admin UI 补推列表加 source 列** —— 不增新页面
5. **状态机说明** —— admin-upload 走 5 态机（pending→parsing→chunking→pushing→done），crawler 走 3 态机（pending→pushing→done/failed），详见 §3.3
6. **3 种触发** —— 共享同一个 crawler main.ts，触发只决定"何时跑"

### 3.3 状态机说明（澄清）

`local_ingest.status` 有 7 个 enum 值：`pending | parsing | chunking | pushing | done | failed`。

- **admin-upload 路径**（source='upload'）：走 `pending → parsing → chunking → pushing → done` 5 态机（admin-upload spec §3.3，arch-v2.3 修正后无 embedding 阶段）
- **crawler 路径**（source='crawler'）：**只走 `pending → pushing → done/failed`** 3 态机
  - `parsing` / `chunking` 状态在 crawler 进程内跑完，crawler 写 SQLite 时已经处于 `pending` 等待手动推
  - admin 手动推时 → `pushing` → 成功 `done` / 失败 `failed`
  - **没有** `parsing` / `chunking` 状态（admin-upload UI 状态机展示对 crawler 无意义）
  - 失败重试：`failed → pushing → done/failed`，重试次数记 `retry_count`

---

## 4. 组件清单

| 组件 | 路径 | Action | 职责 |
|---|---|---|---|
| **CrawlerIngestAdapter** | `apps/crawler/src/ingest-sqlite.ts` (新) | 新建 | 替代现有 `ingest.ts`；不调云，写 local_ingest |
| **CrawlerTrigger** | `apps/crawler/src/trigger.ts` (新) | 新建 | CLI / launchd / UI 三种触发统一入口 |
| **LocalEmbedderV2** | `packages/local-llm/src/local-embedder.ts` (新) | 新建（迁移自 admin）| OMLX bge-m3 1536 维 |
| **CloudEmbedderV2** | `packages/local-llm/src/cloud-embedder.ts` (新) | 新建（迁移自 admin）| MiniMax embo-01 1536 维 |
| **LocalChatV2** | `packages/local-llm/src/local-chat.ts` (新) | 新建 | OMLX Qwen3.6 35B-A3B 4bit |
| **CloudChatV2** | `packages/local-llm/src/cloud-chat.ts` (新) | 新建 | MiniMax abab |
| **ProviderFactory** | `packages/local-llm/src/provider.ts` (新) | 新建 | env-driven `createEmbedder` / `createChat` |
| **LocalLLMConfig** | `packages/local-llm/src/config.ts` (新) | 新建 | env 解析（OMLX_BASE_URL / MiniMax_API_KEY 等） |
| **LocalLLMPackage** | `packages/local-llm/package.json` (新) | 新建 | monorepo workspace 成员 |
| **IngestSchema** | `packages/local-llm/src/types.ts` (新) | 新建 | `Embedder` / `Chat` interface 共享类型 |
| **AdminLLMProviderBridge** | `apps/admin/server/llm-provider.ts` (改) | UPDATE | `re-export from @unequal/local-llm`（保持向后兼容）|
| **LocalEmbedderLegacy** | `apps/admin/server/local-embedder.ts` (删) | DELETE | 迁到 packages |
| **CloudEmbedderLegacy** | `apps/admin/server/cloud-embedder.ts` (删) | DELETE | 同上 |
| **EmbedderFactoryLegacy** | `apps/admin/server/embedder-factory.ts` (删) | DELETE | 同上 |
| **StatusStore** | `apps/admin/server/status-store.ts` (改) | UPDATE | 表 schema 加 `source TEXT DEFAULT 'upload'` |
| **LocalIngestMiddleware** | `apps/admin/server/local-ingest.ts` (改) | UPDATE | `/api/manual-push` / `/api/crawler/start` / `/api/retry` 扩展兼容 source=crawler |
| **UploadPage** | `apps/admin/src/pages/Upload.tsx` (改) | UPDATE | 补推列表加 source 列过滤 + 启动爬虫按钮 |
| **launchd plist** | `scripts/com.unequal.crawler.daily.plist` (新) | 新建 | 凌晨 3 点定时启 crawler |
| **CrawlerIngestLegacy** | `apps/crawler/src/ingest.ts` (删) | DELETE | 改为 ingest-sqlite（直推云路径被 P3-7 替代）|

### 4.1 关键接口

```typescript
// packages/local-llm/src/types.ts
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}
export interface Chat {
  chat(messages: ChatMessage[]): Promise<string>;
}
export type EmbedderProvider = "local" | "cloud" | "auto";
export type ChatProvider = "local" | "cloud" | "auto";
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// packages/local-llm/src/provider.ts
export function createEmbedder(provider?: EmbedderProvider): Embedder;
export function createChat(provider?: ChatProvider): Chat;

// packages/local-llm/src/config.ts
export interface LocalLLMConfig {
  embed: {
    provider: "local" | "cloud" | "auto";
    omlxBaseUrl?: string;
    omlxApiKey?: string;
    omlxEmbedModel?: string;
    cloudApiKey?: string;
    cloudEmbedModel?: string;
  };
  chat: {
    provider: "local" | "cloud" | "auto";
    omlxBaseUrl?: string;
    omlxApiKey?: string;
    omlxChatModel?: string;
    cloudApiKey?: string;
    cloudChatModel?: string;
  };
}
export function loadLocalLLMConfig(): LocalLLMConfig;

// apps/crawler/src/ingest-sqlite.ts（替代 ingest.ts）
export interface CrawlerIngestInput {
  source: "xhs" | "wechat-mp" | "webpage";
  url: string;
  title?: string;
  markdown: string;
  chunks: Array<{
    content: string;
    embedding: number[];
    idx: number;
    token_count: number;
  }>;
  trust_level: 0 | 1 | 2 | 3;
  metadata?: {
    crawl_depth?: number;
    source_domain?: string;
    crawled_at?: number;
    parent_url?: string;
  };
}
export interface CrawlerIngestResult {
  file_id: string;
  status: "pending";
}
export async function ingestCrawlerMarkdown(
  input: CrawlerIngestInput,
): Promise<CrawlerIngestResult>;

// apps/crawler/src/trigger.ts
export interface TriggerOptions {
  source?: "xhs" | "wechat-mp" | "webpage" | "all";
  url?: string;
  since?: number;
  until?: number;
  limit?: number;
  fullScan?: boolean;
  stdoutLog?: string;
}
export async function runCrawler(opts: TriggerOptions): Promise<{
  total: number;
  succeeded: number;
  failed: number;
  file_ids: string[];
}>;
```

### 4.2 StatusStore 表 schema 改动

```sql
-- apps/admin/.tmp/unequal.db
ALTER TABLE local_ingest ADD COLUMN source TEXT NOT NULL DEFAULT 'upload';
-- 'upload' = admin-upload 拖入文件
-- 'crawler' = crawler 爬出 markdown
CREATE INDEX idx_source_status ON local_ingest(source, status);
```

```typescript
// apps/admin/server/status-store.ts
type FileStatus = {
  ...existing,
  source: "upload" | "crawler";
  metadata?: {
    crawl_depth?: number;
    source_domain?: string;
    crawled_at?: number;
    parent_url?: string;
  };
};
```

---

## 5. 数据流

### 5.1 happy path：每日定时 凌晨 3 点

```
launchd 启 pnpm -F crawler start --full-scan --source=all
            ↓
CrawlerTrigger.runCrawler({fullScan: true, source: "all"})
  // 注意：crawler 进程同步跑完所有 50 条 → 入 SQLite → 才退出
  // 不留后台任务，进程退出 = 50 条全部 status=pending
  1. 读 source 列表 (xhs / wechat-mp / webpage)，全量抓
  2. parser 解析 → markdown
  3. chunkText → chunks[]
  4. LocalEmbedderV2.embedBatch(chunks) (provider = env-driven, 默认 auto = OMLX)
            ↓
  对每条 markdown:
    ingestCrawlerMarkdown({url, title, markdown, chunks, trust_level=1, metadata})
            ↓
    StatusStore.create({
      file_id: newId(),
      source: "crawler",
      status: "pending",
      markdown, chunks_json, metadata
    })
            ↓
  return { total: 50, succeeded: 48, failed: 2, file_ids: [...] }
            ↓
launchd 进程退出（已确认 50 条全部入 SQLite）
admin 早上 9 点起来打开 admin dev
```

### 5.2 happy path：admin 手动批量推送

```
admin 打开 admin-upload "补推列表" 页
            ↓
页面 onLoad:
  GET /api/ingest-status?source=crawler&status=pending
            ↓
LocalIngestMiddleware.handleStatus({source: "crawler", status: "pending"})
  → StatusStore.list({source: "crawler", status: "pending"})
  → 返 { batch_id, files: [50 条 FileStatus] }
            ↓
UI 显示 50 条带 checkbox + source 列 "crawler" + trust_level 列（可改）
admin 勾选 30 条 → 点 "批量推送"
            ↓
POST /api/manual-push { file_ids: [...], trust_level_overrides?: { [file_id]: level } }
            ↓
LocalIngestMiddleware.handleManualPush(file_ids)
  for each file_id:
    record = StatusStore.get(file_id)
    if record.status !== "pending": skip (UI 已自动过滤)
    StatusStore.update(file_id, {status: "pushing", retry_count++})
    CloudPusher.push({                             ← admin-upload 已实现的
      content: record.markdown,
      title: record.title,
      url: record.url,
      trust_level: trust_level_overrides[file_id] ?? record.trust_level,
      user_id: env.DEFAULT_USER_ID
    })
            ↓
    成功: StatusStore.update(file_id, {status: "done", cloud_source_id, cloud_document_id})
    失败: StatusStore.update(file_id, {status: "failed", error_code, error_message, retryable: true})
            ↓
  return { pushed: 28, failed: 2 }
            ↓
UI 刷新: 28 done + 2 failed（failed 行带 "重试" 按钮）
```

### 5.3 happy path：失败单条重试

```
admin 点 failed 行的 "重试" 按钮
            ↓
POST /api/retry { file_id }
            ↓
LocalIngestMiddleware.handleRetry(file_id)
  record = StatusStore.get(file_id)
  if record.status !== "failed" or !record.retryable: 400
  StatusStore.update(file_id, {status: "pushing", retry_count++})
  CloudPusher.push(...)                                 ← 同 §5.2
  成功 / 失败 → 更新状态
            ↓
UI 刷新
```

### 5.4 happy path：CLI 手动爬

```
$ pnpm -F crawler start --source=xhs --since=1748000000000 --limit=10
            ↓
CrawlerTrigger.runCrawler({source: "xhs", since: 1748000000000, limit: 10})
  抓 xhs 最近 10 条（自 1748000000000 以来）
  解析 + chunk + embed（同 §5.1）
  ingestCrawlerMarkdown × 10 次
            ↓
打印: "10 crawled, 10 ingested to local SQLite (status=pending, awaiting manual push)"
退出码: 0
```

### 5.5 happy path：UI 启动爬虫

```
admin 点 "启动爬虫" 按钮 → 选 source="xhs" + limit=20
            ↓
POST /api/crawler/start { source: "xhs", limit: 20 }
            ↓
LocalIngestMiddleware.handleCrawlerStart({source, limit})
  spawn child_process: pnpm -F crawler start --source=xhs --limit=20
  不等子进程完成，返 { process_id, status: "started" }
            ↓
UI 轮询 GET /api/crawler/status?process_id=X (每 2s 一次)
  → 显示 "爬取中... 5/20"
            ↓
子进程退出后:
  StatusStore.list({source: "crawler", status: "pending", batch_id=process_id})
  UI 显示 "20 条新暂存，去推送"
```

### 5.6 单条数据流细节（ingestCrawlerMarkdown → StatusStore.create → 等待推送）

```
ingestCrawlerMarkdown(input: CrawlerIngestInput):
  // 1. 解析 + 校验
  validate(input);                              // url / markdown / chunks 非空

  // 2. 嵌入检测（trust_level 是 caller 决定，不是自动）
  if input.chunks.length === 0: throw "NO_CHUNKS";
  for c in chunks: validate embedding dim = 1536;

  // 3. 写 SQLite
  file_id = newId();
  StatusStore.create({
    file_id, source: "crawler",
    status: "pending",
    markdown: input.markdown,
    chunks_json: JSON.stringify(input.chunks),   // 暂存避免重 embed
    url: input.url,
    title: input.title,
    trust_level: input.trust_level,
    metadata: input.metadata
  });

  return { file_id, status: "pending" };
```

---

## 6. 错误处理

### 6.1 错误分类 + 策略

| 阶段 | 错误类型 | 自动重试 | 用户操作 |
|---|---|---|---|
| **crawler 爬** | 404 / 反爬 / 网络瞬断 | ✅ 3 次（退避 1/3/10s）| 失败 1 条不影响其他 |
| **crawler 解析** | HTML 异常 / mineru 失败 | ❌ 0 次 | 入库 status=failed + error |
| **embed** | OMLX 不可达 / OOM | ✅ 1 次（auto mode → 切 cloud）| 切 cloud 仍失败才 status=failed |
| **embed** | cloud MiniMax 401 / 5xx | ❌ 0 次（防止爆 token）| UI 提示"补 MiniMax key" |
| **写 SQLite** | 文件锁 / 磁盘满 | ❌ 0 次 | 致命 + 日志（不入库）|
| **admin UI 推送** | 4xx auth | ❌ 0 次 | UI "重登 / 查 proxy secret" |
| **admin UI 推送** | 5xx server | ❌ 0 次（避免 token 暴增）| UI "重试" 单条按钮 |
| **admin UI 推送** | 429 限流 | ❌ 0 次 | UI "重试" 单条按钮（带提示：稍后重试）|
| **admin UI 推送** | 413 payload > 5MB | ❌ 0 次 | UI "重试前请裁切 markdown" 提示 |

### 6.2 推送去重（防止重复入 CloudBase）

```
推送前:
  if StatusStore.get(file_id).cloud_source_id:
    skip + log "already pushed, cloud_source_id=..."
    UI 显示 "已推送过" 不再可重试
```

### 6.3 单条手动重试上限

- 单条失败后 admin 手动点"重试"，**不自动重试**（与 §6.1 5xx 0 次自动重试策略一致）
- 单条 `retry_count >= 3` → `retryable=false`（不再可手动重试，admin 需删除或重置）
- 推送时遇到 `trust_level_overrides` 改 → UI 显示"已覆盖原 trust_level=X"

### 6.4 launchd 定时失败处理

- launchd 任务失败 → `/tmp/unequal-crawler.log` 写错误
- 第二天 admin 打开 UI → `/api/crawler/recent-runs` 返最近 7 天 run history
- 失败任务标红 + "重跑" 按钮（调 trigger.ts CLI 重跑）

### 6.5 LLM Provider 切换

```
auto mode (默认):
  probe OMLX_BASE_URL/health → 通则 local，否则 cloud
  连续 3 次 local 失败 → 切 cloud（整个进程只切一次）
  cloud 失败 → 不再切回 local（防止循环）
```

### 6.6 网络约束

- crawler 跑在 admin MacBook 上：本地无 GFW 限制
- CloudBase HTTP 触发器：从 MacBook 调用，国内可达（CP-6 已验证）
- launchd 启动 pnpm 进程：用户本机环境，无需 ICP 备案
- admin UI 通过 admin dev (5173) 访问：admin-upload spec §1 已说明

---

## 7. 测试

### 7.1 测试金字塔

| 层级 | 数量 | 工具 | 覆盖 |
|---|---|---|---|
| **单元** | ~30 | vitest | `provider.ts` 工厂 / `local-llm-config` env 解析 / `ingestCrawlerMarkdown` SQLite 写入 / `LocalEmbedder` / `CloudEmbedder` / StatusStore source 列 / Trigger 参数校验 |
| **集成** | ~10 | vitest + supertest | admin dev middleware `/api/manual-push` / `/api/crawler/start` / `/api/retry` 端到端 mock cloud |
| **真接** | 5 场景 | manual + curl | CLI 跑爬 + admin UI 批量推 + CloudBase 验证 + 启动爬虫 + launchd 定时 |

### 7.2 关键单元测试

```typescript
// packages/local-llm/test/provider.test.ts
describe("createEmbedder (P3-7)", () => {
  it("provider=local → 返 LocalEmbedder (OMLX)", () => {});
  it("provider=cloud → 返 CloudEmbedder (MiniMax)", () => {});
  it("provider=auto + OMLX 可达 → 返 LocalEmbedder", () => {});
  it("provider=auto + OMLX 不可达 → 返 CloudEmbedder", () => {});
  it("无任何 provider env → 抛错", () => {});
});

// apps/crawler/test/ingest-sqlite.test.ts
describe("ingestCrawlerMarkdown (P3-7)", () => {
  it("写 SQLite 成功 → file_id 返 + status=pending", () => {});
  it("chunks 为空 → 抛 NO_CHUNKS", () => {});
  it("embedding dim != 1536 → 抛 DIM_MISMATCH", () => {});
  it("metadata.crawl_depth 正确存", () => {});
  it("source='crawler' 字段正确填", () => {});
});

// apps/admin/test/status-store.test.ts
describe("StatusStore source 列 (P3-7)", () => {
  it("create 默认 source='upload'", () => {});
  it("create with source='crawler'", () => {});
  it("list({source: 'crawler'}) 只返 crawler", () => {});
  it("list({source: 'upload'}) 只返 upload", () => {});
});

// apps/crawler/test/trigger.test.ts
describe("CrawlerTrigger.runCrawler (P3-7)", () => {
  it("--source=xhs --limit=10 → 跑 10 条", () => {});
  it("1 条爬失败不影响其他 9 条", () => {});
  it("--full-scan → 全量跑", () => {});
});
```

### 7.3 集成测试

```typescript
// apps/admin/test/local-ingest-manual-push.test.ts
describe("/api/manual-push (P3-7)", () => {
  it("推送 5 条 pending → 返 {pushed: 5, failed: 0}", async () => {
    // mock CloudPusher 成功 5 次
    // 验证 StatusStore 5 条变 done
  });
  it("推送 3 条 + 第 2 条 mock 失败 → 返 {pushed: 2, failed: 1}", async () => {});
  it("推送包含非 pending 记录 → 跳过 + 返 {skipped: 1}", async () => {});
  it("推送带 trust_level_overrides → 信任级正确传", async () => {});
});

describe("/api/crawler/start (P3-7)", () => {
  it("spawn 子进程 pnpm -F crawler start --source=xhs --limit=10", async () => {});
  it("子进程 exit 0 → 返 process_id + status=started", async () => {});
  it("子进程 exit 1 → 返 process_id + status=failed + stderr", async () => {});
});

describe("/api/retry (P3-7 retry source=crawler)", () => {
  it("failed + retryable → 重推 + status 变 done / failed", async () => {});
  it("failed + retry_count >= 3 → 400 NOT_RETRYABLE", async () => {});
});
```

### 7.4 真接测试

```bash
# 1. CLI 跑爬 + 暂存
pnpm -F crawler start --source=xhs --limit=5
sqlite3 apps/admin/.tmp/unequal.db "SELECT file_id, status, source FROM local_ingest WHERE source='crawler'"
# 期望: 5 行，status=pending, source=crawler

# 2. admin UI 批量推
# - 启 admin dev: pnpm -F admin dev
# - 浏览器 http://localhost:5173/upload
# - 切到"补推列表" tab，过滤 source=crawler
# - 勾选 5 条 → 点"批量推送"
# - 验证: 5 条 status=done + cloud_source_id 已填
# - CloudBase 控制台: 5 source + 5 document + chunks

# 3. 失败 + 重试
# - mock CloudPusher 5xx 一次
# - 验证 1 条 status=failed + retryable=true
# - UI 点"重试" → mock 解除 → 成功

# 4. UI 启动爬虫
# - 浏览器 admin-upload 页点 "启动爬虫" → 选 xhs + limit=3
# - 验证: 子进程启 → 3 条入 SQLite → UI 显示 "3 条新暂存"

# 5. launchd 定时
# - 加载 plist: launchctl load scripts/com.unequal.crawler.daily.plist
# - 等到凌晨 3 点 (或临时改 plist 为下一分钟)
# - 验证: 跑完 + 入 SQLite + 写 /tmp/unequal-crawler.log
```

### 7.5 累计测试数

- packages/local-llm: ~25（新增）
- apps/crawler: 29 → ~38（+9 单元）
- apps/admin: 141 → ~155（+14：source 列 / manual-push / crawler/start / retry 扩展）
- **总: 406 → ~465（净 +59）**

---

## 8. 实施计划（4 phase）

### Phase A: 抽 packages/local-llm 共享包（1-2 天）
- 新建 `packages/local-llm/`
- 迁移 admin 现有 LocalEmbedder / CloudEmbedder / EmbedderFactory
- 补 LocalChat / CloudChat（Qwen3.6 35B-A3B / MiniMax abab）
- 补 `createChat` factory
- 删 admin 端 legacy 文件（local-embedder.ts / cloud-embedder.ts / embedder-factory.ts）
- admin server/llm-provider.ts 改 re-export
- 单元测试覆盖 provider.ts 5 个 case + 配置解析
- 回归：确保 admin 当前 141 测试仍 PASS

### Phase B: crawler 改写本地暂存（1-2 天）
- 新建 `apps/crawler/src/ingest-sqlite.ts`
- 删 `apps/crawler/src/ingest.ts`（直推云路径）
- 新建 `apps/crawler/src/trigger.ts`（CLI / launchd / UI 统一入口）
- `apps/crawler/src/main.ts` 改调 trigger.ts
- crawler 依赖 `@unequal/local-llm`
- 单元测试覆盖 ingest-sqlite + trigger

### Phase C: admin UI 扩展（1 天）
- StatusStore 加 `source` 列 + index
- `local-ingest.ts` middleware 加 `/api/manual-push` / `/api/crawler/start` / `/api/retry` 扩展
- 修 `Upload.tsx`：补推列表加 source 列过滤 + 启动爬虫按钮 + 重试按钮
- 单元 + 集成测试覆盖 middleware

### Phase D: launchd 集成（半天）
- 新建 `scripts/com.unequal.crawler.daily.plist`（凌晨 3 点全量）
- 加 `pnpm` 入口脚本 `scripts/run-daily-crawler.sh`
- 真接测试 5 场景
- 更新 state-cp7-zhenjie.md §10 P3 进度

---

## 9. References

- admin-upload v2.3 spec: `docs/superpowers/specs/2026-06-22-admin-upload-page-design.md`
- arch-v2.3: `docs/superpowers/state-arch-v2.3.md`（admin 不 embed / API 自己 embed / 5 状态机）
- CP-7-C #2 ingest_proxy 鉴权: `apps/api/src/lib/auth-admin.ts:36-73`
- CP-7-C #4 db.add() autoid: `docs/superpowers/specs/2026-06-21-cp7-c4-db-add-autoid-design.md`
- CP-7-D LLM Provider 抽象: `apps/admin/server/llm-provider.ts` (commit ff77dd3)
- state-cp7-zhenjie: `docs/superpowers/state-cp7-zhenjie.md` §10 P3 进度
- crawler 当前 ingest: `apps/crawler/src/ingest.ts` (直推云 — P3-7 替代)
- CloudPusher 现有实现: `apps/admin/server/cloud-pusher.ts` (复用)
- 微信小程序上传 API: 暂不在 P3-7 范围

---

## 10. Open Questions（已解决）

| Q | 答案 |
|---|---|
| 目标用户 | 仅 admin 内部用（minipgm 不增入口）|
| 上传后行为 | 本地解析 + 暂存 + 手动推送 |
| 本地暂存表 | 复用 `local_ingest` + `source` 列 |
| 鉴权方式 | `X-Ingest-Proxy-Secret` |
| 推送粒度 | 过滤 + 批量选 + 批量推 |
| 爬虫触发 | 3 种全支持（每日定时 / CLI / UI）|
| LLM Provider | 抽 `packages/local-llm/` 共享包 |
| UI 入口 | 补推列表加 source 列（不增新页面）|
| 错误恢复 | 失败单条手动重试 |
| 定时颗粒度 | 每天 1 个固定点（凌晨 3 点）全量跑 |
| 测试范围 | 单元 + 集成 + 真接 三套全跑 |

---

**最后更新**：2026-06-22 design 完成（5 节 + 12 问 + 10 节 spec）
