#!/usr/bin/env bash
#
# CP-6: 部署 13 个 CloudBase 函数
#
# 用 @cloudbase/cli (tcb) — 安装：
#   npm install -g @cloudbase/cli
# 或：pnpm add -g @cloudbase/cli
#
# 用法：
#   export TCB_ENV=<your-env-id>
#   ./scripts/deploy-functions.sh
#
# 前提：
#   - CloudBase 环境已创建
#   - 9 collections 已建（deploy-collections.ts）
#   - field indexes 已建（deploy-indexes.ts 或控制台）
#   - 4 secrets 已注入（deploy-secrets.sh 或控制台）
#

set -euo pipefail

# CloudBase 函数 deploy 命令模板
# tcb fn deploy <name> --code <handler-path> --env <env-id>

# 13 个函数（按 path → handler 映射；handler 文件在 src/handlers/）
# 部署模式 1：单入口分发（推荐 — 只 deploy 一个 api-router 函数）
# 部署模式 2：13 个独立函数（spec 推荐；本脚本按此模式列出）

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

if [[ -z "${TCB_ENV:-}" ]]; then
  echo "Missing TCB_ENV env var"
  exit 1
fi

echo "[deploy-functions] env=$TCB_ENV"

# 部署模式 A（推荐 简化）：单入口分发
# - 只 deploy 1 个函数 "api-router"
# - 通过 path 分发到 13 handler（src/index.ts HANDLER_MAP）
# - 减少函数配置工作量 13 → 1
echo ""
echo "推荐 模式 A：单入口分发（deploy 1 个 api-router 函数）"
echo ""
echo "  tcb fn deploy api-router \\"
echo "    --code src/index.ts \\"
echo "    --handler src/index.main \\"
echo "    --runtime Nodejs16 \\"
echo "    --timeout 30 \\"
echo "    --memory-size 256 \\"
echo "    --env $TCB_ENV"
echo ""

# 部署模式 B（spec 推荐）：13 个独立函数
echo "模式 B：13 个独立函数（spec §2.4 推荐方案）"
echo ""
for handler in "${HANDLERS[@]}"; do
  echo "  tcb fn deploy $handler \\"
  echo "    --code src/handlers/$handler.ts \\"
  echo "    --handler src/handlers/$handler.main \\"
  echo "    --runtime Nodejs16 \\"
  echo "    --timeout 30 \\"
  echo "    --memory-size 256 \\"
  echo "    --env $TCB_ENV"
  echo ""
done

# 定时触发器（仅模式 B 需要；模式 A 用 HTTP 触发器）
echo "[deploy-cron-trigger] api-cron-cleanup 每日 03:00 UTC"
echo ""
echo "  tcb fn trigger create api-cron-cleanup \\"
echo "    --type timer \\"
echo "    --cron '0 3 * * *' \\"
echo "    --env $TCB_ENV"
echo ""

echo "📋 选择模式 A 或 B 后按上面命令逐个执行"
echo "💡 模式 A 部署快但维护复杂（单点）；模式 B 独立部署但配置 13 倍"
echo "✅ CP-6 Phase 8 推荐模式 A（spec §8.5 简化方案）"