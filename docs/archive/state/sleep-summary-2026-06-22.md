# 2026-06-22 晚间进度 + 决策汇总（明早问用）

**用户状态**：已睡。托管模式启动（多选项时直接推荐 + 执行，不 pause 决策；destructive 操作除外）
**当前时间**：2026-06-22 02:40 左右
**今天做了什么**：Phase A ✅ + Phase B ✅ + Phase C T14 ✅；T15 写完 setup 但没真跑 dev server（用户说要去睡了，不阻塞 long-running）

---

## 1. 已完成的 commits

```
52cef75 feat(admin): T10-T13 — Phase B UI (Upload 重写 + retry 测试 + LlmStatus + 错误 i18n)
bd6f1a9 feat(admin): T14 — 切 LocalEmbedder 到 Qwen3-Embedding-4B + matryoshka 1536
3a838f9 feat(admin): T5-T9 — LocalParser + LocalEmbedder + FallbackDetector + CloudPusher + 集成
ea10c13 feat(admin): T1-T4 + T9 stub — vite middleware + StatusStore + ConcurrencyGate
```

测试数：92 → 122 → 123（+30）

---

## 2. Phase B（已完成 T10-T13）

| Task | 内容 | 测试 |
|---|---|---|
| T10 | Upload.tsx 重写：多文件拖入 + dropzone + setInterval(1s) 轮询 + 状态表格 + 重推按钮 + i18n 错误 | 4 个 UI 测试 |
| T11 | retry endpoint 测试补全（之前只有 404，新增 NOT_RETRYABLE / 缺 file_id / retryable=1 重试成功） | 3 个 server 测试 |
| T12 | OMLX 真实 probe + LlmStatus 组件（30s 轮询，4 色 chip：绿/灰/红/黄）+ UploadPage 顶部集成 | 5 probe + 6 UI 测试 |
| T13 | error-i18n.ts：14 个 error_code → 中文（ParseFailed/RateLimited/OMLX_Unavailable/OOM/DimensionMismatch 等） | 12 个 i18n 测试 |

**关键决策**：LlmStatus 集成到 UploadPage 头部 — 用户上传前就能看到 OMLX 在线/离线，决定要不要先启动 OMLX。

---

## 3. Phase C T14（环境就绪）

### 发现的问题：OMLX 不可用 + bge-m3 dim 不匹配

**问题 A**：用户说 OMLX 装了，但 `omlx` CLI 跑不起来
- 原因：editable install 指向 `/Users/Mark/git_project/omlx`（已删除目录）
- 解决方案：发现 `oMLX.app`（GUI app）其实在 port 8000 跑着 server（pid 46651）
- API key: `mark`（~/.omlx/settings.json）

**问题 B**：bge-m3-mlx-4bit 实测输出 1024 维，不是设计写的 1536
- 原因：bge-m3 matryoshka max = 1024，强行设 `dimensions=1536` 被忽略
- 影响：admin 存 1024 vs CloudBase MiniMax 1536 → cosineSimilarity 抛 `length mismatch` → 搜索 100% 失败
- **用户决策**：换本地 embedding 模型（不能接受 1024）

### 3 个 Qwen3-Embedding 候选对比

| Model | 磁盘 | 内存 | 原生 dim | **matryoshka 1536** | 质量 | 速度 |
|---|---|---|---|---|---|---|
| Qwen3-Embedding-0.6B-4bit-DWQ | 335MB | ~0.6GB | 1024 | ❌ 锁死 1024 | 中 | 最快 |
| **Qwen3-Embedding-4B-4bit-DWQ** | **2.12GB** | **~2.5GB** | **2560** | **✅ 工作** | **较好** | **中** |
| Qwen3-Embedding-8B-4bit-DWQ | 4.3GB | ~5GB | 4096 | ✅ | 最好 | 慢 |

### 最终选择：**Qwen3-Embedding-4B-4bit-DWQ**

**理由**：
1. **唯一满足硬约束**：只有 4B 和 8B 支持 matryoshka → 1536；0.6B 和 bge-m3 都钉死 1024
2. **资源可控**：2.5GB 内存 + Qwen3.6-35B-A3B (11.5GB) + bge-m3 (0.5GB, 保留不删) ≈ 14.5GB + 系统 < 32GB M1 Pro ✓
3. **质量好**：4B 比 0.6B 在中文 MTEB 榜单高 5-8 点
4. **OMLX 内存防护**：8B + 35B-A3B 同时跑会触发 OMLX settings.json 里的 `aggressive` memory_guard；4B 安全
5. **磁盘可接受**：2.12GB 比 8B 少一半

### T14 实施

- 改了 `apps/admin/server/local-embedder.ts`：
  - `OMLX_BASE_URL`: 11434 → 8000（OMLX 实际端口）
  - `apiKey`: "ollama" → "mark"（OMLX 默认）
  - `DEFAULT_MODEL`: "bge-m3" → "Qwen3-Embedding-4B-4bit-DWQ"
  - 调用 OMLX 时带 `dimensions: EXPECTED_DIM (1536)` 走 matryoshka
- 新增 `test/server/local-embedder-real.test.ts`：真接 OMLX，1279ms 跑完 2 个 1536 维 embedding（包含首次模型加载）

---

## 4. Phase C T15 进度（部分完成 — mineru 配置修好）

**完成**：
- ✅ 创建 `apps/admin/server/chunker.ts`：包装 `@unequal/shared/chunking`
- ✅ `packages/shared/src/index.ts` 加 `export * from "./chunking.js"`
- ✅ `apps/admin/server/local-ingest.ts` 加 `initProductionDeps()` 函数
- ✅ `apps/admin/vite.config.ts` 在 `configureServer` 调 `initProductionDeps()`
- ✅ typecheck 干净
- ✅ pdf-parse 依赖加到 admin package.json
- ✅ LocalParser.parsePdf 改为 try mineru → fallback pdf-parse
- ✅ **`MINERU_MODEL_SOURCE=modelscope` 让 mineru 走魔搭镜像（避开 GFW）**

**mineru 真测结果**：
- hybrid-auto-engine + modelscope：`RuntimeError: There is no Stream(gpu, 1)` — VLM 后端 + MLX 冲突
- **pipeline + modelscope：✅ 成功！** 14 页 1MB PDF 解析 ~15s（OCR-det + 14 pages processing）
- 输出 `/tmp/test/auto/test.md` 跟 LocalParser 期望路径一致

**为什么 mineru 默认挂**：
1. 默认走 huggingface（GFW 拦 PDF-Extract-Kit 下载）
2. hybrid-auto-engine 要 VLM 模型（MLX GPU stream 冲突）
3. 用户用 ModelScope（魔搭）不是 HuggingFace

**未做**：
- ❌ 启动 admin dev 真跑（明早第一件事）

---

## 5. 已知风险 / 待确认

### R1: ~~mineru 解析 `01-valid.pdf` 是否成功~~ ✅ 解决
原因已明：MINERU_MODEL_SOURCE=modelscope + -b pipeline 即可。
**Plan B（pdf-parse fallback）已实现**，双保险。

### R2: ~~mineru 输出格式~~ ✅ 解决
输出 markdown，跟 LocalParser 路径匹配。

### R3: CloudPusher 调真实 CloudBase
admin 的 `X-Ingest-Proxy-Secret` 硬编码在 cloud-pusher.ts:69 `"5852adc6..."`，跟生产是否一致要确认。
**Plan B**：如果生产 secret 不同，从 env `INGEST_PROXY_SECRET` 注入（目前已有 fallback）。

### R4: OMLX 4B 模型 token limit
Qwen3-Embedding-4B 支持 32K context（config.json max_position_embeddings=32768）。但 OMLX 4B 内存防护 aggressive 模式可能限制实际可用长度。需要真跑长文本测一下。

### R5: CloudBase cosineSimilarity dim 验证
切到 4B 1536 后理论上解决了 dim mismatch，但没真跑 CloudBase 端验证。明早 T15 跑时第一次 push 是验证关键。

### R6 (NEW): LLM 配置层（用户新要求）
用户明早前新要求：**所有用到大模型的地方都应该可配置 local/cloud**。
当前状态：
- Embedding: LocalEmbedder 硬编码 OMLX + Qwen3-Embedding-4B
- LLM (crawler): apps/crawler 应该有 LLM 调用，待确认是否硬编码
- PDF: LocalParser 用 mineru（已是 local；fallback pdf-parse）
- CloudBase api-search: 服务端 MiniMax（用户改不了）
**明早设计**：env-driven `LLM_PROVIDER=local|cloud` + 各 provider 的 model/key 配置。

---

## 6. 用户需要决策的事情（明早）

1. **mineru 解析失败 fallback**：✅ 已实现（mineru + pdf-parse 双路径）
2. **bge-m3 是否卸载**：4B 上线后 bge-m3-mlx-4bit 还占 321MB 磁盘 / 0.5GB 内存，是否 `omlx rm` 卸载？
3. **Phase C T15 完成后是否进 Phase D**（minipgm 上传 v2）？还是先做 v3（弃用旧 /api-upload 路径）？
4. **LLM 配置层设计**（NEW）：env-driven local/cloud 切换 — 详细设计明天提

---

## 7. 设计 doc 同步状态

**还没更新到文档的**（应该改但今天没改）：
- `docs/superpowers/state-arch-v2.md` §3.4 Resource budget：原写 1.2GB bge-m3，实际 2.12GB Qwen3-Embedding-4B；总资源 ~12.7GB → ~13.7GB
- `docs/superpowers/specs/2026-06-22-admin-upload-page-design.md`：embedding 段提到 bge-m3 1536 matryoshka，应该改成 Qwen3-Embedding-4B + matryoshka 1536

**明早建议**先跑 T15 验证 + 然后批量更新文档。

---

## 8. 当前进程状态

- OMLX (`oMLX.app` pid 46651) 跑着，模型列表包含 Qwen3-Embedding-4B-4bit-DWQ + bge-m3-mlx-4bit + Qwen3.6-35B-A3B-4bit
- mineru 3.2.3 已装（`/opt/homebrew/bin/mineru`）
- admin dev 没起（用户睡了，没必要）
- 122 测试 + 1 真接测试 PASS

---

## 9. 一句话总结

今天解决了 bge-m3 dim 不匹配的架构硬伤（换成 Qwen3-Embedding-4B matryoshka 1536），Phase A+B 完整 ship，Phase C T14 完成，T15 写完 setup + mineru 配魔搭镜像修好，等明早跑 admin dev 真接。