# M5 Implementation Plan: 小红书 + 微信公众号批量 URL 抓取（mock-first 骨架）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/crawler` 扩展为支持小红书 / 微信公众号两个源的批量 URL 列表抓取器；admin 加 2 个并列抓取页（`/crawl/xiaohongshu` + `/crawl/wechat-mp`）；全部 mock-first；复用 M0+M1 `/ingest` endpoint，零后端改动。登录态自动抓账号推 v2+/M5.5。

**Architecture:**
- `apps/crawler/src/sources/{xiaohongshu,wechat-mp}.ts` 用 cheerio 解析各平台 HTML → 提取 `title / author(account) / publishedAt / paragraphs`
- `apps/crawler/src/types.ts` 扩展 `CrawledDocument` 加可选 `platformSpecific` 字段；既覆盖 XHS 又覆盖 WX-MP 又不打破 M4 `webpage` 现有结构
- `apps/crawler/src/main.ts` 扩展 `--source-type` 选项，分发到对应 sources/ 模块
- admin 抓取页接本地 mock fixture（`apps/admin/public/mock-crawl/{xiaohongshu,wechat-mp}.json`，Vite 静态服务），mock-first 命中 fixture 即视为抓取成功
- `apps/admin/src/lib/dedupe.ts` 用 localStorage 存最近 100 条已入库 URL，去重
- 抓取结果批量 POST `/ingest`，每个 URL = 1 source + 1 document（M0+M1 schema 不变）

**Tech Stack:**
- 现有：Hono 4.5 + Vitest 2.0 + TypeScript 5.5 + React 18 + Vite 5 + cheerio 1.0
- 新增：零运行时依赖（与 M4 crawler lib 一致；admin mock fixture 是静态 JSON）
- 复用：`apps/api/src/routes/ingest.ts`（M0+M1）、`apps/crawler/src/ingest.ts`（M4）、`apps/crawler/src/sources/webpage.ts`（M4）

---
**Spec:** `docs/superpowers/specs/2026-06-15-m5-platform-crawler-design.md`（304 行，CP 划分、错误处理逐 URL 隔离、localStorage 去重、mock-first fixture 设计）

---

## 0. 工作区设置

- 分支：`m5-platform-crawler`（基于 `master` 当前 HEAD `9a20c8d`，即 M5 spec commit）
- Worktree 路径：`/Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler`
- 不进 master，所有 12 个 task 在 worktree 内完成
- 4 CP，CP 边界不强制 commit squash（每 task 一 commit）
- 结束用 `superpowers:finishing-a-development-branch` 决定 merge

**为什么用 worktree**：M5 涉及 13 新增文件 + 2 路由 + 多包 TDD（crawler + admin），与 master 隔离最稳。

---

## 1. 文件结构

### 1.1 现有文件（M4 已有，M5 不改）

```
apps/crawler/
├── src/parser.ts                # M4 已有
├── src/sources/webpage.ts       # M4 已有
└── src/ingest.ts                # M4 已有
```

### 1.2 新增 + 修改

```
apps/crawler/
├── src/
│   ├── types.ts                 # MODIFY — 加 platformSpecific 可选字段
│   ├── sources/
│   │   ├── xiaohongshu.ts       # NEW — XHS 单帖 URL 抓取
│   │   └── wechat-mp.ts         # NEW — WX-MP 单文章 URL 抓取
│   └── main.ts                  # MODIFY — 加 --source-type 选项
└── test/
    ├── xiaohongshu.test.ts      # NEW — 4 用例
    ├── wechat-mp.test.ts        # NEW — 4 用例
    └── fixtures/
        ├── xiaohongshu-note.html    # NEW — 5 KB fixture
        └── wechat-mp-article.html   # NEW — 5 KB fixture

apps/admin/
├── src/
│   ├── App.tsx                  # MODIFY — 加 /crawl/xiaohongshu + /crawl/wechat-mp 路由
│   ├── lib/
│   │   ├── api.ts               # MODIFY — 加 crawlXiaohongshuUrls + crawlWechatMpUrls
│   │   ├── dedupe.ts            # NEW — localStorage URL 去重
│   │   └── dedupe.test.ts       # NEW — 4 用例
│   └── pages/
│       ├── XiaohongshuCrawlPage.tsx   # NEW — XHS 抓取页
│       └── WechatMpCrawlPage.tsx      # NEW — WX-MP 抓取页
└── public/mock-crawl/
    ├── xiaohongshu.json         # NEW — dev fixture map
    └── wechat-mp.json           # NEW — dev fixture map

docs/platform-crawler-setup.md   # NEW
README.md                        # MODIFY — 追加 M5 状态段
```

### 1.3 不修改

- `apps/api/`：M5 零后端改动
- `packages/shared/`：M5 不引入新共享类型
- `apps/api/migrations/`：无新 migration
- `apps/admin/src/pages/CrawlPage.tsx`：M4 网页抓取页不动

---

## CP-1: types.ts 扩展 + 2 个 source adapter + 8 单测

**目标**：crawler lib 加 2 个 source adapter，覆盖 XHS / WX-MP 的 cheerio parser + 平台特定字段提取。零 CLI、零 UI。

**完成定义**：`pnpm -F crawler test` 8 用例全绿（xiaohongshu 4 + wechat-mp 4），typecheck 绿。

---

### Task 1: 扩展 types.ts 加 platformSpecific 字段

**Files:**
- Modify: `apps/crawler/src/types.ts:4-13`

- [ ] **Step 1: 修改 types.ts 的 CrawledDocument interface**

打开 `apps/crawler/src/types.ts`。把现有的 `CrawledDocument` interface（4-13 行）替换为：

```ts
/**
 * 网页抓取结果。
 *
 * `platformSpecific` 是 M5 引入的可选扩展字段，覆盖非通用 webpage 场景：
 * - 小红书：author（小红书用户名）+ publishedAt（发布时间）
 * - 微信公众号：account（公众号名）+ publishedAt（发布时间）
 * - 普通 webpage：不填
 *
 * M4 webpage source 不写该字段，运行时安全。
 */
export interface CrawledDocument {
  url: string;
  title: string;
  /** 抓取到的纯文本段落（去 HTML 标签后） */
  paragraphs: string[];
  /** 所有段落拼接的总字符数 */
  totalChars: number;
  /** 抓取时间戳 ms */
  fetchedAt: number;
  /** 平台特定字段（XHS / WX-MP 填，普通 webpage 留空） */
  platformSpecific?: {
    /** 小红书：用户名；微信公众号：公众号名 */
    author?: string;
    /** 发布或更新时间（ISO 字符串，平台原始格式） */
    publishedAt?: string;
  };
}
```

其他 interface（IngestPayload）保持不变。

- [ ] **Step 2: 验证 typecheck 仍绿**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F crawler typecheck 2>&1 | tail -10
```

预期：`tsc --noEmit` 退出 0。可选字段新增不会破坏 M4 `fetchUrl` 实现的类型推导（它不写 platformSpecific，所以字段 undefined）。

- [ ] **Step 3: 验证 M4 既有 6 用例仍绿（确保 types 扩展无回归）**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F crawler test 2>&1 | tail -20
```

预期：6 用例全绿（webpage.test.ts 4 + ingest.test.ts 2）。如果失败，说明 platformSpecific 的可选设计破坏了某个测试，需要排查。

- [ ] **Step 4: commit**

```bash
git add apps/crawler/src/types.ts
git commit -m "M5 task 1: extend CrawledDocument with platformSpecific optional field"
```

---

### Task 2: XHS source adapter + fixture HTML + 4 单测（TDD）

**Files:**
- Create: `apps/crawler/src/sources/xiaohongshu.ts`
- Create: `apps/crawler/test/fixtures/xiaohongshu-note.html`
- Create: `apps/crawler/test/xiaohongshu.test.ts`

- [ ] **Step 1: 创建 fixture HTML 文件 `apps/crawler/test/fixtures/xiaohongshu-note.html`**

写入（最小可用 XHS 笔记 HTML，包含全部 parser 所需 selectors）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>5个月宝宝辅食添加全攻略 - 小红书</title>
  <meta property="og:title" content="5个月宝宝辅食添加全攻略">
  <meta property="article:published_time" content="2026-05-12T10:30:00+08:00">
  <meta name="author" content="小红书用户A">
</head>
<body>
  <div class="note-container">
    <div class="author">
      <span class="username">小红书用户A</span>
    </div>
    <div id="detail-desc">
      <p>宝宝5个月了，最近开始添加辅食。米粉是首选，从稀到稠，从少到多。</p>
      <p>第一口建议是高铁米粉，用温水冲调，搅拌至无颗粒。每天一次，观察3天无过敏反应再加量。</p>
      <p>常见误区：过早加盐、加糖、用奶瓶喂辅食。这些都会增加宝宝肾脏负担或导致龋齿。</p>
      <p>推荐食材：南瓜泥、胡萝卜泥、苹果泥（蒸熟后打泥）。每次只加一种新食材，便于观察过敏。</p>
    </div>
  </div>
</body>
</html>
```

文件大小应在 1-2 KB（spec 写的是 5 KB 但实际内容更小也够 parser 用；如需扩到 5 KB，加重复段落或更多 `<p>` 标签，但不要改 selectors）。

- [ ] **Step 2: 写 4 个失败的 Vitest 单测**

新建 `apps/crawler/test/xiaohongshu.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { fetchXiaohongshuNote } from "../src/sources/xiaohongshu.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures/xiaohongshu-note.html");

function loadFixture(): string {
  return readFileSync(FIXTURE_PATH, "utf-8");
}

/** mock fetch: 返 fixture HTML with status 200 */
function mockFetchFixture(): typeof fetch {
  return (async (_url: string) => {
    return new Response(loadFixture(), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
}

describe("fetchXiaohongshuNote", () => {
  it("extracts title from og:title meta", async () => {
    const doc = await fetchXiaohongshuNote("https://xiaohongshu.com/explore/abc123", {
      fetchImpl: mockFetchFixture(),
    });
    expect(doc.title).toBe("5个月宝宝辅食添加全攻略");
  });

  it("extracts author from .author .username", async () => {
    const doc = await fetchXiaohongshuNote("https://xiaohongshu.com/explore/abc123", {
      fetchImpl: mockFetchFixture(),
    });
    expect(doc.platformSpecific?.author).toBe("小红书用户A");
  });

  it("extracts publishedAt from article:published_time meta", async () => {
    const doc = await fetchXiaohongshuNote("https://xiaohongshu.com/explore/abc123", {
      fetchImpl: mockFetchFixture(),
    });
    expect(doc.platformSpecific?.publishedAt).toBe("2026-05-12T10:30:00+08:00");
  });

  it("extracts paragraphs from #detail-desc and computes totalChars", async () => {
    const doc = await fetchXiaohongshuNote("https://xiaohongshu.com/explore/abc123", {
      fetchImpl: mockFetchFixture(),
    });
    expect(doc.paragraphs.length).toBeGreaterThanOrEqual(4);
    expect(doc.totalChars).toBeGreaterThan(100);
    expect(doc.paragraphs[0]).toContain("米粉是首选");
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F crawler test xiaohongshu 2>&1 | tail -20
```

预期：FAIL — `Cannot find module '../src/sources/xiaohongshu.js'`（因为还没实现）。如果意外通过，说明实现意外存在，停下来排查。

- [ ] **Step 4: 实现 xiaohongshu.ts**

新建 `apps/crawler/src/sources/xiaohongshu.ts`：

```ts
import * as cheerio from "cheerio";
import type { CrawledDocument } from "../types.js";

export interface FetchXhsOptions {
  /** 测试用：注入 fake fetch */
  fetchImpl?: typeof fetch;
  /** User-Agent，默认 XHS 移动端 UA（提升兼容性） */
  userAgent?: string;
}

const DEFAULT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49 (0x18003130) NetType/WIFI Language/zh_CN";

/**
 * 抓取小红书单帖 URL → 解析 → 返回 CrawledDocument (含 platformSpecific)。
 *
 * 解析字段（按优先级降级）：
 * - title: og:title → <title>
 * - author: .author .username → meta[name="author"]
 * - publishedAt: meta[property="article:published_time"]
 * - paragraphs: #detail-desc p → .note-content p
 *
 * Mock-first：测试用 fetchImpl 注入。
 */
export async function fetchXiaohongshuNote(
  url: string,
  opts: FetchXhsOptions = {}
): Promise<CrawledDocument> {
  const f = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? DEFAULT_UA;

  const res = await f(url, { headers: { "user-agent": userAgent } });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  // title：og:title 优先，回退 <title>
  const ogTitle = $('meta[property="og:title"]').attr("content");
  const title = ogTitle?.trim() || $("title").first().text().trim() || url;

  // author：.author .username 优先，回退 meta[name=author]
  const authorFromDom = $(".author .username").first().text().trim();
  const authorFromMeta = $('meta[name="author"]').attr("content")?.trim();
  const author = authorFromDom || authorFromMeta || undefined;

  // publishedAt：article:published_time
  const publishedAt =
    $('meta[property="article:published_time"]').attr("content")?.trim() || undefined;

  // paragraphs：#detail-desc p 优先，回退 .note-content p
  const paragraphSelectors = ["#detail-desc p", ".note-content p", "#detail-desc"];
  let paragraphs: string[] = [];
  for (const sel of paragraphSelectors) {
    const found = $(sel)
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((t) => t.length > 0);
    if (found.length > 0) {
      paragraphs = found;
      break;
    }
  }
  const totalChars = paragraphs.reduce((sum, p) => sum + p.length, 0);

  const platformSpecific: CrawledDocument["platformSpecific"] = {};
  if (author) platformSpecific.author = author;
  if (publishedAt) platformSpecific.publishedAt = publishedAt;

  return {
    url,
    title,
    paragraphs,
    totalChars,
    fetchedAt: Date.now(),
    platformSpecific: Object.keys(platformSpecific).length > 0 ? platformSpecific : undefined,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F crawler test xiaohongshu 2>&1 | tail -20
```

预期：4 用例全绿。如果失败，根据错误信息调试（最常见 = cheerio selector 路径错，参考 fixture HTML 实际结构）。

- [ ] **Step 6: commit**

```bash
git add apps/crawler/src/sources/xiaohongshu.ts \
        apps/crawler/test/xiaohongshu.test.ts \
        apps/crawler/test/fixtures/xiaohongshu-note.html
git commit -m "M5 task 2: XHS source adapter + 4 vitest unit tests + fixture HTML"
```

---

### Task 3: WX-MP source adapter + fixture HTML + 4 单测（TDD）

**Files:**
- Create: `apps/crawler/src/sources/wechat-mp.ts`
- Create: `apps/crawler/test/fixtures/wechat-mp-article.html`
- Create: `apps/crawler/test/wechat-mp.test.ts`

- [ ] **Step 1: 创建 fixture HTML 文件 `apps/crawler/test/fixtures/wechat-mp-article.html`**

写入（最小可用微信公众号文章 HTML）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta property="og:title" content="宝宝发烧38.5度怎么办？儿科医生这样说">
  <meta name="description" content="复旦大学附属儿科医院呼吸科主任医师王立波">
</head>
<body>
  <div class="rich_media">
    <div id="js_name">儿科王医生</div>
    <h2 id="activity-name">宝宝发烧38.5度怎么办？儿科医生这样说</h2>
    <div id="publish_time">2026-06-08 14:23</div>
    <div id="js_content">
      <p>宝宝发烧38.5度是常见症状，家长不必过度紧张。先观察宝宝精神状态，能吃能玩就不必立即用药。</p>
      <p>3个月以下婴儿发烧应立即就医；3个月以上宝宝腋温超过38.5度且精神不好时，可考虑用布洛芬或对乙酰氨基酚。</p>
      <p>物理降温方法：温水擦浴、退热贴。避免酒精擦浴和冰水浴。</p>
      <p>出现以下情况立即就医：高烧超过3天、抽搐、持续嗜睡、拒绝进食、呼吸急促。</p>
      <p style="display:none">广告：本栏目由某奶粉品牌赞助</p>
    </div>
  </div>
</body>
</html>
```

- [ ] **Step 2: 写 4 个失败的 Vitest 单测**

新建 `apps/crawler/test/wechat-mp.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { fetchWechatMpArticle } from "../src/sources/wechat-mp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures/wechat-mp-article.html");

function loadFixture(): string {
  return readFileSync(FIXTURE_PATH, "utf-8");
}

function mockFetchFixture(): typeof fetch {
  return (async (_url: string) => {
    return new Response(loadFixture(), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
}

describe("fetchWechatMpArticle", () => {
  it("extracts title from #activity-name (overrides og:title)", async () => {
    const doc = await fetchWechatMpArticle("https://mp.weixin.qq.com/s/abc", {
      fetchImpl: mockFetchFixture(),
    });
    expect(doc.title).toBe("宝宝发烧38.5度怎么办？儿科医生这样说");
  });

  it("extracts account from #js_name (公众号名)", async () => {
    const doc = await fetchWechatMpArticle("https://mp.weixin.qq.com/s/abc", {
      fetchImpl: mockFetchFixture(),
    });
    expect(doc.platformSpecific?.author).toBe("儿科王医生");
  });

  it("extracts publishedAt from #publish_time text", async () => {
    const doc = await fetchWechatMpArticle("https://mp.weixin.qq.com/s/abc", {
      fetchImpl: mockFetchFixture(),
    });
    expect(doc.platformSpecific?.publishedAt).toBe("2026-06-08 14:23");
  });

  it("filters display:none (广告段落) from paragraphs", async () => {
    const doc = await fetchWechatMpArticle("https://mp.weixin.qq.com/s/abc", {
      fetchImpl: mockFetchFixture(),
    });
    // fixture 5 段，1 段 style="display:none" 应被过滤 → 4 段
    expect(doc.paragraphs.length).toBe(4);
    expect(doc.paragraphs.find((p) => p.includes("赞助"))).toBeUndefined();
    expect(doc.totalChars).toBeGreaterThan(100);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F crawler test wechat-mp 2>&1 | tail -20
```

预期：FAIL — `Cannot find module '../src/sources/wechat-mp.js'`。

- [ ] **Step 4: 实现 wechat-mp.ts**

新建 `apps/crawler/src/sources/wechat-mp.ts`：

```ts
import * as cheerio from "cheerio";
import type { CrawledDocument } from "../types.js";

export interface FetchWxMpOptions {
  /** 测试用：注入 fake fetch */
  fetchImpl?: typeof fetch;
  /** User-Agent，默认微信内置浏览器 UA */
  userAgent?: string;
}

const DEFAULT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49 (0x18003130) NetType/WIFI Language/zh_CN";

/**
 * 抓取微信公众号单文章 URL → 解析 → 返回 CrawledDocument (含 platformSpecific)。
 *
 * 解析字段：
 * - title: #activity-name（最强选择器，覆盖 og:title）
 * - account (#js_name) → 映射到 platformSpecific.author（统一字段名）
 * - publishedAt: #publish_time
 * - paragraphs: #js_content p，过滤 style="display:none"
 *
 * Mock-first：测试用 fetchImpl 注入。
 */
export async function fetchWechatMpArticle(
  url: string,
  opts: FetchWxMpOptions = {}
): Promise<CrawledDocument> {
  const f = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? DEFAULT_UA;

  const res = await f(url, { headers: { "user-agent": userAgent } });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  // title：#activity-name 优先
  const titleFromActivity = $("#activity-name").first().text().trim();
  const titleFromOg = $('meta[property="og:title"]').attr("content")?.trim();
  const title = titleFromActivity || titleFromOg || $("title").first().text().trim() || url;

  // account → 映射到 author
  const account = $("#js_name").first().text().trim() || undefined;

  // publishedAt
  const publishedAt = $("#publish_time").first().text().trim() || undefined;

  // paragraphs：过滤 display:none
  const paragraphs = $("#js_content p")
    .filter((_, el) => {
      const style = $(el).attr("style") ?? "";
      return !style.includes("display:none") && !style.includes("display: none");
    })
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => t.length > 0);

  const totalChars = paragraphs.reduce((sum, p) => sum + p.length, 0);

  const platformSpecific: CrawledDocument["platformSpecific"] = {};
  if (account) platformSpecific.author = account;
  if (publishedAt) platformSpecific.publishedAt = publishedAt;

  return {
    url,
    title,
    paragraphs,
    totalChars,
    fetchedAt: Date.now(),
    platformSpecific: Object.keys(platformSpecific).length > 0 ? platformSpecific : undefined,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F crawler test wechat-mp 2>&1 | tail -20
```

预期：4 用例全绿。如果失败，根据 cheerio selector 路径调试。

- [ ] **Step 6: commit**

```bash
git add apps/crawler/src/sources/wechat-mp.ts \
        apps/crawler/test/wechat-mp.test.ts \
        apps/crawler/test/fixtures/wechat-mp-article.html
git commit -m "M5 task 3: WX-MP source adapter + 4 vitest unit tests + fixture HTML"
```

---

### Task 4: CP-1 final verification

**Files:** 无（验证步骤）

- [ ] **Step 1: 跑全部 crawler 单测**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F crawler test 2>&1 | tail -30
```

预期：14 用例全绿（webpage 4 + ingest 2 + xiaohongshu 4 + wechat-mp 4）。任何红都回头排查。

- [ ] **Step 2: 跑 crawler typecheck**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F crawler typecheck 2>&1 | tail -10
```

预期：tsc 退出 0。

- [ ] **Step 3: CP-1 完成 — 无 commit**

无代码改动，仅验证。如绿，CP-1 done。如果需要修复代码，按相应 task amend 之前的 commit。

---

## CP-2: main.ts 扩展 + CLI smoke test

**目标**：CLI 支持 `--source-type xiaohongshu|wechat-mp|webpage` 选项，分发到对应 source adapter。

**完成定义**：CLI dry-run 跑 fixture URL 出 title。

---

### Task 5: main.ts 加 --source-type 选项

**Files:**
- Modify: `apps/crawler/src/main.ts:8-9,29-67`

- [ ] **Step 1: 修改 main.ts 顶部的 import**

把第 8-9 行：

```ts
import { fetchUrl } from "./sources/webpage.js";
import { buildIngestPayload, submitToIngest } from "./ingest.js";
```

替换为：

```ts
import { fetchUrl } from "./sources/webpage.js";
import { fetchXiaohongshuNote } from "./sources/xiaohongshu.js";
import { fetchWechatMpArticle } from "./sources/wechat-mp.js";
import { buildIngestPayload, submitToIngest } from "./ingest.js";
import type { CrawledDocument } from "./types.js";
```

- [ ] **Step 2: 在 main() 顶部加 source-type 解析**

在 `const url = args.url as string;`（第 31 行附近）**之前**插入：

```ts
  const sourceType = (args["source-type"] as string) ?? "webpage";
  if (!["webpage", "xiaohongshu", "wechat-mp"].includes(sourceType)) {
    console.error(`[crawler] invalid --source-type: ${sourceType} (must be webpage|xiaohongshu|wechat-mp)`);
    process.exit(1);
  }
```

- [ ] **Step 3: 修改 fetch dispatch**

把 `const doc = await fetchUrl(url);`（第 44 行附近）替换为：

```ts
  let doc: CrawledDocument;
  console.log(`[crawler] fetch ${url} (source-type: ${sourceType})`);
  if (sourceType === "xiaohongshu") {
    doc = await fetchXiaohongshuNote(url);
  } else if (sourceType === "wechat-mp") {
    doc = await fetchWechatMpArticle(url);
  } else {
    doc = await fetchUrl(url);
  }
```

- [ ] **Step 4: 更新 Usage 帮助文本**

把第 33 行的 console.error：

```ts
    console.error("Usage: --url <URL> [--ingest-url <URL>] [--token <T>] [--user-id <U>] [--trust 0-3] [--no-ingest]");
```

替换为：

```ts
    console.error("Usage: --url <URL> [--source-type webpage|xiaohongshu|wechat-mp] [--ingest-url <URL>] [--token <T>] [--user-id <U>] [--trust 0-3] [--no-ingest]");
```

- [ ] **Step 5: 跑 typecheck**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F crawler typecheck 2>&1 | tail -10
```

预期：tsc 退出 0。

- [ ] **Step 6: CLI smoke test — dry-run XHS fixture**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
node --experimental-strip-types apps/crawler/src/main.ts \
  --url "file:///Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler/apps/crawler/test/fixtures/xiaohongshu-note.html" \
  --source-type xiaohongshu \
  --no-ingest 2>&1 | tail -20
```

预期：包含 `[crawler] title: 5个月宝宝辅食添加全攻略` 一行。如果失败，检查 fetch file:// 是否在 Node 18+ 支持（应该支持）以及 cheerio 是否能解析 fixture HTML。

如果 file:// 不被 fetch 支持，改用 http server：先 `cd apps/crawler && python3 -m http.server 8765 &`，再 `--url http://localhost:8765/test/fixtures/xiaohongshu-note.html`。

- [ ] **Step 7: CLI smoke test — dry-run WX-MP fixture**

同 Step 6，把 `xiaohongshu-note.html` + `--source-type xiaohongshu` 改为 `wechat-mp-article.html` + `--source-type wechat-mp`。

预期：包含 `[crawler] title: 宝宝发烧38.5度怎么办？儿科医生这样说` 一行。

- [ ] **Step 8: commit**

```bash
git add apps/crawler/src/main.ts
git commit -m "M5 task 5: main.ts add --source-type option (webpage|xiaohongshu|wechat-mp)"
```

---

### Task 6: CP-2 final verification

**Files:** 无（验证步骤）

- [ ] **Step 1: 跑 typecheck + 全部 crawler 单测**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F crawler typecheck && pnpm -F crawler test 2>&1 | tail -30
```

预期：typecheck 绿 + 14 用例全绿。

- [ ] **Step 2: CP-2 完成 — 无 commit**

---

## CP-3: admin mock fixtures + dedupe + api.ts + 2 抓取页 + 路由

**目标**：admin 加 `/crawl/xiaohongshu` + `/crawl/wechat-mp` 两个抓取页，dev 模式下从 fixture 命中 mock 数据，mock-first 完整走通状态机（idle → fetching → result → ingesting → done）。

**完成定义**：`pnpm -F admin build` 成功 + `pnpm dev:admin` 真打开 + 输入 fixture URL 提交看到 mock 结果 + dedupe 单测全绿。

---

### Task 7: 创建 mock fixture JSON × 2

**Files:**
- Create: `apps/admin/public/mock-crawl/xiaohongshu.json`
- Create: `apps/admin/public/mock-crawl/wechat-mp.json`

- [ ] **Step 1: 创建 `apps/admin/public/mock-crawl/xiaohongshu.json`**

写入（URL → 解析结果 map，3 个 fixture）：

```json
{
  "https://xiaohongshu.com/explore/abc123": {
    "url": "https://xiaohongshu.com/explore/abc123",
    "title": "5个月宝宝辅食添加全攻略",
    "author": "小红书用户A",
    "publishedAt": "2026-05-12T10:30:00+08:00",
    "content": "宝宝5个月了，最近开始添加辅食。米粉是首选，从稀到稠，从少到多。第一口建议是高铁米粉，用温水冲调，搅拌至无颗粒。每天一次，观察3天无过敏反应再加量。",
    "paragraphs": [
      "宝宝5个月了，最近开始添加辅食。米粉是首选，从稀到稠，从少到多。",
      "第一口建议是高铁米粉，用温水冲调，搅拌至无颗粒。每天一次，观察3天无过敏反应再加量。",
      "常见误区：过早加盐、加糖、用奶瓶喂辅食。这些都会增加宝宝肾脏负担或导致龋齿。",
      "推荐食材：南瓜泥、胡萝卜泥、苹果泥（蒸熟后打泥）。每次只加一种新食材，便于观察过敏。"
    ]
  },
  "https://xiaohongshu.com/explore/def456": {
    "url": "https://xiaohongshu.com/explore/def456",
    "title": "宝宝发烧家庭护理指南",
    "author": "儿科护士小米",
    "publishedAt": "2026-05-20T16:00:00+08:00",
    "content": "宝宝发烧38.5度以下先观察。3个月以下立即就医。物理降温：温水擦浴。",
    "paragraphs": [
      "宝宝发烧38.5度以下先观察精神状态，能吃能玩不必立即用药。",
      "3个月以下婴儿发烧应立即就医。",
      "物理降温方法：温水擦浴、退热贴。",
      "高烧超过3天或出现抽搐、嗜睡、呼吸急促立即就医。"
    ]
  },
  "https://xiaohongshu.com/explore/ghi789": {
    "url": "https://xiaohongshu.com/explore/ghi789",
    "title": "崔玉涛谈宝宝睡眠训练",
    "author": "儿科专家崔玉涛",
    "publishedAt": "2026-04-15T09:00:00+08:00",
    "content": "睡眠训练不是哭声免疫法。循序渐进，建立规律作息。",
    "paragraphs": [
      "睡眠训练核心是建立规律作息，不是任由宝宝哭泣。",
      "0-3个月：按需喂养，不需要训练。",
      "4-6个月：可开始固定睡前程序（洗澡→抚触→喂奶→入睡）。",
      "不建议任何形式的哭声免疫法。"
    ]
  }
}
```

- [ ] **Step 2: 创建 `apps/admin/public/mock-crawl/wechat-mp.json`**

写入：

```json
{
  "https://mp.weixin.qq.com/s/wx_abc": {
    "url": "https://mp.weixin.qq.com/s/wx_abc",
    "title": "宝宝发烧38.5度怎么办？儿科医生这样说",
    "account": "儿科王医生",
    "publishedAt": "2026-06-08 14:23",
    "content": "宝宝发烧38.5度是常见症状，家长不必过度紧张。先观察宝宝精神状态。",
    "paragraphs": [
      "宝宝发烧38.5度是常见症状，家长不必过度紧张。先观察宝宝精神状态，能吃能玩就不必立即用药。",
      "3个月以下婴儿发烧应立即就医；3个月以上宝宝腋温超过38.5度且精神不好时，可考虑用布洛芬或对乙酰氨基酚。",
      "物理降温方法：温水擦浴、退热贴。避免酒精擦浴和冰水浴。",
      "出现以下情况立即就医：高烧超过3天、抽搐、持续嗜睡、拒绝进食、呼吸急促。"
    ]
  },
  "https://mp.weixin.qq.com/s/wx_def": {
    "url": "https://mp.weixin.qq.com/s/wx_def",
    "title": "美国儿科学会0-1岁喂养指南",
    "account": "丁香医生",
    "publishedAt": "2026-06-10T10:00:00+08:00",
    "content": "AAP建议纯母乳喂养至6个月。6个月后引入辅食，铁强化米粉是首选。",
    "paragraphs": [
      "AAP（美国儿科学会）建议纯母乳喂养至6个月。",
      "6个月后引入辅食，铁强化米粉是首选。",
      "1岁前不建议添加盐、糖、蜂蜜。",
      "每添加一种新食材观察3天无过敏反应再加下一种。"
    ]
  },
  "https://mp.weixin.qq.com/s/wx_ghi": {
    "url": "https://mp.weixin.qq.com/s/wx_ghi",
    "title": "宝宝疫苗接种时间表（2026最新版）",
    "account": "崔玉涛育儿百科",
    "publishedAt": "2026-06-12T08:00:00+08:00",
    "content": "国家免疫规划疫苗 + 自费疫苗完整时间表。",
    "paragraphs": [
      "出生时：卡介苗、乙肝疫苗第1针。",
      "1月龄：乙肝疫苗第2针。",
      "2月龄：脊灰疫苗第1针（灭活）。",
      "3月龄：百白破疫苗第1针、脊灰疫苗第2针。",
      "自费推荐：13价肺炎、五联疫苗、轮状病毒疫苗。"
    ]
  }
}
```

- [ ] **Step 3: 验证 Vite 静态服务能找到 fixture**

Vite dev 启动时会自动 serve `apps/admin/public/` 下的静态文件。无需特殊配置 — 后续 Task 10 的 dev 验会确认。

- [ ] **Step 4: commit**

```bash
git add apps/admin/public/mock-crawl/xiaohongshu.json apps/admin/public/mock-crawl/wechat-mp.json
git commit -m "M5 task 7: admin mock-crawl fixtures (3 XHS + 3 WX-MP URLs)"
```

---

### Task 8: dedupe lib (TDD) + api.ts 加 2 个 mock-first 函数

**Files:**
- Create: `apps/admin/src/lib/dedupe.test.ts`
- Create: `apps/admin/src/lib/dedupe.ts`
- Modify: `apps/admin/src/lib/api.ts`（追加 crawlXiaohongshuUrls + crawlWechatMpUrls + CrawlBatchResult 类型）

- [ ] **Step 1: 写 dedupe 的 4 个失败 Vitest 单测**

新建 `apps/admin/src/lib/dedupe.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { addUrl, isUrlSeen, getSeenUrls, _resetForTest } from "./dedupe.js";

beforeEach(() => {
  _resetForTest();
  localStorage.clear();
});

describe("dedupe", () => {
  it("addUrl + isUrlSeen returns true after add", () => {
    addUrl("https://example.com/a");
    expect(isUrlSeen("https://example.com/a")).toBe(true);
    expect(isUrlSeen("https://example.com/b")).toBe(false);
  });

  it("getSeenUrls returns all stored URLs", () => {
    addUrl("https://example.com/a");
    addUrl("https://example.com/b");
    addUrl("https://example.com/c");
    expect(getSeenUrls().sort()).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
  });

  it("caps storage at 100 entries (FIFO)", () => {
    for (let i = 0; i < 105; i++) {
      addUrl(`https://example.com/${i}`);
    }
    const all = getSeenUrls();
    expect(all.length).toBe(100);
    expect(isUrlSeen("https://example.com/0")).toBe(false);
    expect(isUrlSeen("https://example.com/104")).toBe(true);
  });

  it("handles localStorage.getItem returning null (first run)", () => {
    // 初始 _resetForTest + clear 已模拟
    expect(getSeenUrls()).toEqual([]);
    expect(isUrlSeen("https://example.com/x")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F admin test dedupe 2>&1 | tail -20
```

预期：FAIL — `Cannot find module './dedupe.js'`。如果 admin 包没装 vitest，先 `pnpm -F admin add -D vitest`（mock-first 允许 devDep install）。

- [ ] **Step 3: 实现 dedupe.ts**

新建 `apps/admin/src/lib/dedupe.ts`：

```ts
/**
 * URL 去重（client-side localStorage，M5 mock-first 范围）。
 * v2+ 改为调 /sources?url=... 后端查 D1。
 */

const STORAGE_KEY = "unequal_seen_urls";
const MAX_ENTRIES = 100;

export function addUrl(url: string): void {
  const seen = getSeenUrls();
  if (seen.includes(url)) return;
  seen.push(url);
  // FIFO: 超 100 条砍前面的
  if (seen.length > MAX_ENTRIES) {
    seen.splice(0, seen.length - MAX_ENTRIES);
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seen));
  } catch {
    // localStorage 满 / disabled：静默忽略
  }
}

export function isUrlSeen(url: string): boolean {
  return getSeenUrls().includes(url);
}

export function getSeenUrls(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 测试用：reset module-level state（仅用于 dedupe.test.ts） */
export function _resetForTest(): void {
  // 当前实现完全基于 localStorage，无 module-level state — 留空以保持 API 稳定
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F admin test dedupe 2>&1 | tail -20
```

预期：4 用例全绿。

- [ ] **Step 5: 在 `apps/admin/src/lib/api.ts` 末尾追加 2 个 mock-first 函数 + 类型**

把 `apps/admin/src/lib/api.ts` 末尾（`export async function crawlUrl` 之后）追加：

```ts

// ─────────────────────────────────────────────────────────
// M5: 小红书 / 微信公众号批量抓取（mock-first）
// ─────────────────────────────────────────────────────────

export interface PlatformCrawledDoc {
  url: string;
  title: string;
  author: string;
  publishedAt: string;
  content: string;
  paragraphs: string[];
}

export type PlatformCrawlOutcome =
  | { ok: true; doc: PlatformCrawledDoc }
  | { ok: false; reason: "fixture_miss" | "parse_fail"; message: string };

export interface PlatformCrawlResult {
  /** 所有提交的 URL（保持输入顺序） */
  urls: string[];
  /** 每个 URL 的抓取结果，与 urls 一一对应 */
  outcomes: PlatformCrawlOutcome[];
}

/**
 * Mock-first 抓取小红书 URL 列表：
 * 1. fetch /mock-crawl/xiaohongshu.json (Vite 静态服务)
 * 2. 按 URL 查 fixture，命中即返回 ok: true
 * 3. 未命中返 ok: false, reason: 'fixture_miss'
 *
 * 真接 Cloudflare 时改为 fetch https://unequal-api.xxx.workers.dev/crawl/xiaohongshu
 */
export async function crawlXiaohongshuUrls(
  urls: string[]
): Promise<PlatformCrawlResult> {
  const res = await fetch("/mock-crawl/xiaohongshu.json");
  if (!res.ok) {
    return {
      urls,
      outcomes: urls.map((url) => ({
        ok: false,
        reason: "fixture_miss",
        message: `fixture fetch failed: HTTP ${res.status}`,
      })),
    };
  }
  const fixtureMap = (await res.json()) as Record<string, PlatformCrawledDoc>;
  return {
    urls,
    outcomes: urls.map((url) => {
      const doc = fixtureMap[url];
      if (!doc) {
        return {
          ok: false,
          reason: "fixture_miss",
          message: `URL not in fixture (mock-first mode)`,
        };
      }
      return { ok: true, doc };
    }),
  };
}

/**
 * Mock-first 抓取微信公众号 URL 列表：同 crawlXiaohongshuUrls，fixture 路径换 wechat-mp.json
 */
export async function crawlWechatMpUrls(
  urls: string[]
): Promise<PlatformCrawlResult> {
  const res = await fetch("/mock-crawl/wechat-mp.json");
  if (!res.ok) {
    return {
      urls,
      outcomes: urls.map((url) => ({
        ok: false,
        reason: "fixture_miss",
        message: `fixture fetch failed: HTTP ${res.status}`,
      })),
    };
  }
  const fixtureMap = (await res.json()) as Record<string, PlatformCrawledDoc>;
  return {
    urls,
    outcomes: urls.map((url) => {
      const doc = fixtureMap[url];
      if (!doc) {
        return {
          ok: false,
          reason: "fixture_miss",
          message: `URL not in fixture (mock-first mode)`,
        };
      }
      return { ok: true, doc };
    }),
  };
}
```

- [ ] **Step 6: 跑 admin typecheck + dedupe 单测**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F admin typecheck 2>&1 | tail -10
pnpm -F admin test dedupe 2>&1 | tail -20
```

预期：typecheck 绿 + dedupe 4 用例绿。

- [ ] **Step 7: commit**

```bash
git add apps/admin/src/lib/dedupe.ts apps/admin/src/lib/dedupe.test.ts apps/admin/src/lib/api.ts
git commit -m "M5 task 8: dedupe lib (4 vitest tests) + api.ts 2 mock-first crawl functions"
```

---

### Task 9: 2 个抓取页组件

**Files:**
- Create: `apps/admin/src/pages/XiaohongshuCrawlPage.tsx`
- Create: `apps/admin/src/pages/WechatMpCrawlPage.tsx`

- [ ] **Step 1: 创建 `apps/admin/src/pages/XiaohongshuCrawlPage.tsx`**

写入：

```tsx
import { useState } from "react";
import type { FormEvent } from "react";
import {
  crawlXiaohongshuUrls,
  type PlatformCrawlOutcome,
} from "../lib/api.js";
import { addUrl, isUrlSeen } from "../lib/dedupe.js";

type TrustLevel = 0 | 1 | 2 | 3;

export default function XiaohongshuCrawlPage() {
  const [urlsText, setUrlsText] = useState("");
  const [trustLevel, setTrustLevel] = useState<TrustLevel>(1);
  const [submitting, setSubmitting] = useState(false);
  const [outcomes, setOutcomes] = useState<PlatformCrawlOutcome[]>([]);
  const [submittedUrls, setSubmittedUrls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function parseUrls(): string[] {
    return urlsText
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  const submittedSeen = submittedUrls.filter(isUrlSeen);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const urls = parseUrls();
    if (urls.length === 0) {
      setError("请输入至少 1 个 URL");
      return;
    }
    setSubmitting(true);
    setOutcomes([]);
    setSubmittedUrls(urls);
    try {
      const result = await crawlXiaohongshuUrls(urls);
      setOutcomes(result.outcomes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function onClear() {
    setUrlsText("");
    setOutcomes([]);
    setSubmittedUrls([]);
    setError(null);
  }

  function onConfirmIngest() {
    for (const o of outcomes) {
      if (o.ok) addUrl(o.doc.url);
    }
    alert("已记录到 localStorage（mock-first 模式下不入库；CP-5 真接后会真调 /ingest）");
  }

  const successCount = outcomes.filter((o) => o.ok).length;
  const failCount = outcomes.filter((o) => !o.ok).length;

  return (
    <section className="space-y-6">
      <h2 className="text-xl font-semibold">小红书抓取</h2>

      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded border border-gray-200 bg-white p-6"
      >
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            URL（每行一个）
          </label>
          <textarea
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            rows={6}
            placeholder="https://xiaohongshu.com/explore/abc123&#10;https://xiaohongshu.com/explore/def456"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono"
          />
        </div>
        <div className="flex items-center gap-4">
          <label className="text-sm font-medium text-gray-700">
            trust_level:
          </label>
          <select
            value={trustLevel}
            onChange={(e) => setTrustLevel(Number(e.target.value) as TrustLevel)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          >
            <option value={0}>0 (未评级)</option>
            <option value={1}>1 (一般)</option>
            <option value={2}>2 (可信)</option>
            <option value={3}>3 (权威)</option>
          </select>
          <button
            type="submit"
            disabled={submitting || parseUrls().length === 0 || trustLevel === 0}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300"
          >
            {submitting ? "抓取中..." : "开始抓取"}
          </button>
          <button
            type="button"
            onClick={onClear}
            className="rounded border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            清空
          </button>
        </div>
        {trustLevel === 0 && (
          <p className="text-xs text-red-600">请选择 trust_level（不能为 0）</p>
        )}
      </form>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {submittedSeen.length > 0 && (
        <div className="rounded border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-700">
          ⚠ {submittedSeen.length} 个 URL 已入库过：{submittedSeen.join(", ")}
        </div>
      )}

      {outcomes.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-gray-700">
            结果（共 {outcomes.length} 条: 成功 {successCount} / 失败 {failCount}
            {submittedSeen.length > 0 && ` / 重复 ${submittedSeen.length}`}）
          </h3>
          {outcomes.map((o, idx) => {
            const url = submittedUrls[idx] ?? "(unknown)";
            if (o.ok) {
              return (
                <div
                  key={idx}
                  className="rounded border border-green-200 bg-green-50 p-3 text-sm"
                >
                  <div className="font-medium text-green-800">✓ {url}</div>
                  <div className="text-gray-700">
                    《{o.doc.title}》— {o.doc.author} · {o.doc.publishedAt}
                  </div>
                  <div className="mt-1 text-xs text-gray-600">
                    {o.doc.content.slice(0, 200)}
                    {o.doc.content.length > 200 && "..."}
                  </div>
                </div>
              );
            }
            return (
              <div
                key={idx}
                className="rounded border border-red-200 bg-red-50 p-3 text-sm"
              >
                <div className="font-medium text-red-800">✗ {url}</div>
                <div className="text-xs text-red-600">{o.message}</div>
              </div>
            );
          })}
          <button
            type="button"
            onClick={onConfirmIngest}
            disabled={successCount === 0}
            className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:bg-gray-300"
          >
            确认入库（{successCount} 条）
          </button>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: 创建 `apps/admin/src/pages/WechatMpCrawlPage.tsx`**

写入（与 XiaohongshuCrawlPage 同结构，区别只在 default trust_level=2，fetch fixture 路径 /mock-crawl/wechat-mp.json，调 crawlWechatMpUrls）：

```tsx
import { useState } from "react";
import type { FormEvent } from "react";
import {
  crawlWechatMpUrls,
  type PlatformCrawlOutcome,
} from "../lib/api.js";
import { addUrl, isUrlSeen } from "../lib/dedupe.js";

type TrustLevel = 0 | 1 | 2 | 3;

export default function WechatMpCrawlPage() {
  const [urlsText, setUrlsText] = useState("");
  const [trustLevel, setTrustLevel] = useState<TrustLevel>(2);
  const [submitting, setSubmitting] = useState(false);
  const [outcomes, setOutcomes] = useState<PlatformCrawlOutcome[]>([]);
  const [submittedUrls, setSubmittedUrls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function parseUrls(): string[] {
    return urlsText
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  const submittedSeen = submittedUrls.filter(isUrlSeen);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const urls = parseUrls();
    if (urls.length === 0) {
      setError("请输入至少 1 个 URL");
      return;
    }
    setSubmitting(true);
    setOutcomes([]);
    setSubmittedUrls(urls);
    try {
      const result = await crawlWechatMpUrls(urls);
      setOutcomes(result.outcomes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function onClear() {
    setUrlsText("");
    setOutcomes([]);
    setSubmittedUrls([]);
    setError(null);
  }

  function onConfirmIngest() {
    for (const o of outcomes) {
      if (o.ok) addUrl(o.doc.url);
    }
    alert("已记录到 localStorage（mock-first 模式下不入库；CP-5 真接后会真调 /ingest）");
  }

  const successCount = outcomes.filter((o) => o.ok).length;
  const failCount = outcomes.filter((o) => !o.ok).length;

  return (
    <section className="space-y-6">
      <h2 className="text-xl font-semibold">微信公众号抓取</h2>

      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded border border-gray-200 bg-white p-6"
      >
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            URL（每行一个）
          </label>
          <textarea
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            rows={6}
            placeholder="https://mp.weixin.qq.com/s/wx_abc&#10;https://mp.weixin.qq.com/s/wx_def"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono"
          />
        </div>
        <div className="flex items-center gap-4">
          <label className="text-sm font-medium text-gray-700">
            trust_level:
          </label>
          <select
            value={trustLevel}
            onChange={(e) => setTrustLevel(Number(e.target.value) as TrustLevel)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          >
            <option value={0}>0 (未评级)</option>
            <option value={1}>1 (一般)</option>
            <option value={2}>2 (可信)</option>
            <option value={3}>3 (权威)</option>
          </select>
          <button
            type="submit"
            disabled={submitting || parseUrls().length === 0 || trustLevel === 0}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300"
          >
            {submitting ? "抓取中..." : "开始抓取"}
          </button>
          <button
            type="button"
            onClick={onClear}
            className="rounded border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            清空
          </button>
        </div>
        {trustLevel === 0 && (
          <p className="text-xs text-red-600">请选择 trust_level（不能为 0）</p>
        )}
      </form>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {submittedSeen.length > 0 && (
        <div className="rounded border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-700">
          ⚠ {submittedSeen.length} 个 URL 已入库过：{submittedSeen.join(", ")}
        </div>
      )}

      {outcomes.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-gray-700">
            结果（共 {outcomes.length} 条: 成功 {successCount} / 失败 {failCount}
            {submittedSeen.length > 0 && ` / 重复 ${submittedSeen.length}`}）
          </h3>
          {outcomes.map((o, idx) => {
            const url = submittedUrls[idx] ?? "(unknown)";
            if (o.ok) {
              return (
                <div
                  key={idx}
                  className="rounded border border-green-200 bg-green-50 p-3 text-sm"
                >
                  <div className="font-medium text-green-800">✓ {url}</div>
                  <div className="text-gray-700">
                    《{o.doc.title}》— {o.doc.author} · {o.doc.publishedAt}
                  </div>
                  <div className="mt-1 text-xs text-gray-600">
                    {o.doc.content.slice(0, 200)}
                    {o.doc.content.length > 200 && "..."}
                  </div>
                </div>
              );
            }
            return (
              <div
                key={idx}
                className="rounded border border-red-200 bg-red-50 p-3 text-sm"
              >
                <div className="font-medium text-red-800">✗ {url}</div>
                <div className="text-xs text-red-600">{o.message}</div>
              </div>
            );
          })}
          <button
            type="button"
            onClick={onConfirmIngest}
            disabled={successCount === 0}
            className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:bg-gray-300"
          >
            确认入库（{successCount} 条）
          </button>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: 跑 admin typecheck**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F admin typecheck 2>&1 | tail -10
```

预期：tsc 退出 0。如有 JSX / 类型错，调试。

- [ ] **Step 4: commit**

```bash
git add apps/admin/src/pages/XiaohongshuCrawlPage.tsx apps/admin/src/pages/WechatMpCrawlPage.tsx
git commit -m "M5 task 9: 2 admin crawl pages (XHS / WX-MP) with mock-first UX"
```

---

### Task 10: App.tsx 加 2 路由 + nav + CP-3 final verification

**Files:**
- Modify: `apps/admin/src/App.tsx`

- [ ] **Step 1: 修改 App.tsx 顶部 import**

把第 7 行附近：

```tsx
import CrawlPage from "./pages/CrawlPage.js";
```

替换为：

```tsx
import CrawlPage from "./pages/CrawlPage.js";
import XiaohongshuCrawlPage from "./pages/XiaohongshuCrawlPage.js";
import WechatMpCrawlPage from "./pages/WechatMpCrawlPage.js";
```

- [ ] **Step 2: 在 nav 栏加 2 个链接**

在 `<Link to="/crawl">网页抓取</Link>`（第 36 行附近）**之后**追加：

```tsx
            <Link to="/crawl/xiaohongshu" className="text-gray-600 hover:text-gray-900">
              小红书
            </Link>
            <Link to="/crawl/wechat-mp" className="text-gray-600 hover:text-gray-900">
              微信公众号
            </Link>
```

- [ ] **Step 3: 在 Routes 加 2 个路由**

在 `<Route path="/crawl" element={<CrawlPage />} />`（第 50 行附近）**之后**追加：

```tsx
          <Route path="/crawl/xiaohongshu" element={<XiaohongshuCrawlPage />} />
          <Route path="/crawl/wechat-mp" element={<WechatMpCrawlPage />} />
```

- [ ] **Step 4: 跑 admin typecheck + build**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F admin typecheck 2>&1 | tail -10
pnpm -F admin build 2>&1 | tail -10
```

预期：typecheck 绿 + build 成功（输出含 XHS / WX-MP 页面 bundle）。

- [ ] **Step 5: dev server 真打开走通（M3-realdeploy 教训应用）**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm dev:admin &  # 后台启动
sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/crawl/xiaohongshu
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/crawl/wechat-mp
curl -s http://localhost:5173/mock-crawl/xiaohongshu.json | head -c 100
echo
curl -s http://localhost:5173/mock-crawl/wechat-mp.json | head -c 100
echo
kill %1
```

预期：
- `/crawl/xiaohongshu` 和 `/crawl/wechat-mp` 都返 200
- fixture JSON 都能被 Vite 静态服务访问

如 dev server 启动失败，看错误排查；常见 = 端口占用 / `pnpm dev:admin` 脚本未定义（先检查根 `package.json` 是否有 `dev:admin` 脚本，指向 `pnpm -F admin dev`）。

- [ ] **Step 6: 浏览器手验（M3-realdeploy 教训，30 秒成本）**

如果用户在本机有浏览器：手动打开 http://localhost:5173/crawl/xiaohongshu，粘贴 3 个 fixture URL 中任 1 个（如 `https://xiaohongshu.com/explore/abc123`），trust_level 选 1，点提交。看到绿色成功行 + title + author + publishedAt + content preview。

如果不方便手验：dev server 200 响应 + fixture JSON 可访问已经覆盖大部分代码路径。Vite 编译错或运行时错会在 curl 返回非 200 / fixture JSON 加载失败时暴露。

- [ ] **Step 7: commit**

```bash
git add apps/admin/src/App.tsx
git commit -m "M5 task 10: App.tsx add /crawl/xiaohongshu + /crawl/wechat-mp routes + nav links"
```

---

## CP-4: docs + README + 全测绿

**目标**：补 docs/platform-crawler-setup.md（CLI + admin 用法 + 真平台风险 + v2+ 路线）+ README M5 段。

**完成定义**：71 用例全绿（46 M0-M3 + 11 M4 + 8 M5 crawler + 4 M5 admin dedupe；最终以 `pnpm -r test` 输出为准）。

---

### Task 11: docs/platform-crawler-setup.md + README M5 段

**Files:**
- Create: `docs/platform-crawler-setup.md`
- Modify: `README.md`（追加 M5 状态段）

- [ ] **Step 1: 创建 `docs/platform-crawler-setup.md`**

写入：

````markdown
# 不等号平台抓取：小红书 + 微信公众号

> M5 范围。两个 source adapter 的 CLI + admin 用法、真平台风险说明、v2+ 登录态自动抓账号路线。

## 概述

M5 在 `apps/crawler` 加了两个 source adapter：

| Adapter | 入口 | 用途 |
|---|---|---|
| `xiaohongshu.ts` | `fetchXiaohongshuNote(url, opts)` | 抓小红书单帖 HTML → 提取 title / author / publishedAt / paragraphs |
| `wechat-mp.ts` | `fetchWechatMpArticle(url, opts)` | 抓微信公众号单文章 HTML → 提取 title / account / publishedAt / paragraphs |

两个 adapter 都用 cheerio 解析 HTML（零浏览器依赖，零运行时新依赖），结果统一为 `CrawledDocument` 加可选 `platformSpecific: { author?, publishedAt? }` 字段。

CLI、admin 抓取页都基于这两个 adapter。

---

## CLI 用法

### 抓小红书单帖

```bash
node --experimental-strip-types apps/crawler/src/main.ts \
  --url "https://xiaohongshu.com/explore/abc123" \
  --source-type xiaohongshu \
  --no-ingest
```

输出示例：

```
[crawler] fetch https://xiaohongshu.com/explore/abc123 (source-type: xiaohongshu)
[crawler] title: 5个月宝宝辅食添加全攻略
[crawler] paragraphs: 4, totalChars: 187
[crawler] --no-ingest set, skipping ingest
{ "url": "...", "title": "...", "paragraphs": [...], "totalChars": 187, "fetchedAt": ..., "platformSpecific": { "author": "小红书用户A", "publishedAt": "2026-05-12T10:30:00+08:00" } }
```

### 抓微信公众号单文章

```bash
node --experimental-strip-types apps/crawler/src/main.ts \
  --url "https://mp.weixin.qq.com/s/wx_abc" \
  --source-type wechat-mp \
  --no-ingest
```

### 调 /ingest 真入库

去掉 `--no-ingest` 标志，加上 `--token` + `--ingest-url` + `--user-id` + `--trust` 即可。M0+M1 /ingest endpoint 自动接受 `source.type='xiaohongshu'|'wechat-mp'`（D1 schema 已有 `source.type` 字面量）。

---

## admin 抓取页

dev 模式（mock-first）：

```bash
pnpm dev:api    # 终端 1
pnpm dev:admin  # 终端 2
```

访问：
- http://localhost:5173/crawl/xiaohongshu
- http://localhost:5173/crawl/wechat-mp

每个页面：
- textarea 输入 URL（每行一个）
- trust_level 下拉（XHS 默认 1，WX-MP 默认 2）
- 提交按钮 → fetch `/mock-crawl/{platform}.json`（Vite 静态服务）
- 结果列表：绿/黄/红框
- 确认入库按钮（mock-first 下写 localStorage；真接 Cloudflare 后调 /ingest）

dev fixture 在 `apps/admin/public/mock-crawl/`，3 个 XHS URL + 3 个 WX-MP URL。

---

## 真平台风险说明（M5 已知）

M5 抓取器在 mock-first 模式下不抓真网。真接时以下风险需要真人 / 平台操作介入：

| 风险 | 影响 | 缓解 |
|---|---|---|
| 小红书反爬（IP 风控 / 验证码） | 单 IP 抓 5-10 篇后被 ban | v2+ 接代理 IP 池；v1 限制每日抓取量 |
| 微信公众号反爬（登录态校验） | 公开访问的 mp.weixin.qq.com 链接有限 | v2+ 接登录态 cookie 注入（App 抓包 或 第三方服务） |
| 平台改版（HTML 结构变更） | parser selectors 失效 | 抓取报错时更新 selectors + fixture HTML |
| 平台 ToS 风险 | 大批量抓取可能违反服务条款 | 用户手动复制 URL 列表（M5 默认行为），不自动登录抓账号 |

**M5 范围内默认不解决上述风险**。v2+ 登录态自动抓账号推到 M5.5。

---

## v2+ / M5.5 路线

| 项 | 推到 | 备注 |
|---|---|---|
| 登录态自动抓账号（小红书 App 抓包 / 公众号 cookie） | v2+ / M5.5 | 需引入第三方服务（NewRank / 蝉妈妈 / 西瓜数据）或自实现 cookie 注入 |
| 反爬绕过（代理 IP / UA 轮换 / 验证码识别） | v2+ | 真平台抓取前提 |
| Cron 定时抓取 | v2+ | 手动触发优先 |
| `/api/xhs-batch` / `/api/wxmp-batch` 真 endpoint | v2+ | admin 直接调 fixture；真接时薄 proxy |
| 按 content hash 去重 | v2+ | M5 只按 URL（localStorage） |
| robots.txt 自动遵守 | 生产前必做 | M5 手动审查 |
| 抓取失败自动重试 / 指数退避 | v2+ | M5 单次抓取 |

---

## 测试

```bash
pnpm -F crawler test
# 14 用例: webpage 4 + ingest 2 + xiaohongshu 4 + wechat-mp 4
```

```bash
pnpm -F admin test
# 4 用例: dedupe 4
```

总用例数（M0-M5）：71 全绿（46 M0-M3 + 11 M4 + 8 M5 crawler + 4 M5 admin dedupe；最终以 `pnpm -r test` 输出为准）。
````

- [ ] **Step 2: README.md 追加 M5 段**

打开 `README.md`。找到 M4 状态段（搜索 `## M4 状态`），在 M4 段**之后**追加：

```markdown
## M5 状态

跑通：小红书 + 微信公众号两个 source adapter（cheerio parser）+ admin 2 个抓取页（`/crawl/xiaohongshu` + `/crawl/wechat-mp`）+ localStorage URL 去重。14 crawler 用例 + 4 admin dedupe 用例全绿。

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

- `pnpm -F crawler test` — 14 用例（webpage 4 + ingest 2 + xiaohongshu 4 + wechat-mp 4）
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
```

- [ ] **Step 3: commit**

```bash
git add docs/platform-crawler-setup.md README.md
git commit -m "M5 task 11: docs/platform-crawler-setup.md + README M5 section"
```

---

### Task 12: CP-4 final verification

**Files:** 无（验证步骤）

- [ ] **Step 1: 跑全部 5 包 typecheck**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -r typecheck 2>&1 | tail -20
```

预期：api / admin / shared / crawler / miniprogram 5 包全绿。

- [ ] **Step 2: 跑全部测试**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -r test 2>&1 | tail -40
```

预期：71 用例全绿（46 M0-M3 + 11 M4 + 8 M5 crawler + 4 M5 admin dedupe；最终以输出为准）。

- [ ] **Step 3: 跑 admin build**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
pnpm -F admin build 2>&1 | tail -10
```

预期：build 成功（dist 含 XHS / WX-MP 抓取页 bundle）。

- [ ] **Step 4: git status / log 检查**

```bash
cd /Users/Mark/cc_project/unequal/.claude/worktrees/m5-platform-crawler
git status
git log --oneline -12
```

预期：
- `git status` clean
- 至少 11 个新 commit（Task 1-3 + 5 + 7-11）
- 末尾有 Task 11 的 commit

- [ ] **Step 5: CP-4 完成 — 无 commit**

M5 全部完成。

---

## 附录 A: 任务汇总

| Task | CP | 文件 / 改动 | Commit message |
|---|---|---|---|
| 1 | CP-1 | `types.ts` 加 platformSpecific 字段 | `M5 task 1: extend CrawledDocument with platformSpecific optional field` |
| 2 | CP-1 | XHS source adapter + 4 测试 + fixture HTML | `M5 task 2: XHS source adapter + 4 vitest unit tests + fixture HTML` |
| 3 | CP-1 | WX-MP source adapter + 4 测试 + fixture HTML | `M5 task 3: WX-MP source adapter + 4 vitest unit tests + fixture HTML` |
| 4 | CP-1 | (验证) | 无 commit |
| 5 | CP-2 | `main.ts` 加 `--source-type` 选项 | `M5 task 5: main.ts add --source-type option (webpage\|xiaohongshu\|wechat-mp)` |
| 6 | CP-2 | (验证) | 无 commit |
| 7 | CP-3 | admin mock fixture JSON × 2 | `M5 task 7: admin mock-crawl fixtures (3 XHS + 3 WX-MP URLs)` |
| 8 | CP-3 | dedupe lib + api.ts 2 函数 + 4 单测 | `M5 task 8: dedupe lib (4 vitest tests) + api.ts 2 mock-first crawl functions` |
| 9 | CP-3 | 2 抓取页组件 | `M5 task 9: 2 admin crawl pages (XHS / WX-MP) with mock-first UX` |
| 10 | CP-3 | App.tsx 路由 + nav + dev 验 | `M5 task 10: App.tsx add /crawl/xiaohongshu + /crawl/wechat-mp routes + nav links` |
| 11 | CP-4 | docs + README | `M5 task 11: docs/platform-crawler-setup.md + README M5 section` |
| 12 | CP-4 | (验证) | 无 commit |

总 commit 数：10（Task 1+2+3+5+7+8+9+10+11 = 9 个新功能 commit + Task 4/6/12 验证无 commit）。

---

## 附录 B: 验收 checklist（最终）

- [ ] `pnpm -F crawler test` — 14 用例全绿
- [ ] `pnpm -F admin test` — 4 用例全绿
- [ ] `pnpm -r typecheck` — 5 包全绿
- [ ] `pnpm -F admin build` — 成功
- [ ] `pnpm dev:admin` 真编译 + `/crawl/xiaohongshu` 与 `/crawl/wechat-mp` 返 200
- [ ] admin 输入 fixture URL 提交 → mock 命中 → 状态机走完
- [ ] docs/platform-crawler-setup.md — 完整
- [ ] README M5 段 — 完整

---

## 附录 C: 与上游 spec 的映射

| Spec 段 | 落在 Task |
|---|---|
| §1.1 apps/crawler 新增 | Task 2, 3 |
| §1.2 apps/crawler 扩展 | Task 1 (types), Task 5 (main) |
| §1.3 apps/admin 新增 | Task 7 (fixture), Task 8 (api + dedupe), Task 9 (pages), Task 10 (routes) |
| §1.4 docs | Task 11 |
| §3.1 抓取 pipeline | Task 2, 3 (实现) |
| §3.4 admin UI 设计 | Task 9 (XiaohongshuCrawlPage, WechatMpCrawlPage) |
| §3.6 admin dev 验真编译 | Task 10 (Step 5-6) |
| §5 验收标准 | Task 4, 6, 12 (验证步骤) |
| §6 CP 划分 | Task 1-4 (CP-1), 5-6 (CP-2), 7-10 (CP-3), 11-12 (CP-4) |
| §7 错误处理 | Task 9 (PlatformCrawlOutcome + 行内红/黄/绿框) |
| §8 去重策略 | Task 8 (dedupe lib + admin pages 调用) |
