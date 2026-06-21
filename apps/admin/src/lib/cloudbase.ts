/**
 * CloudBase Gateway 客户端（admin 测试页用）
 *
 * admin 走 cloudbase Gateway callFunction 直接调 api-router（不走 HTTP 网关）。
 * 原因：CloudBase 个人版 HTTP 网关有"功能缺失及稳定性风险"（官方警告）。
 *
 * 实现：直接 fetch `${envId}.api.tcloudbasegateway.com`（CloudBase 网关端点）
 *  - 匿名登录 → 拿 access_token
 *  - 调函数：POST /v1/envs/{envId}/functions/{name}:invoke + Bearer token
 *
 * js-sdk 1.8 改了 auth API，匿名登录不直观；直接 fetch 更稳。
 * 仅 admin 测试页用，不进业务代码（admin 业务调函数走 admin_token + CF Pages Functions proxy）。
 */

const ENV_ID = import.meta.env.VITE_TCB_ENV_ID as string | undefined;
const GATEWAY = ENV_ID ? `https://${ENV_ID}.api.tcloudbasegateway.com` : null;

export function isCloudBaseConfigured(): boolean {
  return Boolean(ENV_ID);
}

export function getEnvId(): string {
  return ENV_ID ?? "(not configured)";
}

/** HttpTriggerEvent-shaped payload for api-router */
export interface HttpEvent {
  httpMethod: string;
  path: string;
  headers: Record<string, string>;
  queryString: Record<string, string>;
  body: string | null;
  isBase64Encoded: boolean;
}

export interface HttpResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/** 拿 access_token（匿名登录）。缓存到过期前 60s。 */
async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  if (!GATEWAY) throw new Error("CloudBase not configured");
  // 匿名登录（不需要任何凭证；返回 access_token 有效期 ~2h）
  const res = await fetch(`${GATEWAY}/v1/auth/anonymous-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`anonymous-login failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in: number; // seconds
  };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

/** 调 api-router。失败抛错。 */
export async function callApiRouter(event: HttpEvent): Promise<HttpResponse> {
  if (!GATEWAY) {
    throw new Error("CloudBase not configured. Set VITE_TCB_ENV_ID in .env.local");
  }
  const token = await getAccessToken();
  const res = await fetch(
    `${GATEWAY}/v1/envs/${ENV_ID}/functions/api-router:invoke`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ data: event }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`callFunction failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { result?: HttpResponse; data?: HttpResponse };
  // CloudBase invoke response 格式: { result: <handler return>, requestId }
  // handler return = HttpResponse = { statusCode, headers, body }
  return (data.result ?? data.data) as HttpResponse;
}


