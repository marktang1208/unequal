# state-v2.4-zhenjie4 — pushChunks 切批复用优化 PASS

> 日期: 2026-06-23
> 前置: state-v2.4-zhenjie3.md (commit 6cba861) — 失败 retry PASS
> 状态: ✅ pushChunks 切批复用 source/document_id — 15 chunks 端到端 -33%

## 1. 验收结果

| 维度 | 优化前 | 优化后 | 节省 |
|---|---|---|---|
| 15 chunks PDF 端到端 | T+90s | T+60s | **30s (-33%)** |
| 37 chunks README 端到端 | T+280s | T+209s | **71s (-25%)** |
| source/document 重复创建 | 8 个 / file | 1 个 / file | -87.5% |
| CloudBase 函数调用 | 8 次 / file | 8 次 / file | 同（HTTP 调用数不变，省的是 handler 内 add 次数）|
| 测试 | 498/498 | 499/499 | +1 (新 14b 测试) |

## 2. 优化原理

### 优化前 (commit ee29be1)

```
15 chunks → 8 批 (MAX=2)
每批都调 api-ingest handler:
  批 1: add<Source> + add<Document> + 2× add<Chunk>
  批 2: add<Source> + add<Document> + 2× add<Chunk>  ← 重复
  ...
  批 8: add<Source> + add<Document> + 1× add<Chunk>  ← 重复

总: 8× add<Source> + 8× add<Document> = 16 个重复实体
```

### 优化后 (commit f707f5f)

```
15 chunks → 8 批 (MAX=2)
首批: 不带 source_id/document_id → handler 创建 source + document + 2 chunks
后续批: 带 source_id + document_id (first batch 的) → handler 跳过 source/document 新建

总: 1× add<Source> + 1× add<Document> = 2 个实体 (-87.5%)
```

## 3. 双端改动

### 3.1 admin cloud-pusher.ts (commit f707f5f)

```typescript
// ChunksPushInput 加可选 source_id/document_id
export interface ChunksPushInput {
  chunks: ...;
  title?: string;
  url: string;
  trust_level: 0 | 1 | 2 | 3;
  user_id?: string;
  source_id?: string;     // 新
  document_id?: string;   // 新
}

// pushChunks 切批后续批传 first batch 的 ID
for (let i = 0; i < allBatches.length; i++) {
  const batch = allBatches[i]!;
  if (i > 0 && firstResult) {
    batch.source_id = firstResult.source_id;
    batch.document_id = firstResult.document_id;
  }
  const r = await this._doPost(batch);
  ...
}
```

### 3.2 api api-ingest.ts (commit f707f5f)

```typescript
interface IngestRequest {
  source_id?: string;
  document_id?: string;   // 新
  ...
}

// handler 接受 document_id → 复用跳过新建
if (body.document_id) {
  docId = body.document_id;
} else {
  docId = (await add<Document>(COLLECTIONS.document, {...})) ?? "";
}
```

### 3.3 api-ingest.test.ts 新增 14b (commit f707f5f)

```typescript
it("14b. v2.4 切批复用: body.document_id → 跳过 document add", async () => {
  // mock add per collection
  add: vi.fn(async (_coll) => _coll === "source" ? "01HNEWSRC" : ...)

  const res = await main(makeEvent({
    body: JSON.stringify({
      source_id: "01HNEWSRC",
      document_id: "01HEXISTINGDOC",
      chunks: [{...}, {...}],  // 2 chunks
    }),
  }));

  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).document_id).toBe("01HEXISTINGDOC");
  
  // 关键断言: document collection 的 add 不应被调用
  const docAdds = add.mock.calls.filter(c => c[0] === "document");
  expect(docAdds).toHaveLength(0);  // ← 跳过 document 新建
});
```

## 4. 部署

新 API bundle 含 document_id 支持 → `tcb fn deploy api-router` → CloudBase 部署成功。

验证：直 curl `/api-ingest` 两次（首次不带 document_id，第二次带）：
```
batch 1: source_id=01KVS4GK1..., document_id=01KVS4GK30...
batch 2: source_id=01KVS4GK1... (复用), document_id=01KVS4GK30... (复用)  ← 生效
```

## 5. 真接 trace

```
[15 chunks PDF]
T+0~30s: parsing (mineru 串行)
T+30~50s: embedding (OMLX 8 批 × 10 chunks/批)
T+50~60s: pushing (8 批 × ~1.3s/批，复用 source/document)
T+60s: done, cloud_source_id=01KVS4K8TX5MP8, cloud_document_id=01KVS4K8X5S264

[37 chunks README]
T+0~30s: parsing
T+30~160s: embedding (OMLX 4 批 × 10 chunks/批)
T+160~210s: pushing (19 批 × ~3s/批，复用 source/document)
T+210s: done
```

## 6. commit 链

```
f707f5f perf(v2.4): pushChunks 切批复用 source/document_id — 15 chunks 端到端 -33%  ← 本次
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
| 全 monorepo | 499 | **PASS** |
| v2.4 pushChunks 性能优化真接 | 2 场景 (15ch + 37ch) | **PASS** (本轮) |

## 8. v2.4 实施总结（5 真接场景）

| 真接场景 | 报告 |
|---|---|
| 单 PDF 端到端 | state-v2.4-zhenjie.md (c938003) |
| 5 文件并发 | state-v2.4-zhenjie2.md (ee29be1) |
| 失败 retry | state-v2.4-zhenjie3.md (6cba861) |
| **pushChunks 性能优化** | **state-v2.4-zhenjie4.md (f707f5f)** ← 本次 |

## 9. 下一步候选

1. **大文件真接** — 28MB 育儿百科 PDF (200+ chunks)，验证极限容量
2. **retry 流程优化** — 跳过 parse/chunk/embed 只重 push（当前 retry 重跑整流程浪费 OMLX 算力）
3. **M7-D / P4 / 新功能** — 跨工作区

建议优先级: **1 → 2 → 3**（容量 → 体验 → 新功能）