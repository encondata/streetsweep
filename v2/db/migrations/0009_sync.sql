-- Stage 6: what phones need to sync incrementally.

-- Things removed outright (not soft-deleted), so a phone that synced before can drop them.
CREATE TABLE deletions (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('mark')),
  team_id     uuid REFERENCES teams(id) ON DELETE CASCADE,
  key         text NOT NULL,
  deleted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deletions_at ON deletions (deleted_at);

-- When each covered segment last changed for a team, so phones get just the new ones.
ALTER TABLE team_coverage ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX team_coverage_updated ON team_coverage (team_id, updated_at);

-- A recount replaces a team's coverage wholesale: phones refetch it all after this.
ALTER TABLE teams ADD COLUMN coverage_reset_at timestamptz;

CREATE INDEX segment_marks_created ON segment_marks (team_id, created_at);
CREATE INDEX places_updated ON places (updated_at);
CREATE INDEX drives_updated ON drives (uploaded_by, updated_at);
