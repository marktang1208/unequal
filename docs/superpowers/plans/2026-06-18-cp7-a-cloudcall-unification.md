# CP-7-A Plan — miniprogram callFunction 统一化

**Spec**：`docs/superpowers/specs/2026-06-18-cp7-a-cloudcall-unification-design.md`（commit `3c86ac2`，已批准）
**复杂度**：Small-Medium（1 包 / 6 caller / 1 helper 升级 / 0 schema / 0 env）
**预计**：主线程 2-4h（参考 M6.3c/d/4/9/10 经验）

---

## ⚠️ Spec vs 实际代码差异（写 plan 时发现）

| 项 | Spec 设想 | 实际代码 | Plan 调整 |
|---|---|---|---|
| `lib/cloud-call.ts` | NEW（150 行）| **已存在**（73 行，P3.9 引入）| **升级** — 改 cloudCall 函数 + 加 ApiError + 加 __resetCloudCallImpl；不动测试桩 `__setCloudCallImpl` 名字 |
| `cloudCall` API | `cloudCall<T>(req): Promise<T>` + throw ApiError | `cloudCall(req): Promise<{statusCode, body}>` | **重写函数签名**（保持名字） |
| caller 数 | 5（chat/sessions/ask/rename/delete）| **6**（+ updateNickname M6.3c） | 6 caller 改调 cloudCall |
| `adminLogin` | 不动（已说明）| **确认不动** — 走 getFetch 直连（无 jwt header）| 不动 |
| `fetchWithRefresh` | 删 dead code | 已存在（M6.3a/M6.4）| **删 dead code** |
| `inflightEnsureJwt` + `__clearInflightEnsureJwt` | 隐含删除 | 已在 `lib/api.ts` 模块级 | **迁入 cloudCall.ts 模块级 + 删 api.ts 的** |
| `wxRequestAsFetch` | 删 dead code | 已存在（P3.9 之前）| **删 dead code** |
| `lib/auth.ts` ensureJwt | 改 private + rename export | **已有 callFunction 路径** + 旧 `_baseUrl/fetchImpl` 参数残留 | **清理** — 删旧参数（callFunction 不需要）+ 改为内部使用；保留 public export（M6.2 已 work） |
| 测试 mock 模式 | `__setCloudCallImpl(fakeFn)` 注入 | 现 `fetchImpl` + `globalThis.wx.request` | **大规模 mock 改造** — 14 个 api.test 用例全部改 mock（spec 已说"行为保留，仅 mock 改"） |

**影响**：工作量比 spec 估的稍大（mock 改造 14 个 vs spec 估 0 净改），但仍是单 PR 可完成。

---

## Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| 测试桩注入 | `apps/miniprogram/lib/cloud-call.ts:32-34` `__setCloudCallImpl`（P3.9 已 work） | cloudCall.ts 模块级 `impl` + `__setCloudCallImpl` + `__resetCloudCallImpl`（add reset） |
| inflight promise 共享 | `apps/miniprogram/lib/api.ts:87-114` `inflightEnsureJwt` + `.finally(() => delete)` (M6.4) | cloudCall.ts 模块级 `inflightRefresh: Promise<string> \| null` + `.finally(() => inflightRefresh = null)` |
| Error class | `apps/api/src/lib/http-error.ts` HttpError（statusCode + code + message）| cloudCall.ts `ApiError extends Error`，同形态 |
| Typed wrapper | `apps/admin/src/lib/api.ts`（admin helper） | miniprogram `lib/api.ts` 6 caller 改 typed wrapper：`cloudCall<T>({...})` 直接返 `Promise<T>` |
| Mock-first | CP-1 ~ CP-6 全程 | 测试用 `__setCloudCallImpl(mockFn)`，0 wx.cloud global mock |
| Refresh 边界 | `apps/miniprogram/lib/api.ts:95-128` `fetchWithRefresh` isRetry 模式 | cloudCall.ts isRetry 参数（防止 401 + refresh + retry 仍 401 时死循环） |

---

## Files to Change

| File | Action | Why |
|---|---|---|
| `apps/miniprogram/lib/cloud-call.ts` | UPDATE（73 → ~150 行）| 升级 cloudCall 函数为 typed `Promise<T>` + throw ApiError + 内作 401 refresh + inflight share |
| `apps/miniprogram/lib/api.ts` | REWRITE（262 → ~140 行）| 6 caller 改调 cloudCall；删 `wxRequestAsFetch` / `fetchWithRefresh` / `inflightEnsureJwt` / `__clearInflightEnsureJwt` |
| `apps/miniprogram/lib/auth.ts` | UPDATE（69 → ~50 行）| ensureJwt 删旧 `_baseUrl/fetchImpl` 参数残留；保留公共 export（M6.2 兼容）|
| `apps/miniprogram/test/cloud-call.test.ts` | NEW（~250 行）| 10 用例：happy / 401+refresh / 401+no-jwt / 401+refresh-fail / 401+retry-401 / 4xx / 5xx / network / inflight share / wx.login fail |
| `apps/miniprogram/test/api.test.ts` | UPDATE（568 → ~280 行）| 14 用例改 mock：`fetchImpl` mock → `__setCloudCallImpl(fakeFn)`；删 fetchWithRefresh/inflight 测试（迁移到 cloud-call.test.ts）|
| `apps/miniprogram/test/auth.test.ts` | UPDATE（104 → ~80 行）| ensureJwt 改内部用 cloudCall（删旧 HTTP fetchImpl 分支）；5 用例改 mock（用 `__setCloudCallImpl`）|
| `docs/cp7-cloud-call-setup.md` | NEW（~120 行）| 用法 + mock 指南 + 内部细节 + migration 路径 |
| `README.md` | UPDATE | +CP-7-A 节 |
| `docs/superpowers/state-cp7-a.md` | NEW（~200 行）| commit 汇总 + 教训 + 真接路径 |

**共 3 改代码 + 1 新测试 + 2 改测试 + 3 新/改文档 = 9 总**

---

## Tasks

### Task 1: `cloud-call.ts` 升级（RED-GREEN-REFACTOR）

- **Action**：
  1. 写 `apps/miniprogram/test/cloud-call.test.ts` 10 用例（RED）
  2. 升级 `apps/miniprogram/lib/cloud-call.ts`：
     - 保留 `CloudCallRequest` 接口（已对）
     - 保留 `__setCloudCallImpl` 测试桩（已对）
     - 加 `__resetCloudCallImpl` 测试桩
     - 加 `ApiError` class
     - 重写 `cloudCall<T>(req): Promise<T>`：typed body + throw ApiError + 401 refresh + inflight share
     - 加模块级 `inflightRefresh: Promise<string> | null`
     - 加私有 `_refreshJwt()` helper
     - 加 `codeFromBody()` + `msgFromBody()` helpers
  3. 跑测试（GREEN）— 10 用例全绿
  4. REFACTOR：清理 impl 函数、内联 helper（如合适）

- **Mirror**：`apps/miniprogram/lib/api.ts:87-128` inflightEnsureJwt + fetchWithRefresh isRetry 模式
- **Validate**：`pnpm -F miniprogram test cloud-call`

---

### Task 2: `lib/api.ts` 重写 + `lib/auth.ts` 清理

- **Action**：
  1. 重写 `apps/miniprogram/lib/api.ts`：
     - 删 `wxRequestAsFetch` 函数（dead code）
     - 删 `getFetch` 函数（dead code）
     - 删 `fetchWithRefresh` 函数（dead code，refresh 内作于 cloudCall）
     - 删 `inflightEnsureJwt` + `__clearInflightEnsureJwt`（迁入 cloudCall.ts）
     - 删 `buildHeaders` 函数（内作于 cloudCall）
     - 6 caller（ask / chat / listSessions / renameSession / deleteSession / updateNickname）改调 `cloudCall<T>({path, httpMethod, body, jwt})`，返 `Promise<T>`
     - `adminLogin` 保留走 HTTP — 因为 admin 走不了 wx.cloud（admin 是 web app），但 miniprogram 端 `adminLogin` 是 admin 用，所以保留 getFetch；或者考虑改为 callFunction（admin 也能用 — 详见"决策点"）
  2. 清理 `apps/miniprogram/lib/auth.ts`：
     - ensureJwt 删 `_baseUrl` / `fetchImpl` 参数（callFunction 不需要）
     - 保留 public export（M6.2 已 work）
     - cloudCall 调用删旧 fallback 分支
  3. 跑测试 — 验证旧行为保留

- **Mirror**：spec §6.1 + §6.2
- **Validate**：`pnpm -F miniprogram test` — 期望 23 用例全绿（M6.3a 4 refresh + M6.4 3 inflight + M6.2 adminLogin 1 + ...，但部分删除后总数变化，详见 §Acceptance）

---

### Task 3: 测试更新

- **Action**：
  1. 更新 `apps/miniprogram/test/api.test.ts`：
     - 删 `fetchWithRefresh` describe 块（M6.3a + M6.4 共 7 用例 — 迁到 cloud-call.test.ts）
     - 改 14 caller 测试 mock：`fetchImpl` mock → `__setCloudCallImpl(fakeFn)`
     - 改 input 断言：`"http://localhost:8787/api-ask"` → `/api-ask`（无 baseUrl）
     - 改 body 断言：`"http://localhost:8787/api-ask"` 不在 cloudCall 内，body / headers 在 cloudCall 内断言
  2. 更新 `apps/miniprogram/test/auth.test.ts`：
     - ensureJwt 改内部用 cloudCall（删旧 HTTP fetchImpl 分支）；5 用例 mock 改 `__setCloudCallImpl`
  3. 跑测试 — 验证全绿

- **Mirror**：spec §7.1 + §7.2
- **Validate**：`pnpm -F miniprogram test` 全绿；`pnpm -r typecheck` 全绿

---

### Task 4: 文档 + state

- **Action**：
  1. 写 `docs/cp7-cloud-call-setup.md` — 用法 + mock 指南 + 内部细节 + migration 路径
  2. 更新 `README.md` 加 CP-7-A 节（参考 M6.x 节模式）
  3. 写 `docs/superpowers/state-cp7-a.md` 收尾

- **Validate**：commit 后阅读 docs 无 placeholder / TBD

---

## Validation

```bash
# Task 1 验证（RED-GREEN）
pnpm -F miniprogram test cloud-call

# Task 2 验证（caller 重写后）
pnpm -F miniprogram test

# Task 3 验证（全套）
pnpm -F miniprogram test         # 期望 23 用例全绿（迁移后）
pnpm -F miniprogram typecheck    # 期望 0 error
pnpm -r typecheck                # 5 包全绿
pnpm -F miniprogram build        # wx build 成功（如有 build 脚本）

# 最终累计
pnpm -F miniprogram test 2>&1 | grep -E "Test Files|Tests"
# 期望：约 23 用例（M6.3a 4 + M6.4 3 迁到 cloud-call，剩 16 + cloud-call 10 - 删除数 = 净调整）
```

---

## Decision Points

### DP-1: miniprogram `adminLogin` 走不走 callFunction？

**现状**：`adminLogin` 走 `getFetch` 直连 HTTP gateway（admin web app 用，不能用 wx.cloud — 但 miniprogram 端的 adminLogin 是 admin 在 web app 外的 mobile 入口，理论上可以用 callFunction）。

**选项**：
- **A：保留 HTTP** — adminLogin 不走 refresh（无 jwt header），保持现状。优点：scope 最小。缺点：miniprogram 端 admin 仍走 HTTP（不是 100% callFunction）。
- **B：改为 callFunction** — adminLogin 改调 cloudCall，删 getFetch。优点：miniprogram 端 100% callFunction。缺点：admin 鉴权要走 CloudBase context（userInfo.openId），但 admin 鉴权用 admin_token 不依赖 userInfo，callFunction 也能 work。

**Plan 决策**：**A 保留**。理由：admin 鉴权无 userInfo 依赖，HTTP 也 work；保持 admin 路径独立，CP-7-A scope 不蔓延；如 admin 想统一再后续处理。

### DP-2: `api-` 前缀写在 caller 还是 cloudCall 内部？

**选项**：
- **A：caller 写 `/api-chat` 完整路径**（spec D-7 决策）。caller 显式；cloudCall 透明转发。优点：debug 友好；caller 知道 server handler 名。
- **B：cloudCall 内部加 `api-` 前缀**。caller 写 `/chat`，cloudCall 改 `/api-chat`。优点：caller 简洁。缺点：隐式 magic（caller 不直观看 endpoint）。

**Plan 决策**：**A**（与 spec D-7 一致）。caller 写完整 `/api-chat`。

### DP-3: 测试 mock 是 `__setCloudCallImpl` 还是 vitest spy on `wx.cloud.callFunction`？

**选项**：
- **A：`__setCloudCallImpl(fakeFn)`**（spec 选）。优点：mock 简单；与 state-cp6 §10.6.3 设计一致。缺点：测试依赖测试桩存在（耦合）。
- **B：vitest spy `wx.cloud.callFunction`**。优点：mock 真实 wx 接口。缺点：需 mock 全局 wx；与现有 `fetchImpl` mock 模式不一致。

**Plan 决策**：**A**（与 spec D-5 一致；与 P3.9 auth.test.ts 已 work 模式一致）。

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Mock 改造漏 caller（api.test.ts 14 用例 → 改后部分迁到 cloud-call.test.ts） | MED | AC 显式列 6 caller 全覆盖；Task 3 拆 3 子步骤验证 |
| inflight share 与 M6.4 行为差异 | LOW | 复用 `inflightEnsureJwt` 模式（map + finally delete）；3 cloud-call 测试覆盖并发 |
| adminLogin 路径选择错误 | LOW | DP-1 选 A，scope 最小化；admin 后端独立 |
| impl 注入 mock 与真实 wx.cloud 不一致 | LOW | 测试覆盖所有错误路径；P3.9 已验真实协议 work；CP-7 真接时再验 |
| ApiError 与 server HttpError 不对齐 | LOW | ApiError 设计仿 HttpError（statusCode + code + message）|
| deleteSession / renameSession handler 后端 404 | LOW | CP-7-B 独立项目；客户端 throw ApiError(404) caller 降级显示 |
| ensureJwt 公共 export 改动影响其他 caller | LOW | M6.2 已有 ensureJwt public；保留 export 不破坏向后兼容；Task 2 子步骤验证 |

---

## Acceptance

### AC 功能

- [ ] AC-1 cloud-call.ts 提供 `cloudCall<T>(req): Promise<T>` + `ApiError(statusCode, code, message)` + `__setCloudCallImpl` + `__resetCloudCallImpl`
- [ ] AC-2 200 → return body as T
- [ ] AC-3 401 + jwt → refreshJwt + retry 1 次（成功返 body；失败 throw REFRESH_FAILED / UNAUTHORIZED）
- [ ] AC-4 401 + 无 jwt → throw ApiError(401, MISSING_AUTH)
- [ ] AC-5 4xx / 5xx → throw ApiError(statusCode, code, message)
- [ ] AC-6 impl throw → throw ApiError(0, NETWORK_ERROR, msg)
- [ ] AC-7 inflight share：3 并发 401 → 1 次 refreshJwt
- [ ] AC-8 401 + refresh + retry 仍 401 → clearJwt + throw UNAUTHORIZED
- [ ] AC-9 6 caller 全部改调 cloudCall，函数签名不变（adminLogin 除外）
- [ ] AC-10 `wxRequestAsFetch` / `fetchWithRefresh` / `inflightEnsureJwt` / `__clearInflightEnsureJwt` dead code 全部清理
- [ ] AC-11 `lib/auth.ts` ensureJwt 删旧 `_baseUrl/fetchImpl` 参数，公共 export 保留

### AC 测试

- [ ] AC-12 `pnpm -F miniprogram test` 全绿（迁移后期望 23 用例，详见 §Validation）
- [ ] AC-13 `pnpm -r typecheck` 5 包全绿

### AC 文档

- [ ] AC-14 `docs/cp7-cloud-call-setup.md` 完成
- [ ] AC-15 `README.md` 加 CP-7-A 节
- [ ] AC-16 `docs/superpowers/state-cp7-a.md` 收尾

---

## Commit 拆分（5 commit + 1 merge = 6 总）

| # | Commit | 主题 | 测试增量 |
|---|---|---|---|
| 1 | spec | `docs: CP-7-A spec — miniprogram callFunction 统一化` | 0（已 commit `3c86ac2`）|
| 2 | plan | `docs: CP-7-A plan — miniprogram callFunction 统一化` | 0（本文件 commit）|
| 3 | Task 1 | `feat(miniprogram): CP-7-A — cloud-call.ts 升级 (typed Promise<T> + ApiError + 401 refresh + inflight share)` | +10 cloud-call |
| 4 | Task 2+3 | `refactor(miniprogram): CP-7-A — lib/api.ts 重写 + lib/auth.ts 清理 + 测试 mock 改造 + dead code 删` | 0（迁移后净调整）|
| 5 | docs | `docs: CP-7-A — state + README + setup.md` | 0 |
| merge | `worktree-cp7-a-cloudcall → master --no-ff` | — |

**共 6 commit + 1 merge = 7 总**

---

## 工作流

- worktree 隔离 + 1 包改动（仅 miniprogram）
- TDD 严格走：10 测试先写（RED）→ 升级 cloud-call.ts（GREEN）→ 改 lib/api.ts（保持现有测试绿）→ REFACTOR
- 主线程直接做（参考 M6.3c/d/4/9/10 经验，~2-4h 总耗时）
- 每个 Task 完跑 `pnpm -F miniprogram test` 验证

---

## 累计测试 + 文件清单

### 仓库测试累计（CP-7-A 后）

| 包 | 现有 | CP-7-A | 累计 |
|---|---|---|---|
| shared | 47 | 0 | 47 |
| api | 23 | 0 | 23 |
| miniprogram | 30 | 净调整（cloud-call +10 / api.test 改 mock / auth.test 改 mock）| **33-35**（待 Task 3 完确认）|
| admin | 24 | 0 | 24 |
| crawler | 19 | 0 | 19 |
| **累计** | **143** | 净调整（+10 cloud-call / -7 fetchWithRefresh+inflight 迁出）| **153-155** |

注：M6.3a + M6.4 共 7 个 fetchWithRefresh/inflight 测试迁到 cloud-call.test.ts；api.test.ts 14 caller 测试保留。净增 ≈ +3。

### 文件清单（CP-7-A 后）

| 类型 | 文件 | 状态 |
|---|---|---|
| 改代码 | `apps/miniprogram/lib/cloud-call.ts` | 73 → ~150 行（重写 cloudCall + 加 ApiError + 加 inflight）|
| 改代码 | `apps/miniprogram/lib/api.ts` | 262 → ~140 行（6 caller 重写 + 删 dead code）|
| 改代码 | `apps/miniprogram/lib/auth.ts` | 69 → ~50 行（删旧参数 + 简化 ensureJwt）|
| 新测试 | `apps/miniprogram/test/cloud-call.test.ts` | NEW（~250 行，10 用例）|
| 改测试 | `apps/miniprogram/test/api.test.ts` | 568 → ~280 行（14 caller 测试改 mock + 删 fetchWithRefresh 7 用例）|
| 改测试 | `apps/miniprogram/test/auth.test.ts` | 104 → ~80 行（5 用例改 mock + 删 HTTP fetchImpl 分支测试）|
| 新文档 | `docs/cp7-cloud-call-setup.md` | NEW（~120 行）|
| 新文档 | `docs/superpowers/specs/2026-06-18-cp7-a-cloudcall-unification-design.md` | NEW（已 commit）|
| 新文档 | `docs/superpowers/plans/2026-06-18-cp7-a-cloudcall-unification.md` | NEW（本文件）|
| 新文档 | `docs/superpowers/state-cp7-a.md` | NEW（~200 行）|
| 改文档 | `README.md` | +CP-7-A 节 |

**共 3 改代码 + 1 新测试 + 2 改测试 + 4 文档 = 10 总**

---

## 附录 A：Plan 与 Spec 关键差异

| # | Spec | Plan 调整 | 理由 |
|---|---|---|---|
| P-1 | 新建 `lib/cloud-call.ts` | **升级**现有 | P3.9 已建；`__setCloudCallImpl` 已存在；改名会破坏现有 auth.test.ts |
| P-2 | 5 caller | **6 caller**（+ updateNickname）| M6.3c 后多 1 个；spec 漏数 |
| P-3 | `__ensureJwtForTesting` rename export | **不 rename** | M6.2 已 work；callFunction 模式不需要 `fetchImpl` 参数，cleanup 是删参数不是 rename |
| P-4 | 测试 30 + 10 = 40 | 测试数净调整（+3）| M6.3a + M6.4 共 7 fetchWithRefresh/inflight 测试迁到 cloud-call.test.ts；api.test.ts 14 caller 测试保留 |
| P-5 | `lib/auth.ts` ensureJwt 改 private | **保持 public export** | M6.2 已 work；caller 可能直接调（不应再调但保留避免破坏）；M6.2 → CP-7-A 行为不变 |