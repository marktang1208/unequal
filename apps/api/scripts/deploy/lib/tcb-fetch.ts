/**
 * lib/tcb-fetch.ts — 读 CloudBase audit_log 最新 deploy snapshot
 *
 * tcb CLI 3.5.7 没"列出云函数当前 env vars"命令。
 * 做法：从 audit_log collection 读最近一条 action="deploy" 记录，里面 deploySnapshot.after
 *      = 上次 push 的完整 vars。
 *
 * 首次 deploy 容错：query 无结果 → 抛 TcbFetchError，调用方 fallback 到本地模板。
 */

import { spawnSync } from "node:child_process";
import { TcbFetchError } from "./errors.js";
import type { EnvSnapshot } from "./diff.js";

const TCB_ENV = "unequal-d4ggf7rwg82e0900b";

interface AuditQueryResult {
  data?: Array<{
    timestamp: number;
    deploySnapshot?: { after?: Record<string, string> };
  }>;
}

export function getRemoteEnvSnapshot(envId: string = TCB_ENV): EnvSnapshot {
  const query = JSON.stringify({
    filter: { action: "deploy" },
    sort: { timestamp: -1 },
    limit: 1,
  });

  const r = spawnSync(
    "tcb",
    [
      "db", "nosql", "query",
      "--env-id", envId,
      "--direct", query,
    ],
    { encoding: "utf-8" },
  );

  if (r.status !== 0) {
    throw new TcbFetchError(
      `tcb db nosql query failed (status ${r.status}): ${r.stderr?.trim() ?? "unknown error"}`,
    );
  }

  let data: AuditQueryResult;
  try {
    data = JSON.parse(r.stdout);
  } catch (err) {
    throw new TcbFetchError(`tcb db nosql query returned invalid JSON: ${r.stdout?.slice(0, 200)}`);
  }

  const latest = data?.data?.[0];
  if (!latest?.deploySnapshot?.after) {
    throw new TcbFetchError(
      "No previous deploy snapshot found in audit_log; cannot determine remote env. Run a full deploy first.",
    );
  }

  return {
    source: "remote",
    capturedAt: latest.timestamp,
    envVariables: latest.deploySnapshot.after,
  };
}