-- 用户（MVP 阶段只有 1 行；wx_openid 留给未来 wx.login）
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  wx_openid TEXT UNIQUE,
  nickname TEXT,
  created_at INTEGER NOT NULL
);

-- 数据源
CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('file', 'webpage', 'xiaohongshu', 'wechat-mp')),
  title TEXT,
  url TEXT,
  account TEXT,
  trust_level INTEGER NOT NULL DEFAULT 0 CHECK (trust_level BETWEEN 0 AND 3),
  created_at INTEGER NOT NULL,
  meta TEXT,
  FOREIGN KEY (user_id) REFERENCES user(id)
);

CREATE INDEX IF NOT EXISTS source_user_idx ON source(user_id);

-- 文档
CREATE TABLE IF NOT EXISTS document (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT,
  raw_path TEXT NOT NULL,
  parsed_text_path TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_id) REFERENCES source(id)
);

CREATE INDEX IF NOT EXISTS document_source_idx ON document(source_id);
CREATE INDEX IF NOT EXISTS document_user_idx ON document(user_id);

-- chunk（最小检索单元）
CREATE TABLE IF NOT EXISTS chunk (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  trust_level INTEGER NOT NULL CHECK (trust_level BETWEEN 0 AND 3),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES document(id)
);

CREATE INDEX IF NOT EXISTS chunk_user_idx ON chunk(user_id);
CREATE INDEX IF NOT EXISTS chunk_document_idx ON chunk(document_id);

-- 抓取任务
CREATE TABLE IF NOT EXISTS crawl_job (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_id TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'cron')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed')),
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS crawl_job_user_idx ON crawl_job(user_id);
CREATE INDEX IF NOT EXISTS crawl_job_status_idx ON crawl_job(status);
