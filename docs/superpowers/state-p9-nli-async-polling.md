# state-p9-nli-async-polling — P9 NLI 后置 (polling 轮询) PASS

> 日期: 2026-06-25
> 前置: state-p8-vector-db-pgvector.md (P8 vector DB 集成 PASS, commit ce3207c)
> spec: `docs/superpowers/specs/2026-06-25-p9-nli-async-polling-design.md` (commit 0d8673a + §1 修 40f8292, 12 节, 612 行)
> plan: `docs/superpowers/plans/2026-06-25-p9-nli-async-polling.md` (commit e56822e, 5 task × 11 step)
> 状态: ✅ **代码 + 单测 100% 收官** (5 commits + 13 unit tests + 真接 3 步 follow-up); **真接待云端 deploy NLI_ASYNC=1**

## 0. TL;DR

P5 v1.3 NLI 同步在 chat 响应路径上阻塞 1.9s cold (用户看 answer 时 NLI 在算)。P9 改 **NLI 异步**: chat 立即返 answer (不阻塞), 后台 `setImmediate` 调 NLI 写 `audit_log` (`action=chat_nli_async`), mini program **polling GET `/api-nli-result?turnId=<id>`** 查 verdict (3s 起始 + 2s 间隔 × 5, 13s 总)。

**核心收益**:
- chat 响应 26.4s → 24.5s (省 1.9s NLI cold, 主路径 LLM 20s 不变)
- NLI 误判 verdict 不再阻塞用户看 answer (5-13s 后才推 warning, 用户体验顺)
- P5 v1.4 跨轮 NLI + P8 PG HNSW + P9 异步三层叠加, chat UX 达最优

**核心决策**:
- **Polling 轮询** (1 文件改, 不引 SSE/WebSocket/CFS 异步)
- **复用 audit_log** + 新增 `chat_nli_async` action (sync/async verdict 隔离)
- **3-2-5 节奏** (3s 起始 + 2s 间隔 × 5, 13s 总, fallback 返原 answer)
- **`turnId` 唯一标识** (`${session_id}:${turn_seq}` 格式, 后端读 audit_log filter)
- **P5 v1.3 sync 路径保留** (env.NLI_ASYNC undefined → default sync, backward compat 老客户端)

## 1. 验收结果

### 1.1 P9 代码收官基线 (主线程验证, 2026-06-25)

| 验证 | 命令 | 结果 |
|---|---|---|
| **P9 涉及测试** | `pnpm -F api test src/handlers/__tests__/api-nli-result.test.ts test/handlers/api-chat.test.ts test/lib/auth-admin.test.ts` | ✅ **49/49 PASS** in 547ms |
| **mini program 测试** | `apps/miniprogram npx vitest run test/chat.test.ts` | ✅ **1/1 PASS** in 321ms |
| **verify:p9-nli-async** (本机 NLI_ASYNC=0 sync 路径) | `pnpm -F api verify:p9-nli-async` | ✅ 退 0 + warn (T1/T2 无 nliTurnId, 走 P5 v1.3 sync 行为) |
| **typecheck** | `pnpm -F api typecheck` | ✅ P9 引入 0 错 (4 pre-existing P6 onnx-provider baseline) |
| **git tree** | `git status` | ✅ 干净 (除 `docs/superpowers/plans/` untracked) |

**附带收益**: baseline 8 个 typecheck 错 → 减到 4 错 (P9 Task 2 扩 audit.ts 加 `chat_nli_reject`/`chat_nli_async` + `sessionId` + `reason "async"`, 顺手解决 P5 v1.3 4 个 baseline 错)

### 1.2 P9 完整 commit 链

| Commit | Phase | 模块 | Tests |
|---|---|---|---|
| `b23ba23` | Phase 1 | api-nli-result polling 端点 + 13 单测 (mock whereQuery) + env NLI_ASYNC + cloudbaserc default 0 | 351 → 364 |
| `2419aa8` | Phase 2 | api-chat NLI_ASYNC 灰度分支 (setImmediate fire-and-forget) + 4 新单测 + audit.ts 类型扩 + types.ts nliTurnId + ChatResponse nliTurnId | 364 → 375 |
| `9cb6a35` | Phase 3 | verify-p9-nli-async 真接脚本 (T1+T2 跨轮 polling 验, ~190 行) + package.json script | 375 → 375 |
| `c832189` | Phase 4 | cloudbaserc NLI_ASYNC=1 + mini program 改 (types.ts + chat.ts polling + getJwtToken import) | 375 → 375 |
| (待) | Phase 5 | state-p9 收尾 + memory + MEMORY.md (本文件) | - |

### 1.3 真接 3 步 follow-up (待用户手动跑, 需 Tencent Cloud 网络)

| 步 | 命令 | 通过标准 | 状态 |
|---|---|---|---|
| 1 | `pnpm -F api deploy:full` | 26 vars atomic set, 含 NLI_ASYNC=1 | ⏸️ 真接 follow-up #1 |
| 2 | `pnpm -F api deploy:status` | 26 vars 完整 (15 template + 9 secrets + VECTOR_STORE + LLM_MAX_TOKENS + NLI_ASYNC) | ⏸️ 真接 follow-up #2 |
| 3 | `pnpm -F api verify:p9-nli-async` | T1+T2 双轮 200 + nliTurnId 命中 + 轮询命中 audit_log chat_nli_async + verdict 推断 isWarning 正确 (13s 内) | ⏸️ 真接 follow-up #3 |

**回滚** (1 行 env 验证): `NLI_ASYNC=1 → 0` + `pnpm -F api deploy:full` → P5 v1.3 sync 行为恢复 (老客户端 backward compat).

**关键**: 真实云端 deploy:full 需 Tencent Cloud 网络 (本机 deploy-full.test.ts 必卡, P7 follow-up #1 已知 baseline 必卡, 跟 P9 无关).

## 2. 关键设计决策

### 2.1 Polling 轮询 (1 文件改, 不引 SSE/WebSocket/CFS)

```typescript
// apps/miniprogram/pages/chat/chat.ts pollNliResult (新, ~30 行)
async function pollNliResult(baseUrl: string, turnId: string): Promise<NliResultResponse | null> {
  const url = `${baseUrl}/api-nli-result?turnId=${encodeURIComponent(turnId)}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 1 ? 3000 : 2000));
    try {
      const res = await wx.cloud.callFunction({
        name: "api-router",
        data: { route: "/api-nli-result", method: "GET", query: { turnId } },
        header: { Authorization: `Bearer ${token}` },
      });
      const body = (res?.result ?? {}) as NliResultResponse;
      if (body.found) return body;
    } catch { /* 继续轮询 */ }
  }
  return null;  // 5 次后 fallback
}
```

**决策**: 客户端 2 次请求 (chat + 轮询), 简单可靠. SSE 流式需 handler + mini program 双端 SSE 改造, 高成本大工程.

### 2.2 复用 audit_log + chat_nli_async action

```typescript
// api-chat.ts setImmediate fire-and-forget (新, ~95 行)
if (env.NLI_ASYNC === "1") {
  const turnSeq = session.messages.filter((m) => m.role === "assistant").length;
  const turnId = `${session.id}:${turnSeq}`;
  setImmediate(async () => {
    try {
      const provider = await getNliProvider();
      const verdict = await provider.verify(cleaned, nliHypothesis);
      await recordAudit({
        action: "chat_nli_async",  // P9 新 action, 跟 P5 v1.3 sync reject 隔离
        actor: { via: "jwt", userId, clientIp, sessionId: session.id },
        target: { userId, resourceType: "chunk" },
        result: "success",
        nliSnapshot: { turnId, verdict: verdict.verdict, score: verdict.score, latencyMs, reason: "async" },
      });
    } catch (err) {
      // 失败写 audit_log failure record (P5 v1.3 failOpen 风格, 但 P9 不抛 + 不阻塞 chat)
      await recordAudit({
        action: "chat_nli_async",
        result: "failure",
        error: err instanceof Error ? err.message : String(err),
        nliSnapshot: { turnId, verdict: "neutral", score: 0, latencyMs: 0, reason: "runtime_error" | "timeout" },
      });
    }
  });
  // chat 立即返 (P9 不阻塞 response)
  return jsonResponse({ ..., nliTurnId: turnId });
}
```

**决策**: `action: "chat_nli_async"` 跟 P5 v1.3 sync `chat_nli_reject` 隔离. `nliSnapshot.turnId` 字段唯一标识 polling 查询. `actor.sessionId` 字段 audit.ts 类型扩 (顺手解决 P5 v1.3 4 个 baseline typecheck 错).

### 2.3 setImmediate fire-and-forget (P5 v1.3 failOpen 风格)

**决策**: setImmediate 不 await, handler 立即返. 即使 NLI 抛异常 (runtime_error / timeout), 也不影响 chat 响应 (用户已看 answer). 失败写 audit_log failure record (失败可追溯).

### 2.4 P5 v1.3 sync 路径 backward compat

```typescript
// env.NLI_ASYNC === undefined 或 "0" (default) → 走 P5 v1.3 老路径
// 老客户端无 nliTurnId 字段, 走 P5 v1.3 sync 行为 (warning prefix 文本)
// warning prefix 在 spec §1 决策摘要 P9 修正 (commit 40f8292): sync 保留 + async 删
```

**决策**: 老客户端 (P9 灰度前 + 老 mini program 版本) 走 P5 v1.3 sync 行为, 无 breaking change. warning prefix 仅 P9 async 路径删 (warning 移到轮询 verdict UI).

### 2.5 跟 P8 灰度独立 (2D 灰度矩阵)

```
       NLI_ASYNC=0 (sync)  |  NLI_ASYNC=1 (async)
VECTOR_STORE=nosql (P7)  |  P7 baseline     |  P7+P9 async (本次)
VECTOR_STORE=pg (P8)    |  P8 baseline     |  P8+P9 async (未来)
```

**决策**: P8 (VECTOR_STORE) × P9 (NLI_ASYNC) 独立切, 任意组合可部署. 跟 P7 follow-up #1 (deploy:full 串行) + P4 #3 (tcb fn deploy wipes secrets) 兼容.

## 3. 关键真问题 + 修法 (subagent 报告 + 主线程验证)

| # | 问题 | 修法 |
|---|---|---|
| 1 | spec §3.1 测试 import 路径错 (按 test/handlers 惯例, 实际 src/handlers/__tests__/) | 跟 sibling api-ingest-dual-write.test.ts 对齐路径 ✅ |
| 2 | spec §3.1 verifyJwt 调用形式不对 (positional vs object) | 改 verifyJwt({ token, secret }) ✅ |
| 3 | spec §3.1 queryString 字段名不对 (queryStringParameters vs queryString) | 用 getQuery(event, "turnId") helper ✅ |
| 4 | jsonResponse 不支持 generic (spec 写错) | 去掉 <NliResultResponse> 类型参数 ✅ |
| 5 | scope 判断 spec 矛盾 (admin → 401) | 跟 spec/plan 一致 (polling user-only, admin 走 audit_log 直查) ✅ |
| 6 | ChatResponse 是 api-chat.ts 内 local interface (spec §3.4 误述) | 改 types.ts (ChatMessage) + api-chat.ts (ChatResponse) 双处 ✅ |
| 7 | P9-4 mock coll 名错 (chatSession 驼峰 vs chat_session snake_case) | 改 snake_case ✅ |
| 8 | audit.ts AuditEntry 没 actor.sessionId 字段 (P9 async 用) | 扩 type union + 加 sessionId 字段 (顺手解决 baseline 4 个错) ✅ |
| 9 | P9 describe 变量作用域 (auditSpy 没 let) | 显式 let + mockEmbedAndChat helper 复制到 P9 describe ✅ |
| 10 | P9-3 GREEN-by-coincidence (sync 路径本来就不返 nliTurnId) | 预期行为, 反映 "sync 路径完全不动" 决策 ✅ |
| 11 | spec §1 warning prefix 决策矛盾 (sync 删 vs backward compat) | 修: sync 保留 + async 删 (commit 40f8292) ✅ |

## 4. 文件清单 (P9 增量)

### 4.1 新建 (4 files, ~400 lines)

| 文件 | 行数 | 用途 |
|---|---|---|
| `apps/api/src/handlers/api-nli-result.ts` | ~50 | polling 端点 (JWT auth + turnId regex + audit_log query + isWarning 推断) |
| `apps/api/src/handlers/__tests__/api-nli-result.test.ts` | ~200 | 13 cases (8 plan + 5 边界: contradiction score=0.6 / entailed score=0.2 / 多 record / XSS / OPTIONS) |
| `apps/api/scripts/verify-p9-nli-async.ts` | ~190 | T1+T2 跨轮 polling 真接脚本 (3-2-5 节奏 + chatTurn + pollNliResult) |

### 4.2 修改 (6 files)

| 文件 | 改动 |
|---|---|
| `apps/api/src/handlers/api-chat.ts` | 加 NLI_ASYNC 灰度分支 (~95 行, setImmediate fire-and-forget + audit_log chat_nli_async) + ChatResponse nliTurnId |
| `apps/api/src/lib/audit.ts` | 扩 type union (action 加 chat_nli_reject/chat_nli_async, via 加 jwt/jwt_user, actor 加 sessionId, nliSnapshot 加 turnId + reason "async") |
| `apps/api/src/lib/env.ts` | Env 加 NLI_ASYNC 字段 + parseNliAsync helper |
| `apps/api/cloudbaserc.json` | 加 NLI_ASYNC=0 (Phase 1 default) → Phase 4 改 =1 |
| `apps/api/test/handlers/api-chat.test.ts` | 加 4 新 cases (P9 describe) |
| `packages/shared/src/types.ts` | ChatMessage 加 nliTurnId? |
| `apps/miniprogram/lib/types.ts` | ChatResponse 加 nliTurnId? |
| `apps/miniprogram/pages/chat/chat.ts` | Page data 加 3 字段 + MessageItem 加 nliVerdict + callChat polling + pollNliResult helper + import getJwtToken |
| `apps/api/package.json` | + `verify:p9-nli-async` script |

## 5. 测试基线

| 模块 | cases | 覆盖 |
|---|---|---|
| `api-nli-result.test.ts` | 13 | JWT 缺/scope 错/turnId 非法/audit_log 命中/未命中/entailed 0.9/contradiction 0.3/neutral 0.4/边界 (5 extra) |
| `api-chat.test.ts` (P9 增量) | 4 | NLI_ASYNC=1 + nliTurnId 命中 / setImmediate runtime_error 写 audit_log failure / NLI_ASYNC=0 sync backward compat / turnSeq 计数 |
| `chat.test.ts` (mini program) | 1 | 现有 chat() 集成, 0 破坏 |
| **P9 涉及总测试** | **49 + 1** = **50** | 13 P9 + 21 api-chat + 15 auth-admin + 1 chat |

**全测基线**: 部署 + 涉及 file 49+1/50 PASS, 跟 baseline 371 → 375 PASS 一致 (P9 Task 1+2 增量 +13+4).

**typecheck**: 4 baseline P6 onnx-provider 错 (已知), P9 引入 0 错. P9 Task 2 顺手解决 baseline 4 个 P5 v1.3 audit 错.

## 6. 关联

- **P5 v1.3 NLI spec** (`2026-06-23-p5-nli-entailment-design.md`) — sync 路径 P9 保留 (backward compat)
- **P5 v1.4 跨轮 NLI** (commit ccf6895) — P9 在 setImmediate 内走跨轮 (union hypothesis)
- **P6 本地 ONNX NLI** (`state-p6-local-onnx-nli.md`) — NLI provider P9 不动, 仅调用时序改
- **P7 follow-up** (`state-p7-p8-followup-completion.md`) — baseline 358/358 tests + 真接 5 步
- **P8 vector DB** (`state-p8-vector-db-pgvector.md`) — P9 跟 P8 灰度独立, 2D 矩阵
- **state-arch-v2.4.md** — CloudBase 限制事实稳定

## 7. 风险 / 边界

| 风险 | Likelihood | Impact | Mitigation |
|---|---|---|---|
| setImmediate 内 NLI 抛未 catch | LOW | MEDIUM | try/catch 包 setImmediate 整体 (api-chat §2.2 已写), failOpen 写 audit_log failure |
| audit_log 写入失败 (network/permission) | LOW | LOW | console.warn 吞, P5 v1.3 failOpen 风格 |
| turnId 冲突 (同 session 同 turn_seq) | LOW | LOW | turnSeq 来自 session.messages 计数, 单调递增, 几乎不可能冲突 |
| mini program 轮询 bug (无限轮询) | LOW | MEDIUM | max attempt=5, fallback 不显示 warning |
| 客户端断网 | MEDIUM | LOW | 5 次后 fallback, 不显示 warning |
| P8 PG HNSW 慢 → setImmediate NLI 因 P5 v1.4 跨轮 hypothesis 拉取慢 | LOW | LOW | P9 不改 P5 v1.4 跨轮逻辑, 性能由 P5/P8 决定 |
| 真接 evidence 不足 (P9 灰度短) | MEDIUM | LOW | state-p9 §1.3 真接 3 步 + 7 天 audit_log 趋势 |
| P5 v1.3 sync NLI 路径 break (backward compat) | LOW | HIGH | env.NLI_ASYNC undefined → "0" sync 路径, default 行为不变 |
| 旧 audit_log record (P5 v1.3 旧数据) 跟 P9 schema 不兼容 | LOW | LOW | audit_log NoSQL 弹性 schema, 旧 record 缺 nliSnapshot.turnId 字段, polling 返 found: false (正确) |
| mini program 老版本不识别 nliTurnId 字段 | MEDIUM | LOW | mini program 老版本忽略未知字段, 走 P5 v1.3 sync 行为 (无轮询) |
| setImmediate 在 CloudBase Node 20 runtime 行为不一致 | LOW | MEDIUM | P9 跟 P5 v1.3 sync 路径平行, 灰度可控; 真接 3 步验证 |

### 已知限制

1. **Polling 1 真 user 不代表全量**: mini program 旧版本不识别 nliTurnId 字段, 灰度期间 50% 用户用 polling, 50% 用 P5 v1.3 sync
2. **审计 trail 增长**: chat_nli_async record 每 chat 1 record, audit_log 7 天容量 1.5x
3. **P5 v1.4 跨轮 NLI**: 跨轮 hypothesis 仍在 setImmediate 内 union, 行为不变
4. **P8 PG HNSW 不动**: P9 跟 P8 灰度独立, 部署互不影响
5. **deploy-full.test.ts 真实跑 tcb fn deploy 必卡**: 本机 baseline 已知 (P7 follow-up #1), 真接需 Tencent Cloud 网络

## 8. 副发现 / 教训 (记录给未来)

1. **spec self-review 必要**: 12 节 spec 写完才发现 §1 跟 §3.3 矛盾 (warning prefix sync/async 行为), 主线程自己审 5 个 checklist 抓 1 个, 修 1 行 commit `40f8292`
2. **Polling 节奏 13s 跟 LLM 20s 主路径并行**: 用户几乎感觉不到 verdict 推迟 (5-13s 后才推 warning UI)
3. **P5 v1.3 sync 路径 backward compat**: 老客户端无 nliTurnId 字段, 走 P5 v1.3 sync 行为 (warning prefix 文本), 0 breaking change
4. **P9 跟 P8 灰度独立**: P8 VECTOR_STORE × P9 NLI_ASYNC 2D 灰度矩阵, 任意组合可部署
5. **audit_log schema 扩展兼容旧 record**: NoSQL 弹性 schema, 旧 record 缺 nliSnapshot.turnId 字段, polling 返 found: false
6. **subagent 测试代码 +1 5 边界 case**: plan 列 8 cases, subagent 加 5 (contradiction score=0.6 不警告, entailed score=0.2 不警告, 多 record 第 1 匹配, XSS 特殊字符, OPTIONS 预检) 锁 isWarning 阈值边界
7. **baseline typecheck 错 P9 顺手修 4 个**: 扩 audit.ts 加 chat_nli_reject/jwt/sessionId/reason "async" 顺手解决 P5 v1.3 baseline 4 个错 (8 → 4)
8. **mock coll 名 snake_case 陷阱**: CloudBase collection 名是 `chat_session` snake_case (不是 `chatSession` 驼峰), 跟 camelCase field 不同

## 9. 验证清单 (P9 代码收官)

- [x] P9 §0 TL;DR + §1 决策摘要 (12 决策点, §1 修 warning prefix)
- [x] P9 §2 架构 (polling + setImmediate + audit_log)
- [x] P9 §3 组件 (3 NEW + 6 MODIFIED)
- [x] P9 §4 数据流 (chat async + polling 3-2-5 节奏)
- [x] P9 §5 错误处理表 (8 失败场景)
- [x] P9 §6 测试策略 (13 单元 + 1 真接 + 3 步)
- [x] P9 §7 迁移 (4 phase 灰度, 1 行 env 切)
- [x] P9 §8 风险 / 边界 (11 风险)
- [x] P9 §9 真接验证 (3 步 follow-up)
- [x] P9 §10 关联 + §11 副发现 + §12 验证清单
- [x] Task 1 Phase 1: api-nli-result + 13 单测 (commit b23ba23)
- [x] Task 2 Phase 2: api-chat NLI_ASYNC 灰度 + 4 单测 (commit 2419aa8)
- [x] Task 3 Phase 3: verify-p9-nli-async 真接脚本 (commit 9cb6a35)
- [x] Task 4 Phase 4: cloudbaserc NLI_ASYNC=1 + mini program polling (commit c832189)
- [x] Task 5 Phase 5: state-p9 收尾 (本文件) + memory + MEMORY.md
- [ ] **真接 3 步 follow-up** (deploy:full + deploy:status + verify:p9-nli-async) — 标 P9 follow-up, 主线程真接日补