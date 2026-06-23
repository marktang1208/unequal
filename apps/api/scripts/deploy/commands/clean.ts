/**
 * commands/clean.ts — 恢复 7 vars 干净版（Override 强制）
 *
 * v1 占位：直接用 cloudbaserc.json 模板推 Override update
 * v1 占位：audit 写空（commit 2 集成）
 */

import os from "node:os";
import { makeTmpConfig, cleanupTmp } from "../lib/tmp-config.js";
import { runTcbConfigUpdate } from "../lib/tcb.js";
import { logger } from "../lib/logger.js";
import { DeployError } from "../lib/errors.js";

const TCB_ENV = "unequal-d4ggf7rwg82e0900b";
const TEMPLATE_PATH = "cloudbaserc.json";

export async function clean(opts: Record<string, unknown>): Promise<void> {
  logger.info(`[clean] 恢复 api-router 到 ${TEMPLATE_PATH} 干净版`);

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
  logger.info(`[clean] operator: ${os.userInfo().username}`);
  logger.info(`[clean] v1 占位: audit 在 commit 2 集成`);
}