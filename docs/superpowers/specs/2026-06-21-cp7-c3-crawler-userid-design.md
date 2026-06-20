# CP-7-C #3: crawler CLI schema 对齐 + user_id wire-up

**日期**：2026-06-21
**前置**：CP-7-C #2（commit `be61e1c`，ingest audit + user_id 收紧）
**目标包**：`apps/crawler`
**Tag**：`cp7-c3-crawler-userid`

---

## 1. Summary

让 `apps/crawler` CLI 真能跑通 `/api-ingest` handler，并支持通过 `--user-id` 把 chunks 绑给指定 wx user。

**根因**：crawler CLI 自 CP-6 起 schema 没跟上 — `buildIngestPayload` 还在用 M0+M1 payload（`{ source, document: { parsed_text }, chunks: [...] }`），但 `api-ingest` handler 已在 CP-6 时改成新 schema（`{ content, ... }`，自己 chunk + embed）。当前 `node crawler --url X` 必然 400 INVALID_REQUEST（api 找不到 `body.content`）。

**修复**：
1. `buildIngestPayload` → `buildIngestBody`，对齐 `api-ingest` 的 `IngestRequest`
2. `--user-id` → `body.user_id` 透传（CLI 缺省时省略字段，api 端 fallback `DEFAULT_USER_ID`）
3. Authorization header 互斥（proxy secret 有值 → 只发 `x-ingest-proxy-secret`；否则只发 `Authorization: Bearer`）
4. CLI fail-fast 三种错误组合（user-id 缺 proxy / proxy+token 互斥 / 都缺）
5. 删 chunks / raw_path / sourceId / documentId 相关代码（YAGNI — api 自己生成）
6. 5 旧测试重写 + ~13 新测试

---

## 2. Goals

- **G1**：`node apps/crawler/src/main.ts --url <URL> --ingest-proxy-secret <S> --user-id <U>` 端到端跑通 `/api-ingest`，chunks 绑给 U
- **G2**：`node apps/crawler/src/main.ts --url <URL> --token <T>` 端到端跑通，chunks 绑给 `DEFAULT_USER_ID`（admin 路径）
- **G3**：CLI fail-fast 三种错误组合（user-id 缺 proxy / proxy+token 互斥 / 都缺）
- **G4**：测试覆盖率 ≥80%（`buildIngestBody` + `submitToIngest` 边界全覆盖）

---

## 3. Non-Goals

- **N1**：不重构 source type 体系（`webpage`/`xiaohongshu`/`wechat-mp` 各自 fetchXxx 函数不动）
- **N2**：不改 `api-ingest` handler（CP-7-C #2 已完成）
- **N3**：不动 `scripts/crawl-and-ingest.ts` 临时脚本（CP-7-C #2 收尾已完成）
- **N4**：不做重试 / batch / 并发（crawler 是手动批处理脚本）
- **N5**：不做 `main.ts` 单元测试（IO-heavy，手工 AC 覆盖）

---

## 4. Patterns to Mirror

参考 CP-7-C #2 的 spec / impl 模式（`docs/superpowers/specs/2026-06-21-cp7-c-ingest-audit-design.md`）：

| Category | Source | Pattern |
|---|---|---|
| 命名 | `apps/crawler/src/types.ts:11` | `CrawledDocument` 大驼峰 interface |
| 命名 | `apps/crawler/src/ingest.ts:8` | `BuildPayloadOptions` 动词+名词+suffix |
| 错误返回 | `apps/crawler/src/ingest.ts:44` | discriminated union `{ ok: true; ... } \| { ok: false; status, error }` |
| 测试 mock | `apps/crawler/test/ingest.test.ts:34` | `fetchMock: typeof fetch = async (input, init) => ...` 捕获 init.headers |
| env fallback | `apps/crawler/src/main.ts:51` | `args.token ?? process.env.ADMIN_TOKEN` |
| fail-fast | `apps/crawler/src/main.ts:74` | `if (!token && !ingestProxySecret) { console.error(...); process.exit(1); }` |
| CP-7-C #2 auth 互斥 | `apps/api/src/handlers/api-ingest.ts:75` | proxy header 优先于 Authorization |

---

## 5. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ crawler CLI (main.ts)                                        │
│   --url <U> --ingest-proxy-secret <S> --user-id <X>         │
│   --trust 0-3 --no-ingest (optional)                        │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   │  buildIngestBody(doc, { trustLevel, userId? })
                   │  → { content, title, url, trust_level, user_id? }
                   │     (userId undefined → 字段省略)
                   │
                   │  submitToIngest(doc, {
                   │    ingestUrl, ingestProxySecret? | token?,
                   │    userId?, trustLevel, fetchImpl?
                   │  })
                   │  → headers: { x-ingest-proxy-secret }  (proxy 优先)
                   │           | { authorization: Bearer }  (admin)
                   │  (proxy + token 互斥；任一缺失 throw Error)
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ api-ingest handler (apps/api/src/handlers/api-ingest.ts)     │
│   CP-7-C #2 已实现                                          │
│                                                              │
│   proxy header 存在 → requireIngestProxy                     │
│   否则 → requireAdmin                                        │
│   body.user_id 存在 → 用作 targetUserId                      │
│   否则 → env.DEFAULT_USER_ID                                │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
   ingest 业务 (chunkText + embed + audit_log)
```

---

## 6. Files to Change

| File | Action | Why |
|---|---|---|
| `apps/crawler/src/types.ts` | UPDATE | `IngestPayload` → `IngestBody`（新 schema）|
| `apps/crawler/src/ingest.ts` | UPDATE | `buildIngestPayload` → `buildIngestBody`；`submitToIngest` 改 auth 互斥；删 chunks/raw_path 生成 |
| `apps/crawler/src/main.ts` | UPDATE | `userId` 改可选；`token` 改显式（不再 implicit env fallback）；3 个 fail-fast 校验 |
| `apps/crawler/test/ingest.test.ts` | UPDATE | 删 1 旧用例 + 改 2 旧用例 + 加 ~13 新用例 |
| `docs/superpowers/state-cp7-zhenjie.md` | UPDATE | §6 + §8 #3 标记完成（部署 AC 通过后）|

**不动**：
- `apps/api/*`（CP-7-C #2 已对齐）
- `apps/api/scripts/crawl-and-ingest.ts`（CP-7-C #2 临时脚本独立路径）
- `apps/crawler/src/sources/*`（fetchXxx 函数不动）
- `apps/crawler/src/parser.ts`（HTML 解析不动）

---

## 7. Detailed Changes

### 7.1 `apps/crawler/src/types.ts`

```typescript
/**
 * 调 /api-ingest 的 body（与 apps/api IngestRequest 对齐）。
 * - user_id 缺省时不写该字段；CLI 必须配 --ingest-proxy-secret 才能传 user_id
 * - 不嵌 chunks（api 端 chunkText 自己生成）
 */
export interface IngestBody {
  content: string;
  title?: string;
  url: string;
  trust_level: 0 | 1 | 2 | 3;
  user_id?: string;
}
```

**保留** `CrawledDocument` interface（不变）。

### 7.2 `apps/crawler/src/ingest.ts`

```typescript
export interface BuildBodyOptions {
  trustLevel: 0 | 1 | 2 | 3;
  /**
   * 缺省 undefined：CLI 不传 --user-id → 字段从 body 完全省略。
   * 传具体 user_id：CLI 传 --user-id <X> → body 含 user_id: X。
   * 注意：admin 路径禁止 user_id（CLI 层 fail-fast 拦截）。
   */
  userId?: string;
}

export function buildIngestBody(doc: CrawledDocument, opts: BuildBodyOptions): IngestBody {
  return {
    content: doc.paragraphs.join("\n\n"),
    title: doc.title || doc.url,
    url: doc.url,
    trust_level: opts.trustLevel,
    ...(opts.userId ? { user_id: opts.userId } : {}),
  };
}

export interface SubmitOptions {
  ingestUrl: string;
  /**
   * auth：proxy secret 与 token 互斥（CLI 层 enforce；submitToIngest 也防御性 throw）。
   * - ingestProxySecret 有值 → headers 含 x-ingest-proxy-secret（只发这一个）
   * - token 有值 → headers 含 authorization: Bearer（只发这一个）
   * - 两者都有/都无 → throw Error
   */
  ingestProxySecret?: string;
  token?: string;
  /** undefined → body 不含 user_id 字段 */
  userId?: string;
  trustLevel: 0 | 1 | 2 | 3;
  fetchImpl?: typeof fetch;
}

export type SubmitResult =
  | { ok: true; sourceId?: string; documentId?: string }
  | { ok: false; status: number; error: string };

export async function submitToIngest(
  doc: CrawledDocument,
  opts: SubmitOptions,
): Promise<SubmitResult> {
  const hasProxy = !!opts.ingestProxySecret;
  const hasToken = !!opts.token;
  if (hasProxy === hasToken) {
    // both true or both false
    throw new Error("submitToIngest: exactly one of ingestProxySecret/token must be provided");
  }

  const body = buildIngestBody(doc, { trustLevel: opts.trustLevel, userId: opts.userId });

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (hasProxy) {
    headers["x-ingest-proxy-secret"] = opts.ingestProxySecret!;
  } else {
    headers["authorization"] = `Bearer ${opts.token!}`;
  }

  const f = opts.fetchImpl ?? fetch;
  const res = await f(opts.ingestUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, status: res.status, error: errBody.error ?? `HTTP ${res.status}` };
  }

  const okBody = (await res.json()) as { ok?: boolean; sourceId?: string; documentId?: string };
  return { ok: true, sourceId: okBody.sourceId, documentId: okBody.documentId };
}
```

**删除**：`cryptoRandomHex()` helper（旧 sourceId/documentId 生成用，不再需要）。

### 7.3 `apps/crawler/src/main.ts`

```typescript
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url as string;
  const sourceType = (args["source-type"] as string) ?? "webpage";
  if (!["webpage", "xiaohongshu", "wechat-mp"].includes(sourceType)) {
    console.error(`[crawler] invalid --source-type: ${sourceType} (must be webpage|xiaohongshu|wechat-mp)`);
    process.exit(1);
  }
  if (!url) {
    console.error("Usage: --url <URL> [--source-type webpage|xiaohongshu|wechat-mp] [--ingest-url <URL>] [--token <T> | --ingest-proxy-secret <S>] [--user-id <U>] [--trust 0-3] [--no-ingest]");
    process.exit(1);
  }

  const ingestUrl = (args["ingest-url"] as string) ?? "http://localhost:8787/ingest";
  const ingestProxySecret = (args["ingest-proxy-secret"] as string) ?? process.env.INGEST_PROXY_SECRET;
  const token = (args.token as string) ?? process.env.ADMIN_TOKEN ?? "";
  const userIdArg = args["user-id"] as string | undefined;
  const trustLevel = parseInt((args.trust as string) ?? "2", 10) as 0 | 1 | 2 | 3;
  const noIngest = args["no-ingest"] === true;

  // fetch + parse 不变（line 56-72）
  let doc: CrawledDocument;
  // ... (省略 fetchXxx 分支)

  if (noIngest) {
    console.log("[crawler] --no-ingest set, skipping ingest");
    console.log(JSON.stringify(doc, null, 2));
    return;
  }

  // ─── CP-7-C #3: fail-fast 三种错误组合 ────────────────────
  if (ingestProxySecret && token) {
    console.error("[crawler] --token and --ingest-proxy-secret are mutually exclusive (pick one auth path)");
    process.exit(1);
  }
  if (!ingestProxySecret && !token) {
    console.error("[crawler] --token (ADMIN_TOKEN) or --ingest-proxy-secret / INGEST_PROXY_SECRET required for ingest (or pass --no-ingest)");
    process.exit(1);
  }
  if (userIdArg && !ingestProxySecret) {
    console.error("[crawler] --user-id requires --ingest-proxy-secret (admin path can only ingest to DEFAULT_USER_ID)");
    process.exit(1);
  }

  console.log(`[crawler] submit to ${ingestUrl} (auth: ${ingestProxySecret ? "ingest_proxy" : "admin_token"}${userIdArg ? `, target userId=${userIdArg}` : ""})`);
  const result = await submitToIngest(doc, {
    ingestUrl,
    ...(ingestProxySecret ? { ingestProxySecret } : { token }),
    userId: userIdArg,  // string | undefined 透传
    trustLevel,
  });

  if (result.ok) {
    console.log(`[crawler] ingest ok: sourceId=${result.sourceId ?? "?"} documentId=${result.documentId ?? "?"}`);
  } else {
    console.error(`[crawler] ingest failed: ${result.status} ${result.error}`);
    process.exit(1);
  }
}
```

### 7.4 `apps/crawler/test/ingest.test.ts`

**删除**：
- `describe("buildIngestPayload")` 整个 block（M0+M1 schema 已无意义）

**改写**：
- `200 + JSON → 返回 ok=true` → 改用新 schema body 断言（不含 source/document/chunks 嵌套）
- `传 ingestProxySecret → headers 含 x-ingest-proxy-secret + 仍含 authorization` → 改写为「只含 x-ingest-proxy-secret，**不**含 authorization」

**保留**：
- `401 (token invalid) → 返回 ok=false 含 status 401`
- `不传 ingestProxySecret → headers 仅 authorization 无 x-ingest-proxy-secret`

**新增** 13 个用例（见 §10）。

---

## 8. Data Flow

### 8.1 成功路径：proxy + user-id

```
CLI: --url <U> --ingest-proxy-secret <S> --user-id <X>
  ↓
buildIngestBody(doc, { trustLevel: 2, userId: "X" })
  → { content: "...", title: "...", url: "<U>", trust_level: 2, user_id: "X" }
  ↓
submitToIngest(doc, { ingestProxySecret: "<S>", userId: "X", ... })
  → headers: { "content-type": "application/json", "x-ingest-proxy-secret": "<S>" }
  → POST <ingestUrl>
  ↓
api-ingest:
  proxy header 存在 → requireIngestProxy OK
  body.user_id = "X" → targetUserId = "X"
  audit start → ingest 业务 → audit success
  → 200 { ok: true, source_id, document_id, chunks_inserted }
```

### 8.2 成功路径：admin + 无 user-id

```
CLI: --url <U> --token <T>
  ↓
buildIngestBody(doc, { trustLevel: 2 })  // userId undefined
  → { content, title, url, trust_level }  // 无 user_id 字段
  ↓
submitToIngest(doc, { token: "<T>", trustLevel: 2 })
  → headers: { "content-type": "application/json", "authorization": "Bearer <T>" }
  → POST <ingestUrl>
  ↓
api-ingest:
  无 proxy header → requireAdmin OK (token 验证)
  body.user_id 缺省 → targetUserId = env.DEFAULT_USER_ID
  → 200 { ok: true, ... }
```

### 8.3 失败路径：user-id 缺 proxy

```
CLI: --url <U> --token <T> --user-id <X>
  ↓ main.ts fail-fast 拦截
stderr: "[crawler] --user-id requires --ingest-proxy-secret (admin path can only ingest to DEFAULT_USER_ID)"
exit 1
```

### 8.4 失败路径：proxy + token 互斥

```
CLI: --url <U> --token <T> --ingest-proxy-secret <S>
  ↓ main.ts fail-fast 拦截
stderr: "[crawler] --token and --ingest-proxy-secret are mutually exclusive"
exit 1
```

---

## 9. Error Handling

### 9.1 CLI 层 fail-fast（main.ts）

| 情况 | stderr message | exit code |
|---|---|---|
| `--user-id X` 但无 `--ingest-proxy-secret` | `--user-id requires --ingest-proxy-secret (admin path can only ingest to DEFAULT_USER_ID)` | 1 |
| 同时传 `--token` 和 `--ingest-proxy-secret` | `--token and --ingest-proxy-secret are mutually exclusive (pick one auth path)` | 1 |
| 既无 `--token` 又无 `--ingest-proxy-secret` | `--token (ADMIN_TOKEN) or --ingest-proxy-secret / INGEST_PROXY_SECRET required for ingest (or pass --no-ingest)` | 1 |
| `--url` 缺省 | `Usage: ...` | 1 |
| `--source-type` 不合法 | `invalid --source-type: ...` | 1 |

### 9.2 submitToIngest 内部校验

```typescript
if (hasProxy === hasToken) {
  throw new Error("submitToIngest: exactly one of ingestProxySecret/token must be provided");
}
```

抛 Error 是 programming error 信号 — CLI 层应该已拦截，submitToIngest 这里是防御性 throw。

### 9.3 HTTP 错误响应

```typescript
export type SubmitResult =
  | { ok: true; sourceId?: string; documentId?: string }
  | { ok: false; status: number; error: string };
```

| api 端状态码 | CLI 行为 |
|---|---|
| 200 | stdout 打印「ingest ok: sourceId=X documentId=Y」|
| 401 | stderr 「401 <error>」，exit 1；提示检查 token/secret |
| 403 | stderr 「403 <error>」，exit 1；提示检查 IP allowlist / scope |
| 400 | stderr 「400 <error>」，exit 1；提示检查 payload schema（开发期 bug）|
| 500 | stderr 「500 <error>」，exit 1；提示查 audit_log |

**不重试**：crawler 是手动批处理；重试语义模糊。

### 9.4 fetch 网络错误

`submitToIngest` 不 catch fetch 抛出的网络错误（DNS / TCP / timeout）。CLI 顶层 `main().catch(err => ...)` 已捕获 → stderr → exit 1。

---

## 10. Testing Strategy

### 10.1 旧测试处理（5 用例 → 1 删 2 改 2 保）

| 旧测试 | 处理 |
|---|---|
| `CrawledDocument → IngestPayload (source.type='webpage' + document + chunks)` | **删除** |
| `200 + JSON → 返回 ok=true` | **重写**（新 schema body 断言）|
| `401 (token invalid) → 返回 ok=false 含 status 401` | 保留 |
| `传 ingestProxySecret → headers 含 x-ingest-proxy-secret + 仍含 authorization` | **改写**（只含 proxy，不含 authorization）|
| `不传 ingestProxySecret → headers 仅 authorization 无 x-ingest-proxy-secret` | 保留 |

### 10.2 新测试矩阵 — buildIngestBody（7 用例）

| 用例 | 断言 |
|---|---|
| 基础：trustLevel=2，无 userId | body 含 content/title/url/trust_level，**无** user_id |
| userId undefined | body 完全不含 user_id 字段 |
| userId 空字符串 | body 不含 user_id（trim 后省略）|
| userId 传具体值 | body 含 `user_id: 'X'` |
| 段落拼接 | content = `paragraphs.join("\n\n")` |
| title 缺省 fallback 到 url | title = `doc.url` |
| trustLevel 透传 | trust_level = opts.trustLevel |

### 10.3 新测试矩阵 — submitToIngest（6 用例）

| 用例 | 断言 |
|---|---|
| proxy + userId 组合 | headers 仅 x-ingest-proxy-secret；body 含 user_id；200 → ok |
| token + 无 userId | headers 仅 authorization；body 不含 user_id；200 → ok |
| proxy + token 都有 | throw Error（"exactly one of..."）|
| proxy + token 都无 | throw Error（"exactly one of..."）|
| 401 HTTP 错误 | ok=false 含 status 401 + error message |
| 403 HTTP 错误 | ok=false 含 status 403 + error message |

### 10.4 累计测试数

- crawler: 19 → ~26（净 +7；删 1 改 2 加 13）

### 10.5 不做的测试

- main.ts 单元测试（IO-heavy；手工 AC 覆盖）
- sources/* 单元测试（M4 已覆盖，不动）

---

## 11. Acceptance Criteria

### AC-1 unit tests pass
```bash
pnpm -F crawler test
```
预期：所有用例 PASS；crawler test count ≥ 26

### AC-2 typecheck pass
```bash
pnpm -F crawler typecheck
```
预期：无 error

### AC-3 CLI proxy + user-id 端到端（手工 AC）
```bash
node apps/crawler/src/main.ts \
  --url <article URL> --ingest-proxy-secret <S> --user-id <U> --trust 2
```
（也可通过 `INGEST_PROXY_SECRET=<S>` env 替代 `--ingest-proxy-secret <S>` flag，arg 优先 env。）
预期：
- stdout `ingest ok: sourceId=... documentId=...`
- CloudBase `audit_log` collection：1 条 success entry（`actor.via=ingest_proxy`，`target.userId=<U>`）
- CloudBase `document` collection：`userId=<U>` 字段新文档
- CloudBase `chunk` collection：`userId=<U>` 字段 N 条新记录

### AC-4 CLI token + 无 user-id 端到端（手工 AC）
```bash
ADMIN_TOKEN=<T> node apps/crawler/src/main.ts \
  --url <URL> --token <T> --trust 2
```
预期：
- stdout `ingest ok: ...`
- CloudBase `document`/`chunk` collection：`userId=DEFAULT_USER_ID`

### AC-5 CLI fail-fast：user-id 缺 proxy（手工 AC）
```bash
node apps/crawler/src/main.ts --url <URL> --token <T> --user-id <U>
```
预期：stderr 含 `--user-id requires --ingest-proxy-secret`；exit 1

### AC-6 CLI fail-fast：proxy + token 互斥（手工 AC）
```bash
node apps/crawler/src/main.ts --url <URL> --token <T> --ingest-proxy-secret <S>
```
预期：stderr 含 `mutually exclusive`；exit 1

### AC-7 CLI fail-fast：两者都缺（手工 AC，已存在逻辑）
```bash
node apps/crawler/src/main.ts --url <URL>
```
预期：stderr 含 `required for ingest`；exit 1

### AC-8 CloudBase 数据隔离验证
```bash
# AC-3 后用 <U> 的 wx user 登录小程序，问 AC-3 ingest 的文章相关问题
# 预期：能看到 [N] 引用
# AC-4 ingest 的文章应该对 <U> 不可见（不同 user scope）
```

---

## 12. Deployment

**无新 env var**：`INGEST_PROXY_SECRET` 已 CP-7-C #2 部署到 CloudBase env `unequal-d4ggf7rwg82e0900b`（admin function）。

**部署步骤**：
1. 合并 feature branch 到 master
2. 无需 `tcb fn deploy`（crawler 是 CLI 工具，不部署到 CloudBase）
3. 部署完成验证 = AC-3 / AC-4 / AC-5 / AC-6 / AC-7 / AC-8

**清理**：crawler 是本地 CLI，无 deploy artifact 需要清理。

---

## 13. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `scripts/crawl-and-ingest.ts` 临时脚本与新 crawler CLI 行为差异 | LOW | 临时脚本已走新 schema（CP-7-C #2 收尾）；不动它 |
| main.ts 删 token implicit env fallback 破坏老用户 | LOW | 仍支持 `--token` 参数 + `ADMIN_TOKEN` env（保留 env fallback）；只是 CLI 不再"无 token 时 silent 用空字符串" |
| api-ingest handler 缺 user_id 字段时仍正确 fallback DEFAULT_USER_ID | LOW | 已 CP-7-C #2 AC 验证；本 spec 仅复用 |
| Authorization header 互斥后，proxy+token 同时传被 CLI 拦截前是否有人依赖双发 | LOW | 旧逻辑双发是 dirty（api 优先看 proxy 即可），无合理依赖 |

---

## 14. Out of Scope (后续候选)

- crawler CLI 加 `--source-type` 选项（已 M5 task 加，保留）
- 重试 / 批量 ingest（YAGNI）
- 进度条 / 详细 log（YAGNI）
- crawler 改支持 OAuth2 / JWT 登录（admin 路径禁止 user_id 已通过 INGEST_PROXY_SECRET 解耦）

---

## 15. References

- **state-cp7-zhenjie.md §8 #3**：本 spec 任务来源
- **CP-7-C #2 spec**：`docs/superpowers/specs/2026-06-21-cp7-c-ingest-audit-design.md`
- **CP-7-C #2 impl**：commit `be61e1c`
- **api-ingest handler**：`apps/api/src/handlers/api-ingest.ts`
- **CP-6 ingest handler schema 改动**：commit `3c634f4`（M0+M1 → 新 schema）

---

## Appendix A: 完整新测试代码预览

```typescript
// apps/crawler/test/ingest.test.ts

import { describe, it, expect } from "vitest";
import { buildIngestBody, submitToIngest } from "../src/ingest.js";
import type { CrawledDocument } from "../src/types.js";

const sample: CrawledDocument = {
  url: "https://example.com/article",
  title: "婴儿发烧 38.5℃ 的家庭处理",
  paragraphs: [
    "婴儿发烧时先观察精神状态比体温数字更重要。",
    "对乙酰氨基酚（泰诺林）是 3 个月以上婴儿首选退烧药。",
  ],
  totalChars: 60,
  fetchedAt: 1718400000000,
};

describe("buildIngestBody", () => {
  it("基础: 无 userId → body 不含 user_id 字段", () => {
    const b = buildIngestBody(sample, { trustLevel: 2 });
    expect(b.content).toContain("婴儿发烧时先观察精神状态");
    expect(b.title).toBe("婴儿发烧 38.5℃ 的家庭处理");
    expect(b.url).toBe("https://example.com/article");
    expect(b.trust_level).toBe(2);
    expect("user_id" in b).toBe(false);
  });

  it("userId undefined → 字段省略", () => {
    const b = buildIngestBody(sample, { trustLevel: 2 });
    expect(b.user_id).toBeUndefined();
  });

  it("userId 空字符串 → 字段省略 (trim 后)", () => {
    const b = buildIngestBody(sample, { trustLevel: 2, userId: "" });
    expect("user_id" in b).toBe(false);
  });

  it("userId 传具体值 → body 含 user_id: X", () => {
    const b = buildIngestBody(sample, { trustLevel: 2, userId: "01KVCZ..." });
    expect(b.user_id).toBe("01KVCZ...");
  });

  it("段落拼接 → content = paragraphs.join('\\n\\n')", () => {
    const b = buildIngestBody(sample, { trustLevel: 2 });
    expect(b.content).toBe(sample.paragraphs.join("\n\n"));
  });

  it("title 缺省 → fallback 到 url", () => {
    const noTitle: CrawledDocument = { ...sample, title: "" };
    const b = buildIngestBody(noTitle, { trustLevel: 2 });
    expect(b.title).toBe(sample.url);
  });

  it("trustLevel 透传", () => {
    const b0 = buildIngestBody(sample, { trustLevel: 0 });
    const b3 = buildIngestBody(sample, { trustLevel: 3 });
    expect(b0.trust_level).toBe(0);
    expect(b3.trust_level).toBe(3);
  });
});

describe("submitToIngest", () => {
  it("proxy + userId → headers 仅 x-ingest-proxy-secret, body 含 user_id, 200 → ok", async () => {
    let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
    const fetchMock: typeof fetch = async (input, init) => {
      captured = {
        url: typeof input === "string" ? input : input.toString(),
        headers: init?.headers as Record<string, string>,
        body: init?.body as string,
      };
      return new Response(JSON.stringify({ ok: true, sourceId: "01H", documentId: "01H" }), { status: 200 });
    };
    const r = await submitToIngest(sample, {
      ingestUrl: "http://localhost:8787/ingest",
      ingestProxySecret: "secret-1",
      userId: "u-1",
      trustLevel: 2,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
    expect(captured!.headers["x-ingest-proxy-secret"]).toBe("secret-1");
    expect(captured!.headers["authorization"]).toBeUndefined();
    const parsedBody = JSON.parse(captured!.body);
    expect(parsedBody.user_id).toBe("u-1");
  });

  it("token + 无 userId → headers 仅 authorization, body 不含 user_id, 200 → ok", async () => {
    let captured: { headers: Record<string, string>; body: string } | undefined;
    const fetchMock: typeof fetch = async (_input, init) => {
      captured = {
        headers: init?.headers as Record<string, string>,
        body: init?.body as string,
      };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const r = await submitToIngest(sample, {
      ingestUrl: "http://localhost:8787/ingest",
      token: "admin-tok",
      trustLevel: 2,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
    expect(captured!.headers["authorization"]).toBe("Bearer admin-tok");
    expect(captured!.headers["x-ingest-proxy-secret"]).toBeUndefined();
    const parsedBody = JSON.parse(captured!.body);
    expect("user_id" in parsedBody).toBe(false);
  });

  it("proxy + token 都有 → throw Error", async () => {
    await expect(submitToIngest(sample, {
      ingestUrl: "x", ingestProxySecret: "s", token: "t", trustLevel: 2,
    })).rejects.toThrow("exactly one of ingestProxySecret/token");
  });

  it("proxy + token 都无 → throw Error", async () => {
    await expect(submitToIngest(sample, {
      ingestUrl: "x", trustLevel: 2,
    })).rejects.toThrow("exactly one of ingestProxySecret/token");
  });

  it("401 HTTP → ok=false 含 status 401 + error", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
    const r = await submitToIngest(sample, {
      ingestUrl: "http://x", token: "bad", trustLevel: 2, fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.error).toContain("Invalid token");
    }
  });

  it("403 HTTP → ok=false 含 status 403 + error", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "IP_NOT_ALLOWED" }), { status: 403 });
    const r = await submitToIngest(sample, {
      ingestUrl: "http://x", token: "ok", trustLevel: 2, fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toContain("IP_NOT_ALLOWED");
    }
  });
});
```