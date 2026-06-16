-- M6.3a 登录失败尝试记录（rate limit 数据源）
-- identifier: admin_token 用 sha256(admin_token).slice(0,16)；wx_code 用 sha256(code).slice(0,16)
-- attempt_type: 'admin' | 'wx_code'（同表分桶，spec §6）
-- succeeded: 0 = 失败 / 1 = 成功
-- 清理：mock-first 阶段不主动清理；M6.5+ 加 cron 删 24h 前数据

CREATE TABLE IF NOT EXISTS login_attempt (
  id           TEXT PRIMARY KEY,
  identifier   TEXT NOT NULL,
  attempt_type TEXT NOT NULL CHECK (attempt_type IN ('admin', 'wx_code')),
  succeeded    INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempt_lookup
  ON login_attempt(identifier, attempt_type, created_at DESC);
