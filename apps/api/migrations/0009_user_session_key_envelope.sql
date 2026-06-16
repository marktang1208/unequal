-- M6.7: envelope encryption 列（每条数据独立 DEK）
-- session_key_ct: base64(nonce_12B || ciphertext+tag) — DEK 加密的 session_key
-- session_key_dek: base64(nonce_12B || wrappedDek+tag) — KEK 加密的 DEK
-- 旧 session_key 列保留（M6.3b 写入的明文）；M6.7 写时将其置 NULL（避免明密共存）
-- 新列可空：M6.7 上线前老 user session_key_ct=NULL/session_key_dek=NULL

ALTER TABLE user ADD COLUMN session_key_ct TEXT;
ALTER TABLE user ADD COLUMN session_key_dek TEXT;
