/**
 * deploy-steps.ts — 三个 deploy 步骤的隔离抽象
 *
 * 用途: deploy-full 命令按顺序串行调 runBuild → runTcbDeploy → runPush
 * 每个 step 独立可测, 各自抛错让上层决定是否继续
 *
 * P7 follow-up of P6:
 *   - runBuild 调 tsx scripts/deploy-build.ts (esbuild bundle + cpSync nli-assets)
 *   - runTcbDeploy 调 tcb CLI (注意: P4 #3 发现 tcb fn deploy 会 wipe secrets, 必须串 push)
 *   - runPush 调 tsx scripts/deploy/index.ts push (Keychain secrets → SCF API atomic set)
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const API_ROOT = join(__dirname, "..", "..", "..");
const FUNC_DIR = join(API_ROOT, "..", "miniprogram", "cloudfunctions", "api-router");
const TCB_ENV = "unequal-d4ggf7rwg82e0900b";
const FUNCTION_NAME = "api-router";

/** tsx 子进程 promise 化 */
function runTsx(scriptPath: string, args: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", scriptPath, ...args], {
      cwd: API_ROOT,
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptPath} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

/** tcb CLI 子进程 promise 化 */
function runTcbCli(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tcb", args, {
      cwd: API_ROOT,
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tcb ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

/** Step 1: esbuild bundle + cpSync nli-assets + write package.json */
export async function runBuild(): Promise<void> {
  logger.info("[deploy-full] Step 1/3: build (esbuild bundle + nli-assets sync)");
  await runTsx("scripts/deploy-build.ts");
}

/** Step 2: tcb fn deploy 推送 code 到 CloudBase (会 wipe secrets!) */
export async function runTcbDeploy(): Promise<void> {
  logger.info("[deploy-full] Step 2/3: tcb fn deploy (推送 code, ⚠️ wipes secrets)");
  await runTcbCli([
    "fn", "deploy", FUNCTION_NAME,
    "--dir", FUNC_DIR,
    "--force",
  ]);
}

/** Step 3: Keychain secrets → SCF API atomic set (恢复 tcb wipe 的 secrets) */
export async function runPush(opts: { override?: boolean; force?: boolean; skipAudit?: boolean } = {}): Promise<void> {
  logger.info("[deploy-full] Step 3/3: push (Keychain secrets → SCF API, 23 vars atomic set)");
  const args: string[] = [];
  if (opts.override) args.push("--override");
  if (opts.force) args.push("--force");
  if (opts.skipAudit) args.push("--skip-audit");
  await runTsx("scripts/deploy/index.ts", ["push", ...args]);
}

// re-export 常量给 deploy-full 错误信息用
export { TCB_ENV, FUNCTION_NAME };
