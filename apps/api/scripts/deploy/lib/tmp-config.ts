/**
 * lib/tmp-config.ts — mkdtemp /tmp 临时 cloudbaserc.json + chmod 600
 *
 * 抽自 deploy-secrets-v2.ts（state-p4 commit 53fd0f8）。
 *
 * 复用 cloudbaserc.json 模板（保证 KEK_CURRENT_VERSION 等配置不漂移）
 * mergedEnv 覆盖模板里的 envVariables（template 提供 7 stable vars，mergedEnv 加 6 secrets）
 */

import { mkdtemp, writeFile, chmod, unlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeTmpConfig(
  mergedEnv: Record<string, string>,
  templatePath = "cloudbaserc.json",
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "unequal-deploy-"));
  const cfgPath = join(dir, "cloudbaserc.json");

  const template = await readFile(templatePath, "utf-8");
  const cfg = JSON.parse(template);

  for (const fn of cfg.functions ?? []) {
    fn.envVariables = { ...(fn.envVariables ?? {}), ...mergedEnv };
  }
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
  await chmod(cfgPath, 0o600);
  return cfgPath;
}

/** 调完 tcb 后立即 rm 临时 file（双保险：chmod 600 + rm） */
export async function cleanupTmp(cfgPath: string): Promise<void> {
  try {
    await unlink(cfgPath);
    // 同步删父目录（mkdtemp 创建的）
    const dir = cfgPath.replace(/\/[^/]+$/, "");
    if (dir.startsWith(tmpdir())) {
      await unlink(dir).catch(() => {/* rmdir 需要空目录，但可能被 OS 占 — ignore */});
    }
  } catch {
    // 静默忽略（可能已被 OS 自动清 / 并发删了）
  }
}