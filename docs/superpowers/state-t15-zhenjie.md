# T15 真接验证 — admin 本地 ingest 端到端

**日期**：2026-06-22 22:30
**状态**：✅ 通路 PASS · ⚠️ mineru pipeline exit 1（pdf-parse fallback 救场，但解析质量降级）
**作者**：T15 setup 真跑 + 用户决策

---

## 1. TL;DR

admin dev (`pnpm -F admin dev`) + CloudBase 生产环境端到端真接 **2 场景全部 PASS**：

| 场景 | 文件 | chunks | 耗时 | cloud_source_id |
|---|---|---|---|---|
| 小 md | /tmp/cp7-t15-test.md | 1 | **3s** | 01KVQVGTN1JABJ5GSAK11933X4 |
| 1MB PDF | /tmp/test.pdf (14 页双语) | 104 | **175s** | 01KVQVPCPWMA5A9EW9GD3FR3MB |

**但 PDF 解析质量降级**：mineru pipeline backend 在生产环境跑 5 分钟后 `exit code 1`，fallback 到 pdf-parse@1.1.1（纯文本提取，无 OCR/排版），导致 chunks 内容稀薄。**spec 期望的 ~74s 走 mineru pipeline 解析没成功**。

## 2. R3-R5 真接验证（全部 PASS）

### R3 — CloudPusher proxy secret 一致

- admin `cloud-pusher.ts:64` fallback secret = `5852adc6...` ✅
- 生产 `apps/api/cloudbaserc.smoke.json:28` `INGEST_PROXY_SECRET` = `5852adc6...` ✅
- **R3 风险消除**：两端一致，无需从 env 注入

### R4 — Qwen3-Embedding-4B OMLX context 限制

- T15 架构修正（commit `5e63e41`）：admin 端不 embed，**API 端 embed**（MiniMax embo-01 → 1536 维）
- OMLX aggressive memory_guard 限制 **不再影响 admin 上传链路**（admin 不再调 OMLX embed）
- **R4 风险在新架构下自动消除**（未来 P1 admin 预 embed 才需重测）

### R5 — CloudBase cosineSimilarity dim 1536 验证

- API 端 MiniMax embo-01 → 1536 维
- CloudBase NoSQL chunk embedding 字段存 1536 维
- 真接 `/api-search?q=宝宝发烧&limit=3` → 10 results（top score 1.087）+ **无 dim mismatch 错误**
- 第 5 个 chunkId `01KVQVGV4M9GD1E8TVA2FTH6EY` = 我刚上传的 PDF 第 1 个 chunk（trustLevel=1）— CloudBase 端真的自己 embed + cosine 命中
- **R5 风险消除**

## 3. 端到端链路细节

### 3.1 启动配置

新建 `apps/admin/.env.local`（之前 gitignored 不存在）：

```bash
OMLX_BASE_URL=http://localhost:8000/v1
OMLX_API_KEY=mark
OMLX_EMBED_MODEL=Qwen3-Embedding-4B-4bit-DWQ
OMLX_CHAT_MODEL=Qwen3.6-35B-A3B-4bit
MINERU_MODEL_SOURCE=modelscope
VITE_TCB_ENV_ID=unequal-d4ggf7rwg82e0900b
```

启动日志：

```
$ vite
  VITE v5.4.21  ready in 286 ms
  ➜  Local:   http://localhost:5173/
[local-ingest] Pusher=CloudBase (api-ingest); Embedder infra=local (model=Qwen3-Embedding-4B-4bit-DWQ) [API 端 embed]
```

**auto mode 探 OMLX 8000 可达 → 走 local**；CloudPusher 推 CloudBase；admin 不 embed（架构 v2.3 对齐）。

### 3.2 小 md 文件场景

```
$ curl -X POST http://localhost:5173/api/upload \
    -F "files=@/tmp/cp7-t15-test.md" \
    -F "trust_level=1"
→ HTTP 202 { batch_id, file_id, status: "pending" }

# 等 3s
$ curl http://localhost:5173/api/ingest-status?batch_id=...
→ status=done, progress=100, chunks_count=1
  cloud_source_id=01KVQVGTN1JABJ5GSAK11933X4
  cloud_document_id=01KVQVGTQTWGN9SVY0N85C4HG3
  trust_level=1, elapsed=3s
```

**全链路 PASS**，md 解析 → chunk → CloudPusher → CloudBase embed → 写库。

### 3.3 1MB PDF 场景（mineru 失败 + pdf-parse fallback）

```
$ curl -X POST http://localhost:5173/api/upload \
    -F "files=@/tmp/test.pdf" \
    -F "trust_level=1"
→ HTTP 202 { batch_id, file_id, status: "pending" }

# vite dev log 看到：
[LocalParser] mineru failed for test.pdf, falling back to pdf-parse: mineru exit code 1

# 等 175s
$ curl ... /api/ingest-status?batch_id=...
→ status=done, progress=100, chunks_count=104
  cloud_source_id=01KVQVPCPWMA5A9EW9GD3FR3MB
  cloud_document_id=01KVQVPCS14PCHCNJ0V27665J6
  trust_level=1, elapsed=175s
```

**通路 PASS，但 PDF 解析质量降级** — chunks 内容是 pdf-parse 抽到的纯文本流（无 OCR/排版），104 个 chunks 大量是噪音（"page 1", "page 2" 之类）。

## 4. mineru pipeline exit 1 调查（明早 task）

### 4.1 现象

- mineru 进程启动 OK（pid 26914, `-b pipeline -l ch -m auto`，MINERU_MODEL_SOURCE=modelscope）
- 跑了 ~5 分钟（不是 timeout — 否则会走 "mineru parse timeout (>1800000ms)" 分支）
- 进程消失，exit 1，无 stderr 写入 mineru.log

### 4.2 跟 sleep-summary §4 预期不一致

当时 T15 setup 验证 `pipeline + modelscope` 跑通：

> pipeline + modelscope：✅ 成功！14 页 1MB PDF 解析 ~15s（OCR-det + 14 pages processing）

现在跑同样的 PDF + 同样的 backend + 同样的 env，**5 分钟后 exit 1**。

### 4.3 可能原因（待诊断）

1. **OMLX 资源抢占**：Qwen3-Embedding-4B-4bit-DWQ (~2.5GB) + Qwen3.6-35B-A3B (~11.5GB) 同时跑，mineru spawn 时可能 OOM
2. **mineru 子进程 model cache 路径冲突**：之前可能 mineru 把 cache 写到 GFW 阻断的 huggingface 路径
3. **macOS 进程清理**：sleep/wake 后资源锁没释放
4. **PDF-specific**：这个 PDF 内部有什么触发 mineru crash

### 4.4 明早任务

- [ ] 单独跑 `mineru -p /tmp/test.pdf -o /tmp/test-out -m auto -b pipeline -l ch` 复现 exit 1
- [ ] 抓 mineru stderr 到文件（当前 `stdio: ["ignore", "pipe", "pipe"]` pipe 已接但 log 没保存）
- [ ] 如 OOM → 加 OMLX 内存防护 / 跑 mineru 前先停 OMLX 大模型
- [ ] 如 GFW → 强制 MINERU_MODEL_SOURCE=modelscope 已设但仍试 hf 路径，看 mineru CLI 3.2.3 是否真读这个 env
- [ ] 如成功 → 修 local-parser.ts 抓 stderr 写 .log 文件便于诊断

### 4.5 Plan B 已生效

**pdf-parse fallback 已救场**（spec §"T15 setup" 设计的双保险）— 即使 mineru 挂，admin 仍能上传 PDF（虽然质量降级）。

这跟 sleep-summary §R1 决策一致：

> R1: mineru 解析 01-valid.pdf 是否成功 ✅ 解决
> 原因已明：MINERU_MODEL_SOURCE=modelscope + -b pipeline 即可。
> **Plan B（pdf-parse fallback）已实现**，双保险。

## 5. T15 真接成果总结

### 5.1 完成项

- ✅ admin dev server 启动（vite 5.4.21，286ms ready）
- ✅ 4 个依赖 wire（LocalParser / CloudPusher / Chunker / Embedder infra）
- ✅ `.env.local` 创建 + OMLX auto probe → local
- ✅ md 端到端 PASS（3s，1 chunk）
- ✅ PDF 端到端 PASS 通路（175s，104 chunks，但 pdf-parse fallback 质量降级）
- ✅ R3 / R4 / R5 三个风险项全部 PASS
- ✅ CloudBase 端真接验证（生产 admin token 鉴权 + 搜索 1536 维 dim 对齐）

### 5.2 已知问题（待修）

- ⚠️ mineru pipeline 跑 ~5 分钟后 exit 1（明早第一件事）
- ⚠️ `LocalParser` stderr 没写 log 文件（下次挂时无法诊断 — local-parser.ts:90 stderr.slice(-500) 仅 console.warn，不写文件）
- ⚠️ admin-upload 中 `tmp_data` 字段存原始 binary 到 SQLite（看 status API 时返 Buffer array，无用但占空间 — 后续 T9 改写文件）

### 5.3 累计测试（未动）

- T15 setup 没新增代码（仅 config 切换 + vite wire）— 全 monorepo **450 tests** all PASS（state-cp7-zhenjie §13.5）

## 6. 下一步

1. **明早 P0**：诊断 mineru exit 1（§4.4）— 这是 admin 上传 PDF 的实际可用性 blocker
2. **可选 P1**：admin-upload `tmp_data` 字段改写文件（T9 之前）
3. **P2**：本地 stderr 写 log 文件（local-parser.ts 加 fs.writeFile）
4. **不做**：T15 通路本身（已 PASS，无需重做）

## 7. References

- 架构 v2.3：admin 不 embed + API 自己 embed — `docs/superpowers/state-arch-v2.3.md`
- 昨晚决策汇总 — `docs/superpowers/sleep-summary-2026-06-22.md`
- R3-R5 风险项 — sleep-summary §5
- LocalParser 实现 — `apps/admin/server/local-parser.ts`
- CloudPusher 实现 — `apps/admin/server/cloud-pusher.ts`
- admin server init — `apps/admin/server/local-ingest.ts`
- 部署 + 真接报告 — `docs/superpowers/state-cp7-zhenjie.md`