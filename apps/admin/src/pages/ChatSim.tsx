import { useState } from "react";
import type { FormEvent } from "react";
import { ask, type AskResponse, type AskCitation } from "../lib/api.js";

type Role = "user" | "assistant";

interface Message {
  id: string;
  role: Role;
  text: string;
  citations?: AskCitation[];
  cached?: boolean;
}

export default function ChatSim() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [q, setQ] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!q.trim()) return;
    const userMsg: Message = { id: crypto.randomUUID(), role: "user", text: q.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setQ("");
    setSubmitting(true);
    try {
      const r: AskResponse = await ask(userMsg.text);
      const botMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: r.answer,
        citations: r.citations,
        cached: r.cached,
      };
      setMessages((prev) => [...prev, botMsg]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex h-[calc(100vh-8rem)] flex-col">
      <h2 className="mb-4 text-xl font-semibold">Chat Simulation（小程序 UI 镜像）</h2>
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
                    <a
                      key={c.n}
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block text-xs text-blue-600 hover:underline"
                    >
                      [{c.n}] {c.title}
                    </a>
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
    </section>
  );
}
