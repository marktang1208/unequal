# unequal / 不等号

微信端个人育儿智能体，基于个人知识库的问答 + 引用追溯。

- 设计稿：[`docs/superpowers/specs/2026-06-14-unequal-top-level-design.md`](docs/superpowers/specs/2026-06-14-unequal-top-level-design.md)
- M0+M1 实施计划：[`docs/superpowers/plans/2026-06-14-m0-m1-monorepo-knowledge-base.md`](docs/superpowers/plans/2026-06-14-m0-m1-monorepo-knowledge-base.md)
- 执行 runbook（orchestrator 视角）：[`docs/superpowers/state.md`](docs/superpowers/state.md)

## 架构

参见设计稿。简述：

- **apps/api** — Cloudflare Worker（Hono），对外暴露 `/health` `/seed-user` `/upload` `/ingest` `/search`，绑定 D1 / Vectorize / R2。
- **apps/admin** — Cloudflare Pages 上的 React + Vite + Tailwind 上传/检索后台，M0+M1 只跑通端到端流程，不做正式 UI。
- **packages/shared** — 类型 + zod schema + chunking + embedding + retrieval，纯函数库，给 api 复用，未来给小程序/爬虫复用。

## M0+M1 状态

跑通：上传 PDF/Word/TXT/MD → 自动 chunk → embedding → 入库 → `/search` 命中。

M0+M1 在 mock-first 策略下完成：所有 Cloudflare / MiniMax 调用均未实跑，wrangler `database_id` 是占位符，secrets 由用户首次跑时注入。下面是「第一次跑」流程，把 mock 换成真实资源。

### 第一次跑

1. **开通 Cloudflare 资源**（一次性，详见 spec）：

   ```bash
   cd apps/api
   pnpm wrangler login
   pnpm wrangler d1 create unequal-db
   pnpm wrangler vectorize create unequal-chunks --dimensions=1024 --metric=cosine
   pnpm wrangler r2 bucket create unequal-storage
   ```

2. **配 secrets**：

   ```bash
   pnpm wrangler secret put ADMIN_TOKEN    # 任意字符串
   pnpm wrangler secret put MINIMAX_API_KEY
   ```

3. **改 `wrangler.jsonc` 的 `database_id`** 为 step 1 拿到的 D1 ID。

4. **本地开发**：

   ```bash
   # 终端 1
   pnpm dev:api

   # 终端 2
   pnpm dev:admin
   ```

5. **访问** `http://localhost:5173/upload`，上传文件，去 `/search` 验证命中。

## M2 状态

跑通：单轮问答端到端 — 用户问题 → embedding → top5 检索 → prompt → LLM chat → 双层引用验证 → 医疗免责声明 → 缓存回写。

mock-first 实现：LLM 走 `globalThis.fetch` mock（4 夹具：happy / no_citation / cite_mismatch / malformed_json），无真人操作。真接 MiniMax 时改 `MINIMAX_BASE_URL` 即可。

### /ask 用法

```bash
curl -X POST http://localhost:8787/ask \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"q":"5个月宝宝发烧38.5怎么办？"}'
```

返回：

```json
{
  "answer": "5个月宝宝... [来源 1] [来源 3]\n\n以上信息来源于知识库内容，不构成医疗建议。",
  "disclaimer": "以上信息来源于知识库内容，不构成医疗建议。具体情况请咨询专业儿科医生。",
  "citations": [{ "n": 1, "title": "...", "trust_level": 3 }],
  "cached": false
}
```

### M2 测试矩阵

- `pnpm -F shared test` — 24 用例（cite-verify 4 + prompt 4 + 旧 16）
- `pnpm -F api test` — 18 用例（auth 4 + integration 3 + ask 7 + cache 4）

### 待办（v2+）

- M2: `/ask` + `/chat` + LLM 拼 prompt + 双层引用验证 + 医疗免责声明
- M3: 微信小程序
- M4-M5: 爬虫
- M6: 多轮会话 + 真鉴权

## M3 状态

跑通：微信小程序 + admin ChatSim 双形态落地，端到端接 /ask，单轮问答 + 引用卡片可视化。

mock-first 实现：AppID 用占位字符串（真机联调前用户需到 mp.weixin.qq.com 注册 + 替换），/ask 调本地 mock API（CP-5 后改 Cloudflare Workers URL）。

### 小程序端 / ChatSim 用法

- 微信小程序：导入 `apps/miniprogram` 到微信开发者工具（详见 `docs/wechat-miniprogram-setup.md`）
- admin ChatSim：`pnpm -F admin dev` → 访问 `/chat-sim` → 输入问题

### 真机联调前置

1. mp.weixin.qq.com 注册个人主体（30 元/年，1-2 工作日审核）
2. 获取 AppID
3. 替换 `apps/miniprogram/project.config.json` 的 `appid` 字段
4. 勾选微信开发者工具「不校验合法域名」开发期

### M3 测试矩阵

- `pnpm -F miniprogram test` — 4 用例（lib/api.ts: happy / 带 token / 400 / 500）
- `pnpm -F miniprogram typecheck` — 绿（容忍 types 警告，types 包 v2+ 补）
- `pnpm -F admin build` — 成功（含 ChatSim 页）

## M4 状态

跑通：网页抓取（curl + cheerio → /ingest）端到端 + admin `/crawl` 抓取页可视化。13 task 全绿，CP-1/2/3/4 四个 checkpoint 全部 done。

mock-first 实现：抓取器用 cheerio（零浏览器依赖），admin 抓取页直接 fetch `apps/api` 的 `/api/crawl` endpoint（mock-first 模式下未实现，预期 404）。真抓真网 / 配 Cron / 限速 / 反爬推 v2+。

### 新增

- **`apps/crawler` 包** — 5 个源文件 + 11 个单测 + fixture HTML
  - `src/types.ts` — `CrawledDocument` + `IngestPayload` 类型
  - `src/parser.ts` — cheerio HTML → 段落数组 + `totalChars`
  - `src/sources/webpage.ts` — `fetchUrl(url)` → `CrawledDocument`
  - `src/ingest.ts` — `buildIngestPayload` + `submitToIngest`
  - `src/main.ts` — CLI 入口（解析 argv + 调 fetchUrl + 可选 /ingest）
  - `test/parser.test.ts` (4) + `test/webpage.test.ts` (4) + `test/ingest.test.ts` (3) + `test/fixtures/sample-article.html`
- **admin `CrawlPage.tsx` 页** — URL 输入 + trust level 下拉 + 抓取按钮 + 结果展示（title / fetchedAt / content 前 500 字 / ingested 状态 / sourceId / documentId / chunkCount）+ 错误红框
- **admin 路由集成** — `App.tsx` 加 `/crawl` 路由 + nav 栏「网页抓取」链接
- **`docs/webpage-crawler-setup.md`** — CLI / admin 用法 + 真人操作 checklist + 故障排查表

### 抓取器用法

```bash
# CLI（dry-run：只抓不调 /ingest）
node apps/crawler/src/main.ts --url "https://example.com/article" --no-ingest

# CLI（真接 /ingest：需要本地 wrangler dev 跑着 + ADMIN_TOKEN）
node apps/crawler/src/main.ts --url "https://example.com/article" \
  --user-id 01H0000000000000000000000 \
  --token "$ADMIN_TOKEN" \
  --trust 2

# admin UI
pnpm -F admin dev → 访问 http://localhost:5173/crawl
```

详细参数、trust level 含义、真人操作 checklist 见 `docs/webpage-crawler-setup.md`。

### M4 测试矩阵

- `pnpm -F crawler test` — 11 用例（parser 4 + webpage 4 + ingest 3）
- `pnpm -r typecheck` — 5 包全绿（api / admin / shared / crawler / miniprogram）
- `pnpm -F admin build` — 成功（含 CrawlPage 页）

### M4 限制（mock-first 已知）

- ❌ **不支持 JS SPA**：cheerio 只能解析 SSR HTML，客户端渲染的 React/Vue 页面解析后段落为空 → v2+ 接 Playwright 或 Cloudflare Browser Rendering
- ❌ **无反爬策略**：Cloudflare anti-bot / 验证码 → v2+
- ❌ **无 Cron 定时**：v1 范围手工触发（CLI 或 admin）→ v2+ launchd / Cloudflare Cron Triggers
- ❌ **admin `/api/crawl` endpoint 未实现**：mock-first 模式下 `apps/api` 没加 `/api/crawl` 路由，admin 直接 fetch 会 404 → 预期行为；CP-5 真接 Cloudflare 时补 thin proxy
- ❌ **/ingest 调远端 Vectorize binding 500**：mock-first 无真 Vectorize index → CP-5 真接后正常返回 chunks > 0

### 未做（推到 v2+ / CP-5）

- **代理 IP 池**（v2+）：避免单 IP 被封
- **User-Agent 轮换**（v2+）：目标站 UA 校验
- **Cron 定时抓取**（v2+）：launchd / Cloudflare Cron Triggers
- **robots.txt 自动遵守**（生产前必做）：v1 手动审查
- **真接 Cloudflare Vectorize**（CP-5）：`wrangler vectorize create unequal-chunks --dimensions=1024 --metric=cosine`
- **小红书 / 微信公众号抓取**（M5 范围）：这两个平台需要登录态 / 反爬严格，独立 scope

## M6.2 状态

跑通：wx.login + JWT (HS256 24h) + admin 登录页 + 小程序冷启动自动登录。164 用例全绿（73 M0-M5 + 57 M6.1 + 34 M6.2）。

mock-first 实现：
- `verifyAuth()` 加 `jwt` 分支（替换 M6.1 的 501 留口）— AUTH_MODE 切 `admin_token` ↔ `jwt`，**M6.1 留的 3 个切换点全打通**
- jose 库（HS256 同步算法，~50KB）真跑签发 + 验签
- jscode2session 走 fetchImpl 注入 mock（生产换真 wx.login）
- admin 登录页 1 个 form（admin_token + submit）+ localStorage 持久化 jwt + RequireAuth HOC 路由 guard
- 小程序 onLaunch 调 `wx.login` + `/auth/wx-login` + `wx.setStorageSync('unequal:jwt')` 持久化
- 不存 session_key（M6.3+ 再加）

### 鉴权用法（M6.2 后）

**M6.1 切到 M6.2 路径**（CP-5 备查）：
```bash
# wrangler.jsonc
vars.AUTH_MODE = "jwt"   # 从 "admin_token" 改 "jwt"

# 配 4 个 secret
pnpm wrangler secret put ADMIN_TOKEN        # 仅 admin_login 端点验
pnpm wrangler secret put JWT_SECRET        # M6.2 新增（32+ 字节）
pnpm wrangler secret put WX_APP_SECRET      # M6.2 新增（敏感）
# WX_APP_ID 走 vars 即可
```

**admin 登录**（dev + 真接都走 /login）：
```bash
# 浏览器访问 http://localhost:5173/login
# → 输入 admin_token "test-token-please-change"（dev sentinel）
# → 提交 → 写 localStorage("admin_token", jwt) → 跳 /chat-sim
# → /chat-sim 调 /chat 时 header = "Authorization: Bearer <jwt>"

# 真接 Cloudflare：输入真 admin token（wrangler secret put 设的）
```

**小程序冷启动登录**（自动）：
```ts
// apps/miniprogram/app.ts onLaunch（SA5 task 10 加）
await ensureJwt();  // wx.login + /auth/wx-login + 存 storage
// 后续 ask() / chat() / listSessions() 自动带 Bearer jwt header
```

**API 端**：
```bash
# admin 登录
curl -X POST http://localhost:8787/auth/admin-login \
  -H "Content-Type: application/json" \
  -d '{"admin_token":"test-token-please-change"}'
# → { token: "eyJ.jwt", user_id, is_admin: true, expires_in: 86400 }

# 小程序登录（code 由 wx.login 拿）
curl -X POST http://localhost:8787/auth/wx-login \
  -H "Content-Type: application/json" \
  -d '{"code":"mock_test_code_081H1z"}'
# → { token: "eyJ.jwt", user_id, is_new_user: true, expires_in: 86400 }

# 鉴权调用（任何受保护路由都走 verifyAuth）
curl -X POST http://localhost:8787/chat \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"q":"5个月宝宝发烧38.5"}'
```

### M6.2 测试矩阵

- `pnpm -F shared test` — 38 用例（无变化）
- `pnpm -F api test` — 77 用例（auth-jwt 4 + wx 4 + user 4 + auth 4 + auth route 5 + 56 旧回归 = 77）
- `pnpm -F miniprogram test` — 18 用例（auth 4 + api 14 旧 = 18）
- `pnpm -F admin test` — 12 用例（LoginPage 4 + ChatSim 4 + dedupe 4 = 12）
- `pnpm -F crawler test` — 19 用例（无变化）
- `pnpm -r typecheck` — 5 包全绿
- `pnpm -F admin build` — 成功（194.56 kB JS / 14.33 kB CSS）
- 累计：**164 用例全绿**

### M6.2 限制（mock-first 已知）

- 不真接 Cloudflare / 不接 wx.login 真机扫码 — 推到 CP-5
- 不存 session_key（不调 wx.getUserInfo 拿 nickname/avatar）— M6.3
- 不加 refresh token（24h 后强制重 login）— M6.4+
- admin 8 路由只有 /chat-sim 加 RequireAuth，其他保留 M3 dev fallback — 单独 task
- /auth/wx-login 401 不自动 refresh — M6.3

详见 `docs/superpowers/state-m6-2.md`（含 ECC 组件 + 真接路径 + commit 汇总）。

## M6.3a 状态

跑通：3 项 M6.2 留的"生产前必须堵的口"全部收口。**187 用例全绿**（164 M6.2 + 23 M6.3a 新增）。

mock-first 实现：

| 子系统 | 交付 | 防什么 |
|---|---|---|
| A — server rate limit | `lib/rate-limit.ts` + D1 `login_attempt` 表 + 2 路由改造 | 暴力破解 admin_token（5 次 / 15min 锁定）+ wx code 5min 重复刷 |
| B — admin RequireAuth 全包 | `App.tsx` 9 路由 + catch-all `*` + `LoginPage` 429 倒计时 + 5 fetch `handleApiResponse` 串接 | jwt 24h 过期后用户操作能自动跳 /login（不再卡在 upload/search/ask/chat/crawl 页面）+ 防爆破倒计时 |
| C — miniprogram 401 refresh | `fetchWithRefresh` wrapper + 5 函数挂载（chat/sessions/ask/rename/delete）| 小程序用户 24h 后不感知过期，透明 wx.login + retry |

### Rate limit 行为（M6.3a 后）

```bash
# 5 次错 admin_token → 第 6 次 429 + retry_after
for i in 1 2 3 4 5 6; do
  curl -X POST http://localhost:8787/auth/admin-login \
    -H "Content-Type: application/json" \
    -d '{"admin_token":"wrong"}' -w "\n%{http_code}\n"
done
# 1-5: 401 INVALID_ADMIN_TOKEN
# 6:   429 { "error": "RATE_LIMITED", "retry_after": 723 }
```

- 锁定窗口：15 分钟（滑动）
- 阈值：5 次失败（可调，hardcoded 5，M6.4 提取 wrangler vars）
- identifier：admin_token 用 `sha256(token).slice(0, 16)`；wx_code 用 `sha256(code).slice(0, 16)`（不存明文）

### 401 refresh 行为

- **admin**：`uploadFile` / `search` / `ask` / `authedJson` / `crawlUrl` 5 个 fetch 调用点 wrap `handleApiResponse` → 401 → 清 token + `window.location.href = "/login"` 强刷
- **miniprogram**：`chat` / `listSessions` / `renameSession` / `deleteSession` / `ask` 5 函数走 `fetchWithRefresh` → 401 → 自动 `wx.login` 拿新 code → POST /auth/wx-login → 存 jwt → retry 原 request 1 次；wx.login 失败或 refresh 仍 401 → 透传给 caller（不重试避免死循环）

### M6.3a 测试矩阵

- `pnpm -F shared test` — 38 用例（无变化）
- `pnpm -F api test` — 86 用例（rate-limit 6 + auth route 3 + 77 旧 = 86）
- `pnpm -F miniprogram test` — 23 用例（api 4 + auth 1 + 18 旧 = 23）
- `pnpm -F admin test` — 21 用例（App 3 + LoginPage 2 + handleApiResponse 1 + D2 串接 3 + 12 旧 = 21）
- `pnpm -F crawler test` — 19 用例（无变化）
- `pnpm -r typecheck` — 5 包全绿
- `pnpm -F admin build` — 成功（195.67 kB JS / 14.41 kB CSS）
- 累计：**187 用例全绿**（spec 估 182，+5：admin D2 串接 3 + SA1/SA3 边界扩展 2）

### M6.3a 限制（mock-first 已知）

- admin 5 fetch 串接靠静态 grep 测试守卫 — 未来新增 admin API 需同步加 regex
- per-token rate limit：attacker 换 wrong-token 即可绕过 → M6.4 加 IP 维度
- fetchWithRefresh 并发 race：3 并发 401 触发 3 次 wx.login（功能正确但浪费）→ M6.4 共享 inflight promise
- D1 eventually consistent：同 token 5 并发 admin-login 有小窗口 → M6.4 加 token-level mutex
- login_attempt 表无清理 → M6.5+ cron

详见 `docs/superpowers/state-m6-3a.md`（含 commit 汇总 + ECC 组件 + 真接路径 + 4 个偏差记录）。

## M6.3b 状态

跑通：每次 `/auth/wx-login` 成功后把 `session_key` 写入 D1 `user` 表，给未来的 `/auth/wx-user-info` AES-CBC 解密留口。**194 用例全绿**（187 M6.3a 收尾 + 7 M6.3b 新增）。

mock-first 实现：

- migration 0006 `ALTER TABLE user ADD COLUMN session_key TEXT`（不加时间戳，每次重写 + 30 天 TTL 天然覆盖）
- `lib/user.ts` 新 `updateUserSessionKey(d1, userId, sessionKey)` — 空字符串 skip / D1 错误透传
- `/auth/wx-login` 在 findOrCreateUser 后调 updateUserSessionKey，**写失败 try/catch 隔离不阻断 jwt 签发**（未来解密不可用但当前登录仍成功）
- 0 miniprogram 改动（session_key 不下发 client）
- 0 admin 改动

### Session key 行为（M6.3b 后）

```bash
# 真接 Cloudflare 后用 wrangler d1 execute 验证
pnpm wrangler d1 execute unequal-db --remote \
  --command "SELECT id, wx_openid, session_key FROM user LIMIT 5"
# 旧 user（M6.3b 上线前创建）session_key = NULL
# 新 user（M6.3b 上线后 /auth/wx-login）session_key = 微信最新 session_key
```

- 写入时机：每次 /auth/wx-login 成功都重写（不增量）
- 字段类型：TEXT（明文，依赖 Cloudflare D1 encryption at rest）
- 不下发到 client：response body 不含 session_key（仅 user_id + token + is_new_user + expires_in）
- 写失败不阻断：用户拿 jwt 仍可调 /chat / /sessions / /ask，仅未来 /auth/wx-user-info 解密不可用

### M6.3b 测试矩阵

- `pnpm -F shared test` — 38 用例（无变化）
- `pnpm -F api test` — 93 用例（migration 1 + user 4 + auth 2 + 86 旧 = 93）
- `pnpm -F miniprogram test` — 23 用例（无变化）
- `pnpm -F admin test` — 21 用例（无变化）
- `pnpm -F crawler test` — 19 用例（无变化）
- `pnpm -r typecheck` — 5 包全绿
- 累计：**194 用例全绿**（spec 估 6-8 新增，+7 取中）

### M6.3b 限制（mock-first 已知）

- session_key 存明文 → 依赖 Cloudflare D1 encryption at rest；M6.4+ envelope encryption
- ALTER TABLE 在大表慢（user 表当前 0-几千行）→ M6.5+ user 表破 100k 考虑新表
- migration 0006 down 留空（SQLite < 3.35 不支持 DROP COLUMN）→ orphan column 无副作用
- 不存 nickname / avatar（YAGNI）→ M6.3c

详见 `docs/superpowers/state-m6-3b.md`（含 commit 汇总 + 主线程接管原因 + 3 个偏差记录）。

## M6.3c 状态

跑通：miniprogram 端用 2024 微信主推 `nickname-input` 组件收集 nickname（替代已 deprecated 2022 的 `wx.getUserProfile`），server 端新增 PATCH /user/nickname 写 user.nickname。**205 用例全绿**（194 M6.3b 收尾 + 11 M6.3c 新增）。

mock-first 实现：

- server `routes/user.ts` 新 `userRoute.UPDATE_NICKNAME` — 验 jwt + 验 nickname 1-20 字符 + UPDATE
- miniprogram `lib/api.ts` 新 `updateNickname` helper（401 自动 wx.login + retry via `fetchWithRefresh`）
- miniprogram `lib/chat-storage.ts` 新 `hasShownNicknameModal` / `setShownNicknameModal` + `__setNicknameModalStorageImpl`
- miniprogram `pages/chat/chat.ts` onLoad 触发首次 modal（`wx.showModal({ editable: true, cancelText: "跳过" })`）
- 0 avatar 字段 / 0 wx.getUserProfile 集成 / 0 AES-CBC 解密 / 0 settings 页（推 M6.3c+）
- 4 task 跨 2 包主线程直接做（M6.3b stall 教训应用）

### Nickname 行为（M6.3c 后）

```bash
# 1. miniprogram 启动 → chat 页 onLoad → 弹 modal 引导填昵称
# 2. user 填 "张三" + confirm
# 3. updateNickname("张三") → PATCH /user/nickname 带 jwt
# 4. server verifyAuth → UPDATE user SET nickname = "张三" WHERE id = ?
# 5. 200 返 { nickname: "张三" } + wx.showToast "昵称已保存"
# 6. storage flag = true（不论填/跳过/PATCH 失败/成功，永远 true）

# 真接 Cloudflare 后用 wrangler d1 execute 验证
pnpm wrangler d1 execute unequal-db --remote \
  --command "SELECT id, wx_openid, nickname FROM user LIMIT 5"
# nickname 字段应 = user 填的昵称
```

- 触发时机：仅 chat 页首次进入（storage flag false）
- 跳过行为：cancel / 留空 → setShownNicknameModal() 仍调（避免反复弹）
- PATCH 失败：showToast 失败 + flag 仍 true（不做 settings 页 retry）
- admin 模式：isAdmin=true → 400 ADMIN_CANNOT_SET_NICKNAME
- nickname 限制：1-20 字符，trim 后空 → 400 NICKNAME_EMPTY

### M6.3c 测试矩阵

- `pnpm -F shared test` — 38 用例（无变化）
- `pnpm -F api test` — 98 用例（user 5 + 93 旧 = 98）
- `pnpm -F miniprogram test` — 29 用例（api 2 + storage 3 + chat 1 + 23 旧 = 29）
- `pnpm -F admin test` — 21 用例（无变化）
- `pnpm -F crawler test` — 19 用例（无变化）
- `pnpm -r typecheck` — 5 包全绿
- 累计：**205 用例全绿**（spec 估 9 新增，+11 取中）

### M6.3c 限制（mock-first 已知）

- 改昵称 / settings 页未做（user 改主意想再填 → 推 M6.3c+）
- avatar 字段未做（nickname-input 组件不返 avatar，默认灰头）
- PATCH 失败但 flag true（不阻断 + 不 retry）
- chat Page lifecycle 测试用 smoke test（真实触发推 CP-5 微信真机）
- 0 production console.log

详见 `docs/superpowers/state-m6-3c.md`（含 commit 汇总 + 主线程接管原因 + 5 个偏差记录）。

## M6.4 状态

跑通：3 项 M6.3a/b/c 阶段已发现的 mock-first 已知 limitation 收口 — (1) `fetchWithRefresh` 共享 inflight promise（同 baseUrl 并发 401 → 1 次 wx.login）；(2) rate-limit 阈值提取到 wrangler vars；(3) `login_attempt` 表 cron 清理 + 单列 created_at 索引。**219 用例全绿**（205 M6.3c 收尾 + 14 M6.4 新增）。

mock-first 实现：

- `apps/miniprogram/lib/api.ts` 模块级 `inflightEnsureJwt: Map<string, Promise<string>>` + `__clearInflightEnsureJwt` + 改 `fetchWithRefresh` 用 `.finally(() => delete)` 清缓存
- `apps/api/src/lib/rate-limit.ts` 新 `RateLimitConfig` + `DEFAULT_RATE_LIMIT_CONFIG` + `readRateLimitConfig(env)` + 改 `checkRateLimit` 签名（now 第 4 / config 第 5，向后兼容）
- `apps/api/src/routes/auth.ts` 2 处 `checkRateLimit` 调用加 `readRateLimitConfig(env)` 参数
- `apps/api/src/types.ts` Env 加 3 可选字段（LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS / CRON_SECRET）
- `apps/api/wrangler.jsonc` vars 块加 3 个 var + 注释
- `apps/api/migrations/0007_login_attempt_created_at_index.sql` 新（CREATE INDEX 单列 created_at）
- `apps/api/src/routes/cron.ts` 新 `cronRoute.CLEANUP_LOGIN_ATTEMPTS` handler（Bearer CRON_SECRET 验证 + DELETE 24h 前 attempts）
- `apps/api/src/index.ts` 挂 `app.post("/cron/cleanup-login-attempts", ...)`
- 3 task 跨 2 包主线程直接做（M6.3c 教训应用，总耗时 ~30 min）

### Inflight 行为（M6.4 后）

```bash
# user 24h 后首次打开小程序 → 3 个 API 并发
# → 全部 401 → 第 1 个 fetchWithRefresh 调 ensureJwt 创建 inflight promise
# → 第 2 / 3 个 fetchWithRefresh 复用同一 promise（wx.login 只调 1 次）
# → inflight 完成（saveJwt）→ 3 个 fetchWithRefresh 各自 retry
# → .finally 清缓存，下次 401 重新触发
```

### Rate-limit 配置行为（M6.4 后）

```bash
# wrangler.jsonc vars 块（dev 默认；prod 可调）
"LOGIN_MAX_ATTEMPTS": "5",
"LOGIN_WINDOW_MS": "900000"

# 非法 env fallback
LOGIN_MAX_ATTEMPTS="abc" → fallback 5（不 throw）
LOGIN_MAX_ATTEMPTS="0"  → fallback 5（≤0 视为非法）
LOGIN_MAX_ATTEMPTS 不设  → fallback default
```

### Cron cleanup 行为（M6.4 后）

```bash
# 手动触发（CP-5 接 scheduled handler / external cron）
curl -X POST http://localhost:8787/cron/cleanup-login-attempts \
  -H "Authorization: Bearer $CRON_SECRET"
# → 200 { "deleted": N, "cutoff": timestamp }

# 401: 缺 / 错 Authorization
curl -X POST http://localhost:8787/cron/cleanup-login-attempts
# → 401 { "error": "UNAUTHORIZED", "message": "Invalid or missing CRON_SECRET" }
```

- 触发时机：CP-5 由用户决定（方案 A scheduled handler / 方案 B external cron）
- 清理范围：24h 前 attempts（保留 rate-limit 窗口 15min × ~100 倍分析余量）
- 24h 阈值硬编码（YAGNI 不抽 env）
- CRON_SECRET M6.4 放 vars（CP-5 真接升级到 wrangler secret put）

### M6.4 测试矩阵

- `pnpm -F shared test` — 38 用例（无变化）
- `pnpm -F api test` — 109 用例（rate-limit 7 + cron 4 + 98 旧 = 109）
- `pnpm -F miniprogram test` — 32 用例（inflight 3 + 29 旧 = 32）
- `pnpm -F admin test` — 21 用例（无变化）
- `pnpm -F crawler test` — 19 用例（无变化）
- `pnpm -r typecheck` — 5 包全绿
- 累计：**219 用例全绿**（spec 估 8 新增，+14 取中：readRateLimitConfig 5 覆盖更全 + cron 表空 edge 1）

### M6.4 限制（mock-first 已知）

- Cloudflare scheduled handler wrap 未做（M6.4 范围聚焦清理逻辑；CP-5 由用户决定接 scheduled handler 还是 external cron）
- CRON_SECRET 放 vars（M6.4 mock-first 可接受；CP-5 升级到 wrangler secret put）
- cron 24h 阈值硬编码未抽 env（YAGNI）
- inflight map key 用 baseUrl 而非 user（防御性，baseUrl 最多 1-2 个）
- readRateLimitConfig 走 env 对象字面量测试（真 wrangler vars 注入推 CP-5）
- 0 production console.log

详见 `docs/superpowers/state-m6-4.md`（含 commit 汇总 + 主线程接管原因 + 5 个偏差记录 + CP-5 真接路径）。

## M6.5 状态

跑通：2 项 M6.4 留口的 mock-first 已知 limitation 收口 — (1) `cleanupLoginAttempts` 函数抽取 + worker.scheduled 真接 Cloudflare Cron Triggers（每日 UTC 03:00 触发）；(2) admin `/stats` 页面可视化（数字卡 + by_type + 24/72/168h CSS bars）。**237 用例全绿**（219 M6.4 收尾 + 18 M6.5 新增：api 15 + admin 3）。

mock-first 实现：

- `apps/api/src/lib/cleanup.ts` 新 `cleanupLoginAttempts(env, cutoffMs)` + `DEFAULT_CUTOFF_MS = 86_400_000` + `CleanupResult { deleted, cutoff }`
- `apps/api/src/routes/cron.ts` 改：inline DELETE SQL 删除，改调 `cleanupLoginAttempts(env, DEFAULT_CUTOFF_MS)`；行为不变（4 测试保留）
- `apps/api/src/scheduled.ts` 新（独立模块）：scheduled handler 函数（try/catch + console.log 成功 / console.error 失败，不 re-throw）
- `apps/api/src/index.ts` 改：`export default app` → `export default { fetch: app.fetch.bind(app), scheduled }`；加 `app.get("/stats/login-attempts", ...)`；加 `export { ChatSessionDO }` re-export（wrangler build 需要）
- `apps/api/wrangler.jsonc` 改：+3 行 `triggers.crons = ["0 3 * * *"]`
- `apps/api/src/routes/stats.ts` 新 `statsRoute.GET_LOGIN_ATTEMPTS` handler + `clampHours` + `buildStats` + types
- `apps/admin/src/lib/api.ts` 改：+30 行 `getLoginAttemptStats(hours)` helper + `LoginAttemptStats` interface
- `apps/admin/src/pages/StatsPage.tsx` 新（~180 行）：4 数字卡 + by_type TypeRow + HourBars CSS bars（无图表库）+ Asia/Shanghai 时区 tooltip
- `apps/admin/src/App.tsx` 改：+4 行（import + nav `<Link to="/stats">统计` + routes `<Route path="/stats">`）
- 4 task 跨 2 包主线程直接做（M6.3c/d/4 教训应用，总耗时 ~100 min）

### Scheduled handler 行为（M6.5 后）

```bash
# CF Cron Triggers 每日 UTC 03:00 自动触发（无需外部 cron）
# scheduled handler 调 cleanupLoginAttempts(env, DEFAULT_CUTOFF_MS)
# 成功 → console.log "[cron] cleanup-login-attempts: deleted=N"
# 失败 → console.error + 不 re-throw（防 worker panic）

# wrangler.jsonc triggers
"triggers": {
  "crons": ["0 3 * * *"]
}

# 临时验证：改 cron 到 */1 * * * *（每分钟），wrangler tail 看日志
```

### Stats dashboard 行为（M6.5 后）

```bash
# admin JWT 鉴权
curl http://localhost:8787/stats/login-attempts?hours=24 \
  -H "Authorization: Bearer $ADMIN_JWT"
# → 200 {
#     "window_hours": 24,
#     "cutoff": 1718520000000,
#     "total_failed": 4,
#     "total_succeeded": 7,
#     "by_type": {
#       "admin":   { "failed": 3, "succeeded": 5 },
#       "wx_code": { "failed": 1, "succeeded": 2 }
#     },
#     "by_hour": [
#       { "hour_ts": 1718491200000, "failed": 0, "succeeded": 0 },
#       ...
#     ]  // 长度 === window_hours (24/72/168)
#   }

# hours clamp 行为（与 spec §6.1 clampHours 一致）
hours=999  → 168 (clamp 上限)
hours=0    → 1   (clamp 下限)
hours=-5   → 1   (clamp 下限)
hours=abc  → 24  (NaN fallback 默认值)
hours 缺省  → 24 (默认 24h)

# 401 无效 admin token → UNAUTHORIZED
curl http://localhost:8787/stats/login-attempts
# → 401 { "error": "UNAUTHORIZED", "message": "..." }
```

### M6.5 测试矩阵

- `pnpm -F shared test` — 38 用例（无变化）
- `pnpm -F api test` — 124 用例（cleanup 6 + scheduled 2 + stats 7 + 109 旧 = 124）
- `pnpm -F miniprogram test` — 32 用例（无变化）
- `pnpm -F admin test` — 24 用例（StatsPage 3 + 21 旧 = 24）
- `pnpm -F crawler test` — 19 用例（无变化）
- `pnpm -r typecheck` — 5 包全绿
- `pnpm -r build` — api dry-run OK（1216 KB）+ admin build OK（199 KB）
- 累计：**237 用例全绿**（spec 估 16 新增，实际 +18：cleanup.test.ts 加 cutoffMs=0 边界 + DEFAULT_CUTOFF_MS 常量验证）

### M6.5 限制（mock-first 已知）

- Cloudflare Cron Triggers 真触发未验（miniflare 不模拟 cron；CP-5 真接验证）
- 真 D1 SQL `cleanupLoginAttempts` DELETE 性能未验（fakeDB 不执行 SQL；CP-5 验 < 100ms 预期）
- 真 D1 SQL `statsRoute` aggregation 性能未验（CP-5 验 < 200ms 预期）
- admin 真浏览器渲染（CSS bars + Asia/Shanghai 时区 + hover tooltip）未验（jsdom 不验 CSS layout；CP-5 真接验）
- 真 admin JWT 鉴权（jwt 模式）未验（测试用 admin_token 模式简化）
- scheduled handler 不加 CRON_SECRET 鉴权（CF Cron Triggers 是控制面触发，不暴露公网 — spec §5.5 决策）
- 0 production console.log（scheduled handler 的 console.log/error 是 CF Worker 日志约定，**不计入**）

详见 `docs/superpowers/state-m6-5.md`（含 8 个偏差记录 + commit 汇总 + CP-5 真接路径 + 下一步建议）。

## M6.6 状态

跑通：1 项 M6.3a 留口加固 — rate-limit 在 per-token 维度基础上加 per-IP 维度（双层独立计数，任一锁则整体锁），消除 attacker 轮换 wrong-token N 次绕过 5/15min 限流的攻击面。**251 用例全绿**（237 M6.5 收尾 + 14 M6.6 新增）。

mock-first 实现：

- `apps/api/src/lib/rate-limit.ts` 加 5 个新 export：
  - `getClientIp(req)` — 读 `CF-Connecting-IP` header，缺则 `"unknown"`
  - `sha256ClientIp(ip)` — 完整 IP sha256 截 16 字符；`"unknown"` 短路返 `UNKNOWN_IP_HASH = "unknown000000000"`
  - `checkRateLimitByIp(d1, clientIpHash, type, ...)` — 镜像 `checkRateLimit` 签名，SQL `WHERE client_ip = ?`
  - `checkRateLimitDual(d1, identifier, clientIpHash, type, ...)` — `Promise.all` 并发 + 任一锁即整体锁
  - `UNKNOWN_IP_HASH` — 缺 header 防御性固定 hash
- `recordAttempt` 签名加 `clientIpHash` 必填参数（必填：调用方显式表达"已知 IP"或"unknown"）；INSERT SQL 加 `client_ip` 列
- `apps/api/src/routes/auth.ts` WX_LOGIN + ADMIN_LOGIN 改调 `checkRateLimitDual`，加 `getClientIp` + `sha256ClientIp` 解析客户端 IP
- `apps/api/migrations/0008_login_attempt_client_ip.sql` 新 — `ALTER TABLE login_attempt ADD COLUMN client_ip TEXT` + `CREATE INDEX idx_login_attempt_client_ip ON login_attempt(client_ip, attempt_type, created_at DESC)`
- `apps/api/migrations/0008_login_attempt_client_ip.down.sql` 新 — `DROP INDEX`（SQLite < 3.35 不支持 DROP COLUMN；orphan column 无副作用）
- 2 commit 跨 1 包主线程直接做（M6.5 教训应用，总耗时 ~15 min）

### 双层限流行为（M6.6 后）

```bash
# 1. per-IP 锁（新场景）：同 IP 5 个不同 wrong-token → 第 6 个 429
for token in wrong1 wrong2 wrong3 wrong4 wrong5 wrong6; do
  curl -X POST http://localhost:8787/auth/admin-login \
    -H "CF-Connecting-IP: 1.2.3.4" \
    -H "Content-Type: application/json" \
    -d "{\"admin_token\":\"$token\"}" -w "\n%{http_code}\n"
done
# 1-5: 401 INVALID_ADMIN_TOKEN / 6: 429 RATE_LIMITED { retry_after: 900 }

# 2. per-token 锁（回归）：5 同 wrong-token 不同 IP → 第 6 个 429
for ip in 10.0.0.{1..6}; do
  curl -X POST http://localhost:8787/auth/admin-login \
    -H "CF-Connecting-IP: $ip" \
    -H "Content-Type: application/json" \
    -d '{"admin_token":"shared-wrong"}' -w "\n%{http_code}\n"
done
# 1-5: 401 / 6: 429

# 3. 双层都锁：5 同 IP 同 token → 第 6 个 429（per-token / per-IP 都达 5）
```

- 合并语义：`checkRateLimitDual` 串两次 SQL（`Promise.all` 并发 < 10ms 总耗时），任一维度锁即整体锁
- `retry_after`：取锁维度的 retry_after（保守 = 任一先解锁即解锁）
- `client_ip` 存 sha256 hash（不存明文 IP 防 PII；与 identifier 字段同模式）
- `clientIpHash` 16 字符 hex（v4/v6 不区分；与 sha256Identifier 16 字符 hex 截断同模式）
- "unknown" IP 固定 hash = `"unknown000000000"`（缺 header 请求共享 bucket；防御性合并）
- 0 新 env（IP 来自 `CF-Connecting-IP` header，CF 边缘节点自动注入；client 不可伪造）
- 0 跨包改动（仅 apps/api）

### M6.6 测试矩阵

- `pnpm -F shared test` — 38 用例（无变化）
- `pnpm -F api test` — 138 用例（rate-limit 11 + auth 3 + 124 旧 = 138）
- `pnpm -F miniprogram test` — 32 用例（无变化）
- `pnpm -F admin test` — 24 用例（无变化）
- `pnpm -F crawler test` — 19 用例（无变化）
- `pnpm -r typecheck` — 5 包全绿
- 累计：**251 用例全绿**（spec 估 14 新增，实际 14 一致）

### M6.6 限制（mock-first 已知）

- 真实 CF 边缘注入 `CF-Connecting-IP` header 未验（miniflare 不模拟；fake req.headers mock）
- 真实 D1 SQL `checkRateLimitByIp` 索引命中未验（< 5ms 预期；CP-5 真接时 EXPLAIN）
- 真实 D1 ALTER TABLE + CREATE INDEX 性能未验（mock-first 不验）
- admin 输 5 次错 token 锁本机 IP 15min UX 真实体验未验（mock-first 只能验逻辑）
- "unknown" IP bucket 在生产是否真为 0（CF 100% 注入，预期 0 行；CP-5 真接时验）
- applyMigrations 列表手动维护（auth.test.ts 显式列 0001/0005/0006/0008；M6.7+ 加 migration 需同步更新）
- 0 production console.log

详见 `docs/superpowers/state-m6-6.md`（含 4 个偏差记录 + commit 汇总 + CP-5 真接路径 + 下一步建议）。

## M6.7 状态

跑通：1 项 M6.3b 留口加固 — `session_key` 改 envelope encryption（Web Crypto AES-256-GCM，每条数据独立 DEK + KEK 来自 `env.KEK_SECRET`），消除明文存 session_key 依赖 CF D1 encryption at rest 黑盒信任。**263 用例全绿**（251 M6.6 收尾 + 12 M6.7 新增：envelope 8 + user 4 净增）。

mock-first 实现：

- `apps/api/src/lib/envelope.ts` 新（~80 行）：
  - `encryptEnvelope(plaintext, env)` → `{ ciphertext, wrappedDek }`
    每次生成新 DEK（32B 随机）+ 2 个 96-bit nonce；DEK 加密 plaintext → ciphertext；KEK 加密 DEK → wrappedDek
  - `decryptEnvelope(ct_b64, dek_b64, env)` → plaintext
    失败 throw "envelope decrypt failed"（KEK 错 / tamper / 格式坏）
  - 内部 `deriveKek(env)`：SHA-256(env.KEK_SECRET)[:32] → AES-256 raw key
  - 内部 base64 串行化 helper（自包含 nonce + tag + ciphertext）
- `apps/api/src/lib/user.ts` 改 `updateUserSessionKey` 签名加 env 必填；写密文路径 `UPDATE user SET session_key_ct=?, session_key_dek=?, session_key=NULL`；新 `readUserSessionKey` 透明 fallback 老明文（lazy 兼容）
- `apps/api/src/routes/auth.ts` 改 1 处：`updateUserSessionKey` 调用加 env
- `apps/api/src/types.ts` Env 加 `KEK_SECRET?: string` 字段
- `apps/api/migrations/0009_user_session_key_envelope.sql` 新 — `ALTER TABLE user ADD session_key_ct TEXT` + `session_key_dek TEXT`
- 2 commit 跨 1 包主线程直接做（M6.6 教训应用，总耗时 ~10 min）

### Envelope encryption 行为（M6.7 后）

```bash
# 写：每次 /auth/wx-login 成功后
#   1. DEK = random(32B)
#   2. ciphertext = AES-GCM(DEK, nonce1, session_key)
#   3. KEK = SHA-256(env.KEK_SECRET)[:32]
#   4. wrappedDek = AES-GCM(KEK, nonce2, DEK)
#   5. D1: UPDATE user SET session_key_ct=base64(nonce1+ct), session_key_dek=base64(nonce2+wrappedDek), session_key=NULL

# 读：未来 /auth/wx-user-info
#   1. SELECT session_key_ct, session_key_dek, session_key FROM user
#   2. 优先解 envelope：DEK = AES-GCM-decrypt(KEK, nonce2, wrappedDek); plaintext = AES-GCM-decrypt(DEK, nonce1, ct)
#   3. session_key_ct=NULL（老 user）→ fallback 旧明文
#   4. decrypt 失败 → null + console.warn

# 验证（D1 真接后）
pnpm wrangler d1 execute unequal-db --remote \
  --command "SELECT id, session_key_ct, session_key_dek, session_key FROM user LIMIT 5"
# 新 user: session_key_ct + session_key_dek 有 base64 密文，session_key=NULL
# 老 user（M6.3b 上线后 / M6.7 上线前）: session_key 仍明文
```

- 合并语义：`checkRateLimitDual` 无关（M6.6）；envelope 是独立 lib
- `KEK_SECRET` 来自 `wrangler secret put KEK_SECRET`（与 JWT_SECRET / WX_APP_SECRET / CRON_SECRET 同模式）
- 派生算法：SHA-256 截 32 字节（env 任意长度 secret 统一 raw key）
- nonce 12 字节（96-bit AES-GCM 推荐）
- DEK 32 字节（AES-256 key）
- 写时 `session_key=NULL` 避免明密共存（安全原则）
- 读路径懒 fallback：M6.3b 老 user（`session_key_ct=NULL`）自动走旧明文（lazy 兼容）
- 0 新 wrangler vars（KEK_SECRET 是 secret）
- 0 跨包改动（仅 apps/api）

### M6.7 测试矩阵

- `pnpm -F shared test` — 38 用例（无变化）
- `pnpm -F api test` — 150 用例（envelope 8 + user 4 净增 + 138 旧 = 150）
- `pnpm -F miniprogram test` — 32 用例（无变化）
- `pnpm -F admin test` — 24 用例（无变化）
- `pnpm -F crawler test` — 19 用例（无变化）
- `pnpm -r typecheck` — 5 包全绿
- 累计：**263 用例全绿**（spec 估 264，差 1 user 净增 — 详见 state-m6-7.md 偏差 1）

### M6.7 限制（mock-first 已知）

- **KEK 丢失 HIGH 严重度**：env.KEK_SECRET 误删/重生成 → 老 user 密文全不可解
  - 缓解：KEK 强制密码管理器备份（1Password / Bitwarden）
  - 未来 M6.8 候选：KEK version + 多 KEK 兜底
- 真实 CF Workers 注入 `env.KEK_SECRET` 行为未验（miniflare 无 secret 注入）
- 真实 D1 ALTER TABLE 2 列性能未验（mock-first 不验）
- 真实 Web Crypto AES-GCM 性能未验（< 1ms 预期）
- 老 user（M6.3b 上线后 / M6.7 上线前）需重 login 自然迁移到密文（0 主动 batch migration）
- 派生算法 hardcode SHA-256（未来换 scrypt 需数据迁移；YAGNI）
- `applyMigrations` 列表手动维护（auth.test.ts 显式列 0001/0005/0006/0008/0009；M6.8+ 加 migration 需同步更新）
- 0 production console.log（除 envelope decrypt 失败 `console.warn` — 监控必需，**不计入**）

详见 `docs/superpowers/state-m6-7.md`（含 4 个偏差记录 + commit 汇总 + CP-5 真接路径 + 下一步建议）。

## M6.8 状态

跑通：1 项 M6.7 留口加固 — 加 KEK version 字段 + 多 KEK env 变量（KEK_SECRET_V1, V2, V3, ...）+ fallback 遍历所有 env KEK 试解，解决 M6.7 单 KEK 丢失 HIGH 严重度。**274 用例全绿**（263 M6.7 收尾 + 11 M6.8 新增：envelope 7 + user 4 净增）。

mock-first 实现：

- `apps/api/src/lib/envelope.ts` 改：
  - 新 `KekEnv = Record<string, string | undefined>` type alias
  - `deriveKek(env, version)` 加 version 参数；按 `env.KEK_SECRET_V${version}` 取
  - `encryptEnvelope(plaintext, env, version)` + `decryptEnvelope(ct, dek, env, version)` 签名加 version
  - 新 `tryDecryptWithAnyKek(ct, dek, env)` 遍历 env 所有 KEK 试解；全失败 throw "all KEKs failed to decrypt"
  - 新 `getAllKekVersions(env)` 扫描 `KEK_SECRET_V*` 模式
- `apps/api/src/lib/user.ts` 改：
  - `updateUserSessionKey` 写 `session_key_kek_version = currentVersion`（env.KEK_CURRENT_VERSION ?? "1"；非法 fallback 1）
  - `readUserSessionKey` SELECT 加 version；1st try 优先用 row.session_key_kek_version（fast path）；失败 → fallback `tryDecryptWithAnyKek` 遍历
- `apps/api/src/types.ts` 改：Env interface 改 `KEK_SECRET` → `KEK_SECRET_V1/V2/V3 + KEK_CURRENT_VERSION`（4 字段）
- `apps/api/migrations/0010_user_session_key_kek_version.sql` 新：`ALTER TABLE user ADD session_key_kek_version INTEGER NOT NULL DEFAULT 1` + `idx_user_kek_version`
- 1 commit 跨 1 包主线程直接做（M6.7 教训应用，总耗时 ~15 min）

### KEK version + multi-KEK fallback 行为（M6.8 后）

```bash
# 1. 写：每次 /auth/wx-login 成功后
#   currentVersion = parseInt(env.KEK_CURRENT_VERSION ?? "1", 10)  // 默认 V1
#   encryptEnvelope(plaintext, env, currentVersion)  // 用 V1 KEK
#   D1: UPDATE user SET session_key_ct=base64(nonce+ct), session_key_dek=base64(nonce+wrappedDek),
#                    session_key_kek_version=currentVersion, session_key=NULL

# 2. 读：1st try 优先用 row.session_key_kek_version → 失败 fallback 遍历
#   SELECT session_key_ct, session_key_dek, session_key, session_key_kek_version FROM user
#   1st try: decryptEnvelope(ct, dek, env, row.session_key_kek_version)
#   fail → 2nd try: tryDecryptWithAnyKek → 遍历 env.KEK_SECRET_V* 试解
#   全失败 → null + console.error

# 3. 轮换：加新 KEK + 改 currentVersion（admin 流程）
#   pnpm wrangler secret put KEK_SECRET_V2
#   pnpm wrangler secret put KEK_CURRENT_VERSION  # 值="2"
#   # 0 主动重 wrap；老 user 仍 V1，fallback 链 V1 仍可读

# 验证（D1 真接后）
pnpm wrangler d1 execute unequal-db --remote \
  --command "SELECT id, session_key_kek_version FROM user LIMIT 5"
# V1 老 user: session_key_kek_version=1
# V2 新 user: session_key_kek_version=2
```

- 合并语义：`tryDecryptWithAnyKek` 串行遍历 env.KEK_SECRET_V*（V1 → V2 → V3）任一解出即返
- `KEK_CURRENT_VERSION` 决定新数据写入用哪个 KEK（默认 "1"）
- 写时 `session_key_kek_version` 列记录所用 KEK version
- 1st try fast path（happy 1 次解密）/ fallback 跨 KEK 不可解（V1 加密的 wrappedDek 用 V2 永远解不开）
- 0 主动重 wrap DEK 工具（M6.8+ YAGNI）
- 0 跨包改动（仅 apps/api）

### M6.8 测试矩阵

- `pnpm -F shared test` — 38 用例（无变化）
- `pnpm -F api test` — 161 用例（envelope 15 + user 16 + auth 14 + 116 旧 = 161；M6.8 新增 11）
- `pnpm -F miniprogram test` — 32 用例（无变化）
- `pnpm -F admin test` — 24 用例（无变化）
- `pnpm -F crawler test` — 19 用例（无变化）
- `pnpm -r typecheck` — 5 包全绿
- 累计：**274 用例全绿**（spec 估 9 净增，实际 11 — +2 envelope 边界测试：跨 KEK 不可解 + 跳过非法 version）

### M6.8 限制（mock-first 已知）

- **所有 KEK 都丢 HIGH 严重度**：env.KEK_SECRET_V* 全被删/重生成 → 老 user 数据全不可解
  - 缓解：KEK 强制密码管理器备份（CP-5 流程 doc 强提示）
  - 兜底已无：admin 需重设原 KEK 才能恢复
- fallback 跨 KEK 不可解：V1 加密的 wrappedDek 用 V2 永远解不开（AES-GCM 不可跨 KEK 解密）— 监控必需
- 真实 CF Workers 注入 `env.KEK_SECRET_V*` 行为未验（miniflare 无 secret 注入）
- 真实 D1 ALTER TABLE 性能未验（mock-first 不验）
- 真实多 KEK 轮换流程未验（CP-5 admin 文档演练）
- 真实老 user（M6.7 上线后）重 login 后 version 升到 currentVersion 未验
- 派生算法 hardcode SHA-256（未来换 scrypt 需数据迁移；YAGNI）
- `applyMigrations` 列表手动维护（auth.test.ts 显式列 0001/0005/0006/0008/0009/0010；M6.9+ 加 migration 需同步更新）
- 0 production console.log（除 envelope fallback console.warn + console.error — 监控必需，**不计入**）

详见 `docs/superpowers/state-m6-8.md`（含 6 个偏差记录 + commit 汇总 + CP-5 真接路径 + 下一步建议）。

## M6.9 状态

跑通：1 项 M6.3a 留口防御性加固 — 同 token 5 并发 admin-login/wx-login 小窗口串行化（in-process Map + `withTokenMutex` helper）。**280 用例全绿**（274 M6.8 收尾 + 6 M6.9 新增：token-mutex 6）。

mock-first 实现：

- `apps/api/src/lib/token-mutex.ts` 新（~30 行）：
  - `withTokenMutex<T>(identifier, fn) → Promise<T>`
  - module-level `inflight: Map<string, Promise<unknown>>`
  - chain 模式：`prev → next`（避免 N 个 await 串成 N 层）
  - `finally` 释放 mutex + `if (inflight.get(id) === chained)` 防御性检查
- `apps/api/src/routes/auth.ts` 改 3 处：
  - WX_LOGIN INVALID_CODE 路径
  - ADMIN_LOGIN 失败路径
  - ADMIN_LOGIN 成功路径
- 1 commit 跨 1 包主线程直接做（M6.8 教训应用，总耗时 ~5 min）

### Mutex 行为（M6.9 后）

```typescript
// 同 token 5 并发：5 个 fn 串行（~25ms 总耗时，节省 ~5-10ms 并发开销）
const p1 = withTokenMutex(adminIdentifier, () => recordAttempt(...));
const p2 = withTokenMutex(adminIdentifier, () => recordAttempt(...));  // 等 p1
const p3 = withTokenMutex(adminIdentifier, () => recordAttempt(...));  // 等 p2
// ...

// 不同 token 不阻塞
const w1 = withTokenMutex(codeIdentifier, () => recordAttempt(...));
const w2 = withTokenMutex(adminIdentifier, () => recordAttempt(...));  // 与 w1 并行
```

- 模式：in-process Map（CF Workers 单 isolate 内有效）
- 失败：fn throw → mutex 释放 + throw 透传
- 范围：仅 /auth/admin-login + /auth/wx-login（其他鉴权路由不受影响）
- 0 新依赖 / 0 schema / 0 env 改动
- 0 跨包改动（仅 apps/api）

### M6.9 测试矩阵

- `pnpm -F shared test` — 38 用例（无变化）
- `pnpm -F api test` — 167 用例（token-mutex 6 + 161 旧 = 167；M6.9 新增 6）
- 其他包 — 113 用例（无变化）
- `pnpm -r typecheck` — 5 包全绿
- `pnpm -F api build` — wrangler dry-run OK
- 累计：**280 用例全绿**（spec 估 6 净增，实际 6 — 精确一致）

### M6.9 限制（mock-first 已知）

- **多 isolate 不防**（设计预期）：CF Workers 多 isolate 间不共享 Map mutex
  - 缓解：M6.3a per-token 5/15min + M6.6 per-IP 5/15min 兜底
  - 未来 CP-5 观察实际并发后决定是否升级 DO-level mutex
- 实际价值低（spec §1 价值评估）：5 个 record 仍 5 行 D1 写；只节省 5-10ms 串行耗时
- 防御性代码：M6.9 是"如果未来并发问题升级时已有基础"
- 0 production console.log
- 0 跨包改动

详见 `docs/superpowers/state-m6-9.md`（含 0 偏差记录 + commit 汇总 + CP-5 真接路径 + 下一步建议）。

## M6.1 状态

跑通：多轮会话 + Durable Objects（一个 session 一个 DO instance）+ D1 session 列表 + 小程序双 tab（对话 / 历史）+ admin ChatSim 多 session 切换。130 用例全绿（73 M0-M5 + 57 M6.1）。

mock-first 实现：
- Durable Object 走 miniflare 真 binding（生产换 `wrangler durable-objects class create ChatSessionDO`）
- /chat 走 spec §3.2 完整数据流（拼 multiturn context + 调 RAG + 写 DO + D1 维护）
- /sessions 走 server-side 列表（前端不再用 localStorage 存历史）
- 鉴权走 `verifyAuth` 唯一切换点（M6.1 `admin_token`，M6.2 切 `jwt` 只动一个函数）
- 限额：每 user 最多 50 active session
- 过期：lazy 判定（30 天未活跃 → loadSession 返 null → 404）
- 降级：DO 写失败或 SESSION_DO binding 缺 → `degraded: true` 不 throw

### 多轮会话用法

**admin ChatSim**（多 session 升级）：

```bash
pnpm dev:admin → 访问 http://localhost:5173/chat-sim
                → 左栏 session 列表（hover 显示 ✎ / ×）
                → 提问题：建新 session 自动加进列表
                → 点 session 切换 / 长按重命名 / × 软删
```

**API**：

```bash
# 新建 session
curl -X POST http://localhost:8787/chat \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"q":"5个月宝宝发烧38.5怎么办？"}'
# → { "answer": "...", "session_id": "01H...", "is_new_session": true, ... }

# 复用 session
curl -X POST http://localhost:8787/chat \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"q":"那 38.5 以下呢？", "session_id":"01H..."}'

# 列 session
curl http://localhost:8787/sessions -H "Authorization: Bearer $ADMIN_TOKEN"

# 重命名 / 软删
curl -X PATCH http://localhost:8787/sessions/01H... -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"title":"新标题"}'
curl -X DELETE http://localhost:8787/sessions/01H... -H "Authorization: Bearer $ADMIN_TOKEN"
```

**小程序双 tab**（聊天 / 历史）：
- 聊天 tab 持 session_id（`wx.setStorageSync('unequal:currentSessionId')`），关掉重开继续上一轮
- 历史 tab 调 `/sessions` 拉 server-side 列表，长按 session 弹「重命名 / 删除」

### M6.1 测试矩阵

- `pnpm -F shared test` — 38 用例（multiturn 12 + 其他 M0-M5 26）
- `pnpm -F api test` — 56 用例（chat 14 + chat route 4 + sessions lib 10 + sessions route 4 + do-client 4 + ask/cache/auth/integration 20）
- `pnpm -F miniprogram test` — 9 用例（chat 2 + list 1 + rename 1 + delete 1 + ask 4）
- `pnpm -F admin test` — 8 用例（ChatSim 4 + dedupe 4）
- `pnpm -F crawler test` — 19 用例（无变化）
- `pnpm -r typecheck` — 5 包全绿
- `pnpm -F admin build` — 成功（192.81 kB / 60.09 kB gzip）
- 累计：**130 用例全绿**

### M6.1 限制（mock-first 已知）

- 不真接 Cloudflare Workers / D1 / DO — 推到 CP-5
- 不接 wx.login / 微信小程序真鉴权 — M6.2
- 不签 JWT — M6.2
- 不实跑 admin dev 真连 /chat-sim（仅 build + 8 jsdom 单测覆盖）— 推到 M6.2 真接后做

详见 `docs/superpowers/state-m6-1.md`（含 ECC 组件 + 真接路径 + commit 汇总）。

## M5 状态

跑通：小红书 + 微信公众号两个 source adapter（cheerio parser）+ admin 2 个抓取页（`/crawl/xiaohongshu` + `/crawl/wechat-mp`）+ localStorage URL 去重。19 crawler 用例 + 4 admin dedupe 用例全绿。

mock-first 实现：抓取器单测用 fixture HTML + mock fetch；admin 抓取页接 `/mock-crawl/{platform}.json`（Vite 静态服务 3 fixture URL）；真接 Cloudflare 后改 `apps/admin/src/lib/api.ts` 即可。

### 小红书 / 微信公众号 抓取器用法

CLI：

```bash
node --experimental-strip-types apps/crawler/src/main.ts \
  --url "https://xiaohongshu.com/explore/abc123" \
  --source-type xiaohongshu --no-ingest
```

admin：

```bash
pnpm dev:admin → 访问 http://localhost:5173/crawl/xiaohongshu
                → 访问 http://localhost:5173/crawl/wechat-mp
```

### M5 测试矩阵

- `pnpm -F crawler test` — 19 用例（webpage 4 + ingest 3 + parser 4 + xiaohongshu 4 + wechat-mp 4）
- `pnpm -F admin test` — 4 用例（dedupe 4）
- `pnpm -r typecheck` — 5 包全绿（api / admin / shared / crawler / miniprogram）
- `pnpm -F admin build` — 成功（含 XiaohongshuCrawlPage + WechatMpCrawlPage）

### M5 限制（mock-first 已知）

- ❌ **不抓真网**：admin 抓取页只命中 fixture，未在 fixture 的 URL 报 `fixture_miss`
- ❌ **无登录态自动抓账号**：用户需手动复制 URL 列表；自动抓账号推 v2+/M5.5
- ❌ **无反爬策略**：真接时需代理 IP / UA 轮换 / 验证码识别（v2+）
- ❌ **无 Cron 定时**：手动触发（CLI 或 admin）；Cloudflare Cron Triggers v2+
- ❌ **/ingest 调远端 Vectorize binding 500**：mock-first 无真 Vectorize index → CP-5 真接后正常

### 未做（推到 v2+ / M5.5）

- 登录态自动抓账号（小红书 App 抓包 / 公众号 cookie 注入）
- 代理 IP 池 / User-Agent 轮换
- Cron 定时抓取
- robots.txt 自动遵守（生产前必做）
- 真接 Cloudflare Vectorize（CP-5）
- 按 content hash 去重

详细 v2+ 路线见 `docs/platform-crawler-setup.md`。

## 开发

```bash
pnpm install
pnpm typecheck   # 3 包全部 tsc --noEmit
pnpm test        # 20 用例（16 shared + 4 api）
```

各 app 单独开发：

```bash
pnpm dev:api     # wrangler dev
pnpm dev:admin   # vite dev server
```

构建：

```bash
pnpm -F api build    # wrangler deploy --dry-run
pnpm -F admin build  # vite build
```

## 仓库结构

```
apps/
  api/      Cloudflare Worker + Hono + D1 + Vectorize + R2
  admin/    React + Vite + Tailwind 后台（Pages）
packages/
  shared/   类型 + zod schema + chunking + embedding + retrieval
docs/
  superpowers/
    specs/   设计稿
    plans/   实施计划
    state.md orchestrator runbook
```

## 测试

`pnpm test` 跑 20 个用例：16 个在 `packages/shared`（schemas / chunking / embedding / retrieval），4 个在 `apps/api`（admin token 鉴权）。

M0+M1 全程 TDD：每个新模块都先写测试，再写实现。M2 起再补 D1/R2/Vectorize 的 Miniflare 集成测试（M0+M1 期间 mock-first 跳过）。

## 部署

```bash
pnpm deploy:api    # wrangler deploy
pnpm deploy:admin  # wrangler pages deploy dist
```

首次部署前先走完上面「第一次跑」的 step 1–3。

## 故障排查

### `pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS: sharp@...`

`sharp` 是 wrangler 的 transitive dep（image processing）。pnpm 11 strict mode 要求显式 opt-in/out。已在 `pnpm-workspace.yaml` 的 `allowBuilds:` 设 `sharp: false`（用 prebuilt binaries，不用 build native）。如复现：

```bash
grep "sharp" pnpm-workspace.yaml   # 应有 `sharp: false`
pnpm install
```

### `wrangler d1 migrations apply unequal-db` 报 "no migrations found"

迁移文件必须在 `apps/api/migrations/` 目录（由 `wrangler.jsonc` 的 `migrations_dir` 指定）。检查：

```bash
ls apps/api/migrations/             # 应有 0001_init.sql 等
cd apps/api && pnpm wrangler d1 migrations list unequal-db
```

### `/upload` 后 `/search` 没命中

D1 有数据但 Vectorize 没有 — upload 流程的两个 upsert 没都跑通。检查：

1. 是否在 admin UI 看到 `✅ 入库成功：N chunks`？N > 0 才说明 Vectorize.upsert 也跑了。
2. MiniMax API key 是否有效（`pnpm wrangler secret list`）。
3. 查询 query 是否与 chunk 内容语义相关（MiniMax 1024-dim embedding 对短查询/不相关 query 会返回低分）。

### Admin UI 调 API 报 CORS 错误

开发环境：Vite proxy 已处理（`/api/*` → `http://localhost:8787/*`），不应出现 CORS 错。

生产环境：API Worker 的 `ALLOWED_ORIGIN` 必须包含 admin 域名。修改 `wrangler.jsonc` 的 `vars.ALLOWED_ORIGIN`（如 `"https://unequal-admin.pages.dev"`），然后 `pnpm deploy:api`。

### `wrangler dev` 报 "Authentication error [code: 10000]"

未登录。跑 `pnpm wrangler login` 后重试。

### TypeScript 报 `Cannot find name 'Buffer'` 或 `Property 'env' does not exist on type 'ImportMeta'`

- `Buffer`: `apps/api` 已加 `import { Buffer } from "node:buffer"`，检查 `tsconfig.json` 是否有 `"types": ["@cloudflare/workers-types"]`。
- `import.meta.env`: `apps/admin` 已加 `"types": ["vite/client"]`，检查 `apps/admin/tsconfig.json`。

## 许可 / 致谢

个人项目，暂未开源许可证。