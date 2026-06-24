# Deploy Pipeline Rewrite — Design Spec

> 日期: 2026-06-23
> 前置: state-p4-secrets-manager.md (commit 53fd0f8) — Keychain + /tmp 临时 config 部署
> 范围: 4 子项（KEK_CURRENT_VERSION 防漂移 / KEK 轮换脚本 / deploy audit log / Merge update fallback）
> 状态: 📝 spec 设计稿，待用户 review

## 1. 背景

P3.6 + P4 已完成 deploy 基础能力（两步法 + Keychain secrets）。但 4 个长期痛点未解决：

| 痛点 | 现状 | 风险 |
|---|---|---|
| KEK_CURRENT_VERSION 不漂移 | tcb push 时 version 自增（1→2），代码不知 | 未来按 version 选 KEK 时 v2 不存在 → 解密失败 |
| KEK 轮换脚本 | 全靠手工 openssl + export + deploy:secrets（state-cp6 §10.3 演练过流程但没固化）| 应急轮换时容易漏步 |
| Deploy audit log | 完全无记录：谁、何时、推了什么 vars | 出问题无法回溯 |
| Merge update fallback | expect 强制 Override，单 var 调试会清其他 vars（state-p4 §9 教训）| 调试路径不安全 |

**目标**：把 4 子项合并为统一 `deploy` CLI（subcommand 化），可测试、可审计、可回滚。

## 2. 设计原则

1. **合并 vs 独立**：4 子项天然相互依赖（rotate-kek 内部调 push、audit log 任何命令都要写、Merge fallback 是 push 默认行为），合并为统一入口减少重复代码。
2. **TypeScript 模块化**：所有子功能可 mock + unit test（不依赖外部命令）。
3. **macOS 优先**：用 Keychain + `/tmp` 临时 config（已有路径），Linux 兼容 (#3 P4 候选) 留路 v2。
4. **Merge by default**：调试路径安全为默认；Override 必须显式 `--override` 启用。
5. **Audit first**：所有 deploy 行为都进 `audit_log` collection，跨设备可查。

## 3. 架构

```
apps/api/scripts/deploy/
├── index.ts                # CLI 入口（Node 20+ parseArgs + subcommand 分发）
├── lib/
│   ├── keychain.ts         # macOS Keychain 读写（security 命令 wrapper）
│   ├── tmp-config.ts       # mkdtemp /tmp + chmod 600 + merge cloudbaserc.json 模板
│   ├── tcb.ts              # expect 跑 tcb config update fn (Merge/Override 二选一)
│   ├── tcb-fetch.ts        # 读 CloudBase audit_log 最新 deploy 记录（远端 snapshot）
│   ├── diff.ts             # deploy 前后 vars diff + KEK_CURRENT_VERSION 防漂移
│   ├── audit.ts            # 写 CloudBase audit_log collection（action="deploy"）
│   ├── logger.ts           # 统一 NDJSON stdout + stderr 协议
│   └── errors.ts           # DeployError / KeychainError / TcbError / AuditError
├── commands/
│   ├── push.ts             # push [default: Merge, --override 切换]
│   ├── rotate-kek.ts       # 生成新 KEK_SECRET_V1 → 写 Keychain → push
│   ├── clean.ts            # 恢复 7 vars 干净版（Override 强制，Merge 模式会留 secrets）
│   └── status.ts           # 读云端 env vars + 列出最近 10 条 deploy audit
└── __tests__/              # vitest unit tests (mock security/tcb/SDK)
```

**入口**（`index.ts`）：
```typescript
#!/usr/bin/env tsx
import { parseArgs } from "node:util";
import { push } from "./commands/push.js";
import { rotateKek } from "./commands/rotate-kek.js";
import { clean } from "./commands/clean.js";
import { status } from "./commands/status.js";

const HELP = `Usage: pnpm -F api deploy <command> [flags]

Commands:
  push           Read secrets from Keychain + push to cloud function
                 Default: Merge (preserves other vars). Use --override for full replace.
  rotate-kek     Generate new KEK_SECRET_V1 + write Keychain + push
  clean          Reset cloud function to 7 vars clean template (secrets cleared)
  status         Show current cloud env vars + recent deploy audit history

Flags:
  --override              Use Override update instead of Merge (push only)
  --force                 Skip KEK_CURRENT_VERSION drift check + skip rotate-kek confirmation
  --skip-audit            Don't write audit_log entry
  -h, --help              Show this help
`;

const { values, positionals } = parseArgs({
  options: {
    override: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    "skip-audit": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

const [cmd] = positionals;
if (values.help || !cmd) console.log(HELP), process.exit(0);

try {
  switch (cmd) {
    case "push": await push(values); break;
    case "rotate-kek": await rotateKek(values); break;
    case "clean": await clean(values); break;
    case "status": await status(values); break;
    default: console.error(`Unknown command: ${cmd}`), process.exit(1);
  }
} catch (err) { logger.fatal(err); process.exit(1); }
```

**package.json scripts**（保持向后兼容）：
```json
{
  "deploy": "tsx scripts/deploy/index.ts",
  "deploy:clean": "tsx scripts/deploy/index.ts clean",
  "deploy:rotate-kek": "tsx scripts/deploy/index.ts rotate-kek",
  "deploy:status": "tsx scripts/deploy/index.ts status",
  "deploy:push": "tsx scripts/deploy/index.ts push",
  "setup:keychain-secrets": "bash scripts/setup-keychain-secrets.sh"
}
```

**旧脚本删除**：`deploy-secrets.ts` / `deploy-secrets-v2.ts` / `deploy-clean.ts`（功能全被新模块替代）。

## 4. 4 个核心模块

### 4.1 `lib/keychain.ts`

```typescript
/** macOS Keychain 读写 — 抽自 deploy-secrets-v2.ts */
/** Keychain 项：service="unequal:api-router:<KEY>", account="unequal-deploy" */

export const KEYCHAIN_ACCOUNT = "unequal-deploy";
export const KEYCHAIN_PREFIX = "unequal:api-router:";

export function keychainGet(key: string): string {
  const r = spawnSync("security", [
    "find-generic-password",
    "-a", KEYCHAIN_ACCOUNT,
    "-s", KEYCHAIN_PREFIX + key,
    "-w",
  ], { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new KeychainError(`Keychain read failed for ${key} (status ${r.status}): ${r.stderr.trim()}\nRun: pnpm -F api setup:keychain-secrets`);
  }
  const value = r.stdout.trim();
  if (!value) throw new KeychainError(`Keychain read returned empty value for ${key}`);
  return value;
}

export function keychainSet(key: string, value: string): void {
  if (!value) throw new Error(`keychainSet: empty value for ${key}`);
  const r = spawnSync("security", [
    "add-generic-password",
    "-a", KEYCHAIN_ACCOUNT,
    "-s", KEYCHAIN_PREFIX + key,
    "-w", value,
    "-U",  // 同名覆盖
  ], { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new KeychainError(`Keychain write failed for ${key} (status ${r.status}): ${r.stderr.trim()}`);
  }
}
```

### 4.2 `lib/tmp-config.ts`

```typescript
/** mkdtemp /tmp 临时 config — 抽自 deploy-secrets-v2.ts */
/** 复用 cloudbaserc.json 模板（保证 KEK_CURRENT_VERSION 等配置不漂移） */

export async function makeTmpConfig(
  mergedEnv: Record<string, string>,
  templatePath = "cloudbaserc.json",
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "unequal-deploy-"));
  const cfgPath = join(dir, "cloudbaserc.json");

  const template = await readFile(templatePath, "utf-8");
  const cfg = JSON.parse(template);

  for (const fn of cfg.functions ?? []) {
    fn.envVariables = { ...(fn.envVariables ?? {}), ...mergedEnv };
  }
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
  await chmod(cfgPath, 0o600);
  return cfgPath;
}

export async function cleanupTmp(cfgPath: string): Promise<void> {
  try { await unlink(cfgPath); } catch {}
  const dir = cfgPath.replace(/\/[^/]+$/, "");
  if (dir.startsWith(tmpdir())) {
    await unlink(dir).catch(() => {});  // OS reboot 自动清
  }
}
```

**新增 backup hook**：deploy 前后各保存一份完整 env vars 到 `~/.claude/logs/unequal-deploys/snapshot-<ts>.json`（不进 repo，保留 24h）。`/tmp/unequal-deploy-PREVIOUS-*.json` 同样保留。

### 4.3 `lib/tcb.ts` — Merge / Override 切换

```typescript
export type UpdateMode = "merge" | "override";

export async function runTcbConfigUpdate(
  cfgPath: string,
  mode: UpdateMode,
  envId: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (!existsSync("/usr/bin/expect") && !existsSync("/opt/homebrew/bin/expect")) {
    throw new Error("`expect` not found; install via `brew install expect`");
  }

  // CLI 3.5.7 提示文案：「Override update」「Merge update」
  const prompt = mode === "merge" ? "Merge update" : "Override update";
  const expectScript = `set timeout 60
spawn tcb --config-file ${cfgPath} config update fn api-router -e ${envId}
expect "${prompt}"
send "\\r"
expect eof
exit [lindex [wait] 3]
`;

  return new Promise((resolve, reject) => {
    const child = spawn("expect", ["-c", expectScript], { env: process.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}
```

### 4.4 `lib/diff.ts` — KEK_CURRENT_VERSION 防漂移

```typescript
/** deploy 前后 vars diff + KEK_CURRENT_VERSION 防漂移检查 */

export interface EnvSnapshot {
  source: "remote" | "local-template";
  capturedAt: number;
  envVariables: Record<string, string>;
}

export interface DriftReport {
  added: string[];
  removed: string[];
  changed: { key: string; before: string | undefined; after: string | undefined }[];
  warnings: string[];
}

const KEK_VERSION_DRIFT_THRESHOLD = 2;
const KEK_VERSION_KEY = "KEK_CURRENT_VERSION";

export function diffEnv(
  before: EnvSnapshot,
  after: EnvSnapshot,
  opts: { forceVersionDrift?: boolean } = {},
): DriftReport {
  const beforeVars = before.envVariables;
  const afterVars = after.envVariables;

  const added = Object.keys(afterVars).filter((k) => !(k in beforeVars));
  const removed = Object.keys(beforeVars).filter((k) => !(k in afterVars));
  const changed: DriftReport["changed"] = [];

  for (const k of Object.keys(afterVars)) {
    if (beforeVars[k] !== afterVars[k]) {
      changed.push({ key: k, before: beforeVars[k], after: afterVars[k] });
    }
  }

  const warnings: string[] = [];

  // KEK_CURRENT_VERSION 防漂移
  const kBefore = parseInt(beforeVars[KEK_VERSION_KEY] ?? "0", 10);
  const kAfter = parseInt(afterVars[KEK_VERSION_KEY] ?? "0", 10);
  const delta = kAfter - kBefore;
  if (!opts.forceVersionDrift && Math.abs(delta) > KEK_VERSION_DRIFT_THRESHOLD) {
    warnings.push(
      `${KEK_VERSION_KEY} drift too large: ${kBefore} → ${kAfter} (Δ=${delta}, threshold=${KEK_VERSION_DRIFT_THRESHOLD}). ` +
      `Use --force-version-drift to override.`,
    );
  } else if (delta !== 0) {
    warnings.push(
      `${KEK_VERSION_KEY} changed: ${kBefore} → ${kAfter} (Δ=${delta}). This may be tcb server behavior.`,
    );
  }

  return { added, removed, changed, warnings };
}
```

**远程 snapshot 读取**（`lib/tcb-fetch.ts`）：

tcb CLI 3.5.7 没"列出云函数当前 env vars"的命令。**做法**：从 `audit_log` collection 读最近一条 `action="deploy"` 记录，里面有 `deploySnapshot.after` 字段 = 上次 push 的完整 vars。

```typescript
export async function getRemoteEnvSnapshot(envId: string): Promise<EnvSnapshot> {
  // tcb db nosql query --env-id <envId> --direct '{"filter":{"action":"deploy"},"sort":{"timestamp":-1},"limit":1}'
  const query = JSON.stringify({
    filter: { action: "deploy" },
    sort: { timestamp: -1 },
    limit: 1,
  });
  const r = spawnSync("tcb", [
    "db", "nosql", "query",
    "--env-id", envId,
    "--direct", query,
  ], { encoding: "utf-8" });

  if (r.status !== 0) {
    throw new TcbFetchError(`tcb db nosql query failed: ${r.stderr.trim()}`);
  }
  const data = JSON.parse(r.stdout);
  const latest = data?.data?.[0];
  if (!latest?.deploySnapshot?.after) {
    throw new TcbFetchError("No previous deploy snapshot found in audit_log; cannot determine remote env. Run a full deploy first.");
  }
  return {
    source: "remote",
    capturedAt: latest.timestamp,
    envVariables: latest.deploySnapshot.after,
  };
}
```

**首次 deploy 容错**：如果 audit_log 没有 deploy 记录（首次部署），用 `cloudbaserc.json` 模板作为 before snapshot，warnings 会空（首次 push 不报警）。

## 5. 4 个 commands

### 5.1 `commands/push.ts` — 主流程（默认 Merge）

```typescript
export async function push(opts: Record<string, unknown>): Promise<void> {
  const envId = "unequal-d4ggf7rwg82e0900b";
  const mode: UpdateMode = opts.override ? "override" : "merge";

  logger.info(`[push] mode=${mode}`, { cmd: "push", mode });

  // 1. 读 deploy 前 snapshot（从 audit_log 最新一条）
  const before = await getRemoteEnvSnapshot(envId).catch(() => ({
    source: "local-template" as const,
    capturedAt: Date.now(),
    envVariables: await loadTemplateEnv("cloudbaserc.json"),
  }));
  logger.info(`[push] before: ${Object.keys(before.envVariables).length} vars from ${before.source}`);

  // 2. 读 6 secrets from Keychain
  const merged: Record<string, string> = {};
  for (const key of SECRETS) {
    merged[key] = keychainGet(key);
  }
  logger.info(`[push] ✓ 6 secrets loaded`);

  // 3. 写 /tmp 临时 config + chmod 600
  const cfgPath = await makeTmpConfig(merged);
  logger.info(`[push] ✓ tmp config: ${cfgPath}`);

  // 4. tcb config update fn (expect 自动选 mode)
  const result = await runTcbConfigUpdate(cfgPath, mode, envId);
  const lastLines = result.stdout.split("\n").filter(l => l.trim()).slice(-5);
  for (const line of lastLines) logger.info(`  | ${line.trim()}`);
  await cleanupTmp(cfgPath);
  if (result.code !== 0) throw new TcbError(`tcb config update fn failed: exit ${result.code}`);

  // 5. 写 audit log（含 deploySnapshot）
  const after: EnvSnapshot = {
    source: "remote",
    capturedAt: Date.now(),
    envVariables: { ...(await loadTemplateEnv("cloudbaserc.json")), ...merged },
  };

  // 6. diff + 防漂移检查（diff 是给 status 命令回看的，push 本身不强制 abort）
  const drift = diffEnv(before, after, { forceVersionDrift: !!opts.force });
  if (drift.warnings.length > 0) {
    logger.warn(`[push] ⚠️  ${drift.warnings.length} warning(s):`);
    for (const w of drift.warnings) logger.warn(`  - ${w}`);
    if (!opts.force && drift.warnings.some(w => w.includes("drift too large"))) {
      throw new DiffError("KEK_CURRENT_VERSION drift exceeded threshold; use --force to override");
    }
  }

  logger.info(`[push] ✓ ${drift.added.length} added, ${drift.removed.length} removed, ${drift.changed.length} changed`);

  // 7. 写 audit_log
  if (!opts["skip-audit"]) {
    await writeDeployAudit({
      action: "deploy",
      mode,
      before, after,
      drift,
      secretsCount: SECRETS.length,
      operator: os.userInfo().username,
    });
  }
}
```

### 5.2 `commands/rotate-kek.ts` — KEK 轮换

```typescript
export async function rotateKek(opts: Record<string, unknown>): Promise<void> {
  if (!opts.force) {
    logger.warn(`[rotate-kek] ⚠️  This will replace KEK_SECRET_V1 in Keychain.`);
    logger.warn(`[rotate-kek] ⚠️  Existing data encrypted with old KEK may be unreadable if code switches to KEK_SECRET_V2 later.`);
    logger.warn(`[rotate-kek] ⚠️  Use --force to confirm.`);
    process.exit(1);
  }

  // 1. 生成新 KEK_SECRET_V1
  const newKek = execSync("openssl rand -hex 32", { encoding: "utf-8" }).trim();
  if (!/^[a-f0-9]{64}$/.test(newKek)) {
    throw new Error(`openssl generated invalid KEK: ${newKek.slice(0, 16)}...`);
  }
  logger.info(`[rotate-kek] ✓ generated new KEK (${newKek.length} chars)`);

  // 2. 写到 Keychain（覆盖）
  keychainSet("KEK_SECRET_V1", newKek);
  logger.info(`[rotate-kek] ✓ wrote to Keychain`);

  // 3. 调用 push 子流程（用新 KEK 推 env vars）
  await push({ override: false, force: true });

  // 4. 提示用户跑 6 步 smoke
  logger.info(`[rotate-kek] ✓ pushed new KEK to cloud function`);
  logger.info(`[rotate-kek] ⚠️  NEXT: Run 6-step smoke (docs/archive/state/state-cp6.md §4)`);
  logger.info(`[rotate-kek] ⚠️  If existing data encrypted with old KEK is needed, run re-encrypt migration (P4 follow-up)`);
}
```

**风险**：KEK v1 → v2 迁移不在 v1 范围（如果代码将来按 version 选 KEK 才需要）。当前代码只用 KEK_SECRET_V1，轮换是 deterministic 派生所以旧 chunk 仍可读。

### 5.3 `commands/clean.ts` — 恢复 7 vars 干净版

```typescript
export async function clean(opts: Record<string, unknown>): Promise<void> {
  // 直接用 cloudbaserc.json 模板（7 vars），不读 Keychain
  const cfgPath = await makeTmpConfig({}, "cloudbaserc.json");
  logger.info(`[clean] tmp config from cloudbaserc.json (7 vars)`);

  // clean 必须 Override（Merge 会保留 secrets）
  const result = await runTcbConfigUpdate(cfgPath, "override", "unequal-d4ggf7rwg82e0900b");
  const lastLines = result.stdout.split("\n").filter(l => l.trim()).slice(-5);
  for (const line of lastLines) logger.info(`  | ${line.trim()}`);
  await cleanupTmp(cfgPath);
  if (result.code !== 0) throw new TcbError(`tcb config update fn failed: exit ${result.code}`);

  logger.info(`[clean] ✓ secrets cleared`);

  if (!opts["skip-audit"]) {
    await writeDeployAudit({
      action: "deploy",
      mode: "override",
      // before/after: 7 vars 模板
      operator: os.userInfo().username,
      note: "clean: reset to 7 vars template",
    });
  }
}
```

### 5.4 `commands/status.ts` — 查云端 + audit 历史

```typescript
const SECRET_KEYS = new Set(["ADMIN_TOKEN", "JWT_SECRET", "MINIMAX_API_KEY", "KEK_SECRET_V1", "INGEST_PROXY_SECRET"]);

function maskValue(key: string, value: string): string {
  if (SECRET_KEYS.has(key)) return `${value.slice(0, 4)}...${value.slice(-4)} (${value.length})`;
  return value;
}

export async function status(_opts: Record<string, unknown>): Promise<void> {
  const envId = "unequal-d4ggf7rwg82e0900b";

  // 1. 读当前云端 env vars
  const current = await getRemoteEnvSnapshot(envId).catch(() => null);
  if (!current) {
    console.log(`⚠️  No deploy audit found. Run 'pnpm -F api deploy push' first.`);
  } else {
    console.log(`Current env vars (${Object.keys(current.envVariables).length}, captured ${new Date(current.capturedAt).toISOString()}):`);
    for (const [k, v] of Object.entries(current.envVariables)) {
      console.log(`  ${k} = ${maskValue(k, v)}`);
    }
  }

  // 2. 列出最近 10 条 deploy audit
  const history = await queryDeployAudit({ envId, limit: 10 });
  console.log(`\nRecent deploys (${history.length}):`);
  for (const entry of history) {
    const ts = new Date(entry.timestamp).toISOString();
    const added = entry.deploySnapshot?.added.length ?? 0;
    const removed = entry.deploySnapshot?.removed.length ?? 0;
    const changed = entry.deploySnapshot?.changed.length ?? 0;
    console.log(`  ${ts} | ${entry.request.title ?? entry.action} | Δ +${added} -${removed} ~${changed}`);
  }
}

async function queryDeployAudit({ envId, limit }: { envId: string; limit: number }): Promise<AuditEntry[]> {
  const query = JSON.stringify({
    filter: { action: "deploy" },
    sort: { timestamp: -1 },
    limit,
  });
  const r = spawnSync("tcb", [
    "db", "nosql", "query",
    "--env-id", envId,
    "--direct", query,
  ], { encoding: "utf-8" });
  if (r.status !== 0) {
    console.warn(`⚠️  audit query failed: ${r.stderr.trim()}`);
    return [];
  }
  const data = JSON.parse(r.stdout);
  return data?.data ?? [];
}
```

## 6. AuditEntry 类型扩展

`apps/api/src/lib/audit.ts` 需扩展 `AuditEntry`：

```typescript
export interface AuditEntry {
  id: string;
  timestamp: number;
  action: "ingest" | "session_rename" | "session_delete" | "nickname_update" | "deploy";  // 加 "deploy"
  actor: {
    via: "admin_token" | "admin_jwt" | "ingest_proxy" | "jwt_user" | "deploy_script";  // 加 "deploy_script"
    clientIp: string;  // 部署时填 "localhost"
    tokenFingerprint?: string;
    userId?: string;  // 部署时填 "system"
  };
  target: {
    userId: string;  // 部署时填 "system"
    sourceId?: string;
    documentId?: string;
    chunksInserted?: number;
    resourceId?: string;
    resourceType?: "chat_session" | "user" | "document" | "chunk" | "source" | "function";  // 加 "function"
  };
  request: {
    contentLen: number;
    trustLevel: number;
    title?: string;  // 部署时填 "push mode=merge" / "rotate-kek" / "clean"
  };
  result: "success" | "failure" | "in_progress" | "denied";
  error?: string;
  requestId: string;
  // 新增字段（deploy action 专用）：
  deploySnapshot?: {
    before: Record<string, string>;
    after: Record<string, string>;
    added: string[];
    removed: string[];
    changed: { key: string; before?: string; after?: string }[];
  };
  operator?: string;  // OS username (os.userInfo().username)
}
```

`apps/api/src/lib/collections.ts` 同步扩展：

```typescript
export type AuditAction = "ingest" | "session_rename" | "session_delete" | "nickname_update" | "deploy";
```

## 7. 错误处理

**统一错误类**（`lib/errors.ts`）：
```typescript
export class DeployError extends Error { constructor(msg: string) { super(msg); this.name = "DeployError"; } }
export class KeychainError extends DeployError {}
export class TcbError extends DeployError {}
export class AuditError extends DeployError {}
export class DiffError extends DeployError {}
export class TcbFetchError extends DeployError {}
```

**logger 协议**（`lib/logger.ts`，NDJSON 一行结构化）：

```typescript
// stdout: 可解析 JSON (供其他工具 pipe)
// stderr: 人读 (含颜色)
function emit(level: "info" | "warn" | "error", msg: string, meta?: object): void {
  const json = JSON.stringify({ level, msg, ts: Date.now(), ...meta });
  if (level === "info") process.stdout.write(json + "\n");
  else process.stderr.write(json + "\n");
}
export const logger = {
  info: (msg: string, meta?: object) => emit("info", msg, meta),
  warn: (msg: string, meta?: object) => emit("warn", msg, meta),
  error: (msg: string, meta?: object) => emit("error", msg, meta),
  fatal: (err: unknown) => {
    if (err instanceof Error) {
      emit("error", err.message, { stack: err.stack, name: err.name });
    } else {
      emit("error", String(err));
    }
    process.exit(1);
  },
};
```

**幂等性**：
- `push` 重复跑：Merge 模式下 vars 不变 → diff 空、warnings 空 → 成功
- `push` 在 clean 后跑：Merge 模式会把 6 secrets 加回去 → 正确
- `push` 在 KEK 漂移警告后跑：默认 abort；`--force` 跳过检查

**rollback**：v1 不实现自动 rollback。用户可手动 `deploy status` 看上次状态 + `/tmp/unequal-deploy-PREVIOUS-*.json` 24h 保留可手工恢复。

## 8. 测试

**Unit tests**（vitest，`apps/api/scripts/deploy/__tests__/`）：

| 模块 | 测试数 | mock 范围 |
|---|---|---|
| `keychain.test.ts` | 6 cases: read OK / read fail (status≠0) / read empty stdout / write OK / write fail / write empty value | `spawnSync` |
| `tmp-config.test.ts` | 4 cases: 模板读取 / 合并 envVars / chmod 600 / cleanup 删除 | `fs/promises` |
| `tcb.test.ts` | 3 cases: Merge mode 提示 / Override mode 提示 / expect missing | `spawn` |
| `diff.test.ts` | 8 cases: 纯添加 / 纯删除 / 单 var 改 / KEK_VERSION +1 / KEK_VERSION +5 报警 / force 跳过 / 空 diff / 阈值边界 | 纯函数 |
| `audit.test.ts` | 5 cases: deploy snapshot 写入 / KEK_CURRENT_VERSION 漂移 warning / mode=merge 标记 / operator 字段 / 写失败不阻塞 | SDK mock |

**集成测试**：v1 不写（无 staging 环境）。所有路径靠真接覆盖（state-p4 的做法）。

**真接验收脚本**（`scripts/verify-deploy-pipeline.sh`）：
```bash
#!/usr/bin/env bash
# 1. status → 看云端当前 13 vars
pnpm -F api deploy status

# 2. push (Merge) → 验证 vars 不变、audit 写 1 条
pnpm -F api deploy push

# 3. push --override → 验证 vars 强制重写
pnpm -F api deploy push --override

# 4. push --force → 跳过 KEK_CURRENT_VERSION 检查
pnpm -F api deploy push --force

# 5. rotate-kek --force → 验证 KEK 真的换了 + 6 步 smoke 通过
pnpm -F api deploy rotate-kek --force
# 手动跑 smoke (state-cp6 §4)
pnpm -F api deploy:clean  # 切回 7 vars
```

## 9. Commit 计划（拆 4 个 commit，按依赖顺序）

```
[commit 1] refactor(deploy): 抽 deploy/ 模块 + keychain + tmp-config + tcb
  - 新建 apps/api/scripts/deploy/{index,lib,commands,__tests__}.ts
  - 抽 logger.ts + errors.ts
  - index.ts CLI 入口（先只支持 push + clean + status）
  - 5 个 __tests__/ unit test 文件
  - package.json: deploy / deploy:clean / deploy:push / deploy:status
  - 删 deploy-secrets.ts / deploy-secrets-v2.ts / deploy-clean.ts

[commit 2] feat(deploy): diff + KEK_CURRENT_VERSION 防漂移
  - lib/diff.ts (核心算法 + 单元测试)
  - lib/tcb-fetch.ts (读 audit_log 最新 deploy 记录)
  - push.ts 集成 diff 检查
  - audit.ts 扩展 AuditEntry (action="deploy", deploySnapshot, operator)

[commit 3] feat(deploy): rotate-kek + status command + clean command
  - commands/rotate-kek.ts (新)
  - commands/status.ts (新)
  - commands/clean.ts (从 deploy-clean.ts 迁移)
  - setup-keychain-secrets.sh 加 update 模式（让 rotate-kek 可写）

[commit 4] docs(deploy): verify-deploy-pipeline.sh + state-p4-deploy-pipeline.md
  - scripts/verify-deploy-pipeline.sh
  - docs/superpowers/state-p4-deploy-pipeline.md (验收报告)
  - 跑通真接：status → push → push --override → push --force → rotate-kek → clean
```

## 10. 验收清单

**必达 (commit 4 验收)**：

| 项 | 验证方式 |
|---|---|
| `pnpm -F api deploy status` 输出云端 13 vars（masked secrets） | 真接 |
| `pnpm -F api deploy push` 默认 Merge，diff 空、audit 写 1 条 | 真接 + `tcb db nosql query` |
| `pnpm -F api deploy push --override` 完全替换，diff 含 removed | 真接 |
| `pnpm -F api deploy push --force` 跳过 KEK_CURRENT_VERSION 漂移检查 | 真接 |
| `pnpm -F api deploy rotate-kek --force` 生成新 KEK + Keychain 更新 + push 成功 | 真接 + 6 步 smoke |
| `pnpm -F api deploy clean` 恢复 7 vars 干净版 | 真接 |
| `deploy audit_log` 可查 (tcb db nosql query) | 真接 |
| KEK 轮换后现有数据仍可读 | 6 步 smoke 全 PASS |
| Merge 调试路径：单 var 调试不影响其他 vars | 真接 (--override vs 默认对比) |
| KEK_CURRENT_VERSION 漂移 >2 报警 | 真接 (改 cloudbaserc.json KEK_CURRENT_VERSION="99" 后跑 deploy) |
| 511/511 unit tests PASS（deploy 模块独立 26 tests） | `pnpm -F api test` |
| 旧 `deploy-secrets.ts` / `deploy-secrets-v2.ts` / `deploy-clean.ts` 删除 | `git rm` |

**Nice-to-have (不阻 P4 完成)**：

| 项 | 优先级 |
|---|---|
| 自动 rollback (`/tmp/unequal-deploy-PREVIOUS-*.json` → push 时自动备份 → 失败自动恢复) | v2 |
| 跨平台（Linux secret-tool 替换 security） | P4 #3 |
| Deploy 并发锁 | v2 |
| re-encrypt 旧数据（KEK v1 → v2 迁移） | v2（如果代码开始按 version 选 KEK） |
| Deploy audit 仪表盘（admin UI） | v3 |
| Slack/email 通知（deploy 成功/失败） | v3 |

## 11. 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| `expect "Merge update"` prompt 文案未来 tcb 改 | 中 | deploy 卡死 60s timeout | timeout 给明确错误，提示用户手动跑 |
| tcb CLI 3.5.7 → 4.x 升级后 `db nosql query` 命令签名变 | 低 | audit 读取失败 | 失败只 stderr 报警，不阻塞 deploy |
| `KEK_CURRENT_VERSION` 真要按 version 选 KEK（未来） | 中（方向未定）| 漂移逻辑变复杂 | v1 仅防御性 warning；v2 再 design |
| macOS `security` 命令被 Apple 改 | 极低 | Keychain 读写全失败 | Linux 兼容 (#3 P4 候选) 留路 |
| audit_log collection 缺索引导致 status 查询慢 | 低 | status 命令 5s+ | deploy 脚本里加索引（state-cp7 已加过 audit_log 时间索引） |
| 多个 deploy 并发跑 | 低 | audit_log 顺序乱 | v1 不做并发锁；用户自行保证 |
| `cloudbaserc.json` KEK_CURRENT_VERSION 被人手改 | 中 | 漂移检查误报 | warning 不 abort，只报警（除非 Δ>2） |
| `push` 默认 Merge 让 KEK_CURRENT_VERSION 漂移看不见 | 中 | v1 v2 版本切换时无法感知 | diff 仍会 warn "changed: KEK_CURRENT_VERSION 1 → 2" |
| tcb db nosql query 找不到 audit_log collection 索引 | 低 | status 命令慢 | fail 后 fallback 提示用户 |

## 12. 文件改动清单

**新建**（~880 lines）：
```
apps/api/scripts/deploy/index.ts                                (~80 lines)
apps/api/scripts/deploy/lib/keychain.ts                         (~50 lines)
apps/api/scripts/deploy/lib/tmp-config.ts                       (~60 lines)
apps/api/scripts/deploy/lib/tcb.ts                              (~70 lines)
apps/api/scripts/deploy/lib/tcb-fetch.ts                        (~70 lines)
apps/api/scripts/deploy/lib/diff.ts                             (~80 lines)
apps/api/scripts/deploy/lib/audit.ts                            (~70 lines)
apps/api/scripts/deploy/lib/logger.ts                           (~30 lines)
apps/api/scripts/deploy/lib/errors.ts                           (~20 lines)
apps/api/scripts/deploy/commands/push.ts                        (~80 lines)
apps/api/scripts/deploy/commands/rotate-kek.ts                  (~40 lines)
apps/api/scripts/deploy/commands/clean.ts                       (~40 lines)
apps/api/scripts/deploy/commands/status.ts                       (~60 lines)
apps/api/scripts/deploy/__tests__/keychain.test.ts              (~60 lines)
apps/api/scripts/deploy/__tests__/tmp-config.test.ts            (~50 lines)
apps/api/scripts/deploy/__tests__/tcb.test.ts                   (~40 lines)
apps/api/scripts/deploy/__tests__/diff.test.ts                  (~80 lines)
apps/api/scripts/deploy/__tests__/audit.test.ts                 (~60 lines)
scripts/verify-deploy-pipeline.sh                               (~40 lines)
docs/superpowers/state-p4-deploy-pipeline.md                    (~150 lines)
```

**修改**：
```
apps/api/package.json                       # scripts 改 + 删旧条目
apps/api/scripts/setup-keychain-secrets.sh  # 加 update 模式 (--update <key>)
apps/api/src/lib/audit.ts                   # AuditEntry 扩展
apps/api/src/lib/collections.ts             # AuditAction / ResourceType 联合类型扩展
```

**删除**：
```
apps/api/scripts/deploy-secrets.ts          # 老
apps/api/scripts/deploy-secrets-v2.ts       # 已被 deploy/ 模块替代
apps/api/scripts/deploy-clean.ts            # 已被 deploy clean 命令替代
```

## 13. 与既有 P4 #1 secrets manager 的关系

P4 #1 secrets manager（commit 53fd0f8）已完成 Keychain + /tmp 临时 config 部署。本 spec 是 **P4 #2**（deploy 流程重写），向上扩展：

| 维度 | P4 #1 secrets manager | P4 #2 deploy 流程重写（本 spec） |
|---|---|---|
| 入口 | `pnpm -F api deploy:secrets-v2` | `pnpm -F api deploy <command>` |
| KEK_CURRENT_VERSION 处理 | 自增无感知 | 防漂移警告 + 阈值检查 |
| 轮换脚本 | 手工 5 步（state-cp6 §10.3） | `rotate-kek --force` 一键 |
| Audit log | 无 | deploy snapshot 进 audit_log collection |
| Merge / Override | expect 强制 Override | 默认 Merge + `--override` 切换 |
| Status 查询 | 无 | `deploy status` 看云端 + audit 历史 |

**向前兼容**：现有 `deploy:secrets-v2` alias 保留 1 个版本（用 deprecation warning 提示用新命令），commit 5 之后删除。