import { describe, it, expect, vi } from "vitest";
import { jscode2session } from "../../src/lib/wx.js";

function makeFetchMock(impl: (url: string) => Promise<Response> | Response): typeof fetch {
  return vi.fn(async (url: string) => impl(url)) as unknown as typeof fetch;
}

describe("wx.jscode2session (fetchImpl 注入 mock)", () => {
  it("happy: 200 + { openid, session_key } → 返 WxSessionResult", async () => {
    const fetchMock = makeFetchMock(async (url) => {
      // verify URL 含正确 query params
      const u = new URL(url);
      expect(u.searchParams.get("appid")).toBe("wx_test_id");
      expect(u.searchParams.get("secret")).toBe("wx_test_secret");
      expect(u.searchParams.get("js_code")).toBe("test_code_081H1z");
      expect(u.searchParams.get("grant_type")).toBe("authorization_code");
      return new Response(JSON.stringify({ openid: "mock_openid_001", session_key: "mock_session_key" }), { status: 200 });
    });
    const got = await jscode2session({
      code: "test_code_081H1z",
      appId: "wx_test_id",
      appSecret: "wx_test_secret",
      fetchImpl: fetchMock,
    });
    expect(got.openid).toBe("mock_openid_001");
    expect(got.session_key).toBe("mock_session_key");
  });

  it("errcode != 0 → 抛 HttpError 401 INVALID_CODE", async () => {
    const fetchMock = makeFetchMock(() =>
      new Response(JSON.stringify({ errcode: 40029, errmsg: "invalid code" }), { status: 200 }),
    );
    await expect(
      jscode2session({ code: "bad", appId: "wx_id", appSecret: "wx_secret", fetchImpl: fetchMock }),
    ).rejects.toMatchObject({ status: 401, code: "INVALID_CODE" });
  });

  it("network error (fetch throw) → 抛 HttpError 502 WX_API_ERROR", async () => {
    const fetchMock = makeFetchMock(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      jscode2session({ code: "test", appId: "wx_id", appSecret: "wx_secret", fetchImpl: fetchMock }),
    ).rejects.toMatchObject({ status: 502, code: "WX_API_ERROR" });
  });

  it("缺 appId → 抛 HttpError 500 INFRA_MISSING", async () => {
    await expect(
      jscode2session({ code: "test", appId: "", appSecret: "wx_secret" }),
    ).rejects.toMatchObject({ status: 500, code: "INFRA_MISSING" });
  });
});