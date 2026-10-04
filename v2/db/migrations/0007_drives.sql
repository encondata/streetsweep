-- Stage 4: drives from phones and loggers, matched to streets, counted for teams.

CREATE TABLE drives (
  -- Generated on the phone (so a retried upload is the same drive); by the server for loggers.
  id                uuid PRIMARY KEY,
  source            text NOT NULL CHECK (source IN ('phone', 'logger')),
  uploaded_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id         uuid REFERENCES devices(id) ON DELETE SET NULL,
  logger_id         uuid REFERENCES loggers(id) ON DELETE SET NULL,
  -- Who drove what. NULL user = not known (a logger drive nobody had the car for).
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  vehicle_id        uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  attribution       text NOT NULL CHECK (attribution IN ('explicit', 'inferred', 'unknown', 'edited')),
  drive_type_key    text NOT NULL REFERENCES drive_types(key) ON UPDATE CASCADE,
  started_at        timestamptz NOT NULL,
  ended_at          timestamptz NOT NULL,
  point_count       int NOT NULL,
  distance_m        real NOT NULL,
  -- The cleaned track; M is the time of each fix in epoch seconds.
  track             geometry(LineStringM, 4326) NOT NULL,
  status            text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'matching', 'matched', 'failed')),
  match_method      text CHECK (match_method IN ('valhalla', 'geometric')),
  match_error       text,
  matched_at        timestamptz,
  segment_count     int,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CHECK (ended_at >= started_at)
);
CREATE INDEX drives_user ON drives (user_id, started_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX drives_vehicle ON drives (vehicle_id, started_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX drives_uploader ON drives (uploaded_by, started_at DESC);

-- Every street segment a drive covered (at least half of it), and when.
CREATE TABLE segment_passes (
  drive_id    uuid NOT NULL REFERENCES drives(id) ON DELETE CASCADE,
  segment_id  bigint NOT NULL REFERENCES street_segments(id),
  driven_at   timestamptz NOT NULL,
  fraction    real NOT NULL,
  PRIMARY KEY (drive_id, segment_id)
);
CREATE INDEX segment_passes_segment ON segment_passes (segment_id);

-- What a logger has sent: batches are idempotent on (logger, seq); points wait here
-- until the worker cuts them into drives at gaps.
CREATE TABLE logger_batches (
  logger_id     uuid NOT NULL REFERENCES loggers(id) ON DELETE CASCADE,
  seq           bigint NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  via           text NOT NULL DEFAULT 'wifi' CHECK (via IN ('wifi', 'ble')),
  relayed_by    uuid REFERENCES devices(id) ON DELETE SET NULL,
  point_count   int NOT NULL,
  PRIMARY KEY (logger_id, seq)
);
CREATE TABLE logger_points (
  logger_id  uuid NOT NULL REFERENCES loggers(id) ON DELETE CASCADE,
  t          timestamptz NOT NULL,
  lat        double precision NOT NULL,
  lon        double precision NOT NULL,
  speed      real,
  accuracy   real,
  drive_id   uuid REFERENCES drives(id) ON DELETE SET NULL,
  discarded  boolean NOT NULL DEFAULT false,   -- too short to be a drive
  PRIMARY KEY (logger_id, t)
);
CREATE INDEX logger_points_open ON logger_points (logger_id, t) WHERE drive_id IS NULL AND NOT discarded;

-- A team's swept streets: derived from passes, memberships and drive-type toggles, and
-- rebuilt from them whenever any of those change for past drives.
CREATE TABLE team_coverage (
  team_id          uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  segment_id       bigint NOT NULL REFERENCES street_segments(id),
  first_driven_at  timestamptz NOT NULL,
  first_drive_id   uuid REFERENCES drives(id) ON DELETE SET NULL,
  passes           int NOT NULL DEFAULT 1,
  PRIMARY KEY (team_id, segment_id)
);
CREATE INDEX team_coverage_segment ON team_coverage (segment_id);

-- Field marks: a street done without a drive ("walked it", "gated, did it by hand") or
-- left out ("private road"). One mark per street per team.
CREATE TABLE segment_marks (
  team_id     uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  segment_id  bigint NOT NULL REFERENCES street_segments(id),
  kind        text NOT NULL CHECK (kind IN ('complete', 'excluded')),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  note        text CHECK (length(note) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, segment_id)
);
