#!/usr/bin/env bash
# verify-deploy-pipeline.sh — P4 #2 deploy pipeline 真接验收脚本
#
# 跑通 6 步核心场景 + 验证：
#   1. status → 看云端当前 vars
#   2. push (Merge) → vars 不变, audit 写 1 条
#   3. push --override → 强制重写
#   4. push --force → 跳过 KEK_CURRENT_VERSION 漂移检查
#   5. rotate-kek --force → KEK 轮换
#   6. clean → 恢复 7 vars
#
# 用法：
#   bash scripts/verify-deploy-pipeline.sh
#
# 前置：
#   - tcb login (需先用 tcb login 登录)
#   - Keychain 已 setup (pnpm -F api setup:keychain-secrets)
#   - 接受 6 步 smoke (state-cp6 §4) 手动跑（rotate-kek 后）
#
# 退出码：
#   0 = 全 6 步通过
#   1 = 任意步骤失败

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/apps/api"

echo "=== P4 #2 deploy pipeline 真接验收 ==="
echo "  repo: $REPO_ROOT"
echo "  tcb env: unequal-d4ggf7rwg82e0900b"
echo ""

# 检查前置
if ! command -v tcb &> /dev/null; then
  echo "❌ tcb CLI 未安装"
  exit 1
fi

if ! command -v expect &> /dev/null; then
  echo "❌ expect 未安装 (brew install expect)"
  exit 1
fi

if [ "$(uname)" != "Darwin" ]; then
  echo "❌ 仅 macOS (用 security 命令读 Keychain)"
  exit 1
fi

# 验证 Keychain 6 secrets 已 setup
echo "[1/6] status — 查云端当前 vars"
pnpm deploy:status || {
  echo "❌ status 失败 (tcb 未 login?)"
  exit 1
}
echo "✅ status 通过"
echo ""

echo "[2/6] push (Merge 模式)"
pnpm deploy:push || {
  echo "❌ push 失败"
  exit 1
}
echo "✅ push (Merge) 通过"
echo ""

echo "[3/6] push --override (强制重写)"
# pnpm 默认拦截未知 flag 给子命令，用 `--` 显式分隔
pnpm deploy push -- --override || {
  echo "❌ push --override 失败"
  exit 1
}
echo "✅ push --override 通过"
echo ""

echo "[4/6] push --force (跳过 KEK_CURRENT_VERSION 检查)"
pnpm deploy push -- --force || {
  echo "❌ push --force 失败"
  exit 1
}
echo "✅ push --force 通过"
echo ""

echo "[5/6] rotate-kek --force (KEK 轮换 + 推云)"
pnpm deploy rotate-kek -- --force || {
  echo "❌ rotate-kek 失败"
  exit 1
}
echo "✅ rotate-kek 通过"
echo "  ⚠️  NEXT: 手动跑 6 步 smoke (docs/superpowers/state-cp6.md §4)"
echo ""

echo "[6/6] clean (恢复 7 vars 干净版)"
pnpm deploy:clean || {
  echo "❌ clean 失败"
  exit 1
}
echo "✅ clean 通过"
echo ""

echo "=== 6 步全通过 ✅ ==="
echo ""
echo "下一步验收（手动）:"
echo "  1. tcb db nosql execute 查 audit_log deploy records:"
echo "     tcb db nosql execute --command '[{\"TableName\":\"audit_log\",\"CommandType\":\"QUERY\",\"Command\":\"{\\\"find\\\":\\\"audit_log\\\",\\\"filter\\\":{\\\"action\\\":\\\"deploy\\\"},\\\"sort\\\":{\\\"timestamp\\\":-1},\\\"limit\\\":10}\"}]'"
echo ""
echo "  2. 6 步 smoke (state-cp6 §4) — 验证 KEK 轮换后旧数据仍可读"
echo "     Step 1: pnpm -F api deploy push   # 推 12 vars (含新 KEK)"
echo "     Step 2: curl /api-auth-admin-login -d '{\"token\":\"...\"}' → 拿 JWT"
echo "     Step 3: curl /api-auth-me -H 'Authorization: Bearer \$JWT'"
echo "     Step 4: curl '/api-search?q=发烧&topK=5'   # 验证旧 chunk 可解密"
echo "     Step 5: curl /api-ask (LLM 回答)"
echo "     Step 6: curl /api-chat (多轮)"
echo "     Step 7: curl /api-ingest (新数据写入)"
echo "     全 PASS 后: pnpm -F api deploy clean   # 切回 7 vars"
echo ""
echo "  3. status 命令查 deploy history:"
echo "     pnpm -F api deploy:status"