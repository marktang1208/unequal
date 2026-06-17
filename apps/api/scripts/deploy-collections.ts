/**
 * CP-6: 部署脚本 — 创建 9 个 CloudBase collections（幂等）
 *
 * 用法（用户在 CloudBase 账号实名 + 环境创建后跑）：
 *   1. export TCB_SECRET_ID=<your-api-key>     # API Key 3.0 单 key
 *   2. export TCB_SECRET_KEY=<same-key>        # 同一字符串（API Key 3.0 兼容）
 *   3. export TCB_ENV=<your-env-id>            # CloudBase 控制台 → 环境 ID
 *   4. pnpm tsx scripts/deploy-collections.ts
 *
 * 幂等：已存在的 collection 跳过。
 *
 * 不做的事（spec §10）：
 * - 创建 field index（SDK 无 createIndex API，需 CloudBase 控制台或 HTTP API）
 * - 部署云函数（用 CloudBase CLI 或控制台）
 * - 注入 secrets / vars（用 CloudBase 控制台或 CLI）
 */

import cloudbase from "@cloudbase/node-sdk";
import { COLLECTIONS, REQUIRED_INDEXES, type CollectionName } from "../src/lib/collections.js";

const SECRET_ID = process.env.TCB_SECRET_ID;
const SECRET_KEY = process.env.TCB_SECRET_KEY;
const ENV = process.env.TCB_ENV;

if (!SECRET_ID || !SECRET_KEY || !ENV) {
  console.error("Missing env vars: TCB_SECRET_ID / TCB_SECRET_KEY / TCB_ENV");
  console.error("(API Key 3.0 模式：SECRET_ID 和 SECRET_KEY 传同一个 key 字符串)");
  process.exit(1);
}

async function main() {
  console.log(`[deploy-collections] env=${ENV}`);
  const app = cloudbase.init({
    secretId: SECRET_ID,
    secretKey: SECRET_KEY,
    env: ENV,
  });
  const db = app.database();

  // 1. 创建 9 collection（幂等：已存在跳过）
  for (const [name, value] of Object.entries(COLLECTIONS)) {
    process.stdout.write(`  - ${name} (${value})... `);
    try {
      await (db as unknown as { createCollection: (n: string) => Promise<unknown> }).createCollection(value);
      console.log("✅ created");
    } catch (err: unknown) {
      // 多语言错误码兼容
      const code = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      const isExists =
        code === "DATABASE_COLLECTION_ALREADY_EXIST" ||
        code === "-501000" ||
        msg.includes("already exists") ||
        msg.includes("Table exist") ||
        msg.includes("已存在");
      if (isExists) {
        console.log("⏭  already exists");
      } else {
        console.log(`❌ ${msg}`);
        throw err;
      }
    }
  }

  // 2. 列出 field index 清单（提示用户手动在控制台建）
  console.log("\n[field indexes — 需在 CloudBase 控制台手动建，或用 deploy-indexes.ts HTTP API]:");
  const grouped = new Map<CollectionName, string[]>();
  for (const { collection, field } of REQUIRED_INDEXES) {
    const arr = grouped.get(collection) ?? [];
    arr.push(field);
    grouped.set(collection, arr);
  }
  for (const [coll, fields] of grouped.entries()) {
    console.log(`  ${coll}: ${fields.join(", ")}`);
  }

  console.log("\n✅ 9 collections 创建完成");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});