# Plan: CP-5 — 真接 Cloudflare

- **Spec**：`docs/superpowers/specs/2026-06-16-cp5-real-cloudflare-design.md`（commit `863014a`）
- **日期**：2026-06-16
- **复杂度**：Medium（5 资源创建 + 5 secret 注入 + 2 var 改 + 9 migration + 6 步 smoke + miniprogram config 改；约 1-3 小时主线程直接做）
- **执行模式**：你跑 `wrangler login` 一次 + `wrangler secret put` 5 次时贴值；其余 wrangler 命令我跑；smoke 我跑 + 贴输出

---

## 1. Requirements Restatement

把 mock-first 的 apps/api Worker 真接到 Cloudflare 账号：5 个资源（D1 / Vectorize / R2 / DO / Worker）真创建，5 secret 经 `wrangler secret put` 注入，1 新 var（ADMIN_IP_ALLOWLIST）+ 1 新 var（MINIMAX_BASE_URL）+ 1 改 var（ENVIRONMENT="production"），9 个 D1 migration apply（skip 0002_dev_seed），Worker 真 deploy，跑 6 步 smoke 验证端到端，改 miniprogram apiBaseUrl 到 https URL，关闭 M6-3a / M6-10 / webpage-crawler-setup 留的 6 项 "CP-5 真接时验"。

**核心交付**：

| # | 类别 | 文件/资源 | 内容 |
|---|---|---|---|
| 1 | CF 资源 | D1 `unequal-db` | 真创建 + 拿 database_id |
| 2 | CF 资源 | Vectorize `unequal-chunks` | 真创建（dimensions=1536）|
| 3 | CF 资源 | R2 bucket `unequal-storage` | 真创建 |
| 4 | CF 资源 | Durable Object `ChatSessionDO` | 随 Worker 首次 deploy 自动 |
| 5 | CF 资源 | Worker `unequal-api` | 真 deploy → 拿到 production URL |
| 6 | Secret | ADMIN_TOKEN / JWT_SECRET / MINIMAX_API_KEY / CRON_SECRET / KEK_SECRET_V1 | `wrangler secret put` 5 次 |
| 7 | Var | ADMIN_IP_ALLOWLIST / MINIMAX_BASE_URL | `wrangler vars set`（实际写进 wrangler.jsonc）|
| 8 | Var | ENVIRONMENT | `"development"` → `"production"` |
| 9 | D1 migration | 0001/0003-0010 | 9 个 apply（skip 0002_dev_seed）|
| 10 | 配置文件 | `apps/api/wrangler.jsonc` | 5 项改动（database_id + 2 secret 移除 + 2 var 新增 + 1 var 改值）|
| 11 | 配置文件 | miniprogram apiBaseUrl | `http://localhost:8787` → `https://unequal-api.<subdomain>.workers.dev` |
| 12 | 文档 | `docs/superpowers/state-cp5.md` + `README.md` CP-5 节 | 收尾 |
| 13 | 验证 | 6 步 smoke（curl `/health` `/auth/admin-login` `/upload` `/search` `/ask` `/stats/login-attempts`）| 端到端 |

**不交付**（推到 cp-6 / YAGNI）：
- mini-program 真机验证（需 AppID 注册 → cp-6）
- custom domain / CF for SaaS route 配置
- `/crawl` endpoint 补全（admin `/upload` 已覆盖）
- `/chat` `/sessions/*` 完整测（M6.1 单独覆盖）
- cron 手工 trigger（Cron Triggers 自动）
- 监控告警（CF free 自带 wrangler tail）
- 数据迁移（passive，重 login 自然升级）
- KEK 轮换（M6.8 留口；本轮只注入 V1）
- 单元测试新增（CP-5 不加新代码；M0-M6 累计 287 用例已稳）

**WX_APP_SECRET 显式 defer**（无 mini-program 真机）。

---

## 2. Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| CF 资源创建 | 现有 `wrangler.jsonc` 资源声明 | 创建命令 + grep list 幂等检查 |
| Secret put | M6.3a state §"真接 Cloudflare 路径"8 步 | `wrangler secret put X` + 用户贴值 |
| Var 改值 | `wrangler.jsonc` vars 块 | 直接改文件而非 `wrangler vars set`（更可见 + 可 commit）|
| Migration apply | `apps/api/migrations/` 9 个文件 | for 循环逐个 apply（skip 0002_dev_seed）|
| Smoke test | `curl` + 现有 routes | 不引入新工具；admin_token 鉴权走现有 `Authorization: Bearer $TOKEN` |
| Miniprogram config | `apps/miniprogram` 找 apiBaseUrl 配置文件 | 单文件 1 行改 |

---

## 3. Files to Change

### 修改（3 个）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `apps/api/wrangler.jsonc` | 5 项（§5 spec diff）：database_id + 2 secret 移除 + 2 var 新增 + 1 var 改值 | +3 / -3 |
| `apps/miniprogram/<apiBaseUrl config 文件>` | apiBaseUrl 改 https URL | +1 / -1 |
| `README.md` | 加 CP-5 节 | +30 / -0 |

### 新建（2 个）

| 文件 | 内容 | 预估行数 |
|---|---|---|
| `docs/superpowers/state-cp5.md` | CP-5 收尾（URL + smoke 输出 + commit hash + Admin IP 变更 SOP）| ~150 |
| `docs/superpowers/plans/2026-06-16-cp5-real-cloudflare.md` | 本文件 | ~250 |

### 不改（沿用现有）

- ✅ `apps/api/src/**` — 0 改动（CP-5 不加新代码）
- ✅ `apps/api/migrations/**` — 0 改动（已存在的 9 个待 apply）
- ✅ `apps/admin/**` — 0 改动（admin URL 通过 env 配，不需改代码）
- ✅ `apps/miniprogram/**` — 仅 apiBaseUrl 配置改 1 行
- ✅ `packages/**` — 0 跨包

---

## 4. Tasks（1 task / 12 step / 5 checkpoint）

### Phase 1 — 主线程直接实施（Task 1 / 12 step / CP-1 ~ CP-5）

**Task 1: CP-5 真接 12 步部署 + 6 步 smoke + miniprogram config + state doc 收尾**

按 M6.10 教训 + "merge 是 destructive 操作"原则，主线程直接做（1 部署任务 + ~1-3 小时）。

---

#### Step 1 — Preflight（约 5 分钟，你做）

**动作**：
- 浏览器开 `https://ifconfig.me` → 记下公网 IP（作为 `ADMIN_IP_ALLOWLIST` 值）
- 终端跑 4 次 `openssl rand -hex 32` → 4 个 64 字符 hex 串
  - 给 ADMIN_TOKEN / JWT_SECRET / CRON_SECRET / KEK_SECRET_V1 各分配 1 个
  - **保留至少 32 字节**（hex = 64 字符即可，openssl rand -hex 32 输出正好 64 字符）
- 备好 `MINIMAX_API_KEY` 明文（你已有）
- 备好 Admin 想要部署后立即测试的 1 个 MD 文件内容（如 "5个月宝宝发烧38.5怎么办"）

**Mirror**：现有 `.dev.vars.example` 列了所有 env 的预期值；本次按 .dev.vars.example 的 MINIMAX_BASE_URL `https://api.MiniMax.chat/v1` 用。

**Validate**：你手上有 1 IP + 4 hex 串 + 1 MiniMax key + 1 段 MD 测试文本。

---

#### Step 2 — wrangler login（约 1-2 分钟，你做）

**动作**：
```bash
cd /Users/Mark/cc_project/unequal/apps/api
pnpm wrangler login
```
浏览器跳 CF OAuth 登录 → 授权 → 终端显示 "You are logged in"。

**Validate**：终端显示成功 + chat 告诉我 "logged in"。

**失败处理**：清 `~/.config/.wrangler/config/default.toml` 后重试。

---

#### Step 3 — Capture account info（约 30 秒，我做）

**动作**：
```bash
cd /Users/Mark/cc_project/unequal/apps/api
pnpm wrangler whoami
pnpm wrangler deploy --dry-run --outdir=dist/.cp5-dry
```

**输出**：
- Account ID + 默认 workers.dev subdomain（如 `mark-unequal.workers.dev`）
- 最终 worker URL: `https://unequal-api.<subdomain>.workers.dev`
- dry-run 输出确认 wrangler.jsonc 解析无错

**Validate**：拿到 Account ID + subdomain + dry-run 0 错。

---

#### Step 4 — Create Cloudflare 资源（约 2-3 分钟，我做）

**动作**（含 idempotent 检查）：
```bash
# D1
pnpm wrangler d1 list | grep -q unequal-db || pnpm wrangler d1 create unequal-db
# 记录输出的 database_id

# Vectorize（dimensions=1536 假设，见 spec §2.2）
pnpm wrangler vectorize list | grep -q unequal-chunks || pnpm wrangler vectorize create unequal-chunks --metric=cosine --dimensions=1536

# R2
pnpm wrangler r2 bucket list | grep -q unequal-storage || pnpm wrangler r2 bucket create unequal-storage
```

**Validate**：
```bash
pnpm wrangler d1 list | grep unequal-db
pnpm wrangler vectorize list | grep unequal-chunks
pnpm wrangler r2 bucket list | grep unequal-storage
```

**风险点**：Vectorize dimensions 不匹配 MiniMax embedding（如实际 1024 / 3072）。**先验证再继续**：
- 读 `packages/shared/src/embedding.ts` 确认输出维度
- 如不符：`pnpm wrangler vectorize delete unequal-chunks` + 用正确维度重建

**🛑 CP-1**: 3 资源全在 list + dimensions 验证

---

#### Step 5 — wrangler.jsonc 改 5 项（约 1 分钟，我做）

**动作**：用 Edit 改 `apps/api/wrangler.jsonc`：

```diff
   "vars": {
-    "ENVIRONMENT": "development",
+    "ENVIRONMENT": "production",
     "ALLOWED_ORIGIN": "*",
     "AUTH_MODE": "admin_token",
     "WX_APP_ID": "wx_development_placeholder",
-    "JWT_SECRET": "dev-jwt-secret-change-me-in-production-32-bytes-min",
+    "MINIMAX_BASE_URL": "https://api.MiniMax.chat/v1",
+    "ADMIN_IP_ALLOWLIST": "<your-ip-from-step-1>",
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
+      "database_id": "<real-id-from-step-4>",
       "migrations_dir": "migrations"
     }
   ],
```

**Validate**：`git diff apps/api/wrangler.jsonc` 你目视 5 项改动正确。

**🛑 CP-2**: wrangler.jsonc 5 项改完（CI dry-run deploy 也走一遍看 wrangler 不报）

---

#### Step 6 — Inject 5 secrets（约 3-5 分钟，我跑 + 你贴值）

**动作**：每次 `wrangler secret put X` 我跑命令，你贴值（按提示输入，不进 chat 历史明文）：
```bash
pnpm wrangler secret put ADMIN_TOKEN       # 你贴值（hidden input）
pnpm wrangler secret put JWT_SECRET        # 你贴值
pnpm wrangler secret put MINIMAX_API_KEY   # 你贴值
pnpm wrangler secret put CRON_SECRET       # 你贴值
pnpm wrangler secret put KEK_SECRET_V1     # 你贴值
```

**Validate**：
```bash
pnpm wrangler secret list
# 期望：5 行全列（ADMIN_TOKEN / JWT_SECRET / MINIMAX_API_KEY / CRON_SECRET / KEK_SECRET_V1）
```

**🛑 CP-3**: 5 secrets 注入

---

#### Step 7 — Skip（ADMIN_IP_ALLOWLIST 已在 Step 5 wrangler.jsonc 改完）

**说明**：spec §7 step 7 设计的 `wrangler vars set` 已被 §5 改动替代（直接写 wrangler.jsonc vars 块）。本步是 verify gate，不是新动作。

**Validate**：wrangler deploy 完成后 `wrangler tail` 看 env 含 `ADMIN_IP_ALLOWLIST`。

---

#### Step 8 — Apply D1 migrations（约 1-2 分钟，我做）

**动作**（for 循环逐个 apply 非 0002）：
```bash
cd /Users/Mark/cc_project/unequal/apps/api
for m in 0001_init 0003_query_cache 0004_chat_session 0005_login_attempt \
         0006_user_session_key 0007_login_attempt_created_at_index \
         0008_login_attempt_client_ip 0009_user_session_key_envelope \
         0010_user_session_key_kek_version; do
  pnpm wrangler d1 migrations apply unequal-db --remote "$m"
done
```

**Validate**：
```bash
pnpm wrangler d1 execute unequal-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
# 期望：7 张表 — chat_session / chunk / document / login_attempt / query_cache / source / user
```

**🛑 CP-4**: 7 张表全在

---

#### Step 9 — Deploy Worker（约 30 秒，我做）

**动作**：
```bash
cd /Users/Mark/cc_project/unequal/apps/api
pnpm wrangler deploy
```

**输出**：`Published unequal-api (x.xx sec)` + URL `https://unequal-api.<subdomain>.workers.dev`

**Validate**：拿到 production URL。

**🛑 CP-5**: Worker 真 deploy + URL 可达

---

#### Step 10 — Smoke test 6 步（约 2-3 分钟，我跑）

**动作**：
```bash
export API="https://unequal-api.<subdomain>.workers.dev"
export TOKEN="<your-ADMIN_TOKEN>"

# Step 1: health
curl -sf $API/health | jq

# Step 2: admin login
JWT=$(curl -sf -X POST $API/auth/admin-login \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\"}" | jq -r .jwt)

# Step 3: upload（小 MD 文件）
echo "# test\n5个月宝宝发烧38.5要观察精神状态" > /tmp/cp5-test.md
curl -sf -X POST $API/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/tmp/cp5-test.md" | jq

# Step 4: search
curl -sf "$API/search?q=发烧" -H "Authorization: Bearer $TOKEN" | jq '.results | length'

# Step 5: ask
curl -sf -X POST $API/ask \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"q":"5个月宝宝发烧怎么办"}' | jq

# Step 6: stats
curl -sf $API/stats/login-attempts -H "Authorization: Bearer $TOKEN" | jq
```

**Validate**：6 步全 200 + 期望响应（具体期望见 spec §8）。

**关闭 deferred**：
- D-1 (M6-3a)：admin auth 链路完整
- D-2 (M6-3a)：D1 7 张表（已在 CP-4）
- D-3 (M6-3a)：旁路跑错误 token 6 次 → 第 6 次 429
- D-4 (M6-10)：旁路从非 allowlist IP 调 /auth/admin-login → 403
- D-6 (webpage-crawler-setup)：Vectorize 远端 binding 真接（upload → search 召回成功）

---

#### Step 11 — Miniprogram apiBaseUrl 改（约 1 分钟，我做）

**动作**：
- 找 `apps/miniprogram` 里配 `apiBaseUrl` 的文件（grep `apiBaseUrl`）
- 改值：`http://localhost:8787` → `https://unequal-api.<subdomain>.workers.dev`

**Validate**：`grep apiBaseUrl apps/miniprogram/<file>` 确认改值。

---

#### Step 12 — Commit + state doc + README + push（你说 push 才 push）

**动作**：
1. `git add -A && git commit -m "chore(api): CP-5 — wrangler.jsonc 真接 (D1 id + vars + secrets placeholder)"`
2. 写 `docs/superpowers/state-cp5.md`（10 sections）：
   - §1 摘要 + URL
   - §2 资源清单（含 create 命令输出）
   - §3 secrets 注入清单
   - §4 vars 改动
   - §5 migration apply 输出
   - §6 smoke test 输出（6 步贴原始输出）
   - §7 关闭 deferred 项（D-1 ~ D-6）
   - §8 commit hash 列表
   - §9 Admin IP 变更 SOP（spec 附录 A）
   - §10 已知 issue / 风险 / 下一步（cp-6）
3. 改 `README.md` 加 CP-5 节（~30 行，含 URL + smoke 结果 + commit hash）
4. 再 `git commit -m "docs: CP-5 state-cp5.md 收尾 + README CP-5 节"`
5. **`git push` 前问你**（destructive）

---

## 5. Validation

### 5.1 每步 gate（见 §4 Task 1）

| Checkpoint | 通过条件 |
|---|---|
| CP-1 | 3 资源（D1/Vectorize/R2）全在 list + dimensions 验证 |
| CP-2 | wrangler.jsonc 5 项改完 + dry-run deploy 0 错 |
| CP-3 | 5 secrets 注入（`wrangler secret list` 全见）|
| CP-4 | 7 张 D1 表（chat_session / chunk / document / login_attempt / query_cache / source / user）|
| CP-5 | Worker 真 deploy + URL 可达 + 6 步 smoke 全 200 |

### 5.2 全局验证（Phase 2 后）

```bash
# smoke 6 步（spec §8 全命令）
curl -sf $API/health
curl -sf -X POST $API/auth/admin-login ...
# ... 全 6 步

# D1 7 张表
pnpm wrangler d1 execute unequal-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"

# secrets / vars
pnpm wrangler secret list
git diff apps/api/wrangler.jsonc  # 5 项

# miniprogram
grep apiBaseUrl apps/miniprogram/<file>

# git log
git log --oneline | head -5  # 见 CP-5 commit hash
```

### 5.3 关闭 deferred 验证（spec §10）

| 项 | 验证方式 |
|---|---|
| D-1 admin auth 链路 | smoke step 2-6 全 200 |
| D-2 D1 表 | CP-4 |
| D-3 rate-limit 旁路 | smoke step 2 旁路：错误 token 6 次 → 第 6 次 429 |
| D-4 ADMIN_IP_ALLOWLIST | smoke step 2 旁路：curlbin.io 转发 → 403 |
| D-5 Admin IP SOP | state-cp5.md §9 落地 |
| D-6 Vectorize 远端 | smoke step 3-4（upload → search 召回）|

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Vectorize dimensions 不匹配 MiniMax embedding | 中 | Step 4 先验证；不符则 destroy + recreate |
| ADMIN_TOKEN / JWT_SECRET 泄漏（chat 留痕）| 中 | secret put 时 hidden input，不在 chat 贴明文全值 |
| Cloudflare 免费 plan 限额超 | 低 | D1 10/R2 10 bucket/Vectorize 100 index 远不到 |
| Worker URL 公开可访问 | 中 | ADMIN_IP_ALLOWLIST + admin_token 双层防御 |
| 静态 IP 变更（admin 换网络）| 低 | state-cp5.md §9 SOP 文档化 |
| Migration apply 某步失败 | 低 | `wrangler d1 migrations list` 看状态；失败 migration 手工 SQL 补 |
| wrangler deploy 编译错 | 低 | 看错误信息回滚 wrangler.jsonc（git checkout）|

**最高风险**：Vectorize dimensions 不匹配。Mitigation：Step 4 提前验证 + 失败立即 destroy + recreate。

---

## 7. Acceptance

### 7.1 功能 AC

- [ ] AC-1: 5 个 CF 资源全创建（D1 / Vectorize / R2 / DO / Worker）
- [ ] AC-2: wrangler.jsonc 5 项改动全到位
- [ ] AC-3: 5 个 secret 经 `wrangler secret put` 注入
- [ ] AC-4: ADMIN_IP_ALLOWLIST var 注入（deploy 后 `wrangler tail` 看 env）
- [ ] AC-5: 9 个 migration applied（skip 0002_dev_seed）；D1 7 张表全在
- [ ] AC-6: Worker 真 deploy，公网 URL `https://unequal-api.<subdomain>.workers.dev` 可达
- [ ] AC-7: smoke 6 步全过
- [ ] AC-8: miniprogram apiBaseUrl 改 https URL

### 7.2 关闭 AC

- [ ] AC-9: D-1 / D-2 / D-3（M6-3a）关闭
- [ ] AC-10: D-4 / D-5（M6-10）关闭
- [ ] AC-11: D-6（webpage-crawler-setup）关闭

### 7.3 文档 AC

- [ ] AC-12: `docs/superpowers/state-cp5.md` 收尾（含 URL + smoke 输出 + commit hash + Admin IP 变更 SOP）
- [ ] AC-13: `README.md` 加 CP-5 节
- [ ] AC-14: `docs/superpowers/plans/2026-06-16-cp5-real-cloudflare.md`（本文件）committed

### 7.4 Push AC

- [ ] `git push` 之前得到你口头确认（destructive 操作原则）

---

## 8. Implementation Notes

### 8.1 Subagent 分配

CP-5 1 task 1 部署集成 → 主线程直接做（~1-3 小时 + 阻塞你 wrangler login + 5 次 secret put 贴值）。

### 8.2 Commit 节奏（4 commit）

```
1. docs: CP-5 spec — 真接 Cloudflare
              [✅ done: 863014a]

2. docs: CP-5 plan — 真接 Cloudflare (12 step / 5 CP)
              [本文件 commit]

3. chore(api): CP-5 — wrangler.jsonc 真接 (D1 id + vars + secrets placeholder)
              [🛑 CP-1 ~ CP-5: 5 checkpoints 全过]

4. docs: CP-5 state-cp5.md 收尾 + README CP-5 节
              [Step 12 完成]
```

**总 4 commit（spec 1 + plan 1 + 部署 1 + state 1）**。无需 merge commit（直接在 master 上做，与 M6.10 一致）。

### 8.3 阻塞 / 时序

- 你阻塞 1：`wrangler login`（Step 2，约 1-2 分钟）
- 你阻塞 2-6：5 次 `wrangler secret put` 贴值（Step 6，约 5 分钟合计）
- 其余步骤不阻塞你

### 8.4 push 策略

按 "merge 是 destructive 操作" + "git push 是 shared state" 原则：
- 4 commit 全在本地做
- `git push origin master` 前问你 OK 才 push
- 如果中途你想放弃 / 失败要回滚：§9 全局回滚步骤（spec §9.2）适用

### 8.5 mock-first 边界（CP-5 真接打破 mock-first）

- ✅ 不验 IPv6 admin IP 留口（你 admin 是 IPv4）
- ✅ 不验 cron 真跑（次日凌晨 03:00 UTC 自动）
- ✅ 不验 mini-program 真机（cp-6 范围）
- ❌ 全验：admin auth + D1 表 + Vectorize 召回 + R2 上传 + LLM 调用 + admin auth 链路

### 8.6 下一步（cp-6 候选）

1. **Mini-program 真机验证**：注册 AppID + 改 wx_app_id + 微信开发者工具扫码
2. **Custom domain**：CF for SaaS route（如果 `workers.dev` 域名体验差）
3. **WE_APP_SECRET 注入 + auth/wx-login 真验**：配套 1 一起做
4. **KEK 轮换演练**：M6.8 spec 已留口

---

## 9. Rollback Strategy

如 CP-5 真接中途 abort：

```bash
# 1. Worker 销毁（最先）
pnpm wrangler delete

# 2. miniprogram apiBaseUrl 回滚
cd /Users/Mark/cc_project/unequal
git checkout HEAD~1 -- apps/miniprogram/<apiBaseUrl file>

# 3. Vars / Secrets 清
pnpm wrangler secret delete ADMIN_TOKEN JWT_SECRET MINIMAX_API_KEY CRON_SECRET KEK_SECRET_V1
pnpm wrangler vars delete ADMIN_IP_ALLOWLIST  # 如用了 vars set

# 4. Resources 销毁（可选）
pnpm wrangler d1 delete unequal-db
pnpm wrangler vectorize delete unequal-chunks
pnpm wrangler r2 bucket delete unequal-storage
```

**可逆性**：
- D1 数据 / R2 文件 / Vectorize 索引 销毁均不可逆（除非有备份）
- Worker URL 销毁后同名可重 deploy
- wrangler.jsonc 改动通过 `git revert` 完全可逆
- secrets 通过 `wrangler secret delete` 立即清

---

## 10. References

- **Spec**：`docs/superpowers/specs/2026-06-16-cp5-real-cloudflare-design.md`（commit `863014a`）
- **项目 README**：`README.md`（CP-5 节待加）
- **M6.10 spec**：`docs/superpowers/specs/2026-06-16-m6-10-admin-allowlist-design.md`（ADMIN_IP_ALLOWLIST 来源）
- **M6.3a state**：`docs/superpowers/state-m6-3a.md` §"真接 Cloudflare 路径"（CP-3 验证流程来源）
- **M6.10 state**：`docs/superpowers/state-m6-10.md` §"CP-5 真接决策"
- **webpage-crawler-setup**：`docs/webpage-crawler-setup.md` §6.1（CP-5 Vectorize 真接范围）
- **wechat-miniprogram-setup**：`docs/wechat-miniprogram-setup.md`（apiBaseUrl cp-5 后改 https）

---

**🛑 CP 总结**：CP-1（资源）→ CP-2（wrangler.jsonc）→ CP-3（secrets）→ CP-4（D1 migration）→ CP-5（deploy + smoke）。

**等待用户确认**："proceed" / "modify: [改动]" / "skip step X"。