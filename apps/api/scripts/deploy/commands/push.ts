/**
 * commands/push.ts — push 主流程（默认 Merge，可 --override 切换）
 *
 * Flow:
 * 1. 读 deploy 前 snapshot（tcb-fetch / 兜底本地模板）
 * 2. 读 6 secrets from Keychain
 * 3. 写 /tmp 临时 config + chmod 600
 * 4. tcb config update fn (expect 自动选 mode)
 * 5. diff + 防漂移检查（KEK_CURRENT_VERSION Δ>2 abort）
 * 6. 写 audit_log (audit_log collection)
 *
 * 边界：
 * - tcb-fetch 失败 → 兜底本地模板（首次 deploy 容错）
 * - audit 写失败 → 警告但不阻塞 deploy（spec §7）
 * - KEK_CURRENT_VERSION drift too large → 默认 abort，--force 跳过
 */

import os from "node:os";
import { readFile } from "node:fs/promises";
import { keychainGet } from "../lib/keychain.js";
import { makeTmpConfig, cleanupTmp } from "../lib/tmp-config.js";
import { runTcbConfigUpdate, type UpdateMode } from "../lib/tcb.js";
import { getRemoteEnvSnapshot } from "../lib/tcb-fetch.js";
import { diffEnv, type EnvSnapshot } from "../lib/diff.js";
import { writeDeployAudit } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
import { DeployError, DiffError } from "../lib/errors.js";

/** 7 个 secrets（顺序敏感，IP allowlist 是 config 不是 key） */
const SECRETS = [
  "ADMIN_TOKEN",
  "JWT_SECRET",
  "MINIMAX_API_KEY",
  "KEK_SECRET_V1",
  "INGEST_PROXY_SECRET",
  "ADMIN_IP_ALLOWLIST",
  // P5 NLI: 硅基流动 API key
  "SILICONFLOW_API_KEY",
] as const;

const TCB_ENV = "unequal-d4ggf7rwg82e0900b";
const TEMPLATE_PATH = "cloudbaserc.json";

export async function push(opts: Record<string, unknown>): Promise<void> {
  const mode: UpdateMode = opts.override ? "override" : "merge";
  logger.info(`[push] mode=${mode} (use --override to switch)`, { cmd: "push", mode });

  // 1. 读 deploy 前 snapshot
  let before: EnvSnapshot;
  try {
    before = getRemoteEnvSnapshot(TCB_ENV);
    logger.info(`[push] ✓ before: ${Object.keys(before.envVariables).length} vars from remote (audit_log)`);
  } catch (err) {
    logger.warn(`[push] ⚠️  remote snapshot failed (${err instanceof Error ? err.message : String(err)}), fallback to local template`);
    before = await loadLocalTemplate();
  }

  // 2. 读 6 secrets from Keychain
  const merged: Record<string, string> = {};
  for (const key of SECRETS) {
    merged[key] = keychainGet(key);
  }
  logger.info(`[push] ✓ ${SECRETS.length} secrets loaded`);

  // 3. 写 /tmp 临时 config + chmod 600
  const cfgPath = await makeTmpConfig(merged, TEMPLATE_PATH);
  logger.info(`[push] ✓ tmp config: ${cfgPath}`);

  // 4. tcb config update fn (expect 自动选 mode)
  logger.info(`[push] → tcb --config-file <tmp> config update fn api-router -e ${TCB_ENV} (auto ${mode})`);
  const result = await runTcbConfigUpdate(cfgPath, mode, TCB_ENV);
  const lastLines = result.stdout.split("\n").filter((l) => l.trim()).slice(-5);
  for (const line of lastLines) logger.info(`  | ${line.trim()}`);

  await cleanupTmp(cfgPath);

  if (result.code !== 0) {
    logger.error(`[push] ❌ tcb config update fn failed: exit ${result.code}`);
    throw new DeployError(`tcb config update fn failed: exit ${result.code}`);
  }
  logger.info(`[push] ✓ tcb config update fn 成功`);

  // 5. 构建 after snapshot (template + merged secrets)
  const templateRaw = await readFile(TEMPLATE_PATH, "utf-8");
  const templateCfg = JSON.parse(templateRaw);
  const after: EnvSnapshot = {
    source: "remote",
    capturedAt: Date.now(),
    envVariables: { ...(templateCfg.functions?.[0]?.envVariables ?? {}), ...merged },
  };

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