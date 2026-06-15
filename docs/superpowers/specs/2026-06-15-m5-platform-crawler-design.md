# M5 设计：小红书 + 微信公众号批量 URL 抓取（mock-first 骨架）

> **For agentic workers:** 配套 plan: `docs/superpowers/plans/2026-06-15-m5-platform-crawler-monorepo.md`（writing-plans 阶段产出）
> 上游：`构想.md §九 M4-M5` + `2026-06-14-unequal-top-level-design.md §1 §6 §9`；spec 复用：M4 crawler design §3 pipeline + M0+M1 /ingest endpoint。
> 关联：`docs/superpowers/specs/2026-06-15-agent-dispatch-protocol.md`（长任务子 agent 派发协议，subagent 心跳+abort+主线程 install）

**Goal:** 把 `apps/crawler` 扩展为支持小红书 / 微信公众号两个源的批量 URL 列表抓取器，admin 加 2 个并列抓取页，全部 mock-first，复用 M0+M1 `/ingest`。**范围严格限制在骨架 + URL 列表导入**，登录态自动抓账号推到 v2+/M5.5。

---

## 1. 范围（in-scope）

### 1.1 apps/crawler 新增

| 路径 | 用途 |
|---|---|
| `apps/crawler/src/sources/xiaohongshu.ts` | XHS 单帖 URL → fetch + cheerio + 提取 title / author / publishedAt / content |
| `apps/crawler/src/sources/wechat-mp.ts` | WX-MP 单文章 URL → fetch + cheerio + 提取 title / account / publishedAt / content |
| `apps/crawler/test/xiaohongshu.test.ts` | 4 单测（happy / 缺 author / 缺 publishedAt / 空 content） |
| `apps/crawler/test/wechat-mp.test.ts` | 4 单测（happy / 缺 account / 缺 publish_time / 404 HTML） |
| `apps/crawler/test/fixtures/xiaohongshu-note.html` | 5 KB fixture，含 og:title / author / published_time / detail-desc |
| `apps/crawler/test/fixtures/wechat-mp-article.html` | 5 KB fixture，含 activity-name / js_name / publish_time / js_content |

### 1.2 apps/crawler 扩展

| 路径 | 改动 |
|---|---|
| `apps/crawler/src/main.ts` | 增加 `--source-type xiaohongshu\|wechat-mp\|webpage` 选项；分发到对应 sources/ 模块 |
| `apps/crawler/src/ingest.ts` | 复用 M4 已实现的 POST /ingest，零改动 |
| `apps/crawler/src/types.ts` | 扩展：`CrawledDocument` 加可选字段 `platformSpecific: { author?: string; account?: string; publishedAt?: string }`；既覆盖 XHS 又覆盖 WX-MP 又不打破 M4 `webpage` 的现有结构 |

### 1.3 apps/admin 新增

| 路径 | 用途 |
|---|---|
| `apps/admin/src/pages/XiaohongshuCrawlPage.tsx` | XHS 抓取页：textarea + trust_level 下拉（默认 1）+ 提交按钮 + 结果列表（行内红/黄/绿）+ 确认入库按钮 |
| `apps/admin/src/pages/WechatMpCrawlPage.tsx` | WX-MP 抓取页：同结构，trust_level 默认 2 |
| `apps/admin/src/lib/dedupe.ts` | localStorage URL 去重（最近 100 条） |
| `apps/admin/src/lib/api.ts` | 扩展：`crawlXiaohongshuUrls(urls)` / `crawlWechatMpUrls(urls)` — mock-first 返 fixture |
| `apps/admin/public/mock-crawl/xiaohongshu.json` | dev fixture：3 个 URL → 完整解析结果 |
| `apps/admin/public/mock-crawl/wechat-mp.json` | dev fixture：3 个 URL → 完整解析结果 |
| `apps/admin/src/App.tsx` | 加 `/crawl/xiaohongshu` + `/crawl/wechat-mp` 路由，nav 栏两个新链接 |
| `apps/admin/src/components/...` | 复用 M4 `CrawlPage` 已有的 `ResultRow` 等小组件（如有）；不强制拆分 |

### 1.4 docs/

| 路径 | 用途 |
|---|---|
| `docs/platform-crawler-setup.md` | XHS / WX-MP 各自用法 + 真平台风险说明 + v2+ 登录态路线 |
| `README.md` | 追加 M5 状态段 |

### 1.5 根级配置

无。`pnpm-workspace.yaml` 已通配 `apps/*`，新文件无需改 yaml。

### 1.6 不修改

- `apps/api/`：M5 零后端改动（复用 `/ingest`）
- `packages/shared/`：M5 不引入新共享类型
- `apps/api/migrations/`：无新 migration（D1 schema 已有 `source.type` 包含 `'xiaohongshu' | 'wechat-mp'`，见 top-level design §4.1）
- `apps/admin/src/pages/CrawlPage.tsx`：M4 已有网页抓取页，不动

---

## 2. 范围外（out-of-scope，推到 v2+ / M5.5）

| 项 | 推到 | 备注 |
|---|---|---|
| 登录态自动抓账号（小红书 App 抓包 / 公众号 cookie 注入） | v2+ / M5.5 | 与 M5 范围独立，避免 ToS 风险 |
| 反爬绕过（代理 IP 池 / UA 轮换 / 验证码识别） | v2+ | 真平台抓取前提 |
| Cron 定时抓取（Cloudflare Cron / 本地 launchd） | v2+ | 手动触发优先 |
| `/api/xhs-batch` / `/api/wxmp-batch` 真 endpoint | v2+ | M5 admin 直接调 fixture；真接时薄 proxy |
| admin 真调真抓（fixture → 真平台） | v2+ / CP-5 | 真接 Cloudflare URL 后改 `api.ts` 即可 |
| 按 content hash 去重 | v2+ | M5 只按 URL |
| robots.txt 自动遵守 | 生产前必做（v2+） | M5 手动审查 |
| 抓取失败自动重试 / 指数退避 | v2+ | M5 单次抓取 |

---

## 3. 关键技术设计

### 3.1 抓取 pipeline（每平台）

```
URL (XHS / WX-MP)
  ↓
  fetch (undici) → HTML string
  ↓
  cheerio.load(html) → $
  ↓
  平台特定 selectors:
    XHS: meta[property="og:title"] | .author .username | meta[property="article:published_time"] | #detail-desc
    WX-MP: #activity-name | #js_name | #publish_time | #js_content
  ↓
  → { title, author/account, publishedAt, content, paragraphs }
  ↓
  buildIngestPayload({ source: { type: 'xiaohongshu'|'wechat-mp', title, url, account, trust_level },
                        document: { title, raw_path, parsed_text },
                        chunks: [...] })
  ↓
  POST /ingest (复用 M0+M1)
```

### 3.2 /ingest 复用（M0+M1）

M0+M1 已实现 `POST /ingest` endpoint（`apps/api/src/routes/ingest.ts`），schema：

```ts
{
  source: { type: 'file'|'webpage'|'xiaohongshu'|'wechat-mp', title, url, account?, trust_level, meta? },
  document: { title, raw_path, parsed_text },
  chunks: [{ idx, content, token_count, trust_level }]
}
```

D1 schema 已有 `source.type` 字面量包含 `xiaohongshu` 和 `wechat-mp`（见 top-level design §4.1）。M5 抓取器直接构造 source.type='xiaohongshu' / 'wechat-mp' 调 /ingest，**零后端改动**。

### 3.3 每个 URL = 1 source + 1 document

**一批 URL 不打包成 1 个 source**。理由：
- 复用 `/ingest` 单文档 schema，零 schema 改动
- admin 列表 / 去重 / 按 URL 跳过都自然
- 同账号 10 篇文章 = 10 个 source 行，每个都有 `account` 字段（可筛选）

### 3.4 admin 抓取页 UI 设计

每个抓取页（XiaohongshuCrawlPage / WechatMpCrawlPage）结构：

```
┌─ 抓取 ─────────────────────────────────────────┐
│ URL（每行一个）:                                │
│ ┌─────────────────────────────────────────────┐ │
│ │ url 1                                       │ │
│ │ url 2                                       │ │
│ │ url 3                                       │ │
│ └─────────────────────────────────────────────┘ │
│ trust_level: [1 ▼] (默认 1)  [开始抓取] [清空] │
│                                                  │
│ ── 结果 ─────────────────────────────────────  │
│ ✓ url1  《title》                              │
│           作者 · publishedAt                     │
│           content preview                       │
│           [查看详情] [跳过]                      │
│ ✗ url2  未命中 fixture（mock-first 模式）        │
│ ⚠ url3  该 URL 已入库（2026-06-10）            │
│                                                  │
│ 共 3 条: 成功 1 / 失败 1 / 重复 1                │
│ [确认入库] [取消]                                │
└──────────────────────────────────────────────────┘
```

### 3.5 Mock-first 边界（与 M2/M3/M4 一致）

| 操作 | 状态 |
|---|---|
| 抓真网（任何真 URL） | ❌ 不做 |
| 配代理 IP | ❌ 不做 |
| 登录态 cookie 注入 | ❌ 不做（推 v2+） |
| `apps/crawler/src/sources/{xiaohongshu,wechat-mp}.ts` 实现 | ✅ 全做（依赖 fetch + cheerio） |
| `apps/crawler/test/{xiaohongshu,wechat-mp}.test.ts` mock HTTP + fixture HTML | ✅ Vitest |
| admin 抓取页接 fixture JSON + mock 层 | ✅ 全做（Vite 静态服务） |
| admin 真抓真网 | ❌ 不做（CP-5 后） |
| 真接 Cloudflare 跑生产抓取 | 🟡 v2+（CP-5 真接后） |

### 3.6 admin dev 验真编译走通（M3-realdeploy 教训应用）

M3-realdeploy 真机预览补漏段（state-m3.md）：mock-first 验收只跑 Vitest + tsc + admin build 不够，必须 dev server 真编译走一遍。M5 admin 抓取页验收追加：

- `pnpm dev:admin` 真启动
- 浏览器打开 `/crawl/xiaohongshu`
- 输入 fixture 中 3 个 URL → 点提交 → 看到 mock 命中结果列表
- 点「确认入库」→ 看到 ingesting → done 状态机走完

任何 dev 编译错（如 M3 那种 Vite 解析 wx 全局类型错）或运行时错（如 fetch 路径错）都不算「M5 完成」。

### 3.7 与 M0+M1 / M2 / M3 / M4 边界

- ✅ 复用：`apps/api/src/routes/ingest.ts`（M0+M1）— 接受 source.type='xiaohongshu'|'wechat-mp' 不改
- ✅ 复用：`apps/admin/src/lib/api.ts` 的 `getToken()`（M0+M1）— 抓取页用同一 token
- ✅ 复用：`apps/crawler/src/ingest.ts`（M4）— submitToInest 函数不变
- ✅ 复用：`packages/shared/src/chunking.ts`（M0+M1）— 抓取后调 chunking.ts 切分
- ✅ 复用：`apps/crawler/src/sources/webpage.ts`（M4）— 不动，作为 M5 的同包范例
- ❌ 不动：apps/api 任何代码、packages/shared 任何代码

---

## 4. 数据流（端到端 mock-first）

```
┌─────────────────────────────────────────────────┐
│ Admin XiaohongshuCrawlPage / WechatMpCrawlPage  │
│  textarea (URLs) + trust_level dropdown + 提交    │
└──────────────────┬──────────────────────────────┘
                   │ 1) 提交时 fetch /mock-crawl/xiaohongshu.json
                   │    (Vite 静态服务 fixture map)
                   ▼
┌─────────────────────────────────────────────────┐
│ 前端 mock 层 (apps/admin/src/lib/api.ts)         │
│  按 URL 查 fixture → 命中返 {title,...}         │
│                  未命中返 {ok:false, reason}    │
│  (去重: localStorage 已存在 URL 标黄)            │
└──────────────────┬──────────────────────────────┘
                   │ 2) 用户点「确认入库」后批量 POST /ingest
                   │    每个 URL 一次调用, 串行或并发
                   ▼
┌─────────────────────────────────────────────────┐
│ Cloudflare Worker /ingest (M0+M1, 零改动)       │
│  source.type='xiaohongshu' / 'wechat-mp'        │
│  source.account=作者/公众号名                    │
│  source.trust_level=用户选                       │
│  document.title / parsed_text                    │
│  chunks[]                                       │
└──────────────────┬──────────────────────────────┘
                   │ 写 D1.source + D1.document + D1.chunk
                   │ (Vectorize 远端 binding mock-first 500 — 已知)
                   ▼
              知识库新增 N 个 source + N 个 document + N×k 个 chunk
```

mock-first 模式下：admin fixture 命中 OK；/ingest 在 Vectorize 远端 binding 缺失时 500（与 M4 一致，预期行为）。

---

## 5. 验收标准

| 项 | 标准 |
|---|---|
| `pnpm -F crawler test` | 8 用例全绿（xiaohongshu 4 + wechat-mp 4） |
| `pnpm -r typecheck` | 5 包全绿（api / admin / shared / crawler / miniprogram） |
| `pnpm -F admin build` | 成功（含 XiaohongshuCrawlPage + WechatMpCrawlPage） |
| `pnpm dev:admin` 真编译 | 启动成功，`/crawl/xiaohongshu` + `/crawl/wechat-mp` 可访问 |
| admin 输入 fixture URL 提交 | mock 命中，状态机走完（idle → fetching → result → ingesting → done） |
| fixture HTML × 2 | 每个 ≥ 5 KB，含全部 parser 所需 selectors |
| `docs/platform-crawler-setup.md` | 完整（XHS / WX-MP 各自用法 + 真平台风险 + v2+ 路线） |
| README M5 段 | 已有，引用 setup doc |

---

## 6. CP 划分（建议 4 个 checkpoint）

| CP | 范围 | Task 数 | 验证标准 |
|---|---|---|---|
| **CP-1** | crawler lib 骨架：`sources/xiaohongshu.ts` + `sources/wechat-mp.ts` + parser + types + fixture HTML × 2 + 8 单测全绿 | 4-5 | `pnpm -F crawler test` 8 绿 |
| **CP-2** | crawler main.ts 扩展 + CLI smoke test + Vitest mock fetch | 1-2 | CLI dry-run 跑 fixture URL 出 title |
| **CP-3** | admin 2 抓取页 + 路由 + mock fixture JSON × 2 + dedupe lib | 3-4 | admin build 绿 + `pnpm dev:admin` 真打开走通 |
| **CP-4** | docs/platform-crawler-setup.md + README M5 段 + 全测绿 | 1-2 | 文档齐全 + 71 用例绿（46 M0-M3 + 11 M4 + 8 M5 crawler + 4 M5 admin dedupe；最终以 `pnpm -r test` 输出为准） |

**预估总 task 数**：9-13 task（与 M4 的 13 task 量级相当）。

---

## 7. 错误处理（逐 URL 隔离）

| 场景 | 行为 |
|---|---|
| Fixture 未命中（admin 输入的 URL 不在 fixture map） | 该 URL 行红框 + 「未命中 fixture（mock-first 模式）」 |
| Fixture 命中但解析失败（mock HTML 缺字段） | 该 URL 行红框 + 「解析失败：缺 {field}」 |
| 入库失败（mock-first 下 Vectorize 500） | 该 URL 行红框 + 「/ingest 500（Vectorize 远端 binding 缺失，CP-5 后正常）」 |
| 重复 URL | 提交时 client-side 检查 → 黄框提示「该 URL 已入库（source.title=...）」 |
| Trust_level 未选 / 选 0 | 提交按钮 disabled，「请选择 trust_level」提示 |

**单条失败不影响其他 URL**。状态机：

```
idle → fetching → result → ingesting → done
  ↑__________________________________↓
                  清空
```

---

## 8. 去重策略（client-side，mock-first 范围）

**实现位置**：`apps/admin/src/lib/dedupe.ts`

**数据源**：本地 `localStorage` 存最近 100 条已入库 URL（与 M0+M1 admin token 存储模式一致）

**流程**：
1. 用户输入 URL → 提交时先过滤掉 localStorage 已存在 URL → 黄框列出跳过项
2. 提交时同时记入 localStorage
3. /ingest 真成功后（mock-first 下 Vectorize 500 也算成功创建了 D1.source 行）→ 写入 localStorage

**v2+ 改进**：调 `/sources?url=...` 后端查 D1.source 表（mock-first 不可用，因为没有 GET /sources endpoint）。M5 用 localStorage 顶替。

---

## 9. 与上游 spec 的偏差

无。M5 范围严格对齐 `构想.md §九 M4-M5` + `2026-06-14-unequal-top-level-design.md §1 §6 §9`。

具体设计决策记录：

| 决策点 | 选择 | 理由 |
|---|---|---|
| M5 范围 | 两平台都做骨架 + URL 列表 | 复用骨架 ~80%；手动复制 URL 比自动登录抓账号更可控；反幻觉原则相关（用户挑好源 > 平台全量抓） |
| URL 输入 | 两个独立 section | 平台默认值不同（XHS L1 / WX-MP L2）；决策点显式化；调试粒度清 |
| trust_level | UI 默认 + 强制确认 | 反幻觉原则要求决策点显式化 |
| 去重 | 按 URL（localStorage） | 实现最简；v2+ 改 content hash |
| mock-first | 完全 mock-first | 与 M3/M4 一致；CP-5 真接 |
| admin endpoint | 前端 mock 返 fixture | 与 M4 mock-first 风格一致；一个 fixture 两个用途（Vitest + dev 验） |
| 测试范围 | 只 crawler 包单测 | 与 M4 一致；admin UI 用 dev 验而非 RTL 单测 |
