#!/usr/bin/env bash
#
# CP-6: 用 @cloudbase/cli (tcb) 部署 9 indexes + 4 secrets + 8 vars + 13 functions
#
# 用法：
#   1. 安装 CLI：npm install -g @cloudbase/cli
#   2. 登录（API Key 3.0 模式）：tcb login --apiKeyId <SECRET_ID>
#      或：tcb login -e <ENV_ID> （交互输入 SecretId/SecretKey）
#   3. ./scripts/deploy-functions.sh
#
# 前提：
#   - CloudBase 环境已创建 + 9 collection 已建（deploy:collections 跑过）
#   - 9 indexes 可选（脚本生成；tcb CLI 支持创建）
#   - 4 secrets + 8 vars 注入（脚本生成）
#   - 13 functions 部署（脚本生成；mode A 单入口 / mode B 13 独立）
#
# ⚠️ 本脚本只生成命令清单，不直接执行（避免误操作）。
# 用户复制粘贴运行；或我帮跑（明确告知）。
#

set -euo pipefail

if [[ -z "${TCB_ENV:-}" ]] || [[ -z "${TCB_SECRET_ID:-}" ]]; then
  echo "❌ Missing TCB_ENV or TCB_SECRET_ID"
  echo "请先 export 这两个值（或在跑 readiness 时配好）"
  exit 1
fi

cat <<BANNER
╔════════════════════════════════════════════════════════════╗
║ CP-6 部署 runbook — 复制每段命令到 terminal 跑              ║
║ CloudBase env: ${TCB_ENV}                                ║
╚════════════════════════════════════════════════════════════╝
BANNER

# ====== 1. 登录 CloudBase CLI（API Key 3.0 模式）======
cat <<'CMD'

【Step 1: tcb CLI 登录】

# 首次使用：tcb login -e <env-id>
#  交互输入 SecretId + SecretKey（用你 export 的 TCB_SECRET_ID / TCB_SECRET_KEY）

tcb login -e "${TCB_ENV}"

# 或：环境变量方式（适合脚本）
export TENCENTCLOUD_SECRETID="${TCB_SECRET_ID}"
export TENCENTCLOUD_SECRETKEY="${TCB_SECRET_KEY}"
export TENCENTCLOUD_SESSIONTOKEN=""

CMD

# ====== 2. 创建 9 indexes（如果之前没建）======
cat <<'CMD'

【Step 2: 创建 9 个 field index】

tcb db create-index source       userId
tcb db create-index document     sourceId
tcb db create-index chunk        documentId
tcb db create-index chunk        sourceId
tcb db create-index chunk        userId
tcb db create-index chatSession  userId
tcb db create-index loginAttempt clientIpHash
tcb db create-index userSessionKey userId
tcb db create-index crawlJob     sourceId
tcb db create-index crawlJob     status

# 注：tcb db create-index 命令实际参数可能不同（按 CLI 版本）
# 如失败，看 tcb db create-index --help 或在 CloudBase 控制台手动建

CMD

# ====== 3. 注入 4 secrets + 8 vars 到所有函数 ======
cat <<'CMD'

【Step 3: 注入 4 secrets + 8 vars】

# Secrets（敏感值；从你的 terminal env 读）
for FUNC in api-router api-ask api-upload api-ingest api-search api-chat api-sessions-list api-sessions-get api-sessions-delete api-stats api-auth-wx-login api-auth-admin-login api-cron-cleanup api-health; do
  tcb fn config update "$FUNC" --secret ADMIN_TOKEN="${ADMIN_TOKEN}"
  tcb fn config update "$FUNC" --secret JWT_SECRET="${JWT_SECRET}"
  tcb fn config update "$FUNC" --secret MINIMAX_API_KEY="${MINIMAX_API_KEY}"
  tcb fn config update "$FUNC" --secret KEK_SECRET_V1="${KEK_SECRET_V1}"
done

# Vars（环境级 + 函数级；环境级更省事）
tcb env update --vars "ENVIRONMENT=production,ALLOWED_ORIGIN=*,ADMIN_IP_ALLOWLIST=${ADMIN_IP_ALLOWLIST},MINIMAX_BASE_URL=https://api.MiniMax.chat/v1,DEFAULT_USER_ID=01H0000000000000000000000,LOGIN_MAX_ATTEMPTS=5,LOGIN_WINDOW_MS=900000,KEK_CURRENT_VERSION=1"

# 注：tcb 命令实际参数可能不同
# 如失败，看 tcb fn config --help 或 tcb env --help

CMD

# ====== 4. 部署 13 functions ======
cat <<'CMD'

【Step 4: 部署 13 函数（推荐 mode A 单入口）】

# Mode A: 单入口分发（只 1 个函数 = api-router）
tcb fn deploy api-router \
  --code src/index.ts \
  --handler src/index.main \
  --runtime Nodejs18 \
  --timeout 30 \
  --memory-size 256 \
  --env "${TCB_ENV}"

# 然后：在 CloudBase 控制台 → api-router → 触发器 → 创建 HTTP 触发器
# 路径: /* (所有请求)

CMD

cat <<'CMD'

【Mode B（不推荐）：13 个独立函数】

CMD

HANDLERS=(
  "api-health"
  "api-auth-admin-login"
  "api-auth-wx-login"
  "api-stats"
  "api-sessions-list"
  "api-sessions-get"
  "api-sessions-delete"
  "api-upload"
  "api-ingest"
  "api-search"
  "api-ask"
  "api-chat"
  "api-cron-cleanup"
)

for handler in "${HANDLERS[@]}"; do
  cat <<CMD
tcb fn deploy $handler \\
  --code src/handlers/$handler.ts \\
  --handler src/handlers/$handler.main \\
  --runtime Nodejs18 \\
  --timeout 30 \\
  --memory-size 256 \\
  --env "${TCB_ENV}"

CMD
done

cat <<'CMD'

# 定时触发器（仅 mode B 需要；mode A 用 HTTP 触发器）
tcb fn trigger create api-cron-cleanup \
  --type timer \
  --cron "0 3 * * *" \
  --env "${TCB_ENV}"

CMD

cat <<'BANNER'
╔════════════════════════════════════════════════════════════╗
║ ✅ 复制每段命令到 terminal 依次跑（建议按 step 1→2→3→4 顺序）  ║
║ ❓ 任何步骤报错贴回我看（tcb CLI 不同版本命令可能略不同）     ║
╚════════════════════════════════════════════════════════════╝
BANNER