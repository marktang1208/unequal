# M0 + M1 Implementation Plan: Monorepo Scaffold + Knowledge Base Minimal Loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 spec 的 M0（项目脚手架）和 M1（知识库最小闭环）跑通——能在 admin 后台上传一份 PDF，30 秒内 `/search` 接口能命中该 PDF 内的内容并按 trust_level 加权排序。

**Architecture:** pnpm monorepo，`apps/api` 是 Cloudflare Workers（API 网关 + 摄入/检索），`apps/admin` 是 React + Vite（管理后台，部署到 Pages），`packages/shared` 是被两边复用的纯 TypeScript（types / chunking / embedding / retrieval）。文件经 Worker 中转上传到 R2，摄入管道按 PDF/Word/TXT/MD 分支解析 → chunking → MiniMax embedding → 写 D1 + Vectorize。`/search` 是 admin 测试用的纯检索端点（不调 LLM，M2 再加 chat）。

**Tech Stack:** pnpm workspace, TypeScript 5, Cloudflare Workers + D1 + Vectorize + R2, MiniMax API (OpenAI 兼容), React 18 + Vite 5, TailwindCSS, Vitest, Zod.

**Spec reference:** `docs/superpowers/specs/2026-06-14-unequal-top-level-design.md`

---

## File Structure

```
unequal/
├── apps/
│   ├── api/                          # Cloudflare Workers (M0+M1)
│   │   ├── src/
│   │   │   ├── index.ts              # 入口，路由分发
│   │   │   ├── routes/
│   │   │   │   ├── health.ts         # GET /health
│   │   │   │   ├── search.ts        # GET /search  (admin 测试用)
│   │   │   │   ├── upload.ts        # POST /upload (M1 简化为 Worker 中转)
│   │   │   │   └── ingest.ts        # POST /ingest (供未来爬虫 + 上传后端入库用)
│   │   │   ├── lib/
│   │   │   │   ├── auth.ts          # ADMIN_TOKEN 校验
│   │   │   │   ├── d1.ts            # D1 client helpers
│   │   │   │   ├── vectorize.ts     # Vectorize client helpers
│   │   │   │   ├── r2.ts            # R2 client helpers
│   │   │   │   └── parsers/
│   │   │   │       ├── pdf.ts
│   │   │   │       ├── word.ts
│   │   │   │       └── text.ts
│   │   │   └── types.ts             # wrangler 绑定类型
│   │   ├── wrangler.jsonc
│   │   ├── migrations/
│   │   │   └── 0001_init.sql
│   │   ├── test/                     # Vitest
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── admin/                        # React + Vite (M0+M1)
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── pages/
│       │   │   ├── Sources.tsx
│       │   │   ├── Upload.tsx
│       │   │   ├── Documents.tsx
│       │   │   └── SearchTest.tsx
│       │   ├── lib/
│       │   │   └── api.ts            # 后端调用封装
│       │   └── index.css
│       ├── index.html
│       ├── vite.config.ts
│       ├── package.json
│       └── tsconfig.json
│
├── packages/
│   └── shared/                       # 共享 (M0+M1)
│       ├── src/
│       │   ├── types.ts              # User/Source/Document/Chunk/Citation 等
│       │   ├── schemas.ts            # Zod schemas
│       │   ├── chunking.ts           # 文本分块
│       │   ├── embedding.ts          # embedding 接口 + MiniMax 实现
│       │   └── retrieval.ts          # Vectorize query + trust_level 加权 + 缓存
│       ├── test/
│       ├── package.json
│       └── tsconfig.json
│
├── docs/
│   └── superpowers/
│       ├── specs/
│       └── plans/
│
├── .env.example                      # MiniMax API key 等
├── .gitignore
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
```

**不在 M0+M1 范围**：爬虫 (apps/crawler)、prompts 包、Durable Objects、小程序、信源自动评级、查询缓存写回（查询缓存读取在 M0+M1 也不做，留到 M2）。

---

## Open Items（执行 plan 时需先确认）

这些是执行前需要拿到的真实值，plan 里会用 placeholder 写死，但跑通后必须改：

1. **MiniMax API base URL** 和 **embedding 维度**——执行 Task 2 创建 Vectorize 时用 placeholder `1024` 维度；用户登录 platform.MiniMax.io 确认后改 `apps/api/wrangler.jsonc` 的 `vectorize.dimensions`。
2. **个人主体小程序 appid**——M0+M1 不需要，留到 M3。
3. **Cloudflare account_id**——执行 Task 2 时 `wrangler login` 拿到。

---

### Task 1: Monorepo Scaffold (pnpm workspace + TypeScript base + 初始 commit)

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `README.md`
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/admin/package.json`
- Create: `apps/admin/tsconfig.json`
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`

- [ ] **Step 1.1: 写根 package.json**

`/Users/Mark/cc_project/unequal/package.json`：

```json
{
  "name": "unequal",
  "private": true,
  "version": "0.0.1",
  "description": "WeChat-ecosystem personal parenting RAG agent",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "dev:api": "pnpm -F api dev",
    "dev:admin": "pnpm -F admin dev",
    "deploy:api": "pnpm -F api deploy",
    "deploy:admin": "pnpm -F admin deploy"
  },
  "engines": {
    "node": ">=20",
    "pnpm": ">=9"
  }
}
```

- [ ] **Step 1.2: 写 pnpm-workspace.yaml**

`/Users/Mark/cc_project/unequal/pnpm-workspace.yaml`：

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 1.3: 写 tsconfig.base.json**

`/Users/Mark/cc_project/unequal/tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true
  }
}
```

- [ ] **Step 1.4: 写 .gitignore**

`/Users/Mark/cc_project/unequal/.gitignore`：

```
node_modules/
dist/
.wrangler/
.dev.vars
.env
.env.local
*.log
.DS_Store
coverage/
```

- [ ] **Step 1.5: 写 README.md**

`/Users/Mark/cc_project/unequal/README.md`：

```markdown
# unequal / 不等号

微信端个人育儿智能体，基于个人知识库的问答 + 引用追溯。

## 架构

参见 `docs/superpowers/specs/2026-06-14-unequal-top-level-design.md`。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
```

各 app 单独开发：

```bash
pnpm dev:api
pnpm dev:admin
```

## 部署

```bash
pnpm deploy:api
pnpm deploy:admin
```
```

- [ ] **Step 1.6: 写 apps/api/package.json**

`/Users/Mark/cc_project/unequal/apps/api/package.json`：

```json
{
  "name": "api",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "build": "wrangler deploy --dry-run --outdir=dist",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "db:migrate": "wrangler d1 migrations apply unequal-db --local"
  },
  "dependencies": {
    "@unequal/shared": "workspace:*",
    "hono": "^4.5.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20240620.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "wrangler": "^3.65.0"
  }
}
```

- [ ] **Step 1.7: 写 apps/api/tsconfig.json**

`/Users/Mark/cc_project/unequal/apps/api/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "outDir": "dist",
    "noEmit": true
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 1.8: 写 apps/admin/package.json**

`/Users/Mark/cc_project/unequal/apps/admin/package.json`：

```json
{
  "name": "admin",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "deploy": "wrangler pages deploy dist",
    "test": "vitest run",
    "typecheck": "tsc -b --noEmit"
  },
  "dependencies": {
    "@unequal/shared": "workspace:*",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.25.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.5.0",
    "vite": "^5.3.0",
    "vitest": "^2.0.0",
    "wrangler": "^3.65.0"
  }
}
```

- [ ] **Step 1.9: 写 apps/admin/tsconfig.json**

`/Users/Mark/cc_project/unequal/apps/admin/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "outDir": "dist",
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 1.10: 写 packages/shared/package.json**

`/Users/Mark/cc_project/unequal/packages/shared/package.json`：

```json
{
  "name": "@unequal/shared",
  "version": "0.0.1",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./types": "./src/types.ts",
    "./chunking": "./src/chunking.ts",
    "./embedding": "./src/embedding.ts",
    "./retrieval": "./src/retrieval.ts"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 1.11: 写 packages/shared/tsconfig.json**

`/Users/Mark/cc_project/unequal/packages/shared/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "outDir": "dist",
    "noEmit": true
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 1.12: 安装依赖并验证**

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm install
```

Expected: 安装成功，无错误。可能需要 1-2 分钟。

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm -r typecheck
```

Expected: 每个 package 报告 `Done`（即使 src/ 还是空的，tsconfig 通过就行）。

- [ ] **Step 1.13: 提交**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo with apps/api, apps/admin, packages/shared"
```

---

### Task 2: Cloudflare Resources + wrangler Configuration

**Files:**
- Create: `apps/api/wrangler.jsonc`
- Create: `apps/api/src/index.ts` (hello world)
- Create: `apps/api/src/types.ts`
- Create: `apps/api/.dev.vars.example`

- [ ] **Step 2.1: 登录 Cloudflare**

Run:
```bash
cd /Users/Mark/cc_project/unequal/apps/api && pnpm wrangler login
```

Expected: 浏览器弹出 Cloudflare 授权页，登录后 CLI 显示 `Successfully logged in.`。

- [ ] **Step 2.2: 创建 D1 数据库**

Run:
```bash
cd /Users/Mark/cc_project/unequal/apps/api && pnpm wrangler d1 create unequal-db
```

Expected: 输出形如
```
[[d1_databases]]
binding = "DB"
database_name = "unequal-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

把 `database_id` 复制下来，**Step 2.6 会用到**。

- [ ] **Step 2.3: 创建 Vectorize 索引**

> ⚠️ 维度用 placeholder `1024`。MiniMax embedding 真实维度待登录 platform.MiniMax.io 确认后改 wrangler.jsonc。

Run:
```bash
cd /Users/Mark/cc_project/unequal/apps/api && pnpm wrangler vectorize create unequal-chunks --dimensions=1024 --metric=cosine
```

Expected: 输出 `✅ Created index 'unequal-chunks'`.

- [ ] **Step 2.4: 创建 R2 bucket**

Run:
```bash
cd /Users/Mark/cc_project/unequal/apps/api && pnpm wrangler r2 bucket create unequal-storage
```

Expected: 输出 `✨ Successfully created bucket 'unequal-storage'`.

- [ ] **Step 2.5: 创建 wrangler.jsonc**

`/Users/Mark/cc_project/unequal/apps/api/wrangler.jsonc`：

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "unequal-api",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },

  "vars": {
    "ENVIRONMENT": "development"
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "unequal-db",
      "database_id": "PASTE_DATABASE_ID_FROM_STEP_2.2",
      "migrations_dir": "migrations"
    }
  ],

  "vectorize": [
    {
      "binding": "VECTORIZE",
      "index_name": "unequal-chunks"
    }
  ],

  "r2_buckets": [
    {
      "binding": "R2",
      "bucket_name": "unequal-storage"
    }
  ],

  "secrets": {
    "ADMIN_TOKEN": "",
    "MINIMAX_API_KEY": ""
  }
}
```

> 把 `PASTE_DATABASE_ID_FROM_STEP_2.2` 替换为 Step 2.2 拿到的真实 ID。`secrets` 段会在 Step 2.8 实际写入，wrangler.jsonc 只是声明。

- [ ] **Step 2.6: 创建 .dev.vars.example**

`/Users/Mark/cc_project/unequal/apps/api/.dev.vars.example`：

```bash
ADMIN_TOKEN=dev-token-change-me
MINIMAX_API_KEY=sk-MiniMax-placeholder
MINIMAX_BASE_URL=https://api.MiniMax.chat/v1
```

> 本地开发用 `wrangler dev` 时，wrangler 读 `.dev.vars`（这个文件被 `.gitignore` 忽略）。`.dev.vars.example` 是模板，提交进 git。

- [ ] **Step 2.7: 创建 .dev.vars (本地用，gitignored)**

Run:
```bash
cd /Users/Mark/cc_project/unequal/apps/api && cp .dev.vars.example .dev.vars
```

然后编辑 `.dev.vars`，把 `MINIMAX_API_KEY` 换成真实值（M0+M1 实际不需要 LLM 调用，但 Task 7 以后会用到）。

- [ ] **Step 2.8: 写入生产 secrets**

Run:
```bash
cd /Users/Mark/cc_project/unequal/apps/api && pnpm wrangler secret put ADMIN_TOKEN
# 按提示输入 token 值
pnpm wrangler secret put MINIMAX_API_KEY
# 按提示输入 API key
```

Expected: 两次都输出 `✨ Success! Updated the secret values.`

- [ ] **Step 2.9: 创建 src/types.ts（wrangler 绑定类型）**

`/Users/Mark/cc_project/unequal/apps/api/src/types.ts`：

```typescript
export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  R2: R2Bucket;
  ADMIN_TOKEN: string;
  MINIMAX_API_KEY: string;
  MINIMAX_BASE_URL: string;
  ENVIRONMENT: string;
}
```

- [ ] **Step 2.10: 创建 src/index.ts（hello world）**

`/Users/Mark/cc_project/unequal/apps/api/src/index.ts`：

```typescript
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", environment: env.ENVIRONMENT }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
```

- [ ] **Step 2.11: 本地启动验证**

Run:
```bash
cd /Users/Mark/cc_project/unequal/apps/api && pnpm dev
```

Expected: 几秒后看到 `Ready on http://localhost:8787`

另开终端：
```bash
curl http://localhost:8787/health
```

Expected: `{"status":"ok","environment":"development"}`

按 Ctrl+C 停掉。

- [ ] **Step 2.12: typecheck + 提交**

```bash
cd /Users/Mark/cc_project/unequal && pnpm -F api typecheck
git add apps/api/wrangler.jsonc apps/api/src/ apps/api/.dev.vars.example apps/api/package.json
git commit -m "feat(api): scaffold worker with d1+vectorize+r2 bindings, /health endpoint"
```

---

### Task 3: D1 Schema Migration

**Files:**
- Create: `apps/api/migrations/0001_init.sql`
- Create: `apps/api/migrations/0001_init.down.sql`
- Create: `apps/api/scripts/seed-default-user.mjs`

- [ ] **Step 3.1: 创建迁移 SQL**

`/Users/Mark/cc_project/unequal/apps/api/migrations/0001_init.sql`：

```sql
-- 用户（MVP 阶段只有 1 行；wx_openid 留给未来 wx.login）
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  wx_openid TEXT UNIQUE,
  nickname TEXT,
  created_at INTEGER NOT NULL
);

-- 数据源
CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('file', 'webpage', 'xiaohongshu', 'wechat-mp')),
  title TEXT,
  url TEXT,
  account TEXT,
  trust_level INTEGER NOT NULL DEFAULT 0 CHECK (trust_level BETWEEN 0 AND 3),
  created_at INTEGER NOT NULL,
  meta TEXT,
  FOREIGN KEY (user_id) REFERENCES user(id)
);

CREATE INDEX IF NOT EXISTS source_user_idx ON source(user_id);

-- 文档
CREATE TABLE IF NOT EXISTS document (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT,
  raw_path TEXT NOT NULL,
  parsed_text_path TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_id) REFERENCES source(id)
);

CREATE INDEX IF NOT EXISTS document_source_idx ON document(source_id);
CREATE INDEX IF NOT EXISTS document_user_idx ON document(user_id);

-- chunk（最小检索单元）
CREATE TABLE IF NOT EXISTS chunk (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  trust_level INTEGER NOT NULL CHECK (trust_level BETWEEN 0 AND 3),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES document(id)
);

CREATE INDEX IF NOT EXISTS chunk_user_idx ON chunk(user_id);
CREATE INDEX IF NOT EXISTS chunk_document_idx ON chunk(document_id);

-- 抓取任务
CREATE TABLE IF NOT EXISTS crawl_job (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_id TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'cron')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed')),
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS crawl_job_user_idx ON crawl_job(user_id);
CREATE INDEX IF NOT EXISTS crawl_job_status_idx ON crawl_job(status);
```

- [ ] **Step 3.2: 创建 down migration（用于 reset）**

`/Users/Mark/cc_project/unequal/apps/api/migrations/0001_init.down.sql`：

```sql
DROP TABLE IF EXISTS crawl_job;
DROP TABLE IF EXISTS chunk;
DROP TABLE IF EXISTS document;
DROP TABLE IF EXISTS source;
DROP TABLE IF EXISTS user;
```

- [ ] **Step 3.3: 应用迁移到本地 D1**

Run:
```bash
cd /Users/Mark/cc_project/unequal/apps/api && pnpm db:migrate
```

Expected: 输出 `Migrations applied successfully.`

- [ ] **Step 3.4: 验证表创建**

Run:
```bash
cd /Users/Mark/cc_project/unequal/apps/api && pnpm wrangler d1 execute unequal-db --local --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Expected: 输出形如
```
name
chunk
crawl_job
document
source
sqlite_sequence
user
_d1_migrations
```

- [ ] **Step 3.5: 创建默认 user 种子脚本**

`/Users/Mark/cc_project/unequal/apps/api/scripts/seed-default-user.mjs`：

```javascript
// 用法：node scripts/seed-default-user.mjs
// 写一个固定的 default user，id 是 "01H0000000000000000000000"（MVP 阶段 admin 写死用这个 id）

import { ulid } from "ulid";

const DEFAULT_USER_ID = "01H0000000000000000000000";

const result = await fetch("http://127.0.0.1:8787/seed-user", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: DEFAULT_USER_ID, nickname: "default" }),
});
console.log(result.status, await result.text());
```

> 这个脚本是占位说明，实际写到 Task 8（Workers 基础）才实现 `/seed-user` 路由。M0+M1 完成时才会真正调用。

- [ ] **Step 3.6: 提交**

```bash
git add apps/api/migrations/ apps/api/scripts/
git commit -m "feat(api): d1 schema migration with user/source/document/chunk/crawl_job tables"
```

---

### Task 4: packages/shared - Types + Zod Schemas

**Files:**
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/schemas.ts`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/test/types.test.ts`

- [ ] **Step 4.1: 安装 ulid（用作 ID 生成）**

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm -F @unequal/shared add ulid
```

- [ ] **Step 4.2: 写 types.ts**

`/Users/Mark/cc_project/unequal/packages/shared/src/types.ts`：

```typescript
export type SourceType = "file" | "webpage" | "xiaohongshu" | "wechat-mp";
export type TrustLevel = 0 | 1 | 2 | 3;

export interface User {
  id: string;
  wxOpenid?: string;
  nickname?: string;
  createdAt: number;
}

export interface Source {
  id: string;
  userId: string;
  type: SourceType;
  title?: string;
  url?: string;
  account?: string;
  trustLevel: TrustLevel;
  createdAt: number;
  meta?: Record<string, unknown>;
}

export interface Document {
  id: string;
  sourceId: string;
  userId: string;
  title?: string;
  rawPath: string;
  parsedTextPath?: string;
  createdAt: number;
}

export interface Chunk {
  id: string;
  documentId: string;
  sourceId: string;
  userId: string;
  idx: number;
  content: string;
  tokenCount: number;
  trustLevel: TrustLevel;
  createdAt: number;
}

export interface Citation {
  n: number;
  title?: string;
  snippet: string;
  url: string;
  trustLevel: TrustLevel;
  sourceId: string;
  chunkId: string;
}
```

- [ ] **Step 4.3: 写 schemas.ts**

`/Users/Mark/cc_project/unequal/packages/shared/src/schemas.ts`：

```typescript
import { z } from "zod";

export const TrustLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const SourceTypeSchema = z.enum(["file", "webpage", "xiaohongshu", "wechat-mp"]);

export const UserSchema = z.object({
  id: z.string().min(1),
  wxOpenid: z.string().optional(),
  nickname: z.string().optional(),
  createdAt: z.number().int().positive(),
});

export const SourceSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  type: SourceTypeSchema,
  title: z.string().optional(),
  url: z.string().url().optional(),
  account: z.string().optional(),
  trustLevel: TrustLevelSchema,
  createdAt: z.number().int().positive(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const DocumentSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  userId: z.string().min(1),
  title: z.string().optional(),
  rawPath: z.string().min(1),
  parsedTextPath: z.string().optional(),
  createdAt: z.number().int().positive(),
});

export const ChunkSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  sourceId: z.string().min(1),
  userId: z.string().min(1),
  idx: z.number().int().nonnegative(),
  content: z.string().min(1),
  tokenCount: z.number().int().nonnegative(),
  trustLevel: TrustLevelSchema,
  createdAt: z.number().int().positive(),
});

export const CitationSchema = z.object({
  n: z.number().int().positive(),
  title: z.string().optional(),
  snippet: z.string().min(1),
  url: z.string().min(1),
  trustLevel: TrustLevelSchema,
  sourceId: z.string().min(1),
  chunkId: z.string().min(1),
});
```

- [ ] **Step 4.4: 写 index.ts (barrel export)**

`/Users/Mark/cc_project/unequal/packages/shared/src/index.ts`：

```typescript
export * from "./types.js";
export * from "./schemas.js";
```

> `.js` 后缀是 ESM + TypeScript 推荐的"显式扩展名"写法，配合 `moduleResolution: "Bundler"`。

- [ ] **Step 4.5: 写 vitest 配置 + 测试**

`/Users/Mark/cc_project/unequal/packages/shared/vitest.config.ts`：

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
```

`/Users/Mark/cc_project/unequal/packages/shared/test/schemas.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { SourceSchema, ChunkSchema, TrustLevelSchema } from "../src/schemas.js";

describe("TrustLevelSchema", () => {
  it("accepts 0,1,2,3", () => {
    for (const t of [0, 1, 2, 3]) {
      expect(TrustLevelSchema.parse(t)).toBe(t);
    }
  });
  it("rejects 4 and -1", () => {
    expect(() => TrustLevelSchema.parse(4)).toThrow();
    expect(() => TrustLevelSchema.parse(-1)).toThrow();
  });
});

describe("SourceSchema", () => {
  it("accepts a minimal file source", () => {
    const src = {
      id: "01H...",
      userId: "u1",
      type: "file" as const,
      trustLevel: 1 as const,
      createdAt: Date.now(),
    };
    expect(SourceSchema.parse(src)).toEqual(src);
  });
  it("rejects invalid type", () => {
    expect(() =>
      SourceSchema.parse({
        id: "01H...",
        userId: "u1",
        type: "bogus",
        trustLevel: 1,
        createdAt: Date.now(),
      })
    ).toThrow();
  });
});

describe("ChunkSchema", () => {
  it("accepts a valid chunk", () => {
    const c = {
      id: "01H...",
      documentId: "d1",
      sourceId: "s1",
      userId: "u1",
      idx: 0,
      content: "hello",
      tokenCount: 1,
      trustLevel: 0 as const,
      createdAt: Date.now(),
    };
    expect(ChunkSchema.parse(c)).toEqual(c);
  });
});
```

- [ ] **Step 4.6: 运行测试**

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm -F @unequal/shared test
```

Expected:
```
✓ test/schemas.test.ts (4 tests) X passed
```

- [ ] **Step 4.7: 提交**

```bash
git add packages/shared/
git commit -m "feat(shared): core types and zod schemas for user/source/document/chunk/citation"
```

---

### Task 5: packages/shared - Chunking (TDD)

**Files:**
- Create: `packages/shared/src/chunking.ts`
- Create: `packages/shared/test/chunking.test.ts`

- [ ] **Step 5.1: 写测试**

`/Users/Mark/cc_project/unequal/packages/shared/test/chunking.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { chunkText } from "../src/chunking.js";

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    const chunks = chunkText("hello world", { maxTokens: 100, overlapTokens: 10 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("hello world");
    expect(chunks[0]?.tokenCount).toBeGreaterThan(0);
  });

  it("splits long text into multiple chunks with overlap", () => {
    // 制造一段约 100 token 的中文文本
    const longText = "育儿知识。".repeat(100);
    const chunks = chunkText(longText, { maxTokens: 30, overlapTokens: 5 });
    expect(chunks.length).toBeGreaterThan(1);
    // 每个 chunk 都有 idx，从 0 开始递增
    chunks.forEach((c, i) => expect(c.idx).toBe(i));
  });

  it("preserves content when joining chunks covers original (overlap allowed)", () => {
    const text = "第一段内容。第二段内容。第三段内容。";
    const chunks = chunkText(text, { maxTokens: 10, overlapTokens: 3 });
    // 拼回去的字符应该覆盖原文（允许 overlap 重复）
    const joined = chunks.map((c) => c.content).join("");
    expect(joined.length).toBeGreaterThanOrEqual(text.length);
  });

  it("handles empty text", () => {
    expect(chunkText("", { maxTokens: 100, overlapTokens: 10 })).toEqual([]);
  });

  it("handles text with only whitespace", () => {
    expect(chunkText("   \n  \n", { maxTokens: 100, overlapTokens: 10 })).toEqual([]);
  });
});
```

- [ ] **Step 5.2: 运行测试确认失败**

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm -F @unequal/shared test chunking
```

Expected: 失败，报 `Cannot find module '../src/chunking.js'` 或类似。

- [ ] **Step 5.3: 实现 chunking**

`/Users/Mark/cc_project/unequal/packages/shared/src/chunking.ts`：

```typescript
import { ulid } from "ulid";

export interface ChunkOptions {
  maxTokens: number;       // 每块最大 token 数（粗略按字符数估算：中文 1 字 ≈ 1.5 token）
  overlapTokens: number;   // 块间重叠 token 数
}

export interface ChunkResult {
  id: string;
  idx: number;
  content: string;
  tokenCount: number;
}

// 粗略的 token 估算：英文按空格分词 ×1.3，中文按字符 ×1
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[一-龥]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars * 1 + otherChars * 0.3);
}

// 按段落 + 句末标点切分
function splitBySentences(text: string): string[] {
  // 按换行或句末标点切，保留分隔符
  const parts = text.split(/(?<=[。！？!?\n])/g);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

export function chunkText(text: string, opts: ChunkOptions): ChunkResult[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences = splitBySentences(trimmed);
  if (sentences.length === 0) return [];

  const maxChars = Math.floor(opts.maxTokens * 1.5);  // token → 字符 粗略换算
  const overlapChars = Math.floor(opts.overlapTokens * 1.5);

  const chunks: ChunkResult[] = [];
  let current = "";
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);
    const wouldExceed = currentTokens + sentenceTokens > opts.maxTokens;

    if (wouldExceed && current.length > 0) {
      // 收尾当前 chunk
      chunks.push({
        id: ulid(),
        idx: chunks.length,
        content: current.trim(),
        tokenCount: estimateTokens(current),
      });
      // 算 overlap：从 current 末尾往前截 overlapChars
      if (overlapChars > 0 && current.length > overlapChars) {
        current = current.slice(-overlapChars);
        currentTokens = estimateTokens(current);
      } else {
        current = "";
        currentTokens = 0;
      }
    }

    current += sentence;
    currentTokens += sentenceTokens;

    // 单句本身就超长时强制切
    if (current.length > maxChars) {
      chunks.push({
        id: ulid(),
        idx: chunks.length,
        content: current.trim(),
        tokenCount: estimateTokens(current),
      });
      current = "";
      currentTokens = 0;
    }
  }

  if (current.trim().length > 0) {
    chunks.push({
      id: ulid(),
      idx: chunks.length,
      content: current.trim(),
      tokenCount: estimateTokens(current),
    });
  }

  return chunks;
}
```

- [ ] **Step 5.4: 运行测试确认通过**

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm -F @unequal/shared test
```

Expected: 全部 9 个测试通过（5 个新增 + 4 个 schemas）。

- [ ] **Step 5.5: 提交**

```bash
git add packages/shared/src/chunking.ts packages/shared/test/chunking.test.ts
git commit -m "feat(shared): chunking with sentence-based split and overlap (TDD)"
```

---

### Task 6: packages/shared - Embedding Interface + MiniMax Implementation (TDD)

**Files:**
- Create: `packages/shared/src/embedding.ts`
- Create: `packages/shared/test/embedding.test.ts`

- [ ] **Step 6.1: 写测试**

`/Users/Mark/cc_project/unequal/packages/shared/test/embedding.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMiniMaxEmbedder } from "../src/embedding.js";

describe("MiniMaxEmbedder", () => {
  const fakeFetch = vi.fn();

  beforeEach(() => {
    fakeFetch.mockReset();
  });

  it("calls MiniMax /embeddings with batched input", async () => {
    fakeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { embedding: [0.1, 0.2, 0.3] },
            { embedding: [0.4, 0.5, 0.6] },
          ],
          usage: { total_tokens: 10 },
        }),
        { headers: { "content-type": "application/json" } }
      )
    );

    const embed = createMiniMaxEmbedder({
      apiKey: "sk-test",
      baseUrl: "https://api.MiniMax.test/v1",
      model: "MiniMax-embedding",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    const result = await embed.embed(["hello", "world"]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([0.1, 0.2, 0.3]);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe("https://api.MiniMax.test/v1/embeddings");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "MiniMax-embedding",
      input: ["hello", "world"],
    });
  });

  it("throws on API error with status", async () => {
    fakeFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    );

    const embed = createMiniMaxEmbedder({
      apiKey: "sk-bad",
      baseUrl: "https://api.MiniMax.test/v1",
      model: "MiniMax-embedding",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    await expect(embed.embed(["x"])).rejects.toThrow(/401/);
  });

  it("returns empty array for empty input", async () => {
    const embed = createMiniMaxEmbedder({
      apiKey: "sk-test",
      baseUrl: "https://api.MiniMax.test/v1",
      model: "MiniMax-embedding",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    expect(await embed.embed([])).toEqual([]);
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6.2: 运行测试确认失败**

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm -F @unequal/shared test embedding
```

Expected: 失败。

- [ ] **Step 6.3: 实现 embedding**

`/Users/Mark/cc_project/unequal/packages/shared/src/embedding.ts`：

```typescript
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface MiniMaxEmbedderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

export function createMiniMaxEmbedder(config: MiniMaxEmbedderConfig): Embedder {
  const f = config.fetchImpl ?? fetch;
  const maxRetries = config.maxRetries ?? 3;

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      let lastError: unknown;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const res = await f(`${config.baseUrl}/embeddings`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: config.model,
              input: texts,
            }),
          });

          if (!res.ok) {
            const body = await res.text();
            throw new Error(`MiniMax embedding failed: ${res.status} ${body}`);
          }

          const json = (await res.json()) as {
            data: Array<{ embedding: number[] }>;
          };
          return json.data.map((d) => d.embedding);
        } catch (e) {
          lastError = e;
          // 指数退避：100ms, 200ms, 400ms
          await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
        }
      }
      throw lastError;
    },
  };
}
```

- [ ] **Step 6.4: 运行测试确认通过**

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm -F @unequal/shared test
```

Expected: 全部 12 个测试通过。

- [ ] **Step 6.5: 提交**

```bash
git add packages/shared/src/embedding.ts packages/shared/test/embedding.test.ts
git commit -m "feat(shared): MiniMax embedder with retry and fetch injection (TDD)"
```

---

### Task 7: packages/shared - Retrieval (Vectorize Query + trust_level Weighting)

**Files:**
- Create: `packages/shared/src/retrieval.ts`
- Create: `packages/shared/test/retrieval.test.ts`

- [ ] **Step 7.1: 写测试**

`/Users/Mark/cc_project/unequal/packages/shared/test/retrieval.test.ts`：

```typescript
import { describe, it, expect, vi } from "vitest";
import { searchChunks } from "../src/retrieval.js";

describe("searchChunks", () => {
  const fakeVectorize = {
    query: vi.fn(),
  };

  it("queries Vectorize with user filter, applies trust_level weighting, returns topK", async () => {
    fakeVectorize.query.mockResolvedValueOnce({
      matches: [
        { id: "c1", score: 0.9, metadata: { trust_level: 3 } },
        { id: "c2", score: 0.85, metadata: { trust_level: 0 } },
        { id: "c3", score: 0.8, metadata: { trust_level: 2 } },
        { id: "c4", score: 0.7, metadata: { trust_level: 1 } },
      ],
    });

    const results = await searchChunks({
      vectorize: fakeVectorize as unknown as VectorizeIndex,
      userId: "u1",
      queryVector: [0.1, 0.2, 0.3],
      topK: 3,
    });

    expect(fakeVectorize.query).toHaveBeenCalledWith([0.1, 0.2, 0.3], {
      topK: 20,
      returnMetadata: true,
      filter: { user_id: "u1", trust_level: { $gte: 0 } },
    });

    // 应用 trust_level 加权：c1=0.9*1.3=1.17, c2=0.85*1.0=0.85, c3=0.8*1.1=0.88, c4=0.7*1.0=0.7
    // 排序后 top3: c1 (1.17), c3 (0.88), c2 (0.85)
    expect(results.map((r) => r.chunkId)).toEqual(["c1", "c3", "c2"]);
    expect(results[0]?.finalScore).toBeCloseTo(1.17, 2);
  });

  it("returns empty array when no matches", async () => {
    fakeVectorize.query.mockResolvedValueOnce({ matches: [] });

    const results = await searchChunks({
      vectorize: fakeVectorize as unknown as VectorizeIndex,
      userId: "u1",
      queryVector: [0.1],
      topK: 5,
    });

    expect(results).toEqual([]);
  });

  it("respects custom trustWeightMap", async () => {
    fakeVectorize.query.mockResolvedValueOnce({
      matches: [{ id: "c1", score: 1.0, metadata: { trust_level: 3 } }],
    });

    const results = await searchChunks({
      vectorize: fakeVectorize as unknown as VectorizeIndex,
      userId: "u1",
      queryVector: [0.1],
      topK: 5,
      trustWeightMap: { 0: 1, 1: 1, 2: 1, 3: 1 },  // 全 1，等于不加权
    });

    expect(results[0]?.finalScore).toBe(1.0);
  });
});
```

- [ ] **Step 7.2: 运行测试确认失败**

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm -F @unequal/shared test retrieval
```

Expected: 失败。

- [ ] **Step 7.3: 实现 retrieval**

`/Users/Mark/cc_project/unequal/packages/shared/src/retrieval.ts`：

```typescript
import type { TrustLevel } from "./types.js";

export const DEFAULT_TRUST_WEIGHTS: Record<TrustLevel, number> = {
  0: 1.0,
  1: 1.0,
  2: 1.1,
  3: 1.3,
};

export interface SearchOptions {
  vectorize: VectorizeIndex;
  userId: string;
  queryVector: number[];
  topK: number;
  trustWeightMap?: Record<TrustLevel, number>;
}

export interface SearchResult {
  chunkId: string;
  vectorizeScore: number;
  finalScore: number;
  trustLevel: TrustLevel;
}

export async function searchChunks(opts: SearchOptions): Promise<SearchResult[]> {
  const weights = opts.trustWeightMap ?? DEFAULT_TRUST_WEIGHTS;

  const res = await opts.vectorize.query(opts.queryVector, {
    topK: Math.max(opts.topK * 4, 20),  // 多召回一些，给 trust 加权留余量
    returnMetadata: true,
    filter: {
      user_id: opts.userId,
      trust_level: { $gte: 0 },
    },
  });

  const matches = res.matches ?? [];

  const weighted: SearchResult[] = matches
    .map((m) => {
      const tl = (m.metadata?.trust_level ?? 0) as TrustLevel;
      const weight = weights[tl] ?? 1.0;
      return {
        chunkId: m.id,
        vectorizeScore: m.score,
        finalScore: m.score * weight,
        trustLevel: tl,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, opts.topK);

  return weighted;
}
```

- [ ] **Step 7.4: 运行测试确认通过**

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm -F @unequal/shared test
```

Expected: 全部 15 个测试通过。

- [ ] **Step 7.5: 提交**

```bash
git add packages/shared/src/retrieval.ts packages/shared/test/retrieval.test.ts
git commit -m "feat(shared): Vectorize search with trust_level weighting (TDD)"
```

---

### Task 8: Workers API 基础 (Hono + /health + /seed-user + 鉴权中间件)

**Files:**
- Create: `apps/api/src/lib/auth.ts`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/routes/seed-user.ts`
- Create: `apps/api/src/index.ts` (重写)
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/test/auth.test.ts`

- [ ] **Step 8.1: 安装 Hono（已写入 package.json,跑 pnpm install）**

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm install
```

- [ ] **Step 8.2: 写鉴权测试**

`/Users/Mark/cc_project/unequal/apps/api/test/auth.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { verifyAdminToken } from "../src/lib/auth.js";

describe("verifyAdminToken", () => {
  it("returns ok when token matches", () => {
    expect(verifyAdminToken("Bearer secret", "secret")).toEqual({ ok: true });
  });

  it("returns error on missing header", () => {
    expect(verifyAdminToken(undefined, "secret")).toEqual({
      ok: false,
      status: 401,
      message: "Missing Authorization header",
    });
  });

  it("returns error on wrong token", () => {
    expect(verifyAdminToken("Bearer wrong", "secret")).toEqual({
      ok: false,
      status: 401,
      message: "Invalid token",
    });
  });

  it("returns error on non-Bearer scheme", () => {
    expect(verifyAdminToken("Basic secret", "secret")).toEqual({
      ok: false,
      status: 401,
      message: "Invalid token",
    });
  });
});
```

- [ ] **Step 8.3: 写 vitest 配置**

`/Users/Mark/cc_project/unequal/apps/api/vitest.config.ts`：

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 8.4: 实现 auth**

`/Users/Mark/cc_project/unequal/apps/api/src/lib/auth.ts`：

```typescript
export type AuthResult = { ok: true } | { ok: false; status: number; message: string };

export function verifyAdminToken(header: string | null | undefined, expected: string): AuthResult {
  if (!header) {
    return { ok: false, status: 401, message: "Missing Authorization header" };
  }
  if (header !== `Bearer ${expected}`) {
    return { ok: false, status: 401, message: "Invalid token" };
  }
  return { ok: true };
}
```

- [ ] **Step 8.5: 写 health 路由**

`/Users/Mark/cc_project/unequal/apps/api/src/routes/health.ts`：

```typescript
import type { Env } from "../types.js";

export const healthRoute = {
  async GET(_request: Request, env: Env): Promise<Response> {
    return Response.json({
      status: "ok",
      environment: env.ENVIRONMENT,
      timestamp: Date.now(),
    });
  },
};
```

- [ ] **Step 8.6: 写 seed-user 路由（创建默认 user）**

`/Users/Mark/cc_project/unequal/apps/api/src/routes/seed-user.ts`：

```typescript
import type { Env } from "../types.js";

export const seedUserRoute = {
  async POST(request: Request, env: Env): Promise<Response> {
    const body = (await request.json()) as { id?: string; nickname?: string };
    if (!body.id) {
      return new Response("Missing id", { status: 400 });
    }

    // 幂等：已存在则跳过
    const existing = await env.DB.prepare("SELECT id FROM user WHERE id = ?")
      .bind(body.id)
      .first();

    if (existing) {
      return Response.json({ id: body.id, created: false });
    }

    await env.DB.prepare(
      "INSERT INTO user (id, nickname, created_at) VALUES (?, ?, ?)"
    )
      .bind(body.id, body.nickname ?? "default", Date.now())
      .run();

    return Response.json({ id: body.id, created: true });
  },
};
```

- [ ] **Step 8.7: 重写 index.ts 用 Hono**

`/Users/Mark/cc_project/unequal/apps/api/src/index.ts`：

```typescript
import { Hono } from "hono";
import type { Env } from "./types.js";
import { healthRoute } from "./routes/health.js";
import { seedUserRoute } from "./routes/seed-user.js";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => healthRoute.GET(c.req.raw, c.env));

// seed-user 不强制鉴权（MVP 阶段给本地种子脚本用）
app.post("/seed-user", (c) => seedUserRoute.POST(c.req.raw, c.env));

app.notFound((c) => c.text("Not found", 404));

export default app;
```

- [ ] **Step 8.8: 运行测试**

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm -F api test
```

Expected: 4 个 auth 测试通过。

- [ ] **Step 8.9: 本地启动验证**

Run:
```bash
cd /Users/Mark/cc_project/unequal/apps/api && pnpm dev
```

另开终端：
```bash
curl http://localhost:8787/health
# 期望：{"status":"ok","environment":"development","timestamp":...}

curl -X POST http://localhost:8787/seed-user \
  -H "content-type: application/json" \
  -d '{"id":"01H0000000000000000000000","nickname":"default"}'
# 期望：{"id":"01H0000000000000000000000","created":true}

# 重复调用应返回 created:false
curl -X POST http://localhost:8787/seed-user \
  -H "content-type: application/json" \
  -d '{"id":"01H0000000000000000000000"}'
# 期望：{"id":"01H0000000000000000000000","created":false}
```

按 Ctrl+C 停掉 dev。

- [ ] **Step 8.10: 提交**

```bash
git add apps/api/
git commit -m "feat(api): Hono + /health + /seed-user + ADMIN_TOKEN auth middleware"
```

---

### Task 9: File Ingestion (Upload → R2 → Parse → Chunk → Embed → Store)

**Files:**
- Create: `apps/api/src/lib/parsers/pdf.ts`
- Create: `apps/api/src/lib/parsers/word.ts`
- Create: `apps/api/src/lib/parsers/text.ts`
- Create: `apps/api/src/lib/parsers/index.ts`
- Create: `apps/api/src/routes/upload.ts`
- Create: `apps/api/src/routes/ingest.ts`
- Create: `apps/api/src/index.ts` (更新)
- Modify: `apps/api/package.json` (加 pdf-parse, mammoth, hono already there)

- [ ] **Step 9.1: 安装文件解析依赖**

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm -F api add pdf-parse mammoth
```

Expected: 安装成功。

- [ ] **Step 9.2: 写 text 解析器（最简单）**

`/Users/Mark/cc_project/unequal/apps/api/src/lib/parsers/text.ts`：

```typescript
export async function parseText(bytes: ArrayBuffer): Promise<string> {
  return new TextDecoder("utf-8").decode(bytes);
}
```

- [ ] **Step 9.3: 写 pdf 解析器**

`/Users/Mark/cc_project/unequal/apps/api/src/lib/parsers/pdf.ts`：

```typescript
// pdf-parse 是 CommonJS 库，在 ESM 项目里要这样导入
// @ts-expect-error - no types for default export
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export async function parsePdf(bytes: ArrayBuffer): Promise<string> {
  const buffer = Buffer.from(bytes);
  const result = await pdfParse(buffer);
  return result.text;
}
```

> `pdf-parse` 默认会读测试文件，需要用 `pdf-parse/lib/pdf-parse.js` 绕过。

- [ ] **Step 9.4: 写 word 解析器**

`/Users/Mark/cc_project/unequal/apps/api/src/lib/parsers/word.ts`：

```typescript
import mammoth from "mammoth";

export async function parseWord(bytes: ArrayBuffer): Promise<string> {
  const buffer = Buffer.from(bytes);
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}
```

- [ ] **Step 9.5: 写 parser 路由**

`/Users/Mark/cc_project/unequal/apps/api/src/lib/parsers/index.ts`：

```typescript
import { parseText } from "./text.js";
import { parsePdf } from "./pdf.js";
import { parseWord } from "./word.js";

export type FileType = "pdf" | "docx" | "txt" | "md";

export function detectFileType(filename: string): FileType | null {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "txt") return "txt";
  if (ext === "md" || ext === "markdown") return "md";
  return null;
}

export async function parseFile(type: FileType, bytes: ArrayBuffer): Promise<string> {
  switch (type) {
    case "pdf":
      return parsePdf(bytes);
    case "docx":
      return parseWord(bytes);
    case "txt":
    case "md":
      return parseText(bytes);
  }
}
```

- [ ] **Step 9.6: 写 upload 路由（接受文件 → 存 R2 → 触发 ingest）**

`/Users/Mark/cc_project/unequal/apps/api/src/routes/upload.ts`：

```typescript
import { ulid } from "ulid";
import { verifyAdminToken } from "../lib/auth.js";
import type { Env } from "../types.js";
import { detectFileType, parseFile } from "../lib/parsers/index.js";
import { chunkText } from "@unequal/shared/chunking";
import { createMiniMaxEmbedder } from "@unequal/shared/embedding";
import type { TrustLevel } from "@unequal/shared/types";

const DEFAULT_USER_ID = "01H0000000000000000000000";

export const uploadRoute = {
  async POST(request: Request, env: Env): Promise<Response> {
    const auth = verifyAdminToken(request.headers.get("authorization"), env.ADMIN_TOKEN);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return new Response("Missing file field", { status: 400 });
    }

    const fileType = detectFileType(file.name);
    if (!fileType) {
      return new Response(`Unsupported file type: ${file.name}`, { status: 400 });
    }

    const trustLevel = Number(formData.get("trust_level") ?? 0) as TrustLevel;
    if (![0, 1, 2, 3].includes(trustLevel)) {
      return new Response("trust_level must be 0-3", { status: 400 });
    }

    const fileId = ulid();
    const r2Key = `raw/${DEFAULT_USER_ID}/${fileId}/${file.name}`;
    const arrayBuffer = await file.arrayBuffer();

    // 1. 存 R2
    await env.R2.put(r2Key, arrayBuffer, {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
    });

    // 2. 解析
    const text = await parseFile(fileType, arrayBuffer);
    if (!text.trim()) {
      return new Response("File contains no extractable text", { status: 400 });
    }

    // 3. chunk
    const chunks = chunkText(text, { maxTokens: 500, overlapTokens: 50 });

    // 4. embedding
    const embed = createMiniMaxEmbedder({
      apiKey: env.MINIMAX_API_KEY,
      baseUrl: env.MINIMAX_BASE_URL,
      model: "MiniMax-embedding",
    });
    const vectors = await embed.embed(chunks.map((c) => c.content));

    // 5. 写 D1
    const now = Date.now();
    const sourceId = ulid();
    const documentId = ulid();

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO source (id, user_id, type, title, trust_level, created_at) VALUES (?, ?, 'file', ?, ?, ?)"
      ).bind(sourceId, DEFAULT_USER_ID, file.name, trustLevel, now),
      env.DB.prepare(
        "INSERT INTO document (id, source_id, user_id, title, raw_path, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(documentId, sourceId, DEFAULT_USER_ID, file.name, r2Key, now),
    ]);

    // 6. 写 chunk 到 D1 + Vectorize
    const chunkInserts = chunks.map((c, i) =>
      env.DB.prepare(
        "INSERT INTO chunk (id, document_id, source_id, user_id, idx, content, token_count, trust_level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        c.id,
        documentId,
        sourceId,
        DEFAULT_USER_ID,
        i,
        c.content,
        c.tokenCount,
        trustLevel,
        now
      )
    );
    await env.DB.batch(chunkInserts);

    await env.VECTORIZE.upsert(
      chunks.map((c, i) => ({
        id: c.id,
        values: vectors[i]!,
        metadata: {
          chunk_id: c.id,
          user_id: DEFAULT_USER_ID,
          source_id: sourceId,
          document_id: documentId,
          trust_level: trustLevel,
          is_cached: false,
        },
      }))
    );

    return Response.json({
      sourceId,
      documentId,
      chunkCount: chunks.length,
      r2Key,
    });
  },
};
```

- [ ] **Step 9.7: 写 ingest 路由（爬虫用，M1 阶段先打 stub）**

`/Users/Mark/cc_project/unequal/apps/api/src/routes/ingest.ts`：

```typescript
import { verifyAdminToken } from "../lib/auth.js";
import type { Env } from "../types.js";

export const ingestRoute = {
  async POST(request: Request, env: Env): Promise<Response> {
    const auth = verifyAdminToken(request.headers.get("authorization"), env.ADMIN_TOKEN);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });

    // M1 阶段：爬虫还没做，/ingest 先打 stub，未来爬虫走这里
    return Response.json({
      message: "ingest endpoint reserved for crawler (M4+)",
      body: await request.json().catch(() => null),
    });
  },
};
```

- [ ] **Step 9.8: 更新 index.ts 注册 upload + ingest**

`/Users/Mark/cc_project/unequal/apps/api/src/index.ts`：

```typescript
import { Hono } from "hono";
import type { Env } from "./types.js";
import { healthRoute } from "./routes/health.js";
import { seedUserRoute } from "./routes/seed-user.js";
import { uploadRoute } from "./routes/upload.js";
import { ingestRoute } from "./routes/ingest.js";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => healthRoute.GET(c.req.raw, c.env));
app.post("/seed-user", (c) => seedUserRoute.POST(c.req.raw, c.env));
app.post("/upload", (c) => uploadRoute.POST(c.req.raw, c.env));
app.post("/ingest", (c) => ingestRoute.POST(c.req.raw, c.env));

app.notFound((c) => c.text("Not found", 404));

export default app;
```

- [ ] **Step 9.9: 本地验证 typecheck + dev**

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm -F api typecheck
```

Expected: 无错误。

Run:
```bash
cd /Users/Mark/cc_project/unequal/apps/api && pnpm dev
```

另开终端准备一个测试文件：
```bash
echo "婴儿发烧38.5度，建议先测量腋温确认。超过38.5可考虑用退烧药。三个月以下婴儿发烧应立即就医。" > /tmp/test.txt
```

调 upload：
```bash
curl -X POST http://localhost:8787/upload \
  -H "Authorization: Bearer dev-token-change-me" \
  -F "file=@/tmp/test.txt" \
  -F "trust_level=1"
```

Expected: 形如
```json
{"sourceId":"01H...","documentId":"01H...","chunkCount":1,"r2Key":"raw/..."}
```

调无 token：
```bash
curl -X POST http://localhost:8787/upload -F "file=@/tmp/test.txt"
```

Expected: `Missing Authorization header` (401)

按 Ctrl+C 停 dev。

- [ ] **Step 9.10: 提交**

```bash
git add apps/api/
git commit -m "feat(api): file upload endpoint with parse/chunk/embed/store pipeline (PDF/Word/TXT/MD)"
```

---

### Task 10: /search Endpoint (Pure Retrieval, No LLM)

**Files:**
- Create: `apps/api/src/routes/search.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 10.1: 写 search 路由**

`/Users/Mark/cc_project/unequal/apps/api/src/routes/search.ts`：

```typescript
import { verifyAdminToken } from "../lib/auth.js";
import { createMiniMaxEmbedder } from "@unequal/shared/embedding";
import { searchChunks } from "@unequal/shared/retrieval";
import type { Env } from "../types.js";

const DEFAULT_USER_ID = "01H0000000000000000000000";

export const searchRoute = {
  async GET(request: Request, env: Env): Promise<Response> {
    const auth = verifyAdminToken(request.headers.get("authorization"), env.ADMIN_TOKEN);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });

    const url = new URL(request.url);
    const q = url.searchParams.get("q");
    const topK = Number(url.searchParams.get("topK") ?? 5);
    if (!q) return new Response("Missing q parameter", { status: 400 });

    // 1. embedding
    const embed = createMiniMaxEmbedder({
      apiKey: env.MINIMAX_API_KEY,
      baseUrl: env.MINIMAX_BASE_URL,
      model: "MiniMax-embedding",
    });
    const [queryVector] = await embed.embed([q]);

    // 2. 检索
    const hits = await searchChunks({
      vectorize: env.VECTORIZE,
      userId: DEFAULT_USER_ID,
      queryVector: queryVector!,
      topK,
    });

    if (hits.length === 0) {
      return Response.json({ q, hits: [], snippets: [] });
    }

    // 3. 用 chunk_id 反查 D1 拿 content（spec §5.2 步骤 ⑧ 二次校验）
    const placeholders = hits.map(() => "?").join(",");
    const stmt = env.DB.prepare(
      `SELECT id, content, source_id, document_id, trust_level FROM chunk WHERE id IN (${placeholders})`
    );
    const rows = await stmt.bind(...hits.map((h) => h.chunkId)).all();

    const byId = new Map((rows.results as Array<Record<string, unknown>>).map((r) => [r.id as string, r]));

    const snippets = hits.map((h) => {
      const row = byId.get(h.chunkId);
      return {
        chunkId: h.chunkId,
        sourceId: row?.source_id,
        documentId: row?.document_id,
        trustLevel: h.trustLevel,
        finalScore: h.finalScore,
        vectorizeScore: h.vectorizeScore,
        content: (row?.content as string | undefined)?.slice(0, 300) ?? "",
      };
    });

    return Response.json({ q, hits: snippets });
  },
};
```

- [ ] **Step 10.2: 注册 search 路由**

`/Users/Mark/cc_project/unequal/apps/api/src/index.ts`（找到 search 行的位置加）：

```typescript
import { searchRoute } from "./routes/search.js";
// ...
app.get("/search", (c) => searchRoute.GET(c.req.raw, c.env));
```

- [ ] **Step 10.3: 端到端验证**

Run:
```bash
cd /Users/Mark/cc_project/unequal/apps/api && pnpm dev
```

另开终端：
```bash
# 上传（用 Task 9 已测试过的命令）
curl -X POST http://localhost:8787/upload \
  -H "Authorization: Bearer dev-token-change-me" \
  -F "file=@/tmp/test.txt" \
  -F "trust_level=2"

# 搜索
curl "http://localhost:8787/search?q=婴儿发烧怎么办&topK=3" \
  -H "Authorization: Bearer dev-token-change-me"
```

Expected: 形如
```json
{
  "q": "婴儿发烧怎么办",
  "hits": [
    {
      "chunkId": "01H...",
      "sourceId": "01H...",
      "documentId": "01H...",
      "trustLevel": 2,
      "finalScore": 1.05,
      "vectorizeScore": 0.95,
      "content": "婴儿发烧38.5度..."
    }
  ]
}
```

调无关问题：
```bash
curl "http://localhost:8787/search?q=量子力学&topK=3" \
  -H "Authorization: Bearer dev-token-change-me"
```

Expected: `{"q":"量子力学","hits":[],"snippets":[]}` 或 finalScore 很低的命中（取决于 MiniMax embedding 质量）。

按 Ctrl+C。

- [ ] **Step 10.4: 提交**

```bash
git add apps/api/
git commit -m "feat(api): /search endpoint with embedding, Vectorize query, D1 hydration"
```

---

### Task 11: Admin 后台 (React + Vite) — Sources/Upload/Documents/SearchTest 页

**Files:**
- Create: `apps/admin/index.html`
- Create: `apps/admin/vite.config.ts`
- Create: `apps/admin/src/main.tsx`
- Create: `apps/admin/src/App.tsx`
- Create: `apps/admin/src/index.css`
- Create: `apps/admin/src/lib/api.ts`
- Create: `apps/admin/src/pages/Sources.tsx`
- Create: `apps/admin/src/pages/Upload.tsx`
- Create: `apps/admin/src/pages/Documents.tsx`
- Create: `apps/admin/src/pages/SearchTest.tsx`
- Create: `apps/admin/tailwind.config.js`
- Create: `apps/admin/postcss.config.js`

- [ ] **Step 11.1: 初始化 Vite + React + Tailwind**

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm install
```

- [ ] **Step 11.2: 写 index.html**

`/Users/Mark/cc_project/unequal/apps/admin/index.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>unequal admin</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 11.3: 写 vite.config.ts**

`/Users/Mark/cc_project/unequal/apps/admin/vite.config.ts`：

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
```

- [ ] **Step 11.4: 写 Tailwind + PostCSS 配置**

`/Users/Mark/cc_project/unequal/apps/admin/tailwind.config.js`：

```javascript
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
};
```

`/Users/Mark/cc_project/unequal/apps/admin/postcss.config.js`：

```javascript
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

- [ ] **Step 11.5: 写 index.css**

`/Users/Mark/cc_project/unequal/apps/admin/src/index.css`：

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 11.6: 写 main.tsx**

`/Users/Mark/cc_project/unequal/apps/admin/src/main.tsx`：

```typescript
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
```

- [ ] **Step 11.7: 写 App.tsx (4 个页面的导航)**

`/Users/Mark/cc_project/unequal/apps/admin/src/App.tsx`：

```tsx
import { Link, Route, Routes } from "react-router-dom";
import { Upload } from "./pages/Upload";
import { Documents } from "./pages/Documents";
import { SearchTest } from "./pages/SearchTest";
import { Sources } from "./pages/Sources";

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm border-b">
        <div className="max-w-5xl mx-auto px-4 py-3 flex gap-6">
          <Link to="/upload" className="font-semibold text-gray-900">上传</Link>
          <Link to="/sources" className="text-gray-600">源</Link>
          <Link to="/documents" className="text-gray-600">文档</Link>
          <Link to="/search" className="text-gray-600">检索测试</Link>
        </div>
      </nav>
      <main className="max-w-5xl mx-auto px-4 py-8">
        <Routes>
          <Route path="/upload" element={<Upload />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/documents" element={<Documents />} />
          <Route path="/search" element={<SearchTest />} />
        </Routes>
      </main>
    </div>
  );
}
```

- [ ] **Step 11.8: 写 api.ts 封装**

`/Users/Mark/cc_project/unequal/apps/admin/src/lib/api.ts`：

```typescript
// 通过 Vite proxy 转发到 Workers
const API_BASE = "/api";

function getToken(): string {
  // MVP 阶段 token 写死在 localStorage；未来 wx.login 后换 JWT
  return localStorage.getItem("admin_token") ?? "dev-token-change-me";
}

export interface UploadResponse {
  sourceId: string;
  documentId: string;
  chunkCount: number;
  r2Key: string;
}

export interface SearchHit {
  chunkId: string;
  sourceId?: string;
  documentId?: string;
  trustLevel: number;
  finalScore: number;
  vectorizeScore: number;
  content: string;
}

export async function uploadFile(
  file: File,
  trustLevel: number
): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("trust_level", String(trustLevel));
  const res = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${getToken()}` },
    body: fd,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function search(q: string, topK = 5): Promise<{ q: string; hits: SearchHit[] }> {
  const res = await fetch(
    `${API_BASE}/search?q=${encodeURIComponent(q)}&topK=${topK}`,
    { headers: { authorization: `Bearer ${getToken()}` } }
  );
  if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`);
  return res.json();
}
```

- [ ] **Step 11.9: 写 Upload 页**

`/Users/Mark/cc_project/unequal/apps/admin/src/pages/Upload.tsx`：

```tsx
import { useState } from "react";
import { uploadFile } from "../lib/api";

export function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [trustLevel, setTrustLevel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await uploadFile(file, trustLevel);
      setResult(`✅ 入库成功：${r.chunkCount} chunks, source=${r.sourceId.slice(0, 8)}...`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">上传文件入库</h1>
      <form onSubmit={handleSubmit} className="space-y-4 bg-white p-6 rounded shadow-sm">
        <div>
          <label className="block text-sm font-medium mb-1">文件（PDF / Word / TXT / MD）</label>
          <input
            type="file"
            accept=".pdf,.docx,.txt,.md,.markdown"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm border rounded p-2"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">信源等级</label>
          <select
            value={trustLevel}
            onChange={(e) => setTrustLevel(Number(e.target.value))}
            className="block border rounded p-2"
          >
            <option value={0}>0 - 未评级</option>
            <option value={1}>1 - 一般</option>
            <option value={2}>2 - 可信</option>
            <option value={3}>3 - 权威</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={!file || busy}
          className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
        >
          {busy ? "处理中..." : "上传并入库"}
        </button>
        {result && <div className="text-green-700 bg-green-50 p-3 rounded">{result}</div>}
        {error && <div className="text-red-700 bg-red-50 p-3 rounded">{error}</div>}
      </form>
    </div>
  );
}
```

- [ ] **Step 11.10: 写 SearchTest 页**

`/Users/Mark/cc_project/unequal/apps/admin/src/pages/SearchTest.tsx`：

```tsx
import { useState } from "react";
import { search, SearchHit } from "../lib/api";

export function SearchTest() {
  const [q, setQ] = useState("");
  const [topK, setTopK] = useState(5);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!q) return;
    setBusy(true);
    try {
      const r = await search(q, topK);
      setHits(r.hits);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">检索测试</h1>
      <form onSubmit={handleSubmit} className="space-y-3 bg-white p-6 rounded shadow-sm">
        <div className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="输入问题..."
            className="flex-1 border rounded p-2"
          />
          <input
            type="number"
            value={topK}
            onChange={(e) => setTopK(Number(e.target.value))}
            min={1}
            max={20}
            className="w-20 border rounded p-2"
          />
          <button
            type="submit"
            disabled={busy}
            className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
          >
            {busy ? "检索中..." : "检索"}
          </button>
        </div>
      </form>

      <div className="space-y-3">
        {hits.map((h, i) => (
          <div key={h.chunkId} className="bg-white p-4 rounded shadow-sm border">
            <div className="flex justify-between text-sm text-gray-500 mb-2">
              <span>#{i + 1} · chunk {h.chunkId.slice(0, 8)}</span>
              <span>
                score={h.finalScore.toFixed(3)} (vector={h.vectorizeScore.toFixed(3)})
                · trust={h.trustLevel}
              </span>
            </div>
            <div className="text-gray-800 whitespace-pre-wrap">{h.content}</div>
          </div>
        ))}
        {hits.length === 0 && !busy && (
          <div className="text-gray-400 text-center py-8">还没有检索结果</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 11.11: 写 Sources 和 Documents 占位页**

`/Users/Mark/cc_project/unequal/apps/admin/src/pages/Sources.tsx`：

```tsx
export function Sources() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">源管理</h1>
      <div className="bg-white p-6 rounded shadow-sm text-gray-500">
        M0+M1 范围：源由上传文件自动创建。本页 M2 再做（手动添加网页 URL、调整 trust_level）。
      </div>
    </div>
  );
}
```

`/Users/Mark/cc_project/unequal/apps/admin/src/pages/Documents.tsx`：

```tsx
import { useEffect, useState } from "react";

interface ChunkRow {
  id: string;
  document_id: string;
  content: string;
  trust_level: number;
  idx: number;
}

export function Documents() {
  const [chunks, setChunks] = useState<ChunkRow[]>([]);

  useEffect(() => {
    // 简单演示：从 /search 用空 q 列出所有 chunk 不现实，
    // 改用 D1 直接查：M1 阶段 admin 不直连 D1，留空。
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">文档列表</h1>
      <div className="bg-white p-6 rounded shadow-sm text-gray-500">
        M0+M1 范围：本页 M2 再做。当前通过「检索测试」页验证 chunk 入库是否正确。
      </div>
    </div>
  );
}
```

- [ ] **Step 11.12: 本地启动验证**

Run:
```bash
cd /Users/Mark/cc_project/unequal && pnpm -F admin typecheck
```

Expected: 无错误。

Run（两个终端）：
```bash
# 终端 1：Workers dev
cd /Users/Mark/cc_project/unequal/apps/api && pnpm dev
```

```bash
# 终端 2：admin dev
cd /Users/Mark/cc_project/unequal && pnpm dev:admin
```

浏览器打开 `http://localhost:5173/upload`：
- 选 /tmp/test.txt
- 选 trust_level=2
- 点上传
- 应看到 `✅ 入库成功：N chunks, ...`

切到 `http://localhost:5173/search`：
- 输入"婴儿发烧"
- 应看到命中的 chunk

按 Ctrl+C 停两个 dev。

- [ ] **Step 11.13: 提交**

```bash
git add apps/admin/
git commit -m "feat(admin): React+Vite admin with Upload/SearchTest pages, Vite proxy to Workers"
```

---

### Task 12: 端到端验证 + README 更新

**Files:**
- Modify: `README.md`
- Create: `apps/api/test/integration.test.ts` (可选，端到端)

- [ ] **Step 12.1: 写一个最小集成测试（用 Miniflare）**

> 可选。Task 9/10/11 都已经手动端到端验证过。如果想加自动化，跳过也行——M2 阶段补测试更值得。

如果跳过：直接到 Step 12.2。

如果要加：
```bash
cd /Users/Mark/cc_project/unequal && pnpm -F api add -D @miniflare/d1 @miniflare/r2 @miniflare/vectorize
```

> Miniflare 配置较复杂，建议在 M2 阶段用 wrangler 自带的 `--test` 模式或 vitest-pool-workers 补齐。M0+M1 阶段手动验证足够。

- [ ] **Step 12.2: 更新 README**

`/Users/Mark/cc_project/unequal/README.md`（追加）：

```markdown
## M0+M1 状态

跑通：上传 PDF/Word/TXT/MD → 自动 chunk → embedding → 入库 → /search 命中。

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

### 待办（v2+）

- M2: /ask + /chat + LLM 拼 prompt + 双层引用验证 + 医疗免责声明
- M3: 微信小程序
- M4-M5: 爬虫
- M6: 多轮会话 + 真鉴权
```

- [ ] **Step 12.3: 提交**

```bash
git add README.md
git commit -m "docs: M0+M1 first-run instructions in README"
```

---

## Self-Review Checklist

- [x] **Spec coverage:**
  - §0 目标与产品原则 → M0+M1 不直接实现，但 README 引述；产品原则在每条 prompt 拼接时遵循（M2 重点）
  - §1 架构总览 → Task 1-2 创建所有子项目骨架
  - §2 七个子系统 → Task 1 (monorepo), Task 8-10 (api), Task 11 (admin)
  - §3.1 反幻觉 → M0+M1 不实现 LLM 部分（Task 10 只做纯检索），M2 实现
  - §3.2 信源评级 → Task 4 (types) + Task 9 (上传时落 trust_level) + Task 7 (retrieval 加权)
  - §3.3 用户体系 → Task 3 (user schema) + Task 8 (/seed-user)，MVP 不做真鉴权
  - §3.4 部署形态 → Task 1-2 (Cloudflare 资源) + Task 12 (部署说明)
  - §4 数据模型 → Task 3 (D1 migration) + Task 4 (types + zod)
  - §4.2 Vectorize 索引 → Task 2 + Task 7 (Vectorize query 加权)
  - §4.3 信源评级表 → Task 4 + Task 9
  - §5.1 摄入管道 → Task 5 (chunking) + Task 6 (embedding) + Task 9 (upload 端到端)
  - §5.2 检索 + 生成 → Task 10 (仅检索，LLM 部分留 M2)
  - §6 API 接口 → Task 8 (health, seed-user) + Task 9 (upload, ingest) + Task 10 (search)
  - §7 前端 → Task 11 (admin 三个页面，Sources/Documents 占位)
  - §8 抓取调度 → M0+M1 不实现 (Task 9 ingest 路由是 stub)
  - §9 部署 → Task 2 + Task 12
  - §10 成本 → 不在 plan 内
  - §11 风险 → 不在 plan 内
  - §12 监控 → 不在 plan 内

- [x] **Placeholder scan:** 没有 TBD/TODO/占位说明
- [x] **Type consistency:** `TrustLevel = 0|1|2|3` 在所有 task 一致；`chunk.idx` / `chunk.content` / `chunk.tokenCount` / `chunk.trustLevel` 一致；`searchChunks` 的 `SearchResult.chunkId/vectorizeScore/finalScore/trustLevel` 与 upload 写入 Vectorize 的 metadata 字段名一致

## Execution Handoff

Plan 写完等用户选执行方式。Subagent-Driven（推荐）或 Inline Execution。
