import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { chat, listSessions, renameSession, deleteSession } from "../lib/api.js";
import type { ChatCitation, ChatSessionRow } from "../lib/api.js";

type Role = "user" | "assistant";

interface Message {
  id: string;
  role: Role;
  text: string;
  citations?: ChatCitation[];
  cached?: boolean;
}

export default function ChatSim() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [q, setQ] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // M6.1: 多 session 状态
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  async function refreshSessions() {
    setLoadingSessions(true);
    try {
      const res = await listSessions();
      setSessions(res.sessions);
    } catch (err) {
      // 静默失败 — sessions 列表非核心
      console.warn("listSessions failed:", err instanceof Error ? err.message : err);
    } finally {
      setLoadingSessions(false);
    }
  }

  useEffect(() => {
    void refreshSessions();
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const trimmed = q.trim();
    if (!trimmed) return;
    const userMsg: Message = { id: crypto.randomUUID(), role: "user", text: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setQ("");
    setSubmitting(true);
    try {
      const r = await chat(trimmed, sessionId ?? undefined);
      const botMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: r.answer,
        citations: r.citations,
        cached: r.cached,
      };
      setMessages((prev) => [...prev, botMsg]);
      // 服务端返的 session_id 持久化到本地 state
      if (r.session_id && r.session_id !== sessionId) {
        setSessionId(r.session_id);
        setSessionTitle(r.session_title);
        // 新建 session → 刷新列表
        if (r.is_new_session) void refreshSessions();
      } else if (r.session_title && r.session_title !== sessionTitle) {
        setSessionTitle(r.session_title);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function onNewSession() {
    setSessionId(null);
    setSessionTitle(null);
    setMessages([]);
    setError(null);
  }

  function onSwitchSession(id: string) {
    setSessionId(id);
    setMessages([]); // 简化：切换不清 messages（实际可调 GET /sessions/:id 拉 history，M6.2 加）
    const found = sessions.find((s) => s.id === id);
    setSessionTitle(found?.title ?? null);
  }

  async function onRenameSession(id: string) {
    const current = sessions.find((s) => s.id === id);
    const newTitle = window.prompt("新标题（<= 100 字）", current?.title ?? "");
    if (newTitle == null) return;
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    try {
      await renameSession(id, trimmed);
      await refreshSessions();
      if (id === sessionId) setSessionTitle(trimmed);
    } catch (err) {
      setError(`rename failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function onDeleteSession(id: string) {
    if (!window.confirm("确认删除？服务端会软删。")) return;
    try {
      await deleteSession(id);
      if (id === sessionId) onNewSession();
      await refreshSessions();
    } catch (err) {
      setError(`delete failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <section className="flex h-[calc(100vh-8rem)] gap-4">
      {/* 左栏：session 列表 */}
      <aside className="w-64 overflow-y-auto rounded border border-gray-200 bg-white p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">会话列表</h3>
          <button
            type="button"
            onClick={onNewSession}
            className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
          >
            + 新建
          </button>
        </div>
        {loadingSessions && <p className="text-xs text-gray-500">加载中…</p>}
        {!loadingSessions && sessions.length === 0 && (
          <p className="text-xs text-gray-500">暂无会话。提个问题开始第一个。</p>
        )}
        <ul className="space-y-1">
          {sessions.map((s) => (
            <li
              key={s.id}
              className={`group flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-gray-100 ${
                s.id === sessionId ? "bg-blue-50 font-medium" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => onSwitchSession(s.id)}
                className="flex-1 truncate text-left"
                title={s.title ?? s.id}
              >
                {s.title ?? "(无标题)"}
              </button>
              <span className="hidden space-x-1 group-hover:inline">
                <button
                  type="button"
                  onClick={() => onRenameSession(s.id)}
                  className="text-gray-500 hover:text-blue-600"
                  aria-label="重命名"
                >
                  ✎
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteSession(s.id)}
                  className="text-gray-500 hover:text-red-600"
                  aria-label="删除"
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      </aside>

      {/* 右栏：当前 session 对话 */}
      <div className="flex flex-1 flex-col">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xl font-semibold">
            Chat Simulation
            {sessionTitle && <span className="ml-2 text-sm font-normal text-gray-500">— {sessionTitle}</span>}
          </h2>
          {sessionId && (
            <span className="text-xs text-gray-400" title={sessionId}>
              session: {sessionId.slice(0, 8)}…
            </span>
          )}
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-4">
          {messages.length === 0 && (
            <p className="text-sm text-gray-500">问个问题试试，例如：5个月宝宝发烧38.5怎么办？</p>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
                  m.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-white text-gray-800 shadow"
                }`}
              >
                <p className="whitespace-pre-wrap">{m.text}</p>
                {m.role === "assistant" && m.cached && (
                  <p className="mt-1 text-xs text-green-600">缓存命中</p>
                )}
                {m.role === "assistant" && m.citations && m.citations.length > 0 && (
                  <div className="mt-2 space-y-1 border-t border-gray-100 pt-2">
                    {m.citations.map((c) => (
                      <p key={c.n} className="text-xs text-blue-600">
                        [{c.n}] {c.title} (trust {c.trust_level})
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        <form onSubmit={onSubmit} className="mt-4 flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="输入问题…"
            className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
            disabled={submitting}
          />
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "提问中…" : "提问"}
          </button>
        </form>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>
    </section>
  );
}
