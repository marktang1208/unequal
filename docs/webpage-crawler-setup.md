# 网页抓取器使用 + 真人操作 Checklist

> M4 mock-first 阶段代码完整（`apps/crawler/` + admin CrawlPage `/crawl`），但**真抓真网 / 配 Cron / 限速 / 反爬**需真人操作。
> 本文档按时间顺序列出，从「零」到「本地端到端跑通抓取」+ 「生产前 checklist」。

目标读者：项目作者本人（非团队 — 涉及 Cloudflare 账号、代理 IP、目标站 robots.txt 都是个人主体决策）。

预计耗时：
- 端到端本地验证（CLI / admin）：10 分钟
- 真接 Cloudflare Vectorize（CP-5 范围）：30 分钟
- 真抓真网 + 限速 + 反爬（v2+）：半天到一天

---

## 0. 前置确认

开始前，确认本地已经跑通 M0+M1+M2+M3：

```bash
# 1. 后端 mock 跑通（参见 README.md 「M2 状态」段）
curl -X POST http://localhost:8787/ask \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"q":"5个月宝宝发烧38.5怎么办？"}'

# 2. admin CrawlPage 跑通（参见 README.md 「M3 状态」段 + 本文档 §3）
pnpm -F admin dev
# 浏览器打开 http://localhost:5173/crawl
```

如果上面任一不通过，先回到 README 排错，不要往下走。

---

## 1. 抓取器架构

### 1.1 技术栈

| 组件 | 选型 | 理由 |
|------|------|------|
| HTTP 客户端 | Node `fetch`（globalThis 内置） | 零依赖；undici 作为 Node 18+ 默认 fetch 实现已足够 |
| HTML 解析 | cheerio 1.0 | 服务端 jQuery 风格 API，零浏览器依赖，体积小 |
| TS runtime | tsx / `tsc + node` | CP-4 阶段用 `node` 直跑编译产物（plan 见 §1.3） |
| 测试 | vitest | 11 个用例覆盖 parser / webpage / ingest |

**核心原则：零浏览器依赖**。不打包 Puppeteer / Playwright / headless Chrome — 这些会引入 200MB+ 镜像和复杂 CI 部署。

### 1.2 文件结构

```
apps/crawler/
├── package.json                  # name=crawler, typecheck/test scripts
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── types.ts                  # CrawledDocument + IngestPayload 类型
│   ├── parser.ts                 # cheerio HTML → 段落数组 + totalChars
│   ├── ingest.ts                 # buildIngestPayload + submitToIngest
│   ├── main.ts                   # CLI 入口（解析 argv + 调用 fetchUrl + 可选 /ingest）
│   └── sources/
│       └── webpage.ts            # fetchUrl(url) → CrawledDocument（fetch + parser）
└── test/
    ├── parser.test.ts            # 4 用例（fixture HTML + 段落提取 + 字符数）
    ├── webpage.test.ts           # 4 用例（fetch 成功 + 解析失败 + 非 200 + 网络错）
    ├── ingest.test.ts            # 3 用例（payload 构建 + 鉴权头 + 错误态）
    └── fixtures/
        └── sample-article.html   # parser 测试夹具
```

### 1.3 不支持（v1 已知）

| 能力 | 状态 | 替代 |
|------|------|------|
| JS SPA 渲染（React/Vue 客户端渲染） | ❌ cheerio 只能解析 SSR HTML | v2+ 接 Playwright / Cloudflare Browser Rendering |
| 反爬（Cloudflare anti-bot / 验证码） | ❌ 不做 | v2+ 接打码平台 / 代理 IP 池 |
| Cron 定时抓取 | ❌ 不做 | v2+ launchd / Cloudflare Cron Triggers |
| robots.txt 自动遵守 | ❌ 不做 | 生产前真人审查目标站 |
| 代理 IP 池 | ❌ 不做 | v2+ 集成商业代理 |
| User-Agent 轮换 | ⚠️ 单 UA（v1 默认 desktop UA） | v2+ 随机 UA 池 |
| 登录态 / Cookie | ❌ 不做 | v2+ session 复用 |

---

## 2. CLI 用法

### 2.1 启动方式

CLI 通过 `apps/crawler/src/main.ts` 暴露。当前 `apps/crawler/package.json` 的 scripts 是 `typecheck` / `test`，**没 `dev` script**。

**当前可直接执行的命令**（CP-4 阶段）：

```bash
cd /Users/Mark/cc_project/unequal
node apps/crawler/src/main.ts --url "https://example.com/article" --no-ingest
```

**期望的便捷命令**（`apps/crawler/package.json` 加 `"dev": "node src/main.ts"` 后）：

```bash
# dry-run：只抓不调 /ingest，打印解析结果（调试首选）
pnpm -F crawler dev --url https://example.com/article --trust 2 --no-ingest

# 真接 /ingest：抓 + 入库（需要本地 wrangler dev 跑着 + ADMIN_TOKEN）
pnpm -F crawler dev --url https://example.com/article \
  --user-id 01H0000000000000000000000 \
  --token "$ADMIN_TOKEN" \
  --trust 2
```

> 注：当前 package.json 还没有 `dev` script。两种方案任选其一：
> 1. 在 `apps/crawler/package.json` 加 `"dev": "node src/main.ts"`，重启 `pnpm install`
> 2. 直接 `node apps/crawler/src/main.ts --url ...`（效果完全一样）

### 2.2 参数说明

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `--url <URL>` | ✅ | — | 抓取目标 URL（必须是 http/https） |
| `--trust <0\|1\|2\|3>` | ❌ | `2` | trust level（0=UGC 不可信 / 1=半可信 / 2=可信 / 3=内部权威） |
| `--user-id <UUID>` | ❌ | `01H0000000000000000000000`（占位） | 入库时的 user_id 字段 |
| `--token <str>` | ❌（除非走 ingest） | — | admin token，对应 `apps/api/.dev.vars` 的 `ADMIN_TOKEN` |
| `--ingest-url <URL>` | ❌ | `http://localhost:8787/ingest` | 目标 /ingest endpoint |
| `--no-ingest` | ❌ | `false` | 只抓不调 ingest（dry-run，调试用） |

`--trust` / `--user-id` / `--token` 在 `--no-ingest` 模式下不生效。

### 2.3 输出格式

成功（dry-run）：

```text
[crawler] fetch https://example.com/article
[crawler] title: 文章标题
[crawler] paragraphs: 12, totalChars: 3456
[crawler] --no-ingest set, skipping ingest
{
  "url": "https://example.com/article",
  "title": "文章标题",
  "paragraphs": ["第一段...", "第二段..."],
  "totalChars": 3456,
  "fetchedAt": "2026-06-15T10:30:00.000Z"
}
```

成功（真接 /ingest）：

```text
[crawler] fetch https://example.com/article
[crawler] title: 文章标题
[crawler] paragraphs: 12, totalChars: 3456
[crawler] submit to http://localhost:8787/ingest
[crawler] ingest ok: sourceId=src_abc123 documentId=doc_xyz789
```

错误（典型）：

```text
[crawler] fetch https://blocked.example.com/article
[crawler] fatal: fetch failed: ECONNREFUSED
# 或
[crawler] ingest failed: 500 internal server error
```

---

## 3. admin CrawlPage 用法

### 3.1 启动

```bash
# 终端 1：本地后端
pnpm dev:api    # wrangler dev → http://localhost:8787

# 终端 2：admin UI
pnpm -F admin dev    # vite → http://localhost:5173
```

### 3.2 访问 /crawl 路由

1. 浏览器打开 `http://localhost:5173/crawl`
2. 左侧 nav 栏有「网页抓取」链接（m4-crawler CP-3 任务 10 加的）
3. 页面分两段：
   - 上：**表单**（URL 输入框 + trust level 下拉 + 抓取按钮）
   - 下：**结果展示**（抓取成功后显示，错误时显示红框）

### 3.3 操作步骤

| 步骤 | 操作 | 期望 |
|------|------|------|
| 1 | 在 URL 输入框填 `https://example.com/article` | — |
| 2 | 选择 trust level（默认 2 可信） | — |
| 3 | 点击「抓取」 | 按钮变「抓取中…」禁用态 |
| 4 | 等待 1-3 秒 | 下方出现结果卡片 |
| 5 | 查看结果 | 见 §3.4 |

### 3.4 结果展示

抓取成功后，admin CrawlPage 显示：

| 字段 | 来源 | 说明 |
|------|------|------|
| `title` | `<title>` 或首段前 60 字 | 抓取页标题 |
| `url` | 原始 URL | 点击可跳外链（新窗口） |
| `fetchedAt` | ISO 时间戳 | 服务端 fetch 完成时刻 |
| `trust <N>` 标签 | 抓取时选的 trust level | 颜色编码（trust 0-3） |
| 「已入库 / 未入库」标签 | `/ingest` 返回的 `ingested` 字段 | mock-first 模式下经常显示「未入库」 |
| `sourceId` | `/ingest` 返回 | 入库成功后才有 |
| `documentId` | `/ingest` 返回 | 入库成功后才有 |
| `chunks` | `/ingest` 返回 | 入库 chunk 数（mock-first 通常是 0） |
| `Content（前 500 字）` | `paragraphs` 拼接后截 500 字 | 解析后的可读文本预览 |

### 3.5 错误显示

错误时显示红框「抓取失败」+ 具体错误信息：

| 错误现象 | 原因 | 处置 |
|---------|------|------|
| `/crawl 404: Not Found` | mock-first 模式下 apps/api 没实现 /api/crawl endpoint，admin 直接 fetch 端点不存在 | **预期行为**，等 CP-5 真接 Cloudflare |
| `Network request failed` | 后端 wrangler dev 没跑 | 终端 1 跑 `pnpm dev:api` |
| `500 internal server error` | Vectorize 远端 binding 没真接 | mock-first 已知，CP-5 修复 |
| `401 unauthorized` | ADMIN_TOKEN 不匹配 | 检查 `apps/api/.dev.vars` |
| 抓取超时（>30s） | 目标站慢 / block 国内 IP | 换目标站或加代理（v2+） |

---

## 4. 程序化调用（其他 Worker / 脚本）

如需在另一个 Node 脚本里集成抓取器：

```ts
import { fetchUrl } from "./apps/crawler/src/sources/webpage.js";
import { buildIngestPayload, submitToIngest } from "./apps/crawler/src/ingest.js";

const doc = await fetchUrl("https://example.com/article");

const payload = buildIngestPayload(doc, {
  userId: "01H0000000000000000000000",
  trustLevel: 2,
});

const result = await submitToIngest(doc, {
  ingestUrl: "http://localhost:8787/ingest",
  token: process.env.ADMIN_TOKEN!,
  userId: "01H0000000000000000000000",
  trustLevel: 2,
});

if (result.ok) {
  console.log(`ingested: sourceId=${result.sourceId}, documentId=${result.documentId}`);
}
```

`fetchUrl` 内部走 `globalThis.fetch`，可用 `vi.fn()` mock 测试（见 `apps/crawler/test/webpage.test.ts` 4 用例）。

---

## 5. mock-first 局限

| 场景 | M4 行为 | 真接后 |
|------|--------|--------|
| 抓取真网 | ❌ 不做（CP-4 阶段无真抓测试） | §6 真抓前 checklist |
| `/ingest` 调远端 Vectorize binding | ⚠️ mock-first 下 500（无真 Vectorize index） | CP-5 真接后正常返回 chunks > 0 |
| admin 抓取 UI 显示 | ✅ 抓取 + 解析可验 | — |
| `/api/crawl` endpoint | ❌ mock-first 模式下 apps/api 没实现 | CP-5 真接后加 thin proxy |
| Cloudflare Vectorize 真 index | ❌ 没创建 | `wrangler vectorize create unequal-chunks --dimensions=1024 --metric=cosine` |

---

## 6. 真人操作 Checklist（生产前必做）

### 6.1 真接 Cloudflare Vectorize（CP-5 范围）

```bash
cd apps/api
pnpm wrangler login
pnpm wrangler vectorize create unequal-chunks --dimensions=1024 --metric=cosine
# 拿返回的 index_name，填到 apps/api/wrangler.jsonc 的 vectorize[0].index_name

pnpm wrangler d1 create unequal-db   # 已有可跳过
pnpm wrangler r2 bucket create unequal-storage   # 已有可跳过
pnpm wrangler secret put ADMIN_TOKEN
pnpm wrangler secret put MINIMAX_API_KEY

pnpm deploy:api
```

### 6.2 代理 IP 池（避免单 IP 被封）

简单起步：v1 阶段不做，限速到合理水位（§6.3）。

生产（v2+）：
- 商业代理（Bright Data / Oxylabs / SmartProxy）— 个人项目成本按量计
- 自建代理池（云函数 egress IP）— 部署复杂
- 跳过：只抓内部可信源（如崔玉涛官网 / WHO 官方）

### 6.3 限速（建议每域名每分钟 ≤ 30 次）

`apps/crawler/src/sources/webpage.ts` 当前没限速。v1 范围内不抓真网所以无所谓；真接前最低限度加 setTimeout：

```ts
// 伪代码示意
async function fetchUrlWithRateLimit(url: string, lastFetchedAt: number) {
  const elapsed = Date.now() - lastFetchedAt;
  const minInterval = 2000;  // 2s = 30 req/min
  if (elapsed < minInterval) {
    await new Promise(r => setTimeout(r, minInterval - elapsed));
  }
  return fetchUrl(url);
}
```

生产（v2+）：
- `p-queue` 或 `bottleneck` 库做并发限流
- 每个 host 独立队列
- 失败重试指数退避

### 6.4 抓取频率（Cron 定时推 v2+）

v1 范围：手工触发（CLI 或 admin）。

v2+ 方案对比：

| 方案 | 适用 | 备注 |
|------|------|------|
| macOS launchd | 个人本机定时 | 简单，但电脑要常开 |
| Cloudflare Cron Triggers | 生产 | 与 Worker 集成，免费额度够用 |
| GitHub Actions cron | 个人项目托管 | 公开仓库 free，私有仓库有 minutes 限制 |

macOS launchd 示例（每 6 小时抓一次 URL 列表）：

```bash
0 */6 * * * cd /Users/Mark/cc_project/unequal && node apps/crawler/src/main.ts --url "https://..." --token "$ADMIN_TOKEN" >> /var/log/crawler.log 2>&1
```

### 6.5 反爬应对（推 v2+）

| 场景 | 应对 |
|------|------|
| Cloudflare anti-bot 拦截 | v2+ 接 Cloudflare Browser Rendering（直接绕过） |
| 验证码（reCAPTCHA / hCaptcha） | v2+ 接打码平台（如不抓需要登录的页面可跳过） |
| IP 黑名单 | §6.2 代理 IP 池 |
| UA 校验失败 | §6.6 UA 轮换 |
| robots.txt 限制 | §6.7 手动审查 |

### 6.6 User-Agent 轮换

v1 默认 desktop Chrome UA。目标站 UA 校验严格时（如某些新闻站）：

```ts
const UAs = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
];
const ua = UAs[Math.floor(Math.random() * UAs.length)];
```

### 6.7 JS SPA 抓取（推 v2+ Playwright 或 Cloudflare Browser Rendering）

cheerio 只能解析 SSR HTML。遇到以下情况内容为空：
- 客户端渲染（React/Vue SPA，初次返回 `<div id="root"></div>`）
- 内容由 JS 注入（如某些新闻站 lazy load）

v2+ 方案：
- **本地**：Playwright（装 Chromium ~200MB）
- **Serverless**：Cloudflare Browser Rendering（按请求计费）
- **替代**：找该站的 RSS / sitemap（很多站提供 `/sitemap.xml` 含全文）

### 6.8 robots.txt 遵守（生产前必做）

生产前手动检查目标站 robots.txt：

```bash
curl https://example.com/robots.txt
# 看 User-agent: * + Disallow: /articles/ 之类
# 决定抓取范围
```

如果目标站 robots 禁止某路径（如 `/private/`），**永远不要抓** — 不仅是道德问题，也是法律风险（CFAA / 当地爬虫法规）。

---

## 7. 故障排查

| 症状 | 可能原因 | 排查 |
|------|---------|------|
| CLI 报 `fetch failed: ECONNREFUSED` | 目标站拒绝连接 / IP 被封 | `curl -I https://target.com` 看是否连通；考虑代理 |
| CLI 报 `fetch failed: ETIMEDOUT` | 网络超时 / 防火墙 | 增加 timeout（当前 30s 默认）；检查防火墙 |
| 解析段落为空 | SPA 渲染（cheerio 拿不到内容） | v2+ Playwright；或检查 HTML 源码 |
| 解析段落少（应有 N 段实际 M 段） | cheerio 只抓 `<p>` 标签 | `apps/crawler/src/parser.ts` 加 selector 配置（v2+） |
| `/ingest` 500 | Vectorize 远端 binding 缺失 | CP-5 真接 Cloudflare |
| `/ingest` 401 | admin token 不对 | 检查 `apps/api/.dev.vars` 的 `ADMIN_TOKEN`，CLI 传对应 `--token` |
| admin `/crawl` 404 | mock-first 模式下 apps/api 没实现 /api/crawl endpoint | **预期行为**，等 CP-5 |
| admin 显示「未入库」但无报错 | `/api/crawl` 调用的是 mock fetch，没真走 /ingest | mock-first 已知；CrawlPage 错误态正常 |
| `pnpm -F crawler dev` 报 `Missing script` | apps/crawler/package.json 没 `dev` script | 用 `node apps/crawler/src/main.ts --url ...` 直接跑；或加 `"dev": "node src/main.ts"` |
| 字符数统计 < 实际 | cheerio 只抓 `<p>` 标签；如有 `<div>` 内容需 v2+ 自定义 selector | 改 parser.ts 加 selector 配置 |

---

## 8. 速查：commit 后的下一步

| 状态 | 下一步 |
|------|--------|
| 没跑过抓取 | §0 前置 → §2 CLI 或 §3 admin |
| CLI / admin 都通，但 /ingest 500 | §6.1 真接 Cloudflare（CP-5 范围） |
| 都不想跑真网 | §5 mock-first 局限 + admin UI 验证即可 |
| 真接 Cloudflare 后想上生产 | §6 真人操作 checklist（限速 + 反爬 + robots.txt） |
| 想抓 SPA | §6.7 Playwright（v2+） |
| 想定时抓 | §6.4 Cron（v2+） |

---

## 关联文档

- 设计稿：`docs/superpowers/specs/2026-06-15-m4-crawler-design.md`
- M4 计划：`docs/superpowers/plans/2026-06-15-m4-crawler-monorepo.md`
- 总 README：`README.md`（M4 段）
- M3 真机联调（同样 mock-first 模式）：`docs/wechat-miniprogram-setup.md`
- /ingest endpoint 接收方（M0+M1）：`apps/api/src/routes/ingest.ts`
- cheerio 解析逻辑：`apps/crawler/src/parser.ts`
- 抓取实现：`apps/crawler/src/sources/webpage.ts`
