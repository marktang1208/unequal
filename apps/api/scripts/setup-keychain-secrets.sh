#!/usr/bin/env bash
# P4 secrets manager — one-time 迁移 6 secrets 到 macOS Keychain
#
# 用法：
#   1. 编辑下面的 SECRETS_* 值（从你 secure password manager 复制）
#   2. ./scripts/setup-keychain-secrets.sh
#   3. 之后 deploy 走：pnpm -F api deploy:secrets-v2
#
# Keychain 项：service="unequal:api-router:<KEY>", account="unequal-deploy"
# 用 `security find-generic-password -s unequal:api-router:ADMIN_TOKEN` 可查询

set -euo pipefail

ACCOUNT="unequal-deploy"
PREFIX="unequal:api-router:"

# ⚠️ 这里 6 个值需要你从 password manager 复制（不要 commit 到 git！）
SECRETS_ADMIN_TOKEN=""
SECRETS_JWT_SECRET=""
SECRETS_MINIMAX_API_KEY=""
SECRETS_KEK_SECRET_V1=""
SECRETS_INGEST_PROXY_SECRET=""
SECRETS_ADMIN_IP_ALLOWLIST=""

# 防御：如果 SECRETS_* 是空 → 拒绝运行（避免误把空值写进 Keychain）
check_non_empty() {
  local name="$1" val="$2"
  if [ -z "$val" ]; then
    echo "❌ $name 未设置" >&2
    echo "   编辑本脚本填入值（建议从密码管理器复制）" >&2
    exit 1
  fi
}

check_non_empty "SECRETS_ADMIN_TOKEN" "$SECRETS_ADMIN_TOKEN"
check_non_empty "SECRETS_JWT_SECRET" "$SECRETS_JWT_SECRET"
check_non_empty "SECRETS_MINIMAX_API_KEY" "$SECRETS_MINIMAX_API_KEY"
check_non_empty "SECRETS_KEK_SECRET_V1" "$SECRETS_KEK_SECRET_V1"
check_non_empty "SECRETS_INGEST_PROXY_SECRET" "$SECRETS_INGEST_PROXY_SECRET"
check_non_empty "SECRETS_ADMIN_IP_ALLOWLIST" "$SECRETS_ADMIN_IP_ALLOWLIST"

add_secret() {
  local key="$1" val="$2"
  # 删旧的（如果存在）
  security delete-generic-password -a "$ACCOUNT" -s "${PREFIX}${key}" 2>/dev/null || true
  # 加新的
  security add-generic-password -a "$ACCOUNT" -s "${PREFIX}${key}" -w "$val" -U >/dev/null
  echo "  ✓ $key (len=${#val})"
}

echo "[setup-keychain-secrets] 写 6 secrets 到 macOS Keychain"
add_secret "ADMIN_TOKEN" "$SECRETS_ADMIN_TOKEN"
add_secret "JWT_SECRET" "$SECRETS_JWT_SECRET"
add_secret "MINIMAX_API_KEY" "$SECRETS_MINIMAX_API_KEY"
add_secret "KEK_SECRET_V1" "$SECRETS_KEK_SECRET_V1"
add_secret "INGEST_PROXY_SECRET" "$SECRETS_INGEST_PROXY_SECRET"
add_secret "ADMIN_IP_ALLOWLIST" "$SECRETS_ADMIN_IP_ALLOWLIST"

echo ""
echo "✅ 6 secrets 写入完成"
echo ""
echo "验证："
echo "  security find-generic-password -a $ACCOUNT -s ${PREFIX}ADMIN_TOKEN -w"
echo ""
echo "下一步："
echo "  pnpm -F api deploy:secrets-v2   # 推 12 vars 到 CloudBase"
