# CP-5 — 真接 Cloudflare 收尾

**完成日期**：2026-06-16
**前置 commits**：spec `863014a` / plan `2ecdc14` / wrangler.jsonc `88a26ef` / app.ts（待 commit）
**Worker URL**：`https://unequal-api.yydsnews.workers.dev`
**Worker Version ID**：`58e0a2fe-7507-4e05-94b9-4bc251d122de`

---

## 1. 摘要

把 mock-first 的 apps/api Worker 真接到 Cloudflare 账号。完成 5 个 CF 资源创建 + 5 secret 注入 + 9 migration apply + Worker 真 deploy + miniprogram apiBaseUrl 切 https。

**核心成果**：
- Worker 真在 CF 跑（CF 端验证 deploy / secret list / D1 execute 全过）
- miniprogram `apiBaseUrl` 已切到 `https://unequal-api.yydsnews.workers.dev`
- Wrangler.jsonc 5 项改动到位（含 `ADMIN_IP_ALLOWLIST` 你的 IPv6）
- 8 张应用表 + CF 内部 `_cf_KV` 已建

**重要 caveat**：用户（admin）所在网络阻所有 CF 域（`workers.dev` + `*.devprod.cloudflare.dev`），**端到端 smoke 无法在本机执行**。详见 §6。

---

## 2. 资源清单

| 资源 | 名称 | ID / 配置 | 验证方式 | 通过 |
|---|---|---|---|---|
| Worker | `unequal-api` | URL `https://unequal-api.yydsnews.workers.dev` | `pnpm wrangler deploy` 输出 | ✅ |
| D1 | `unequal-db` | `11617a27-81da-4459-a8f5-c8ab1d7afb52` (WNAM) | `pnpm wrangler d1 list` | ✅ |
| Vectorize | `unequal-chunks` | 1536 dims, cosine | `pnpm wrangler vectorize list` | ✅ |
| R2 bucket | `unequal-storage` | Standard class | `pnpm wrangler r2 bucket list` | ✅ |
| Durable Object | `ChatSessionDO` | 随 Worker deploy | (deploy OK 即代表 OK) | ✅ |
| Cron Trigger | `0 3 * * *` | daily UTC 03:00 | deploy 输出确认 | ✅ |
| Account | Mark_tang@163.com | `ef7b3a58c86937132f41f95074112886` | `pnpm wrangler whoami` | ✅ |
| Subdomain | yydsnews | — | deploy URL | ✅ |

**创建命令**（含 idempotent check 模式）：
```bash
pnpm wrangler d1 list | grep -q unequal-db || pnpm wrangler d1 create unequal-db
pnpm wrangler vectorize list | grep -q unequal-chunks || pnpm wrangler vectorize create unequal-chunks --metric=cosine --dimensions=1536
pnpm wrangler r2 bucket list | grep -q unequal-storage || pnpm wrangler r2 bucket create unequal-storage
```

---

## 3. Secrets 注入（5 个）

| Secret | 来源 | 注入方式 |
|---|---|---|
| `ADMIN_TOKEN` | `openssl rand -hex 32` | `wrangler secret bulk /tmp/cp5-secrets.json` |
| `JWT_SECRET` | `openssl rand -hex 32` | 同上 |
| `MINIMAX_API_KEY` | platform.MiniMax.io | 同上 |
| `CRON_SECRET` | `openssl rand -hex 32` | 同上 |
| `KEK_SECRET_V1` | `openssl rand -hex 32` | 同上 |

**`WX_APP_SECRET` 显式 defer**（cp-6 mini-program 真机时再注）。

**注入流程**：
1. 用 `openssl rand -hex 32` 生成 4 个 hex + 准备 MiniMax key
2. 写 `/tmp/cp5-secrets.json`（5 个 key 全部填入；`chmod 600`）
3. `pnpm wrangler secret bulk /tmp/cp5-secrets.json`（wrangler 3.x 自动创建 Worker shell 存 secrets）
4. `pnpm wrangler secret list` 验证 5 个全列
5. `shred -u /tmp/cp5-secrets.json` 安全删除

**注意**：wrangler secret bulk 自动创建的 Worker shell 是占位（无代码），Step 9 `wrangler deploy` 用真代码覆盖。

---

## 4. Vars 改动

### wrangler.jsonc 5 项 diff

```diff
   "vars": {
-    "ENVIRONMENT": "development",
+    "ENVIRONMENT": "production",
     "ALLOWED_ORIGIN": "*",
     "AUTH_MODE": "admin_token",
     "WX_APP_ID": "wx_development_placeholder",
-    "JWT_SECRET": "dev-jwt-secret-change-me-in-production-32-bytes-min",
+    "MINIMAX_BASE_URL": "https://api.MiniMax.chat/v1",
+    "ADMIN_IP_ALLOWLIST": "240e:3b4:38ed:4100:10a1:f77f:f362:d8b0",
     "LOGIN_MAX_ATTEMPTS": "5",
-    "LOGIN_WINDOW_MS": "900000",
-    "CRON_SECRET": "dev-cron-secret-change-me-in-production"
+    "LOGIN_WINDOW_MS": "900000"
   },
   "d1_databases": [
     {
       "binding": "DB",
       "database_name": "unequal-db",
-      "database_id": "PLACEHOLDER_DATABASE_ID",
+      "database_id": "11617a27-81da-4459-a8f5-c8ab1d7afb52",
       "migrations_dir": "migrations"
     }
   ],
```

**关键修复**：`MINIMAX_BASE_URL` 在 `apps/api/src/types.ts:7` 是必填（无 `?`），原先 wrangler.jsonc 没声明；生产 deploy 后 `ask`/`search`/`upload` 会因 env 未注入运行时崩。本 spec §5 diff 加这行。

---

## 5. D1 Migrations（9 个 apply，skip 0002_dev_seed）

```bash
for m in 0001_init 0003_query_cache 0004_chat_session 0005_login_attempt \
         0006_user_session_key 0007_login_attempt_created_at_index \
         0008_login_attempt_client_ip 0009_user_session_key_envelope \
         0010_user_session_key_kek_version; do
  pnpm wrangler d1 execute unequal-db --remote --file=migrations/$m.sql
done
```

**验证（D1 表列表）**：
```
_cf_KV (CF internal)
chat_session       (M6.1)
chunk              (M0/M1)
crawl_job          (in 0001_init; /crawl 路径未实现但 schema 预留)
document           (M0/M1)
login_attempt      (M6.3a)
query_cache        (M2)
source             (M0/M1)
user               (M0/M1)
```

8 张应用表 + CF 内部 KV。**0002_dev_seed 未 apply**（dev-only seed data，不上生产）。

---

## 6. Smoke Test — DEFERRED（网络阻塞）

### 6.1 期望的 6 步 smoke（plan §4 Step 10）

```bash
API="https://unequal-api.yydsnews.workers.dev"
TOKEN="<ADMIN_TOKEN>"

# Step 1: health
curl -sf $API/health

# Step 2: admin login
curl -sf -X POST $API/auth/admin-login -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\"}"

# Step 3: upload
echo "..." > /tmp/cp5-test.md
curl -sf -X POST $API/upload -H "Authorization: Bearer $TOKEN" -F "file=@/tmp/cp5-test.md"

# Step 4: search
curl -sf "$API/search?q=发烧" -H "Authorization: Bearer $TOKEN"

# Step 5: ask
curl -sf -X POST $API/ask -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"q":"5个月宝宝发烧怎么办"}'

# Step 6: stats
curl -sf $API/stats/login-attempts -H "Authorization: Bearer $TOKEN"
```

### 6.2 实际执行结果 — DEFERRED

**试过 3 种方式，全部失败（用户网络问题，不是配置问题）**：

| 方式 | 命令 | 失败原因 |
|---|---|---|
| **直接 curl workers.dev** | `curl https://unequal-api.yydsnews.workers.dev/health` | TCP connect timeout（port 443 连不上） |
| **浏览器** | Chrome / Safari 打开 URL | 卡 loading，最终 timeout |
| **`wrangler dev --remote`**（含 preview R2 bucket） | `pnpm wrangler dev --remote --port 8787` | local server 起得来，但 remote preview session 创建超时（连 `*.devprod.cloudflare.dev` 也被阻） |

### 6.3 DNS 污染证据

`nslookup unequal-api.yydsnews.workers.dev`：

| Resolver | 返回 IP | 备注 |
|---|---|---|
| 本机（192.168.88.1） | `202.160.128.238` | 非典型 CF 段（APNIC 段，疑似劫持） |
| Cloudflare 1.1.1.1 | `45.77.186.255` | **Vultr**（AS-CHOOPA），非 CF |
| Google 8.8.8.8 | `157.240.16.50` | **Facebook 段** (`157.240.0.0/16`) |

**结论**：用户网络（看起来是 GFW 或企业防火墙）拦截 `workers.dev` DNS 解析 + 阻所有 CF 子域（workers.dev / devprod.cloudflare.dev）。从本机无法 smoke 真 CF worker。

### 6.4 关闭 deferred 项状态

| # | 来自 | 项 | 状态 |
|---|---|---|---|
| D-1 | M6-3a | admin upload/search/ask/chat/crawlUrl 真实 401 跳 /login | ⏸ smoke 未跑 |
| D-2 | M6-3a | D1 表初始化验证 | ✅（§5 8 表确认） |
| D-3 | M6-3a | /login 输错 5 次第 6 次 429 | ⏸ smoke 未跑 |
| D-4 | M6-10 | ADMIN_IP_ALLOWLIST 真实生效 | ⏸ smoke 未跑 |
| D-5 | M6-10 | Admin IP 变更 SOP 文档化 | ✅（§9） |
| D-6 | webpage-crawler-setup | Vectorize 远端 binding 真接 | ⏸ smoke 未跑（仅 schema 验证 OK） |

**3 项真接验证 deferred 到网络可达时**（VPN / 非国内网络 / 或切 custom domain 后）。

---

## 7. Wrangler.jsonc commit hash

```
863014a  docs: CP-5 spec — 真接 Cloudflare
2ecdc14  docs: CP-5 plan — 真接 Cloudflare (12 step / 5 CP)
88a26ef  chore(api): CP-5 — wrangler.jsonc 真接 (D1 id + vars + secrets placeholder)
<pending> docs: CP-5 state-cp5.md 收尾 + README CP-5 节
```

---

## 8. Miniprogram apiBaseUrl

**改动**：`apps/miniprogram/app.ts:7`

```diff
-    apiBaseUrl: "http://localhost:8787",  // CP-5 后改 https://unequal.xxx.workers.dev
+    apiBaseUrl: "https://unequal-api.yydsnews.workers.dev",  // CP-5 真接后 (was http://localhost:8787)
```

**未改**：`apps/miniprogram/lib/auth.ts:17`（函数默认参数，app.ts 总显式传入，实际不生效）+ `apps/miniprogram/test/*.test.ts`（测试 mock，留 localhost）。

**注意**：本地 dev 时如要切回 localhost 调试，临时改 `app.ts` 即可。

---

## 9. Admin IP 变更 SOP（M6-10 D-5 落地）

**当前 ADMIN_IP_ALLOWLIST**：`240e:3b4:38ed:4100:10a1:f77f:f362:d8b0`（IPv6 / China Mobile）

**触发条件**：admin 换网络（公司 → 家 / 移动 / 旅行）→ IP 变 → admin login / upload / crawl 收 403。

**流程**：
1. 查新 IP：`curl https://ifconfig.me`（或浏览器 `https://ifconfig.me`）
2. 改 wrangler.jsonc 的 `ADMIN_IP_ALLOWLIST` 值
3. `pnpm wrangler deploy`（CF 端 env vars 改动会自动 reload worker，无需手动 restart）

**多 IP 支持**：comma-separated；如要同时支持公司 + 家 + 移动，写成 `"1.2.3.4,5.6.7.8,9.9.9.9"`。

**频率预期**：家庭宽带 / 公司固定 IP 几个月一次；移动 / 旅行网络每次换即变。

**⚠️ China Mobile IPv6 风险**：SLAAC + EUI-64 自动分配，**接口 ID 每次拨号会变**（prefix `/64` 较稳定）。本 IP 可能在数小时 ~ 数天内失效。**短期缓解**：定期重跑 `curl https://ifconfig.me` 看是否变；如频繁变，考虑：
- 短期：`ADMIN_IP_ALLOWLIST` 设宽（IPv6 prefix `/64` 不行，因代码 `string equality`，不支持 CIDR；需列具体 IP 或全空 + 接受 rate-limit）
- 中期：custom domain + ICP 备案 + 可能换 hosting
- 长期：考虑 mTLS 客户端证书 / Tailscale 等零信任方案（spec YAGNI 范围外）

**M6.10 白名单代码兼容性**：`parseAdminIpAllowlist`（逗号 split）+ `isAdminIpAllowed`（`.includes()` string equality）已支持 IPv6，无需改代码。

---

## 10. 已知 issue / 风险 / 下一步

### 10.1 已知 issue

| Issue | 影响 | 状态 |
|---|---|---|
| **用户网络阻 workers.dev** | admin 在国内无法访问 Worker URL | ⏸ 需 custom domain |
| **smoke 未跑** | 端到端 3 项 deferred 真接验证（D-1/D-3/D-4/D-6）| ⏸ 同上解决后重跑 |
| **China Mobile IPv6 动态** | ADMIN_IP_ALLOWLIST 可能数天失效 | ⏸ §9 SOP 跟踪 |
| **MINIMAX_BASE_URL 未在 types.ts 标 optional** | 任何 deploy 不设该 env 都崩 | ✅ CP-5 加到 wrangler.jsonc |

### 10.2 cp-6 计划项

1. **Custom domain + ICP 备案**（critical — 解决 admin + mini-program 国内可达性）
   - 注册域名（如 markx.me）
   - CF for SaaS route 把 `api.markx.me` 指向 Worker
   - 国内 ICP 备案（个人主体需 ~20 天）
   - mini-program apiBaseUrl 改 `https://api.markx.me`
2. **Mini-program 真机验证**（需先注册 AppID + ICP 备案）
   - 改 `WX_APP_ID` + 注入 `WX_APP_SECRET` secret
   - 微信开发者工具扫码跑 chat / sessions / admin
3. **WE_APP_SECRET 注入**（配套）
4. **重跑 deferred smoke**（D-1 / D-3 / D-4 / D-6）
5. **Admin IP 变更监控**（如频繁变，触发 custom domain 优先级提升）
6. **KEK 轮换演练**（M6.8 留口；可独立验证）

### 10.3 长远考虑（spec YAGNI）

- 监控告警（CF free 自带 wrangler tail；不接 Datadog/Sentry）
- 单元测试新增（CP-5 不加新代码）
- Custom domain 之外的 DNS 优化

---

## 11. References

- **Spec**：`docs/superpowers/specs/2026-06-16-cp5-real-cloudflare-design.md` (commit `863014a`)
- **Plan**：`docs/superpowers/plans/2026-06-16-cp5-real-cloudflare.md` (commit `2ecdc14`)
- **README**：CP-5 节（待 commit）
- **M6.10 spec**：`docs/superpowers/specs/2026-06-16-m6-10-admin-allowlist-design.md`（ADMIN_IP_ALLOWLIST 来源）
- **M6.3a state**：`docs/superpowers/state-m6-3a.md` §"真接 Cloudflare 路径"
- **M6.10 state**：`docs/superpowers/state-m6-10.md` §"CP-5 真接决策"
- **webpage-crawler-setup**：`docs/webpage-crawler-setup.md` §6.1
- **wechat-miniprogram-setup**：`docs/wechat-miniprogram-setup.md`

---

## 12. Lessons Learned（给后续 checkpoint）

1. **网络可达性 preflight**：CP 类 spec 启动前应该 ping workers.dev（或用 1.1.1.1 验 DNS）确认可达；不可达则提示用户先解决。
2. **Preview R2 / D1 在 dev 模式**：wrangler 3.x 强制 `preview_bucket_name` / 推荐 `preview_database_id`；dev 流程要先建 preview 资源。
3. **Bulk secret put**：5+ secret 一次性 bulk 比 5 次 secret put 快很多；JSON 文件不进 chat。
4. **Token 文件 vs env var**：Bash tool 不继承 terminal env var，必须用文件 + cat。
5. **Heredoc 易卡**：不熟悉 shell 的用户用 `nano` 编辑更稳。
6. **DNS pollution 风险**：国内用户的部署必须考虑 custom domain + ICP 备案路径。
7. **M6.10 admin IP 白名单支持 IPv6**：`isAdminIpAllowed` 是 string equality，无需改代码；只需在 SOP 文档化 dynamic IP 风险。

---

**🛑 CP-5 收尾待办**：
- [ ] README 加 CP-5 节
- [ ] Commit state-cp5.md + app.ts 改动
- [ ] `git push` 前确认