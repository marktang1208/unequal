/**
 * CP-6: 部署脚本 — 创建 9 个 collection 的 field indexes（HTTP API）
 *
 * CloudBase Node SDK 没暴露 createIndex API；用 HTTP REST API（管理 API）。
 * 用户从 CloudBase 控制台 → 用户管理 → API 密钥管理拿 access token。
 *
 * 用法：
 *   export TCB_ACCESS_TOKEN=<api-access-token>   # CloudBase 控制台 → API 密钥管理
 *   export TCB_ENV=<env-id>                       # CloudBase 控制台 → 环境 ID
 *   pnpm tsx scripts/deploy-indexes.ts
 */

import { REQUIRED_INDEXES } from "../src/lib/collections.js";

const ACCESS_TOKEN = process.env.TCB_ACCESS_TOKEN;
const ENV = process.env.TCB_ENV;

if (!ACCESS_TOKEN || !ENV) {
  console.error("Missing env vars: TCB_ACCESS_TOKEN / TCB_ENV");
  process.exit(1);
}

const API_BASE = "https://api.cloudbase.tencentcloud.com/v2/database";

interface IndexInfo {
  collection: string;
  field: string;
}

async function createIndex(info: IndexInfo): Promise<boolean> {
  const url = `${API_BASE}/${info.collection}/index`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-CloudBase-AccessToken": ACCESS_TOKEN!,
      "X-CloudBase-Env": ENV!,
    },
    body: JSON.stringify({
      IndexName: `idx_${info.field}`,
      Keys: [{ Name: info.field, Direction: "1" }],  // "1" = asc
      Unique: false,
    }),
  });

  if (res.status === 200 || res.status === 201) {
    console.log(`  ✅ ${info.collection}.${info.field}`);
    return true;
  }
  const text = await res.text();
  if (text.includes("already exists") || text.includes("DuplicateKey")) {
    console.log(`  ⏭  ${info.collection}.${info.field} already exists`);
    return true;
  }
  console.log(`  ❌ ${info.collection}.${info.field}: ${res.status} ${text}`);
  return false;
}

async function main() {
  console.log(`[deploy-indexes] env=${ENV}`);

  let ok = 0;
  let fail = 0;
  for (const info of REQUIRED_INDEXES) {
    const success = await createIndex(info);
    if (success) ok++;
    else fail++;
  }

  console.log(`\n${ok} indexes created/exist, ${fail} failed`);
  if (fail > 0) {
    console.error("❌ Some indexes failed to create");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});