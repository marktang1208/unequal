/**
 * P3-7 / Phase C: PendingPushList — admin UI 补推列表组件
 *
 * 显示 local_ingest.status='pending' 的所有记录，admin 勾选后批量推送到 CloudBase。
 * - 默认 source='crawler'（crawler 暂存为主）
 * - 可切 source='upload' 看 admin-upload 失败的补推
 * - 单条 trust_level 可临时改（不持久化；推送请求体里覆盖）
 * - 失败行有 "重试" 按钮（POST /api/retry）
 */

import { useEffect, useRef, useState } from "react";
import type { TrustLevel } from "@unequal/shared/types";
import { translateErrorMessage } from "../lib/error-i18n.js";

interface IngestRow {
  file_id: string;
  filename: string;
  source: "upload" | "crawler";
  status: string;
  trust_level: number;
  markdown_chars: number | null;
  chunks_count: number | null;
  cloud_source_id: string | null;
  cloud_document_id: string | null;
  retry_count: number;
  retryable: 0 | 1;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

const TRUST_LEVELS: TrustLevel[] = [0, 1, 2, 3];

interface PushResult {
  pushed: number;
  failed: number;
  skipped: number;
  errors: Array<{ file_id: string; error: string }>;
}

interface CrawlerStartForm {
  source: "xhs" | "wechat-mp" | "webpage" | "all";
  limit: number;
  fullScan: boolean;
  trustLevel: TrustLevel;
}

export function PendingPushList() {
  const [rows, setRows] = useState<IngestRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, TrustLevel>>({});
  const [result, setResult] = useState<PushResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "pending" | "failed">("pending");
  const [sourceFilter, setSourceFilter] = useState<"all" | "upload" | "crawler">("crawler");
  const pollRef = useRef<number | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (sourceFilter !== "all") params.set("source", sourceFilter);
      if (filter !== "all") params.set("status", filter);
      const res = await fetch(`/api/ingest-status?${params.toString()}`);
      if (!res.ok) {
        setError(`refresh failed: ${res.status}`);
        return;
      }
      const data = (await res.json()) as { files: IngestRow[] };
      setRows(data.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // 每 3s 轮询（推送后看到状态变化）
    pollRef.current = window.setInterval(() => { void refresh(); }, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [sourceFilter, filter]);

  function toggleSelect(fileId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === rows.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map((r) => r.file_id)));
    }
  }

  async function onBatchPush() {
    if (selected.size === 0) return;
    setPushing(true);
    setError(null);
    setResult(null);
    try {
      const file_ids = Array.from(selected);
      const res = await fetch("/api/manual-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids, trust_level_overrides: overrides }),
      });
      const data = (await res.json()) as PushResult;
      setResult(data);
      setSelected(new Set());
      setOverrides({});
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushing(false);
    }
  }

  async function onRetry(fileId: string) {
    setError(null);
    try {
      const res = await fetch(`/api/retry?file_id=${fileId}`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        setError(`retry ${fileId} failed: ${data.message ?? res.status}`);
      } else {
        void refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function setOverride(fileId: string, level: TrustLevel) {
    setOverrides((prev) => ({ ...prev, [fileId]: level }));
  }

  const allSelected = selected.size > 0 && selected.size === rows.length;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">待推送列表</h2>
        <div className="flex items-center gap-2">
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as "all" | "upload" | "crawler")}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
            data-testid="source-filter"
          >
            <option value="crawler">crawler</option>
            <option value="upload">upload</option>
            <option value="all">all</option>
          </select>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as "all" | "pending" | "failed")}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
            data-testid="status-filter"
          >
            <option value="pending">pending</option>
            <option value="failed">failed</option>
            <option value="all">all</option>
          </select>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="rounded border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          {error}
        </div>
      )}

      {result && (
        <div className="rounded border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900">
          推送完成：pushed={result.pushed} failed={result.failed} skipped={result.skipped}
          {result.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {result.errors.map((e) => (
                <li key={e.file_id}>{e.file_id}: {e.error}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-2 py-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    data-testid="select-all"
                  />
                </th>
                <th className="px-2 py-2">来源</th>
                <th className="px-2 py-2">文件名</th>
                <th className="px-2 py-2">状态</th>
                <th className="px-2 py-2">信任级</th>
                <th className="px-2 py-2">markdown/chunks</th>
                <th className="px-2 py-2">错误 / 结果</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.file_id} className="border-b last:border-b-0">
                  <td className="px-2 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(r.file_id)}
                      onChange={() => toggleSelect(r.file_id)}
                      data-testid={`select-${r.file_id}`}
                    />
                  </td>
                  <td className="px-2 py-2 text-xs">
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono">{r.source}</span>
                  </td>
                  <td className="px-2 py-2">
                    <div className="truncate font-medium max-w-[200px]" title={r.filename}>{r.filename}</div>
                    <div className="text-xs text-gray-400">{r.file_id.slice(0, 8)}</div>
                  </td>
                  <td className="px-2 py-2">
                    <PendingBadge status={r.status} />
                  </td>
                  <td className="px-2 py-2">
                    <select
                      value={overrides[r.file_id] ?? r.trust_level}
                      onChange={(e) => setOverride(r.file_id, Number(e.target.value) as TrustLevel)}
                      className="rounded border border-gray-300 px-1 py-0.5 text-xs"
                      data-testid={`trust-${r.file_id}`}
                    >
                      {TRUST_LEVELS.map((lvl) => (
                        <option key={lvl} value={lvl}>{lvl}</option>
                      ))}
                    </select>
                    {overrides[r.file_id] !== undefined && (
                      <span className="ml-1 text-xs text-orange-600">已覆盖</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-xs text-gray-500">
                    {r.markdown_chars ?? 0}c / {r.chunks_count ?? 0}chunks
                  </td>
                  <td className="px-2 py-2">
                    {r.status === "done" && r.cloud_source_id ? (
                      <div className="text-xs text-green-700">
                        <div>source: {r.cloud_source_id}</div>
                        <div>document: {r.cloud_document_id}</div>
                      </div>
                    ) : r.status === "failed" ? (
                      <div className="text-xs text-red-700">
                        {translateErrorMessage(r.error_code, r.error_message)}
                        {r.error_code && (
                          <div className="mt-0.5 text-gray-500">code: {r.error_code}</div>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {r.status === "failed" && r.retryable === 1 && (
                      <button
                        type="button"
                        onClick={() => void onRetry(r.file_id)}
                        className="rounded border border-blue-300 bg-white px-2 py-0.5 text-xs text-blue-700 hover:bg-blue-50"
                        data-testid={`retry-${r.file_id}`}
                      >
                        重试
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded border border-gray-200 bg-white p-4 text-sm text-gray-500">
          暂无 {sourceFilter}/{filter} 的记录
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded border border-blue-300 bg-blue-50 p-3">
          <span className="text-sm text-blue-900">已选 {selected.size} 条</span>
          <button
            type="button"
            onClick={() => void onBatchPush()}
            disabled={pushing}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="batch-push"
          >
            {pushing ? "推送中…" : `批量推送 ${selected.size} 条`}
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="rounded border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            清空选择
          </button>
        </div>
      )}
    </section>
  );
}

function PendingBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: "待推", cls: "bg-yellow-100 text-yellow-800" },
    pushing: { label: "推送中", cls: "bg-blue-100 text-blue-800" },
    done: { label: "已推送", cls: "bg-green-100 text-green-800" },
    failed: { label: "失败", cls: "bg-red-100 text-red-800" },
  };
  const s = map[status] ?? { label: status, cls: "bg-gray-100 text-gray-700" };
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}

/* ──── P3-7 / Phase C: 启动爬虫组件 ──── */

export function CrawlerStartButton() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CrawlerStartForm>({ source: "xhs", limit: 10, fullScan: false, trustLevel: 1 });
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState<{ process_id: string; alive: boolean; pending_count: number; log_tail?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function pollStatus(processId: string) {
    try {
      const res = await fetch(`/api/crawler/status?process_id=${processId}`);
      if (res.ok) {
        const data = (await res.json()) as typeof status & { log_tail?: string };
        setStatus(data);
        if (!data.alive) {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      }
    } catch {
      // 静默；下次重试
    }
  }

  async function onStart() {
    setStarting(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/crawler/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: form.source,
          limit: form.limit,
          fullScan: form.fullScan,
          trustLevel: form.trustLevel,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(`${res.status} ${data.error ?? data.message ?? ""}`);
      }
      const data = (await res.json()) as { process_id: string };
      setStatus({ process_id: data.process_id, alive: true, pending_count: 0 });
      // 开始轮询 status
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = window.setInterval(() => { void pollStatus(data.process_id); }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700"
        data-testid="crawler-start-toggle"
      >
        启动爬虫
      </button>

      {open && (
        <div className="mt-3 space-y-3 rounded border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-3">
            <label className="text-sm text-gray-700">来源：</label>
            <select
              value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value as CrawlerStartForm["source"] })}
              className="rounded border border-gray-300 px-2 py-1 text-sm"
              data-testid="crawler-source"
            >
              <option value="xhs">xhs</option>
              <option value="wechat-mp">wechat-mp</option>
              <option value="webpage">webpage</option>
              <option value="all">all</option>
            </select>
            <label className="text-sm text-gray-700">limit：</label>
            <input
              type="number"
              min={1}
              max={1000}
              value={form.limit}
              onChange={(e) => setForm({ ...form, limit: Number(e.target.value) })}
              className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
              data-testid="crawler-limit"
            />
            <label className="text-sm text-gray-700">信任：</label>
            <select
              value={form.trustLevel}
              onChange={(e) => setForm({ ...form, trustLevel: Number(e.target.value) as TrustLevel })}
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            >
              {TRUST_LEVELS.map((lvl) => (
                <option key={lvl} value={lvl}>{lvl}</option>
              ))}
            </select>
            <label className="ml-2 flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={form.fullScan}
                onChange={(e) => setForm({ ...form, fullScan: e.target.checked })}
                data-testid="crawler-full-scan"
              />
              <span>全量</span>
            </label>
            <button
              type="button"
              onClick={() => void onStart()}
              disabled={starting}
              className="ml-auto rounded bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="crawler-start-submit"
            >
              {starting ? "启动中…" : "启动"}
            </button>
          </div>

          {error && (
            <div className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900">
              {error}
            </div>
          )}

          {status && (
            <div className="rounded border border-gray-200 bg-gray-50 p-3 text-sm">
              <div className="font-mono text-xs text-gray-500">process_id: {status.process_id}</div>
              <div className="mt-1">
                状态：
                <span className={status.alive ? "text-blue-700" : "text-green-700"}>
                  {status.alive ? "运行中" : "已结束"}
                </span>
                {status.alive ? "" : "（刷新页面后消失）"}
              </div>
              <div>已暂存待推：{status.pending_count} 条</div>
              {status.log_tail && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-gray-500">查看日志</summary>
                  <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded bg-gray-900 p-2 font-mono text-xs text-gray-100">
                    {status.log_tail}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}