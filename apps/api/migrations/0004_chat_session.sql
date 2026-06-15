-- M6.1 多轮会话 session 列表（D1 只存 metadata，不存 message 全文）
-- message 全文存在 Durable Object state.storage 里（apps/api/src/do/chat-session.ts）
--
-- 限额：每 user 最多 50 个 session
-- 过期：lazy 模式（30 天未活跃视为过期），不在 D1 加 cron trigger
-- degraded_at：DO 路由失败时标记，前端显示「会话暂不可用」

CREATE TABLE IF NOT EXISTS chat_session (
  id TEXT PRIMARY KEY,              -- ULID
  user_id TEXT NOT NULL,
  title TEXT,                       -- 首问后 LLM 生成 10 字（失败时为空）
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,  -- 用于 30 天过期判定（last_active_at > now - 30天）
  degraded_at INTEGER,              -- DO 路由失败时标记；null = 正常
  FOREIGN KEY (user_id) REFERENCES user(id)
);

CREATE INDEX IF NOT EXISTS chat_session_user_active_idx
  ON chat_session(user_id, last_active_at DESC);
