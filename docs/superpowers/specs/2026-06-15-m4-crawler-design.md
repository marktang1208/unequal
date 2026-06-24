# M4 设计：网页抓取（curl + cheerio → /ingest）

> **For agentic workers:** 配套 plan: `docs/archive/plans/2026-06-15-m4-crawler-monorepo.md`（writing-plans 阶段产出）
> 上游：构想.md §九 M4 + §6 目录；spec 复用：M2 ask design §5 ask 编排 + M0+M1 /ingest endpoint。

**Goal:** 落地 `apps/crawler/` monorepo 包（TypeScript + curl + cheerio）+ admin 抓取页，端到端抓取指定 URL → 提取正文 → 调 /ingest 入库。零浏览器依赖（无 Playwright），mock-first 全程不抓真网。

---

## 1. 范围（in-scope）

### 1.1 apps/crawler 新增

| 路径 | 用途 |
|---|---|
| `apps/crawler/package.json` | npm 包（typecheck + test scripts + devDep：cheerio + typescript + vitest + undici） |
| `apps/crawler/tsconfig.json` | extends 根 tsconfig.base.json |
| `apps/crawler/.gitignore` | node_modules + dist |
| `apps/crawler/vitest.config.ts` | vitest 配置 |
| `apps/crawler/src/types.ts` | 抓取结果类型（CrawledDocument） |
| `apps/crawler/src/sources/webpage.ts` | URL 抓取 + HTML 解析 + 正文提取（cheerio） |
| `apps/crawler/src/main.ts` | CLI 入口（接受 `--url` `--ingest-url` `--user-id` 等参数） |
| `apps/crawler/src/parser.ts` | HTML → 纯文本 + title（cheerio selectors） |
| `apps/crawler/src/ingest.ts` | 调 /ingest endpoint 提交（fetch wrapper） |
| `apps/crawler/test/webpage.test.ts` | 抓取 + 解析单测（mock HTTP + fixture HTML） |
| `apps/crawler/test/ingest.test.ts` | ingest 提交单测（mock fetch） |
| `apps/crawler/test/fixtures/sample-article.html` | 测试用 fixture HTML（5 KB） |

### 1.2 apps/admin 新增/修改

| 路径 | 用途 |
|---|---|
| `apps/admin/src/lib/api.ts` | 加 `crawlUrl(url): Promise<CrawlResult>` |
| `apps/admin/src/pages/CrawlPage.tsx` | 抓取页：URL 输入框 + 抓取按钮 + 结果展示（title / paragraphs / ingest status） |
| `apps/admin/src/App.tsx` | 加 /crawl 路由 + 导航 |

### 1.3 docs/

| 路径 | 用途 |
|---|---|
| `docs/webpage-crawler-setup.md` | 抓取器使用 + 真人操作（生产 Cron / 代理 IP / 限速） |
| `README.md` | 追加 M4 状态段 |

### 1.4 根级配置

| 路径 | 用途 |
|---|---|
| `pnpm-workspace.yaml` | 加 `apps/crawler` |

### 1.5 不修改

- `packages/shared/`：M4 不引入新共享类型
- `apps/api/`：复用现有 /ingest endpoint（M0+M1 已实现）
- `apps/api/migrations/`：无新 migration（/ingest 接受 source.type='webpage'，复用 0001_init schema）

---

## 2. 范围外（out-of-scope，推 v2+/M5+）

- ❌ Playwright 浏览器渲染（JavaScript SPA / 动态加载）— 推到 v2+ Cloudflare Browser Rendering
- ❌ 小红书 / 微信公众号抓取 — M5 范围
- ❌ 反爬策略（代理 IP 池 / User-Agent 轮换 / 验证码识别）— 简单起步，v2+ 强化
- ❌ 抓取 Cron 定时（本地 Mac launchd / Cloudflare Workers Cron）— v2+
- ❌ 抓取去重（按 URL hash 跳过已入库）— v2+ 文档增删改场景
- ❌ 抓取失败重试 / 指数退避 — 简单 1 次抓取，v2+ 加 retry
- ❌ JS 渲染的 SPA 抓取（React/Vue SSR） — 需要 Playwright
- ❌ Cookie / 登录态 — 公开页面起步

---

## 3. 关键技术设计

### 3.1 抓取 pipeline

```
URL → fetch (undici) → HTML string
     → cheerio.load(html) → $
     → $('article, main, .content, body').text() → 纯文本
     → $('title').text() → title
     → 调 /ingest endpoint → { source, document, chunks }
```

### 3.2 /ingest 复用（M0+M1）

M0+M1 已实现 `POST /ingest` endpoint（apps/api/src/routes/ingest.ts），接受：
```ts
{
  source: { type: 'file' | 'webpage' | 'xiaohongshu' | 'wechat-mp', title, url, account?, trust_level, meta? },
  document: { title, raw_path, parsed_text },
  chunks: [{ idx, content, token_count, trust_level }]
}
```

M4 抓取 webpage 类型时直接构造 source.type='webpage' 调 /ingest，零后端改动。

### 3.3 Mock-first 边界（与 M2/M3 一致）

| 操作 | 状态 |
|---|---|
| 抓取真网（任何真 URL） | ❌ 不做 |
| 配代理 IP | ❌ 不做 |
| Cron 定时 | ❌ 不做 |
| `apps/crawler/src/sources/webpage.ts` 实现 | ✅ 全做（依赖 fetch + cheerio） |
| `apps/crawler/test/webpage.test.ts` mock HTTP + fixture HTML | ✅ Vitest |
| admin CrawlPage 接 /crawl endpoint 或直接调 crawler CLI | ✅ 全做（admin 调 API 走 Vite proxy） |
| 抓取已知 fixture URL（test fixture 路径） | ✅ 单元测试 |
| 真接 Cloudflare 跑生产抓取 | 🟡 v2+（CP-5 真接后） |

### 3.4 与 M0+M1 / M2 边界

- ✅ 复用：`apps/api/src/routes/ingest.ts`（M0+M1）— 接受 source.type='webpage' 不改
- ✅ 复用：`apps/admin/src/lib/api.ts` 的 `getToken()`（M0+M1）— admin CrawlPage 用同一 token
- ✅ 复用：`packages/shared/src/chunking.ts`（M0+M1）— 抓取后调 chunking.ts 切分
- ❌ 不动：apps/api 任何代码（crawler 是客户端）
- ❌ 不动：apps/admin AskTest / ChatSim（已存在）

### 3.5 admin CrawlPage UI 设计

- 顶部：URL 输入框（textarea 或 input）+ "抓取"按钮 + "清空"按钮
- 中部：抓取结果展示
  - 标题：`<h2>`，source 链接
  - 来源类型 badge：`webpage` (绿)
  - trust_level 选择（dropdown 0/1/2/3）
  - 段落数 + 总字符数
  - "入库到 /ingest"按钮
- 底部：抓取历史（最近 10 条 URL）

---

## 4. 数据流（端到端）

```
┌────────────────────────────────┐
│ Admin CrawlPage (or CLI)       │
│ URL: https://example.com/...   │
└──────────┬─────────────────────┘
           │ crawlUrl(url)
┌──────────▼─────────────────────┐
│ apps/crawler (CLI or lib)      │
│ fetch → cheerio → title + text │
└──────────┬─────────────────────┘
           │ POST /ingest { source, document, chunks }
┌──────────▼─────────────────────┐
│ Cloudflare Worker API          │
│ /ingest → chunking → embed     │
│  → D1 + Vectorize (D1 真 +    │
│    Vectorize mock-first 500)   │
└────────────────────────────────┘
```

mock-first 模式下：抓取 OK，ingest 在 Vectorize 远端 binding 缺失时 500（已知）。Crawler 本身的抓取 + 解析逻辑可独立验证。

---

## 5. 验收标准

| 项 | 标准 |
|---|---|
| `pnpm -r typecheck` | 全绿（5 包） |
| `pnpm -F crawler test` | ≥ 6 用例（webpage.test.ts: 4 + ingest.test.ts: 2）全绿 |
| `pnpm -F admin build` | 成功（含 CrawlPage） |
| 抓取 fixture HTML 5 KB | parser 提取 title + ≥ 3 段 + 字符数合理 |
| 调 /ingest with mock-first | （V2 真实 Vectorize 后验证；M4 阶段不强求 200） |
| `docs/webpage-crawler-setup.md` | 完整 |
| README M4 段 | 已有 |

---

## 6. CP 划分（建议 4 个）

| CP | 范围 | Task 数 |
|---|---|---|
| CP-1 | monorepo 接入 + lib 层（types + parser + webpage + ingest）+ Vitest 单测 | 4-5 |
| CP-2 | CLI 入口 + fixture HTML + curl smoke test | 1-2 |
| CP-3 | admin CrawlPage + 路由 + 集成 crawler lib | 2-3 |
| CP-4 | docs + README + 收尾 | 1-2 |

具体 task 划分由 writing-plans skill 产出。

---

## 7. 与上游 spec 的偏差

无。M4 范围严格对齐 `构想.md §九 M4 + §6 目录`。
