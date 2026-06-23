/**
 * commands/rotate-kek.ts — KEK 轮换（生成新 KEK + 写 Keychain + push）
 *
 * 用法:
 *   pnpm -F api deploy rotate-kek --force
 *
 * 边界:
 * - 默认需要 --force 确认（破坏性操作）
 * - KEK v1 → v1 不影响派生 KEK（spec §5.2）：旧 chunk 仍可读
 * - 如果未来代码按 version 选 KEK（如 KEK_SECRET_V2），需跑 re-encrypt 迁移（P4 follow-up）
 */

import { execSync } from "node:child_process";
import os from "node:os";
import { keychainSet } from "../lib/keychain.js";
import { push } from "./push.js";
import { logger } from "../lib/logger.js";

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

  // 3. 调用 push 子流程（用新 KEK 推 env vars，--force 跳过 KEK_CURRENT_VERSION 漂移检查）
  await push({ override: false, force: true });

  // 4. 提示用户跑 6 步 smoke
  logger.info(`[rotate-kek] ✓ pushed new KEK to cloud function`);
  logger.info(`[rotate-kek] ⚠️  NEXT: Run 6-step smoke (docs/superpowers/state-cp6.md §4)`);
  logger.info(`[rotate-kek] ⚠️  If existing data encrypted with old KEK is needed, run re-encrypt migration (P4 follow-up)`);
  logger.info(`[rotate-kek] operator: ${os.userInfo().username}`);
}