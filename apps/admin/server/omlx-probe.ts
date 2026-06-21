/**
 * OMLX runtime probe — 检查 OMLX (Apple MLX OpenAI 兼容) 是否在线
 *
 * 通过 GET {baseUrl}/v1/models 探活（OpenAI API 兼容约定）。
 * 失败 → 返回 { available: false, error }
 *
 * 设计：
 * - 短超时（2s）：避免阻塞 dev server
 * - 不抛错：调用方只看 available 字段
 */

export interface OllamaModelsResponse {
  data?: Array<{ id: string }>;
}

export interface OmlxProbeResult {
  available: boolean;
  url: string;
  models: string[];
  error?: string;
}

const DEFAULT_URL = "http://localhost:11434/v1";
const PROBE_TIMEOUT_MS = 2000;

export async function probeOmlx(
  baseUrl: string = DEFAULT_URL,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<OmlxProbeResult> {
  const url = `${baseUrl}/models`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      return { available: false, url: baseUrl, models: [], error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as OllamaModelsResponse;
    const models = (data.data ?? []).map((m) => m.id);
    return { available: true, url: baseUrl, models };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // AbortError 通常是超时
    if ((err as { name?: string }).name === "AbortError") {
      return { available: false, url: baseUrl, models: [], error: `timeout after ${timeoutMs}ms` };
    }
    return { available: false, url: baseUrl, models: [], error: msg };
  }
}