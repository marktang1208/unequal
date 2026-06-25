# unequal 进度索引 (2026-06-25)

> 今日 (2026-06-25) 是 unequal 项目的 code-completion 大日子 — **P8 vector DB 集成 + P9 NLI 后置 (polling) + D baseline typecheck 三件大事代码层 100% 收官**, 全 typecheck 0 错, 等真接日 deploy + verify。

## TL;DR

| 里程碑 | 状态 | 涉及测试 | 真接 follow-up |
|---|---|---|---|
| **P8 vector DB 集成** (CloudBase PG + pgvector + dual-write + handler 灰度切) | ✅ 代码 100% 收官 | 64/64 P8 涉及 PASS | 4 步 (PG 实例 + ETL + deploy:full + verify) |
| **P9 NLI 后置** (polling 3-2-5 + setImmediate + audit_log + P5 v1.3 sync backward compat) | ✅ 代码 100% 收官 | 49/49 P9 涉及 PASS | 3 步 (deploy:full + deploy:status + verify:p9-nli-async) |
| **D baseline typecheck 收官** (8 → 0 错) | ✅ 0 错 | 18/18 onnx-provider 回归 PASS | - |

**今日累计 commit**: 17 (P8: 8 + P9: 8 + D: 1)

## 文档地图

### spec / plan
- `docs/superpowers/specs/2026-06-25-p8-vector-db-pgvector-design.md` (P8 design)
- `docs/superpowers/specs/2026-06-25-p9-nli-async-polling-design.md` (P9 design, 12 节, 612 行)
- `docs/superpowers/plans/2026-06-25-p8-vector-db-pgvector.md` (P8 plan, 4 task × 11 step)
- `docs/superpowers/plans/2026-06-25-p9-nli-async-polling.md` (P9 plan, 5 task × 11 step, 572 行)

### state 文档 (代码收官记录)
- `docs/superpowers/state-p8-vector-db-pgvector.md` (P8 完整 9 节, ~400 行, commit ce3207c)
- `docs/superpowers/state-p8-real-deploy-guide.md` (P8 真接 5 步走, commit ea7f969)
- `docs/superpowers/state-p9-nli-async-polling.md` (P9 完整 9 节, ~260 行, commit a2067d8)

### memory (~/.claude/.../memory/)
- `project_unequal_progress_2026_06_25_part2.md` — 今日 part 2 进度汇总
- `project_unequal_progress_2026_06_25.md` — 今日 part 1 进度 (P6 + P7 + P8 v1.4 真接)
- `project_p8_vector_db_code_complete.md` — P8 集成 memory
- `project_p9_nli_async_polling.md` — P9 polling memory
- `project_d_typecheck_baseline_complete.md` — D baseline typecheck memory

## 2D 灰度矩阵 (核心决策)

P8 (VECTOR_STORE) × P9 (NLI_ASYNC) 独立切, 任意组合可部署:

| VECTOR_STORE × NLI_ASYNC | NLI_ASYNC=0 (sync) | NLI_ASYNC=1 (async) |
|---|---|---|
| **VECTOR_STORE=nosql** (P7) | P7 baseline | P7 + P9 async (本次 default) |
| **VECTOR_STORE=pg** (P8) | P8 baseline (未来) | P8 + P9 async (本次 target) |

**Production target**: VECTOR_STORE=pg + NLI_ASYNC=1 (P8 + P9 同时打开)
**回退路径**: 各回 nosql + 0 (P7 baseline 0 风险)

## 关键设计决策

### P8
1. **CloudBase PG + pgvector** (not 自建 Qdrant) — 同生态 + 免运维
2. **dual-write pattern** — NoSQL source-of-truth + PG retrieval cache (failOpen)
3. **HNSW 索引** m=16, ef_construction=64
4. **handler 灰度切** — env.VECTOR_STORE 控制, 默认 nosql
5. **ETL idempotent** — ON CONFLICT DO NOTHING, retry × 3 指数退避

### P9
1. **Polling 轮询** (not SSE/WebSocket) — 1 文件改, 简单可靠
2. **复用 audit_log** + 新增 `chat_nli_async` action (跟 P5 v1.3 sync reject 隔离)
3. **3-2-5 节奏** (3s 起始 + 2s 间隔 × 5, 13s 总, fallback 返原 answer)
4. **`turnId` 唯一标识** — `${session_id}:${turn_seq}` 格式
5. **P5 v1.3 sync backward compat** — 老客户端无 breaking change
6. **setImmediate fire-and-forget** — P5 v1.3 failOpen 风格

### D
1. **不重构, 只 micro-fix** — typecheck baseline 不动架构
2. **优先 `!` 而非重构类型** — TS 2352/18048 是 strict 保守推断, 加 `!` 比改类型更安全
3. **修完跑回 onnx-provider 18 单测** — 0 行为破坏

## 关键副发现 / 教训

1. **TDD 死循环 + OOM 误诊**: RED + OOM 应先看实现有没有死循环, 不该调测试参数绕 (50 分钟误诊)
2. **spec self-review 必要**: 12 节 spec 写完才发现 §1 跟 §3.3 矛盾 (warning prefix sync/async), commit 40f8292 修 1 行
3. **subagent 测试 +5 边界**: plan 列 8 cases, subagent 加 5 (contradiction 0.6 / entailed 0.2 / 多 record / XSS / OPTIONS)
4. **mock coll 名 snake_case**: CloudBase collection 名是 `chat_session` snake_case (不是 camelCase)
5. **verify-p8 ESM**: 改 ESM default import cloudbase + namespace import tcbScf
6. **verify-nli-cross-turn stdout balanced JSON**: 不该用 regex 匹配 stderr, 改 balanced JSON parse
7. **subagent 卡死接管**: P8 Task 2 subagent 10 分钟 stream watchdog 触发, 主线程诊断 + 接管
8. **typecheck baseline 累积效应**: 每 phase 顺手修 (P9 修 4 + D 修 4 = 8 → 0)
9. **`toBeDefined()` 不 narrow 类型** — 加 `!` 或 `(x as T)` 显式 narrow
10. **`as` 类型转换 number/bigint** 必报 TS2352, 用 `as unknown as T` 双层断言

## 测试基线 (今日 final)

| 模块 | cases | 状态 |
|---|---|---|
| P8 涉及 | 64/64 | ✅ PASS |
| P9 涉及 | 49/49 | ✅ PASS in 547ms |
| mini program | 1/1 | ✅ PASS in 321ms |
| onnx-provider (D 回归) | 18/18 | ✅ PASS in 199ms |
| **typecheck** | 0 错 | ✅ baseline 8 → 0 |

## Production 部署 (待真接)

- **24 env vars** (part 1 完成) + **2 待加** (P8 VECTOR_STORE=pg, P9 NLI_ASYNC=1) = **26 vars 目标**
- 真接顺序建议: 先 P8 (vector DB ETL 大头) → 再 P9 (polling 灰度) → 同时观察 chat latency
- 真实 gateway: `https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com`
- 真用户: `01KVCZ2JRBAGF3MY75D7KEY4RZ` (M7-D settings 页注册, 13 sessions, 26 messages)

### P8 真接 4 步
1. 创建 CloudBase PG 实例 + pgvector 扩展
2. `pnpm -F api migrate:no-sql-to-pg` (one-time, ~10-30min 视数据量)
3. `pnpm -F api deploy:full` 推 26 vars (含 VECTOR_STORE=pg)
4. `pnpm -F api verify:p8-vector-db` 4 步真接 (SCF env + cross-turn + VECTOR_STORE + chat)

### P9 真接 3 步
1. `pnpm -F api deploy:full` 推 26 vars (含 NLI_ASYNC=1)
2. `pnpm -F api deploy:status` 验 26 vars
3. `pnpm -F api verify:p9-nli-async` T1+T2 双轮 200 + nliTurnId 命中 + 轮询命中 audit_log + verdict 推断 isWarning 正确 (13s 内)

### 回滚测试
- P8: VECTOR_STORE=pg → nosql + deploy:full (P7 baseline 行为恢复)
- P9: NLI_ASYNC=1 → 0 + deploy:full (P5 v1.3 sync 行为恢复)

## 后续候选 (按 ROI 排序)

| # | 任务 | ROI | 风险 |
|---|---|---|---|
| 1 | **P8 + P9 真接** | production 24 → 26 vars, vector DB + polling 真接验 | 中 (Tencent 网络, 需用户手动) |
| 2 | **P10: chat UX 进一步优化** (per-turn warning 动画 + answer streaming 整合) | UX 提升 | 中 |
| 3 | **P11: 本地推理 (OMLX Qwen3-4B)** | LLM 20s → 5-10s | 高 |
| 4 | **P12: 多源 ingest 全跑通** | 数据丰富度 | 中 |

**P10+ 起点建议**: 等 P8 + P9 真接 PASS 拿真数据 (1-2 周) → 再决定 P10。

## 状态文档关联

- **前序 (今日 part 1)**: `state-p7-p8-followup-completion.md` (P6 follow-up + P8 v1.4 真接)
- **前序**: `state-p6-local-onnx-nli.md` (P6 本地 ONNX NLI)
- **前序**: `state-p5-nli-entailment.md` (P5 HTTP NLI)
- **前序**: `state-p4-deploy-pipeline.md` (P4 deploy pipeline)
- **架构稳定**: `state-arch-v2.4.md`
