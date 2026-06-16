-- M6.8: 加 session_key_kek_version 列（每行 envelope 用哪个 KEK version）
-- DEFAULT 1：M6.7 老行 = version 1（M6.7 KEK 重命名为 KEK_SECRET_V1 后兼容）
-- NOT NULL：M6.8 上线后所有新行必填

ALTER TABLE user ADD COLUMN session_key_kek_version INTEGER NOT NULL DEFAULT 1;

-- 索引：读路径按 version 过滤（admin 排查 / 批量重 wrap 工具用）
CREATE INDEX IF NOT EXISTS idx_user_kek_version
  ON user(session_key_kek_version);
