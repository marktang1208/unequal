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