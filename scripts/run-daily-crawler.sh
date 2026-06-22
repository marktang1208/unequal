#!/bin/bash
# P3-7 / Phase D: launchd 入口脚本 — 每日凌晨 3 点跑 crawler 全量
# 由 launchd 调起（不是手动），输出写到 /tmp/unequal-crawler.log（launchd 重定向）。
# 失败：exit code 透传给 launchd（launchd 看 exit != 0 → 标运行失败）
set -euo pipefail

cd /Users/Mark/cc_project/unequal

# 调 pnpm 跑 crawler 全量
exec pnpm -F crawler start --full-scan --source=all --trust=1
