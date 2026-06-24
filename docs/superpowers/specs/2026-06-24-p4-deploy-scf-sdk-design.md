# P4 #3 — Deploy Pipeline 修复：绕开 tcb CLI 走 SCF SDK

**日期**：2026-06-24
**前置**：P0-#1 ADMIN_IP_ALLOWLIST CIDR PASS（commit `ae7b977`）— 真接发现 tcb CLI 3.5.7 silently wipes secrets
**状态**：⏸ 草稿，待用户 review
**作者**：brainstorming session 2026-06-24

---

## 1. TL;DR

P4 #2 deploy pipeline（`pnpm -F api deploy push`，commit `9950196`）用 `tcb config update fn` + `expect` 模拟 tty 选择 Merge/Override。P0-#1 真接发现：**tcb CLI 3.5.7 "Merge update" silently wipes secrets**（admin 真接 100% IP_NOT_ALLOWED 解阻塞后才发现），且 `push.ts:87-94` 用本地模板拼 after snapshot（13 vars + Keychain = 20 vars），diff 是假的。

**修复**：用 Tencent Cloud 官方 SDK `tencentcloud-sdk-nodejs-scf@4.1.168`（含 `UpdateFunctionConfiguration` + `GetFunctionConfiguration`）替换 `tcb config update fn`，消除 tcb CLI prompt 不确定性；after snapshot 改用真云端 fetch。

**核心收益**：
- 确定性 deploy：API 返回什么就是什么，不会 silently wipe
- 真正 diff：before/after 都来自真云端，不再用本地模板拼
- 部署更快：HTTP API ~1-2s，expect 模拟 tty ~5-10s
- 跨平台潜力：去掉 `expect` 二进制依赖

---

## 2. 根因分析

### 2.1 tcb CLI 3.5.7 行为（实测）

```
$ tcb --config-file <tmp> config update fn api-router
? Override update or Merge update (Use arrow keys)
❯ Override update
  Merge update
```

- **Override update**：用本地 template（13 vars）完全替换云端 → 丢所有 secrets
- **Merge update**：CLI 自报 `envVariables=20项`，**实际云端 runtime env 仍有 secrets**（admin login 200 证明）— 但 `tcb config pull fn` 显示 13 vars（CLI display bug，隐藏 secrets）
- **`push.ts:87-94` 拼的 after snapshot 是假的**：用本地 cloudbaserc.json 模板（13 vars）+ 7 Keychain secrets = 20 vars（不是真云端 fetch）
- **`diff +0 -0 ~0` 数字假**：本地模板差异本来就是 0

### 2.2 影响

- **每次 deploy 后必须 `curl /api-auth-admin-login` 验证**（P0-#1 教训）
- 中途失败（push 成功但 cloudbaserc.json 模板错）→ production 缺 secrets → 全部 handler 500
- 真接 deploy 期间 admin 端任何真接（CP-7 / P5 NLI / Arch-V2.4 / M3-D）都 silent 失败

### 2.3 真验证

P0-#1 commit `ae7b977` 真接 3 步：
```
Step 1: tcb config pull fn api-router → 13 vars (cli display bug)
Step 2: POST /api-auth-admin-login → 200 + JWT 205 chars ✅
Step 3: GET /api-auth-me → 404 (admin user not in user collection) ✅
```

admin login 200 证明云端 runtime env 实际有所有 secrets，CLI 显示 13 vars 是 display bug。

---

## 3. 架构

### 3.1 当前架构（P4 #2 后）

```
┌─────────────────────────────────────────────────┐
│ pnpm -F api deploy push                          │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
   ┌──────────────────────────────┐
   │ 1. read remote snapshot     │
   │    (tcb db nosql execute)   │
   └──────────┬───────────────────┘
              │
              ▼
   ┌──────────────────────────────┐
   │ 2. read 7 Keychain secrets  │
   └──────────┬───────────────────┘
              │
              ▼
   ┌──────────────────────────────┐
   │ 3. write /tmp tmp config     │
   └──────────┬───────────────────┘
              │
              ▼
   ┌──────────────────────────────┐
   │ 4. tcb config update fn     │ ← bug: 弹 prompt, expect 模拟
   │    (expect 选 Merge)        │   silently wipes (or not)
   └──────────┬───────────────────┘
              │
              ▼
   ┌──────────────────────────────┐
   │ 5. fake after snapshot      │ ← bug: 用本地模板拼, 不是真云端
   │    (template + secrets)     │
   └──────────┬───────────────────┘
              │
              ▼
   ┌──────────────────────────────┐
   │ 6. diff + KEK 漂移检查       │ ← bug: diff 数字假
   └──────────┬───────────────────┘
              │
              ▼
   ┌──────────────────────────────┐
   │ 7. write audit_log          │
   └─────────────────────────────────┘
```

### 3.2 新架构（P4 #3）

```
┌─────────────────────────────────────────────────┐
│ pnpm -F api deploy push                          │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
   ┌──────────────────────────────┐
   │ 1. read remote snapshot     │
   │    (SCF SDK GetFunction)    │ ← 真云端, 不弹 prompt
   └──────────┬───────────────────┘
              │ (fallback to local template on fail)
              ▼
   ┌──────────────────────────────┐
   │ 2. read 7 Keychain secrets  │ (不变)
   │    + 2 new: TCB_SECRET_ID   │
   │             TCB_SECRET_KEY  │
   └──────────┬───────────────────┘
              │
              ▼
   ┌──────────────────────────────┐
   │ 3. write /tmp tmp config     │ (保留, 备份)
   └──────────┬───────────────────┘
              │
              ▼
   ┌──────────────────────────────┐
   │ 4. SCF SDK setFunctionEnv  │ ← HTTP API, 确定性
   │    (UpdateFunctionConfig)  │   不弹 prompt, 不 wipe
   └──────────┬───────────────────┘
              │
              ▼
   ┌──────────────────────────────┐
   │ 5. read remote snapshot     │ ← 真云端 (after), 重试 3 次
   │    (SCF SDK GetFunction)    │
   └──────────┬───────────────────┘
              │
              ▼
   ┌──────────────────────────────┐
   │ 6. diff + KEK 漂移检查       │ ← before/after 都来自真云端
   └──────────┬───────────────────┘
              │
              ▼
   ┌──────────────────────────────┐
   │ 7. write audit_log          │ (不变)
   └─────────────────────────────────┘
```

---

## 4. 关键组件

### 4.1 `lib/tcb-scf.ts`（新建）

```typescript
import { Client } from "tencentcloud-sdk-nodejs-scf";
import { Credential } from "tencentcloud-sdk-nodejs-common";
import { keychainGet } from "./keychain.js";

const TCB_REGION = "ap-shanghai";
const TCB_NAMESPACE = "default";

export interface EnvVars { [key: string]: string; }

export function initScfClient(): Client {
  const secretId = keychainGet("TCB_SECRET_ID");
  const secretKey = keychainGet("TCB_SECRET_KEY");
  if (!secretId || !secretKey) {
    throw new ScfAuthError("TCB_SECRET_ID/TCB_SECRET_KEY not found in keychain; run `tcb login` and add to keychain");
  }
  const cred = new Credential(secretId, secretKey);
  return new Client(cred, TCB_REGION);
}

/** 真云端 fetch（替换 tcb config pull fn 解析） */
export async function getFunctionEnv(functionName: string): Promise<EnvVars> {
  const client = initScfClient();
  const resp = await client.GetFunctionConfiguration({
    FunctionName: functionName,
    Namespace: TCB_NAMESPACE,
  });
  const vars = resp.Environment?.Variables ?? [];
  const result: EnvVars = {};
  for (const v of vars) {
    if (v.Key) result[v.Key] = v.Value ?? "";
  }
  return result;
}

/** 写云端 env（替换 tcb config update fn + expect） */
export async function setFunctionEnv(functionName: string, envVars: EnvVars): Promise<{ requestId: string }> {
  const client = initScfClient();
  const variables = Object.entries(envVars).map(([k, v]) => ({ Key: k, Value: v }));
  const resp = await client.UpdateFunctionConfiguration({
    FunctionName: functionName,
    Namespace: TCB_NAMESPACE,
    Environment: { Variables: variables },
  });
  return { requestId: resp.RequestId ?? "unknown" };
}
```

**特性**：
- 不弹 prompt，不依赖 `expect` 二进制
- Tencent API 3.0 atomic：全 set 或全不 set（不会出现部分成功）
- 鉴权失败抛 `ScfAuthError`，调用方决定 fallback
- SDK 158KB，依赖 `tencentcloud-sdk-nodejs-common` (tslib)

### 4.2 `lib/tcb.ts`（删除）

`runTcbConfigUpdate` (expect + tcb CLI) 删除。命令/调用方都改走 `tcb-scf.ts` 的 `setFunctionEnv` / `getFunctionEnv`。

### 4.3 `lib/tcb-fetch.ts`（改写）

```typescript
// 旧: tcb db nosql execute → 读 audit_log 找上次 deploy snapshot (绕, 不准)
// 新: SCF SDK GetFunctionConfiguration → 真云端 env (直接, 准)

import { getFunctionEnv } from "./tcb-scf.js";
import { TcbFetchError } from "./errors.js";

export function getRemoteEnvSnapshot(envId: string = TCB_ENV, functionName = "api-router"): EnvSnapshot {
  try {
    const envVars = getFunctionEnv(functionName);
    return {
      source: "remote",
      capturedAt: Date.now(),
      envVariables: envVars,
    };
  } catch (err) {
    throw new TcbFetchError(`GetFunctionConfiguration failed: ${err.message}`);
  }
}
```

**注意**：envId 参数保留兼容（不抛 warning），实际用的是 `functionName`（因为 SDK 要 function name 不用 env id）。

### 4.4 `commands/push.ts`（改写）

```typescript
// 旧: runTcbConfigUpdate(cfgPath, mode, envId)  →  expect + tcb CLI
// 新: setFunctionEnv(functionName, envVars)     →  SCF SDK HTTP API

// 旧: after snapshot 用本地模板 + Keychain 拼 (假)
// 新: after snapshot 用 getFunctionEnv 拉真云端 (真)

const FUNCTION_NAME = "api-router";

export async function push(opts: Record<string, unknown>): Promise<void> {
  // 1. 读 deploy 前 snapshot (SCF SDK)
  let before: EnvSnapshot;
  try {
    before = getRemoteEnvSnapshot(TCB_ENV, FUNCTION_NAME);
    logger.info(`[push] ✓ before: ${Object.keys(before.envVariables).length} vars from remote (SCF API)`);
  } catch (err) {
    logger.warn(`[push] ⚠️  remote snapshot failed: ${err.message}, fallback to local template`);
    before = await loadLocalTemplate();
  }

  // 2. 读 7 secrets from Keychain (不变)
  const merged: Record<string, string> = {};
  for (const key of SECRETS) merged[key] = keychainGet(key);

  // 3. 写 /tmp 临时 config (保留, 备份用)
  const cfgPath = await makeTmpConfig(merged, TEMPLATE_PATH);

  // 4. SCF SDK setFunctionEnv (替换 tcb config update fn)
  logger.info(`[push] → SCF SDK UpdateFunctionConfiguration (api-router, ${Object.keys(merged).length} vars)`);
  const { requestId } = await setFunctionEnv(FUNCTION_NAME, merged);
  logger.info(`[push] ✓ SCF API 成功 (RequestId: ${requestId})`);

  // 5. 真云端 fetch after snapshot (重试 3 次防网络抖)
  const after = await getRemoteEnvSnapshotWithRetry(TCB_ENV, FUNCTION_NAME, 3);

  // 6. diff + 防漂移检查 (不变)
  const drift = diffEnv(before, after, { forceVersionDrift: !!opts.force });
  // ... (不变)

  // 7. 写 audit_log (不变)
  // ...
}
```

### 4.5 `commands/clean.ts` / `commands/rotate-kek.ts`（小改）

`runTcbConfigUpdate` 调用 → `setFunctionEnv` 调用。各 ~3 行改动。

### 4.6 Keychain 新增 2 entries

| Entry | 用途 | 来源 |
|---|---|---|
| `TCB_SECRET_ID` | Tencent Cloud API 鉴权 | `tcb login` 后从 `~/.tcb/cli-config.json` 拿 |
| `TCB_SECRET_KEY` | Tencent Cloud API 鉴权 | 同上 |

**获取方法**（一次性）：
```bash
# 1. 确认已 tcb login
tcb login  # 如果未登录

# 2. 提取 secretId/secretKey
cat ~/.tcb/cli-config.json  # 找 secretId/secretKey 字段

# 3. 写 keychain
security add-generic-password -s "unequal:api-router:KEY" -a "TCB_SECRET_ID" -w "<secretId>"
security add-generic-password -s "unequal:api-router:KEY" -a "TCB_SECRET_KEY" -w "<secretKey>"
```

---

## 5. 错误处理

| 错误 | 来源 | 处理 |
|---|---|---|
| `TCB_SECRET_ID/KEY` 缺 | Keychain 查不到 | 抛 `ScfAuthError`, 报错 "run `tcb login` + add to keychain" |
| SDK init 失败 | 网络/凭证错 | 抛 `ScfAuthError`, 不重试 |
| `GetFunction` 失败 | HTTP 4xx/5xx | 抛 `TcbFetchError`, fallback local template (before only) |
| `UpdateFunction` 失败 | HTTP 4xx/5xx | 抛 `DeployError`, 旧 config 保留, audit 写 failure |
| `GetFunction` 二次失败 (after) | 网络抖 | 重试 3 次 (1s/3s/9s), 全失败 → abort deploy + audit failure |
| 鉴权 401/403 | secretId/Key 错 | 抛 `ScfAuthError`, audit failure, 不重试 (永久失败) |
| 限流 429 | API quota | SDK 自动重试 1 次, 仍失败 → 抛错 (deployment 立即 abort) |

**fallback 兼容**：
- `TCB_FALLBACK_CLI=true` 环境变量切回老 `tcb config update fn` 路径（仅紧急用 1-2 commit 后删）
- 默认走新 SDK 路径

---

## 6. 测试

### 6.1 单测（vitest）

| 测试文件 | 覆盖 | 新建/改写 |
|---|---|---|
| `tcb-scf.test.ts` | `initScfClient` 鉴权失败抛错 | 新建 |
| `tcb-scf.test.ts` | `setFunctionEnv` 调 `UpdateFunctionConfiguration` (mock SDK) | 新建 |
| `tcb-scf.test.ts` | `getFunctionEnv` 解析 `Array<Variable>` | 新建 |
| `tcb-scf.test.ts` | secretId 缺 → 抛 `ScfAuthError` | 新建 |
| `tcb-fetch.test.ts` | `getRemoteEnvSnapshot` 走 SDK 路径 | 改写 |
| `tcb-fetch.test.ts` | SDK 失败 → 抛 `TcbFetchError` (不 fallback) | 改写 |
| `tcb-fetch.test.ts` | 解析 `Environment.Variables[]` 为 `Record<string,string>` | 改写 |
| `push.test.ts` | 端到端 push 流程 mock SDK | 新建 |
| `push.test.ts` | after snapshot 用真 fetch 不是本地模板 | 新建 |
| `push.test.ts` | KEK 漂移检查仍工作 | 改写 |

**预估**：~12-15 个新测试 case

### 6.2 真接验证

参考 `state-p4-deploy-pipeline.md` §1.1 6 步：

| 步 | 命令 | 期望 | 验证 |
|---|---|---|---|
| [1/6] status | `pnpm -F api deploy:status` | 20 vars from SCF API (not audit_log) | SCF 返 vars 数 = 20 |
| [2/6] push (Merge) | `pnpm -F api deploy push` | 推 20 vars + diff +0 -0 ~0 + audit_log | `curl /api-auth-admin-login` 200 |
| [3/6] push --override | `pnpm -F api deploy push -- --override` | 同上 (override 是 SDK 默认, 行为一致) | 同上 |
| [4/6] push --force | `pnpm -F api deploy push -- --force` | KEK_CURRENT_VERSION 未漂移 | diff +0 -0 ~0 |
| [5/6] rotate-kek --force | `pnpm -F api deploy rotate-kek -- --force` | KEK 轮换 + 推云 | KEK_CURRENT_VERSION=2 |
| [6/6] clean | `pnpm -F api deploy clean` | 恢复 7 vars | clean.ts 调 setFunctionEnv |

**关键回归测试**：
- 跑完 push 立刻 `curl /api-auth-admin-login` → 200 (确认 secrets 真写到了)
- 不再需要 `expect` 二进制 (卸载 brew install expect 后仍能 deploy)

### 6.3 回归

- `pnpm -r test` 全 PASS (基线 618/618 → +12-15)
- `pnpm -F api typecheck` 干净 (新加 SDK 类型)
- `pnpm -F api deploy:build` 成功 (esbuild bundle 含新依赖)

---

## 7. 改动清单

| 文件 | 动作 | 行数 |
|---|---|---|
| `lib/tcb-scf.ts` | 新建 | ~70 |
| `lib/tcb-scf.test.ts` | 新建 | ~120 |
| `lib/tcb.ts` | 删除 | -55 |
| `lib/tcb.test.ts` | 删除 | -180 |
| `lib/tcb-fetch.ts` | 改写 | -50 / +20 |
| `lib/tcb-fetch.test.ts` | 改写 | -100 / +60 |
| `commands/push.ts` | 改写 | -20 / +30 |
| `commands/push.test.ts` | 新建 | ~150 |
| `commands/clean.ts` | 改 | -5 / +3 |
| `commands/rotate-kek.ts` | 改 | -5 / +3 |
| `package.json` | 加依赖 | +1 |
| **合计** | | **~+250 / -410** (净 -160) |

---

## 8. 风险

| 风险 | 概率 | 缓解 |
|---|---|---|
| Tencent SDK 内部 bug | 低 (4.1.168 稳定) | 保留 `TCB_FALLBACK_CLI=true` 切老路径 1-2 commit |
| `secretId/secretKey` 失效 (轮换) | 中 (腾讯账号安全策略) | audit 写 failure 立即报警, 用户重 tcb login + 更新 keychain |
| SDK 依赖膨胀 | 低 (158KB) | 比 tcb CLI 3.5.7 (300MB+) 小 3 个数量级 |
| 跨区域 (region) 错 | 中 (默认 ap-shanghai) | `TCB_REGION` env 可覆盖 |
| 真云端 fetch 慢 (after) | 中 (1-2s) | 重试 3 次 + 背压 |
| 函数其他配置被改 | 中 (SDK 全 set Environment) | 只改 Environment.Variables, 其它字段不传 (SDK 默认保留) |

---

## 9. 兼容性

- **Keychain 新增 2 entries**：deploy 首次跑时缺 → 抛错 + 提示用户 run `tcb login` + add
- **回退路径**：`TCB_FALLBACK_CLI=true` 切老 tcb CLI 路径（应急）
- **audit_log schema 不变**：仍复用现有 `deploySnapshot` + `operator` 字段
- **deploy CLI 命令不变**：`pnpm -F api deploy push/clean/rotate-kek/status` 行为一致

---

## 10. Lessons (P0-#1 教训 → P4 #3 修复)

1. **CLI 不应该有 prompt**：自动化 pipeline 用的 CLI 必须支持 non-interactive flag 或 HTTP API。tcb CLI 3.5.7 弹 Merge/Override prompt 是设计缺陷。
2. **snapshot 必须真云端 fetch**：用本地模板拼"after"是 lazy 但不可靠。修后 diff 数字真。
3. **deploy 后必须 verify**：`curl /api-auth-admin-login` 200 是 deploy 成功的真验证（保留作为 deploy 收尾自动 step）。
4. **依赖外部 CLI = 不可控**：tcb CLI 升级可能改行为，绑 SDK 后不受影响。

---

## 11. 后续候选

- **P4 #4 (Linux 兼容)**：当前 expect 路径 macOS only，SDK 路径跨平台 → 自然解决
- **P4 #5 (并行 deploy)**：现在串行 deploy 多函数，SDK 路径可以并发
- **P4 #6 (CI/CD 集成)**：deploy 走 GitHub Actions 时，Keychain 不存在 → 改用 GitHub Secrets

---

## 12. References

- **P0-#1 副发现**：`docs/superpowers/state-m7-d.md` §6.1.1 + memory `project_p0_1_ip_allowlist_cidr_pass.md`
- **P4 #2 deploy pipeline**：`docs/superpowers/state-p4-deploy-pipeline.md` (commit `9950196`)
- **Tencent SCF API 文档**：https://cloud.tencent.com/document/api/583/19808 (UpdateFunctionConfiguration)
- **SDK npm**：`tencentcloud-sdk-nodejs-scf@4.1.168` (158KB, tslib dep)
