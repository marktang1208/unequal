# Implementation Plan: admin 本地上传文件页

**日期**：2026-06-22
**Source Spec**：`docs/superpowers/specs/2026-06-22-admin-upload-page-design.md`
**范围**：Phase A + B + C（1-3 天）
**Phase D + E**：v2 独立项

---

## 总览

| Phase | 内容 | 估时 | Task 数 |
|---|---|---|---|
| Phase A | vite middleware + 5 类 parser + SQLite + embed + push | 1-2 天 | T1-T9 |
| Phase B | 补推 UI + FallbackDetector + 错误分类 | 1 天 | T10-T13 |
| Phase C | 模型/库真接验证（mineru + bge-m3 + Qwen3.6）| 半天 | T14-T16 |

**TDD 原则**：每个 task 先写 test → 写实现 → 跑 test → 真接

---

## Phase A: vite middleware + 核心流程（T1-T9）

### T1: 修 vite.config.ts 删 8787 proxy

**目标**：admin dev server 不再代理到不存在的 8787
**改动**：`apps/admin/vite.config.ts`
**步骤**：
1. 删 `server.proxy["/api"]` 配置
2. 加 `server.middleware: [...localIngestMiddleware]`（占位，T2 实现）
**Acceptance**：
- `pnpm -F admin dev` 启动后 vite 不报 proxy 错
- `curl http://localhost:5173/api/upload` 返 404（无 middleware 时）
**验证**：`pnpm -F admin build` 编译通过

### T2: 写 LocalIngestMiddleware 骨架

**目标**：vite middleware 接 POST /api/upload + GET /api/ingest-status
**新建**：`apps/admin/server/local-ingest.ts`
**步骤**：
1. 创建 `Express.Multer` 配置（multer 内存存储 + 5 类 accept）
2. 实现 `handleUpload`：
   - 解析 multipart → 写文件到 `.tmp/uploads/{uuid}.{ext}`
   - 返 202 `{ batch_id, files: [{file_id, filename, status: "pending"}] }`
3. 实现 `handleStatus`：从 SQLite 查 `batch_id` 的所有 file
4. 导出 `localIngestMiddleware` (Vite Connect.Server)
**测试**：`apps/admin/test/server/local-ingest.test.ts`（vitest + supertest）
- POST /api/upload 单文件 → 202 + file_id
- POST /api/upload 5 文件 → 5 file_id
- GET /api/ingest-status?batch_id=X → 5 status
**Acceptance**：测试全 PASS，handler 返正确格式

### T3: 写 StatusStore（SQLite）

**目标**：better-sqlite3 + WAL mode + 6 状态机
**新建**：`apps/admin/server/status-store.ts`
**步骤**：
1. 装 `better-sqlite3`（pnpm add）
2. schema（spec §4.2）：local_ingest 表 + 2 index
3. API：`create(file_id, batch_id, ...)` / `update(file_id, ...)` / `getByFileId` / `listByBatch` / `resetForRetry`
4. WAL 模式 + 串行化（避免 SQLite lock）
**测试**：`apps/admin/test/server/status-store.test.ts`
- create + update + get 流程
- 并发 update 不冲突（WAL 验证）
- 状态机转换正确性
**Acceptance**：测试全 PASS，DB schema 正确，WAL 模式启用

### T4: 写 ConcurrencyGate

**目标**：3 semaphore 限流（parser=1, embed=3, push=5）
**新建**：`apps/admin/server/concurrency-gate.ts`
**步骤**：
1. 用 Promise + 自实现 semaphore（轻量，无外部依赖）
2. 3 个独立 semaphore 实例
3. API：`withLimit(name, fn)` 包 fn 在 semaphore 限制下
4. 暴露 `getCurrentCount(name)` 供状态查询
**测试**：`apps/admin/test/server/concurrency-gate.test.ts`
- parserSem: 5 并发 → 只有 1 同时跑
- embedSem: 5 并发 → 3 同时跑
- pushSem: 5 并发 → 5 同时跑
**Acceptance**：测试全 PASS，限流准确

### T5: 写 LocalParser（5 类）

**目标**：5 类文件 → markdown
**新建**：`apps/admin/server/local-parser.ts`
**步骤**：
1. `parsePdf(path)`：`spawn("mineru", ["--output", "md", path])` 调 mineru CLI
2. `parseDocx(path)`：`mammoth.extractRawText({ path })`
3. `parseHtml(path)`：cheerio 提取 main + readability 模板
4. `parseText(path)` / `parseMd(path)`：`fs.readFileSync`
5. `parseAuto(path, ext)` 路由
6. 错误分类：`ParseFailed` / `UnsupportedExt` / `EncryptedFile`
**测试**：`apps/admin/test/server/local-parser.test.ts`
- 5 类 happy path（用 fixtures）
- 未知 ext → UnsupportedExtError
- 不存在的文件 → ParseFailed
**fixtures**：`apps/admin/test/fixtures/` (commit 进 git)
- `weaning-guide.pdf` (~50KB)
- `guide.docx` (~30KB)
- `xhs-post.html` (1 篇真 xhs 笔记)
- `sample.txt`
- `sample.md`
**Acceptance**：5 类单测全 PASS，错误分类正确

### T6: 写 LocalEmbedder（OMLX bge-m3）

**目标**：OMLX client 调 bge-m3 embedding
**新建**：`apps/admin/server/local-embedder.ts`
**步骤**：
1. 装 `openai` npm 包（OMLX 兼容 OpenAI API）
2. `new OpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" })`
3. `embedBatch(texts)`：调 `client.embeddings.create({ model: "bge-m3", input: texts })`
4. 验证维度 = 1536（matryoshka 配置）
5. 错误处理：OMLX 不可用 / OOM
**测试**：`apps/admin/test/server/local-embedder.test.ts`
- 1024 chunks → 1024×1536 矩阵
- OMLX 失败 → 抛 EmbedError
- 维度不匹配 → 抛 DimensionMismatch
**Acceptance**：测试全 PASS，OMLX mock 调通

### T7: 写 FallbackDetector

**目标**：OMLX 连续 3 次失败 → 切云端
**新建**：`apps/admin/server/fallback-detector.ts`
**步骤**：
1. 单例：维护每个 component (embed/llm) 的失败计数
2. API：`recordFailure(component)` / `recordSuccess(component)` / `shouldDisableLocal(component)`
3. 阈值：3 次失败 → `shouldDisableLocal = true`；成功 → 重置计数
4. 累计 5 次失败 → 警告 + 永久禁用 fallback
5. 状态可查：getState(component) → `{ count, disabled, warning }`
**测试**：`apps/admin/test/server/fallback-detector.test.ts`
- 3 次失败 → shouldDisableLocal
- 失败 2 + 成功 1 → 重置
- 累计 5 次 → warning
- 多 component 独立计数
**Acceptance**：测试全 PASS，状态机正确

### T8: 写 CloudPusher

**目标**：POST /api-ingest (chunks + markdown)
**新建**：`apps/admin/server/cloud-pusher.ts`
**步骤**：
1. 用 fetch 调 `https://{gateway}/api-router/api-ingest`
2. Header: `X-Ingest-Proxy-Secret: $INGEST_PROXY_SECRET`
3. Body：`{ url, type, title, trust_level, user_id, document: {...}, markdown, chunks: [{content, embedding, idx, token_count}] }`
4. 重试：5xx 2 次（退避 1s/3s），429 3 次（退避 5s/10s/20s）
5. 错误分类：AuthError (401/403 不重试) / RateLimited / ServerError / NetworkError
6. 推送前查 SQLite 是否有 cloud_source_id（去重）
**测试**：`apps/admin/test/server/cloud-pusher.test.ts`
- 200 → 返 source_id
- 401 → AuthError no retry
- 5xx → 重试 2 次
- 429 → 重试 3 次
- 推送去重
**Acceptance**：测试全 PASS，重试策略正确

### T9: 写 IngestOrchestrator + 集成

**目标**：单文件 6 状态机调度 + 多文件并发
**新建**：`apps/admin/server/ingest-orchestrator.ts`
**步骤**：
1. `processFile(file_id, tmp_path, ext, trust_level)` 主函数
2. 状态机：
   - pending → parsing (StatusStore.update)
   - 解析 (ConcurrencyGate.parserSem)
   - → chunking (StatusStore.update + chunkText)
   - → embedding (ConcurrencyGate.embedSem + LocalEmbedder)
   - → pushing (ConcurrencyGate.pushSem + CloudPusher)
   - → done (StatusStore.update + cloud_ids)
3. 错误处理：每个阶段 try/catch → 失败时 update status=failed + error_code/message + retryable
4. Fallback：LocalEmbedder 失败时调云端 MiniMax
5. middleware 在 T2 集成 orchestrator
**测试**：`apps/admin/test/server/ingest-orchestrator.test.ts`
- 单文件 happy path（mock parser + embed + push）
- 解析错误 → status=parse_failed
- 推送错误 → status=push_failed + retryable
- 5 文件并发 → Promise.allSettled
- Fallback 触发（embed 3 次失败 → 切云端）
**Acceptance**：测试全 PASS，状态机 + fallback 正确
**集成测试**：`apps/admin/test/server/integration.test.ts`
- POST /api/upload 5 PDF → 5 status=pending
- 轮询 /api/ingest-status → 全部 = done
- CloudBase 假数据验证（mock fetch 验 payload）

---

## Phase B: 补推 UI + Fallback UI（T10-T13）

### T10: 修 UploadPage UI

**目标**：现有 Upload.tsx 适配新 API + 加状态列表
**改动**：`apps/admin/src/pages/Upload.tsx`
**步骤**：
1. 改 onSubmit：POST FormData 到 `/api/upload`（不是 `/upload`）
2. 加状态轮询：`useEffect` + setInterval(1s) 调 `/api/ingest-status?batch_id=X`
3. 加状态表格：每文件一行（filename / status / progress / error / 重推按钮）
4. 重推按钮：POST `/api/retry?file_id=X`
5. 实时进度条 / 状态 icon
**Acceptance**：
- 拖入 5 PDF → 显示 5 行状态
- 1s 刷新一次
- 完成后显示 cloud_source_id
- 失败显示 error + 重推按钮

### T11: 写 retry endpoint

**目标**：POST /api/retry 重推失败文件
**改动**：`apps/admin/server/local-ingest.ts`
**步骤**：
1. `handleRetry(file_id)`：
   - 查 SQLite 取原 tmp_path + ext + markdown（如有）
   - 重新走 orchestrator
   - 状态从 failed → pending
2. 路由 `POST /api/retry?file_id=X`
**测试**：`apps/admin/test/server/local-ingest.test.ts` (扩展)
- retry 成功 → status=pending → done
- retry 失败 → 保持 status=failed
**Acceptance**：测试全 PASS

### T12: 写 FallbackDetector UI 状态

**目标**：admin UI 显示本地 LLM 状态
**改动**：`apps/admin/src/components/LlmStatus.tsx` (新)
**步骤**：
1. 组件：显示 OMLX 在线 / 离线 / fallback 中
2. GET /api/llm-status（admin middleware 加 endpoint）
3. 实时刷新（30s）
**Acceptance**：
- OMLX 在线 → 绿色 chip "本地 LLM ✓"
- 3 次失败 → 红色 chip "Fallback: 云端"
- 累计 5 次 → 黄色 chip "本地 LLM 禁用"

### T13: 错误分类 UI

**目标**：用户看到的中文错误信息
**改动**：`apps/admin/src/lib/error-i18n.ts` (新) + UploadPage
**步骤**：
1. 错误码 → 中文 message 映射：
   - `ParseFailed` → "文件解析失败，请检查文件格式"
   - `EncryptedFile` → "PDF 已加密，请先解密"
   - `OMLX_Unavailable` → "本地 LLM 不可用，已切换云端"
   - `RateLimited` → "服务繁忙，请稍后重试"
2. UploadPage 用 error-i18n 翻译 error_code
**Acceptance**：
- 错误显示中文（不显示英文 stack）
- 分类明确（不是 raw error）

---

## Phase C: 模型/库真接验证（T14-T16）

### T14: 装 mineru + bge-m3 + Qwen3.6

**目标**：本机环境就绪
**步骤**：
1. mineru：用户已装 → 验证 `mineru --version`
2. OMLX：`brew install omlx` 或 `pip install omlx`（或用 mlx-community docker）
3. bge-m3：`omlx pull mlx-community/bge-m3` (~1.2GB)
4. Qwen3.6 35B-A3B 4bit：`omlx pull mlx-community/Qwen3.6-35B-A3B-4bit` (~10GB)
5. 启动 OMLX server：`omlx serve` (port 11434)
**Acceptance**：
- `curl http://localhost:11434/v1/models` 列出 bge-m3 + Qwen3.6
- `omlx embeddings -m bge-m3 -i "test"` 返 1536 维向量
- `omlx chat -m Qwen3.6-35B-A3B-4bit "你好"` 返中文回复

### T15: PDF 端到端真接

**目标**：验证 PDF 中英文解析 + 推云
**步骤**：
1. 用 admin dev 启动：`pnpm -F admin dev`
2. 浏览器 `http://localhost:5173/upload`
3. 上传 3 个文件：
   - 中英混合 PDF（50KB）
   - 纯英文 PDF（10KB）
   - 中文 PDF 含表格（20KB）
4. 验证：3 个 status=done + CloudBase 控制台有 3 source + chunks
**Acceptance**：
- 中英文 PDF 都解析成功
- 表格内容识别正确（markdown 表格）
- 5xx/4xx 错误触发 fallback

### T16: 5 类 parser 真接 + 性能

**目标**：验证完整链路 + 性能 baseline
**步骤**：
1. 准备 5 个 fixtures：PDF + DOCX + HTML + TXT + MD
2. 上传 5 文件
3. 测总耗时（concurrency 3 个 semaphore）
4. 验证：5 个都 done + cloud_source_id + chunks
**性能预期**：
- parser 阶段：~30s/PDF（mineru）+ 5s/DOCX + 10s/HTML
- embed 阶段：~5s/1024 chunks
- push 阶段：~3s/批
- **单文件总耗时：~40s**（含 push）
- 5 文件并发：~80s（parser 1 个串行，embed 3 并发，push 5 并发）
**Acceptance**：
- 5 文件全 done
- 性能在预期范围内
- 资源占用 M1 Pro 32GB 不 swap

---

## 验证标准（Acceptance 全集）

### Phase A 完结标准
- [ ] T1-T9 所有单测 PASS（~30 用例）
- [ ] T9 集成测试 PASS（5 文件并发 end-to-end）
- [ ] `pnpm -F admin typecheck` PASS
- [ ] `pnpm -F admin test` PASS
- [ ] `pnpm -F admin build` PASS
- [ ] admin dev server 启动无错
- [ ] curl /api/upload 返正确格式

### Phase B 完结标准
- [ ] T10-T13 单测 PASS
- [ ] UI 拖入文件后 1s 内看到状态
- [ ] 重推按钮在 status=failed 时显示
- [ ] 错误显示中文
- [ ] LLM 状态 chip 实时更新

### Phase C 完结标准
- [ ] T14 OMLX 装好，bge-m3 + Qwen3.6 可调
- [ ] T15 PDF 端到端 PASS（中英文）
- [ ] T16 5 类真接 PASS + 性能 baseline

### 最终真接（dev server + 真文件）
- [ ] admin dev server 启动无错
- [ ] 浏览器访问 /upload 不报错
- [ ] 拖入 3 个不同类型文件 → 全部 done
- [ ] CloudBase 控制台 3 source + 3 document + N chunks
- [ ] 失败文件可重推

---

## 风险 + 缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| OMLX 装不上 | 中 | fallback Ollama；再 fallback 云端 |
| Qwen3.6 35B-A3B mlx-community 无 | 中 | 试 Qwen3 30B-A3B 或 14B |
| mineru CLI 不识别某些 PDF | 低 | fallback pdf-parse（v1 退路）|
| vite middleware 与 HMR 冲突 | 低 | 用 `configureServer` hook 不用 plugin |
| SQLite 多进程 lock | 低 | WAL + 串行写 |
| M1 Pro 32GB 内存不够 | 中 | 余 8.8GB，监控 swap |

---

## 时间分配

| Day | 任务 |
|---|---|
| Day 1 上午 | T1 + T2 + T3（vite config + middleware 骨架 + StatusStore）|
| Day 1 下午 | T4 + T5（ConcurrencyGate + LocalParser）|
| Day 2 上午 | T6 + T7 + T8（LocalEmbedder + FallbackDetector + CloudPusher）|
| Day 2 下午 | T9（IngestOrchestrator + 集成测试）|
| Day 3 上午 | T10 + T11（UI 修 + retry endpoint）|
| Day 3 下午 | T12 + T13（LLM status + i18n）+ T14（装环境）|
| Day 4 上午 | T15 + T16（真接 + 5 类 + 性能）|

**总计：3 天（如果 0 阻碍）**

---

## References

- design spec: `docs/superpowers/specs/2026-06-22-admin-upload-page-design.md`
- arch-v2: `docs/superpowers/state-arch-v2.md`
- mineru: https://github.com/opendatalab/MinerU
- bge-m3: https://huggingface.co/BAAI/bge-m3
- Qwen3.6 35B-A3B 4bit: https://huggingface.co/mlx-community (Qwen3.6 35B-A3B-4bit)
- vite middleware: https://vitejs.dev/guide/api-plugin.html#configureserver
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3

---

**最后更新**：2026-06-22 plan 完成
