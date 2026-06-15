-- M0+M1 dev fixtures: a default user + 2 sources + 2 documents + 4 chunks
-- so first-run has data to search against.
--
-- Vectors are stored in Vectorize (not D1), so this migration only seeds
-- D1 rows. After applying this, you must ALSO call /upload (or manually
-- Vectorize.upsert) to populate the embedding index before /search returns
-- hits. This is intentional: keeps dev fixtures honest about the
-- embed-and-upsert step.

-- 1. default user (matches DEFAULT_USER_ID in apps/api/src/routes/{upload,search}.ts)
INSERT OR IGNORE INTO user (id, nickname, created_at) VALUES
  ('01H0000000000000000000000', 'default', 1718400000000);

-- 2. sample source 1: authoritative pediatric reference
INSERT OR IGNORE INTO source (id, user_id, type, title, trust_level, created_at, meta) VALUES
  ('01HAAAPEDSAAAA00000000001', '01H0000000000000000000000', 'file', '美国儿科学会育儿百科（第7版）节选', 3, 1718400000001,
   '{"language":"zh","format":"pdf","note":"节选：新生儿护理与发烧处理"}');

-- 3. sample source 2: trusted blog (lower trust)
INSERT OR IGNORE INTO source (id, user_id, type, title, account, trust_level, created_at, meta) VALUES
  ('01HAAAPEDSAAAA00000000002', '01H0000000000000000000000', 'wechat-mp', '崔玉涛：婴儿发烧的家庭处理', '崔玉涛育儿百科', 2, 1718400000002,
  '{"language":"zh","format":"article"}');

-- 4. documents (one per source)
INSERT OR IGNORE INTO document (id, source_id, user_id, title, raw_path, created_at) VALUES
  ('01HBBBAAAA00000000000001', '01HAAAPEDSAAAA00000000001', '01H0000000000000000000000',
   '新生儿发烧处理', 'raw/01H0000000000000000000000/dev-seed/aap-fever.pdf', 1718400000010),
  ('01HBBBAAAA00000000000002', '01HAAAPEDSAAAA00000000002', '01H0000000000000000000000',
   '婴儿发烧的家庭处理', 'raw/01H0000000000000000000000/dev-seed/cui-yutao-fever.html', 1718400000011);

-- 5. chunks (2 per document, sample text). token_count is an estimate
-- matching chunking.ts's Chinese heuristic (~1 token / char).
INSERT OR IGNORE INTO chunk (id, document_id, source_id, user_id, idx, content, token_count, trust_level, created_at) VALUES
  ('01HCCCAAAA00000000000001', '01HBBBAAAA00000000000001', '01HAAAPEDSAAAA00000000001',
   '01H0000000000000000000000', 0,
   '三个月以下婴儿发烧应立即就医。3-6 个月婴儿体温超过 38.5℃建议先测量腋温确认，如持续高烧或伴有精神差、拒奶、抽搐等症状，应尽快就诊。',
   78, 3, 1718400000020),
  ('01HCCCAAAA00000000000002', '01HBBBAAAA00000000000001', '01HAAAPEDSAAAA00000000001',
   '01H0000000000000000000000', 1,
   '对乙酰氨基酚（泰诺林）是 3 个月以上婴儿首选退烧药，按体重每 4-6 小时一次，24 小时内不超过 4 次。布洛芬（美林）适用于 6 个月以上婴儿。',
   75, 3, 1718400000021),
  ('01HCCCAAAA00000000000003', '01HBBBAAAA00000000000002', '01HAAAPEDSAAAA00000000002',
   '01H0000000000000000000000', 0,
   '婴儿发烧时先观察精神状态比体温数字更重要。精神好、吃奶正常、玩耍如常的低烧（<38.5℃）可先物理降温（温水擦浴、减衣），密切观察 24 小时。',
   76, 2, 1718400000022),
  ('01HCCCAAAA00000000000004', '01HBBBAAAA00000000000002', '01HAAAPEDSAAAA00000000002',
   '01H0000000000000000000000', 1,
   '不推荐用酒精擦浴（已被多国儿科指南淘汰）。也不建议冰敷或冷水浴，避免引起寒战反而升高体温。',
   53, 2, 1718400000023);
