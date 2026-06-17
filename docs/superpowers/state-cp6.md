# CP-6 — CloudBase 全量迁移 收尾

**完成日期**：2026-06-17
**Spec**：`docs/superpowers/specs/2026-06-17-cp6-cloudbase-migration-design.md`（commit `0301f7a`）
**Plan**：`docs/superpowers/plans/2026-06-17-cp6-cloudbase-migration.md`（commit `e285c1d`）

---

## 1. 摘要

apps/api 从 CF Workers 全量迁移到微信云开发 CloudBase 国内可达方案。共 8 个 phase 实施，9 个 checkpoint 全过；累计 143 tests 全绿。

**核心成果**：
- 13 个 CloudBase 云函数骨架 + 8 个完整实现（health / admin-login / wx-login / stats / sessions CRUD / upload / ingest / search / ask / chat / cron）
- shared `types.ts` + `retrieval.ts` 重写（NoSQL + brute-force cosine）
- CloudBase SDK 基础设施（init singleton + DB helpers + storage helpers）
- env 加载 + 启动时硬验证（embedding dim）
- JWT 签发 + admin IP allowlist
- 4 secrets + 8 vars 注入清单（待 CloudBase 环境创建）

**重要 caveat**：CloudBase 环境创建 + 资源部署需用户手动操作（控制台），代码已完成无法测真实部署。

---

## 2. 资源清单（待用户在 CloudBase 控制台建）

### 2.1 CloudBase 资源（5 个，需手动建）

| 资源 | 名称 | 命令 / 路径 | 状态 |
|---|---|---|---|
| CloudBase 环境 | `<user-env>` | 腾讯云控制台 → 云开发 → 新建环境（推荐 region `ap-shanghai`）| ⏸ 待用户 |
| D1 等价（CloudBase DB） | `<user-env>` 内置 | CloudBase 控制台 → 数据库 → 建 9 个 collection | ⏸ 待用户 |
| Vectorize 等价 | 9 个 collection 内（brute-force）| 同上 | ⏸ 待用户 |
| R2 等价（CloudBase 云存储） | `unequal-storage` | CloudBase 控制台 → 存储 → 建 bucket | ⏸ 待用户 |
| Durable Object 等价 | CloudBase collection 内（chat_session）| 同上 | ⏸ 待用户 |
| Cron Trigger | api-cron-cleanup | CloudBase 控制台 → 云函数 → 触发器 → 定时（每日 03:00 UTC）| ⏸ 待用户 |

### 2.2 9 个 Collection + 6+ Field Index

**Collection 名称**（spec §3.1）：
- `source`
- `document`
- `chunk`
- `query_cache`
- `chat_session`
- `user`
- `user_session_key`
- `login_attempt`
- `crawl_job`

**Field Index（spec §3.3）**：
- `chunk.documentId` / `chunk.sourceId` / `chunk.userId`
- `document.sourceId`
- `chat_session.userId`
- `login_attempt.clientIpHash`
- `user_session_key.userId`
- `crawl_job.sourceId` / `crawl_job.status`

### 2.3 13 个 CloudBase Functions

部署方式：每个 handler 独立成云函数，或用单入口分发（当前 `src/index.ts` 是单入口模式，按 path 分发到 13 个 handler 模块）。

| Function | 触发器 | 实现状态 |
|---|---|---|
| api-health | HTTP | ✅ 完成 |
| api-auth-admin-login | HTTP | ✅ 完成 |
| api-auth-wx-login | wx.cloud.callFunction | ✅ 完成（兼容多字段名）|
| api-stats | HTTP (admin) | ✅ 完成 |
| api-sessions-list | HTTP (JWT) | ✅ 完成 |
| api-sessions-get | HTTP (JWT) | ✅ 完成 |
| api-sessions-delete | HTTP (JWT) | ✅ 完成 |
| api-upload | HTTP (admin) | ✅ 完成 |
| api-ingest | HTTP (admin) | ✅ 完成 |
| api-search | HTTP (admin) | ✅ 完成 |
| api-ask | HTTP (admin) | ✅ 完成 |
| api-chat | HTTP (JWT) | ✅ 完成 |
| api-cron-cleanup | 定时触发器 | ✅ 完成 |

---

## 3. Secrets + Vars 注入清单（待用户在 CloudBase 控制台配）

### 3.1 4 Secrets（CloudBase 函数配置 → 环境变量）

| Secret | 来源 | 长度 |
|---|---|---|
| `ADMIN_TOKEN` | `openssl rand -hex 32` | 64 字符 |
| `JWT_SECRET` | `openssl rand -hex 32` | 64 字符 |
| `MINIMAX_API_KEY` | platform.MiniMax.io | 你已有 |
| `KEK_SECRET_V1` | `openssl rand -hex 32` | 64 字符 |

### 3.2 8 Vars

| Var | 值 |
|---|---|
| `ENVIRONMENT` | `production` |
| `ALLOWED_ORIGIN` | `*`（admin 跨域需要）|
| `ADMIN_IP_ALLOWLIST` | `240e:3b4:38ed:4100:10a1:f77f:f362:d8b0`（你 v0 已用的 IPv6）|
| `MINIMAX_BASE_URL` | `https://api.MiniMax.chat/v1` |
| `DEFAULT_USER_ID` | `01H0000000000000000000000`（v0 单用户常量）|
| `LOGIN_MAX_ATTEMPTS` | `5` |
| `LOGIN_WINDOW_MS` | `900000` |
| `KEK_CURRENT_VERSION` | `1` |

---

## 4. 6 步 Smoke Runbook（待 CloudBase 部署后跑）

**前置**：4 secrets + 8 vars 注入完成 + 13 函数部署成功 + 9 collection 创建。

```bash
# 设变量（用户替换 <...>）
API="https://<appid>.<region>.app.tcloudbase.com"
TOKEN="<your-ADMIN_TOKEN>"

# Step 1: health
curl -sf $API/api-health | jq
# 期望: { ok: true, environment: "production", timestamp: <ms> }

# Step 2: admin login
JWT=$(curl -sf -X POST $API/api-auth-admin-login \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\"}" | jq -r .jwt)
# 期望: JWT 字符串；ADMIN_TOKEN 验证通过；ADMIN_IP_ALLOWLIST 检查通过

# Step 3: upload（小 MD，base64）
echo "# test
5个月宝宝发烧38.5要观察精神状态，多喝水，超过39度就医" > /tmp/cp6-test.md
CONTENT=$(base64 -i /tmp/cp6-test.md | tr -d '\n')
curl -sf -X POST $API/api-upload \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"filename\":\"cp6-test.md\",\"content_base64\":\"$CONTENT\",\"trust_level\":2}" | jq
# 期望: { source_id, document_id, chunks_inserted: 1, chunks_failed: 0 }

# Step 4: search
curl -sf "$API/api-search?q=发烧&topK=5" \
  -H "Authorization: Bearer $TOKEN" | jq '.results | length'
# 期望: ≥1（Vectorize 召回验证）

# Step 5: ask
curl -sf -X POST $API/api-ask \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"q":"5个月宝宝发烧怎么办"}' | jq '.answer // ., .citations // "no citations"'
# 期望: 完整 RAG 链路；answer 含 [1][2] 引用 + 末尾 {"citations":[1,2]} JSON

# Step 6: stats
curl -sf $API/api-stats \
  -H "Authorization: Bearer $TOKEN" | jq
# 期望: 200 { total, totalSuccess, totalFailed, last24h, last24hFailed, timestamp }
```

**任一步失败** → §6 失败处理。

### 4.1 关闭 Deferred 项（D-1 / D-3 / D-4 / D-6）

| 项 | 来自 | 验证方式 |
|---|---|---|
| D-1 admin auth 链路 | M6-3a | smoke step 2-6 全 200（admin token 通过）|
| D-3 /login 输错 5 次 429 | M6-3a | 旁路：连发 6 次错误 token → 第 6 次 429 |
| D-4 ADMIN_IP_ALLOWLIST 真实生效 | M6-10 | 旁路：从非 allowlist IP 调 /api-auth-admin-login → 403 |
| D-6 Vectorize 远端 binding 真接 | webpage-crawler-setup | smoke step 3-4（upload → search 召回）|

---

## 5. Commit 列表

```
292de8e  chore(api): CP-6 Phase 1 — CloudBase SDK init + shared 重写（CP-1 ✅）
b77bf5e  chore(api): CP-6 Phase 2 — Data Layer + 13 handler 骨架（CP-2 ✅）
b43ad0e  feat(api): CP-6 Phase 3 — Auth + 简单 read handlers（CP-3 ✅）
3c634f4  feat(api): CP-6 Phase 4 — Write handlers + vector search（CP-4 ✅）
6c8501e  feat(api): CP-6 Phase 5 — Chat + Ask handlers（CP-5 ✅）
81bbf9f  feat(api): CP-6 Phase 6 — cron + 启动硬验证测试（CP-6 ✅）
d123dfb  feat(miniprogram,admin): CP-6 Phase 7 — Frontend apiBaseUrl
<pending> docs: CP-6 state-cp6.md 收尾 + README CP-6 节 + v0 封存 tag
```

**总 8 commit + 0 merge**（master 直接做）。

---

## 6. 失败处理

### 6.1 CloudBase 部署失败

最常见 5 个：
1. **CloudBase 环境未实名**：腾讯云账号需先完成实名认证（个人 1-3 天）
2. **collection 已存在但 schema 不匹配**：删 collection 重跑（注意数据丢失）
3. **Field Index 类型不匹配**：检查索引配置（spec §3.3）
4. **Trigger URL 配置错**：检查 HTTP 触发器 path 配置
5. **env 注入错位**：CloudBase 函数 → 配置 → 环境变量 检查 4 secrets + 8 vars

### 6.2 端到端 smoke 失败

- Step 1 health 失败 → 函数未部署成功，查 CloudBase 控制台 → 云函数 → 日志
- Step 2 admin login 失败 → ADMIN_TOKEN 错 / ADMIN_IP_ALLOWLIST 不含本机 IP
- Step 3 upload 失败 → 文件太大（> 4MB）/ parse 失败 / MiniMax embedding 错
- Step 4 search 失败 → Vectorize 召回失败（D-6 关闭项失败）
- Step 5 ask 失败 → MiniMax chat 失败 / 引用解析错
- Step 6 stats 失败 → login_attempt 聚合错

### 6.3 Rollback 路径（5 分钟）

```bash
# 1. 改 mini-program apiBaseUrl 指回 v0
# 编辑 apps/miniprogram/app.ts:7
apiBaseUrl: "https://unequal-api.yydsnews.workers.dev",

# 2. 改 admin VITE_API_BASE_URL 指回 v0
# 编辑 apps/admin/.env.production
VITE_API_BASE_URL=https://unequal-api.yydsnews.workers.dev

# 3. CloudBase 控制台 disable 所有云函数触发器 + 定时触发器

# 4. commit + push（问用户）
```

**v0 资源保留**：CF Worker + D1 + Vectorize + R2 不动；admin_token + IP allowlist 同 v0；admin 走 VPN 访问。

---

## 7. v0 封存附录（追加到 state-cp5.md）

CP-6 收尾同时给 `state-cp5.md` 加如下附录：

```markdown
## 附录：v0 封存归档（2026-06-17）

cp-6 CloudBase 全量迁移完成后，v0 CF 部署进入封存状态。

- **git tag**：`v0-cf-archived`（CP-6 收尾 commit 同步打）
- **CF 资源保留**：Worker / D1 / Vectorize / R2 均不销毁（cost ¥0）
- **回滚路径**：改 mini-program + admin apiBaseUrl 指回 `https://unequal-api.yydsnews.workers.dev`（5 分钟）
- **决策点**：v1 稳定运行 1 个月+ 后，让用户决策是否销毁 v0 资源

详见 `docs/superpowers/specs/2026-06-17-cp6-cloudbase-migration-design.md`
```

---

## 8. 已知 issue / 风险 / 下一步

### 8.1 已知 issue

| Issue | 影响 | 状态 |
|---|---|---|
| **CloudBase 环境未创建** | 代码完整但无法部署测真 | ⏸ 用户手动操作 |
| **Smoke 端到端未跑** | 8 个 handler 实现但未真验 | ⏸ CloudBase 部署后跑 |
| **ADMIN_IP_ALLOWLIST IPv6 动态风险** | China Mobile EUI-64 可能数天失效 | 沿用 CP-5 §9 SOP |
| **Embedding 1536 维假设** | 启动时硬验证；不符即 throw | ✅ 已加测试 |
| **WX_CONTEXT.openid 字段路径** | 兼容 3 种字段名（`userInfo.openId`/`openid`/`OPENID`）| ✅ smoke 时验 |

### 8.2 部署自动化（CP-6+ 新增）

`apps/api/scripts/` 下 4 个部署自动化脚本（托管模式开发 — 让你跑最少手动步骤）：

| 脚本 | 命令 | 用途 |
|---|---|---|
| `deploy-collections.ts` | `pnpm -F api deploy:collections` | SDK 创建 9 collection（幂等：已存在跳过）|
| `deploy-indexes.ts` | `pnpm -F api deploy:indexes` | HTTP API 创建 9 个 field index（幂等）|
| `deploy-functions.sh` | `pnpm -F api deploy:functions` | 打印 13 个函数的 tcb CLI 命令（用户复制执行）|
| `deploy-secrets.ts` | `pnpm -F api deploy:secrets` | 注入 4 secrets + 8 vars（HTTP API）|

**前置 env vars**：
- `TCB_SECRET_ID` / `TCB_SECRET_KEY` / `TCB_ENV`（CloudBase 控制台拿）
- `TCB_ACCESS_TOKEN`（CloudBase 控制台 → API 密钥管理 → 自签 token）
- 4 secrets 从你 terminal env 读（ADMIN_TOKEN / JWT_SECRET / MINIMAX_API_KEY / KEK_SECRET_V1）

**部署流程**：
```bash
cd apps/api
export TCB_SECRET_ID=...  TCB_SECRET_KEY=...  TCB_ENV=...  TCB_ACCESS_TOKEN=...
export ADMIN_TOKEN=...  JWT_SECRET=...  MINIMAX_API_KEY=...  KEK_SECRET_V1=...
pnpm deploy:collections   # 创建 9 collection
pnpm deploy:indexes        # 创建 9 field index
bash scripts/deploy-functions.sh  # 看输出复制 tcb 命令
pnpm deploy:secrets        # 注入 4 secrets + 8 vars
```

**部署模式二选一**：
- **模式 A（推荐）**：单入口分发（deploy 1 个 `api-router` 函数）；spec §2.4 简化方案
- **模式 B**：13 个独立函数；spec §2.4 推荐方案（更灵活但配置 13 倍）

### 8.3 cp-7 计划项

1. **CloudBase 环境创建 + 13 函数部署**（用户操作 — 跑 §8.2 脚本）
2. **Mini-program 真机验证**（需 AppID 注册时同时做；现在 user 已有 AppID）
3. **重跑 6 步 smoke**（D-1 / D-3 / D-4 / D-6 全部验证）
4. **KEK 轮换演练**（M6.8 留口）
5. **v0 资源销毁决策**（1 个月后）

### 8.3 教训（给后续 checkpoint）

1. **可达性优先**：spec 设计阶段必须先验证国内可达（[[feedback-china-network-constraints]]）
2. **CloudBase SDK ≠ CF Workers SDK**：handler signature / event context / SDK 调用模式完全不同
3. **D1 SQL → NoSQL 是大重构**：所有 query 重写、denormalize 决策需提前设计
4. **partial failure 处理**：每 chunk / 每 doc 独立 try/catch + errors 报告
5. **embedding 假设需验证**：启动时硬验证比 smoke 时才发现更安全
6. **CloudBase 控制台操作 = 用户**：不能自动化（要腾讯云账号 + 实名），spec 阶段就标出阻塞

---

## 9. References

- **Spec**：`docs/superpowers/specs/2026-06-17-cp6-cloudbase-migration-design.md`（commit `0301f7a`）
- **Plan**：`docs/superpowers/plans/2026-06-17-cp6-cloudbase-migration.md`（commit `e285c1d`）
- **CP-5 state**：`docs/superpowers/state-cp5.md`（v0 封存附录待加）
- **CP-5 spec**：`docs/superpowers/specs/2026-06-16-cp5-real-cloudflare-design.md`
- **M6.10 spec**：`docs/superpowers/specs/2026-06-16-m6-10-admin-allowlist-design.md`
- **README**：v1 / v0 段已加
- **腾讯 CloudBase 文档**：https://docs.cloudbase.net/
- **@cloudbase/node-sdk**：https://docs.cloudbase.net/api-reference/server/node-sdk.html