/**
 * lib/audit.ts — 写 CloudBase audit_log collection (action="deploy")
 *
 * 复用现有 audit_log 写入能力（spec §6 扩展 AuditEntry）
 * 走 tcb db nosql insert 命令（避免引入 SDK 依赖）
 */

import { spawnSync } from "node:child_process";
import { ulid } from "ulid";
import { AuditError } from "./errors.js";
import type { DriftReport, EnvSnapshot } from "./diff.js";

const TCB_ENV = "unequal-d4ggf7rwg82e0900b";

export interface WriteDeployAuditInput {
  action: "deploy";
  mode: "merge" | "override";
  note?: string;
  before: EnvSnapshot;
  after: EnvSnapshot;
  drift: DriftReport;
  secretsCount: number;
  operator: string;
}

export async function writeDeployAudit(input: WriteDeployAuditInput): Promise<void> {
  const now = Date.now();
  const entry = {
    id: ulid(),
    timestamp: now,
    action: input.action,
    actor: {
      via: "deploy_script",
      clientIp: "localhost",
      userId: "system",
    },
    target: {
      userId: "system",
      resourceType: "function",
    },
    request: {
      contentLen: 0,
      trustLevel: 99,
      title: input.note ?? `${input.action} mode=${input.mode} secrets=${input.secretsCount}`,
    },
    result: "success",
    requestId: ulid(),
    deploySnapshot: {
      before: input.before.envVariables,
      after: input.after.envVariables,
      added: input.drift.added,
      removed: input.drift.removed,
      changed: input.drift.changed,
    },
    operator: input.operator,
  };

  const r = spawnSync(
    "tcb",
    [
      "db", "nosql", "insert",
      "--env-id", TCB_ENV,
      "--direct", JSON.stringify(entry),
    ],
    { encoding: "utf-8" },
  );

  if (r.status !== 0) {
    throw new AuditError(
      `audit write failed (status ${r.status}): ${r.stderr?.trim() ?? "unknown error"}`,
    );
  }
}