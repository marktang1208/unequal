/**
 * CP-6: admin IP 白名单（spec §5.3）
 *
 * 沿用 v0 M6.10 设计：string equality，不支持 CIDR；
 * 改成从 process.env 读取（v0 走 Env binding）。
 *
 * IPv6 字符串兼容：`240e:3b4:...` 全字符串包含匹配。
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
  return allowlist.includes(clientIp);
}