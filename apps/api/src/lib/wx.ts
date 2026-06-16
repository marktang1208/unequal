import { HttpError } from "./auth.js";

export interface WxSessionResult {
  openid: string;
  session_key: string;
  unionid?: string;
}

export interface Jscode2SessionOptions {
  code: string;
  appId: string;
  appSecret: string;
  fetchImpl?: typeof fetch;
}

const WX_API_BASE = "https://api.weixin.qq.com/sns/jscode2session";

export async function jscode2session(opts: Jscode2SessionOptions): Promise<WxSessionResult> {
  if (!opts.appId) {
    throw new HttpError(500, "INFRA_MISSING", "WX_APP_ID is not configured");
  }
  if (!opts.appSecret) {
    throw new HttpError(500, "INFRA_MISSING", "WX_APP_SECRET is not configured");
  }
  const f = opts.fetchImpl ?? fetch;
  const url = new URL(WX_API_BASE);
  url.searchParams.set("appid", opts.appId);
  url.searchParams.set("secret", opts.appSecret);
  url.searchParams.set("js_code", opts.code);
  url.searchParams.set("grant_type", "authorization_code");

  let res: Response;
  try {
    res = await f(url.toString());
  } catch (err) {
    throw new HttpError(502, "WX_API_ERROR", `jscode2session network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new HttpError(502, "WX_API_ERROR", `jscode2session HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    openid?: string;
    session_key?: string;
    unionid?: string;
    errcode?: number;
    errmsg?: string;
  };
  if (data.errcode || !data.openid) {
    throw new HttpError(401, "INVALID_CODE", data.errmsg ?? "jscode2session returned no openid");
  }
  return { openid: data.openid, session_key: data.session_key ?? "", unionid: data.unionid };
}