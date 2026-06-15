import { useState } from "react";
import type { FormEvent } from "react";
import { crawlUrl, type CrawlResult } from "../lib/api.js";

type TrustLevel = 0 | 1 | 2 | 3;

export default function CrawlPage() {
  const [url, setUrl] = useState("");
  const [trustLevel, setTrustLevel] = useState<TrustLevel>(2);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CrawlResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!url.trim()) {
      setError("请输入 URL");
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      const r = await crawlUrl(url.trim(), trustLevel);
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const doc = result?.document;
  const contentPreview = doc?.content.slice(0, 500) ?? "";
  const truncated = (doc?.content.length ?? 0) > 500;

  return (
    <section className="space-y-6">
      <h2 className="text-xl font-semibold">网页抓取</h2>

      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded border border-gray-200 bg-white p-6"
      >
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            URL
          </label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/article"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            disabled={submitting}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Trust Level
          </label>
          <select
            value={trustLevel}
            onChange={(e) => setTrustLevel(Number(e.target.value) as TrustLevel)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
            disabled={submitting}
          >
            <option value={0}>0 — 未审核 / UGC 不可信</option>
            <option value={1}>1 — 半可信 / 一般来源</option>
            <option value={2}>2 — 可信 / 默认（崔玉涛 / 权威指南）</option>
            <option value={3}>3 — 高度可信 / 内部权威文档</option>
          </select>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? "抓取中…" : "抓取"}
        </button>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-3">
            <p className="text-sm font-medium text-red-700">抓取失败</p>
            <p className="mt-1 text-xs text-red-600">{error}</p>
          </div>
        )}
      </form>

      {doc && (
        <div className="space-y-4 rounded border border-gray-200 bg-white p-6">
          <div>
            <h3 className="text-lg font-semibold">
              {doc.title || "(无标题)"}
            </h3>
            <a
              href={doc.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block break-all text-xs text-blue-600 hover:underline"
            >
              {doc.url}
            </a>
            <p className="mt-1 text-xs text-gray-500">
              fetchedAt: {doc.fetchedAt}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-green-100 px-2 py-0.5 text-green-700">
              trust {doc.trustLevel}
            </span>
            {result?.ingested ? (
              <span className="rounded bg-blue-100 px-2 py-0.5 text-blue-700">
                已入库
              </span>
            ) : (
              <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-700">
                未入库
              </span>
            )}
            {result?.ingested && (
              <>
                <span className="text-gray-600">
                  sourceId:{" "}
                  <span className="font-mono">{result.sourceId}</span>
                </span>
                <span className="text-gray-600">
                  documentId:{" "}
                  <span className="font-mono">{result.documentId}</span>
                </span>
                <span className="text-gray-600">
                  chunks: {result.chunkCount}
                </span>
              </>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-sm font-medium text-gray-700">
              Content（前 500 字）
            </h4>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-gray-100 bg-gray-50 p-3 text-xs text-gray-800">
              {contentPreview}
              {truncated && "\n\n…（已截断，完整内容已入库）"}
            </pre>
          </div>
        </div>
      )}
    </section>
  );
}
