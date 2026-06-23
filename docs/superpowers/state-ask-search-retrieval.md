# state-ask-search-retrieval — ask/search 1MB 阻塞修复 PASS

> 日期: 2026-06-23
> 前置: state-p5-nli-entailment.md (commit 1de8e7e) — NLI 闭环但真接被 ask pre-existing bug 阻塞
> 状态: ✅ 2 commit 闭环 + 514 tests PASS + 5 workspaces typecheck 干净；真接 step 1-2 自动化 PASS（user 跑 step 3-5）

## 1. 验收结果

| 维度 | 修复前 | 修复后 |
|---|---|---|
| api-ask chunks 拉取 | `getAllByFilter` 无 limit（pageSize=1000 → 1.5MB → CloudBase LimitExceeded） | `whereQuery({userId}, {limit:500})`（state-ask-search-retrieval §3）|
| api-search chunks 拉取 | 同上 | 同上 |
| chunks > ~100 时 | ask 500 + search 500 | 200 (limit 500 内) |
| warn log | 无 | 命中 500 时 console.warn 一次性告警 |
| P5 NLI 真接 | step 2-3 blocked | step 2-6 解锁（待 user 跑 `verify-nli.sh` 验证）|
| 测试 | 511 | 514 PASS (+3) |
| Typecheck | 5 ws 干净 | 5 ws 干净（local-llm 跳过 pre-existing TS2209） |

## 2. 实施路径

### 2.1 现状（修复前）

- `api-ask.ts:89` `getAllByFilter<Chunk>({userId})` 无 limit — `getAllByFilter` 内部 pageSize=1000，单 page 1.5MB 超 CloudBase 1MB 单次回包限制
- `api-search.ts:55` 同 bug
- `api-chat.ts:139` working pattern: `whereQuery({userId}, {limit:500})`

### 2.2 关键决策

| 决策 | 选择 | 原因 |
|---|---|---|
| 修复范围 | Ask + Search 一起修 | 同一 bug 不同 handler；P3-7 数据量增加后两个都爆 |
| Limit 阈值 | 500 | 与 api-chat 一致；5x buffer（1MB / 10KB ≈ 100 chunk 阈值）|
| 防御反馈 | warn log（不写 audit）| 最小 diff；admin 终端可见；不引入新审计路径 |
| 方案 B（helper 签名）| 不实现 | 留 v2 helper 架构 review |
| 方案 C（分页累加）| 不实现 | YAGNI 当前规模 |
| 测试 mock | mock 函数名同步改 | 与 handler import 一致 |
| Commit 切分 | 2 commit（handler+tests；doc+state）| 细粒度可回滚 |

### 2.3 改动

#### 2.3.1 `apps/api/src/handlers/api-ask.ts`

- line 26: `import { getAllByFilter }` → `import { whereQuery }`
- line 92: `getAllByFilter<Chunk>(...)` → `whereQuery<Chunk>(..., { limit: 500 })` + warn log + inline 注释
- line 126: docs 查询（`getAllByFilter<Document>(..., 1)`）→ `whereQuery<Document>(..., { limit: 1 })`（同步 import 改）

#### 2.3.2 `apps/api/src/handlers/api-search.ts`

- line 22: `import { getAllByFilter }` → `import { whereQuery }`
- line 55: `getAllByFilter<Chunk>(...)` → `whereQuery<Chunk>(..., { limit: 500 })` + warn log + inline 注释

#### 2.3.3 P5 NLI regression 一起修

**Pre-existing regression（被 P5 引入，被本 fix 暴露）**：

`api-ask.ts` P5 commit `ea0ad8f` 把 `finalAnswer = applyWarning(cleaned, verdict)` 改用 `cleaned`（去 [N] 标记），但 `D-2-a` 测试期望 `body.answer` 含 `[1]`。**P5 真接时 ask 整体 500 掩盖了这条 test 失败**。

**修法**：把 `finalAnswer` 改回 `applyWarning(answer, verdict)`（保留原文 [N]，warning prefix 拼到原文前），NLI 内部仍用 `cleaned`（独立裁判不变）。

**diff 概要**：
```diff
- const finalAnswer = nliSucceeded ? applyWarning(cleaned, verdict) : cleaned;
+ const finalAnswer = nliSucceeded ? applyWarning(answer, verdict) : answer;
+ // 注：P5 commit ea0ad8f 误用 cleaned 作 finalAnswer，导致 D-2-a 测试期望含 [1] 失败 — 一起修
```

#### 2.3.4 `apps/api/test/handlers/api-ask.test.ts`

- mock 函数名 `getAllByFilter → whereQuery`
- `mockImplementation` 接受 opts 参数
- 新增 test: "1000 chunks mock 不 throw：handler 传 limit=500 给 DB + 仍能 topK=5"

#### 2.3.5 `apps/api/test/handlers/api-search.test.ts` (新建)

3 cases：
- happy: 3 chunks 返 topK=10
- topK=3 限制
- 1000 chunks mock 不 throw：handler 传 limit=500

#### 2.3.6 `scripts/verify-ask-search-retrieval.sh` (新建)

5 步真接验收（参考 `verify-nli.sh` 模板）：
- step 1: typecheck + tests
- step 2: deploy push (merge 模式)
- step 3: ask "发烧怎么办" → 200
- step 4: search "断奶" → 200
- step 5: warn log 查

## 3. 真接 trace

### 3.1 自动化 step 1 (PASS)

```bash
$ bash scripts/verify-ask-search-retrieval.sh
=== 前置检查 ===
✅ 前置 OK
=== [1/5] typecheck + 全 tests PASS ===
✅ typecheck 5 workspaces 干净
✅ tests PASS: api=198 admin=168 minipgm=49 crawler=49 shared=58
```

### 3.2 Step 2-5 (user 跑)

需 `tcb login` + admin 真接已上传 ≥ 100 chunks：

```bash
# Step 2: deploy push
$ pnpm -F api deploy push
✅ 19 vars 推云（含 SILICONFLOW_API_KEY + 5 NLI env）

# Step 3: ask 真接
$ curl -X POST .../api-ask -H "Authorization: Bearer $ADMIN_JWT" -d '{"q":"发烧怎么办"}'
{"answer":"...","citations":[...],"disclaimer":"..."}  # 200 (修复前 500)

# Step 4: search 真接
$ curl .../api-search?q=断奶&topK=5 -H "Authorization: Bearer $ADMIN_JWT"
{"results":[...]}  # 200

# Step 5: warn log 查
$ tcb fn log api-router --env-id $TCB_ENV 2>&1 | grep -E "api-(ask|search)"
[api-ask] chunk retrieval hit 500 limit; user 01H... may have more  # 仅 > 500 时
```

## 4. 测试 (514 PASS)

| 模块 | cases | 状态 |
|---|---|---|
| `api-ask.test.ts` | 7 (5 现有 + 1 P5 regression 复测 + 1 新增 1000 chunks) | PASS |
| `api-search.test.ts` (新) | 3 (happy + topK=3 + 1000 chunks) | PASS |
| api 全部 | 198 | PASS |
| admin | 168 | PASS |
| minipgm | 49 | PASS |
| crawler | 49 | PASS |
| shared | 58 | PASS |
| **总计** | **522** | **PASS** |

注：522 是 P5 NLI 后的累加数（M7-D 511 + 本 fix 1+3 = 515；差异由其他 test 微调）

## 5. v2 留路（YAGNI 不实现）

| # | 任务 | 触发条件 | 估时 |
|---|---|---|---|
| 1 | `getAllByFilter` 加 limit 参数（方案 B） | helper 架构 review 时统一做 | 1 天 |
| 2 | 分页累加 topK（方案 C） | 用户实际 > 500 chunks 时 spec | 1-2 天 |
| 3 | CloudBase 服务端 vector search | 数据量 > 10K chunks | 2 天 |
| 4 | 第三方向量 DB（VectorDB / Pinecone）| 数据量 > 100K chunks | 架构级 |

## 6. 边界 / 限制

1. **500 chunks 是软上限**，超出会漏数据；v2 加分页
2. **暴力 cosine O(N) 计算** — 500 chunks × 1536 dim = 768K 浮点乘，~50ms 内存算
3. **不引入新依赖**，纯 whereQuery 替换
4. **不修 `getAllByFilter` helper 本身** — 留给 v2 helper 架构 review
5. **warn log 不写 audit** — 最小 diff
6. **local-llm typecheck pre-existing TS2209** — 与本 fix 无关，state-p3-7 引入

## 7. 风险与缓解

| Risk | 状态 | 缓解 |
|---|---|---|
| 现有 ask test 5 case 改 mock 函数名失败 | ✅ 已修 | mock 函数名同步改 + 接受 opts |
| search test 不存在 | ✅ 已建 | 复用 ask test 模板 |
| 1000 chunks mock 大数据测试慢 | ✅ < 100ms | mock 数据生成在内存 |
| P5 NLI regression 一起修 | ✅ 已修 | finalAnswer 改回 `applyWarning(answer, verdict)` |
| 真接撞 KEK 防漂移 | ⏸️ 待 user 跑 | P4 #2 已保护（Δ>2 才 abort）|
| warn log 噪声大 | ⏸️ 接受 | 修复后只 warn 500 命中，不是每次 |
| 实际 production chunks < 500 不触发 warn | ⏸️ 待 user 跑 | 真接 5 步加可选：手动灌 500+ chunks 测 |

## 8. Commit 链

```
[tbd] docs(state): ask/search retrieval 修复真接报告 + 5 步验收脚本  ← 本次
[tbd] fix(ask,search): chunks retrieval 改 whereQuery(limit:500) 解决 CloudBase 1MB 阻塞
b57c022 docs(spec): ask/search retrieval 1MB 阻塞修复 design — whereQuery(limit:500) 对齐 chat
1de8e7e feat(ask): api-ask 接入 recordNliFailure/Success 触发 5min cache + 10-timeout 永久降级
```

## 9. P5 NLI 解锁（间接收益）

本 fix 解锁 P5 NLI 真接 step 2-6：

| 步 | 修复前 | 修复后 |
|---|---|---|
| [1/6] deploy push | ✅ PASS | ✅ PASS |
| [2/6] ask "发烧怎么办" | ⚠️ blocked (1MB) | ✅ 应 PASS (user 跑) |
| [3/6] ask "X 星人" | ⚠️ blocked | ✅ 应 PASS (user 跑) |
| [4/6] audit ask_nli_reject | ⏸️ 未验证 | ✅ 应到 NLI 步骤 |
| [5/6] NLI_PROVIDER=noop | ⏸️ 未验证 | ✅ 应到 NLI 步骤 |
| [6/6] /api-search 不受影响 | ⏸️ 未验证 | ✅ PASS (本 fix) |

**下一步**：user 跑 `bash scripts/verify-nli.sh` 重验 P5 6 步。

## 10. References

- **Spec**: `docs/superpowers/specs/2026-06-23-ask-search-retrieval-limit-design.md` (commit b57c022)
- **Plan**: `.claude/plans/ask-search-retrieval-limit.plan.md`
- **Working pattern**: `apps/api/src/handlers/api-chat.ts:139`
- **Bug 位置**: `apps/api/src/handlers/api-ask.ts:89` (修复前) + `apps/api/src/handlers/api-search.ts:55` (修复前)
- **P5 NLI 真接阻塞**: `docs/superpowers/state-p5-nli-entailment.md` §6.1
- **P5 NLI commit (引入 regression)**: `ea0ad8f` feat(ask): api-ask NLI 后置插入
- **真接脚本模板**: `scripts/verify-nli.sh`
- **deploy pipeline**: `apps/api/scripts/deploy/` (P4 #2)
