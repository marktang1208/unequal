/**
 * deploy-full.ts — bundle + tcb fn deploy + push 一气呵成
 *
 * P7 follow-up of P6 state-p6 §7 P1 candidate:
 *   "deploy pipeline 自动顺序 (tcb fn deploy + pnpm deploy push 一条命令)"
 *
 * 背景 (P4 #3 真接发现):
 *   - tcb fn deploy 推 code 时会 wipe secrets (tcb CLI 3.5.7 已知行为)
 *   - 必须 tcb fn deploy → pnpm deploy push 顺序
 *   - P6 真接 5 次 push 都是这个原因
 *
 * Usage:
 *   pnpm -F api deploy:full                    # 默认: build + tcb + push 三步
 *   pnpm -F api deploy:full --no-build         # 跳过 build + tcb, 只 push (应急/debug)
 *   pnpm -F api deploy:full --skip-push        # build + tcb, 跳过 push (首次没 secret 时用)
 *   pnpm -F api deploy:full --force            # 跳过 KEK drift 检查
 *   pnpm -F api deploy:full --override         # SCF API set 用 Override 而非 Merge
 *
 * 失败处理:
 *   - build 失败 → 抛错, tcb / push 不跑 (secrets 未动, 重跑即可)
 *   - tcb fn deploy 失败 → 抛错, push 不跑 (secrets 未 wipe, 重跑即可)
 *   - push 失败 → 抛错 + 关键提示: tcb 已完成, secrets 已 wipe, 必须重跑
 *     `pnpm -F api deploy:full --no-build` 恢复 secrets
 */

import { runBuild, runTcbDeploy, runPush } from "./deploy-steps.js";
import { logger } from "../lib/logger.js";

export interface DeployFullOptions {
  /** 跳过 build + tcb fn deploy, 只 push */
  noBuild?: boolean;
  /** 跑 build + tcb fn deploy, 跳过 push (首次部署 / dry run) */
  skipPush?: boolean;
  /** 跳过 KEK_CURRENT_VERSION drift 检查 */
  force?: boolean;
  /** SCF API set 用 Override 而非 Merge */
  override?: boolean;
  /** 不写 audit_log */
  skipAudit?: boolean;
}

export async function deployFull(opts: DeployFullOptions = {}): Promise<void> {
  if (opts.noBuild && opts.skipPush) {
    throw new Error("deploy-full: --no-build 和 --skip-push 不能同时设 (没有任何步骤可跑)");
  }

  // 步骤 1 + 2: build + tcb fn deploy
  if (!opts.noBuild) {
    try {
      await runBuild();
    } catch (err) {
      logger.error(`[deploy-full] ❌ Step 1/3 build failed: ${err instanceof Error ? err.message : String(err)}`);
      logger.error(`[deploy-full]    secrets 未变动, 修 build 错后重跑即可`);
      throw err;
    }

    try {
      await runTcbDeploy();
    } catch (err) {
      logger.error(`[deploy-full] ❌ Step 2/3 tcb fn deploy failed: ${err instanceof Error ? err.message : String(err)}`);
      logger.error(`[deploy-full]    secrets 未 wipe, 修后重跑 deploy:full 即可`);
      throw err;
    }
  } else {
    logger.info("[deploy-full] --no-build: 跳过 build + tcb fn deploy, 直接 push");
  }

  // 步骤 3: push
  if (!opts.skipPush) {
    try {
      await runPush({
        override: opts.override,
        force: opts.force,
        skipAudit: opts.skipAudit,
      });
      logger.info("[deploy-full] ✅ Step 3/3 push complete, 23 vars atomic set");
    } catch (err) {
      const originalMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[deploy-full] ❌ Step 3/3 push failed: ${originalMsg}`);
      logger.error(`[deploy-full]    ⚠️ tcb fn deploy 已完成, secrets 已 wipe!`);
      logger.error(`[deploy-full]    💡 恢复命令: pnpm -F api deploy:full --no-build`);
      // 把恢复提示塞进抛出的 error message, 让 catch 的人 / 测试 能直接看到
      throw new Error(`push failed (secrets wiped, 重跑 deploy:full --no-build 恢复): ${originalMsg}`, {
        cause: err,
      });
    }
  } else {
    logger.info("[deploy-full] --skip-push: build + tcb 已完成, secrets 已 wipe, 必须手动跑 push:");
    logger.info("[deploy-full]    pnpm -F api deploy push");
  }

  logger.info("[deploy-full] ✅ ALL DONE (build + tcb + push)");
}
