# CP-7-A — miniprogram callFunction 统一化

**版本**：2026-06-18
**前置**：CP-6 已归档（commit `0fa7f0e` + tag `cp6-archived`）；miniprogram 5/5 真机验证 PASS
**范围**：apps/miniprogram 端 callFunction 统一化 — 删 P3.9 临时方案留下的 wxRequestAsFetch / fetchWithRefresh 双套机制，统一走 `cloudCall<T>(req)` 单一入口；admin scope 不动（admin 走 HTTP 不能用 wx.cloud）

> **不是新功能 spec** — 是清理 P3.9 临时方案留下的技术债。结构借鉴 M6.4 inflightEnsureJwt 设计 + M6.9 mutex spec 写法。

---

## 1. Requirements

| # | 现状 | 目标 |
|---|---|---|
| R-1 | P3.9 临时方案：wx-login 走 callFunction，其他 5 caller（chat/sessions/ask/rename/delete）走 HTTP gateway → 双套机制并存 | miniprogram 端 100% 走 callFunction，统一 1 套机制 |
| R-2 | 5 caller 各自包 `fetchWithRefresh` 401 refresh + inflight promise 共享（M6.4）| refresh 逻辑统一内作于 cloudCall；caller 不感知 |
| R-3 | caller 函数返 `Promise<Response>` 形态（caller 解析 body）+ `wxRequestAsFetch` 返 ResponseLike | cloudCall 返 `Promise<T>` typed body + 异常路径 throw `ApiError` |
| R-4 | `ensureJwt` 是 lib/auth.ts 公共 export，5 caller 各自调 | ensureJwt 改 cloudCall 内部使用，`__ensureJwtForTesting` 改名 export 给测试 |
| R-5 | 5 caller 路径用 `/chat` `/sessions` `/ask` 等裸名（callFunction work 后已加 `api-` 前缀）| 路径统一 `/api-*` 前缀，cloudCall 内部做前缀映射 / 或 caller 写完整路径 |

**YAGNI 精简**（spec 显式不做）：
- ❌ 不动 admin scope（admin-login 走 HTTP，不能用 wx.cloud）
- ❌ 不做 callFunction retry/backoff（CP-7-A scope 仅 1 次 refresh）
- ❌ 不做 callFunction timeout（CloudBase 默认 5s 足够；如不够 P3.9 已 work）
- ❌ 不做 KEK 轮换 / session_key envelope（M6.8 / M6.7 已做）
- ❌ 不做 handler 后端补全（CP-7-B 独立项目；本 spec 不阻塞）

---

## 2. Patterns to Mirror

| 类别 | 来源 | 复用方式 |
|---|---|---|
| inflight promise 共享 | `apps/miniprogram/lib/api.ts` M6.4 `inflightEnsureJwt: Map<string, Promise<string>>` + `.finally(() => delete)` | cloudCall.ts 同模式（refreshJwt 共享 1 次 wx.login） |
| 测试桩注入 | `packages/shared/src/embedding.ts` `__setEmbeddingImpl` + `cloudbase.ts` `__setCloudCallImpl`（P3.9 已存在） | cloudCall.ts 同模式 `__setCloudCallImpl` |
| ApiError 形态 | `apps/api/src/lib/http-error.ts` HttpError（statusCode + code + message） | cloudCall.ts `ApiError` 同形态（前端 + 后端 error class 一致） |
| Mock-first | CP-1 ~ CP-6 全程 mock-first（真接 CloudBase 推 CP-7 真接阶段） | cloudCall.ts 测试用 `__setCloudCallImpl(mockFn)`，0 wx.cloud global mock |
| 5 caller typed wrapper | `apps/admin/src/lib/api.ts` admin helper（typed body + thin wrapper） | miniprogram lib/api.ts 5 caller 同模式（chat/sessions/ask/rename/delete） |

---

## 3. Architecture Overview

```
─── 入口层（apps/miniprogram/lib/cloud-call.ts）─────────────────────
新 cloudCall<T>(req: CloudCallRequest): Promise<T>:
  1. rawCall(req) → impl ?? wx.cloud.callFunction 实现
  2. 401 + req.jwt 存在 → refreshJwt() + rawCall 重试 1 次
  3. 200-299 → return body as T
  4. 4xx / 5xx → throw ApiError(statusCode, code, msg)
  5. rawCall throw → throw ApiError(0, "NETWORK_ERROR", err.message)
  6. refreshJwt() 失败 → throw ApiError(401, "REFRESH_FAILED", "...")

─── 入参（CloudCallRequest）───────────────────────────────────
interface CloudCallRequest {
  path: string;                          // "/api-chat"
  httpMethod: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string>;
  jwt?: string;                          // 不传 = 不 refresh
}

─── 出口（ApiError）───────────────────────────────────────────
class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}

─── 上层（apps/miniprogram/lib/api.ts）─────────────────────────
5 caller 函数（chat / listSessions / ask / renameSession / deleteSession）改为 cloudCall<T> 的 typed wrapper:
  export async function chat(input: ChatInput): Promise<ChatResponse> {
    return cloudCall<ChatResponse>({
      path: "/api-chat", httpMethod: "POST", body: input, jwt: getJwt(),
    });
  }

─── auth 层（apps/miniprogram/lib/auth.ts）─────────────────────
ensureJwt public export 删（caller 不再调）
保留：getJwt / setJwt / clearJwt（仍 export 给 lib/api.ts 内部用）
inflight promise 共享 + wx.login 调用逻辑迁入 cloudCall.ts 模块内（cloudCall 内部 _refreshJwt private）
__ensureJwtForTesting 改名 export（仅测试用，prod 不调）

─── 路由层（miniprogram app.ts / 各 page）──────────────────────
0 改动（page 调 lib/api.ts 的 5 caller 函数即可；caller 函数签名不变）
```

**关键设计原则**：
- ✅ cloudCall 是 miniprogram 唯一 callFunction 调用点（`impl ?? wx.cloud.callFunction`）
- ✅ 401 refresh 内作于 cloudCall，caller 不感知
- ✅ Promise<T> typed body，caller 不解析 statusCode
- ✅ 异常路径 throw ApiError，caller 可 `instanceof ApiError` 判断 statusCode
- ✅ 测试桩 `__setCloudCallImpl(mockFn)` 注入（不 mock 全局 wx.cloud）
- ❌ 不做 callFunction retry/backoff（仅 1 次 refresh）
- ❌ admin scope 不动（admin 走 HTTP，不能用 wx.cloud）

---

## 4. Files to Change

### 新建（3 个）

| 文件 | 内容 | 预估行数 |
|---|---|---|
| `apps/miniprogram/lib/cloud-call.ts` | `cloudCall<T>` + `ApiError` + `__setCloudCallImpl` + `_refreshJwt`（私有） + inflight map | ~150 |
| `apps/miniprogram/test/cloud-call.test.ts` | 10 测试（happy / 401+refresh / 401-no-jwt / 401-refresh-fail / 401-retry-401 / 4xx / 5xx / network / wx.login fail / inflight share） | ~180 |
| `docs/cp7-cloud-call-setup.md` | 用法 + mock 指南 + 内部细节 + migration 路径 | ~120 |

### 修改（3 个）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `apps/miniprogram/lib/api.ts` | 重写：删 wxRequestAsFetch + fetchWithRefresh，5 caller 改调 cloudCall | ~180 → ~140 |
| `apps/miniprogram/lib/auth.ts` | ensureJwt public export 删；保留 getJwt/setJwt/clearJwt；__ensureJwtForTesting rename | ~150 → ~120 |
| `apps/miniprogram/test/api.test.ts` | 改 mock：`__setCloudCallImpl` 注入 fake，14 caller 测试逻辑保留 | ~200 → ~180 |

### 删除（0 个文件删除，1 段 dead code 清理）

- ✅ `apps/miniprogram/lib/api.ts` 内 `wxRequestAsFetch` 函数 + `fetchWithRefresh` 函数（dead code）
- ✅ `apps/miniprogram/lib/auth.ts` 内 `ensureJwt` 函数（迁入 cloudCall.ts 模块内）

### 不改（沿用 M6.4 / M6.9）

- ✅ `apps/api/src/...` — 0 改动（server handler 不动；callFunction 协议 P3.9 已 work）
- ✅ `apps/admin/...` — 0 改动（admin 仍走 HTTP）
- ✅ `apps/crawler/...` — 0 改动
- ✅ `packages/shared/...` — 0 改动
- ✅ CloudBase api-router handler — 0 改动
- ✅ miniprogram app.ts / 各 page — 0 改动（caller 函数签名不变）

---

## 5. Task 1: `cloud-call.ts` 新 lib

### 5.1 `cloud-call.ts` 实现（伪代码）

```typescript
/**
 * CP-7-A miniprogram 唯一 callFunction 入口（spec §3）。
 * 
 * 行为：
 * - Promise<T> typed body，caller 不解析 statusCode
 * - 401 + 有 jwt → refresh + retry 1 次（内部 inflight 共享 wx.login）
 * - 4xx / 5xx → throw ApiError(statusCode, code, message)
 * - rawCall throw → throw ApiError(0, "NETWORK_ERROR", err.message)
 * 
 * 测试桩：`__setCloudCallImpl(mockFn)` 注入（避免 mock 全局 wx.cloud）
 */

import { getJwt, setJwt, clearJwt } from "./auth";

// ─── ApiError ───────────────────────────────────────────────
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ─── CloudCallRequest / RawResult ───────────────────────────
export interface CloudCallRequest {
  path: string;
  httpMethod: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string>;
  jwt?: string;
}

export interface RawResult {
  statusCode: number;
  body: unknown;
}

export type CloudCallFn = (req: CloudCallRequest) => Promise<RawResult>;

// ─── impl + 测试桩 ──────────────────────────────────────────
let impl: CloudCallFn | null = null;
export function __setCloudCallImpl(next: CloudCallFn | null) { impl = next; }
export function __resetCloudCallImpl() { impl = null; }

// ─── inflight refresh (M6.4 模式) ──────────────────────────
let inflightRefresh: Promise<string> | null = null;

async function refreshJwt(): Promise<string> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    try {
      const { ensureJwt } = await import("./auth.js");
      return await ensureJwt();
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

// ─── rawCall（impl ?? wx.cloud.callFunction）────────────────
async function rawCall(req: CloudCallRequest): Promise<RawResult> {
  if (impl) return impl(req);
  if (typeof wx === "undefined" || !wx.cloud) {
    throw new ApiError(0, "WX_UNAVAILABLE", "wx.cloud not available");
  }
  const res = await wx.cloud.callFunction({
    name: "api-router",
    data: {
      path: req.path,
      httpMethod: req.httpMethod,
      body: req.body,
      headers: req.jwt ? { Authorization: `Bearer ${req.jwt}` } : {},
    },
  });
  return {
    statusCode: res.result.statusCode ?? 200,
    body: res.result.body ?? null,
  };
}

// ─── cloudCall（公开 API）──────────────────────────────────
function codeFromBody(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    return String((body as Record<string, unknown>).error);
  }
  return "UNKNOWN";
}

function msgFromBody(body: unknown): string {
  if (body && typeof body === "object" && "message" in body) {
    return String((body as Record<string, unknown>).message);
  }
  return "Unknown error";
}

export async function cloudCall<T>(req: CloudCallRequest): Promise<T> {
  let res: RawResult;
  try {
    res = await rawCall(req);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, "NETWORK_ERROR", err instanceof Error ? err.message : String(err));
  }

  if (res.statusCode === 401 && req.jwt) {
    let newJwt: string;
    try {
      newJwt = await refreshJwt();
    } catch (err) {
      throw new ApiError(401, "REFRESH_FAILED", err instanceof Error ? err.message : String(err));
    }
    let retry: RawResult;
    try {
      retry = await rawCall({ ...req, jwt: newJwt });
    } catch (err) {
      throw new ApiError(0, "NETWORK_ERROR", err instanceof Error ? err.message : String(err));
    }
    if (retry.statusCode === 401) {
      clearJwt();
      throw new ApiError(401, "UNAUTHORIZED", "Authentication failed after refresh");
    }
    if (retry.statusCode >= 400) {
      throw new ApiError(retry.statusCode, codeFromBody(retry.body), msgFromBody(retry.body));
    }
    return retry.body as T;
  }

  if (res.statusCode === 401) {
    throw new ApiError(401, "MISSING_AUTH", "No JWT provided");
  }
  if (res.statusCode >= 400) {
    throw new ApiError(res.statusCode, codeFromBody(res.body), msgFromBody(res.body));
  }
  return res.body as T;
}
```

### 5.2 关键决策

- ✅ `cloudCall<T>` 公开 API；`ApiError` 暴露 statusCode + code + message
- ✅ `__setCloudCallImpl` 测试桩（避免 mock 全局 wx.cloud）
- ✅ inflight refresh promise 共享（M6.4 模式，节省 wx.login 次数）
- ✅ rawCall 失败 throw ApiError(0, "NETWORK_ERROR", ...)，与 HTTP statusCode 错区分
- ✅ 401 + refresh + retry 401 → clearJwt + throw UNAUTHORIZED（避免死循环）
- ❌ 不返回 `Mutex` 对象 / 不返回 `Promise<{statusCode, body}>` / 不做 backoff（YAGNI）
- ❌ admin scope 不动（admin 走 HTTP）

---

## 6. Task 2: `lib/api.ts` 重写 + `lib/auth.ts` 清理

### 6.1 `lib/api.ts` 重写（伪代码）

```typescript
/**
 * CP-7-A 5 caller typed wrapper（spec §6.1）。
 * 
 * 路径全部带 `api-` 前缀对齐 server HANDLER_MAP（state-cp6 §10.6.1 P3.9 修过）。
 * body / query / jwt 通过 cloudCall 透明传递。
 */

import { cloudCall } from "./cloud-call.js";
import { getJwt } from "./auth.js";

export interface ChatInput { q: string; session_id?: string; }
export interface ChatResponse { answer: string; citations: ...; session_id: string; is_new_session: boolean; }

export async function chat(input: ChatInput): Promise<ChatResponse> {
  return cloudCall<ChatResponse>({
    path: "/api-chat", httpMethod: "POST", body: input, jwt: getJwt(),
  });
}

// listSessions / ask / renameSession / deleteSession 类似
// ask: POST /api-ask
// listSessions: GET /api-sessions-list
// renameSession: PATCH /api-sessions-rename/:id  body: {title}
// deleteSession: DELETE /api-sessions-delete/:id
```

### 6.2 `lib/auth.ts` 清理

```typescript
// 保留：
export function getJwt(): string | null { ... }
export function setJwt(jwt: string): void { ... }
export function clearJwt(): void { ... }

// 删 public ensureJwt（迁入 cloudCall.ts 模块内）
// 改 export __ensureJwtForTesting（仅测试）
export async function __ensureJwtForTesting(): Promise<string> {
  // 原 ensureJwt 内部实现，仅 __ensureJwtForTesting 调
}

// inflight 共享 map 改放到 cloudCall.ts 模块内（auth.ts 不持有）
```

### 6.3 关键决策

- ✅ 5 caller 函数签名不变（caller 不感知 cloudCall）
- ✅ 路径全部带 `api-` 前缀（state-cp6 §10.6.1 P3.9 修过，对齐 server HANDLER_MAP）
- ✅ ensureJwt private，cloudCall 内部 _refreshJwt 用
- ❌ 不暴露 ensureJwt 给 caller（避免 caller 误调导致 refresh 时机混乱）

---

## 7. Task 3: 测试更新

### 7.1 `cloud-call.test.ts` 新增（10 用例）

```typescript
describe("cloudCall (CP-7-A)", () => {
  beforeEach(() => { __setCloudCallImpl(null); __resetCloudCallImpl(); /* mock auth module */ });
  afterEach(() => { __resetCloudCallImpl(); jest.restoreAllMocks(); });

  it("happy path: 200 → return body as T", async () => {
    __setCloudCallImpl(async () => ({ statusCode: 200, body: { x: 1 } }));
    const r = await cloudCall<{ x: number }>({ path: "/x", httpMethod: "GET", jwt: "t" });
    expect(r.x).toBe(1);
  });

  it("401 + 有 jwt + refresh 成功 + retry 200 → return retry body", async () => {
    let callCount = 0;
    __setCloudCallImpl(async (req) => {
      callCount++;
      if (callCount === 1) return { statusCode: 401, body: { error: "UNAUTHORIZED" } };
      return { statusCode: 200, body: { x: 2 } };
    });
    // mock refreshJwt 返新 jwt
    const r = await cloudCall<{ x: number }>({ path: "/x", httpMethod: "GET", jwt: "old" });
    expect(r.x).toBe(2);
    expect(callCount).toBe(2);
  });

  it("401 + 有 jwt + refresh 失败 → throw ApiError(401, REFRESH_FAILED)", async () => {
    __setCloudCallImpl(async () => ({ statusCode: 401, body: null }));
    // mock refreshJwt throw
    await expect(cloudCall({ path: "/x", httpMethod: "GET", jwt: "old" }))
      .rejects.toThrow("REFRESH_FAILED");
  });

  it("401 + 有 jwt + refresh 成功 + retry 仍 401 → throw ApiError(401, UNAUTHORIZED) + clearJwt", async () => {
    __setCloudCallImpl(async () => ({ statusCode: 401, body: null }));
    // mock refreshJwt 返 newJwt
    // mock clearJwt (spy)
    await expect(cloudCall({ path: "/x", httpMethod: "GET", jwt: "old" }))
      .rejects.toThrow("UNAUTHORIZED");
    // expect clearJwt 被调
  });

  it("401 + 无 jwt → throw ApiError(401, MISSING_AUTH)", async () => {
    await expect(cloudCall({ path: "/x", httpMethod: "GET" }))
      .rejects.toThrow("MISSING_AUTH");
  });

  it("4xx: throw ApiError(statusCode, server code, message)", async () => {
    __setCloudCallImpl(async () => ({ statusCode: 400, body: { error: "BAD", message: "bad" } }));
    await expect(cloudCall({ path: "/x", httpMethod: "POST", body: {}, jwt: "t" }))
      .rejects.toMatchObject({ statusCode: 400, code: "BAD", message: "bad" });
  });

  it("5xx: throw ApiError(500, ...)", async () => {
    __setCloudCallImpl(async () => ({ statusCode: 500, body: { error: "BOOM" } }));
    await expect(cloudCall({ path: "/x", httpMethod: "GET", jwt: "t" }))
      .rejects.toMatchObject({ statusCode: 500 });
  });

  it("rawCall throw: throw ApiError(0, NETWORK_ERROR)", async () => {
    __setCloudCallImpl(async () => { throw new Error("network down"); });
    await expect(cloudCall({ path: "/x", httpMethod: "GET", jwt: "t" }))
      .rejects.toMatchObject({ statusCode: 0, code: "NETWORK_ERROR" });
  });

  it("inflight share: 3 并发 401 → 1 次 refreshJwt", async () => {
    __setCloudCallImpl(async () => ({ statusCode: 401, body: null }));
    // mock refreshJwt: spy on call count
    let refreshCount = 0;
    // mock refreshJwt to count
    const p1 = cloudCall({ path: "/x", httpMethod: "GET", jwt: "old" }).catch(() => null);
    const p2 = cloudCall({ path: "/x", httpMethod: "GET", jwt: "old" }).catch(() => null);
    const p3 = cloudCall({ path: "/x", httpMethod: "GET", jwt: "old" }).catch(() => null);
    await Promise.all([p1, p2, p3]);
    // expect refreshCount === 1（inflight 共享）
  });

  it("impl throw → throw ApiError(0, NETWORK_ERROR)", async () => {
    __setCloudCallImpl(async () => { throw "string error"; });
    await expect(cloudCall({ path: "/x", httpMethod: "GET", jwt: "t" }))
      .rejects.toMatchObject({ statusCode: 0, code: "NETWORK_ERROR" });
  });
});
```

### 7.2 `api.test.ts` 改 mock

现有 14 测试保留 case 逻辑，mock 改：
- 删 `wxRequestAsFetch` mock
- 加 `__setCloudCallImpl(fakeFn)` 注入
- 5 caller（chat/sessions/ask/rename/delete）的请求/响应断言不变（typed body 不变）

```typescript
// 例：chat test 改 mock
beforeEach(() => {
  __setCloudCallImpl(async (req) => {
    if (req.path === "/api-chat" && req.httpMethod === "POST") {
      return { statusCode: 200, body: { answer: "ok", session_id: "s1", ... } };
    }
    return { statusCode: 404, body: null };
  });
});
```

### 7.3 关键决策

- ✅ cloud-call 10 测试覆盖所有错误路径
- ✅ api.test.ts 14 测试逻辑保留，仅 mock 改 impl
- ✅ 0 wx.cloud global mock（用 `__setCloudCallImpl` 测试桩）
- ❌ 不测 wx.cloud.callFunction 真实行为（mock-first；CP-7 真接时验）

---

## 8. 数据流

### 8.1 流 A — happy path

```
T0: page.chat tab 用户点击发送 → page.ts 调 chat({q: "宝宝发烧怎么办"})
  └→ chat(input) → cloudCall({path: "/api-chat", httpMethod: "POST", body: input, jwt: getJwt()})
       └→ rawCall → impl ?? wx.cloud.callFunction
            └→ api-router handler: verifyAuth → 通过 → 调 chat handler → 返 {statusCode: 200, body: {answer, ...}}
       └→ res.statusCode === 200 → return body as ChatResponse
  └→ chat 返 ChatResponse → page.ts 渲染
```

### 8.2 流 B — 401 refresh

```
T0: jwt 24h 过期
T0+1s: page.ts 调 chat(input) → cloudCall({..., jwt: "oldJwt"})
  └→ rawCall → 401
  └→ res.statusCode === 401 && req.jwt 存在 → refreshJwt()
       └→ inflight map check：空 → 创建 promise
            └→ 调 ensureJwt → wx.login + /auth/wx-login → 拿 newJwt → setJwt
            └→ finally: inflight = null
       └→ return newJwt
  └→ rawCall({..., jwt: newJwt}) 重试 1 次
       └→ api-router verifyAuth → 通过 → 200 body
  └→ return body as ChatResponse
```

### 8.3 流 C — 401 refresh 后仍 401

```
T0: jwt 过期 + server 端 user 已删（极端情况）
T0+1s: cloudCall({..., jwt: "oldJwt"}) → rawCall → 401
  └→ refreshJwt → newJwt（user 已删但 jwt 签发能过，refresh 仍返 jwt）
  └→ rawCall({..., jwt: newJwt}) → 401（verifyAuth 失败）
  └→ clearJwt() + throw ApiError(401, "UNAUTHORIZED", "Authentication failed after refresh")
  └→ page.ts catch ApiError → 显示"请重新登录"提示
```

### 8.4 流 D — 401 无 jwt

```
T0: 用户首次启动（jwt 未拿到）
T0+1s: page.ts 调 chat(input) → cloudCall({..., jwt: undefined})
  └→ rawCall → 401（no Authorization header）
  └→ res.statusCode === 401 但 req.jwt undefined → throw ApiError(401, "MISSING_AUTH")
  └→ page.ts catch → 应先 ensureJwt 再 retry（app.ts onLaunch 已 ensureJwt；不应该发生）
```

### 8.5 流 E — inflight share

```
T0: jwt 过期 + page 触发 3 并发 fetch（chat + listSessions + renameSession）
T0+1ms: 3 个 caller 各自调 cloudCall → rawCall → 3 个 401
T0+2ms: 3 个 cloudCall 同时进入 refresh 分支
  └→ 第 1 个调 refreshJwt → 创建 inflightRefresh promise
  └→ 第 2 个 await inflightRefresh（同一 promise）
  └→ 第 3 个 await inflightRefresh（同一 promise）
  └→ wx.login 只调 1 次（inflight 共享）
T0+500ms: inflight 完成 → 3 个 cloudCall 各自 rawCall 重试
  └→ 3 个都 200
T0+1s: finally → inflightRefresh = null
```

---

## 9. 错误处理

| 错误场景 | cloudCall 行为 | caller 行为 |
|---|---|---|
| `impl` throw (wx.cloud 不可用) | throw ApiError(0, "NETWORK_ERROR", err.message) | 显示"网络异常" |
| impl 返 200 | return body as T | 正常处理 |
| impl 返 4xx | throw ApiError(statusCode, code, message) | 显示服务端错误提示 |
| impl 返 5xx | throw ApiError(statusCode, code, message) | 显示"服务异常" + 上报 |
| impl 返 401 + 有 jwt | refreshJwt + retry 1 次 | 透明 |
| impl 返 401 + refresh 失败 | throw ApiError(401, "REFRESH_FAILED") | 显示"请重新登录" + 跳登录页 |
| impl 返 401 + refresh 成功 + retry 401 | clearJwt + throw ApiError(401, "UNAUTHORIZED") | 显示"账号已失效" + 跳登录页 |
| impl 返 401 + 无 jwt | throw ApiError(401, "MISSING_AUTH") | 不应发生（app.ts onLaunch ensureJwt）；catch 后兜底 ensureJwt |
| impl 返 body 解析失败 | throw ApiError(statusCode, code, message) — 由 codeFromBody fallback 处理 | 显示服务端错误 |

---

## 10. 测试策略

### 10.1 TDD 流程

```
Task 1: 写 10 cloud-call 测试（RED）→ 写 cloud-call.ts（GREEN）→ REFACTOR
Task 2: 改 api.ts 重写 5 caller → 跑 14 api.test.ts 验证逻辑保留
Task 3: 删 wxRequestAsFetch / fetchWithRefresh dead code → 跑全部测试
```

### 10.2 Mock-first 边界

- ✅ cloud-call 单元测试纯函数（用 __setCloudCallImpl mock）
- ✅ api.test.ts 14 测试行为不变（仅 mock 改）
- ❌ 不测 wx.cloud.callFunction 真实协议（P3.9 已验真；CP-7 真接时再验）
- ❌ 不测真实 CloudBase api-router handler（mock-first）
- ❌ 不测真实 wx.login + /auth/wx-login（mock refreshJwt）

### 10.3 累计测试矩阵

| 测试文件 | 现有 | CP-7-A | 累计 |
|---|---|---|---|
| `apps/miniprogram/test/cloud-call.test.ts` | 0 | +10 | **10** |
| `apps/miniprogram/test/api.test.ts` | 18 | 改 mock（数不变）| 18 |
| `apps/miniprogram/test/auth.test.ts` | 5 | 改 mock（数不变）| 5 |
| 其他包 | 113 | 0 | 113 |
| **累计** | **143** | **+10** | **153** |

注：5 个 auth test 改 `__ensureJwtForTesting` 调用，case 逻辑保留，测试数不变。

### 10.4 Dev 验证 AC（CP-7 真接时补）

- 真实 wx.cloud.callFunction 协议兼容（P3.9 已验）
- 真实 wx.login 401 refresh 行为
- 真实 CloudBase api-router handler 兼容性

---

## 11. Acceptance Criteria

### 11.1 功能 AC

| # | 标准 |
|---|---|
| AC-1 | `cloud-call.ts` 提供 `cloudCall<T>(req): Promise<T>` + `ApiError(statusCode, code, message)` + `__setCloudCallImpl` |
| AC-2 | 200 → return body as T |
| AC-3 | 401 + jwt → refreshJwt + retry 1 次（成功返 body，失败 throw REFRESH_FAILED / UNAUTHORIZED）|
| AC-4 | 401 + 无 jwt → throw ApiError(401, MISSING_AUTH) |
| AC-5 | 4xx / 5xx → throw ApiError(statusCode, code, message) |
| AC-6 | impl throw → throw ApiError(0, NETWORK_ERROR, msg) |
| AC-7 | inflight share：3 并发 401 → 1 次 refreshJwt |
| AC-8 | 401 + refresh + retry 仍 401 → clearJwt + throw UNAUTHORIZED |
| AC-9 | `lib/api.ts` 5 caller 全部改调 cloudCall，函数签名不变 |
| AC-10 | `lib/auth.ts` ensureJwt public 删，__ensureJwtForTesting 改 export |
| AC-11 | `wxRequestAsFetch` / `fetchWithRefresh` dead code 全部清理 |

### 11.2 测试 AC

| # | 标准 |
|---|---|
| AC-12 | `pnpm -F miniprogram test` 全绿（**33 用例**：23 旧 + 10 新）|
| AC-13 | `pnpm -r typecheck` 5 包全绿 |

### 11.3 文档 AC

| # | 标准 |
|---|---|
| AC-14 | `docs/cp7-cloud-call-setup.md` 完成（用法 + mock + 内部细节 + migration 路径）|
| AC-15 | `README.md` 加 CP-7-A 节（与 M6.x 模式一致）|
| AC-16 | `docs/superpowers/state-cp7-a.md` 收尾（commit 汇总 + 真接路径）|

### 11.4 Dev 验证 AC（CP-7 真接时补）

- 真实 wx.cloud.callFunction 协议
- 真实 wx.login refresh 行为
- 真实 CloudBase api-router handler 兼容性

---

## 12. CP-7 真接路径

CP-7-A 真接 CloudBase 时验证：
- 5 个 caller 函数真接 CloudBase 后 5/5 走通（state-cp6 §10.6.5 P3.9 已验）
- refresh path：模拟 jwt 过期 → 验证 inflight share + clearJwt 行为
- 4xx / 5xx / NETWORK_ERROR 边界真接验证

---

## 13. 风险与回滚

### 13.1 风险点

| 风险 | 缓解 | 严重度 |
|---|---|---|
| **impl 注入 mock 与真实 wx.cloud 不一致** | 测试覆盖所有错误路径；P3.9 已验真实协议 work | LOW |
| **inflight share 与 M6.4 行为差异** | cloudCall 复用 M6.4 inflightEnsureJwt 模式（map + finally delete）；M6.4 已 3 测试验 | LOW |
| **caller 改调 cloudCall 漏 caller** | api.test.ts 14 测试全保留（覆盖 5 caller）；AC-9 显式列 5 caller | MED |
| **ApiError 与 HttpError 后端 error class 不一致** | ApiError 设计仿 HttpError（statusCode + code + message）；CP-7 真接时验证对齐 | LOW |
| **deleteSession / renameSession handler 后端 404** | CP-6 后端没实现；客户端调用会 throw ApiError(404) — caller 显示"功能暂不可用"；CP-7-B 单独项目补 | LOW（已知 limitation）|

### 13.2 回滚策略

| Commit | 回滚方式 | 影响 |
|---|---|---|
| Task 1+2+3 (cloud-call + api + auth + tests) | `git revert <merge>` | miniprogram 退回 P3.9 双套机制（wxRequestAsFetch + fetchWithRefresh + ensureJwt public）；admin / server / shared / crawler 不受影响 |

---

## 14. 实施计划

### 14.1 Commit 拆分（5 commit + 1 merge = 6 总）

| # | Commit | 主题 | 测试增量 |
|---|---|---|---|
| 1 | spec | `docs: CP-7-A spec — miniprogram callFunction 统一化` | 0 |
| 2 | plan | `docs: CP-7-A plan — miniprogram callFunction 统一化` | 0 |
| 3 | Task 1 | `feat(miniprogram): CP-7-A — cloud-call.ts 新 lib + 10 tests` | +10 |
| 4 | Task 2+3 | `refactor(miniprogram): CP-7-A — lib/api.ts 重写 + lib/auth.ts 清理 + dead code 删` | 0（api.test 改 mock，数不变）|
| 5 | docs | `docs: CP-7-A — state + README + setup.md` | 0 |
| merge | `worktree-cp7-a-cloudcall → master --no-ff` | — |

**共 5 commit + 1 merge = 6 总**

### 14.2 工作流

- worktree 隔离 + 1 包改动（仅 miniprogram）
- TDD 严格走：10 测试先写（RED）→ 写 cloud-call.ts（GREEN）→ 改 api.ts（保持现有 18 测试绿）→ REFACTOR
- 主线程直接做（参考 M6.3c/d/4/9/10 经验，~2-4h 总耗时）

---

## 15. 累计测试 + 文件清单

### 15.1 仓库测试累计（CP-7-A 后）

| 包 | 现有 | CP-7-A | 累计 |
|---|---|---|---|
| shared | 47 | 0 | 47 |
| api | 23 | 0 | 23 |
| miniprogram | 30 | +10（cloud-call）| **40** |
| admin | 24 | 0 | 24 |
| crawler | 19 | 0 | 19 |
| **累计** | **143** | **+10** | **153** |

### 15.2 文件清单（CP-7-A 后）

| 类型 | 文件 | 状态 |
|---|---|---|
| 新代码 | `apps/miniprogram/lib/cloud-call.ts` | NEW（~150 行）|
| 新测试 | `apps/miniprogram/test/cloud-call.test.ts` | NEW（~180 行）|
| 新文档 | `docs/cp7-cloud-call-setup.md` | NEW（~120 行）|
| 改代码 | `apps/miniprogram/lib/api.ts` | 重写（180 → 140 行）|
| 改代码 | `apps/miniprogram/lib/auth.ts` | 删 dead code + rename export（150 → 120 行）|
| 改测试 | `apps/miniprogram/test/api.test.ts` | 改 mock（200 → 180 行）|
| 改测试 | `apps/miniprogram/test/auth.test.ts` | rename ensureJwt → __ensureJwtForTesting |
| 新文档 | `docs/superpowers/specs/2026-06-18-cp7-a-cloudcall-unification-design.md` | NEW（本文件）|
| 新文档 | `docs/superpowers/plans/2026-06-18-cp7-a-cloudcall-unification.md` | NEW |
| 新文档 | `docs/superpowers/state-cp7-a.md` | NEW |
| 改文档 | `README.md` | +CP-7-A 节 |

**共 1 新 lib + 2 新测试 + 1 新 setup doc + 2 改代码 + 2 改测试 + 4 文档 = 12 总**

---

## 附录 A：关键设计决策记录

| # | 决策 | 理由 | 拒绝方案 |
|---|---|---|---|
| D-1 | cloudCall 是 miniprogram 唯一 callFunction 入口 | P3.9 双套机制（wxRequestAsFetch + fetchWithRefresh + ensureJwt public）是临时方案；统一消除 dead code | 保留双套 + 加 cloudCall thin wrapper（dead code 反模式，违反 ECC coding-style）|
| D-2 | `Promise<T>` + throw ApiError | caller 不解析 statusCode；类型安全；异常路径清晰 | Promise<{statusCode, body}>（caller 仍要 if-else）；裸 Promise<T> + throw 通用 Error（缺 statusCode 判断）|
| D-3 | 401 refresh 内作于 cloudCall | caller 不感知 refresh 时机；集中管理 inflight share | caller 自己 refresh（5 caller 重复逻辑）；服务器端 refresh（服务端无法调 wx.login）|
| D-4 | inflight share 用 module-level map（M6.4 模式） | wx.login 共享：3 并发 401 → 1 次 wx.login 节省 ~200ms | 每次 401 都新 wx.login（浪费 + 触发 wx 风控）；Promise.all 协调（更复杂）|
| D-5 | `__setCloudCallImpl(mockFn)` 测试桩 | 避免 mock 全局 wx.cloud；测试更纯粹；与 state-cp6 §10.6.3 设计一致 | mock 全局 wx.cloud（污染 global state）；jest.mock wx.cloud（vitest 不友好）|
| D-6 | 401 + refresh + retry 仍 401 → clearJwt + throw UNAUTHORIZED | 避免死循环（user 已删等极端情况）；UI 跳登录页 | 静默 retry（死循环）；不 clearJwt（下次又 refresh 又 fail）|
| D-7 | 路径 `/api-*` 前缀写在 caller | caller 显式声明 endpoint；路径转换简单可读；HANDLER_MAP 已有 `api-` 前缀 | cloudCall 内部映射（隐式 magic，debug 不友好）；server 端改 HANDLER_MAP（破坏 P3.9 已 work 模式）|
| D-8 | 范围仅 miniprogram（admin scope 不动）| admin 是 web app 不能用 wx.cloud；admin-login 走 HTTP | admin 也走 callFunction（技术不可行）；加 admin 等价的 cloudCall（YAGNI，admin 仍可 HTTP）|
| D-9 | 不做 callFunction retry/backoff | CP-7-A scope 仅 1 次 refresh；额外 retry 复杂度高 + 价值低 | 重试 3 次 + 指数 backoff（CP-7-A+ YAGNI）；stream response（小程序不支持）|
| D-10 | 不补 renameSession / deleteSession handler 后端 | CP-7-B 独立项目；本 spec 不阻塞；客户端调用 throw ApiError(404) caller 可降级 | 本 spec 一并补（scope 蔓延，违反 ECC coding-style YAGNI）|