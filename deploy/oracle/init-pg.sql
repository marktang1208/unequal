-- unequal PostgreSQL 初始化脚本
-- 容器首次启动时自动执行（/docker-entrypoint-initdb.d/）

-- pgvector 扩展（向量检索核心）
CREATE EXTENSION IF NOT EXISTS vector;

-- 启用 uuid / citext
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;

-- ============================================
-- 业务表（10 个 collection → 10 张表）
-- ============================================

-- source：数据源
CREATE TABLE IF NOT EXISTS source (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,         -- webpage / file / pdf / xiaohongshu / wechat-mp
  url             TEXT,
  title           TEXT,
  meta            JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- document：文档（一对多 chunk）
CREATE TABLE IF NOT EXISTS document (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  content_hash    TEXT NOT NULL,
  content         TEXT,
  meta            JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_document_source ON document(source_id);
CREATE INDEX IF NOT EXISTS idx_document_hash ON document(content_hash);

-- chunk：分块 + 1536 维向量（pgvector HNSW 索引）
CREATE TABLE IF NOT EXISTS chunk (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  embedding       vector(1536),
  chunk_index     INTEGER NOT NULL,
  meta            JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chunk_document ON chunk(document_id);
-- HNSW 向量索引（cosine 距离，P8 已验证 P99<100ms）
CREATE INDEX IF NOT EXISTS idx_chunk_embedding ON chunk USING hnsw (embedding vector_cosine_ops);

-- user：用户
CREATE TABLE IF NOT EXISTS app_user (
  id              TEXT PRIMARY KEY,
  wx_openid       TEXT UNIQUE,
  nickname        TEXT,
  meta            JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_wx_openid ON app_user(wx_openid);

-- chat_session：会话
CREATE TABLE IF NOT EXISTS chat_session (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  title           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_session_user ON chat_session(user_id, updated_at DESC);

-- chat_message：会话消息
CREATE TABLE IF NOT EXISTS chat_message (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,        -- user / assistant
  content         TEXT NOT NULL,
  meta            JSONB DEFAULT '{}'::jsonb,  -- citations / nliVerdict / cached 等
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_session ON chat_message(session_id, created_at);

-- query_cache：query 缓存（命中 cache 直返）
CREATE TABLE IF NOT EXISTS query_cache (
  query_hash      TEXT PRIMARY KEY,
  answer          TEXT NOT NULL,
  citations       JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- audit_log：审计（deploy / chat / nli_async 等）
CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGSERIAL PRIMARY KEY,
  actor           TEXT,                 -- user_id / deployer
  action          TEXT NOT NULL,        -- chat / deploy / nli_async / login / etc.
  payload         JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor, created_at DESC);

-- login_attempt：登录限流
CREATE TABLE IF NOT EXISTS login_attempt (
  id              BIGSERIAL PRIMARY KEY,
  ip              INET NOT NULL,
  username        TEXT,
  success         BOOLEAN NOT NULL,
  meta            JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_ip_time ON login_attempt(ip, created_at DESC);

-- user_session_key：JWT 撤销/会话管理
CREATE TABLE IF NOT EXISTS user_session_key (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  key_hash        TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_session_key_user ON user_session_key(user_id);

-- crawl_job：爬虫任务（admin 触发，本地落 SQLite 后 push）
CREATE TABLE IF NOT EXISTS crawl_job (
  id              TEXT PRIMARY KEY,
  source_id       TEXT REFERENCES source(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending / running / done / failed
  meta            JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_crawl_status ON crawl_job(status, created_at DESC);
