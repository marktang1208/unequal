/**
 * lib/diff.ts — deploy 前后 vars diff + KEK_CURRENT_VERSION 防漂移
 *
 * spec §4.4: 防止 tcb 服务端 version 自增导致代码读到 KEK_SECRET_V2 但 DB 里只存了 v1 加密数据
 * 阈值 Δ=2 (abs(delta) > 2) 才 abort；Δ=1/-1 是 tcb 自增行为，只 warning
 */

export interface EnvSnapshot {
  source: "remote" | "local-template";
  capturedAt: number;
  envVariables: Record<string, string>;
}

export interface DriftReport {
  added: string[];
  removed: string[];
  changed: { key: string; before: string | undefined; after: string | undefined }[];
  warnings: string[];
}

const KEK_VERSION_DRIFT_THRESHOLD = 2;
const KEK_VERSION_KEY = "KEK_CURRENT_VERSION";

export function diffEnv(
  before: EnvSnapshot,
  after: EnvSnapshot,
  opts: { forceVersionDrift?: boolean } = {},
): DriftReport {
  const beforeVars = before.envVariables;
  const afterVars = after.envVariables;

  const added = Object.keys(afterVars).filter((k) => !(k in beforeVars));
  const removed = Object.keys(beforeVars).filter((k) => !(k in afterVars));
  const changed: DriftReport["changed"] = [];

  // changed 仅包含 before/after 都存在且值不同的 key (added/removed 单独归类)
  for (const k of Object.keys(afterVars)) {
    if (k in beforeVars && beforeVars[k] !== afterVars[k]) {
      changed.push({ key: k, before: beforeVars[k], after: afterVars[k] });
    }
  }

  const warnings: string[] = [];

  // KEK_CURRENT_VERSION 防漂移
  const kBefore = parseInt(beforeVars[KEK_VERSION_KEY] ?? "0", 10);
  const kAfter = parseInt(afterVars[KEK_VERSION_KEY] ?? "0", 10);
  const delta = kAfter - kBefore;
  if (delta === 0) {
    // 无变化，不警告
  } else if (opts.forceVersionDrift) {
    // force 完全跳过 KEK_CURRENT_VERSION 警告
  } else if (Math.abs(delta) > KEK_VERSION_DRIFT_THRESHOLD) {
    warnings.push(
      `${KEK_VERSION_KEY} drift too large: ${kBefore} → ${kAfter} (Δ=${delta}, threshold=${KEK_VERSION_DRIFT_THRESHOLD}). ` +
      `Use --force-version-drift to override.`,
    );
  } else {
    warnings.push(
      `${KEK_VERSION_KEY} changed: ${kBefore} → ${kAfter} (Δ=${delta}). This may be tcb server behavior.`,
    );
  }

  return { added, removed, changed, warnings };
}