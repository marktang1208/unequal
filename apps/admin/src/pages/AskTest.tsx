import { useState } from "react";
import type { FormEvent } from "react";
import { ask, type AskResponse, type AskCitation } from "../lib/api.js";

type Tab = "chunks" | "prompt" | "answer" | "citations";

export default function AskTest() {
  const [q, setQ] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resp, setResp] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("chunks");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!q.trim()) {
      setError("请输入问题");
      return;
    }
    setSubmitting(true);
    try {
      const r = await ask(q.trim());
      setResp(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResp(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-6">
      <h2 className="text-xl font-semibold">问答测试</h2>

      <form onSubmit={onSubmit} className="space-y-4 rounded border border-gray-200 bg-white p-6">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">问题 (q)</label>
          <textarea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            rows={3}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder="例如：5个月宝宝发烧38.5°C 怎么办？"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? "提问中…" : "提问"}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>

      {resp && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            {resp.cached && (
              <span className="rounded bg-green-100 px-2 py-1 text-xs text-green-700">缓存命中</span>
            )}
            <span className="text-xs text-gray-500">{resp.citations.length} 条 verified 引用</span>
          </div>

          <div className="flex border-b border-gray-200">
            {(["chunks", "prompt", "answer", "citations"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className={`px-4 py-2 text-sm font-medium ${
                  activeTab === t
                    ? "border-b-2 border-blue-600 text-blue-600"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>

          <div className="rounded border border-gray-200 bg-white p-6">
            {activeTab === "chunks" && <ChunksTab citations={resp.citations} />}
            {activeTab === "prompt" && <PromptTab q={q} citations={resp.citations} />}
            {activeTab === "answer" && <AnswerTab resp={resp} />}
            {activeTab === "citations" && <CitationsTab citations={resp.citations} />}
          </div>
        </div>
      )}
    </section>
  );
}

const TAB_LABELS: Record<Tab, string> = {
  chunks: "Top 5 Chunks",
  prompt: "Final Prompt",
  answer: "LLM Answer",
  citations: "Citations",
};

function ChunksTab({ citations }: { citations: AskCitation[] }) {
  if (citations.length === 0) {
    return <p className="text-sm text-gray-500">无 verified 引用（可能走了降级路径）</p>;
  }
  return (
    <ul className="space-y-3">
      {citations.map((c) => (
        <li key={c.n} className="rounded border border-gray-100 p-3">
          <div className="mb-1 flex items-center gap-2 text-sm">
            <span className="font-mono text-gray-500">[{c.n}]</span>
            <span className="font-medium">{c.title}</span>
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">trust {c.trustLevel}</span>
          </div>
          <p className="text-sm text-gray-700">{c.snippet}</p>
        </li>
      ))}
    </ul>
  );
}

function PromptTab({ q, citations }: { q: string; citations: AskCitation[] }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-gray-700">
      {`[system prompt 完整内容]\n${citations.map((c) => `[${c.n}] ${c.title}`).join("\n")}\n\nuser: ${q}`}
    </pre>
  );
}

function AnswerTab({ resp }: { resp: AskResponse }) {
  return (
    <div className="space-y-2 text-sm text-gray-800">
      <p className="whitespace-pre-wrap">{resp.answer}</p>
      <p className="text-xs text-gray-500">— disclaimer: {resp.disclaimer}</p>
    </div>
  );
}

function CitationsTab({ citations }: { citations: AskCitation[] }) {
  if (citations.length === 0) {
    return <p className="text-sm text-gray-500">无 verified 引用</p>;
  }
  return (
    <ul className="space-y-2 text-sm">
      {citations.map((c) => (
        <li key={c.n} className="rounded border border-gray-100 p-2">
          <span className="font-mono text-gray-500">[{c.n}]</span>{" "}
          <span className="font-medium">{c.title}</span>{" "}
          <a className="text-xs text-blue-600 hover:underline" href={`/api/documents/${c.chunkId}/raw`}>
            查看原文
          </a>
        </li>
      ))}
    </ul>
  );
}
