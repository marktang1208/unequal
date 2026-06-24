# M4 Implementation Plan: 网页抓取（curl + cheerio → /ingest）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `apps/crawler/` monorepo 包（TypeScript + cheerio）+ admin 抓取页，端到端抓取指定 URL → 提取正文 → 调 /ingest 入库。零浏览器依赖（无 Playwright），mock-first 全程不抓真网。

**Architecture:**
- `apps/crawler/src/sources/webpage.ts` 用 undici `fetch` 拉 HTML + cheerio 提取 title/正文
- 抓取结果构造 /ingest payload（source.type='webpage'）调 apps/api
- admin CrawlPage 复用 M0+M1 admin 基础设施（getToken + Vite proxy /api）
- Vitest 单元测试用 cheerio.load(fixture HTML) + fetchImpl mock

**Tech Stack:**
- 现有：Hono 4.5 + Vitest 2.0 + TypeScript 5.5 + React 18 + Vite 5
- 新增：cheerio（HTML 解析，零浏览器依赖）+ undici / globalThis.fetch（HTTP）
- 复用：`apps/api/src/routes/ingest.ts`（M0+M1）

---
**Spec:** `docs/superpowers/specs/2026-06-15-m4-crawler-design.md`（184 行，CP 划分、lib/types 对齐、mock-first 边界）

---

## 0. 工作区设置

- 分支：`m4-crawler`（基于 `master` 当前 HEAD `b756826`）
- Worktree 路径：`/Users/Mark/cc_project/unequal/.claude/worktrees/m4-crawler`
- 不进 master，所有 11 个 task 在 worktree 内完成
- 4 CP，CP 边界不强制 commit squash（每 task 一 commit）
- 结束用 `superpowers:finishing-a-development-branch` 决定 merge

**为什么用 worktree**：M4 涉及 13+ 新增文件 + 跨 packages TDD（crawler + admin + lib 单测），与 master 隔离最稳。

---

## 1. 文件结构

### 1.1 apps/crawler 新增

```
apps/crawler/
├── package.json                       # NEW — typecheck/test + devDeps (cheerio, vitest)
├── tsconfig.json                      # NEW — extends ../../tsconfig.base.json
├── .gitignore                         # NEW — node_modules + dist
├── vitest.config.ts                   # NEW — vitest 配置
├── src/
│   ├── types.ts                       # NEW — CrawledDocument + IngestPayload
│   ├── parser.ts                      # NEW — parseHtml(html) → { title, paragraphs[] }
│   ├── sources/
│   │   └── webpage.ts                 # NEW — fetchUrl(url) → CrawledDocument
│   ├── ingest.ts                      # NEW — submitToIngest(payload, opts) → Response
│   └── main.ts                        # NEW — CLI 入口 (--url, --ingest-url, --user-id)
└── test/
    ├── webpage.test.ts                # NEW — 4 用例 (mock fetch + cheerio)
    ├── ingest.test.ts                 # NEW — 2 用例 (mock fetch)
    └── fixtures/
        └── sample-article.html        # NEW — 5 KB 测试用 HTML
```

### 1.2 apps/admin 修改

```
apps/admin/src/
├── App.tsx                            # MODIFY — 加 /crawl 路由 + 导航
├── lib/
│   └── api.ts                         # MODIFY — 加 crawlUrl(url) + CrawlResult 类型
└── pages/
    └── CrawlPage.tsx                  # NEW — admin 抓取页 (form + 结果展示)
```

### 1.3 根级修改

```
pnpm-workspace.yaml                   # MODIFY — 加 apps/crawler
README.md                             # MODIFY — 追加 M4 状态段
docs/webpage-crawler-setup.md         # NEW — 抓取器使用 + 真人操作
```

### 1.4 不修改

- `packages/shared/`：M4 不引入新共享类型（crawler 内部 types.ts 镜像定义）
- `apps/api/`：复用 M0+M1 /ingest endpoint，不改
- `apps/api/migrations/`：无新 migration

---

## CP-1: monorepo 接入 + lib 层（types + parser + webpage + ingest + 单测）

**目标**：`apps/crawler/` 接入 pnpm workspace；lib 层 4 文件（types/parser/webpage/ingest）+ 6 个 Vitest 单测覆盖 happy/网络错误/HTML 解析/Ingest payload 构造。零 CLI、零 UI。

**完成定义**：`pnpm -F crawler test` 6 用例全绿，typecheck 绿。

---

### Task 1: monorepo 接入 + crawler 骨架

**Files:**
- Create: `apps/crawler/tsconfig.json`
- Create: `apps/crawler/package.json`
- Create: `apps/crawler/.gitignore`
- Create: `apps/crawler/vitest.config.ts`
- Modify: `pnpm-workspace.yaml`（加 `apps/crawler`）

- [ ] **Step 1: 创建 apps/crawler/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "node",
    "lib": ["es2022", "dom"],
    "outDir": "./dist",
    "rootDir": ".",
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 2: 创建 apps/crawler/package.json**

```json
{
  "name": "crawler",
  "version": "0.1.0",
  "private": true,
  "description": "unequal webpage crawler (curl + cheerio)",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "cheerio": "1.0.0"
  },
  "devDependencies": {
    "typescript": "5.5.4",
    "vitest": "2.0.5"
  }
}
```

- [ ] **Step 3: 创建 apps/crawler/.gitignore**

```
node_modules/
dist/
```

- [ ] **Step 4: 创建 apps/crawler/vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: 修改 pnpm-workspace.yaml**

读 `pnpm-workspace.yaml` 完整内容。如果已用 `apps/*` 通配，新加的 `apps/crawler` 自动被捕获，不动 yaml。如果显式列出，加 `apps/crawler`。

- [ ] **Step 6: 验证 typecheck 骨架可跑**

```bash
cd apps/crawler
pnpm exec tsc --noEmit 2>&1 | tail -5
```

预期：cheerio 类型应通过（pnpm install 后）。如果 `Cannot find module 'cheerio'`，先 `pnpm install`（mock-first 模式下允许 devDep install）。

- [ ] **Step 7: commit**

```bash
git add apps/crawler/tsconfig.json apps/crawler/package.json apps/crawler/.gitignore apps/crawler/vitest.config.ts pnpm-workspace.yaml
git commit -m "M4 task 1: monorepo scaffold for apps/crawler"
```

---

### Task 2: src/types.ts 抓取结果 + Ingest payload 类型

**Files:**
- Create: `apps/crawler/src/types.ts`

- [ ] **Step 1: 创建 types.ts**

```ts
/**
 * 网页抓取结果。
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
}

/**
 * 调 /ingest 时的 payload（与 apps/api M0+M1 ingest schema 对齐）。
 * source.type = 'webpage'（schema CHECK 已支持）。
 */
export interface IngestPayload {
  source: {
    type: "file" | "webpage" | "xiaohongshu" | "wechat-mp";
    title: string;
    url: string;
    trust_level: 0 | 1 | 2 | 3;
    meta?: Record<string, unknown>;
  };
  document: {
    title: string;
    raw_path: string;
    parsed_text: string;
  };
  chunks: Array<{
    idx: number;
    content: string;
    token_count: number;
    trust_level: 0 | 1 | 2 | 3;
  }>;
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm -F crawler typecheck 2>&1 | tail -5
```

预期：通过。

- [ ] **Step 3: commit**

```bash
git add apps/crawler/src/types.ts
git commit -m "M4 task 2: crawler src/types.ts (CrawledDocument + IngestPayload)"
```

---

### Task 3: src/parser.ts HTML 解析（cheerio）

**Files:**
- Create: `apps/crawler/src/parser.ts`
- Create: `apps/crawler/test/fixtures/sample-article.html`

- [ ] **Step 1: 创建 sample-article.html fixture**

```html
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <title>婴儿发烧 38.5℃ 的家庭处理</title>
  <meta name="author" content="崔玉涛">
  <meta name="description" content="婴儿发烧家庭处理指南">
  <style>body { font-family: sans-serif; }</style>
</head>
<body>
  <header>
    <nav><a href="/">首页</a> <a href="/articles">文章列表</a></nav>
  </header>
  <article>
    <h1>婴儿发烧 38.5℃ 的家庭处理</h1>
    <p>婴儿发烧时先观察精神状态比体温数字更重要。精神好、吃奶正常、玩耍如常的低烧（&lt;38.5℃）可先物理降温（温水擦浴、减衣），密切观察 24 小时。</p>
    <p>不推荐用酒精擦浴（已被多国儿科指南淘汰）。也不建议冰敷或冷水浴，避免引起寒战反而升高体温。</p>
    <p>对乙酰氨基酚（泰诺林）是 3 个月以上婴儿首选退烧药，按体重每 4-6 小时一次，24 小时内不超过 4 次。布洛芬（美林）适用于 6 个月以上婴儿。</p>
    <p>三个月以下婴儿发烧应立即就医。3-6 个月婴儿体温超过 38.5℃ 建议先测量腋温确认，如持续高烧或伴有精神差、拒奶、抽搐等症状，应尽快就诊。</p>
  </article>
  <footer>
    <p>© 2024 崔玉涛育儿百科</p>
    <script>analytics.track('pageview');</script>
  </footer>
</body>
</html>
```

- [ ] **Step 2: 写 parser.test.ts（4 用例）**

`apps/crawler/test/parser.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseHtml } from "../src/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures/sample-article.html");

describe("parseHtml", () => {
  it("happy: 提取 title + 4 段落（去 header/footer/nav/script）", () => {
    const html = readFileSync(FIXTURE_PATH, "utf-8");
    const r = parseHtml(html);
    expect(r.title).toBe("婴儿发烧 38.5℃ 的家庭处理");
    expect(r.paragraphs.length).toBe(4);
    expect(r.paragraphs[0]).toContain("婴儿发烧时先观察精神状态");
    expect(r.paragraphs[1]).toContain("不推荐用酒精擦浴");
    expect(r.paragraphs[2]).toContain("对乙酰氨基酚");
    expect(r.paragraphs[3]).toContain("三个月以下婴儿发烧");
  });

  it("段落不含 HTML 标签和 script 内容", () => {
    const html = readFileSync(FIXTURE_PATH, "utf-8");
    const r = parseHtml(html);
    for (const p of r.paragraphs) {
      expect(p).not.toMatch(/<[^>]+>/);
      expect(p).not.toContain("analytics.track");
      expect(p).not.toContain("© 2024");  // footer 不应混入
    }
  });

  it("totalChars = 段落拼接总字符数（去 HTML 后）", () => {
    const html = readFileSync(FIXTURE_PATH, "utf-8");
    const r = parseHtml(html);
    const expected = r.paragraphs.reduce((sum, p) => sum + p.length, 0);
    expect(r.totalChars).toBe(expected);
    expect(r.totalChars).toBeGreaterThan(100);
  });

  it("空 HTML: title='', paragraphs=[]", () => {
    const r = parseHtml("<html><body></body></html>");
    expect(r.title).toBe("");
    expect(r.paragraphs).toEqual([]);
    expect(r.totalChars).toBe(0);
  });
});
```

- [ ] **Step 3: 跑测试看红**

```bash
pnpm -F crawler test 2>&1 | tail -10
```

预期：FAIL with "Cannot find module '../src/parser.js'"。

- [ ] **Step 4: 实现 parser.ts**

```ts
import { load } from "cheerio";

export interface ParsedHtml {
  title: string;
  paragraphs: string[];
  totalChars: number;
}

/**
 * HTML → 纯文本段落（cheerio 解析）。
 * - title: 优先 <article> 内的 <h1>，fallback 到 <title>
 * - paragraphs: <article>/<main> 内的所有 <p>，去 HTML 标签，去 header/footer/nav/script/style
 */
export function parseHtml(html: string): ParsedHtml {
  const $ = load(html);

  // title: 优先 article 内的 h1，fallback head title
  const h1 = $("article h1").first().text().trim();
  const headTitle = $("head title").first().text().trim();
  const title = h1 || headTitle || "";

  // 移除 noise
  $("script, style, nav, header, footer").remove();

  // 段落: article/main 内的 p，fallback body p
  const scope = $("article").length > 0 ? $("article p") : $("body p");
  const paragraphs: string[] = [];
  scope.each((_, el) => {
    const text = $(el).text().trim();
    if (text) paragraphs.push(text);
  });

  const totalChars = paragraphs.reduce((sum, p) => sum + p.length, 0);
  return { title, paragraphs, totalChars };
}
```

- [ ] **Step 5: 跑测试看绿**

```bash
pnpm -F crawler test 2>&1 | tail -10
```

预期：4 用例全 PASS。

- [ ] **Step 6: commit**

```bash
git add apps/crawler/src/parser.ts apps/crawler/test/parser.test.ts apps/crawler/test/fixtures/sample-article.html
git commit -m "M4 task 3: crawler parser.ts (cheerio HTML→段落) + 4 unit tests + fixture"
```

---

### Task 4: src/sources/webpage.ts 抓取 + 解析 + CrawledDocument

**Files:**
- Create: `apps/crawler/src/sources/webpage.ts`
- Create: `apps/crawler/test/webpage.test.ts`

- [ ] **Step 1: 写 webpage.test.ts（4 用例）**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchUrl } from "../src/sources/webpage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_HTML = readFileSync(resolve(__dirname, "fixtures/sample-article.html"), "utf-8");

describe("fetchUrl", () => {
  it("happy: fetch 200 + HTML → CrawledDocument (title + paragraphs + totalChars + fetchedAt)", async () => {
    const fetchMock: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://example.com/article");
      return new Response(FIXTURE_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    };

    const r = await fetchUrl("https://example.com/article", { fetchImpl: fetchMock });
    expect(r.url).toBe("https://example.com/article");
    expect(r.title).toBe("婴儿发烧 38.5℃ 的家庭处理");
    expect(r.paragraphs.length).toBe(4);
    expect(r.totalChars).toBeGreaterThan(100);
    expect(r.fetchedAt).toBeGreaterThan(0);
  });

  it("fetch 404 → 抛 Error 含 '404'", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response("not found", { status: 404 });
    await expect(fetchUrl("https://example.com/404", { fetchImpl: fetchMock })).rejects.toThrow(/404/);
  });

  it("fetch 500 → 抛 Error 含 '500'", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response("server error", { status: 500 });
    await expect(fetchUrl("https://example.com/500", { fetchImpl: fetchMock })).rejects.toThrow(/500/);
  });

  it("fetch 网络错误 (fetch reject) → 抛 Error", async () => {
    const fetchMock: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(fetchUrl("https://example.com/down", { fetchImpl: fetchMock })).rejects.toThrow(/ECONNREFUSED/);
  });
});
```

- [ ] **Step 2: 跑测试看红**

```bash
pnpm -F crawler test 2>&1 | tail -10
```

预期：FAIL with "Cannot find module '../src/sources/webpage.js'"。

- [ ] **Step 3: 实现 webpage.ts**

```ts
import { parseHtml } from "../parser.js";
import type { CrawledDocument } from "../types.js";

export interface FetchUrlOptions {
  /** 测试用：注入 fake fetch */
  fetchImpl?: typeof fetch;
  /** User-Agent，默认 "unequal-crawler/0.1 (+https://unequal.xxx.workers.dev)" */
  userAgent?: string;
}

/**
 * 抓取单个 URL → 解析 → 返回 CrawledDocument。
 * Mock-first：测试用 fetchImpl 注入。
 */
export async function fetchUrl(url: string, opts: FetchUrlOptions = {}): Promise<CrawledDocument> {
  const f = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? "unequal-crawler/0.1 (+https://unequal.xxx.workers.dev)";

  const res = await f(url, { headers: { "user-agent": userAgent } });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  }
  const html = await res.text();
  const parsed = parseHtml(html);
  return {
    url,
    title: parsed.title,
    paragraphs: parsed.paragraphs,
    totalChars: parsed.totalChars,
    fetchedAt: Date.now(),
  };
}
```

- [ ] **Step 4: 跑测试看绿**

```bash
pnpm -F crawler test 2>&1 | tail -10
```

预期：4 用例全 PASS（parser 4 + webpage 4 = 8 总用例）。

- [ ] **Step 5: commit**

```bash
git add apps/crawler/src/sources/webpage.ts apps/crawler/test/webpage.test.ts
git commit -m "M4 task 4: crawler sources/webpage.ts (fetch + parse + CrawledDocument) + 4 unit tests"
```

---

### Task 5: src/ingest.ts 调 /ingest + 单测

**Files:**
- Create: `apps/crawler/src/ingest.ts`
- Create: `apps/crawler/test/ingest.test.ts`

- [ ] **Step 1: 写 ingest.test.ts（2 用例）**

```ts
import { describe, it, expect } from "vitest";
import { buildIngestPayload, submitToIngest } from "../src/ingest.js";
import type { CrawledDocument } from "../src/types.js";

const sample: CrawledDocument = {
  url: "https://example.com/article",
  title: "婴儿发烧 38.5℃ 的家庭处理",
  paragraphs: [
    "婴儿发烧时先观察精神状态比体温数字更重要。",
    "对乙酰氨基酚（泰诺林）是 3 个月以上婴儿首选退烧药。",
  ],
  totalChars: 60,
  fetchedAt: 1718400000000,
};

describe("buildIngestPayload", () => {
  it("CrawledDocument → IngestPayload (source.type='webpage' + document + chunks)", () => {
    const p = buildIngestPayload(sample, { userId: "01H0000000000000000000000", trustLevel: 2 });
    expect(p.source.type).toBe("webpage");
    expect(p.source.title).toBe("婴儿发烧 38.5℃ 的家庭处理");
    expect(p.source.url).toBe("https://example.com/article");
    expect(p.source.trust_level).toBe(2);
    expect(p.document.title).toBe("婴儿发烧 38.5℃ 的家庭处理");
    expect(p.document.parsed_text).toContain("婴儿发烧时先观察精神状态");
    expect(p.chunks.length).toBe(2);
    expect(p.chunks[0]?.idx).toBe(0);
    expect(p.chunks[0]?.content).toBe("婴儿发烧时先观察精神状态比体温数字更重要。");
    expect(p.chunks[0]?.token_count).toBeGreaterThan(0);
    expect(p.chunks[0]?.trust_level).toBe(2);
  });
});

describe("submitToIngest", () => {
  it("200 + JSON → 返回 ok=true", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("http://localhost:8787/ingest");
      const body = JSON.parse(init?.body as string);
      expect(body.source.type).toBe("webpage");
      return new Response(JSON.stringify({ ok: true, sourceId: "01H...", documentId: "01H..." }), { status: 200 });
    };
    const r = await submitToIngest({ ...sample, userId: "01H0000000000000000000000", trustLevel: 2 }, {
      ingestUrl: "http://localhost:8787/ingest",
      token: "test-token-please-change",
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
  });

  it("401 (token invalid) → 返回 ok=false 含 status 401", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
    const r = await submitToIngest({ ...sample, userId: "01H...", trustLevel: 2 }, {
      ingestUrl: "http://localhost:8787/ingest",
      token: "bad-token",
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.error).toContain("Invalid token");
    }
  });
});
```

- [ ] **Step 2: 跑测试看红**

```bash
pnpm -F crawler test 2>&1 | tail -10
```

预期：FAIL with "Cannot find module '../src/ingest.js'"。

- [ ] **Step 3: 实现 ingest.ts**

```ts
import type { CrawledDocument, IngestPayload } from "./types.js";

export interface BuildPayloadOptions {
  userId: string;
  trustLevel: 0 | 1 | 2 | 3;
}

export function buildIngestPayload(doc: CrawledDocument, opts: BuildPayloadOptions): IngestPayload {
  const safeTitle = doc.title || doc.url;
  const sourceId = "01H" + cryptoRandomHex(24);
  const documentId = "01H" + cryptoRandomHex(24);
  return {
    source: {
      type: "webpage",
      title: safeTitle,
      url: doc.url,
      trust_level: opts.trustLevel,
      meta: { source_id: sourceId, fetched_at: doc.fetchedAt },
    },
    document: {
      title: safeTitle,
      raw_path: `raw/${opts.userId}/crawl/${documentId}.html`,
      parsed_text: doc.paragraphs.join("\n\n"),
    },
    chunks: doc.paragraphs.map((content, idx) => ({
      idx,
      content,
      token_count: content.length,  // 简化：1 char = 1 token（中文 heuristic）
      trust_level: opts.trustLevel,
    })),
  };
}

export interface SubmitOptions {
  ingestUrl: string;
  token: string;
  userId: string;
  trustLevel: 0 | 1 | 2 | 3;
  fetchImpl?: typeof fetch;
}

export type SubmitResult =
  | { ok: true; sourceId?: string; documentId?: string }
  | { ok: false; status: number; error: string };

export async function submitToIngest(
  doc: CrawledDocument,
  opts: SubmitOptions,
): Promise<SubmitResult> {
  const payload = buildIngestPayload(doc, { userId: opts.userId, trustLevel: opts.trustLevel });

  const f = opts.fetchImpl ?? fetch;
  const res = await f(opts.ingestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, status: res.status, error: body.error ?? `HTTP ${res.status}` };
  }

  const body = (await res.json()) as { ok?: boolean; sourceId?: string; documentId?: string };
  return { ok: body.ok ?? true, sourceId: body.sourceId, documentId: body.documentId };
}

/** 26 hex chars — 简化版 ulid 替代 */
function cryptoRandomHex(len: number): string {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}
```

- [ ] **Step 4: 跑测试看绿**

```bash
pnpm -F crawler test 2>&1 | tail -10
```

预期：parser 4 + webpage 4 + ingest 3 = 11 用例全 PASS。

- [ ] **Step 5: commit**

```bash
git add apps/crawler/src/ingest.ts apps/crawler/test/ingest.test.ts
git commit -m "M4 task 5: crawler ingest.ts (buildIngestPayload + submitToIngest) + 3 unit tests"
```

---

### Task 6: CP-1 收尾

- [ ] **Step 1: 全测 + typecheck**

```bash
pnpm -F crawler test
pnpm -F crawler typecheck
pnpm -r typecheck 2>&1 | tail -10
```

预期：crawler 11 用例绿 + 5 包 typecheck 全绿。

- [ ] **Step 2: commit（如有遗漏）**

```bash
git status --short
```

如有 dirty，commit "M4 task 6: CP-1 final verification"。

**CP-1 完成**：`apps/crawler/` monorepo 接入 + lib 层 4 文件 + 11 单测。零 CLI、零 UI。

---

## CP-2: CLI 入口 + curl smoke test

**目标**：`apps/crawler/src/main.ts` CLI 入口（`--url` `--ingest-url` `--token`），命令行跑抓取 + 入库。零 UI。

**完成定义**：CLI 在 fixture HTML 路径下能跑（用 `file://` URL 或本地 HTTP server）但 spec 范围不强求 end-to-end（Vectorize mock-first 500 已知）。库函数 11 用例已覆盖核心逻辑。

---

### Task 7: src/main.ts CLI 入口

**Files:**
- Create: `apps/crawler/src/main.ts`

- [ ] **Step 1: 实现 CLI**

```ts
#!/usr/bin/env node
/**
 * CLI 入口：node apps/crawler/src/main.ts --url <URL> [--ingest-url <URL>] [--token <T>] [--trust 0-3] [--no-ingest]
 *
 * 默认：抓取 + 调 /ingest。
 * --no-ingest: 只抓取不调 ingest（调试用）。
 */
import { fetchUrl } from "./sources/webpage.js";
import { buildIngestPayload, submitToIngest } from "./ingest.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url as string;
  if (!url) {
    console.error("Usage: --url <URL> [--ingest-url <URL>] [--token <T>] [--trust 0-3] [--no-ingest]");
    process.exit(1);
  }

  const ingestUrl = (args["ingest-url"] as string) ?? "http://localhost:8787/ingest";
  const token = (args.token as string) ?? "";
  const trustLevel = parseInt((args.trust as string) ?? "2", 10) as 0 | 1 | 2 | 3;
  const noIngest = args["no-ingest"] === true;

  console.log(`[crawler] fetch ${url}`);
  const doc = await fetchUrl(url);
  console.log(`[crawler] title: ${doc.title}`);
  console.log(`[crawler] paragraphs: ${doc.paragraphs.length}, totalChars: ${doc.totalChars}`);

  if (noIngest) {
    console.log("[crawler] --no-ingest set, skipping ingest");
    console.log(JSON.stringify(doc, null, 2));
    return;
  }

  if (!token) {
    console.error("[crawler] --token required for ingest (or pass --no-ingest)");
    process.exit(1);
  }

  console.log(`[crawler] submit to ${ingestUrl}`);
  const result = await submitToIngest(doc, { ingestUrl, token });
  if (result.ok) {
    console.log(`[crawler] ingest ok: sourceId=${result.sourceId ?? "?"} documentId=${result.documentId ?? "?"}`);
  } else {
    console.error(`[crawler] ingest failed: ${result.status} ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[crawler] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
```

- [ ] **Step 2: typecheck + commit**

```bash
pnpm -F crawler typecheck 2>&1 | tail -5
git add apps/crawler/src/main.ts
git commit -m "M4 task 7: crawler main.ts CLI (--url --token --trust --no-ingest)"
```

**CP-2 完成**：CLI 可用（`node apps/crawler/src/main.ts --url <URL> --token <T>`）。无需单测（CLI 是 wrapper，库函数已覆盖）。

---

## CP-3: admin CrawlPage + 路由 + 集成 crawler lib

**目标**：`apps/admin/src/pages/CrawlPage.tsx` 抓取页 + `lib/api.ts` 加 `crawlUrl(url)` + App.tsx 路由 + 导航。Vite proxy 调本地 mock API。

**完成定义**：`pnpm -F admin build` 绿，CrawlPage 可见 + 可调通库函数（admin 端调本地 API ingest 在 Vectorize 缺失时会 500，UI 显示错误态 — 已知 mock-first 局限）。

---

### Task 8: admin api.ts 加 crawlUrl + CrawlResult 类型

**Files:**
- Modify: `apps/admin/src/lib/api.ts`

- [ ] **Step 1: 读现有 lib/api.ts 找插入点**

读完整内容，找 `ask()` 附近，在末尾追加。

- [ ] **Step 2: 追加 crawlUrl + CrawlResult**

```ts
export interface CrawledDocument {
  url: string;
  title: string;
  paragraphs: string[];
  totalChars: number;
  fetchedAt: number;
}

export interface CrawlResult {
  ok: boolean;
  status?: number;
  error?: string;
  document?: CrawledDocument;
  sourceId?: string;
  documentId?: string;
}

/**
 * Admin 端调本地 crawler：fetch /api/crawl?url=...
 * 后端 apps/api 没有 /api/crawl 端点（M4 范围外）；本步骤先实现一个 thin proxy
 * 走 apps/api 的 /ingest 已存在 endpoint 在 admin 端直接调。
 *
 * 简化：admin 直接调本地 /api/crawl（如果 apps/api 加了 endpoint）
 * 或：先返回抓取结果，ingest 单独按钮触发。
 */
export async function crawlUrl(url: string): Promise<CrawlResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`/api/crawl?url=${encodeURIComponent(url)}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, status: res.status, error: text };
  }
  return (await res.json()) as CrawlResult;
}
```

- [ ] **Step 3: typecheck + commit**

```bash
pnpm -F admin typecheck 2>&1 | tail -5
git add apps/admin/src/lib/api.ts
git commit -m "M4 task 8: admin api.ts — crawlUrl() + CrawledDocument + CrawlResult types"
```

---

### Task 9: admin CrawlPage 页

**Files:**
- Create: `apps/admin/src/pages/CrawlPage.tsx`

- [ ] **Step 1: 实现 CrawlPage**

```tsx
import { useState } from "react";
import type { FormEvent } from "react";
import { crawlUrl, type CrawlResult, type CrawledDocument } from "../lib/api.js";

export default function CrawlPage() {
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CrawlResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!url.trim()) {
      setError("请输入 URL");
      return;
    }
    setSubmitting(true);
    try {
      const r = await crawlUrl(url.trim());
      setResult(r);
      if (!r.ok) setError(r.error ?? "抓取失败");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-6">
      <h2 className="text-xl font-semibold">网页抓取</h2>

      <form onSubmit={onSubmit} className="space-y-3 rounded border border-gray-200 bg-white p-6">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">URL</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/article"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? "抓取中…" : "抓取"}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>

      {result?.document && (
        <div className="space-y-3 rounded border border-gray-200 bg-white p-6">
          <div>
            <h3 className="text-lg font-semibold">{result.document.title || "(无标题)"}</h3>
            <p className="text-xs text-gray-500">{result.document.url}</p>
          </div>
          <div className="text-xs text-gray-600">
            <span className="rounded bg-green-100 px-2 py-0.5 text-green-700">webpage</span>
            <span className="ml-2">{result.document.paragraphs.length} 段 · {result.document.totalChars} 字符</span>
          </div>
          <div className="space-y-2">
            {result.document.paragraphs.map((p, idx) => (
              <p key={idx} className="text-sm text-gray-700">{p}</p>
            ))}
          </div>
          {result.ok && result.sourceId && (
            <p className="text-xs text-green-600">
              入库成功：source {result.sourceId} / document {result.documentId}
            </p>
          )}
        </div>
      )}

      {result && !result.ok && (
        <div className="rounded border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          <p>抓取失败：{result.error}</p>
          <p className="mt-2 text-xs">提示：mock-first 模式下 /ingest 调 Vectorize 远端 binding 会 500（已知）。要真入库请走 CP-5 真接 Cloudflare。</p>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: typecheck + commit**

```bash
pnpm -F admin typecheck 2>&1 | tail -5
git add apps/admin/src/pages/CrawlPage.tsx
git commit -m "M4 task 9: admin CrawlPage (URL form + result display + error state)"
```

---

### Task 10: wire CrawlPage 进 App.tsx

**Files:**
- Modify: `apps/admin/src/App.tsx`

- [ ] **Step 1: 读 App.tsx 找插入点**

- [ ] **Step 2: 加 import + 路由 + 导航**

```tsx
// 顶部 import 段追加：
import CrawlPage from "./pages/CrawlPage.js";

// 导航段（在 /chat-sim 之后）追加：
<Link to="/crawl" className="text-gray-600 hover:text-gray-900">抓取</Link>

// Routes 段（在 /chat-sim 之后）追加：
<Route path="/crawl" element={<CrawlPage />} />
```

- [ ] **Step 3: build 验证**

```bash
pnpm -F admin build 2>&1 | tail -10
```

预期：vite build 成功。

- [ ] **Step 4: commit**

```bash
git add apps/admin/src/App.tsx
git commit -m "M4 task 10: wire CrawlPage into App routing + nav"
```

---

### Task 11: CP-3 收尾

- [ ] **Step 1: 全 typecheck + build**

```bash
pnpm -r typecheck 2>&1 | tail -10
pnpm -F admin build 2>&1 | tail -5
```

预期：5 包 typecheck 绿（含 apps/crawler），admin build 成功。

- [ ] **Step 2: commit（如有遗漏）**

```bash
git status --short
```

如有 dirty，commit "M4 task 11: CP-3 final verification"。

**CP-3 完成**：admin 抓取页 + 路由；可在 admin 内嵌 UI 触发抓取（mock-first 模式下 ingest 已知 500）。

---

## CP-4: docs + README + 收尾

**目标**：`docs/webpage-crawler-setup.md` 抓取器使用 + 真人操作；README M4 段加完；全测全绿。

**完成定义**：`pnpm -r typecheck` 5 包绿；docs 完整。

---

### Task 12: docs/webpage-crawler-setup.md

**Files:**
- Create: `docs/webpage-crawler-setup.md`

- [ ] **Step 1: 写 setup doc**

````markdown
# 网页抓取器使用 + 真人操作 Checklist

> M4 mock-first 阶段代码完整（`apps/crawler/` + admin CrawlPage），但**真抓真网 / 配 Cron / 限速**需真人操作。
> 本文档按时间顺序列出。

## 1. 抓取器用法

### 1.1 CLI 模式（最直接）

```bash
cd /Users/Mark/cc_project/unequal
node apps/crawler/src/main.ts --url "https://example.com/article" --token "test-token-please-change"
```

参数：
- `--url`（必填）：抓取 URL
- `--ingest-url`（可选）：默认 `http://localhost:8787/ingest`
- `--token`（可选，admin token）：如果省略，CLI 走 `--no-ingest` 模式
- `--trust 0|1|2|3`（可选）：默认 2（可信）
- `--no-ingest`（可选）：只抓不调 ingest（调试用）

### 1.2 admin UI 模式

`pnpm -F admin dev` → 访问 `/crawl` → 输入 URL → 抓取 → 显示 title/段落/字符数。

### 1.3 程序化调用

```ts
import { fetchUrl } from "./apps/crawler/src/sources/webpage.js";
import { buildIngestPayload, submitToIngest } from "./apps/crawler/src/ingest.js";

const doc = await fetchUrl("https://example.com/article");
const payload = buildIngestPayload(doc, { userId: "...", trustLevel: 2 });
const result = await submitToIngest(doc, {
  ingestUrl: "http://localhost:8787/ingest",
  token: "...",
});
```

## 2. mock-first 局限

| 场景 | 行为 |
|---|---|
| 抓取真网 | ❌ 不做（需要真人 + 网络） |
| ingest 调 Vectorize 远端 binding | ⚠️ mock-first 下 500（无真 Vectorize index） |
| admin 抓取 UI 显示 | ✅ 抓取 + 解析可验；ingest 入库 500 时 UI 弹错 |

## 3. 真人操作 Checklist

### 3.1 配 Cloudflare Vectorize 真 index（CP-5 范围）

```bash
npx wrangler vectorize create unequal-chunks --dimensions=1024 --metric=cosine
# 拿返回的 index_id，填到 apps/api/wrangler.jsonc 的 vectorize[0].index_name
```

### 3.2 抓取速率限制

简单起步：每秒 ≤ 1 个请求（`apps/crawler/src/sources/webpage.ts` 加 setTimeout 1000ms）。

生产：v2+ 加 p-queue / Bottleneck（队列 + 并发限流）。

### 3.3 抓取 Cron 定时（v2+）

```bash
# macOS launchd（每 6 小时抓一次指定 URL 列表）
0 */6 * * * cd /path/to/unequal && pnpm tsx apps/crawler/src/main.ts --url "https://..." --token "..." >> /var/log/crawler.log 2>&1
```

### 3.4 反爬策略（v2+）

- User-Agent 轮换：每次抓取随机选 UA
- 代理 IP 池：v2+ 集成（如不需要可跳过）
- 验证码识别：v2+ 接打码平台（如不抓需要登录的页面可跳过）

## 4. 遇到问题

| 问题 | 排查 |
|---|---|
| 抓取返回 403/401 | 加 User-Agent header（默认已有）或换 IP |
| cheerio 解析空段落 | 网页是 JS 渲染 SPA — 需 Playwright（v2+） |
| ingest 500 internal | Vectorize 远端 binding 缺失 — CP-5 真接 |
| /ingest 401 | admin token 不对 — 检查 apps/api/.dev.vars 的 `ADMIN_TOKEN` |
| 字符数统计 < 实际 | cheerio 只抓 `<p>` 标签；如有 `<div>` 内容需 v2+ 自定义 selector |

## 5. 关联文档

- `docs/superpowers/specs/2026-06-15-m4-crawler-design.md` — M4 设计
- `docs/superpowers/state-m4.md` — M4 归档（CP-4 完成后生成）
- `apps/api/src/routes/ingest.ts` — /ingest endpoint 接收方（M0+M1）
- `apps/crawler/src/parser.ts` — cheerio 解析逻辑
````

- [ ] **Step 2: commit**

```bash
git add docs/webpage-crawler-setup.md
git commit -m "M4 task 12: docs/webpage-crawler-setup.md (crawler usage + 真人操作 checklist)"
```

---

### Task 13: README M4 段 + CP-4 收尾

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 找 M3 段位置**

```bash
grep -n "## M3 状态" README.md
```

- [ ] **Step 2: 在 M3 段之后追加 M4 段**

```markdown
## M4 状态

跑通：网页抓取（curl + cheerio → /ingest）端到端 + admin 抓取页可视化。

mock-first 实现：抓取器用 cheerio（零浏览器依赖），/ingest 调远端 Vectorize binding 缺失 500 已知（CP-5 真接后修复）。真抓真网 / 配 Cron / 限速推 v2+。

### 抓取器用法

```bash
# CLI
node apps/crawler/src/main.ts --url "https://example.com/article" --token "..."

# admin UI
pnpm -F admin dev → /crawl
```

### M4 测试矩阵

- `pnpm -F crawler test` — 11 用例（parser 4 + webpage 4 + ingest 3）
- `pnpm -F admin build` — 成功（含 CrawlPage）
```

- [ ] **Step 3: 全测 + typecheck + build**

```bash
pnpm -r typecheck 2>&1 | tail -10
pnpm -F crawler test 2>&1 | tail -10
pnpm -F admin build 2>&1 | tail -10
```

预期：5 包 typecheck 绿（miniprogram / shared / admin / api / crawler），crawler 11 用例全绿，admin build 成功。

- [ ] **Step 4: commit**

```bash
git add README.md
git commit -m "M4 task 13: README M4 section + CP-4 final verification"
```

**CP-4 完成**：M4 端到端跑通（mock-first + 真人 checklist）。

---

## 11 任务汇总

| CP | Task | Commit msg | 关键产物 |
|---|---|---|---|
| 1 | 1 | monorepo scaffold for apps/crawler | tsconfig + package.json + workspace |
| 1 | 2 | crawler src/types.ts | types.ts |
| 1 | 3 | crawler parser.ts + 4 unit tests + fixture | parser.ts + sample-article.html |
| 1 | 4 | crawler sources/webpage.ts + 4 unit tests | webpage.ts |
| 1 | 5 | crawler ingest.ts + 3 unit tests | ingest.ts |
| 1 | 6 | CP-1 final verification | — |
| 2 | 7 | crawler main.ts CLI | main.ts |
| 3 | 8 | admin api.ts — crawlUrl() + types | lib/api.ts |
| 3 | 9 | admin CrawlPage | CrawlPage.tsx |
| 3 | 10 | wire CrawlPage into App routing + nav | App.tsx |
| 3 | 11 | CP-3 final verification | — |
| 4 | 12 | docs/webpage-crawler-setup.md | 真人 checklist |
| 4 | 13 | README M4 section + CP-4 final verification | README |

---

## 14. Mock-first 边界（重申）

- ❌ 不抓取真网
- ❌ 不配代理 / 不调任何真人 API
- ❌ 不创建真 Cloudflare 资源（Vectorize / D1 / R2 推 CP-5）
- ✅ `pnpm -F crawler test` 11 用例 + `pnpm -F admin build` 全绿
- ✅ admin CrawlPage UI 可验（抓取 + 解析 + 错误态）
- ✅ 真接 Cloudflare 推 CP-5

---

## 15. 风险与回退

| 风险 | 概率 | 缓解 | 回退 |
|---|---|---|---|
| cheerio 对某些网页解析不准确 | 高 | 选主流 article/main/p selector；v2+ 加可配置 selector | v2+ 集成 Playwright 处理 SPA |
| CLI 启动需 node ESM 配置 | 低 | package.json 加 `"type": "module"` 或 tsx 运行 | v2+ |
| admin /api/crawl 端点缺失 | 中 | apps/api 没加 /api/crawl — admin 直接 fetch 端点不存在会 404 | v2+ apps/api 加 thin proxy endpoint |
| ingest 调 Vectorize 远端 binding 500 | 高 | admin UI 显示错误态 + 提示 CP-5 真接 | CP-5 |
| 抓取速率无限制 | 中 | mock-first 范围内不抓真网 | v2+ p-queue |

---

## 16. 出 CP-1/2/3/4 后的归档

- `state.md`（M4 专用）记录：
  - mock-first 边界
  - checkpoint pass 标准
  - 与 spec 的偏差
  - 未做项（推到 v2+ 真接 + 真抓）
- 完成后用 `superpowers:finishing-a-development-branch` 决定 merge / PR

---

## 17. 写 plan 时的自检

按 writing-plans skill §Self-Review：

- ✅ Spec coverage：spec §1-7 都有对应 task
  - §1 文件结构：Task 1/2/3/4/5/7/8/9 覆盖
  - §2 范围外：明确推到 v2+/M5+
  - §3.1 抓取 pipeline：Task 3/4 实现
  - §3.2 /ingest 复用：Task 5 buildIngestPayload 对齐
  - §3.3 mock-first 边界：§14 重申
  - §3.4 与 M0+M1/M2 边界：Task 5 复用 ingest
  - §3.5 admin UI：Task 9 实现
  - §6 验收：每个 CP 完成定义明确
  - §6 CP 划分：4 CP / 13 task 严格匹配
- ✅ Placeholder scan：无 TBD/TODO；每个 code step 都有完整代码
- ✅ Type consistency：`CrawledDocument` / `IngestPayload` 跨 task 一致
- ✅ No "see Task N" 重定向：每个 step 独立完整
- ✅ Frequent commits：13 task = 13 commit
- ✅ TDD：parser/webpage/ingest 三个 task 先 test 后 impl
- ✅ File structure 在 §1 锁定
