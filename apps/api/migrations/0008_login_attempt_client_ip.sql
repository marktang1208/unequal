-- M6.6: 加 client_ip 列（per-IP 限流数据源）
-- 存 sha256(ip).slice(0,16) 不存明文（防 PII）
-- 可空：M6.6 上线前的旧 attempt 行 client_ip = NULL

ALTER TABLE login_attempt ADD COLUMN client_ip TEXT;

-- 新索引：per-IP 限流查询 (client_ip, attempt_type, created_at) 复合
CREATE INDEX IF NOT EXISTS idx_login_attempt_client_ip
  ON login_attempt(client_ip, attempt_type, created_at DESC);
