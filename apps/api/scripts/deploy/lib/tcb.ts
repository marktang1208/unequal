/**
 * lib/tcb.ts — expect 跑 tcb config update fn（Merge / Override 二选一）
 *
 * 抽自 deploy-secrets-v2.ts（state-p4 commit 53fd0f8）。
 *
 * tcb CLI 3.5.7 行为：
 * - `tcb config update fn <name>` 检测到 env vars 变化时弹 prompt
 *   「Override update」(完全替换) / 「Merge update」(合并)
 * - 用 expect 模拟 tty 自动选
 *
 * 默认 Merge（保云端其他 vars），--override 走 Override。
 *
 * 坑：tcb 未来 prompt 文案改了 expect 会卡死 60s timeout → 暴露错误让用户反馈
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { TcbError } from "./errors.js";

export type UpdateMode = "merge" | "override";

export interface TcbResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runTcbConfigUpdate(
  cfgPath: string,
  mode: UpdateMode,
  envId: string,
): Promise<TcbResult> {
  if (!existsSync("/usr/bin/expect") && !existsSync("/opt/homebrew/bin/expect")) {
    throw new TcbError("`expect` not found; install via `brew install expect`");
  }

  // CLI 3.5.7 提示文案：「Override update」「Merge update」
  const prompt = mode === "merge" ? "Merge update" : "Override update";
  const expectScript = `set timeout 60
spawn tcb --config-file ${cfgPath} config update fn api-router -e ${envId}
expect "${prompt}"
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