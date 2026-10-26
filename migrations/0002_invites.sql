-- One-time links for new staff to choose their own password (also used as password-reset links).
-- Safe to run more than once: the Worker runs this automatically on first use.
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_user ON invites(user_id);
