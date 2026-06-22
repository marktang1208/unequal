# state-v2.4-zhenjie — v2.4 端到端真接 PASS 报告

> 日期: 2026-06-23
> 前置: state-arch-v2.4.md (commit 3a9d4e7) + v2.4 code (commit 30eb9b8)
> 状态: ✅ PASS — 单 PDF 端到端 30s 完成到 CloudBase

## 1. 验收结果

| 维度 | 结果 |
|---|---|
| 解析 | mineru exit 0（vite loadEnv 注入 MINERU_MODEL_SOURCE=modelscope） |
| 嵌入 | OMLX Qwen3-Embedding-4B-4bit-DWQ 1536 维本地 embed |
| 推送 | CloudBase api-ingest 接收预嵌入 chunks 直写 |
| 端到端耗时 | **30s**（解析 + embed + push 全程） |
| 异常分支 | 0（无 retry / 无 fallback / 无 error_code） |

### 1.1 真接 trace

```
POST /api/upload (trust_level=1, file=32、-AI产品经理简历内容框架社招.pdf 386KB)
  → 202 batch_id=5a80ddf6-babd-4d9d-8094-5ad51ad81522
  → file_id=00037cbf-c8bd-4221-96d9-8a8a5b88d74d status=pending

T+0~24s: status=parsing (mineru 解析 PDF → markdown)
T+24~30s: status=embedding → status=pushing
T+30s: status=done progress=100
        cloud_source_id=01KVR40FHT6A9D5WSXDZ3FA9ZS
        cloud_document_id=01KVR40FKRW5DF3X4KPYXQPHFJ
```

## 2. 真接期间发现并修的 bug

### 2.1 omlx-probe 假阴性（commit 2056cec）

**症状**: `GET /api/llm-status` 返 `omlx.available=false, url=http://localhost:11434/v1`，即便 OMLX 实际在 8000 跑着。

**根因**: `server/omlx-probe.ts` 默认 URL 硬编码 `11434`（Ollama 旧假设），且 probe 不带 Authorization 头 → OMLX 401 → 误判 unavailable。

**修复**:
- 默认 URL 从 `process.env.OMLX_BASE_URL` 读，fallback 11434
- 默认 Authorization 从 `process.env.OMLX_API_KEY` 读，缺失时不带头

**副作用**: 这是诊断接口修，不影响 v2.4 主链路（config.ts 启动时单独调 probeOmlxAvailable 已走通 local）。

### 2.2 LocalEmbedder 80 长文本 OOM/hang（commit 2056cec）

**症状**: 单批 80 个长文本走 OMLX 嵌入 169s 后 terminated，OMLX 进程留 4 个 ESTABLISHED zombie 连接。

**根因**: OMLX (Qwen3-Embedding-4B MLX backend) 对单批 >30 长文本会卡 loadText/OOM。

**修复**: `BATCH_SIZE = 10` 分批嵌入，每批独立 OpenAI 客户端请求 + 独立 fetch lifecycle，避免单批积累。

**真接验证**: 80 chunks 路径已通过 386KB PDF 端到端 30s 完成（含解析）。

### 2.3 omlx-server zombie 进程

**症状**: 上轮调试期间 omlx-server 留 4 个 ESTABLISHED 连接，2.5GB 内存。

**处理**: `pkill -9 -f omlx-server` 后 omlx-server 重新 spawn（oMLX.app tray icon 守护）。

**预防建议**: admin client 端 embedding 调用应该 `AbortController` + timeout，避免长任务堆积（LocalEmbedder.embed 已分批 + BATCH=10 已足够降风险；如未来上 max-conn 池化再加 AbortController）。

## 3. v2.4 全链路代码改动汇总

| 文件 | 改动 |
|---|---|
| apps/admin/server/cloud-pusher.ts | 加 pushChunks() + _doPost() 统一方法 |
| apps/admin/server/ingest-orchestrator.ts | 加 Embedder 接口 + setEmbedder() + 6 状态机 |
| apps/api/src/handlers/api-ingest.ts | chunks[] schema + 直写分支（不走 LLM） |
| apps/admin/server/local-ingest.ts | initProductionDeps 注入 embedder |
| apps/admin/server/omlx-probe.ts | (本轮) probe 默认值修假阴 |
| packages/local-llm/src/local-embedder.ts | (本轮) BATCH_SIZE=10 分批 |
| apps/admin/test/server/ingest-orchestrator.test.ts | 加 Embedder mock |
| apps/admin/test/server/local-ingest.test.ts | retry 测试加 pushChunks 路径 |
| packages/local-llm/dist/local-embedder.js | rebuild (BATCH_SIZE 编译进 dist) |

总计 8 个文件改动（不含 dist），2 个 commit（v2.4 code `30eb9b8` + fixes `2056cec`）。

## 4. 测试状态

| 测试集 | 数量 | 结果 |
|---|---|---|
| admin unit + integration | 162 | PASS |
| api unit + integration | 129 | PASS |
| packages + 其他 | 207 | PASS |
| **总计** | **498** | **PASS** |
| v2.4 真接 (PDF 端到端) | 1 场景 | **PASS** |

## 5. v2.4 架构验证清单

- [x] admin 本地全链路：parse + chunk + embed + SQLite staging（v2.4 code）
- [x] push 走 CloudBase api-ingest，预嵌入 chunks 直写（无 LLM 调）
- [x] OMLX 本地 embedding，绕过 MiniMax 5hr 配额限制
- [x] mineru + modelscope 路径避开 GFW（vite loadEnv 注入）
- [x] 单 PDF 端到端 30s 完成到 CloudBase（真接验证）
- [x] 全 monorepo 测试 498/498 PASS
- [x] omlx-probe 假阴修复（GET /api/llm-status 返 available:true）

## 6. 下一步候选

1. **多文件并发真接验证** — 当前只跑 1 文件，建议跑 5 文件并发确认 ConcurrencyGate v2.4 协调正确
2. **大文件真接** — 28MB 育儿百科 PDF，验证 BATCH_SIZE=10 对 200+ chunks 的稳定性
3. **失败 retry 真接** — 故意断 CloudBase 验证 pushChunks 失败 → retry → 恢复
4. **临时文件清理** — apps/admin/.tmp/ + apps/api/cloudbaserc.deploy.json + apps/api/scripts/pdf-parse-real.mjs 是调试残留，可清理
5. **CP-7 后续 P 阶段** — M7-D / P4（参见 state-cp7-zhenjie.md §9）

建议优先级: **1 > 4 > 2 > 3 > 5**

## 7. commit 链

```
2056cec fix(v2.4): probe 读 OMLX env + embedder 分批 10 — 修 llm-status 假阴 + 长文本 OOM
30eb9b8 feat(v2.4): admin 本地 embed + 推预嵌入 chunks
3a9d4e7 docs: v2.4 架构 + v2.3 废弃 — admin 本地全链路 embed + 推预嵌入 chunks
ed8e0c0 fix: mineru exit 1 根因诊断 + 修复 — vite loadEnv + 默认 modelscope
b38d1a2 docs: T15 真接验证报告 — 2 场景 PASS + mineru exit 1 风险暴露
```