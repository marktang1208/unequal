# P9 NLI 后置 (不阻塞 chat response) — 设计

> 日期: 2026-06-25
> 作者: Mark + Claude (brainstorming 协作)
> 状态: ⏸️ Design approved sections 0-1, pending user review §2+
> Tag: `p9-nli-async-polling`
> 前置:
> - P8 vector DB 集成 PASS (state-p8-vector-db-pgvector.md) — retrieval P99 < 100ms (P5 v1.3 瓶颈解)
> - P5 v1.4 跨轮 NLI (commit ccf6895) — 跨轮 hypothesis 实际工作
> - P6 本地 ONNX NLI (state-p6-local-onnx-nli.md) — cold 1.9s / warm < 500ms

---

## 0. TL;DR

P5 v1.3 NLI 同步在 chat 响应路径上, **阻塞 response 1.9s cold / < 500ms warm**。P9 改 **NLI 异步**: chat 立即返 answer (不阻塞), 后台 `setImmediate` 调 NLI 写 `audit_log` (`action=chat_nli_async`), mini program **polling GET `/api-nli-result?turnId=<id>`** 查 verdict (3s 起始 + 2s 间隔 × 5, 13s 总)。

**核心收益**:
- chat 响应 26s → 24s (省 1.9s NLI cold, 22s 主路径不变因 LLM 仍是主耗时)
- NLI 误判 verdict 不再阻塞用户看 answer (5-10s 后才推 warning, 用户体验顺)
- P5 v1.4 跨轮 NLI + P8 PG HNSW + P9 异步三层叠加, chat UX 达最优

**核心决策**:
- **Polling 轮询** (1 文件改, 不引 SSE/WebSocket/CFS 异步)
- **复用 audit_log** + 新增 `chat_nli_async` action (sync/async verdict 隔离, action 区分)
- **3-2-5 节奏** (3s 起始 + 2s 间隔 × 5, 13s 总, 拿不到 verdict fallback 返原 answer)
- **`turnId` 唯一标识** (新加 chat response 字段, `session_id:turn_seq` 格式, 后端读 audit_log filter)

**架构边界**:
- P5 v1.3 sync NLI 路径**保留** (作 fallback, 跟 P9 async 平行)
- handler 内部 `setImmediate` 后台 fire-and-forget (P9 不阻塞 chat 响应)
- mini program 改 1 个文件 (轮询逻辑)
- 1 新 handler `api-nli-result.ts` (~50 行)

---

## 1. 决策摘要

| 决策点 | 选择 | 原因 |
|---|---|---|
| **核心目标** | NLI 后置 (不阻塞 chat response) | P8 PG HNSW 已快, NLI 1.9s cold 异步不阻塞 → UX 提升明显 + 跟 P5 v1.4 跨轮 NLI 协同 + 中等成本 |
| **异步路径** | polling 轮询 (1 文件改) | 改动小, 不动 chat 响应路径, 客户端 2 次请求 (chat + 轮询) |
| **轮询节奏** | 3s 起始 + 2s 间隔 × 5 (total 13s) | 30s 内总耗时 + 不增后端压力; NLI 慢时 fallback 返原 answer |
| **verdict 持久化** | 复用 audit_log + chat_nli_async action | 复用现有 audit_log 架构, 不加新表; action 区分 sync/async |
| **chat response 字段** | 新增 `nliTurnId` (string \| null) | client 拿 turnId 轮询; null 表示 P5 v1.3 sync 路径走 (P5 backward compat) |
| **sync/async 切换** | env var `NLI_ASYNC=1\|0` (default 0) | 灰度 1 行 env; 默认 sync 走 P5 v1.3 行为不变 |
| **NLI 失败处理** | 写 audit_log (action=chat_nli_async, reason=runtime_error/timeout) + 不返 warning | async 路径, warning UX 已移到轮询 verdict |
| **chat warning prefix** | **保留 (sync 路径)** + **删 (async 路径)** | sync 路径走 P5 v1.3 老行为 (返 answer + warning prefix), async 路径不返 prefix (warning 移到轮询 verdict) |
| **P5 v1.4 跨轮 NLI** | 保留 (在后台 setImmediate 内走跨轮) | 跨轮 hypothesis union 不动, 仅同步/异步切 |
| **P8 PG HNSW** | 不动 (走 queryTopK 50 candidates) | 检索路径不变, 仅 NLI 调用时序改 |
| **回滚** | env var `NLI_ASYNC=0` (默认) | 1 行 env 回滚, P5 v1.3 sync 行为恢复 |
| **测试** | 12 单测 (mock setImmediate + audit_log 写) | 单元测试 + 真接 T1+T2 验 |

---

## 2. 架构

### 2.1 高层图

```text
[1] 用户 chat → api-chat handler (P8 Phase 4, VECTOR_STORE=pg/nosql 灰度)
    ↓
[2] embed query + PG HNSW topK*10=50 candidates (P8 不动)
    ↓
[3] searchChunks trust/recency 加权 → top-5 chunks (P5 v1.3 不动)
    ↓
[4] LLM chat completion (~20s, P5 不动, 主耗时)
    ↓
[5] parseAnswerSegments (P5 v1.3 [N] 解析, 不动)
    ↓
[6] NLI 路径分支 (P9 新增):
    ├─ env.NLI_ASYNC === "1" (灰度):
    │  ├─ 同步路径跳过 NLI (P5 v1.3 块删)
    │  ├─ 生成 turnId = `${session_id}:${turn_seq}`
    │  ├─ **setImmediate 异步 fire-and-forget**:
    │  │   - getProvider().verify() (1.9s cold, < 500ms warm)
    │  │   - write audit_log (action=chat_nli_async, nliSnapshot{turnId, verdict, score, latencyMs})
    │  └─ chat 立即返 answer + nliTurnId=turnId
    └─ env.NLI_ASYNC !== "1" (默认, P5 v1.3 兼容):
       └─ 同步 NLI 路径保留 (返 answer + warning prefix)
    ↓
[7] chat 响应 200 (24s, 1.9s 节省; sync 路径 26s 不变)
    ↓
[8] mini program 拿 chat response, 解析 nliTurnId
    ↓
[9] 3s 后开始轮询 GET /api-nli-result?turnId=<id>:
    ├─ 查 audit_log filter {action=chat_nli_async, nliSnapshot.turnId=turnId}
    ├─ 命中: 返 {verdict, score, latencyMs, isWarning}
    │   ├─ verdict === "entailed": 不显示 warning
    │   ├─ verdict === "contradiction" / "neutral" && score < 0.5: 显示 warning UI
    │   └─ 命中即停轮询
    └─ 未命中: 2s 后重试, 5 次后 fallback (不显示 warning, 接受原 answer)
```

### 2.2 关键边界

- **P5 v1.3 sync 路径保留** (`NLI_ASYNC=0` 默认): 不破坏现有 chat 行为, P5/P6/P7 真接测试照常工作
- **NLI provider 不动**: `getProvider()` 复用 P6 本地 ONNX, P9 仅在调用时序上改
- **audit_log schema 扩展**: `nliSnapshot.turnId` 字段新加, 兼容旧 record (旧 record turnId 缺, polling 返 404)
- **chat response 字段新加**: `nliTurnId?: string` (sync 路径返 null/undefined, 客户端跳过轮询)
- **setImmediate fire-and-forget**: 不 await, handler 立即返; 即使 NLI 抛异常也不影响 chat 响应
- **turnId 格式**: `${session_id}:${turn_seq}` (e.g. `NGEVQYJH:0`), 简单稳定, 跟 P5 v1.4 session.messages 索引对齐

### 2.3 部署架构

```text
CloudBase env: unequal-d4ggf7rwg82e0900b (现有)
├── function: api-router (P9 加 1 个 endpoint: /api-nli-result)
│   ├── /api-chat (P9 改 NLI 同步→异步灰度)
│   ├── /api-ask (P9 同样改, async NLI)
│   ├── /api-nli-result (P9 新, ~50 行 handler)
│   └── /api-*-... (其他不动)
├── NoSQL collections (P9 不动):
│   ├── chatSession: 加 nliTurnId 字段 (assistant msg 上, 兼容旧)
│   ├── audit_log: 加 chat_nli_async action + nliSnapshot.turnId 字段
│   └── chunk / document / user / source: 不动
└── env vars (P9 加 1):
    ├── NLI_ASYNC: "0" (默认) | "1" (灰度)
    └── ...其他 25 vars 不动
```

---

## 3. 组件

### 3.1 `apps/api/src/handlers/api-nli-result.ts` (NEW, ~50 行)

```typescript
/**
 * api-nli-result.ts — P9 NLI 异步 verdict 轮询端点
 *
 * GET /api-nli-result?turnId=<id>
 *  查 audit_log 找 nliSnapshot.turnId = turnId
 *  命中: 返 { verdict, score, latencyMs, isWarning, found: true }
 *  未命中: 返 { found: false } (让 client 继续轮询)
 *
 * 决策:
 *  - JWT auth 必填 (跟 /api-chat 一致)
 *  - 不返 audit_log 整 record, 只返 nliSnapshot 字段 (防 leak)
 *  - 404 跟 "found: false" 区分: 404 仅当 turnId 格式非法
 */

import { errorResponse, jsonResponse, optionsResponse, type HttpTriggerEvent, type HttpTriggerResponse } from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";
import { verifyJwt } from "../lib/jwt.js";
import { COLLECTIONS } from "../lib/db.js";
import { whereQuery } from "../lib/db.js";

interface NliResultResponse {
  found: boolean;
  verdict?: "entailed" | "neutral" | "contradiction";
  score?: number;
  latencyMs?: number;
  isWarning?: boolean;
}

const TURN_ID_PATTERN = /^[A-Z0-9]{8,16}:[0-9]{1,4}$/;

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  // JWT auth (user scope, 跟 /api-chat 一致)
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return errorResponse("AUTH_FAILED", "Missing Authorization header", 401);
  }
  const token = authHeader.slice("Bearer ".length);
  const payload = await verifyJwt(token, env.JWT_SECRET);
  if (!payload || payload.scope !== "user") {
    return errorResponse("AUTH_FAILED", "Invalid JWT or scope", 401);
  }

  // 解析 turnId from query string
  const turnId = event.queryStringParameters?.turnId ?? "";
  if (!TURN_ID_PATTERN.test(turnId)) {
    return errorResponse("INVALID_REQUEST", "Invalid turnId format", 400);
  }

  // 查 audit_log (P5 v1.3 audit_log schema, nliSnapshot 字段在 P9 加 turnId)
  const records = await whereQuery<{ nliSnapshot?: { turnId?: string; verdict?: string; score?: number; latencyMs?: number } }>(
    COLLECTIONS.auditLog,
    { action: "chat_nli_async" },
    { limit: 50 },
  );
  const hit = records.find((r) => r.nliSnapshot?.turnId === turnId);

  if (!hit || !hit.nliSnapshot) {
    return jsonResponse<NliResultResponse>({ found: false });
  }

  const { verdict, score, latencyMs } = hit.nliSnapshot;
  const isWarning = (verdict === "contradiction" || verdict === "neutral") && (score ?? 1) < 0.5;

  return jsonResponse<NliResultResponse>({
    found: true,
    verdict: verdict as NliResultResponse["verdict"],
    score,
    latencyMs,
    isWarning,
  });
}
```

### 3.2 `apps/api/src/handlers/__tests__/api-nli-result.test.ts` (NEW test, ~120 行, 8 cases)

| Case | 覆盖 |
|---|---|
| 1 | JWT 缺 → 401 AUTH_FAILED |
| 2 | JWT scope != user → 401 AUTH_FAILED |
| 3 | turnId 格式非法 (不含 `:` 或含特殊字符) → 400 INVALID_REQUEST |
| 4 | turnId 合法 + audit_log 命中 → 200 + {found: true, verdict, score, latencyMs, isWarning} |
| 5 | turnId 合法 + audit_log 未命中 → 200 + {found: false} (让 client 继续轮询) |
| 6 | verdict=entailed + score=0.9 → isWarning=false |
| 7 | verdict=contradiction + score=0.3 → isWarning=true (P5 v1.3 阈值 0.5) |
| 8 | verdict=neutral + score=0.4 → isWarning=true |
| (额外)  | 9. verdict=contradiction + score=0.6 → isWarning=false (score ≥ 0.5) |
| (额外)  | 10. verdict=entailed + score=0.2 → isWarning=false (entailed 不警告) |
| (额外)  | 11. audit_log 多 record (latest 优先, 找第 1 个匹配 turnId) |
| (额外)  | 12. turnId 含特殊字符 (XSS 注入) → 400 INVALID_REQUEST |

### 3.3 `apps/api/src/handlers/api-chat.ts` (MODIFIED, ~40 行 diff)

```diff
// import 块加 setImmediate 用法 + turnId helper
+ function generateTurnId(sessionId: string, turnSeq: number): string {
+   return `${sessionId}:${turnSeq}`;
+ }

- // P5 v1.3 同步 NLI 块 (line 261-348, ~87 行)
- const nliHypothesis = crossTurn.hypothesis;
- // ... 同步 verify + recordAudit
- if (nliSucceeded && verdict.verdict !== "entailed") {
-   await recordAudit({ action: "chat_nli_reject", ... });
- }
- let finalAnswer = applyWarning(answer, nliSucceeded, verdict, ...);

+ // P9 NLI 异步 (env.NLI_ASYNC === "1" 灰度)
+ if (env.NLI_ASYNC === "1") {
+   // 跳过同步 NLI, 生成 turnId + setImmediate 后台 fire-and-forget
+   const turnSeq = session.messages.filter((m) => m.role === "assistant").length;
+   const turnId = generateTurnId(session.id, turnSeq);
+   const nliHypothesis = crossTurn.hypothesis;  // P5 v1.4 跨轮, 保留
+   setImmediate(async () => {
+     try {
+       const provider = await getNliProvider();
+       const verdict = await provider.verify(cleaned, nliHypothesis);
+       const latencyMs = Date.now() - nliStart;
+       await recordAudit({
+         action: "chat_nli_async",  // P9 新 action, 跟 P5 v1.3 sync reject 隔离
+         actor: { via: "jwt", userId, clientIp, sessionId: session.id },
+         target: { userId, resourceType: "chunk" },
+         request: { contentLen: q.length, trustLevel: 0, title: q.slice(0, 100) },
+         result: "success",
+         requestId: `chat_nli_async_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
+         nliSnapshot: { turnId, verdict: verdict.verdict, score: verdict.score, latencyMs, reason: "async" },
+       });
+     } catch (err) {
+       // async 失败写 audit_log (P5 v1.3 failOpen 风格, 但 P9 不抛 + 不阻塞 chat)
+       await recordAudit({
+         action: "chat_nli_async",
+         result: "failure",
+         error: err instanceof Error ? err.message : String(err),
+         nliSnapshot: { turnId, verdict: "neutral", score: 0, latencyMs: 0, reason: err instanceof NliTimeoutError ? "timeout" : "runtime_error" },
+       });
+     }
+   });
+   let finalAnswer = answer;  // 不 applyWarning (warning 移到轮询 verdict)
+   // 持久化 assistant msg 加 nliTurnId
+   const newMessages: ChatMessage[] = [
+     ...session.messages,
+     { role: "user", content: q, createdAt: now },
+     { role: "assistant", content: finalAnswer, nliTurnId: turnId, createdAt: now },  // P9 加字段
+   ];
+   return jsonResponse<ChatResponse>({
+     answer: finalAnswer,
+     citedNums: validCitedNums,
+     citations,
+     session_id: session.id,
+     session_title: session.title ?? null,
+     is_new_session: isNewSession,
+     nliTurnId: turnId,  // P9 新字段, client 拿此轮询
+   });
+ } else {
+   // P5 v1.3 sync NLI 路径保留 (default NLI_ASYNC=0)
+   // ... 原有 ~87 行不动
+ }
```

### 3.4 `packages/shared/src/types.ts` (MODIFIED, ~5 行 diff)

```diff
// ChatMessage interface 加 nliTurnId 字段
  interface ChatMessage {
    role: "user" | "assistant";
    content: string;
    citations?: Citation[];
    /** P5 v1.4: 该 assistant 轮 retrieve 出的 chunk IDs */
    retrievedChunkIds?: string[];
+   /** P9: 该 assistant 轮的 NLI async turnId (轮询 GET /api-nli-result 用) */
+   nliTurnId?: string;
    createdAt: number;
  }

  interface ChatResponse {
    answer: string;
    citedNums: number[];
    citations: Citation[];
    session_id: string;
    session_title: string | null;
    is_new_session: boolean;
+   /** P9: NLI async turnId, 客户端拿此轮询 /api-nli-result; sync 路径返 null */
+   nliTurnId?: string;
  }
```

### 3.5 `apps/api/src/lib/env.ts` (MODIFIED, ~3 行 diff)

```diff
// Env interface 加 NLI_ASYNC 字段
+ /** P9: NLI 异步化灰度, "0" = sync 走 P5 v1.3 (default), "1" = async fire-and-forget + polling */
+ NLI_ASYNC?: "0" | "1";
```

### 3.6 `apps/api/cloudbaserc.json` (MODIFIED, 1 行 env var)

```diff
  "envVariables": {
    ...
    "LLM_MAX_TOKENS": "2048",
+   "NLI_ASYNC": "0",
  }
```

### 3.7 mini program (MODIFIED, ~30 行改)

```typescript
// apps/miniprogram/pages/chat/chat.ts (P9 加轮询逻辑)
async function pollNliResult(turnId: string, attempt: number = 1): Promise<NliResult | null> {
  if (attempt > 5) return null; // 5 次后 fallback
  await new Promise((r) => setTimeout(r, attempt === 1 ? 3000 : 2000)); // 3s 起始 + 2s 间隔
  const res = await wx.cloud.callFunction({
    name: "api-router",
    data: { route: "/api-nli-result", method: "GET", query: { turnId } },
    header: { Authorization: `Bearer ${getJwt()}` },
  });
  const data = res.result as NliResult;
  if (data.found) return data;
  return pollNliResult(turnId, attempt + 1);
}

async function onChatResponse(chatRes: ChatResponse) {
  // 1. 立即显示 answer (不阻塞)
  this.setData({ answer: chatRes.answer, citations: chatRes.citations, nliPending: !!chatRes.nliTurnId });
  // 2. 后台轮询 NLI (3-2-5 节奏)
  if (chatRes.nliTurnId) {
    const nli = await pollNliResult(chatRes.nliTurnId);
    if (nli?.isWarning) {
      this.setData({ showWarning: true, warningText: "该回答可能与文档不符, 请参考引用核实" });
    } else {
      this.setData({ nliPending: false });
    }
  }
}
```

---

## 4. 数据流

### 4.1 chat 异步 NLI 路径 (env.NLI_ASYNC=1)

```text
[1] 用户 chat → api-chat handler
    ↓
[2] JWT auth + parse body + find/create session (不变)
    ↓
[3] embed query (MiniMax embo-01, ~1s)
    ↓
[4] VECTOR_STORE 路径 (P8 不动)
    ↓
[5] searchChunks trust/recency 加权 → top-5 chunks (P5 v1.3 不动)
    ↓
[6] LLM chat completion (~20s, P5 不动, 主耗时)
    ↓
[7] parseAnswerSegments (P5 v1.3 [N] 解析, 不动)
    ↓
[8] P9: **NLI_ASYNC=1 灰度分支**:
    ├─ 跳过 P5 v1.3 同步 NLI 块 (~87 行)
    ├─ turnSeq = session.messages.filter(m => m.role === "assistant").length
    ├─ turnId = `${session.id}:${turnSeq}`
    ├─ setImmediate 后台 fire-and-forget:
    │   ├─ getProvider().verify(cleaned, nliHypothesis) (1.9s cold, < 500ms warm)
    │   ├─ write audit_log (action=chat_nli_async, nliSnapshot{turnId, verdict, score, latencyMs})
    │   └─ 失败: write audit_log (action=chat_nli_async, result=failure, reason=runtime_error/timeout)
    └─ chat 立即返 { answer, citations, session_id, is_new_session, nliTurnId: turnId }
    ↓
[9] chat 响应 200 (24s, 1.9s 节省; P5 v1.3 sync 路径 26s 不变)
```

### 4.2 mini program 轮询路径

```text
[1] mini program 拿 chat response, 解析 nliTurnId
    ↓
[2] 立即 setData 显示 answer + nliPending: true (UI spinner)
    ↓
[3] 3s 后第 1 次轮询 GET /api-nli-result?turnId=<id>:
    ├─ api-nli-result 查 audit_log 命中 → 200 + {found: true, verdict, isWarning}
    │   ├─ isWarning=true: 1s 后显示 warning UI, setData({nliPending: false})
    │   └─ isWarning=false: setData({nliPending: false}) (静默)
    └─ 未命中: 200 + {found: false}, 继续轮询
    ↓
[4] 2s 后第 2 次轮询 (累计 5s)
    ↓
[5] 2s 后第 3 次轮询 (累计 7s)
    ↓
[6] 2s 后第 4 次轮询 (累计 9s)
    ↓
[7] 2s 后第 5 次轮询 (累计 11s)
    ↓
[8] 第 5 次仍未命中 (13s 总): fallback 不显示 warning, setData({nliPending: false})
```

### 4.3 error 处理表

| 失败场景 | 行为 | 用户可见 | Audit |
|---|---|---|---|
| **chat response 缺 nliTurnId** (sync 路径或 chat 报错) | client 跳过轮询, 不显示 nliPending | 跟 P5 v1.3 sync 路径一致 (warning prefix) | n/a |
| **轮询 NLI_API 401/500** | client 5 次轮询后 fallback | 不显示 warning, 接原 answer | n/a |
| **轮询 NLI 持续 404** (audit_log 无 record) | client 5 次后 fallback | 不显示 warning | audit_log 应有 chat_nli_async 记录 (setImmediate 跑了), 404 异常需查 |
| **setImmediate NLI 抛 runtime_error** | write audit_log (result=failure, reason=runtime_error) | 不阻塞 chat, 不显示 warning | `chat_nli_async result=failure` |
| **setImmediate NLI timeout** (>5s) | write audit_log (result=failure, reason=timeout) | 不阻塞 chat, 不显示 warning | `chat_nli_async result=failure` |
| **setImmediate 写 audit_log 失败** | console.warn + 吞 (P5 failOpen 风格) | n/a (用户已看 answer) | 无 |
| **audit_log collection 缺** (DBA 误删) | 整个 cloud function 抛错, 500 返 | chat 响应 500 | n/a (chat 失败) |
| **mini program 断网** | 轮询 fetch 失败 → 5 次后 fallback | 不显示 warning, 接原 answer | n/a |

---

## 5. 测试策略

### 5.1 单元测试 (vitest, 12 cases)

`apps/api/src/handlers/__tests__/api-nli-result.test.ts` (8 cases) + `api-chat.test.ts` (4 新 cases) + `cross-turn-hypothesis.test.ts` (不动):

**api-nli-result.test.ts** (8 cases, 见 §3.2 表)

**api-chat.test.ts 新增** (4 cases):
1. NLI_ASYNC=1 + chat 200 → response.nliTurnId 非空 (turnId 格式 `${session_id}:${turn_seq}`)
2. NLI_ASYNC=1 + setImmediate 内 NLI runtime_error → audit_log 写 failure, chat 不抛
3. NLI_ASYNC=0 (默认) → 走 P5 v1.3 sync 路径, response.nliTurnId 为 null/undefined (backward compat)
4. NLI_ASYNC=1 + turnSeq 计数正确 (创 session turnSeq=0, 第 2 轮 turnSeq=1)

### 5.2 集成测试 (verify 脚本, 1 case)

`scripts/verify-p9-nli-async.ts` (NEW, ~80 行):
- deploy NLI_ASYNC=1 + N 改 chat 1 次
- 解析 response.nliTurnId
- 3s 起始 + 2s × 5 轮询 GET /api-nli-result
- 验: 命中 audit_log chat_nli_async + verdict + isWarning 推断正确

### 5.3 真接验证 (3 步, post-Phase 4)

| 步 | 命令 | 通过标准 |
|---|---|---|
| 1 | `pnpm -F api test` | 351+12 = 363+ tests PASS (P8 364 + P9 12) |
| 2 | `pnpm -F api typecheck` | 干净 (P9 引入 0 错) |
| 3 | `pnpm -F api verify:p9-nli-async` (T1+T2 跨轮) | 命中 audit_log, 13s 内拿到 verdict, T2 跨轮 hypothesis 跟 P5 v1.4 一致 |

### 5.4 成功标准 (vs P5 v1.3 baseline)

| 指标 | P5 v1.3 (前) | P9 目标 |
|---|---|---|
| chat 长问 latency | 26.4s (含 NLI 同步) | **24.5s** (省 1.9s NLI cold) |
| NLI 误判 verdict 可见时间 | 26.4s (跟 answer 一齐) | **5-13s 后 (轮询)** |
| audit_log 噪声 | chat_nli_reject (sync) | chat_nli_async (async, 更多 record 因 P5 v1.3 sync reject 移过来) |
| handler 单元测试 | 358/358 (P8 收官) | 370+ (P9 增量 12) |
| 真接 1 真接 2 真接 3 | 64/64 (P8 涉及) | + verify:p9-nli-async |

---

## 6. 迁移 (4 phase 灰度, 1 行 env 切)

### Phase 1: env + handler 骨架 (半天, 0 风险)

1. env.ts 加 `NLI_ASYNC?: "0" | "1"` 字段
2. cloudbaserc.json 加 `"NLI_ASYNC": "0"` (默认 safe)
3. api-nli-result.ts 实现 + 8 单测
4. typecheck + 全测
5. **不动 api-chat.ts**, **不动 mini program** (P5 v1.3 行为不变)

**回滚**: 删 NLI_ASYNC 字段 (env var 不读, 走 undefined → 走 default "0" sync)

### Phase 2: api-chat.ts 加 NLI_ASYNC 灰度分支 (半天, 低风险)

1. api-chat.ts 加 NLI_ASYNC 判断 + setImmediate fire-and-forget (~40 行 diff)
2. ChatMessage / ChatResponse 加 nliTurnId 字段
3. 4 个新单测 (sync/async/turnSeq/runtime_error)
4. typecheck + 全测
5. **不动 mini program** (P5 v1.3 sync 行为不变, 客户端不感知)

**回滚**: NLI_ASYNC=0 (default), P5 v1.3 行为恢复

### Phase 3: dual-write (半天, 低风险)

1. 不动 (P9 async NLI 已走 audit_log chat_nli_async action, 跟 P5 v1.3 sync reject 隔离)
2. 验证: NLI_ASYNC=1 时 audit_log 应有 chat_nli_async, **不应有** chat_nli_reject (sync 路径不走)
3. 真接 1 chat 验 audit_log schema 兼容 (P5 v1.3 record 旧, P9 record 新 turnId 字段)

**回滚**: 跟 Phase 2 同

### Phase 4: 切流 + mini program 改造 (1 天, 中等风险)

| Day | 步骤 | 风险 |
|---|---|---|
| Day 1 | env var `NLI_ASYNC=0` → `1` (admin 1 真 user 测试) | 低 (单 user) |
| Day 2 | 验 chat 真接 → audit_log chat_nli_async 写入 + T1+T2 跨轮 NLI 跨轮 hypothesis 跟 P5 v1.4 一致 | 中 (需量化) |
| Day 3 | mini program 加轮询逻辑 (~30 行) → 灰度全量 | 中 (mini program 改) |
| Day 4 | 灰度全量 (默认 NLI_ASYNC=1) + verify:p9-nli-async PASS | 中 |

**回滚**: env var `NLI_ASYNC=1` → `0` (1 行 env), mini program 不显示 nliPending UI 即可

---

## 7. 风险 / 边界

| 风险 | Likelihood | Impact | Mitigation |
|---|---|---|---|
| setImmediate 内 NLI 抛未 catch | LOW | MEDIUM | try/catch 包 setImmediate 整体 (api-chat §3.3 已写), failOpen 写 audit_log failure |
| audit_log 写入失败 (network/permission) | LOW | LOW | console.warn 吞, P5 v1.3 failOpen 风格 |
| turnId 冲突 (同 session 同 turn_seq) | LOW | LOW | turnSeq 来自 session.messages 计数, 单调递增, 几乎不可能冲突 |
| mini program 轮询 bug (无限轮询) | LOW | MEDIUM | max attempt=5, fallback 不显示 warning |
| P8 PG HNSW 慢 → setImmediate NLI 因 P5 v1.4 跨轮 hypothesis 拉取慢 | LOW | LOW | P9 不改 P5 v1.4 跨轮逻辑, 性能由 P5/P8 决定 |
| 客户端断网 | MEDIUM | LOW | 5 次后 fallback, 不显示 warning |
| 真接 evidence 不足 (P9 灰度短) | MEDIUM | LOW | state-p9 §1.1 真接 3 步 + 7 天 audit_log 趋势 |
| P5 v1.3 sync NLI 路径 break (backward compat) | LOW | HIGH | env.NLI_ASYNC undefined → "0" sync 路径, default 行为不变 |
| 旧 audit_log record (P5 v1.3 旧数据) 跟 P9 schema 不兼容 | LOW | LOW | audit_log NoSQL 弹性 schema, 旧 record 缺 nliSnapshot.turnId 字段, polling 返 found: false (正确) |
| mini program 老版本不识别 nliTurnId 字段 | MEDIUM | LOW | mini program 老版本忽略未知字段, 走 P5 v1.3 sync 行为 (无轮询) |
| setImmediate 在 CloudBase Node 20 runtime 行为不一致 | LOW | MEDIUM | P9 跟 P5 v1.3 sync 路径平行, 灰度可控; 真接 3 步验证 |

### 已知限制

1. **Polling 1 真 user 不代表全量**: mini program 旧版本不识别 nliTurnId 字段, 灰度期间 50% 用户用 polling, 50% 用 P5 v1.3 sync
2. **审计 trail 增长**: chat_nli_async record 多 (每 chat 1 record), audit_log 7 天容量 1.5x
3. **P5 v1.4 跨轮 NLI**: 跨轮 hypothesis 仍在 setImmediate 内 union, 行为不变
4. **P8 PG HNSW 不动**: P9 跟 P8 灰度独立, 部署互不影响

---

## 8. 真接验证 (post-Phase 4)

| 验证 | 命令 | 通过标准 |
|---|---|---|
| **基础** | `pnpm -F api test` | 370+/370+ tests PASS (12 新 P9 cases) |
| **基础** | `pnpm -F api typecheck` | 干净 |
| **部署** | `pnpm -F api deploy:full` | 26 vars atomic set, 含 NLI_ASYNC |
| **真接** | `pnpm -F api verify:p9-nli-async` (T1+T2 跨轮) | 命中 audit_log chat_nli_async, 13s 内拿到 verdict, T2 跨轮 hypothesis 跟 P5 v1.4 一致 |
| **真接** | `pnpm -F api deploy:status` | 26 vars 完整: 14 template + 9 secrets + VECTOR_STORE + PG_CONNECTION_STRING + LLM_MAX_TOKENS + NLI_ASYNC |
| **状态** | audit_log 7 天 chat_nli_async 趋势 | 跟 P5 v1.3 chat_nli_reject 数量对比 (新 action 启用率 ≈ 100%) |

---

## 9. 关联

- **P5 v1.3 NLI spec** (`2026-06-23-p5-nli-entailment-design.md`) — P5 v1.3 sync 路径 P9 保留 (backward compat)
- **P5 v1.4 跨轮 NLI** (commit ccf6895) — P9 保留, 在 setImmediate 内走跨轮
- **P6 本地 ONNX NLI** (`state-p6-local-onnx-nli.md`) — NLI provider P9 不动, 仅调用时序改
- **P7 follow-up** (`state-p7-p8-followup-completion.md`) — 当前状态基线
- **P8 vector DB** (`state-p8-vector-db-pgvector.md`) — P9 跟 P8 灰度独立, 部署互不影响
- **P8 follow-up #9-10**: state-p9 + memory 更新 (P9 真接 PASS 后)
- **state-arch-v2.4.md** — CloudBase 限制事实稳定

---

## 10. References

- Node.js `setImmediate` in Cloud Functions: https://docs.cloudbase.net/cf/functions/event
- CloudBase audit_log 模式: state-p6 §9
- P5 v1.3 sync NLI 实现: `apps/api/src/handlers/api-chat.ts` line 261-348
- P5 v1.4 跨轮 NLI: `apps/api/src/lib/nli/cross-turn-hypothesis.ts` (90 行)
- Polling 3-2-5 节奏: state-p9 §4.2 (mini program 3s 起始 + 2s 间隔 × 5)
- P8 setImmediate fire-and-forget pattern: 跟 P5 NLI v1.3 failOpen 风格一致

---

## 11. 副发现 (记录给未来)

1. **P5 v1.3 sync NLI 保留**: 不删, 作 default `NLI_ASYNC=0` fallback, P5/P6/P7 真接测试照常工作
2. **Polling 节奏 13s 总耗时**: 跟 LLM 20s 主路径并行, 用户几乎感觉不到 verdict 推迟
3. **setImmediate fire-and-forget 跟 P5 failOpen 一致**: 失败不抛, 写 audit_log failure, 跟 P9 async 风格兼容
4. **audit_log schema 扩展兼容旧 record**: NoSQL 弹性 schema, 旧 record 缺 nliSnapshot.turnId 字段, polling 返 found: false
5. **P9 不动 P8 PG HNSW**: 跟 P8 灰度独立, 部署互不影响 (P8 VECTOR_STORE=pg/nosql + P9 NLI_ASYNC=0/1 独立切)
6. **mini program 旧版本向后兼容**: 忽略未知字段 nliTurnId, 走 P5 v1.3 sync 行为

---

## 12. 验证清单 (P9 完整收官)

- [x] P9 §0 TL;DR + §1 决策摘要 (12 决策点)
- [x] P9 §2 架构 (高层图 + 关键边界 + 部署架构)
- [x] P9 §3 组件 (1 NEW handler + 1 NEW test + 4 MODIFIED)
- [x] P9 §4 数据流 (chat async + polling)
- [x] P9 §5 错误处理表 (8 失败场景)
- [x] P9 §6 测试策略 (12 单元 + 1 真接 + 3 步)
- [x] P9 §7 迁移 (4 phase 灰度, 1 行 env 切)
- [x] P9 §8 风险 / 边界 (11 风险)
- [x] P9 §9 真接验证 (3 步)
- [x] P9 §10 关联 + §11 副发现 + §12 验证清单
- [ ] **用户 reviews spec** (Checkpoint 8)
- [ ] **writing-plans skill** (Checkpoint 9, terminal)


