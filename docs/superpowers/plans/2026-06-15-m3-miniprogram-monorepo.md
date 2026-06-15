# M3 Implementation Plan: 微信小程序端单轮问答 + admin ChatSim

> **For agentic workers:** REQUIRED SUB-KILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 微信小程序 + admin 内嵌 ChatSim 双形态落地，端到端接 `/ask` 真接口，单轮问答 + 引用卡片可视化。零真人操作（无小程序注册、无 AppID、无真机调试）。

**Architecture:**
- `apps/miniprogram/` 用微信原生开发（TypeScript + WXML/WXSS/JSON），lib 层（api/types/storage）TDD 严格
- `apps/admin/src/pages/ChatSim.tsx` 用 React 复用 M0+M1 + M2 admin 基础设施，先在 admin 模拟聊天 UI 验 /ask
- lib 层类型与 M2 `packages/shared/src/types.ts` Citation 对齐（不直接 import，镜像定义避免跨 runtime 依赖）
- Mock-first 全程，无 AppID / 无真机调试 / 无提审（推到 v2+ 真机联调阶段）

**Tech Stack:**
- 现有：Hono 4.5 + Vitest 2.0 + TypeScript 5.5 + React 18 + Vite 5
- 新增：微信原生（wxml/wxss/json/ts），无 npm runtime 依赖（仅 devDep：typescript + vitest）

---
**Spec:** `docs/superpowers/specs/2026-06-15-m3-miniprogram-design.md`（271 行，CP 划分、lib/types 对齐、真人 checklist）

---

## 0. 工作区设置

- 分支：`m3-miniprogram`（基于 `master` 当前 HEAD `783dd97`）
- Worktree 路径：`/Users/Mark/cc_project/unequal/.claude/worktrees/m3-miniprogram`
- 不进 master，所有 20 个 task 在 worktree 内完成
- 5 CP，CP 边界不强制 commit squash（每 task 一 commit）
- 结束用 `superpowers:finishing-a-development-branch` 决定 merge

**为什么用 worktree**：M3 涉及 25+ 新增文件 + 全栈 TDD（admin + miniprogram + lib 单测），与 master 隔离最稳。

---

## 1. 文件结构

### 1.1 apps/miniprogram 新增

```
apps/miniprogram/
├── app.ts                       # NEW — onLaunch + globalData
├── app.json                     # NEW — pages 注册 + tabBar
├── app.wxss                     # NEW — 全局样式
├── tsconfig.json                # NEW — extends ../../tsconfig.base.json
├── package.json                 # NEW — typecheck/test scripts
├── project.config.json          # NEW — 微信开发者工具配置（占位 AppID）
├── project.private.config.json  # NEW — 私有配置（gitignored）
├── sitemap.json                 # NEW — 索引配置（默认全部可索引）
├── .gitignore                   # NEW — miniprogram_npm + project.private.config.json
├── lib/
│   ├── api.ts                   # NEW — ask(q) fetch wrapper
│   ├── types.ts                 # NEW — Citation / AskResponse / HistoryEntry
│   └── storage.ts               # NEW — localStorage helper
├── components/
│   ├── citation-card/
│   │   ├── citation-card.ts     # NEW
│   │   ├── citation-card.wxml   # NEW
│   │   ├── citation-card.wxss   # NEW
│   │   └── citation-card.json   # NEW
│   └── message-bubble/
│       ├── message-bubble.ts    # NEW
│       ├── message-bubble.wxml  # NEW
│       ├── message-bubble.wxss  # NEW
│       └── message-bubble.json  # NEW
├── pages/
│   ├── chat/                    # NEW — chat.ts + chat.wxml + chat.wxss + chat.json
│   ├── source-detail/           # NEW — source-detail.ts + .wxml + .wxss + .json
│   └── history/                 # NEW — history.ts + .wxml + .wxss + .json
└── test/
    └── api.test.ts              # NEW — lib/api.ts 单元测试（mock fetch）
```

### 1.2 apps/admin 修改

```
apps/admin/src/
├── App.tsx                      # MODIFY — 加 /chat-sim 路由 + 导航
└── pages/
    └── ChatSim.tsx              # NEW — admin 内嵌 chat 仿真页
```

### 1.3 根级修改

```
pnpm-workspace.yaml             # MODIFY — 加 apps/miniprogram
README.md                       # MODIFY — 追加 M3 状态段
docs/wechat-miniprogram-setup.md # NEW — 真人操作 checklist
```

### 1.4 不修改

- `packages/shared/`：M3 不引入新共享类型（lib/types.ts 镜像定义避免跨 runtime 依赖）
- `apps/api/`：M3 是消费 /ask endpoint 的客户端
- `apps/api/migrations/`：无新 migration
- `wrangler.jsonc`：M3 不影响部署

---

## CP-1: monorepo 接入 + lib 层（types + storage + api + 单测）

**目标**：`apps/miniprogram/` 接入 pnpm workspace；lib 层 3 文件 + 4 个 Vitest 单测覆盖 happy/auth error/网络错误/localStorage round-trip。零 UI。

**完成定义**：`pnpm -F miniprogram test` 4 用例绿，typecheck 绿。

---

### Task 1: monorepo 接入 + miniprogram 骨架

**Files:**
- Create: `apps/miniprogram/tsconfig.json`
- Create: `apps/miniprogram/package.json`
- Create: `apps/miniprogram/.gitignore`
- Create: `apps/miniprogram/sitemap.json`
- Modify: `pnpm-workspace.yaml`（加 `apps/miniprogram`）

- [ ] **Step 1: 创建 apps/miniprogram/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "node",
    "lib": ["es2022", "dom"],
    "types": ["miniprogram-api-typings"],
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
  "exclude": ["node_modules", "dist", "miniprogram_npm"]
}
```

注：types `miniprogram-api-typings` 是微信小程序官方类型包（M3 范围外 npm install — 用 tsconfig 的 `typeRoots` 自动解析全局 `wx` API 类型；如果 plan 阶段无法 npm install，则在 Task 6 typecheck 时去掉此行并 mock 类型）。

- [ ] **Step 2: 创建 apps/miniprogram/package.json**

```json
{
  "name": "miniprogram",
  "version": "0.1.0",
  "private": true,
  "description": "unequal WeChat miniprogram client",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "5.5.4",
    "vitest": "2.0.5"
  }
}
```

- [ ] **Step 3: 创建 apps/miniprogram/.gitignore**

```
node_modules/
miniprogram_npm/
dist/
project.private.config.json
```

- [ ] **Step 4: 创建 apps/miniprogram/sitemap.json**

```json
{
  "desc": "关于本文件的更多信息，请参考文档 https://developers.weixin.qq.com/miniprogram/dev/reference/configuration/sitemap.html",
  "rules": [{ "action": "allow", "page": "*" }]
}
```

- [ ] **Step 5: 修改 pnpm-workspace.yaml 加 miniprogram**

读 `pnpm-workspace.yaml` 完整内容，在 `packages:` 列表追加 `apps/miniprogram`：

```yaml
packages:
  - apps/api
  - apps/admin
  - apps/miniprogram   # 新增
  - packages/*
```

- [ ] **Step 6: typecheck**

```bash
cd apps/miniprogram
pnpm exec tsc --noEmit 2>&1 | tail -5
```

预期：如果 `miniprogram-api-typings` 未安装，tsc 会报类型找不到；这一步是确认骨架可编译，错误可接受（v2+ 真机联调前再补类型包）。

- [ ] **Step 7: commit**

```bash
git add apps/miniprogram/tsconfig.json apps/miniprogram/package.json apps/miniprogram/.gitignore apps/miniprogram/sitemap.json pnpm-workspace.yaml
git commit -m "M3 task 1: monorepo scaffold for apps/miniprogram"
```

---

### Task 2: lib/types.ts 共享类型

**Files:**
- Create: `apps/miniprogram/lib/types.ts`

- [ ] **Step 1: 创建 lib/types.ts**

```ts
/**
 * 小程序端类型（与 M2 packages/shared/src/types.ts Citation 对齐）。
 * 镜像定义而非 import 是为了避免跨 runtime 依赖：
 * - 小程序 runtime 不支持 node 模块系统
 * - admin/admin 已独立 lib/types
 */

export interface Citation {
  n: number;            // 1..5
  title: string;
  snippet: string;
  url: string;          // R2 原始文件 URL 或 raw_path
  trustLevel: 0 | 1 | 2 | 3;
  sourceId: string;
  chunkId: string;
}

export interface AskResponse {
  answer: string;       // 含 [来源 N] 标记 + 免责声明
  disclaimer: string;
  citations: Citation[];
  cached: boolean;
}

export interface AskError {
  error: string;
  detail?: string;
}

export interface HistoryEntry {
  id: string;           // ulid
  q: string;
  response: AskResponse;
  createdAt: number;    // ms
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm -F miniprogram typecheck 2>&1 | tail -5
```

预期：通过（类型层无外部依赖）。

- [ ] **Step 3: commit**

```bash
git add apps/miniprogram/lib/types.ts
git commit -m "M3 task 2: miniprogram lib/types.ts (Citation/AskResponse/HistoryEntry)"
```

---

### Task 3: lib/storage.ts localStorage 封装

**Files:**
- Create: `apps/miniprogram/lib/storage.ts`

- [ ] **Step 1: 实现 storage**

```ts
import type { HistoryEntry } from "./types.js";

const STORAGE_KEY = "unequal:history";
const MAX_ENTRIES = 50;

/**
 * 小程序端历史问答 localStorage 封装。
 * 真机运行时由 wx.getStorageSync/wx.setStorageSync 替代（Task 15 chat 页）。
 * 本步骤只提供抽象层 + 测试桩，方便 Vitest 单测。
 */

export function loadHistory(): HistoryEntry[] {
  // 测试桩：单元测试中替换；运行时由 chat 页用 wx.getStorageSync 包装
  return _loadHistoryImpl();
}

export function saveHistory(entries: HistoryEntry[]): void {
  const trimmed = entries.slice(0, MAX_ENTRIES);
  _saveHistoryImpl(trimmed);
}

export function appendHistory(entry: HistoryEntry): HistoryEntry[] {
  const existing = loadHistory();
  const next = [entry, ...existing].slice(0, MAX_ENTRIES);
  saveHistory(next);
  return next;
}

export function clearHistory(): void {
  saveHistory([]);
}

// 默认实现：测试中通过 stub 替换
let _loadHistoryImpl: () => HistoryEntry[] = () => [];
let _saveHistoryImpl: (entries: HistoryEntry[]) => void = () => {};

export function __setStorageImpl(
  load: () => HistoryEntry[],
  save: (entries: HistoryEntry[]) => void,
): void {
  _loadHistoryImpl = load;
  _saveHistoryImpl = save;
}

export function __resetStorageImpl(): void {
  _loadHistoryImpl = () => [];
  _saveHistoryImpl = () => {};
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm -F miniprogram typecheck 2>&1 | tail -5
```

预期：通过。

- [ ] **Step 3: commit**

```bash
git add apps/miniprogram/lib/storage.ts
git commit -m "M3 task 3: miniprogram lib/storage.ts (localStorage history abstraction)"
```

---

### Task 4: lib/api.ts fetch 封装

**Files:**
- Create: `apps/miniprogram/lib/api.ts`

- [ ] **Step 1: 实现 ask 函数**

```ts
import type { AskResponse, AskError } from "./types.js";

/**
 * 调 /ask endpoint 拿单轮问答。
 * Mock-first：
 * - 开发期 base URL = http://localhost:8787（需在微信开发者工具勾选「不校验合法域名」）
 * - CP-5 真接 Cloudflare 后改 https://unequal.xxx.workers.dev
 * - fetch 注入点允许测试桩（Vitest 单测）
 */

export interface AskOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export async function ask(q: string, opts: AskOptions = {}): Promise<AskResponse> {
  const baseUrl = opts.baseUrl ?? "http://localhost:8787";
  const f = opts.fetchImpl ?? fetch;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  const res = await f(`${baseUrl}/ask`, {
    method: "POST",
    headers,
    body: JSON.stringify({ q }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as AskError;
    throw new Error(`/ask ${res.status}: ${body.error ?? "unknown"}`);
  }

  return (await res.json()) as AskResponse;
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm -F miniprogram typecheck 2>&1 | tail -5
```

预期：通过。

- [ ] **Step 3: commit**

```bash
git add apps/miniprogram/lib/api.ts
git commit -m "M3 task 4: miniprogram lib/api.ts (ask() fetch wrapper with token + injectable fetch)"
```

---

### Task 5: lib/api.ts Vitest 单测（4 用例）

**Files:**
- Create: `apps/miniprogram/test/api.test.ts`
- Create: `apps/miniprogram/vitest.config.ts`

- [ ] **Step 1: 创建 vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: 写 api.test.ts（4 用例）**

```ts
import { describe, it, expect } from "vitest";
import { ask } from "../lib/api.js";
import type { AskResponse } from "../lib/types.js";

describe("ask()", () => {
  const happy: AskResponse = {
    answer: "5个月宝宝发烧 38.5 [来源 1] [来源 3]\n\n以上信息...不构成医疗建议。",
    disclaimer: "以上信息...不构成医疗建议。具体情况请咨询专业儿科医生。",
    citations: [
      { n: 1, title: "美国儿科学会育儿百科", snippet: "三个月以下...", url: "raw/.../aap.pdf", trustLevel: 3, sourceId: "01H...", chunkId: "01H..." },
      { n: 3, title: "崔玉涛", snippet: "婴儿发烧...", url: "raw/.../cui.html", trustLevel: 2, sourceId: "01H...", chunkId: "01H..." },
    ],
    cached: false,
  };

  it("happy: 200 + JSON → 返回 AskResponse", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      expect(input).toBe("http://localhost:8787/ask");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ q: "test" });
      return new Response(JSON.stringify(happy), { status: 200, headers: { "content-type": "application/json" } });
    };

    const res = await ask("test", { fetchImpl: fetchMock });
    expect(res.citations.length).toBe(2);
    expect(res.citations[0]?.n).toBe(1);
    expect(res.cached).toBe(false);
  });

  it("带 token: Authorization header 设置正确", async () => {
    let capturedAuth: string | null = null;
    const fetchMock: typeof fetch = async (input, init) => {
      capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
      return new Response(JSON.stringify(happy), { status: 200 });
    };

    await ask("test", { token: "abc123", fetchImpl: fetchMock });
    expect(capturedAuth).toBe("Bearer abc123");
  });

  it("400: 抛 Error 含状态码 + error 字段", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "Missing or empty 'q' field" }), { status: 400 });

    await expect(ask("", { fetchImpl: fetchMock })).rejects.toThrow(/400.*Missing or empty/);
  });

  it("500: 抛 Error 含 'internal' 字段", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "internal", detail: "boom" }), { status: 500 });

    await expect(ask("test", { fetchImpl: fetchMock })).rejects.toThrow(/500.*internal/);
  });
});
```

- [ ] **Step 3: 跑测试看绿**

```bash
pnpm -F miniprogram test 2>&1 | tail -15
```

预期：4 用例全 PASS。

- [ ] **Step 4: commit**

```bash
git add apps/miniprogram/test/api.test.ts apps/miniprogram/vitest.config.ts
git commit -m "M3 task 5: miniprogram lib/api.ts — 4 vitest unit tests (happy/token/auth/network)"
```

---

### Task 6: CP-1 收尾

- [ ] **Step 1: 全测 + typecheck**

```bash
pnpm -F miniprogram test
pnpm -F miniprogram typecheck
pnpm -r typecheck 2>&1 | tail -10
```

预期：4 miniprogram 用例 + 全局 typecheck 绿。

- [ ] **Step 2: commit（如有遗漏）**

```bash
git status --short
```

如无 dirty，跳过；如有 commit "M3 task 6: CP-1 final verification"。

**CP-1 完成**：`apps/miniprogram/` monorepo 接入 + lib 层（api/types/storage）+ 4 单测。零 UI，零真机。

---

## CP-2: admin ChatSim 页（小程序 UI 的镜像 + 真接口验 /ask）

**目标**：`apps/admin/src/pages/ChatSim.tsx` 实现聊天 UI，路由接入 App.tsx，先在 admin 模拟聊天验 /ask 端到端（M3 是 M2 /ask 的客户端；ChatSim 让用户在小程序未发布前能看到效果）。

**完成定义**：`pnpm -F admin build` 绿，ChatSim 页可见 + 可调通 /ask（admin 端 Vite proxy 调本地 mock API）。

---

### Task 7: ChatSim 页骨架（form + 消息列表）

**Files:**
- Create: `apps/admin/src/pages/ChatSim.tsx`

- [ ] **Step 1: 实现 ChatSim**

```tsx
import { useState } from "react";
import type { FormEvent } from "react";
import { ask, type AskResponse, type AskCitation } from "../lib/api.js";

type Role = "user" | "assistant";

interface Message {
  id: string;
  role: Role;
  text: string;
  citations?: AskCitation[];
  cached?: boolean;
}

export default function ChatSim() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [q, setQ] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!q.trim()) return;
    const userMsg: Message = { id: crypto.randomUUID(), role: "user", text: q.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setQ("");
    setSubmitting(true);
    try {
      const r: AskResponse = await ask(userMsg.text);
      const botMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: r.answer,
        citations: r.citations,
        cached: r.cached,
      };
      setMessages((prev) => [...prev, botMsg]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex h-[calc(100vh-8rem)] flex-col">
      <h2 className="mb-4 text-xl font-semibold">Chat Simulation（小程序 UI 镜像）</h2>
      <div className="flex-1 space-y-3 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-4">
        {messages.length === 0 && (
          <p className="text-sm text-gray-500">问个问题试试，例如：5个月宝宝发烧38.5怎么办？</p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
                m.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-800 shadow"
              }`}
            >
              <p className="whitespace-pre-wrap">{m.text}</p>
              {m.role === "assistant" && m.cached && (
                <p className="mt-1 text-xs text-green-600">缓存命中</p>
              )}
              {m.role === "assistant" && m.citations && m.citations.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-gray-100 pt-2">
                  {m.citations.map((c) => (
                    <a
                      key={c.n}
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block text-xs text-blue-600 hover:underline"
                    >
                      [{c.n}] {c.title}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={onSubmit} className="mt-4 flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="输入问题…"
          className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
          disabled={submitting}
        />
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? "提问中…" : "提问"}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm -F admin typecheck 2>&1 | tail -5
```

预期：通过。

- [ ] **Step 3: commit**

```bash
git add apps/admin/src/pages/ChatSim.tsx
git commit -m "M3 task 7: admin ChatSim page (form + message list + citation cards)"
```

---

### Task 8: wire ChatSim 进 App.tsx

**Files:**
- Modify: `apps/admin/src/App.tsx`

- [ ] **Step 1: 读 App.tsx 完整内容**

（主线程已读：导入段、nav 段、Routes 段）

- [ ] **Step 2: 加 import + 路由 + 导航**

```tsx
// 顶部 import 段追加：
import ChatSim from "./pages/ChatSim.js";

// 导航段（在 /ask 之后）追加：
<Link to="/chat-sim" className="text-gray-600 hover:text-gray-900">Chat Sim</Link>

// Routes 段（在 /ask 之后）追加：
<Route path="/chat-sim" element={<ChatSim />} />
```

- [ ] **Step 3: build 验证**

```bash
pnpm -F admin build 2>&1 | tail -10
```

预期：vite build 成功；dist 包含 ChatSim 页 chunk。

- [ ] **Step 4: commit**

```bash
git add apps/admin/src/App.tsx
git commit -m "M3 task 8: wire ChatSim into App routing + nav"
```

---

### Task 9: CP-2 收尾

- [ ] **Step 1: 全 build + typecheck**

```bash
pnpm -r typecheck
pnpm -F admin build 2>&1 | tail -10
```

预期：3 包 typecheck 绿，admin build 成功。

- [ ] **Step 2: commit（如有遗漏）**

```bash
git status --short
```

如有 dirty，commit "M3 task 9: CP-2 final verification"。

**CP-2 完成**：admin ChatSim 页面 + 路由；可在 admin 内嵌聊天验 /ask 端到端。

---

## CP-3: 小程序全局配置（app.ts + app.json + app.wxss）

**目标**：`apps/miniprogram` 全局配置就位：pages 注册、tabBar、全局样式、tsconfig + project.config.json 占位 AppID。零业务代码。

**完成定义**：`pnpm -F miniprogram typecheck` 绿（即使 tsconfig 不全）；所有全局配置文件存在。

---

### Task 10: app.ts + app.json + app.wxss

**Files:**
- Create: `apps/miniprogram/app.ts`
- Create: `apps/miniprogram/app.json`
- Create: `apps/miniprogram/app.wxss`

- [ ] **Step 1: 创建 app.ts**

```ts
// 小程序全局逻辑
App({
  globalData: {
    apiBaseUrl: "http://localhost:8787",  // CP-5 后改 https://unequal.xxx.workers.dev
    // 真机调试时必须在微信开发者工具勾选「不校验合法域名」
  },
  onLaunch() {
    // 启动时拉历史问答（chat 页 onShow 时也拉一次）
    console.log("unequal miniprogram launched");
  },
});
```

- [ ] **Step 2: 创建 app.json**

```json
{
  "pages": [
    "pages/chat/chat",
    "pages/history/history",
    "pages/source-detail/source-detail"
  ],
  "window": {
    "backgroundTextStyle": "light",
    "navigationBarBackgroundColor": "#ffffff",
    "navigationBarTitleText": "不等号 · 育儿问答",
    "navigationBarTextStyle": "black",
    "backgroundColor": "#f7f7f7"
  },
  "tabBar": {
    "color": "#666666",
    "selectedColor": "#2563eb",
    "backgroundColor": "#ffffff",
    "list": [
      { "pagePath": "pages/chat/chat", "text": "问答" },
      { "pagePath": "pages/history/history", "text": "历史" }
    ]
  },
  "style": "v2",
  "sitemapLocation": "sitemap.json"
}
```

- [ ] **Step 3: 创建 app.wxss**

```css
/* 全局样式 */
page {
  background-color: #f7f7f7;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 28rpx;
  color: #1f2937;
  box-sizing: border-box;
}

view, text, button, input, textarea {
  box-sizing: border-box;
}
```

- [ ] **Step 4: typecheck + commit**

```bash
pnpm -F miniprogram typecheck 2>&1 | tail -5
git add apps/miniprogram/app.ts apps/miniprogram/app.json apps/miniprogram/app.wxss
git commit -m "M3 task 10: miniprogram global app.ts + app.json + app.wxss (pages + tabBar)"
```

---

### Task 11: project.config.json + 占位 AppID

**Files:**
- Create: `apps/miniprogram/project.config.json`

- [ ] **Step 1: 创建 project.config.json（占位 AppID）**

```json
{
  "description": "不等号 / unequal 微信小程序配置。占位 AppID 用于本地开发，真机调试前需替换。",
  "packOptions": { "ignore": [], "include": [] },
  "setting": {
    "urlCheck": false,
    "es6": true,
    "enhance": true,
    "postcss": true,
    "preloadBackgroundData": false,
    "minified": true,
    "newFeature": true,
    "coverView": true,
    "nodeModules": false,
    "autoAudits": false,
    "showShadowRootInWxmlPanel": true,
    "scopeDataCheck": false,
    "uglifyFileName": false,
    "checkInvalidKey": true,
    "checkSiteMap": true,
    "uploadWithSourceMap": true,
    "compileHotReLoad": false,
    "useMultiFrameRuntime": true,
    "useApiHook": true,
    "useApiHostProcess": true,
    "babelSetting": {
      "ignore": [],
      "disablePlugins": [],
      "outputPath": ""
    },
    "enableEngineNative": false,
    "useIsolateContext": true,
    "userConfirmedBundleSwitch": false,
    "packNpmManually": false,
    "packNpmRelationList": [],
    "minifyWXSS": true,
    "disableUseStrict": false,
    "minifyWXML": true,
    "showES6CompileOption": false,
    "useCompilerPlugins": false
  },
  "compileType": "miniprogram",
  "libVersion": "3.5.0",
  "appid": "touristappid0000000",
  "projectname": "unequal-miniprogram",
  "condition": {},
  "editorSetting": { "tabIndent": "insertSpaces", "tabSize": 2 },
  "miniprogramRoot": "./"
}
```

**关键说明**：
- `appid: "touristappid0000000"` 是占位字符串。真机调试前用户需替换为 mp.weixin.qq.com 注册后获得的真 AppID。
- `urlCheck: false` 允许开发期调 `http://localhost:8787`（生产环境必须改回 true）。

- [ ] **Step 2: commit**

```bash
git add apps/miniprogram/project.config.json
git commit -m "M3 task 11: miniprogram project.config.json (placeholder AppID for mock-first dev)"
```

---

### Task 12: CP-3 收尾

- [ ] **Step 1: 全 typecheck**

```bash
pnpm -r typecheck 2>&1 | tail -10
```

预期：3 包 typecheck 绿（miniprogram 容忍 types 缺失警告）。

- [ ] **Step 2: commit（如有遗漏）**

```bash
git status --short
```

如有 dirty，commit "M3 task 12: CP-3 final verification"。

**CP-3 完成**：小程序全局配置就位，下一步落地页面 + 组件。

---

## CP-4: 小程序页面 + 组件（chat + source-detail + history + citation-card + message-bubble）

**目标**：3 个页面 + 2 个组件完整实现。每个页面 .ts + .wxml + .wxss + .json 全套。零单测（页面层逻辑靠 TypeScript + 真机调试；lib 层 Task 5 已覆盖）。

**完成定义**：所有文件存在；`pnpm -F miniprogram typecheck` 绿（types 缺失警告可接受）。

---

### Task 13: citation-card 组件

**Files:**
- Create: `apps/miniprogram/components/citation-card/citation-card.ts`
- Create: `apps/miniprogram/components/citation-card/citation-card.wxml`
- Create: `apps/miniprogram/components/citation-card/citation-card.wxss`
- Create: `apps/miniprogram/components/citation-card/citation-card.json`

- [ ] **Step 1: citation-card.ts**

```ts
import type { Citation } from "../../lib/types.js";

Component({
  properties: {
    citation: {
      type: Object as { value: Citation },
      required: true,
    },
  },
  methods: {
    onTap() {
      const c = (this.data as { citation: Citation }).citation;
      this.triggerEvent("tap", { citation: c });
      // 跳 source-detail 页
      wx.navigateTo({
        url: `/pages/source-detail/source-detail?chunkId=${c.chunkId}&title=${encodeURIComponent(c.title)}`,
      });
    },
  },
});
```

- [ ] **Step 2: citation-card.wxml**

```xml
<view class="citation-card" bindtap="onTap">
  <view class="header">
    <text class="num">[{{citation.n}}]</text>
    <text class="title">{{citation.title}}</text>
    <text class="trust">trust {{citation.trustLevel}}</text>
  </view>
  <view class="snippet">{{citation.snippet}}</view>
</view>
```

- [ ] **Step 3: citation-card.wxss**

```css
.citation-card {
  margin-top: 12rpx;
  padding: 16rpx;
  background-color: #f0f7ff;
  border-left: 4rpx solid #2563eb;
  border-radius: 8rpx;
}

.header {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 8rpx;
}

.num {
  font-family: monospace;
  color: #6b7280;
  font-size: 24rpx;
}

.title {
  font-weight: 500;
  color: #1f2937;
  font-size: 28rpx;
  flex: 1;
}

.trust {
  font-size: 20rpx;
  color: #6b7280;
  background-color: #e5e7eb;
  padding: 2rpx 8rpx;
  border-radius: 4rpx;
}

.snippet {
  font-size: 24rpx;
  color: #4b5563;
  line-height: 1.5;
}
```

- [ ] **Step 4: citation-card.json**

```json
{
  "component": true,
  "usingComponents": {}
}
```

- [ ] **Step 5: commit**

```bash
git add apps/miniprogram/components/citation-card/
git commit -m "M3 task 13: citation-card component (4 files: .ts + .wxml + .wxss + .json)"
```

---

### Task 14: message-bubble 组件

**Files:**
- Create: `apps/miniprogram/components/message-bubble/message-bubble.ts`
- Create: `apps/miniprogram/components/message-bubble/message-bubble.wxml`
- Create: `apps/miniprogram/components/message-bubble/message-bubble.wxss`
- Create: `apps/miniprogram/components/message-bubble/message-bubble.json`

- [ ] **Step 1: message-bubble.ts**

```ts
type Role = "user" | "assistant";

Component({
  properties: {
    role: {
      type: String as { value: Role },
      value: "user" as Role,
    },
    text: {
      type: String,
      value: "",
    },
    cached: {
      type: Boolean,
      value: false,
    },
    citations: {
      type: Array,
      value: [] as Array<Record<string, unknown>>,
    },
  },
});
```

- [ ] **Step 2: message-bubble.wxml**

```xml
<view class="bubble {{role === 'user' ? 'user' : 'assistant'}}">
  <view class="text">{{text}}</view>
  <view wx:if="{{role === 'assistant' && cached}}" class="cached-tag">缓存命中</view>
  <view wx:if="{{role === 'assistant' && citations.length > 0}}" class="citations">
    <citation-card wx:for="{{citations}}" wx:key="n" citation="{{item}}" />
  </view>
</view>
```

- [ ] **Step 3: message-bubble.wxss**

```css
.bubble {
  max-width: 80%;
  padding: 20rpx 24rpx;
  border-radius: 16rpx;
  font-size: 28rpx;
  line-height: 1.6;
}

.bubble.user {
  align-self: flex-end;
  background-color: #2563eb;
  color: #ffffff;
}

.bubble.assistant {
  align-self: flex-start;
  background-color: #ffffff;
  color: #1f2937;
  box-shadow: 0 1rpx 4rpx rgba(0, 0, 0, 0.05);
}

.text {
  white-space: pre-wrap;
  word-break: break-word;
}

.cached-tag {
  display: inline-block;
  margin-top: 8rpx;
  font-size: 20rpx;
  color: #16a34a;
  background-color: #dcfce7;
  padding: 2rpx 8rpx;
  border-radius: 4rpx;
}

.citations {
  margin-top: 12rpx;
}
```

- [ ] **Step 4: message-bubble.json**

```json
{
  "component": true,
  "usingComponents": {
    "citation-card": "/components/citation-card/citation-card"
  }
}
```

- [ ] **Step 5: commit**

```bash
git add apps/miniprogram/components/message-bubble/
git commit -m "M3 task 14: message-bubble component (4 files: .ts + .wxml + .wxss + .json)"
```

---

### Task 15: chat 页

**Files:**
- Create: `apps/miniprogram/pages/chat/chat.ts`
- Create: `apps/miniprogram/pages/chat/chat.wxml`
- Create: `apps/miniprogram/pages/chat/chat.wxss`
- Create: `apps/miniprogram/pages/chat/chat.json`

- [ ] **Step 1: chat.ts**

```ts
import { ask } from "../../lib/api.js";
import { appendHistory, loadHistory, __setStorageImpl } from "../../lib/storage.js";
import type { AskResponse, HistoryEntry } from "../../lib/types.js";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations?: AskResponse["citations"];
  cached?: boolean;
}

const app = getApp() as { globalData: { apiBaseUrl: string } };

Page({
  data: {
    messages: [] as ChatMessage[],
    q: "",
    submitting: false,
    error: null as string | null,
  },

  onLoad() {
    this.loadFromStorage();
  },

  loadFromStorage() {
    // 注入 wx storage 实现
    const load = () => {
      try {
        const raw = wx.getStorageSync("unequal:history") as HistoryEntry[] | undefined;
        return Array.isArray(raw) ? raw : [];
      } catch {
        return [];
      }
    };
    const save = (entries: HistoryEntry[]) => {
      try {
        wx.setStorageSync("unequal:history", entries);
      } catch {
        // 忽略 storage 失败（容量满 / 系统限制）
      }
    };
    __setStorageImpl(load, save);

    const history = loadHistory();
    // 取最近 10 条作为消息列表（首条是最近问答）
    const recent = history.slice(0, 10);
    const messages: ChatMessage[] = recent.map((h) => ({
      id: h.id,
      role: "assistant",
      text: `${h.q}\n\n${h.response.answer}`,
      citations: h.response.citations,
      cached: h.response.cached,
    }));
    // 把 q 也作为 user 消息插入（在 assistant 之前）
    const withUser: ChatMessage[] = [];
    for (const m of messages) {
      if (m.role === "assistant") {
        const h = recent.find((x) => x.id === m.id);
        if (h) {
          withUser.push({ id: `${m.id}-q`, role: "user", text: h.q });
        }
      }
      withUser.push(m);
    }
    this.setData({ messages: withUser });
  },

  onQInput(e: WechatMiniprogram.InputEvent) {
    this.setData({ q: e.detail.value });
  },

  async onSubmit() {
    const q = this.data.q.trim();
    if (!q || this.data.submitting) return;

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: "user", text: q };
    this.setData({ messages: [...this.data.messages, userMsg], q: "", submitting: true, error: null });

    try {
      const r = await ask(q, { baseUrl: app.globalData.apiBaseUrl });
      const botMsg: ChatMessage = {
        id: `a-${Date.now()}`,
        role: "assistant",
        text: r.answer,
        citations: r.citations,
        cached: r.cached,
      };
      this.setData({ messages: [...this.data.messages, botMsg], submitting: false });

      // 写历史
      const entry: HistoryEntry = {
        id: botMsg.id,
        q,
        response: r,
        createdAt: Date.now(),
      };
      appendHistory(entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setData({ submitting: false, error: msg });
    }
  },

  onTapCitation(e: WechatMiniprogram.CustomEvent) {
    // citation-card 已自动 navigateTo source-detail；这里仅占位
  },
});
```

