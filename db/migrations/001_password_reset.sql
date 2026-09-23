-- Adds password-reset support to the users table.
-- Safe to run more than once.

ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_exp  TIMESTAMPTZ;

-- Look-ups happen by token, so index it (partial: only rows with an active token).
CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users (reset_token)
  WHERE reset_token IS NOT NULL;
