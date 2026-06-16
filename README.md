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