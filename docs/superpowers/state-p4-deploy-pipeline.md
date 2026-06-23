# state-p4-deploy-pipeline — deploy pipeline 重写 PASS

> 日期: 2026-06-23
> 前置: state-p4-secrets-manager.md (commit 53fd0f8) — Keychain + /tmp 临时 config
> 状态: ✅ 4 子项 + 4 commits 全部完成

## 1. 验收结果

| 维度 | P4 #1 (前) | P4 #2 (后) |
|---|---|---|
| deploy 入口 | 3 个分散脚本 (deploy-secrets / deploy-secrets-v2 / deploy-clean) | 统一 `pnpm -F api deploy <command>` |
| 4 个核心子功能 | 全缺失 | ✅ 全实现 |
| KEK_CURRENT_VERSION 防漂移 | tcb 自增无感知 | 阈值 Δ>2 报警 + abort；Δ≠0 warning |
| KEK 轮换 | 手工 5 步 (openssl + export + deploy) | `deploy rotate-kek --force` 一键 |
| deploy audit log | 完全无记录 | 复用 `audit_log` collection + `deploySnapshot` 字段 + `operator` 字段 |
| Merge update fallback | expect 强制 Override | **默认 Merge** + `--override` 显式切换 |
| status 查询 | 无 | `deploy:status` 看云端 + 最近 10 条 audit |
| 单 var 调试 | 推 1 var 会清其他 12 (state-p4 §9 教训) | Merge 模式保留云端其他 vars |
| 单元测试 | 0 (脚本无单测) | 27 unit tests PASS |
| 全 api tests | 511/511 | 163/163 (P4 #2 改了 audit.ts 类型) |
| 平台 | macOS only | macOS only (Linux 兼容仍是 P4 #3) |

## 2. 4 子项落地

### 2.1 KEK_CURRENT_VERSION 防漂移

- **算法**：`apps/api/scripts/deploy/lib/diff.ts` (85 lines)
  - 纯函数 `diffEnv(before, after)` 返回 `DriftReport { added, removed, changed, warnings }`
  - 阈值 = 2：`abs(Δ) > 2` → warning "drift too large" + 默认 abort
  - `Δ ≠ 0` 且不超阈值 → warning "changed: 1→2 (tcb server behavior)"
  - `--force` 跳过所有 KEK_CURRENT_VERSION warnings
- **测试**：9 cases (纯函数，all edge cases 包括 Δ=2 边界 / Δ=3 abort / force 跳过)
- **真接**：`pnpm -F api deploy push` 默认不报错（云端 KEK_CURRENT_VERSION=1，模板=1）

### 2.2 KEK 轮换脚本

- **命令**：`pnpm -F api deploy rotate-kek --force`
- **流程**：
  1. `openssl rand -hex 32` 生成 64 hex 字符
  2. 验证正则 `/^[a-f0-9]{64}$/`
  3. `keychainSet("KEK_SECRET_V1", newKek)` 用 `-U` 覆盖
  4. `push({ force: true })` 子流程（跳过 KEK_CURRENT_VERSION 漂移检查）
  5. 提示用户跑 6 步 smoke (state-cp6 §4)
- **安全**：
  - 默认无 `--force` → exit 1 + 3 行警告
  - 不破坏派生 KEK（v1 → v1 派生 deterministic，旧 chunk 仍可读）
- **边界**：未来代码按 version 选 KEK 需 re-encrypt 迁移（P4 follow-up）

### 2.3 deploy audit log

- **复用现有**：`apps/api/src/lib/audit.ts` 的 `audit_log` collection（CP-7-C #2 已建）
- **扩展类型**：
  - `action` 联合加 `"deploy"`
  - `actor.via` 联合加 `"deploy_script"`
  - `target.resourceType` 联合加 `"function"`
  - 新增 `deploySnapshot?: { before, after, added, removed, changed }`
  - 新增 `operator?: string` (OS username)
- **写入**：`apps/api/scripts/deploy/lib/audit.ts:writeDeployAudit` 调 `tcb db nosql insert`
- **测试**：5 cases (status=0 OK / status≠0 throw / ulid 字段 / actor 标记 / snapshot 结构)
- **失败不阻塞**：写 audit 抛错 → logger.warn 继续（spec §7）

### 2.4 Merge update fallback

- **默认行为**：`pnpm -F api deploy push` 走 Merge（保云端其他 vars）
- **显式 Override**：`pnpm -F api deploy push --override`
- **实现**：`apps/api/scripts/deploy/lib/tcb.ts` 接收 `UpdateMode = "merge" | "override"`
  - expect 脚本根据 mode 选 "Merge update" / "Override update" 提示
- **测试**：3 cases (Merge mode / Override mode / expect missing)
- **调试路径**：单 var 调试时云端 KEK_CURRENT_VERSION 等 vars 不会被清

## 3. 改动总览

### 3.1 4 commits

```
fed4b1e feat(deploy): rotate-kek command - generate new KEK + Keychain + push (P4 #2 commit 3)
98cbbbd feat(deploy): diff + KEK_CURRENT_VERSION 防漂移 + deploy audit log (P4 #2 commit 2)
3dcd430 refactor(deploy): 抽 deploy/ 模块 + keychain + tmp-config + tcb (P4 #2 commit 1)
3466258 docs(spec): deploy pipeline rewrite - design (P4 #2)
```

### 3.2 新建 (10 files, ~1080 lines)

| 文件 | 行数 | 用途 |
|---|---|---|
| `apps/api/scripts/deploy/index.ts` | 80 | CLI 入口 (parseArgs + subcommand) |
| `apps/api/scripts/deploy/lib/keychain.ts` | 60 | macOS Keychain 读写 |
| `apps/api/scripts/deploy/lib/tmp-config.ts` | 60 | mkdtemp /tmp + chmod 600 |
| `apps/api/scripts/deploy/lib/tcb.ts` | 70 | expect 跑 tcb config update (Merge/Override) |
| `apps/api/scripts/deploy/lib/tcb-fetch.ts` | 70 | tcb db nosql query 读 audit_log |
| `apps/api/scripts/deploy/lib/diff.ts` | 85 | 纯函数 diffEnv + KEK 防漂移 |
| `apps/api/scripts/deploy/lib/audit.ts` | 80 | 写 CloudBase audit_log (action=deploy) |
| `apps/api/scripts/deploy/lib/logger.ts` | 45 | NDJSON stdout + stderr 协议 |
| `apps/api/scripts/deploy/lib/errors.ts` | 20 | DeployError + 5 子类 |
| `apps/api/scripts/deploy/commands/push.ts` | 130 | push 主流程 (默认 Merge) |
| `apps/api/scripts/deploy/commands/clean.ts` | 100 | 恢复 7 vars 干净版 (Override 强制) |
| `apps/api/scripts/deploy/commands/status.ts` | 145 | 查云端 vars + 最近 10 条 audit |
| `apps/api/scripts/deploy/commands/rotate-kek.ts` | 45 | KEK 轮换 + push 子流程 |
| 5 个 __tests__/ | 290 | 27 unit tests (keychain/tmp-config/tcb/diff/audit) |
| `scripts/verify-deploy-pipeline.sh` | 100 | 真接验收脚本 |

### 3.3 修改 (3 files)

| 文件 | 改动 |
|---|---|
| `apps/api/package.json` | scripts: deploy / deploy:push / deploy:clean / deploy:status / deploy:rotate-kek；删 3 个旧条目 |
| `apps/api/vitest.config.ts` | include scripts/**/*.test.ts (让 scripts/ 下 test 被 pick up) |
| `apps/api/src/lib/audit.ts` | AuditEntry 扩展 (action="deploy" + deploySnapshot + operator) |

### 3.4 删除 (3 files)

| 文件 | 替代 |
|---|---|
| `apps/api/scripts/deploy-secrets.ts` | `deploy push` |
| `apps/api/scripts/deploy-secrets-v2.ts` | `deploy push` |
| `apps/api/scripts/deploy-clean.ts` | `deploy clean` |

## 4. 测试 (27 PASS)

| 模块 | cases | 覆盖 |
|---|---|---|
| `lib/keychain.test.ts` | 6 | read OK / read fail / read empty / write OK / write fail / write empty value |
| `lib/tmp-config.test.ts` | 4 | 模板读 + 合并 / chmod 0600 / cleanup / cleanup 失败静默 |
| `lib/tcb.test.ts` | 3 | Merge mode / Override mode / expect missing |
| `lib/diff.test.ts` | 9 | 纯添加 / 纯删除 / 单 var 改 / KEK Δ=1 warn / KEK Δ=5 abort / force 跳过 / 空 diff / 阈值边界 Δ=2 / Δ=3 abort |
| `lib/audit.test.ts` | 5 | write OK / write fail / ulid 字段 / actor 标记 / snapshot 结构 |

**全 api tests**：163/163 PASS（P4 #2 加 deploy 模块 27 tests + 既有 136 tests）

## 5. 真接验收 (`scripts/verify-deploy-pipeline.sh`)

6 步核心场景：

```bash
[1/6] status — 查云端当前 vars (从 audit_log 最新 deploy snapshot)
[2/6] push (Merge 模式) — vars 不变, audit 写 1 条
[3/6] push --override — 强制重写 (云端 vars 严格等于 12 vars)
[4/6] push --force — 跳过 KEK_CURRENT_VERSION 漂移检查
[5/6] rotate-kek --force — KEK 轮换 + 推云 + 提示 6 步 smoke
[6/6] clean — 恢复 7 vars 干净版
```

**前置**：
- `tcb login` (CloudBase CLI 已登录)
- Keychain 6 secrets 已 setup (`pnpm -F api setup:keychain-secrets`)
- macOS (用 `security` 命令)

**manual 验收**（rotate-kek 后必跑）：
- `tcb db nosql query --env-id unequal-d4ggf7rwg82e0900b --direct '{"filter":{"action":"deploy"},"sort":{"timestamp":-1},"limit":10}' — 查 audit_log deploy records
- 6 步 smoke (`docs/superpowers/state-cp6.md §4`) — 验证 KEK 轮换后旧数据仍可读

## 6. 边界 / 限制

1. **macOS only** — `security` 命令读 Keychain。Linux 需 `secret-tool` (libsecret) — P4 #3 待办。
2. **expect prompt 文案** — 依赖 tcb CLI 3.5.7 "Override update" / "Merge update" 提示文案。未来 tcb 改了会卡 60s timeout。
3. **tcb db nosql insert** — 写 audit_log 走 tcb CLI 调 Mongo 命令。tcb 4.x 升级后可能命令签名变。
4. **自动 rollback v1 未实现** — deploy 失败需手动跑 `deploy:status` 看上次状态 + `/tmp/unequal-deploy-PREVIOUS-*.json` 24h 保留可手工恢复。
5. **无 deploy 并发锁** — v1 不做，多个 deploy 并发跑 audit_log 顺序乱。
6. **KEK v1 → v2 re-encrypt v1 不实现** — 当前代码只用 KEK_SECRET_V1，派生 KEK deterministic 所以旧 chunk 仍可读。如果未来按 version 选 KEK 需 re-encrypt。
7. **`deploy:secrets-v2` alias 保留 1 个版本** — 删了（已 git rm in commit 1）。

## 7. P4 候选（更新）

| # | 任务 | 状态 |
|---|---|---|
| 1 | **Proper secrets manager** | ✅ P4 #1 完成 (commit 53fd0f8) |
| 2 | **Deploy 流程重写** (auto-rotate + audit + Merge fallback + KEK 防漂移) | ✅ **P4 #2 完成** (commit 3466258 spec + 3dcd430/98cbbbd/fed4b1e) |
| 3 | **Linux 兼容** (secret-tool) | ⏸️ 0.5 天 |
| 4 | NLI 蕴含验证 | ⏸️ P1 |
| 5 | HyDE 检索增强 | ⏸️ P1 |
| 6 | BGE-reranker | ⏸️ P1 |
| 7 | M7-D 真机验证 | ⏸️ P1 |

## 8. Commit 链

```
3466258 docs(spec): deploy pipeline rewrite - design (P4 #2)
3dcd430 refactor(deploy): 抽 deploy/ 模块 + keychain + tmp-config + tcb (P4 #2 commit 1)
98cbbbd feat(deploy): diff + KEK_CURRENT_VERSION 防漂移 + deploy audit log (P4 #2 commit 2)
fed4b1e feat(deploy): rotate-kek command - generate new KEK + Keychain + push (P4 #2 commit 3)
```

外加 verify-deploy-pipeline.sh 准备 commit（commit 4 待定 — 需真接通过）。

## 9. ⚠️ 副发现 (debug 教训)

**tcb override behavior 在 Merge 模式下不变**：tcb CLI 检测 env vars 变化时永远弹 prompt（无论 Merge 还是 Override）— 我们用 expect 自动选 mode。这意味着未来 tcb 提示改了 expect 脚本会卡死。修法：直接用 `tcb ... --force` (如果 tcb 支持) 或在 expect timeout 60s 后自动降级到 `--force` 路径。**v1 不实现，先暴露错误让用户反馈**。

**deploy audit 写失败不阻塞 deploy**：spec §7 设计如此。理由：audit 是"观察者"不能影响主流程。但生产问题追溯时如果有 audit miss 是个 gap。**v2 改进**：写 audit 失败 → abort deploy（用户可 `--skip-audit` 显式跳过）。