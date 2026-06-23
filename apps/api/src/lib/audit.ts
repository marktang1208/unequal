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
  /** P4 #2 deploy pipeline: 加 "deploy" 枚举 */
  action: "ingest" | "session_rename" | "session_delete" | "nickname_update" | "deploy";
  actor: {
    /** P4 #2 deploy pipeline: 加 "deploy_script"（本地 deploy CLI） */
    via: "admin_token" | "admin_jwt" | "ingest_proxy" | "jwt_user" | "deploy_script";
    clientIp: string;
    tokenFingerprint?: string;
    /** M7-C: 越权 / 非 admin 路径需记当前 userId */
    userId?: string;
  };
  target: {
    userId: string;
    sourceId?: string;
    documentId?: string;
    chunksInserted?: number;
    /** M7-C: 越权审计用 */
    resourceId?: string;
    /** P4 #2 deploy pipeline: 加 "function"（deploy 行为的目标资源） */
    resourceType?: "chat_session" | "user" | "document" | "chunk" | "source" | "function";
  };
  request: {
    contentLen: number;
    trustLevel: number;
    title?: string;
  };
  /** M7-C: 加 "denied" 表示越权 attempt（owner check 失败） */
  result: "success" | "failure" | "in_progress" | "denied";
  error?: string;
  requestId: string;
  /** P4 #2 deploy pipeline: deploy action 专用 — 记录 deploy 前后 vars diff */
  deploySnapshot?: {
    before: Record<string, string>;
    after: Record<string, string>;
    added: string[];
    removed: string[];
    changed: { key: string; before?: string; after?: string }[];
  };
  /** P4 #2 deploy pipeline: deploy action 专用 — 操作者 OS username (os.userInfo().username) */
  operator?: string;
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