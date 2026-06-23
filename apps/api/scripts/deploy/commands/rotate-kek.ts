/**
 * commands/rotate-kek.ts — KEK 轮换（占位）
 *
 * v1 占位：generate KEK + write Keychain + push 子流程
 * 当前 commit 1 不实现，commit 3 实现。
 */

import { logger } from "../lib/logger.js";

export async function rotateKek(_opts: Record<string, unknown>): Promise<void> {
  logger.warn(`[rotate-kek] ❌ Not yet implemented in commit 1; will be added in commit 3`);
  throw new Error("rotate-kek not yet implemented");
}