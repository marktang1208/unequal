/**
 * CP-7-C #2: Audit log helper
 *
 * 落地：CloudBase `audit_log` collection + stdout JSON 一行
 * - 任何 admin 路径写操作（目前仅 ingest）都应调用
 * - 失败 throw：调用方决定如何响应（ingest 用 500 AUDIT_FAILED）
 * - 测试桩：__setAuditImpl(mockFn) / __resetAuditImpl()
 */

import { ulid } from "ulid";
import { add } from "./db.js";
import { COLLECTIONS } from "./collections.js";

export interface AuditEntry {
  id: string;
  timestamp: number;
  action: "ingest";
  actor: {
    via: "admin_token" | "admin_jwt" | "ingest_proxy";
    clientIp: string;
    tokenFingerprint?: string;
  };
  target: {
    userId: string;
    sourceId?: string;
    documentId?: string;
    chunksInserted?: number;
  };
  request: {
    contentLen: number;
    trustLevel: number;
    title?: string;
  };
  result: "success" | "failure" | "in_progress";
  error?: string;
  requestId: string;
}

type AuditImpl = (entry: AuditEntry) => Promise<void>;

let _impl: AuditImpl | null = null;

/** 默认 impl：写 CloudBase collection + stdout JSON 一行 */
const defaultImpl: AuditImpl = async (entry) => {
  await add(COLLECTIONS.auditLog, entry);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: "info",
      msg: "audit",
      ...entry,
    }),
  );
};

/** 记录一条 audit；任一内部 throw 透传给 caller */
export async function recordAudit(
  entry: Omit<AuditEntry, "id" | "timestamp">,
): Promise<void> {
  validateEntry(entry);

  const full: AuditEntry = {
    ...entry,
    id: ulid(),
    timestamp: Date.now(),
  };

  const impl = _impl ?? defaultImpl;
  await impl(full);
}

/** 测试桩：注入 mock 写入函数 */
export function __setAuditImpl(impl: AuditImpl): void {
  _impl = impl;
}

/** 测试桩：重置为默认 impl */
export function __resetAuditImpl(): void {
  _impl = null;
}

function validateEntry(
  entry: Omit<AuditEntry, "id" | "timestamp">,
): void {
  if (!entry.action) throw new Error("audit: missing action");
  if (!entry.actor?.via) throw new Error("audit: missing actor.via");
  if (!entry.target?.userId) throw new Error("audit: missing target.userId");
  if (!entry.requestId) throw new Error("audit: missing requestId");
}