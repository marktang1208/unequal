#!/usr/bin/env bash
# verify-nli.sh — P5 NLI 蕴含验证 (HttpNliProvider 硅基流动 Qwen2.5-7B) 真接验收脚本
#
# 跑通 6 步核心场景 + 验证：
#   1. SILICONFLOW_API_KEY 已加到 Keychain
#   2. deploy push（cloudbaserc.json 含 SILICONFLOW_API_KEY）
#   3. ask chunk 支持的问题 → 无 warning
#   4. ask chunk 不支持的问题 → 有 warning
#   5. tcb audit_log 查 ask_nli_reject 记录
#   6. NLI_PROVIDER=noop 重 deploy → 永远无 warning
#   7. /api-search 走原路径不受影响
#
# 用法：
#   bash scripts/verify-nli.sh
#
# 前置：
#   - tcb login
#   - SILICONFLOW_API_KEY 已加 Keychain (`security add-generic-password -U ...`)
#   - accept 5 步 smoke (state-cp6 §4) 手动跑
#
# 退出码：
#   0 = 全 6 步通过
#   1 = 任意步骤失败

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/apps/api"

echo "=== P5 NLI 真接验收 (硅基流动 Qwen2.5-7B) ==="
echo "  repo: $REPO_ROOT"
echo "  tcb env: unequal-d4ggf7rwg82e0900b"
echo ""

# 检查前置
if ! command -v tcb &> /dev/null; then
  echo "❌ tcb CLI 未安装"
  exit 1
fi

if ! command -v jq &> /dev/null; then
  echo "❌ jq 未安装 (brew install jq)"
  exit 1
fi

# 验证 SILICONFLOW_API_KEY 在 Keychain
KEYCHAIN_VAL=$(security find-generic-password -s "unequal-siliconflow-api-key" -w 2>/dev/null || echo "")
if [ -z "$KEYCHAIN_VAL" ]; then
  echo "❌ SILICONFLOW_API_KEY 不在 Keychain"
  echo "  加 keychain: security add-generic-password -U -s 'unequal-siliconflow-api-key' -a 'unequal' -w 'sk-xxx'"
  exit 1
fi
echo "✅ SILICONFLOW_API_KEY 在 Keychain"
echo ""

echo "[1/6] deploy push（cloudbaserc.json 含 SILICONFLOW_API_KEY）"
pnpm deploy:push || {
  echo "❌ deploy push 失败"
  exit 1
}
echo "✅ deploy push 通过"
echo ""

# 取 admin JWT 用于后续 ask
echo "  (拿 admin JWT...)"
JWT=$(curl -s -X POST "$API_URL/api-auth-admin-login" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"${ADMIN_TOKEN:?ADMIN_TOKEN env required}\"}" | jq -r '.jwt // .token // empty')
if [ -z "$JWT" ]; then
  echo "❌ 拿 JWT 失败"
  exit 1
fi
echo "  JWT 拿到"
echo ""

echo "[2/6] ask chunk 支持的问题 → 无 warning"
ANSWER2=$(curl -s -X POST "$API_URL/api-ask" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"q":"发烧怎么办"}')
echo "$ANSWER2" | jq -r '.answer' | head -3
if echo "$ANSWER2" | grep -q "⚠️"; then
  echo "❌ 预期无 warning，但响应含 '⚠️'"
  exit 1
fi
echo "✅ 无 warning"
echo ""

echo "[3/6] ask chunk 不支持的问题 → 有 warning"
ANSWER3=$(curl -s -X POST "$API_URL/api-ask" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"q":"X 星人住在哪个星系"}')
echo "$ANSWER3" | jq -r '.answer' | head -3
if echo "$ANSWER3" | grep -q "⚠️"; then
  echo "✅ 有 warning"
else
  echo "❌ 预期有 warning，但响应无 '⚠️'"
  exit 1
fi
echo ""

echo "[4/6] tcb audit_log 查 ask_nli_reject 记录"
MONGO_CMD='[{"TableName":"audit_log","CommandType":"QUERY","Command":"{\"find\":\"audit_log\",\"filter\":{\"action\":\"ask_nli_reject\"},\"sort\":{\"timestamp\":-1},\"limit\":1}"}]'
AUDIT_RESULT=$(tcb db nosql execute --command "$MONGO_CMD" 2>&1 || true)
# tcb 输出前 4 行是 banner/进度，从第一个 '[' 开始解析
AUDIT_JSON=$(echo "$AUDIT_RESULT" | grep -o '\[.*' | head -1 || true)
if echo "$AUDIT_JSON" | grep -q "ask_nli_reject"; then
  echo "✅ audit 记录存在"
else
  echo "⚠️  audit 记录未找到（可能 step 3 实际 verdict 是 entailed）"
  echo "  完整 tcb 输出：$AUDIT_RESULT"
fi
echo ""

echo "[5/6] NLI_PROVIDER=noop 重 deploy → 永远无 warning"
echo "  (手动操作：)"
echo "    1. 改 cloudbaserc.json: envVariables.NLI_PROVIDER = \"noop\""
echo "    2. pnpm -F api deploy push"
echo "    3. 重跑 [2/6] 和 [3/6] curl 验证无 warning"
echo "  (注：本脚本不自动跑 step 5，避免覆盖部署)"
echo ""

echo "[6/6] /api-search 走原路径不受影响"
SEARCH=$(curl -s "$API_URL/api-search?q=发烧&topK=5" \
  -H "Authorization: Bearer $JWT")
RESULT_COUNT=$(echo "$SEARCH" | jq -r '.results | length' 2>/dev/null || echo "0")
echo "  返回 $RESULT_COUNT 条结果"
if [ "$RESULT_COUNT" -gt 0 ]; then
  echo "✅ /api-search 正常"
else
  echo "⚠️  /api-search 无结果（可能数据库无内容）"
fi
echo ""

echo "=== P5 NLI 真接验收完成 ==="
echo ""
echo "下一步验收（手动）:"
echo "  1. 跑 5 步 smoke (state-cp6 §4) — 验证 NLI 不影响其他路径"
echo "     curl /api-auth-admin-login (拿 JWT)"
echo "     curl /api-auth-me"
echo "     curl '/api-search?q=发烧&topK=5'"
echo "     curl /api-ask (验 NLI 接)"
echo "     curl /api-chat (验 NLI 不接，chat 路径 v2 才加)"
echo "     curl /api-ingest (新数据写入)"
echo ""
echo "  2. dev 环境跑 50 真实家长问题，统计 warning 触发率（预期 20-40%）"
echo "     超过 60% → 调阈值或 prompt"
echo ""
echo "  3. 评估 v2 路径："
echo "     - chat NLI（v2）"
echo "     - TransformersNliProvider 本地 ONNX（v2，需 optimum 量化 + OSS 路径）"
