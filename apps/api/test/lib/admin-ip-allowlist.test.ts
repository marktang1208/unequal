/**
 * M6.10 lib/admin-ip-allowlist.ts 测试套件（spec §6 + §10）。
 *
 * 5 + 3 用例覆盖：
 * parseAdminIpAllowlist (5):
 *   1. env 未设 → 返 []
 *   2. env.ADMIN_IP_ALLOWLIST = '' → 返 []
 *   3. env.ADMIN_IP_ALLOWLIST = '1.2.3.4' → 返 ['1.2.3.4']
 *   4. env.ADMIN_IP_ALLOWLIST = '1.2.3.4,5.6.7.8,127.0.0.1' → 返 3 个
 *   5. env.ADMIN_IP_ALLOWLIST 含空格 + 空 → trim + filter
 * isAdminIpAllowed (3):
 *   6. 命中: clientIp 在白名单 → true
 *   7. 未命中: clientIp 不在白名单 → false
 *   8. 空白名单 → false
 *
 * 测试策略：纯函数单元测试，不依赖 D1 / miniflare。
 */
import { describe, it, expect } from "vitest";
import {
  parseAdminIpAllowlist,
  isAdminIpAllowed,
} from "../../src/lib/admin-ip-allowlist.js";

describe("admin-ip-allowlist.parseAdminIpAllowlist (M6.10)", () => {
  it("env 未设 → 返 []", () => {
    expect(parseAdminIpAllowlist({})).toEqual([]);
  });

  it("env.ADMIN_IP_ALLOWLIST = '' → 返 []", () => {
    expect(parseAdminIpAllowlist({ ADMIN_IP_ALLOWLIST: "" })).toEqual([]);
  });

  it("env.ADMIN_IP_ALLOWLIST = '1.2.3.4' → 返 ['1.2.3.4']", () => {
    expect(parseAdminIpAllowlist({ ADMIN_IP_ALLOWLIST: "1.2.3.4" })).toEqual(["1.2.3.4"]);
  });

  it("env.ADMIN_IP_ALLOWLIST = '1.2.3.4,5.6.7.8,127.0.0.1' → 返 3 个", () => {
    expect(
      parseAdminIpAllowlist({ ADMIN_IP_ALLOWLIST: "1.2.3.4,5.6.7.8,127.0.0.1" }),
    ).toEqual(["1.2.3.4", "5.6.7.8", "127.0.0.1"]);
  });

  it("env.ADMIN_IP_ALLOWLIST = '1.2.3.4, 5.6.7.8, , ' → trim + filter 空 → 2 个", () => {
    expect(
      parseAdminIpAllowlist({ ADMIN_IP_ALLOWLIST: "1.2.3.4, 5.6.7.8, , " }),
    ).toEqual(["1.2.3.4", "5.6.7.8"]);
  });
});

describe("admin-ip-allowlist.isAdminIpAllowed (M6.10)", () => {
  it("命中: clientIp 在白名单 → true", () => {
    expect(isAdminIpAllowed("1.2.3.4", ["1.2.3.4", "5.6.7.8"])).toBe(true);
  });

  it("未命中: clientIp 不在白名单 → false", () => {
    expect(isAdminIpAllowed("9.9.9.9", ["1.2.3.4", "5.6.7.8"])).toBe(false);
  });

  it("空白名单 → false", () => {
    expect(isAdminIpAllowed("1.2.3.4", [])).toBe(false);
  });
});
