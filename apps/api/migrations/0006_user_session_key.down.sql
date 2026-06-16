-- SQLite < 3.35 不支持 ALTER TABLE DROP COLUMN。
-- M6.3a 0005 是 CREATE TABLE + DROP TABLE 对称，0006 是 ALTER TABLE ADD COLUMN 非对称。
-- 旧 user 的 session_key 数据在 down 迁移后保留为 orphan column，无副作用。
-- 真要彻底清空需要 recreate（ALTER TABLE user RENAME TO user_old + CREATE TABLE 不含 session_key + INSERT SELECT + DROP user_old），M6.3b 不实现。
SELECT 1;
