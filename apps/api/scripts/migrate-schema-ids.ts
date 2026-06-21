/**
 * CP-7-C #6: 数据迁移 — 把历史 records 的 `id` 字段从 "" 改成 = `_id`
 *
 * CP-7-C #4 修了 `db.add()` 让新 doc 自动填 id = _id。但**已有数据**不会自动更新：
 * - document: 5/14 (35%) 有 id==""
 * - chunk:    12/20 (60%) 有 id==""
 * - source:  10/14 (71%) 有 id==""
 * - user:    1/1   (100%) 有 id==""
 * - chat_session: 0/17 (已正确)
 *
 * 用法：
 *   # 1. dry-run（默认；只统计 + dump 备份，不改）
 *   pnpm -F api migrate:schema-ids
 *
 *   # 2. apply（真改）
 *   pnpm -F api migrate:schema-ids --apply
 *
 *   # 3. 回滚（如需）：
 *   #   cat /tmp/migration-backup-{ts}.json | 读 {collection, _id, oldId}，
 *   #   对每条 update $set id=oldId, $unset 不需要
 *
 * 工具：tcb db nosql execute 走 MongoDB protocol（避免本地 SDK init 凭据问题）
 */

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const TCB_ENV = "unequal-d4ggf7rwg82e0900b";

/** 哪些 collection 需要迁移 */
const COLLECTIONS_TO_MIGRATE = ["document", "chunk", "source", "user"] as const;
type CollectionName = (typeof COLLECTIONS_TO_MIGRATE)[number];

interface MigrationEntry {
  collection: CollectionName;
  _id: string;
  oldId: string;
  newId: string;
}

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

interface TcbNosqlResponse {
  data?: { results?: unknown[][] };
}

/** 提取 {results: [...]} 数组中的 docs 列表
 *
 * tcb db nosql execute --json 返：
 *   {
 *     "data": { "results": [[docs...]] }
 *   }
 * 或 count 命令：
 *   {
 *     "data": { "results": [[{ n, ok, ... }]] }
 *   }
 *
 * 我们用整段 JSON.parse 拿 docs。
 */
function extractDocs(stdout: string): Array<Record<string, unknown>> {
  // 跳过 "Loading data..." 等前置 log
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) return [];
  const jsonEnd = stdout.lastIndexOf("}");
  if (jsonEnd < jsonStart) return [];
  const parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1)) as TcbNosqlResponse;
  const outer = parsed.data?.results?.[0];
  if (!Array.isArray(outer)) return [];
  // 区分 count shape（第一个元素是 {n, ok}）和 find shape（第一个元素有 _id）
  if (outer.length === 0) return [];
  if (typeof outer[0] === "object" && outer[0] !== null) {
    if ("_id" in outer[0]) return outer as Array<Record<string, unknown>>;
    if ("n" in outer[0]) return []; // count shape, not docs
  }
  return [];
}

/** 找所有 id=="" 或 id 缺失的 records
 *
 * 注意：MongoDB `find({id: ""})` 只匹配字段存在且 = "" 的记录。
 * 历史数据可能 id 字段**缺失**（不是空字符串），需要 $or 覆盖。
 */
async function findEmptyIdRecords(coll: CollectionName): Promise<Array<Record<string, unknown>>> {
  const filter = {
    $or: [
      { id: "" },
      { id: null },
      { id: { $exists: false } },
    ],
  };
  const cmd = JSON.stringify({ find: coll, filter, limit: 1000 });
  const r = await runTcb([
    "db", "nosql", "execute",
    "-c", JSON.stringify([{ TableName: coll, CommandType: "COMMAND", Command: cmd }]),
    "-e", TCB_ENV,
    "--json",
  ]);
  if (r.code !== 0) {
    throw new Error(`find ${coll} failed: exit ${r.code}\n${r.stderr}`);
  }
  return extractDocs(r.stdout);
}

/** 按 _id update id = _id */
async function applyOne(entry: MigrationEntry): Promise<void> {
  const cmd = JSON.stringify({
    update: entry.collection,
    updates: [
      { q: { _id: entry._id }, u: { $set: { id: entry.newId } }, multi: false },
    ],
  });
  const r = await runTcb([
    "db", "nosql", "execute",
    "-c", JSON.stringify([{ TableName: entry.collection, CommandType: "UPDATE", Command: cmd }]),
    "-e", TCB_ENV,
    "--json",
  ]);
  if (r.code !== 0) {
    throw new Error(`update ${entry.collection}/${entry._id} failed: exit ${r.code}\n${r.stderr}`);
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const mode = apply ? "APPLY" : "DRY-RUN";
  console.log(`[migrate-schema-ids] mode: ${mode}`);
  console.log(`  target collections: ${COLLECTIONS_TO_MIGRATE.join(", ")}`);
  console.log(`  env: ${TCB_ENV}`);

  // 1. 扫描所有 collection
  const allEntries: MigrationEntry[] = [];
  for (const coll of COLLECTIONS_TO_MIGRATE) {
    const docs = await findEmptyIdRecords(coll);
    console.log(`  ${coll}: ${docs.length} records with id==""`);
    for (const d of docs) {
      const _id = String(d._id ?? "");
      if (!_id) continue;
      allEntries.push({
        collection: coll,
        _id,
        oldId: "",
        newId: _id,
      });
    }
  }

  console.log(`\n  TOTAL: ${allEntries.length} records to migrate`);

  if (allEntries.length === 0) {
    console.log("✅ 无需迁移（所有 id 字段已正确）");
    return;
  }

  // 2. dump 备份（dry-run 也 dump，apply 前给你备份）
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = `/tmp/migration-backup-${ts}.json`;
  const backup = {
    timestamp: new Date().toISOString(),
    mode,
    env: TCB_ENV,
    note: apply
      ? "回滚：读此文件，对每条 update $set id=oldId"
      : "dry-run，未应用；apply 时会重新 dump",
    entries: allEntries,
  };
  writeFileSync(backupFile, JSON.stringify(backup, null, 2));
  console.log(`  📦 备份 dump: ${backupFile}`);

  if (!apply) {
    console.log(`\n  👀 详细变更：`);
    for (const e of allEntries.slice(0, 10)) {
      console.log(`    ${e.collection}/${e._id}  id: "" → "${e.newId}"`);
    }
    if (allEntries.length > 10) {
      console.log(`    ... (共 ${allEntries.length} 条，详见 ${backupFile})`);
    }
    console.log(`\n  确认无误后跑：pnpm -F api migrate:schema-ids --apply`);
    return;
  }

  // 3. apply：按 collection 分批 update（每批 ≤ 100 records）
  console.log(`\n  开始 update ${allEntries.length} records ...`);
  let ok = 0;
  let fail = 0;
  for (const e of allEntries) {
    try {
      await applyOne(e);
      ok++;
      if (ok % 5 === 0) console.log(`    [${ok}/${allEntries.length}] updated`);
    } catch (err) {
      fail++;
      console.error(`    ❌ ${e.collection}/${e._id} 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n  ✅ apply 完成：${ok} 成功 / ${fail} 失败`);
  console.log(`  📦 备份仍在：${backupFile}（含 ${allEntries.length} 条 entry，可回滚）`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
