-- Stage 3b: areas (public boundaries and team drawings), their streets, and which
-- teams follow which public areas.

CREATE TABLE areas (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL: a public boundary from OpenStreetMap, there for every team to follow.
  team_id          uuid REFERENCES teams(id) ON DELETE CASCADE,
  parent_id        uuid REFERENCES areas(id) ON DELETE SET NULL,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  level            text NOT NULL CHECK (level IN ('state', 'county', 'city', 'neighborhood', 'custom')),
  source           text NOT NULL CHECK (source IN ('drawn', 'osm_boundary')),
  osm_relation_id  bigint,
  admin_level      smallint,
  geom             geometry(MultiPolygon, 4326) NOT NULL,
  color            text CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  notes            text CHECK (length(notes) <= 2000),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  -- Bumped whenever the outline changes; a build is for one version.
  version          int NOT NULL DEFAULT 1,
  -- Its street list (area_segments), built by the worker's "area-build" job.
  build_status     text NOT NULL DEFAULT 'none' CHECK (build_status IN ('none', 'queued', 'building', 'built', 'failed')),
  built_version    int,
  built_at         timestamptz,
  segment_count    int,
  street_m         double precision,
  build_error      text,
  CHECK ((source = 'osm_boundary') = (team_id IS NULL)),
  CHECK (source <> 'osm_boundary' OR osm_relation_id IS NOT NULL)
);
CREATE UNIQUE INDEX areas_osm_relation ON areas (osm_relation_id) WHERE source = 'osm_boundary';
CREATE INDEX areas_geom ON areas USING gist (geom) WHERE deleted_at IS NULL;
CREATE INDEX areas_team ON areas (team_id) WHERE deleted_at IS NULL;
CREATE INDEX areas_name ON areas (lower(name) text_pattern_ops) WHERE deleted_at IS NULL;

-- The streets inside an area, and how much of each lies inside (a street crossing the
-- edge counts only for its inside part).
CREATE TABLE area_segments (
  area_id     uuid NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  segment_id  bigint NOT NULL REFERENCES street_segments(id),
  inside_m    real NOT NULL,
  PRIMARY KEY (area_id, segment_id)
);
CREATE INDEX area_segments_segment ON area_segments (segment_id);

-- Public boundaries a team has chosen to follow (its own drawn areas it follows anyway).
CREATE TABLE team_areas (
  team_id   uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  area_id   uuid NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  added_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, area_id)
);

-- The boundary import keeps its own log beside the street one.
ALTER TABLE osm_imports ADD COLUMN boundaries int;
