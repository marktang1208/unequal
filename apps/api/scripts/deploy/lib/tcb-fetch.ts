/**
 * lib/tcb-fetch.ts — 读 CloudBase audit_log 最新 deploy snapshot
 *
 * tcb CLI 3.5.7 真实命令：
 *   tcb db nosql execute --command '[{"TableName":"audit_log","CommandType":"QUERY","Command":"{...}"}]'
 *
 * 从 audit_log collection 读最近一条 action="deploy" 记录，里面 deploySnapshot.after
 * = 上次 push 的完整 vars。
 *
 * 首次 deploy 容错：query 无结果 → 抛 TcbFetchError，调用方 fallback 到本地模板。
 */

import { spawnSync } from "node:child_process";
import { TcbFetchError } from "./errors.js";
import type { EnvSnapshot } from "./diff.js";

const TCB_ENV = "unequal-d4ggf7rwg82e0900b";

interface AuditDoc {
  timestamp?: number | { $numberLong?: string; $numberInt?: string };
  deploySnapshot?: { after?: Record<string, string> };
}

/** 解 Mongo $numberLong/$numberInt 字符串回 number */
function unMongoNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  if (v && typeof v === "object") {
    const obj = v as { $numberLong?: string; $numberInt?: string };
    if (obj.$numberLong) return parseInt(obj.$numberLong, 10);
    if (obj.$numberInt) return parseInt(obj.$numberInt, 10);
  }
  return 0;
}

/** 包 MongoCommand 成 tcb CLI 3.5.7 期望的 MgoCommands JSON 数组字符串 */
function wrapMongoCommand(tableName: string, commandType: "QUERY" | "INSERT", innerCommand: object): string {
  return JSON.stringify([
    {
      TableName: tableName,
      CommandType: commandType,
      Command: JSON.stringify(innerCommand),
    },
  ]);
}

export function getRemoteEnvSnapshot(envId: string = TCB_ENV): EnvSnapshot {
  const mongoCommand = wrapMongoCommand("audit_log", "QUERY", {
    find: "audit_log",
    filter: { action: "deploy" },
    sort: { timestamp: -1 },
    limit: 1,
  });

  const r = spawnSync(
    "tcb",
    [
      "db", "nosql", "execute",
      "--command", mongoCommand,
    ],
    { encoding: "utf-8" },
  );

  if (r.status !== 0) {
    throw new TcbFetchError(
      `tcb db nosql execute (query) failed (status ${r.status}): ${r.stderr?.trim() ?? "unknown error"}`,
    );
  }

  let docs: AuditDoc[];
  try {
    // 真实输出形如：
    //   CloudBase CLI 3.5.7\nTry ...\n- Loading data...\n- Executing command...\n[{...},{...}]\n
    // 找第一个 '[' 字符位置，从那里解析到末尾
    const stdout = r.stdout ?? "";
    const firstBracket = stdout.indexOf("[");
    if (firstBracket < 0) {
      throw new TcbFetchError(`tcb db nosql execute returned no JSON array: ${stdout.slice(0, 200)}`);
    }
    const json = stdout.slice(firstBracket);
    const parsed = JSON.parse(json);
    docs = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    throw new TcbFetchError(
      `tcb db nosql execute returned invalid JSON: ${r.stdout?.slice(0, 200)}`,
    );
  }

  const latest = docs[0];
  if (!latest?.deploySnapshot?.after) {
    throw new TcbFetchError(
      "No previous deploy snapshot found in audit_log; cannot determine remote env. Run a full deploy first.",
    );
  }

  return {
    source: "remote",
    capturedAt: unMongoNumber(latest.timestamp) || Date.now(),
    envVariables: latest.deploySnapshot.after,
  };
}