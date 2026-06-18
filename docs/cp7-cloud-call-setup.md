# CP-7-A Setup — miniprogram callFunction 统一化

## 1. 用途

`apps/miniprogram/lib/cloud-call.ts` 是 miniprogram 端 callFunction 的唯一入口。所有 endpoint（chat/sessions/ask/nickname/adminLogin 等）都走它，统一 401 refresh + inflight 共享 + typed error。

## 2. 公开 API

```typescript
import { cloudCall, ApiError } from "./lib/cloud-call.js";

// caller-facing API：typed body + throw ApiError
async function myCaller() {
  try {
    const data = await cloudCall<MyResponse>({
      path: "/api-chat",       // 必填：server handler path
      httpMethod: "POST",      // 必填：GET/POST/PATCH/DELETE
      body: { q: "test" },     // 可选：JSON body（自动 JSON.stringify）
      jwt: getJwtToken() ?? undefined,  // 可选：401 refresh 触发条件
    });
    return data;
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.statusCode === 401) { /* 跳登录 */ }
      else { /* 显示错误 */ }
    }
    throw e;
  }
}
```

## 3. ApiError

```typescript
class ApiError extends Error {
  readonly statusCode: number;  // 0 = NETWORK_ERROR, 401, 404, 500 等
  readonly code: string;        // server error code 或 "NETWORK_ERROR" / "MISSING_AUTH" 等
  message: string;              // server message 或兜底
}
```

| statusCode | code 例子 | 含义 |
|---|---|---|
| 0 | NETWORK_ERROR / WX_UNAVAILABLE | impl 抛错 / wx.cloud 不可用 |
| 401 | MISSING_AUTH / REFRESH_FAILED / UNAUTHORIZED | 无 jwt / refresh 失败 / refresh 后仍 401 |
| 4xx / 5xx | server code | server 返错 |

## 4. 7 caller 一览

| caller | path | httpMethod | jwt? | 备注 |
|---|---|---|---|---|
| `ask(q)` | `/api-ask` | POST | storage jwt | 单轮问答 |
| `chat({q, session_id?})` | `/api-chat` | POST | storage jwt | 多轮问答 |
| `listSessions()` | `/api-sessions-list` | GET | storage jwt | 列 session |
| `renameSession(id, title)` | `/sessions/:id` | PATCH | storage jwt | CP-7-B handler 待补 |
| `deleteSession(id)` | `/api-sessions-delete/:id` | DELETE | storage jwt | 软删 |
| `updateNickname(name)` | `/user/nickname` | PATCH | storage jwt | CP-7-B handler 待补 |
| `adminLogin(adminToken)` | `/api-auth-admin-login` | POST | 无 | admin 鉴权 |

`adminLogin` 是唯一无 jwt 的 caller（admin_token 是凭证而非 jwt）。

## 5. 测试 mock

测试用 `__setCloudCallImpl(mockFn)` 注入 fake，不 mock 全局 `wx.cloud`：

```typescript
import { __setCloudCallImpl, ApiError, type CloudCallFn } from "../lib/cloud-call.js";

beforeEach(() => {
  const mockCloudCall = vi.fn();
  __setCloudCallImpl(mockCloudCall as unknown as CloudCallFn);
});

it("happy", async () => {
  mockCloudCall.mockResolvedValue({ statusCode: 200, body: { answer: "ok" } });
  // ...caller...
  expect(mockCloudCall).toHaveBeenCalledWith({
    path: "/api-ask", httpMethod: "POST", body: { q: "test" }, jwt: ...,
  });
});

it("5xx", async () => {
  mockCloudCall.mockRejectedValue(new ApiError(500, "INTERNAL", "boom"));
  // ...caller 抛 ApiError...
});
```

测试桩 3 个：
- `__setCloudCallImpl(fn | null)` — 注入 / 清空
- `__resetCloudCallImpl()` — 同上（清空）
- `__clearInflightRefresh()` — 清模块级 inflight refresh 缓存（并发 401 测试用）

## 6. 生产部署（CP-7 真接验证）

生产路径（miniprogram 运行时）：
1. miniprogram app.ts `wx.cloud.init({ env: "unequal-d4ggf7rwg82e0900b" })` 已 work
2. `cloudCall` 默认 impl 自动调 `wx.cloud.callFunction({ name: "api-router", data: {...} })`
3. CloudBase api-router handler 接收 `event.httpMethod/path/body/headers/queryString`
4. server 端 `parseFuncPath` 解析 `/api-chat` → `chat` → HANDLER_MAP["chat"]

无需改 server / CloudBase 配置（CP-6 已 work）。

## 7. 内部细节

### 7.1 401 refresh 内作

```typescript
async function cloudCall<T>(req) {
  let res = await rawCall(req);
  if (res.statusCode === 401 && req.jwt) {
    const newJwt = await refreshJwt();  // 内部 inflight 共享 wx.login
    res = await rawCall({ ...req, jwt: newJwt });  // 重试 1 次
    if (res.statusCode === 401) {
      saveJwt(null);  // 清空 storage，下次 401 触发新 wx.login
      throw new ApiError(401, "UNAUTHORIZED", "...");
    }
  }
  // ...
}
```

### 7.2 inflight 共享（M6.4 模式）

```typescript
let inflightRefresh: Promise<string> | null = null;

async function refreshJwt(): Promise<string> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    try { return await ensureJwt(); }
    finally { inflightRefresh = null; }  // 不论成功失败清缓存
  })();
  return inflightRefresh;
}
```

3 并发 401 → 1 次 `ensureJwt`（节省 ~200ms）。

### 7.3 saveJwt 来源

`cloudCall.ts` import `saveJwt` from `chat-storage.js`（不是 `auth.js` — auth.ts 不 re-export saveJwt）。

## 8. 迁移路径（v0 → v1）

miniprogram 之前用 `fetchWithRefresh` + `wxRequestAsFetch` + `inflightEnsureJwt` 三件套（M6.3a / M6.4 时代）。CP-7-A 全部清理：

| 删除 | 替代 |
|---|---|
| `wxRequestAsFetch` | `wx.cloud.callFunction`（cloudCall 默认 impl）|
| `getFetch` | 同上 |
| `fetchWithRefresh` | cloudCall 内部 401 refresh |
| `inflightEnsureJwt` + `__clearInflightEnsureJwt` | cloudCall 内部 `inflightRefresh` + `__clearInflightRefresh` |
| `buildHeaders` | cloudCall 内部 jwt header 注入 |

`api.ts` 从 262 行（带 dead code）缩到 ~140 行。

## 9. 已知 limitation（CP-7-A scope 不做）

- ❌ 不做 callFunction retry/backoff（仅 1 次 refresh）
- ❌ 不补 renameSession / updateNickname server handler（CP-7-B 独立项目；客户端调会 throw ApiError(404)）
- ❌ 不做 mini-program 端 admin scope（admin 走 HTTP gateway via admin web app；adminLogin 走 callFunction 是 miniprogram lib export 给未来 admin 调试用）

详见 `docs/superpowers/specs/2026-06-18-cp7-a-cloudcall-unification-design.md`。