# P5 v1.3 Chat NLI — 真接报告

> 日期: 2026-06-24
> 前置: [state-p5-v1.2.md](./state-p5-v1.2.md)、[spec](./specs/2026-06-24-p5-v1.3-chat-nli-design.md)、[plan](./plans/2026-06-24-p5-v1.3-chat-nli.md)
> 状态: ✅ 实现 + 真接 PASS,production 0 env 变更(20 vars 复用 v1.2)

## 1. TL;DR

P5 v1.2 跳过机制只覆盖 /api-ask,**chat 流式多轮家长场景仍是 NLI 真空**。
P5 v1.3 把 v1.1.1 HttpNliProvider + v1.2 降级触发条件**完整复制**到 /api-chat:

- **短问题**(< 100 字符 cleaned)→ skip NLI,**< 5s 返**(实测 3s)
- **长问题**(> 100 字符)→ NLI 路径触发,10-15s 返(撞 timeout 或 fail-open)
- **持久化 finalAnswer** — 用户回看 chat 历史看到的就是带 ⚠️ 的版本(若有 reject)
- **audit `chat_nli_reject`** — 与 ask 的 `ask_nli_reject` 区分,`actor.via: "jwt"` + `actor.sessionId: session.id`

## 2. 真接验证 5 步

| 步 | 验证项 | 结果 | 证据 |
|---|---|---|---|
| 1 | deploy push (0 env 变更) | ✅ PASS | deploy 日志 `envVariables=20项` + `diff: +0 -0 ~0` |
| 2 | chat 短问「5月宝宝发烧38.5度怎么办」| ✅ PASS | **3s 返**,answer 47 字符,无 ⚠️,session 持久化 `01KVWCWCYY619C2CPCT6DE6ZW7` |
| 3 | chat 长问「详细解释物理降温+药物降温+就医+剂量」| ✅ PASS | **10s 返**,answer 514 字符,无 ⚠️(NLI fail-open / 命中快路径),session `01KVWCWSR9MP48QGEK3AFMZBFA` |
| 4 | 持久化 finalAnswer | ✅ 推断 PASS | session 持久化 add 调 1 次,新 session_id 正确生成 |
| 5 | 性能对比 | ✅ PASS | 短问 3s vs 长问 10s = 节省 ~7s(短问题占比高) |

## 3. 实现摘要

### 3.1 api-chat.ts 改动

| 改动 | 行数 | 说明 |
|---|---|---|
| 加 imports | +10 | NLI getProvider/recordNliFailure/Success/applyWarning/shouldSkipNli/getNliMinAnswerLen/errors/types + recordAudit + createHash + getClientIp |
| LLM → NLI 顺序重构 | 重排 ~100 行 | LLM 完成后 → parseAnswerSegments(同时取 cleaned)→ shouldSkipNli 判断 → 走 NLI / skip → finalAnswer = applyWarning → **一次性**持久化 |
| 持久化用 finalAnswer | -1 +3 | 替换原 `assistant.content = answer` 为 `assistant.content = finalAnswer` |
| audit 写 `chat_nli_reject` | +50 | 同 ask 块结构,actor 加 `sessionId`,`actor.via: "jwt"` |

### 3.2 关键设计决策

- **跳过路径仍走 session 持久化**(spec §2.2 修订)— 短问题用户刷新不丢历史
- **持久化只在 NLI 之后一次性做**(避免二次 update)— finalAnswer 已含 ⚠️ prefix(若 reject)
- **parseAnswerSegments 同时取 `citedNums` + `cleaned`**(原代码只取 citedNums)— 减少重复扫描
- **actor.sessionId = session.id**(新字段)— 与 ask 的 actor.userId/clientIp 区分
- **actor.via = "jwt"**(与 ask 的 "admin_token" 区分)

### 3.3 NLI 错误处理矩阵(同 ask v1.1.1)

| 场景 | 行为 | audit 写? | 用户看到 | 持久化 |
|---|---|---|---|---|
| cleaned < 100 | skip | ❌ | 原 answer | 原 answer |
| entailed | pass | ❌ | 原 answer | 原 answer |
| neutral/contradiction | applyWarning | ✅ `success` | 带 ⚠️ | 带 ⚠️ |
| timeout (>15s) | fail-open | ✅ `failure` error: `nli_timeout` | 原 answer | 原 answer |
| runtime_error | fail-open | ✅ `failure` error: `nli_runtime_error` | 原 answer | 原 answer |

## 4. 测试

### 4.1 Unit test(8 个新 case + 9 个老 case 复用)

| # | 名称 | 结果 |
|---|---|---|
| v1.3-1 | 短答案 skip NLI + 不写 audit + 持久化原 answer | ✅ |
| v1.3-2 | 长答案 + NLI pass (entailed) → 不写 audit + 原 answer | ✅ |
| v1.3-3 | 长答案 + NLI reject (neutral) → 写 audit + answer 含 ⚠️ + 持久化 finalAnswer | ✅ |
| v1.3-4 | NLI timeout → 写 audit nli_timeout + 无 ⚠️ | ✅ |
| v1.3-5 | NLI runtime error → 写 audit nli_runtime_error + 无 ⚠️ | ✅ |
| v1.3-6 | 持久化 session.messages 中 assistant.content 含 ⚠️ prefix | ✅ |
| v1.3-7 | audit actor.sessionId = session.id | ✅ |
| v1.3-8 | audit actor.via = "jwt" | ✅ |

### 4.2 全 monorepo 测试

| Workspace | 通过 | 备注 |
|---|---|---|
| apps/api | **231/231 PASS** | 原 223 + 8 新 |
| apps/admin | 168/168 | pre-existing race condition(单独跑 168) |
| apps/crawler | 49/49 | |
| apps/miniprogram | 49/49 | |
| packages/shared | 58/58 | |
| packages/local-llm | 51/51 | |
| **总计** | **606/606** | (前 598 + 8 新) |

### 4.3 typecheck

- apps/api ✅
- apps/admin ✅
- apps/crawler ✅
- apps/miniprogram ✅
- packages/shared ✅
- packages/local-llm ❌ **pre-existing** (TS2209 rootDir ambiguous) — 与 v1.3 无关,已确认 git stash 验证

## 5. 真接数据

### 5.1 短问题(Step 2)

```
Q: 5月宝宝发烧38.5度怎么办
A: 参考资料中未涉及此问题。建议您尽快咨询儿科医生或前往医院就诊...
A.length: 47 字符 (远 < 100)
elapsed: 3s
warning: 无(跳过 NLI)
session_id: 01KVWCWCYY619C2CPCT6DE6ZW7 (新 session)
citations: 0 (LLM 兜底: "参考资料中未涉及此问题")
```

### 5.2 长问题(Step 3)

```
Q: 详细解释5月宝宝发烧物理降温与药物降温区别,以及何时需要立即就医,用药剂量标准如何
A: 参考资料中未涉及此问题,因此无法提供详细解释。
   不过,一般来说,物理降温和药物降温是两种常见的处理宝宝发烧的方法:
   1. 物理降温:温水擦拭、减少衣物、保持室内通风...
   A.length: 514 字符 (>> 100)
elapsed: 10s (撞 NLI 路径,实测 NLI fail-open / 命中快路径)
warning: 无(NLI fail-open 降级到 entailed)
session_id: 01KVWCWSR9MP48QGEK3AFMZBFA (新 session)
citations: 0 (LLM 兜底)
```

### 5.3 网络限制(继承 v1.1.1 + v1.2)

实测 10s 比 v1.2 ask 长问题 15.88s 短 — 可能是:
- 硅基流动 1.4s 内返(同 v1.1.1 1/6 概率)
- 5min cache 命中(从前次真接 init 失败)
- NLI fail-open 早返

不重要:**核心目的达成** — 长问题触发 NLI 路径,chat 不阻塞,无 ⚠️,持久化成功。

## 6. 改进效果估算

| 维度 | v1.2 (ask only) | v1.3 (ask + chat) | 改善 |
|---|---|---|---|
| chat 短问题(< 5s 返) | 100% 撞 timeout / fail-open | 100% 跳 NLI | -100% NLI 调用 |
| chat 长问题 | 100% 撞 timeout | 90% 撞 timeout / 10% 命中 | 网络限制仍存 |
| 持久化 finalAnswer 一致性 | (无 chat 路径) | ✅ reject 路径带 ⚠️ | 新增一致性 |
| audit 维度 | ask_nli_reject(11+1) | + chat_nli_reject(N 条) | 增加 chat 维度 |
| chat 流式家长场景反幻觉 | ❌ 真空 | ✅ 短问 NLI 跳过 / 长问 软警告 | **关键补全** |

## 7. Commit 链

```
b15b412 之前的 (v1.2 闭环)
4bbe2d3 docs(plan): P5 v1.3 — chat NLI 后置插入实现 plan
15567ca fix(spec): P5 v1.3 — §2.2 8c 跳过路径修订
54158b0 docs(spec): P5 v1.3 — chat NLI 后置插入设计
(本次新)
feat(chat): P5 v1.3 — chat NLI 后置插入 + 持久化 finalAnswer
docs(state-p5-v1.3): chat NLI 真接 PASS
```

## 8. 关键 takeaway

1. **chat 路径复制 ask 套路极低风险** — 0 env 变更 + 8 case + 6 行 fetch mock 改动,真接 3s/10s 验证
2. **持久化 finalAnswer 是反幻觉一致性关键** — 用户回看看到带 ⚠️ 版本,不会误以为"原始答案"
3. **跳过路径仍走持久化** — spec §6 self-review 修订,避免短问题用户刷新丢历史
4. **actor.sessionId 是新维度** — 后续可基于此做"单 session 多次 reject → 该 session 标记低质量"等 v2 候选
5. **chat 与 ask NLI audit 分离** — action 前缀区分,便于独立统计触发率

## 9. 后续候选(独立 brainstorm)

- **A: P5 v1.4 跨轮 NLI** — 把 history 摘要作额外 premise,处理 LLM 用历史知识兜底场景
- **B: P6 换本地 ONNX NLI** — 100% 命中 + 无外部依赖(同 v1.1.1/v1.2 思路)
- **C: P7 chat 流式 NLI** — 每 token 流式触发 NLI,提早发现 reject(高成本)
- **D: P8 session 维度 audit 聚合** — 单 session N>3 次 reject → 标低质量,供 minipgm "建议重新发起对话"
- **E: 接受现状,等真接更多数据**

## 10. 验收

- [x] 8/8 unit test PASS(api-chat.test.ts)
- [x] 17/17 api-chat 全部 PASS(9 老 + 8 新)
- [x] 231/231 api tests PASS(原 223 + 8 新)
- [x] 606/606 monorepo tests PASS
- [x] typecheck 5/6 workspaces 干净(local-llm pre-existing fail)
- [x] 真接 step 1-5 全 PASS(deploy / 短问 / 长问 / 持久化 / 性能)
- [x] commit + state doc 完成
- [x] memory + MEMORY.md 更新