/**
 * M6.1 do-client — 包装 Durable Object stub fetch 调用（spec §2.2/§3）。
 *
 * 命名约定：`session:${userId}:${sessionId}`，Cloudflare 按名字全球唯一路由
 * 所有方法只做 fetch 包装 + JSON 解析；具体存储逻辑在 ChatSessionDO 里。
 *
 * 测试注入：`fetchImpl` 可被 fake namespace 覆盖，让单元测不依赖 workerd。
 */

import type { ChatMessage } from "@unequal/shared";

export interface SessionDOEnv {
  SESSION_DO: DurableObjectNamespace;
  fetchImpl?: typeof fetch;
}

export interface AppendMessageInput {
  role: "user" | "assistant";
  content: string;
  summary?: string;
}

export interface AppendMessageResult {
  id: string;
  count: number;
}

function sessionName(userId: string, sessionId: string): string {
  return `session:${userId}:${sessionId}`;
}

function doFetch(env: SessionDOEnv, name: string, path: string, init?: RequestInit): Promise<Response> {
  const id = env.SESSION_DO.idFromName(name);
  const stub = env.SESSION_DO.get(id) as unknown as { fetch: typeof fetch };
  const url = `https://do/${path}`;
  return stub.fetch(url, init);
}

export async function getSessionMessages(
  env: SessionDOEnv,
  userId: string,
  sessionId: string,
): Promise<ChatMessage[]> {
  const res = await doFetch(env, sessionName(userId, sessionId), "messages", { method: "GET" });
  if (!res.ok) {
    throw new Error(`getSessionMessages failed: ${res.status}`);
  }
  const body = (await res.json()) as { messages: ChatMessage[] };
  return body.messages;
}

export async function appendMessage(
  env: SessionDOEnv,
  userId: string,
  sessionId: string,
  msg: AppendMessageInput,
): Promise<AppendMessageResult> {
  const res = await doFetch(env, sessionName(userId, sessionId), "append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg),
  });
  if (!res.ok) {
    throw new Error(`appendMessage failed: ${res.status}`);
  }
  const body = (await res.json()) as { ok: true; id: string; count: number };
  return { id: body.id, count: body.count };
}

export async function resetSession(
  env: SessionDOEnv,
  userId: string,
  sessionId: string,
): Promise<void> {
  const res = await doFetch(env, sessionName(userId, sessionId), "reset", { method: "POST" });
  if (!res.ok) {
    throw new Error(`resetSession failed: ${res.status}`);
  }
}
