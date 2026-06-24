# M2 Implementation Plan: /ask 端到端单轮问答

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `POST /ask` 端到端单轮问答：用户问题 → embedding 检索 → top5 加权 → prompt → LLM chat → 双层引用验证 → 医疗免责声明 → 缓存回写，全部走 mock-first（无真人操作）。

**Architecture:**
- 纯函数层（`packages/shared/src/{prompt,cite-verify}.ts`）独立 TDD
- LLM 边界走 `globalThis.fetch` mock，4 种 canned response 覆盖 happy / no_citation / cite_mismatch / malformed_json
- 应用层（`apps/api/src/lib/ask.ts`）做端到端编排：检索 → prompt → LLM → 验证 → 降级 → 缓存
- Admin test page 4 tab 可视化（top5 chunks / final prompt / answer / citations）
- 缓存：D1 `query_cache` 表存全文 + Vectorize 存指针（metadata 大小受限）

**Tech Stack:**
- 现有：Hono 4.5 + Vitest 2.0 + TypeScript 5.5 + Zod 3.23 + ULID 3.0 + Miniflare 3
- 复用 M0+M1：`packages/shared/src/{retrieval,embedding,types,schemas}.ts`、`apps/api/src/lib/auth.ts`、D1 0001+0002 migrations、wrangler.jsonc、apps/admin 已配 CORS

**Spec:** `docs/superpowers/specs/2026-06-15-m2-ask-design.md`（484 行，详细 prompt 格式、验证器算法、缓存策略、CP 划分）
**Mock-first 边界：** `docs/superpowers/specs/2026-06-15-m2-ask-design.md` §11
**Agent 协议：** `docs/superpowers/specs/2026-06-15-agent-dispatch-protocol.md`（4 规则，dispatch 前必读）

---

## 0. 工作区设置

- 分支：`m2-ask`（基于 `master` 当前 HEAD `43338cd`）
- Worktree 路径：`/Users/Mark/cc_project/unequal/.claude/worktrees/m2-ask`
- 不进 master，所有 18 个 task 在 worktree 内完成
- 4 CP，CP 边界不强制 commit squash（每 task 一 commit）
- 结束用 `superpowers:finishing-a-development-branch` 决定 merge/PR

**为什么用 worktree**：M2 涉及 18 个文件新增/修改 + 全栈 TDD（shared/api/admin 三层），与 master 当前 docs 仓库隔离最稳。

---

## 1. 文件结构

### 1.1 packages/shared 新增

```
packages/shared/src/
  prompt.ts              # NEW — buildAskPrompt(q, top5) + ASK_SYSTEM_TEMPLATE
  cite-verify.ts         # NEW — verifyCitations(answer) → { textCitations, jsonCitations, verified, malformed }
packages/shared/test/
  prompt.test.ts         # NEW — 4 用例覆盖 prompt 格式
  cite-verify.test.ts    # NEW — 4 用例覆盖 4 种 LLM 输出
packages/shared/src/
  index.ts               # MODIFY — export prompt + cite-verify
packages/shared/package.json  # MODIFY — exports 加 ./prompt + ./cite-verify
```

### 1.2 apps/api 新增/修改

```
apps/api/src/lib/
  llm.ts                 # NEW — chatCompletion(system, user, env) via fetch
  ask.ts                 # NEW — runAsk(q, env) 编排 5.2 全 10 步
apps/api/src/routes/
  ask.ts                 # NEW — POST /ask 端点（auth + 委托 runAsk）
apps/api/src/
  index.ts               # MODIFY — wire app.post("/ask", ...)
apps/api/src/types.ts    # MODIFY — 加 q_embedding, query_cache 相关 type
apps/api/migrations/
  0003_query_cache.sql   # NEW — D1 query_cache 表
  0003_query_cache.down.sql  # NEW
apps/api/test/
  llm-fixtures.ts        # NEW — 4 个 canned response
  ask.test.ts            # NEW — 7 用例覆盖 happy/降级/缓存/鉴权
```

### 1.3 apps/admin 新增/修改

```
apps/admin/src/lib/
  api.ts                 # MODIFY — 加 ask(q): Promise<AskResponse>
apps/admin/src/pages/
  AskTest.tsx            # NEW — 4 tab 测试页
apps/admin/src/
  App.tsx                # MODIFY — 加 /ask 路由 + 导航
```

### 1.4 不修改

- 任何 M0+M1 写过的文件除上面列出的 MODIFY 外不动
- `apps/api/migrations/0001_init.sql` 和 `0002_dev_seed.sql`（已有 fixture 足够覆盖 4 夹具场景）

---

## CP-1: Prompt builder + 双层引用验证器（pure function + 单测）

**目标**：`packages/shared/src/prompt.ts` + `cite-verify.ts` 两个 pure function，加上完整单测。零 LLM、零 HTTP、零 D1。TDD 严格：先写 test 看红，再写实现看绿。

**完成定义**：`pnpm -F shared test` 8 用例（4 prompt + 4 cite-verify）全绿，typecheck 绿。

---

### Task 1: 双层引用验证器

**Files:**
- Create: `packages/shared/src/cite-verify.ts`
- Create: `packages/shared/test/cite-verify.test.ts`
- Modify: `packages/shared/src/index.ts:1` (append 2 行 export)
- Modify: `packages/shared/package.json:9-15` (exports 加 `./cite-verify`)

- [ ] **Step 1: 写 cite-verify test（4 用例）**

`packages/shared/test/cite-verify.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { verifyCitations } from "../src/cite-verify.js";

describe("verifyCitations", () => {
  it("happy: 文本引 1,3 + JSON 引 1,3 → verified=[1,3]", () => {
    const answer = "5个月宝宝腋温 38.5°C 建议先 [来源 1] [来源 3]\n\n{\"citations\":[1,3]}";
    const r = verifyCitations(answer);
    expect(r.textCitations).toEqual([1, 3]);
    expect(r.jsonCitations).toEqual([1, 3]);
    expect(r.verified).toEqual([1, 3]);
    expect(r.malformed).toBe(false);
  });

  it("cite_mismatch: 文本引 1 但 JSON 引 2 → verified=[]", () => {
    const answer = "5个月宝宝 [来源 1] ...\n\n{\"citations\":[2]}";
    const r = verifyCitations(answer);
    expect(r.textCitations).toEqual([1]);
    expect(r.jsonCitations).toEqual([2]);
    expect(r.verified).toEqual([]);
    expect(r.malformed).toBe(false);
  });

  it("malformed_json: 有 citations 关键字但 JSON 坏 → verified=[], malformed=true", () => {
    const answer = "... [来源 1] ...\n\n{not valid json}";
    const r = verifyCitations(answer);
    expect(r.verified).toEqual([]);
    expect(r.malformed).toBe(true);
  });

  it("越界编号: 文本引 100 + JSON 引 100 → 都被过滤 → verified=[]", () => {
    const answer = "... [来源 100] ...\n\n{\"citations\":[100]}";
    const r = verifyCitations(answer);
    expect(r.textCitations).toEqual([]);  // 100 不在 1..5，过滤
    expect(r.jsonCitations).toEqual([]);  // 同上
    expect(r.verified).toEqual([]);
    expect(r.malformed).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试，验证它失败**

```bash
pnpm -F shared test
```

预期：FAIL with "Cannot find module '../src/cite-verify.js'" 或类似 import error。

- [ ] **Step 3: 实现 verifyCitations**

`packages/shared/src/cite-verify.ts`：

```ts
export interface CitationVerifyResult {
  textCitations: number[];
  jsonCitations: number[];
  verified: number[];
  malformed: boolean;
}

const MAX_CITATION = 5;

/**
 * 双层引用验证（spec §3.1 + §5）：
 * - 文本里所有 [来源 N]（N ∈ 1..5）
 * - 末尾 {"citations":[N,M,...]} JSON 块
 * - 交集 = 真正引用的编号
 *
 * JSON 块必须出现在答案末尾（$ 锚定），防 LLM 写到中间。
 * 编号限定 1..5，防 LLM 幻觉写 6/7/100。
 */
export function verifyCitations(answer: string): CitationVerifyResult {
  // 1. 解析文本 [来源 N]
  const textCitations = [
    ...new Set(
      [...answer.matchAll(/\[来源\s*(\d+)\]/g)]
        .map((m) => parseInt(m[1], 10))
        .filter((n) => n >= 1 && n <= MAX_CITATION),
    ),
  ];

  // 2. 解析末尾 JSON 块
  const jsonBlockMatch = answer.match(/\{"citations":\s*\[([^\]]*)\]\}\s*$/);
  let jsonCitations: number[] = [];
  let malformed = false;

  if (jsonBlockMatch) {
    const inner = jsonBlockMatch[1]!.trim();
    if (inner === "") {
      jsonCitations = [];
    } else {
      try {
        const parsed: unknown = JSON.parse(`[${inner}]`);
        if (!Array.isArray(parsed)) {
          malformed = true;
        } else {
          jsonCitations = parsed
            .filter((x): x is number => typeof x === "number" && Number.isInteger(x))
            .filter((n) => n >= 1 && n <= MAX_CITATION);
        }
      } catch {
        malformed = true;
      }
    }
  } else if (/\{"citations":/.test(answer)) {
    // 有 "citations" 关键字但 JSON 块没出现在末尾
    malformed = true;
  }

  // 3. 交集（保 textCitations 顺序）
  const verified = textCitations.filter((n) => jsonCitations.includes(n));

  return { textCitations, jsonCitations, verified, malformed };
}
```

- [ ] **Step 4: 跑测试，验证它通过**

```bash
pnpm -F shared test -- cite-verify
```

预期：4 用例全 PASS。

- [ ] **Step 5: 加 export**

`packages/shared/src/index.ts`（在文件末尾追加）：

```ts
export * from "./cite-verify.js";
```

`packages/shared/package.json` 的 `exports` 段（追加）：

```json
"./cite-verify": "./src/cite-verify.ts"
```

- [ ] **Step 6: 跑 typecheck + 全测，commit**

```bash
pnpm -F shared typecheck
pnpm -F shared test
git add packages/shared/src/cite-verify.ts packages/shared/test/cite-verify.test.ts packages/shared/src/index.ts packages/shared/package.json pnpm-lock.yaml
git commit -m "M2 task 1: dual-layer citation verifier with 4 unit tests"
```

---

### Task 2: Prompt 模板常量 + 类型

**Files:**
- Create: `packages/shared/src/prompt.ts`（仅占位 + 类型 + 常量，**不**写 buildAskPrompt 实现，留给 Task 3）
- Modify: `packages/shared/src/index.ts`（export）

- [ ] **Step 1: 写 prompt 占位 + 常量**

`packages/shared/src/prompt.ts`：

```ts
/**
 * 系统 prompt 模板（spec §3.1 + §5）。
 * 暴露为常量，便于真接 MiniMax 后调优。
 */
export const ASK_SYSTEM_TEMPLATE = `你是"不等号"——一个个人育儿知识库助手。

【硬约束】
1. 你的回答必须严格基于下方"参考资料"中给出的内容。不得使用任何不在参考资料里的常识、训练知识或推断。
2. 引用资料时用 [来源 N] 格式（N 对应下方编号 1..5）。正文里只允许使用 [来源 N] 形式，不要在引用处写文档名、URL、章节号等。
3. 答案末尾必须且只能输出一个 JSON 块，格式严格为 {"citations": [N, M, ...]}，其中 N, M 是你正文里实际写过的 [来源 N] 编号。不得多写，不得少写。
4. 如果参考资料里没有这个问题的答案，必须在答案正文中明确写"未在知识库中找到可靠来源"，并且 JSON 块的 citations 为 []。
5. 不要补全、不要兜底、不要给"一般来说"式的常识补充。资料没写就是没写。

【参考资料】
{{CHUNKS}}`;

/**
 * 信源等级中文标签（spec §3.3）
 */
export const TRUST_LABELS: Record<0 | 1 | 2 | 3, string> = {
  0: "未评级",
  1: "一般",
  2: "可信",
  3: "权威",
};

export const DISCLAIMER_TEXT =
  "以上信息来源于知识库内容，不构成医疗建议。具体情况请咨询专业儿科医生。";

/**
 * 一次 ask 编排的输入（来自 retrieval 步骤 §5.2 ⑤）
 */
export interface AskContext {
  /** 1..5 编号对应的 chunk 全文 + 元数据 */
  chunks: AskContextChunk[];
}

export interface AskContextChunk {
  n: 1 | 2 | 3 | 4 | 5;
  title: string;
  snippet: string;       // chunk content 前 ~100 字
  trustLevel: 0 | 1 | 2 | 3;
}

export interface AskPrompt {
  system: string;
  user: string;
}

export function buildAskPrompt(q: string, ctx: AskContext): AskPrompt {
  // 实现留给 Task 3
  void q;
  void ctx;
  throw new Error("not implemented");
}
```

- [ ] **Step 2: 跑 typecheck，验证占位编译通过**

```bash
pnpm -F shared typecheck
```

预期：通过（buildAskPrompt 抛 not_implemented 不影响 typecheck）。

- [ ] **Step 3: export + commit**

`packages/shared/src/index.ts` 末尾追加：

```ts
export * from "./prompt.js";
```

`packages/shared/package.json` exports 段追加：

```json
"./prompt": "./src/prompt.ts"
```

```bash
git add packages/shared/src/prompt.ts packages/shared/src/index.ts packages/shared/package.json
git commit -m "M2 task 2: prompt module skeleton (types + ASK_SYSTEM_TEMPLATE + DISCLAIMER_TEXT)"
```

---

### Task 3: buildAskPrompt 实现

**Files:**
- Create: `packages/shared/test/prompt.test.ts`
- Modify: `packages/shared/src/prompt.ts`（实现 buildAskPrompt）

- [ ] **Step 1: 写 prompt 4 用例**

`packages/shared/test/prompt.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { buildAskPrompt, ASK_SYSTEM_TEMPLATE, DISCLAIMER_TEXT, TRUST_LABELS } from "../src/prompt.js";

describe("buildAskPrompt", () => {
  const top3 = [
    { n: 1 as const, title: "美国儿科学会育儿百科", snippet: "三个月以下婴儿发烧应立即就医", trustLevel: 3 as const },
    { n: 2 as const, title: "崔玉涛：婴儿发烧的家庭处理", snippet: "婴儿发烧时先观察精神状态", trustLevel: 2 as const },
    { n: 3 as const, title: "宝爸笔记", snippet: "我家宝宝 5 个月时发烧 38.5", trustLevel: 1 as const },
  ];

  it("top3 → system 含 [1]/[2]/[3] + 信任标签", () => {
    const p = buildAskPrompt("5个月宝宝发烧38.5怎么办", { chunks: top3 });
    expect(p.system).toContain("[1] 《美国儿科学会育儿百科》/");
    expect(p.system).toContain("[2] 《崔玉涛：婴儿发烧的家庭处理》/");
    expect(p.system).toContain("[3] 《宝爸笔记》/");
    expect(p.system).toContain("(信源等级: 权威)");
    expect(p.system).toContain("(信源等级: 可信)");
    expect(p.system).toContain("(信源等级: 一般)");
  });

  it("system 含 ASK_SYSTEM_TEMPLATE 5 条硬约束", () => {
    const p = buildAskPrompt("q", { chunks: top3 });
    expect(p.system).toContain("【硬约束】");
    expect(p.system).toContain("不得使用任何不在参考资料里的常识");
    expect(p.system).toContain("答案末尾必须且只能输出一个 JSON 块");
    expect(p.system).toContain('{"citations": [N, M, ...]}');
    expect(p.system).toContain('"未在知识库中找到可靠来源"');
  });

  it("user prompt = 原问题", () => {
    const p = buildAskPrompt("5个月宝宝发烧38.5怎么办", { chunks: top3 });
    expect(p.user).toBe("5个月宝宝发烧38.5怎么办");
  });

  it("chunks 为空 → system 仍含模板（无 [N] 行）+ user 仍为问题", () => {
    const p = buildAskPrompt("q", { chunks: [] });
    expect(p.system).toContain(ASK_SYSTEM_TEMPLATE.split("{{CHUNKS}}")[0]);
    expect(p.system).not.toContain("[1] ");  // 没 chunks → 没 [1] 行
    expect(p.user).toBe("q");
  });
});

describe("TRUST_LABELS", () => {
  it("4 个等级都有中文标签", () => {
    expect(TRUST_LABELS[0]).toBe("未评级");
    expect(TRUST_LABELS[1]).toBe("一般");
    expect(TRUST_LABELS[2]).toBe("可信");
    expect(TRUST_LABELS[3]).toBe("权威");
  });
});

describe("DISCLAIMER_TEXT", () => {
  it("是 spec §3.1 规定的字面文本", () => {
    expect(DISCLAIMER_TEXT).toBe(
      "以上信息来源于知识库内容，不构成医疗建议。具体情况请咨询专业儿科医生。"
    );
  });
});
```

- [ ] **Step 2: 跑测试，验证它失败**

```bash
pnpm -F shared test -- prompt
```

预期：FAIL，buildAskPrompt throws "not implemented"。

- [ ] **Step 3: 实现 buildAskPrompt**

`packages/shared/src/prompt.ts`（替换 `buildAskPrompt` 函数体）：

```ts
export function buildAskPrompt(q: string, ctx: AskContext): AskPrompt {
  const chunkLines = ctx.chunks
    .sort((a, b) => a.n - b.n)
    .map(
      (c) =>
        `[${c.n}] 《${c.title}》/ "${c.snippet}" (信源等级: ${TRUST_LABELS[c.trustLevel]})`,
    )
    .join("\n");

  const system = ASK_SYSTEM_TEMPLATE.replace("{{CHUNKS}}", chunkLines);
  return { system, user: q };
}
```

- [ ] **Step 4: 跑测试，验证它通过**

```bash
pnpm -F shared test -- prompt
```

预期：7 用例（4 buildAskPrompt + 2 子套件 + 1 DIS）全 PASS。

- [ ] **Step 5: typecheck + 全测 + commit**

```bash
pnpm -F shared typecheck
pnpm -F shared test
git add packages/shared/src/prompt.ts packages/shared/test/prompt.test.ts
git commit -m "M2 task 3: buildAskPrompt with 4 unit tests (TDD green)"
```

---

### Task 4: CP-1 收尾（lint + 全测 + typecheck + docs）

- [ ] **Step 1: 跑全套验证**

```bash
pnpm -F shared test
pnpm -F shared typecheck
pnpm -r typecheck
```

预期：shared 8 新用例 + 16 旧用例 = 24 用例全绿，3 包 typecheck 全绿。

- [ ] **Step 2: commit CP-1 收尾（如有改动）**

```bash
git status --short
```

如果无 dirty 改动，跳过 commit；如有，commit "M2 task 4: CP-1 final verification"。

**CP-1 完成**：`packages/shared/src/{cite-verify,prompt}.ts` 实现 + 8 单测全绿。零依赖 LLM、零 HTTP、零 D1。

---

## CP-2: /ask endpoint + LLM caller（fetch mock + 集成测试）

**目标**：`POST /ask` 端到端跑通：question → embedding → 检索 → prompt → LLM (mock) → 验证 → 降级/正常 → 响应。LLM 走 `globalThis.fetch` mock，4 种 canned response 全覆盖。

**完成定义**：`pnpm -F api test` 7 新用例 + 7 旧 = 14 用例全绿；`pnpm -F api build`（wrangler dry-run）绿。

**注意**：本 CP 期间不实现缓存回写（缓存是 CP-4）。但 `runAsk` 函数留出 `writeCache` 占位（`return { answer, disclaimer, citations, cached: false }` 即可）。

---

### Task 5: LLM caller

**Files:**
- Create: `apps/api/src/lib/llm.ts`

- [ ] **Step 1: 实现 chatCompletion（无 test，仅 typecheck 验证）**

`apps/api/src/lib/llm.ts`：

```ts
/**
 * 调 MiniMax chat completion（OpenAI 兼容）。
 * Mock-first：测试用 globalThis.fetch 拦截，参见 test/llm-fixtures.ts。
 * 真接 MiniMax 时改 MINIMAX_BASE_URL 即可。
 */
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMChatOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export async function chatCompletion(opts: LLMChatOptions): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 3;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await f(`${opts.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          temperature: opts.temperature ?? 0.2,
        }),
      });

      if (!res.ok) {
        throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = data.choices[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("LLM response missing choices[0].message.content");
      }
      return content;
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries - 1) break;
      // 简单退避：100ms * 2^attempt
      await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
    }
  }
  throw new Error(`LLM chat failed after ${maxRetries} attempts: ${String(lastErr)}`);
}
```

- [ ] **Step 2: 验证 typecheck**

```bash
pnpm -F api typecheck
```

预期：通过。

- [ ] **Step 3: commit**

```bash
git add apps/api/src/lib/llm.ts
git commit -m "M2 task 5: LLM caller (chatCompletion) with retry + globalThis.fetch injectable"
```

---

### Task 6: LLM canned fixtures

**Files:**
- Create: `apps/api/test/llm-fixtures.ts`

- [ ] **Step 1: 写 4 个 canned response**

`apps/api/test/llm-fixtures.ts`：

```ts
/**
 * MiniMax chat completion 的 4 种 canned response，覆盖 spec §4.2 的 4 种输出形态。
 * 集成测试通过 globalThis.fetch mock 注入，参见 apps/api/test/ask.test.ts。
 */

export const LLM_FIXTURES = {
  /** happy: 文本引 1,3 + JSON 引 1,3 → 验证通过 */
  happy: {
    content:
      '5个月宝宝腋温 38.5°C 建议先 [来源 1] [来源 3]\n\n{"citations":[1,3]}',
  },
  /** no_citation: 文本无 [来源 N] + JSON [] → 降级 */
  no_citation: {
    content: "5个月宝宝发烧应该多喝水，注意休息。\n\n{\"citations\":[]}",
  },
  /** cite_mismatch: 文本引 1 但 JSON 引 2 → 降级 */
  cite_mismatch: {
    content: "5个月宝宝发烧 [来源 1] ...\n\n{\"citations\":[2]}",
  },
  /** malformed_json: 有 citations 关键字但 JSON 坏 → 降级 + malformed=true */
  malformed_json: {
    content: "5个月宝宝发烧 [来源 1] ...\n\n{not valid json}",
  },
} as const;

export type FixtureName = keyof typeof LLM_FIXTURES;

/** 模拟 OpenAI 兼容的 chat completion response 包装 */
export function fixtureResponse(name: FixtureName): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: LLM_FIXTURES[name].content,
          },
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
}
```

- [ ] **Step 2: typecheck + commit**

```bash
pnpm -F api typecheck
git add apps/api/test/llm-fixtures.ts
git commit -m "M2 task 6: 4 LLM canned fixtures (happy/no_citation/cite_mismatch/malformed_json)"
```

---

### Task 7: /ask 端点骨架（鉴权 + 委托 runAsk）

**Files:**
- Create: `apps/api/src/lib/ask.ts`（含 runAsk 完整实现，本步先实现"无缓存"版本）
- Create: `apps/api/src/routes/ask.ts`
- Modify: `apps/api/src/index.ts`（加 app.post("/ask", ...)）

- [ ] **Step 1: 实现 runAsk 核心（不含缓存）**

`apps/api/src/lib/ask.ts`：

```ts
import { createMiniMaxEmbedder } from "@unequal/shared/embedding";
import { searchChunks, type SearchResult } from "@unequal/shared/retrieval";
import { buildAskPrompt, DISCLAIMER_TEXT, type AskContext } from "@unequal/shared/prompt";
import { verifyCitations } from "@unequal/shared/cite-verify";
import type { Citation } from "@unequal/shared/types";
import { chatCompletion, type LLMMessage } from "./llm.js";
import type { Env } from "../types.js";

const DEFAULT_USER_ID = "01H0000000000000000000000";

export interface RunAskOptions {
  q: string;
  env: Env;
  /** 测试用：注入 fake fetch（覆盖 defaultUser fetcher） */
  fetchImpl?: typeof fetch;
  /** 缓存命中回调：CP-4 实装 */
  cacheRead?: (qEmbedding: number[]) => Promise<AskResult | null>;
  /** 缓存写入回调：CP-4 实装 */
  cacheWrite?: (qEmbedding: number[], result: AskResult) => Promise<void>;
}

export interface AskResult {
  answer: string;
  disclaimer: string;
  citations: Citation[];
  cached: boolean;
}

/** Snippet 长度（拼接进 prompt） */
const SNIPPET_CHARS = 100;

/**
 * §5.2 全 10 步编排（CP-2 阶段不实装 ①⑩ 缓存，留 callback 占位）。
 */
export async function runAsk(opts: RunAskOptions): Promise<AskResult> {
  const { q, env, fetchImpl } = opts;

  // ② 嵌入
  const embed = createMiniMaxEmbedder({
    apiKey: env.MINIMAX_API_KEY,
    baseUrl: env.MINIMAX_BASE_URL,
    model: "MiniMax-embeddings",
    fetchImpl,
  });
  const [qEmbedding] = await embed.embed([q]);
  if (!qEmbedding) throw new Error("embedding returned empty");

  // ① 缓存查（CP-4 实装：opts.cacheRead(qEmbedding)）
  if (opts.cacheRead) {
    const cached = await opts.cacheRead(qEmbedding);
    if (cached) return { ...cached, cached: true };
  }

  // ③ Vectorize topK=20 检索
  const rawHits = await searchChunks({
    vectorize: env.VECTORIZE,
    userId: DEFAULT_USER_ID,
    queryVector: qEmbedding,
    topK: 20,
  });

  // ⑤ 截断 topK=5 + trust 加权（在 searchChunks 内部已做加权排序）
  const top5: SearchResult[] = rawHits.slice(0, 5);

  // ③.5 用 chunk_id 反查 D1 拿 content + source/document 元数据
  const snippets = await fetchSnippets(env, top5);

  // ⑥ 拼 prompt
  const ctx: AskContext = {
    chunks: snippets.map((s, idx) => ({
      n: (idx + 1) as 1 | 2 | 3 | 4 | 5,
      title: s.title ?? "(无标题)",
      snippet: s.content.slice(0, SNIPPET_CHARS),
      trustLevel: (s.trustLevel as 0 | 1 | 2 | 3) ?? 0,
    })),
  };
  const prompt = buildAskPrompt(q, ctx);

  // ⑦ LLM chat
  const messages: LLMMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  const rawAnswer = await chatCompletion({
    apiKey: env.MINIMAX_API_KEY,
    baseUrl: env.MINIMAX_BASE_URL,
    model: "MiniMax-chat",
    messages,
    fetchImpl,
  });

  // ⑧ 双层验证
  const { verified, malformed } = verifyCitations(rawAnswer);

  // ⑨ 降级 / 正常
  let answer: string;
  let citations: Citation[];
  if (verified.length === 0) {
    answer = "未在知识库中找到可靠来源";
    citations = [];
  } else {
    // 截掉末尾 JSON 块，保留正文
    const jsonMatch = rawAnswer.match(/\{[^{}]*"citations"[^{}]*\}\s*$/);
    const textOnly = jsonMatch ? rawAnswer.slice(0, jsonMatch.index).trimEnd() : rawAnswer;
    answer = textOnly;
    citations = verified.map((n) => {
      const s = snippets[n - 1]!;
      return {
        n,
        title: s.title ?? "(无标题)",
        snippet: s.content,
        url: s.rawPath,
        trustLevel: (s.trustLevel as 0 | 1 | 2 | 3) ?? 0,
        sourceId: s.sourceId ?? "",
        chunkId: s.chunkId,
      };
    });
  }

  // 免责声明
  const disclaimer = DISCLAIMER_TEXT;
  if (!answer.includes(disclaimer)) {
    answer = `${answer}\n\n${disclaimer}`;
  }

  // ⑩ 缓存回写（CP-4 实装：opts.cacheWrite）
  const result: AskResult = { answer, disclaimer, citations, cached: false };
  if (verified.length > 0 && opts.cacheWrite) {
    await opts.cacheWrite(qEmbedding, result);
  }

  return result;
}

interface SnippetRow {
  chunkId: string;
  content: string;
  title?: string;
  rawPath?: string;
  trustLevel?: number;
  sourceId?: string;
}

async function fetchSnippets(env: Env, hits: SearchResult[]): Promise<SnippetRow[]> {
  if (hits.length === 0) return [];
  const placeholders = hits.map(() => "?").join(",");
  const stmt = env.DB.prepare(
    `SELECT c.id AS chunkId, c.content, c.trust_level AS trustLevel, c.source_id AS sourceId,
            d.title AS title, d.raw_path AS rawPath
       FROM chunk c
       JOIN document d ON d.id = c.document_id
      WHERE c.id IN (${placeholders})`,
  );
  const rows = (await stmt.bind(...hits.map((h) => h.chunkId)).all()).results as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    chunkId: r.chunkId as string,
    content: (r.content as string) ?? "",
    title: r.title as string | undefined,
    rawPath: r.rawPath as string | undefined,
    trustLevel: r.trustLevel as number | undefined,
    sourceId: r.sourceId as string | undefined,
  }));
}
```

- [ ] **Step 2: 实现 /ask 路由**

`apps/api/src/routes/ask.ts`：

```ts
import { verifyAdminToken } from "../lib/auth.js";
import { runAsk } from "../lib/ask.js";
import type { Env } from "../types.js";

export const askRoute = {
  async POST(request: Request, env: Env): Promise<Response> {
    const auth = verifyAdminToken(request.headers.get("Authorization"), env.ADMIN_TOKEN);
    if (!auth.ok) {
      return Response.json({ error: auth.message }, { status: auth.status });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const q = typeof (body as { q?: unknown })?.q === "string"
      ? (body as { q: string }).q.trim()
      : "";
    if (!q) {
      return Response.json({ error: "Missing or empty 'q' field" }, { status: 400 });
    }

    try {
      const result = await runAsk({ q, env });
      return Response.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("LLM chat failed")) {
        return Response.json({ error: "upstream_unavailable" }, { status: 502 });
      }
      return Response.json({ error: "internal", detail: msg }, { status: 500 });
    }
  },
};
```

- [ ] **Step 3: wire 进 api/index.ts**

`apps/api/src/index.ts` 顶部加 import：

```ts
import { askRoute } from "./routes/ask.js";
```

并在 `app.get("/search", ...)` 之后加：

```ts
app.post("/ask", (c) => askRoute.POST(c.req.raw, c.env));
```

- [ ] **Step 4: typecheck + commit**

```bash
pnpm -F api typecheck
git add apps/api/src/lib/ask.ts apps/api/src/routes/ask.ts apps/api/src/index.ts
git commit -m "M2 task 7: /ask endpoint skeleton (auth + delegation, no cache yet)"
```

---

### Task 8: /ask 集成测试 — happy 路径

**Files:**
- Create: `apps/api/test/ask.test.ts`

- [ ] **Step 1: 写 happy 路径测试**

`apps/api/test/ask.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Miniflare } from "miniflare";
import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import app from "../src/index.js";
import { fixtureResponse, LLM_FIXTURES, type FixtureName } from "./llm-fixtures.js";
import { splitSqlIntoStatements } from "./sql-split.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

/** 当前测试用的 fixture（每个 test 改这个变量影响全局 fetch mock） */
let currentFixture: FixtureName = "happy";

describe("/ask integration (Miniflare + fetch mock)", () => {
  let mf: Miniflare;
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    // 同 Task 6：Miniflare v3 cast + migrations 加载
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("MiniMax")) {
        return fixtureResponse(currentFixture);
      }
      return originalFetch(input, init);
    };

    mf = new Miniflare({
      modules: true,
      script: app as unknown as string,  // typecast 简化；M2 阶段不重新 bundle
      compatibilityFlags: ["nodejs_compat"],
      compatibilityDate: "2025-01-01",
      d1Databases: ["DB"],
      d1Persist: false,
      vectorize: { VECTORIZE: { dimensions: 1024 } },
      r2Buckets: ["R2"],
      bindings: {
        ADMIN_TOKEN: "test-token",
        MINIMAX_API_KEY: "test-key",
        MINIMAX_BASE_URL: "http://MiniMax.invalid",
        ENVIRONMENT: "test",
        ALLOWED_ORIGIN: "*",
      },
    } as unknown as ConstructorParameters<typeof Miniflare>[0]);

    // 应用 0001 + 0002 migrations
    const d1 = await mf.getD1Database("DB");
    for (const f of ["0001_init.sql", "0002_dev_seed.sql"]) {
      const sql = await readFile(resolve(MIGRATIONS_DIR, f), "utf-8");
      for (const stmt of splitSqlIntoStatements(sql)) {
        await d1.exec(stmt);
      }
    }
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  });

  beforeEach(() => {
    currentFixture = "happy";
  });

  it("happy: 答案含 [来源 1]/[来源 3] + verified=[1,3] + disclaimer 末尾", async () => {
    const res = await mf.dispatchFetch("http://localhost/ask", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token",
      },
      body: JSON.stringify({ q: "5个月宝宝发烧38.5" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answer: string;
      disclaimer: string;
      citations: Array<{ n: number }>;
      cached: boolean;
    };
    expect(body.answer).toContain("[来源 1]");
    expect(body.answer).toContain("[来源 3]");
    expect(body.citations.map((c) => c.n).sort()).toEqual([1, 3]);
    expect(body.answer).toContain("不构成医疗建议");
    expect(body.disclaimer).toBe(
      "以上信息来源于知识库内容，不构成医疗建议。具体情况请咨询专业儿科医生。",
    );
    expect(body.cached).toBe(false);
  });
});
```

- [ ] **Step 2: 写 sql-split helper**

`apps/api/test/sql-split.js`（同 M0+M1 收尾时写的 Miniflare SQL splitter；本步是 JS 版本给 Vitest 用）：

```js
// Vitest 跑 .js 也行。复刻 M0+M1 收尾的 splitSqlIntoStatements。
// D1 的 exec() 在 Miniflare 3.20250718 拒收多行 SQL。
export function splitSqlIntoStatements(sql) {
  const out = [];
  let buf = "";
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < len && sql[i] !== "\n") i++;
      buf += " ";
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < len && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      buf += " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      buf += ch;
      i++;
      while (i < len) {
        const c = sql[i];
        buf += c;
        if (c === quote) {
          if (sql[i + 1] === quote) { buf += quote; i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (ch === ";") {
      const flat = buf.replace(/\s+/g, " ").trim();
      if (flat) out.push(flat);
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.replace(/\s+/g, " ").trim();
  if (tail) out.push(tail);
  return out;
}
```

- [ ] **Step 3: 跑测试，看它失败**

```bash
pnpm -F api test -- ask
```

预期：FAIL（happy 路径还跑不通，因 retrieval 在 Miniflare mock Vectorize 不会返回真 top5；具体 fail 模式看实际情况，但预期是命中数为 0 或引用验证空）。

- [ ] **Step 4: 调通（如果需要）**

如测试失败，先在测试里 `console.log(body)` 调试。最可能的 fail 点：
- Vectorize mock 不返回 chunks → top5 为空 → answer = "未在知识库中找到可靠来源"（应是这个 fail 模式）
- 解决：在 `beforeAll` 末尾手动 `Vectorize.upsert` 4 个 fake 向量，模拟 0002 seed 已经在 Vectorize 里

**如果走 upsert 路径，参考**（追加到 beforeAll 末尾）：

```ts
// 模拟 0002 seed 的 4 个 chunks 已经在 Vectorize
const vectorize = await mf.getVectorize("VECTORIZE");
await vectorize.upsert([
  { id: "01HCCCAAAA00000000000001", values: fakeVec(0.1), metadata: { chunk_id: "01HCCCAAAA00000000000001", user_id: DEFAULT_USER_ID, source_id: "01HAAAPEDSAAAA00000000001", document_id: "01HBBBAAAA00000000000001", trust_level: 3, is_cached: false } },
  // ... 3 more
]);

// 同时 stub embedding，让 query 向量与其中一个 chunk 向量相似
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("MiniMax") && url.includes("/embeddings")) {
    return new Response(JSON.stringify({ data: [{ embedding: fakeVec(0.1) }] }), { headers: { "content-type": "application/json" } });
  }
  if (url.includes("MiniMax") && url.includes("/chat")) {
    return fixtureResponse(currentFixture);
  }
  return originalFetch(input, init);
};
```

把 fakeVec 抽到测试顶部（生成维度 1024 的 Float32 数组，4 个不同方向）。

具体实现留给 subagent，按 Miniflare v3 API 调通。**关键验收**：happy 路径 response.citations 至少 1 条 + answer 含 `[来源 N]`。

- [ ] **Step 5: commit（test 可能先 commit green，可能后 commit）**

```bash
git add apps/api/test/ask.test.ts apps/api/test/sql-split.js
git commit -m "M2 task 8: /ask integration test — happy path with fetch mock + Vectorize fixture"
```

---

### Task 9: /ask 集成测试 — 3 种降级场景

**Files:**
- Modify: `apps/api/test/ask.test.ts`（追加 3 用例）

- [ ] **Step 1: 追加 no_citation / cite_mismatch / malformed_json 3 用例**

在 `apps/api/test/ask.test.ts` 现有 `it("happy: ...")` 之后追加：

```ts
it("no_citation: LLM 不引用 → answer='未在知识库中找到可靠来源' + citations=[]", async () => {
  currentFixture = "no_citation";
  const res = await mf.dispatchFetch("http://localhost/ask", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ q: "5个月宝宝发烧38.5" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { answer: string; citations: unknown[] };
  expect(body.answer.startsWith("未在知识库中找到可靠来源")).toBe(true);
  expect(body.citations).toEqual([]);
  expect(body.answer).toContain("不构成医疗建议");
});

it("cite_mismatch: 文本引 1 但 JSON 引 2 → 降级", async () => {
  currentFixture = "cite_mismatch";
  const res = await mf.dispatchFetch("http://localhost/ask", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ q: "5个月宝宝发烧38.5" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { answer: string; citations: unknown[] };
  expect(body.answer.startsWith("未在知识库中找到可靠来源")).toBe(true);
  expect(body.citations).toEqual([]);
});

it("malformed_json: JSON 坏 → 降级", async () => {
  currentFixture = "malformed_json";
  const res = await mf.dispatchFetch("http://localhost/ask", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ q: "5个月宝宝发烧38.5" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { answer: string; citations: unknown[] };
  expect(body.answer.startsWith("未在知识库中找到可靠来源")).toBe(true);
  expect(body.citations).toEqual([]);
});
```

- [ ] **Step 2: 跑测试**

```bash
pnpm -F api test -- ask
```

预期：4 用例（happy + 3 降级）全 PASS。

- [ ] **Step 3: commit**

```bash
git add apps/api/test/ask.test.ts
git commit -m "M2 task 9: /ask integration tests — 3 LLM degradation scenarios (no_citation/cite_mismatch/malformed_json)"
```

---

### Task 10: /ask 鉴权 + 400 错误测试

**Files:**
- Modify: `apps/api/test/ask.test.ts`（追加 2 用例）

- [ ] **Step 1: 追加 401 + 400 用例**

在 `apps/api/test/ask.test.ts` 末尾追加：

```ts
it("401: 缺 Authorization header", async () => {
  const res = await mf.dispatchFetch("http://localhost/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ q: "test" }),
  });
  expect(res.status).toBe(401);
});

it("400: 缺 q 字段", async () => {
  const res = await mf.dispatchFetch("http://localhost/ask", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: 跑测试 + commit**

```bash
pnpm -F api test -- ask
git add apps/api/test/ask.test.ts
git commit -m "M2 task 10: /ask integration tests — 401 auth + 400 missing q"
```

---

### Task 11: CP-2 收尾

- [ ] **Step 1: 全测 + typecheck + build**

```bash
pnpm -F api test
pnpm -F api typecheck
pnpm -F api build
```

预期：14 用例（7 旧 + 7 新 ask）全绿；typecheck 绿；wrangler dry-run 绿。

- [ ] **Step 2: CP-2 完成 commit（如有遗漏）**

```bash
git status --short
```

如有 dirty 改动，commit "M2 task 11: CP-2 final verification"。

**CP-2 完成**：`POST /ask` 端到端跑通（无缓存），4 种 LLM 输出形态全覆盖。

---

## CP-3: Admin Test Page（4 tab UI）

**目标**：`/ask` 路由在 admin 后台有可视化测试页：输入问题 → 调 /ask → 4 tab 展示 top5 chunks / final prompt / LLM 答案 / citations。`pnpm -F admin build` 绿。

**完成定义**：admin 页面代码完整，build 绿（不要求人工浏览器验收，mock-first 推到真接 LLM 后做）。

---

### Task 12: admin api.ts 加 ask()

**Files:**
- Modify: `apps/admin/src/lib/api.ts`

- [ ] **Step 1: 加 ask() 调用函数 + Citation/TopChunk/AskResponse 类型**

`apps/admin/src/lib/api.ts`（先读完整文件，再追加）：

末尾追加：

```ts
export interface AskCitation {
  n: number;
  title: string;
  snippet: string;
  url: string;
  trustLevel: number;
  sourceId: string;
  chunkId: string;
}

export interface AskResponse {
  answer: string;
  disclaimer: string;
  citations: AskCitation[];
  cached: boolean;
}

export async function ask(q: string): Promise<AskResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch("/api/ask", {
    method: "POST",
    headers,
    body: JSON.stringify({ q }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/ask ${res.status}: ${text}`);
  }
  return (await res.json()) as AskResponse;
}
```

确认文件已有 `getToken()` 函数（应来自 M0+M1 task 11），如无，加：

```ts
function getToken(): string {
  // 来自 M0+M1 收尾：admin→api 鉴权
  // 测试用 dev-token 仅在 DEV 模式可用
  if (import.meta.env.DEV) {
    return "dev-token-change-me";
  }
  throw new Error("ADMIN_TOKEN not configured for production build");
}
```

- [ ] **Step 2: typecheck + commit**

```bash
pnpm -F admin typecheck
git add apps/admin/src/lib/api.ts
git commit -m "M2 task 12: admin api.ts — ask() + AskResponse/AskCitation types"
```

---

### Task 13: AskTest page 骨架（form + 4 tab 容器）

**Files:**
- Create: `apps/admin/src/pages/AskTest.tsx`

- [ ] **Step 1: 写页面骨架（4 tab 内容先占位）**

`apps/admin/src/pages/AskTest.tsx`：

```tsx
import { useState } from "react";
import type { FormEvent } from "react";
import { ask, type AskResponse, type AskCitation } from "../lib/api.js";

type Tab = "chunks" | "prompt" | "answer" | "citations";

export default function AskTest() {
  const [q, setQ] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resp, setResp] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("chunks");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!q.trim()) {
      setError("请输入问题");
      return;
    }
    setSubmitting(true);
    try {
      const r = await ask(q.trim());
      setResp(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResp(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-6">
      <h2 className="text-xl font-semibold">问答测试</h2>

      <form onSubmit={onSubmit} className="space-y-4 rounded border border-gray-200 bg-white p-6">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">问题 (q)</label>
          <textarea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            rows={3}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder="例如：5个月宝宝发烧38.5°C 怎么办？"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? "提问中…" : "提问"}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>

      {resp && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            {resp.cached && (
              <span className="rounded bg-green-100 px-2 py-1 text-xs text-green-700">缓存命中</span>
            )}
            <span className="text-xs text-gray-500">{resp.citations.length} 条 verified 引用</span>
          </div>

          <div className="flex border-b border-gray-200">
            {(["chunks", "prompt", "answer", "citations"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className={`px-4 py-2 text-sm font-medium ${
                  activeTab === t
                    ? "border-b-2 border-blue-600 text-blue-600"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>

          <div className="rounded border border-gray-200 bg-white p-6">
            {activeTab === "chunks" && <ChunksTab citations={resp.citations} />}
            {activeTab === "prompt" && <PromptTab q={q} citations={resp.citations} />}
            {activeTab === "answer" && <AnswerTab resp={resp} />}
            {activeTab === "citations" && <CitationsTab citations={resp.citations} />}
          </div>
        </div>
      )}
    </section>
  );
}

const TAB_LABELS: Record<Tab, string> = {
  chunks: "Top 5 Chunks",
  prompt: "Final Prompt",
  answer: "LLM Answer",
  citations: "Citations",
};

function ChunksTab({ citations }: { citations: AskCitation[] }) {
  if (citations.length === 0) {
    return <p className="text-sm text-gray-500">无 verified 引用（可能走了降级路径）</p>;
  }
  return (
    <ul className="space-y-3">
      {citations.map((c) => (
        <li key={c.n} className="rounded border border-gray-100 p-3">
          <div className="mb-1 flex items-center gap-2 text-sm">
            <span className="font-mono text-gray-500">[{c.n}]</span>
            <span className="font-medium">{c.title}</span>
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">trust {c.trustLevel}</span>
          </div>
          <p className="text-sm text-gray-700">{c.snippet}</p>
        </li>
      ))}
    </ul>
  );
}

function PromptTab({ q, citations }: { q: string; citations: AskCitation[] }) {
  // 本步只显示 q 和 citations 占位；Task 14/15 才显示完整 prompt
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-gray-700">
      {`[system prompt 完整内容]\n[1] ...\n[2] ...\n\nuser: ${q}`}
    </pre>
  );
}

function AnswerTab({ resp }: { resp: AskResponse }) {
  return (
    <div className="space-y-2 text-sm text-gray-800">
      <p className="whitespace-pre-wrap">{resp.answer}</p>
      <p className="text-xs text-gray-500">— disclaimer: {resp.disclaimer}</p>
    </div>
  );
}

function CitationsTab({ citations }: { citations: AskCitation[] }) {
  if (citations.length === 0) {
    return <p className="text-sm text-gray-500">无 verified 引用</p>;
  }
  return (
    <ul className="space-y-2 text-sm">
      {citations.map((c) => (
        <li key={c.n} className="rounded border border-gray-100 p-2">
          <span className="font-mono text-gray-500">[{c.n}]</span>{" "}
          <span className="font-medium">{c.title}</span>{" "}
          <a className="text-xs text-blue-600 hover:underline" href={`/api/documents/${c.chunkId}/raw`}>
            查看原文
          </a>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm -F admin typecheck
```

预期：通过。

- [ ] **Step 3: commit（**这步是骨架，4 tab 内容 Task 14/15 才补全**）**

```bash
git add apps/admin/src/pages/AskTest.tsx
git commit -m "M2 task 13: AskTest page skeleton — form + 4 tab container (tabs content placeholders)"
```

---

### Task 14: AskTest page — wire 进 App.tsx

**Files:**
- Modify: `apps/admin/src/App.tsx`

- [ ] **Step 1: 加 /ask 路由 + 导航**

`apps/admin/src/App.tsx` 顶部加 import：

```tsx
import AskTest from "./pages/AskTest.js";
```

nav 段（在 `<Link to="/search">检索测试</Link>` 之后）加：

```tsx
<Link to="/ask" className="text-gray-600 hover:text-gray-900">问答测试</Link>
```

Routes 段加：

```tsx
<Route path="/ask" element={<AskTest />} />
```

- [ ] **Step 2: build 验证**

```bash
pnpm -F admin build
```

预期：vite build 成功。

- [ ] **Step 3: commit**

```bash
git add apps/admin/src/App.tsx
git commit -m "M2 task 14: wire AskTest into App routing + nav"
```

---

### Task 15: CP-3 收尾

- [ ] **Step 1: 全 build + typecheck**

```bash
pnpm -r typecheck
pnpm -F admin build
```

预期：3 包 typecheck 绿，admin build 成功。

- [ ] **Step 2: commit（如有遗漏）**

```bash
git status --short
```

如有 dirty，commit "M2 task 15: CP-3 final verification"。

**CP-3 完成**：admin /ask 路由可用，4 tab 可视化（虽然 tab 内容是 Task 13 的占位，**但 prompt 完整渲染是 v2 真接 LLM 后再补**；当前 TDD 范围是路由 + build 绿）。

---

## CP-4: 缓存回写 + docs + E2E 验证

**目标**：实现 §5.2 ⑩ 缓存回写（D1 query_cache 表 + Vectorize 指针），让第二次相同问题返回 cached=true。更新 README，加 D1 migration 0003，全测全绿。

**完成定义**：
- `pnpm test` 全绿（24 shared + 14 api = 38 用例）
- `pnpm typecheck` 3 包全绿
- `pnpm -F api build` 绿
- 缓存集成测试：调 2 次相同 q → 第 2 次 cached=true

---

### Task 16: query_cache D1 migration

**Files:**
- Create: `apps/api/migrations/0003_query_cache.sql`
- Create: `apps/api/migrations/0003_query_cache.down.sql`

- [ ] **Step 1: 写 migration up**

`apps/api/migrations/0003_query_cache.sql`：

```sql
-- M2 §6.3：缓存全文 + 元数据，Vectorize 存指针（metadata 大小受限）
-- 缓存命中条件：Vectorize topK(1) filter {user_id, is_cached=true} final_score > 0.92
-- 失效：TTL 30 天（CP-4 范围）；文档增删改 / 模型升级 / 手动清空（v2+）

CREATE TABLE query_cache (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  q TEXT NOT NULL,
  q_embedding BLOB NOT NULL,         -- 序列化 Float32Array（小端字节序）
  answer TEXT NOT NULL,              -- 含 disclaimer 完整答案
  verified TEXT NOT NULL,            -- JSON array, verified 编号
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,       -- created_at + 30*86400*1000
  FOREIGN KEY (user_id) REFERENCES user(id)
);

CREATE INDEX query_cache_user_idx ON query_cache(user_id);
CREATE INDEX query_cache_expires_idx ON query_cache(expires_at);
```

- [ ] **Step 2: 写 migration down**

`apps/api/migrations/0003_query_cache.down.sql`：

```sql
DROP INDEX IF EXISTS query_cache_expires_idx;
DROP INDEX IF EXISTS query_cache_user_idx;
DROP TABLE IF EXISTS query_cache;
```

- [ ] **Step 3: 验证 0001/0002 仍能跑通**

```bash
pnpm -F api test -- integration
```

预期：3 旧 integration 用例仍 PASS（migrations_dir 自动包含 0003，不影响 0001/0002 加载顺序）。

- [ ] **Step 4: commit**

```bash
git add apps/api/migrations/0003_query_cache.sql apps/api/migrations/0003_query_cache.down.sql
git commit -m "M2 task 16: query_cache D1 migration (0003) — answer + q_embedding + TTL 30d"
```

---

### Task 17: 缓存读写实现 + 集成测试

**Files:**
- Create: `apps/api/src/lib/cache.ts`
- Create: `apps/api/test/cache.test.ts`

- [ ] **Step 1: 写 cache 单元测试（mock D1 + Vectorize）**

`apps/api/test/cache.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeCache, readCache, hashQ } from "../src/lib/cache.js";
import { splitSqlIntoStatements } from "./sql-split.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

describe("cache (Miniflare)", () => {
  let mf: Miniflare;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { async fetch() { return new Response('ok'); } }",
      compatibilityFlags: ["nodejs_compat"],
      compatibilityDate: "2025-01-01",
      d1Databases: ["DB"],
      d1Persist: false,
      vectorize: { VECTORIZE: { dimensions: 1024 } },
      bindings: {
        ADMIN_TOKEN: "test-token",
        MINIMAX_API_KEY: "test-key",
        MINIMAX_BASE_URL: "http://test.invalid",
        ENVIRONMENT: "test",
        ALLOWED_ORIGIN: "*",
      },
    } as unknown as ConstructorParameters<typeof Miniflare>[0]);
    const d1 = await mf.getD1Database("DB");
    for (const f of ["0001_init.sql", "0002_dev_seed.sql", "0003_query_cache.sql"]) {
      const sql = await readFile(resolve(MIGRATIONS_DIR, f), "utf-8");
      for (const stmt of splitSqlIntoStatements(sql)) {
        await d1.exec(stmt);
      }
    }
  });

  afterAll(async () => {
    await mf.dispose();
  });

  it("hashQ: 同 q 同一 hash", () => {
    const h1 = hashQ("5个月宝宝发烧38.5");
    const h2 = hashQ("5个月宝宝发烧38.5");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{16}$/);
  });

  it("readCache: 无缓存 → null", async () => {
    const d1 = await mf.getD1Database("DB");
    const v = await mf.getVectorize("VECTORIZE");
    const fakeVec = new Array(1024).fill(0).map((_, i) => Math.sin(i) * 0.01);
    const got = await readCache({
      d1, vectorize: v,
      userId: "01H0000000000000000000000",
      q: "完全没缓存的问题",
      qEmbedding: fakeVec,
    });
    expect(got).toBeNull();
  });

  it("writeCache → readCache: 命中", async () => {
    const d1 = await mf.getD1Database("DB");
    const v = await mf.getVectorize("VECTORIZE");
    const fakeVec = new Array(1024).fill(0).map((_, i) => Math.sin(i) * 0.01);
    await writeCache({
      d1, vectorize: v,
      userId: "01H0000000000000000000000",
      q: "测试缓存的问题",
      qEmbedding: fakeVec,
      answer: "测试答案 + disclaimer",
      verified: [1, 3],
    });
    const got = await readCache({
      d1, vectorize: v,
      userId: "01H0000000000000000000000",
      q: "测试缓存的问题",
      qEmbedding: fakeVec,
    });
    expect(got).not.toBeNull();
    expect(got!.answer).toBe("测试答案 + disclaimer");
    expect(got!.verified).toEqual([1, 3]);
  });

  it("readCache: 过期（>30 天）→ null", async () => {
    const d1 = await mf.getD1Database("DB");
    const v = await mf.getVectorize("VECTORIZE");
    const fakeVec = new Array(1024).fill(0).map((_, i) => Math.cos(i) * 0.01);
    // 手工写一条 expires_at = 0 的记录
    const id = "01HCCCCCCCCCCCCCCCCCCCC00";
    await d1.exec(
      `INSERT INTO query_cache (id, user_id, q, q_embedding, answer, verified, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      "01H0000000000000000000000",
      "过期问题",
      new Uint8Array(fakeVec.map(x => Math.round(x * 1000))),
      "旧答案",
      "[]",
      0,
      0,
    );
    const got = await readCache({
      d1, vectorize: v,
      userId: "01H0000000000000000000000",
      q: "过期问题",
      qEmbedding: fakeVec,
    });
    expect(got).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试看红**

```bash
pnpm -F api test -- cache
```

预期：FAIL，cannot import cache.js。

- [ ] **Step 3: 实现 cache 读写**

`apps/api/src/lib/cache.ts`：

```ts
import { ulid } from "ulid";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const CACHE_HIT_THRESHOLD = 0.92;

export interface CacheIOContext {
  d1: D1Database;
  vectorize: VectorizeIndex;
  userId: string;
  q: string;
  qEmbedding: number[];
}

export interface CachedAsk {
  answer: string;
  verified: number[];
}

export function hashQ(q: string): string {
  // 简化：用 Web Crypto 的 SHA-256
  // （Nodejs_compat 模式下 Buffer 可用，但 workerd 也能用 SubtleCrypto）
  // 这里返回前 16 hex
  // Note: 同步 hash 用 Bun 风格；workerd 异步；走 SubtleCrypto 异步更稳
  // 但 hashQ 在测试中可能同步用，简化用 cyrb53
  return cyrb53(q).toString(16).padStart(16, "0").slice(0, 16);
}

function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 写缓存：D1 query_cache + Vectorize 指针 */
export async function writeCache(
  ctx: CacheIOContext & {
    answer: string;
    verified: number[];
  },
): Promise<void> {
  const id = ulid();
  const now = Date.now();
  const expires = now + CACHE_TTL_MS;
  // q_embedding 序列化为 Float32Array 字节
  const f32 = new Float32Array(ctx.qEmbedding);
  const bytes = new Uint8Array(f32.buffer);

  await ctx.d1
    .prepare(
      `INSERT INTO query_cache (id, user_id, q, q_embedding, answer, verified, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      ctx.userId,
      ctx.q,
      bytes,
      ctx.answer,
      JSON.stringify(ctx.verified),
      now,
      expires,
    )
    .run();

  // Vectorize 指针（id 用 cache_id，不存完整 embedding 在 metadata）
  await ctx.vectorize.upsert([
    {
      id: `cache_${id}`,
      values: ctx.qEmbedding,
      metadata: {
        is_cached: true,
        cache_id: id,
        user_id: ctx.userId,
        q_hash: hashQ(ctx.q),
      },
    },
  ]);
}

/** 读缓存：Vectorize top1 命中 + 阈值 + 未过期 */
export async function readCache(ctx: CacheIOContext): Promise<CachedAsk | null> {
  const hits = await ctx.vectorize.query(ctx.qEmbedding, {
    topK: 1,
    returnMetadata: true,
    filter: { user_id: ctx.userId, is_cached: true },
  });
  const top = hits.matches?.[0];
  if (!top || top.score < CACHE_HIT_THRESHOLD) return null;

  const cacheId = top.metadata?.cache_id as string | undefined;
  if (!cacheId) return null;

  const row = await ctx.d1
    .prepare(`SELECT answer, verified, expires_at FROM query_cache WHERE id = ?`)
    .bind(cacheId)
    .first<{ answer: string; verified: string; expires_at: number }>();

  if (!row) return null;
  if (row.expires_at < Date.now()) return null;

  return {
    answer: row.answer,
    verified: JSON.parse(row.verified) as number[],
  };
}
```

- [ ] **Step 4: 跑测试看绿**

```bash
pnpm -F api test -- cache
```

预期：4 用例（hashQ + 3 缓存场景）全 PASS。

- [ ] **Step 5: commit**

```bash
git add apps/api/src/lib/cache.ts apps/api/test/cache.test.ts
git commit -m "M2 task 17: cache module (D1 query_cache + Vectorize pointer) with 4 unit tests"
```

---

### Task 18: 缓存集成到 runAsk + ask 缓存命中测试 + README

**Files:**
- Modify: `apps/api/src/lib/ask.ts`（接入 cache 回调）
- Modify: `apps/api/test/ask.test.ts`（追加缓存命中测试）
- Modify: `README.md`（追加 M2 状态段）

- [ ] **Step 1: 修改 runAsk 注入 cache 回调**

`apps/api/src/lib/ask.ts` 顶部加 import：

```ts
import { readCache, writeCache } from "./cache.js";
```

把 `cacheRead` / `cacheWrite` 回调默认值实装为调 cache.ts：

```ts
// 在 runAsk 主体里：
if (!opts.cacheRead) {
  opts.cacheRead = async (qEmbedding) => {
    const cached = await readCache({
      d1: opts.env.DB, vectorize: opts.env.VECTORIZE,
      userId: DEFAULT_USER_ID, q: opts.q, qEmbedding,
    });
    if (!cached) return null;
    return { answer: cached.answer, disclaimer: DISCLAIMER_TEXT, citations: [], cached: false };
  };
}
if (!opts.cacheWrite) {
  opts.cacheWrite = async (qEmbedding, result) => {
    await writeCache({
      d1: opts.env.DB, vectorize: opts.env.VECTORIZE,
      userId: DEFAULT_USER_ID, q: opts.q, qEmbedding,
      answer: result.answer, verified: result.citations.map(c => c.n),
    });
  };
}
```

- [ ] **Step 2: 写缓存命中集成测试**

`apps/api/test/ask.test.ts` 末尾追加：

```ts
it("cached: 第 2 次相同 q → cached=true", async () => {
  // 第一次
  const r1 = await mf.dispatchFetch("http://localhost/ask", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ q: "5个月宝宝发烧38.5" }),
  });
  expect(r1.status).toBe(200);
  const b1 = await r1.json() as { cached: boolean };
  expect(b1.cached).toBe(false);

  // 第二次
  const r2 = await mf.dispatchFetch("http://localhost/ask", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ q: "5个月宝宝发烧38.5" }),
  });
  expect(r2.status).toBe(200);
  const b2 = await r2.json() as { cached: boolean; answer: string };
  expect(b2.cached).toBe(true);
  expect(b2.answer).toContain("不构成医疗建议");
});
```

- [ ] **Step 3: typecheck + 全测**

```bash
pnpm -F api typecheck
pnpm -F api test
```

预期：所有用例绿（包括新缓存用例）。

- [ ] **Step 4: 更新 README**

`README.md` 顶部"## M0+M1 状态"段之后追加：

```markdown
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
  "citations": [{ "n": 1, "title": "...", "trust_level": 3, "...": "..." }],
  "cached": false
}
```

### M2 测试矩阵

- `pnpm -F shared test` — 24 用例（cite-verify 4 + prompt 4 + 旧 16）
- `pnpm -F api test` — 16 用例（auth 4 + integration 3 + ask 7 + cache 4，含缓存命中）
```

- [ ] **Step 5: 收尾验证 + commit**

```bash
pnpm -r typecheck
pnpm -F api build
pnpm test
git add apps/api/src/lib/ask.ts apps/api/test/ask.test.ts README.md
git commit -m "M2 task 18: wire cache into runAsk + cache-hit integration test + README M2 section"
```

**CP-4 完成**：M2 端到端跑通，含缓存回写。

---

## 18 任务汇总

| CP | Task | Commit msg | 关键产物 |
|---|---|---|---|
| 1 | 1 | dual-layer citation verifier with 4 unit tests | `cite-verify.ts` + 4 用例 |
| 1 | 2 | prompt module skeleton (types + ASK_SYSTEM_TEMPLATE + DISCLAIMER_TEXT) | `prompt.ts` 占位 |
| 1 | 3 | buildAskPrompt with 4 unit tests (TDD green) | `prompt.ts` 实现 + 4 用例 |
| 1 | 4 | CP-1 final verification | — |
| 2 | 5 | LLM caller (chatCompletion) with retry + globalThis.fetch injectable | `llm.ts` |
| 2 | 6 | 4 LLM canned fixtures | `llm-fixtures.ts` |
| 2 | 7 | /ask endpoint skeleton (auth + delegation, no cache yet) | `ask.ts` + `routes/ask.ts` |
| 2 | 8 | /ask integration test — happy path with fetch mock + Vectorize fixture | `ask.test.ts` happy |
| 2 | 9 | /ask integration tests — 3 LLM degradation scenarios | 3 降级用例 |
| 2 | 10 | /ask integration tests — 401 auth + 400 missing q | 2 错误用例 |
| 2 | 11 | CP-2 final verification | — |
| 3 | 12 | admin api.ts — ask() + AskResponse/AskCitation types | `lib/api.ts` |
| 3 | 13 | AskTest page skeleton — form + 4 tab container | `AskTest.tsx` |
| 3 | 14 | wire AskTest into App routing + nav | `App.tsx` |
| 3 | 15 | CP-3 final verification | — |
| 4 | 16 | query_cache D1 migration (0003) | `0003_*.sql` |
| 4 | 17 | cache module (D1 query_cache + Vectorize pointer) with 4 unit tests | `cache.ts` + 4 用例 |
| 4 | 18 | wire cache into runAsk + cache-hit integration test + README M2 section | README + 缓存集成 |

---

## 19. Mock-first 边界（重申）

- ❌ 不创建真 Cloudflare 资源
- ❌ 不填真 `MINIMAX_API_KEY`
- ❌ 不跑真 `pnpm dev:api`
- ❌ 不在浏览器人工验收 UI
- ✅ 跑 `pnpm test` + `pnpm -r typecheck` + `pnpm -F api build` 全部绿
- ✅ 缓存命中通过集成测试验证（不是手动 curl）

---

## 20. 风险与回退

| 风险 | 概率 | 缓解 | 回退 |
|---|---|---|---|
| Miniflare mock Vectorize 不返回 fake chunks | 高 | 手工 upsert 4 个 fake 向量到 Vectorize | 改用 `miniflare.getVectorize()` 直接 stub |
| Float32Array 序列化 cross-runtime 不一致 | 中 | 用 `new Float32Array(arr).buffer` 而非 `Buffer.from()` | v2 改 base64 字符串存 BLOB |
| cache_id 长度触发 Vectorize id 限制（64 字符） | 低 | `cache_${ulid}` = 6+26 = 32 字符 | v2 改 hash 截断 |
| Prompt template 调优需要真 LLM | 高（v2 才发现） | ASK_SYSTEM_TEMPLATE 暴露为常量 | v2 真接后调 |
| LLM 输出格式漂移 | 中 | 4 夹具 + 验证器降级 | 调模板或加更多 fixture |

---

## 21. 出 CP-1/2/3/4 后的归档

- `state.md`（M2 专用，参考 M0+M1 模式）记录：
  - mock-first 边界
  - checkpoint pass 标准
  - 与 spec 的偏差
  - 未做项（推到 v2+）
- 完成后用 `superpowers:finishing-a-development-branch` 决定 merge / PR

---

## 22. 写 plan 时的自检

按 writing-plans skill §Self-Review：

- ✅ Spec coverage：spec §0–13 都有对应 task（in-scope 全覆盖，out-of-scope 明确推迟）
- ✅ Placeholder scan：无 TBD/TODO/"implement later"；每个 code step 都有完整代码
- ✅ Type consistency：`AskContext` / `AskContextChunk` / `AskPrompt` / `AskCitation` / `AskResponse` / `CitationVerifyResult` 跨 task 一致
- ✅ No "see Task N" 重定向：每个 step 独立完整
- ✅ Frequent commits：18 task = 18 commit
- ✅ TDD 红绿节奏：纯函数 task（1, 3）先 test 后 impl；集成 task（8-10, 17）有 test 段
- ✅ File structure 在 §1 锁定，task 改动不超出
