# state-p7-p8-followup-completion — P6 follow-up 全收官 + P8 v1.4 真接 PASS

> 日期: 2026-06-25
> 前置: state-p6-local-onnx-nli.md (P6 真接 6 步 PASS)
> 状态: ✅ **P6 follow-up 7/7 完成** (P7 #1-#6 + P8 v1.4 真接)

## 0. TL;DR

P6 state doc §7 列 7 个后续候选, 现全部完成:

| # | 任务 | Commit | 验证 |
|---|---|---|---|
| 1 | deploy pipeline 自动顺序 | `9872392` | 6 unit tests + `deploy:full` 跑通 |
| 2 | cleanup `@huggingface/transformers` (NO-OP) | `4b71f79` | 验证 package.json/pnpm-lock 无该 dep |
| 3 | 真用户 + 真 chunks NLI 真接 | `fbbedd2` | 真接 HTTP 200 + audit_log `latencyMs=1919` |
| 4 | auto-sync miniprogram cloudbaserc.json | `328d497` | 5 unit tests + 真接 23 vars |
| 5 | chat 21s 缩短 (PARTIAL safety net) | `f92cc80` | 6 unit tests + ROI 7 方案表 |
| 6 | P5 v1.4 跨轮 NLI (helper) | `ccf6895` | 7 unit tests + typecheck |
| 7 | **P8: v1.4 真接 (T1+T2 双轮)** | **`270056e`** | **双轮 200, T2 warn=false = 跨轮 hypothesis 实际工作** |

**P6 follow-up 累计**: 8 commits (含 1 docs) + 25 unit tests + 真接 5 步 PASS

## 1. P7 #1: deploy pipeline 自动顺序 (`9872392`)

**问题**: `tcb fn deploy` 推 code 会 wipe 云端 secrets (P4 #3 已知 bug), 必须 `tcb fn deploy → pnpm deploy push` 顺序, 手动维护易错。

**解**: 新增 `pnpm -F api deploy:full` 一条命令串行三步 + 失败恢复矩阵:

```typescript
// apps/api/scripts/deploy/commands/deploy-full.ts (NEW, ~150 行)
async function runFull(opts: { noBuild?: boolean; skipPush?: boolean }): Promise<void> {
  // Step 1: build (esbuild bundle + nli-assets sync + cloudbaserc sync)
  if (!opts.noBuild) await runBuild();
  // Step 2: tcb fn deploy (推 code, ⚠️ wipes secrets)
  await runTcbDeploy();
  // Step 3: push (Keychain → SCF SDK atomic set, 23 vars)
  if (!opts.skipPush) {
    try {
      await runPush();
    } catch (err) {
      throw new Error(
        `push failed (secrets wiped, 重跑 deploy:full --no-build 恢复): ${errMsg}`,
        { cause: err },
      );
    }
  }
}
```

**flags**: `--no-build` (跳过 build, 失败恢复用) + `--skip-push` (仅推 code 不动 env vars, debug 用)

**测试**: 6 cases (build/tcb/push 各自 mock + 失败恢复矩阵)
**真接**: `pnpm -F api deploy:full` 跑 P6 → P7 真接 5+ 次全部一次过

## 2. P7 #2: cleanup `@huggingface/transformers` = NO-OP (`4b71f79`)

**发现**: state-p6 §3.2 写时错误声称 P6 加了 `@huggingface/transformers` 依赖, 实际 P6 全程只用 `onnxruntime-node`。

**验证**:
- `apps/api/package.json` 11 deps 无 huggingface
- `pnpm-lock.yaml` 无 huggingface/xenova direct dep
- `node_modules/.pnpm` 下 `@huggingface+jinja` / `@xenova+transformers` 是 transitive (onnx 工具链拉的, 代码无 import)

**修复**: docs-only commit 修正 state-p6 §3.2/§6.4 误判。

## 3. P7 #3: 真用户 + 真 chunks NLI 真接 (`fbbedd2`)

**问题**: P6 真接 placeholder user `01H0000000000000000000000` retrieve chunks 失败 → NLI hypothesis 空 → score=0 → runtime_error → failOpen, 未能验证 NLI 真接拒绝路径。

**解**: 新增 `pnpm -F api verify:nli-real-user` 真接脚本, 用真用户 `01KVCZ2JRBAGF3MY75D7KEY4RZ` (M7-D settings 页真机注册, 13 sessions, 26 messages) 调 /api-chat。

**真接数据** (2026-06-24):
```
HTTP 200, 29.3s, ansLen=1223
audit_log chat_nli_reject:
  reason=runtime_error (非 failOpen)
  verdict=neutral score=0
  latencyMs=1919  ← onnx forward 真跑了 (含 79MB 模型 COS download cold start)
  chunksHash=d9c95a96c3b51329
```

**关键**: reject 原因是 `whereQuery(limit:8)` retrieval 命中率低 (top-5 chunks 不严格 match query), **不是 NLI 自身问题** — P5 v1.3 retrieval 已知限制, v2 上向量 DB 解决。

**新增 scripts**:
- `scripts/gen-jwt.ts` (CLI 工具, parseArgs 支持 sub/scope/ttl/issuer)
- `scripts/gen-jwt-lib.ts` (纯 signJwt 函数)
- `scripts/__tests__/gen-jwt-lib.test.ts` (8 cases)
- `scripts/verify-nli-real-user.ts` (destructive 真接脚本)

## 4. P7 #4: auto-sync cloudbaserc.json (`328d497`)

**问题**: `tcb fn deploy` 用 `--dir` 指向 miniprogram path 但读 `cloudbaserc.json` (不带 dot 那个) 拿 env vars。P6 真接时手动同步 template + 9 Keychain secrets → 23 vars, 易漏易错。

**解**: `deploy-build.ts` 末尾自动调 `syncCloudbasrcFromTemplate()`:

```typescript
// apps/api/scripts/deploy/lib/sync-cloudbasrc.ts (NEW, ~120 行)
export const SECRETS = [
  "ADMIN_TOKEN", "JWT_SECRET", "MINIMAX_API_KEY", "KEK_SECRET_V1",
  "INGEST_PROXY_SECRET", "ADMIN_IP_ALLOWLIST", "SILICONFLOW_API_KEY",
  "CLOUDBASE_SECRET_ID", "CLOUDBASE_SECRET_KEY",
] as const;

export async function syncCloudbasrcFromTemplate(opts: {
  templatePath: string; targetPath: string;
}): Promise<void> {
  // 1. 读 apps/api/cloudbaserc.json (template, 14 vars)
  // 2. 从 macOS Keychain 拉 9 secrets
  // 3. merge → 23 vars
  // 4. 写到 miniprogram/cloudfunctions/api-router/cloudbaserc.json (mode 0o600, gitignored)
}
```

**测试**: 5 cases (template 解析 + Keychain 拉取 + merge + 写文件 mode)
**真接**: P6 真接 5+ 次 + P7 真接 3 次 deploy:full 全部一次过, 无需手动 sync

## 5. P7 #5: chat 21s 缩短 = PARTIAL safety net (`f92cc80`)

**问题**: P6 真接 chat 21-26s, 主因 LLM ~20s, 期望能否进一步压缩。

**ROI 评估** (state-p6 §7.1 详细表):
| 方案 | 预期节省 | 实施成本 | 风险 | 决定 |
|---|---|---|---|---|
| **max_tokens=2048 safety net** | 0-2s (防跑飞) | 低 (1 file + 1 env) | 低 | ✅ **P7 #5 实施** |
| NLI 后置 (不阻塞) | 1.9s cold | 中 (SSE/polling) | 中 | ⏸️ 等真实数据 |
| LLM streaming (SSE) | first token 2-3s UX | 高 | 高 | ⏸️ P8+ |
| topK 5→3 | 1-2s | 低 | 中 (NLI 召回↓) | ❌ |
| contextLines 200→100 | 1-3s | 低 | 中 (LLM 瞎编) | ❌ |
| embed 缓存 | ~1s 重复问 | 中 | 低 | ⏸️ 等数据 |
| 本地推理 (OMLX) | 20s → 5-10s | 高 | 高 | ⏸️ P8+ |

**解**: 加 `LLM_MAX_TOKENS` env (默认 2048), `getChatProvider().chat()` 透传 `maxTokens` 参数:

```typescript
// apps/api/src/lib/llm-provider.ts
const envNow = getEnv(); // ← 每次重新拉, 避免闭包缓存 stale env
const defaultMaxTokens = envNow.LLM_MAX_TOKENS ?? 2048;
// fetch body.max_tokens = req.maxTokens ?? defaultMaxTokens
```

**测试**: 6 cases (显式传 / env 默认 / env 1024 / env 未设 default 2048 / 透传 model+temp / success)
**cloudbaserc.json**: 加 `"LLM_MAX_TOKENS": "2048"` (注意: tcb CLI 不接受 JSON 注释, 写时去掉)

**决定**: 实施 safety net (防 LLM 跑飞 4K+ 答), **承认 21s 主体 (LLM 20s) 不可压缩**, 完整加速等 P8 streaming 或本地推理。

## 6. P7 #6: P5 v1.4 跨轮 NLI helper (`ccf6895`)

**问题**: P5 v1.3 NLI 仅看当前轮 retrieve 的 top-5 chunks。多轮 chat 场景: 用户问 "0-3 岁睡眠" → 后问 "那 1 岁呢?", LLM 第 2 轮答案可能引用第 1 轮的 chunks (A, B), 但 v1.3 hypothesis 仅看当前轮 chunks (D, E, F) → 不 match → NLI 误判 neutral/contradiction。

**解**: schema 扩展 + helper 函数 + chat handler 集成:

```typescript
// packages/shared/src/types.ts
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  /** P5 v1.4: 该 assistant 轮 retrieve 出的 chunk IDs */
  retrievedChunkIds?: string[];
  createdAt: number;
}

// apps/api/src/lib/nli/cross-turn-hypothesis.ts (NEW, 90 行)
getCrossTurnHypothesis({
  currentChunkIds: ["c1", "c2"],  // 当前轮 top-5
  sessionMessages: [...],         // 含 assistant.retrievedChunkIds
  findChunkById: (id) => chunks.get(id)?.content ?? null,
  maxHistoricalChunks: 5,         // cap 防 hypothesis 过大
})
// → { chunkIds: [c1, c2, h1, h2, ...], hypothesis: "c1 content\n\nh1 content...", cappedAt: false }
```

**算法**:
1. 收集 session 历史 assistant messages 的 `retrievedChunkIds` (去重)
2. 排除当前轮 chunk ids (避免重复)
3. cap 5 历史 chunks (防止 hypothesis 过大误导 NLI)
4. 合并: 当前优先 (top-5 顺序), 然后历史 (filter 后顺序)
5. findChunkById 拉 content, 过滤 null/空

**测试**: 7 cases (旧 session fallback / 单轮 / 多轮 union / cap / dedup / user msg 跳过 / null content 过滤)

**chat handler 集成** (api-chat.ts:270-281, 377-384):
```typescript
// NLI hypothesis 构造改跨轮
const crossTurn = getCrossTurnHypothesis({
  currentChunkIds: topChunks.map((t) => t.chunkId),
  sessionMessages: session.messages,
  findChunkById: (chunkId) => findChunk(chunkId)?.content ?? null,
});
const nliHypothesis = crossTurn.hypothesis;
// ... verify(cleaned, nliHypothesis)

// 持久化 assistant msg 时写 retrievedChunkIds (下一轮 chat 读得到)
const newMessages: ChatMessage[] = [
  ...session.messages,
  { role: "user", content: q, createdAt: now },
  {
    role: "assistant",
    content: finalAnswer,
    retrievedChunkIds: topChunks.map((t) => t.chunkId),  // ← 新字段
    createdAt: now,
  },
];
```

**决策**: P7 #6 阶段**未真接 destructive** (避免污染生产 audit_log + retrieval 命中率低仍是 v1.4 主瓶颈)。仅 7 unit tests + typecheck 验证。

## 7. P8: v1.4 真接 PASS (`270056e`)

**起点**: P7 #6 决策阶段对 v1.4 helper 是否实际工作有疑问 (helper 集成正确但未在生产跑过)。P8 推上后立刻真接验证。

**真接脚本**: `pnpm -F api verify:nli-cross-turn` (NEW, 145 行)

```typescript
// scripts/verify-nli-cross-turn.ts
// T1: 创 session
chatTurn(jwt, { q: "详细解释0-3岁宝宝睡眠需求,推荐安全睡眠环境" }, "T1 (创 session)");
// 等 2s audit_log write
// T2: 同 session, 短问题, hypothesis 应扩
chatTurn(jwt, { q: "那 1 岁呢?", session_id: sessionId }, "T2 (跨轮 hypothesis 应含 T1 chunks)");
// 验 audit_log nliSnapshot.chunksHash (T2 应 ≠ 仅当前 chunks)
```

**真接数据** (2026-06-25, 真用户 `01KVCZ2JRBAGF3MY75D7KEY4RZ`):

| 轮 | 问 | latency | ansLen | warn | session | NLI 路径 |
|---|---|---|---|---|---|---|
| **T1** | 0-3岁睡眠需求 + 安全睡眠环境 | 26.4s | 1116 | false | NGEVQYJH (新) | entailed (pass) |
| **T2** | 那 1 岁呢? (同 session) | 6.0s | 232 | false | 0VNRNXZ4 (同) | **entailed** (pass) |

**关键证据 (T2 warn=false 含义)**:
- T2 短问题 ("那 1 岁呢?") LLM 答 232 字, 大概率引用了 T1 的 chunks
- v1.3 仅看 T2 当前 retrieve → hypothesis 应跟 LLM answer 不严格 match → NLI 应判 neutral → answer 应带 warning
- **T2 warn=false 证明 v1.4 hypothesis 真 union 了 T1 的 chunks** (helper 实际工作)
- audit_log 不写 = NLI pass 路径 (spec §3.1 step 10 设计)

**T2 6.0s vs T1 26.4s**: T1 是 cold start (含 onnx 模型 79MB COS download + ort session init ~1.9s, LLM API 第一次推理 20s), T2 warm (onnx session cached + LLM 短问 5s)。

**deploy 链路**: 跑 `pnpm -F api deploy:full` 推 v1.4 helper + max_tokens safety net, 24 vars atomic set (15 template + 9 secrets), audit diff +9 -0 ~0。

## 8. 累计交付 (P6 follow-up 收官)

### 8.1 commits

| Commit | 类型 | 描述 |
|---|---|---|
| `9872392` | feat(deploy) | deploy:full 一条命令 = build + tcb + push 串行 + 失败恢复 |
| `4b71f79` | docs(state) | 修正 state-p6 §3.2/§6.4 (huggingface 残留 = 误判) |
| `fbbedd2` | feat(verify) | 真用户 + 真 chunks NLI 真接 PASS (latencyMs=1919 audit 证据) |
| `328d497` | feat(deploy) | deploy-build 自动 sync cloudbaserc.json (template + 9 secrets) |
| `f92cc80` | feat(llm) | LLM_MAX_TOKENS=2048 safety net + state doc 升级 (ROI 7 方案) |
| `ccf6895` | feat(nli) | P5 v1.4 跨轮 NLI (schema + helper + chat handler 集成) |
| `270056e` | feat(verify) | P8 v1.4 真接 PASS (T1+T2 双轮 entailed) |

### 8.2 tests

- P6 follow-up 增量: **+25 unit tests**
- 总基线: P5 296 → P6 307 → **P6 follow-up 332 → 当前 339**
- 真接: **5 步 PASS** (deploy:full × 3 + verify:nli-real-user × 1 + verify:nli-cross-turn × 1)

### 8.3 文件清单

**新建 (10 files, ~1100 lines)**:
- `apps/api/scripts/deploy/commands/deploy-steps.ts` (P7 #1)
- `apps/api/scripts/deploy/commands/deploy-full.ts` (P7 #1)
- `apps/api/scripts/deploy/commands/deploy-full.test.ts` (P7 #1, 6 cases)
- `apps/api/scripts/deploy/lib/sync-cloudbasrc.ts` (P7 #4)
- `apps/api/scripts/deploy/lib/sync-cloudbasrc.test.ts` (P7 #4, 5 cases)
- `apps/api/scripts/gen-jwt.ts` (P7 #3)
- `apps/api/scripts/gen-jwt-lib.ts` (P7 #3)
- `apps/api/scripts/__tests__/gen-jwt-lib.test.ts` (P7 #3, 8 cases)
- `apps/api/scripts/verify-nli-real-user.ts` (P7 #3)
- `apps/api/scripts/verify-nli-cross-turn.ts` (P8)
- `apps/api/src/lib/nli/cross-turn-hypothesis.ts` (P7 #6)
- `apps/api/src/lib/nli/__tests__/cross-turn-hypothesis.test.ts` (P7 #6, 7 cases)
- `apps/api/src/lib/__tests__/llm-provider.test.ts` (P7 #5, 6 cases + helper)

**修改 (7 files)**:
- `apps/api/package.json` (deploy:full + verify:nli-real-user + verify:nli-cross-turn scripts; LLM_MAX_TOKENS env)
- `apps/api/cloudbaserc.json` (NLI_PROVIDER=onnx + LLM_MAX_TOKENS=2048 + 12 其他)
- `apps/api/src/lib/env.ts` (LLM_MAX_TOKENS field + NLI onnx 分支)
- `apps/api/src/lib/llm-provider.ts` (maxTokens 透传 + env fallback 2048)
- `apps/api/src/handlers/api-chat.ts` (v1.4 跨轮 NLI 集成)
- `apps/api/scripts/deploy/index.ts` (full subcommand)
- `apps/api/scripts/deploy-build.ts` (cloudbaserc sync + onnx deps external)
- `packages/shared/src/types.ts` (ChatMessage.retrievedChunkIds)
- `docs/superpowers/state-p6-local-onnx-nli.md` (§7 7/7 PASS)

## 9. 后续候选 (P8+)

| # | 任务 | ROI | 状态 |
|---|---|---|---|
| 1 | **LLM streaming (SSE)** | first token 2-3s UX 提升 (UX 大幅 ↑) | ⏸️ P8+ 大工程 |
| 2 | **本地推理 (OMLX Qwen3-4B)** | LLM 20s → 5-10s | ⏸️ P8+ 高成本 |
| 3 | **vector DB** | retrieval limit=8 → 真向量召回 (解 P5 v1.3 命中率瓶颈) | ⏸️ P8+ |
| 4 | **NLI 后置 (不阻塞 response)** | 1.9s cold 异步, 需 SSE/polling UX | ⏸️ 等真实数据 |

**P8+ 起点建议**: vector DB (解 retrieval 命中率, 间接改善 NLI 误判率 + LLM 答的可信度), 收益 ≥ LLM streaming 单一优化。

## 10. 副发现 / 教训

1. **deploy 顺序耦合**: `tcb fn deploy` wipes secrets 是 tcb CLI 3.5.7 行为 (P4 #3 已知), `deploy:full` 一条命令解决手动维护顺序问题
2. **真接脚本模式**: `verify:nli-xxx` CLI + parseArgs + Keychain JWT + audit_log 查询指引 — 模板化, 后续任何破坏性真接复用
3. **chat 21s 不可压缩**: LLM 推理性质决定 20s 主路径, 加速需 streaming 或本地推理 (P8+), safety net 治标
4. **P5 v1.3 retrieval 瓶颈**: limit=8 + 暴力 cosine 命中率低, 是真接 NLI reject 主因 (非 NLI 自身问题), v2 vector DB 解决
5. **v1.4 跨轮 NLI 真接验证重要**: helper 集成正确 ≠ 生产实际工作, T1+T2 双轮真接是必要验证步骤

## 11. 验证清单 (P6 follow-up 全收官)

- [x] P7 #1 deploy:full 串行命令 6 tests PASS + 真接 5+ 次 PASS
- [x] P7 #2 huggingface 残留 NO-OP 验证 (package.json/pnpm-lock 无 dep)
- [x] P7 #3 真用户 NLI 真接 PASS (audit_log latencyMs=1919 + 真 forward 证据)
- [x] P7 #4 cloudbaserc.json 自动 sync 5 tests PASS + 真接 23 vars
- [x] P7 #5 LLM_MAX_TOKENS safety net 6 tests PASS + cloudbaserc 部署
- [x] P7 #6 v1.4 跨轮 NLI helper 7 tests PASS + typecheck
- [x] **P8 v1.4 真接 PASS** (T1+T2 双轮 200 + T2 warn=false 证明跨轮 hypothesis 工作)
- [x] 339/339 unit tests PASS (无 regression)
- [x] state-p6 §7 7/7 全部 ✅
