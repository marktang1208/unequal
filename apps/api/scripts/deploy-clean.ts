/**
 * CP-6.5 (P3.6): 清理脚本 — 把 api-router env vars 恢复到干净版（7 vars）
 *
 * smoke 跑完后用。重 deploy api-router 用 cloudbaserc.json（7 stable vars），
 * 把 4 secrets + IP allowlist 从云函数 env 清掉。
 *
 * 用法：
 *   pnpm -F api deploy:clean
 *
 * 幂等：重复跑无副作用（始终是 7 vars 干净版）。
 */

import { spawn } from "node:child_process";

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runTcb(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("tcb", args, { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

async function main() {
  console.log("[deploy-clean] 恢复 api-router 到 7 vars 干净版");
  console.log("  → tcb fn deploy --all --force （用 cloudbaserc.json 7 vars）");
  const r = await runTcb([
    "fn", "deploy", "--all", "--force", "--json",
  ]);
  if (r.code !== 0) {
    console.log(`  ❌ deploy 失败 (exit ${r.code})`);
    console.log(r.stdout);
    console.log(r.stderr);
    throw new Error(`tcb fn deploy failed: exit ${r.code}`);
  }
  console.log("  ✅ 7 vars 干净版已 deploy");
  console.log("\n✅ secrets + IP allowlist 已从云函数 env 清除");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
