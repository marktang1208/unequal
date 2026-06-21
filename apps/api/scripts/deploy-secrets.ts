/**
 * CP-7-C #5: 部署脚本 — 注入 4 secrets + IP allowlist 到 CloudBase 函数
 *
 * CLI 3.5.7 行为变化（state-cp7-b §6.3 教训 #7）：
 * - `tcb fn deploy --force` **只更新函数代码**，env vars 不会被更新
 * - 必须单独跑 `tcb config update fn <name>` 推 env vars
 *
 * 本脚本分两步：
 *   Step 1: `tcb fn deploy api-router --force`（推代码，chdir 到 miniprogram 路径）
 *   Step 2: `tcb --config-file cloudbaserc.smoke.json config update fn api-router`（推 env vars）
 *
 * 用法（需先 `tcb login`）：
 *   # 1. 准备 4 secrets + IP allowlist 到本机 env
 *   export ADMIN_TOKEN=... JWT_SECRET=... MINIMAX_API_KEY=... KEK_SECRET_V1=...
 *   export ADMIN_IP_ALLOWLIST=...
 *
 *   # 2. 跑 deploy:secrets（生成 cloudbaserc.smoke.json + 两步 deploy）
 *   pnpm -F api deploy:secrets
 *
 *   # 3. 跑 6 步 smoke（state-cp6.md §4）
 *
 *   # 4. 清理：把 secrets 从云函数 env 清掉
 *   pnpm -F api deploy:clean
 *
 * 幂等：重 deploy 会覆盖已有 env vars。
 *
 * 前置：
 * - apps/api/cloudbaserc.json 已存在（7 stable vars 模板）
 * - deploy:build 已跑（apps/miniprogram/cloudfunctions/api-router/index.js 最新）
 */

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

const SMOKE_CONFIG = "cloudbaserc.smoke.json";
const CLEAN_CONFIG = "cloudbaserc.json";
const TCB_ENV = "unequal-d4ggf7rwg82e0900b";
const FUNC_DIR = "../miniprogram/cloudfunctions/api-router";

const SECRETS = {
  ADMIN_TOKEN: process.env.ADMIN_TOKEN,
  JWT_SECRET: process.env.JWT_SECRET,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  KEK_SECRET_V1: process.env.KEK_SECRET_V1,
};

// CP-7-C #2: ingest proxy secret 也走 smoke config，避免 Override 模式被清
// 用户不提供时跳过（如果纯走 admin path 灌数据可以省）
const INGEST_PROXY_SECRET = process.env.INGEST_PROXY_SECRET;

const IP_ALLOWLIST = process.env.ADMIN_IP_ALLOWLIST;

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

async function loadBaseConfig(): Promise<Record<string, unknown>> {
  const raw = await readFile(CLEAN_CONFIG, "utf-8");
  return JSON.parse(raw);
}

async function writeSmokeConfig(): Promise<void> {
  for (const [name, value] of Object.entries(SECRETS)) {
    if (!value) throw new Error(`Missing env var: ${name}`);
  }
  if (!IP_ALLOWLIST) throw new Error("Missing env var: ADMIN_IP_ALLOWLIST");

  const base = await loadBaseConfig();
  const fns = base.functions as Array<Record<string, unknown>>;
  if (!Array.isArray(fns) || fns.length === 0) {
    throw new Error("cloudbaserc.json has no functions array");
  }

  const fn = fns[0];
  const envVars = (fn.envVariables ?? {}) as Record<string, string>;
  fn.envVariables = {
    ...envVars,
    ADMIN_TOKEN: SECRETS.ADMIN_TOKEN!,
    JWT_SECRET: SECRETS.JWT_SECRET!,
    MINIMAX_API_KEY: SECRETS.MINIMAX_API_KEY!,
    KEK_SECRET_V1: SECRETS.KEK_SECRET_V1!,
    ADMIN_IP_ALLOWLIST: IP_ALLOWLIST!,
    // CP-7-C #2: Override 模式会清所有 env vars，把 INGEST_PROXY_SECRET 也注入保持幂等
    ...(INGEST_PROXY_SECRET ? { INGEST_PROXY_SECRET } : {}),
  };

  await writeFile(SMOKE_CONFIG, JSON.stringify(base, null, 2) + "\n");
  const totalVars = Object.keys(fn.envVariables).length;
  console.log(`  ✅ ${SMOKE_CONFIG} 生成（${totalVars} vars：7 stable + 4 secrets + IP allowlist${INGEST_PROXY_SECRET ? " + INGEST_PROXY_SECRET" : ""}）`);
}

/** Step 1: 推代码（用 --dir 指到 miniprogram 路径；cli 自动从该目录找 index.js） */
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

/** Step 2: 推 env vars（用 smoke config 的 envVariables）
 *
 * CLI 3.5.7 在检测到 env vars 变化时弹 prompt「Override / Merge update」：
 * - Override = 完全替换云端（CP-6 smoke 行为）
 * - Merge = 合并（local 覆盖同名）
 *
 * 用 expect 模拟 tty 自动选 Override（默认第一项 + Enter）。
 */
async function deployEnvVars(): Promise<void> {
  console.log(`  → Step 2: tcb --config-file ${SMOKE_CONFIG} config update fn api-router -e ${TCB_ENV} (auto Override via expect)`);

  // 检查 expect 可用
  const hasExpect = existsSync("/usr/bin/expect") || existsSync("/opt/homebrew/bin/expect");
  if (!hasExpect) {
    throw new Error("`expect` not found in PATH; install via `brew install expect` or run tcb config update manually");
  }

  const cmd = `tcb --config-file ${SMOKE_CONFIG} config update fn api-router -e ${TCB_ENV}`;
  const expectScript = `set timeout 60
spawn ${cmd}
expect "Override update"
send "\\r"
expect eof
exit [lindex [wait] 3]
`;
  const r = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn("expect", ["-c", expectScript], { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
  if (r.code !== 0) {
    console.log(`  ❌ env vars update 失败 (exit ${r.code})`);
    console.log(r.stdout);
    console.log(r.stderr);
    throw new Error(`tcb config update fn failed: exit ${r.code}`);
  }
  console.log("  ✅ env vars update 成功（12 vars 已推）");
}

async function main() {
  console.log("[deploy-secrets] 生成 smoke 配置 + 两步 deploy（代码 + env vars）");

  await writeSmokeConfig();
  await deployCode();
  await deployEnvVars();

  console.log("\n✅ 4 secrets + IP allowlist 注入完成");
  console.log("\n下一步：");
  console.log("  1. 跑 6 步 smoke（docs/superpowers/state-cp6.md §4）");
  console.log("  2. smoke 通过后跑 pnpm -F api deploy:clean 清 secrets");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
