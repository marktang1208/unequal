-- M6.4: cron DELETE WHERE created_at < ? 的索引
-- 配合 cron handler：DELETE FROM login_attempt WHERE created_at < ?
-- 现有 idx_login_attempt_lookup(identifier, attempt_type, created_at DESC)
-- 复合索引第一列是 identifier，不优化单列 created_at 比较

CREATE INDEX IF NOT EXISTS idx_login_attempt_created_at
  ON login_attempt(created_at);
