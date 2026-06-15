# M5 State

> M5 实施收尾归档（参考 M0+M1/M2/M3 state.md 模式）。归档时间：2026-06-16。
> 配套：spec = `docs/superpowers/specs/2026-06-15-m5-platform-crawler-design.md`，plan = `docs/superpowers/plans/2026-06-15-m5-platform-crawler-monorepo.md`。

## Mock-first 边界（严格遵守）

M5 全程零真人操作：
- ❌ 不抓真网（任何真 XHS / WX-MP URL）
- ❌ 不配代理 IP / UA 轮换
- ❌ 不接登录态自动抓账号
- ❌ 不实跑 wrangler 真接 Cloudflare
- ✅ source adapter 用本地 fixture HTML + Vitest mock fetch
- ✅ admin 抓取页接 `/mock-crawl/{platform}.json`（Vite 静态服务）
- ✅ admin dev 验真编译走通（M3-realdeploy 教训应用）
- ✅ 验收：8 crawler 用例 + 4 admin dedupe 用例 + typecheck + admin build 全绿

## Checkpoint pass 标准（全部达成）

| CP | Tasks | Pass 标准 | 实际 |
|---|---|---|---|
| CP-1 | 1-4 | crawler 8 用例 + typecheck 绿 | ✅ 19 crawler 用例绿（M4 11 + M5 8） |
| CP-2 | 5-6 | main.ts --source-type + CLI smoke test | ✅ 2 source types dispatch work |
| CP-3 | 7-10 | admin mock + dedupe + 2 抓取页 + 路由 + dev 验 | ✅ build 绿 + dev 4 endpoints 200 |
| CP-4 | 11-12 | docs + README + 全测绿 | ✅ 73 用例绿（46 M0-M3 + 11 M4 + 8 M5 crawler + 4 M5 admin + 4 api 新增） |

## 与 spec 的偏差

### 1. dedupe 单测需 jsdom env（Task 8 发现）

**Spec 原计划**：直接在 Node 环境跑 vitest 测 dedupe（基于 localStorage）。

**实际偏差**：Node 无 `globalThis.localStorage`，4 个 dedupe 单测全报 `ReferenceError`。

**实际方案**：Task 8 implementer 增加：
- `apps/admin/vitest.config.ts` 加 `environment: 'jsdom'`
- `apps/admin/package.json` 加 `jsdom` devDep
- `pnpm-lock.yaml` 同步

提交 commit `067b27b` 同时带 6 个文件改动（spec 未列支持文件，implementer 合在一起 commit 合理）。

### 2. types.ts `platformSpecific` JSDoc 矛盾（Task 1 review 触发）

**Spec 原计划**：`publishedAt?: string` JSDoc 写「ISO 字符串，平台原始格式」（自相矛盾）。

**实际修复**：code reviewer (Explore) flag 后，inline 改 JSDoc 明确：
- XHS：`meta[property="article:published_time"]` 通常 ISO 8601
- WX-MP：`#publish_time` 文本（例 `2026-06-08 14:23`）
- 命名统一：`author` 字段 XHS=用户名 / WX-MP=公众号名

提交 commit `da67a02`（separate commit from initial `4eebad1`）。

### 3. `pnpm -F crawler dev` 脚本本身 broken（pre-existing M4 issue）

**Spec 未提**。

**Task 5 implementer 发现**：`node --experimental-strip-types apps/crawler/src/main.ts` 立即失败 — Node 的 `--experimental-strip-types` 只 strip types，不 rewrite `.js` import suffixes 到 `.ts` 文件。源文件全用 `.js` 后缀（TypeScript ESM 惯例），但只有 `.ts` 存在。

**实际方案**：implementer 用临时 ESM loader hook（`/tmp/.js-to-ts-loader.mjs`）跑通 smoke test。**功能 work（两个 source title 都出对）**，但 `dev` 脚本本身需要后续修（加 `tsx` 依赖或换 runner）。

**非 M5 引入** — M4 commit `f004995` 就这样了。建议推 v2+ 或独立 fix task。**不在 M5 scope**。

### 4. admin pages 重复代码（Task 9 — DRY 边界）

**Plan 接受**：`XiaohongshuCrawlPage.tsx` 和 `WechatMpCrawlPage.tsx` 几乎 100% 相同（仅 trust_level 默认值 + crawl 函数不同），~95% 重复。

**reviewer 评估**：2 实例 DRY 边界 — 接受（不抽组件，避免 v1 过早抽象）。

**v2+ 改进路径**：如果加第三个平台（抖音？知乎？），抽 `<PlatformCrawlForm>` 共享组件。

### 5. Plan 文件 Task 11 行号偏差

**Plan 写的 modify 行号**：`apps/admin/src/App.tsx` 第 7 行附近 import / 第 36 行 nav / 第 50 行 route。

**实际行号**：第 8-9 行 import / 第 40-45 行 nav / 第 59-60 行 route。

**Implementer 处理**：先 Read App.tsx 确认实际行号，按实际位置 apply。无代码偏差。

## 未做项（推到 v2+ / M5.5）

1. **真接 Cloudflare（CP-5）** — 需 `wrangler login` + 真 D1 ID + 真 Vectorize index + 真 MiniMax API key + 真 admin token
2. **登录态自动抓账号**（小红书 App 抓包 / 公众号 cookie 注入）— v2+ / M5.5，需要第三方服务（NewRank / 蝉妈妈 / 西瓜数据）或自实现
3. **反爬策略**（代理 IP / UA 轮换 / 验证码识别）— v2+，真平台抓取前提
4. **Cron 定时抓取**（Cloudflare Cron Triggers / 本地 launchd）— v2+
5. **`/api/xhs-batch` / `/api/wxmp-batch` 真 endpoint** — v2+，admin 直接调 fixture 是 mock-first 简化
6. **按 content hash 去重** — v2+，M5 只按 URL（localStorage）
7. **robots.txt 自动遵守** — 生产前必做，M5 手动审查
8. **抓取失败自动重试 / 指数退避** — v2+
9. **`pnpm -F crawler dev` 脚本修复**（pre-existing M4 issue）— 独立 fix task
10. **admin 抓取页 RTL 单测** — v2+，M5 仅 crawler 包 + dedupe 单测；admin UI 用 dev 验
11. **多轮抓取调度 / 任务队列** — M6 / v2+

## 10 task commit 汇总（m5-platform-crawler 分支，已 merge to master）

| Task | Commit | 主题 |
|---|---|---|
| spec | `9a20c8d` | M5 spec for XHS + WeChat-MP platform crawler (mock-first skeleton) |
| plan | `dcc51ab` | M5 12-task implementation plan |
| 1 | `4eebad1` | types.ts extend CrawledDocument with platformSpecific optional field |
| 1 (fix) | `da67a02` | types.ts clarify platformSpecific JSDoc (XHS/WX-MP format diff, v2+ union hint) |
| 2 | `21f831e` | XHS source adapter + 4 vitest unit tests + fixture HTML |
| 3 | `6aaf2b1` | WX-MP source adapter + 4 vitest unit tests + fixture HTML |
| 4 | — | CP-1 final verification (无 dirty) |
| 5 | `bf0d3d8` | main.ts add --source-type option (webpage\|xiaohongshu\|wechat-mp) |
| 6 | — | CP-2 final verification (无 dirty) |
| 7 | `9ca9b5b` | admin mock-crawl fixtures (3 XHS + 3 WX-MP URLs) |
| 8 | `067b27b` | dedupe lib (4 vitest tests) + api.ts 2 mock-first crawl functions |
| 9 | `dceb30d` | 2 admin crawl pages (XHS / WX-MP) with mock-first UX |
| 10 | `055e643` | App.tsx add /crawl/xiaohongshu + /crawl/wechat-mp routes + nav links |
| 11 | `4d1eafa` | docs/platform-crawler-setup.md + README M5 section |
| 12 | — | CP-4 final verification (无 dirty) |
| merge | `e492cc6` | Merge branch 'm5-platform-crawler' (no-ff, comprehensive message) |

## 测试矩阵（最终）

- `pnpm -F crawler test`：19 用例全绿（webpage 4 + ingest 3 + parser 4 + xiaohongshu 4 + wechat-mp 4）
- `pnpm -F admin test`：4 用例全绿（dedupe 4）
- `pnpm -r typecheck`：5 包全绿（api / admin / shared / crawler / miniprogram）
- `pnpm -F admin build`：成功（189.67 kB / 59.20 kB gzip）
- 累计测试用例（M0-M5）：**73 用例全绿**
  - packages/shared: 26
  - apps/api: 20
  - apps/miniprogram: 4
  - apps/crawler: 19（M4 11 + M5 8）
  - apps/admin: 4（M5 新增）

## dev verification（M3-realdeploy 教训应用）

Task 10 验证 dev server 真启动后 4 endpoints 返 HTTP 200：
- `/crawl/xiaohongshu` → 200
- `/crawl/wechat-mp` → 200
- `/mock-crawl/xiaohongshu.json` → 200
- `/mock-crawl/wechat-mp.json` → 200

fixture JSON 头部内容已现场验证有效（Vite publicDir 默认 `apps/admin/public/`，无需 vite.config 改动）。

## ECC 组件使用（M5）

| 组件 | 用法 |
|---|---|
| superpowers:brainstorming | M5 spec 设计阶段（澄清 7 个关键问题） |
| superpowers:writing-plans | M5 12-task plan 产出 |
| superpowers:using-git-worktrees | `.claude/worktrees/m5-platform-crawler` 建立 |
| superpowers:subagent-driven-development | 9 个实施 task × (implementer + combined reviewer) |
| superpowers:verification-before-completion | CP-4 验证步骤 |
| superpowers:finishing-a-development-branch | merge to master + 清理 worktree + 删分支 |

未触发：react-review（路由改动小）、cloudflare / workers-best-practices（M5 零后端改动）、durable-objects（M6 才用）。

## 真接 Cloudflare 路径（CP-5 备查）

将来 M5.5 / CP-5 真接时必走：

1. **Cloudflare 资源**（一次性）：
   ```bash
   cd apps/api
   pnpm wrangler login
   pnpm wrangler d1 create unequal-db    # 拿 database_id
   pnpm wrangler vectorize create unequal-chunks --dimensions=1024 --metric=cosine
   pnpm wrangler r2 bucket create unequal-storage
   ```

2. **改 `apps/api/wrangler.jsonc`**：
   - `database_id` = step 1 拿到的 D1 ID
   - `vars.ALLOWED_ORIGIN` 加 admin 域名（生产）

3. **配 secrets**：
   ```bash
   pnpm wrangler secret put ADMIN_TOKEN
   pnpm wrangler secret put MINIMAX_API_KEY
   ```

4. **改 `apps/admin/src/lib/api.ts`** 2 个 mock-first 函数 → 调真 `https://unequal-api.xxx.workers.dev/api/{platform}-batch` endpoint
   - 加 `/api/xhs-batch` + `/api/wxmp-batch` 真 endpoint（薄 proxy → admin 调 → Worker 调 crawler）
   - 或：apps/api 直接 import apps/crawler 包（monorepo 跨包 import）

5. **重跑 admin dev 验真接**：`pnpm dev:api` 跑 wrangler dev 后，admin 输入真 XHS / WX-MP URL 看真抓（注意反爬可能挡住，需代理 / UA）

## 下一步建议

**M6 = 多轮会话 + Durable Objects + 真鉴权** — 真正"用户能用的产品"里程碑。

Top-level design 已规划：
- `2026-06-14-unequal-top-level-design.md §3.3` 用户体系 / §5.3 多轮对话 / §2 Durable Objects 子系统
- 状态从「家长能用的小程序单轮问答 + 多源知识库」升级到「可登录的多轮会话产品」

直接进入 M6 brainstorming。
