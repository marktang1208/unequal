# M0+M1 Execution Protocol

- **状态**：草稿，待用户复核
- **日期**：2026-06-14
- **目的**：定义 unequal 项目 M0+M1 阶段的**执行规约**（不是设计，也不是实现计划）
- **上层文档**：
  - 顶层设计 spec：`docs/superpowers/specs/2026-06-14-unequal-top-level-design.md`
  - 详细实现 plan：`docs/archive/plans/2026-06-14-m0-m1-monorepo-knowledge-base.md`（12 tasks, TDD-driven）

---

## 0. 项目当前状态

- ✅ 顶层架构设计已写完（spec）
- ✅ M0+M1 详细实施计划已写完（12 tasks / 2734 行 / TDD-driven）
- ⏳ 零代码，未 scaffold
- ⏳ 零外部凭证已配置（MiniMax API key 未填入 wrangler secret；wrangler 未 login）

---

## 1. 目标与完成定义

**目标**：在 m0-m1 分支上完成 plan 全部 12 个 task，本地可跑通端到端最小闭环。

**完成定义（Done）**：

- CP-4 全部通过
- 在 worktree 里执行 `pnpm dev:api & pnpm dev:admin` 后，admin 网页能上传一份 PDF，30 秒内 `/search` 接口命中该 PDF 内容并按 `trust_level` 加权排序
- README 更新本地开发步骤
- m0-m1 分支上有 12 个 task commit（每 task 一 commit）；4 个 CP 边界可在 review 时决定 squash 或保留
- **不要求**：真实 MiniMax API 联通、Cloudflare 真资源 deploy、生产 HTTPS 域名

**不在范围（M0+M1 明确不做）**：

- LLM chat completion（M2）
- 反幻觉双层验证、医疗免责声明（M2）
- 微信小程序（M3）
- 网页/小红书/公众号抓取（M4-M5）
- 多用户真鉴权、多轮会话（M6）
- 定时抓取调度、信源自动评级

---

## 2. 工作区设置

| 项 | 值 |
|---|---|
| 工具 | `superpowers:using-git-worktrees` |
| 路径 | `/Users/Mark/cc_project/unequal/.claude/worktrees/m0-m1` |
| 分支名 | `m0-m1`（基于 `master` 当前 HEAD） |
| 是否进 master | 否，整个执行在 worktree 内 |
| 结束处理 | 完成后用 `superpowers:finishing-a-development-branch` 决定 merge/PR/清理 |

**理由**：master 是干净的 spec 仓库（最近 4 个 commit 全是 docs）。12 task 涉及 ~50 个新文件 + `pnpm install`（数百 MB 依赖），worktree 隔离最稳。

---

## 3. 执行主体

**主线 skill**：`superpowers:subagent-driven-development`

**流程**：

1. 在 worktree 里读 plan
2. 按 plan 顺序跑 task 1 → 12
3. 每 task 起一个 subagent，subagent 读 plan 段 → 写代码 → 跑 verify → 自检 → 报告
4. 真人环节（wrangler login、填 secret、问 account_id）停下来问用户，**不**让 subagent 自动跑
5. 大节点触发 `superpowers:requesting-code-review` 做评审

**辅助 skill**（按需调用）：

- `superpowers:test-driven-development`：每 task 写测试 / 跑测试
- `superpowers:verification-before-completion`：每 task 完跑 verify 才能进下一个
- `superpowers:using-git-worktrees`：开 worktree 本身
- `superpowers:requesting-code-review`：4 个 CP 边界 review
- `superpowers:finishing-a-development-branch`：CP-4 完后决定收尾方式

---

## 4. 四个 Checkpoint

| # | 名称 | 包含的 plan task | 验收命令 | 真人参与 |
|---|---|---|---|---|
| **CP-1** | M0 脚手架 | Task 1 + Task 2 + Task 3 | `pnpm install` + `pnpm -r typecheck` + `pnpm -r test` + `wrangler d1 migrations list unequal-db --local` 成功 | 是：wrangler login、account_id、Vectorize 维度（写 placeholder 也可） |
| **CP-2** | M1 shared 库 | Task 4 + Task 5 + Task 6 + Task 7 | `pnpm -F shared test` 全绿 + `pnpm -F shared typecheck` 通 | 否 |
| **CP-3** | M1 API + admin | Task 8 + Task 9 + Task 10 + Task 11 | 本地 `wrangler dev` + `pnpm dev:admin` 同时跑：浏览器打开 admin 上传一个测试 PDF/TXT → /search 命中 | 否 |
| **CP-4** | E2E 验证 | Task 12 | 端到端走一遍：上传 → 摄入 → 检索命中；README 更新；4 个 CP 边界 commit + 12 task commit 齐全 | 否 |

**Checkpoint 行为**：

- 每个 CP 完成后停下来给用户看 diff / 跑验收命令
- 用户验收通过 → 进下一个 CP
- 任何 CP 出问题 → 停下来 debug，**不**跳过

---

## 5. Mock / 凭证策略（关键解耦点）

**原则**：12 task 不被任何外部凭证阻塞。拿到凭证后改 1-2 行配置切真。

### 5.1 MiniMax API

| 组件 | 策略 |
|---|---|
| `packages/shared/embedding.ts` | 写一个 `EmbeddingProvider` 接口，两个实现：`FakeEmbedding`（输出确定性伪向量，1024 维）+ `MinimaxEmbedding`（真 API 调用，代码写完但 TDD 用 mock fetch 跑） |
| `apps/api/wrangler.jsonc` | 加 `EMBEDDING_PROVIDER` 环境变量，默认 `fake`；`minimax` 切真 |
| `Task 6` 验收 | `pnpm -F shared test` 全绿；不调真 API |
| `Task 9` 验收 | ingestion 默认走 fake embedding；不调真 API |
| 切真 API 时机 | CP-4 验收完，用户给 key 后跑一次集成测试 + 一个补 commit |

### 5.2 Cloudflare 资源

| 资源 | 策略 |
|---|---|
| D1 | `wrangler dev` 本地模式自动用 SQLite 副本 |
| Vectorize | `wrangler dev` 通过 miniflare 模拟；维度写 1024 placeholder |
| R2 | `wrangler dev` 本地文件模拟 |
| 真实 deploy | **M0+M1 不做**；留 M2 起步时 |

### 5.3 Cloudflare 凭证

- `account_id` / `database_id` / `vectorize_index_id` 在 `wrangler.jsonc` 写 placeholder（fake 模式可跑）
- `wrangler login` 在 CP-4 验收完做一次（为 M2 真 deploy 准备），**M0+M1 内不强求**

### 5.4 MiniMax key

- CP-4 之前：不填 secret
- CP-4 之后：用户给 key → wrangler secret put MINIMAX_API_KEY → 切 EMBEDDING_PROVIDER=minimax → 跑一次集成测试

---

## 6. Commit 粒度

| Commit 类型 | 数量 | message 格式 |
|---|---|---|
| Task commit | 12 | `M0+M1 task N: <task title>` |
| CP 边界 tag | 0-4 | `CP-X: <CP name> complete`（可选 squash；review 后决定） |
| 集成测试补 commit | 0-1 | `M0+M1: wire real MiniMax API + integration test`（用户给 key 后） |

**约束**：

- 每 task 完做一次 commit（不要攒几个 task 一起 commit）
- commit message 标 task 编号便于回溯 plan
- CP 边界 commit 由主流程（不是 subagent）做，方便 review

---

## 7. 每 Task 必跑验证

每个 task 完成后、commit 之前跑：

1. `pnpm -F <pkg> typecheck`（严格模式 + noUncheckedIndexedAccess）
2. `pnpm -F <pkg> test`（Vitest）
3. 改 `packages/shared` 后：`pnpm -r test`（api/admin 可能受影响）
4. plan 里该 task 的 verify 步骤（plan 文档有具体命令）

`superpowers:verification-before-completion` 在以下时机必跑：
- 每 task 完
- 每个 CP 完

---

## 8. 风险兜底

| 风险 | 兜底 |
|---|---|
| Subagent 跑偏 / 输出过长 | 限定 subagent 只读 plan 对应 task 段；不读全 plan |
| pnpm install 失败 | 停下来问用户，不绕过；可能是网络/Node 版本问题 |
| Vitest 在 Workers 环境跑不通 | 用 `@cloudflare/vitest-pool-workers` 跑 Workers 代码；普通 unit test 走默认 node pool |
| `wrangler dev` 跑不起来 | 先 `wrangler dev --dry-run` 通过；最小化到能启动；wrangler.jsonc 绑定类型用 `@cloudflare/workers-types` |
| admin Vite 与 api 跨域 | `apps/admin/vite.config.ts` 配 server.proxy → `http://localhost:8787`（wrangler dev 默认端口） |
| Vectorize 维度不匹配 | 全部 fake embedding 输出统一 1024 维；真 embedding 拿到后改一个常量 |
| 测试夹具污染 | 每个 test 用 tmp 目录；mock 全部 reset |

---

## 9. 依赖与基础设施清单

执行前确认（不需要立刻拿到，但要知道缺什么）：

- [ ] Node.js >= 20（系统已装）
- [ ] pnpm >= 9（执行时 `corepack enable` 或 `npm i -g pnpm`）
- [ ] Wrangler（CP-2 前 `pnpm -F api exec wrangler --version` 通过）
- [ ] Cloudflare 账号（CP-4 验收后做 wrangler login）
- [ ] MiniMax API key（CP-4 验收后用户给）
- [ ] MiniMax embedding 模型名 + 维度（用户在 platform.MiniMax.io 确认）

---

## 10. 完成态示例

CP-4 全部通过后，工作区状态：

```
$ cd /Users/Mark/cc_project/unequal/.claude/worktrees/m0-m1
$ pnpm install
$ pnpm -r typecheck    # 全绿
$ pnpm -r test         # 全绿
$ pnpm dev:api &       # 启动 wrangler dev on :8787
$ pnpm dev:admin &     # 启动 Vite on :5173
# 浏览器打开 :5173
# 上传一个 PDF
# 30 秒内 /search 命中
```

---

## 11. 退出条件

CP-4 验收通过后，调用 `superpowers:finishing-a-development-branch`，给用户 4 个选择：

1. 合并 m0-m1 → master（开始 M2）
2. 开 PR（如果想 review 后再合）
3. 保留分支（继续 M2 时再处理）
4. 丢弃 worktree（实验性质，跑完即弃）

**默认建议**：选 1（合并到 master），因为 m0-m1 是有完整 verify 的可工作状态。

---

## 附录 A：本规约与既有文档的关系

```
构想.md                            (顶层架构设计，中文)
  └─ 被合并入 ↓
docs/superpowers/specs/
  └─ 2026-06-14-unequal-top-level-design.md    (架构 spec)
       └─ 上游 ↓
docs/archive/plans/
  └─ 2026-06-14-m0-m1-monorepo-knowledge-base.md  (实施 plan, 12 tasks)
       └─ 上游 ↓
docs/superpowers/specs/
  └─ 2026-06-14-m0-m1-execution-protocol.md    (本文件：执行规约)
       └─ 直接驱动 ↓
       superpowers:subagent-driven-development
       （实际执行 12 task）
```

**重要**：本文件**不**重写 plan 内容，只补充 plan 没覆盖的"怎么执行"维度（worktree / checkpoint / mock / commit / 风险）。plan 仍是 task 步骤的 single source of truth。

---

## 附录 B：决策记录

| 决策点 | 选择 | 备注 |
|---|---|---|
| 执行策略 | subagent-driven-development | plan 自己推荐 |
| 工作区 | worktree m0-m1 | 隔离 master |
| Checkpoint 数量 | 4 个 | M0 / M1-shared / M1-API+admin / E2E |
| Mock 策略 | mock-first + 后续补真 | 不被凭证阻塞 |
| Cloudflare deploy | M0+M1 不做 | 留 M2 |
| MiniMax 真 API | CP-4 验收后再切 | 不阻塞 12 task |
| Commit 粒度 | 每 task 一 commit + CP 边界 tag | 便于回溯 |
| 完成态标准 | 本地可跑通端到端最小闭环 | 不要求真 deploy |
