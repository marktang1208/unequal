/**
 * M6.1 ChatSessionDO — 一个 session 一个 Durable Object instance（spec §2.2）。
 *
 * 命名约定：`session:${userId}:${sessionId}`（do-client.ts 负责拼名字）
 * 存储：state.storage KV 持久化 + 内存 cache 加速读
 * 上限：MAX_MESSAGES_PER_SESSION = 50（spec §4.3 截断策略）
 *
 * 内部 fetch endpoint（do-client.ts 调用，DO 自调）：
 *   GET  /messages  → { messages: ChatMessage[] }
 *   POST /append    body { role, content, summary? } → { ok, id, count }
 *   POST /reset     → { ok, count: 0 }
 */

import type { ChatMessage } from "@unequal/shared";

const MAX_MESSAGES_PER_SESSION = 50;
const STORAGE_KEY_MESSAGES = "messages";

interface AppendRequest {
  role: "user" | "assistant";
  content: string;
  summary?: string;
}

export class ChatSessionDO implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: unknown;
  private messages: ChatMessage[] = [];
  private loaded = false;

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    this.env = env;
    // 启动时 load messages from storage，串行化避免竞态
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<ChatMessage[]>(STORAGE_KEY_MESSAGES);
      this.messages = stored ?? [];
      this.loaded = true;
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/messages") {
      return this.handleMessages();
    }
    if (req.method === "POST" && url.pathname === "/append") {
      return this.handleAppend(req);
    }
    if (req.method === "POST" && url.pathname === "/reset") {
      return this.handleReset();
    }

    return new Response("Not Found", { status: 404 });
  }

  private handleMessages(): Response {
    return Response.json({ messages: this.messages });
  }

  private async handleAppend(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = parseAppendRequest(body);
    if (!parsed.ok) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const msg: ChatMessage = {
      role: parsed.value.role,
      content: parsed.value.content,
      ...(parsed.value.summary !== undefined ? { summary: parsed.value.summary } : {}),
      created_at: Date.now(),
    };
    this.messages.push(msg);

    // 截断到最近 50（spec §4.3）
    if (this.messages.length > MAX_MESSAGES_PER_SESSION) {
      this.messages = this.messages.slice(-MAX_MESSAGES_PER_SESSION);
    }

    await this.state.storage.put(STORAGE_KEY_MESSAGES, this.messages);
    return Response.json({ ok: true, id, count: this.messages.length });
  }

  private async handleReset(): Promise<Response> {
    this.messages = [];
    await this.state.storage.delete(STORAGE_KEY_MESSAGES);
    return Response.json({ ok: true, count: 0 });
  }
}

type ParseResult =
  | { ok: true; value: AppendRequest }
  | { ok: false; error: string };

function parseAppendRequest(body: unknown): ParseResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Body must be an object" };
  }
  const b = body as Record<string, unknown>;
  const role = b.role;
  if (role !== "user" && role !== "assistant") {
    return { ok: false, error: "role must be 'user' or 'assistant'" };
  }
  const content = b.content;
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, error: "content must be a non-empty string" };
  }
  const summary = b.summary;
  const out: AppendRequest = { role, content };
  if (typeof summary === "string") out.summary = summary;
  return { ok: true, value: out };
}
