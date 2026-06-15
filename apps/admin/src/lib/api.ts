import type { TrustLevel } from "@unequal/shared/types";

// React app 走 Vite proxy：`/api/*` → `http://localhost:8787/*`（前缀被剥离）
const API_BASE = "/api";

export function getToken(): string {
  const token = localStorage.getItem("admin_token");
  if (token) return token;
  // Dev-only fallback so the local dev experience still works
  // (set localStorage("admin_token", "...") for any non-dev env).
  // Production builds throw to avoid silent auth.
  if (import.meta.env.DEV) return "dev-token-change-me";
  throw new Error("admin_token 未设置：请先在 localStorage 设置 admin_token");
}

export interface UploadResponse {
  sourceId: string;
  documentId: string;
  chunkCount: number;
  r2Key: string;
}

export interface SearchHit {
  chunkId: string;
  sourceId?: string;
  documentId?: string;
  trustLevel: number;
  finalScore: number;
  vectorizeScore: number;
  content: string;
}

export interface SearchResponse {
  q: string;
  hits: SearchHit[];
}

export async function uploadFile(
  file: File,
  trustLevel: TrustLevel
): Promise<UploadResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("trust_level", String(trustLevel));

  const resp = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`upload failed: ${resp.status} ${text}`);
  }
  return (await resp.json()) as UploadResponse;
}

export async function search(q: string, topK = 5): Promise<SearchResponse> {
  const params = new URLSearchParams({ q, topK: String(topK) });
  const resp = await fetch(`${API_BASE}/search?${params.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`search failed: ${resp.status} ${text}`);
  }
  return (await resp.json()) as SearchResponse;
}