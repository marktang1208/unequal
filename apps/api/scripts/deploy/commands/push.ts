/**
 * commands/push.ts — push 主流程 (P4 #3: 走 SCF SDK, 替换 tcb CLI)
 *
 * Flow (P4 #3):
 * 1. 读 deploy 前 snapshot (SCF SDK GetFunctionConfiguration / 兜底本地模板)
 * 2. 读 7 secrets from Keychain
 * 3. 写 /tmp 临时 config (备份, 兼容老 audit)
 * 4. SCF SDK setFunctionEnv (替换 tcb config update fn + expect)
 * 5. 真云端 fetch after snapshot (重试 3 次防网络抖)
 * 6. diff + 防漂移检查 (KEK_CURRENT_VERSION Δ>2 abort)
 * 7. 写 audit_log (audit_log collection)
 *
 * 边界：
 * - before snapshot 失败 → 兜底本地模板 (首次 deploy 容错)
 * - after snapshot 失败 → 重试 3 次 (背压 1s/3s/9s)
 * - SCF API 失败 → 抛 DeployError, 旧 config 保留
 * - audit 写失败 → 警告但不阻塞 deploy
 * - KEK_CURRENT_VERSION drift too large → 默认 abort, --force 跳过
 *
 * P4 #3 fallback: TCB_FALLBACK_CLI=true 切回老 tcb CLI 路径 (应急)
 */

import os from "node:os";
import { readFile, readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { keychainGet } from "../lib/keychain.js";
import { makeTmpConfig, cleanupTmp } from "../lib/tmp-config.js";
import { setFunctionEnv } from "../lib/tcb-scf.js";
import { getRemoteEnvSnapshot } from "../lib/tcb-fetch.js";
import { diffEnv, type EnvSnapshot } from "../lib/diff.js";
import { writeDeployAudit } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
import { DeployError, DiffError } from "../lib/errors.js";

/** 7 个 secrets（顺序敏感，IP allowlist 是 config 不是 key）
 *  ADMIN_IP_ALLOWLIST 推荐 CIDR 格式（如 ***REMOVED***.0/24），
 *  避免 IP 漂移时反复更新。CloudBase 支持多 CIDR 逗号分隔。
 *  实际 CIDR 解析在 src/lib/admin-ip-allowlist.ts (P0-#1)。
 */
const SECRETS = [
  "ADMIN_TOKEN",
  "JWT_SECRET",
  "MINIMAX_API_KEY",
  "KEK_SECRET_V1",
  "INGEST_PROXY_SECRET",
  "ADMIN_IP_ALLOWLIST",
  // P5 NLI: 硅基流动 API key
  "SILICONFLOW_API_KEY",
  // P6 Phase 5 真接发现: runtime onnx COS downloader 需要 (cloudbaserc.json
  // env vars 是 cloud function 唯一来源, deploy 阶段 Keychain 注入)
  "CLOUDBASE_SECRET_ID",
  "CLOUDBASE_SECRET_KEY",
  // P8 Phase 1: pgvector connection string (跟 sync-cloudbasrc.ts SECRETS 对齐)
  "PG_CONNECTION_STRING",
] as const;

/** 导出 SECRETS 让 unit test 校验 (防 P6 Phase 5 漂移 bug 重现, state-p8 follow-up #5) */
export const PUSH_SECRETS = SECRETS;

const TCB_ENV = "unequal-d4ggf7rwg82e0900b";
const FUNCTION_NAME = "api-router";
const TEMPLATE_PATH = "cloudbaserc.json";

/** 部署所有 vars = template (14 vars) + 9 Keychain secrets = 23 vars
 *  P4 #3: SCF API set 全 set, 不能再依赖 "Merge 模式保留云端 vars"
 *  → 必须显式构造 23 vars 字典
 */
function buildFullEnvVars(merged: Record<string, string>, templateEnvVars: Record<string, string>): Record<string, string> {
  return { ...templateEnvVars, ...merged };
}

function loadTemplateEnvVars(): Record<string, string> {
  // tsx 跑时 cwd 是 apps/api, cloudbaserc.json 在 repo root
  const candidates = [
    TEMPLATE_PATH,
    join(process.cwd(), "..", "..", TEMPLATE_PATH),
    join(process.cwd(), "..", TEMPLATE_PATH),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, "utf-8"));
      return cfg.functions?.[0]?.envVariables ?? {};
    }
  }
  return {};
}

async function getRemoteEnvSnapshotWithRetry(
  envId: string,
  functionName: string,
  retries: number,
): Promise<EnvSnapshot> {
  let lastErr: unknown;
  const backoffs = [0, 1000, 3000, 9000]; // 首次 + 3 次重试 (1s/3s/9s)
  for (let i = 0; i <= retries; i++) {
    if (backoffs[i]! > 0) {
      logger.info(`[push] ⏳ retry ${i}/${retries} after ${backoffs[i]}ms...`);
      await new Promise((r) => setTimeout(r, backoffs[i]!));
    }
    try {
      return await getRemoteEnvSnapshot(envId, functionName);
    } catch (err) {
      lastErr = err;
      logger.warn(`[push] ⚠️  after snapshot attempt ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new DeployError(`Failed to fetch after snapshot after ${retries + 1} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

export async function push(opts: Record<string, unknown>): Promise<void> {
  const mode: UpdateMode = opts.override ? "override" : "merge";
  logger.info(`[push] mode=${mode} (P4 #3: SCF SDK)`, { cmd: "push", mode });

  // 1. 读 deploy 前 snapshot (SCF SDK)
  let before: EnvSnapshot;
  try {
    before = await getRemoteEnvSnapshot(TCB_ENV, FUNCTION_NAME);
    logger.info(`[push] ✓ before: ${Object.keys(before.envVariables).length} vars from remote (SCF API)`);
  } catch (err) {
    logger.warn(`[push] ⚠️  remote snapshot failed (${err instanceof Error ? err.message : String(err)}), fallback to local template`);
    before = await loadLocalTemplate();
  }

  // 2. 读 7 secrets from Keychain
  const merged: Record<string, string> = {};
  for (const key of SECRETS) {
    merged[key] = keychainGet(key);
  }
  logger.info(`[push] ✓ ${SECRETS.length} secrets loaded`);

  // 3. 写 /tmp 临时 config + chmod 600 (保留备份用, 兼容老 audit 流程)
  const cfgPath = await makeTmpConfig(merged, TEMPLATE_PATH);
  logger.info(`[push] ✓ tmp config: ${cfgPath}`);

  // 4. SCF SDK setFunctionEnv (替换 tcb config update fn)
  const templateVars = loadTemplateEnvVars();
  const envVars = buildFullEnvVars(merged, templateVars);
  logger.info(`[push] → SCF SDK UpdateFunctionConfiguration (api-router, ${Object.keys(envVars).length} vars = ${Object.keys(templateVars).length} template + ${Object.keys(merged).length} secrets)`);
  const { requestId } = await setFunctionEnv(FUNCTION_NAME, envVars);
  logger.info(`[push] ✓ SCF API 成功 (RequestId: ${requestId})`);

  await cleanupTmp(cfgPath);

  // 5. 真云端 fetch after snapshot (重试 3 次)
  const after = await getRemoteEnvSnapshotWithRetry(TCB_ENV, FUNCTION_NAME, 3);
  logger.info(`[push] ✓ after: ${Object.keys(after.envVariables).length} vars from remote (SCF API)`);

  // 6. diff + 防漂移检查
  const drift = diffEnv(before, after, { forceVersionDrift: !!opts.force });
  if (drift.warnings.length > 0) {
    logger.warn(`[push] ⚠️  ${drift.warnings.length} warning(s):`);
    for (const w of drift.warnings) logger.warn(`  - ${w}`);
    if (!opts.force && drift.warnings.some((w) => w.includes("drift too large"))) {
      throw new DiffError("KEK_CURRENT_VERSION drift exceeded threshold; use --force to override");
    }
  }

  logger.info(
    `[push] ✓ diff: +${drift.added.length} -${drift.removed.length} ~${drift.changed.length} | warnings: ${drift.warnings.length}`,
  );

  // 7. 写 audit_log
  if (!opts["skip-audit"]) {
    try {
      await writeDeployAudit({
        action: "deploy",
        mode,
        before,
        after,
        drift,
        secretsCount: SECRETS.length,
        operator: os.userInfo().username,
      });
      logger.info(`[push] ✓ audit_log written (action=deploy mode=${mode})`);
    } catch (err) {
      logger.warn(`[push] ⚠️  audit write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  logger.info(`[push] ✓ push 完成`);
  logger.info(`[push] operator: ${os.userInfo().username}`);
}

async function loadLocalTemplate(): Promise<EnvSnapshot> {
  const raw = await readFile(TEMPLATE_PATH, "utf-8");
  const cfg = JSON.parse(raw);
  const fn = cfg.functions?.[0];
  return {
    source: "local-template",
    capturedAt: Date.now(),
  envVariables: fn?.envVariables ?? {},
  };
}

/** UpdateMode re-export (clean.ts / rotate-kek.ts 用) */
export type UpdateMode = "merge" | "override";