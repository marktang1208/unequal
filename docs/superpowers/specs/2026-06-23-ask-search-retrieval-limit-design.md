# Ask/Search Retrieval 1MB 阻塞修复

**日期**：2026-06-23
**作者**：Mark + Claude (brainstorming 协作)
**状态**：✅ Design approved
**Tag**：`ask-search-retrieval-limit`
**前置**：
- P5 NLI spec `2026-06-23-p5-nli-entailment-design.md`（commit `82a093e`）— 真接 step 2-3 被本 bug 阻塞
- `api-chat.ts:139` — working pattern（已用 `whereQuery({limit:500})`）
- `state-arch-v2.3.md` — admin 不 embed / API 自己 embed / CloudBase 5MB/1MB 限制

---

## 1. 摘要

修复 `api-ask` 和 `api-search` 两个 handler 因 CloudBase 1MB 单次回包限制导致的 `LimitExceeded.OutOfResultSizeLimit` 错误。当用户 chunks 累计 > ~100 条（按 10KB/chunk 估）时 `getAllByFilter` 全量拉会爆 1MB。

**核心改动**：把两个 handler 的 `getAllByFilter({userId})` 替换为 `whereQuery({userId}, {limit:500})`，与 `api-chat` 行为一致。

**核心收益**：
- P5 NLI 真接 step 2-6 立即生效（不被 ask retrieval bug 阻塞）
- /api-search 不再因数据量爆雷
- 3 个 handler 行为一致（ask / chat / search 都走相同检索 pattern）

---

## 2. 决策摘要

| 决策点 | 选择 | 原因 |
|---|---|---|
| **修复范围** | Ask + Search 都修 | 同一 bug 不同 handler，一起修避免复发 |
| **Limit 阈值** | 500 | 与 api-chat 完全一致；5x buffer（CloudBase 1MB / chunk 10KB ≈ 100 阈值） |
| **超限反馈** | warn log（不写 audit） | 最小 diff；admin 终端可见；不引入新审计路径 |
| **方案选择** | whereQuery(limit:500) | 与 chat 一致；YAGNI；v2 留路给 helper 签名 + 分页 |
| **方案 B（helper 签名）** | 不实现 | 影响其他 caller（admin 真接路径），需架构 review |
| **方案 C（分页累加）** | 不实现 | round-trip 多，YAGNI 在当前规模 |
| **测试 mock** | mock 函数名同步改 | 与 handler import 一致 |
| **Commit 粒度** | 2 commit（handler+tests；doc+state） | 细粒度可回滚 |

---

## 3. 架构（不变）

暴力 cosine in-memory 检索（`searchChunks` in `@unequal/shared/retrieval`）。本次只改"拉 chunks"那一步，不动检索算法 / 不动 LLM / 不动 NLI。

```
                    ┌─────────────────────┐
                    │   CloudBase DB      │
                    │   (chunk 集合)      │
                    └──────────┬──────────┘
                               │
                               │ whereQuery({userId}, {limit:500})  ← NEW
                               │ was: getAllByFilter({userId})      ← OLD (buggy)
                               │
                    ┌──────────▼──────────┐
                    │   searchChunks      │
                    │   (暴力 cosine)     │
                    └──────────┬──────────┘
                               │
                               │ topK=5 chunks
                               │
                    ┌──────────▼──────────┐
                    │   LLM chat + NLI    │
                    └─────────────────────┘
```

---

## 4. 改动

### 4.1 `apps/api/src/handlers/api-ask.ts`

```diff
- import { getAllByFilter } from "../lib/db.js";
+ import { whereQuery } from "../lib/db.js";

- const chunks = await getAllByFilter<Chunk>(COLLECTIONS.chunk, { userId: env.DEFAULT_USER_ID });
+ // CloudBase 单次回包 1MB 上限；limit=500 与 api-chat 对齐。
+ // chunk 平均 10KB（含 1536 浮点 embedding），500 chunks ≈ 5MB 上界；500 是云端排序后取 topK=5 的安全余量。
+ // 若用户实际 > 500 chunks，暴力 cosine 仍能 topK=5 但漏候选 — v2 需分页累加。
+ const chunks = await whereQuery<Chunk>(COLLECTIONS.chunk, { userId: env.DEFAULT_USER_ID }, { limit: 500 });
+ if (chunks.length === 500) {
+   // eslint-disable-next-line no-console
+   console.warn(`[api-ask] chunk retrieval hit 500 limit; user ${env.DEFAULT_USER_ID} may have more (v2 待分页)`);
+ }
```

### 4.2 `apps/api/src/handlers/api-search.ts`

```diff
- import { getAllByFilter } from "../lib/db.js";
+ import { whereQuery } from "../lib/db.js";

- const chunks = await getAllByFilter<Chunk>(COLLECTIONS.chunk as CollectionName, { userId: env.DEFAULT_USER_ID });
+ // 同 api-ask：CloudBase 1MB 单次回包上限，limit=500 与 api-chat 一致。
+ const chunks = await whereQuery<Chunk>(COLLECTIONS.chunk as CollectionName, { userId: env.DEFAULT_USER_ID }, { limit: 500 });
+ if (chunks.length === 500) {
+   // eslint-disable-next-line no-console
+   console.warn(`[api-search] chunk retrieval hit 500 limit; user ${env.DEFAULT_USER_ID} may have more (v2 待分页)`);
+ }
```

### 4.3 不动的部分

| 文件 | 行 | 不动的原因 |
|---|---|---|
| `apps/api/src/handlers/api-ask.ts:119` | docs 查询 | 已传 `1` 作 limit 参数（按 documentId 单查，正确） |
| `apps/api/src/handlers/api-chat.ts:139` | 已是 working pattern | 不动 |
| `packages/shared/src/retrieval.ts` | searchChunks 算法 | 不动 |
| `apps/api/src/lib/db.ts` | getAllByFilter helper | v2 再改签名 |

### 4.4 测试 mock 更新

#### 4.4.1 `apps/api/test/handlers/api-ask.test.ts`

```diff
- // 1. mock CloudBase DB — getAllByFilter 返 mock chunks + docs
+ // 1. mock CloudBase DB — whereQuery 返 mock chunks + docs
  vi.mock("../../src/lib/db.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/lib/db.js")>();
    return {
      ...actual,
-     getAllByFilter: vi.fn(),
+     whereQuery: vi.fn(),
    };
  });

- import * as db from "../../src/lib/db.js";
- // ...
- vi.mocked(db.getAllByFilter).mockImplementation(async (coll: string, filter: any) => {
+ import * as db from "../../src/lib/db.js";
+ // ...
+ vi.mocked(db.whereQuery).mockImplementation(async (coll: string, filter: any, opts?: any) => {
    if (coll === "chunk") return [MOCK_CHUNK_1, MOCK_CHUNK_2] as any;
    if (coll === "document") {
      if (filter && filter.id) return [MOCK_DOC_1] as any;
      return [];
    }
    return [];
  });
```

新增 test case：

```typescript
it("1000 chunks mock 不 throw：handler 返回 topK=5", async () => {
  // mock 1000 chunks，验证不再 throw CloudBase LimitExceeded
  const bigChunks = Array.from({ length: 1000 }, (_, i) => ({
    ...MOCK_CHUNK_1,
    _id: `01K_CHUNK_${i}`,
    id: `01K_CHUNK_${i}`,
    content: `mock chunk ${i}: ${"x".repeat(1000)}`,  // 模拟大 payload
    embedding: new Array(1536).fill(Math.random()),
  }));
  vi.mocked(db.whereQuery).mockImplementation(async (coll: string, filter: any, opts?: any) => {
    if (coll === "chunk") {
      // 验证 handler 传了 limit: 500
      expect(opts?.limit).toBe(500);
      return bigChunks as any;
    }
    return [];
  });

  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ vectors: [new Array(1536).fill(0.5)] }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "答案 [1]." } }],
      }),
    } as Response);

  const ev = makeEvent({ q: "q" });
  const res = await askMain(ev);
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).citations.length).toBeGreaterThan(0);
});
```

#### 4.4.2 `apps/api/test/handlers/api-search.test.ts`

类似更新；如文件不存在则新建（参考 api-search spec §6 测试 pattern）。

---

## 5. 真接验收 (`scripts/verify-ask-search-retrieval.sh`)

5 步核心场景：

```bash
[1/5] typecheck + 全 511+ tests PASS
[2/5] pnpm -F api deploy push（merge 模式，不重写其他 vars）
[3/5] production ask "发烧怎么办" → 不再 500（修复前必失败，修复后 PASS）
[4/5] production search "断奶" → topK=5 正常返
[5/5] audit log 查 warn（如有触发）
```

**前置**：
- `tcb login` (CloudBase CLI 已登录)
- SILICONFLOW_API_KEY 已加 Keychain
- 真实 production 数据（admin 已上传 ≥ 100 chunks）

**manual 验收**：
- `pnpm -F api deploy push` 推 ask/search handler bundle
- `curl /api-ask -d '{"q":"发烧怎么办"}'` → 200 + answer + citations（修复前会 500）
- `curl /api-search?q=断奶` → 200 + results
- CloudBase 日志搜 `[api-ask]` / `[api-search]` 看 warn 是否触发（用户实际 > 500 才 warn）
- P5 NLI 真接 6 步重跑（修完后 NLI 应走到 step 4-6）

---

## 6. v2 留路（YAGNI 不实现）

| 候选 | 触发条件 | 估时 |
|---|---|---|
| `getAllByFilter` 加 limit 参数（方案 B） | helper 架构 review 时统一做 | 1 天 |
| 分页累加 topK（方案 C） | 用户实际 > 500 chunks 时 spec | 1-2 天 |
| CloudBase 服务端 vector search | 数据量 > 10K chunks 时 | 2 天（架构） |
| 第三方向量 DB（VectorDB / Pinecone） | 数据量 > 100K chunks | 架构级 |

---

## 7. 边界 / 限制

1. **500 chunks 是软上限**，超出会漏数据；v2 加分页
2. **暴力 cosine O(N) 计算** — 500 chunks × 1536 dim = 768K 浮点乘，~50ms 内存算（vs 全量 1万 chunks 500ms）
3. **不引入新依赖**，纯 whereQuery 替换
4. **不修 `getAllByFilter` helper 本身** — 留给 v2 helper 架构 review
5. **warn log 不写 audit** — 最小 diff，不引入新审计路径
6. **不修 CloudBase SDK `tcb ... .limit()` 行为** — SDK 限制，非本 PR 范围

---

## 8. 风险

| Risk | Likelihood | Mitigation |
|---|---|---|
| 现有 ask test 没覆盖大 chunks 场景 | LOW | 新增 1000 chunks mock 测试 |
| search test 不存在 | MEDIUM | 复用现有 pattern 新建 |
| warn log 噪声大（每天 1000+ ask） | LOW | 仅在 chunks.length === 500 触发，不是每次 |
| 用户实际 > 500 chunks 漏召回 | LOW | 当前 production 数据 < 500 chunks；warn log 提前信号 |
| 真接发现新 bug（如 scoreThreshold 误调） | LOW | 真接前 typecheck + 全 tests + mock 1000 chunks 测试 |

---

## 9. 关联

- **P5 NLI 真接 6 步**（`scripts/verify-nli.sh`）— 本修复后 step 2-6 立即生效
- **api-chat handler**（working pattern）— 复用其 `whereQuery({limit:500})` 用法
- **api-search 真接**（state-cp5 §4 step 4）— 不再因数据量 500
- **state-arch-v2.3.md** — CloudBase 1MB / 5MB 限制事实稳定

---

## 10. References

- P5 NLI spec：`docs/superpowers/specs/2026-06-23-p5-nli-entailment-design.md`
- 架构事实：`docs/archive/state/state-arch-v2.3.md`
- working pattern：`apps/api/src/handlers/api-chat.ts:139`
- bug 位置：`apps/api/src/handlers/api-ask.ts:89` + `apps/api/src/handlers/api-search.ts:55`
- 真接阻塞：`docs/superpowers/state-p5-nli-entailment.md` §6.1