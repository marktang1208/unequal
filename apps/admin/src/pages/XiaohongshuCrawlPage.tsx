import { useState } from "react";
import type { FormEvent } from "react";
import {
  crawlXiaohongshuUrls,
  type PlatformCrawlOutcome,
} from "../lib/api.js";
import { addUrl, isUrlSeen } from "../lib/dedupe.js";

type TrustLevel = 0 | 1 | 2 | 3;

export default function XiaohongshuCrawlPage() {
  const [urlsText, setUrlsText] = useState("");
  const [trustLevel, setTrustLevel] = useState<TrustLevel>(1);
  const [submitting, setSubmitting] = useState(false);
  const [outcomes, setOutcomes] = useState<PlatformCrawlOutcome[]>([]);
  const [submittedUrls, setSubmittedUrls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function parseUrls(): string[] {
    return urlsText
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  const submittedSeen = submittedUrls.filter(isUrlSeen);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const urls = parseUrls();
    if (urls.length === 0) {
      setError("请输入至少 1 个 URL");
      return;
    }
    setSubmitting(true);
    setOutcomes([]);
    setSubmittedUrls(urls);
    try {
      const result = await crawlXiaohongshuUrls(urls);
      setOutcomes(result.outcomes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function onClear() {
    setUrlsText("");
    setOutcomes([]);
    setSubmittedUrls([]);
    setError(null);
  }

  function onConfirmIngest() {
    for (const o of outcomes) {
      if (o.ok) addUrl(o.doc.url);
    }
    alert("已记录到 localStorage（mock-first 模式下不入库；CP-5 真接后会真调 /ingest）");
  }

  const successCount = outcomes.filter((o) => o.ok).length;
  const failCount = outcomes.filter((o) => !o.ok).length;

  return (
    <section className="space-y-6">
      <h2 className="text-xl font-semibold">小红书抓取</h2>

      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded border border-gray-200 bg-white p-6"
      >
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            URL（每行一个）
          </label>
          <textarea
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            rows={6}
            placeholder="https://xiaohongshu.com/explore/abc123&#10;https://xiaohongshu.com/explore/def456"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono"
          />
        </div>
        <div className="flex items-center gap-4">
          <label className="text-sm font-medium text-gray-700">
            trust_level:
          </label>
          <select
            value={trustLevel}
            onChange={(e) => setTrustLevel(Number(e.target.value) as TrustLevel)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          >
            <option value={0}>0 (未评级)</option>
            <option value={1}>1 (一般)</option>
            <option value={2}>2 (可信)</option>
            <option value={3}>3 (权威)</option>
          </select>
          <button
            type="submit"
            disabled={submitting || parseUrls().length === 0 || trustLevel === 0}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300"
          >
            {submitting ? "抓取中..." : "开始抓取"}
          </button>
          <button
            type="button"
            onClick={onClear}
            className="rounded border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            清空
          </button>
        </div>
        {trustLevel === 0 && (
          <p className="text-xs text-red-600">请选择 trust_level（不能为 0）</p>
        )}
      </form>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {submittedSeen.length > 0 && (
        <div className="rounded border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-700">
          ⚠ {submittedSeen.length} 个 URL 已入库过：{submittedSeen.join(", ")}
        </div>
      )}

      {outcomes.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-gray-700">
            结果（共 {outcomes.length} 条: 成功 {successCount} / 失败 {failCount}
            {submittedSeen.length > 0 && ` / 重复 ${submittedSeen.length}`}）
          </h3>
          {outcomes.map((o, idx) => {
            const url = submittedUrls[idx] ?? "(unknown)";
            if (o.ok) {
              return (
                <div
                  key={idx}
                  className="rounded border border-green-200 bg-green-50 p-3 text-sm"
                >
                  <div className="font-medium text-green-800">✓ {url}</div>
                  <div className="text-gray-700">
                    《{o.doc.title}》— {o.doc.author} · {o.doc.publishedAt}
                  </div>
                  <div className="mt-1 text-xs text-gray-600">
                    {o.doc.content.slice(0, 200)}
                    {o.doc.content.length > 200 && "..."}
                  </div>
                </div>
              );
            }
            return (
              <div
                key={idx}
                className="rounded border border-red-200 bg-red-50 p-3 text-sm"
              >
                <div className="font-medium text-red-800">✗ {url}</div>
                <div className="text-xs text-red-600">{o.message}</div>
              </div>
            );
          })}
          <button
            type="button"
            onClick={onConfirmIngest}
            disabled={successCount === 0}
            className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:bg-gray-300"
          >
            确认入库（{successCount} 条）
          </button>
        </div>
      )}
    </section>
  );
}
