/**
 * commands/push.ts — push 主流程（默认 Merge，可 --override 切换）
 *
 * Flow:
 * 1. 读 deploy 前 snapshot（从 audit_log 最新 deploy 记录 / 兜底本地模板）
 * 2. 读 6 secrets from Keychain
 * 3. 写 /tmp 临时 config + chmod 600
 * 4. tcb config update fn (expect 自动选 mode)
 * 5. diff + 防漂移检查
 * 6. 写 audit_log
 *
 * v1 占位：snapshot 兜底本地模板（tcb-fetch 模块在 commit 2 集成）
 * v1 占位：diff 写空 DriftReport（diff 模块在 commit 2 集成）
 * v1 占位：audit 写空 record（audit 模块在 commit 2 集成）
 */

import os from "node:os";
import { readFile } from "node:fs/promises";
import { keychainGet, keychainSet } from "../lib/keychain.js";
import { makeTmpConfig, cleanupTmp } from "../lib/tmp-config.js";
import { runTcbConfigUpdate, type UpdateMode } from "../lib/tcb.js";
import { logger } from "../lib/logger.js";
import { DeployError } from "../lib/errors.js";

/** 6 个 secrets（顺序敏感，IP allowlist 是 config 不是 key） */
const SECRETS = [
  "ADMIN_TOKEN",
  "JWT_SECRET",
  "MINIMAX_API_KEY",
  "KEK_SECRET_V1",
  "INGEST_PROXY_SECRET",
  "ADMIN_IP_ALLOWLIST",
] as const;

const TCB_ENV = "unequal-d4ggf7rwg82e0900b";
const TEMPLATE_PATH = "cloudbaserc.json";

export async function push(opts: Record<string, unknown>): Promise<void> {
  const mode: UpdateMode = opts.override ? "override" : "merge";
  logger.info(`[push] mode=${mode} (use --override to switch)`, { cmd: "push", mode });

  // 1. 读 deploy 前 snapshot（v1 兜底：本地模板）
  const before = await loadLocalTemplate();
  logger.info(`[push] before: ${Object.keys(before.envVariables).length} vars (local-template, v1 fallback)`, {
    source: before.source,
  });

  // 2. 读 6 secrets from Keychain
  const merged: Record<string, string> = {};
  for (const key of SECRETS) {
    merged[key] = keychainGet(key);
  }
  logger.info(`[push] ✓ 6 secrets loaded`);

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

  // 5. v1 占位：diff 在 commit 2 集成
  // 6. v1 占位：audit 在 commit 2 集成
  logger.info(`[push] ✓ push 完成（commit 2 将集成 diff + audit_log）`);
  logger.info(`[push] operator: ${os.userInfo().username}`);
}

async function loadLocalTemplate(): Promise<{ source: "local-template"; capturedAt: number; envVariables: Record<string, string> }> {
  const raw = await readFile(TEMPLATE_PATH, "utf-8");
  const cfg = JSON.parse(raw);
  const fn = cfg.functions?.[0];
  return {
    source: "local-template",
    capturedAt: Date.now(),
    envVariables: fn?.envVariables ?? {},
  };
}

// re-export keychainSet for rotate-kek command (避免重复 import 路径)
export { keychainSet };