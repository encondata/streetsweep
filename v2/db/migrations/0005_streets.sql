-- Stage 3a: streets imported from an OpenStreetMap extract, split into segments.

-- Each run of the importer (worker job "osm-import").
CREATE TABLE osm_imports (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_url     text NOT NULL,
  region         text NOT NULL,                       -- e.g. "texas"
  status         text NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'done', 'failed', 'skipped')),
  step           text,                                -- what it's doing now, for the admin page
  osm_timestamp  timestamptz,                         -- how fresh the extract's data is
  file_bytes     bigint,
  ways           int,
  segments       int,
  added          int,
  changed        int,
  retired        int,
  error          text,
  requested_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);

-- The OpenStreetMap ways that count as streets (see SWEEPABLE in osm/import.ts).
CREATE TABLE street_ways (
  way_id      bigint PRIMARY KEY,
  name        text,
  highway     text NOT NULL,
  oneway      boolean NOT NULL DEFAULT false,
  tags        jsonb NOT NULL DEFAULT '{}',
  import_id   bigint NOT NULL REFERENCES osm_imports(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz                         -- gone from the latest extract
);

-- The unit of coverage: a way cut at every node it shares with another street.
-- Identified by (way, from node, to node, dup) so a re-import keeps the same id for the
-- same piece of street; `dup` tells apart the rare repeats of one node pair in one way.
-- Pieces that vanish from a later extract are retired, never deleted: drives point at them.
CREATE TABLE street_segments (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  way_id      bigint NOT NULL,
  from_node   bigint NOT NULL,
  to_node     bigint NOT NULL,
  dup         smallint NOT NULL DEFAULT 0,
  geom        geometry(LineString, 4326) NOT NULL,
  length_m    real NOT NULL,
  import_id   bigint NOT NULL REFERENCES osm_imports(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz,
  UNIQUE (way_id, from_node, to_node, dup)
);
CREATE INDEX street_segments_geom ON street_segments USING gist (geom) WHERE retired_at IS NULL;
CREATE INDEX street_segments_way ON street_segments (way_id);

-- Staging for an import run: filled by COPY, merged into the tables above, then emptied.
CREATE UNLOGGED TABLE import_ways (
  way_id   bigint NOT NULL,
  name     text,
  highway  text NOT NULL,
  oneway   boolean NOT NULL,
  tags     jsonb NOT NULL
);
CREATE UNLOGGED TABLE import_segments (
  way_id     bigint NOT NULL,
  from_node  bigint NOT NULL,
  to_node    bigint NOT NULL,
  dup        smallint NOT NULL,
  geom       geometry(LineString, 4326) NOT NULL
);
