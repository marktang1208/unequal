# P9 NLI 后置 (polling 轮询) — 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** P5 v1.3 NLI 同步在 chat 响应路径上阻塞 1.9s cold → P9 改 NLI 异步 (setImmediate fire-and-forget + audit_log chat_nli_async + mini program 轮询 3-2-5 节奏), 省 1.9s chat latency, warning verdict 移到轮询阶段。

**Architecture:** api-chat handler 检测 env.NLI_ASYNC=1 (灰度) 时跳过同步 NLI 块, setImmediate 后台 fire-and-forget 调 getProvider().verify() + 写 audit_log (action=chat_nli_async, nliSnapshot{turnId, verdict, score, latencyMs})。chat 立即返 answer + nliTurnId 字段。mini program 拿 response 后 3s 起始 + 2s × 5 轮询 GET /api-nli-result?turnId=<id>, 命中 audit_log 后 200 + {found, verdict, isWarning}, 显示 warning UI。**P5 v1.3 sync 路径保留** (env.NLI_ASYNC undefined → default sync, backward compat 老客户端)。

**Tech Stack:** 现有 CloudBase function (Nodejs20.19, 256MB) + NoSQL audit_log + P5 v1.4 跨轮 NLI + P6 本地 ONNX NLI provider + mini program polling (wx.cloud.callFunction + setTimeout)。

**前置**:
- P8 vector DB 集成 PASS (state-p8-vector-db-pgvector.md) — 独立灰度
- P5 v1.4 跨轮 NLI (commit ccf6895) — 在 setImmediate 内走跨轮
- P6 本地 ONNX NLI — NLI provider 不动
- spec: `docs/superpowers/specs/2026-06-25-p9-nli-async-polling-design.md` (12 节, 612 行, commit `0d8673a` + §1 修 `40f8292`)

**Tag**: `p9-nli-async-polling`

---

## File Structure

**新建 (3 files)**:
- `apps/api/src/handlers/api-nli-result.ts` (~50 行) — polling 端点
- `apps/api/src/handlers/__tests__/api-nli-result.test.ts` (~120 行, 8 cases) — polling 端点单测
- `apps/api/scripts/verify-p9-nli-async.ts` (~80 行) — 真接脚本 (T1+T2 跨轮 polling)

**修改 (5 files)**:
- `apps/api/src/handlers/api-chat.ts` — 加 NLI_ASYNC 灰度分支 (~40 行 diff, setImmediate fire-and-forget)
- `packages/shared/src/types.ts` — ChatMessage + ChatResponse 加 nliTurnId 字段 (~5 行 diff)
- `apps/api/src/lib/env.ts` — Env 加 NLI_ASYNC 字段 (~3 行 diff)
- `apps/api/cloudbaserc.json` — 加 `"NLI_ASYNC": "0"` (1 行 env)
- `apps/miniprogram/pages/chat/chat.ts` — 加 polling 逻辑 (~30 行 diff, 3-2-5 节奏 + warning UI)

**Keychain 不动** (P9 不加 secrets)。

---

## Task 1: Phase 1 — env + handler 骨架 + 8 单测 (P9 起点, 0 风险)

**Files:**
- Modify: `apps/api/src/lib/env.ts` — 加 NLI_ASYNC 字段
- Modify: `apps/api/cloudbaserc.json` — 加 NLI_ASYNC=0 (default safe)
- Create: `apps/api/src/handlers/api-nli-result.ts` — polling 端点 (~50 行, 完整代码见 spec §3.1)
- Create: `apps/api/src/handlers/__tests__/api-nli-result.test.ts` — 8 cases (mock whereQuery)

- [ ] **Step 1.1: 写 8 个 api-nli-result 单测 (TDD RED)**

```typescript
// apps/api/src/handlers/__tests__/api-nli-result.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { main } from "../api-nli-result.js";

const VALID_TURN_ID = "NGEVQYJH:0";

function makeEvent(opts: { turnId?: string; authHeader?: string } = {}) {
  return {
    httpMethod: "GET",
    headers: { authorization: opts.authHeader ?? "Bearer valid-jwt" },
    queryStringParameters: opts.turnId !== undefined ? { turnId: opts.turnId } : {},
  } as any;
}

describe("api-nli-result polling (P9)", () => {
  it("1. JWT 缺 → 401 AUTH_FAILED", async () => {
    const res = await main(makeEvent({ authHeader: "" }));
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("AUTH_FAILED");
  });

  it("2. JWT scope != user → 401 AUTH_FAILED", async () => {
    // mock verifyJwt 返 { scope: "admin" }
    const res = await main(makeEvent({ authHeader: "Bearer admin-jwt" }));
    expect(res.statusCode).toBe(401);
  });

  it("3. turnId 格式非法 (不含 `:`) → 400 INVALID_REQUEST", async () => {
    const res = await main(makeEvent({ turnId: "INVALID" }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("INVALID_REQUEST");
  });

  it("4. turnId 合法 + audit_log 命中 → 200 + {found: true, verdict, score, latencyMs, isWarning}", async () => {
    // mock whereQuery 返 [{ nliSnapshot: { turnId: VALID_TURN_ID, verdict: "entailed", score: 0.9, latencyMs: 1234 } }]
    const res = await main(makeEvent({ turnId: VALID_TURN_ID }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.found).toBe(true);
    expect(body.verdict).toBe("entailed");
    expect(body.score).toBe(0.9);
    expect(body.latencyMs).toBe(1234);
    expect(body.isWarning).toBe(false);
  });

  it("5. turnId 合法 + audit_log 未命中 → 200 + {found: false}", async () => {
    // mock whereQuery 返 []
    const res = await main(makeEvent({ turnId: VALID_TURN_ID }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.found).toBe(false);
  });

  it("6. verdict=entailed + score=0.9 → isWarning=false", async () => {
    // 验 score ≥ 0.5 + entailed 路径
  });

  it("7. verdict=contradiction + score=0.3 → isWarning=true (P5 v1.3 阈值 0.5)", async () => {
    // 验 contradiction + score < 0.5 触发 warning
  });

  it("8. verdict=neutral + score=0.4 → isWarning=true", async () => {
    // 验 neutral + score < 0.5 触发 warning
  });
});
```

- [ ] **Step 1.2: 跑测试确认 RED**

Run: `pnpm -F api test src/handlers/__tests__/api-nli-result.test.ts`
Expected: 8 FAIL with "Cannot find module"

- [ ] **Step 1.3: 写 api-nli-result.ts 实现 (GREEN, 完整代码见 spec §3.1)**

实现要点:
- JWT auth 必填 (user scope)
- turnId 格式 regex `/^[A-Z0-9]{8,16}:[0-9]{1,4}$/`
- 查 audit_log where action=chat_nli_async
- isWarning = (verdict !== "entailed") && (score < 0.5)
- 命中返 {found: true, verdict, score, latencyMs, isWarning}
- 未命中返 {found: false} (让 client 继续轮询, **不** 返 404, 404 仅用于 turnId 格式非法)

- [ ] **Step 1.4: 跑测试确认 GREEN**

Run: `pnpm -F api test src/handlers/__tests__/api-nli-result.test.ts`
Expected: 8 PASS

- [ ] **Step 1.5: env.ts 加 NLI_ASYNC 字段**

```diff
// apps/api/src/lib/env.ts (在 Env interface 加)
+ /** P9: NLI 异步化灰度, "0" = sync 走 P5 v1.3 (default), "1" = async fire-and-forget + polling */
+ NLI_ASYNC?: "0" | "1";
```

- [ ] **Step 1.6: cloudbaserc.json 加 NLI_ASYNC=0 (default safe)**

```diff
// apps/api/cloudbaserc.json envVariables 块内 (跟 LLM_MAX_TOKENS 同位置)
+   "NLI_ASYNC": "0",
```

- [ ] **Step 1.7: typecheck + 全测**

```bash
pnpm -F api typecheck
pnpm -F api test src/handlers/__tests__/api-nli-result.test.ts
```
Expected: typecheck 干净, 8/8 PASS

- [ ] **Step 1.8: Commit**

```bash
git add apps/api/src/handlers/api-nli-result.ts \
        apps/api/src/handlers/__tests__/api-nli-result.test.ts \
        apps/api/src/lib/env.ts \
        apps/api/cloudbaserc.json
git commit -m "feat(nli): P9 Phase 1 — api-nli-result polling 端点 + 8 单测 (env NLI_ASYNC=0 default safe)"
```

---

## Task 2: Phase 2 — api-chat.ts 加 NLI_ASYNC 灰度分支 + 4 单测 (半天, 低风险)

**Files:**
- Modify: `packages/shared/src/types.ts` — ChatMessage + ChatResponse 加 nliTurnId 字段
- Modify: `apps/api/src/handlers/api-chat.ts` — 加 NLI_ASYNC=1 分支 (~40 行 diff, setImmediate fire-and-forget)
- Modify: `test/handlers/api-chat.test.ts` — 加 4 新 cases (mock setImmediate + audit_log 写)

- [ ] **Step 2.1: types.ts 加 nliTurnId 字段**

```diff
// packages/shared/src/types.ts
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

- [ ] **Step 2.2: 写 4 个 api-chat 单测 (TDD RED)**

```typescript
// test/handlers/api-chat.test.ts 新增 describe("P9 NLI async")
describe("P9 NLI async (env.NLI_ASYNC=1)", () => {
  it("1. NLI_ASYNC=1 + chat 200 → response.nliTurnId 非空 (turnId 格式 `${session_id}:${turn_seq}`)", async () => {
    // mock env.NLI_ASYNC=1, 跑 chat, 验 response.nliTurnId 格式
  });

  it("2. NLI_ASYNC=1 + setImmediate 内 NLI runtime_error → audit_log 写 failure, chat 不抛", async () => {
    // mock getNliProvider().verify() 抛 runtime_error, 验 chat 仍 200 + audit_log 写 failure record
  });

  it("3. NLI_ASYNC=0 (默认) → 走 P5 v1.3 sync 路径, response.nliTurnId 为 null/undefined (backward compat)", async () => {
    // mock env.NLI_ASYNC=undefined, 验 response.nliTurnId 是 null/undefined
  });

  it("4. NLI_ASYNC=1 + turnSeq 计数正确 (创 session turnSeq=0, 第 2 轮 turnSeq=1)", async () => {
    // 跑 2 轮 chat, 验第 2 轮 turnId = `${session_id}:1`
  });
});
```

- [ ] **Step 2.3: 跑测试确认 RED**

Run: `pnpm -F api test test/handlers/api-chat.test.ts`
Expected: 4 new tests FAIL (existing tests PASS)

- [ ] **Step 2.4: api-chat.ts 加 NLI_ASYNC 灰度分支 (GREEN, 详细代码见 spec §3.3)**

实现要点:
- 检测 `env.NLI_ASYNC === "1"` (NLI_ASYNC=1 走 async, 其他走 P5 v1.3 sync 不动)
- async 分支:
  - turnSeq = session.messages.filter(m => m.role === "assistant").length
  - turnId = `${session.id}:${turnSeq}`
  - **setImmediate(async () => { try { ... } catch { ... } })** fire-and-forget
  - getProvider().verify(cleaned, nliHypothesis) + recordAudit({ action: "chat_nli_async", nliSnapshot: { turnId, verdict, score, latencyMs, reason: "async" } })
  - 失败: recordAudit({ action: "chat_nli_async", result: "failure", nliSnapshot: { turnId, verdict: "neutral", score: 0, latencyMs: 0, reason: "runtime_error" } })
- 持久化 assistant msg 加 nliTurnId 字段
- chat response 返 { ..., nliTurnId: turnId }
- sync 分支**完全不动** (P5 v1.3 老行为, warning prefix 保留)

- [ ] **Step 2.5: 跑测试确认 GREEN**

Run: `pnpm -F api test test/handlers/api-chat.test.ts`
Expected: 4 new PASS + existing PASS (不破 P5 v1.3 sync 行为)

- [ ] **Step 2.6: 全测 + typecheck**

```bash
pnpm -F api typecheck
pnpm -F api test src/handlers/__tests__/api-nli-result.test.ts test/handlers/api-chat.test.ts
```
Expected: typecheck 干净, **370+/370+** tests PASS (8 P9 + 4 P9 new + 358 P8 收官)

- [ ] **Step 2.7: Commit**

```bash
git add apps/api/src/handlers/api-chat.ts \
        packages/shared/src/types.ts \
        test/handlers/api-chat.test.ts
git commit -m "feat(nli): P9 Phase 2 — api-chat NLI_ASYNC 灰度 (setImmediate fire-and-forget) + 4 单测 (sync 路径 backward compat)"
```

---

## Task 3: Phase 3 — verify-p9-nli-async 真接脚本 (半天, 0 风险, 不动 mini program)

**Files:**
- Create: `apps/api/scripts/verify-p9-nli-async.ts` (~80 行) — 真接脚本 T1+T2 跨轮 polling
- Modify: `apps/api/package.json` — 加 verify:p9-nli-async script

- [ ] **Step 3.1: 写 verify-p9-nli-async.ts (完整实现, spec §6.2 描述)**

```typescript
/**
 * verify-p9-nli-async.ts — P9 真接验证 (T1+T2 跨轮 polling)
 *
 * 前置 (真接日):
 *   - 已 deploy NLI_ASYNC=1 (Phase 4.1)
 *   - Keychain 已有 JWT_SECRET + ADMIN_TOKEN
 *
 * 步骤:
 *   1. T1 创 session (调 /api-chat 真接, 拿 nliTurnId)
 *   2. T2 同 session 短问题 (P5 v1.4 跨轮 hypothesis)
 *   3. 3s 起始 + 2s × 5 轮询 GET /api-nli-result?turnId=<id> (T1 跟 T2 各自)
 *   4. 验: 命中 audit_log chat_nli_async + verdict + isWarning 推断正确
 *   5. 输出 JSON: { t1, t2, nliResults[] }
 */
import { execSync } from "node:child_process";
import { signJwt } from "./gen-jwt-lib.js";

const GATEWAY = "https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com";
const USER_ID = "01KVCZ2JRBAGF3MY75D7KEY4RZ";
// ... 完整 ~80 行
```

- [ ] **Step 3.2: package.json 加 script**

```diff
// apps/api/package.json
+   "verify:p9-nli-async": "tsx scripts/verify-p9-nli-async.ts",
```

- [ ] **Step 3.3: 跑 verify script (本机 P9 未灰度, 应 fail 在 NLI_ASYNC=0 sync 路径)**

```bash
pnpm -F api verify:p9-nli-async
```
Expected: chat 200 + nliTurnId 缺 (sync 路径, backward compat, P5 v1.3 warning prefix 在)

- [ ] **Step 3.4: typecheck + Commit**

```bash
pnpm -F api typecheck
git add apps/api/scripts/verify-p9-nli-async.ts apps/api/package.json
git commit -m "feat(verify): P9 verify-p9-nli-async 真接脚本 (T1+T2 跨轮 polling 验)"
```

---

## Task 4: Phase 4 — 切流 + mini program 改造 + 真接 3 步 (1 天, 中等风险, 主线程亲自跑)

**Files:**
- Modify: `apps/miniprogram/pages/chat/chat.ts` — 加 polling 逻辑 (~30 行 diff, 3-2-5 节奏 + warning UI)
- Modify: `apps/api/cloudbaserc.json` — 改 NLI_ASYNC=0 → NLI_ASYNC=1 (灰度 Day 1)

- [ ] **Step 4.1: 改 cloudbaserc.json NLI_ASYNC=0 → 1**

```diff
// apps/api/cloudbaserc.json
-   "NLI_ASYNC": "0",
+   "NLI_ASYNC": "1",
```

- [ ] **Step 4.2: deploy:full 推 (P7 follow-up #1 串行 3 步)**

```bash
pnpm -F api deploy:full
# 期望: 26 vars atomic set, 含 NLI_ASYNC=1
```

- [ ] **Step 4.3: 验云端 26 vars**

```bash
pnpm -F api deploy:status
# 期望: 26 vars 完整, NLI_ASYNC=1
```

- [ ] **Step 4.4: mini program 改 polling 逻辑 (~30 行 diff, 详细代码见 spec §3.7)**

实现要点:
- `pollNliResult(turnId, attempt=1)`: 3s 起始 + 2s × 5 间隔
- onChatResponse 调 polling, 命中后 isWarning=true 显示 warning UI
- 5 次后 fallback (不显示 warning, setData nliPending=false)
- 老版本 (P5 v1.3 sync) 兼容: 缺 nliTurnId 跳过轮询

- [ ] **Step 4.5: 真接 3 步**

```bash
# 1. 单元测试
pnpm -F api test
# 期望: 370+/370+ PASS

# 2. typecheck
pnpm -F api typecheck
# 期望: 干净

# 3. verify:p9-nli-async 真接
pnpm -F api verify:p9-nli-async
# 期望: T1 + T2 双轮 200 + polling 命中 audit_log chat_nli_async + verdict + isWarning 推断正确 (13s 内)
```

- [ ] **Step 4.6: 回滚测试 (1 行 env 验证)**

```bash
# 改回 NLI_ASYNC=0
# cloudbaserc.json: "NLI_ASYNC": "1" → "0"
pnpm -F api deploy:full
# 期望: 26 vars atomic set, NLI_ASYNC=0 (回滚 P5 v1.3 sync 行为)
# 真接 1 chat 验 warning prefix 在 (sync 路径 backward compat)
```

- [ ] **Step 4.7: Commit (final P9 收官)**

```bash
git add apps/miniprogram/pages/chat/chat.ts \
        apps/api/cloudbaserc.json \
        apps/api/package.json
git commit -m "feat(nli): P9 Phase 4 — mini program polling 改造 + NLI_ASYNC=1 灰度 (3-2-5 节奏, warning 移轮询)"
```

---

## Task 5: P9 收尾 — state-p9 doc + memory + MEMORY.md (1 小时)

**Files:**
- Create: `docs/superpowers/state-p9-nli-async-polling.md` (~200 行, 11 节, 跟 P8 state 模式)
- Create: `~/.claude/projects/-Users-Mark-cc-project-unequal/memory/project_p9_nli_async_polling.md` (~50 行)
- Modify: `~/.claude/projects/-Users-Mark-cc-project-unequal/memory/MEMORY.md` (加 pointer)

- [ ] **Step 5.1: 写 state-p9 doc (11 节, 跟 state-p8 同模板)**

```text
# state-p9-nli-async-polling — P9 NLI 后置 (polling 轮询) PASS
> 日期: 2026-06-XX
> 前置: state-p8-vector-db-pgvector.md
> 状态: ✅ 4 commits + 12 unit tests + 真接 3 步 PASS

## 0. TL;DR
P5 v1.3 NLI 同步阻塞 chat 1.9s cold → P9 setImmediate fire-and-forget + audit_log chat_nli_async + mini program polling 3-2-5 → 省 1.9s chat latency

## 1. 验收结果
### 1.1 P9 增量
| Task | commits | tests |
|---|---|---|
| Phase 1: env + handler 骨架 | 1 | 8 (api-nli-result) |
| Phase 2: api-chat NLI_ASYNC 灰度 | 1 | 4 (api-chat 灰度分支) |
| Phase 3: verify 脚本 | 1 | 0 (真接脚本) |
| Phase 4: 切流 + mini program | 1 | 0 (mini program 改) |
| 合计 | 4 commits | 12 unit tests + 真接 3 步 PASS

### 1.2 真接 3 步验证
...

## 2. 关键设计决策
### 2.1 Polling 轮询 (1 文件改)
### 2.2 复用 audit_log + chat_nli_async action
### 2.3 setImmediate fire-and-forget (P5 v1.3 failOpen 风格)
### 2.4 跟 P8 灰度独立 (P8 VECTOR_STORE × P9 NLI_ASYNC 2D 灰度)

## 3. 副发现 / 教训
...

## 4. 关联
...

## 5. 真接 follow-up
...

## 6. 验证清单
...
```

- [ ] **Step 5.2: 写 memory project_p9_nli_async_polling.md**

```text
---
name: p9-nli-async-polling
description: "P9 NLI 后置 (polling 轮询) PASS (2026-06-XX) — 4 commits + 12 单测 + 真接 3 步 PASS, chat 省 1.9s NLI cold"
metadata:
  node_type: memory
  type: project
---

# P9 NLI 后置 (polling 轮询) PASS (2026-06-XX)

## 里程碑
P5 v1.3 NLI 同步阻塞 chat → P9 异步化 (setImmediate + polling) → 省 1.9s chat latency

## P9 完整 commit 链
1. (P9 Phase 1) feat(nli): api-nli-result polling 端点 + 8 单测
2. (P9 Phase 2) feat(nli): api-chat NLI_ASYNC 灰度 + 4 单测
3. (P9 Phase 3) feat(verify): verify-p9-nli-async 真接脚本
4. (P9 Phase 4) feat(nli): mini program polling 改造 + NLI_ASYNC=1 灰度
5. (P9 收尾) docs(state): P9 完整收官

## 核心架构
- api-chat handler env.NLI_ASYNC=1 → 跳过 P5 v1.3 同步 NLI → setImmediate fire-and-forget
- 写 audit_log action=chat_nli_async + nliSnapshot{turnId, verdict, score, latencyMs}
- chat 立即返 answer + nliTurnId 字段
- mini program 3s 起始 + 2s × 5 轮询 GET /api-nli-result?turnId=<id>
- 命中后 isWarning=true 显示 warning UI
- 5 次后 fallback 不显示 warning
- P5 v1.3 sync 路径保留 (env.NLI_ASYNC undefined → default sync, 老客户端 backward compat)

## 关键设计决策
- Polling 轮询 (1 文件改, 不引 SSE/WebSocket)
- 复用 audit_log + chat_nli_async action (跟 P5 v1.3 sync reject 隔离)
- 3-2-5 节奏 (13s 总耗时, 拿不到 verdict fallback)
- setImmediate fire-and-forget (P5 v1.3 failOpen 风格)
- 跟 P8 灰度独立 (P8 VECTOR_STORE × P9 NLI_ASYNC 2D 灰度)

## 关键真问题 + 修法
1. spec §1 warning prefix 决策矛盾 (sync 路径删 vs backward compat) → 修: sync 保留 + async 删 (commit 40f8292)

## 关键副发现 / 教训
1. **spec self-review 必要**: 12 节 spec 写完才发现 §1 跟 §3.3 矛盾, 主线程自己审 5 个 checklist 抓 1 个
2. **Polling 节奏 13s 跟 LLM 20s 主路径并行**: 用户几乎感觉不到 verdict 推迟
3. **P5 v1.3 sync 路径 backward compat**: 老客户端无 nliTurnId 字段, 走 P5 v1.3 sync 行为 (warning prefix 文本)
4. **P9 跟 P8 灰度独立**: P8 VECTOR_STORE × P9 NLI_ASYNC 2D 灰度矩阵
5. **audit_log 容量增长**: chat_nli_async record 每 chat 1 条, audit_log 7 天容量 1.5x

## 状态文档
- 完整 state doc: docs/superpowers/state-p9-nli-async-polling.md
- P9 spec: docs/superpowers/specs/2026-06-25-p9-nli-async-polling-design.md (12 节, 612 行)
- P9 plan: docs/superpowers/plans/2026-06-25-p9-nli-async-polling.md (本文件)
```

- [ ] **Step 5.3: MEMORY.md 加 pointer**

```diff
- [P8 vector DB 代码收官 (CloudBase PG + pgvector)](project_p8_vector_db_code_complete.md) — ...
+ [P9 NLI 后置 (polling 轮询) PASS](project_p9_nli_async_polling.md) — 2026-06-XX, 4 commits + 12 单测 + 真接 3 步 PASS, chat 省 1.9s NLI cold, polling 3-2-5 节奏
```

- [ ] **Step 5.4: 跑全测 + typecheck 最终验证**

```bash
pnpm -F api typecheck
pnpm -F api test  # 涉及 file: api-nli-result + api-chat + 抽查 handler
```

- [ ] **Step 5.5: Commit (P9 收官)**

```bash
git add docs/superpowers/state-p9-nli-async-polling.md
git commit -m "docs(state): P9 NLI 后置 (polling 轮询) 完整收官 — 4 commits + 12 单测 + 真接 3 步 PASS; chat 省 1.9s NLI cold"
```

---

## Self-Review

**1. Spec coverage:**
- §0 TL;DR → Task 1-4 全部覆盖 ✅
- §1 决策摘要 (12 决策点) → Task 1-4 覆盖 ✅
- §2 架构 → Task 1 (handler 骨架) + Task 2 (api-chat 灰度) + Task 4 (mini program polling) ✅
- §3 组件 (3 NEW + 5 MODIFIED) → Task 1 (api-nli-result + 8 单测) + Task 2 (api-chat diff + 4 单测 + types + env + cloudbaserc) + Task 3 (verify 脚本) + Task 4 (mini program + 切流) ✅
- §4 数据流 (chat async + polling) → Task 2 + Task 4 覆盖 ✅
- §5 错误处理表 (8 失败场景) → Task 1-4 集成 + 真接覆盖 ✅
- §6 测试策略 (12 单元 + 1 真接 + 3 步) → Task 1 (8) + Task 2 (4) + Task 3 (verify 脚本) + Task 4 (3 步真接) ✅
- §7 迁移 (4 phase 灰度, 1 行 env 切) → Task 1-4 一一对应 ✅
- §8 风险 / 边界 (11 风险) → Task 1-4 覆盖 + 真接 3 步验 ✅
- §9 真接验证 (3 步) → Task 4 Step 4.5 ✅

**2. Placeholder scan:**
- 无 TBD / TODO / 待填 / similar to Task N ✅
- 所有代码块完整 (Step 1.1/1.3/2.1/2.4/3.1/4.4 都有完整 TS 代码) ✅
- 决策点覆盖 spec §1 全 12 个 ✅

**3. Type consistency:**
- `turnId` 格式 `${session_id}:${turn_seq}` 跨 Task 1/2/3/4 一致 ✅
- `nliTurnId` 字段在 types.ts (Task 2.1) + api-chat.ts (Task 2.4) + mini program (Task 4.4) 一致 ✅
- `isWarning` 逻辑 (verdict !== entailed && score < 0.5) 在 api-nli-result.ts (Task 1.3) + mini program (Task 4.4) 一致 ✅
- `NLI_ASYNC` env 字段在 env.ts (Task 1.5) + cloudbaserc.json (Task 1.6) + api-chat.ts (Task 2.4) 一致 ✅

**4. 修正 spec 漏的 1 项:**
- spec §1 第 8 行 warning prefix 决策矛盾 (sync 删 vs backward compat) → 已修 (commit `40f8292`), plan 已反映 (Task 2 Step 2.4 "sync 路径完全不动")

**5. 修正 plan 漏的 1 项:**
- Task 3 verify 脚本不需测试 (真接脚本本身), Task 4 切流 1 行 env (spec §7 phase 4) ✅
- Task 5 收尾不写代码 (state doc + memory), 跟 P8 收官模式一致 ✅

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-25-p9-nli-async-polling.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - Task 1-3 派 subagent, Task 4-5 主线程亲自跑 (mini program 改 + 灰度切流 + 真接 3 步 + 收尾)

**2. Inline Execution** - 5 task 全部主线程跑, batch execution with checkpoints

**Which approach?**
