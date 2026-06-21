import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import type { TrustLevel } from "@unequal/shared/types";
import { translateErrorMessage } from "../lib/error-i18n.js";
import { LlmStatus } from "../components/LlmStatus.js";

interface UploadFileResult {
  batch_id: string;
  file_id: string;
  filename: string;
  status: "pending" | string;
}

interface StatusRow {
  file_id: string;
  filename: string;
  status: string;
  progress: number;
  error_code: string | null;
  error_message: string | null;
  cloud_source_id: string | null;
  cloud_document_id: string | null;
  retryable: number;
}

const TRUST_LEVELS: TrustLevel[] = [0, 1, 2, 3];

export default function Upload() {
  const [files, setFiles] = useState<File[]>([]);
  const [trustLevel, setTrustLevel] = useState<TrustLevel>(1);
  const [submitting, setSubmitting] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [rows, setRows] = useState<StatusRow[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const dragCounter = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // 轮询 status（batchId 设置后启动；清理时取消）
  useEffect(() => {
    if (!batchId) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      abortRef.current = new AbortController();
      try {
        const res = await fetch(`/api/ingest-status?batch_id=${batchId}`, {
          signal: abortRef.current.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { files: StatusRow[] };
        if (!cancelled) setRows(data.files);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("status poll failed:", err);
        }
      }
    };
    void tick();
    const id = setInterval(() => { void tick(); }, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [batchId]);

  function addFiles(incoming: FileList | File[]) {
    const arr = Array.from(incoming);
    setFiles((prev) => {
      const map = new Map(prev.map((f) => [`${f.name}_${f.size}`, f] as const));
      for (const f of arr) map.set(`${f.name}_${f.size}`, f);
      return Array.from(map.values());
    });
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    setUploadError(null);
    if (e.target.files) addFiles(e.target.files);
    e.target.value = "";  // allow re-selecting same file
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    dragCounter.current = 0;
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
  }
  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragCounter.current += 1;
    setIsDragging(true);
  }
  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragging(false);
    }
  }
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  async function onUpload() {
    setUploadError(null);
    if (files.length === 0) {
      setUploadError("请选择至少一个文件");
      return;
    }
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("trust_level", String(trustLevel));
      for (const f of files) form.append("file", f);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`upload failed: ${res.status} ${text}`);
      }
      const data = (await res.json()) as { batch_id: string; files: UploadFileResult[] };
      setBatchId(data.batch_id);
      // 初始化 rows 为 pending
      setRows(data.files.map((f) => ({
        file_id: f.file_id,
        filename: f.filename,
        status: "pending",
        progress: 0,
        error_code: null,
        error_message: null,
        cloud_source_id: null,
        cloud_document_id: null,
        retryable: 0,
      })));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onRetry(fileId: string) {
    setRetrying((prev) => new Set(prev).add(fileId));
    try {
      const res = await fetch(`/api/retry?file_id=${fileId}`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        // 弹个 console 警告；UI 暂时不变（status polling 会反映）
        console.warn(`retry ${fileId} failed:`, data.message ?? res.status);
      }
      // 1s 后 polling 会自动更新
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  }

  function resetAll() {
    setFiles([]);
    setBatchId(null);
    setRows([]);
    setUploadError(null);
  }

  const allDone = rows.length > 0 && rows.every((r) => r.status === "done" || r.status === "failed");

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">本地上传文件</h2>
        <LlmStatus />
      </div>

      {/* 拖拽区 + 文件选择 */}
      <div
        onDrop={onDrop}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        className={`rounded border-2 border-dashed p-8 text-center transition-colors ${
          isDragging
            ? "border-blue-500 bg-blue-50"
            : "border-gray-300 bg-white hover:border-gray-400"
        }`}
        data-testid="dropzone"
      >
        <p className="text-sm text-gray-600">
          拖入文件到此处，或
          <label className="ml-1 cursor-pointer text-blue-600 underline hover:text-blue-700">
            点击选择
            <input
              type="file"
              multiple
              onChange={onFileChange}
              className="hidden"
              data-testid="file-input"
            />
          </label>
        </p>
        <p className="mt-2 text-xs text-gray-400">支持 PDF / DOCX / HTML / TXT / MD（单批 ≤5MB）</p>
      </div>

      {/* 待上传文件列表 */}
      {files.length > 0 && !batchId && (
        <div className="rounded border border-gray-200 bg-white p-4">
          <div className="mb-2 text-sm font-medium text-gray-700">
            待上传：{files.length} 个文件
          </div>
          <ul className="space-y-1 text-sm">
            {files.map((f, i) => (
              <li key={`${f.name}_${f.size}`} className="flex items-center justify-between text-gray-700">
                <span className="truncate">
                  <span className="text-gray-400">{f.name}</span>
                  <span className="ml-2 text-xs text-gray-400">
                    {(f.size / 1024).toFixed(1)} KB
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => removeFile(i)}
                  className="text-xs text-red-600 hover:text-red-800"
                >
                  移除
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex items-center gap-4">
            <div>
              <label className="mr-2 text-sm text-gray-700">信任等级：</label>
              <select
                value={trustLevel}
                onChange={(e) => setTrustLevel(Number(e.target.value) as TrustLevel)}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
              >
                {TRUST_LEVELS.map((lvl) => (
                  <option key={lvl} value={lvl}>{lvl}</option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={onUpload}
              disabled={submitting}
              className="rounded bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
              data-testid="upload-btn"
            >
              {submitting ? "上传中…" : `上传 ${files.length} 个文件`}
            </button>
          </div>
        </div>
      )}

      {uploadError && (
        <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-900">
          {uploadError}
        </div>
      )}

      {/* 状态表格（轮询结果） */}
      {rows.length > 0 && (
        <div className="rounded border border-gray-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-medium text-gray-700">
              批次：<code className="rounded bg-gray-100 px-1 text-xs">{batchId}</code>
              <span className="ml-3 text-xs text-gray-500">
                {allDone ? "已完成" : "处理中…（每 1s 自动刷新）"}
              </span>
            </div>
            <button
              type="button"
              onClick={resetAll}
              className="rounded border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              清空 / 新批次
            </button>
          </div>

          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="py-2">文件名</th>
                <th className="py-2">状态</th>
                <th className="py-2">进度</th>
                <th className="py-2">结果 / 错误</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.file_id} className="border-b last:border-b-0">
                  <td className="py-2 pr-4">
                    <div className="truncate font-medium">{r.filename}</div>
                    <div className="text-xs text-gray-400">{r.file_id.slice(0, 8)}</div>
                  </td>
                  <td className="py-2 pr-4">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="py-2 pr-4">
                    <ProgressBar value={r.progress} />
                  </td>
                  <td className="py-2 pr-4">
                    {r.status === "done" && r.cloud_source_id && (
                      <div className="text-xs text-green-700">
                        <div>source: {r.cloud_source_id}</div>
                        <div>document: {r.cloud_document_id}</div>
                      </div>
                    )}
                    {r.status === "failed" && (
                      <div className="text-xs text-red-700">
                        <div className="font-medium">
                          {translateErrorMessage(r.error_code, r.error_message)}
                        </div>
                        {r.error_code && (
                          <div className="mt-1 text-gray-500">
                            code: <code className="rounded bg-gray-100 px-1">{r.error_code}</code>
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="py-2">
                    {r.status === "failed" && r.retryable === 1 && (
                      <button
                        type="button"
                        onClick={() => onRetry(r.file_id)}
                        disabled={retrying.has(r.file_id)}
                        className="rounded border border-blue-300 bg-white px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                        data-testid={`retry-${r.file_id}`}
                      >
                        {retrying.has(r.file_id) ? "重推中…" : "重推"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: "等待中", cls: "bg-gray-100 text-gray-700" },
    parsing: { label: "解析中", cls: "bg-yellow-100 text-yellow-800" },
    chunking: { label: "切分中", cls: "bg-yellow-100 text-yellow-800" },
    embedding: { label: "Embedding", cls: "bg-yellow-100 text-yellow-800" },
    pushing: { label: "推送中", cls: "bg-blue-100 text-blue-800" },
    done: { label: "完成", cls: "bg-green-100 text-green-800" },
    failed: { label: "失败", cls: "bg-red-100 text-red-800" },
  };
  const s = map[status] ?? { label: status, cls: "bg-gray-100 text-gray-700" };
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}

function ProgressBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-24 overflow-hidden rounded bg-gray-200">
      <div
        className="h-full bg-blue-500 transition-all"
        style={{ width: `${v}%` }}
      />
    </div>
  );
}