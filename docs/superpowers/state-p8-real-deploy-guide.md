# P8 Real Deploy Guide — CloudBase PG 模式 + pgvector 真接 5 步走

> 日期: 2026-06-25
> 前置: `state-p8-vector-db-pgvector.md` (代码收官, commit `ce3207c`)
> 配套: spec `specs/2026-06-25-p8-vector-db-pgvector-design.md` + plan `plans/2026-06-25-p8-vector-db-pgvector.md`
> 状态: ⏸️ **指南就绪, 真接待部署 (1-2 天)**

## 0. TL;DR

P8 代码 100% 收官 (4 commits + 25 单测 + 64/64 P8 涉及 PASS), 但**真接**需腾讯云控制台手动操作 + 5 步 CLI。本指南按 Phase 0-5 走, 每步有命令、回滚、验收。

**前置条件 (本地)**:
- macOS (Keychain + tcb CLI)
- 跑过 `pnpm -F api setup:keychain-secrets` (9 secrets 已注入 Keychain)
- production 24 vars atomic set (P7 follow-up #1 baseline)

**关键约束**:
- 真实 gateway: `https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com`
- 真实 user: `01KVCZ2JRBAGF3MY75D7KEY4RZ` (13 sessions, 26 messages, 1963 chunks)
- 真实 admin IP allowlist: `***REMOVED***.0/24` (你办公网 IP 在内才登得上去)
- 真实 9 Keychain secrets: ADMIN_TOKEN, JWT_SECRET, MINIMAX_API_KEY, KEK_SECRET_V1, INGEST_PROXY_SECRET, ADMIN_IP_ALLOWLIST, SILICONFLOW_API_KEY, CLOUDBASE_SECRET_ID, CLOUDBASE_SECRET_KEY

---

## Phase 0: 腾讯云控制台手动操作 (1-2 天)

**耗时**: 0.5-1 天 (CloudBase 文档熟的话), **这是唯一不能 CLI 自动化的步骤**

### 0.1 建 PG 模式 env

1. 登录 [腾讯云 CloudBase 控制台](https://console.cloud.tencent.com/tcb)
2. 选 ap-shanghai region (跟现有 env 同 region, 走 VPC 内)
3. 新建环境: env ID = `unequal-d4ggf7rwg82e0900b-pg`
4. **关键**: 套餐选"包年包月 / PG 模式", **不是** MySQL 模式 (P8 spec §3.3 强制)
5. 等 5-10 分钟创建完成
6. 记下 **connection string** 格式: `postgres://user:pass@host:5432/dbname?sslmode=require`
7. (可选) 调整 memory / IOPS (默认配置够 1963 chunks 用)

**注意**:
- PG 模式 ≠ MySQL 模式 (CloudBase 互斥), 故必须**新建 env** 不是改现有
- 跨 env 数据访问只能走函数内 dual-write, 不能 SQL join
- 计费独立, 调研确认 PG 模式价格 (state-p8 §8 risk #9)

### 0.2 开 pgvector 扩展 + 建 schema

进 PG env 的 "数据库" → "数据建模" 或 psql 客户端, 执行:

```sql
-- 0.2.1 开 pgvector 扩展 (state-p8 §3.1)
CREATE EXTENSION IF NOT EXISTS vector;

-- 0.2.2 建 chunks 表 (11 列, 跟 ChunkWithEmbedding 对齐, 注意 sourceType 在 M7-B 已加)
CREATE TABLE chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  source_id   TEXT NOT NULL DEFAULT '',
  user_id     TEXT NOT NULL,
  idx         INT NOT NULL,
  content     TEXT NOT NULL,
  embedding   vector(1536) NOT NULL,
  trust_level INT NOT NULL,
  source_type TEXT NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL
);

-- 0.2.3 3 索引 (state-p8 spec §3.1)
CREATE INDEX chunks_user_id_idx     ON chunks (user_id);
CREATE INDEX chunks_document_id_idx ON chunks (document_id);
CREATE INDEX chunks_embedding_hnsw  ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 0.2.4 验 HNSW 索引生效 (state-p8 §8 risk #1 mitigation)
SET hnsw.ef_search = 40;
EXPLAIN ANALYZE
SELECT id FROM chunks
WHERE user_id = '01KVCZ2JRBAGF3MY75D7KEY4RZ'
ORDER BY embedding <=> (SELECT embedding FROM chunks LIMIT 1)
LIMIT 5;
-- 期望: "Index Scan using chunks_embedding_hnsw" (不是 Seq Scan)
--       Execution Time < 100ms (P8 success criteria)
```

**注意**:
- `vector(1536)` 是 MiniMax embo-01 输出维度 (跟现有 NoSQL chunk.embedding 字段一致)
- HNSW 参数 m=16, ef_construction=64 是 P8 spec 经验值 (2000 chunks/user), 大规模时调
- 锁 pgvector 版本 ≥ 0.7.0 (state-p8 §8 risk #8 mitigation)

### 0.3 测试 PG 连接 (本地)

```bash
# 0.3.1 macOS psql 客户端 (Homebrew: brew install libpq && echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc)
PGPASSWORD=<password> psql -h <host>.tencentcdb.com -U <user> -d <dbname>
# 期望: 进 psql 交互, \dt 看到 chunks 表, \di 看到 3 索引

# 0.3.2 1 query latency 验证 (state-p8 §8 risk #1 mitigation)
PGPASSWORD=<password> psql -h <host>.tencentcdb.com -U <user> -d <dbname> -c "
  EXPLAIN ANALYZE SELECT count(*) FROM chunks;
"
# 期望: < 50ms (空表, 主要是连接耗时)
```

**回滚**: 删 PG env (独立 env, 不影响现有)

---

## Phase 1: 本地配置 + 跑 ETL (1-2 小时)

### 1.1 替换 Keychain PG_CONNECTION_STRING

```bash
# 1.1.1 把 Phase 0.1 拿到的 connection string 注入 Keychain
# 格式: postgres://user:password@host:5432/dbname?sslmode=require
# (URL encode password 里 @ : / ? 等特殊字符)
security delete-generic-password -a unequal-deploy -s "unequal:api-router:PG_CONNECTION_STRING" 2>/dev/null
security add-generic-password \
  -a unequal-deploy \
  -s "unequal:api-router:PG_CONNECTION_STRING" \
  -w "postgres://user:ENCODED_PASS@host:5432/dbname?sslmode=require" \
  -U

# 1.1.2 验 Keychain 注入成功 (state-p8 §3.6 placeholder 已存在, -U 覆盖)
security find-generic-password -a unequal-deploy -s "unequal:api-router:PG_CONNECTION_STRING" -w
# 期望: 返 connection string (不是空)
```

**注意**:
- **必须** URL encode 密码里的特殊字符 (`@`, `:`, `/`, `?`, `#`, `[`, `]`, `%`)
- 拿 Node 跑 `encodeURIComponent("p@ss:word")` → `p%40ss%3Aword`
- Keychain 密码含中文/日文/emoji 时 P8 测试已验证可行

### 1.2 跑 ETL (NoSQL 1963 chunks → PG)

```bash
# 1.2.1 干跑 (DRY-RUN, 只查不写) — Phase 1 保险, 确认连接
pnpm -F api migrate:no-sql-to-pg --dry-run
# (待 Phase 1 完, verify:p8-vector-db 骨架 step1 已注释)
# 没 --dry-run 参数时, 用 env 隔离
PG_CONNECTION_STRING="postgres://placeholder:x@127.0.0.1:5432/x" \
  pnpm -F api migrate:no-sql-to-pg
# 期望: connect 失败 → 友好报错 "PG connect timeout" → exit 1
```

(干跑机制 P9 follow-up: 加 `--dry-run` flag)

```bash
# 1.2.2 真跑 ETL (1963 chunks, 预计 1-3 分钟)
pnpm -F api migrate:no-sql-to-pg
# 期望输出 (state-p8 §2.2):
#   [ETL] batch offset=0 size=100 total=100
#   [ETL] batch offset=100 size=100 total=200
#   ...
#   [ETL] batch offset=1900 size=63 total=1963
#   [ETL] DONE total=1963 migrated=1963 failed=0

# 1.2.3 验 ETL 写入完整
PGPASSWORD=<password> psql -h <host>.tencentcdb.com -U <user> -d <dbname> -c "
  SELECT count(*) AS pg_count FROM chunks;
"
# 期望: pg_count = 1963 (跟 NoSQL chunk 集合总数对齐)

PGPASSWORD=<password> psql -h <host>.tencentcdb.com -U <user> -d <dbname> -c "
  SELECT user_id, count(*) FROM chunks GROUP BY user_id ORDER BY count(*) DESC LIMIT 5;
"
# 期望: 第一行 user_id = '01KVCZ2JRBAGF3MY75D7KEY4RZ' (真用户), count ≈ 1963
#       或多个 user (production 真接测试可能多个 user)

# 1.2.4 抽样 5 chunks 人工核对
PGPASSWORD=<password> psql -h <host>.tencentcdb.com -U <user> -d <dbname> -c "
  SELECT id, user_id, idx, length(content) AS content_len,
         vector_dims(embedding) AS emb_dim, trust_level
  FROM chunks LIMIT 5;
"
# 期望: 5 行, emb_dim=1536, content_len > 0, trust_level ∈ {0,1,2,3}
```

**回滚**: ETL 是只读 (读 NoSQL + 写 PG), 不动 NoSQL. 重跑 idempotent (ON CONFLICT DO NOTHING). 真出问题, 直接 `TRUNCATE chunks;` + 重跑.

### 1.3 验 HNSW 索引 + 真 query latency

```bash
# 1.3.1 测 query latency (production 1963 chunks)
PGPASSWORD=<password> psql -h <host>.tencentcdb.com -U <user> -d <dbname> -c "
  EXPLAIN ANALYZE
  SELECT id, 1 - (embedding <=> '[0.1,0.2,...]') AS sim
  FROM chunks
  WHERE user_id = '01KVCZ2JRBAGF3MY75D7KEY4RZ'
  ORDER BY embedding <=> '[0.1,0.2,...]'
  LIMIT 5;
"
# 期望: Execution Time < 100ms (state-p8 spec §0)
#       "Index Scan using chunks_embedding_hnsw" (确认走索引, 不是 Seq Scan)
```

**如果 > 100ms 或走 Seq Scan**: 检查 HNSW 索引创建成功, `SET hnsw.ef_search = 40` 生效, 调 `ef_construction` (state-p8 §8 risk #6 mitigation: 加 env var `PG_EF_SEARCH`).

---

## Phase 2: 验 dual-write ingest (半天)

### 2.1 deploy P8 code 到云 (不改 VECTOR_STORE, 默认 nosql)

```bash
# 2.1.1 deploy:full 一条命令 (P7 follow-up #1 串行 3 步: build + tcb + push)
pnpm -F api deploy:full
# 期望:
#   Step 1/3 build: esbuild bundle + nli-assets sync + cloudbaserc sync (24 vars)
#   Step 2/3 tcb fn deploy: 推 code (⚠️ wipes secrets, P4 #3 已知)
#   Step 3/3 push: SCF SDK atomic set 24 vars (14 template + 9 secrets + VECTOR_STORE + LLM_MAX_TOKENS)
#   audit_log 写 deploy record (action="deploy", mode=merge, deploySnapshot 24 vars)

# 2.1.2 验云端 24 vars 完整 (state-p8 §1.1 P7 baseline)
pnpm -F api deploy:status
# 期望: 24 vars atomic set, VECTOR_STORE=nosql (default safe, P8 spec §4.6)
#       NLI_PROVIDER=onnx + 5 NLI vars + 7 secrets + CLOUDBASE_SECRET_ID/KEY + 9 standard
```

**注意**:
- 这一步**不**改 VECTOR_STORE (仍是 `nosql`), 等 Phase 3 才切
- 验 P8 code 在云端能跑 (api-chat 仍走 P7 暴力 cosine, PG 模块存在但不调用)

### 2.2 admin 推 1 PDF 验 dual-write (failOpen path)

```bash
# 2.2.1 admin token login 拿 JWT (state-p4 deploy pipeline)
ADMIN_TOKEN=$(security find-generic-password -a unequal-deploy -s "unequal:api-router:ADMIN_TOKEN" -w)
JWT=$(pnpm -F api gen-jwt --sub admin --scope admin --ttl 1h)

# 2.2.2 admin 推 1 测试 PDF (MiniMax embo-01 embed, chunk split)
curl -X POST https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com/api-ingest \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{
    "content": "这是一段测试 PDF 内容。0-3岁宝宝需要充足的睡眠,每天建议12-15小时。",
    "title": "P8 dual-write verify test"
  }'
# 期望: 200 + { source_id, document_id, chunks_inserted: ~1-3, chunks_failed: 0 }

# 2.2.3 验 NoSQL 写入 (source-of-truth)
tcb db nosql query --env unequal-d4ggf7rwg82e0900b --collection chunk \
  --filter '{"documentId":"<doc_id_from_2.2.2>"}'
# 期望: 1-3 chunk 返

# 2.2.4 验 PG 写入 (dual-write, 即使 VECTOR_STORE=nosql 也写, 因 PG_CONNECTION_STRING 注入)
PGPASSWORD=<password> psql -h <host>.tencentcdh.com -U <user> -d <dbname> -c "
  SELECT id, document_id, user_id, idx, length(content) AS content_len,
         vector_dims(embedding) AS emb_dim, trust_level, created_at
  FROM chunks
  WHERE document_id = '<doc_id_from_2.2.2>';
"
# 期望: 1-3 行, content_len > 0, emb_dim=1536, trust_level=0 (默认)
#       created_at ≈ 现在 (跟 2.2.2 调 ingest 时间对齐, 几秒内)

# 2.2.5 验 audit_log ingest 成功 (注意: P8 没加 chunk_indexed_pg audit,
#       因 P8 决策是 failOpen warn + 不阻塞, 不写 audit. 验 warn 也行:
#       看 cloudbase fn log 含 "[ingest] PG dual-write" 调过)
tcb fn log api-router --env unequal-d4ggf7rwg82e0900b | grep "PG dual-write" | tail -5
# 期望: 看到 "PG dual-write skip chunk <id>" 或 "PG dual-write success chunk <id>"
#       (后者说明 PG INSERT 成功, failOpen 没触发)
```

**回滚**: dual-write 是 best-effort (PG 失败 console.warn 不阻塞), ingest 主流程跟 P7 一致. 出问题直接撤 Phase 2.1 deploy, 回到 P7 baseline.

**P8 follow-up #7 (主线程填 verify-p8-vector-db.ts step1 实现)**: Phase 2.1.2 `pnpm -F api deploy:status` 自动验 25 vars, 含 `VECTOR_STORE=nosql` (Phase 2) / `VECTOR_STORE=pg` (Phase 3).

---

## Phase 3: 灰度切流 (3 天, 1 行 env var)

### 3.1 Day 1: env var VECTOR_STORE=pg (admin 1 真 user 测试)

```bash
# 3.1.1 改 cloudbaserc.json VECTOR_STORE=nosql → pg (1 行)
# apps/api/cloudbaserc.json envVariables 块:
#   "VECTOR_STORE": "nosql"  →  "VECTOR_STORE": "pg"

# 3.1.2 跑 deploy:full 推 (注意: env var 切换要走 push, 不是 tcb fn deploy 单独)
pnpm -F api deploy:full
# 期望: 25 vars atomic set (VECTOR_STORE=pg + PG_CONNECTION_STRING)

# 3.1.3 验云端 25 vars (14 template + 9 secrets + VECTOR_STORE(=pg) + PG_CONNECTION_STRING + LLM_MAX_TOKENS)
pnpm -F api deploy:status
# 期望: 25 vars 完整, VECTOR_STORE=pg 确认
# 注意: deploy:full 序列 build + tcb + push, 中间 build step 会重跑 esbuild,
#       tcb step 会 wipe secrets, push step 会重置 25 vars. 详见 P7 follow-up #1.
```

### 3.2 Day 2: 验 chat 真接 → 跟 P7 #3 对比 NLI reject 率

```bash
# 3.2.1 真接 destructive: 真用户 (01KVCZ2JRBAGF3MY75D7KEY4RZ) 调 /api-chat 长问
pnpm -F api verify:nli-real-user
# 期望: HTTP 200, 6-26s (P7 baseline 26.4s, P8 应略短, retrieval P99 < 100ms)
# 关键 evidence:
#   - answerLength > 0 (LLM 真答了)
#   - hasWarningPrefix = false (NLI pass 路径, PG top-5 真 match query)
#   - audit_log 7 天 reject 趋势下降 (vs P7 baseline 30%+ sample)
```

```bash
# 3.2.2 真接 destructive: 真用户 + 跨轮 NLI (P8 v1.4)
pnpm -F api verify:nli-cross-turn
# 期望: T1 26.4s (cold) + T2 6.0s (warm), 双轮 200 + T2 warn=false
# 关键 evidence: 跨轮 hypothesis union 实际工作 (P8 v1.4 helper)

# 3.2.3 查 audit_log NLI reject 7 天趋势 (跟 P7 #3 对比)
# 用 mongodb-like query (state-p6 §9 audit_log 格式):
tcb db nosql query --env unequal-d4ggf7rwg82e0900b --collection audit_log \
  --filter '{"action":"chat_nli_reject", "timestamp":{"$gte":<7_days_ago_ms>}}' \
  --limit 1000
# 期望: 数量较 P7 baseline 下降 50%+ (state-p8 spec §0 目标)
#       (如 < 10% vs P7 baseline 30%+ sample)
```

### 3.3 Day 3: 灰度全量 + verify:p8-vector-db 4 步

**灰度全量 (P8 收尾)**:
- env var `VECTOR_STORE=pg` 已是默认, 移除 nosql 兼容代码 (P9 follow-up)
- 监控 24h NLI reject 趋势, audit_log 噪声
- 如有 PG 性能问题 → 调 `PG_EF_SEARCH` (P9 follow-up)

```bash
# 3.3.1 跑 4 步真接脚本 (主线程已填实现)
pnpm -F api verify:p8-vector-db
# 期望: 4/4 PASS:
#   step1_env_vars: 25 vars atomic set
#   step2_nli_cross_turn: T1+T2 双轮 entailed, latency < 30s
#   step3_nli_reject_trend: reject 率 < 10% (vs P7 baseline 30%+)
#   step4_vector_store_pg: VECTOR_STORE=pg 真切流 (handler 日志走 PG)
```

---

## Phase 4: 收尾 (state-p8-real-deploy + memory)

### 4.1 state doc 收尾

把这份 `state-p8-real-deploy-guide.md` 链接到新增 `state-p8-real-deploy.md` (P8 真接 PASS 后的 state doc, 模板跟 P5/P6 一致):
- 11 节, 含真接 4 步 evidence (latency / reject rate / PG HNSW P99 / ETL 全量)
- 收尾 commit 链 (P8-5 ... P8-8 真接 4 commits)
- 已知限制 + 后续 P9 候选 (state-p8 §8 + §9 follow-up)

### 4.2 memory + MEMORY.md

- 新增 `project_p8_vector_db_real_deploy.md` (跟 `project_p8_vector_db_code_complete.md` 对应)
- MEMORY.md pointer 更新: "P8 真接 PASS + 25 vars + reject 率 < 10% + retrieval P99 < 100ms"
- 把 `p8-vector-db-pgvector-code-complete.md` 标记 superseded (被 `p8-vector-db-pgvector-real-deploy.md` 取代)

### 4.3 P9 brainstorm 起点

P8 真接后 NLI reject 率下降 50%+ 验证, 解 P5 v1.3 retrieval 瓶颈. **下一步 P9 候选**:
- **NLI 后置** (不阻塞 response) — P8 PG HNSW 已快, NLI 1.9s cold 可异步, UX 提升明显 (state-p8 §9 #1)
- **LLM streaming (SSE)** — first token 2-3s UX 大幅提升 (大工程, state-p8 §9 #2)
- **本地推理 (OMLX Qwen3-4B)** — LLM 20s → 5-10s (高成本架构改动, state-p8 §9 #3)

**P9 起点建议** (P8 真接验证后): NLI 后置 (ROI 最高, 跟 P8 PG HNSW 协同, 中等成本)

---

## 5. 回滚矩阵 (任意 phase 可回滚)

| 阶段 | 回滚命令 | 影响 | 数据丢失? |
|---|---|---|---|
| Phase 0 (建 env) | 删 PG env (腾讯云控制台) | 无 (独立 env) | 无 |
| Phase 1.1 (Keychain) | `security delete-generic-password` | 无 (下次 deploy 不传 PG_CONNECTION_STRING) | 无 |
| Phase 1.2 (ETL) | 重跑 idempotent | 无 | 无 (PG 是 retrieval cache, NoSQL 是 source-of-truth) |
| Phase 2.1 (deploy P8 code) | 撤 deploy, 回到 P7 baseline (VECTOR_STORE=nosql) | 无 (P7 行为恢复) | 无 |
| Phase 2.2 (dual-write ingest) | Phase 2.1 撤 deploy | 无 | 无 |
| Phase 3.1 (切流 VECTOR_STORE=pg) | **1 行 env**: VECTOR_STORE=pg → nosql + `pnpm -F api deploy:full` | P7 行为恢复, PG 数据保留 (不删) | 无 |
| Phase 3.2 (verify) | 不需回滚 (只是测) | 无 | 无 |
| Phase 3.3 (灰度全量) | P9 follow-up 拆 nosql 兼容代码 | 复杂 (代码改) | 无 |

**关键**: PG 是 retrieval cache, NoSQL 是 source-of-truth. PG 数据丢失不丢用户数据, 重跑 ETL 恢复.

---

## 6. 真接脚本模板 (主线程填实现)

### 6.1 step1_verifyEnvVars 实现

```typescript
// verify-p8-vector-db.ts step1: 调 cloudbase SDK ListFunctionConfig 验 25 vars
import cloudbase from "@cloudbase/node-sdk";

async function step1_verifyEnvVars(): Promise<StepResult> {
  const app = cloudbase.init({
    env: "unequal-d4ggf7rwg82e0900b",
    secretId: keychainGet("CLOUDBASE_SECRET_ID"),
    secretKey: keychainGet("CLOUDBASE_SECRET_KEY"),
  });
  const fns = await app.functions();
  // ListFunctionConfig 返回所有 vars
  const { EnvVariables } = await fns.listFunctionConfig({ Name: "api-router" });
  const expected = 25; // 14 template + 9 secrets + VECTOR_STORE + PG_CONNECTION_STRING
  const actual = Object.keys(EnvVariables).length;
  const hasPg = EnvVariables.VECTOR_STORE === "pg";
  const hasPgConn = !!EnvVariables.PG_CONNECTION_STRING;
  const passed = actual === expected && hasPg && hasPgConn;
  return {
    passed,
    detail: `${actual}/${expected} vars, VECTOR_STORE=${EnvVariables.VECTOR_STORE ?? "(missing)"}, PG_CONNECTION_STRING=${hasPgConn ? "(present)" : "(missing)"}`,
  };
}
```

### 6.2 step2_runNliCrossTurn 实现

```typescript
// step2: exec verify:nli-cross-turn, 抓 T1+T2 latency
import { execSync } from "node:child_process";

async function step2_runNliCrossTurn(): Promise<StepResult> {
  try {
    const output = execSync("pnpm -F api verify:nli-cross-turn", { encoding: "utf8" });
    // 解析 output, 抓 T1 + T2 latencyMs
    const t1Match = output.match(/T1[^\d]*(\d+)s/);
    const t2Match = output.match(/T2[^\d]*(\d+(?:\.\d+)?)s/);
    const t1Latency = t1Match ? parseInt(t1Match[1]) : -1;
    const t2Latency = t2Match ? parseFloat(t2Match[2]) : -1;
    // P8 success criteria: T1+T2 双轮 200, retrieval P99 < 100ms
    // T1 26.4s (cold) + T2 6.0s (warm) 是 P7 baseline, P8 应略短
    const passed = t1Latency > 0 && t2Latency > 0 && t1Latency < 30 && t2Latency < 30;
    return { passed, detail: `T1=${t1Latency}s, T2=${t2Latency}s (P7 baseline: T1=26.4s, T2=6.0s)` };
  } catch (err) {
    return { passed: false, detail: `exec failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
```

### 6.3 step3_checkNliRejectTrend 实现

```typescript
// step3: 查 audit_log 7 天 chat_nli_reject count
async function step3_checkNliRejectTrend(): Promise<StepResult> {
  const app = cloudbase.init({
    env: "unequal-d4ggf7rwg82e0900b",
    secretId: keychainGet("CLOUDBASE_SECRET_ID"),
    secretKey: keychainGet("CLOUDBASE_SECRET_KEY"),
  });
  const db = app.database();
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  // 总 chat 数
  const totalRes = await db.collection("audit_log")
    .where({ action: "chat", timestamp: db.command.gte(sevenDaysAgo) })
    .count();
  // reject 数
  const rejectRes = await db.collection("audit_log")
    .where({ action: "chat_nli_reject", timestamp: db.command.gte(sevenDaysAgo) })
    .count();
  const total = totalRes.total;
  const reject = rejectRes.total;
  const rejectRate = total > 0 ? reject / total : 0;
  // P8 success: reject 率 < 10% (vs P7 baseline 30%+)
  const passed = rejectRate < 0.10;
  return {
    passed,
    detail: `7d reject rate: ${(rejectRate * 100).toFixed(1)}% (${reject}/${total}, P7 baseline 30%+, target < 10%)`,
  };
}
```

### 6.4 step4_verifyVectorStorePg 实现

```typescript
// step4: 调 /api-chat + 验 handler 日志走 PG 分支
async function step4_verifyVectorStorePg(): Promise<StepResult> {
  // 4.1 调 /api-chat (admin token 拿 JWT)
  const jwt = await signJwt({ sub: "01KVCZ2JRBAGF3MY75D7KEY4RZ", scope: "user", secret: keychainGet("JWT_SECRET"), ttl: "1h" });
  const res = await fetch(`${GATEWAY}/api-chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ q: "0-3岁宝宝睡眠需求" }),
  });
  const body = await res.json();

  // 4.2 查 cloudbase fn log (走 PG 分支会含 "[api-chat] PG retrieval")
  const fns = await cloudbase.init({
    env: "unequal-d4ggf7rwg82e0900b",
    secretId: keychainGet("CLOUDBASE_SECRET_ID"),
    secretKey: keychainGet("CLOUDBASE_SECRET_KEY"),
  }).functions();
  const logs = await fns.listFunctionLogs({ Name: "api-router", Limit: 50 });
  const pgBranchHit = logs.Logs.some((log) => log.LogContent.includes("[api-chat] PG retrieval"));

  // 4.3 验 VECTOR_STORE=pg 真切流
  const passed = res.ok && pgBranchHit;
  return {
    passed,
    detail: `chat HTTP ${res.status}, PG branch hit: ${pgBranchHit ? "YES" : "NO"} (handler log 含 [api-chat] PG retrieval)`,
  };
}
```

---

## 7. 验证清单 (P8 真接完整收官)

- [ ] Phase 0.1 建 PG env `unequal-d4ggf7rwg82e0900b-pg` + pgvector 扩展
- [ ] Phase 0.2 schema + 3 索引 + HNSW EXPLAIN ANALYZE < 100ms
- [ ] Phase 1.1 Keychain PG_CONNECTION_STRING 注入
- [ ] Phase 1.2 ETL 1963 chunks → PG, ON CONFLICT DO NOTHING idempotent
- [ ] Phase 1.3 真 query latency < 100ms, HNSW 索引走通
- [ ] Phase 2.1 deploy P8 code 到云 (VECTOR_STORE=nosql, baseline 24 vars)
- [ ] Phase 2.2 admin 推 1 PDF + 验 NoSQL/PG 双写 + audit_log
- [ ] Phase 3.1 Day 1: VECTOR_STORE=pg 切流 + deploy:full + 25 vars
- [ ] Phase 3.2 Day 2: verify:nli-real-user + verify:nli-cross-turn + audit_log 7 天趋势
- [ ] Phase 3.3 Day 3: verify:p8-vector-db 4/4 PASS + 灰度全量
- [ ] Phase 4.1 state-p8-real-deploy.md 收尾
- [ ] Phase 4.2 memory + MEMORY.md pointer 更新
- [ ] Phase 4.3 P9 brainstorm 起点 (NLI 后置 / LLM streaming / 本地推理)

---

## 8. 关联文档

- **P8 代码收官**: `state-p8-vector-db-pgvector.md` (commit `ce3207c`, 10 节)
- **P8 spec**: `specs/2026-06-25-p8-vector-db-pgvector-design.md` (commit `175024a`)
- **P8 plan**: `plans/2026-06-25-p8-vector-db-pgvector.md`
- **P4 deploy pipeline**: `state-p4-deploy-pipeline.md` (deploy:full / push / status 模式)
- **P6 真接模板**: `state-p6-local-onnx-nli.md` §1.2 (6 步真接表模板)
- **P7 真接模板**: `state-p7-p8-followup-completion.md` (verify:nli-cross-turn 真接脚本)
- **P7 follow-up #1**: deploy:full 一条命令 (Phase 3.1 / 3.2 / 3.3 都用)
- **P4 #3 部署顺序耦合**: tcb fn deploy wipes secrets, 必须 deploy → push 顺序

## 9. 真接期间已知风险 + 缓解

| 风险 | Mitigation |
|---|---|
| 腾讯云 PG 模式建 env 失败 (账号未开 PG) | 联系腾讯云客服开通, 或回退到 MySQL + cosine UDF (P8 spec §2 B 方案, YAGNI) |
| pgvector 版本 < 0.7.0 segment fault | 锁版本 ≥ 0.7.0, 监控 PG 端 errors |
| HNSW 索引 build 慢 (>30s on 1963 chunks) | 正常 (冷建索引), 后续 insert 走 HNSW 增量 |
| Phase 1.2 ETL 1963 chunks 慢 (>5min) | batch 100 + retry 3 次 + 进度报告 (state-p8 §2.2) |
| Phase 2.1 deploy 后 P8 code 启动失败 (TypeScript 类型错漏) | 看 cloudbase fn log, 立即撤 deploy, 修代码重跑 |
| Phase 3.2 NLI reject 率反升 (PG 数据缺, 命中率低) | 回滚 VECTOR_STORE=nosql, 修 ETL (重跑) / 加索引 |
| Phase 3.3 真接 4 步有 fail | 拆 step 单独跑, 找具体 step 错, 修 verify:p8-vector-db 或 PG config |
| 真接后 PG 计费成本 | 调研确认 PG 模式价格, 月度账单监控 (state-p8 §8 risk #9) |

---

## 10. 总结 (执行顺序 cheat sheet)

```bash
# === Phase 0 (云端手动, 半天) ===
# 1. 腾讯云控制台建 PG env `unequal-d4ggf7rwg82e0900b-pg`
# 2. CREATE EXTENSION vector + schema + 3 索引 (Phase 0.2 SQL)
# 3. EXPLAIN ANALYZE 验证 HNSW 走通 + latency < 100ms

# === Phase 1 (CLI, 1-2 小时) ===
# 4. security add-generic-password 注入 PG_CONNECTION_STRING
# 5. pnpm -F api migrate:no-sql-to-pg (1963 chunks ETL)
# 6. psql 验 pg_count = 1963 + EXPLAIN ANALYZE 走 HNSW

# === Phase 2 (CLI, 半天) ===
# 7. pnpm -F api deploy:full (P8 code 部署, VECTOR_STORE=nosql)
# 8. admin 推 1 PDF + 验 NoSQL/PG 双写

# === Phase 3 (CLI, 3 天) ===
# 9. Day 1: 改 VECTOR_STORE=nosql → pg + deploy:full + 25 vars
# 10. Day 2: pnpm -F api verify:nli-real-user + verify:nli-cross-turn + audit_log 7 天趋势
# 11. Day 3: pnpm -F api verify:p8-vector-db 4/4 PASS + 灰度全量

# === Phase 4 (文档, 1 小时) ===
# 12. 写 state-p8-real-deploy.md + memory + MEMORY.md pointer
# 13. P9 brainstorm 起点 (建议: NLI 后置)
```

**总耗时估计**: 半天 (Phase 0) + 2 小时 (Phase 1) + 半天 (Phase 2) + 3 天 (Phase 3) + 1 小时 (Phase 4) = **4-5 天** (含云端操作 + 灰度观察期)

P8 完整收官 = 代码 (✅ done) + 真接 (本指南) + state doc (Phase 4).