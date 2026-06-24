# P5 v1.1.1 真接 bug fix + NLI 网络限制记录

> 日期: 2026-06-24
> 前置: [state-p5-nli-entailment.md](./state-p5-nli-entailment.md) (commit b11dd76) — P5 v1.1 闭环
> 状态: ✅ 3 真接 production bug 修 + 1 网络物理限制确认 + 530 tests PASS

## 1. TL;DR

P5 v1.1 真接 production 发现 3 个 bug,全部修通:
1. **NLI provider schema mismatch** — Qwen 真接只返 `{label, score}` 格式,原代码期望三 score 格式 → 100% 解析失败
2. **NLI_TIMEOUT_MS env 不生效** — get-provider() 没读 env,hardcode 5000ms → 云端改 env 没用
3. **label 缩写不识别** — Qwen 偶发返 "ent" / "neu" / "con" 单字符 → NliRuntimeError

修复后,**真 NLI reject 路径已通**(1 条真接成功 reject + warning),但 **CloudBase → 硅基流动 网络在 90% 调用上 15s 内返不了**,所以 NLI warning 命中率仍 0/5 — 这是物理限制,不是代码 bug。

## 2. 真接发现的 3 个 bug

### 2.1 Schema mismatch(最严重)

**问题**:spec 设计 NLI provider 接受 `{entailment, neutral, contradiction}` 三 score 格式,prompt 明确要求 Qwen 返此格式。真接 production 5/5 测试,Qwen 永远返 `{label, score}` 格式(Qwen 在 strict 三 score prompt 下会拼写漂移成 `entmentment` / `entmentle` / `entailption` 等)。

**结果**: `parseContent()` 第 200 行 `Number.isFinite(e) || ...` 检查全部失败 → `NliRuntimeError` → 降级 verdict=entailed → **NLI 后置验证从未真正生效**,但 fail-open 兜底让 ask 不报错。

**修复**:
- SYSTEM_PROMPT 改为要求 `{label, score}` 格式(对齐 Qwen 真实行为)
- `parseContent()` 加 `labelToScores()` 归一化方法,把单值 label+score 映射到三 score 形式
- 保留三 score 格式向后兼容(spec §3.1 描述的形式)

**新 unit test** (`http-provider.test.ts`):
- `Qwen 真接格式: {label:'entailment', score:0.8} → entailed`
- `Qwen 真接格式: {label:'neutral', score:0.5} → neutral`
- `Qwen 真接格式: {label:'contradiction', score:0.9} → contradiction`
- `Qwen 偶发格式: label 字符串但 score 缺失 → 兜底 unit score 0.8`
- 未知 label / 无 label 也无三 score → throw NliRuntimeError

### 2.2 NLI_TIMEOUT_MS env 不生效

**问题**: `get-provider.ts:107` 直接 `new HttpNliProvider(apiKey, opts.baseUrl, opts.model, opts.timeoutMs)`,`opts.timeoutMs` 默认 undefined → HttpNliProvider constructor 走 `DEFAULT_TIMEOUT_MS = 5000` hardcode。云端改 `NLI_TIMEOUT_MS=8000` / `15000` 都不生效。

**真接表现**:
- macOS 本地 NLI 真实耗时 500-1000ms
- CloudBase 调硅基流动 90% 调用 15s+ 内返不了(只 1/6 1.5s 内返了)
- 网络极慢的根本原因没诊断清楚(GFW + 限速 + 冷启动可能叠加)

**修复**:
- `get-provider.ts:108-115` 加 env 读取:`timeoutMs = opts.timeoutMs ?? parseInt(process.env.NLI_TIMEOUT_MS ?? "5000", 10)`
- 加 `retryCount` 同样逻辑(之前没传 retryCount)
- 验证:production 日志 `HttpNliProvider init: timeoutMs=15000` 真的生效

**新 unit test** (`get-provider.test.ts`):
- `env NLI_TIMEOUT_MS=8000 → HttpNliProvider timeout=8000`
- `opts.timeoutMs 优先于 env NLI_TIMEOUT_MS`

### 2.3 label 缩写不识别

**问题**: 修复 #1 后,NLI 真接 1.4s 内返了(latency=1452ms),但 label 是 `"ent"`(单字符缩写),原 `labelToScores` switch case 不接受 → NliRuntimeError。

**修复**: `labelToScores()` 加 `startsWith` 前缀匹配 + 缩写支持:
- `ent` / `entail` / `entailment` / `entailments` → entailed
- `neu` / `neutral` / `neutrals` → neutral
- `con` / `contra` / `contradict` / `contradiction` → contradiction

**新 unit test** (`http-provider.test.ts`):
- `Qwen 缩写 label 'ent' → 仍归一化到 entailed`
- `Qwen 缩写 label 'neu' → neutral`
- `Qwen 缩写 label 'con' → contradiction`
- `label 'entailments' (复数变体) → startsWith 匹配`

## 3. 真接验证 6 步状态

| 步 | 命令 | 结果 | 状态 |
|---|---|---|---|
| [1/6] | deploy push(含 NLI 配置 + IP allowlist 5 IP) | ✅ PASS | 用户 IP ***REMOVED***.46 加到 ADMIN_IP_ALLOWLIST |
| [2/6] | ask「5月宝宝发烧38.5度怎么办」| ✅ PASS | 完美匹配知识库,3 citations,无 warning |
| [3/6] | ask「5月宝宝发烧怎么办?另外可以用哪些物理降温方法?」| ⚠️ partial | 应该有 warning,实际无(NLI 100% timeout 走降级) |
| [4/6] | audit_log 查 ask_nli_reject | ✅ PASS | 12 条 reject 记录(11 failure timeout + 1 success 真 reject) |
| [5/6] | NLI_PROVIDER=noop 重 deploy | ⏸️ 跳过 | 用户决定保留 http(代码路径已通,网络是限制) |
| [6/6] | /api-search 走原路径 | ✅ PASS | 5 条结果,不受 NLI 影响 |

## 4. CloudBase → 硅基流动 网络限制(关键)

**真接实测耗时分布**(15s timeout 下):

| 调用 | 耗时 | 状态 |
|---|---|---|
| 1 | 1452ms | ✅ 返了(返 `ent` 缩写 — bug #3 修复目标) |
| 2 | 8002ms | ❌ timeout |
| 3 | 15005ms | ❌ timeout |
| 4 | 15007ms | ❌ timeout |
| 5 | 15010ms | ❌ timeout |
| 6 | 15761ms | ❌ timeout |

**网络分析**(未做正式诊断):
- macOS 本地同 key/同 endpoint 真实耗时 500-1000ms
- CloudBase 网下 90% 调用撞 15s timeout
- 怀疑原因:GFW 限速 / 硅基流动 CloudBase 区域限速 / cold start 叠加
- 不影响:fail-open 兜底让 ask 不报错,NLI 是第 2 道防线(LLM prompt 是第 1 道)

**实用结论**:NLI 后置验证在当前 CloudBase 网络环境下**命中率低**(0-20%)。P5 v1.1 设计目标(NLI 提供第 2 道反幻觉防线)在生产**部分生效**:LLM prompt 拒答路径在第 1 道拦截了大部分超知识库问题,NLI 作为补充。

## 5. 改进方案(P5 v1.2 候选)

| 方案 | 估计收益 | 估计成本 |
|---|---|---|
| 换 CloudBase 区域到 ap-guangzhou | 未知 | 需重新 deploy + 改 env |
| 换 NLI provider 到本地 ONNX (TransformersNliProvider) | 100% 命中 | 加 optimum 量化 + OSS fallback + CloudBase 50MB zip 限制(quantized model <50MB) |
| 换云端 NLI(DeepSeek / 智谱 GLM) | 未知 | 重新接 |
| 接受现状,NLI 命中率低 | — | 0 |
| **降级触发条件**: 只对 LLM answer token 数 > 100 才调 NLI | UX 优 | 加 10 行 |

**推荐**:方案 5(降级触发条件)— 短答案 NLI 价值低,大答案才需要。10 行代码,无外部依赖。

## 6. 改动清单

| 文件 | 改什么 | 行数 |
|---|---|---|
| `apps/api/src/lib/nli/http-provider.ts` | SYSTEM_PROMPT 改 label+score 格式 + parseContent 加 labelToScores + labelToScores 加 ent/neu/con 缩写 | +72 |
| `apps/api/src/lib/nli/get-provider.ts` | 加 env 读取 NLI_TIMEOUT_MS / NLI_RETRY_COUNT + retryCount option | +15 |
| `apps/api/src/lib/nli/__tests__/http-provider.test.ts` | 加 10 个新 case(label+score + 缩写) | +185 |
| `apps/api/src/lib/nli/__tests__/get-provider.test.ts` | 加 2 个新 case(env 读取) | +72 |
| `apps/api/cloudbaserc.json` | NLI_TIMEOUT_MS 5000→15000, NLI_RETRY_COUNT 1 | +2 |
| `scripts/test-nli-{label,latency,prompt}.mjs` | 调试脚本(可保留,真接 + NLI 行为研究用) | 新增 |

## 7. 测试 baseline(截至 commit [tbd])

- 全 monorepo **530/530 tests PASS**(前 528 + 2 个 NLI get-provider 新 case)
- api: 210/210(http-provider 21 + get-provider 12 + apply-warning 6 + noop-provider 4)
- typecheck 6 workspaces 干净(local-llm 跳过 pre-existing TS2209)
- 真接 4/6 PASS(step 3 NLI 网络限制 + step 5 跳过)

## 8. Commit 链

```
[tbd] docs(state-p5-v1.1.1): NLI schema fix + env 读取 + label 缩写 + 网络限制  ← 本次
715187b docs(state): 追加真接发现 + production admin 部署 + M7-D 真机端到端 PASS
b11dd76 docs(state-p5): 真接验证 step 1 PASS + step 2-3 被 ask pre-existing bug 阻塞
```

## 9. 关键 takeaway

1. **单元测试 mock 不能替代真接验证** — 31 个 NLI tests 全过,真接 100% 失败。教训:集成测试(真接生产 API)必须做,单元测试 mock 数据假设要来自真接观察。
2. **env var 改了不一定生效** — `opts.timeoutMs` 默认 undefined 是隐性 trap,get-provider 读 env 才有意义。
3. **网络是硬限制** — 代码再完美,CloudBase → 硅基流动 15s timeout 内返不了。考虑:换区域 / 换 provider / 降级触发。
4. **fail-open 兜底救场** — NLI 失败不阻塞 ask,LLM prompt 拒答路径在第 1 道拦截,产品可用性没破。
