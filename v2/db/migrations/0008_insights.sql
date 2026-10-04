-- Stage 5: achievements (people and teams), places with photos and sharing.

-- What someone has reached, and when. Definitions live in code (server/src/insights/
-- achievements.ts); a ladder stores one row per level reached, a badge one row at level 0.
CREATE TABLE user_achievements (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       text NOT NULL,
  level      int  NOT NULL DEFAULT 0,
  earned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code, level)
);
CREATE INDEX user_achievements_code ON user_achievements (code, level);

-- The same for a team as a whole.
CREATE TABLE team_achievements (
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  code       text NOT NULL,
  level      int  NOT NULL DEFAULT 0,
  earned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, code, level)
);
CREATE INDEX team_achievements_code ON team_achievements (code, level);

-- Spots someone marked: private to them until they share it with one of their teams.
CREATE TABLE places (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  note        text CHECK (length(note) <= 2000),
  geom        geometry(Point, 4326) NOT NULL,
  drive_id    uuid REFERENCES drives(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX places_user ON places (user_id) WHERE deleted_at IS NULL;
CREATE INDEX places_geom ON places USING gist (geom) WHERE deleted_at IS NULL;

CREATE TABLE place_shares (
  place_id   uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  shared_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (place_id, team_id)
);
CREATE INDEX place_shares_team ON place_shares (team_id);

CREATE TABLE place_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id    uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  path        text NOT NULL,
  width       int,
  height      int,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX place_photos_place ON place_photos (place_id, created_at);
