import { useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { uploadFile, type UploadResponse } from "../lib/api.js";
import type { TrustLevel } from "@unequal/shared/types";

const TRUST_LEVELS: TrustLevel[] = [0, 1, 2, 3];

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [trustLevel, setTrustLevel] = useState<TrustLevel>(0);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    setError(null);
    setResult(null);
    setFile(e.target.files?.[0] ?? null);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!file) {
      setError("请选择文件");
      return;
    }
    setSubmitting(true);
    try {
      const resp = await uploadFile(file, trustLevel);
      setResult(resp);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-6">
      <h2 className="text-xl font-semibold">上传文件</h2>

      <form onSubmit={onSubmit} className="space-y-4 rounded border border-gray-200 bg-white p-6">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">文件</label>
          <input
            type="file"
            onChange={onFileChange}
            className="block w-full text-sm text-gray-700 file:mr-4 file:rounded file:border-0 file:bg-gray-900 file:px-4 file:py-2 file:text-sm file:text-white hover:file:bg-gray-700"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">信任等级 (trust_level)</label>
          <select
            value={trustLevel}
            onChange={(e) => setTrustLevel(Number(e.target.value) as TrustLevel)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          >
            {TRUST_LEVELS.map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {submitting ? "上传中…" : "上传"}
        </button>
      </form>

      {result && (
        <div className="rounded border border-green-300 bg-green-50 p-4 text-sm text-green-900">
          <div className="font-medium">上传成功</div>
          <div>sourceId: {result.sourceId}</div>
          <div>documentId: {result.documentId}</div>
          <div>chunkCount: {result.chunkCount}</div>
          <div>r2Key: {result.r2Key}</div>
        </div>
      )}

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-900">{error}</div>
      )}
    </section>
  );
}