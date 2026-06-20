# CP-7-C #4: db.add() 自动填 schema id 字段（root cause fix）

**日期**：2026-06-21
**前置**：CP-7 真接 Round 2 教训（commit `b7bee4a`）— JWT.sub="" 污染
**目标包**：`apps/api`
**Tag**：`cp7-c4-db-add-autoid`

---

## 1. Summary

修 `apps/api/src/lib/db.ts` 的 `add()` 函数：当 caller 没提供有效 `id` 字段（空字符串/undefined/null/whitespace）时，自动填 = 新生成的 CloudBase `_id`。这是 CP-7 真接 Round 2 JWT.sub="" 污染问题的 **root cause fix** — 之前 caller 用 `id: ""` dirty workaround，现在 add() 自动保证 schema `id` 字段 = `_id`，从源头避免污染。

**重要约束**：本 spec 只修 Pattern A（caller 没提供有效 id 的 6 个 caller 自动修复）。Pattern B（caller 显式提供有效 id 的 4 个 caller，如 `api-upload` document / `api-chat` session / `audit`）**维持现状**（向后兼容，不破坏现有 caller 的隐含语义）。

---

## 2. Goals

- **G1**：`add(collection, { id: "" })` → 写入 doc 的 schema `id` 字段 = 新生成的 `_id`（不再是空字符串）
- **G2**：`add(collection, { id: undefined })` 或 `id: null` 或 `id: "   "` → 同 G1
- **G3**：`add(collection, { id: "01HABC..." })` → 写入 doc 的 `id` = `"01HABC..."`（caller 值不被覆盖）
- **G4**：所有 6 个 Pattern A caller（`api-auth-wx-login` / `api-upload` source+chunk / `api-ingest` source+document+chunk）零代码改动即获得 G1 行为
- **G5**：所有 4 个 Pattern B caller（`api-upload` document / `api-chat` session / `audit` / `api-auth-admin-login`）零行为变化
- **G6**：单元测试覆盖行为矩阵（empty/undefined/null/whitespace/有效值 5+1 用例）

---

## 3. Non-Goals

- **N1**：不改 Pattern B caller（`api-upload` document / `api-chat` session / `audit` 等即使有 `_id != caller_id` 的潜在不一致，也不是本 spec 范围）
- **N2**：不改 `packages/shared/src/types.ts` 的 schema 定义（`id: string` 仍必填）
- **N3**：不改任何 handler（6 Pattern A caller 自动受益；4 Pattern B caller 自动不受影响）
- **N4**：不做文档历史数据迁移（CP-7-C #6 候选独立处理）
- **N5**：不改 `add()` 返回值（仍返回 `_id`）
- **N6**：不改 `add()` 泛型签名（保持 free `<T>`，type 层不强制 `id` 字段）

---

## 4. Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| 泛型签名 | `apps/api/src/lib/db.ts:22` | `add<T>(collection, data: T): Promise<string>` |
| Mock 模式 | `apps/api/test/lib/audit.test.ts` | `vi.mock("../../src/lib/db.js", () => ({ add: vi.fn(...) }))` |
| 错误 throw 风格 | `apps/api/src/lib/audit.ts:85` | `if (!field) throw new Error("...")` |
| Conditional 字段 | `apps/api/src/handlers/api-ingest.ts:126` | `...(tokenFingerprint ? { tokenFingerprint } : {})` |
| 测试 fixture | `apps/api/test/handlers/api-ingest.test.ts:30-42` | `testEnv` 对象 mock env |
| Spread 顺序 | `apps/api/src/lib/db.ts:27` | `{ _id, ...data }` 当前顺序 |

---

## 5. Architecture

```
caller: add(collection, { id: "", ...other })
                │
                ▼
       ┌────────────────────────────┐
       │ db.ts: add()                │
       │   1. const _id = newId()    │
       │   2. const dataRecord = ... │
       │   3. const providedId = ... │  ← typeof === "string" ? : ""
       │   4. const finalId =        │
       │        providedId.trim()    │
       │        !== "" ?             │
       │        providedId : _id    │  ← 关键：empty → 用 _id
       │   5. add({ ...data,         │
       │           _id,              │
       │           id: finalId })    │  ← 后置覆盖（data spread 先，id 后置）
       │   6. return _id             │
       └────────────────────────────┘
                │
                ▼
       CloudBase doc: { _id, id: <_id 或 caller值>, ...data }
```

---

## 6. Files to Change

| File | Action | Why |
|---|---|---|
| `apps/api/src/lib/db.ts` | UPDATE | `add()` 内部加 id 自动填逻辑（spread 顺序调整）|
| `apps/api/test/lib/db.test.ts` | CREATE（如果不存在）/ UPDATE | 新增 7 个 unit test 覆盖行为矩阵 |
| `docs/superpowers/state-cp7-zhenjie.md` | UPDATE | §8 #4 标 ✅（commit 后）|

**不动**：
- 任何 handler（零代码改动）
- `packages/shared/src/types.ts`（schema 定义不变）
- `apps/api/src/lib/audit.ts`（Pattern B 维持）
- 任何现有 handler test（间接 mock add() 即可）

---

## 7. Detailed Changes

### 7.1 `apps/api/src/lib/db.ts`

**Before** (line 22-29):
```typescript
export async function add<T>(
  collection: CollectionName,
  data: T,
): Promise<string> {
  const _id = newId();
  await DB().collection(collection).add({ _id, ...(data as Record<string, unknown>) });
  return _id;
}
```

**After**:
```typescript
export async function add<T>(
  collection: CollectionName,
  data: T,
): Promise<string> {
  const _id = newId();
  const dataRecord = data as Record<string, unknown>;
  // CP-7-C #4: caller 没提供有效 id → 自动填 = _id（避免 id: "" 污染）
  const providedId = typeof dataRecord.id === "string" ? dataRecord.id : "";
  const finalId = providedId.trim() !== "" ? providedId : _id;
  await DB().collection(collection).add({ ...dataRecord, _id, id: finalId });
  return _id;
}
```

**关键改动**：
1. Spread 顺序改为 `{ ...dataRecord, _id, id: finalId }` — `_id` 后置避免被 data 覆盖（防御性，实际 schema 不含 `_id`）；`id` 一定最后置，确保覆盖 caller 的空 id
2. `providedId.trim() !== ""` 显式处理 4 种 empty case（"" / undefined / null / "   "）

### 7.2 `apps/api/test/lib/db.test.ts`（如不存在则 CREATE）

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock CloudBase SDK
const mockAdd = vi.fn(async () => ({ id: "mock-cloudbase-id" }));
const mockCollection = { add: mockAdd };
const mockDB = { collection: vi.fn(() => mockCollection) };

vi.mock("../../src/lib/cloudbase.js", () => ({
  getDB: () => mockDB,
}));

import { add, newId } from "../../src/lib/db.js";
import { COLLECTIONS } from "../../src/lib/collections.js";

beforeEach(() => {
  mockAdd.mockClear();
  mockDB.collection.mockClear();
});

describe("db.add() - CP-7-C #4 自动填 schema id", () => {
  it("id: '' (empty) → 自动填 = _id (CP-7-C #4)", async () => {
    const result = await add(COLLECTIONS.user, { id: "", name: "test" });
    expect(mockAdd).toHaveBeenCalledTimes(1);
    const writtenDoc = mockAdd.mock.calls[0]![0] as Record<string, unknown>;
    expect(writtenDoc.id).toBe(result);  // id === _id
    expect(writtenDoc._id).toBe(result);
  });

  it("id: undefined → 自动填 = _id (CP-7-C #4)", async () => {
    const data: { id?: string; name: string } = { name: "test" };
    const result = await add(COLLECTIONS.user, data);
    const writtenDoc = mockAdd.mock.calls[0]![0] as Record<string, unknown>;
    expect(writtenDoc.id).toBe(result);
  });

  it("id: null → 自动填 = _id (CP-7-C #4)", async () => {
    const data = { id: null as unknown as string, name: "test" };
    const result = await add(COLLECTIONS.user, data);
    const writtenDoc = mockAdd.mock.calls[0]![0] as Record<string, unknown>;
    expect(writtenDoc.id).toBe(result);
  });

  it("id: '   ' (whitespace) → 自动填 = _id (CP-7-C #4)", async () => {
    const data = { id: "   ", name: "test" };
    const result = await add(COLLECTIONS.user, data);
    const writtenDoc = mockAdd.mock.calls[0]![0] as Record<string, unknown>;
    expect(writtenDoc.id).toBe(result);
  });

  it("id: '01HABC...' (有效值) → 保留 caller 值 (CP-7-C #4)", async () => {
    const callerId = "01HABCDEFG123456789012345";
    await add(COLLECTIONS.user, { id: callerId, name: "test" });
    const writtenDoc = mockAdd.mock.calls[0]![0] as Record<string, unknown>;
    expect(writtenDoc.id).toBe(callerId);  // caller 值不被覆盖
  });

  it("data 不含 id 字段 → 自动填 = _id (CP-7-C #4)", async () => {
    const result = await add(COLLECTIONS.user, { name: "test" });
    const writtenDoc = mockAdd.mock.calls[0]![0] as Record<string, unknown>;
    expect(writtenDoc.id).toBe(result);
  });

  it("返回值始终是新生成的 _id（不是 caller id）(CP-7-C #4)", async () => {
    const callerId = "01HABCDEFG123456789012345";
    const result = await add(COLLECTIONS.user, { id: callerId, name: "test" });
    expect(result).not.toBe(callerId);  // add() 仍返 _id
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
```

---

## 8. Data Flow

### 8.1 Pattern A caller（id: ""）— 修复路径

```
api-auth-wx-login.ts:
  const newUser = { id: "", wxOpenid, createdAt };
  await add(COLLECTIONS.user, newUser);
                ↓
db.add():
  _id = newId() = "01HNEW..."
  providedId = ""
  finalId = _id  ← 自动填
  add({ ...newUser, _id, id: finalId })
                ↓
CloudBase doc: { _id: "01HNEW...", id: "01HNEW...", wxOpenid, createdAt }
                ↓
后续 read: getById 返 { _id: "01HNEW...", id: "01HNEW...", wxOpenid, ... }
         whereQuery({id: "01HNEW..."}) 也能查到（之前查不到因为 id=""）
```

### 8.2 Pattern B caller（id: caller_value）— 维持路径

```
api-upload.ts:
  const docId = newId();
  await add(COLLECTIONS.document, { id: docId, sourceId, ..., rawPath: rawFilePath(env.DEFAULT_USER_ID, docId, ext) });
                ↓
db.add():
  _id = "01HNEW_DIFFERENT..."
  providedId = docId
  finalId = docId  ← 保留 caller 值
  add({ ...data, _id: "01HNEW...", id: docId })
                ↓
CloudBase doc: { _id: "01HNEW...", id: docId, sourceId, ... }
                ↓
caller 用 docId 拼 rawPath/parsedTextPath (与 add() 写入的 id 一致)
caller 用 sourceId = add() 返回值（_id）当 source 身份
```

---

## 9. Error Handling

add() 内部不 throw（除非 CloudBase SDK 自身 throw，透传）。validation 在 caller 层：
- caller 必须给 `data`（非 null/undefined）— type 层强制
- caller 必须确保 `data` 是 plain object — type 层强制

**不新增 validation**：trust caller 传入的 data shape；如果 caller 传错，CloudBase SDK 会 throw，透传给 handler。

---

## 10. Testing Strategy

### 10.1 新测试（`db.test.ts`）

7 个 unit test（见 §7.2）：
- 4 种 empty case（"" / undefined / null / whitespace）→ 自动填 `_id`
- 1 个有效值 case → 保留 caller
- 1 个 data 无 id 字段 case → 自动填 `_id`
- 1 个返回值始终是 `_id` case

### 10.2 现有测试（应仍 PASS）

- `api-auth-wx-login.test.ts` — mock `db.add()` 返固定值；行为不变
- `api-upload.test.ts` — 同上
- `api-ingest.test.ts`（17 用例）— mock `db.add()` 返固定值；行为不变
- `api-chat.test.ts` — 同上
- `audit.test.ts`（9 用例）— mock `db.add()` 返固定值；行为不变
- `auth-admin.test.ts` — 不调 add()，无影响

### 10.3 累计测试数

- api: ~63 → ~70（净 +7）

---

## 11. Acceptance Criteria

### AC-1 单元测试全 PASS
```bash
pnpm -F api test
```
预期：全部 PASS；api test count ≥ 70

### AC-2 typecheck PASS
```bash
pnpm -F api typecheck
```
预期：无 error

### AC-3 现有 caller test 仍 PASS（间接回归覆盖）
包含 `api-auth-wx-login.test.ts` / `api-upload.test.ts` / `api-ingest.test.ts` / `api-chat.test.ts` / `audit.test.ts`，全部仍 PASS

### AC-4 commit
```bash
git log --oneline | grep cp7-c4
```
预期：1 个 commit（`feat(api): CP-7-C #4 db.add() 自动填 schema id`）

### AC-5 行为正确性 spot check（可选）
写一个一次性的 node 脚本调用 add() 验证最终 doc 的 id == _id（mock SDK）；不强制，AC-1 已覆盖

---

## 12. Deployment

**无部署**：纯代码改动（apps/api 包内）；CloudBase 端 schema 不变，无需 migration。

部署步骤 = commit + 无需 tcb fn deploy（api-router 函数未变 — add() 是函数内行为变化）。

---

## 13. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Pattern B caller 的隐含 `_id != caller_id` 不一致未被修复 | LOW | 不在 #4 范围；Pattern B caller 自己决定是否用 `_id`；后续如需可单独优化 |
| `providedId.trim()` 对非 ASCII whitespace 不全 | LOW | JS String.trim() 处理所有 Unicode whitespace；足够 |
| Mock CloudBase SDK 行为与真实 SDK 不一致 | LOW | Mock 用 `vi.fn(async () => ({ id: "..." }))` 返 CloudBase SDK 期望 shape；ac-1 mock 测试通过即可信 |
| type 系统不强制 `T extends { id?: string }` | LOW | 显式 `Record<string, unknown>` 兜底；runtime 不依赖 type 检查 |

---

## 14. Out of Scope (后续候选)

- **CP-7-C #6** 候选：documents schema id 字段数据迁移（如果 #4 上线后有历史脏数据需要 cleanup，独立 spec）
- Pattern B caller cleanup（如果未来需要统一 `_id` 为唯一身份）
- add() batch 模式 / 事务支持（YAGNI）

---

## 15. References

- **state-cp7-zhenjie.md §8 #4**：本 spec 任务来源
- **CP-7 真接 Round 2 教训**：state-cp7-zhenjie.md §2 Round 2 + §7 教训 #1
- **CP-7-C #1**：`fcc3693` 删除临时 debug handlers
- **CP-7-C #2**：`be61e1c` ingest audit + user_id 收紧
- **CP-7-C #3**：`f5ae83e` crawler schema 对齐 + user_id wire-up
- **packages/shared/src/types.ts**：所有 schema 的 `id: string` 必填定义
- **Chunk 类型注释**（line 33-37）："`id` 字段保留以兼容历史接口 ... 但实际 ID 由 CloudBase `_id` 自动生成" — 现状正是本 spec 要修的问题