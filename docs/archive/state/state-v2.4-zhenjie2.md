# state-v2.4-zhenjie2 — 5 文件并发真接 PASS + CloudBase 1MB 限制修复

> 日期: 2026-06-23
> 前置: state-v2.4-zhenjie.md (commit c938003) — 单 PDF 端到端 30s PASS
> 状态: ✅ 5 文件并发 PASS — pushChunks 切批 2 + status slim 修复

## 1. 验收结果

| 维度 | 结果 |
|---|---|
| 多文件并发 | ✅ 5 文件 (3 PDF + 1 MD + 1 HTML) 全部 done |
| 大 chunks 文件 | ✅ 15 chunks / 37 chunks PDF+MD 端到端成功 |
| 测试回归 | ✅ 498/498 PASS |
| CloudBase 1MB 限制 | ✅ 适配 (pushChunks 自动切批 ≤2 chunks ≈66KB) |
| status 响应瘦身 | ✅ 6.5MB → < 1KB |

### 1.1 5 文件并发 trace

```
batch_id=16bcaa49-6412-4da2-9428-ee4e58105ad6
files: 24-核查.pdf(15ch) + 32-简历.pdf(1ch) + 33-面试.pdf(1ch) + README.md(37ch) + 2605.html(4ch)

T+0~70s: parser 串行 (ConcurrencyGate.parser=1)
  - PDF 串行 3 个 + MD/HTML 后行
T+40s: 24-核查进 embedding
T+70s: 24-核查 + 32-简历 done
T+100s: 33-面试 done
T+180s: 2605.html done
T+~280s: README.md 37 chunks done (最后一文件，4 批 × 10 chunks OMLX 串行)

最终 cloud_source_id:
  24-核查.pdf    → 01KVR63P4ANY3AGBVQ1653CQ86
  32-简历.pdf    → 01KVR63VRKRAB307Q3R5PN3NG1
  33-面试.pdf    → 01KVR64RMQS374MRY7VRAH80DA
  README.md      → 01KVR6A6Z253FQN1D4BFDTC46X
  2605.html      → 01KVR6795A0C0T3XWEC5A5RMAY
```

## 2. 真接期间发现并修的 bug

### 2.1 CloudBase maxRequestBodySize ≈ 100KB (commit 608bd19)

**症状**: 5 文件并发跑时 24-核查 (15 chunks) + 2605.html (4 chunks) 报 `413 EXCEED_MAX_PAYLOAD_SIZE`，单 PDF 386KB 单独跑没事。

**根因**:
- CloudBase Event 函数默认 `maxRequestBodySize ≈ 100KB`（实测触边界 100KB）
- pushChunks payload ≈ `chunk 数 × (content + embedding JSON)`
- 每个 chunk embedding 1536 维 float JSON 序列化 ≈ 21 char/维 = 32KB embedding + 1KB content = **33KB/chunk**
- 5 chunks payload = 165KB > 100KB ❌
- 3 chunks payload = 99.9KB ⚠️ 临界，仍触发 413
- 2 chunks payload = 66KB ✅ 留 34KB 安全边距

**修复** (`apps/admin/server/cloud-pusher.ts`):
```typescript
static readonly MAX_CHUNKS_PER_PUSH = 2;

async pushChunks(input: ChunksPushInput): Promise<CloudPusherResult> {
  if (input.chunks.length <= CloudPusher.MAX_CHUNKS_PER_PUSH) {
    return this._doPost(input);
  }
  // 切批：保留首条 source/document ID 关联
  const allBatches: ChunksPushInput[] = [];
  for (let i = 0; i < input.chunks.length; i += CloudPusher.MAX_CHUNKS_PER_PUSH) {
    allBatches.push({...input, chunks: input.chunks.slice(i, i + CloudPusher.MAX_CHUNKS_PER_PUSH)});
  }
  let firstResult: CloudPusherResult | null = null;
  let totalInserted = 0;
  let totalFailed = 0;
  for (const batch of allBatches) {
    const r = await this._doPost(batch);
    if (!firstResult) firstResult = r;
    totalInserted += r.chunks_inserted;
    totalFailed += r.chunks_failed;
  }
  return {source_id: firstResult!.source_id, document_id: firstResult!.document_id, chunks_inserted: totalInserted, chunks_failed: totalFailed};
}
```

**副作用**:
- 80 chunks 文件从 1 次推 → 40 次推，端到端时间 +1min 可接受
- v1 embed API 推大文件可能要进一步优化（可选：embedding 用 float16/8 字节省空间）

### 2.2 ingest-status 6.5MB 响应 (commit 608bd19)

**症状**: 5 文件 batch 完成后 `GET /api/ingest-status?batch_id=X` 返 6.5MB JSON，包含 `tmp_data`(Buffer base64) + `markdown` + `chunks_json` 全文。前端 parse 6.5MB 含控制字符会爆。

**根因**: `local-ingest.ts handleStatus` 直接返 `store.listByBatch(batchId)`，里面每个 file 的 `tmp_data`/`markdown`/`chunks_json` 都被 JSON 序列化。

**修复**:
```typescript
const slim = files.map((f) => ({
  file_id: f.file_id, batch_id: f.batch_id, filename: f.filename, ext: f.ext,
  status: f.status, progress: f.progress, chunks_count: f.chunks_count,
  cloud_source_id: f.cloud_source_id, cloud_document_id: f.cloud_document_id,
  error_code: f.error_code, error_message: f.error_message,
  retry_count: f.retry_count, retryable: f.retryable,
  created_at: f.created_at, updated_at: f.updated_at,
  source: f.source, trust_level: f.trust_level,
}));
```

**副作用**: 如果未来 admin UI 要看 markdown 全文，需另开 `/api/file-content?file_id=X` 端点（暂不需要）。

## 3. v2.4 实施完整 commit 链

```
608bd19 fix(v2.4): pushChunks 切批 2 chunks + ingest-status strip 重字段  ← 本次
c938003 docs: v2.4 真接报告 — 单 PDF 端到端 30s PASS
2056cec fix(v2.4): probe 读 OMLX env + embedder 分批 10
30eb9b8 feat(v2.4): admin 本地 embed + 推预嵌入 chunks
3a9d4e7 docs: v2.4 架构 + v2.3 废弃
ed8e0c0 fix: mineru exit 1 根因诊断 + 修复
```

## 4. 测试状态

| 测试集 | 数量 | 结果 |
|---|---|---|
| admin unit + integration | 162 | PASS |
| api unit + integration | 129 | PASS |
| minipgm + crawler + packages | 207 | PASS |
| **总计** | **498** | **PASS** |
| v2.4 单 PDF 真接 | 1 场景 | PASS |
| v2.4 5 文件并发真接 | 1 场景 | **PASS** (本轮新加) |

## 5. v2.4 性能观察

| 维度 | 单 PDF | 5 文件并发 |
|---|---|---|
| parser | mineru 串行 (~30s/PDF) | 3 PDF 串行 ~90s |
| embedder | OMLX 1 批 ~18s | OMLX 串行 (4 批 × ~20s) |
| pusher | pushChunks 1 次 ~5s | pushChunks 切批 (≤2 chunks) ~30-60s |
| 总耗时 | ~30s (单小 PDF) | ~280s (5 文件含 15+37 chunks) |

**瓶颈**: mineru parser 串行 + OMLX 串行（每次 batch_size=10）。后续优化方向：
1. parser 池化 (ConcurrencyGate.parserMax 1→2)
2. embedder 并发 (ConcurrencyGate.embedMax 3→5)
3. pushChunks 复用 first batch 的 source/document 减少 75% 请求

## 6. 待办（next session 候选）

1. **失败 retry 真接** — 故意断 CloudBase 验证 pushChunks retry → 恢复
2. **大文件真接** — 28MB 育儿百科 PDF，验证 200+ chunks 端到端
3. **OMLX client connection 池化 + AbortController** — 防 zombie 连接
4. **pushChunks 性能优化** — 复用 first batch source_id/document_id 减少 75% 请求
5. **M7-D / P4 / 新功能** — 跨工作区候选

建议优先级: **1 > 4 > 2 > 3**（短链验证 → 性能 → 大文件 → 防御）