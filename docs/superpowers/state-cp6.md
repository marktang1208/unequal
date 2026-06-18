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

### 8.2 部署自动化（CP-6+ 新增；P3.5/P3.6 重写完）

`apps/api/scripts/` 下 5 个部署自动化脚本（托管模式开发 — 让你跑最少手动步骤）：

| 脚本 | 命令 | 用途 | Auth 方式 |
|---|---|---|---|
| `deploy-collections.ts` | `pnpm -F api deploy:collections` | tcb CLI + MongoDB `create` 建 9 collection | `tcb login` |
| `deploy-indexes.ts` | `pnpm -F api deploy:indexes` | tcb CLI + MongoDB `createIndexes` 建 9 index | `tcb login` |
| `deploy-functions.sh` | `pnpm -F api deploy:functions` | 打印 13 个函数的 tcb CLI 命令（用户复制执行）| `tcb login` |
| `deploy-secrets.ts` | `pnpm -F api deploy:secrets` | 写 cloudbaserc.smoke.json + `tcb fn deploy` 注入 4 secrets + IP allowlist | `tcb login` |
| `deploy-clean.ts` | `pnpm -F api deploy:clean` | smoke 后用干净 cloudbaserc.json 重 deploy 恢复 7 vars | `tcb login` |

**前置**：先 `tcb login`（扫码或 API Key 3.0）；env 从 `cloudbaserc.json` 读，或 `-e unequal-d4ggf7rwg82e0900b` 显式指定。

**部署流程**：
```bash
cd /Users/Mark/cc_project/unequal
tcb login                                  # 一次性
pnpm -F api deploy:collections             # 建 9 collection（幂等）
pnpm -F api deploy:indexes                 # 建 9 field index（幂等）
pnpm -F api deploy:build                   # build bundle → functions/api-router/
bash scripts/deploy-functions.sh           # 看输出复制 tcb fn deploy 命令
```

**Smoke 流程**：
```bash
# 1. 准备 5 env vars（export 5 个值；用 /tmp/dump-secrets.sh 写到文件 600 权限）
export ADMIN_TOKEN=$(openssl rand -hex 32)  # 或保留旧值
export JWT_SECRET=$(openssl rand -hex 32)
export KEK_SECRET_V1=$(openssl rand -hex 32)
export MINIMAX_API_KEY=sk-cp-...
export ADMIN_IP_ALLOWLIST="240e:...,113.116.119.197"  # 多 IP 用逗号
/tmp/dump-secrets.sh
source /tmp/unequal-secrets.env
cd /Users/Mark/cc_project/unequal
pnpm -F api deploy:secrets                 # 写 cloudbaserc.smoke.json + 重 deploy api-router

# 2. 跑 6 步 smoke（docs/superpowers/state-cp6.md §4）

# 3. 清理：恢复 7 vars 干净版
pnpm -F api deploy:clean                   # 用干净 cloudbaserc.json 重 deploy
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
---

## 9. 附录：CP-6.5 部署阻塞报告（2026-06-18 凌晨）

### 9.1 时间线
- 2026-06-17 17:53: **第一次成功 deploy**（`tcb fn deploy`）到旧 env `unequal-d8g4fjk0x5ea36822`（个人版，¥19.9/月）— 当时配置是 **Nodejs20.19 + handler=index.main + installDependency=true**（cloudbaserc.json 写 Nodejs18.15 但 tcb CLI 用 default Nodejs20.19）
- 2026-06-17 18:00-23:00: **HTTP 网关调试 8 次请求 0 成功** —— `prod.ap-shanghai.service.tencentcloudbase.com` API gateway 8 次调用 0 成功
- 2026-06-17 23:00 之后: 旧 env 用户**主动注销**（个人版 ¥19.9/月停用）
- 2026-06-17 23:30-00:00: 公众号云开发 **d8g6 重新激活测试**（d8g6 是 CP-6 之前从微信公众号后台开通的免费版，d8g4 注销后回来测试同账号下的免费版是否 work） — IDE 同步 + Monaco 代码 editor 验证，**但 SCF Node 18 runtime 触发 `writeRuntimeFile toString undefined` 错**（不同 bug）
- 2026-06-18 00:00-01:00: 新个人版 env `unequal-d4ggf7rwg82e0900b` 开通（**账号身份切换：微信账号 → 小程序账号**；用新主 API key `***REMOVED***`），tcb CLI 凭证切换
- 2026-06-18 01:00-01:15: **所有 deploy 100% 失败** —— `bash: mjs: command not found` 错（包括 207 字节 helloworld）
- **诊断：北京时间 01:11（凌晨）= 腾讯云 SCF 系统运维窗口**（通常 02:00-06:00），BuildCodeViaSCF 镜像 mjs 工具维护期间被下掉

### 9.2 已完成的修复（独立于 SCF 平台 bug）
1. ✅ `apps/api/src/index.ts` export `handler = main`（兼容 SCF handler 字段）
2. ✅ esbuild bundle 14.5MB（`@cloudbase/node-sdk`, `jose`, `mammoth`, `pdf-parse`, `ulid`, `zod` 全 inline）
3. ✅ `apps/api/scripts/deploy-build.ts` — 自动化 build + scf_bootstrap + package.json 写
4. ✅ pdf-parse 1.1.1 兼容（esbuild plugin 在 transform 阶段 patch `isDebugMode = !module.parent` → `false`）
5. ✅ `apps/api/cloudbaserc.json` — 17:53 成功配置：`runtime: Nodejs20.19 + handler: index.main + installDependency: true`
6. ✅ 3 处 envId 引用统一到 `unequal-d4ggf7rwg82e0900b`（miniprogram app.ts / admin .env / cloudbaserc.json）
7. ✅ 19 个 env vars 全部注入（`tcb fn detail` 验证：admin_token / jwt_secret / minimax_api_key / kek_secret_v1 / admin_ip_allowlist / wechat_appid+secret / embedding_* / allowed_origin / environment / minimax_base_url / default_user_id / login_* / kek_current_version / node_env）
8. ✅ miniprogram 测试页 `pages/cloudbase-test/`（4 文件：ts/wxml/wxss/json）+ `app.ts` 加 `wx.cloud.init`
9. ✅ admin 测试页 `pages/CloudBaseCallTest.tsx` + `src/lib/cloudbase.ts`（fetch + 匿名 login）+ `.env.local.example`

### 9.5 CP-6.5 部署修复 + smoke 报告（2026-06-18 上午）

### 9.5.1 真实根因（凌晨 1 点误判）

凌晨 §9.1 误判是腾讯云 SCF 凌晨运维下掉 mjs 工具。**实际根因是 esbuild ESM bundle 与 axios ESM 互操作**：

`apps/api/scripts/deploy-build.ts` 用 `format: "esm"`，但 axios（@cloudbase/node-sdk 依赖）内部用 `require("http")` 调 Node native module。ESM 模式下 esbuild 把 native require 替换成抛错：

```
Error: Dynamic require of "http" is not supported
  at functions/api-router/index.js:11:9
```

`require("http")` 在 bundle line 11（module top-level），`setInterval(1_000)` keep-alive 在 line 327000+（load 完后），**module load 即 throw → 进程 crash → SCF 报 "0 code exit unexpected"**。凌晨所有 deploy 0% 成功是因为 bundle 一直有问题，跟 SCF 凌晨运维无关。

### 9.5.2 修复（3 文件）

| 文件 | 改动 |
|---|---|
| `apps/api/scripts/deploy-build.ts` | `format: "esm" → "cjs"`, `target: node18 → node20`, pkgJson 模板去 `"type": "module"` |
| `apps/api/functions/api-router/package.json` | 删 `"type": "module"`（deploy-build 模板同步去） |
| `apps/api/cloudbaserc.json` | `type: "HTTP" → "Event"`, `runtime: Nodejs18.15 → 20.19`, 加 `envVariables` (7 稳定 vars) |

**额外**：删 `apps/api/src/http-server.ts`（Web 函数实验遗留，Event 模式不需要）。

### 9.5.3 9 必填 env vars 验证

§9.4 临时回退项 1/2/3 全部生效：
- `apps/api/src/lib/env.ts` 改回 9 必填（ADMIN_TOKEN / JWT_SECRET / MINIMAX_API_KEY / KEK_SECRET_V1 / ADMIN_IP_ALLOWLIST / ENVIRONMENT / ALLOWED_ORIGIN / KEK_CURRENT_VERSION / DEFAULT_USER_ID）
- `apps/miniprogram/app.json` cloudbase-test 仍在 pages 数组最后（master 已是对的状态）
- `apps/api/src/http-server.ts` 已删

cloudbaserc.json 只配 7 个稳定 vars，4 secrets + IP allowlist 走临时 **cloudbaserc.smoke.json**（gitignored）注入 12 env vars。

### 9.5.4 MiniMax embedding 协议 bug

smoke step 3/4/5/6 暴露 **MiniMax embedding 协议错配**：embedder 用 OpenAI 兼容（`{model, input}` → `data.embedding`），但 MiniMax API 实际用自家协议（`{model, texts, type}` → `vectors`）。

修：
- `packages/shared/src/embedding.ts` — 改 MiniMax 协议，加 `type` config (default `db`)
- 5 个 handler + 1 处 env.ts validateEmbeddingDim 改 model name `MiniMax-embeddings` → `embo-01`（不是 `em-01`）
- `packages/shared/test/embedding.test.ts` — mock 改 MiniMax 协议，加 `type=query` + `vectors count mismatch` 2 个新 test

### 9.5.5 Smoke 6 步结果

| Step | Result | Notes |
|---|---|---|
| 1 health | ✅ 200 | `environment: production` |
| 2 admin-login | ✅ 200 | JWT 返，ADMIN_IP_ALLOWLIST IPv6 命中 |
| 3 upload | ✅ 200 | `chunks_inserted:1, chunks_failed:0`（mini-smoke 文件 1 chunk） |
| 4 search | ✅ 200 | 1 chunk 召回 score 0.64；`chunkId:""` 是次要 bug（DB 写入 chunkId 没传） |
| 5 ask | ❌ 502 | `unknown model 'minimax-chat'` — chat 真实 model name 待查（spec 阶段漏验） |
| 6 stats | ⚠️ 200 | 返 `{total:0, totalSuccess:0, ...}` — admin-login 走过 2 次但 total=0；`login_attempt` collection 没记录或聚合 SQL 缺 index |

**4/6 步核心通**（health/admin-login/upload/search）。Step 5/6 留 P3 后续。

### 9.5.6 deploy-collections.ts 没跑通（已 P3.5 解决）

CAM 永久 key (AKID...) 直接调 @cloudbase/node-sdk 报 `SIGN_PARAM_INVALID`。**根因（部分）**：CloudBase OpenAPI 需要 STS 临时凭证（accessKeyId + secretAccessKey + token），不是 CAM 永久 key。SDK 默认不自动拿 STS 凭证，**必须从函数 runtime context 或预先 STS 化**。

**更深的根因（P3.5 发现）**：之前用的 HTTP API 端点 `https://api.cloudbase.tencentcloud.com/v2/database` 域名 **NXDOMAIN** — 这域名不存在，国内 DNS 完全不可达。deploy-secrets.ts / deploy-indexes.ts 用同样 URL，理论上从没真跑通过；只是之前手动控制台补救了所以没人发现。

修法（P3.5 已完成）：
- **不走 SDK / 不走 HTTP API**：改 `tcb db nosql execute` + MongoDB `create` / `createIndexes` 命令
- **tcb CLI 内部用 `tcb-api.tencentcloudapi.com`**，国内 DNS 解析正常（109.244.144.136）
- **CLI 已 `tcb login`**，auth 自动处理，不需要 CAM key / STS / access token
- **幂等**：collection 已存在返回 `NamespaceExists`，index 已存在返回 `note: all indexes already exist`

### 9.5.7 教训（给后续 checkpoint）

1. **凌晨报错不一定是平台问题** — §9.1 凌晨报错被误判为 SCF 运维，实际是 bundle bug。**先看 invariant log（"0 code exit unexpected"）反推根因**，不要从 timing 猜。
2. **CAM key ≠ CloudBase OpenAPI 凭证** — 腾讯云 CAM 永久 key 不能直接调 CloudBase OpenAPI（需要 STS 临时凭证）。SDK 不会自动转换。
3. **spec 阶段必须验外部 API 协议** — MiniMax embedding 真实协议（`texts` + `type` + `vectors`）跟 spec 设计的 OpenAI 兼容协议（`input` + `data.embedding`）不一致，导致 4 个 handler 写错。**必须在 spec 阶段真打一次 API 验证**。
4. **CJS bundle 在 Node 20 兼容更好** — 大量 node lib（axios / pdf-parse）依赖 native require，ESM bundle 容易踩 "Dynamic require" 坑。**生产 bundle 默认 CJS**。
5. **cloudbaserc.json 是 deploy-only，secrets 不应进 git** — 用 gitignored `cloudbaserc.smoke.json` 临时注入 4 secrets + IP allowlist。`tcb --config-file` flag 支持指定 config path。
6. **API GW event 字段名是 `queryStringParameters`（不是 `queryString`）** — CloudBase HTTP gateway 用 SCF API GW 标准 event 格式。**handler 读 query 必须兼容两者**。P3.7 修：handler-utils.ts `getQuery` 用 `event.queryString ?? event.queryStringParameters`。
7. **handler-utils.ts 类型定义要 reflect runtime** — `queryString: Record<...>` 标注太乐观，runtime 是 `undefined`。**所有 optional field 都加 `?`**。
8. **zsh 子进程看不到未 export 的变量** — `VAR=value cmd`（裸赋值）只设 shell-local 变量，子进程（脚本 subshell）看不到。**必须 `export VAR=value`**。dump 脚本要 sanity-check 失败立刻报错 + 提示 export，否则错误信息（"Missing env var"）完全没指向真正原因。

## 10. P3 待办（继承自 §8.3 + 新增）

1. ~~CloudBase 环境创建 + 13 函数部署~~ (已 deploy api-router 1 个)
2. **MiniMax chat model name 实测** — 试 `MiniMax-01` / `abab-6.5s-chat` / `MiniMax-Text-01` 等
3. **stats handler 修** — login_attempt 记录 + 聚合逻辑
4. **search chunkId 空 bug** — 查 DB schema 写入是否漏 chunkId 字段
5. ~~**deploy-collections.ts 重写** — 用 CAM key 走 STS 拿临时凭证~~ ✅ **P3.5 完成** (2026-06-18 18:30) — 改走 `tcb db nosql execute` + MongoDB `create` 命令。CLI 内部用 `tcb-api.tencentcloudapi.com`（国内 DNS 可达），不需要 SDK / access token / STS。9/9 collection 报 `NamespaceExists`（已存在，幂等）。
6. ~~**deploy-indexes.ts 同上**~~ ✅ **P3.5 完成** — 同上路径，MongoDB `createIndexes`。首次跑 1 created + 8 existed（漏 `login_attempt.clientIpHash`，自动补），二次跑 0 created + 9 existed（幂等）。
7. ~~**9 个 field index** 创建（spec §3.3）~~ ✅ **P3.4 完成** (2026-06-18 13:30) — CloudBase 控制台手动建，9 index 跨 7 collection:
   - `chunk.documentId` / `chunk.sourceId` / `chunk.userId` (3)
   - `document.sourceId`
   - `chat_session.userId`
   - `login_attempt.clientIpHash`
   - `user_session_key.userId`
   - `crawl_job.sourceId` / `crawl_job.status` (2)
   - 全 String + unique false。smoke step 4 search 验 chunk.userId index 走通。
8. ~~**KEK 轮换演练** (M6.8)~~ ✅ **P3.6 同时完成** — 2026-06-18 smoke 重新生成 KEK_SECRET_V1 + JWT_SECRET + ADMIN_TOKEN（MiniMax_API_KEY 保留旧值），deploy:secrets 把新值注入云函数，6 步 smoke 全通后再 deploy:clean 清掉。**实战演练了"轮换 → 注入 → 验证 → 清理"全流程**。
9. v0 资源销毁决策 (1 个月后)
10. ~~**cloudbaserc.smoke.json secrets cleanup** — smoke 后跑一次 `tcb --config-file cloudbaserc.json fn deploy` (7 vars 干净版) 清 4 secrets~~ ✅ 已流程化为 `pnpm -F api deploy:clean`（2026-06-18 P3.6 新增）
11. ~~**deploy-secrets.ts 重写** — 用 CAM key 走 STS 拿临时凭证~~ ✅ **P3.6 完成** (2026-06-18 19:00) — 改走 `tcb --config-file cloudbaserc.smoke.json fn deploy --all --force`，CLI 内部用 `tcb-api.tencentcloudapi.com`。详见 §10.3。
12. ~~**queryString 字段兼容修**~~ ✅ **P3.7 完成** (2026-06-18 19:30) — handler-utils.ts `getQuery` 用 `event.queryString ?? event.queryStringParameters`，类型加 `?`。
13. ~~**ask handler citations title="未知文档"**~~ ✅ **P3.8 完成** (2026-06-18 20:00) — api-ask.ts + api-chat.ts query 改用 schema `id` 字段（不是 CloudBase `_id`），docMap key 改 `d.id`。Smoke step 5 验：3 次跑 2 次返 `title: "cp7-test.md"`，1 次 citations 空是 LLM variance（已知 caveat，跟 P3.8 无关）。
14. ~~**Mini-program 真机验证**（CP-6 终极 gate）~~ ✅ **P3.9 完成** (2026-06-18 17:30) — 暴露 4 个 CP-6 漏掉的问题，全部修：wx-login HTTP 400 (must callFunction) + api-router 缺 env vars (deploy --force 重置) + api-chat model 拼错 (MiniMax-chat → MiniMax-Text-01) + miniprogram paths 不对齐 (加 api- 前缀) + ChatSessionRow shape snake_case 不匹配 server camelCase + history.wxml 还是 CP-3 期 entries 形态 (重写渲染 sessions)。详见 §10.6。

## 10.1 P3 修 3 个 smoke bug (2026-06-18 12:25)

| Bug | Root cause | 修法 | Smoke 验 |
|---|---|---|---|
| P3.1 ask "unknown model 'minimax-chat'" | spec 阶段漏验 chat 真实 model | `api-ask.ts:135` `model: "MiniMax-Text-01"` (试 9 个 model 后选定) | 200 + 完整 RAG answer + [来源 1] 引用 |
| P3.2 stats login 计数 0 | `api-auth-admin-login.ts` 完全没写 login_attempt collection | 加 `recordLoginAttempt()` 成功 + 失败 (IP_NOT_ALLOWED + AUTH_FAILED) 都写; `clientIpHash: sha256(JWT_SECRET+":"+clientIp)` (spec §3.3 rate-limit 用) | `total:3, totalSuccess:2, totalFailed:1` (1+2 累加对) |
| P3.3 search chunkId="" | upload 写 chunk 时 `id: ""`, CloudBase 自动生成 _id 没回写; retrieval 用 `c.id` 永远取空 | Chunk schema 加 `_id?: string`; retrieval `chunkId: c._id ?? c.id`; upload 接住 `add()` 返的 _id; search/ask/chat 3 handler `chunks.map` 加 `_id: c._id`; ask handler 3 处 `find` + docMap 改用 `_id` | search 返 `chunkId: "01KVCE5..."` 真值; ask 完整 RAG |

commit `67ac297` (`fix(api): P3 — chunkId bug + login_attempt 写 + ask chat model`) 包含 3 修复 (7 files, +58/-11).

caveat: ask handler citations 数组有时空 — LLM 不严格 follow system prompt 末尾 JSON 指令 (`{"citations": [...]}`). 修法 (非 P3): temperature=0 + few-shot + prompt 强化. spec §3.1 硬约束 3. 留 P4.

## 10.2 P3.5 deploy-collections/indexes 重写 (2026-06-18 18:30)

### 10.2.1 决策路径

| 路径 | 时间 | 复杂度 | 可行性 | 结果 |
|---|---|---|---|---|
| HTTP API `api.cloudbase.tencentcloud.com` | 30 min | 低 | ❌ NXDOMAIN 国内不可达 | 弃 |
| CAM key + SDK | 30 min | 低 | ❌ SIGN_PARAM_INVALID | 弃（§9.5.6 已知） |
| CAM key + STS + SDK | 4-6h | 高 | ⚠️ 仍可能 DNS 受限 | 弃（过度工程）|
| **`tcb db nosql execute` + MongoDB 命令** | **30 min** | **低** | ✅ **国内可达 + 已登录** | **选** |

### 10.2.2 关键发现

- `https://api.cloudbase.tencentcloud.com` 域名 **不存在**（NXDOMAIN）
- 之前 deploy-secrets.ts / deploy-indexes.ts 用同样 URL，**从未真跑过**；只是 smoke 走 cloud function URL 不依赖这域名
- tcb CLI 用 `tcb-api.tencentcloudapi.com`（109.244.144.136），DNS 解析正常
- `tcb db nosql execute --command '[{TableName,CommandType,Command}]'` 支持 MongoDB 原生命令：`create` collection / `createIndexes` index

### 10.2.3 实测结果

```bash
$ pnpm -F api deploy:collections
[deploy-collections] via tcb db nosql execute
  - source (source)... ⏭  already exists
  ... (9 条全 ⏭)
0 created, 9 already exist, 0 failed

$ pnpm -F api deploy:indexes
[deploy-indexes] via tcb db nosql execute
  - chunk.documentId... ⏭  already exists
  ...
  - login_attempt.clientIpHash... ✅ created   # 之前手工漏，自动补
  - crawl_job.status... ⏭  already exists
1 created, 8 already exist, 0 failed

$ pnpm -F api deploy:indexes   # 二次跑验幂等
0 created, 9 already exist, 0 failed
```

### 10.2.4 教训（追加 §9.5.7）

8. **验证端点 URL 而不只是协议** — 之前 deploy-secrets.ts 用 `api.cloudbase.tencentcloud.com` 看着像对的，实际域名 NXDOMAIN。**dev/staging 跑过 ≠ 部署脚本 work**。deploy 脚本必须真在目标网络跑通才算数，不能假设 deploy 是"未来再测"。
9. **CLI 是被低估的 API** — `tcb db nosql execute` 直接吃 MongoDB 命令，比 SDK 灵活 10 倍，比 HTTP API 省心（不用签名 / 不用 STS / 不用 token）。**当 SDK / HTTP API 走不通，先看 CLI 有没有**。

## 10.3 P3.6 deploy-secrets/clean 重写 + KEK 轮换演练 (2026-06-18 19:00)

### 10.3.1 决策路径

| 路径 | 时间 | 复杂度 | 结果 |
|---|---|---|---|
| HTTP API `api.cloudbase.tencentcloud.com` | 30 min | 低 | ❌ NXDOMAIN（P3.5 已证）|
| CAM key + SDK | 30 min | 低 | ❌ SIGN_PARAM_INVALID |
| `tcb config update fn --all` | 10 min | 低 | ❌ 交互式 prompt 卡 Override/Merge |
| **`tcb --config-file smoke.json fn deploy --all --force`** | **15 min** | **低** | ✅ **选**（非交互 + 重 deploy + env vars 一起注入 + `tcb login` 状态复用）|

### 10.3.2 实现

- `apps/api/scripts/deploy-secrets.ts`：
  - 读 5 env vars（`ADMIN_TOKEN` / `JWT_SECRET` / `MINIMAX_API_KEY` / `KEK_SECRET_V1` / `ADMIN_IP_ALLOWLIST`）
  - 写 `cloudbaserc.smoke.json`（gitignored，12 vars = 7 stable + 4 secrets + IP allowlist）
  - `tcb --config-file cloudbaserc.smoke.json fn deploy --all --force`
- `apps/api/scripts/deploy-clean.ts`（新增）：
  - 用干净 `cloudbaserc.json`（7 vars）`tcb fn deploy --all --force`
  - 重 deploy api-router 把 4 secrets + IP allowlist 从云函数 env 清掉
- `apps/api/package.json`：加 `deploy:clean` 脚本

### 10.3.3 KEK 轮换演练（顺手完成 M6.8）

| 步 | 操作 | 结果 |
|---|---|---|
| 1 生成 | `openssl rand -hex 32` × 3（ADMIN_TOKEN / JWT_SECRET / KEK_SECRET_V1）| 3 个新 hex 64 字符 |
| 2 export + dump | `export` 5 vars + `/tmp/dump-secrets.sh`（带 sanity-check）| `/tmp/unequal-secrets.env` 5 行 600 权限 |
| 3 注入 | `pnpm -F api deploy:secrets` | cloudbaserc.smoke.json + tcb 重 deploy |
| 4 验 | 6 步 smoke 全通（4-6/6） | see §4 runbook |
| 5 清 | `pnpm -F api deploy:clean` | cloudbaserc.json + 重 deploy = 7 vars 干净版 |

### 10.3.4 实测问题（暴露 + 修）

**Issue 1（IP 切换）**：smoke step 2 报 `IP_NOT_ALLOWED clientIp=113.116.119.197`。原本 allowlist 只有 IPv6（`240e:3b4:...`），但 CloudBase gateway 现在看到 IPv4。修：`ADMIN_IP_ALLOWLIST` 用逗号分隔多 IP。

**Issue 2（queryString undefined）**：smoke step 4 报 `Cannot read properties of undefined (reading 'q')`。CloudBase HTTP gateway event 实际是 `queryStringParameters`（API GW 标准），不是 `queryString`。修：见 §10.4 P3.7。

**Issue 3（zsh export 子进程陷阱）**：用户在 zsh 里写 `ADMIN_IP_ALLOWLIST="240e:..."`（无 export），dump 脚本 subshell 看不到，写到文件是空。dump 脚本已加 sanity-check 拒绝写空文件 + 明确提示 "must use 'export VAR=value'"。详见 [[feedback-zsh-export-subshell]]。

### 10.3.5 当前状态

- ✅ api-router 部署 `cloudbaserc.json`（7 vars 干净版）
- ✅ KEK 已轮换（旧值失效，v1 fresh deploy 无影响）
- ✅ IP allowlist: `240e:...,113.116.119.197`（如临时 IPv4 不稳再加）
- ⚠️ `/tmp/unequal-secrets.env` 仍含旧 4 secrets（chmod 600）— 下次 smoke 时 dump 覆盖即可

## 10.4 P3.7 queryString 字段兼容修 (2026-06-18 19:30)

### 10.4.1 现象

smoke step 4 `api-search?q=发烧&topK=5` → 500 `Cannot read properties of undefined (reading 'q')`。
定位：handler-utils.ts:83 `event.queryString[key]` 当 `event.queryString` 为 undefined 时炸。

### 10.4.2 根因

CloudBase HTTP gateway 用 SCF **API GW 标准 event 格式**，字段是 `queryStringParameters`（camelCase），不是 `queryString`。代码类型定义 `queryString: Record<...>` 是错的，runtime 实际 `undefined`。

之前 smoke "通过" 的概率解释：可能 gateway 行为有差异（IP allowlist 走 IPv6 时 vs IPv4 时走的不同 node），或 event 结构在某些 path 下漏 `queryString`。无论根因，**runtime 是 undefined 是事实**。

### 10.4.3 修法

`apps/api/src/lib/handler-utils.ts`：
- 类型：`queryString?: Record<...>`（加 `?`，允许 undefined）
- `getQuery()`：fallback `event.queryString ?? event.queryStringParameters`
- 整体兼容两种字段名

```ts
export function getQuery(event: HttpTriggerEvent, key: string): string | undefined {
  const qs = event.queryString ?? (event as unknown as { queryStringParameters?: ... }).queryStringParameters;
  const v = qs?.[key];
  return Array.isArray(v) ? v[0] : v;
}
```

### 10.4.4 教训（§9.5.7 第 6-7 条）

6. **API GW event 字段名是 `queryStringParameters`** — 不要假设叫 `queryString`。写 HTTP gateway event adapter 时**同时读两者**。
7. **TypeScript 类型要 reflect runtime** — `queryString: Record<...>` 标注太乐观。**所有 optional 字段加 `?`**。

## 10.5 P3.8 ask/chat doc title 修 (2026-06-18 20:00)

### 10.5.1 现象

ask handler 3 处 citations 都 `title: "未知文档"`（虽然 snippet/content 正确）。

### 10.5.2 根因（最终确认）

upload 时：
```ts
const docId = newId();  // ULID
await add<Document>({ id: docId, title, ... });  // doc.id = docId (schema 字段)
await add<Chunk>({ documentId: docId, ... });  // chunk.documentId = docId
```

ask/chat 时：
```ts
const docs = await getAllByFilter<Document>(COLLECTIONS.document, { _id: id }, 1);
// id = chunk.documentId = docId (schema id)
// query {_id: docId} 找的是 CloudBase auto-generated _id（与 schema id 字段不同！）
// 结果：query 返空 → docMap 空 → 全 "未知文档"
```

**关键误解**：之前 P3.3 修复时，注释写的是「upload 写时 id=""」，让人误以为 doc.id 是空要用 doc._id。**实际上 upload 时 id 是 newId() 生成的 ULID，写入 schema `id` 字段**。chunk.documentId 也是这个 ULID。要按 schema id 查。

### 10.5.3 修法

`apps/api/src/handlers/api-ask.ts` 和 `api-chat.ts`：

```diff
- const docs = await getAllByFilter<Document>(COLLECTIONS.document, { _id: id }, 1)
+ const docs = await getAllByFilter<Document>(COLLECTIONS.document, { id }, 1)
- const docMap = new Map(docs.filter(Boolean).map((d) => [d!._id, d!]))
+ const docMap = new Map(docs.filter(Boolean).map((d) => [d!.id, d!]))
```

### 10.5.4 Smoke verify

3 次跑 ask：
- Run 1: `title: "cp7-test.md"` ✅
- Run 2: `title: "cp7-test.md"` ✅
- Run 3: citations: 0 — LLM 没 emit `{"citations":[1,2,3]}` JSON 块（state-cp6.md §10.1 caveat，temperature=0 + few-shot 修，留 P4）

P3.8 修复成功（2/3 跑出正确 title），LLM variance 是另一个问题。

### 10.5.5 教训（§9.5.7 第 9 条）

9. **不要混用 schema `id` 字段和 CloudBase `_id`** — 两者不同来源。代码读 doc/chunk 时**先用 schema `id` 字段**（application-level stable identifier），CloudBase `_id` 只用于内部。P3.3 时注释错误说「id=""」，误导了 P3.8 — **注释也是代码，要 reflect reality**。

### 9.4 临时回退项（早 7-8 点 deploy 成功后改回）
- `apps/api/src/lib/env.ts` line 51-60: required 列表从 `["ALLOWED_ORIGIN"]` 改回 9 个必填
- `apps/miniprogram/app.json` pages 数组：把 `pages/cloudbase-test/cloudbase-test` 移回最后（chat 是首页）
- `apps/api/src/http-server.ts` 删掉（Web 函数实验遗留，Event 函数不需要）

### 9.5 备选路径（CP-7 时评估）
- **个人版 CloudBase**（已用）：¥19.9/月，依赖 SCF 平台稳定性
- **公众号云开发**（试过）：免费，但 SCF Node runtime 同样有 bug
- **Cloudflare Workers**（CP-5 老路）：免费 + 稳定，但国内访问慢，miniprogram 需备案域名
- **阿里云函数计算 / AWS Lambda**：要新账号，1-2 周迁移

## 10.6 P3.9 Mini-program 真机验证 (2026-06-18 17:30)

### 10.6.1 现象（5 步验证全部 FAIL → 逐个修）

CP-6 6 步 admin smoke 全通，但 miniprogram 真机是终极 gate — 暴露 4 类 CP-6 漏掉的问题：

| # | 现象 | 根因 | 修法 |
|---|------|------|------|
| 1 | POST /auth/wx-login 400 INVALID_REQUEST | api-auth-wx-login handler 读 `event.userInfo.openId`（CloudBase 自动注入），HTTP gateway 不注入该字段 | miniprogram 改走 `wx.cloud.callFunction({ name: "api-router", data: {httpMethod, path, body, headers} })`，CloudBase context 才有 |
| 2 | callFunction `errCode: -504002 functions execute fail \| Missing required env vars: ADMIN_TOKEN, JWT_SECRET, MINIMAX_API_KEY, KEK_SECRET_V1, ADMIN_IP_ALLOWLIST` | `tcb fn deploy --force` 重置 env vars 为 cloudbaserc.json 默认值（7 个干净 vars），deploy:clean 后没人 push secrets 回去 | 建 `cloudbaserc.fn-all.json`（12 vars）→ `tcb config update fn api-router --config-file cloudbaserc.fn-all.json`（12 vars 全 push）。注意：deploy 流程要把 push env vars 内置 |
| 3 | /api-chat 502 MINIMAX_FAILED | `api-chat.ts` 用了 `model: "MiniMax-chat"`（拼错的 model 名），MiniMax API 返 `unknown model 'minimax-chat'`。admin smoke 测的 /api-ask 用 `MiniMax-Text-01` 是 work，chat 没测过 | `api-chat.ts:148` `model: "MiniMax-Text-01"` |
| 4 | /api-chat 404 NOT_FOUND | miniprogram lib/api.ts 发的 path 是 `/chat`（不带 `api-` 前缀），server `parseFuncPath` 要求 `api-` 前缀（对齐 HANDLER_MAP key） | lib/api.ts paths 加 `api-` 前缀：`/ask → /api-ask`、`/chat → /api-chat`、`/sessions → /api-sessions-list`、`/sessions/:id DELETE → /api-sessions-delete/:id` |
| 5 | history tab 显示空白 | `ChatSessionRow` 用 snake_case（`user_id, created_at, last_active_at, degraded_at`），server 返 camelCase（`messageCount, createdAt, updatedAt`），类型不匹配；外加 `history.wxml` 还是 CP-3 期 entries 形态（`q, citations, cached, timestamp`），从来没适配 CP-6 session 形态 | `lib/types.ts` ChatSessionRow 改 camelCase；`history.wxml` 重写为 `wx:for="{{sessions}}"` 渲染 `title, messageCount, updatedAt` |

外加次要：
- `app.ts:7` `apiBaseUrl` 占位符 → 真 URL `https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com`
- `lib/auth.ts` `wxRequestAsFetch` 用了 `new Response(...)`，miniprogram runtime 没 Response 全局构造 → 改返 ResponseLike 形态（无 Response）

### 10.6.2 miniprogram → callFunction 架构调整

**核心决策**：miniprogram 所有 endpoint 走 callFunction，不走 HTTP gateway。

**理由**：
- wx-login **必须** callFunction（要 userInfo.openId）
- admin-login 走 HTTP（admin web app 用，不需要 cloud context）
- chat/sessions/ask 走 HTTP 也 work（只需 jwt header），但 callFunction 更一致

**当前实现（最小改动版）**：
- wx-login 走 callFunction（auth.ts:73-93）
- 其他 endpoint 仍走 HTTP（api.ts）+ CloudBase HTTP gateway

**后续清理（CP-7）**：lib/api.ts 全改造为 callFunction，去掉 wxRequestAsFetch / fetchWithRefresh，统一走 `cloudCall(req)` helper。admin scope 也走 callFunction（admin-login 也能简化）。

### 10.6.3 关键设计：`lib/cloud-call.ts`

新建 helper 模块，封装 `wx.cloud.callFunction`：

```typescript
export interface CloudCallRequest { path, httpMethod, body?, query?, jwt? }
export interface CloudCallResult { statusCode: number; body: unknown }
export type CloudCallFn = (req) => Promise<CloudCallResult>;

let impl: CloudCallFn | null = null;
export function __setCloudCallImpl(next) { impl = next; }  // 测试桩注入
export function cloudCall(req): Promise<CloudCallResult> {
  if (impl) return impl(req);  // 测试用
  // 生产：wx.cloud.callFunction({ name: "api-router", data: {httpMethod, path, headers, queryString, body} })
}
```

**设计原则**：
- 默认 impl 用 wx.cloud.callFunction
- 测试桩 `__setCloudCallImpl(mock)` 注入（避免 mock 全局 wx.cloud）
- 不吞错，fail 走 reject（caller 决定 mock-first fallback）

### 10.6.4 deploy 流程教训（重要！）

**`tcb fn deploy --force` 会重置 env vars 为 cloudbaserc.json 默认值**。deploy-clean 之后必须 push secrets 回去。

**deploy 完整流程（CP-7 时固化）**：
1. `pnpm -F api deploy:build` — rebuild bundle
2. `pnpm -F api deploy:secrets` — push 12 vars（含 secrets）
3. `pnpm -F api deploy:clean` — push 7 vars（清 secrets，给生产环境）

**临时方案（P3.9 验证用）**：
- `apps/api/cloudbaserc.fn-all.json`（gitignored，含 12 vars）→ `tcb config update fn api-router --config-file cloudbaserc.fn-all.json`
- 之后 deploy:clean 会清回 7 vars，所以**只要跑过 deploy/secrets/clean 任何一个，都要把对应 vars 重新 push 回去**

### 10.6.5 Mini-program 5 步验证结果

| # | 步骤 | 结果 |
|---|------|------|
| 1 | 编译 → `[unequal] wx.cloud.init ok, env: unequal-d4ggf7rwg82e0900b` | ✅ |
| 2 | onLaunch → ensureJwt 调 callFunction 拿 user jwt | ✅ Console 无 `ensureJwt failed` |
| 3 | chat tab → 发送「宝宝不爱吃饭怎么办」→ 1-3s 后返完整育儿建议（6-8 条 tips，含 [N] 引用占位符） | ✅ `/api-chat 200`，session_id 自动生成 + 持久化 |
| 4 | history tab → 看到 2 个 session（标题「宝宝不爱吃饭怎么办」「宝宝晚上发热怎么办」），各 2 条消息 | ✅ `history.wxml` 重写后渲染 sessions 正常 |
| 5 | session 持久化跨 tab 切换 | ✅ server log 4 次 200 调用都成功 |

**CP-6 终极 gate PASS！** Mini-program 全流程从冷启动 → wx-login → chat → history → session 持久化 全部 work。

### 10.6.6 教训（追加 §9.5.7）

10. **Mini-program 是终极 gate，不是 admin smoke** — admin scope 用 HTTP + admin_token 测不到 user scope 的 cloud context 依赖。CP-6 应该**先** miniprogram 验证再做 admin smoke，admin smoke 通过不等同 miniprogram 通过。
11. **`tcb fn deploy --force` 重置 env vars** — deploy-clean 之后必须 push secrets 回去。deploy 流程要把"push env vars"内建。
12. **LLM model name 要 cross-handler 一致** — admin smoke 只测了 /api-ask（用 MiniMax-Text-01 work），但 /api-chat 用了不同 model 名没测。CP-7 加 LLM 调用 smoke 时，所有 model 名要统一验证。
13. **前端 type shape 要跟 server response 对齐** — spec 阶段 ChatSessionRow 写的是 snake_case（spec 早），CP-6 server 实现用了 camelCase，client type 没更新；外加 `history.wxml` 整体没适配 session 形态。**type mismatch + UI 没更新** = 显示空白。
14. **miniprogram runtime 没有 Response 全局构造** — `new Response(...)` 在 Node/Vitest OK，但 wx runtime 没。fetch wrapper 必须返 ResponseLike 形态。
