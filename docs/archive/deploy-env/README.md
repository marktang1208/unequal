# deploy-env — 旧 CloudBase 部署副本（已归档）

此目录是 `apps/api/` 的过时克隆（commit 历史中的部署快照），与 `apps/api/` 仅有 1 处微小差异：

- `src/lib/admin-ip-allowlist.ts` — 缺少 P0-#1 的 CIDR 范围匹配支持（仅精确 IP 匹配）

**当前生产部署走 `apps/api/` 的 P4 #3 SCF SDK 管线**，此副本仅保留供参考。
