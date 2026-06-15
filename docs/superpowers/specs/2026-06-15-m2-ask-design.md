# M2 Spec: /ask 端到端单轮问答

- **状态**：草稿，待用户复核
- **日期**：2026-06-15
- **目的**：把顶层 spec §5.2 / §3.1 / §6（/ask 部分）/ §7.2 test page 部分展开到可实现粒度
- **上层文档**：
  - 顶层架构 spec：`docs/superpowers/specs/2026-06-14-unequal-top-level-design.md`
  - Agent dispatch 协议：`docs/superpowers/specs/2026-06-15-agent-dispatch-protocol.md`
- **本 spec 不覆盖**：/chat、多轮、Durable Objects session（这些是 M6）

---

## 0. 范围（in / out）

### 0.1 in scope
- §5.2 读库侧全 10 步（缓存查 → embedding → topK=20 → 截断+加权 → prompt → LLM → 双层验证 → 免责声明 → 缓存回写）
- §3.1 双层引用验证 + 强制医疗免责声明
- §6 `POST /ask` 端点
- §7.2 admin test page：可视化命中 chunks / 最终 prompt / LLM 答案
- mock-first：LLM 走 `globalThis.fetch` mock，无真人操作

### 0.2 out of scope（推迟到 M3+ / M6）
- `POST /chat`（需要 Durable Objects session，M6）
- 微信小程序（M3）
- 抓取（M4-M5）
- 真鉴权、多用户（M6）
- 抓取调度、信源自动评级、答案质量反馈、知识库自动 invalidate 缓存（v2+）

---

## 1. 数据流（§5.2 实例化）

```
POST /ask { q: "5个月宝宝发烧38.5°C 怎么办？" }
  ↓
  ① 缓存查：Vectorize.topK(1) filter {user_id, is_cached=true}
     final_score > 0.92 → 直接返回缓存
  ↓ miss
  ② embedding(q) → v
  ↓ (复用 M0+M1 packages/shared/embed.ts, mock MiniMax)
  ③ Vectorize.query(v, topK=20, filter={user_id, trust_level: {$gte: 0}})
  ↓
  ④ rerank: MVP 跳过
  ↓
  ⑤ 截断 topK=5，trust_level 加权（1.0/1.0/1.1/1.3），重新排序 → 编号 [1]..[5]
  ↓
  ⑥ 拼 prompt（见 §3）
  ↓
  ⑦ MiniMax chat completion（mock via globalThis.fetch，见 §4）
  ↓
  ⑧ verifyCitations(answer) → verified: number[]（见 §5）
  ↓ verified.length === 0
  ⑨ 降级：answer = "未在知识库中找到可靠来源"
  ⑨ 强制追加医疗免责声明（应用层做，dedup LLM 写的）
  ↓
  ⑩ Vectorize.upsert {q, v, answer (with disclaimer), verified, is_cached=true, q_embedding=v}
  ↓
返回 { answer, disclaimer, citations: [...], cached: false }
```

---

## 2. 接口契约

### 2.1 `POST /ask`

**Request**:
```json
{
  "q": "5个月宝宝发烧38.5°C 怎么办？"
}
```

**Response (200 happy)**:
```json
{
  "answer": "5个月宝宝腋温 38.5°C 建议先... [来源 1] [来源 3]\n\n以上信息来源于知识库内容，不构成医疗建议。具体情况请咨询专业儿科医生。",
  "disclaimer": "以上信息来源于知识库内容，不构成医疗建议。具体情况请咨询专业儿科医生。",
  "citations": [
    {
      "n": 1,
      "title": "美国儿科学会育儿百科（第7版）节选",
      "snippet": "三个月以下婴儿发烧应立即就医。3-6 个月婴儿体温超过 38.5℃建议...",
      "url": "raw/01H0000000000000000000000/dev-seed/aap-fever.pdf",
      "trust_level": 3,
      "source_id": "01HAAAPEDSAAAA00000000001",
      "chunk_id": "01HCCCAAAA00000000000001"
    },
    { "n": 3, "...": "..." }
  ],
  "cached": false
}
```

**Response (200 empty)**: 走降级路径，`answer` = "未在知识库中找到可靠来源" + disclaimer + `citations: []`。

**Error**:
- 400: 缺 `q` 字段 / `q` 为空
- 401: ADMIN_TOKEN 缺失或不匹配
- 502: MiniMax chat 调用 3 次重试后仍失败 → `{ "error": "upstream_unavailable" }`
- 500: 其他内部错误

### 2.2 鉴权

复用 M0+M1 的 `requireAdmin` 中间件（apps/api/src/middleware/auth.ts）。`/ask` 必须带 `Authorization: Bearer ${ADMIN_TOKEN}`。

---

## 3. Prompt 格式

`packages/shared/src/prompt.ts` 的 `buildAskPrompt(q, top5: ScoredChunk[]): { system: string; user: string }`。

### 3.1 system prompt

```
你是"不等号"——一个个人育儿知识库助手。

【硬约束】
1. 你的回答必须严格基于下方"参考资料"中给出的内容。不得使用任何不在参考资料里的常识、训练知识或推断。
2. 引用资料时用 [来源 N] 格式（N 对应下方编号 1..5）。正文里只允许使用 [来源 N] 形式，不要在引用处写文档名、URL、章节号等。
3. 答案末尾必须且只能输出一个 JSON 块，格式严格为 {"citations": [N, M, ...]}，其中 N, M 是你正文里实际写过的 [来源 N] 编号。不得多写，不得少写。
4. 如果参考资料里没有这个问题的答案，必须在答案正文中明确写"未在知识库中找到可靠来源"，并且 JSON 块的 citations 为 []。
5. 不要补全、不要兜底、不要给"一般来说"式的常识补充。资料没写就是没写。

【参考资料】
[1] 《{title}》/ "{chunk snippet 前 100 字}..." (信源等级: {trust_label})
[2] 《{title}》/ "..." (信源等级: {trust_label})
... (省略，到 5)
```

### 3.2 user prompt

```
{q}
```

### 3.3 trust_label 映射

```ts
const TRUST_LABELS: Record<0|1|2|3, string> = {
  0: "未评级",
  1: "一般",
  2: "可信",
  3: "权威",
};
```

### 3.4 prompt 模板可配置（留口子）

`packages/shared/src/prompt.ts` 暴露 `ASK_SYSTEM_TEMPLATE: string` 常量，**不**把字符串硬编码在 `buildAskPrompt` 内部。后续真接 MiniMax 时可调优。

---

## 4. LLM 调用与 mock

### 4.1 LLM caller

`apps/api/src/lib/llm.ts` 暴露 `chatCompletion(system: string, user: string, env: Env): Promise<string>`。

实现：直接调 `fetch(env.MINIMAX_BASE_URL + "/v1/chat/completions", {...})`，解析 OpenAI 兼容响应取 `choices[0].message.content`。**无任何特殊封装**——mock 简单，bug 面积小。

### 4.2 Mock 策略

`apps/api/test/fixtures/llm-responses.ts` 暴露 4 个 canned response：

| 名称 | 模拟场景 | response |
|---|---|---|
| `happy` | 正常引用 | `5个月宝宝腋温 38.5°C 建议先 [来源 1] [来源 3]\n\n{"citations":[1,3]}` |
| `no_citation` | LLM 不引用 | `5个月宝宝发烧应该... 多喝水...\n\n{"citations":[]}` |
| `cite_mismatch` | 文本引 1，JSON 引 2 | `... [来源 1] ...\n\n{"citations":[2]}` |
| `malformed_json` | JSON 格式坏 | `... [来源 1] ...\n\n{not valid json}` |

### 4.3 Mock 注入点

`apps/api/test/setup.ts`（或 `integration.test.ts` 的 `beforeAll`）：

```ts
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.startsWith(env.MINIMAX_BASE_URL)) {
    // 根据测试场景返回不同 canned
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: currentFixtureContent } }],
    }), { headers: { "content-type": "application/json" } });
  }
  return originalFetch(input, init);
};
```

集成测试中通过 `currentFixtureContent` 变量切换 4 种 canned。`afterAll` 恢复 `globalThis.fetch`。

### 4.4 Mock 边界

- embedding 端：M0+M1 已 mock（不调真 MiniMax）
- chat 端：本 spec 引入 fetch mock
- Vectorize / D1 / R2：Miniflare 自带

---

## 5. 双层引用验证

### 5.1 算法

`packages/shared/src/cite-verify.ts`：

```ts
export interface CitationVerifyResult {
  textCitations: number[];   // 文本里所有 [来源 N] 的 N（去重保序）
  jsonCitations: number[];   // 末尾 JSON 块里 citations 数组的 N
  verified: number[];        // 交集，按 textCitations 顺序
  malformed: boolean;        // JSON 块存在但解析失败
}

export function verifyCitations(answer: string): CitationVerifyResult {
  // 1. 解析正文里所有 [来源 N]
  const textCitations = [...new Set(
    [...answer.matchAll(/\[来源\s*(\d+)\]/g)]
      .map(m => parseInt(m[1], 10))
      .filter(n => n >= 1 && n <= 5)  // 限定在 top5 范围内
  )];

  // 2. 解析末尾 {"citations": [...]} 块（要求是答案末尾）
  const jsonMatch = answer.match(/\{"citations":\s*\[([^\]]*)\]\}\s*$/);
  let jsonCitations: number[] = [];
  let malformed = false;
  if (jsonMatch) {
    const inner = jsonMatch[1].trim();
    if (inner === "") {
      jsonCitations = [];
    } else {
      try {
        const parsed = JSON.parse(`[${inner}]`);
        jsonCitations = parsed
          .filter((x: unknown) => typeof x === "number" && Number.isInteger(x))
          .filter(n => n >= 1 && n <= 5);
      } catch {
        malformed = true;
      }
    }
  } else if (/\{"citations":/.test(answer)) {
    // 有 "citations" 关键字但格式坏
    malformed = true;
  }

  // 3. 交集：保 textCitations 顺序，去重
  const verified = textCitations.filter(n => jsonCitations.includes(n));

  return { textCitations, jsonCitations, verified, malformed };
}
```

**约束**：
- 编号限定 `1..5`（top5 范围），防止 LLM 幻觉写 6/7/100
- JSON 块必须出现在答案**末尾**（`$` 锚定），防止 LLM 把块写到中间
- 解析失败（malformed）→ 视为 no citation → 降级

### 5.2 单元测试（`packages/shared/test/cite-verify.test.ts`，4 用例）

- `verifyCitations("... [来源 1] ... [来源 3] ...\n\n{\"citations\":[1,3]}")` → verified=[1,3]
- `verifyCitations("... [来源 1] ...\n\n{\"citations\":[2]}")` → verified=[]（cite_mismatch 场景）
- `verifyCitations("... [来源 1] ...\n\n{not valid}")` → verified=[], malformed=true
- `verifyCitations("... [来源 100] ...\n\n{\"citations\":[100]}")` → verified=[]（越界）

### 5.3 应用层组装

`apps/api/src/lib/ask.ts` 的 `runAsk(q, env)` 函数伪代码：

```ts
const top5 = await retrieveTop5(q, env);
const prompt = buildAskPrompt(q, top5);
const rawAnswer = await chatCompletion(prompt.system, prompt.user, env);

const { verified, textCitations, malformed } = verifyCitations(rawAnswer);

let answer: string;
let citations: Citation[] = [];
if (verified.length === 0) {
  // 降级
  answer = "未在知识库中找到可靠来源";
} else {
  // 截掉原文末尾的 JSON 块，保留正文
  const jsonMatch = rawAnswer.match(/\{[^{}]*"citations"[^{}]*\}\s*$/);
  const textOnly = jsonMatch
    ? rawAnswer.slice(0, jsonMatch.index).trimEnd()
    : rawAnswer;
  answer = textOnly;
  citations = verified.map(n => buildCitation(n, top5[n - 1]));
}

// 追加 disclaimer（dedup LLM 写的）
const disclaimer = DISCLAIMER_TEXT;
if (!answer.includes(DISCLAIMER_TEXT)) {
  answer = `${answer}\n\n${disclaimer}`;
}

// 缓存回写（仅当 verified.length > 0）
if (verified.length > 0) {
  await writeCache(q, qEmbedding, answer, verified, env);
}

return { answer, disclaimer, citations, cached: false };
```

---

## 6. 缓存策略

### 6.1 缓存写入（§5.2 ⑩）

- 调 `Vectorize.upsert([{ id: hash(q), values: qEmbedding, metadata: { is_cached: true, q, answer, verified, created_at } }])`
- 命中条件：`Vectorize.query(qEmbedding, topK=1, filter={user_id, is_cached=true})` 的 top1 `final_score > 0.92`

### 6.2 缓存失效（§5.4）

**M2 范围**：
- ✅ TTL 30 天：每次读缓存检查 `Date.now() - created_at > 30*86400*1000` → 视为 miss
- ❌ 文档增删改失效（v2+ 补 admin UI 触发）
- ❌ MiniMax 模型升级全局清空（v2+ 配 admin 设置项）
- ❌ 用户手动清空（v2+ 补 admin UI 按钮）

### 6.3 缓存存储格式

Vectorize metadata 不能存 answer 全文（Vectorize metadata 字段有大小限制，约 8KB；超出报 runtime error）。M2 方案：answer 存 D1 新表 `query_cache`，Vectorize 只存 `cache_id` 指针。

```sql
CREATE TABLE query_cache (
  id TEXT PRIMARY KEY,           -- ULID
  user_id TEXT NOT NULL,
  q TEXT NOT NULL,               -- 原始问题
  q_embedding BLOB,              -- 序列化 Float32Array
  answer TEXT NOT NULL,          -- 含 disclaimer 完整答案
  verified TEXT NOT NULL,        -- JSON array, verified 编号
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,   -- created_at + 30d
  FOREIGN KEY (user_id) REFERENCES user(id)
);
```

Vectorize metadata：
```ts
{
  is_cached: true,
  cache_id: "<ULID>",
  q_hash: "<sha256(q) 前 16 hex>",
  user_id,
  trust_level: <max in top5>,  // 冗余，便于按信源过滤
}
```

**为什么用 D1 + Vectorize 双存储**：Vectorize 向量查得快，但 metadata 大小受限；D1 存全文 + 元数据，Vectorize 只存指针和元数据索引。

### 6.4 不在 M2 范围

- 缓存命中率统计
- 缓存预热
- 跨用户共享缓存（永远 per-user_id 隔离）

---

## 7. Admin Test Page

`apps/admin/src/pages/test/index.tsx`（沿用 M0+M1 Pages 路由约定）：

### 7.1 UX 流程

1. 用户输入问题 → 点"提问"
2. POST `/ask`（带 ADMIN_TOKEN）
3. 页面展示 4 个 tab：
   - **Top 5 Chunks**：列表，每条显示 title、trust 图标、content 摘要、vectorize_score
   - **Final Prompt**：system + user 全文，可折叠可复制
   - **LLM Answer**：含/不含 disclaimer 可切换显示；verified 引用标黄，未 verified 标红
   - **Citations**：每条 verified 引用显示 title、snippet、url、trust_level

### 7.2 验证用 UI 细节

- 答案中所有 `[来源 N]` 文本：verified 的标绿色，textCitations 但未 verified 的标橙色（提示 LLM 输出不一致），未在 textCitations 出现的标灰色
- 缓存命中时显示 `cached: true` 徽标

### 7.3 M2 不做

- 多轮（/chat）UI
- 抓取任务 UI
- 信源管理 UI
- 文档管理 UI

---

## 8. 测试矩阵

### 8.1 单元测试（`packages/shared/test/`）

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `prompt.test.ts` | 4 | top5 → system 文本格式、trust label、user 拼接、空 top5 降级 |
| `cite-verify.test.ts` | 4 | 见 §5.2 |
| 已有 | 16 | M0+M1 留下的，不动 |

### 8.2 集成测试（`apps/api/test/integration.test.ts` 扩 3 用例）

- `/ask` happy（mock `happy` fixture）→ 200 + 答案含 `[来源 1]` + verified=[1] + disclaimer 末尾
- `/ask` no_citation（mock `no_citation`）→ 200 + 答案 = 降级文本 + verified=[] + disclaimer 末尾
- `/ask` malformed_json（mock `malformed_json`）→ 200 + 降级 + verified=[] + malformed=true
- 缓存命中：调 2 次相同 q → 第 2 次 response.cached=true
- 401 鉴权失败：缺 token → 401
- 400 缺 q 字段 → 400

### 8.3 端到端验证（CP-4）

- `pnpm dev:api` + `pnpm dev:admin`
- admin /test 输入问题 → 看 4 tab 输出符合预期
- 输入 0002 seed 不覆盖的问题（如"如何培养宝宝睡眠习惯"）→ 看到降级路径

---

## 9. CP 划分与任务计数

| CP | 内容 | 任务数 | 验收 |
|---|---|---|---|
| **CP-1** | prompt builder + cite verifier（pure function + 单测） | 4 | `pnpm -F shared test` 8 用例绿 |
| **CP-2** | /ask endpoint + LLM caller (fetch mock) + 集成测试 | 6 | `pnpm -F api test` 13 用例绿，Miniflare 跑通 |
| **CP-3** | admin test page（4 tab UI） | 4 | `pnpm -F admin build` 绿，UI 截图人工验收 |
| **CP-4** | docs + 缓存回写（D1 query_cache 表 + migration 0003） + E2E 验证 | 4 | `pnpm test` 全绿，admin /test 端到端跑通 |

合计 **18 任务**（含 TDD 红绿节奏，每个实现任务前都有 test 任务）。

### 9.1 不拆 /ask 为 sub-CP 的理由

/ask 的 4 个核心步骤（prompt / verify / cache / route）耦合度高（共享 ScoredChunk、shared metadata、retrieval），拆 sub-CP 反而增加 commit 数和 review 面积。一次 4 CP 跑完最稳。

---

## 10. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| LLM 输出格式漂移 | 高 | 中 | prompt 硬约束 + 4 夹具 + 验证器降级；模板可配置 |
| Miniflare fetch mock 不稳定 | 中 | 中 | 测试夹具放 fixture 文件，不用 vi.mock 等魔法 |
| Vectorize metadata 太大 | 已发生（spec §4.2 限制） | 高 | D1 query_cache 存全文，Vectorize 只存指针 |
| 缓存命中率低影响 E2E 体验 | 低 | 低 | TTL 30 天 + 验证器只接受 1..5 编号 |
| 真接 MiniMax 后 prompt 需调 | 高 | 中 | ASK_SYSTEM_TEMPLATE 常量导出，不硬编码 |
| 微信小程序 ≠ admin，无法直接复用 test page UX | 低 | 低 | 端到端验证只用 admin test page，wx 端是 M3 |

---

## 11. Mock-first 边界

按 spec §5.2 + agent-dispatch-protocol §1 规则 1：

- ✅ 主线程先跑 `pnpm install`（dispatch agent 前在 orchestrator 跑完）
- ❌ 不创建真 Cloudflare 资源（D1/Vectorize/R2）
- ❌ 不填真 `MINIMAX_API_KEY`（用 `test-key` 占位 + fetch mock）
- ❌ 不跑真 `pnpm dev:api`（用 Miniflare + 集成测试）
- ❌ 不在浏览器人工验收 UI（用 `pnpm -F admin build` + 静态检查代替）

CP-3 的人工验收改成：`pnpm -F admin build` 绿 + 代码 review UI 结构 + 单元测试覆盖 prompt → answer 渲染逻辑。完整 UI 验收推迟到 M2+ 真接 MiniMax 后。

---

## 12. 关键决策记录

| 决策点 | 选择 | 理由 |
|---|---|---|
| /chat 是否进 M2 | 不进 | spec 明确归 M6（Durable Objects） |
| LLM mock 方式 | globalThis.fetch mock | 与 M0+M1 风格一致；mock 简单，bug 面积小 |
| 验证器对编号范围的约束 | 1..5 | top5 范围；防止 LLM 幻觉写 6/7/100 |
| 验证器对 JSON 位置的约束 | 必须在答案末尾 | 防止 LLM 把块写到正文中间 |
| 缓存存储方式 | D1 query_cache + Vectorize 指针 | Vectorize metadata 大小受限 |
| 缓存失效范围 | 仅 TTL | admin UI 触发推迟到 v2+ |
| admin test page 4 tab 设计 | top5 / prompt / answer / citations | 完整可视化 §5.2 全流程 |
| CP 数量 | 4 | 不拆 /ask（耦合度高），4 个 CP 节奏清晰 |

---

## 13. 后续（M2 不做，v2+）

- 多轮 /chat + Durable Objects session
- NLI 蕴含验证（spec §13）
- HyDE 检索增强
- 缓存命中率统计、跨用户缓存共享
- MiniMax 模型升级时的全局缓存清空
- 真鉴权（wx.login → openid → JWT）
- admin 文档/source/抓取管理页
- 微信小程序接入
