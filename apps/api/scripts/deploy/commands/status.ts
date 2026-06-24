/**
 * commands/status.ts — 查云端 env vars (tcb-fetch) + 列出最近 10 条 deploy audit
 *
 * tcb db nosql query 读 audit_log:
 *   filter { action: "deploy" }
 *   sort { timestamp: -1 }
 *   limit 10
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { getRemoteEnvSnapshot } from "../lib/tcb-fetch.js";
import { logger } from "../lib/logger.js";
import { TcbFetchError } from "../lib/errors.js";

const TCB_ENV = "unequal-d4ggf7rwg82e0900b";
const TEMPLATE_PATH = "cloudbaserc.json";

const SECRET_KEYS = new Set([
  "ADMIN_TOKEN",
  "JWT_SECRET",
  "MINIMAX_API_KEY",
  "KEK_SECRET_V1",
  "INGEST_PROXY_SECRET",
]);

function maskValue(key: string, value: string): string {
  if (SECRET_KEYS.has(key)) {
    return `${value.slice(0, 4)}...${value.slice(-4)} (${value.length})`;
  }
  return value;
}

interface DeployAuditEntry {
  id: string;
  /** tcb Mongo 输出 timestamp 形如 { "$numberLong": "1782194000000" } 或纯 number */
  timestamp: number | { $numberLong?: string; $numberInt?: string };
  action: string;
  actor: { via: string; userId?: string; clientIp: string };
  request: { title?: string };
  operator?: string;
  deploySnapshot?: {
    added?: string[];
    removed?: string[];
    changed?: { key: string }[];
  };
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

function queryDeployAudit({ envId, limit }: { envId: string; limit: number }): DeployAuditEntry[] {
  const mongoCommand = JSON.stringify([
    {
      TableName: "audit_log",
      CommandType: "QUERY",
      Command: JSON.stringify({
        find: "audit_log",
        filter: { action: "deploy" },
        sort: { timestamp: -1 },
        limit,
      }),
    },
  ]);

  const r = spawnSync(
    "tcb",
    [
      "db", "nosql", "execute",
      "--command", mongoCommand,
    ],
    { encoding: "utf-8" },
  );

  if (r.status !== 0) {
    logger.warn(`[status] audit query failed: ${r.stderr?.trim() ?? "unknown error"}`);
    return [];
  }

  try {
    // 真实输出前 4 行是 banner / 进度，从第一个 '[' 开始解析
    const stdout = r.stdout ?? "";
    const firstBracket = stdout.indexOf("[");
    if (firstBracket < 0) {
      logger.warn(`[status] audit query returned no JSON array`);
      return [];
    }
    const data = JSON.parse(stdout.slice(firstBracket));
    return Array.isArray(data) ? (data as DeployAuditEntry[]) : [];
  } catch {
    logger.warn(`[status] audit query returned invalid JSON`);
    return [];
  }
}

export async function status(_opts: Record<string, unknown>): Promise<void> {
  // 1. 读当前云端 env vars
  console.log(`\n[status] === Current cloud env vars ===`);
  try {
    const current = await getRemoteEnvSnapshot(TCB_ENV);
    console.log(`[status] Source: remote (SCF API GetFunctionConfiguration)`);
    console.log(`[status] Captured: ${new Date(current.capturedAt).toISOString()}`);
    console.log(`[status] Vars (${Object.keys(current.envVariables).length}):`);
    for (const [k, v] of Object.entries(current.envVariables)) {
      console.log(`  ${k} = ${maskValue(k, String(v))}`);
    }
  } catch (err) {
    if (err instanceof TcbFetchError) {
      console.log(`[status] ⚠️  ${err.message}`);
      console.log(`[status] Falling back to local template:`);
      const raw = await readFile(TEMPLATE_PATH, "utf-8");
      const cfg = JSON.parse(raw);
      const envVars = cfg.functions?.[0]?.envVariables ?? {};
      console.log(`[status] Vars (${Object.keys(envVars).length}):`);
      for (const [k, v] of Object.entries(envVars)) {
        console.log(`  ${k} = ${maskValue(k, String(v))}`);
      }
    } else {
      throw err;
    }
  }

  // 2. 列出最近 10 条 deploy audit
  console.log(`\n[status] === Recent deploys ===`);
  const history = queryDeployAudit({ envId: TCB_ENV, limit: 10 });
  if (history.length === 0) {
    console.log(`[status] (no deploy audit records found)`);
  } else {
    for (const entry of history) {
      const tsMs = unMongoNumber(entry.timestamp);
      const ts = tsMs > 0 ? new Date(tsMs).toISOString() : "(no timestamp)";
      const added = entry.deploySnapshot?.added?.length ?? 0;
      const removed = entry.deploySnapshot?.removed?.length ?? 0;
      const changed = entry.deploySnapshot?.changed?.length ?? 0;
      const title = entry.request.title ?? entry.action;
      const operator = entry.operator ? ` op=${entry.operator}` : "";
      console.log(`  ${ts} | ${title}${operator} | Δ +${added} -${removed} ~${changed}`);
    }
  }
  logger.info(`[status] done`);
}