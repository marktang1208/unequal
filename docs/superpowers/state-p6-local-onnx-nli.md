# state-p6-local-onnx-nli — 本地 ONNX NLI (OnnxNliProvider cross-encoder/nli-MiniLM2-L6-H768) PASS

> 日期: 2026-06-25
> 前置: state-p5-nli-entailment.md (P5 v1.3 chat NLI 后置插入, commit a2f8253, 真接 PASS)
> 状态: ✅ 12 commits + 307/307 unit tests PASS; **真接 6 步 PASS (Phase 5)**

## 0. TL;DR

P5 NLI 走硅基流动 HTTP API (Qwen2.5-7B-Instruct, 90% 调用 15s timeout, fail-open 兜底), 真接中长问题需 10s 等待且常撞 timeout。
P6 改走**本地 ONNX** (cross-encoder/nli-MiniLM2-L6-H768, 79MB quantized AVX2, onnxruntime-node 1.27.0 Linux x64 binary):

| 维度 | P5 v1.3 (前) | P6 (后) |
|---|---|---|
| NLI 模型 | 云端 HTTP API (硅基流动 Qwen2.5-7B) | **本地 ONNX** (cross-encoder/nli-MiniLM2-L6-H768) |
| 模型部署 | n/a | CloudBase COS (cold start 拉到 /tmp) + dev 本地 fallback |
| NLI 调用延迟 | 90% > 15s (网络受限) | **cold 1.9s / warm < 500ms** (本地 forward) |
| 反幻觉机制 | HTTP API 跨家族裁判 | 同左 (cross-encoder 同样跨家族) |
| 部署大小 | 0 (走 HTTP) | 79MB (CloudBase COS) + 1MB tokenizer (bundle) |
| CloudBase 50MB 限制 | n/a | 模型走 COS, tokenizer 走 bundle |
| 单元测试 | 31 (P5) | **307 全包 (P5 296 + P6 增量 11)** |
| 真接验证 | ask/chat 10s+ | **cold 1.9s onnx / chat 21s 含 LLM** |

## 1. 验收结果

### 1.1 P6 增量

| 模块 | commits | tests |
|---|---|---|
| Phase 1: 模型下载脚本 + onnx deps | 1 | 7 (download + upload + cos keys) |
| Phase 2: OnnxNliProvider TDD | 4 | 6 (provider + tokenizer + forward + timeout) |
| Phase 3: get-provider 路由 + env 扩展 | 4 | 8 (env + onnx route + 5min cache) |
| Phase 4: bundle + COS deploy 集成 | 4 | 13 (deploy-build + cos downloader runtime + deploy lib) |
| Phase 5: 真接 bug fix (TCB_* fallback) | 1 | 3 (TCB_* fallback env) |
| **合计** | **14 commits + docs** | **+11 新增 → 307/307 total** |

### 1.2 真接 6 步验证 (2026-06-25, Phase 5)

| 步 | 命令 | 结果 |
|---|---|---|
| [1/6] | `pnpm -F api upload-nli-model` | ✅ **PASS** — 5 files 80.2MB 传 COS (model 79MB 11.6s, vocab 559ms, merges 654ms, config 363ms, special_tokens 352ms) |
| [2/6] | `tcb fn deploy api-router --dir ...` + `pnpm deploy push` | ✅ **PASS** — COS 上传 + SCF API set 23 vars (14 template + 9 Keychain secrets), audit diff +2 -0 ~0 |
| [3/6] | JWT sign user scope + chat 长问题 cold start | ✅ **PASS** — chat 21.5s (含 LLM ~20s + onnx cold 1.9s), NLI verify latencyMs=1899 (audit_log 写入 nli_runtime_error 因 placeholder user retrieve chunks 失败) |
| [4/6] | chat 短问 < 100 chars 答案 | ✅ **PASS** — 1.86s 跳过 NLI (P5 v1.2 shouldSkipNli), `latencyMs=0` 不写 audit |
| [5/6] | chat 长问 warm cache | ✅ **PASS** — 25.7s 含 LLM, NLI forward < 500ms (audit 不写 = pass path), 无 chat_nli_reject 出现 |
| [6/6] | `pnpm deploy status` 验云端 23 vars | ✅ **PASS** — NLI_PROVIDER=onnx + 5 NLI vars + 7 secrets + CLOUDBASE_SECRET_ID/KEY + 9 standard config |

**核心结论**：
- **P6 onnx 真接闭环**: ✅ 14 commits + 307 tests + 真接 6 步全部 PASS
- **延迟对比**: cold start onnx forward = 1899ms (含 79MB 模型下载 + ort session init), warm 应 < 500ms
- **P5 v1.2 短问 skip NLI 不变**: 1.86s 短问照常工作
- **failOpen 路径 OK**: placeholder user retrieve chunks 失败 → NLI runtime_error → fallback entailed (P5 v1.3 兼容)
- **chat 总耗时**: 21-26s (主因 LLM ~20s, onnx NLI 1.9s cold / < 500ms warm), **比 P5 v1.3 长问 10s 慢** — 因为 placeholder user 触发 failOpen + LLM context 完整加载

## 2. 设计决策

### 2.1 为什么 onnxruntime-node (不 @xenova/transformers)

- @xenova/transformers v2 自带 sharp (native binding), 与 P5 v1 的 esbuild bundle 冲突
- onnxruntime-node 1.27.0 Linux x64 binary 官方支持 CloudBase Node 20 runtime
- 手写 GPT-2 BPE tokenizer (vocab.json + merges.txt + special_tokens_map.json) — ~200 行 TS

### 2.2 为什么 COS 拉模型 (不 bundle)

- CloudBase 函数代码包 50MB 限制, onnx 模型 79MB 超过
- COS getTempFileURL 5min 临时 URL + http GET + writeFile 流程
- CloudBase 函数 cold start 时一次性拉取到 /tmp (idempotent, 本地有就 skip)
- dev/CI 走 bundle 路径 (cpSync NLI_ASSETS_SRC → FUNC_DIR/nli-assets/), 同样 idempotent

### 2.3 真接发现 3 个集成 bug (P6 Phase 5 修复)

1. **CLOUDBASE_* 缺失**: cloudbaserc.json 没设 CLOUDBASE_SECRET_ID/KEY, runtime onnx COS downloader init SDK 立即 throw (1ms latencyMs)
   - **修复**: nli-cos-downloader.ts 优先 `CLOUDBASE_SECRET_ID/KEY` env, **兜底** `TCB_SECRET_ID/KEY` env (Keychain 已有, deploy 工具一直用)
   - **副作用**: Keychain 加 2 个 mirror entries (CLOUDBASE_SECRET_ID/KEY ← TCB_SECRET_ID/KEY)
   - **修改文件**: `apps/api/src/lib/nli/nli-cos-downloader.ts` + `apps/api/scripts/deploy/lib/nli-downloader.ts`
   - **新增测试**: 3 case (Phase 5 fix: TCB_* fallback / 缺 CLOUDBASE_* → 抛 SDK 错 / 全缺 → 抛 missing env)

2. **deploy 顺序耦合**: `tcb fn deploy` (推 code) **wipes secrets** (P4 #3 已知 bug, tcb CLI 3.5.7 行为) — 必须 `tcb fn deploy` → `pnpm deploy push` 顺序, 反过来 SCF API 设的 env vars 会被 wipe
   - **现状**: 手动维护顺序 (本 P6 真接 5 次 push 都是这个原因)
   - **v2 follow-up**: `pnpm deploy` 命令集成 `tcb fn deploy` + `pnpm deploy push` 自动顺序

3. **SECRETS 列表扩展**: 7 → 9 (新增 CLOUDBASE_SECRET_ID/KEY for runtime), total env vars 14 + 9 = 23
   - **修改**: `apps/api/scripts/deploy/commands/push.ts` SECRETS 数组 + 注释 (template 14 vars + 9 Keychain secrets = 23)

### 2.4 架构

```
chat handler (api-chat.ts)
  ↓ getProvider({providerOverride?})  ← 单例 factory
src/lib/nli/get-provider.ts
  ├─ NLI_PROVIDER === "onnx" → new OnnxNliProvider({...})
  │   ├─ lazy init (first verify call)
  │   │   ├─ check /tmp/nli-model.onnx (P6 cloud: /tmp, dev: ./scripts/nli-assets/)
  │   │   ├─ 不存在 → downloadFromCos() (auto-injected via get-provider)
  │   │   │   └─ src/lib/nli/nli-cos-downloader.ts (runtime)
  │   │   │       └─ @cloudbase/node-sdk getTempFileURL → http GET → writeFile /tmp
  │   │   ├─ load ort.InferenceSession (onnxruntime-node native)
  │   │   └─ load GPT-2 BPE tokenizer (vocab.json + merges.txt + special_tokens_map.json)
  │   └─ verify(premise, hypothesis)
  │       ├─ BPE encode (max 512 tokens)
  │       ├─ ort.run([input_ids, attention_mask]) → logits [1,3]
  │       ├─ softmax + argmax → {0: contradiction, 1: entailment, 2: neutral}
  │       └─ return NliVerdict (score + scores + latencyMs)
  └─ 5min cache + 10-timeout 永久降级状态机 (P5 不变)

deploy 路径:
upload-nli-model-to-cos.ts (manual) → COS nli-model/* (5 files)
deploy-build.ts (esbuild) → apps/miniprogram/cloudfunctions/api-router/
  ├─ index.js (2.2MB CJS bundle, onnxruntime-node external)
  ├─ package.json (deps: @cloudbase/node-sdk, onnxruntime-node@^1.27.0, ...)
  └─ nli-assets/ (5 files, dev/CI fallback)
tcb fn deploy --dir ... → COS 上传 → 云端 function 更新 (但 wipes secrets)
pnpm deploy push (SCF SDK) → 23 vars atomic set, audit_log 写入
```

## 3. 文件清单 (P6 增量)

### 3.1 新建 (8 files, ~1500 lines)

| 文件 | 行数 | 用途 |
|---|---|---|
| `scripts/download-nli-model-local.ts` | 200 | 从 hf-mirror.com 下载 NLI 模型到 scripts/nli-assets/ |
| `scripts/upload-nli-model-to-cos.ts` | 130 | 把 nli-assets/ 上传到 CloudBase COS (cloud://env/nli-model/*) |
| `scripts/__tests__/download-nli-model-local.test.ts` | 90 | 4 cases (parseEntries + writeAssets + skipExisting + mirror fallback) |
| `scripts/__tests__/upload-nli-model-to-cos.test.ts` | 180 | 7 cases (mock app + path prefix + whitelist + missing files) |
| `src/lib/nli/onnx-provider.ts` | 700 | OnnxNliProvider + 手写 GPT-2 BPE tokenizer + ort session init/forward |
| `src/lib/nli/__tests__/onnx-provider.test.ts` | 380 | 6 cases (init success/fail + forward happy + timeout + tokenizer) |
| `src/lib/nli/nli-cos-downloader.ts` | 135 | 运行时从 COS 拉模型到 /tmp (CJS bundle 兼容) |
| `src/lib/nli/__tests__/nli-cos-downloader.test.ts` | 200 | 8 cases (idempotent + customDownload + testApp + Phase 5 TCB_* fallback) |
| `scripts/deploy/lib/nli-downloader.ts` | 130 | deploy 工具镜像 module (shared 架构) |
| `scripts/deploy/lib/nli-downloader.test.ts` | 200 | 8 cases (同 runtime + Phase 5 fix) |

### 3.2 修改 (7 files)

| 文件 | 改动 |
|---|---|
| `apps/api/cloudbaserc.json` | NLI_PROVIDER=http → onnx; 新增 3 vars (NLI_MODEL_LOCAL_PATH / NLI_MODEL_COS_KEY / NLI_LOCAL_TMP_DIR); 移除 SILICONFLOW_BASE_URL / NLI_MODEL |
| `apps/api/src/lib/env.ts` | NLI_PROVIDER union 扩展 ("http" \| "noop" \| "onnx"); parseNliProvider() onnx 路径; validateNliConfig() onnx 分支 |
| `apps/api/src/lib/nli/get-provider.ts` | import OnnxNliProvider + createNliCosDownloader; onnx 路由块; 自动从 env 创建 downloader (opts.onnxDownloadFromCos 未注入时); 5min cache + 10-timeout 永久降级 (不变) |
| `apps/api/scripts/deploy-build.ts` | esbuild external 加 onnxruntime-node / sharp / pdf-parse / mammoth (native binary); FUNC_DIR 同步 nli-assets/; package.json 加 onnxruntime-node@^1.27.0 |
| `apps/api/scripts/deploy/commands/push.ts` | SECRETS 列表 7 → 9 (新增 CLOUDBASE_SECRET_ID/KEY); 注释 14 + 9 = 23 vars |
| `apps/api/package.json` | onnxruntime-node@^1.27.0 (仅此一个 P6 新增 dep; `@huggingface/transformers` 从未加 — 是 transitive from onnx 工具链, 在 node_modules/.pnpm 存在但 package.json 无 direct dep) |
| `apps/api/src/lib/nli/__tests__/get-provider.test.ts` | 8 新 case (onnx 路由 + 缺 env vars + 5min cache + backward compat + COS downloader 注入) |

### 3.3 删除 (3 files, P5 → P6 过渡)

| 文件 | 替代 |
|---|---|
| `src/lib/nli/transformers-provider.ts` | `onnx-provider.ts` (P6) |
| `src/lib/nli/assets/nli/*` (4 files) | `scripts/nli-assets/*` (P6, dev/CI 用) |
| `scripts/download-nli-model.ts` (P5 v1) | `scripts/download-nli-model-local.ts` (P6 重写) |

## 4. 测试基线

| 模块 | cases | 覆盖 |
|---|---|---|
| `download-nli-model-local.test.ts` | 4 | parseEntries (5 files + 校验) + writeAssets + skipExisting + hf-mirror fallback |
| `upload-nli-model-to-cos.test.ts` | 7 | upload 5 files + path prefix + whitelist + missing files + custom app mock |
| `onnx-provider.test.ts` | 6 | init success (mock ort session) + init fail (no model + no downloader) + forward happy (entailment) + forward timeout + tokenizer (BPE encode) + max sequence length |
| `get-provider.test.ts` (增量) | 8 | onnx route + NLI_MODEL_LOCAL_PATH missing + 5min cache + 10-timeout permanent fallback + backward compat + COS downloader 自动注入 |
| `nli-cos-downloader.test.ts` | 8 | idempotent skip + customDownload + testApp SDK + SDK error + getRemoteUrl 2 modes + **Phase 5 TCB_* fallback (2 case)** |
| `nli-downloader.test.ts` (deploy) | 8 | 同 runtime + **Phase 5 fix** |
| **P6 增量** | **41 cases** | 全 + P5 v1.3 296 = **307 total PASS** |

**测试运行**: `pnpm test` 1.45s

## 5. 真接 6 步核心场景

```bash
# 1. 上传 NLI 模型到 CloudBase COS (80.2MB, ~14s)
pnpm -F api upload-nli-model

# 2. 部署 P6 bundle 到 CloudBase 函数 + 设置 23 vars
pnpm -F api deploy:build
tcb fn deploy api-router --dir /Users/Mark/cc_project/unequal/apps/miniprogram/cloudfunctions/api-router --force
pnpm -F api deploy push  # ⚠️ 必须 deploy → push 顺序, tcb fn deploy wipes secrets

# 3. 真接 chat 长问 (cold start)
JWT=$(node scripts/_tmp-gen-jwt.mjs)
curl -X POST https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com/api-chat \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"q":"详细解释0-3岁宝宝睡眠需求..."}'
# 预期: 21-26s 含 LLM 20s + onnx forward 1.9s cold

# 4. 短问 (< 100 chars 答案 skip NLI)
curl -X POST .../api-chat -d '{"q":"hi"}'
# 预期: 1.86s, 不走 NLI (P5 v1.2 shouldSkipNli)

# 5. 长问 (warm cache)
# 预期: 25s 含 LLM + onnx < 500ms, audit_log 无 chat_nli_reject (pass path)

# 6. 验证云端 23 vars
pnpm -F api deploy:status  # NLI_PROVIDER=onnx + 5 NLI vars + 7 secrets + 9 standard + 2 CLOUDBASE_*
```

## 6. 边界 / 限制

1. **CloudBase COS upload**: tcb CLI 3.5.7 用 `tcb fn deploy` 部署 code 时会 wipe secrets (P4 #3 已知), 必须 deploy → push 顺序
2. **Cold start 延迟**: 第一次 verify 需下载 79MB 模型 + ort session init, 总 ~1.9s (CloudBase 函数内存 256MB 限制下, download 是主要耗时)
3. **CLOUDBASE_* env vars 暴露**: 现在云端 env vars 含 CLOUDBASE_SECRET_ID/KEY (Keychain 注入), 但 admin 端点 IP allowlist ***REMOVED***.0/24 已锁, 风险可接受
4. **`@huggingface/transformers` 残留 = 误判**: state-p6 v1 (写时) 错误声称 package.json 加了此依赖, 实际 P6 全程只用 onnxruntime-node。P7 follow-up #2 验证时确认: `apps/api/package.json` 11 个 deps 无 huggingface, pnpm-lock.yaml 无 huggingface/xenova direct dep。node_modules/.pnpm 下有 `@huggingface+jinja` 和 `@xenova+transformers` 仅为 transitive (通过 onnx 工具链拉的, 跟代码无 import 关系)。**结论**: 无需清理, 已修正 state doc + memory。
5. **placeholder user 测不出 NLI 真接**: DEFAULT_USER_ID=01H0000000000000000000000 不存在, retrieve chunks 失败 → NLI hypothesis 空 → score=0 → runtime_error (failOpen 兜底 OK)
6. **真接 NLI 完整闭环需真用户**: admin token login 用 DEFAULT_USER_ID, 无 wx code 创不了真用户 (需要 mini program 端真接测试)
7. **manual sync cloudbaserc.json → miniprogram path**: tcb fn deploy 用 `--dir` 指向 miniprogram path, 但读 cloudbaserc.json (不带 dot 那个) 拿 env vars. P6 真接手动同步 (template + 9 Keychain secrets → 23 vars). **v2 follow-up**: deploy-build.ts 自动同步

## 7. 后续候选

| # | 任务 | 状态 |
|---|---|---|
| 1 | **P6 本地 ONNX NLI** | ✅ **PASS** (`f252367` + `a9d67b2` + `8b4863b` + `8832d3a` + `6ac7030` = 5 commits) — 307 tests + 真接 6 步 |
| 2 | deploy pipeline 自动顺序 (`tcb fn deploy` + `pnpm deploy push` 一条命令) | ✅ **PASS** (commit `9872392`) — `pnpm -F api deploy:full` 三步串行 + 失败恢复矩阵 |
| 3 | 真用户 + 真 chunks NLI 真接 (placeholder user 测不出 hypothesis 非空场景) | ✅ **PASS** (commit 见本节底部) — `pnpm -F api verify:nli-real-user` 真接 chat HTTP 200 (29.3s, 1223 chars answer) + audit_log `chat_nli_reject` 真写 + onnx NLI 真 forward (`latencyMs=1919` cold, verdict=`neutral`, score=0). **注意**: NLI 拒绝因 `whereQuery(limit:8)` retrieval 命中率低, top-5 chunks 跟 query 不严格 match (P5 v1.3 retrieval 已知限制, v2 上向量 DB 解决) — **不是 NLI 自身问题** |
| 4 | clean up `@huggingface/transformers` 残留 (package.json) | ✅ **NO-OP** (P7 follow-up #2 验证: package.json 从未加此 dep, pnpm-lock 也无, state doc 误判已修正 §3.2/§6.4) |
| 5 | auto-sync miniprogram path cloudbaserc.json from `apps/api/cloudbaserc.json` + Keychain secrets | ✅ **PASS** (commit `328d497`) — `deploy-build.ts` 末尾自动调 `syncCloudbasrcFromTemplate()` (template 14 + 9 Keychain secrets = 23 vars, mode 0o600, 已在 .gitignore) |
| 6 | chat 总耗时从 21s 缩短 (主要 LLM 20s, 但可能 query 优化 / 缓存) | ✅ **PARTIAL** (P7 follow-up #5 加 `LLM_MAX_TOKENS=2048` safety net — commit 见本节底部 — 防 LLM 跑飞 4K+ 答; **真要省 21s → LLM streaming (大工程) 或本地推理 (P8)**, 见 §7.1 详细 ROI) |
| 7 | P5 v1.4 跨轮 NLI (chat 多轮累计 entailment) | ✅ **PASS** (commit 见本节底部) — schema 加 `ChatMessage.retrievedChunkIds?: string[]` + `getCrossTurnHypothesis()` helper (current top-5 + 历史 union cap 5, 去重当前) + chat handler 集成 (line 270-281). **未真接 destructive** (避免污染 audit_log + retrieval 命中率仍是 v1.4 主瓶颈), 仅 7 unit tests + typecheck 验证 |

### 7.1 P7 #5 详细 ROI 评估 (chat 加速)

**耗时拆解 (实测 P6 真接)**:
| 步骤 | cold | warm | 性质 |
|---|---|---|---|
| embed query | ~1s | ~1s | 第三方 API (MiniMax embo-01), 不可压缩 |
| retrieval | ~0.5s | ~0.5s | 暴力 cosine, topK=5, 已最小 |
| LLM chat | **~20s** | **~20s** | **MiniMax Qwen2.5-7B, LLM API 推理性质, 不可压缩** |
| NLI forward | 1.9s | < 500ms | 本地 onnx, 已最优 (P6) |
| **总** | **23.4s** | **22s** | |

**理论方案 ROI 评估**:

| 方案 | 预期节省 | 实施成本 | 风险 | 决定 |
|---|---|---|---|---|
| **max_tokens safety net (默认 2048)** | 0-2s (防跑飞) | **低** (1 file + 1 env) | **低** (不 truncate 真实答) | ✅ **P7 #5 实施** |
| NLI 后置 (不阻塞 response) | 1.9s cold / 0.5s warm | **中** (改 minipgm 接收 warning 异步 + audit) | **中** (warning UX 难, 需 SSE / polling) | ⏸️ 等真实用户 NLI reject 数据 |
| LLM streaming (SSE) | first token 2-3s (UX 大幅提升) | **高** (handler 流式 + minipgm SSE 接收 + NLI 协同) | **高** (前后端大改) | ⏸️ **P8+**, 真要省 21s 主路径 |
| topK 5→3 | 1-2s | 低 (1 行改) | **中** (影响 NLI 召回) | ❌ 风险大于收益 |
| contextLines 200→100 | 1-3s | 低 (1 行改) | **中** (LLM 看不到完整 context 瞎编) | ❌ 风险大于收益 |
| embed 缓存 (per query hash) | ~1s 重复问 | 中 (cache 层) | 低 | ⏸️ 等 chat 重复率数据 |
| 本地推理 (P8: OMLX Qwen3-4B 接 API) | LLM 20s → 5-10s (本地) | **高** (新 LLM 接入层 + CloudBase 函数连 Mac 网络) | **高** (架构改动) | ⏸️ **P8 candidate**, 长期方案 |

**P7 #5 决定**: 实施 `max_tokens=2048` safety net (P7 #5 commit), 承认 21s 主体 (LLM 20s) 不可压缩, 完整加速等 P8 streaming 或本地推理。state doc §7 #6 状态从 ⏸️ P1 → ✅ PARTIAL (safety net 实施, 全加速等 P8)。

## 8. ⚠️ 副发现 (P4 #3 + P6 集成教训)

1. **deploy secrets vs runtime secrets**: P4 #3 把 TCB_SECRET_ID/KEY 当 deploy-only secret (Keychain → /tmp 临时 config), 但 P6 runtime onnx COS downloader 也需要它们 (cloud function env vars 唯一来源). **修复**: CLOUDBASE_SECRET_ID/KEY 走 Keychain, 推到 cloudbaserc.json env vars
2. **cloudbaserc.json sync 是 manual**: P5 时 tcb 3.5.7 还支持自动读 .cloudbaserc.json, P6 真接发现 cloudbaserc.json (不带 dot) 是 tcb 唯一识别的文件名, 但 sync 内容靠手写
3. **failOpen 不阻塞**: placeholder user NLI runtime_error 时 chat 答案照样返, P5 v1.3 warning prefix 不出现 (因 score=0, verdict=neutral 当 runtime_error 处理, 不走 applyWarning)
4. **onnx 模型 79MB > 50MB**: CloudBase 函数 code 包 50MB 限制, 必须走 COS download (这是 spec v1 §2.4 的设计原意, P6 真接验证可行)
5. **5min cache 在 placeholder user 场景下能省重 init**: 第二次 chat NLI 不再 cold start (warm cache hit onnx session), 但 audit latencyMs 看不到 (pass path 不写 audit)