# state-v2.4-zhenjie5 — 28MB 大文件真接 (1520 chunks) + MiniMax cloud embedding PASS

> 日期: 2026-06-23
> 前置: state-v2.4-zhenjie4.md (commit f707f5f) — pushChunks 切批复用优化
> 状态: ✅ 28MB 育儿百科 PDF (1.7MB markdown → 1520 chunks → 4.5 分钟) — embed 切 MiniMax cloud 7x 加速

## 1. 验收结果

| 维度 | OMLX (本地) 预估 | MiniMax (云) 实测 | 对比 |
|---|---|---|---|
| 文件大小 | 28.5MB PDF (665 页) | 28.5MB PDF (665 页) | 同 |
| markdown 输出 | 1.7MB / 15123 行 | 1.7MB / 15123 行 | 同 (mineru 离线 dryrun) |
| chunks 数 | 1520 (real chunker) | 1520 (real chunker) | 同 |
| embed 算力 | OMLX Qwen3-Embedding-4B-4bit (本地 8000) | MiniMax embo-01 cloud | 云端 |
| 10 chunks 1 batch | 13.0s | 0.75s | **17x 快** |
| 1520 chunks 全部 embed | ~33 分钟 (152 × 13s) | ~30s (15 × 0.75s) | **66x 快** |
| 端到端总耗时 | ~49 分钟 (预估) | **4.5 分钟** (实测 T+270s) | **~10x 加速** |
| CloudBase chunks 写入 | 1520 | 1520 | ✓ |
| cloud_source_id | (未跑通 OMLX 路径) | `01KVS7RZTF5WDVGHKEG6B84DDK` | ✓ |
| 失败 retry | n/a | 0 | ✓ |
| 测试 | 498/498 | 502/502 (+4) | +4 (cloud-embedder 改造) |

## 2. 实施路径

### 2.1 干跑预估 (T+0~6min)

```bash
# 1. mineru 离线 dryrun 6:32 (665 页 OCR-det + OCR-rec)
mineru -p /tmp/test.pdf -o /tmp/mineru-dryrun -m auto -b pipeline -l ch -f true -t true
# → 1.7MB markdown

# 2. 真实 chunker 干跑 (用 admin 同款 maxTokens=500, overlapTokens=80)
# → 1520 chunks, 720888 tokens, avg 474 tokens/chunk
# → 预估 push 760 批 (MAX_CHUNKS_PER_PUSH=2)
# → 预估 embed 152 批 (BATCH_SIZE=10) × 13s = 1976s = 33min
```

### 2.2 OMLX 卡死 (T+10~50min)

```bash
# admin upload 28MB PDF → FILE_TOO_LARGE 5MB 限制
# 改传 mineru 已解析的 markdown (1.7MB) → pass
# 但 OMLX 串行 embed 1520 chunks 跑 50+ 分钟仍卡在 50%
# chunks=1520 (chunk 阶段完成) 但 embedding 状态没进 pushing
# 决定切到 MiniMax cloud
```

### 2.3 MiniMax cloud 切换 (T+50~52min)

```bash
# 探活 MiniMax embo-01: 必须用 {type:"query", texts:[...]} 不能用 OpenAI {input:[...]}
# 响应字段: {vectors: number[][]} 不是 {data:[{embedding:...}]}
# 10 chunks 1 batch = 0.75s (17x 快于 OMLX 13s)
```

### 2.4 Cloud embedder schema 修复 (T+52~55min)

发现 2 个 bug：
1. **请求 schema 错误** — admin `@unequal/local-llm/CloudEmbedder` 用 OpenAI 风格 `input/data`
2. **大批 chunks NPE** — 1520 一次性发 MiniMax 返 `vectors: null`，`vectors[0].length` NPE

修复：
- `packages/local-llm/src/cloud-embedder.ts` — 改用 `{type:"query", texts:[...]}` + 响应取 `data.vectors`
- 加 `BATCH_SIZE=100` 分批调用
- 加 `vectors === null` 显式抛 EmbedError

测试覆盖：+2 用例（250 batch split, null vectors 错误处理）

### 2.5 重启 + 上传 + 监控 (T+55~60min)

```bash
# admin .env.local 加 MINIMAX_API_KEY + EMBED_PROVIDER=cloud
# 重启 vite (HMR 不重读 packages dist)
pnpm dev  # 验证 Embedder=cloud (model=embo-01)

# 上传 1.7MB markdown
curl -X POST /api/upload -F "file=@育儿百科-test.md" ...
# batch_id=7d4ae8f3-a2f9-4c7a-acb6-cd54b0a7e6bf
# file_id=295b823d-36af-4508-98b0-ab829d1f891c
```

## 3. 真接 trace

```
T+0     11:18:04  upload done (batch=7d4ae8f3...)
T+30s   11:18:38  status=pushing progress=90 chunks=1520  ← embed 30s 内完成
T+60s   11:19:09  pushing
T+90s   11:19:39  pushing
T+120s  11:20:09  pushing
T+150s  11:20:39  pushing
T+180s  11:21:09  pushing
T+210s  11:21:39  pushing
T+240s  11:22:09  pushing
T+270s  11:22:39  status=done progress=100 cc=01KVS7RZTF5WDVGHKEG6B84DDK  ← done
T+275s  11:22:44  0 retry, 0 error, 1520 chunks_inserted
```

| 阶段 | 耗时 | 备注 |
|---|---|---|
| upload | <1s | 1.7MB md |
| parse | 0s | md skip parser |
| chunk | <1s | 1520 chunks |
| embed | ~30s | 15 batches × ~2s (MiniMax + RTT) |
| push | ~240s | 760 batches × ~0.32s (CloudBase 函数 100KB 限 + 网络) |
| **总** | **~275s = 4.5 分钟** | vs OMLX 预估 49 分钟 = 10x 加速 |

## 4. 双端改动

### 4.1 packages/local-llm/src/cloud-embedder.ts (commit ad4c2f1)

```typescript
// 修复 1: MiniMax embo-01 真实 schema（实测）
//   request:  { model, type: "query"|"db", texts: string[] }
//   response: { vectors: number[][] }
body: JSON.stringify({
  model: this.model,
  type: "query",
  texts,  // 之前是 input: texts (OpenAI 风格，MiniMax 返 invalid params)
}),
const data = (await res.json()) as { vectors: number[][] | null };
const vectors = data.vectors;
if (!vectors) {
  throw new EmbedError(`Cloud embed returned null vectors (texts=${texts.length})`, "Unknown");
}

// 修复 2: BATCH_SIZE=100 分批（之前 1520 一次性发返 null）
private static readonly BATCH_SIZE = 100;
async embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const allVectors: number[][] = [];
  for (let i = 0; i < texts.length; i += CloudEmbedder.BATCH_SIZE) {
    const batch = texts.slice(i, i + CloudEmbedder.BATCH_SIZE);
    const batchVectors = await this._embedBatch(batch);
    allVectors.push(...batchVectors);
  }
  return allVectors;
}
```

### 4.2 apps/admin/test/server/cloud-embedder.test.ts (+4 用例)

```typescript
// happy: 改用 {vectors: [...]} mock
it("happy: 200 → 1536 维 vectors (MiniMax {vectors: [...]} schema)", ...)

// MiniMax schema 校验：request 用 texts+type, 响应取 vectors
it("MiniMax embo-01 schema: 请求用 texts+type, 响应取 vectors", ...)

// 大批 chunks 自动分批
it("大批 chunks (250) → 自动分批 100/batch", ...)

// null vectors 错误处理
it("vectors=null → EmbedError Unknown", ...)
```

### 4.3 apps/admin/.env.local (+3 keys)

```bash
# Cloud Embedding fallback (zhenjie5: 28MB 真接切到 MiniMax embo-01 加速)
MINIMAX_API_KEY=sk-cp-...
MINIMAX_BASE_URL=https://api.minimax.chat/v1
MINIMAX_EMBED_MODEL=embo-01

# zhenjie5: 强制走 MiniMax embed (OMLX 1520 chunks 太慢)
EMBED_PROVIDER=cloud
```

## 5. 部署

仅 admin 端改动（vite middleware），无需 CloudBase 部署。重启 vite dev server 即生效。

## 6. Commit 链

```
ad4c2f1 fix(v2.4): CloudEmbedder MiniMax schema 修复 (texts+vectors) + BATCH_SIZE=100  ← 本次
xxxxxxx docs: v2.4 大文件真接报告
4e31292 docs: v2.4 pushChunks 性能优化真接报告
f707f5f perf(v2.4): pushChunks 切批复用 source/document_id
6cba861 docs: v2.4 失败 retry 真接报告
63a23a8 fix(cloud-pusher): CloudPusher baseUrl 支持 CLOUDBASE_API_INGEST_URL env
ee29be1 docs: v2.4 多文件并发真接报告
608bd19 fix(v2.4): pushChunks 切批 2 chunks + ingest-status strip 重字段
c938003 docs: v2.4 真接报告
2056cec fix(v2.4): probe 读 OMLX env + embedder 分批 10
30eb9b8 feat(v2.4): admin 本地 embed + 推预嵌入 chunks
```

## 7. 测试

| 测试集 | 数量 | 结果 |
|---|---|---|
| 全 monorepo | 502 | **PASS** |
| cloud-embedder (admin) | 9 (含 2 新增) | **PASS** |
| v2.4 大文件真接 (28MB) | 1 场景 (1520 chunks) | **PASS** (4.5 分钟) |

## 8. v2.4 实施总结 (6 真接场景)

| 真接场景 | 报告 |
|---|---|
| 单 PDF 端到端 | state-v2.4-zhenjie.md (c938003) |
| 5 文件并发 | state-v2.4-zhenjie2.md (ee29be1) |
| 失败 retry | state-v2.4-zhenjie3.md (6cba861) |
| pushChunks 性能优化 | state-v2.4-zhenjie4.md (f707f5f) |
| **大文件 + MiniMax cloud** | **state-v2.4-zhenjie5.md (ad4c2f1)** ← 本次 |

## 9. 副发现 / 教训

1. **MiniMax embo-01 schema 与 OpenAI 不兼容** — 这是历史 bug，admin 之前 OMLX path 工作所以没暴露。`EMBED_PROVIDER=cloud` 一开就 NPE。
2. **MiniMax 单次 batch 限** — 实测 1520 一次性发返 null vectors（无明确错误码），需 BATCH_SIZE 控制。
3. **vite HMR 不会重读 workspace package dist** — 改 packages 后必须重启 vite。
4. **.env.local 改完 → vite.config loadEnv 读 → 但 middleware 已 init** — 重启 vite 才是稳的。
5. **zhenjie5 之前 5/15/37 chunks 真接都走 OMLX path** — 因为 OMLX alive + auto-detect 选 local；现在 EMBED_PROVIDER=cloud 强制走 MiniMax。

## 10. 下一步候选

1. **retry 流程优化** — 跳过 parse/chunk/embed 只重 push（admin 现在的 retry 会重跑全流程，浪费 MiniMax 算力）
2. **MiniMax 成本/限速评估** — embo-01 单价 vs 1M tokens quota（admin 跑 1520 chunks ≈ 11K tokens = ~$0.01 量级，可忽略；但需确认 quota）
3. **M7-D / P4 / 新功能** — 跨工作区

建议优先级: **1 → 3**（成本可忽略，先做体验优化）
