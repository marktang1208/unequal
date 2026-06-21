/**
 * CP-7-C #5: 清理脚本 — 把 api-router env vars 恢复到干净版（7 vars）
 *
 * smoke 跑完后用。两步 deploy（对齐 CLI 3.5.7 行为，state-cp7-b §6.3 教训 #7）：
 *   Step 1: 推代码（chdir 到 miniprogram 路径，强制覆盖）
 *   Step 2: 用 cloudbaserc.json（7 stable vars）推 env vars → 把 4 secrets + IP allowlist 清掉
 *
 * 用法：
 *   pnpm -F api deploy:clean
 *
 * 幂等：重复跑无副作用（始终是 7 vars 干净版）。
 */

import { spawn } from "node:child_process";

const TCB_ENV = "unequal-d4ggf7rwg82e0900b";
const FUNC_DIR = "../miniprogram/cloudfunctions/api-router";

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runTcb(args: string[], cwd?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("tcb", args, {
      env: process.env,
      ...(cwd ? { cwd } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

async function deployCode(): Promise<void> {
  console.log(`  → Step 1: tcb fn deploy api-router --dir ${FUNC_DIR} -e ${TCB_ENV} --force`);
  const r = await runTcb([
    "fn", "deploy", "api-router",
    "--dir", FUNC_DIR,
    "-e", TCB_ENV,
    "--force",
  ]);
  if (r.code !== 0) {
    console.log(`  ❌ 代码 deploy 失败 (exit ${r.code})`);
    console.log(r.stdout);
    console.log(r.stderr);
    throw new Error(`tcb fn deploy failed: exit ${r.code}`);
  }
  console.log("  ✅ 代码 deploy 成功");
}

async function resetEnvVars(): Promise<void> {
  console.log(`  → Step 2: tcb --config-file cloudbaserc.json config update fn api-router -e ${TCB_ENV} (7 stable vars)`);
  const r = await runTcb([
    "--config-file", "cloudbaserc.json",
    "config", "update", "fn", "api-router",
    "-e", TCB_ENV,
  ]);
  if (r.code !== 0) {
    console.log(`  ❌ env vars reset 失败 (exit ${r.code})`);
    console.log(r.stdout);
    console.log(r.stderr);
    throw new Error(`tcb config update fn failed: exit ${r.code}`);
  }
  console.log("  ✅ env vars reset 到 7 stable vars（secrets 已清）");
}

async function main() {
  console.log("[deploy-clean] 恢复 api-router 到 7 vars 干净版（两步）");

  await deployCode();
  await resetEnvVars();

  console.log("\n✅ secrets + IP allowlist 已从云函数 env 清除");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
