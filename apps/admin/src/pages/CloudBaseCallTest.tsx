import { useState } from "react";
import {
  callApiRouter,
  getEnvId,
  isCloudBaseConfigured,
  type HttpResponse,
} from "../lib/cloudbase.js";

type Status = "idle" | "running" | "ok" | "fail";

interface TestRow {
  label: string;
  status: Status;
  result?: HttpResponse;
  latencyMs?: number;
  error?: string;
}

interface Preset {
  label: string;
  httpMethod: string;
  path: string;
  body: string | null;
}

const PRESETS: Preset[] = [
  { label: "GET /api-health", httpMethod: "GET", path: "/api-health", body: null },
  { label: "GET /", httpMethod: "GET", path: "/", body: null },
  {
    label: "POST /api-search",
    httpMethod: "POST",
    path: "/api-search",
    body: JSON.stringify({ query: "test", topK: 3 }),
  },
];

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export default function CloudBaseCallTest() {
  const [rows, setRows] = useState<TestRow[]>([]);
  const [running, setRunning] = useState(false);
  const configured = isCloudBaseConfigured();

  async function runOne(preset: Preset): Promise<TestRow> {
    const start = performance.now();
    try {
      const result = await callApiRouter({
        httpMethod: preset.httpMethod,
        path: preset.path,
        headers: preset.body ? { "content-type": "application/json" } : {},
        queryString: {},
        body: preset.body,
        isBase64Encoded: false,
      });
      return {
        label: preset.label,
        status: result.statusCode >= 200 && result.statusCode < 300 ? "ok" : "fail",
        result,
        latencyMs: Math.round(performance.now() - start),
      };
    } catch (err) {
      return {
        label: preset.label,
        status: "fail",
        latencyMs: Math.round(performance.now() - start),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function onRunAll() {
    if (running) return;
    setRunning(true);
    setRows(PRESETS.map((p) => ({ label: p.label, status: "idle" })));
    const acc: TestRow[] = [];
    for (const p of PRESETS) {
      const row = await runOne(p);
      acc.push(row);
      setRows([...acc]);
    }
    setRunning(false);
  }

  function onClear() {
    setRows([]);
  }

  return (
    <section className="space-y-6">
      <h2 className="text-xl font-semibold">CloudBase callFunction 测试 (admin)</h2>

      <div className="rounded border border-gray-200 bg-white p-4 text-sm">
        <div>
          env: <code className="bg-gray-100 px-1">{getEnvId()}</code>
        </div>
        <div>
          SDK configured:{" "}
          {configured ? (
            <span className="text-emerald-600">✓ yes</span>
          ) : (
            <span className="text-red-600">✗ no — copy .env.local.example to .env.local and fill values</span>
          )}
        </div>
        <div className="mt-2 text-xs text-amber-700">
          ⚠️ admin 是 Vite SPA，VITE_* secret 会嵌入 bundle。本地 dev OK；生产部署前必须改走 CF Pages Functions proxy。
        </div>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onRunAll}
          disabled={running || !configured}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {running ? "测试中…" : "跑全部 3 个测试"}
        </button>
        <button
          type="button"
          onClick={onClear}
          className="rounded bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
        >
          清空
        </button>
      </div>

      <div className="space-y-3">
        {rows.map((row, i) => (
          <div
            key={i}
            className={`rounded border-l-4 p-4 ${
              row.status === "ok"
                ? "border-emerald-500 bg-emerald-50"
                : row.status === "fail"
                  ? "border-red-500 bg-red-50"
                  : "border-gray-300 bg-gray-50"
            }`}
          >
            <div className="flex items-center gap-3 text-sm">
              <span className="text-lg font-bold">
                {row.status === "ok" ? "✓" : row.status === "fail" ? "✗" : "·"}
              </span>
              <span className="font-medium">{row.label}</span>
              {row.result && (
                <span className="text-gray-600">HTTP {row.result.statusCode}</span>
              )}
              {row.latencyMs !== undefined && (
                <span className="ml-auto font-mono text-xs text-gray-500">
                  {row.latencyMs}ms
                </span>
              )}
            </div>
            {row.error && (
              <pre className="mt-2 overflow-x-auto rounded bg-red-100 p-2 text-xs text-red-800">
                {row.error}
              </pre>
            )}
            {row.result?.body && (
              <pre className="mt-2 overflow-x-auto rounded bg-gray-100 p-2 text-xs text-gray-800">
                {JSON.stringify(tryParseJson(row.result.body), null, 2).slice(0, 800)}
              </pre>
            )}
          </div>
        ))}
        {rows.length === 0 && !running && (
          <div className="rounded bg-gray-50 p-4 text-sm text-gray-600">
            点上面按钮测 3 个端点（GET /api-health, GET /, POST /api-search）
          </div>
        )}
      </div>
    </section>
  );
}
