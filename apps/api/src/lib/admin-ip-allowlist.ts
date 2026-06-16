/**
 * M6.10: admin IP 白名单（spec §5）。
 * 解决：admin 输错 5 次错 admin_token 锁本机 IP 15min UX 差。
 *
 * 配置：env.ADMIN_IP_ALLOWLIST = "1.2.3.4,5.6.7.8,127.0.0.1"
 * 行为：白名单 IP 跳过 /auth/admin-login 的 checkRateLimitDual
 *
 * 失败：未设 / 空 → 白名单空 → 行为不变（正常限流）
 */

export function parseAdminIpAllowlist(env: { ADMIN_IP_ALLOWLIST?: string }): string[] {
  if (!env.ADMIN_IP_ALLOWLIST) return [];
  return env.ADMIN_IP_ALLOWLIST
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function isAdminIpAllowed(clientIp: string, allowlist: string[]): boolean {
  return allowlist.includes(clientIp);
}
