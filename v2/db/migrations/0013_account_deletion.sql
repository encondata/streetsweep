-- Account deletion: people delete their own account at /delete-me, or (signed out) ask
-- for it by email. An emailed request is confirmed with a code, then a site admin acts.

ALTER TABLE email_codes DROP CONSTRAINT email_codes_purpose_check;
ALTER TABLE email_codes ADD CONSTRAINT email_codes_purpose_check CHECK (purpose IN ('verify', 'reset', 'delete'));

CREATE TABLE deletion_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Kept after the account goes, so there's a record the request was carried out.
  email         citext NOT NULL,
  display_name  text NOT NULL,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  reason        text CHECK (length(reason) <= 1000),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'declined', 'withdrawn')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  note          text CHECK (length(note) <= 1000)
);
CREATE UNIQUE INDEX deletion_requests_pending ON deletion_requests (user_id) WHERE status = 'pending';
CREATE INDEX deletion_requests_status ON deletion_requests (status, requested_at DESC);
