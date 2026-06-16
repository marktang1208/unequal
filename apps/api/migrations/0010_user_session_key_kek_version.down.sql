-- M6.8: down migration
-- SQLite < 3.35 不支持 DROP COLUMN；orphan session_key_kek_version 列无副作用
-- DOWN: 仅 drop index（不影响 column；orphan column 无副作用）

DROP INDEX IF EXISTS idx_user_kek_version;
