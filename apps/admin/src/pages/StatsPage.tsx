/**
 * M6.5 admin StatsPage（spec §6.4 + plan §4 Task 3b）。
 *
 * UI 结构：
 * - header: hours select (24 / 72 / 168)
 * - 4 数字卡 (失败 / 成功 / 失败率 / 总尝试)
 * - by_type 分布 (Admin login + Wx code，横向 bar)
 * - by_hour 时序（CSS bars，无图表库；hover title 显示 Asia/Shanghai tooltip）
 *
 * 无数据时显示"暂无登录尝试"占位文字，不渲染 0px bars。
 */
import { useEffect, useState } from "react";
import { getLoginAttemptStats } from "../lib/api.js";
import type { LoginAttemptStats } from "../lib/api.js";

const HOURS_OPTIONS = [
  { value: 24, label: "最近 24h" },
  { value: 72, label: "最近 72h" },
  { value: 168, label: "最近 7d" },
];

export default function StatsPage() {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<LoginAttemptStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getLoginAttemptStats(hours)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hours]);

  const total = (data?.total_failed ?? 0) + (data?.total_succeeded ?? 0);
  const failureRate = total > 0 ? ((data!.total_failed / total) * 100).toFixed(1) : "0.0";

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">登录尝试统计</h2>
        <select
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
          className="rounded border border-gray-300 px-3 py-1 text-sm"
        >
          {HOURS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </header>

      {loading && <p className="text-sm text-gray-500">加载中…</p>}
      {error && <p className="text-sm text-red-600">stats failed: {error}</p>}

      {data && (
        <>
          <div className="grid grid-cols-4 gap-4">
            <StatCard label="失败" value={data.total_failed} color="red" />
            <StatCard label="成功" value={data.total_succeeded} color="green" />
            <StatCard label="失败率" value={`${failureRate}%`} />
            <StatCard label="总尝试" value={total} />
          </div>

          <div className="rounded border border-gray-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-semibold">类型分布</h3>
            <TypeRow label="Admin login" data={data.by_type.admin} />
            <TypeRow label="Wx code" data={data.by_type.wx_code} />
          </div>

          <div className="rounded border border-gray-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-semibold">每小时分布（UTC+8）</h3>
            {data.by_hour.some((h) => h.failed + h.succeeded > 0) ? (
              <HourBars hours={data.by_hour} />
            ) : (
              <p className="text-sm text-gray-500">暂无登录尝试</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color?: "red" | "green";
}) {
  const colorClass =
    color === "red"
      ? "text-red-600"
      : color === "green"
        ? "text-green-600"
        : "text-gray-900";
  return (
    <div className="rounded border border-gray-200 bg-white p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${colorClass}`}>{value}</div>
    </div>
  );
}

function TypeRow({
  label,
  data,
}: {
  label: string;
  data: { failed: number; succeeded: number };
}) {
  const total = data.failed + data.succeeded;
  const failedPct = total > 0 ? (data.failed / total) * 100 : 0;
  return (
    <div className="mb-2 last:mb-0">
      <div className="flex justify-between text-xs">
        <span>{label}</span>
        <span className="text-gray-500">
          failed={data.failed} succeeded={data.succeeded}
        </span>
      </div>
      <div className="mt-1 flex h-4 overflow-hidden rounded bg-gray-100">
        <div className="bg-red-500" style={{ width: `${failedPct}%` }} />
        <div className="bg-green-500" style={{ width: `${100 - failedPct}%` }} />
      </div>
    </div>
  );
}

function HourBars({
  hours,
}: {
  hours: Array<{ hour_ts: number; failed: number; succeeded: number }>;
}) {
  // 双保险：有数据时 max 至少 1 防除零
  const max = Math.max(1, ...hours.map((h) => h.failed + h.succeeded));
  return (
    <div className="flex h-32 items-end gap-1">
      {hours.map((h) => {
        const total = h.failed + h.succeeded;
        const failedPct = (h.failed / max) * 100;
        const succeededPct = (h.succeeded / max) * 100;
        const label = new Date(h.hour_ts).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour: "2-digit",
          minute: "2-digit",
        });
        return (
          <div
            key={h.hour_ts}
            className="flex flex-1 flex-col justify-end"
            title={`${label} (UTC+8): failed=${h.failed} succeeded=${h.succeeded}`}
          >
            {total > 0 && (
              <>
                <div className="bg-red-500" style={{ height: `${failedPct}%` }} />
                <div className="bg-green-500" style={{ height: `${succeededPct}%` }} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
