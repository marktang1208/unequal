# P5 NLI 蕴含验证 — design

> 日期: 2026-06-23
> 前置: CP-7 / P3-7 / P4 #1 / P4 #2 完成（基础设施就绪：audit + secrets manager + deploy pipeline）
> 目标: 给 /api-ask 加 NLI 蕴含验证后置插入，过滤 LLM 兜底常识幻觉

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

### 1.3 为什么是现在（而不是 CP-7 之前）

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
                 → nli/transformers-provider → nli/types + nli/errors
                 → nli/noop-provider → nli/types
nli/apply-warning → nli/types
audit.ts (加 action 联合) ← api-ask.ts 复用
```

无循环依赖，单向。

## 4. 模块边界

```
apps/api/
├── functions/
│   └── assets/
│       └── nli/                                  # 模型资源目录
│           ├── nli-MiniLM-L6-v2-quantized.onnx   # 90MB ONNX 模型
│           ├── tokenizer.json                    # 3MB WordPiece tokenizer
│           └── README.md                         # 下载来源 + checksum
├── src/
│   └── lib/
│       └── nli/                                  # NLI 模块
│           ├── types.ts                          # NliProvider interface + NliVerdict
│           ├── transformers-provider.ts          # v1 实现 (ONNX via transformers.js)
│           ├── noop-provider.ts                  # 兜底 (禁用/降级)
│           ├── apply-warning.ts                  # verdict → warning prefix 注入
│           ├── errors.ts                         # NliError + 3 子类
│           ├── get-provider.ts                   # 单例 factory (env 路由)
│           └── __tests__/                        # 单元测试
│               ├── transformers-provider.test.ts
│               ├── noop-provider.test.ts
│               ├── apply-warning.test.ts
│               └── get-provider.test.ts
├── src/
│   ├── handlers/
│   │   └── api-ask.ts                            # 改：插入 NLI 调用
│   └── lib/
│       ├── env.ts                                # 改：NLI_ENABLED + NLI_MODEL_PATH
│       └── audit.ts                              # 改：action 联合加 "ask_nli_reject"
├── scripts/
│   ├── deploy-readiness.ts                       # 改：校验 deploy 包大小
│   ├── download-nli-model.ts                     # 新：一次性下载脚本
│   └── verify-nli.sh                             # 新：真接验收脚本
└── package.json                                  # 改：+ @xenova/transformers
```

### 4.1 文件行数预算

| 文件 | 行数 | 单一职责 |
|---|---|---|
| `types.ts` | ~30 | interface + types |
| `errors.ts` | ~40 | 3 个 error 子类 |
| `noop-provider.ts` | ~25 | 永远返回 entailed |
| `transformers-provider.ts` | ~150 | pipeline init + verify 单方法 |
| `apply-warning.ts` | ~50 | verdict → prefix 注入 |
| `get-provider.ts` | ~50 | env 路由 + 5 分钟缓存 |
| `download-nli-model.ts` | ~60 | 一次性脚本（开发用） |

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

### 5.2 `TransformersNliProvider`（v1 实现）

- 加载 `apps/api/functions/assets/nli/nli-MiniLM-L6-v2-quantized.onnx` + `tokenizer.json`
- 用 `@xenova/transformers` 的 `pipeline('text-classification')`
- 单例 lazy init（首次 verify 时初始化）
- verify 单方法：
  1. `premise + ' [SEP] ' + hypothesis` 拼接
  2. `tokenizer.encode` → 截断到 512 token
  3. `model.forward` → softmax 三分类
  4. argmax → verdict，max → score

### 5.3 `NoopNliProvider`（兜底）

- 任何输入返回 `{verdict: "entailed", score: 1, scores: {all: 1}, latencyMs: 0}`
- name = "noop"
- 不抛错，不写 console

### 5.4 `getProvider()` factory

- env `NLI_ENABLED=false` → NoopNliProvider
- env `NLI_ENABLED=true` + 模型文件存在 → TransformersNliProvider（首次 init 慢）
- env `NLI_ENABLED=true` + 模型文件不存在 → throw `NliConfigError`（启动期 fail fast）
- 5 分钟内累计失败 > 0 → 切到 NoopNliProvider 缓存（避免每次 ask 都尝试 init）。5 分钟后下次 `getProvider()` 调用重新尝试初始化 TransformersNliProvider。
- 累计 timeout > 10 次（按进程内 in-memory 计数）→ 切到 NoopNliProvider 永久缓存该实例，**直到 CloudBase 函数实例重启**（warm 进程内不重试；cold 重启后清零，重新走启动期判定）。管理员如需强制重试，需 deploy 一次触发函数实例全量重启。

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
| **A: runtime 故障** | transformers.js 初始化失败 / 推理抛错 | 5 分钟 NoopNliProvider 缓存 | 不加 warning，console.warn | 不写 |
| **B: timeout** | 推理 > 3 秒 | AbortController.timeout(3000) | 不加 warning | 写 `reason: "timeout"` |
| **C: reject** | 推理成功，verdict !== entailed | 加 warning prefix | 加 warning | 写 `reason: "rejected"` |
| **D: 配置错误** | 模型文件缺失 | 启动期 fail fast | 启动失败 | 启动失败 |

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
NLI_ENABLED=true
NLI_MODEL_PATH=functions/assets/nli/nli-MiniLM-L6-v2-quantized.onnx
NLI_TOKENIZER_PATH=functions/assets/nli/tokenizer.json
NLI_TIMEOUT_MS=3000
```

**env.ts 启动校验**（`getEnv` 调用时）：
- `NLI_ENABLED=true` + `NLI_MODEL_PATH` 存在 → TransformersNliProvider
- `NLI_ENABLED=true` + `NLI_MODEL_PATH` 不存在 → throw `NliConfigError`
- `NLI_ENABLED=false` → NoopNliProvider + warn 一次

## 9. 部署策略

### 9.1 模型文件位置

`apps/api/functions/assets/nli/`（**关键**：路径必须在 `functionRoot` 下，CloudBase 部署时随代码打包）：
- `nli-MiniLM-L6-v2-quantized.onnx` (~90MB)
- `tokenizer.json` (~3MB)
- `README.md`（下载来源 + SHA-256 checksum）

**路径解析**：`NLI_MODEL_PATH` env 写绝对路径或相对 `apps/api/` 的相对路径。`getEnv()` 启动期 `path.resolve(process.cwd(), NLI_MODEL_PATH)` 校验文件存在性。开发环境 `process.cwd() = apps/api`，所以默认 `NLI_MODEL_PATH=functions/assets/nli/nli-MiniLM-L6-v2-quantized.onnx` 可工作。

**首次获取模型**：开发者本地跑 `pnpm -F api download-nli-model`（commit 3 新增脚本），从 Hugging Face `Xenova/nli-MiniLM-L6-v2` 仓库下载到 `apps/api/functions/assets/nli/`。脚本幂等：文件已存在且 SHA-256 匹配 → 跳过；不匹配 → 报错退出。

### 9.2 deploy-readiness 大小校验

`apps/api/scripts/deploy-readiness.ts` 加一段：
```ts
const NLI_ASSETS = path.join(FUNCTION_ROOT, "assets/nli");
const nliSize = sumDirSize(NLI_ASSETS);
if (nliSize > 40 * 1024 * 1024) {  // 留 10MB buffer
  throw new Error(
    `NLI assets = ${(nliSize / 1024 / 1024).toFixed(1)}MB. ` +
    `CloudBase function zip limit is 50MB. Consider OSS fallback (v1.1).`
  );
}
```

**v1.1 OSS fallback**（如超限）：
- 模型存 CloudBase 静态存储
- 函数冷启动时按需下载到 `/tmp/.nli-cache/`
- 后续启动读缓存（避免重复下载）

### 9.3 冷启动预算

- 现状：CloudBase 函数 cold start ~500ms
- 加 NLI：首次 +1-2s（transformers.js pipeline 初始化）
- warm 实例复用：NLI init 已完成，verify 单次 ~50-100ms
- 用户体验：cold 路径总 ~3s（可接受），warm 路径不变

## 10. 依赖

`apps/api/package.json`：
```json
"dependencies": {
  "@xenova/transformers": "^2.17.0"  // ~10MB runtime
}
```

不引入：`onnxruntime-node`（transformers.js 自带 ONNX runtime，避免重复依赖）

## 11. 测试

### 11.1 单元测试（4 个文件，25 cases）

#### `transformers-provider.test.ts`（8 cases）
- entailment=0.9 → `{verdict: "entailed", score: 0.9, scores: {...}}`
- entailment=0.3, neutral=0.6 → `{verdict: "neutral", score: 0.6}`
- contradiction=0.7 → `{verdict: "contradiction", score: 0.7}`
- pipeline reject → throw `NliRuntimeError`
- pipeline 3s 不返回 → throw `NliTimeoutError`
- 空 premise → throw `NliError("empty premise")`
- premise + hypothesis > 512 token → 截断 + warn 日志
- 单例 cache：第二次调用复用同一 pipeline 实例

**mock 模式**：
```ts
const { mockPipeline } = vi.hoisted(() => ({ mockPipeline: vi.fn() }));
vi.mock("@xenova/transformers", () => ({
  pipeline: mockPipeline,
  env: { cacheDir: "/tmp/test-nli" },
}));
```

#### `noop-provider.test.ts`（3 cases）
- 任意输入 → `{verdict: "entailed", score: 1, scores: {all: 1}}`
- 不抛错
- 不写 console

#### `apply-warning.test.ts`（6 cases）
- entailed → 返回原 cleaned
- neutral → 加 "⚠️ 以下回答部分参考资料未提及..."
- contradiction → 加 "⚠️ 以下回答与参考资料存在冲突..."
- cleaned 已有 "⚠️" → 不重复加
- cleaned 是空 → 返回空
- prefix 长度 ≤ 60 字符

#### `get-provider.test.ts`（8 cases）
- `NLI_ENABLED=false` → NoopNliProvider
- `NLI_ENABLED=true` + 模型文件存在 → TransformersNliProvider
- `NLI_ENABLED=true` + 模型文件不存在 → throw `NliConfigError`
- TransformersNliProvider init 失败 → 5 分钟 NoopNliProvider 缓存
- 5 分钟后再次尝试 TransformersNliProvider
- 累计 timeout > 10 次 → 永久 NoopNliProvider
- 单例：第二次 getProvider 复用同一实例

### 11.2 集成测试（`api-ask.test.ts` 扩展，5 cases）

基于现有 mock 模式：
- NLI enabled + verdict entailed → response 无 warning
- NLI enabled + verdict neutral → response 有 `⚠️` prefix
- NLI runtime 抛错 → response 无 warning，console.warn
- NLI 写 audit（mock `recordAudit`）→ action="ask_nli_reject" + nliSnapshot
- NLI 跑超时 → 同 runtime 抛错路径 + 额外 audit

### 11.3 真接验证（`scripts/verify-nli.sh`，6 步）

```
[1/6] deploy push（带 NLI 模型文件 + verify deploy-readiness PASS）
[2/6] curl /api-ask "发烧怎么办" → response 无 warning（chunk 支持）
[3/6] curl /api-ask "X 星人住在哪个星系" → response 有 warning（chunk 不支持）
[4/6] tcb db nosql query → audit_log 有 ask_nli_reject 记录
[5/6] NLI_ENABLED=false 重 deploy → response 永远无 warning
[6/6] /api-search 走原路径不受影响
```

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 冷启动 +1-2s | CloudBase 函数 warm 实例复用，cold 仅首次；NLI_ENABLED=false 兜底 |
| ONNX 模型 ~90MB 接近 zip 限制 | deploy-readiness 校验；超限走 OSS（v1.1） |
| transformers.js WASM 体积大 | Node 20 走 ONNX 后端，不走 WASM fallback；先实测部署包大小 |
| chinese tokenize 效果（MiniLM 英文训练） | nli-MiniLM-L6-v2 有 XNLI 中文微调；先在 dev 跑 50 个真实家长问题验证 |
| audit 数据敏感（家长问题 hash 落库） | 只存 qHash（SHA-256 头 16 字符）+ chunksHash + 分数，**不全量存 q** |

## 13. 边界 / 不实现

- v1 不支持 cloud NLI API（接口已抽象，v2 可加 `HttpNliProvider`）
- v1 不切片 NLI 推理（premise + 拼接 hypothesis，单次推理）
- v1 不并行推理 LLM 和 NLI（顺序：LLM → NLI → response）
- v1 不重生成答案（仅 warning marker）
- v1 `/api-chat` 不加 NLI（v2 再扩展）

## 14. 验收成功标准

- [ ] 单元测试 25/25 PASS
- [ ] 集成测试 5/5 PASS（api-ask 现有 + NLI 5 个新场景）
- [ ] 全 monorepo tests 538 + 30 = **568/568 PASS**
- [ ] 真接 6 步全过
- [ ] 部署包大小 < 50MB（deploy-readiness 通过）
- [ ] audit_log 有 ask_nli_reject 记录可查
- [ ] NLI 关闭 fallback 验证

## 15. Commit 计划

```
1. docs(spec): NLI 蕴含验证 design (本文件)
2. chore(api): + @xenova/transformers 依赖 + nli/ 目录骨架 (types/errors/noop/apply-warning)
3. feat(nli): TransformersNliProvider + download-nli-model 脚本 (含 17 unit tests)
4. feat(nli): get-provider 单例 factory + 5min cache + 10-timeout 降级
5. feat(ask): api-ask 接入 NLI 后置插入 + audit "ask_nli_reject" + 5 integration tests
6. chore(deploy): verify-nli.sh + state-p5-nli.md + deploy-readiness 大小校验
```

每个 commit 独立可测。

## 16. 相关文档

- `apps/api/src/handlers/api-ask.ts` — handler 接入点
- `packages/shared/src/prompt.ts:8-18` — prompt 模板（不改）
- `apps/api/src/lib/audit.ts:14-56` — AuditEntry 类型
- `apps/api/src/lib/env.ts:113-125` — env 启动校验模式
- `docs/superpowers/specs/2026-06-16-m6-8-kek-version-design.md` — KEK 模式参考
- `docs/superpowers/state-p4-deploy-pipeline.md` — deploy pipeline 模式参考
