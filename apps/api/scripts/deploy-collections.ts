/**
 * CP-6.5 (P3.5): 部署脚本 — 创建 9 个 CloudBase collections（幂等）
 *
 * 用 tcb CLI（`tcb db nosql execute`）+ MongoDB create 命令。CLI 内部走腾讯
 * 云 API 端点（tcb-api.tencentcloudapi.com），DNS 在国内可达；不需要 SDK、
 * 不需要 access token。
 *
 * 用法（需先 `tcb login` + 当前目录有 cloudbaserc.json 或显式 -e）：
 *   pnpm -F api deploy:collections
 *
 * 幂等：MongoDB `create` 已存在返回 NamespaceExists 错，自动跳过。
 *
 * 不做的事（spec §10）：
 * - 创建 field index（用 deploy-indexes.ts）
 * - 部署云函数（用 tcb fn deploy 或控制台）
 * - 注入 secrets / vars（用 deploy-secrets.ts）
 *
 * 替代方案（已废）：
 * - HTTP API `api.cloudbase.tencentcloud.com` — DNS NXDOMAIN，国内不可达
 * - CAM 永久 key + SDK — SIGN_PARAM_INVALID
 * - STS 临时凭证 + SDK — 4-6h 实现，仍可能 DNS 受限
 */

import { spawn } from "node:child_process";
import { COLLECTIONS, REQUIRED_INDEXES, type CollectionName } from "../src/lib/collections.js";

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

interface CollectionResult {
  name: string;
  created: boolean;
  existed: boolean;
  error?: string;
}

async function createCollection(name: string): Promise<CollectionResult> {
  const cmd = JSON.stringify([{
    TableName: name,
    CommandType: "COMMAND",
    Command: JSON.stringify({ create: name }),
  }]);
  const r = await runTcb(["db", "nosql", "execute", "--command", cmd]);
  const out = r.stdout + r.stderr;
  if (r.code === 0) return { name, created: true, existed: false };
  if (out.includes("NamespaceExists") || out.includes("already exists")) {
    return { name, created: false, existed: true };
  }
  return { name, created: false, existed: false, error: out.slice(0, 200) };
}

async function main() {
  console.log("[deploy-collections] via tcb db nosql execute");
  let ok = 0;
  let existed = 0;
  let fail = 0;
  for (const [key, value] of Object.entries(COLLECTIONS)) {
    process.stdout.write(`  - ${key} (${value})... `);
    const r = await createCollection(value);
    if (r.created) {
      console.log("✅ created");
      ok++;
    } else if (r.existed) {
      console.log("⏭  already exists");
      existed++;
    } else {
      console.log(`❌ ${r.error}`);
      fail++;
    }
  }

  console.log(`\n${ok} created, ${existed} already exist, ${fail} failed`);
  if (fail > 0) process.exit(1);

  // 列出 field index 清单（提示用户跑 deploy-indexes.ts）
  console.log("\n[field indexes — run scripts/deploy-indexes.ts next]:");
  const grouped = new Map<CollectionName, string[]>();
  for (const { collection, field } of REQUIRED_INDEXES) {
    const arr = grouped.get(collection) ?? [];
    arr.push(field);
    grouped.set(collection, arr);
  }
  for (const [coll, fields] of grouped.entries()) {
    console.log(`  ${coll}: ${fields.join(", ")}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
