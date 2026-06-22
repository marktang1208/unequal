/**
 * P3-7 种子 URL 库: admin UI SeedsPage
 *
 * 4 tab (xhs / wechat-mp / webpage / all) + URL 列表 + 添加 modal + 批量粘贴
 * + active 切换 + 删除
 *
 * 设计：
 * - 每 3s 自动轮询 /api/seeds (同 PendingPushList 模式)
 * - 添加走 POST (单条) / POST batch (批量粘贴)
 * - 切换 active 走 PATCH
 * - 删除走 DELETE
 */

import { useEffect, useRef, useState } from "react";
import type { TrustLevel } from "@unequal/shared/types";
import { translateErrorMessage } from "../lib/error-i18n.js";

type SeedSource = "xhs" | "wechat-mp" | "webpage";
type SeedLastStatus = "done" | "failed" | "pending" | null;

interface SeedUrl {
  url: string;
  source: SeedSource;
  trust_level: 0 | 1 | 2 | 3;
  active: boolean;
  last_crawled_at: string | null;
  last_status: SeedLastStatus;
  last_crawled_at_ms: number | null;
  last_error: string | null;
  retry_count: number;
}

const SOURCES: SeedSource[] = ["xhs", "wechat-mp", "webpage"];
const TRUST_LEVELS: TrustLevel[] = [0, 1, 2, 3];

const SOURCE_LABELS: Record<SeedSource, string> = {
  "xhs": "小红书",
  "wechat-mp": "公众号",
  "webpage": "网页",
};

const DEFAULT_TRUST: Record<SeedSource, TrustLevel> = {
  "xhs": 0,
  "wechat-mp": 2,
  "webpage": 1,
};

interface AddState {
  open: boolean;
  source: SeedSource;
  url: string;
  trustLevel: TrustLevel;
  mode: "single" | "batch";
  batchText: string;
}

const initialAdd: AddState = {
  open: false,
  source: "xhs",
  url: "",
  trustLevel: 1,
  mode: "single",
  batchText: "",
};

export function SeedsPage() {
  const [seeds, setSeeds] = useState<SeedUrl[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"all" | SeedSource>("all");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [add, setAdd] = useState<AddState>(initialAdd);
  const [adding, setAdding] = useState(false);
  const pollRef = useRef<number | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch("/api/seeds");
      if (!res.ok) {
        setError(`refresh failed: ${res.status}`);
        return;
      }
      const data = (await res.json()) as { urls: SeedUrl[] };
      setSeeds(data.urls);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    pollRef.current = window.setInterval(() => { void refresh(); }, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function onAdd() {
    setAdding(true);
    setError(null);
    setInfo(null);
    try {
      if (add.mode === "single") {
        if (!add.url.trim()) {
          setError("URL 不能为空");
          setAdding(false);
          return;
        }
        const res = await fetch("/api/seeds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: add.source, url: add.url.trim(), trust_level: add.trustLevel }),
        });
        const data = (await res.json()) as { added: number; skipped: number; errors: Array<{ url: string; error: string }>; error?: string; message?: string };
        if (!res.ok) {
          setError(data.error ?? data.message ?? `add failed: ${res.status}`);
        } else if (data.added > 0) {
          setInfo(`已添加 ${data.added} 条`);
          setAdd(initialAdd);
        } else if (data.skipped > 0) {
          setError("URL 已存在");
        } else {
          setError("添加失败");
        }
      } else {
        // 批量粘贴
        const urls = add.batchText.split("\n").map((u) => u.trim()).filter((u) => u.length > 0);
        if (urls.length === 0) {
          setError("请粘贴至少 1 个 URL（每行 1 个）");
          setAdding(false);
          return;
        }
        if (urls.length > 50) {
          setError("批量最多 50 条，请分批");
          setAdding(false);
          return;
        }
        const res = await fetch("/api/seeds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: add.source, trust_level: add.trustLevel, batch: urls }),
        });
        const data = (await res.json()) as { added: number; skipped: number; errors: Array<{ url: string; error: string }>; error?: string; message?: string };
        if (!res.ok) {
          setError(data.error ?? data.message ?? `batch failed: ${res.status}`);
        } else {
          setInfo(`批量完成: added=${data.added} skipped=${data.skipped} errors=${data.errors.length}`);
          if (data.errors.length > 0) {
            setError(`错误: ${data.errors.map((e) => e.error).join("; ")}`);
          }
          setAdd(initialAdd);
        }
      }
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  async function onToggleActive(s: SeedUrl) {
    try {
      const res = await fetch("/api/seeds", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: s.source, url: s.url, active: !s.active }),
      });
      if (!res.ok) {
        setError(`toggle failed: ${res.status}`);
        return;
      }
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDelete(s: SeedUrl) {
    if (!confirm(`确认删除 ${s.url} ?`)) return;
    try {
      const res = await fetch(`/api/seeds?source=${s.source}&url=${encodeURIComponent(s.url)}`, { method: "DELETE" });
      if (!res.ok) {
        setError(`delete failed: ${res.status}`);
        return;
      }
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const filtered = tab === "all" ? seeds : seeds.filter((s) => s.source === tab);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">种子 URL 库</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            data-testid="seeds-refresh"
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
          <button
            type="button"
            onClick={() => setAdd({ ...initialAdd, open: true, source: tab === "all" ? "xhs" : tab, trustLevel: DEFAULT_TRUST[tab === "all" ? "xhs" : tab] })}
            className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700"
            data-testid="seeds-add-toggle"
          >
            添加 URL
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900" data-testid="seeds-error">
          {error}
        </div>
      )}
      {info && (
        <div className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-900" data-testid="seeds-info">
          {info}
        </div>
      )}

      {/* 4 tab */}
      <div className="flex border-b border-gray-200" role="tablist">
        {(["all", ...SOURCES] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            data-testid={`seeds-tab-${t}`}
            className={`px-4 py-2 text-sm font-medium ${
              tab === t
                ? "border-b-2 border-blue-600 text-blue-700"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            {t === "all" ? "全部" : SOURCE_LABELS[t]}
          </button>
        ))}
      </div>

      {/* 列表 */}
      {filtered.length > 0 ? (
        <div className="overflow-x-auto rounded border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-2 py-2">来源</th>
                <th className="px-2 py-2">URL</th>
                <th className="px-2 py-2">信任</th>
                <th className="px-2 py-2">active</th>
                <th className="px-2 py-2">last_crawled</th>
                <th className="px-2 py-2">last_status</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.url} className="border-b last:border-b-0" data-testid={`seeds-row-${s.source}-${s.url}`}>
                  <td className="px-2 py-2 text-xs">
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono">{s.source}</span>
                  </td>
                  <td className="px-2 py-2">
                    <div className="max-w-[320px] truncate font-mono text-xs" title={s.url}>{s.url}</div>
                  </td>
                  <td className="px-2 py-2 text-xs">{s.trust_level}</td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      onClick={() => void onToggleActive(s)}
                      data-testid={`seeds-toggle-${s.url}`}
                      className={`rounded px-2 py-0.5 text-xs ${
                        s.active ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-600"
                      }`}
                    >
                      {s.active ? "✓" : "✗"}
                    </button>
                  </td>
                  <td className="px-2 py-2 text-xs text-gray-500">
                    {s.last_crawled_at_ms ? new Date(s.last_crawled_at_ms).toLocaleString() : "—"}
                  </td>
                  <td className="px-2 py-2">
                    {s.last_status && <StatusBadge status={s.last_status} error={s.last_error} />}
                  </td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      onClick={() => void onDelete(s)}
                      data-testid={`seeds-delete-${s.url}`}
                      className="rounded border border-red-300 bg-white px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded border border-gray-200 bg-white p-4 text-sm text-gray-500" data-testid="seeds-empty">
          暂无 {tab === "all" ? "" : SOURCE_LABELS[tab as SeedSource]} 种子
        </div>
      )}

      {/* 添加 modal */}
      {add.open && (
        <div className="rounded border border-gray-300 bg-white p-4" data-testid="seeds-add-form">
          <div className="mb-3 flex items-center gap-3">
            <h3 className="text-base font-medium">添加种子 URL</h3>
            <button
              type="button"
              onClick={() => setAdd({ ...add, mode: "single" })}
              className={`rounded px-2 py-0.5 text-xs ${add.mode === "single" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700"}`}
            >
              单条
            </button>
            <button
              type="button"
              onClick={() => setAdd({ ...add, mode: "batch" })}
              className={`rounded px-2 py-0.5 text-xs ${add.mode === "batch" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700"}`}
            >
              批量粘贴
            </button>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <label className="w-20 text-sm text-gray-700">来源：</label>
              <select
                value={add.source}
                onChange={(e) => setAdd({ ...add, source: e.target.value as SeedSource, trustLevel: DEFAULT_TRUST[e.target.value as SeedSource] })}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
                data-testid="seeds-add-source"
              >
                {SOURCES.map((s) => (
                  <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
                ))}
              </select>
              <label className="ml-3 w-20 text-sm text-gray-700">信任：</label>
              <select
                value={add.trustLevel}
                onChange={(e) => setAdd({ ...add, trustLevel: Number(e.target.value) as TrustLevel })}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
                data-testid="seeds-add-trust"
              >
                {TRUST_LEVELS.map((lvl) => (
                  <option key={lvl} value={lvl}>{lvl}</option>
                ))}
              </select>
            </div>

            {add.mode === "single" ? (
              <div className="flex items-center gap-2">
                <label className="w-20 text-sm text-gray-700">URL：</label>
                <input
                  type="text"
                  value={add.url}
                  onChange={(e) => setAdd({ ...add, url: e.target.value })}
                  placeholder="https://..."
                  className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm font-mono"
                  data-testid="seeds-add-url"
                />
              </div>
            ) : (
              <div>
                <label className="mb-1 block text-sm text-gray-700">URL 列表（每行 1 个，最多 50 条）：</label>
                <textarea
                  value={add.batchText}
                  onChange={(e) => setAdd({ ...add, batchText: e.target.value })}
                  placeholder={"https://example.com/1\nhttps://example.com/2\n..."}
                  rows={6}
                  className="w-full rounded border border-gray-300 px-2 py-1 font-mono text-xs"
                  data-testid="seeds-add-batch"
                />
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void onAdd()}
                disabled={adding}
                className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                data-testid="seeds-add-submit"
              >
                {adding ? "添加中…" : "确认添加"}
              </button>
              <button
                type="button"
                onClick={() => setAdd(initialAdd)}
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status, error }: { status: SeedLastStatus; error: string | null }) {
  const map: Record<NonNullable<SeedLastStatus>, { label: string; cls: string }> = {
    done: { label: "完成", cls: "bg-green-100 text-green-800" },
    failed: { label: "失败", cls: "bg-red-100 text-red-800" },
    pending: { label: "推送中", cls: "bg-blue-100 text-blue-800" },
  };
  if (!status) return null;
  const s = map[status];
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${s.cls}`} title={error ?? ""}>
      {s.label}
    </span>
  );
}

export default SeedsPage;

// re-export translateErrorMessage for test compat (避免 unused import warning)
export { translateErrorMessage };