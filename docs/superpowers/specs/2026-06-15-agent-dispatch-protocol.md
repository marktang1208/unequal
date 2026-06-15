# Agent Dispatch Protocol

- **状态**：草稿，待用户复核
- **日期**：2026-06-15
- **目的**：定义 orchestrator 派子 agent 跑长任务时的强制约束。源自 M0+M1 收尾阶段 Miniflare 子 agent 静默 1h 50m 被用户手动 interrupt 的事故复盘。
- **适用**：所有派子 agent 跑"预计 >5 分钟"任务的场景（M2+ 必然大量使用）

---

## 0. 核心问题

子 agent 协议默认"派出去就等回话"。但回话可能几小时不回，期间用户看到的"我什么都不说" = 视为卡死。M0+M1 收尾时的实际事故：

```
10:20:16  orchestrator dispatch Agent(Miniflare test skeleton)
            ... 1 小时 50 分钟 0 动作 ...
12:10:26  user 手动 interrupt（"[Request interrupted by user for tool use]"）
12:10:26  user 跑 /compact
12:11:40  user: "跑了快两个小时了，是卡在哪里吗"
```

transcript 里 Agent 的 tool_result 只有 42 字节"interrupted" — 意味着 agent 当时在跑某个工具调用，**不是跑完了**，是被强制打断的。事故前 orchestrator 还误把"磁盘文件存在"当"子 agent 已完成"，没验证就 commit+merge。

---

## 1. 四条强制规则

### 规则 1：长 install 在主线程跑

**What**：任何预计 >60s 的 install/compile（`pnpm install`、`pnpm add <native-dep>`、workerd 下载、chromium 下载、prisma generate 等）在 **orchestrator 主线程** 跑，失败立即可见。子 agent 只接"依赖已就绪、写代码+测试+验证"的部分。

**Why**：原生依赖（workerd、sharp、prisma engines 等）的下载/编译/链接可能 5-15 分钟，且 install 步骤通常无可观测的中间 progress。把它放给子 agent 等于"黑盒运行 10 分钟"。

**How to apply**：dispatch 子 agent 前，orchestrator 先在主线程跑 `pnpm install` / `pnpm add`，看到"Done"或具体 lockfile diff 再 dispatch。子 agent prompt 里明确写"依赖已安装，请勿重跑 install"。

### 规则 2：子 agent 必须写 heartbeat

**What**：派子 agent 时 prompt 强制要求每 2-5 分钟往 `.agent-heartbeat` 写一行，包含 `(timestamp, current_step, completed_steps, next_step)`。orchestrator 可用 `tail -f` 监听。超 10 分钟无更新 = 视为卡死。

**Why**：无心跳 = 无 progress 信号 = 用户看不到 agent 在做什么 = 用户只能假设"卡住"并手动干预。

**How to apply**：子 agent prompt 模板加一段：

```text
你必须每 2-5 分钟往工作区根目录的 `.agent-heartbeat` 写一行，格式：
  ISO_TIMESTAMP | current_step=<name> | done=<a,b,c> | next=<d>
如果任何步骤超过 5 分钟没动，先写一行 "STALLED: <step>" 再继续。
不要静默执行超过 10 分钟。
```

orchestrator dispatch 后 5 分钟起，定期 `tail .agent-heartbeat` 看 progress。

### 规则 3：子 agent 自主 abort 阈值

**What**：子 agent prompt 写明自主 abort 条件，触达即 stop 并报告，不等用户 interrupt：

- 任何 install 步骤 > 5 分钟无输出 → stop，报告"install stuck at <step>"
- 任何测试 > 2 分钟无输出（且无 progress bar）→ stop，报告"test hang"
- 等待外部资源（API 调用、文件锁、workerd 启动）> 1 分钟 → stop，报告"resource wait"
- 任何命令连续 3 次同错 → stop，报告"反复失败"

**Why**：子 agent 比用户更清楚"我在做什么"。给它自主 abort 比"让用户等 2 小时再 interrupt"高效得多。

**How to apply**：子 agent prompt 模板加一段：

```text
自主 stop 条件（任一触达即 stop + 报告，不要继续）：
- install 步骤超过 5 分钟无 stdout
- 测试运行超过 2 分钟无 stdout（且无进度条）
- 外部资源等待超过 1 分钟
- 同一命令连续 3 次失败
报告格式："ABORTED: <原因>. partial work: <列出已落盘文件>"
```

### 规则 4：收尾阶段独立验证

**What**：子 agent 报告 DONE 后，orchestrator **不能直接信**。必须独立跑：

- `pnpm test`（在主进程跑，不信 agent 报告的数字）
- `pnpm typecheck`
- `pnpm build` 或 `wrangler deploy --dry-run`

**Why**：文件存在 ≠ 子 agent 完成。半成品文件可能存在但 work 不完整。M0+M1 事故中 orchestrator 看到 `integration.test.ts` 存在就推断"agent 跑完"，但实际是 agent 写到一半被 interrupt，文件是部分状态。

**How to apply**：

- 子 agent 报告 DONE → orchestrator 不进 review/commit 流程
- orchestrator 先独立跑上面 3 条命令，全绿才进 review
- 任意一条红 → 把子 agent 的"半成品"作为起点重新 dispatch，不要 reset（保留有效 work）

---

## 2. 子 agent prompt 模板（v1）

所有派子 agent 的 prompt 应至少包含以下 3 段（顺序可调）：

```text
## 1) 任务上下文
- 当前 HEAD: <commit SHA + 一句话总结>
- 你的工作目录: <绝对路径>
- 你不能改的边界: <不要碰的目录/分支/文件>
- 任务文本（从 plan 复制完整）: <粘贴>

## 2) 约束
- 依赖已就绪：<列出已 install 的包>。不要重跑 install。
- mock-first：<哪些外部服务必须 mock>
- TDD 顺序：先写 test 看红，再写实现看绿，最后 refactor
- 完成定义（Done）：<3-5 条可验证的 pass 条件>

## 3) 运行协议
- 每 2-5 分钟写一行 .agent-heartbeat，格式 "TS | current=<step> | done=<a,b> | next=<c>"
- 自主 stop 条件（任一触达即 stop + 报告）：
  * install > 5 分钟无 stdout
  * 测试 > 2 分钟无 stdout
  * 外部资源等待 > 1 分钟
  * 同命令连续 3 次失败
- 报告 DONE 前必须自己跑完 pnpm test + pnpm typecheck + pnpm build，全绿才能 DONE
- 报告 DONE_WITH_CONCERNS 时把顾虑列清楚，别藏
```

---

## 3. orchestrator dispatch checklist

每次 dispatch 子 agent 前，orchestrator 自检：

- [ ] 规则 1：长 install 已在我手里跑完（不是 agent 跑）
- [ ] 规则 2：prompt 含 heartbeat 段
- [ ] 规则 3：prompt 含自主 abort 段
- [ ] 规则 4：我准备在 agent 报告后独立跑 test/typecheck/build
- [ ] 子 agent 工作目录明确（绝对路径，不是相对路径）
- [ ] 子 agent 不能改的边界明确（master 分支、其他 worktree、用户未授权目录）

---

## 4. 复盘

| 事故 | 时间 | 违反规则 | 教训 |
|---|---|---|---|
| Miniflare agent 静默 1h50m | 2026-06-15 | 规则 1（install 没在主线程）+ 规则 2（无 heartbeat）+ 规则 3（无 abort）+ 规则 4（信"文件存在"） | 4 条规则同时违反。任一条遵守都能避免 |

后续 M2+ 每条 dispatch 都按本协议走，事故记录追加到本表。
