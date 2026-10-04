-- Mapped water (lakes, ponds, reservoirs, river banks) from the same extract as the
-- streets, for drawing areas: cutting the water out of an outline drawn roughly into a
-- lake, and snapping corners to the shoreline. Cut into small pieces so the spatial
-- index does the work even for a lake the size of Lake Travis.
CREATE TABLE water_parts (
  id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  geom  geometry(Polygon, 4326) NOT NULL
);
CREATE INDEX water_parts_geom ON water_parts USING gist (geom);

-- The shorelines themselves (outer and island edges), in short runs, for snapping to.
CREATE TABLE water_shores (
  id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  geom  geometry(LineString, 4326) NOT NULL
);
CREATE INDEX water_shores_geom ON water_shores USING gist (geom);
