# state-v2.4-zhenjie3 — 失败 retry 真接 PASS

> 日期: 2026-06-23
> 前置: state-v2.4-zhenjie2.md (commit ee29be1) — 5 文件并发 PASS
> 状态: ✅ pushChunks 5xx 失败 → POST /api/retry → done 端到端 PASS

## 1. 验收结果

| 维度 | 结果 |
|---|---|
| 5xx 失败触发 | ✅ fake-fail server 返 500 → CloudPusher 重试 2 次后抛 PushFailed |
| retryable 标记 | ✅ orchestrator classifyError 归 PushFailed retryable=1 |
| 状态持久化 | ✅ admin restart 后 SQLite 保留 failed record |
| POST /api/retry | ✅ 30s 内 done + 新 cloud_source_id |
| 测试 | ✅ 498/498 PASS 无 regression |

## 2. 真接 trace

```
[Step 1] admin dev with CLOUDBASE_API_INGEST_URL=http://localhost:9999 (fake-fail server)
  POST /api/upload (32-简历.pdf 386KB)
  → batch_id=0c87d5a5 file_id=e575daa4 status=pending
  
[T+0~20s] parsing → embedding (正常)
[T+20s] pushing → fake-fail server 返 500
[T+20~30s] CloudPusher 5xx retry 2 次 (maxRetries5xx=2) 都 500
[T+30s] 抛 PushFailed retryable=true
  → store.markFailed: status=failed, error_code=PushFailed, retryable=1, retry_count=1

fake-fail server log: 3× POST /api-ingest (1 first + 2 retry)

[Step 2] kill admin + restart with 正确 CLOUDBASE URL
  store 保留 failed record (SQLite 文件持久化)

[Step 3] POST /api/retry?file_id=e575daa4
  → store.resetForRetry (retry_count reset 0)
  → orchestrator.processFile 重跑
  → parsing → embedding → pushing (用正确 baseUrl → 200 OK)
[T+30s] done, cloud_source_id=01KVS3A01MYBM2...
```

## 3. 真接期间改的代码

### cloud-pusher.ts baseUrl env 注入 (commit 63a23a8)

```typescript
// 改前
this.baseUrl = opts.baseUrl ?? "https://unequal-d4gg...tcloudbase.com";

// 改后
this.baseUrl = opts.baseUrl ?? process.env.CLOUDBASE_API_INGEST_URL ?? "https://unequal-d4gg...tcloudbase.com";
```

**原因**: 真接 retry 测试需要能临时替换 push URL 模拟 5xx 失败。**只影响测试，prod 默认行为不变**（env 没设 = 写死生产 URL）。

## 4. 关键观察

### 4.1 CloudPusher retry 行为
- 5xx 触发 1 + maxRetries5xx(2) = **3 次请求**
- 4xx (401/403/400) **不重试**，立即抛
- 429 走独立 retry 计数 (maxRetries429=3)

### 4.2 orchestrator classifyError
- PushError retryable 字段被消息推断覆盖 (line 176-177)
- 5xx/Network 走 "PushFailed" retryable=true ✅
- 4xx/Auth 走 "PushAuthError" retryable=false ❌ (不可 retry)

### 4.3 store resetForRetry
- retry 触发时 retry_count reset 0
- 避免 "retry 成功后再 retry 把计数用光" 的边角问题
- 副作用：retry_count 不反映真实重试历史（admin UI 可考虑加 retry_log 表）

### 4.4 重跑整流程的代价
- retry 触发后 orchestrator.processFile 重跑 parse + chunk + embed + push
- 对 386KB PDF 额外 30s（与首次上传相当）
- 优化方向：retry 时跳过 parse/chunk/embed，只重 push（需 store 缓存 chunks+embeddings）

## 5. commit 链

```
63a23a8 fix(cloud-pusher): CloudPusher baseUrl 支持 CLOUDBASE_API_INGEST_URL env  ← 本次
ee29be1 docs: v2.4 多文件并发真接报告
608bd19 fix(v2.4): pushChunks 切批 2 chunks + ingest-status strip 重字段
c938003 docs: v2.4 真接报告 (单 PDF 30s PASS)
2056cec fix(v2.4): probe 读 OMLX env + embedder 分批 10
30eb9b8 feat(v2.4): admin 本地 embed + 推预嵌入 chunks
```

## 6. 测试

| 测试集 | 数量 | 结果 |
|---|---|---|
| 全 monorepo | 498 | **PASS** |
| v2.4 retry 真接 | 1 场景 | **PASS** (本轮新加) |

## 7. v2.4 实施总结（4 commit + 4 真接场景）

| 真接场景 | 状态 | 报告 |
|---|---|---|
| 单 PDF 端到端 | ✅ | state-v2.4-zhenjie.md (c938003) |
| 5 文件并发 | ✅ | state-v2.4-zhenjie2.md (ee29be1) |
| pushChunks 切批 | ✅ (via 5 文件并发) | state-v2.4-zhenjie2.md (ee29be1) |
| 失败 retry | ✅ | state-v2.4-zhenjie3.md (63a23a8) |

## 8. 下一步候选

1. **pushChunks 性能优化** — 复用 first batch source_id/document_id 减少 75% 请求
2. **大文件真接** — 28MB 育儿百科 PDF (200+ chunks)
3. **retry 流程优化** — 跳过 parse/chunk/embed 只重 push
4. **M7-D / P4 / 新功能** — 跨工作区

建议优先级: **1 > 2 > 3 > 4**（性能 → 容量 → 体验 → 新功能）
