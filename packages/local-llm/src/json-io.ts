/**
 * P3-7 种子 URL 库: 通用 JSON 文件原子读写 helper
 *
 * 设计：
 * - `readJsonAtomic<T>(filePath)`：读取 JSON 文件并解析为类型 T；不存在返 null；解析错 throw
 * - `writeJsonAtomic(filePath, data)`：原子写 JSON（writeFileSync to tmp + renameSync to final）
 * - `withFileLock(filePath, fn)`：目录锁（mkdir-as-lock 简化版，单 admin 无并发，v1 简化足够）
 *
 * 跨 apps 共用：admin (SeedsStore 写 JSON) + crawler (seeds-loader 读 JSON) + 未来其他 JSON 配置
 *
 * 原子写说明：
 * - macOS APFS / Linux ext4 的 rename 是原子的（同 fs 内）
 * - tmp + rename 模式：先写 .tmp 后 rename，避免半文件被读到
 * - JSON 序列化前序列化后均 throw 透传（不静默吞错）
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, unlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 读取 JSON 文件并解析。
 * - 文件不存在 → 返 null（调用方判断 default）
 * - 解析错 → throw（含文件名 + 错误位置）
 */
export function readJsonAtomic<T = unknown>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const content = readFileSync(filePath, "utf-8");
  if (content.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(content) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`readJsonAtomic: failed to parse ${filePath}: ${msg}`);
  }
}

/**
 * 原子写 JSON 文件：writeFileSync to .tmp + renameSync to final。
 * - 自动 mkdir parent dir
 * - 序列化错透传
 * - rename 失败时清理 tmp
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = join(dir, `.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  let serialized: string;
  try {
    serialized = JSON.stringify(data, null, 2);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`writeJsonAtomic: JSON.stringify failed for ${filePath}: ${msg}`);
  }
  try {
    writeFileSync(tmpPath, serialized, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    // 清理 tmp（rename 失败的情况）
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`writeJsonAtomic: failed to write ${filePath}: ${msg}`);
  }
}

/**
 * 文件锁（目录锁简化版）：
 * - mkdir(lockDir) 成功 = 拿锁；失败 = 等 + 重试
 * - 单 admin 串行操作 v1 简化足够（无并发）
 * - fn 完成后 rmdir(lockDir)
 *
 * 使用：await withFileLock(filePath, async () => { ... writeJsonAtomic(filePath) ... })
 *
 * 注意：lockDir = `${filePath}.lock/`（避免与 JSON 文件同名冲突）
 */
export async function withFileLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
  const lockDir = `${filePath}.lock`;
  const maxRetries = 50;
  const retryIntervalMs = 20;

  // 拿锁：尝试 mkdir
  for (let i = 0; i < maxRetries; i++) {
    // 确保 lockDir 的 parent 存在（v1 简化：每次 mkdir；多 admin 高并发用 proper-lockfile）
    mkdirSync(dirname(lockDir), { recursive: true });
    try {
      mkdirSync(lockDir);
      break;  // 拿到锁
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`withFileLock: mkdir failed for ${lockDir}: ${msg}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
    }
  }

  try {
    return await fn();
  } finally {
    // 释放锁
    try {
      if (existsSync(lockDir)) {
        rmSync(lockDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup error
    }
  }
}

/**
 * 检查文件存在 + 可读 + 非空（>=1 字节）。
 * 用于 withFileLock 失败重试判断。
 */
export function fileExistsAndNonEmpty(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const stats = statSync(filePath);
    return stats.size > 0;
  } catch {
    return false;
  }
}