# Design: admin 本地上传文件页面

**日期**：2026-06-22
**作者**：Mark + Claude (brainstorming 协作)
**状态**：✅ Design approved（5 节全部 user confirmed）
**决策基础**：arch-v2.md / arch-v2.1.md（本地处理 + 统一 markdown 中间格式）

---

## 1. 背景

### 1.1 现状问题
- `apps/admin/src/pages/Upload.tsx` 已存在 92 行
- `vite.config.ts` proxy 仍指向 `localhost:8787`（CF Workers 早停了，CP-6 迁 CloudBase 后失效）
- 现有 admin 上传功能**实际 broken**（admin 点上传 → vite proxy → 8787 无人 → 失败）
- pdf-parse@1.1.1 内嵌 pdf.js v1.10.100（2017），中文 PDF 解析率 ~0%（实测）

### 1.2 用户需求
> "本地上传文件的页面，方便上传解析，入库以及推到云端的操作"

**分解**：
1. 本地上传：admin web UI 接受文件
2. 本地解析：PDF 用 mineru / docx 用 mammoth / 网页用 cheerio → markdown
3. 本地 chunk + embed
4. 推到云端：通过 `/api-ingest` 推送到 CloudBase

### 1.3 Mac 配置
- **MacBook M1 Pro 32GB**
- 已装：**mineru**（PDF 解析，Python 工具链）
- 已装：**Gemma 4 12B IT (4-bit + 8-bit)**（备选，最终不用）
- 已装：**Ollama**（备选，最终不用）
- **OMLX**（Apple MLX 优化 runtime，最终使用）

---

## 2. 决策摘要

| 决策点 | 选择 | 原因 |
|---|---|---|
| **Server 架构** | Vite middleware（同进程 5173）| 简单 + 零额外进程 |
| **PDF → md 库** | mineru（用户已装）| 业界 SOTA + 中文强 |
| **爬虫解析 LLM** | **Qwen3.6 35B-A3B 4bit**（mlx-community, ~11.5GB）| 2025 末最新 + 中文 SOTA + 工具调用 ★★★★★ + MoE 激活少（3B）速度也快 |
| **Embedding** | bge-m3 (mlx-community, 1.2GB, 1536 dim matryoshka) | 兼容现有 1536 维数据 |
| **LLM runtime** | OMLX（Apple MLX 优化）| M1 Pro 性能优 30-50% + 内存省 1-2GB |
| **上传后行为** | 上传即推云（自动）| happy path 一步到位 |
| **本地暂存** | SQLite + 补推 UI | 失败可重推 + 历史可查 |
| **并发模型** | 3 semaphore（parser=1, embed=3, push=5）| mineru 1 本/次；embed/push 可并行 |
| **状态机** | 6 状态 (pending→parsing→chunking→embedding→pushing→done) | 精细进度可见 |
| **Fallback** | OMLX → 云端 MiniMax（3 次失败后切换）| 瞬错恢复 + 累计失败保护 |

---

## 3. 架构 + 数据流

### 3.1 架构总览

```
admin dev (5173)
├─ 前端 (Upload.tsx) — 拖入 + 实时进度 + 补推列表
├─ Vite middleware (local-ingest.ts)
│   ├─ POST /api/upload (multipart)
│   ├─ GET /api/ingest-status?batch_id=X
│   └─ POST /api/retry?file_id=X
├─ IngestOrchestrator
│   ├─ LocalParser (PDF/DOCX/HTML/TXT/MD → markdown)
│   ├─ StatusStore (SQLite WAL)
│   ├─ LocalEmbedder (OMLX bge-m3 → 1536 维)
│   ├─ CloudPusher (POST /api-ingest markdown + chunks)
│   └─ FallbackDetector (OMLX 失败计数)
├─ ConcurrencyGate (3 个 semaphore)
│   ├─ parserSem: max 1 (mineru 1 本/次)
│   ├─ embedSem: max 3 (OMLX 限流)
│   └─ pushSem: max 5 (CloudBase HTTP)
├─ SQLite (.tmp/unequal.db)
│   └─ local_ingest 表 (status machine)
└─ OMLX runtime (port 11434, OpenAI 兼容)
    ├─ Qwen 2.5 14B (mlx-community)
    └─ bge-m3 (mlx-community)

→ CloudBase
    └─ /api-ingest 接收 markdown + chunks
```

### 3.2 单文件 happy path 数据流

```
User drops "weaning.pdf" + clicks "上传"
            ↓
UploadPage.onSubmit()
  FormData(file + trust_level) → POST /api/upload
            ↓
LocalIngestMiddleware.handleUpload()
  ├─ 解析 multipart → { file_id, tmp_path, ext }
  ├─ StatusStore.create(file_id, status="parsing")
  ├─ IngestOrchestrator.processFile(file_id) (后台 promise)
  │      ├─ 解析 (ConcurrencyGate.parserSem, max=1)
  │      │   └─ LocalParser.parseAuto(tmp_path, ext)
  │      │       └─ mineru parse → markdown
  │      ├─ StatusStore.update(status="chunking", markdown_chars=N)
  │      ├─ chunkText(markdown)
  │      ├─ StatusStore.update(status="embedding", chunks_count=N)
  │      ├─ LocalEmbedder.embedBatch(chunks)
  │      │   └─ OMLX bge-m3 (ConcurrencyGate.embedSem, max=3)
  │      ├─ StatusStore.update(status="pushing")
  │      ├─ CloudPusher.push({markdown, chunks, source_meta})
  │      │   └─ POST /api-ingest (pushSem, max=5, retry 5xx/429)
  │      ├─ StatusStore.update(status="done", cloud_source_id, cloud_document_id)
  │      └─ return { source_id, document_id }
  └─ 立即返 202 { batch_id, files: [{file_id, status:"pending"}] }
            ↓
Client polls GET /api/ingest-status every 1s
            ↓
UI 实时显示进度 (pending → parsing → chunking → embedding → pushing → done)
```

### 3.3 多文件并发流

```
User drops 5 PDFs
            ↓
middleware 创建 5 个 IngestOrchestrator.processFile
            ↓
Promise.allSettled([t1, t2, t3, t4, t5])
  ├─ parserSemaphore (max=1): t1 先解析, t2-t5 等
  │   t1 done → t2 start, t1 → chunking
  ├─ chunking: 无 semaphore (CPU bound, 顺序快)
  ├─ embeddingSemaphore (max=3): 3 并发 embed
  ├─ pushSemaphore (max=5): 5 并发 push
            ↓
5 条 SQLite status="done"
```

### 3.4 资源预算（M1 Pro 32GB）

| 组件 | RAM |
|---|---|
| Qwen3.6 35B-A3B 4bit (MoE 激活 3B) | 11.5 GB |
| bge-m3 | 1.2 GB |
| mineru (CPU) | 2 GB |
| OS + 浏览器 | 8 GB |
| admin dev server | 0.5 GB |
| **余量** | **8.8 GB** |
| **总计** | 32 GB ✅ |

---

## 4. 组件清单

| 组件 | 路径 | 依赖 | 职责 |
|---|---|---|---|
| **UploadPage** | `apps/admin/src/pages/Upload.tsx` (修) | React + Vite | UI: 拖入 + 进度 + 补推列表 |
| **LocalIngestMiddleware** | `apps/admin/server/local-ingest.ts` (新) | Vite middleware | POST/GET/RETRY endpoints |
| **LocalParser** | `apps/admin/server/local-parser.ts` (新) | mineru + mammoth + cheerio | 5 类文件 → markdown |
| **LocalEmbedder** | `apps/admin/server/local-embedder.ts` (新) | OMLX client (OpenAI SDK) | markdown chunks → embeddings |
| **CloudPusher** | `apps/admin/server/cloud-pusher.ts` (新) | fetch + CloudBase creds | chunks → /api-ingest |
| **StatusStore** | `apps/admin/server/status-store.ts` (新) | better-sqlite3 | SQLite 暂存 + status |
| **IngestOrchestrator** | `apps/admin/server/ingest-orchestrator.ts` (新) | LocalParser + LocalEmbedder + CloudPusher + StatusStore | 单文件 6 状态机调度 |
| **ConcurrencyGate** | `apps/admin/server/concurrency-gate.ts` (新) | Promise + semaphore | 3 个限流器 |
| **FallbackDetector** | `apps/admin/server/fallback-detector.ts` (新) | 错误计数 | OMLX→云端 切换 |

### 4.1 关键接口

```typescript
// LocalParser
type Ext = "pdf" | "docx" | "html" | "txt" | "md";
type ParseAutoFn = (tmpPath: string, ext: Ext) => Promise<string>;
type ParseError = "ParseFailed" | "UnsupportedExt" | "EncryptedFile" | "OOM";

// LocalEmbedder
type EmbedBatchFn = (texts: string[]) => Promise<number[][]>;  // [[1536-dim], ...]
type EmbedError = "OMLX_Unavailable" | "OOM" | "DimensionMismatch";

// CloudPusher
type PushInput = {
  markdown: string;
  source_meta: { url: string; type: Ext; title?: string; trust_level: number; user_id?: string };
  document_meta: { title: string; rawPath?: string; previewSnippet?: string };
  chunks: Array<{ content: string; embedding: number[]; idx: number; token_count: number }>;
};
type PushResult = { source_id: string; document_id: string };
type PushError = "AuthFailed" | "RateLimited" | "ServerError" | "NetworkError";

// StatusStore
type FileStatus = {
  file_id: string; batch_id: string; filename: string; ext: Ext;
  status: "pending" | "parsing" | "chunking" | "embedding" | "pushing" | "done" | "failed";
  progress: number;  // 0-100
  markdown_chars?: number; chunks_count?: number;
  error_code?: string; error_message?: string;
  cloud_source_id?: string; cloud_document_id?: string;
  retry_count: number; retryable: boolean;
  created_at: number; updated_at: number;
};

// LocalIngestMiddleware
type HandleUploadReq = { files: Express.Multer.File[]; trust_level: number };
type HandleUploadResp = { batch_id: string; files: [{file_id, filename, status: "pending"}] };
type HandleStatusResp = { batch_id: string; files: FileStatus[] };
```

### 4.2 SQLite schema

```sql
CREATE TABLE local_ingest (
  file_id TEXT PRIMARY KEY,                    -- uuid
  batch_id TEXT NOT NULL,                      -- 一次上传一组
  filename TEXT NOT NULL,
  ext TEXT NOT NULL,
  tmp_path TEXT,                               -- .tmp/uploads/...
  status TEXT NOT NULL,                         -- 6 状态 + failed
  progress INTEGER DEFAULT 0,
  markdown_chars INTEGER,
  chunks_count INTEGER,
  markdown TEXT,                                -- 解析后存（便于 retry 不重解析）
  chunks_json TEXT,                             -- JSON 序列化（避免重复 embed）
  error_code TEXT,
  error_message TEXT,
  cloud_source_id TEXT,
  cloud_document_id TEXT,
  retry_count INTEGER DEFAULT 0,
  retryable INTEGER DEFAULT 0,                  -- 0/1 boolean
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_batch ON local_ingest(batch_id);
CREATE INDEX idx_status ON local_ingest(status);
```

---

## 5. 错误处理

### 5.1 错误分类 + 策略

| 阶段 | 错误类型 | 自动重试 | 用户操作 |
|---|---|---|---|
| 解析 | PDF 损坏 / docx 加密 / mineru 失败 | ❌ 0 次 | UI "换文件" |
| 解析 | 网页 404 / 反爬 | ❌ 0 次 | UI 显示错误码 |
| LLM | OMLX 不可用 / OOM | ✅ 1 次（重启 OMLX）| 失败 → fallback 云端 |
| Embedding | OMLX 失败 | ✅ 1 次 | 失败 → fallback 云端 |
| 推送 | 4xx auth | ❌ 0 次 | 提示重登 |
| 推送 | 5xx server | ✅ 2 次（退避 1s/3s）| 失败 → 补推 |
| 推送 | 429 限流 | ✅ 3 次（退避 5s/10s/20s）| 失败 → 补推 |
| 存储 | SQLite 写失败 | ❌ 0 次 | 致命错误 + 日志 |

### 5.2 Fallback 策略

**触发**：OMLX 连续 3 次失败（503/timeout/OOM）
**行为**：
- 切云端 MiniMax (embo-01 embedding + chat)
- **不重试本地**（避免循环）
- 本次成功，下次再尝试本地（瞬错恢复）
- 累计 5 次失败 → 警告 + 禁用 fallback（怕爆 token）

### 5.3 推送去重

- 上传前查 SQLite：`cloud_source_id` 存在 → 跳过
- 防止：用户重推 / 重复上传

---

## 6. 测试

### 6.1 测试金字塔

| 层级 | 数量 | 工具 | 覆盖 |
|---|---|---|---|
| 单元 | ~30 | vitest | parser / embedder / pusher / status-store / concurrency / fallback |
| 集成 | ~10 | vitest + supertest | middleware 端到端 (mocked cloud) |
| 真接 | 5 场景 | manual + curl | dev server + 真文件 + OMLX + cloud |
| 并发 | ~3 | vitest | 5 文件同时上传 + semaphore |

### 6.2 5 类 parser 单元测试

```typescript
describe("LocalParser", () => {
  it("pdf: weaning-guide.pdf → markdown (含 # 标题)", async () => { ... });
  it("docx: guide.docx → markdown (mammoth)", async () => { ... });
  it("html: xhs-post.html → markdown (cheerio)", async () => { ... });
  it("txt: 直接读", async () => { ... });
  it("md: 原样", async () => { ... });
  it("unknown ext → UnsupportedExtError", async () => { ... });
});
```

### 6.3 fixtures

`apps/admin/test/fixtures/`：
- `weaning-guide.pdf` (~50KB, 中英, 3 页)
- `guide.docx` (~30KB, 1 页)
- `xhs-post.html` (1 篇真 xhs 笔记)
- `sample.txt`
- `sample.md`

### 6.4 真接测试

```bash
# 1. 启动 admin dev
pnpm -F admin dev

# 2. 浏览器 http://localhost:5173/upload
# 3. 拖入 3 文件 (PDF + DOCX + MD)
# 4. 验证: 实时进度 + 3 文件 done + cloud_source_id
# 5. CloudBase 控制台: 3 source + 3 document + chunks
# 6. 重推测试: mock 5xx + 验证 retryable + UI 重推
```

---

## 7. 实施计划（4 phase）

### Phase A: vite middleware 基础（1-2 天）
- 修 vite.config.ts 删 8787 proxy
- 新增 `apps/admin/server/local-ingest.ts`
- 5 类 parser (mineru / mammoth / cheerio)
- LocalEmbedder (OMLX client)
- CloudPusher
- StatusStore (SQLite)
- IngestOrchestrator + ConcurrencyGate
- 修 Upload.tsx 适配
- 单元测试 + 集成测试

### Phase B: SQLite 暂存 + 补推 UI（1 天）
- 补推 endpoint `POST /api/retry?file_id=X`
- UI "补推" 按钮 + 状态列表
- FallbackDetector + 错误分类 UI
- 真接测试

### Phase C: PDF 库验证（半天）
- 装 mineru (用户已装)
- 装 bge-m3 MLX 版
- 装 Qwen3.6 35B-A3B 4bit (mlx-community)
- 真接测 PDF 中文 + 英文 + xhs HTML 转 md

### Phase D: minipgm 上传（v2，独立项）
- R2 中转 / 本地 worker bridge 方案（arch-v2 §9.5）

### Phase E: 旧 /api-upload 弃用（v3）
- CloudBase 旧 `content` 路径返 410 Gone
- admin 上传全走本地路径

---

## 8. References

- arch-v2.md §9 决策补充（统一 markdown 中间格式）
- arch-v2.md §11 admin 本地上传文件页（决策记录）
- arch-v2.md §9.4 新 /api-ingest 协议（markdown 字段）
- state-cp7-zhenjie.md §10 M7 真实用户场景
- spec/2026-06-21-cp7-c-ingest-audit-design.md (CP-7-C #2)
- mineru: https://github.com/opendatalab/MinerU
- bge-m3: https://huggingface.co/BAAI/bge-m3
- Qwen3.6 35B-A3B 4bit (mlx-community): https://huggingface.co/mlx-community (Qwen3.6 35B-A3B-4bit)
- OMLX: Apple MLX runtime
- vite middleware: https://vitejs.dev/guide/api-plugin.html#configureserver

---

## 9. Open Questions（已解决）

| Q | 答案 |
|---|---|
| PDF 库 | mineru（用户已装）|
| server 架构 | Vite middleware |
| 上传后行为 | 上传即推云 |
| SQLite 暂存 | 是 + 补推 UI |
| LLM runtime | OMLX（Apple MLX）|
| 爬虫 LLM 候选 | Qwen2.5 14B / Qwen3 14B / Qwen3 30B-A3B / Qwen3.6 35B-A3B / Gemma 4 12B |
| **爬虫 LLM 终选** | **Qwen3.6 35B-A3B 4bit**（2025 末最新 + 中文 SOTA + MoE 3B 激活）|
| Gemma vs Qwen | Qwen 胜出（中文强）|

---

**最后更新**：2026-06-22 design 完成
