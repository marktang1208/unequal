-- M6.6: down migration
-- SQLite < 3.35 不支持 DROP COLUMN；orphan client_ip 列无副作用
-- DOWN: 仅 drop index（不影响 client_ip 列；orphan column 无副作用）

DROP INDEX IF EXISTS idx_login_attempt_client_ip;
