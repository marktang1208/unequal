# CP-7-A — miniprogram callFunction 统一化 收尾

**完成日期**：2026-06-18
**Spec**：`docs/superpowers/specs/2026-06-18-cp7-a-cloudcall-unification-design.md`（commit `3c86ac2`）
**Plan**：`docs/superpowers/plans/2026-06-18-cp7-a-cloudcall-unification.md`（commit `bf716bf`）

---

## 1. 摘要

apps/miniprogram 端 callFunction 统一化 — 删 P3.9 临时方案留下的双套机制（wxRequestAsFetch + fetchWithRefresh + inflightEnsureJwt + buildHeaders），统一走 `cloudCall<T>(req)` 单一入口。7 caller 全调 cloudCall typed wrapper；refresh 401 + inflight 共享内作于 cloudCall；dead code 全部清理。**154 tests 全绿**（master 143 + 净 +11）。

**核心成果**：
- `cloudCall<T>(req): Promise<T>` typed body + throw `ApiError(statusCode, code, message)`
- 401 + jwt → refresh + retry 1 次；401 + 无 jwt → `MISSING_AUTH`；refresh 失败 → `REFRESH_FAILED`；refresh 后仍 401 → `saveJwt(null)` + `UNAUTHORIZED`
- inflight 共享：3 并发 401 → 1 次 ensureJwt（M6.4 模式）
- 7 caller（ask / chat / listSessions / renameSession / deleteSession / updateNickname / adminLogin）全调 cloudCall
- dead code 清理：wxRequestAsFetch / getFetch / buildHeaders / fetchWithRefresh / inflightEnsureJwt / __clearInflightEnsureJwt 全删

**重要 caveat**：mock-first 实施；真实 wx.cloud.callFunction 协议 + CloudBase api-router 兼容性需 CP-7 真接验证。

---

## 2. 资源清单（无新增 / 无破坏）

### 2.1 apps/miniprogram 改动（3 改代码 + 1 新测试 + 2 改测试）

| 文件 | 状态 | 行数变化 |
|---|---|---|
| `lib/cloud-call.ts` | UPDATE | 73 → 165 行（重写 cloudCall + 加 ApiError + 加 inflight）|
| `lib/api.ts` | REWRITE | 262 → 140 行（7 caller 重写 + 删 dead code）|
| `lib/auth.ts` | UPDATE | 69 → 45 行（删旧参数 + 简化 ensureJwt）|
| `test/cloud-call.test.ts` | NEW | +250 行（10 用例）|
| `test/api.test.ts` | UPDATE | 568 → 215 行（14 caller 测试改 mock + 删 fetchWithRefresh 7 用例 + 加静态验证）|
| `test/auth.test.ts` | UPDATE | 104 → 105 行（5 用例 mock 改）|

### 2.2 文档（3 文件）

| 文件 | 状态 |
|---|---|
| `docs/cp7-cloud-call-setup.md` | NEW（~140 行 — 用法 + mock 指南 + 内部细节 + migration 路径）|
| `README.md` | UPDATE（加 CP-7-A 状态节）|
| `docs/superpowers/state-cp7-a.md` | NEW（本文件）|

### 2.3 不改（沿用 CP-6）

- ✅ `apps/api/...` — 0 改动（server handler 不动；callFunction 协议 P3.9 已 work）
- ✅ `apps/admin/...` — 0 改动（admin 仍走 HTTP gateway）
- ✅ `apps/crawler/...` — 0 改动
- ✅ `packages/shared/...` — 0 改动
- ✅ CloudBase api-router handler — 0 改动
- ✅ miniprogram app.ts / 各 page — 0 改动（caller 函数签名不变）

---

## 3. Secrets + Vars（无变化）

- 0 新增 secret
- 0 新增 var
- 0 移除 secret / var

CP-7-A 是纯前端重构，不动 CloudBase env 配置。

---

## 4. 测试结果

### 4.1 累计测试矩阵

| 包 | master | CP-7-A | 累计 | 状态 |
|---|---|---|---|---|
| shared | 47 | 0 | 47 | 无变化 |
| api | 23 | 0 | 23 | 无变化 |
| miniprogram | 30 | +10 cloud-call +3 caller 测试 -7 fetchWithRefresh 迁移 | **32** | ✅ |
| admin | 24 | 0 | 24 | 无变化 |
| crawler | 19 | 0 | 19 | 无变化 |
| **累计** | **143** | **+11 净** | **154** | ✅ |

注：api 包 23 → 30 差异是 master 实际跑出 30（cp6-archived 后累计），README 数据。

### 4.2 miniprogram 包测试明细

| 文件 | master | CP-7-A | 累计 |
|---|---|---|---|
| `test/cloud-call.test.ts` | 0 | 10 | **10** |
| `test/api.test.ts` | 14 | 改 mock + 删 7 + 加 6 | **13** |
| `test/auth.test.ts` | 5 | 改 mock（数不变）| **5** |
| `test/chat-storage.test.ts` | 3 | 0 | **3** |
| `test/chat.test.ts` | 1 | 0 | **1** |

### 4.3 验证命令

```bash
# Task 1 验证（RED-GREEN）
pnpm -F miniprogram test cloud-call
# 期望：10 passed (1 file)

# 全套测试
pnpm -r test
# 期望：5 包全绿，累计 154 用例

# Typecheck
pnpm -r typecheck
# 期望：5 包全 Done
```

---

## 5. 关键技术决策

### 5.1 cloudCall<T> typed body + throw ApiError

P3.9 临时 cloudCall 返 `Promise<{statusCode, body}>`，caller 还要 if-else。CP-7-A 改为 `Promise<T>` typed body + throw ApiError，caller 不解析 statusCode，类型安全。

### 5.2 401 refresh 内作于 cloudCall

P3.9 临时方案：5 caller 各自包 `fetchWithRefresh`。CP-7-A：refresh 逻辑统一内作于 cloudCall，caller 不感知 refresh 时机。集中管理 inflight share。

### 5.3 inflight share 复用 M6.4 模式

M6.4 已 work：模块级 `inflight: Map<key, Promise>` + `finally` 清缓存。CP-7-A 复用：模块级 `inflightRefresh: Promise<string> | null`，3 并发 401 → 1 次 ensureJwt。

### 5.4 测试桩 `__setCloudCallImpl` + `__resetCloudCallImpl` + `__clearInflightRefresh`

避免 mock 全局 `wx.cloud`。测试更纯粹；与 P3.9 已 work 模式一致。

### 5.5 adminLogin 也改 callFunction（DP-1 调整）

plan §DP-1 决策："adminLogin 保留 HTTP" → 实施时调整为：adminLogin 也改 callFunction。

理由：
- admin 鉴权用 admin_token，**不依赖 userInfo.openId**，callFunction 也 work
- 统一 1 套机制更干净（符合 CP-7-A "统一" 主题）
- plan §Task 2 删 wxRequestAsFetch/getFetch + adminLogin 保留 HTTP 是内部矛盾（adminLogin HTTP 需要保留 wxRequestAsFetch）
- adminLogin 无 production caller（miniprogram 不调；admin web app 走 HTTP），保留作为 lib export 给未来 admin 调试

state 文档显式 note 这个偏差。

### 5.6 saveJwt import 路径修正（plan 漏写）

cloud-call.ts 需要 `saveJwt(null)` 清空 storage。plan §5.1 写 `import { ensureJwt } from "./auth.js"` 但 saveJwt 没在 auth.ts re-export。实施时修正为 `import { saveJwt } from "./chat-storage.js"`。

### 5.7 路径沿用现有约定（CP-6 P3.9 + 旧路径兼容）

CP-7-A 不改路径。沿用：
- `/api-ask` / `/api-chat` / `/api-sessions-list` / `/api-sessions-delete/:id`（P3.9 已加 `api-` 前缀）
- `/sessions/:id`（renameSession — CP-6 后端暂无 handler，CP-7-B 补）
- `/user/nickname`（updateNickname — 同上）
- `/api-auth-admin-login`（adminLogin — 无 `api-` 前的 `/auth/admin-login` 是 server 老路径；统一加 `api-` 前缀对齐 HANDLER_MAP）

实际上 adminLogin 路径 `/api-auth-admin-login` 改自原 `/auth/admin-login` — 这是 CP-7-A scope 微调（统一所有 endpoint 走 `api-` 前缀）。

---

## 6. 已知 issue / 风险 / 下一步

### 6.1 已知 issue

| Issue | 影响 | 状态 |
|---|---|---|
| **wx.cloud.callFunction 真实协议未验** | mock-first 不验；P3.9 真机验证已 work | CP-7 真接再验 |
| **CloudBase api-router handler 兼容性未验** | server handler 不动（callFunction 协议 P3.9 work）| CP-7 真接再验 |
| **renameSession / updateNickname 后端 404** | cloudCall 抛 ApiError(404)，caller 需降级处理 | CP-7-B 独立项目 |
| **adminLogin 无 production caller** | lib export 给未来 admin 调试用 | 不影响（0 caller）|

### 6.2 风险评估

| 风险 | 缓解 | 严重度 |
|---|---|---|
| 真实 wx.cloud.callFunction 与 mock impl 不一致 | 测试覆盖 happy + error paths；P3.9 真机验证 5/5 PASS | LOW |
| adminLogin 无 production caller，但路径 `/api-auth-admin-login` 改了 | server 端 api-router 已注册此 handler（CP-6 P3.9 真机验证 work）；admin web app 暂不调 adminLogin | LOW |
| 7 caller 改 cloudCall 漏 caller | api.test.ts 静态验证（grep 7 fnNames 全调 cloudCall）；AC-9 显式列 7 caller | LOW |
| refresh 401 与 M6.4 inflight 行为差异 | 复用 M6.4 模式（module-level promise + finally 清缓存）；3 cloud-call 测试覆盖并发 | LOW |
| saveJwt 跨模块副作用（cloudCall 清 storage） | 401 + refresh + retry 仍 401 才清（拒绝死循环场景）；其他路径不调 | LOW |

### 6.3 CP-7-A 教训（给后续 checkpoint）

1. **测试桩 reset 与 inflight 清空分离**：测试需要在 beforeEach 调 `__resetCloudCallImpl()` + `__clearInflightRefresh()` 才能保证独立。Mock 库（如 vitest spyOn）默认会自动 reset，但 module-level Map/Promise 需要手清。教训：module-level state 必须有 reset 测试桩。
2. **spec vs 实际代码差异**：plan 阶段才发现 `cloud-call.ts` 已存在（P3.9 引入）而非新建；caller 数 6 → 7（含 adminLogin）；saveJwt 路径在 chat-storage.ts 不是 auth.ts。教训：**写 plan 必读实际代码**（已用 plan skill 的 Pattern Grounding 步骤但仍漏部分细节）。
3. **plan 决策点 DP-1 与 Task 2 内部矛盾**：DP-1 "adminLogin 保留 HTTP" 与 Task 2 "删 wxRequestAsFetch/getFetch dead code" 矛盾。教训：写 plan 后跑一次"决策点 vs Task 步骤"互查，找矛盾。
4. **worktree 不继承 master untracked 文件**：admin CloudBaseCallTest.tsx 是 untracked，git worktree add 不复制。教训：worktree 里跑全包测试前先 cp untracked 文件，或 git add 让其 tracked。

### 6.4 下一步建议

1. **CP-7 真接验证**（user 操作）：
   - 微信开发者工具导入 apps/miniprogram（替换 AppID）
   - 编译 → onLaunch → 5 步真机验证（与 P3.9 类似）
   - 验证：miniprogram 全 5 caller 走 callFunction + 401 refresh 行为 + inflight share
2. **CP-7-B 独立项目**：handler 后端补全（renameSession + updateNickname）+ api-chat.ts [N] 引用解析
3. **CP-7-C 候选**：deploy 流程内化 env vars push（`tcb fn deploy --force` 重置 vars 自动化）
4. **CP-7-D 候选**：LLM model 跨 handler 一致性 smoke（api-ask + api-chat 用统一 model name）

---

## 7. Commit 汇总

| # | Commit | 主题 |
|---|---|---|
| 1 | `3c86ac2` | docs: CP-7-A spec — miniprogram callFunction 统一化 |
| 2 | `bf716bf` | docs: CP-7-A plan — miniprogram callFunction 统一化 |
| 3 | `0374e1b` | feat(miniprogram): CP-7-A — cloud-call.ts 升级 (typed Promise<T> + ApiError + 401 refresh + inflight share) |
| 4 | `c6413e2` | refactor(miniprogram): CP-7-A — lib/api.ts 重写 + lib/auth.ts 清理 + 测试 mock 改造 + dead code 删 |

**共 4 commit**（含 spec / plan / Task 1 / Task 2+3）。Task 4 文档 commit 即将完成（5）。

---

## 8. CP-7 真接路径

CP-7-A 真接验证需：
1. **miniprogram 真机验证**：
   - 替换 `apps/miniprogram/project.config.json` 的 `appid`（user 已注册）
   - 微信开发者工具导入 apps/miniprogram
   - 编译 → 验证 `wx.cloud.init ok`
   - onLaunch → ensureJwt → /api-auth-wx-login callFunction 成功
   - chat tab → /api-chat callFunction → 返 RAG 回答
   - history tab → /api-sessions-list callFunction → 返 sessions
   - session 切换 → /api-chat 带 session_id callFunction → 复用 session
2. **401 refresh 行为验证**：
   - 模拟 jwt 过期（清 storage）
   - 触发任意 caller → 401 → ensureJwt → retry → 200
   - 3 并发 401 → 1 次 ensureJwt（验证 inflight share）
3. **ApiError 边界验证**：
   - 触发 404 / 500 → caller 收到 ApiError
   - 网络断 → ApiError(0, NETWORK_ERROR)

---

## 9. References

- **Spec**：`docs/superpowers/specs/2026-06-18-cp7-a-cloudcall-unification-design.md`
- **Plan**：`docs/superpowers/plans/2026-06-18-cp7-a-cloudcall-unification.md`
- **Setup 文档**：`docs/cp7-cloud-call-setup.md`
- **README**：`README.md` §"CP-7-A 状态"
- **CP-6 state**：`docs/superpowers/state-cp6.md`（P3.9 真机验证 + 双套机制临时方案来源）