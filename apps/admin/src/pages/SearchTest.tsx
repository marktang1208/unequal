import { useState } from "react";
import type { FormEvent } from "react";
import { search, type SearchHit } from "../lib/api.js";

export default function SearchTest() {
  const [q, setQ] = useState("");
  const [topK, setTopK] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!q.trim()) {
      setError("请输入查询字符串");
      return;
    }
    setSubmitting(true);
    try {
      const resp = await search(q.trim(), topK);
      setHits(resp.hits);
      setLastQuery(resp.q);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setHits(null);
      setLastQuery(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-6">
      <h2 className="text-xl font-semibold">检索测试</h2>

      <form onSubmit={onSubmit} className="space-y-4 rounded border border-gray-200 bg-white p-6">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">查询 (q)</label>
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder="例如：婴儿湿疹怎么处理？"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">topK</label>
          <input
            type="number"
            min={1}
            max={50}
            value={topK}
            onChange={(e) => setTopK(Number(e.target.value))}
            className="w-24 rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {submitting ? "检索中…" : "检索"}
        </button>
      </form>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-900">{error}</div>
      )}

      {hits !== null && !error && (
        <div className="space-y-3">
          <div className="text-sm text-gray-600">
            查询：<span className="font-mono">{lastQuery}</span> · {hits.length} 条命中
          </div>

          {hits.length === 0 ? (
            <div className="rounded border border-gray-200 bg-white p-6 text-sm text-gray-500">
              暂无命中。
            </div>
          ) : (
            <ul className="space-y-3">
              {hits.map((h, i) => (
                <li
                  key={h.chunkId}
                  className="rounded border border-gray-200 bg-white p-4 text-sm"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                    <span className="font-semibold text-gray-900">#{i + 1}</span>
                    <span>chunkId: <span className="font-mono">{h.chunkId}</span></span>
                    {h.sourceId && <span>source: <span className="font-mono">{h.sourceId}</span></span>}
                    {h.documentId && (
                      <span>document: <span className="font-mono">{h.documentId}</span></span>
                    )}
                    <span>trust: {h.trustLevel}</span>
                  </div>
                  <div className="mb-2 text-xs text-gray-600">
                    score: <span className="font-mono">{h.finalScore.toFixed(4)}</span>
                    {" · "}
                    vector: <span className="font-mono">{h.vectorizeScore.toFixed(4)}</span>
                  </div>
                  <pre className="whitespace-pre-wrap break-words text-sm text-gray-800">
                    {h.content}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}