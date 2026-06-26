/**
 * CP-6: admin IP 白名单 (spec §5.3)
 *
 * 沿用 v0 M6.10 设计: string equality;
 * P0-#1 扩展: 支持 IPv4 CIDR 范围匹配 (e.g. "192.0.2.0/24");
 * IPv6 CIDR 暂不支持, 显式拒绝 (留作未来 candidate)。
 *
 * IPv6 字符串兼容: `240e:3b4:...` 全字符串包含匹配。
 */

interface AllowlistSource {
  ADMIN_IP_ALLOWLIST?: string;
}

export function parseAdminIpAllowlist(source: AllowlistSource): string[] {
  if (!source.ADMIN_IP_ALLOWLIST) return [];
  return source.ADMIN_IP_ALLOWLIST.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function isAdminIpAllowed(clientIp: string, allowlist: string[]): boolean {
  for (const entry of allowlist) {
    // 单 IP 精确匹配 (向后兼容)
    if (entry === clientIp) return true;
    // CIDR 范围匹配 (P0-#1 新增)
    if (entry.includes("/") && isCidrMatch(clientIp, entry)) return true;
  }
  return false;
}

/**
 * IPv4 CIDR 范围匹配
 *
 * @param ip IPv4 字符串 (e.g. "192.0.2.46")
 * @param cidr CIDR 字符串 (e.g. "192.0.2.0/24")
 * @returns true if ip 在 cidr 范围内
 *
 * 边界:
 * - bits=0 → 匹配所有 IPv4
 * - bits=32 → 等价单 IP 精确匹配
 * - bits<0 或 bits>32 → false
 * - IPv6 CIDR 暂不支持 → false (clientIp 含 ":" 或 cidr 含 ":")
 * - 任何一段格式错误 → false
 */
export function isCidrMatch(ip: string, cidr: string): boolean {
  // IPv6 CIDR 暂不支持
  if (ip.includes(":") || cidr.includes(":")) return false;

  const slashIdx = cidr.indexOf("/");
  if (slashIdx === -1) return false;  // 无 "/" 不是 CIDR
  const range = cidr.slice(0, slashIdx);
  const bitsStr = cidr.slice(slashIdx + 1);
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits) || bits < 0 || bits > 32) return false;

  const ipNum = ipToNumber(ip);
  const rangeNum = ipToNumber(range);
  if (ipNum === null || rangeNum === null) return false;

  if (bits === 0) return true;  // /0 匹配所有
  const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

/** IPv4 字符串 → 32 位无符号整数; 格式错误返 null */
function ipToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = parseInt(p, 10);
    if (isNaN(v) || v < 0 || v > 255) return null;
    // 累加前先左移 8 位, 避免第一个段被乘 256 错位
    n = (n * 256) + v;
  }
  return n;
}
