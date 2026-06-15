import type { AskResponse, AskError } from "./types.js";

/**
 * 调 /ask endpoint 拿单轮问答。
 * Mock-first：
 * - 开发期 base URL = http://localhost:8787（需在微信开发者工具勾选「不校验合法域名」）
 * - CP-5 真接 Cloudflare 后改 https://unequal.xxx.workers.dev
 * - fetch 注入点允许测试桩（Vitest 单测）
 *
 * 三方环境兼容：
 * - Vitest Node 单测：opts.fetchImpl 注入
 * - 小程序运行时：wx 全局存在，走 wxRequestAsFetch（globalThis.fetch 不存在）
 * - 其它（admin / 浏览器）：原生 fetch
 */

export interface AskOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

interface ResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** 把 wx.request 包成 fetch 兼容的 Promise 接口。miniprogram 运行时唯一可用的 HTTP 通道。 */
function wxRequestAsFetch(input: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<ResponseLike> {
  return new Promise((resolve, reject) => {
    // miniprogram-api-typings 没装，wx 全局在 tsc 看是 any
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.request({
      url: input,
      method: (init.method ?? "GET") as any,
      header: init.headers as any,
      data: init.body as any,
      success: (res: any) => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        const bodyText = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
        const response: ResponseLike = {
          ok,
          status: res.statusCode,
          statusText: "",
          json: async () => {
            try { return JSON.parse(bodyText); } catch { return {}; }
          },
          text: async () => bodyText,
        };
        resolve(response);
      },
      fail: (err: any) => reject(new Error(err.errMsg ?? "wx.request failed")),
    });
  });
}

export async function ask(q: string, opts: AskOptions = {}): Promise<AskResponse> {
  const baseUrl = opts.baseUrl ?? "http://localhost:8787";
  const f: (input: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<ResponseLike> =
    opts.fetchImpl
    // @ts-expect-error wx 全局类型 mock-first 缺失
    ?? (typeof wx !== "undefined" && typeof wx.request === "function" ? wxRequestAsFetch : fetch);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  const res = await f(`${baseUrl}/ask`, {
    method: "POST",
    headers,
    body: JSON.stringify({ q }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as AskError;
    throw new Error(`/ask ${res.status}: ${body.error ?? "unknown"}`);
  }

  return (await res.json()) as AskResponse;
}
