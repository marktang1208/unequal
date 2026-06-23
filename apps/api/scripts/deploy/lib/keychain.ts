/**
 * lib/keychain.ts — macOS Keychain 读写
 *
 * 抽自 deploy-secrets-v2.ts（state-p4 commit 53fd0f8）。
 *
 * Keychain 项：service="unequal:api-router:<KEY>", account="unequal-deploy"
 * 用 `security find-generic-password -s unequal:api-router:ADMIN_TOKEN -w` 可查询
 *
 * 测试桩：spawnSync 通过 vi.mock("node:child_process") 注入
 */

import { spawnSync } from "node:child_process";
import { DeployError } from "./errors.js";

export const KEYCHAIN_ACCOUNT = "unequal-deploy";
export const KEYCHAIN_PREFIX = "unequal:api-router:";

export class KeychainError extends DeployError {}

/** 从 Keychain 读 secret。无 → 抛 KeychainError */
export function keychainGet(key: string): string {
  const r = spawnSync(
    "security",
    [
      "find-generic-password",
      "-a", KEYCHAIN_ACCOUNT,
      "-s", KEYCHAIN_PREFIX + key,
      "-w",
    ],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new KeychainError(
      `Keychain read failed for ${key} (status ${r.status}): ${r.stderr?.trim() ?? "unknown error"}\n` +
      `Run: pnpm -F api setup:keychain-secrets`,
    );
  }
  const value = r.stdout?.trim() ?? "";
  if (!value) {
    throw new KeychainError(`Keychain read returned empty value for ${key}`);
  }
  return value;
}

/** 写或更新 secret（-U 同名覆盖）。empty value 立即抛错（防止误清） */
export function keychainSet(key: string, value: string): void {
  if (!value) {
    throw new KeychainError(`keychainSet: empty value for ${key}`);
  }
  const r = spawnSync(
    "security",
    [
      "add-generic-password",
      "-a", KEYCHAIN_ACCOUNT,
      "-s", KEYCHAIN_PREFIX + key,
      "-w", value,
      "-U",
    ],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new KeychainError(
      `Keychain write failed for ${key} (status ${r.status}): ${r.stderr?.trim() ?? "unknown error"}`,
    );
  }
}