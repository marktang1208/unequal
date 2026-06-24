# M6.2 wx.login + JWT + admin 登录页 设计

- **日期**：2026-06-16
- **基线**：M6.1 收尾（commit `325b8b8`）
- **配套 spec**：`docs/superpowers/specs/2026-06-16-m6-1-multiturn-session-design.md`（§7.1 已留切换点、§10 留 M6.2 范围）
- **复杂度**：Medium（4 包协同 + 鉴权重构，jose 同步算法无 DO 复杂度）
- **Mock-first 边界**：jscode2session 走 fetchImpl 注入 mock；不真接 Cloudflare / 微信真机扫码；jose 真跑（HS256 同步算法无外部依赖）

---

## 1. Requirements Restatement

把 M6.1 的 `admin_token` 单模式升级到「admin_token（env secret）+ wx.login（小程序）」双模式，鉴权走统一 `verifyAuth` 入口（`AUTH_MODE` 切）。

**核心交付**：
- `/auth/wx-login` 端点：POST `{ code }` → 调 jscode2session → upsert user → 签 JWT
- `/auth/admin-login` 端点：POST `{ admin_token }` → 验 env.ADMIN_TOKEN → 签 JWT
- `verifyAuth()` 加 `jwt` 分支（替换 M6.1 的 501 留口）
- 现有 6 个路由（upload/ingest/search/ask/chat/sessions）从 `verifyAdminToken` 改 `verifyAuth`
- admin LoginPage（admin_token 输入 form + localStorage 持久化）
- 小程序冷启动 `wx.login` → `/auth/wx-login` → `wx.setStorageSync('jwt')` 持久化
- 32-35 新增 vitest 用例

**不交付**（推到 M6.3+）：
- session_key 存储（M6.3 要拿 nickname/avatar 时再处理）
- refresh token / 双 token 轮转（M6.2 单 24h access token 足够）
- 多租户 / 家长用户邀请流程（M6.4+）
- admin 登录页 rate limit（env secret 强密码足够防爆破）

---

## 2. Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| Migration | `apps/api/migrations/0001_init.sql:1-7` | `CREATE TABLE IF NOT EXISTS` + 预留 `wx_openid TEXT UNIQUE` + `nickname TEXT`（M0-M1 已留 M6.2 接口）|
| Auth | `apps/api/src/lib/auth.ts:41-56` | `verifyAuth(req, env)` 已有 `admin_token` / `jwt` 双分支骨架（`jwt` 抛 501 留口，M6.2 替换实现）|
| Route | `apps/api/src/routes/chat.ts:15-30` | `{ async POST(req, env): Response }` 对象 + verifyAuth + parse body + try/catch HttpError |
| Lib test hooks | `apps/api/src/lib/chat.ts:14-21` | `RunChatOptions { q, env, fetchImpl?, ... }` 测试注入模式（M6.2 `RunWxLoginOptions` 同样）|
| LLM mock | `apps/api/src/lib/llm.ts:21-22` | `fetchImpl = opts.fetchImpl ?? fetch` 模式（M6.2 `wx.ts` 同样）|
| D1 access | `apps/api/src/lib/chat.ts:166-180` | `env.DB.prepare(sql).bind(...).first/all/run()` 模式 |
| miniprogram storage | `apps/miniprogram/lib/chat-storage.ts:23-39` | `__setSessionStorageImpl` 让测试桩替换 wx storage（M6.2 jwt 持久化同样模式）|
| admin api | `apps/admin/src/lib/api.ts:6-14` | `getToken()` 返 localStorage token（M6.2 改用 jwt 字符串）|

---

## 3. Architecture

### 3.1 鉴权统一入口（`verifyAuth`）

```ts
// apps/api/src/lib/auth.ts:41-56（已有骨架，M6.2 替换 jwt 分支）
export async function verifyAuth(req: Request, env: Env): Promise<AuthIdentity> {
  const mode = env.AUTH_MODE || "admin_token";
  if (mode === "admin_token") {
    // 不变（M6.1）
    const header = req.headers.get("Authorization");
    const result = verifyAdminToken(header, env.ADMIN_TOKEN);
    if (!result.ok) throw new HttpError(401, "UNAUTHORIZED", result.message);
    return { userId: DEFAULT_ADMIN_USER_ID, isAdmin: true };
  }
  if (mode === "jwt") {
    // M6.2 实现
    const header = req.headers.get("Authorization");
    if (!header?.startsWith("Bearer ")) {
      throw new HttpError(401, "MISSING_BEARER", "Authorization header must be 'Bearer <jwt>'");
    }
    const token = header.slice(7);
    const payload = await verifyJwt(token, env.JWT_SECRET);
    return { userId: payload.userId, isAdmin: payload.isAdmin };
  }
  throw new HttpError(400, "BAD_AUTH_MODE", `Unsupported AUTH_MODE: ${mode}`);
}
```

**M6.2 关键变化**：M6.1 现有路由（upload/ingest/search/ask/chat/sessions）从 `verifyAdminToken` 改 `verifyAuth`。M6.2 后无 `verifyAdminToken` 直接调用（仅 `verifyAuth` 内部用 admin_token 模式时调）。

### 3.2 JWT 签发 + 验签（`lib/auth-jwt.ts` 新）

```ts
import { SignJWT, jwtVerify } from "jose";

export interface JwtPayload {
  userId: string;
  isAdmin: boolean;
}

const ALG = "HS256";
const ISSUER = "unequal-api";
const TTL_SECONDS = 24 * 60 * 60; // 24h

export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return await new SignJWT({ userId: payload.userId, isAdmin: payload.isAdmin })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(key);
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload> {
  const key = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, key, { issuer: ISSUER });
  if (typeof payload.userId !== "string" || typeof payload.isAdmin !== "boolean") {
    throw new HttpError(401, "INVALID_JWT_CLAIMS", "JWT payload missing userId or isAdmin");
  }
  return { userId: payload.userId, isAdmin: payload.isAdmin };
}
```

**库选择**：jose 4.x（推荐），理由：
- 1 个 dep，~50KB
- HS256/RS256/ES256 全支持
- TypeScript-first，`setProtectedHeader` + `setExpirationTime` 链式 API 直观
- 替代方案：`@tsndr/cloudflare-worker-jwt`（Cloudflare Workers 优化但 API 较老）/ 原生 `Web Crypto API`（无 jose 依赖但样板代码多）

### 3.3 /auth/wx-login 端点（POST）

**文件**：`apps/api/src/routes/auth.ts`（新，2 个 endpoint 共一个 file）

**数据流**：
1. POST `{ code: string }` → 解析 body
2. 调 `wx.jscode2session(code, env.WX_APP_ID, env.WX_APP_SECRET)` → 拿 `openid` + `session_key`
3. `findOrCreateUser(env.DB, openid)` → SELECT 或 INSERT user
4. `signJwt({ userId, isAdmin: false }, env.JWT_SECRET)`
5. 返 `{ token, user_id, is_new_user, expires_in: 86400 }`

**错误码**（spec §6 模式）：
- `MISSING_CODE` (400) — body 缺 `code`
- `INVALID_CODE` (401) — jscode2session 返 `errcode != 0`
- `WX_API_ERROR` (502) — jscode2session 网络/超时
- `INFRA_MISSING` (500) — `env.WX_APP_ID` / `env.WX_APP_SECRET` 缺

### 3.4 /auth/admin-login 端点（POST）

**数据流**：
1. POST `{ admin_token: string }` → 解析 body
2. `body.admin_token === env.ADMIN_TOKEN` → 失败抛 401 `INVALID_ADMIN_TOKEN`
3. `signJwt({ userId: DEFAULT_ADMIN_USER_ID, isAdmin: true }, env.JWT_SECRET)`
4. 返 `{ token, user_id: DEFAULT_ADMIN_USER_ID, is_admin: true, expires_in: 86400 }`

**为什么独立 endpoint**（不直接用 env.ADMIN_TOKEN + verifyAuth admin_token 模式）：
- 显式生成 JWT，让前端 getToken() 拿 JWT 而不是 raw admin_token
- 后端 ADMIN_TOKEN 是 env secret，前端拿 JWT（短期、可撤销、可改 userId）
- M6.2 后 admin_token 模式仅 dev 真验用，prod 一律走 jwt 模式

### 3.5 wx.jscode2session 包装（`lib/wx.ts` 新）

```ts
export interface WxSessionResult {
  openid: string;
  session_key: string; // M6.2 不用存，仅作 jscode2session 返回字段
  unionid?: string;    // 开放平台下唯一，M6.2 暂不存
}

export interface Jscode2SessionOptions {
  code: string;
  appId: string;
  appSecret: string;
  fetchImpl?: typeof fetch; // 测试桩
}

export async function jscode2session(opts: Jscode2SessionOptions): Promise<WxSessionResult> {
  const f = opts.fetchImpl ?? fetch;
  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.searchParams.set("appid", opts.appId);
  url.searchParams.set("secret", opts.appSecret);
  url.searchParams.set("js_code", opts.code);
  url.searchParams.set("grant_type", "authorization_code");
  const res = await f(url.toString());
  if (!res.ok) {
    throw new HttpError(502, "WX_API_ERROR", `jscode2session HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    openid?: string;
    session_key?: string;
    unionid?: string;
    errcode?: number;
    errmsg?: string;
  };
  if (data.errcode || !data.openid) {
    throw new HttpError(401, "INVALID_CODE", data.errmsg ?? "jscode2session returned no openid");
  }
  return { openid: data.openid, session_key: data.session_key ?? "", unionid: data.unionid };
}
```

**测试模式**：fetchImpl 注入 mock Response（与 LLM mock 同模式）。

### 3.6 user 表 upsert（`lib/user.ts` 新）

```ts
export interface UserRow {
  id: string;
  wx_openid: string | null;
  nickname: string | null;
  created_at: number;
}

export async function findOrCreateUser(
  d1: D1Database,
  openid: string,
): Promise<{ user: UserRow; isNew: boolean }> {
  // 先查
  const existing = await d1
    .prepare(`SELECT id, wx_openid, nickname, created_at FROM user WHERE wx_openid = ?`)
    .bind(openid)
    .first<UserRow>();
  if (existing) return { user: existing, isNew: false };
  // 没找到 → 新建（id = ulid()）
  const id = ulid();
  const now = Date.now();
  await d1
    .prepare(
      `INSERT INTO user (id, wx_openid, nickname, created_at) VALUES (?, ?, NULL, ?)`,
    )
    .bind(id, openid, now)
    .run();
  return {
    user: { id, wx_openid: openid, nickname: null, created_at: now },
    isNew: true,
  };
}
```

**M0-M1 schema 已留字段**：`wx_openid TEXT UNIQUE` + `nickname TEXT`，0 migration 改动。

### 3.7 admin LoginPage（`apps/admin/src/pages/LoginPage.tsx` 新）

**UI 流程**：
- 路由 `/login`（无 token 时 navigate guard 强制跳）
- 1 个 form：`admin_token` input（type=password）+ submit button
- 提交后 `authedJson('/auth/admin-login', { method: 'POST', body: { admin_token: value } })` → 拿 `{ token }`
- `localStorage.setItem('admin_token', token)` + `navigate('/chat-sim')`

**改 `getToken()`**：
```ts
// apps/admin/src/lib/api.ts:6-14
export function getToken(): string {
  const token = localStorage.getItem("admin_token");
  if (token) return token;
  // dev fallback（与 M3 一致）
  if (import.meta.env.DEV && localStorage.getItem("admin_token") === null) {
    return "test-token-please-change";  // 触发 dev mock-mode 三连击
  }
  throw new Error("admin_token 未设置：请先访问 /login 输入");
}
```

**`authedJson` 改**：M6.1 现状用 `Authorization: Bearer ${getToken()}` 调 `Bearer <raw_admin_token>`，M6.2 后 `getToken()` 返 JWT 字符串（jose 签的），header 变成 `Authorization: Bearer <jwt>`，无 client 改动（除了 `authedJson` 透明调用 `getToken()`）。

### 3.8 小程序冷启动登录（`apps/miniprogram/lib/auth.ts` 新）

```ts
import { chat } from "./api.js"; // 已有，调用 /auth/wx-login 加这 endpoint

export async function ensureJwt(baseUrl: string, fetchImpl?: typeof fetch): Promise<string> {
  const existing = wx.getStorageSync("unequal:jwt");
  if (existing && typeof existing === "string" && existing.length > 0) {
    return existing; // M6.2 暂不验签，依赖后端返 401 时重 login
  }
  // 调 wx.login 拿 code
  const loginRes = await new Promise<{ code: string }>((resolve, reject) => {
    wx.login({ success: resolve, fail: reject });
  });
  // 调 /auth/wx-login 换 JWT
  const res = await fetchImplOrWx(`${baseUrl}/auth/wx-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: loginRes.code }),
  }, fetchImpl);
  if (!res.ok) {
    throw new Error(`/auth/wx-login ${res.status}`);
  }
  const data = await res.json() as { token: string };
  wx.setStorageSync("unequal:jwt", data.token);
  return data.token;
}
```

**App.onLaunch 调一次**：
```ts
// apps/miniprogram/app.ts
import { ensureJwt } from "./lib/auth.js";
App({
  async onLaunch() {
    try {
      await ensureJwt("http://localhost:8787");
    } catch (err) {
      console.warn("wx.login failed:", err);
      // 失败不阻塞 app 启动（401 时 chat() / listSessions() 会再 retry）
    }
  },
});
```

**`getToken()` 改**：M6.1 现状是 `wx.getStorageSync('unequal:currentSessionId')`（session_id），M6.2 新加 `getJwtToken()` 返 `wx.getStorageSync('unequal:jwt')`，被 `ask()` / `chat()` / `listSessions()` 用。

---

## 4. Files to Change

| File | Action | Why |
|---|---|---|
| `apps/api/src/lib/auth-jwt.ts` | CREATE | jose 签发 + 验签 + HttpError 映射 |
| `apps/api/src/lib/wx.ts` | CREATE | jscode2session fetchImpl 包装 + 错误码映射 |
| `apps/api/src/lib/user.ts` | CREATE | findOrCreateUser (D1) |
| `apps/api/src/lib/auth.ts` | UPDATE | verifyAuth jwt 分支替换 501 留口 |
| `apps/api/src/types.ts` | UPDATE | Env 加 WX_APP_ID / WX_APP_SECRET / JWT_SECRET |
| `apps/api/src/routes/auth.ts` | CREATE | /auth/wx-login + /auth/admin-login 2 endpoint |
| `apps/api/src/index.ts` | UPDATE | 挂 /auth/wx-login + /auth/admin-login |
| `apps/api/wrangler.jsonc` | UPDATE | vars 加 WX_APP_ID / WX_APP_SECRET 占位（dev mock） |
| `apps/api/src/routes/upload.ts` 等 6 个 | UPDATE | verifyAdminToken → verifyAuth（保留原有 AdminToken 容错） |
| `apps/api/test/lib/auth-jwt.test.ts` | CREATE | 4 用例：sign/verify 合法 / 过期 / 篡改 / 缺 userId |
| `apps/api/test/lib/wx.test.ts` | CREATE | 4 用例：happy / errcode / network / 缺 appId |
| `apps/api/test/lib/user.test.ts` | CREATE | 4 用例：find existing / create new / multiple users / isNew 标记 |
| `apps/api/test/lib/auth.test.ts` | UPDATE | 4 新用例：admin_token / jwt 合法 / jwt 缺 Bearer / jwt 篡改 |
| `apps/api/test/routes/auth.test.ts` | CREATE | 5 用例：/wx-login 200/400/401/502 + /admin-login 200/401 |
| `apps/api/test/routes/ask.test.ts` | UPDATE | verifyAuth 集成（已有 mock token 改 jwt token） |
| `apps/miniprogram/lib/auth.ts` | CREATE | ensureJwt + getJwtToken（wx.storage 持久化）|
| `apps/miniprogram/lib/api.ts` | UPDATE | ask/chat/listSessions 加 Authorization header via getJwtToken |
| `apps/miniprogram/lib/chat-storage.ts` | UPDATE | 加 jwt storage（不复用 session_id） |
| `apps/miniprogram/app.ts` | UPDATE | onLaunch 调 ensureJwt |
| `apps/miniprogram/test/auth.test.ts` | CREATE | 4 用例：冷启动 / 持久化 / 401 重 login / 续期（24h 过期模拟） |
| `apps/admin/src/lib/api.ts` | UPDATE | getToken() 走 jwt 模式（dev fallback 不变）；authedJson 不变 |
| `apps/admin/src/pages/LoginPage.tsx` | CREATE | 1 个 form（admin_token + submit） |
| `apps/admin/src/pages/LoginPage.test.tsx` | CREATE | 4 jsdom 用例：mount / 提交 / 错误 token / 成功 navigate |
| `apps/admin/src/App.tsx` | UPDATE | 加 /login 路由 + navigate guard（无 token → /login） |
| `apps/admin/src/pages/ChatSim.tsx` | UPDATE | onMount 时 check token 缺 → navigate("/login") |
| `docs/archive/state/state-m6-2.md` | CREATE | 收尾归档（仿 state-m6-1.md） |
| `README.md` | UPDATE | 加 M6.2 状态节 |
| `docs/wechat-miniprogram-setup.md` | UPDATE | 加 wx.login + /auth/wx-login 端到端联调段 |
| `packages/shared/src/chat-types.ts` | UPDATE | 加 AuthResponse / JwtPayload 类型（admin + miniprogram 共享） |

---

## 5. API Contract

### 5.1 POST /auth/wx-login

**Request**：
```json
{ "code": "081H1zGa1xxx..." }
```

**Response 200**：
```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "user_id": "01HXXXXXXXXXXXXXXXXXX",
  "is_new_user": true,
  "expires_in": 86400
}
```

**错误**：
- `400 MISSING_CODE` — body 缺 code
- `401 INVALID_CODE` — jscode2session errcode != 0（code 失效/伪造）
- `500 INFRA_MISSING` — env.WX_APP_ID / WX_APP_SECRET 缺
- `502 WX_API_ERROR` — jscode2session 网络错误

### 5.2 POST /auth/admin-login

**Request**：
```json
{ "admin_token": "test-token-please-change" }
```

**Response 200**：
```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "user_id": "01H0000000000000000000000",
  "is_admin": true,
  "expires_in": 86400
}
```

**错误**：
- `400 MISSING_TOKEN` — body 缺 admin_token
- `401 INVALID_ADMIN_TOKEN` — token 与 env.ADMIN_TOKEN 不匹配

### 5.3 现有 6 个路由的鉴权变化

`/upload` `/ingest` `/search` `/ask` `/chat` `/sessions` 全部：
- **M6.1**：内部 `verifyAdminToken(headers.get('Authorization'), env.ADMIN_TOKEN)`
- **M6.2**：改 `verifyAuth(request, env)`（按 AUTH_MODE 切）

客户端调用：
- M6.1：`Authorization: Bearer ${raw_admin_token}`
- M6.2：JWT 模式时 `Authorization: Bearer ${jwt}`（admin 和 miniprogram 都用）

`AUTH_MODE=admin_token` 时仍接受 raw admin token（dev 真验 + 真接 Cloudflare 前过渡）。

---

## 6. Data Model

**user 表（M0-M1 已有，M6.2 0 migration）**：
```sql
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  wx_openid TEXT UNIQUE,   -- 微信 openid，M6.2 wx.login 写入
  nickname TEXT,            -- M6.3+ 拿用户信息时写入
  created_at INTEGER NOT NULL
);
```

**MVP 阶段保留的 DEFAULT_ADMIN_USER_ID**：
```sql
-- apps/api/src/lib/auth.ts:65
export const DEFAULT_ADMIN_USER_ID = "01H0000000000000000000000";
-- migration 0002_dev_seed.sql 已经 INSERT 该 id 的 user row（admin 模式 dev 用）
```

**M6.2 不动 D1 schema**（仅 INSERT 新 user，user_id 由 ulid() 生成）。

---

## 7. Error Handling

| 错误码 | HTTP | 触发 | 调用方处理 |
|---|---|---|---|
| `MISSING_CODE` | 400 | /auth/wx-login body 缺 code | 客户端校验 |
| `INVALID_CODE` | 401 | jscode2session errcode | 重 wx.login 再试 |
| `WX_API_ERROR` | 502 | jscode2session 网络 | 1 次 retry 后 fallback |
| `INFRA_MISSING` | 500 | env 缺 WX_APP_ID | 部署修复 |
| `MISSING_TOKEN` | 400 | /auth/admin-login body 缺 admin_token | 客户端校验 |
| `INVALID_ADMIN_TOKEN` | 401 | admin_token 错 | 客户端重 input |
| `UNAUTHORIZED` | 401 | verifyAuth 失败（admin_token 模式） | 跳 /login |
| `MISSING_BEARER` | 401 | verifyAuth jwt 模式缺 Authorization header | 重 login |
| `INVALID_JWT_CLAIMS` | 401 | jwt 验签过但 payload 缺 userId/isAdmin | 服务端 bug 记录 |
| `JWT_EXPIRED` | 401 | jose.jwtVerify 抛 `JWTExpired`（spec §6.1） | 重 wx.login |
| `BAD_AUTH_MODE` | 400 | AUTH_MODE 既不是 admin_token 也不是 jwt | wrangler var 修复 |
| `SESSION_LIMIT_EXCEEDED` | 409 | /chat 时 active session > 50（M6.1 已有）| 不变 |
| `INTERNAL` | 500 | 其他未捕获 Error | 通用 500 |

**wx.login 5 分钟限制**：`code` 5 分钟内有效，nonce 重放需在 5 分钟内。M6.2 不防重放（不存 session_key 也就无法验证 nonce），M6.3+ 加 Redis-like nonce store 时再处理。

---

## 8. Mock-first 边界

**M6.2 阶段严禁**：
- ❌ 不真接 Cloudflare Workers / D1 / Durable Objects
- ❌ 不真接 jscode2session（任何真 AppID / AppSecret）
- ❌ 不接 wx.login 真机扫码
- ❌ 不实跑 admin dev 真连 /auth/* 端到端

**M6.2 允许**：
- ✅ jscode2session 走 fetchImpl 注入 mock Response
- ✅ jose 签发 / 验签真跑（HS256 同步算法无外部依赖）
- ✅ 小程序端走 fetchImpl + wxRequestAsFetch（已有兼容层）
- ✅ admin LoginPage jsdom 单测（mock authedJson）
- ✅ D1 user 表走 miniflare 真 binding（migration 0001 已含 user 表）

**真接 Cloudflare 路径**（CP-5 备查）：
```bash
cd apps/api
pnpm wrangler login
pnpm wrangler secret put ADMIN_TOKEN
pnpm wrangler secret put WX_APP_ID          # 微信小程序 AppID
pnpm wrangler secret put WX_APP_SECRET      # 微信小程序 AppSecret
pnpm wrangler secret put JWT_SECRET         # 32+ 字节随机字符串
# vars 改：
#   AUTH_MODE = "jwt"
#   WX_APP_ID = "wx..." (vars 即可，非敏感)
```

---

## 9. Testing Strategy

**估算 ~30 新增用例**：

| Package | Test file | 用例数 | 覆盖 |
|---|---|---|---|
| api/lib | auth-jwt.test.ts | 4 | sign/verify 合法 / 过期 / 篡改 / 缺 userId |
| api/lib | wx.test.ts | 4 | happy / errcode / network 502 / 缺 appId |
| api/lib | user.test.ts | 4 | find existing / create new / multi user / isNew 标记 |
| api/lib | auth.test.ts | +4 | admin_token / jwt 合法 / jwt 缺 Bearer / jwt 篡改 |
| api/route | auth.test.ts | 5 | /wx-login 200/400/401/502 + /admin-login 200/401 |
| miniprogram | auth.test.ts | 4 | 冷启动 / 持久化 / 401 重 login / 续期 |
| admin | LoginPage.test.tsx | 4 | mount / 提交 / 错误 token / 成功 navigate |
| **累计** | | **~29** | |

**集成测试**（CP-5 必做，M6.2 不实施）：
- admin 真连 /auth/admin-login 拿 jwt → 调 /chat 看鉴权通过
- 微信开发者工具真机扫码 → wx.login → /auth/wx-login → /chat → /sessions 端到端
- 推到 M6.2 真接 Cloudflare 后做（state-m6-2.md 标记）

---

## 10. ECC 组件

| 组件 | 用途 |
|---|---|
| `superpowers:brainstorming` | M6.2 spec 设计（3 决策 + 设计概要） |
| `superpowers:using-superpowers` | entry dispatcher |
| ECC `plan` | M6.2 实施 plan（仿 M6.1 15 task / 4 CP） |
| `subagent-driven-development` (ECC) | 1 task / subagent + heartbeat（避免 stall）|
| `using-git-worktrees` | `.claude/worktrees/m6-2-jwt-auth` |
| `verification-before-completion` | CP-1/2/3/4 验证 |
| `code-review` / `typescript-review` | Task 7/8/9 (auth-jwt / wx / user) 触发 |
| `frontend-design` | LoginPage UI（v1.1 简版，1 个 form，弱触发） |

未触发：`marketing-campaign` / `mcp-builder` / `cloudflare` / `durable-objects`（M6.2 无 DO 改动）。

---

## 11. Risks & Mitigations

| 风险 | Likelihood | Mitigation |
|---|---|---|
| JWT_SECRET 泄露 → 任意伪造用户 | LOW | wrangler secret 定期 rotate（季度）；不写代码；wrangler secret 历史不进 git |
| jscode2session 限频（5 万次/分钟/AppID） | LOW | M6.2 用户量小，< 1k req/min；超限时 5 分钟重试 |
| wx.login code 5 分钟过期 nonce 重放 | LOW | M6.2 不防重放（不存 session_key）；M6.3+ 加 nonce store |
| jose dep 体积（~50KB） | LOW | 1 个 lib 1 个 dep；admin 不直接 import jose（admin 走 jose 验签在后端） |
| admin 登录页不防爆破 | LOW | env.ADMIN_TOKEN 强密码（32+ 字节随机）足够；M6.3+ 加 rate limit |
| wx.login 失败阻断 app 启动 | LOW | app.ts onLaunch 失败不 throw（仅 console.warn），401 时 chat() retry |
| verifyAuth 重构破现有路由（M6.1 改过的 6 个） | MEDIUM | 路由层 verifyAdminToken → verifyAuth 是直接替换；CP-2 跑全 api test 验证 |
| 小程序 getJwtToken 改后旧 session 失效 | LOW | M6.1 getCurrentSessionId 不复用，复用 chat-storage 模式；旧用户清 storage 即可 |

---

## 12. Acceptance

- [ ] 3 决策落地：env var admin login / HS256 24h / 不存 session_key
- [ ] 13-15 task 全部 commit（m6-2-jwt-auth 分支）
- [ ] CP-1/2/3/4 全部 pass
- [ ] ~30 新增用例全绿（73 M0-M5 + 57 M6.1 + 30 M6.2 = 160）
- [ ] `pnpm -r typecheck` 全绿
- [ ] `pnpm -F admin build` + 微信开发者工具 build 成功
- [ ] admin dev 真验（可选）：`/login` 走完提交 → /chat-sim 调 /chat 通过
- [ ] 微信开发者工具真机（推到 M6.2 真接 Cloudflare 后）：wx.login → /auth/wx-login → /chat
- [ ] wrangler.jsonc 加 WX_APP_ID / JWT_SECRET 不破坏现有 `wrangler dev`
- [ ] M6.1 spec §7.1 三个切换点（verifyAuth / AUTH_MODE / getToken）全打通
- [ ] state-m6-2.md commit
- [ ] README 加 M6.2 状态节
- [ ] no `console.log` 留在生产代码
- [ ] 没有 hardcoded secrets（`wrangler secret` 走 .dev.vars 而非 commit）
- [ ] 合并 master 后 worktree 清理

---

## 13. M6.3+ 衔接（不实施，仅 spec 留接口）

- **M6.3**：session_key 存 D1 + /auth/session-key endpoint + wx.getUserInfo 解密拿 nickname/avatar
- **M6.3**：admin LoginPage rate limit（防爆破）
- **M6.4**：多租户 / 家长用户邀请 / 角色 RBAC
- **CP-5**：真接 Cloudflare（wrangler secret put WX_APP_ID / WX_APP_SECRET / JWT_SECRET / ADMIN_TOKEN + AUTH_MODE = "jwt"）

---

## 14. 实施流程（参考 M6.1 实际模式）

1. 建 worktree：`git worktree add .claude/worktrees/m6-2-jwt-auth -b m6-2-jwt-auth master`（已建）
2. 派 ~5 个 subagent 跑 Phase 1-4（每 subagent 1-2 task + heartbeat + 强制 commit）
3. CP-1/2/3/4 验证
4. merge to master (no-ff) + 清理 worktree + 删分支
5. 写 state-m6-2.md 收尾

预计 1-2 天工作量（按 M6.1 实际 1.5 天 13 task 估算）。
