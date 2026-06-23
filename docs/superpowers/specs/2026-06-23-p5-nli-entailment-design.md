# P5 NLI 蕴含验证 — design

> 日期: 2026-06-23 (v1.1: HttpNliProvider)
> 前置: CP-7 / P3-7 / P4 #1 / P4 #2 完成（基础设施就绪：audit + secrets manager + deploy pipeline）
> 目标: 给 /api-ask 加 NLI 蕴含验证后置插入，过滤 LLM 兜底常识幻觉
>
> **v1.1 revision (2026-06-23)**：NLI provider 从本地 ONNX (`TransformersNliProvider`)
> 改为云端 HTTP (`HttpNliProvider`，走硅基流动 Qwen2.5-7B-Instruct)。
> 原因：本地 ONNX 部署包超 CloudBase 50MB 限制；国内模型镜像（魔搭/hf-mirror）
> 不稳定；中文 NLI 模型都得 400MB+；用户手头有硅基流动 API key。
> v1 抽象 (`NliProvider` interface) 保留，未来 v2 可加本地 ONNX 或其他云端 NLI。

## 1. 背景与动机

### 1.1 当前反幻觉机制

`packages/shared/src/prompt.ts:11-15` hardcode 5 条 prompt 规则：
- "仅基于下方参考资料"
- "不兜底常识"
- "参考资料中未涉及此问题"

这是**祈祷式反幻觉** — 希望 LLM 听话。但 MiniMax-Text-01 实际行为：
- 训练数据里有相关知识 → 会**补常识**（违反"不兜底"）
- 答案夹带 chunk 没的细节（奶粉品牌、温度阈值）→ 标 `[1]` 但 `[1]` 实际不支持
- 多 chunk 拼凑时**幻觉桥接**（"因为 A 所以 B"，但 B 不在 A 里）

家长场景里**这很危险**：喂药剂量错、温度阈值错 → 直接影响孩子。

### 1.2 为什么是 NLI（而不是 prompt 强化 / BGE-reranker）

| 方案 | 解决 | 不解决 |
|---|---|---|
| prompt 强化 | 形式上限制 | LLM 看到 chunk 漏时仍会脑补（生成机制决定） |
| BGE-reranker | 检索质量（找到更多相关 chunk） | LLM 用 chunk 之外的训练数据脑补 |
| **NLI 验证** | **生成质量（独立裁判）** | — |

NLI 是**双层模型架构**：
- LLM 层：负责"会说话"（生成流畅答案）
- NLI 层：负责"真不真"（独立裁判，不被 LLM 训练数据污染）

### 1.3 为什么选硅基流动 Qwen2.5-7B（而不是本地 ONNX 或 MiniMax-as-judge）

**v1 原本设计本地 ONNX（`TransformersNliProvider` via `@xenova/transformers` + `nli-MiniLM-L6-v2`）**，
真接发现 3 个问题（spec §9 / commit 9950196 类教训）：

| 问题 | 详情 | 结论 |
|---|---|---|
| Hugging Face 国内被墙 | `huggingface.co` TCP 超时 10s+ | ❌ 无法自动下载模型 |
| hf-mirror 镜像不稳 | TLS 握手中卡 / `nli-MiniLM-L6-v2` 没镜像 / quantized 版 404 | ❌ 不可靠 |
| 魔搭无 quantized 版 | `cross-encoder/nli-MiniLM2-L6-H768` 全精度 113MB；`nli-deberta-v3-*` 系列 176MB+ | ❌ 部署包超 CloudBase 50MB 限制 |
| 中文 NLI 模型体积 | `uer/sbert-base-chinese-nli` 409MB；`IDEA-CCNL/Erlangshen-MacBERT-325M-NLI-Chinese` 1.3GB | ❌ OSS fallback 也复杂 |

**改用 `HttpNliProvider` 走硅基流动 Qwen2.5-7B-Instruct**：

| 维度 | 价值 |
|---|---|
| 价格 | ¥0.0005/1K（输入）/ ¥0.002/1K（输出）— NLI 1000 ask/天 ≈ ¥22/月 |
| 中文 NLI 质量 | 强（Qwen 中文 SOTA） |
| Bias 隔离 | ✅ 完全不同模型家族（Qwen vs MiniMax），避免"自己审自己" |
| 部署 | ✅ 0 部署 — 不下载模型，不超 CloudBase 50MB |
| Latency | +1-2s（硅基流动 Qwen2.5-7B 通常 500-1500ms） |
| 可替换 | ✅ `NliProvider` interface 抽象 — v2 可换 ONNX / DeepSeek / 其他 |

### 1.4 为什么是现在（而不是 CP-7 之前）

CP-7 完成的**基础设施** NLI 之前做没意义：
- 没有 audit → NLI 触发率没法量化
- 没有真实流量 → 在 dev 跑 NLI = 在测试集看分数，**不是真实家长问题**
- 没解决 deploy → NLI 模型文件怎么推上去？放哪？

现在基础设施就绪 → 上 NLI 才有真接验证能力。

## 2. 目标 / 非目标

### 2.1 目标

- v1 在 `/api-ask` handler 后置插入 NLI 验证
- verdict !== "entailed" 时给答案加 `warning prefix`
- 仅 reject 时写 audit log（pass 不写，减少噪声）
- 失败降级：runtime 故障 / timeout → 不阻塞 ask，fallback 到 NoopNliProvider
- 启动期 `validateNliConfig` 校验模型文件存在性，fail fast

### 2.2 非目标

- `/api-chat` 路径 v1 **不**加 NLI（v2 再扩展）
- 不改 prompt 模板（独立验证层，不动 LLM 输入）
- 不做答案重生成（不重生，warning marker 即可）
- 不切片 NLI 推理（v1 单次 premise + 拼接 hypothesis）
- 不支持 BGE-reranker-v2-m3 等大模型（v1 走 nli-MiniLM-L6-v2 小模型）

## 3. 架构

### 3.1 数据流

```
1. POST /api-ask { query: "发烧 38.5 吃多少 ml 美林" }
2. embedQuery(q) → 1024-dim vector
3. searchChunks({topK: 5, scoreThreshold: 0.3}) → SearchResult[]
4. chunksWithEmb.find(c => c.id === r.chunkId) → join content + metadata
5. docs.find(d => d._id === c.documentId) → title
6. buildAskPrompt(q, ctx) → {messages: [system, user]}
7. llmProvider.chat(messages) → raw answer string
8. parseAnswerSegments(raw) → {cleaned: "...", citations: [...]}
9. 【新】nliProvider.verify(cleaned, joinedChunksText) → NliVerdict
10. 【新】if verdict.verdict !== "entailed" → writeAudit({action: "ask_nli_reject", scores, qHash, chunksHash})
11. 【新】applyWarning(cleaned, verdict) → finalAnswer
12. JSON response {answer: finalAnswer, citations}
```

### 3.2 模块依赖

```
api-ask.ts
  ↓ depends on
nli/get-provider → nli/types
                 → nli/http-provider → nli/types + nli/errors
                 → nli/noop-provider → nli/types
nli/apply-warning → nli/types
audit.ts (加 action 联合) ← api-ask.ts 复用
```

无循环依赖，单向。

## 4. 模块边界

```
apps/api/
├── src/
│   └── lib/
│       └── nli/                                  # NLI 模块
│           ├── types.ts                          # NliProvider interface + NliVerdict
│           ├── http-provider.ts                  # v1.1 实现 (硅基流动 Qwen2.5-7B)
│           ├── noop-provider.ts                  # 兜底 (禁用/降级)
│           ├── apply-warning.ts                  # verdict → warning prefix 注入
│           ├── errors.ts                         # NliError + 3 子类
│           ├── get-provider.ts                   # 单例 factory (env 路由)
│           └── __tests__/                        # 单元测试
│               ├── http-provider.test.ts
│               ├── noop-provider.test.ts
│               ├── apply-warning.test.ts
│               └── get-provider.test.ts
├── src/
│   ├── handlers/
│   │   └── api-ask.ts                            # 改：插入 NLI 调用
│   └── lib/
│       ├── env.ts                                # 改：NLI_PROVIDER + SILICONFLOW_API_KEY
│       └── audit.ts                              # 改：action 联合加 "ask_nli_reject"
├── scripts/
│   └── verify-nli.sh                             # 新：真接验收脚本 (硅基流动 API 6 步)
└── package.json                                  # 不变 (无新 runtime 依赖)
```

**v1.1 变化**：
- 删 `transformers-provider.ts` + `download-nli-model.ts` + `functions/assets/nli/` 整个目录
- 删 `@xenova/transformers` 依赖
- 删 `deploy-readiness` NLI 大小校验（无模型文件）
- 新增 `http-provider.ts` 调硅基流动 OpenAI 兼容 API

### 4.1 文件行数预算

| 文件 | 行数 | 单一职责 |
|---|---|---|
| `types.ts` | ~30 | interface + types |
| `errors.ts` | ~40 | 3 个 error 子类 |
| `noop-provider.ts` | ~25 | 永远返回 entailed |
| **`http-provider.ts`** | **~180** | **HTTP 调硅基流动 + strict prompt + JSON 解析 + retry** |
| `apply-warning.ts` | ~50 | verdict → prefix 注入 |
| `get-provider.ts` | ~70 | env 路由 + 5 分钟缓存 + 10-timeout 降级 |

每个文件 ≤ 200 行。

## 5. 接口设计

### 5.1 `NliProvider` interface

```ts
// types.ts
export type NliVerdictLabel = "entailed" | "neutral" | "contradiction";

export interface NliVerdict {
  verdict: NliVerdictLabel;
  score: number;          // 0-1, confidence (max of three)
  scores: {
    entailment: number;
    neutral: number;
    contradiction: number;
  };
  /** provider 内部耗时（ms），用于 audit / 监控 */
  latencyMs: number;
}

export interface NliProvider {
  /**
   * 验证 hypothesis 是否被 premise 蕴含
   * @param premise  主文本（被验证的"陈述"）
   * @param hypothesis  上下文（用以验证的"证据"）
   * @throws NliError on runtime failure / timeout
   */
  verify(premise: string, hypothesis: string): Promise<NliVerdict>;

  /** provider name（用于 audit / 调试） */
  readonly name: string;
}
```

### 5.2 `HttpNliProvider`（v1.1 实现 — 硅基流动 Qwen2.5-7B）

**API 端点**：`POST https://api.siliconflow.cn/v1/chat/completions`（OpenAI 兼容）

**Strict system prompt**（保证 JSON 输出）：
```
你是自然语言推理 (NLI) 专家。任务：判断 hypothesis 的事实内容是否被 premise 蕴含。

返回严格的 JSON object，不要任何其他文字：
{"entailment": <0-1>, "neutral": <0-1>, "contradiction": <0-1>}

三个分数和必须为 1.0（允许 ±0.01 浮点误差）。
- entailment: premise 的所有事实细节都被 hypothesis 支持
- neutral: premise 含 hypothesis 未提及的细节（可能是常识幻觉）
- contradiction: premise 与 hypothesis 冲突

示例 1：
premise: "发烧 38.5 吃 0.4ml/kg 美林"
hypothesis: "美林剂量标准 0.4ml/kg"
→ {"entailment": 0.95, "neutral": 0.03, "contradiction": 0.02}

示例 2：
premise: "X 星人住在仙女座星系"
hypothesis: "X 星人是 2025 年发现的外星文明"
→ {"entailment": 0.05, "neutral": 0.15, "contradiction": 0.80}
```

**User 模板**：
```
Premise（待验证陈述）:
{cleaned}

Hypothesis（证据）:
{joinedChunks}
```

**verify 方法流程**：
1. 拼 system + user message
2. `fetch(SILICONFLOW_BASE_URL + "/chat/completions", POST, { model, messages, temperature: 0, response_format: {type: "json_object"} })`
3. 解析 `choices[0].message.content` JSON
4. 校验 `e + n + c ≈ 1.0`，归一化
5. argmax → verdict，max → score

**超时**：5s（AbortController.timeout）
**重试**：JSON 解析失败 → 1 次重试（不同 seed temperature 0.2）；2 次失败 → 抛 `NliRuntimeError`

### 5.3 `NoopNliProvider`（兜底）

- 任何输入返回 `{verdict: "entailed", score: 1, scores: {all: 1}, latencyMs: 0}`
- name = "noop"
- 不抛错，不写 console

### 5.4 `getProvider()` factory

- env `NLI_PROVIDER=noop` → NoopNliProvider
- env `NLI_PROVIDER=http`（默认）+ `SILICONFLOW_API_KEY` 存在 → HttpNliProvider
- env `NLI_PROVIDER=http` + `SILICONFLOW_API_KEY` 缺失 → throw `NliConfigError`（启动期 fail fast）
- 5 分钟内累计失败 > 0 → 切到 NoopNliProvider 缓存（避免每次 ask 都尝试 HTTP）。5 分钟后下次 `getProvider()` 调用重新尝试 HttpNliProvider。
- 累计 timeout > 10 次（按进程内 in-memory 计数）→ 切到 NoopNliProvider 永久缓存该实例，**直到 CloudBase 函数实例重启**。

### 5.5 `applyWarning(cleaned, verdict)`

```ts
// apply-warning.ts
export function applyWarning(cleaned: string, verdict: NliVerdict): string {
  if (verdict.verdict === "entailed") return cleaned;

  const prefix = verdict.verdict === "contradiction"
    ? "⚠️ 以下回答与参考资料存在冲突，请谨慎参考：\n\n"
    : "⚠️ 以下回答部分参考资料未提及，请谨慎参考：\n\n";

  // 去重：cleaned 已有 "⚠️" 不重复加
  if (cleaned.trimStart().startsWith("⚠️")) return cleaned;
  return prefix + cleaned;
}
```

### 5.6 audit action 扩展

`apps/api/src/lib/audit.ts:18` action 联合：
```ts
type AuditAction = "ingest" | "session_rename" | "session_delete" | "nickname_update" | "deploy" | "ask_nli_reject";
```

新增 audit 字段：
```ts
interface AuditEntry {
  // ... 已有字段
  nliSnapshot?: {
    queryHash: string;        // SHA-256(q).slice(0, 16)
    chunksHash: string;       // SHA-256(chunkIds.join(",")).slice(0, 16)
    verdict: NliVerdictLabel;
    score: number;
    scores: { entailment: number; neutral: number; contradiction: number };
    latencyMs: number;
    reason?: "rejected" | "timeout" | "runtime_error";
  };
}
```

## 6. 阈值与触发逻辑

- 阈值：`entailment >= 0.5`（nli-MiniLM-L6-v2 公开基准 MNLI-matched acc ~87%）
- verdict 选择：argmax(entailment, neutral, contradiction)
- reject 触发：`verdict !== "entailed"`
- warning marker：
  - contradiction → "⚠️ 以下回答与参考资料存在冲突，请谨慎参考：\n\n"
  - neutral → "⚠️ 以下回答部分参考资料未提及，请谨慎参考：\n\n"

## 7. 错误处理

| 类别 | 触发 | 策略 | 响应 | audit |
|---|---|---|---|---|
| **A: runtime 故障** | HTTP 4xx/5xx / JSON 解析失败 2 次 | 5 分钟 NoopNliProvider 缓存 | 不加 warning，console.warn | 写 `reason: "runtime_error"` |
| **B: timeout** | 推理 > 5 秒 | AbortController.timeout(5000) | 不加 warning | 写 `reason: "timeout"` |
| **C: reject** | 推理成功，verdict !== entailed | 加 warning prefix | 加 warning | 写 `reason: "rejected"` |
| **D: 配置错误** | `SILICONFLOW_API_KEY` 缺失 | 启动期 fail fast | 启动失败 | 启动失败 |

### 7.1 Error 类型

```ts
// errors.ts
export class NliError extends Error {
  abstract readonly code: string;
  constructor(message: string, public cause?: unknown) { super(message); }
}
export class NliRuntimeError extends NliError { code = "NLI_RUNTIME"; }
export class NliTimeoutError extends NliError { code = "NLI_TIMEOUT"; }
export class NliConfigError extends NliError { code = "NLI_CONFIG"; }
```

## 8. 环境变量

```bash
# apps/api/.dev.vars.example（追加）
NLI_PROVIDER=http             # 'http' (默认, 走硅基流动) | 'noop' (禁用)
SILICONFLOW_API_KEY=sk-xxx    # 硅基流动 API key（用户已有）
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1  # 默认
NLI_MODEL=Qwen/Qwen2.5-7B-Instruct  # 默认
NLI_TIMEOUT_MS=5000           # HTTP 超时（硅基流动通常 500-1500ms）
NLI_RETRY_COUNT=1             # JSON 解析失败重试次数
```

**env.ts 启动校验**（`getEnv` 调用时）：
- `NLI_PROVIDER=noop` → NoopNliProvider + warn "NLI disabled via env"
- `NLI_PROVIDER=http` + `SILICONFLOW_API_KEY` 存在 → HttpNliProvider
- `NLI_PROVIDER=http` + `SILICONFLOW_API_KEY` 缺失 → throw `NliConfigError`（启动期 fail fast）

**云端配置**：deploy 时需把 `SILICONFLOW_API_KEY` 加到 `cloudbaserc.json` 的 `envVariables`（与 `MINIMAX_API_KEY` 同样的部署机制）。**注意**：API key 落 cloudbaserc.json 文件，**不能 commit 到 git**（`.gitignore` 已覆盖 `cloudbaserc.*.json`，但 `cloudbaserc.json` 主文件在 repo；管理员用 `deploy push` 前手动 export + setup-keychain-secrets 模式从 Keychain 拉）。

## 9. 部署策略

### 9.1 无模型文件（v1.1 重大变化）

**NLI 不需要任何模型文件** —— 全部在硅基流动云端推理。部署包大小不变。

**删 v1 的部署约束**：
- ❌ 无 CloudBase 50MB zip 限制
- ❌ 无 OSS fallback 需求
- ❌ 无 `pnpm -F api download-nli-model` 脚本
- ❌ 无 `deploy-readiness.ts` NLI 大小校验

**部署步骤**：
1. 用户本地 `pnpm -F api setup:keychain-secrets` 把 `SILICONFLOW_API_KEY` 加进 Keychain（P4 #1 模式）
2. `pnpm -F api deploy push` 推 cloudbaserc.json（含 SILICONFLOW_API_KEY env）
3. CloudBase 函数冷启动 → `validateNliConfig` → 有 key → HttpNliProvider ready

### 9.2 冷启动预算

- 现状：CloudBase 函数 cold start ~500ms
- 加 NLI：首次 +0ms（HTTP provider 无本地 init，lazy first-call 触发 HTTP）
- warm 实例：每次 NLI HTTP call 500-1500ms（硅基流动 Qwen2.5-7B）
- 用户体验：cold 路径总 ~500ms + 首次 NLI 1500ms ≈ 2s；warm 路径 +1-2s

### 9.3 限流 / rate limit

硅基流动免费档有 RPM 限制。**生产前确认账号 RPM/TPM**：
- 免费档：60 RPM
- 付费档：600+ RPM

**应对**：
- get-provider 5min cache + 10-timeout 永久降级（spec §5.4）已覆盖部分场景
- 高峰期 NLI 失败 → NoopNliProvider → ask 仍正常（仅无 warning）
- audit 记录 reason="timeout"，可观察触发率

## 10. 依赖

**v1.1 不增任何新依赖**：

- ❌ 删 `@xenova/transformers` (~10MB runtime + models)
- ✅ 用 `fetch` (Node 20 内置) 调硅基流动 OpenAI 兼容 API
- ✅ 用现有 `AbortController.timeout` 做超时

`apps/api/package.json`：去掉 `@xenova/transformers`。
}
```

## 11. 测试

### 11.1 单元测试（4 个文件，30 cases）

#### `http-provider.test.ts`（10 cases）
- 推理成功，e=0.85 → `{verdict: "entailed", score: 0.85, scores: {e: 0.85, n: 0.10, c: 0.05}}`
- 推理成功，n=0.6 最高 → `{verdict: "neutral", score: 0.6}`
- 推理成功，c=0.7 最高 → `{verdict: "contradiction", score: 0.7}`
- 三个分数和不为 1.0 → 归一化
- API 4xx/5xx → throw `NliRuntimeError`
- API timeout > 5s → throw `NliTimeoutError`
- 第一次 JSON 解析失败 → 1 次重试
- 第二次 JSON 解析失败 → throw `NliRuntimeError`
- 空 premise / 空 hypothesis → throw `NliRuntimeError`
- 缺 `SILICONFLOW_API_KEY` → constructor 抛 `NliConfigError`

**mock 模式**（用 `vi.stubGlobal("fetch", ...)`）：
```ts
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
mockFetch.mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { content: '{"entailment":0.9,"neutral":0.05,"contradiction":0.05}' } }],
  }),
});
```

#### `noop-provider.test.ts`（4 cases）
- 任意输入 → `{verdict: "entailed", score: 1, scores: {all: 1}}`
- 空输入也不抛错
- 不写 console
- name 字段是 'noop'

#### `apply-warning.test.ts`（6 cases）
- entailed → 返回原 cleaned
- neutral → 加 "⚠️ 以下回答部分参考资料未提及..."
- contradiction → 加 "⚠️ 以下回答与参考资料存在冲突..."
- cleaned 已有 "⚠️" → 不重复加
- cleaned 是空 → 返回空
- prefix 长度 ≤ 60 字符

#### `get-provider.test.ts`（10 cases）
- `NLI_PROVIDER=noop` → NoopNliProvider
- `NLI_PROVIDER=http` + `SILICONFLOW_API_KEY` 缺失 → throw `NliConfigError`
- `NLI_PROVIDER=http` + 有 key → HttpNliProvider
- `providerOverride` → 用 override
- 第一次 HTTP 失败 → 5 分钟 NoopNliProvider 缓存
- 5 分钟后重试（fake timers）
- 累计 timeout > 10 次 → 永久 NoopNliProvider
- `__resetProviderStateForTest` 清状态
- 单例：第二次 getProvider 复用同一实例
- success path 复用 state.provider（不 new 实例）

### 11.2 集成测试（`api-ask.test.ts` 扩展，5 cases）

基于现有 mock 模式：
- NLI HTTP 成功 + verdict entailed → response 无 warning
- NLI HTTP 成功 + verdict neutral → response 有 `⚠️` prefix
- NLI HTTP 4xx → response 无 warning，console.warn，audit reason="runtime_error"
- NLI HTTP timeout → response 无 warning，audit reason="timeout"
- NLI 写 audit（mock `recordAudit`）→ action="ask_nli_reject" + nliSnapshot 完整

### 11.3 真接验证（`scripts/verify-nli.sh`，6 步）

```
[1/6] setup:keychain-secrets 加 SILICONFLOW_API_KEY
[2/6] deploy push（验证 cloudbaserc.json 含 SILICONFLOW_API_KEY）
[3/6] curl /api-ask "发烧怎么办" → response 无 warning（chunk 支持）
[4/6] curl /api-ask "X 星人住在哪个星系" → response 有 warning（chunk 不支持）
[5/6] tcb db nosql query → audit_log 有 ask_nli_reject 记录
[6/6] /api-search 走原路径不受影响
```

**注**：v1.1 真接验证比 v1 简单 — 无 deploy-readiness 校验，无 NLI 大小问题。

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 硅基流动 API 不可达 / rate limit | 5min cache + 10-timeout 永久降级 NoopNliProvider；audit 记录触发率 |
| API key 泄漏到 git | cloudbaserc.json 走 gitignore + Keychain 管理（P4 #1 模式）|
| LLM-as-judge 精度问题（v.s. 专用 NLI 模型）| Qwen2.5-7B 中文 NLI 强；strict prompt + JSON 解析；dev 跑 50 真实问题验证 |
| 每次 ask +1-2s latency + cost | 用户接受 trade-off；高峰期 NLI 失败降级（不影响主回答）|
| JSON 解析失败 / 输出不合规 | retry 1 次 + 不同 temperature；2 次失败降级 NoopNliProvider |
| audit 数据敏感（家长问题 hash 落库） | 只存 qHash（SHA-256 头 16 字符）+ chunksHash + 分数，**不全量存 q** |

## 13. 边界 / 不实现

- v1 不支持本地 ONNX NLI（接口已抽象，v2 可加 `TransformersNliProvider`）
- v1 不切片 NLI 推理（premise + 拼接 hypothesis，单次推理）
- v1 不并行推理 LLM 和 NLI（顺序：LLM → NLI → response）
- v1 不重生成答案（仅 warning marker）
- v1 `/api-chat` 不加 NLI（v2 再扩展）

## 14. 验收成功标准

- [ ] 单元测试 30/30 PASS
- [ ] 集成测试 5/5 PASS
- [ ] 全 monorepo tests 568/568 PASS
- [ ] 真接 6 步全过
- [ ] 部署包大小 < CloudBase 50MB 限制（v1.1 完全无此问题）
- [ ] audit_log 有 ask_nli_reject 记录可查
- [ ] NLI 关闭 fallback 验证
- [ ] 硅基流动 API key 配置 → NLI 启用；缺失 → NliConfigError fail fast

## 15. Commit 计划

```
1. docs(spec): P5 NLI 蕴含验证 design v1.1 (HttpNliProvider 硅基流动 Qwen2.5-7B)
2. chore(api): - @xenova/transformers + - assets/nli/ + - download-nli-model + + http-provider 骨架
3. feat(nli): HttpNliProvider + strict prompt + JSON 解析 + retry (含 10 unit tests)
4. feat(nli): get-provider 路由 HttpNliProvider + env NLI_PROVIDER + SILICONFLOW_API_KEY
5. chore(deploy): verify-nli.sh 重写为硅基流动真接 + state report
```

**v1 历史 commit（已 commit 但要走 rebase 改造）**：
- `82a093e` docs P5 spec v1（已重写为 v1.1）
- `e823568` 骨架（保留 + 卸 transformers 依赖）
- `e01ecae` TransformersNliProvider（**改造为 http-provider**）
- `3de1b2f` get-provider（**改造路由**）
- `ea0ad8f` ask 接入 + audit（保留，零改动）

每个 commit 独立可测。

## 16. 相关文档

- `apps/api/src/handlers/api-ask.ts` — handler 接入点
- `packages/shared/src/prompt.ts:8-18` — prompt 模板（不改）
- `apps/api/src/lib/audit.ts:14-56` — AuditEntry 类型
- `apps/api/src/lib/env.ts:113-125` — env 启动校验模式
- `docs/superpowers/specs/2026-06-16-m6-8-kek-version-design.md` — KEK 模式参考
- `docs/superpowers/state-p4-deploy-pipeline.md` — deploy pipeline 模式参考
