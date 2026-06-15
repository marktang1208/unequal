-- M2 §6.3：缓存全文 + 元数据，Vectorize 存指针（metadata 大小受限）
-- 缓存命中条件：Vectorize topK(1) filter {user_id, is_cached=true} final_score > 0.92
-- 失效：TTL 30 天（CP-4 范围）；文档增删改 / 模型升级 / 手动清空（v2+）

CREATE TABLE IF NOT EXISTS query_cache (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  q TEXT NOT NULL,
  q_embedding BLOB NOT NULL,         -- 序列化 Float32Array（小端字节序）
  answer TEXT NOT NULL,              -- 含 disclaimer 完整答案
  verified TEXT NOT NULL,            -- JSON array, verified 编号
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,       -- created_at + 30*86400*1000
  FOREIGN KEY (user_id) REFERENCES user(id)
);

CREATE INDEX IF NOT EXISTS query_cache_user_idx ON query_cache(user_id);
CREATE INDEX IF NOT EXISTS query_cache_expires_idx ON query_cache(expires_at);
