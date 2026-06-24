# state-p4-secrets-manager — proper secrets manager PASS

> 日期: 2026-06-23
> 前置: state-m7-d.md (commit c8ce057) — settings 页 + /api-auth-me
> 状态: ✅ secrets 从 gitignored disk JSON 迁到 macOS Keychain + `/tmp` 临时 config 部署

## 1. 验收结果

| 维度 | v1 (前) | v2 (后) |
|---|---|---|
| secrets 持久位置 | `apps/api/cloudbaserc.smoke.json` (disk, gitignored) | macOS Keychain (`security` 命令) |
| secrets 进 git 风险 | 低（gitignore）但 disk 易误看 | 零（Keychain 不进 disk 长期文件）|
| deploy 临时 config | 无 | `/tmp/unequal-deploy-XXX/cloudbaserc.json` (chmod 600, 立即 rm) |
| 部署失败诊断 | 静默 | tcb 输出实时回显 (envVariables=13项) |
| Keychain 缺 secret 报错 | n/a | 明确提示 "run setup:keychain-secrets.sh" |
| 平台支持 | n/a | macOS (用 `security`) — Linux 待 P4 |
| 测试 | 511/511 | 511/511 (脚本本身无单测，靠真接覆盖) |
| 真接 /api-auth-me | ✅ | ✅ (云端 13 vars, 6 secrets 持续生效) |

## 2. 设计

### 2.1 旧流程 (P3.6)

```
deploy:secrets
  ↓
读 process.env.{4 secrets}
  ↓
写 apps/api/cloudbaserc.smoke.json (12 vars)  ← disk file
  ↓
tcb --config-file cloudbaserc.smoke.json config update fn api-router
  ↓
deploy:clean (手动跑)
  ↓
写 apps/api/cloudbaserc.json (7 vars)        ← disk file
```

**问题**：
- cloudbaserc.smoke.json 在 disk 易误 cat / git add (gitignore 不防 IDE 索引)
- secrets 进 process.env 需 export，zsh 子进程陷阱（memory 已记录）
- secrets 反复在 gitignored disk file 与 env 之间搬运

### 2.2 新流程 (P4 secrets manager)

```
setup:keychain-secrets  (一次性, 1 次)
  ↓
security add-generic-password (6 secrets)  → macOS Keychain
  ↓
[secrets 持久在 OS Keychain, 不进 disk]

deploy:secrets-v2  (每次部署)
  ↓
security find-generic-password (6 secrets)  ← 读 Keychain
  ↓
mkdtemp /tmp/unequal-deploy-XXX/cloudbaserc.json (chmod 600)
  ↓
tcb --config-file <tmp> config update fn api-router (expect 自动化 Override)
  ↓
rm -rf <tmp>
```

**优势**：
- secrets 不进 disk 长期文件（Keychain 是 OS 级加密存储）
- 临时 config `/tmp` OS reboot 自动清 + chmod 600 防同机用户看
- Keychain GUI 可视化 + 可审计（钥匙串访问.app）
- 失败诊断：Keychain 缺 secret → 明确提示运行 setup 脚本
- tcb 输出实时回显（不再静默）

## 3. 改动

### 3.1 `apps/api/scripts/deploy-secrets-v2.ts` (新, 130 lines)

```typescript
// 核心流程
async function main() {
  // 平台 + 依赖检查
  if (process.platform !== "darwin") throw new Error("macOS only");
  if (!existsSync("/usr/bin/expect")) throw new Error("expect not found");

  // 1. Keychain 读 6 secrets
  const merged = Object.fromEntries(
    SECRETS.map(key => [key, keychainGet(key)])
  );

  // 2. mkdtemp /tmp 临时 config（merge 进根 cloudbaserc.json 的 7 stable vars）
  const cfgPath = await makeTmpConfig(merged);  // chmod 600

  // 3. expect 调 tcb config update fn (处理 Override/Merge 交互式菜单)
  const r = await runTcbConfigUpdate(cfgPath);
  console.log(r.stdout.split("\n").slice(-5).join("\n  | "));  // 实时回显

  // 4. 立即 rm 临时 config
  await cleanupTmp(cfgPath);
}
```

### 3.2 `apps/api/scripts/setup-keychain-secrets.sh` (新, 一次性)

```bash
# 6 个 SECRETS_* 变量需用户从密码管理器复制（不在脚本里 hard-code）
add_secret() {
  local key="$1" val="$2"
  security delete-generic-password -a "$ACCOUNT" -s "${PREFIX}${key}" 2>/dev/null || true
  security add-generic-password -a "$ACCOUNT" -s "${PREFIX}${key}" -w "$val" -U
}
add_secret "ADMIN_TOKEN" "$SECRETS_ADMIN_TOKEN"
# ... 5 more
```

### 3.3 `apps/api/package.json` scripts (加 2 条)

```json
"deploy:secrets-v2": "tsx scripts/deploy-secrets-v2.ts",
"setup:keychain-secrets": "bash scripts/setup-keychain-secrets.sh"
```

### 3.4 `apps/api/cloudbaserc.smoke.json` (删 disk file)

gitignored 但 disk 上的 smoke config **已删**（避免 IDE 索引误看 / 防误 git add）。

## 4. 真接 trace

```bash
# 1. 一次性: Keychain 写 6 secrets
$ ./scripts/setup-keychain-secrets.sh
[setup-keychain-secrets] 写 6 secrets 到 macOS Keychain
  ✓ ADMIN_TOKEN (len=64)
  ✓ JWT_SECRET (len=64)
  ✓ MINIMAX_API_KEY (len=125)
  ✓ KEK_SECRET_V1 (len=64)
  ✓ INGEST_PROXY_SECRET (len=64)
  ✓ ADMIN_IP_ALLOWLIST (len=109)
✅ 6 secrets 写入完成

# 2. deploy 12 vars
$ pnpm -F api deploy:secrets-v2
[deploy:secrets-v2] 从 Keychain 读 6 secrets + 写 /tmp 临时 config
  ✓ 6 secrets loaded (lengths: ADMIN_TOKEN=64, ...)
  ✓ tmp config: /var/folders/.../unequal-deploy-pwr0bW/cloudbaserc.json (1387 bytes, mode 0600)
[deploy:secrets-v2] 推 env vars 到 CloudBase api-router
  | ✅ Configuration for function [api-router] updated successfully!
  | Updated: timeout=30s, memory=256MB, runtime=Nodejs20.19, handler=index.main, envVariables=13项
  ✓ tmp cleaned
✅ 6 secrets 注入完成

# 3. 真接验证
$ curl .../api-auth-admin-login -d '{"token":"..."}'  → JWT 拿到
$ curl .../api-auth-me -H "Authorization: Bearer $JWT"  → 404 (admin 默认 user 不存在, 符合预期)
```

## 5. 测试

| 测试集 | 数量 | 结果 |
|---|---|---|
| 全 monorepo | 511 | **PASS** (与 zhenjie6/M7-D 一致) |
| deploy:secrets-v2 端到端 | 1 真接 | **PASS** (13 vars 已推) |
| Keychain 缺 secret 报错路径 | 手动测 | 通过（明确提示 setup 脚本） |

## 6. 边界 / 限制

1. **macOS only** — 用 `security` 命令。Linux 需替换 `secret-tool` (libsecret)。P4 待办。
2. **没有 audit log** — 谁部署、什么时候部署、推了什么，都没记录。P4 应加 deploy audit。
3. **没有 auto-rotate** — KEK/JWT_SECRET 轮换仍需手动（state-cp6.md §10.3 P3.6 演练过流程，但脚本没固化）。
4. **override 模式** — `tcb config update fn` 默认 Override（完全替换）。这是 tcb CLI 行为，不是我们能改的。如果只想改 1 个 var，必须传完整 12 vars（不能只传 1 个）。
5. **KEK_CURRENT_VERSION 自增** — tcb 推送时似乎自增（13 而不是 12），但实际值不变。需要看 tcb CLI 行为或者写 diff 校验。

## 7. P4 候选（更新）

| # | 任务 | 工作量 | 状态 |
|---|---|---|---|
| 1 | **Proper secrets manager** | 1-2 天 | ✅ **本 commit 完成** (macOS) |
| 2 | **Deploy 流程重写** | 1 天 | ✅ 部分完成（v2 路径 + 实时回显），仍需：(a) KEK_CURRENT_VERSION 不漂移 (b) auto-rotate 脚本 (c) deploy audit log |
| 3 | **Linux 兼容** (secret-tool) | 0.5 天 | ⏸️ |
| 4 | **NLI 蕴含验证** | 1-2 天 | ⏸️ (P1) |
| 5 | **HyDE 检索增强** | 1 天 | ⏸️ (P1) |
| 6 | **BGE-reranker** | 1-2 天 | ⏸️ (P1) |
| 7 | **M7-D 真机验证** | 0.5 天 | ⏸️ (P1) |

## 8. Commit 链

```
[tbd] feat(p4): proper secrets manager — Keychain + /tmp 临时 config  ← 本次
c8ce057 feat(m7-d): settings 页 + /api-auth-me + chat ⚙ 入口
d0eecdc perf(v2.4): retry 跳过 parse/chunk/embed — chunks_with_emb_json 持久化
ccb98d2 fix(v2.4): CloudEmbedder MiniMax schema 修复 (texts+vectors) + BATCH_SIZE=100
```

## 9. ⚠️ 副发现 (debug 教训)

**deploy 期间误清 env**：我之前用 `expect` 单 var config (`{TEST_VAR: "hello"}`) 测试时，触发了 tcb Override update（完全替换），**把 12 vars 全清成 1 var**。修法：要么永远推完整 config，要么用 Merge update（local 覆盖云端同名字段，不删其他）。

**P4 改进**：deploy 流程应自动 fallback 到 Merge update 而不是 Override（除非用户显式选）。