-- Highways (OpenStreetMap trunk roads and motorways, no ramps) are imported and drawn
-- so they can be marked, but count toward a team's areas and figures only if the team
-- says so. Off by default: freeways are miles of road most people never set out to sweep.
ALTER TABLE teams ADD COLUMN count_highways boolean NOT NULL DEFAULT false;

-- Which of an area's pieces are highway, worked out at build so progress needn't join.
ALTER TABLE area_segments ADD COLUMN major boolean NOT NULL DEFAULT false;
