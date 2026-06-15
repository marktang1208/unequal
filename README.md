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