/**
 * CP-6.5 (P3.5): 部署脚本 — 创建 9 个 collection 的 field indexes（幂等）
 *
 * 用 tcb CLI（`tcb db nosql execute`）+ MongoDB createIndexes 命令。CLI 内部
 * 走腾讯云 API 端点（tcb-api.tencentcloudapi.com），DNS 在国内可达；不需要
 * SDK、不需要 access token。
 *
 * 用法（需先 `tcb login` + 当前目录有 cloudbaserc.json 或显式 -e）：
 *   pnpm -F api deploy:indexes
 *
 * 幂等：MongoDB createIndexes 已存在返回 "all indexes already exist" note。
 *
 * 不做的事：
 * - 创建 collection（用 deploy-collections.ts）
 * - 部署云函数 / secrets（用 tcb CLI 其他子命令）
 *
 * 替代方案（已废）：
 * - HTTP API `api.cloudbase.tencentcloud.com` — DNS NXDOMAIN，国内不可达
 * - CAM 永久 key + SDK — SIGN_PARAM_INVALID
 */

import { spawn } from "node:child_process";
import { REQUIRED_INDEXES } from "../src/lib/collections.js";

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

interface IndexResult {
  collection: string;
  field: string;
  ok: boolean;
  created: boolean;
  error?: string;
}

async function createIndex(collection: string, field: string): Promise<IndexResult> {
  const cmd = JSON.stringify([{
    TableName: collection,
    CommandType: "COMMAND",
    Command: JSON.stringify({
      createIndexes: collection,
      indexes: [{ key: { [field]: 1 }, name: `idx_${field}` }],
    }),
  }]);
  const r = await runTcb(["db", "nosql", "execute", "--command", cmd]);
  const out = r.stdout + r.stderr;
  if (r.code === 0) {
    const created = !out.includes("already exist");
    return { collection, field, ok: true, created };
  }
  if (out.includes("already exist") || out.includes("IndexOptionsConflict")) {
    return { collection, field, ok: true, created: false };
  }
  return { collection, field, ok: false, created: false, error: out.slice(0, 200) };
}

async function main() {
  console.log("[deploy-indexes] via tcb db nosql execute");

  let created = 0;
  let existed = 0;
  let fail = 0;
  for (const { collection, field } of REQUIRED_INDEXES) {
    process.stdout.write(`  - ${collection}.${field}... `);
    const r = await createIndex(collection, field);
    if (!r.ok) {
      console.log(`❌ ${r.error}`);
      fail++;
    } else if (r.created) {
      console.log("✅ created");
      created++;
    } else {
      console.log("⏭  already exists");
      existed++;
    }
  }

  console.log(`\n${created} created, ${existed} already exist, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
