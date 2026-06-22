#!/bin/bash
# P3-7 / Phase D: 卸载 launchd 定时任务
# 用法：bash scripts/uninstall-crawler-launchd.sh
set -euo pipefail

PLIST_DST="$HOME/Library/LaunchAgents/com.unequal.crawler.daily.plist"

if [ -f "$PLIST_DST" ]; then
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  rm -f "$PLIST_DST"
  echo "✅ Uninstalled: $PLIST_DST"
else
  echo "Not installed (no plist at $PLIST_DST)"
fi
