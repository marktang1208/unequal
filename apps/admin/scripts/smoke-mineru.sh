#!/usr/bin/env bash
# CP-7-C T15/T16 真接 smoke 脚本
# 跑前确保：
#   1. OMLX 跑着 (curl http://localhost:8000/v1/models)
#   2. mineru 装好 (mineru --version)
#   3. MINERU_MODEL_SOURCE=modelscope（避开 GFW）
#   4. /tmp/test.pdf 存在（PDF-ParseKit 测试样本）

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== Environment check ==="
echo "1. OMLX:"
curl -s -m 3 -H "Authorization: Bearer mark" http://localhost:8000/v1/models 2>&1 | python3 -c "import sys, json; d=json.load(sys.stdin); print(f'  {len(d.get(\"data\",[]))} models: ' + ', '.join(m['id'] for m in d.get('data',[])[:5]))" || echo "  ✗ OMLX 不可达"

echo ""
echo "2. mineru:"
mineru --version 2>&1 | head -1

echo ""
echo "3. test PDF:"
ls -la /tmp/test.pdf 2>/dev/null || echo "  ✗ /tmp/test.pdf 不存在"

echo ""
echo "=== mineru CLI 直接跑 ==="
rm -rf /tmp/mineru-test
mkdir -p /tmp/mineru-test
MINERU_MODEL_SOURCE=modelscope mineru -p /tmp/test.pdf -o /tmp/mineru-test -m auto -b pipeline -l ch -f true -t true 2>&1 | tail -10

echo ""
echo "=== 输出 ==="
ls /tmp/mineru-test/test/auto/ 2>&1
echo "---"
head -20 /tmp/mineru-test/test/auto/test.md 2>&1
echo "---"
wc -l /tmp/mineru-test/test/auto/test.md 2>&1