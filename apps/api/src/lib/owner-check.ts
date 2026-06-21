/**
 * M7-C: 资源 owner 校验 helper
 *
 * 集中处理「JWT userId != resource ownerUserId」场景：
 * - 失败 → 401 UNAUTHORIZED + audit_log 记录 (result=denied, actor=currentUser, target=resource)
 * - 成功 → 继续 handler 流程
 *
 * 用法：
 *   const result = await assertOwner({
 *     resource: { userId: session.userId, _id: session._id },
 *     currentUserId: userId,
 *     resourceType: "chat_session",
 *     action: "rename",
 *   });
 *   if (!result.ok) return result.response;
 */

import { errorResponse, type HttpTriggerResponse } from "./handler-utils.js";
import { recordAudit, type AuditEntry } from "./audit.js";

export interface AssertOwnerOk {
  ok: true;
}
export interface AssertOwnerDenied {
  ok: false;
  response: HttpTriggerResponse;
}

export interface AssertOwnerOptions {
  resource: { userId: string; _id: string };
  currentUserId: string;
  resourceType: "chat_session" | "user" | "document" | "chunk" | "source";
  action: "session_rename" | "session_delete" | "nickname_update";
  /** 可选：额外 actor 信息（如 scope、clientIp） */
  actor?: { scope?: string; clientIp?: string };
}

export async function assertOwner(
  opts: AssertOwnerOptions,
): Promise<AssertOwnerOk | AssertOwnerDenied> {
  if (opts.resource.userId === opts.currentUserId) {
    return { ok: true };
  }

  // 越权 → audit + 401
  const audit: Omit<AuditEntry, "id" | "timestamp"> = {
    action: opts.action,
    actor: {
      via: "jwt_user",
      clientIp: opts.actor?.clientIp ?? "unknown",
      userId: opts.currentUserId,
    },
    target: {
      userId: opts.resource.userId,
      resourceId: opts.resource._id,
      resourceType: opts.resourceType,
    },
    // M7-C: 越权 audit 不带 contentLen/trustLevel (用占位 0 满足类型)
    request: {
      contentLen: 0,
      trustLevel: 0,
    },
    result: "denied",
    requestId: `auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  try {
    await recordAudit(audit);
  } catch {
    // audit 失败不阻塞 401（defense in depth）
  }

  return {
    ok: false,
    response: errorResponse(
      "UNAUTHORIZED",
      `Not your ${opts.resourceType} (or it doesn't exist)`,
      401,
    ),
  };
}
