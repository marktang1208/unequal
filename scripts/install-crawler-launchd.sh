#!/bin/bash
# P3-7 / Phase D: 安装 launchd 定时任务（每日凌晨 3 点全量跑 crawler）
# 用法：bash scripts/install-crawler-launchd.sh
set -euo pipefail

PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/com.unequal.crawler.daily.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.unequal.crawler.daily.plist"

# 校验源 plist 存在
if [ ! -f "$PLIST_SRC" ]; then
  echo "ERROR: source plist not found: $PLIST_SRC" >&2
  exit 1
fi

# 校验 plist 格式
if ! plutil -lint "$PLIST_SRC" >/dev/null; then
  echo "ERROR: source plist is not valid: $PLIST_SRC" >&2
  plutil -lint "$PLIST_SRC" || true
  exit 1
fi

# 装脚本 +x
chmod +x "$(cd "$(dirname "$0")" && pwd)/run-daily-crawler.sh"

# 已装？先卸载（避免 duplicate）
if [ -f "$PLIST_DST" ]; then
  echo "Removing existing plist: $PLIST_DST"
  launchctl unload "$PLIST_DST" 2>/dev/null || true
fi

# 复制
cp "$PLIST_SRC" "$PLIST_DST"

# 加载
launchctl load "$PLIST_DST"

echo ""
echo "✅ Installed. Active job:"
launchctl list | grep unequal || true
echo ""
echo "手动测试：launchctl start com.unequal.crawler.daily"
echo "查看日志：tail -f /tmp/unequal-crawler.log /tmp/unequal-crawler.err.log"
echo "卸载：bash scripts/uninstall-crawler-launchd.sh"
