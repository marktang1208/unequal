# CP-5 — 真接 Cloudflare

**版本**: 2026-06-16
**前置**: M0–M6.10 全 merge（最新 `c59abbb` M6.10 admin IP allowlist）；mock-first 阶段代码完整；本 spec 把 mock 推到真 CF
**范围**: 把 apps/api Worker + 5 个 binding + 5 secret + 1 var 真接到 Cloudflare 账号；跑 6 步 smoke；改 miniprogram apiBaseUrl；commit + state doc 收尾

> **不是 feature spec** — 是 deployment integration spec。结构借鉴 M6.10 spec 但侧重点不同（操作 + 验证 gate，不是新代码）。

---

## 1. Requirements

| # | 现状 | 目标 |
|---|---|---|
| R-1 | apps/api Worker mock-first（wrangler dev 本地）| 真 deploy 到 CF Workers，公网 URL 可达 |
| R-2 | D1 `PLACEHOLDER_DATABASE_ID` 占位 | 真 D1 db 创建 + 9 migration apply（skip 0002_dev_seed）|
| R-3 | Vectorize `unequal-chunks` 仅 wrangler.jsonc 声明 | 真 index 创建（dimensions=1536 假设）|
| R-4 | R2 `unequal-storage` 仅 wrangler.jsonc 声明 | 真 bucket 创建 |
| R-5 | secrets 仅在 `.dev.vars`（gitignored）| 5 个 secret 经 `wrangler secret put` 注入（ADMIN_TOKEN / JWT_SECRET / MINIMAX_API_KEY / CRON_SECRET / KEK_SECRET_V1）|
| R-6 | `JWT_SECRET` / `CRON_SECRET` 在 wrangler.jsonc vars | 移出 vars（生产用 secret 更安全）|
| R-7 | `ADMIN_IP_ALLOWLIST` 未配（M6.10 留口）| var 注入 admin 静态 IP |
| R-8 | miniprogram `apiBaseUrl = http://localhost:8787` | 改为 `https://unequal-api.<subdomain>.workers.dev` |
| R-9 | M6-3a / M6-10 state 留的"CP-5 真接时验"未跑 | 关闭 §8 列表 |

**为什么 YAGNI 精简**（= 本 spec 不做的事）：
- ❌ 不做 mini-program 真机验证（需 AppID 注册，独立 checkpoint）
- ❌ 不做 custom domain（CF workers.dev 够用；本轮不引入 zone/路由）
- ❌ 不做 `/crawl` endpoint 补全（admin `/upload` 路径已覆盖上传场景）
- ❌ 不做 `/chat` `/sessions/*` 完整测（admin 测试场景不需要；M6.1 单独状态覆盖）
- ❌ 不做 cron 手动 trigger（Cron Triggers 自动；看 wrangler triggers list 即可）
- ❌ 不做监控告警（CF free plan 自带 wrangler tail；不接 Datadog/Sentry）
- ❌ 不做数据迁移（"老 user 重 login 自然升级"是 passive，无需主动操作）

---

## 2. Resources to Create

### 2.1 Cloudflare 资源清单（5 个全新建）

| 资源 | 名称 | 命令 | 幂等 |
|---|---|---|---|
| D1 database | `unequal-db` | `wrangler d1 create unequal-db` | grep list 后 skip |
| Vectorize index | `unequal-chunks` | `wrangler vectorize create unequal-chunks --metric=cosine --dimensions=1536` | grep list 后 skip |
| R2 bucket | `unequal-storage` | `wrangler r2 bucket create unequal-storage` | grep list 后 skip |
| Durable Object | `ChatSessionDO` | 随 Worker 首次 deploy 自动创建（migration tag `v1`）| n/a |
| Worker | `unequal-api` | `wrangler deploy`（§6 step 9） | n/a（每次 deploy 都覆盖）|

### 2.2 Vectorize dimensions 假设

**假设 `1536`**（与 OpenAI `text-embedding-3-small` / 多数 embedding provider 默认一致）。

**风险**：如果 MiniMax embedding 实际输出维度不是 1536（可能是 1024 / 768 / 3072），§4 步骤 4 创建会成功但 §6 步骤 10 smoke step 3 upload 时 Vectorize insert 报错 dimension mismatch。

**缓解**：§6 步骤 4 后立刻跑 `pnpm -F shared test` 或读 `packages/shared/src/embedding.ts` 确认 MiniMax embedding 输出维度；如不符，destroy + recreate。

---

## 3. Secrets to Inject（5 个）

| Secret | 来源 | 生成命令 | 长度要求 |
|---|---|---|---|
| `ADMIN_TOKEN` | 你生成 | `openssl rand -hex 32` | 64 hex 字符（≥32 字节）|
| `JWT_SECRET` | 你生成 | `openssl rand -hex 32` | 同上 |
| `MINIMAX_API_KEY` | platform.MiniMax.io | — | 你已有 |
| `CRON_SECRET` | 你生成 | `openssl rand -hex 32` | 同上 |
| `KEK_SECRET_V1` | 你生成 | `openssl rand -hex 32` | 同上 |

**注入方式**：`pnpm wrangler secret put <NAME>`（每次会提示输入值；你贴值；我跑命令）。

**WX_APP_SECRET 显式 defer**（无 mini-program 真机；下一轮 cp-6 再注）。

**dev fallback**：`apps/api/.dev.vars` 保留 dev 值（gitignored）；secret 注入只影响 remote。

---

## 4. Vars to Set（2 个新增 + 2 个改值 + 1 个保留）

| Var | 现状 | CP-5 值 | 来源 |
|---|---|---|---|
| `ADMIN_IP_ALLOWLIST` | 无 | `"<你的公网 IP>"` | ifconfig.me |
| `MINIMAX_BASE_URL` | **仅 `.dev.vars`，wrangler.jsonc 没声明** ⚠️ | `"https://api.MiniMax.chat/v1"` | .dev.vars.example 已有；移到 vars |
| `ENVIRONMENT` | `"development"` | `"production"` | wrangler.jsonc 改 |
| `JWT_SECRET` | `"dev-jwt-secret-change-me-..."` | _删除_ | wrangler.jsonc 删（改走 secret）|
| `CRON_SECRET` | `"dev-cron-secret-change-me-..."` | _删除_ | wrangler.jsonc 删（改走 secret）|

**保留**（不变）：`ALLOWED_ORIGIN` (`*`) / `AUTH_MODE` (`admin_token`) / `WX_APP_ID` (placeholder) / `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MS`。

> ⚠️ **`MINIMAX_BASE_URL` 必填**（`apps/api/src/types.ts:7` `MINIMAX_BASE_URL: string` 无 `?`；`ask.ts` / `search.ts` / `upload.ts` 都用 `env.MINIMAX_BASE_URL`）。生产 deploy 不设 → ask/search/upload 运行时崩。本 spec §5 同步加。

---

## 5. wrangler.jsonc Changes（5 项）

```diff
   "vars": {
-    "ENVIRONMENT": "development",
+    "ENVIRONMENT": "production",
     "ALLOWED_ORIGIN": "*",
     "AUTH_MODE": "admin_token",
     "WX_APP_ID": "wx_development_placeholder",
-    "JWT_SECRET": "dev-jwt-secret-change-me-in-production-32-bytes-min",
+    "MINIMAX_BASE_URL": "https://api.MiniMax.chat/v1",
+    "ADMIN_IP_ALLOWLIST": "<your-ip>",
     "LOGIN_MAX_ATTEMPTS": "5",
     "LOGIN_WINDOW_MS": "900000",
-    "CRON_SECRET": "dev-cron-secret-change-me-in-production"
   },
   ...
   "d1_databases": [
     {
       "binding": "DB",
       "database_name": "unequal-db",
-      "database_id": "PLACEHOLDER_DATABASE_ID",
+      "database_id": "<real-id-from-wrangler-d1-create>",
       "migrations_dir": "migrations"
     }
   ],
```

---

## 6. D1 Migrations to Apply（9 个，skip 0002_dev_seed）

```
0001_init                   -- source / document / chunk / query_cache
0003_query_cache            -- query_cache (M6.x)
0004_chat_session           -- chat_session (M6.1)
0005_login_attempt          -- login_attempt (M6.3a)
0006_user_session_key       -- user.session_key (M6.7)
0007_login_attempt_created_at_index  -- index (M6.x)
0008_login_attempt_client_ip         -- client_ip column (M6.x)
0009_user_session_key_envelope        -- envelope format (M6.7)
0010_user_session_key_kek_version    -- version column (M6.8)

-- 0002_dev_seed SKIP: dev-only seed data，不上生产
```

**Apply 方式**（推荐）：
```bash
cd apps/api
for m in 0001_init 0003_query_cache 0004_chat_session 0005_login_attempt \
         0006_user_session_key 0007_login_attempt_created_at_index \
         0008_login_attempt_client_ip 0009_user_session_key_envelope \
         0010_user_session_key_kek_version; do
  pnpm wrangler d1 migrations apply unequal-db --remote "$m"
done
```

**验证**：
```bash
pnpm wrangler d1 execute unequal-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
# 应见：chat_session / chunk / document / login_attempt / query_cache / source / user（7 张）
```

---

## 7. Deployment Steps（顺序 12 步，每步有验证 gate）

| # | 步骤 | 动作 | 验证 gate | 失败处理 |
|---|---|---|---|---|
| 1 | Preflight | 你生成 IP + 4 hex 串 + 备好 MiniMax key | 你手上有 1 IP + 4 hex + 1 key | 装 openssl / 重开 ifconfig.me |
| 2 | wrangler login | 你跑 `pnpm wrangler login`（OAuth 浏览器）| 终端 "logged in" | 清 `~/.config/.wrangler/config/default.toml` 重试 |
| 3 | Capture account info | 我跑 `wrangler whoami` + `wrangler deploy --dry-run` | 拿到 Account ID + subdomain + wrangler.jsonc 解析无错 | §9.1 |
| 4 | Create 资源 | 我跑 3 个 create（d1 / vectorize / r2），含 grep 幂等检查 | `wrangler d1/vectorize/r2 list` 全见 | "limit reached" 暂停决策 |
| 5 | wrangler.jsonc 改 | 我改 4 项（§5 diff）| 你目视 `git diff` | `git checkout` 还原 |
| 6 | Secret put（5x）| 我跑 `wrangler secret put X`，你贴值 | `wrangler secret list` 见 5 个 | `wrangler secret delete X` 重 put |
| 7 | Var ADMIN_IP_ALLOWLIST | §4（已写进 wrangler.jsonc §5 改动）| deploy 后 `wrangler tail` 看 env | 改 wrangler.jsonc 重 deploy |
| 8 | Migration apply | §6 for 循环跑 9 个 | D1 7 张表 | `wrangler d1 migrations list` 看已 applied；失败 migration 手工 SQL 补 |
| 9 | Deploy | 我跑 `wrangler deploy` | 拿到 `https://unequal-api.<subdomain>.workers.dev` | 看编译错（binding / import path）|
| 10 | Smoke 6 步 | §8 curl | 全 200 / 期望响应 | §9.1 对应行 |
| 11 | miniprogram apiBaseUrl | 我改 `apps/miniprogram/<config>` | `grep apiBaseUrl` | `git checkout` 还原 |
| 12 | Commit + state doc | 我 commit + 写 `state-cp5.md` + README CP-5 节 + push（你说才 push）| `git log` 见 CP-5 hash | rebase / fix conflict |

---

## 8. Smoke Test（6 步，§7 step 10 展开）

```bash
export API="https://unequal-api.<subdomain>.workers.dev"
export TOKEN="<你的 ADMIN_TOKEN>"

# Step 1: health
curl -sf $API/health | jq
# 期望: { ok: true, ... }

# Step 2: admin login
JWT=$(curl -sf -X POST $API/auth/admin-login \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\"}" | jq -r .jwt)
# 期望: JWT 字符串；D1 可读 + JWT_SECRET 已生效

# Step 3: upload（小 MD 文件）
echo "# test\n5个月宝宝发烧38.5要观察精神状态" > /tmp/cp5-test.md
curl -sf -X POST $API/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/tmp/cp5-test.md" | jq
# 期望: { document_id, chunks: ≥1 }
# 验证: R2 写 + Vectorize insert + D1 写

# Step 4: search
curl -sf "$API/search?q=发烧" -H "Authorization: Bearer $TOKEN" | jq '.results | length'
# 期望: ≥1（Vectorize 真检索出刚 upload 的 chunk）

# Step 5: ask
curl -sf -X POST $API/ask \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"q":"5个月宝宝发烧怎么办"}' | jq
# 期望: { answer, citations: [≥1] }
# 验证: 完整 RAG 链路；citation 编号映射回 chunk

# Step 6: stats
curl -sf $API/stats/login-attempts -H "Authorization: Bearer $TOKEN" | jq
# 期望: 200 { ... }；D1 读 + admin auth 链路完整
```

---

## 9. Error Handling / Rollback

### 9.1 每步失败处理（见 §7 表最后一列）

**关键风险点**：

| 风险 | 缓解 | 严重度 |
|---|---|---|
| **Vectorize dimensions 不匹配** MiniMax embedding | §2.2 提前验证；不符则 destroy + recreate | HIGH |
| **wrangler.jsonc 改错** | `git checkout` 还原 | LOW |
| **secret 值贴错** | `wrangler secret delete` 重 put | LOW |
| **migration 某步失败** | `wrangler d1 migrations list` 看状态；失败 migration 手工 SQL 补 | MEDIUM |
| **ADMIN_IP_ALLOWLIST 配错** | `wrangler vars delete` + 重 deploy | LOW |
| **Mini-program apiBaseUrl 改错** | `git checkout` 还原 | LOW |

### 9.2 全局回滚（abort 时）

```bash
# 1. Worker 销毁（最先）
pnpm wrangler delete

# 2. miniprogram apiBaseUrl 回滚
git checkout HEAD~1 -- apps/miniprogram/<config file>

# 3. Vars / Secrets 清
pnpm wrangler secret delete ADMIN_TOKEN JWT_SECRET MINIMAX_API_KEY CRON_SECRET KEK_SECRET_V1
pnpm wrangler vars delete ADMIN_IP_ALLOWLIST

# 4. Resources 销毁（可选）
pnpm wrangler d1 delete unequal-db
pnpm wrangler vectorize delete unequal-chunks
pnpm wrangler r2 bucket delete unequal-storage
```

**可逆性**：
- D1 数据 / R2 文件 / Vectorize 索引 销毁均不可逆（除非有备份）
- Worker URL 销毁后同名可重 deploy
- wrangler.jsonc 改动通过 `git revert` 完全可逆

### 9.3 安全事件响应（secret 泄漏）

```bash
# 1. 立即 rotate 源头
# MINIMAX_API_KEY → platform.MiniMax.io revoke + regenerate

# 2. 注入新值
pnpm wrangler secret put <NAME>

# 3. 验证
pnpm wrangler secret list
curl <your-worker-url>/health
```

**KEK_SECRET_V1 轮换注意**：rotate KEK 会让老 user session_key 无法解密（除非 KEK_SECRET_V2 也配 fallback）。本轮只注入 V1，不主动 rotate；如发现泄漏：
- 生成 KEK_SECRET_V2（新值）+ secret put
- 老 user 重 login 时 M6.8 fallback 会尝试 V1 仍能解
- 强制升级需主动 wrap（M6.8 spec 已留口，本轮不动）

---

## 10. Closing Deferred Items

### 10.1 来自 M6-3a `dev 验证缺口（CP-5 真接时补）`

| # | 项 | 验证方式 | 关闭条件 |
|---|---|---|---|
| D-1 | admin upload/search/ask/chat/crawlUrl 真实 401 跳 /login | smoke step 3-6 验 admin auth 链路；admin 端 dev server 实跳 /login | curl 401 + admin 实跳 |
| D-2 | D1 表初始化验证 | §6 migration apply 后 d1 execute 查表 | 7 张表全在 |
| D-3 | /login 输错 5 次第 6 次 429 | smoke step 2 旁路：错误 token 连发 6 次 | 第 6 次 429 |

### 10.2 来自 M6-10 `dev 验证缺口（CP-5 真接时补）`

| # | 项 | 验证方式 | 关闭条件 |
|---|---|---|---|
| D-4 | ADMIN_IP_ALLOWLIST 真实生效 | smoke 旁路：从非 allowlist IP（curlbin.io）调 /auth/admin-login | 403 / 拒（M6.10 实际行为）|
| D-5 | 静态 IP 变更流程文档化 | 写进 `state-cp5.md` "Admin IP 变更 SOP" | 文档落地 |

### 10.3 来自 `docs/webpage-crawler-setup.md` §6.1

| # | 项 | 验证方式 | 关闭条件 |
|---|---|---|---|
| D-6 | Vectorize 远端 binding 真接 | smoke step 3 upload 成功后 step 4 search 能召回 | chunks ≥1 且 search 召回 ≥1 |

---

## 11. Acceptance Criteria

### 11.1 功能 AC

| # | 标准 |
|---|---|
| AC-1 | 5 个 CF 资源全创建（D1 / Vectorize / R2 / DO / Worker）|
| AC-2 | wrangler.jsonc 4 项改动全到位（§5 diff）|
| AC-3 | 5 个 secret 经 `wrangler secret put` 注入（`wrangler secret list` 见）|
| AC-4 | ADMIN_IP_ALLOWLIST var 注入（deploy 后 `wrangler tail` 看 env）|
| AC-5 | 9 个 migration applied（skip 0002_dev_seed）；D1 7 张表全在 |
| AC-6 | Worker 真 deploy，公网 URL `https://unequal-api.<subdomain>.workers.dev` 可达 |
| AC-7 | smoke 6 步全过（§8）|
| AC-8 | miniprogram apiBaseUrl 改 https URL |

### 11.2 关闭 AC（deferred 项）

| # | 标准 |
|---|---|
| AC-9 | §10.1 D-1 / D-2 / D-3 关闭 |
| AC-10 | §10.2 D-4 / D-5 关闭 |
| AC-11 | §10.3 D-6 关闭 |

### 11.3 文档 AC

| # | 标准 |
|---|---|
| AC-12 | `docs/archive/state/state-cp5.md` 收尾（含 URL + smoke 输出 + commit hash + Admin IP 变更 SOP）|
| AC-13 | `README.md` 加 CP-5 节 |
| AC-14 | `docs/archive/plans/2026-06-16-cp5-real-cloudflare.md`（plan 文件，本 spec 通过后由 writing-plans skill 生成）|

### 11.4 Dev 验证 AC（CP-5 之外的下轮真接）

- 真实 mini-program 真机扫码（需先注册 AppID → 下轮 cp-6）
- 真实 cron 触发（次日 03:00 UTC 自动；或手工 trigger 看 log）
- 真实 IPv6 admin IP allowlist 验证（如果 admin 是 IPv6）

---

## 12. Risk Register

| # | 风险 | 缓解 | 严重度 |
|---|---|---|---|
| R-1 | Vectorize dimensions 不匹配 MiniMax embedding | §2.2 提前验证；不符则 destroy + recreate | HIGH |
| R-2 | ADMIN_TOKEN / JWT_SECRET 泄漏（chat 留痕）| 你生成时本地跑 openssl，不在 chat 贴明文 secret 全值（只贴首尾字符验证） | MEDIUM |
| R-3 | Cloudflare 免费 plan 限额超 | D1 10 个 / R2 10 bucket / Vectorize 100 index 远不到；监控 wrangler tail 报错 | LOW |
| R-4 | Worker URL 公开可访问 | ADMIN_IP_ALLOWLIST + admin_token auth 双层防御 | MEDIUM |
| R-5 | 静态 IP 变更（你换网络后 admin IP 变了）| §10.2 D-5 SOP 文档化 | LOW |
| R-6 | Mini-program 真机行为 ≠ 浏览器模拟器（下一轮 cp-6 风险，本轮不触发）| n/a | n/a |

---

## 13. Execution Workflow

### 13.1 主线程驱动

- **我跑** wrangler 命令（d1 create / vectorize create / r2 create / secret put / deploy / smoke curl）
- **你跑** 一次 `wrangler login`（OAuth）+ 每次 `wrangler secret put X` 时贴值 + preflight 准备 4 个 hex + IP
- 所有破坏性/创建性命令在 chat 全程可见，不会偷偷发生

### 13.2 Commit 拆分（4 commit + 1 merge）

| # | Commit | 主题 | 何时 |
|---|---|---|---|
| 1 | spec | `docs: CP-5 spec — 真接 Cloudflare` | 本 spec 落地 |
| 2 | plan | `docs: CP-5 plan — 真接 Cloudflare (12 step / X CP)` | writing-plans skill 生成 |
| 3 | code+config | `chore(api): CP-5 — wrangler.jsonc 真接 (D1 id + vars + secrets placeholder)` | §7 step 5 改完（5 项改动）|
| 4 | state + README | `docs: CP-5 state-cp5.md 收尾 + README CP-5 节` | §7 step 12 完 |
| merge | `→ master --no-ff` | — | 你说 merge |

**总 4 commit + 1 merge = 5 总**

### 13.3 worktree 策略

- CP-5 真接 不需要隔离 worktree（操作集中 + 一次性 deploy；worktree 隔离增加复杂度）
- 直接在 master 上做（与 M6.10 同一节奏）

---

## 14. YAGNI / Explicit Non-Goals

本 spec **显式不做**：
- ❌ Mini-program 真机验证（→ 下轮 cp-6）
- ❌ Custom domain / CF for SaaS / route 配置
- ❌ `/crawl` endpoint 补全（admin `/upload` 已覆盖）
- ❌ `/chat` `/sessions/*` 完整测（M6.1 单独覆盖）
- ❌ Cron 手工 trigger（Cron Triggers 自动）
- ❌ 监控告警（CF free 自带 wrangler tail）
- ❌ 数据迁移（passive，重 login 自然升级）
- ❌ KEK 轮换（M6.8 留口；本轮只注入 V1）
- ❌ 单元测试新增（CP-5 不加新代码；M0-M6 累计 287 用例已稳）

---

## 附录 A：Admin IP 变更 SOP（§10.2 D-5 落地内容）

**触发**：admin 换网络（公司 → 家 / 移动热点 / 旅行）→ 静态 IP 变 → admin /upload 等收 403。

**流程**：
1. 查新 IP：浏览器 `ifconfig.me`
2. 我跑 `pnpm wrangler vars set ADMIN_IP_ALLOWLIST "<新 IP>"`
3. 验证：`curl -sf https://unequal-api.<subdomain>.workers.dev/health` → 200

**频率**：通常几个月一次（家庭宽带）/ 极少（公司固定 IP）/ 每次换网络（移动）。

**多 IP 支持**：comma-separated；如要同时支持公司 + 家 + 移动，写成 `"1.2.3.4,5.6.7.8,9.9.9.9"`。

---

## 附录 B：CP-5 真接决策清单（参考 M6.10 spec §11 格式）

- 5 secret 注入：ADMIN_TOKEN / JWT_SECRET / MINIMAX_API_KEY / CRON_SECRET / KEK_SECRET_V1
- 2 secret 从 vars 移除：JWT_SECRET / CRON_SECRET
- 1 var 新增：ADMIN_IP_ALLOWLIST
- 1 var 新增：MINIMAX_BASE_URL（**关键**：types.ts 必填，原先只在 .dev.vars）
- 1 var 改值：ENVIRONMENT="production"
- 1 D1 真创建：unequal-db
- 1 Vectorize 真创建：unequal-chunks（dimensions=1536）
- 1 R2 真创建：unequal-storage
- 9 migration applied（skip 0002_dev_seed）
- 1 Worker 真 deploy
- 1 miniprogram apiBaseUrl 改 https URL