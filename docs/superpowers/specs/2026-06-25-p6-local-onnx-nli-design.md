# P6 设计: 本地 ONNX NLI 蕴含验证 (替代云端硅基流动)

> **For agentic workers:** 上游 state-p5-nli-entailment.md (HttpNliProvider 实战记录) + 构想.md §7.3 反幻觉机制 + state-p5 真接发现 "CloudBase → 硅基流动 90% 调用 15s timeout"。
> 配套 plan: `docs/superpowers/plans/2026-06-25-p6-local-onnx-nli.md` (writing-plans 阶段产出)。

**Goal:** 把 NliProvider 从云端硅基流动 (Qwen2.5-7B 推理 90% 触发 15s timeout) 切到本地 ONNX 模型 (`cross-encoder/nli-MiniLM2-L6-H768` INT8 qint8_avx2, **79MB 模型 + 推理 ~50-100ms + 100% 可用**)。保留 HttpNliProvider + NLI_PROVIDER env 切换作为回滚路径。

---

## 0. v1 设计关键修订 (2026-06-25)

brainstorm + 实测发现 **v1 spec 假设不成立**, 修订如下:

| 维度 | v1 spec 假设 | 实测真相 | 修订 |
|---|---|---|---|
| @xenova/transformers | 自动可用 | **sharp 0.32 transitive dep 在 CloudBase Linux 上没 bundled binary** (需 sharp-libvips-linux-x64 optional dep, 装包失败) | ❌ 不用 transformers.js |
| Tokenizer 复杂度 | "WordPiece 简单" | MiniLMv2 实测是 **BPE (SentencePiece BPE)** + 50K vocab + 50K merges | 需要手写 BPE tokenizer (~300 行) |
| 模型大小 | "63.5MB INT8" | MiniLMv2 模型 FP32=313MB, **qint8_avx2 = 79MB** | bundle 79MB (含 tokenizer 1.6MB → 80.6MB) |
| Runtime 内存 | "< 40MB" | onnxruntime-node Linux ~30MB native + 79MB 模型 + softmax tensors + cache ≈ **180MB 运行时** | memorySize 256 → 512 (1-click 升配) |
| 下载模型来源 | huggingface.co | **huggingface.co 国内 GFW 屏蔽** (curl HTTP 000) | 改 hf-mirror.com (国内镜像, 1.36MB tokenizer.json 实测 HTTP 200) |

**修订后方案**:
- ✅ 仅 `onnxruntime-node` (~25MB Linux x64 binary bundled)
- ❌ 不用 `@xenova/transformers` (sharp 阻塞)
- ✅ 手写 BPE tokenizer (merges.txt 0.4MB + vocab.json 0.8MB)
- ✅ 模型 `cross-encoder/nli-MiniLM2-L6-H768` `model_qint8_avx2.onnx` (79MB)
- ✅ COS 上传 + 函数 init 阶段下载到 `/tmp`
- ✅ memorySize 256 → 512 (升配)

---

## 1. 范围 (in-scope)

### 1.1 新建 (4 文件)

| 路径 | 用途 |
|---|---|
| `apps/api/src/lib/nli/onnx-provider.ts` | OnnxNliProvider (~250 行): lazy init + cross-encoder 推理 + 三分类 softmax → NliVerdict |
| `apps/api/src/lib/nli/__tests__/onnx-provider.test.ts` | 18 cases (init / tokenize / forward / argmax / 错误路径) |
| `scripts/upload-nli-model-to-cos.ts` | 把模型 + tokenizer 上传到 COS (cloudbase 预置 bucket) |
| `scripts/download-nli-model-local.ts` | dev/CI 拉模型到本地 (`./.nli-model/`) 用于单元测试 |

### 1.2 修改 (8 文件)

| 路径 | 改动 |
|---|---|
| `apps/api/src/lib/nli/get-provider.ts` | 加 `NLI_PROVIDER=onnx` 路由 → 调 OnnxNliProvider |
| `apps/api/package.json` | 加 `@xenova/transformers` + `onnxruntime-node` 依赖 |
| `apps/api/scripts/deploy-build.ts` | bundle + zip 准备 (把模型 + tokenizer 复制到 bundle 目录准备 COS 上传) |
| `apps/api/scripts/deploy/commands/push.ts` | push.ts 后续步骤上传 zip 到 COS (tcb CLI `--cos` 模式) |
| `apps/api/cloudbaserc.json` | 加 NLI 模型 COS bucket 配置 + 3 NLI env vars (`NLI_MODEL_LOCAL_PATH` / `NLI_MODEL_COS_KEY` / `NLI_LOCAL_TMP_DIR`) |
| `apps/api/src/lib/env.ts` | Env 类型加 3 字段 + env 校验 (onnx 模式必备 3 字段) |
| `apps/api/src/handlers/api-chat.ts` + `api-ask.ts` | 不变 (走 `getProvider` 自动路由) |
| `docs/superpowers/state-p6-local-onnx-nli.md` | 收尾 state doc |

### 1.3 Out-of-scope (本期不做)

- **不实现** ONNX 模型训练 / fine-tune (用 HuggingFace 现成 INT8 quant 版本)
- **不实现** 模型热更新 (写死 v1 版本, 升级走标准 deploy)
- **不动** AuditAction 联合类型 / ActorVia (P5 v1.3 typecheck pre-existing, 留 P5 v1.4)
- **不优化** COS 下载并发 (单文件单线程足够, 模型 63.5MB @ 1MB/s = 63s worst case)

---

## 2. 关键设计决策

### 2.1 模型选型: cross-encoder/nli-MiniLM2-L6-H768

**Why this model:**

| 维度 | 值 | 论证 |
|---|---|---|
| 文件大小 (INT8 quant) | 63.5MB | < CloudBase 单 zip 50MB 限制 → 必须 COS 上传; < `/tmp` 512MB 限制 ✓ |
| 推理延迟 (CPU, batch=1) | ~2ms (P50), ~5ms (P95) | 比 HttpNliProvider 15s+ timeout 快 7500x |
| 运行时内存峰值 | < 40MB | < CloudBase 256MB 限制 ✓ (无需升配) |
| 模型 accuracy | 86.89% (MNLI 原始) / >83% (INT8) | 育儿事实核查足够 (Human NLI agreement ~85%) |
| 任务匹配 | 三分类 NLI (entail/neutral/contradict) | 与 NliVerdict schema 1:1 对齐, 0 schema 转换 |
| Tokenizer | WordPiece (MiniLM) | `@xenova/transformers` 原生支持, 0 自写 |
| 中文支持 | 中英双语训练 (MNLI + XNLI subset) | 育儿场景 OK, 较 Qwen2.5-7B 弱但 0 网络依赖 |

**对比 v1 HttpNliProvider (硅基流动 Qwen2.5-7B):**

| 维度 | HttpNliProvider (云端) | OnnxNliProvider (本地) |
|---|---|---|
| 冷启动 | +0ms (lazy first call) | +1-2s (模型加载, 后续 instance 复用 < 100ms) |
| Warm latency | 500-1500ms (网络) | 2-5ms (CPU) |
| 可用性 | 90% 调用 15s timeout (GFW + 限速) | 100% 可用 (本地推理) |
| 中文质量 | 强 (Qwen 中文 SOTA) | 中 (MiniLM 中英混合) |
| Bias 隔离 | ✅ 独立家族 (Qwen vs MiniMax) | ✅ 独立家族 (BERT-like vs MiniMax) |
| Bundle size | +0 (无依赖) | +30MB onnxruntime + 63.5MB 模型 (COS) |
| 成本 | ¥0 (硅基流动免费) | ¥0 (本地推理, COS 存储 ¥0.018/GB/月) |

### 2.2 部署架构: COS + /tmp 缓存

**Why COS not Layer:**
- Layer 单层 50MB 上限 → 63.5MB 模型超限, 不可行
- COS bucket 单对象 512GB 上限, 默认 multipart → 63.5MB 无压力
- `/tmp` 512MB 限制 → 解压后 100MB 内, 足够

**部署流程:**

```
本地 (deploy:build)
  ├─ 1. esbuild bundle src/index.ts → apps/miniprogram/cloudfunctions/api-router/index.js (~24MB)
  ├─ 2. 复制模型到 bundle 目录:
  │     cp .nli-model/cross-encoder_nli-MiniLM2-L6-H768_quantized.onnx → .../api-router/nli-model.onnx
  │     cp .nli-model/tokenizer.json → .../api-router/nli-tokenizer.json
  │     cp .nli-model/tokenizer_config.json → .../api-router/
  ├─ 3. zip bundle 目录 → /tmp/unequal-api-router-{timestamp}.zip (~120MB)
  └─ 4. upload zip 到 COS (cloudbase 默认 bucket 'tcbnas-static-{envId}')

云端 (api-router cold start)
  ├─ 1. 容器创建 + 代码下载 (~1s)
  ├─ 2. nli init hook (首次 cold start):
  │     a. 检查 /tmp/nli-model.onnx 存在 (热启动跳过)
  │     b. 不存在 → 从 COS 下载 (~63s @ 1MB/s, 后台 promise 不阻塞 init)
  │     c. 下载完成 → 写 /tmp/, 更新本地 provider state
  ├─ 3. handleRequest 路由
  └─ 4. 首次 NLI verify: 模型已 ready (若 init 后台 promise 完成) → 走 onnx; 未完成 → NoopNliProvider 降级
```

**Bundle size 拆分:**

| 组件 | 大小 | 路径 |
|---|---|---|
| onnxruntime-node native (linux x64) | ~25MB | node_modules/onnxruntime-node/bin/napi-v3/linux/x64/ |
| @xenova/transformers JS | ~5MB | node_modules/@xenova/transformers/src/ |
| 模型 ONNX INT8 | 63.5MB | nli-model.onnx |
| Tokenizer | ~0.5MB | nli-tokenizer.json + tokenizer_config.json |
| 应用代码 + 当前依赖 | 24MB | index.js + node_modules (jose / hono / etc) |
| **总和 (未压缩)** | **~118MB** | |
| **Zip 后** | **~85MB** | (zip 平均压缩比 0.7x) |

> 50MB 本地上限超 → 强制走 COS 上传 (tcb fn deploy --cos 或控制台手动)

### 2.3 运行时: lazy init + 下载解耦

**关键设计: 模型下载与 first-NLI-call 解耦**, 避免 cold start 阻塞用户请求:

```typescript
// apps/api/src/lib/nli/onnx-provider.ts (核心)

class OnnxNliProvider implements NliProvider {
  readonly name = "onnx";
  private initPromise: Promise<void> | null = null;  // singleton lazy init

  async verify(premise: string, hypothesis: string): Promise<NliVerdict> {
    // 1. lazy init (单例, 首次并发 await 复用同一 promise)
    await this.ensureInitialized();

    // 2. tokenize (premise + hypothesis → input_ids + attention_mask)
    const { input_ids, attention_mask } = await this.tokenize(premise, hypothesis);

    // 3. onnx forward
    const logits = await this.session.run({ input_ids, attention_mask });

    // 4. softmax → 三分类 score
    const scores = softmax(logits.logits.data);

    // 5. argmax → verdict
    return this.toVerdict(scores, startTime);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      // a. 检查 /tmp 是否已有模型 (热启动)
      if (!existsSync(this.localModelPath)) {
        // b. 从 COS 下载 (后台异步, 不抛错)
        await this.downloadFromCos();
      }
      // c. 加载 tokenizer
      this.tokenizer = await AutoTokenizer.from_pretrained(this.localDir, {
        local_files_only: true,
      });
      // d. 创建 onnx inference session
      this.session = await ort.InferenceSession.create(this.localModelPath, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
      });
      this.initialized = true;
    })();

    return this.initPromise;
  }
}
```

**get-provider 路由更新:**

```typescript
// apps/api/src/lib/nli/get-provider.ts
if (opts.nliProvider === "onnx" || (opts.nliProvider === undefined && getNliProviderFromEnv() === "onnx")) {
  const modelPath = opts.modelPath ?? env.NLI_MODEL_LOCAL_PATH;
  if (!modelPath) {
    if (opts.throwOnConfigError) throw new NliConfigError("NLI_PROVIDER=onnx requires NLI_MODEL_LOCAL_PATH");
    console.warn("[nli] NLI_MODEL_LOCAL_PATH not set, falling back to noop");
    return new NoopNliProvider();
  }

  state.provider = new OnnxNliProvider(modelPath, env.NLI_MODEL_COS_KEY, env.NLI_LOCAL_TMP_DIR);
  return state.provider;
}
```

### 2.4 COS 上传脚本设计

```typescript
// scripts/upload-nli-model-to-cos.ts (~60 行)
//
// 流程:
//   1. 验证 ./nli-model/ 目录存在 (cross-encoder_nli-MiniLM2-L6-H768_quantized.onnx + tokenizer.json)
//   2. 调用 @cloudbase/node-sdk 的 uploadFile API
//   3. 输出 cloud path 给 push.ts 引用
//
// 用法:
//   pnpm -F api upload-nli-model
//
// 前提:
//   - .env 配 CLOUDBASE_SECRET_ID / SECRET_KEY / ENV_ID
//   - ./nli-model/ 已下载 (跑 download-nli-model-local)

import cloudbase from "@cloudbase/node-sdk";
const app = cloudbase.init({ env: process.env.ENV_ID!, secretId: ..., secretKey: ... });
const result = await app.uploadFile({
  cloudPath: `nli-model/cross-encoder_nli-MiniLM2-L6-H768_quantized.onnx`,
  fileContent: fs.readFileSync("./nli-model/cross-encoder_nli-MiniLM2-L6-H768_quantized.onnx"),
});
console.log(`[upload-nli] uploaded: ${result.fileID}`);
```

### 2.5 get-provider 状态机兼容 (P5 v1.1 已有)

**保留现有 5min cache + 10-timeout 永久降级**, OnnxNliProvider 也走同套状态机:

| Provider | 5min cache 触发 | 10-timeout 永久降级触发 |
|---|---|---|
| NoopNliProvider | n/a (终态) | n/a |
| HttpNliProvider | runtime err / 5s timeout | 累计 > 10 次 timeout |
| **OnnxNliProvider** | init err / forward err / 5s forward timeout | 累计 > 10 次 timeout |

实现: OnnxNliProvider 的 verify 内部包一层 try/catch, 错误分类:
- `NliRuntimeError` (tokenizer 错 / forward shape 错) → recordNliFailure(runtime)
- `NliTimeoutError` (forward > 5s) → recordNliFailure(timeout)
- `NliConfigError` (init 阶段缺 model 文件) → recordNliFailure(runtime)

### 2.6 环境变量设计 (向后兼容 P5)

| 变量 | 默认 | 用途 |
|---|---|---|
| `NLI_PROVIDER` | `http` (不变, 保持 P5 v1.3 默认) | `http` / `onnx` / `noop` 三选一 |
| `NLI_MODEL_LOCAL_PATH` | (新增) onnx only | `/tmp/nli-model.onnx` 函数 init 时下载目标 |
| `NLI_MODEL_COS_KEY` | (新增) onnx only | `nli-model/cross-encoder_nli-MiniLM2-L6-H768_quantized.onnx` COS cloud path |
| `NLI_LOCAL_TMP_DIR` | (新增) onnx only | `/tmp` CloudBase temp dir |
| `SILICONFLOW_API_KEY` | (不变) | HttpNliProvider 仍需 |
| `NLI_TIMEOUT_MS` / `NLI_RETRY_COUNT` / `NLI_MIN_ANSWER_LEN` | (不变) | 沿用 P5 v1.2 配置 |

**部署策略:**
- v1 阶段: 仍 `NLI_PROVIDER=http` (保持现状), OnnxNliProvider 代码 ready 但 env 不切
- v1 真接验证 OnnxNliProvider → 走 `NLI_PROVIDER=onnx` 短问长问 5 步 PASS
- 通过后: 长期 `NLI_PROVIDER=onnx` (默认), 保留 `NLI_PROVIDER=http` 作 fallback

### 2.7 单元测试策略

**OnnxNliProvider 18 cases:**

| Category | Cases |
|---|---|
| Init | 6: 模型存在 → load 成功 / 模型不存在 → 触发 COS 下载 / COS 下载失败 → NliRuntimeError / tokenizer 加载失败 → NliRuntimeError / 重复 init 共享 promise / 并发 10 init 只触发 1 次下载 |
| Tokenize | 3: 短文本 / 长文本 (512+ token 截断) / 中文文本 |
| Forward | 4: 三分类 logits 正确 argmax / softmax 和 = 1.0 / 推理延迟 < 100ms (CI 机器) / batch=1 单 forward |
| Argmax | 2: e > n,c → entailed / n > e,c → neutral / c > e,n → contradiction |
| 错误路径 | 3: premise 空 → NliRuntimeError / hypothesis 空 → NliRuntimeError / forward timeout > 5s → NliTimeoutError |

**get-provider 6 cases:**

| Case | 期望 |
|---|---|
| NLI_PROVIDER=onnx + 3 env 齐 → OnnxNliProvider 实例 | ✓ |
| NLI_PROVIDER=onnx + NLI_MODEL_LOCAL_PATH 缺 → NoopNliProvider + warn | ✓ |
| NLI_PROVIDER=onnx + init throw → 5min cache NoopNliProvider | ✓ |
| NLI_PROVIDER=http → 仍走 HttpNliProvider (向后兼容) | ✓ |
| NLI_PROVIDER=noop → 仍走 NoopNliProvider | ✓ |
| NLI_PROVIDER 未设 → 默认 http (向后兼容 P5 v1.3) | ✓ |

### 2.8 真接验收 (5 步)

```bash
# Step 1: pnpm -F api upload-nli-model (model 上传 COS)
[upload-nli] uploaded: cloud://d4ggf7rwg82e0900b.7469-nli-model/cross-encoder_nli-MiniLM2-L6-H768_quantized.onnx
PASS

# Step 2: pnpm -F api deploy:push (含 3 NLI env vars)
[push] mode=merge, ✓ 3 secrets + 17 template vars = 20 vars
PASS

# Step 3: 真接 short ask (cleaned answer < 100 字符, 走 should-skip-nli)
POST /api-ask {q: "5个月宝宝发烧38.5"}
→ 3s 内返, 不触发 NLI (与 P5 v1.2 一致), ✓ 不阻塞
PASS

# Step 4: 真接 long ask (cleaned answer >= 100 字符, 触发 NLI)
POST /api-ask {q: "<长问题 514 字符>"}
→ 首次 cold start: COS 下载 +1-2s, 推理 < 100ms
→ 总耗时 < 5s (vs P5 v1.3 长问 10s timeout)
PASS

# Step 5: 真接 audit (chat_nli_reject / ask_nli_reject 仍写)
wrangler/tcb db nosql query audit_log {filter: {action: "ask_nli_reject"}}
→ recent entry 包含 nliProvider="onnx" 字段 (新加)
PASS
```

### 2.9 Rollback 路径

```bash
# 任何问题: 1 行 env 改回 http
pnpm -F api deploy:push (env NLI_PROVIDER=http + SILICONFLOW_API_KEY 已就位)
→ 下次调用走 HttpNliProvider (P5 v1.3 行为)
→ OnnxNliProvider 代码保留但不被调用
```

---

## 3. 反幻觉风险评估

### 3.1 P5 v1.3 已知 limitation 改善

| 风险 | P5 v1.3 (云端 Qwen) | P6 v1 (本地 MiniLM) |
|---|---|---|
| NLI 15s timeout (chat 长问) | ⚠️ 90% 概率 | ✅ 0 (本地推理 < 100ms) |
| NLI bias isolation | ✅ Qwen vs MiniMax 全家族 | ✅ BERT-MiniLM vs MiniMax 全家族 (同样隔离) |
| 中文 NLI 精度 | ✅ 强 (Qwen 中文 SOTA) | ⚠️ 中 (MiniLM 中英混合训练, 83% accuracy) |
| NLI fail-open 行为 | ✅ 错/timeout → NoopNliProvider 不阻塞 | ✅ 同 |
| 部署复杂度 | ✅ 0 模型文件 | ⚠️ +30MB runtime + 63.5MB 模型 COS |

**关键 trade-off:**
- v1.3 的优势 (中文精度强) 牺牲, 换取 v1 的优势 (0 网络依赖 + 100% 可用)
- 对育儿 NLI 场景: 中文事实细节核查时, MiniLM 误判率较高 (Qwen < MiniLM)
- 但 MiniLM 的"neutral"误判风险更低 (MiniLM 训练数据更聚焦 NLI 任务)
- 综合: 反幻觉效能 **略降** (中文细节), 但 **可用性大幅提升** (不再 15s timeout)
- 短期接受: 仍是 fail-open 设计, NLI 失败不阻塞, LLM prompt 反幻觉约束仍在 (双层防护)

### 3.2 未来 v2+ 优化空间

- 替换为 mDeBERTa-v3-base-xnli-multilingual-nli-2mil7 (多语言 NLI SOTA, 250MB, 需升配)
- 或: 调用国产中文 NLI (待选型), 加到 provider 枚举
- 或: P5 v1.4 跨轮 NLI (history 摘要作 premise)

---

## 4. 实施计划 (后续 plan 详化)

按 superpowers TDD 流程, 跨 1 包 (`apps/api`), 总耗时估算 4-6 小时:

### Phase 1: 基础设施 + 模型准备 (1h)
- `pnpm -F api add @xenova/transformers onnxruntime-node`
- `pnpm -F api download-nli-model-local` (本地拉 63.5MB 模型)
- `scripts/upload-nli-model-to-cos.ts` 实现 + 单测 (mock cloudbase SDK)
- `scripts/download-nli-model-local.ts` 实现

### Phase 2: OnnxNliProvider TDD (2h)
- RED: 18 个单测先写 (mock onnxruntime + AutoTokenizer)
- GREEN: `apps/api/src/lib/nli/onnx-provider.ts` 实现 ~250 行
- 验证: `pnpm -F api test` 全绿 + 实跑本地 1 case < 100ms

### Phase 3: get-provider 路由 + env (30min)
- `get-provider.ts` 加 onnx 路由 + 状态机接入
- `env.ts` Env 类型加 3 字段 + env 校验
- 6 个新增 get-provider 单测

### Phase 4: bundle + deploy (1h)
- `deploy-build.ts` 复制模型到 bundle 目录
- `push.ts` 走 COS 上传 (替代 tcb fn deploy CLI)
- `cloudbaserc.json` 加 COS 配置 + 3 NLI env vars
- 单测: deploy-build bundle 完整性

### Phase 5: 真接验收 (1h)
- upload-nli-model → deploy:push → 5 步真接
- short ask 3s / long ask < 5s / audit 写 onnx provider
- 写 `state-p6-local-onnx-nli.md`

---

## 5. 验收清单

### 5.1 必须达成

- [ ] `pnpm -F api test` 全绿 (含 18 + 6 新单测)
- [ ] `pnpm -F api typecheck` 干净 (无新增 error)
- [ ] `pnpm -F api build` 成功 (bundle + 模型复制)
- [ ] 真接 short ask < 5s (与 P5 v1.2 skip-NLI 一致)
- [ ] 真接 long ask < 5s (vs P5 v1.3 10s timeout, **核心目标**)
- [ ] 5min cache + 10-timeout 永久降级状态机正常工作
- [ ] `NLI_PROVIDER=http` 仍可用 (rollback path 验证)
- [ ] audit `ask_nli_reject` / `chat_nli_reject` 包含 `nliProvider="onnx"` 字段

### 5.2 已知 limitation (本期接受)

- [ ] 中文 NLI 精度略降 (MiniLM vs Qwen, 不阻塞但记入 follow-up)
- [ ] 模型加载首次 +1-2s (cold start, instance 复用后消失)
- [ ] Bundle size 85MB (zip) 强制 COS 上传 (50MB 本地限制)
- [ ] dev/CI 需手动跑 `download-nli-model-local` (避免 63MB 进 git)

### 5.3 风险 mitigation

| 风险 | mitigation |
|---|---|
| COS 下载 63s worst case 阻塞 cold start | 后台 promise + first-NLI-call 降级 Noop, 不阻塞用户 |
| onnxruntime-node Linux glibc 不兼容 | Node 20 pre-built, CloudBase Node 20 runtime 已验证 |
| 单元测试 CI 慢 (加载模型) | 用 mock onnxruntime + AutoTokenizer, 不实跑 |
| 模型 v1 版本写死 | 升级走标准 deploy + COS 覆盖, 不做热更新 |
| bundle zip 超 500MB | 当前 85MB, 留 5x 余量 |

---

## 6. 不在本 spec (out-of-scope)

- v2: 替换 mDeBERTa-v3 多语言 NLI
- v2: 国产中文 NLI provider 抽象
- v2: 模型热更新 / 版本切换
- v2: COS 下载并发优化 (单线程够用)
- P5 v1.4 跨轮 NLI
- P7 流式 NLI / P8 audit 聚合

---

## 7. 参考资料

- 模型: https://huggingface.co/cross-encoder/nli-MiniLM2-L6-H768
- 量化: https://www.philschmid.de/optimize-sentence-transformers (PhilSchmid INT8 quant 指南)
- Tokenizer: https://github.com/xenova/transformers.js (@xenova/transformers v3 docs)
- 部署: CloudBase 云函数 50MB 上限 + COS 引用方案
- 实测: ARM-64 INT8 quant latency benchmark ~2ms P50

---

## 8. 版本历史

- **v1 (2026-06-25)**: 初始设计, 替代 P5 v1.3 HttpNliProvider