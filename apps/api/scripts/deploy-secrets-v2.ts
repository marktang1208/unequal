/**
 * P4 secrets manager — 从 macOS Keychain 读 4 secrets + 1 IP allowlist
 * 写到 /tmp 临时 cloudbaserc.json，调用 tcb config update fn 后立即 rm
 *
 * 设计目标：
 * - secrets 不落 disk 长期文件（/tmp OS 自动清 + chmod 600）
 * - secrets 不进 repo（disk file 立即删 + .gitignore /tmp）
 * - 复用 cloudbaserc.json 的 7 stable vars 模板（保证 KEK_CURRENT_VERSION 等配置不漂移）
 * - 调 tcb expect 处理交互式菜单（deploy:secrets 历史经验）
 *
 * 用法（需先 `tcb login`）：
 *   # 1. 一次性迁移 secrets 到 Keychain
 *   ./scripts/setup-keychain-secrets.sh  # 写 6 条到 Keychain
 *
 *   # 2. 推 production env
 *   pnpm -F api deploy:secrets-v2
 *
 * 对应：
 *   pnpm -F api deploy:clean    # 恢复 7 vars 干净版（无 secrets）
 *
 * 兼容：
 *   - macOS only（用 `security` 命令）
 *   - Linux 需替换 `security` 为 `secret-tool` (libsecret) — P4 待办
 */

import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, unlink, chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const TCB_ENV = "unequal-d4ggf7rwg82e0900b";
const KEYCHAIN_ACCOUNT = "unequal-deploy";
const KEYCHAIN_PREFIX = "unequal:api-router:";

/** 6 个 secrets（顺序敏感，IP allowlist 是 config 不是 key） */
const SECRETS = [
  "ADMIN_TOKEN",
  "JWT_SECRET",
  "MINIMAX_API_KEY",
  "KEK_SECRET_V1",
  "INGEST_PROXY_SECRET",
  "ADMIN_IP_ALLOWLIST",
] as const;

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** 从 macOS Keychain 读 secret。无 → 抛错 */
function keychainGet(key: string): string {
  const r = spawnSync("security", [
    "find-generic-password",
    "-a", KEYCHAIN_ACCOUNT,
    "-s", KEYCHAIN_PREFIX + key,
    "-w",  // 仅输出密码
  ], { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(
      `Keychain read failed for ${key} (status ${r.status}):\n` +
      `  stderr: ${r.stderr.trim()}\n` +
      `  setup: ./scripts/setup-keychain-secrets.sh`,
    );
  }
  return r.stdout.trim();
}

/** 在 /tmp 建临时目录（OS 级，reboot 自动清） */
async function makeTmpConfig(mergedEnv: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "unequal-deploy-"));
  const cfgPath = join(dir, "cloudbaserc.json");

  // 复用根 cloudbaserc.json 模板（保 7 stable vars + installDependency + memorySize 不漂移）
  const template = await readFile("cloudbaserc.json", "utf-8");
  const cfg = JSON.parse(template);

  // merge secrets 到 envVariables
  for (const fn of cfg.functions ?? []) {
    fn.envVariables = { ...(fn.envVariables ?? {}), ...mergedEnv };
  }
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
  await chmod(cfgPath, 0o600);  // owner-only
  return cfgPath;
}

/** 调 expect 跑 tcb config update fn（处理 Override/Merge 交互式菜单） */
async function runTcbConfigUpdate(cfgPath: string): Promise<ExecResult> {
  // 跟原 deploy:secrets.ts 同样 expect 脚本
  const expectScript = `set timeout 60
spawn tcb --config-file ${cfgPath} config update fn api-router -e ${TCB_ENV}
expect "Override update"
send "\\r"
expect eof
exit [lindex [wait] 3]
`;
  return new Promise((resolve, reject) => {
    const child = spawn("expect", ["-c", expectScript], { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

/** 调完 tcb 后立即 rm 临时 file（双保险：chmod 600 + rm） */
async function cleanupTmp(cfgPath: string): Promise<void> {
  try {
    await unlink(cfgPath);
    // 同步删父目录（mkdtemp 创建的）
    const dir = cfgPath.replace(/\/[^/]+$/, "");
    if (dir.startsWith(tmpdir())) {
      await unlink(dir).catch(() => {/* rmdir 需要空目录，但可能被 OS 占 — ignore */});
    }
  } catch (err) {
    console.warn(`[deploy:secrets-v2] cleanup tmp failed:`, err);
  }
}

async function main(): Promise<void> {
  // 平台检查（macOS only — 用 `security` 命令）
  if (process.platform !== "darwin") {
    throw new Error(`deploy:secrets-v2 only supports macOS (uses 'security' command). Current: ${process.platform}`);
  }
  if (!existsSync("/usr/bin/expect") && !existsSync("/opt/homebrew/bin/expect")) {
    throw new Error("`expect` not found in PATH; install via `brew install expect`");
  }

  console.log("[deploy:secrets-v2] 从 Keychain 读 6 secrets + 写 /tmp 临时 config");

  // 1. 读 6 secrets
  const merged: Record<string, string> = {};
  for (const key of SECRETS) {
    merged[key] = keychainGet(key);
  }
  console.log(`  ✓ 6 secrets loaded (lengths: ${SECRETS.map(k => `${k}=${merged[k]!.length}`).join(", ")})`);

  // 2. 写 /tmp 临时 config
  const cfgPath = await makeTmpConfig(merged);
  const statInfo = await stat(cfgPath);
  console.log(`  ✓ tmp config: ${cfgPath} (${statInfo.size} bytes, mode 0600)`);

  // 3. 调 tcb config update fn（expect 自动化）
  console.log("[deploy:secrets-v2] 推 env vars 到 CloudBase api-router");
  const r = await runTcbConfigUpdate(cfgPath);
  // 打印 tcb 输出（让用户看到推了几项）
  const lines = r.stdout.split("\n").filter(l => l.trim());
  for (const line of lines.slice(-5)) {
    console.log(`  | ${line.trim()}`);
  }
  if (r.stderr.trim()) {
    console.log(`  | stderr: ${r.stderr.split("\n").filter(l => l.trim()).slice(-3).join(" / ")}`);
  }

  // 4. 立即清理 tmp
  await cleanupTmp(cfgPath);
  console.log(`  ✓ tmp cleaned`);

  if (r.code !== 0) {
    console.log(`  ❌ tcb config update fn failed (exit ${r.code})`);
    console.log(r.stdout);
    console.log(r.stderr);
    throw new Error(`tcb config update fn failed: exit ${r.code}`);
  }

  console.log("\n✅ 6 secrets 注入完成（production env 含 12 vars）");
  console.log("\n下一步：");
  console.log("  1. 跑真接验证（admin/wx-login/auth-me 等）");
  console.log("  2. 切回干净版：pnpm -F api deploy:clean");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
