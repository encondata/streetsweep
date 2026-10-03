-- Extensions every later migration leans on.
CREATE EXTENSION IF NOT EXISTS postgis;     -- geometry, spatial indexes
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive emails
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- EXCLUDE constraints on (vehicle_id, during)
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid()
