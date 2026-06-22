# Arch-V2.3: T15 真跑发现 — admin 端不 embed，API 端自己 embed

**日期**：2026-06-22 11:30
**状态**：✅ 真跑验证通过（commit 5e63e41）
**作者**：T15 真跑发现 + 用户决策
**影响范围**：CloudPusher + IngestOrchestrator + LocalEmbedder 角色
**替代**：[state-arch-v2.md](./state-arch-v2.md) §3 chunks 直传协议（v2 schema 暂未实装）

---

## 1. TL;DR

T15 真跑（admin dev + curl upload + CloudBase 端到端）发现 v2 设计的"admin 端 embed + 传 chunks"路径**无法走通**：

- API 端 `apps/api/src/handlers/api-ingest.ts` 实际实现的是 **v1 schema**：`{content, title, url, trust_level, user_id?, source_id?}`
- API 端**没有实现 v2 schema 的 `chunks` 字段**
- API 端**自己 chunk + embed**（`chunkText` + `createMiniMaxEmbedder`，MiniMax embo-01 → 1536 维）

修正：CloudPusher 改 payload = `{content, title, url, trust_level, user_id?}`，admin 端 **不 embed**。

---

## 2. T15 真跑发现的 3 个 bug

### 2.1 mineru backend = hybrid-auto-engine 失败

**症状**：`mineru exit code 1`，stderr 无明显异常（之前没打印）

**原因**：`hybrid-auto-engine` 模式需要 VLM 模型（`MinerU2.5-Pro` VLM 版本），未安装该模型就 fallback 失败

**修复**：改为 `pipeline` backend（model init cost 17s，14/14 pages 成功解析）

**附带改进**：LocalParser catch 块加 stderr 打印（之前只打 message，不打 stderr，下次诊断更慢）

### 2.2 CloudPusher.baseUrl 多写 /api-router 段

**症状**：POST → `404 {"error":"NOT_FOUND","message":"No handler for api-router"}`

**原因**：CloudPusher 写 baseUrl = `https://xxx.ap-shanghai.app.tcloudbase.com/api-router`，
但 CloudBase 端 ingest endpoint 实际路径是 `/api-ingest`（顶层路径，不是 `/api-router/api-ingest`）

**修复**：baseUrl 去 `/api-router` 段，改 `https://xxx.ap-shanghai.app.tcloudbase.com`，POST 路径用 `/api-ingest`

### 2.3 CloudPusher payload schema 错位

**症状**：POST `/api-router/api-ingest` 修复后 → 413 `EXCEED_MAX_PAYLOAD_SIZE`
（即使路径对，1MB PDF → 84KB markdown + 30 chunks × 30KB embeddings ≈ 1.5MB，刚超 CloudBase 5MB 限制）

**原因**：CloudPusher 推 v2 schema `{markdown, chunks+embedding, document_meta, source_meta}`，但 API 端期望 v1 schema `{content, title, url, trust_level, user_id?}`，API 端**不接收 chunks 字段**——payload 巨大但 95% 数据被 API 端忽略

**修复**：
- payload 简化为 v1 schema 5 字段
- admin 端不 embed（LocalEmbedder 在 pipeline 中下线）
- 1MB PDF → 84KB markdown 单字段，完全不进 5MB 限制

---

## 3. 架构修正：6 状态机 → 5 状态机

**旧状态机**（v2 设计）：
```
pending → parsing → chunking → embedding → pushing → done
                    ↑ admin     ↑ admin     ↑ admin
```

**新状态机**（v2.3 真跑后）：
```
pending → parsing → chunking → pushing → done
                    ↑ admin (chunk for status 展示)
                                          ↑ API 端自己 chunk + embed
```

**IngestOrchestrator 变更**：
- 删 `setEmbedder()` 方法 + `LocalEmbedder` dependency
- 删 processFile 中 `embedding` 阶段
- push payload 简化为 `{content, title, url, trust_level, user_id?}`
- `LocalEmbedder` + `EmbedderFactory` + `CloudEmbedder` 基础设施**保留**
  （供未来离线缓存 / fallback / 预 embed cache 优化时复用）

**LocalEmbedder 不下线理由**：
- admin 端仍有 fallback 探测（`probeOmlx` 测 OMLX 8000 可达性）
- 未来 P1 性能优化可能用 admin 预 embed + 缓存（如果 OMLX 算力有富余）
- LLM Provider 抽象（v2.3 同步）已经搭好，删了反而要重搭

---

## 4. T15 真跑结果

### 4.1 小 md 文件

- 文件：`/tmp/test.md`（374B，2 段）
- status=done, progress=100
- cloud_source_id=`01KVPNR7PVTQ79V9K5EAM8SYNS`
- cloud_document_id=`01KVPNR7S65P9P6Y72J35H7TTE`
- chunks_inserted=1
- 总耗时 < 2 秒

### 4.2 1MB PDF（核心场景）

- 文件：`/tmp/test.pdf`（1MB，14 页，双语）
- mineru pipeline 解析 → 84KB markdown
- chunks_count=80（admin 端 chunk 展示用）
- status=done, progress=100
- cloud_source_id=`01KVPNVXEZNEZJQ8JN8SRCKHFP`
- cloud_document_id=`01KVPNVXGTXZ1RNN2Q0H8RR7DR`
- 总耗时 ~74s（mineru PDF 解析 ~30s + admin chunk + API embed + 写库）

### 4.3 端到端链路

```
Mac 本地 (admin dev)                   CloudBase (ap-shanghai)
═══════════════════                    ══════════════════════
1. multipart upload /api/upload
2. LocalParser.parsePdf (mineru pipeline) → markdown
3. Chunker.chunkText → 80 chunks (展示)
4. CloudPusher.push({
     content: markdown,              ──────POST /api-ingest────→
     title, url: local://test.pdf,          {content, title, url, trust_level, user_id}
     trust_level: 1, user_id
   })                                 ←────{source_id, document_id, chunks_inserted: 80}─
5. markDone(source_id, document_id)
```

**5 阶段全部走通**，无 fallback，无降级，无 413，无 404。

---

## 5. 未来路径：API 端支持 chunks 字段

如果未来想让 admin 端做本地缓存优化（预 embed + 跳过重复上传）：

### 5.1 API 端扩展 IngestRequest

```typescript
// apps/api/src/handlers/api-ingest.ts
interface IngestRequest {
  source_id?: string;
  content?: string;        // v1 字段
  chunks?: Array<{         // v2 字段（新增）
    idx: number;
    content: string;
    embedding: number[];   // 1536 维
    tokenCount: number;
  }>;
  title?: string;
  url?: string;
  trust_level?: 0 | 1 | 2 | 3;
  user_id?: string;
}
```

### 5.2 行为分支

```typescript
if (body.chunks && body.chunks.length > 0) {
  // v2 路径：跳过 API 端 embed，直接写库
  for (const c of body.chunks) await add<Chunk>(COLLECTIONS.chunk, c);
} else if (body.content) {
  // v1 路径：API 端 chunk + embed（当前）
  const chunks = chunkText(body.content, ...);
  const embeddings = await embed.embed(texts);
  for (...) await add<Chunk>(...);
}
```

### 5.3 收益

- admin 端可缓存 embedding（避免重 embed 同一 PDF）
- 走本地 OMLX 时省云端 MiniMax API 调用（成本）
- 大文件（>5MB markdown）可分批 chunks 推送

### 5.4 代价

- API 端 schema 复杂度↑
- CloudPusher payload 大小回归（30 chunks × 30KB = 1MB+）
- CloudBase 5MB 限制压力回归（要分批 push 或 chunks batching）

**当前 v2.3 不实现，等 P1 性能优化阶段再决定**。

---

## 6. LLM Provider 抽象（同步进展）

T15 真跑同步推进 LLM Provider 抽象（用户决策："所有用到大模型的地方都应有配置项选 local/cloud"）：

- `apps/admin/server/config.ts`：`EmbedderConfig` + `ChatConfig` + `PdfConfig`，env 驱动
- `apps/admin/server/embedder-factory.ts`：`createEmbedder()` 按 provider 返 `LocalEmbedder` 或 `CloudEmbedder`
- `apps/admin/server/cloud-embedder.ts`：`CloudEmbedder`（MiniMax embo-01 → 1536 维）
- `apps/admin/server/local-embedder.ts`：`LocalEmbedder`（OMLX 8000 → Qwen3-Embedding-4B + matryoshka 1536）
- env：`EMBED_PROVIDER` / `LLM_PROVIDER` / `OMLX_BASE_URL` / `OMLX_API_KEY` / `OMLX_EMBED_MODEL` / `MINIMAX_API_KEY` 等
- auto mode：探 OMLX 8000 可达 → local，否则 cloud

**当前 v2.3 不实装 pipeline，但 provider 抽象已就位**（基础设施完备），
未来 P1 性能优化（admin 端预 embed）时直接用。

---

## 7. 兼容性 / 迁移

### 7.1 已修复

- ✅ `CloudPusher` payload 改 v1 schema
- ✅ `IngestOrchestrator` 去 embedding 阶段
- ✅ `LocalParser` mineru backend = pipeline
- ✅ `LocalParser` catch 块打印 stderr
- ✅ `local-ingest.ts` init 不注入 embedder

### 7.2 测试覆盖

- ✅ `config.test.ts`：7 cases 全过（auto / local / cloud / 无 key 抛错 / pdf config）
- ✅ `cloud-embedder.test.ts`：6 cases 全过（happy / dim / 401 / 500 / 网络错 / 空）
- ✅ `embedder-factory.test.ts`：4 cases 全过（local / cloud / 缺 baseUrl / 缺 apiKey）
- ✅ `ingest-orchestrator.test.ts`：去 setEmbedder 调用，6 cases 全过
- ✅ `local-ingest.test.ts`：去 setEmbedder 调用，12 cases 全过
- ✅ 全部 141/141 测试通过

### 7.3 未来兼容

- `LocalEmbedder` / `CloudEmbedder` 接口保留（`createEmbedder` 可被未来 P1 性能优化复用）
- `IngestOrchestrator` 状态机不破坏 5 阶段调用（未来加回 embedding 阶段不改 schema）
