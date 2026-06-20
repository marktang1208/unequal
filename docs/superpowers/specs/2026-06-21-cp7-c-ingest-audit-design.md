# CP-7-C #2 — ingest handler audit log + user_id 收紧

**版本**：2026-06-21
**前置**：CP-7 真接已归档（tag `cp7-zhenjie-archived`）；CP-7-C #1 debug handlers 已清（commit `fcc3693`）
**范围**：apps/api + apps/crawler 两包；admin / mini / shared 不动

> **不是新功能 spec** — 是 CP-7-B round 9 加 `user_id` 参数时（commit `eae1b14`）引入的「任意 admin 可给任意 user 灌数据」风险的收口。

---

## 1. Requirements

| # | 现状 | 目标 |
|---|---|---|
| R-1 | `api-ingest` 用 `requireAdmin()` 验 Bearer token + IP allowlist，但 admin 路径可指定任意 `user_id` 把 chunks 灌给任意 wx user | 加 `X-Ingest-Proxy-Secret` header 作为「指定 user_id 的合法凭证」；admin 路径指定 user_id → 403 |
| R-2 | ingest handler 没有任何事后审计；调成功 / 失败 / 灌给了哪个 user 全无记录 | 加 `audit_log` CloudBase collection + stdout 日志；actor / target / request / result / requestId 五要素 |
| R-3 | `crawl-and-ingest.ts` 临时脚本（CP-7 真接 prep）走 ADMIN_TOKEN 路径 + 传 user_id | 改走 `X-Ingest-Proxy-Secret` 路径 |
| R-4 | `apps/crawler` CLI 无 ingest 鉴权概念，靠调用方传 `--token` 用 ADMIN_TOKEN（能指定 user_id） | 加 `--ingest-proxy-secret` flag / `INGEST_PROXY_SECRET` env；优先用 proxy，未配则退化到 ADMIN_TOKEN（仅 `user_id` 缺省时可用）|
| R-5 | 完全没有 audit log 概念（grep `audit` 全仓 0 命中）| 新建 `apps/api/src/lib/audit.ts` helper；CloudBase 新 collection `audit_log` |

**YAGNI 精简**（spec 显式不做）：
- ❌ 不做 ingest rate limit（M6.3a 风格）— 攻击面已通过鉴权收紧 + audit 拦截，rate limit 留作 CP-7-C #5
- ❌ 不做 audit_log 自动清理（M6.5+ cron cleanup 已留口，后续独立项目）
- ❌ 不做 ingest_delete / admin_login 其它 action 的 audit（仅 `ingest`，YAGNI）
- ❌ 不改 admin JWT scope 字段（仍是 string `"admin"`，不走 sub-scope 数组；后续真要 sub-scope 独立 spec）
- ❌ 不做 IP-based admin allowlist 收紧（已有，复用 `ADMIN_IP_ALLOWLIST`）

---

## 2. Patterns to Mirror

| 类别 | 来源 | 复用方式 |
|---|---|---|
| Admin 鉴权两层 | `apps/api/src/lib/auth-admin.ts` `requireAdmin()` — Bearer + IP allowlist | `requireIngestProxy()` 同模式：验 `X-Ingest-Proxy-Secret` + IP allowlist |
| 失败标识指纹 | `apps/api/src/lib/rate-limit.ts`（M6.3a）`sha256(token).slice(0, 16)` 不存明文 | audit actor.tokenFingerprint 同算法（不存明文）|
| Secret 读取 | `apps/api/src/lib/env.ts` `MINIMAX_API_KEY` 等 string env | `INGEST_PROXY_SECRET` 同模式读取；可空（dev 不配 = proxy 路径 401）|
| CloudBase collection 注册 | `apps/api/src/lib/collections.ts` `COLLECTIONS.source / document / chunk / ...` | 加 `COLLECTIONS.auditLog: "audit_log"` |
| 临时脚本 HTTP 调用 | `apps/api/scripts/crawl-and-ingest.ts` fetch + `Authorization: Bearer $ADMIN_TOKEN` | 同脚本改 fetch + `X-Ingest-Proxy-Secret: $INGEST_PROXY_SECRET` |
| Crawler CLI 鉴权 | `apps/crawler/src/main.ts` `--token` flag / `TOKEN` env（ADMIN_TOKEN） | 加 `--ingest-proxy-secret` flag / `INGEST_PROXY_SECRET` env（与 `submitToIngest` opts 对齐）|
| Mock-first test 桩注入 | `packages/shared/src/embedding.ts` `__setEmbeddingImpl` | audit.recordAudit 加 `__setAuditImpl(mockFn)` 注入（测试不写真 CloudBase）|

---

## 3. Architecture Overview

```
─── 入口层（apps/api/src/handlers/api-ingest.ts）──────────────────
POST /api-ingest { content, title, trust_level, user_id? }:
  1. OPTIONS? → 预检通过
  2. 鉴权分支:
       has X-Ingest-Proxy-Secret  → requireIngestProxy(event, env)
       has Authorization: Bearer  → requireAdmin(event, env)        // 现有
       无任一                      → 401 AUTH_FAILED
  3. user_id 行为分支:
       admin 鉴权 + body.user_id   → 403 INSUFFICIENT_SCOPE
       proxy 鉴权 + body.user_id   → targetUserId = body.user_id
       任一鉴权 + user_id 缺省     → targetUserId = env.DEFAULT_USER_ID
  4. recordAudit(stage="start") → 失败 → 500 AUDIT_FAILED           // 先 audit 再 ingest
  5. ingest 业务（source / document / chunks 写入）
       失败 → recordAudit(stage="end", result="failure") → 返 500
  6. recordAudit(stage="end", result="success", sourceId, documentId, chunksInserted)
       → 返 200

─── 鉴权 helper（apps/api/src/lib/auth-admin.ts）────────────────
新增 requireIngestProxy(event, env) → IngestProxyCheckResult:
  - 读 header["x-ingest-proxy-secret"]
  - 空 → { ok: false, response: 401 AUTH_FAILED }
  - 与 env.INGEST_PROXY_SECRET 不匹配 → { ok: false, response: 401 INVALID_PROXY }
  - 复用 IP allowlist 检查（与 requireAdmin 同逻辑）
  - 通过 → { ok: true, via: "ingest_proxy" }

─── audit helper（apps/api/src/lib/audit.ts，NEW）────────────────
recordAudit(env, entry: AuditEntry) → Promise<void>:
  - entry 校验（action / actor.via / target.userId / requestId 必填）
  - 持久化：add(COLLECTIONS.auditLog, { ...entry, id: ulid(), timestamp: Date.now() })
  - 日志：console.log(JSON.stringify({ level: "info", msg: "audit", ...entry }))
  - 任一失败 → throw（ingest handler 捕获 → 500 AUDIT_FAILED）
  - 测试桩：__setAuditImpl(mockFn) 注入（不入 CloudBase，只 mock fn）

─── env 扩展（apps/api/src/lib/env.ts）────────────────────────
新增 INGEST_PROXY_SECRET: string | undefined:
  - 从 process.env 读
  - 未设 → undefined；proxy 路径自动 401（dev mode 退化为 admin 路径）
  - 不做 dev sentinel（不像 ADMIN_TOKEN 给 test-token-please-change）— dev 可不配

─── collection 注册（apps/api/src/lib/collections.ts）───────────
新增 export const auditLog: CollectionName = "audit_log";

─── crawler CLI 扩展（apps/crawler/src/main.ts + ingest.ts）─────
CLI argv:
  + --ingest-proxy-secret <SECRET>     (优先)
  + INGEST_PROXY_SECRET env            (回退)
  + 缺省 → 不传 X-Ingest-Proxy-Secret header（caller 走 admin 路径）
submitToIngest opts:
  + ingestProxySecret?: string        (build payload 时加 header)
```

**关键设计原则**：
- ✅ audit 是合规硬约束：先 audit 再 ingest，audit 失败 → ingest 500（不留盲点）
- ✅ INGEST_PROXY_SECRET 与 ADMIN_TOKEN 完全解耦：泄露 INGEST_PROXY_SECRET 不影响 ADMIN_TOKEN 路径（admin 仍只能 user_id=DEFAULT_USER_ID）
- ✅ dev 兼容：`INGEST_PROXY_SECRET` 不配 → proxy 路径 401，admin 路径仍能用 `user_id=DEFAULT_USER_ID`
- ✅ 测试桩 `__setAuditImpl`：测试不写真 CloudBase，0 网络
- ❌ 不做 sub-scope JWT：避免重新签发所有 admin JWT
- ❌ 不做 audit_log 自动清理：M6.5+ cron 留口

---

## 4. Files to Change

### 新建（3 个）

| 文件 | 内容 | 行数估 |
|---|---|---|
| `apps/api/src/lib/audit.ts` | `AuditEntry` 类型 + `recordAudit()` helper + `__setAuditImpl` 桩 | ~120 行 |
| `apps/api/test/lib/audit.test.ts` | recordAudit 单元测试（mock impl 验证 5 字段 + 失败 throw）| ~80 行 |
| `apps/api/scripts/seed-audit-log-collection.ts` | （可选）脚本：本地 seed `audit_log` collection schema（生产由 `pnpm deploy:collections` 自动创建）| ~30 行 |

### 修改（9 个）

| 文件 | 改动 | 行数估 |
|---|---|---|
| `apps/api/src/lib/auth-admin.ts` | + `requireIngestProxy()` 函数（~30 行）；不动现有 `requireAdmin` | +30 |
| `apps/api/src/lib/env.ts` | + `INGEST_PROXY_SECRET` 字段读取 | +5 |
| `apps/api/src/lib/collections.ts` | + `auditLog` 集合名 | +1 |
| `apps/api/src/handlers/api-ingest.ts` | 鉴权分支 + user_id 行为分支 + audit 调用（重构 main）| +60 / -10 |
| `apps/api/src/handlers/api-debug-*.ts` | ❌ 不动（CP-7-C #1 已删）| — |
| `apps/api/test/handlers/api-ingest.test.ts` | 新增 ~17 用例：proxy/admin 鉴权 × user_id 指定/缺省 × 失败路径 | +200 |
| `apps/api/scripts/crawl-and-ingest.ts` | + `X-Ingest-Proxy-Secret: $INGEST_PROXY_SECRET` header | +5 |
| `apps/crawler/src/main.ts` | + `--ingest-proxy-secret` argv 解析 + env 回退 + 传给 `submitToIngest` | +15 |
| `apps/crawler/src/ingest.ts` | + `ingestProxySecret` 在 `SubmitIngestOptions` + build fetch headers | +8 |
| `apps/crawler/src/types.ts` | `SubmitIngestOptions` 加 `ingestProxySecret?: string` | +1 |
| `apps/crawler/test/ingest.test.ts` | + 传/不传 `ingestProxySecret` header 序列化 2 用例 | +25 |
| `apps/api/scripts/deploy-collections.ts` | + `auditLog` collection 注册（与现有 9 collection 同样 schema）| +10 |

### 文档（2 个）

| 文件 | 改动 |
|---|---|
| `docs/superpowers/specs/2026-06-21-cp7-c-ingest-audit-design.md` | NEW（本文）|
| `docs/superpowers/state-cp7-zhenjie.md` | §8 #2 标完成 + 引用 commit hash |

---

## 5. 数据流

### 5.1 成功 ingest（proxy 路径 + 指定 user_id）

```
client (crawler CLI)
  ↓ POST /api-ingest
  ↓ Headers:
  ↓   X-Ingest-Proxy-Secret: <INGEST_PROXY_SECRET>
  ↓ Body: { content, title: "宝宝断奶", trust_level: 2, user_id: "01KV..." }
api-router index.ts (main)
  ↓ log request.start (method=POST, path=/api-ingest, clientIp)
api-ingest main()
  ├─ requireIngestProxy()
  │   ├─ header["x-ingest-proxy-secret"] == env.INGEST_PROXY_SECRET ✅
  │   ├─ IP allowlist check ✅
  │   └─ return { ok: true, via: "ingest_proxy" }
  ├─ user_id 行为分支: proxy + body.user_id → targetUserId = "01KV..."
  ├─ recordAudit(stage="start", actor.via="ingest_proxy", actor.clientIp, actor.tokenFingerprint, target.userId="01KV...", request.contentLen, request.trustLevel=2, request.title="宝宝断奶", result="in_progress")
  │   ├─ CloudBase add(auditLog, entry) → 入库
  │   └─ stdout JSON: { level: "info", msg: "audit", ... }
  ├─ ingest 业务:
  │   ├─ add(source) → sourceId
  │   ├─ add(document) → docId
  │   ├─ chunkText(content) → chunks[]
  │   ├─ embed.embed(texts) → embeddings[]
  │   └─ for each chunk: add(chunk) → inserted++
  ├─ recordAudit(stage="end", result="success", target.sourceId, target.documentId, target.chunksInserted)
  └─ return 200 { source_id, document_id, chunks_inserted, ... }
```

### 5.2 失败 ingest（admin 路径 + 指定 user_id）

```
client (admin tool)
  ↓ POST /api-ingest
  ↓ Headers: Authorization: Bearer <ADMIN_TOKEN>
  ↓ Body: { content, ..., user_id: "01KV..." }
api-ingest main()
  ├─ requireAdmin() ✅
  ├─ user_id 行为分支: admin + body.user_id → 403 INSUFFICIENT_SCOPE
  └─ return 403 { error: "INSUFFICIENT_SCOPE", message: "user_id requires X-Ingest-Proxy-Secret; admin path can only ingest to DEFAULT_USER_ID" }
（不走 audit — 拒绝比审计快）
```

### 5.3 audit 写失败

```
api-ingest main()
  ├─ 鉴权 ✅
  ├─ user_id 行为 ✅
  ├─ recordAudit(stage="start") → CloudBase add throws
  └─ return 500 { error: "AUDIT_FAILED", message: "audit log write failed: ..." }
（先 audit 再 ingest — 失败即拒绝，不进入业务）
```

---

## 6. 错误处理

| 错误码 | HTTP | 触发条件 | 客户端处理 |
|---|---|---|---|
| `AUTH_FAILED` | 401 | 无 Authorization 头且无 X-Ingest-Proxy-Secret 头 | 重试（带凭证）|
| `INVALID_PROXY` | 401 | `X-Ingest-Proxy-Secret` 不匹配 `env.INGEST_PROXY_SECRET` | 检查 proxy secret 配置 |
| `IP_NOT_ALLOWED` | 403 | IP 不在 `ADMIN_IP_ALLOWLIST`（proxy + admin 共用）| 换网络 / 加白名单 |
| `INSUFFICIENT_SCOPE` | 403 | admin 鉴权 + body.user_id 指定 | 改走 `X-Ingest-Proxy-Secret` 路径 |
| `INVALID_REQUEST` | 400 | 缺 `content` / content 非 string / 其他字段错 | 修请求体 |
| `EMBEDDING_FAILED` | 500 | MiniMax embedding API 失败 | 重试（指数退避）|
| `AUDIT_FAILED` | 500 | audit_log CloudBase add 失败 | 重试 + 监控告警 |
| `INTERNAL_ERROR` | 500 | source 创建失败 / 其它业务异常 | 查 CloudBase logs |

**错误码不变项**：`INVALID_REQUEST` / `EMBEDDING_FAILED` / `INTERNAL_ERROR` 沿用现有。

---

## 7. 测试策略

### 7.1 单元测试（apps/api/test/lib/）

| 文件 | 新增用例 |
|---|---|
| `auth-admin.test.ts` | + 6：proxy 正确值通过、proxy 错值 401、proxy 缺 header 走 admin、proxy + IP 不在白名单 403、proxy + `INGEST_PROXY_SECRET` 未配置 401、proxy 与 admin 同 IP 检查复用 |
| `audit.test.ts`（NEW）| 8：recordAudit 5 字段校验、CloudBase 写失败 throw、stdout 日志格式、`__setAuditImpl` 注入、`AuditEntry` 类型必填字段、timestamp / id 自动填 |

### 7.2 集成测试（apps/api/test/handlers/api-ingest.test.ts）

现有 ~6 用例保持，新增 ~17 用例：

| # | 鉴权 | user_id | 期望 |
|---|---|---|---|
| 1 | admin_token | 指定 | 403 INSUFFICIENT_SCOPE |
| 2 | admin_jwt | 指定 | 403 INSUFFICIENT_SCOPE |
| 3 | proxy | 指定 | 200 + target.userId = body.user_id |
| 4 | proxy 错值 | 任意 | 401 INVALID_PROXY |
| 5 | proxy 缺 header | 任意 | 401 AUTH_FAILED（fall through admin? 验证：caller 必须显式选） |
| 6 | admin_token | 缺省 | 200 + target.userId = DEFAULT_USER_ID（回归）|
| 7 | proxy | 缺省 | 200 + target.userId = DEFAULT_USER_ID |
| 8 | admin_token | user_id = "" | 403（空字符串视为指定）|
| 9 | 无 Authorization + 无 proxy | 任意 | 401 AUTH_FAILED |
| 10 | OPTIONS | — | 200 预检通过 |
| 11 | proxy + IP 不在白名单 | 任意 | 403 IP_NOT_ALLOWED |
| 12 | audit 写失败 | 任意 | 500 AUDIT_FAILED（不进 ingest 业务）|
| 13 | ingest 业务失败（embed 错）| proxy + user_id | 200? 实际：先 audit start，再 ingest fail，再 audit end(failure)；返 500 EMBEDDING_FAILED；audit 已记 2 条 |
| 14-17 | （保留 4 个现有测试）| — | 回归 |

**测试桩**：
- `__setAuditImpl` 注入 mock fn → 验证 recordAudit 被调 + 参数正确，不写真 CloudBase
- `__setEmbeddingImpl`（已有）→ 注入 mock embedding 避免真 MiniMax 调用

### 7.3 crawler 测试（apps/crawler/test/ingest.test.ts）

+ 2 用例：`buildIngestPayload` 含/不含 `ingestProxySecret` 时 header 序列化正确。

### 7.4 累计目标

- `pnpm -F api test` — 63 → ~86（+23：6 auth + 8 audit + 9 ingest net new）
- `pnpm -F crawler test` — 19 → 21（+2）
- `pnpm -r typecheck` — 5 包全绿（不动 shared / minipgm / admin）

---

## 8. Acceptance Criteria

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-1 | `audit_log` CloudBase collection 部署成功 | `pnpm -F api deploy:collections` 后 CloudBase 控制台可见 |
| AC-2 | `INGEST_PROXY_SECRET` 注入 CloudBase secret vault | `tcb secrets list -e unequal-d4ggf7rwg82e0900b` 含此 secret |
| AC-3 | proxy 路径 + user_id 指定 → 200 + audit 记录 | 真接后调 `curl -H "X-Ingest-Proxy-Secret: $SECRET" -d '{"user_id":"..."}' /api-ingest`；CloudBase `audit_log` 表见对应行 |
| AC-4 | admin 路径 + user_id 指定 → 403 | 同上但不带 X-Ingest-Proxy-Secret，带 `Authorization: Bearer $ADMIN_TOKEN` + user_id → 403 |
| AC-5 | audit 写失败 → 500 + 不进 ingest | 临时把 CloudBase `audit_log` collection 删掉 → ingest 返 500 AUDIT_FAILED（不进业务）|
| AC-6 | crawler CLI 传 `--ingest-proxy-secret` → header 出现 | `apps/crawler/src/main.ts --ingest-proxy-secret test123 ...` → fetch headers 含 `x-ingest-proxy-secret: test123` |
| AC-7 | 旧 admin 路径 + `user_id=DEFAULT_USER_ID`（缺省）仍能用 | 不带 X-Ingest-Proxy-Secret + 不带 user_id → 200（回归）|
| AC-8 | dev 模式（`INGEST_PROXY_SECRET` 未配）proxy 路径 401；admin 路径不受影响 | `unset INGEST_PROXY_SECRET && curl ...` → proxy 401；admin 200 |
| AC-9 | IP allowlist 同时约束 admin + proxy | 设 `ADMIN_IP_ALLOWLIST=1.2.3.4`，从 5.6.7.8 调 proxy → 403 |
| AC-10 | state-cp7-zhenjie.md §8 #2 标完成 + 引用本 spec + commit | 文档 update commit |

---

## 9. 部署路径

### 9.1 部署顺序

```bash
# 1. 本地生成 INGEST_PROXY_SECRET（32+ 字节随机）
openssl rand -hex 32
# 2. 加到 CloudBase secrets
tcb secrets add INGEST_PROXY_SECRET <secret> -e unequal-d4ggf7rwg82e0900b
# 3. 重打 bundle
pnpm -F api deploy:build
# 4. 部署 audit_log collection
pnpm -F api deploy:collections
# 5. 部署 api-router
tcb fn deploy api-router -e unequal-d4ggf7rwg82e0900b
# 6. 验证 env vars 未被 reset（如 state-cp7-b.md §6.3 教训 #7）
tcb fn config get api-router -e unequal-d4ggf7rwg82e0900b | jq '.EnvVars'
# 期望：原 8 vars + 新 INGEST_PROXY_SECRET（如走 vars）或确认 secrets 已注入
```

**注意**：`INGEST_PROXY_SECRET` 走 `tcb secrets add`（**敏感**），不走 env vars。

### 9.2 升级 crawler CLI

```bash
# 用户升级：
pnpm -F crawler build && pnpm -F crawler install
# 设置 env：
export INGEST_PROXY_SECRET=<secret>
# 调用：
node apps/crawler/src/main.ts --url <URL> \
  --ingest-proxy-secret "$INGEST_PROXY_SECRET" \
  --user-id 01KVCZ2JRBAGF3MY75D7KEY4RZ \
  --trust 2
```

### 9.3 回滚

```bash
# 方案 A：撤回 INGEST_PROXY_SECRET（proxy 路径全 401）
tcb secrets delete INGEST_PROXY_SECRET -e unequal-d4ggf7rwg82e0900b
# 方案 B：撤回整个 commit + redeploy
git revert <commit>
pnpm -F api deploy:build && tcb fn deploy api-router -e unequal-d4ggf7rwg82e0900b
```

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| `audit_log` collection schema 部署失败 → ingest 全 500 | 高 | `pnpm deploy:collections` 强制执行；AC-1 验证 |
| `INGEST_PROXY_SECRET` 配错 → crawler 全 401 | 中 | dev sentinel 不强制（不像 ADMIN_TOKEN）— 部署 checklist 列出 |
| `recordAudit` CloudBase 写入慢 → ingest 延迟 | 低 | CloudBase D1 写 ~10-50ms；可接受；监控 audit latency |
| 旧 admin 路径 + 指定 user_id 突然 403 | 中 | 这是 feature；CP-7 真接临时脚本 `crawl-and-ingest.ts` 同步升级 |
| audit 数据膨胀 | 低 | 无清理机制；M6.5+ cron 留口，独立 PR |
| admin + proxy IP allowlist 共用一份白名单 | 低 | 复用 `ADMIN_IP_ALLOWLIST`；如未来要分开需独立 spec |
| 鉴权顺序：先 proxy 后 admin？同时存在？ | 中 | spec §3.1 step 2：proxy 优先（has header 走 proxy），admin 回退；**不同时存在** |
| tokenFingerprint 泄露 → 反推 token 风险 | 低 | sha256 + 前 16 字符 = 64 bit 截断；理论反推 2^64 复杂度，实际不可行；与 M6.3a login_attempt 同算法 |

---

## 11. 实施计划（待 writing-plans skill 细化）

Phase 1 — 数据层 + helper（无行为变化）：
1. `apps/api/src/lib/collections.ts` + `auditLog`
2. `apps/api/src/lib/env.ts` + `INGEST_PROXY_SECRET`
3. `apps/api/src/lib/audit.ts`（NEW）+ tests
4. `apps/api/scripts/deploy-collections.ts` 注册 audit_log

Phase 2 — 鉴权 helper：
5. `apps/api/src/lib/auth-admin.ts` + `requireIngestProxy()` + tests
6. `apps/api/scripts/deploy-functions.sh` 加 audit_log collection 部署依赖（可选）

Phase 3 — ingest handler 改造：
7. `apps/api/src/handlers/api-ingest.ts` 鉴权分支 + user_id 行为分支 + audit 调用
8. `apps/api/test/handlers/api-ingest.test.ts` +17 用例

Phase 4 — crawler 升级：
9. `apps/crawler/src/main.ts` + `--ingest-proxy-secret` flag
10. `apps/crawler/src/ingest.ts` + `ingestProxySecret` opts
11. `apps/crawler/src/types.ts` + `SubmitIngestOptions.ingestProxySecret`
12. `apps/crawler/test/ingest.test.ts` + 2 用例
13. `apps/api/scripts/crawl-and-ingest.ts` 改用 proxy

Phase 5 — 部署 + 文档：
14. 部署：`tcb secrets add` + `deploy:build` + `deploy:collections` + `tcb fn deploy`
15. AC-1 ~ AC-10 验证
16. `docs/superpowers/state-cp7-zhenjie.md` §8 #2 标完成

---

## 12. 累计测试 + 文件清单

**累计测试目标**：
- apps/api: 63 → ~86 (+23)
- apps/crawler: 19 → 21 (+2)
- 合计: 跨 5 包 typecheck 全绿

**新建文件** (3):
- `apps/api/src/lib/audit.ts`
- `apps/api/test/lib/audit.test.ts`
- `docs/superpowers/specs/2026-06-21-cp7-c-ingest-audit-design.md` (本文)

**修改文件** (12):
- `apps/api/src/lib/auth-admin.ts`
- `apps/api/src/lib/env.ts`
- `apps/api/src/lib/collections.ts`
- `apps/api/src/handlers/api-ingest.ts`
- `apps/api/test/lib/auth-admin.test.ts`
- `apps/api/test/handlers/api-ingest.test.ts`
- `apps/api/scripts/deploy-collections.ts`
- `apps/api/scripts/crawl-and-ingest.ts`
- `apps/crawler/src/main.ts`
- `apps/crawler/src/ingest.ts`
- `apps/crawler/src/types.ts`
- `apps/crawler/test/ingest.test.ts`
- `docs/superpowers/state-cp7-zhenjie.md`

---

## 附录 A：关键设计决策记录

| # | 决策 | 替代方案 | 选 X 的理由 |
|---|---|---|---|
| AD-1 | audit 落地点：CloudBase collection + stdout 双写 | 仅 collection / 仅 stdout | 持久化 + 实时聚合；写两次成本可忽略 |
| AD-2 | `X-Ingest-Proxy-Secret` 错值 → 401 | 403 | 认证失败（非授权失败）；与 ADMIN_TOKEN 401 对称 |
| AD-3 | audit 写失败 → ingest 500 | 静默吞 / 重试 | 审计是合规硬约束；不留盲点 |
| AD-4 | 独立 `INGEST_PROXY_SECRET`，不走 JWT sub-scope | admin JWT 多 scope claim | 与 ADMIN_TOKEN 解耦；crawler 升级简单；不重发 admin JWT |
| AD-5 | 鉴权分支：proxy 优先（has header 走 proxy）| 同时允许（双层验证）| 简化路径语义；admin 路径专用于 user_id=DEFAULT_USER_ID |
| AD-6 | dev 模式：`INGEST_PROXY_SECRET` 未配 → proxy 路径 401；admin 路径仍可用 | 强制必须配 | dev 兼容；spec §3 关键设计原则 |
| AD-7 | audit 不存 content，只存 `contentLen` | 存全文 | PII / 隐私 + 体积；admin 后续审计 user_id 即可定位 |
| AD-8 | tokenFingerprint = sha256(token).slice(0, 16) | 存明文 / 不存 | 与 M6.3a login_attempt 同算法；不存明文合规 |
| AD-9 | audit_log 无 TTL / 自动清理 | 加 TTL | M6.5+ cron 留口；独立 PR；不过度设计 |
| AD-10 | 不做 sub-scope JWT（保持 admin JWT binary scope）| admin JWT scope 数组 | YAGNI；sub-scope 未来需要时独立 spec |

---

**Spec 完。** 准备 review。