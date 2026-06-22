# Arch-V2.4: admin 本地全链路 + 手工推预嵌入 chunks

**日期**：2026-06-22 23:50
**状态**：✅ 架构决策生效，待实施
**取代**：[state-arch-v2.3.md](./state-arch-v2.3.md)（"admin 端不 embed，API 端自己 embed" 已废弃）
**原因**：用户决定不用 MiniMax 做 embed，改用本地 OMLX Qwen3-Embedding-4B + matryoshka 1536

---

## 1. TL;DR

v2.3 的「admin 端不 embed → API 端 MiniMax embed」路径废弃。
新架构：**admin 本地做完整链路（解析 + chunk + embed + SQLite 暂存），手工推预嵌入 chunks 到 CloudBase，云端直接写库，不调任何 LLM**。

核心变化：

| 维度 | v2.3（已废弃） | v2.4（当前） |
|---|---|---|
| embed 位置 | CloudBase（MiniMax embo-01） | admin 本地（OMLX Qwen3-4B matryoshka 1536） |
| push payload | `{content, title, url, trust_level}` (84KB) | `{chunks: [{idx, content, embedding, tokenCount}], ...}` (含嵌入) |
| CloudBase 工作量 | 自己 chunk + embed + write | 只 write（零 LLM 调用） |
| MiniMax 依赖 | 必须（配额满阻塞） | 零依赖（纯 OMLX 本地） |
| 5MB 限制 | 无压力（84KB） | 有压力（80 chunks × ~6KB ≈ 500KB，仍远 < 5MB） |
| 手动推 | 推 content，云端 embed | 推预嵌入 chunks，云端直接写 |

---

## 2. 为什么改

v2.3 设计的核心假设："MiniMax 年卡配额足够，云端 embed 免费" — 但当天就暴露了两个问题：

1. **MiniMax 每日配额 5 小时**：超额后返回 `status_code:1008 insufficient balance`，全链路阻塞
2. **Qwen3-Embedding-4B 已装好 + OMLX 一直在跑**：本地 embed 能力是现成的，没道理不用

用户决策："所有用到大模型的地方都应该可配置 local/cloud"。在这个框架下，embed 走 local 是本分，不是例外。

---

## 3. 新状态机（6 状态 → 带 embed）

v2.3 把 embed 从 admin 端拿掉了（5 状态机），v2.4 加回来：

```
pending → parsing → chunking → embedding → pushing → done
                                       ↑ OMLX local
```

- `embedding`：调 OMLX Qwen3-Embedding-4B，matryoshka 截断到 1536 维（与 CloudBase 对齐）
- `pushing`：推 `{chunks: [{idx, content, embedding: number[1536], tokenCount}], title, url, trust_level, user_id?}`
- CloudBase 端收到 chunks[] → 直接 `collection.add()` 写库（0 MiniMax 调用）

### 性能预期

| 阶段 | 耗时 | 说明 |
|---|---|---|
| parsing（mineru）| ~60-120s | 14 页 1MB PDF，pipeline backend + modelscope |
| chunking | < 50ms | 纯计算，chunkText 500/80 |
| embedding | ~2-5s | OMLX Qwen3-4B，每批 ~0.5s × ~4 批（80 chunks / 20 每批） |
| pushing | ~1-3s | HTTP POST 5MB 内，CloudBase 直接写库 |
| **总计** | **~65-130s** | 跟 v2.3 差不多（v2.3 总 175s 中有 142s 是 GFW timeout） |

---

## 4. CloudBase 端改动

`apps/api/src/handlers/api-ingest.ts`：

```typescript
interface IngestRequest {
  chunks?: Array<{
    idx: number;
    content: string;
    embedding: number[];  // 1536 维 float
    tokenCount: number;
  }>;
  title?: string;
  url?: string;
  trust_level?: 0 | 1 | 2 | 3;
  user_id?: string;
}

// handler 处理
if (body.chunks && body.chunks.length > 0) {
  // v2.4 路径：直接写预嵌入 chunks，零 LLM 调用
  const source = await add<Source>(COLLECTIONS.source, { ... });
  const document = await add<Document>(COLLECTIONS.document, { ... });
  for (const c of body.chunks) {
    await add<Chunk>(COLLECTIONS.chunk, { ...c, document_id: document._id, source_id: source._id });
  }
  return { source_id: source._id, document_id: document._id, chunks_inserted: body.chunks.length };
}

// v1/v2.3 fallback 路径（保留向后兼容）
if (body.content) {
  const chunks = chunkText(body.content);
  const embeddings = await minimaxEmbed(chunks);
  // ...
}
```

---

## 5. Admin 端改动

### 5.1 IngestOrchestrator — 加回 embedding 阶段

```typescript
setEmbedder(embedder: Embedder): void { this.embedder = embedder; }

async processFile(fileId: string): Promise<void> {
  // parsing
  const markdown = await this.parser.parse(buf, ext);
  store.update(fileId, { status: "parsing", progress: 10 });
  // chunking
  const localChunks = this.chunker.chunkText(markdown);
  store.update(fileId, { status: "chunking", progress: 50, chunks_count: localChunks.length });
  // embedding（v2.4 新增）
  const texts = localChunks.map(c => c.content);
  const embeddings = await this.embedder.embed(texts);
  const chunks = localChunks.map((c, i) => ({ ...c, embedding: embeddings[i] }));
  store.update(fileId, { status: "embedding", progress: 80 });
  // pushing
  const result = await this.pusher.pushChunks({
    chunks, title: record.filename, url: record.filename, trust_level: record.trust_level,
  });
  store.markDone(fileId, result.source_id, result.document_id);
}
```

### 5.2 CloudPusher — 新 `pushChunks` 方法

```typescript
async pushChunks(input: {
  chunks: Array<{ idx: number; content: string; embedding: number[]; tokenCount: number }>;
  title?: string; url: string; trust_level: 0 | 1 | 2 | 3; user_id?: string;
}): Promise<CloudPusherResult> {
  const url = `${this.baseUrl}/api-ingest`;
  const body = JSON.stringify(input);
  // POST 逻辑复用现有 retry/backoff 逻辑
}
```

### 5.3 local-ingest.ts — 注入 embedder

```typescript
export async function initProductionDeps(): Promise<void> {
  const config = await initConfig();
  orchestrator.setParser(new LocalParser());
  orchestrator.setPusher(new CloudPusher());
  orchestrator.setChunker({ chunkText });
  // v2.4: 加回 embedder
  const embedder = createEmbedder(config.embed);
  orchestrator.setEmbedder(embedder);
  _initialized = true;
  console.log(`[local-ingest] Pusher=CloudBase (v2.4 chunks); Embedder=${config.embed.provider}`);
}
```

---

## 6. 不动的东西

- **Crawler 路径不变**：trigger.ts 已有本地 embed + ingest-sqlite 暂存（Phase B 已实现）
- **Admin Upload UI 不变**：Upload.tsx / SeedsPage / PendingPushList 不动
- **ManualPush 流程不变**：handleManualPush / handleRetry 改的是 push payload，不是 UI 流程
- **Config / loadEnv 不变**：上次修好（commit `ed8e0c0`）
- **OMLX 配置不变**：Qwen3-Embedding-4B + OMLX_BASE_URL + API key="mark"

---

## 7. 兼容性

### 7.1 老数据（v2.3 推的内容）

老 chunk 的 embedding 是 MiniMax embo-01（1536 维），新 chunk 的 embedding 是 Qwen3-4B（同 1536 维）。两个模型向量空间不完全一致，cosineSimilarity 在同一维度内计算。中文语料下两者 top-5 可能不同但都合理。这不是 bug，是两个不同 embedding model 的自然差异。

### 7.2 v2.3 push 路径保留

ingest handler 仍支持 `{content, title, url, trust_level, user_id?}`（v1/v2.3 格式），即使用户偶尔想走云端 MiniMax embed 也可用。

---

## 8. 改动清单

| 文件 | 改什么 | 行数估算 |
|---|---|---|
| `apps/api/src/handlers/api-ingest.ts` | 加 chunks 分支 | ~30 行 |
| `apps/admin/server/cloud-pusher.ts` | 加 `pushChunks()` + types | ~25 行 |
| `apps/admin/server/ingest-orchestrator.ts` | 加 `setEmbedder` + `embed()` 调用 | ~10 行 |
| `apps/admin/server/local-ingest.ts` | `initProductionDeps` 注入 embedder | ~3 行 |
| **合计** | | **~70 行** |

---

## 9. References

- **旧架构**（v2.3，已废弃）：[state-arch-v2.3.md](./state-arch-v2.3.md)
- **v2.3 真跑发现**：当时发现 admin embed 推云端 413 超 5MB，所以改推 content
- **v2.4 回退**：现在用 pre-embedded chunks（500KB 远小于 5MB），加回 embed 阶段
- **Embedder infra**：`apps/admin/server/embedder-factory.ts` + `local-embedder.ts` + `cloud-embedder.ts`（T14 时已建好）
- **Config**：`apps/admin/server/config.ts` `createEmbedder(config.embed)`（已就位）