-- Stage 1: people, sessions, teams, join requests, drive types.

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  display_name   text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  password_hash  text NOT NULL,
  avatar_path    text,
  is_site_admin  boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz
);

-- Browser sessions. Only the SHA-256 of the cookie token is stored.
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  user_agent    text,
  persistent    boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- personal: one per user, made at sign-up, nobody else can join.
  kind        text NOT NULL CHECK (kind IN ('personal', 'shared')),
  -- Listed teams turn up in search; unlisted ones are joined through the join code.
  listed      boolean NOT NULL DEFAULT true,
  join_code   text NOT NULL UNIQUE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX teams_name ON teams (lower(name)) WHERE deleted_at IS NULL;

-- Membership with history: leaving sets left_at, so "who was in the team when this
-- drive happened" stays answerable. Rejoining adds a new row.
CREATE TABLE team_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'driver', 'viewer')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  left_at    timestamptz,
  CHECK (left_at IS NULL OR left_at >= joined_at)
);
CREATE UNIQUE INDEX team_members_current ON team_members (team_id, user_id) WHERE left_at IS NULL;
CREATE INDEX team_members_user ON team_members (user_id) WHERE left_at IS NULL;

CREATE TABLE team_join_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message       text CHECK (length(message) <= 500),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz
);
CREATE UNIQUE INDEX team_join_requests_pending ON team_join_requests (team_id, user_id) WHERE status = 'pending';

-- One site-wide list; the app asks for one when a drive starts.
CREATE TABLE drive_types (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  label        text NOT NULL,
  icon         text,               -- file in public/, e.g. drive-delivery.png
  sort         int NOT NULL DEFAULT 0,
  archived_at  timestamptz
);
INSERT INTO drive_types (key, label, icon, sort) VALUES
  ('personal',  'Personal',  'drive-personal.png',  10),
  ('commute',   'Commute',   'drive-commute.png',   20),
  ('delivery',  'Delivery',  'drive-delivery.png',  30),
  ('work',      'Work',      'drive-work.png',      40),
  ('exploring', 'Exploring', 'drive-exploring.png', 50);

-- Each team's toggles. A type with no row counts (new types count until switched off).
CREATE TABLE team_drive_types (
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  drive_type_key  text NOT NULL REFERENCES drive_types(key) ON UPDATE CASCADE,
  counts          boolean NOT NULL,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, drive_type_key)
);

CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  team_id    uuid REFERENCES teams(id) ON DELETE SET NULL,
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  data       jsonb
);
CREATE INDEX audit_log_team ON audit_log (team_id, at DESC);
