/**
 * handler-utils 单测 (P10+ 真接 bugfix)
 *
 * 覆盖 getClientIp 3 个 case：
 * 1. headers=undefined (CloudBase gateway bug 真接发现)
 * 2. headers={} (空对象)
 * 3. headers={"x-real-ip": "1.2.3.4"} (正常)
 * 4. headers 大小写不敏感 (X-Real-IP 也命中)
 * 5. headers fallback 优先级 (x-real-ip > x-forwarded-for)
 */

import { describe, it, expect } from "vitest";
import { getClientIp, type HttpTriggerEvent } from "../../src/lib/handler-utils.js";

function makeEvent(headers: Record<string, string> | undefined): HttpTriggerEvent {
  return {
    httpMethod: "GET",
    path: "/test",
    ...(headers !== undefined ? { headers } : {}),
    body: null,
    isBase64Encoded: false,
  };
}

describe("getClientIp (P10+ bugfix)", () => {
  it("headers=undefined → 返 'unknown'（不 crash）", () => {
    const event = makeEvent(undefined);
    expect(() => getClientIp(event)).not.toThrow();
    expect(getClientIp(event)).toBe("unknown");
  });

  it("headers={} → 返 'unknown'", () => {
    const event = makeEvent({});
    expect(getClientIp(event)).toBe("unknown");
  });

  it("headers={'x-real-ip': '1.2.3.4'} → 返 IP", () => {
    const event = makeEvent({ "x-real-ip": "1.2.3.4" });
    expect(getClientIp(event)).toBe("1.2.3.4");
  });

  it("headers 大小写不敏感 (X-Real-IP 也命中)", () => {
    const event = makeEvent({ "X-Real-IP": "5.6.7.8" });
    expect(getClientIp(event)).toBe("5.6.7.8");
  });

  it("x-real-ip 优先于 x-forwarded-for", () => {
    const event = makeEvent({
      "x-real-ip": "1.1.1.1",
      "x-forwarded-for": "2.2.2.2",
    });
    expect(getClientIp(event)).toBe("1.1.1.1");
  });

  it("无 x-real-ip 时 fallback 到 x-forwarded-for", () => {
    const event = makeEvent({ "x-forwarded-for": "9.9.9.9" });
    expect(getClientIp(event)).toBe("9.9.9.9");
  });
});