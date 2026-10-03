-- Email confirmation for new accounts and one-time codes for password resets.

-- NULL until the address is confirmed. Accounts made before this existed count as confirmed.
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
UPDATE users SET email_verified_at = created_at;

-- Six-digit codes sent by email. Only a hash is kept; each lasts 15 minutes, allows a
-- few wrong guesses, and works once. Sending a new one retires the old.
CREATE TABLE email_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  code_hash   bytea NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX email_codes_open ON email_codes (user_id, purpose, created_at DESC);
