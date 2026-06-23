/**
 * commands/clean.ts — 恢复 7 vars 干净版（Override 强制）
 *
 * 直接用 cloudbaserc.json 模板推 Override update
 * 写 audit_log (action=deploy mode=override, note="clean: reset to 7 vars template")
 */

import os from "node:os";
import { readFile } from "node:fs/promises";
import { makeTmpConfig, cleanupTmp } from "../lib/tmp-config.js";
import { runTcbConfigUpdate } from "../lib/tcb.js";
import { writeDeployAudit } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
import { DeployError } from "../lib/errors.js";
import type { EnvSnapshot } from "../lib/diff.js";

const TCB_ENV = "unequal-d4ggf7rwg82e0900b";
const TEMPLATE_PATH = "cloudbaserc.json";

export async function clean(opts: Record<string, unknown>): Promise<void> {
  logger.info(`[clean] 恢复 api-router 到 ${TEMPLATE_PATH} 干净版`);

  // 读模板作为 before snapshot (clean 7 vars)
  const beforeRaw = await readFile(TEMPLATE_PATH, "utf-8");
  const beforeCfg = JSON.parse(beforeRaw);
  const before: EnvSnapshot = {
    source: "local-template",
    capturedAt: Date.now(),
    envVariables: beforeCfg.functions?.[0]?.envVariables ?? {},
  };

  // 直接用 cloudbaserc.json 模板（7 vars），不读 Keychain
  const cfgPath = await makeTmpConfig({}, TEMPLATE_PATH);
  logger.info(`[clean] ✓ tmp config: ${cfgPath} (7 vars)`);

  // clean 必须 Override（Merge 会保留 secrets）
  logger.info(`[clean] → tcb --config-file <tmp> config update fn api-router -e ${TCB_ENV} (auto override)`);
  const result = await runTcbConfigUpdate(cfgPath, "override", TCB_ENV);
  const lastLines = result.stdout.split("\n").filter((l) => l.trim()).slice(-5);
  for (const line of lastLines) logger.info(`  | ${line.trim()}`);

  await cleanupTmp(cfgPath);

  if (result.code !== 0) {
    logger.error(`[clean] ❌ tcb config update fn failed: exit ${result.code}`);
    throw new DeployError(`tcb config update fn failed: exit ${result.code}`);
  }
  logger.info(`[clean] ✓ secrets cleared`);

  // 写 audit_log
  if (!opts["skip-audit"]) {
    try {
      await writeDeployAudit({
        action: "deploy",
        mode: "override",
        note: "clean: reset to 7 vars template",
        before,
        after: before,  // clean 后 vars 与模板一致
        drift: { added: [], removed: [], changed: [], warnings: [] },
        secretsCount: 0,
        operator: os.userInfo().username,
      });
      logger.info(`[clean] ✓ audit_log written (action=deploy note=clean)`);
    } catch (err) {
      logger.warn(`[clean] ⚠️  audit write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  logger.info(`[clean] operator: ${os.userInfo().username}`);
}