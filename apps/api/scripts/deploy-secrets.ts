/**
 * CP-6.5 (P3.6): 部署脚本 — 注入 4 secrets + IP allowlist 到 CloudBase 函数
 *
 * 用 tcb CLI（`tcb fn deploy --all --force --config-file`）从 gitignored
 * cloudbaserc.smoke.json 部署。CLI 内部走 tcb-api.tencentcloudapi.com（国内
 * DNS 可达），auth 复用 `tcb login` 状态。
 *
 * 用法（需先 `tcb login`）：
 *   # 1. 准备 4 secrets + IP allowlist 到本机 env
 *   export ADMIN_TOKEN=... JWT_SECRET=... MINIMAX_API_KEY=... KEK_SECRET_V1=...
 *   export ADMIN_IP_ALLOWLIST=...
 *
 *   # 2. 跑 deploy:secrets（生成 cloudbaserc.smoke.json + 重 deploy api-router）
 *   pnpm -F api deploy:secrets
 *
 *   # 3. 跑 6 步 smoke（state-cp6.md §4）
 *
 *   # 4. 清理：把 secrets 从云函数 env 清掉（用干净 cloudbaserc.json 重 deploy）
 *   pnpm -F api deploy:clean
 *
 * 幂等：重 deploy 会覆盖已有 env vars；先备份后清理。
 *
 * 替代方案（已废）：
 * - HTTP API `api.cloudbase.tencentcloud.com` — DNS NXDOMAIN
 * - `tcb config update fn --all` — 交互式 prompt 卡 Override/Merge
 *
 * 前置：apps/api/cloudbaserc.json 已存在（7 stable vars 模板）。
 */

import { spawn } from "node:child_process";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SMOKE_CONFIG = "cloudbaserc.smoke.json";
const CLEAN_CONFIG = "cloudbaserc.json";
const CLEAN_BACKUP = "cloudbaserc.clean.bak";

const SECRETS = {
  ADMIN_TOKEN: process.env.ADMIN_TOKEN,
  JWT_SECRET: process.env.JWT_SECRET,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  KEK_SECRET_V1: process.env.KEK_SECRET_V1,
};

const IP_ALLOWLIST = process.env.ADMIN_IP_ALLOWLIST;

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runTcb(args: string[], stdin?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("tcb", args, { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

async function loadBaseConfig(): Promise<Record<string, unknown>> {
  const raw = await readFile(CLEAN_CONFIG, "utf-8");
  return JSON.parse(raw);
}

async function writeSmokeConfig(): Promise<void> {
  // 验证 secrets 必填
  for (const [name, value] of Object.entries(SECRETS)) {
    if (!value) {
      throw new Error(`Missing env var: ${name}`);
    }
  }
  if (!IP_ALLOWLIST) {
    throw new Error("Missing env var: ADMIN_IP_ALLOWLIST");
  }

  const base = await loadBaseConfig();
  const fns = base.functions as Array<Record<string, unknown>>;
  if (!Array.isArray(fns) || fns.length === 0) {
    throw new Error("cloudbaserc.json has no functions array");
  }

  // 把 4 secrets + IP allowlist 合并到第一个函数的 envVariables
  const fn = fns[0];
  const envVars = (fn.envVariables ?? {}) as Record<string, string>;
  fn.envVariables = {
    ...envVars,
    ADMIN_TOKEN: SECRETS.ADMIN_TOKEN!,
    JWT_SECRET: SECRETS.JWT_SECRET!,
    MINIMAX_API_KEY: SECRETS.MINIMAX_API_KEY!,
    KEK_SECRET_V1: SECRETS.KEK_SECRET_V1!,
    ADMIN_IP_ALLOWLIST: IP_ALLOWLIST!,
  };

  await writeFile(SMOKE_CONFIG, JSON.stringify(base, null, 2) + "\n");
  console.log(`  ✅ ${SMOKE_CONFIG} 生成（7 stable + 4 secrets + IP allowlist = 12 vars）`);
}

async function deploySmoke(): Promise<void> {
  console.log("  → tcb --config-file cloudbaserc.smoke.json fn deploy --all --force");
  const r = await runTcb([
    "--config-file", SMOKE_CONFIG,
    "fn", "deploy", "--all", "--force", "--json",
  ]);
  if (r.code !== 0) {
    console.log(`  ❌ deploy 失败 (exit ${r.code})`);
    console.log(r.stdout);
    console.log(r.stderr);
    throw new Error(`tcb fn deploy failed: exit ${r.code}`);
  }
  console.log("  ✅ deploy 成功（api-router 已用 12 vars 重 deploy）");
}

async function main() {
  console.log("[deploy-secrets] 生成 smoke 配置 + 重 deploy api-router");

  await writeSmokeConfig();
  await deploySmoke();

  console.log("\n✅ 4 secrets + IP allowlist 注入完成");
  console.log("\n下一步：");
  console.log("  1. 跑 6 步 smoke（docs/superpowers/state-cp6.md §4）");
  console.log("  2. smoke 通过后跑 pnpm -F api deploy:clean 清 secrets");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
