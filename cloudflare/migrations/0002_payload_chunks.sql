CREATE TABLE IF NOT EXISTS payload_chunks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload_ref TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (user_id, payload_ref, chunk_index)
);
