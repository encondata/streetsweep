-- Stage 2: vehicles, permanent assignments and check-outs, phones, GPS loggers.
-- Rows are archived or ended in normal use; the cascades only matter when a test
-- run hard-deletes its own users and teams.

-- A vehicle belongs to no person. The team that manages it decides who may edit it
-- and who may drive it: a personal car sits under its driver's personal team, a
-- household car under the household's team, a van under the company's.
CREATE TABLE vehicles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  managed_by_team_id  uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  kind                text NOT NULL DEFAULT 'car' CHECK (kind IN ('car', 'suv', 'van', 'truck', 'motorcycle', 'other')),
  make                text CHECK (length(make) <= 40),
  model               text CHECK (length(model) <= 40),
  year                int CHECK (year BETWEEN 1900 AND 2100),
  color               text CHECK (length(color) <= 30),
  plate               text CHECK (length(plate) <= 20),
  photo_path          text,
  -- open: any driver in the team can check it out themselves; admin_only: admins hand it out.
  checkout_policy     text NOT NULL DEFAULT 'open' CHECK (checkout_policy IN ('open', 'admin_only')),
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz
);
CREATE INDEX vehicles_team ON vehicles (managed_by_team_id) WHERE archived_at IS NULL;

-- Who drives what, over time. Never deleted: a late upload is credited from the row
-- covering the moment it was driven. Open-ended `during` = still in force.
CREATE TABLE vehicle_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id   uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('permanent', 'checkout')),
  during       tstzrange NOT NULL DEFAULT tstzrange(now(), NULL, '[)'),
  assigned_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  ended_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  note         text CHECK (length(note) <= 200),
  CHECK (NOT isempty(during)),
  -- A van can't be out with two people at once.
  EXCLUDE USING gist (vehicle_id WITH =, during WITH &&) WHERE (kind = 'checkout'),
  -- Nobody holds the same car permanently twice over.
  EXCLUDE USING gist (vehicle_id WITH =, user_id WITH =, during WITH &&) WHERE (kind = 'permanent')
);
CREATE INDEX vehicle_assignments_open ON vehicle_assignments (vehicle_id) WHERE upper_inf(during);
CREATE INDEX vehicle_assignments_user ON vehicle_assignments (user_id) WHERE upper_inf(during);

-- Signed-in phones. The app sends `Authorization: Bearer <token>`; only its SHA-256 is kept.
CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  platform      text NOT NULL DEFAULT 'android' CHECK (platform IN ('android', 'ios', 'other')),
  app_version   text CHECK (length(app_version) <= 40),
  token_hash    bytea NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX devices_user ON devices (user_id);

-- GPS loggers people build (ESP32 + GPS). Requests are signed with HMAC-SHA256, which
-- needs the shared secret itself on the server, so it is stored (not a hash); see
-- docs/LOGGER-PROTOCOL.md. A phone relaying over BLE forwards signed bodies unchanged
-- and never sees the secret.
CREATE TABLE loggers (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                    text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  secret                  bytea NOT NULL,
  -- A logger can't ask anyone, so its drives get this type (fixable on the web later).
  default_drive_type_key  text NOT NULL DEFAULT 'personal' REFERENCES drive_types(key) ON UPDATE CASCADE,
  hardware_id             text CHECK (length(hardware_id) <= 64),   -- as reported, e.g. its MAC
  firmware_version        text CHECK (length(firmware_version) <= 40),
  last_battery_mv         int,
  last_seen_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  revoked_at              timestamptz
);
CREATE INDEX loggers_owner ON loggers (owner_user_id);

-- Which vehicle a logger rode in, over time.
CREATE TABLE logger_installs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  logger_id     uuid NOT NULL REFERENCES loggers(id) ON DELETE CASCADE,
  vehicle_id    uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  during        tstzrange NOT NULL DEFAULT tstzrange(now(), NULL, '[)'),
  installed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK (NOT isempty(during)),
  EXCLUDE USING gist (logger_id WITH =, during WITH &&)
);
CREATE INDEX logger_installs_vehicle ON logger_installs (vehicle_id) WHERE upper_inf(during);
