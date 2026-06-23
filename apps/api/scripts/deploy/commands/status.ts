/**
 * commands/status.ts — 查云端 env vars（v1 兜底本地模板）+ 占位 audit 历史
 *
 * v1 占位：远程 snapshot 走 tcb-fetch（commit 2 集成）
 * v1 占位：audit 历史走 queryDeployAudit（commit 2 集成）
 */

import { readFile } from "node:fs/promises";
import { logger } from "../lib/logger.js";

const TEMPLATE_PATH = "cloudbaserc.json";

const SECRET_KEYS = new Set([
  "ADMIN_TOKEN",
  "JWT_SECRET",
  "MINIMAX_API_KEY",
  "KEK_SECRET_V1",
  "INGEST_PROXY_SECRET",
]);

function maskValue(key: string, value: string): string {
  if (SECRET_KEYS.has(key)) {
    return `${value.slice(0, 4)}...${value.slice(-4)} (${value.length})`;
  }
  return value;
}

export async function status(_opts: Record<string, unknown>): Promise<void> {
  logger.info(`[status] v1: 读本地 ${TEMPLATE_PATH} 模板（commit 2 改为 audit_log 最新 deploy snapshot）`);

  const raw = await readFile(TEMPLATE_PATH, "utf-8");
  const cfg = JSON.parse(raw);
  const envVars = cfg.functions?.[0]?.envVariables ?? {};

  console.log(`\n[status] Local cloudbaserc.json template (${Object.keys(envVars).length} vars):`);
  for (const [k, v] of Object.entries(envVars)) {
    console.log(`  ${k} = ${maskValue(k, String(v))}`);
  }

  console.log(`\n[status] Recent deploys: 0 (v1 占位，commit 2/3 集成 queryDeployAudit)`);
  logger.info(`[status] v1 占位: 远程 snapshot + audit 历史在 commit 2/3 集成`);
}