import { describe, it, expect } from "vitest";
import {
  parseAdminIpAllowlist,
  isAdminIpAllowed,
} from "../../src/lib/admin-ip-allowlist.js";

describe("parseAdminIpAllowlist (CP-6)", () => {
  it("env 未设 → 返 []", () => {
    expect(parseAdminIpAllowlist({})).toEqual([]);
  });
  it("env.ADMIN_IP_ALLOWLIST = '' → 返 []", () => {
    expect(parseAdminIpAllowlist({ ADMIN_IP_ALLOWLIST: "" })).toEqual([]);
  });
  it("single IP", () => {
    expect(parseAdminIpAllowlist({ ADMIN_IP_ALLOWLIST: "1.2.3.4" })).toEqual([
      "1.2.3.4",
    ]);
  });
  it("comma-separated list", () => {
    expect(
      parseAdminIpAllowlist({
        ADMIN_IP_ALLOWLIST: "1.2.3.4,5.6.7.8,127.0.0.1",
      }),
    ).toEqual(["1.2.3.4", "5.6.7.8", "127.0.0.1"]);
  });
  it("trim + filter empty", () => {
    expect(
      parseAdminIpAllowlist({ ADMIN_IP_ALLOWLIST: "1.2.3.4, 5.6.7.8, , " }),
    ).toEqual(["1.2.3.4", "5.6.7.8"]);
  });
  it("IPv6 单值", () => {
    expect(
      parseAdminIpAllowlist({
        ADMIN_IP_ALLOWLIST: "240e:3b4:38ed:4100:10a1:f77f:f362:d8b0",
      }),
    ).toEqual(["240e:3b4:38ed:4100:10a1:f77f:f362:d8b0"]);
  });
  it("IPv4 + IPv6 混合", () => {
    expect(
      parseAdminIpAllowlist({
        ADMIN_IP_ALLOWLIST: "127.0.0.1,240e:3b4:38ed:4100::1",
      }),
    ).toEqual(["127.0.0.1", "240e:3b4:38ed:4100::1"]);
  });
});

describe("isAdminIpAllowed (CP-6)", () => {
  it("命中 IPv4 → true", () => {
    expect(isAdminIpAllowed("1.2.3.4", ["1.2.3.4", "5.6.7.8"])).toBe(true);
  });
  it("命中 IPv6 → true", () => {
    expect(
      isAdminIpAllowed("240e:3b4:38ed:4100:10a1:f77f:f362:d8b0", [
        "240e:3b4:38ed:4100:10a1:f77f:f362:d8b0",
      ]),
    ).toBe(true);
  });
  it("未命中 → false", () => {
    expect(isAdminIpAllowed("9.9.9.9", ["1.2.3.4", "5.6.7.8"])).toBe(false);
  });
  it("空白名单 → false", () => {
    expect(isAdminIpAllowed("1.2.3.4", [])).toBe(false);
  });
});

describe("isAdminIpAllowed CIDR (P0-#1)", () => {
  it("[1] 单 IP 精确匹配 (回归)", () => {
    expect(isAdminIpAllowed("192.0.2.46", ["192.0.2.46"])).toBe(true);
  });
  it("[2] IPv4 在 /24 CIDR 范围内", () => {
    expect(isAdminIpAllowed("192.0.2.46", ["192.0.2.0/24"])).toBe(true);
  });
  it("[3] IPv4 在 /24 CIDR 范围外", () => {
    expect(isAdminIpAllowed("198.51.100.46", ["192.0.2.0/24"])).toBe(false);
  });
  it("[4] IPv4 在 /32 CIDR 范围内 (=单 IP)", () => {
    expect(isAdminIpAllowed("192.0.2.46", ["192.0.2.46/32"])).toBe(true);
  });
  it("[5] IPv4 在 /16 CIDR 范围内 (RFC 5737 文档段)", () => {
    expect(isAdminIpAllowed("192.0.2.46", ["192.0.2.0/16"])).toBe(true);
  });
  it("[6] bits=0 匹配所有 IPv4", () => {
    expect(isAdminIpAllowed("8.8.8.8", ["0.0.0.0/0"])).toBe(true);
  });
  it("[7] bits=33 非法 → false", () => {
    expect(isAdminIpAllowed("192.0.2.46", ["192.0.2.0/33"])).toBe(false);
  });
  it("[8] CIDR 格式错误 (无 /) → 走精确匹配", () => {
    // 无 / 时 entry 当单 IP 处理, 不等 → false
    expect(isAdminIpAllowed("192.0.2.46", ["192.0.2.0"])).toBe(false);
    // 等于时 → true (与现有行为一致)
    expect(isAdminIpAllowed("192.0.2.46", ["192.0.2.46"])).toBe(true);
  });
  it("[9] IPv6 CIDR 暂不支持 → false", () => {
    expect(isAdminIpAllowed("240e:3b4::1", ["240e:3b4::/32"])).toBe(false);
  });
  it("[10] 空 allowlist → false", () => {
    expect(isAdminIpAllowed("192.0.2.46", [])).toBe(false);
  });
  it("[11] 混合 allowlist (单 IP + CIDR) OR 语义", () => {
    // 单 IP 命中
    expect(isAdminIpAllowed("1.2.3.4", ["1.2.3.4", "192.0.2.0/24"])).toBe(true);
    // CIDR 命中
    expect(isAdminIpAllowed("192.0.2.99", ["1.2.3.4", "192.0.2.0/24"])).toBe(true);
    // 都不命中
    expect(isAdminIpAllowed("9.9.9.9", ["1.2.3.4", "192.0.2.0/24"])).toBe(false);
  });
  it("[12] IPv4 格式错误 (5 段) → false", () => {
    expect(isAdminIpAllowed("1.2.3.4.5", ["192.0.2.0/24"])).toBe(false);
  });
});