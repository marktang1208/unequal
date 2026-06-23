/**
 * lib/errors.ts — 统一错误类
 *
 * DeployError 顶级；子类用于 catch 时精确判断。
 * cli/index.ts 在 top-level catch 时调 logger.fatal(err) — DeployError.name 保留用于日志
 */

export class DeployError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "DeployError";
  }
}

export class TcbError extends DeployError {}
export class TcbFetchError extends DeployError {}
export class DiffError extends DeployError {}
export class AuditError extends DeployError {}
// KeychainError re-exported from keychain.ts to avoid circular import in audit.ts
// (audit.ts uses KeychainError only as instanceof check, so re-export is safe)
// Note: keychain.ts 直接 declare KeychainError，logger.ts 不 import keychain module。
// 如果 audit.ts 要 instanceof KeychainError，import { KeychainError } from "./keychain.js" 即可。