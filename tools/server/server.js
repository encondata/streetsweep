"use strict";

// Serves the area builder page and a small JSON API over Postgres.
// No framework: the surface is half a dozen routes and validation matters more than routing.

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const identity = require("./identity");
const achievements = require("./achievements");
const networks = require("./networks");
const streets = require("./streets");
const completions = require("./completions");
const photos = require("./photos");

const PORT = Number(process.env.PORT || 80);
// Set SYNC_TOKEN to require a shared secret on every /api call. Leave it empty only on a
// network you trust completely: the coverage data is a map of where you live and work.
const SYNC_TOKEN = (process.env.SYNC_TOKEN || "").trim();
const PUBLIC = path.join(__dirname, "public");
const PAGE = path.join(PUBLIC, "index.html");
const LOGIN_PAGE = path.join(PUBLIC, "login.html");
// Everything the browser may fetch by name. An allow list rather than a path join,
// so a crafted route can never walk out of the folder.
const ASSET_TYPES = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};
const ASSETS = new Set(
  fs.existsSync(PUBLIC)
    ? fs.readdirSync(PUBLIC).filter((f) => f !== "index.html" && ASSET_TYPES[path.extname(f)])
    : []
);
// Smallest first; the phone's AreaLevel enum is this same ladder in this same order.
const LEVEL_ORDER = ["NEIGHBORHOOD", "CITY", "COUNTY", "METRO", "REGION", "STATE"];
const LEVELS = new Set(LEVEL_ORDER);

// ---------------------------------------------------------------- photos
//
// Photos live on a volume rather than in the database: they are large, read rarely, and
// nothing joins against them. They are streamed out through the routes below, so they
// stay behind the same sign-in as everything else. See photos.js for why this is a
// directory and not MinIO any more.

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PHOTO_MAX_BYTES = 12 * 1024 * 1024;

const readyPhotos = () => photos.ready();
// A segment stamped longer than this after its drive began is not from that drive.
const DRIVE_EDGE_SLACK_MS = 12 * 60 * 60 * 1000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});

// ---------------------------------------------------------------- schema

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS areas (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT        NOT NULL,
      level       TEXT        NOT NULL,
      parent_name TEXT,
      -- [[lat, lng], ...] in drawing order, first point not repeated.
      polygon     JSONB       NOT NULL,
      -- Kept alongside so "which areas cover this point" stays cheap later.
      min_lat     DOUBLE PRECISION NOT NULL,
      min_lng     DOUBLE PRECISION NOT NULL,
      max_lat     DOUBLE PRECISION NOT NULL,
      max_lng     DOUBLE PRECISION NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Added after the first release, so they go on separately rather than in the
    -- CREATE above, which existing installations have already run.
    ALTER TABLE areas ADD COLUMN IF NOT EXISTS city  TEXT;
    ALTER TABLE areas ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE areas ADD COLUMN IF NOT EXISTS color TEXT;
    CREATE INDEX IF NOT EXISTS areas_bbox ON areas (min_lat, min_lng, max_lat, max_lng);

    -- What the phone reports back. Kept apart from "areas" on purpose: that table is the
    -- web's drawing surface, and a push from the phone must never delete an outline drawn
    -- here that has not reached the phone yet.
    CREATE TABLE IF NOT EXISTS reported_areas (
      name             TEXT PRIMARY KEY,
      level            TEXT NOT NULL,
      parent_name      TEXT,
      polygon          JSONB NOT NULL,
      streets_total    INTEGER NOT NULL DEFAULT 0,
      streets_done     INTEGER NOT NULL DEFAULT 0,
      streets_partial  INTEGER NOT NULL DEFAULT 0,
      streets_excluded INTEGER NOT NULL DEFAULT 0,
      meters_total     DOUBLE PRECISION NOT NULL DEFAULT 0,
      meters_driven    DOUBLE PRECISION NOT NULL DEFAULT 0,
      reported_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- One row per road segment the phone has driven, keyed the way the phone keys them so
    -- pushing the same drive twice changes nothing.
    CREATE TABLE IF NOT EXISTS driven_edges (
      key        TEXT PRIMARY KEY,
      way_id     BIGINT,
      name       TEXT,
      road_class TEXT,
      length_m   DOUBLE PRECISION NOT NULL DEFAULT 0,
      driven_at  BIGINT NOT NULL,
      shape      JSONB NOT NULL,
      min_lat    DOUBLE PRECISION NOT NULL,
      min_lng    DOUBLE PRECISION NOT NULL,
      max_lat    DOUBLE PRECISION NOT NULL,
      max_lng    DOUBLE PRECISION NOT NULL
    );
    CREATE INDEX IF NOT EXISTS edges_bbox ON driven_edges (min_lat, min_lng, max_lat, max_lng);
    CREATE INDEX IF NOT EXISTS edges_driven_at ON driven_edges (driven_at);

    CREATE TABLE IF NOT EXISTS drives (
      started_at   BIGINT PRIMARY KEY,
      ended_at     BIGINT,
      trigger      TEXT,
      point_count  INTEGER NOT NULL DEFAULT 0,
      distance_m   DOUBLE PRECISION NOT NULL DEFAULT 0,
      new_segments INTEGER NOT NULL DEFAULT 0,
      new_meters   DOUBLE PRECISION NOT NULL DEFAULT 0
    );
    -- A drive can be paused, and the time it stood still is not time driving.
    ALTER TABLE drives ADD COLUMN IF NOT EXISTS paused_ms BIGINT NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS pois (
      id   TEXT PRIMARY KEY,
      lat  DOUBLE PRECISION NOT NULL,
      lng  DOUBLE PRECISION NOT NULL,
      note TEXT,
      at   BIGINT NOT NULL
    );
    -- A marked place can be named and photographed after the fact, from either the
    -- phone or this page, so it needs somewhere to keep both and a way to tell which
    -- side edited last.
    ALTER TABLE pois ADD COLUMN IF NOT EXISTS name       TEXT;
    ALTER TABLE pois ADD COLUMN IF NOT EXISTS photo_key  TEXT;
    ALTER TABLE pois ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
  `);
}

/**
 * Who each drive, segment and marked place belongs to.
 *
 * Runs after the accounts schema, because everything here points at users(id), and after
 * the first administrator exists, because that is who the rows already in the database
 * are backfilled to: they arrived over the one shared token, and that token is now that
 * account.
 *
 * The keys matter more than the columns. "drives" was keyed by started_at alone and
 * "reported_areas" by name alone, which quietly assumed one phone: a second driver
 * starting in the same millisecond, or reporting an area of the same name, would
 * overwrite the first. Both keys grow to include the person.
 */
async function ensureAttribution() {
  const { rows } = await pool.query("SELECT id FROM users ORDER BY id LIMIT 1");
  const first = rows[0] ? rows[0].id : null;
  if (!first) return;                      // no accounts yet; nothing to point at

  await pool.query(`
    ALTER TABLE drives         ADD COLUMN IF NOT EXISTS user_id    BIGINT REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE drives         ADD COLUMN IF NOT EXISTS vehicle_id BIGINT REFERENCES vehicles(id) ON DELETE SET NULL;
    ALTER TABLE driven_edges   ADD COLUMN IF NOT EXISTS user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE driven_edges   ADD COLUMN IF NOT EXISTS vehicle_id BIGINT REFERENCES vehicles(id) ON DELETE SET NULL;
    ALTER TABLE pois           ADD COLUMN IF NOT EXISTS user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE reported_areas ADD COLUMN IF NOT EXISTS user_id    BIGINT REFERENCES users(id) ON DELETE CASCADE;
  `);

  // Everything already here came in over the shared token, which is the first account.
  await pool.query("UPDATE drives         SET user_id=$1 WHERE user_id IS NULL", [first]);
  await pool.query("UPDATE driven_edges   SET user_id=$1 WHERE user_id IS NULL", [first]);
  await pool.query("UPDATE pois           SET user_id=$1 WHERE user_id IS NULL", [first]);
  await pool.query("UPDATE reported_areas SET user_id=$1 WHERE user_id IS NULL", [first]);

  await pool.query("ALTER TABLE drives ALTER COLUMN user_id SET NOT NULL");
  await pool.query("ALTER TABLE reported_areas ALTER COLUMN user_id SET NOT NULL");

  // A drive is one person's, at one moment. Two people may start in the same
  // millisecond; one person cannot start twice in it.
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drives_pkey') THEN
        ALTER TABLE drives DROP CONSTRAINT drives_pkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drives_person_moment') THEN
        ALTER TABLE drives ADD CONSTRAINT drives_person_moment PRIMARY KEY (user_id, started_at);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reported_areas_pkey') THEN
        ALTER TABLE reported_areas DROP CONSTRAINT reported_areas_pkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reported_person_area') THEN
        ALTER TABLE reported_areas ADD CONSTRAINT reported_person_area PRIMARY KEY (user_id, name);
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS drives_user ON drives (user_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS edges_user  ON driven_edges (user_id);
  `);
}

/** Postgres is usually still starting when we are, so wait rather than crash-loop. */
async function waitForDatabase() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`waiting for postgres (${attempt})…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ------------------------------------------------------------ validation

class BadRequest extends Error {}

function cleanArea(body) {
  const name = String(body && body.name != null ? body.name : "").trim();
  if (!name) throw new BadRequest("An area needs a name");
  if (name.length > 120) throw new BadRequest("That name is too long");

  const level = String(body.level || "NEIGHBORHOOD").toUpperCase();
  if (!LEVELS.has(level)) throw new BadRequest(`Level must be one of ${[...LEVELS].join(", ")}`);

  const polygon = body.polygon;
  if (!Array.isArray(polygon) || polygon.length < 3) throw new BadRequest("An outline needs at least three corners");
  // Generous on purpose: a county as OpenStreetMap draws it runs to several thousand
  // corners and there is no reason to round it off. This is only here so a runaway
  // request cannot ask Postgres to hold something absurd.
  if (polygon.length > 50000) throw new BadRequest("That outline has too many corners");

  const points = polygon.map((p) => {
    if (!Array.isArray(p) || p.length < 2) throw new BadRequest("Each corner must be [lat, lng]");
    const lat = Number(p[0]);
    const lng = Number(p[1]);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new BadRequest("Latitude out of range");
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new BadRequest("Longitude out of range");
    return [lat, lng];
  });

  const lats = points.map((p) => p[0]);
  const lngs = points.map((p) => p[1]);
  const parent = body.parentName ? String(body.parentName).trim().slice(0, 120) : null;
  const city = body.city ? String(body.city).trim().slice(0, 120) : null;
  const notes = body.notes ? String(body.notes).trim().slice(0, 2000) : null;
  // A colour is only ever chosen from the swatches, so anything else is not one.
  const colour = /^#[0-9a-fA-F]{6}$/.test(String(body.color || "")) ? String(body.color) : null;

  return {
    name,
    level,
    parentName: parent || null,
    city: city || null,
    notes: notes || null,
    color: colour,
    polygon: points,
    minLat: Math.min(...lats),
    minLng: Math.min(...lngs),
    maxLat: Math.max(...lats),
    maxLng: Math.max(...lngs),
  };
}

/** Reads a request body as bytes rather than JSON, for a photo upload. */
function readBytes(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new BadRequest("That photo is too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function rowToPoi(r) {
  return {
    id: r.id,
    lat: Number(r.lat),
    lng: Number(r.lng),
    name: r.name || null,
    note: r.note || null,
    hasPhoto: Boolean(r.photo_key),
    at: Number(r.at),
    updatedAt: Number(r.updated_at) || Number(r.at),
  };
}

function rowToArea(row) {
  return {
    id: Number(row.id),
    name: row.name,
    level: row.level,
    parentName: row.parent_name,
    city: row.city || null,
    notes: row.notes || null,
    color: row.color || null,
    polygon: row.polygon,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ----------------------------------------------------------------- store

const COLUMNS = "id, name, level, parent_name, city, notes, color, polygon, created_at, updated_at";

// level is text, so an alphabetical sort would put NEIGHBORHOOD above CITY. Rank it instead,
// largest place first, the way the phone lists them.
const LEVEL_RANK = `CASE level ${
  LEVEL_ORDER.map((name, i) => `WHEN '${name}' THEN ${LEVEL_ORDER.length - 1 - i}`).join(" ")
} ELSE ${LEVEL_ORDER.length} END`;

async function listAreas() {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM areas ORDER BY ${LEVEL_RANK}, name`);
  return rows.map(rowToArea);
}

async function createArea(area) {
  const { rows } = await pool.query(
    `INSERT INTO areas (name, level, parent_name, city, notes, color,
                        polygon, min_lat, min_lng, max_lat, max_lng)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${COLUMNS}`,
    [area.name, area.level, area.parentName, area.city, area.notes, area.color,
     JSON.stringify(area.polygon), area.minLat, area.minLng, area.maxLat, area.maxLng],
  );
  return rowToArea(rows[0]);
}

async function updateArea(id, area) {
  const { rows } = await pool.query(
    `UPDATE areas SET name=$1, level=$2, parent_name=$3, city=$4, notes=$5, color=$6,
                      polygon=$7, min_lat=$8, min_lng=$9, max_lat=$10, max_lng=$11,
                      updated_at=now()
     WHERE id=$12 RETURNING ${COLUMNS}`,
    [area.name, area.level, area.parentName, area.city, area.notes, area.color,
     JSON.stringify(area.polygon), area.minLat, area.minLng, area.maxLat, area.maxLng, id],
  );
  return rows.length ? rowToArea(rows[0]) : null;
}

async function deleteArea(id) {
  const { rowCount } = await pool.query("DELETE FROM areas WHERE id=$1", [id]);
  return rowCount > 0;
}

/**
 * The phone's own ladder stops at METRO, and anything it does not recognise it reads as a
 * NEIGHBORHOOD — the smallest rung, which is the worst possible guess for a county. So on
 * the way out, the three rungs the phone has never heard of become the biggest one it has.
 */
const PHONE_LEVELS = new Set(["NEIGHBORHOOD", "CITY", "METRO"]);
function levelForPhone(level) {
  return PHONE_LEVELS.has(level) ? level : "METRO";
}

/** The same shape tools/area-builder.html exports and the Android app imports. */
function toGeoJson(areas) {
  return {
    type: "FeatureCollection",
    features: areas.map((a) => {
      const ring = a.polygon.map(([lat, lng]) => [round(lng), round(lat)]);
      ring.push(ring[0]);
      const properties = { kind: "area", name: a.name, level: levelForPhone(a.level) };
      if (a.parentName) properties.parent = a.parentName;
      if (a.city) properties.city = a.city;
      if (a.notes) properties.notes = a.notes;
      if (a.color) properties.color = a.color;
      return { type: "Feature", properties, geometry: { type: "Polygon", coordinates: [ring] } };
    }),
  };
}

function round(v) { return Math.round(v * 1e6) / 1e6; }

function extensionFor(type) {
  return type === "image/png" ? ".png" : type === "image/webp" ? ".webp" : ".jpg";
}

/** Accepts a GeoJSON document and stores every polygon in it. */
async function importGeoJson(doc) {
  const features = (doc && doc.features) || [];
  const created = [];
  let unnamed = 0;
  for (const feature of features) {
    const geometry = feature.geometry || {};
    const properties = feature.properties || {};
    if (properties.kind && properties.kind !== "area") continue;

    const rings = geometry.type === "Polygon" ? [geometry.coordinates && geometry.coordinates[0]]
      : geometry.type === "MultiPolygon" ? (geometry.coordinates || []).map((p) => p[0])
      : [];
    for (const ring of rings) {
      if (!Array.isArray(ring)) continue;
      const points = ring.map((c) => [c[1], c[0]]);
      // GeoJSON repeats the first point to close the ring; our model does not.
      if (points.length > 1 &&
          points[0][0] === points[points.length - 1][0] &&
          points[0][1] === points[points.length - 1][1]) points.pop();
      if (points.length < 3) continue;
      created.push(await createArea(cleanArea({
        name: properties.name || `Imported area ${++unnamed}`,
        level: normaliseLevel(properties.level),
        parentName: properties.parent,
        polygon: points,
      })));
    }
  }
  return created;
}

function normaliseLevel(level) {
  if (typeof level === "number") {
    return LEVEL_ORDER[level] || "NEIGHBORHOOD";
  }
  const up = String(level || "").toUpperCase();
  return LEVELS.has(up) ? up : "NEIGHBORHOOD";
}


// ------------------------------------------------------------ phone sync

const EDGE_LIMIT = 30000;

function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

/** Keeps a shape usable: pairs of finite, in-range coordinates and nothing else. */
function shapePoints(raw) {
  if (!Array.isArray(raw)) return null;
  const points = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const lat = Number(p[0]);
    const lng = Number(p[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    points.push([lat, lng]);
  }
  return points.length ? points : null;
}

function bbox(points) {
  const lats = points.map((p) => p[0]);
  const lngs = points.map((p) => p[1]);
  return [Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs)];
}

/**
 * Takes whatever the phone sends. Sections left out are untouched, so edges can arrive in
 * batches without resending the rest. A malformed row is skipped rather than failing the
 * whole push: losing one segment beats losing the sync.
 */
async function applySync(body, by) {
  const result = { areas: 0, edges: 0, drives: 0, pois: 0, completions: 0, skipped: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (Array.isArray(body.areas)) {
      // Only this person's. Without the WHERE, one phone syncing wiped every other
      // driver's reported areas — the exact overwrite the composite key exists to stop.
      await client.query("DELETE FROM reported_areas WHERE user_id=$1", [by.userId]);
      for (const a of body.areas) {
        const points = shapePoints(a.polygon);
        const name = String(a.name || "").trim();
        if (!points || points.length < 3 || !name) { result.skipped++; continue; }
        const st = a.stats || {};
        await client.query(
          `INSERT INTO reported_areas
             (user_id, name, level, parent_name, polygon, streets_total, streets_done,
              streets_partial, streets_excluded, meters_total, meters_driven, reported_at)
           VALUES ($11,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
           ON CONFLICT (user_id, name) DO UPDATE SET
             level=EXCLUDED.level, parent_name=EXCLUDED.parent_name, polygon=EXCLUDED.polygon,
             streets_total=EXCLUDED.streets_total, streets_done=EXCLUDED.streets_done,
             streets_partial=EXCLUDED.streets_partial, streets_excluded=EXCLUDED.streets_excluded,
             meters_total=EXCLUDED.meters_total, meters_driven=EXCLUDED.meters_driven,
             reported_at=now()`,
          [name, normaliseLevel(a.level), a.parent || null, JSON.stringify(points),
           num(st.total, 0), num(st.done, 0), num(st.partial, 0), num(st.excluded, 0),
           num(st.metersTotal, 0), num(st.metersDriven, 0), by.userId],
        );
        result.areas++;
      }
    }

    // "Send everything again" is about this phone's own contribution. Dropping the whole
    // table would throw away every other driver's coverage as well.
    if (body.resetEdges) {
      await client.query("DELETE FROM driven_edges WHERE user_id=$1", [by.userId]);
    }

    if (Array.isArray(body.edges)) {
      for (const e of body.edges) {
        const points = shapePoints(e.shape);
        const key = String(e.key || "").trim();
        if (!points || points.length < 2 || !key) { result.skipped++; continue; }
        const box = bbox(points);
        await client.query(
          `INSERT INTO driven_edges
             (key, way_id, name, road_class, length_m, driven_at, shape,
              min_lat, min_lng, max_lat, max_lng, user_id, vehicle_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (key) DO UPDATE SET
             name=EXCLUDED.name, road_class=EXCLUDED.road_class, length_m=EXCLUDED.length_m,
             driven_at=LEAST(driven_edges.driven_at, EXCLUDED.driven_at), shape=EXCLUDED.shape,
             -- Coverage is shared, so a street stays credited to whoever swept it first.
             -- Only a later pass that predates the one on record changes that.
             user_id=CASE WHEN EXCLUDED.driven_at < driven_edges.driven_at
                          THEN EXCLUDED.user_id ELSE driven_edges.user_id END,
             vehicle_id=CASE WHEN EXCLUDED.driven_at < driven_edges.driven_at
                          THEN EXCLUDED.vehicle_id ELSE driven_edges.vehicle_id END`,
          [key, num(e.wayId, null), e.name || null, e.roadClass || null, num(e.lengthMeters, 0),
           num(e.drivenAt, 0), JSON.stringify(points), box[0], box[1], box[2], box[3],
           by.userId, by.vehicleId],
        );
        result.edges++;
      }
    }

    if (Array.isArray(body.drives)) {
      // This phone sends its whole history each time, so its own rows are replaced —
      // but only its own. Unscoped, the second driver to sync erased the first one's
      // drives entirely, which is what the test caught.
      await client.query("DELETE FROM drives WHERE user_id=$1", [by.userId]);
      for (const d of body.drives) {
        const startedAt = num(d.startedAt, 0);
        if (!startedAt) { result.skipped++; continue; }
        await client.query(
          `INSERT INTO drives (user_id, vehicle_id, started_at, ended_at, trigger, point_count,
                               distance_m, new_segments, new_meters, paused_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (user_id, started_at) DO UPDATE SET
             vehicle_id=EXCLUDED.vehicle_id,
             ended_at=EXCLUDED.ended_at, trigger=EXCLUDED.trigger, point_count=EXCLUDED.point_count,
             distance_m=EXCLUDED.distance_m, new_segments=EXCLUDED.new_segments,
             new_meters=EXCLUDED.new_meters, paused_ms=EXCLUDED.paused_ms`,
          [by.userId, by.vehicleId, startedAt, num(d.endedAt, null), d.trigger || null,
           num(d.pointCount, 0), num(d.distanceMeters, 0), num(d.newSegments, 0),
           num(d.newMeters, 0), num(d.pausedMs, 0)],
        );
        result.drives++;
      }
    }

    if (Array.isArray(body.pois)) {
      // The phone owns which places exist and where they are, so one it no longer
      // has is one you deleted. It does not own the name and note: those can be
      // written from this page too, so the newer edit wins rather than the last
      // sender. Wiping the table and refilling it, as this used to, threw away
      // anything written here between drives.
      const keep = [];
      for (const p of body.pois) {
        const lat = Number(p.lat);
        const lng = Number(p.lng);
        const at = num(p.at, 0);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !at) { result.skipped++; continue; }
        const id = at + ":" + lat.toFixed(6) + ":" + lng.toFixed(6);
        keep.push(id);
        await client.query(
          `INSERT INTO pois (id, lat, lng, note, name, photo_key, at, updated_at, user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO UPDATE SET
             -- A place keeps the person who first marked it.
             user_id = COALESCE(pois.user_id, EXCLUDED.user_id),
             lat = EXCLUDED.lat,
             lng = EXCLUDED.lng,
             note = CASE WHEN EXCLUDED.updated_at >= pois.updated_at THEN EXCLUDED.note ELSE pois.note END,
             name = CASE WHEN EXCLUDED.updated_at >= pois.updated_at THEN EXCLUDED.name ELSE pois.name END,
             photo_key = COALESCE(EXCLUDED.photo_key, pois.photo_key),
             updated_at = GREATEST(EXCLUDED.updated_at, pois.updated_at)`,
          [id, lat, lng, p.note || null, p.name || null, p.photoKey || null, at,
           num(p.updatedAt, at), by.userId],
        );
        result.pois++;
      }
      // Places this phone no longer has, and only this person's: another driver's
      // marks are not this phone's to forget.
      await client.query(
        keep.length
          ? "DELETE FROM pois WHERE user_id=$2 AND NOT (id = ANY($1))"
          : "DELETE FROM pois WHERE user_id=$1",
        keep.length ? [keep, by.userId] : [by.userId],
      );
    }

    if (Array.isArray(body.completions)) {
      // Streets marked complete on the phone. Not scoped to the sender like the rest:
      // a street is finished for everyone, and the newer edit wins whoever made it.
      result.completions = await completions.apply(client, body.completions, by.userId);
    }
    if (Array.isArray(body.exclusions)) {
      // Streets excluded on the phone: gated, private, not drivable. Shared the same way.
      result.exclusions = await completions.applyExclusions(client, body.exclusions, by.userId);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return result;
}

/** Everything the coverage tab draws and counts, in one call. */
/**
 * Drives, each with the ground it actually covered.
 *
 * The phone does not tie a road segment to a drive, but it does stamp every segment with
 * when it was driven, and a drive knows when it began and ended. That is enough to hand
 * each drive its own shape, which is what the list thumbnails and the drive map draw.
 */
async function drives(limit, withShapes) {
  const { rows } = await pool.query(
    `SELECT d.started_at, d.ended_at, d.trigger, d.point_count, d.distance_m,
            d.new_segments, d.new_meters, d.paused_ms,
            u.name AS driver, u.id AS driver_id, v.name AS vehicle
       FROM drives d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN vehicles v ON v.id = d.vehicle_id
      ORDER BY d.started_at DESC LIMIT $1`,
    [Math.min(Math.max(1, limit || 50), 500)],
  );
  if (rows.length === 0) return [];

  const oldest = Number(rows[rows.length - 1].started_at);
  const { rows: edges } = await pool.query(
    `SELECT driven_at, length_m, shape, min_lat, min_lng, max_lat, max_lng
     FROM driven_edges WHERE driven_at >= $1 ORDER BY driven_at`,
    [oldest],
  );

  // Areas are matched by whether the drive's middle falls inside one, which is cheap and
  // right often enough to label a row with.
  const { rows: areaRows } = await pool.query(`SELECT name, polygon, min_lat, min_lng, max_lat, max_lng FROM areas`);

  // Each segment belongs to one drive: the most recent one that had already started when
  // it was stamped. Matching runs after a drive ends, so a window around each drive would
  // let neighbouring drives both claim the same ground.
  const starts = rows.map((d) => Number(d.started_at)).sort((a, b) => a - b);
  const owned = new Map(starts.map((t) => [t, []]));
  for (const e of edges) {
    const at = Number(e.driven_at);
    let lo = 0;
    let hi = starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= at) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (found < 0) continue;
    if (at - starts[found] > DRIVE_EDGE_SLACK_MS) continue;
    owned.get(starts[found]).push(e);
  }

  return rows.map((d) => {
    const from = Number(d.started_at);
    const mine = owned.get(from) || [];
    const box = mine.length
      ? {
          south: Math.min(...mine.map((e) => e.min_lat)),
          west: Math.min(...mine.map((e) => e.min_lng)),
          north: Math.max(...mine.map((e) => e.max_lat)),
          east: Math.max(...mine.map((e) => e.max_lng)),
        }
      : null;
    const centre = box ? [(box.south + box.north) / 2, (box.west + box.east) / 2] : null;
    const area = centre ? (areaRows.find((a) => contains(a, centre)) || {}).name || null : null;

    const out = {
      startedAt: from,
      endedAt: d.ended_at ? Number(d.ended_at) : null,
      trigger: d.trigger,
      points: d.point_count,
      distanceMeters: Number(d.distance_m) || 0,
      newSegments: d.new_segments,
      newMeters: Number(d.new_meters) || 0,
      pausedMs: Number(d.paused_ms) || 0,
      area,
      bounds: box,
      segments: mine.length,
      driver: d.driver || null,
      driverId: d.driver_id != null ? Number(d.driver_id) : null,
      vehicle: d.vehicle || null,
    };
    if (withShapes) out.shape = mine.map((e) => e.shape);
    else out.shape = mine.map((e) => [e.shape[0], e.shape[e.shape.length - 1]]);
    return out;
  });
}

/** Ray casting, the same test the phone uses. */
function contains(area, point) {
  const [lat, lng] = point;
  if (lat < area.min_lat || lat > area.max_lat || lng < area.min_lng || lng > area.max_lng) return false;
  const ring = area.polygon || [];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ai, aj] = [ring[i], ring[j]];
    if ((ai[0] > lat) !== (aj[0] > lat) &&
        lng < ((aj[1] - ai[1]) * (lat - ai[0])) / (aj[0] - ai[0]) + ai[1]) {
      inside = !inside;
    }
  }
  return inside;
}

async function coverage(edgeLimit) {
  const cap = Math.max(1, Math.min(edgeLimit, EDGE_LIMIT));
  const [areas, edges, drives, pois, totals] = await Promise.all([
    pool.query(`SELECT name, level, parent_name, polygon, streets_total, streets_done,
                       streets_partial, streets_excluded, meters_total, meters_driven, reported_at
                FROM reported_areas ORDER BY ${LEVEL_RANK}, name`),
    pool.query("SELECT key, name, road_class, length_m, driven_at, shape FROM driven_edges ORDER BY driven_at DESC LIMIT $1", [cap]),
    pool.query("SELECT started_at, ended_at, trigger, point_count, distance_m, new_segments, new_meters, paused_ms FROM drives ORDER BY started_at DESC"),
    pool.query("SELECT id, lat, lng, note, name, photo_key, at, updated_at FROM pois ORDER BY at DESC"),
    pool.query("SELECT COUNT(*)::int AS edges, COALESCE(SUM(length_m),0) AS meters FROM driven_edges"),
  ]);

  return {
    areas: areas.rows.map((r) => ({
      name: r.name,
      level: r.level,
      parentName: r.parent_name,
      polygon: r.polygon,
      stats: {
        total: r.streets_total, done: r.streets_done, partial: r.streets_partial,
        excluded: r.streets_excluded, metersTotal: Number(r.meters_total),
        metersDriven: Number(r.meters_driven),
      },
      reportedAt: r.reported_at,
    })),
    edges: edges.rows.map((r) => ({
      key: r.key, name: r.name, roadClass: r.road_class,
      lengthMeters: Number(r.length_m), drivenAt: Number(r.driven_at), shape: r.shape,
    })),
    drives: drives.rows.map((r) => ({
      startedAt: Number(r.started_at), endedAt: r.ended_at === null ? null : Number(r.ended_at),
      trigger: r.trigger, pointCount: r.point_count, distanceMeters: Number(r.distance_m),
      newSegments: r.new_segments, newMeters: Number(r.new_meters),
      pausedMs: Number(r.paused_ms) || 0,
    })),
    pois: pois.rows.map(rowToPoi),
    totals: {
      edges: totals.rows[0].edges,
      edgeMeters: Number(totals.rows[0].meters),
      edgesShown: edges.rows.length,
    },
  };
}

// --------------------------------------------------------------- plumbing

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new BadRequest("That file is too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(new BadRequest("Body is not valid JSON")); }
    });
    req.on("error", reject);
  });
}

/** True when switching this person off or down would leave nobody able to manage users. */
async function lastAdmin(id) {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM users WHERE role='admin' AND active AND id <> $1", [id]);
  return rows[0].n === 0;
}

function cleanVehicle(body) {
  const name = String(body.name || "").trim();
  if (!name) throw new BadRequest("A vehicle needs a name");
  if (name.length > 80) throw new BadRequest("That name is too long");
  return {
    name,
    plate: body.plate ? String(body.plate).trim().slice(0, 32) : null,
    note: body.note ? String(body.note).trim().slice(0, 500) : null,
  };
}

function rowToVehicle(row) {
  return {
    id: Number(row.id), name: row.name, plate: row.plate, note: row.note,
    active: row.active !== false, createdAt: row.created_at,
  };
}

/** Routes anyone may reach without proving who they are. */
// A picture of a face, already shrunk to 256px by the browser. Anything approaching
// this is not a face, it is someone pushing.
const AVATAR_MAX_BYTES = 1024 * 1024;

const OPEN_ROUTES = new Set([
  "/api/config", "/api/health", "/api/auth/login", "/api/auth/device",
]);

/** Which right a route needs. Anything not listed here needs only "read". */
function rightFor(route, method) {
  if (route === "/api/vehicles/mine") return "read";
  if (route === "/api/auth/avatar") return "read";          // your own picture
  if (route.startsWith("/api/achievements")) return "read"; // guarded inside

  if (/^\/api\/users\/\d+\/avatar$/.test(route)) return "read";
  if (route.startsWith("/api/admin/")) return "admin";
  if (route.startsWith("/api/admin/")) return "admin";
  if (route.startsWith("/api/users") || route.startsWith("/api/vehicles") ||
      route.startsWith("/api/devices")) return "admin";
  if (route.startsWith("/api/areas") && method !== "GET") return "areas";
  if (route === "/api/sync") return "record";
  if (route.startsWith("/api/pois") && method !== "GET") return "record";
  if (route.startsWith("/api/street-completions") && method !== "GET") return "record";
  if (route.startsWith("/api/street-exclusions") && method !== "GET") return "record";
  return "read";
}

function setCookie(res, value, maxAgeSeconds, req) {
  // Secure only when the request really came over https, or a plain-http install on a
  // LAN would set a cookie the browser then refuses to send back.
  const https = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  res.setHeader("Set-Cookie",
    `${identity.COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}` +
    (https ? "; Secure" : ""));
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const route = url.pathname;

  // The page itself stays open so a browser can load it and offer a sign-in form;
  // everything that reads or writes data does not.
  let who = null;
  if (route.startsWith("/api/") && !OPEN_ROUTES.has(route)) {
    who = await identity.identify(pool, req, { legacyToken: SYNC_TOKEN });
    if (!who) {
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
      return res.end(JSON.stringify({ error: "Please sign in", needsAuth: true }));
    }
    const right = rightFor(route, req.method);
    if (!identity.can(who.user, right)) {
      return sendJson(res, 403, {
        error: right === "admin"
          ? "That is an administrator's job."
          : `A ${who.user.role} account cannot do that.`,
      });
    }
  }

  if (route.length > 1 && ASSETS.has(route.slice(1))) {
    const file = route.slice(1);
    res.writeHead(200, {
      "Content-Type": ASSET_TYPES[path.extname(file)],
      "Cache-Control": "public, max-age=86400",
    });
    return res.end(fs.readFileSync(path.join(PUBLIC, file)));
  }

  if (route === "/login") {
    // Already signed in? Nothing to do here.
    const already = await identity.identify(pool, req, { legacyToken: SYNC_TOKEN });
    if (already && already.via === "session") {
      res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(fs.readFileSync(LOGIN_PAGE));
  }

  if (route === "/" || route === "/index.html") {
    const html = fs.readFileSync(PAGE);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(html);
  }

  if (route === "/api/config") {
    return sendJson(res, 200, { needsAuth: true, signIn: "password" });
  }

  // ---------------------------------------------------------------- signing in

  if (route === "/api/auth/login" && req.method === "POST") {
    const body = await readBody(req);
    const result = await identity.signIn(pool, body.email, body.password);
    if (result.error) return sendJson(res, result.status, { error: result.error });
    const token = await identity.startSession(pool, result.user.id, req.headers["user-agent"]);
    setCookie(res, token, 30 * 24 * 60 * 60, req);
    return sendJson(res, 200, { user: result.user });
  }

  /**
   * How a phone signs in. The browser gets a cookie; a phone gets a device token it
   * keeps, because it syncs in the background long after anyone last looked at it.
   * Same password check and the same lockout as the browser path.
   */
  if (route === "/api/auth/device" && req.method === "POST") {
    const body = await readBody(req);
    const result = await identity.signIn(pool, body.email, body.password);
    if (result.error) return sendJson(res, result.status, { error: result.error });
    if (!identity.can(result.user, "record")) {
      return sendJson(res, 403, { error: "This account cannot record drives." });
    }
    const token = await identity.createDeviceToken(pool, {
      userId: result.user.id,
      label: String(body.label || "Phone").slice(0, 80),
      vehicleId: body.vehicleId ? Number(body.vehicleId) : null,
    });
    return sendJson(res, 201, { token, user: result.user });
  }

  if (route === "/api/auth/logout" && req.method === "POST") {
    const raw = String(req.headers.cookie || "");
    const at = raw.indexOf(identity.COOKIE + "=");
    if (at >= 0) {
      const rest = raw.slice(at + identity.COOKIE.length + 1);
      await identity.endSession(pool, rest.split(";")[0].trim());
    }
    setCookie(res, "", 0, req);
    return sendJson(res, 200, { ok: true });
  }

  /**
   * Your own picture. Sized down to 256px in the browser before it gets here, so this
   * only has to guard the type and the size rather than decode anything.
   */
  if (route === "/api/auth/avatar" && (req.method === "POST" || req.method === "PUT")) {
    if (!photos.on()) return sendJson(res, 503, { error: "Photo storage is not working on this server" });
    const type = String(req.headers["content-type"] || "").split(";")[0].trim();
    if (!PHOTO_TYPES.has(type)) return sendJson(res, 400, { error: "Send a JPEG, PNG or WebP" });
    const bytes = await readBytes(req, AVATAR_MAX_BYTES);
    if (!bytes.length) return sendJson(res, 400, { error: "That upload was empty" });
    const key = "avatars/" + who.user.id + extensionFor(type);
    await photos.put(key, bytes);
    await pool.query("UPDATE users SET avatar_key=$1, updated_at=now() WHERE id=$2",
      [key, who.user.id]);
    return sendJson(res, 200, { ok: true, bytes: bytes.length });
  }

  if (route === "/api/auth/avatar" && req.method === "DELETE") {
    const { rows } = await pool.query("SELECT avatar_key FROM users WHERE id=$1", [who.user.id]);
    if (rows[0] && rows[0].avatar_key) await photos.remove(rows[0].avatar_key);
    await pool.query("UPDATE users SET avatar_key=NULL, updated_at=now() WHERE id=$1", [who.user.id]);
    return sendJson(res, 200, { ok: true });
  }

  // Anyone signed in may see anyone's picture: they are shown beside names all over
  // the admin page, and they are not a secret from the people they work with.
  const avatarMatch = route.match(/^\/api\/users\/(\d+)\/avatar$/);
  if (avatarMatch && req.method === "GET") {
    if (!photos.on()) return sendJson(res, 404, { error: "No picture" });
    const { rows } = await pool.query("SELECT avatar_key FROM users WHERE id=$1", [Number(avatarMatch[1])]);
    const key = rows[0] && rows[0].avatar_key;
    if (!key) return sendJson(res, 404, { error: "No picture" });
    const stat = await photos.stat(key);
    if (!stat) return sendJson(res, 404, { error: "That picture is no longer in storage" });
    res.writeHead(200, {
      "Content-Type": stat.type,
      "Content-Length": stat.size,
      // It is keyed by user id, so the url never changes; the version query does.
      "Cache-Control": "private, max-age=86400",
    });
    return photos.readStream(key).pipe(res);
  }

  /** Your own, or anyone's if you are an administrator. */
  const achMatch = route.match(/^\/api\/achievements(?:\/(\d+))?$/);
  if (achMatch && req.method === "GET") {
    const wanted = achMatch[1] ? Number(achMatch[1]) : who.user.id;
    if (wanted !== who.user.id && !identity.can(who.user, "admin")) {
      return sendJson(res, 403, { error: "That is an administrator's job." });
    }
    return sendJson(res, 200, await achievements.forUser(pool, wanted));
  }

  if (route === "/api/auth/me" && req.method === "GET") {
    return sendJson(res, 200, { user: who.user, via: who.via, vehicleId: who.vehicleId || null });
  }

  // Changing your own password. Knowing the current one is required even for an admin,
  // because a session left open on someone else's screen should not be enough.
  if (route === "/api/auth/password" && req.method === "POST") {
    const body = await readBody(req);
    const next = String(body.password || "");
    if (next.length < 10) throw new BadRequest("Use at least 10 characters");
    const { rows } = await pool.query("SELECT password_hash FROM users WHERE id=$1", [who.user.id]);
    const ok = await identity.passwordMatches(String(body.current || ""), rows[0].password_hash);
    if (!ok) return sendJson(res, 403, { error: "That is not your current password." });
    await pool.query("UPDATE users SET password_hash=$1, updated_at=now() WHERE id=$2",
      [await identity.hashPassword(next), who.user.id]);
    return sendJson(res, 200, { ok: true });
  }

  // ---------------------------------------------------------------- people

  if (route === "/api/users" && req.method === "GET") {
    const { rows } = await pool.query(
      `SELECT u.*, (SELECT count(*)::int FROM device_tokens d
                     WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS devices
         FROM users u ORDER BY u.active DESC, lower(u.name)`);
    return sendJson(res, 200, {
      users: rows.map((r) => Object.assign(identity.publicUser(r), { devices: r.devices })),
    });
  }

  if (route === "/api/users" && req.method === "POST") {
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    const role = String(body.role || "driver").toLowerCase();
    const password = String(body.password || "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequest("That is not an email address");
    if (!name) throw new BadRequest("A name is required");
    if (!identity.ROLES.includes(role)) throw new BadRequest(`Role must be one of ${identity.ROLES.join(", ")}`);
    if (password.length < 10) throw new BadRequest("Use at least 10 characters");
    const { rows: clash } = await pool.query("SELECT 1 FROM users WHERE email=$1", [email]);
    if (clash[0]) throw new BadRequest("Someone already has that email address");
    const { rows } = await pool.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING *`,
      [email, name, role, await identity.hashPassword(password)]);
    return sendJson(res, 201, { user: identity.publicUser(rows[0]) });
  }

  const userMatch = route.match(/^\/api\/users\/(\d+)$/);
  if (userMatch) {
    const id = Number(userMatch[1]);
    if (req.method === "PATCH") {
      const body = await readBody(req);
      const sets = [], vals = [];
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) throw new BadRequest("A name is required");
        sets.push(`name=$${sets.length + 1}`); vals.push(name);
      }
      if (body.role !== undefined) {
        const role = String(body.role).toLowerCase();
        if (!identity.ROLES.includes(role)) throw new BadRequest("Unknown role");
        // Losing the last administrator would lock everyone out of user management.
        if (id === who.user.id && role !== "admin") {
          throw new BadRequest("You cannot take away your own administrator role");
        }
        if (role !== "admin" && await lastAdmin(id)) {
          throw new BadRequest("This is the only administrator left");
        }
        sets.push(`role=$${sets.length + 1}`); vals.push(role);
      }
      if (body.active !== undefined) {
        const active = Boolean(body.active);
        if (!active && id === who.user.id) throw new BadRequest("You cannot switch off your own account");
        if (!active && await lastAdmin(id)) throw new BadRequest("This is the only administrator left");
        sets.push(`active=$${sets.length + 1}`); vals.push(active);
      }
      if (body.password !== undefined) {
        const next = String(body.password);
        if (next.length < 10) throw new BadRequest("Use at least 10 characters");
        sets.push(`password_hash=$${sets.length + 1}`); vals.push(await identity.hashPassword(next));
      }
      if (!sets.length) throw new BadRequest("Nothing to change");
      vals.push(id);
      const { rows } = await pool.query(
        `UPDATE users SET ${sets.join(", ")}, updated_at=now() WHERE id=$${vals.length} RETURNING *`, vals);
      if (!rows[0]) return sendJson(res, 404, { error: "No such person" });
      // A new password or a switched-off account must not leave old logins working.
      if (body.password !== undefined || body.active === false) {
        await identity.endAllSessions(pool, id);
      }
      return sendJson(res, 200, { user: identity.publicUser(rows[0]) });
    }
    if (req.method === "DELETE") {
      if (id === who.user.id) throw new BadRequest("You cannot delete your own account");
      if (await lastAdmin(id)) throw new BadRequest("This is the only administrator left");
      const { rowCount } = await pool.query("DELETE FROM users WHERE id=$1", [id]);
      return rowCount ? sendJson(res, 204, {}) : sendJson(res, 404, { error: "No such person" });
    }
  }

  // ---------------------------------------------------------------- vehicles

  // A driver choosing which vehicle they are in needs the list, so this one read is
  // open to any signed-in account rather than admins only.
  if (route === "/api/vehicles/mine" && req.method === "GET") {
    const { rows } = await pool.query(
      "SELECT * FROM vehicles WHERE active ORDER BY lower(name)");
    return sendJson(res, 200, { vehicles: rows.map(rowToVehicle) });
  }

  if (route === "/api/vehicles" && req.method === "GET") {
    const { rows } = await pool.query(
      "SELECT * FROM vehicles ORDER BY active DESC, lower(name)");
    return sendJson(res, 200, { vehicles: rows.map(rowToVehicle) });
  }

  if (route === "/api/vehicles" && req.method === "POST") {
    const v = cleanVehicle(await readBody(req));
    const { rows } = await pool.query(
      "INSERT INTO vehicles (name, plate, note) VALUES ($1,$2,$3) RETURNING *",
      [v.name, v.plate, v.note]);
    return sendJson(res, 201, { vehicle: rowToVehicle(rows[0]) });
  }

  const vehicleMatch = route.match(/^\/api\/vehicles\/(\d+)$/);
  if (vehicleMatch) {
    const id = Number(vehicleMatch[1]);
    if (req.method === "PATCH") {
      const body = await readBody(req);
      const v = cleanVehicle(body);
      const { rows } = await pool.query(
        `UPDATE vehicles SET name=$1, plate=$2, note=$3,
                active=COALESCE($4, active), updated_at=now() WHERE id=$5 RETURNING *`,
        [v.name, v.plate, v.note, body.active === undefined ? null : Boolean(body.active), id]);
      return rows[0] ? sendJson(res, 200, { vehicle: rowToVehicle(rows[0]) })
                     : sendJson(res, 404, { error: "No such vehicle" });
    }
    if (req.method === "DELETE") {
      const { rowCount } = await pool.query("DELETE FROM vehicles WHERE id=$1", [id]);
      return rowCount ? sendJson(res, 204, {}) : sendJson(res, 404, { error: "No such vehicle" });
    }
  }

  // ---------------------------------------------------------------- phones

  if (route === "/api/devices" && req.method === "GET") {
    const { rows } = await pool.query(
      `SELECT d.token_hash, d.label, d.vehicle_id, d.created_at, d.last_seen_at, d.revoked_at,
              u.name AS user_name, u.id AS user_id, v.name AS vehicle_name
         FROM device_tokens d
         JOIN users u ON u.id = d.user_id
         LEFT JOIN vehicles v ON v.id = d.vehicle_id
        ORDER BY d.revoked_at NULLS FIRST, d.created_at DESC`);
    return sendJson(res, 200, {
      devices: rows.map((r) => ({
        // The hash is the handle; the token itself was shown once and is not kept.
        id: r.token_hash, label: r.label,
        userId: Number(r.user_id), userName: r.user_name,
        vehicleId: r.vehicle_id ? Number(r.vehicle_id) : null, vehicleName: r.vehicle_name || null,
        createdAt: r.created_at, lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at,
      })),
    });
  }

  if (route === "/api/devices" && req.method === "POST") {
    const body = await readBody(req);
    const userId = Number(body.userId);
    if (!userId) throw new BadRequest("Say whose phone it is");
    const { rows: person } = await pool.query("SELECT 1 FROM users WHERE id=$1 AND active", [userId]);
    if (!person[0]) throw new BadRequest("No such person");
    const token = await identity.createDeviceToken(pool, {
      userId, label: body.label, vehicleId: body.vehicleId ? Number(body.vehicleId) : null,
    });
    // The one and only time this is readable. Losing it means issuing another.
    return sendJson(res, 201, { token, id: identity.hashToken(token) });
  }

  const deviceMatch = route.match(/^\/api\/devices\/([a-f0-9]{64})$/);
  if (deviceMatch && req.method === "DELETE") {
    const { rowCount } = await pool.query(
      "UPDATE device_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL",
      [deviceMatch[1]]);
    return rowCount ? sendJson(res, 204, {}) : sendJson(res, 404, { error: "No such phone" });
  }

  /** What the server itself is doing: sizes, counts and how long it has been up. */
  if (route === "/api/admin/server" && req.method === "GET") {
    const [db, counts, photo] = await Promise.all([
      pool.query(`SELECT current_setting('server_version') AS version,
                         pg_database_size(current_database()) AS bytes`),
      pool.query(`SELECT
          (SELECT count(*) FROM users)          AS users,
          (SELECT count(*) FROM users WHERE active) AS users_active,
          (SELECT count(*) FROM vehicles)       AS vehicles,
          (SELECT count(*) FROM device_tokens WHERE revoked_at IS NULL) AS devices,
          (SELECT count(*) FROM areas)          AS areas,
          (SELECT count(*) FROM drives)         AS drives,
          (SELECT count(*) FROM driven_edges)   AS edges,
          (SELECT count(*) FROM pois)           AS pois,
          (SELECT count(*) FROM sessions WHERE expires_at > now()) AS sessions`),
      photos.usage(),
    ]);
    const c = counts.rows[0];
    return sendJson(res, 200, {
      server: {
        node: process.version,
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: Date.now() - Math.round(process.uptime() * 1000),
        memoryBytes: process.memoryUsage().rss,
      },
      database: {
        version: String(db.rows[0].version).split(" ")[0],
        bytes: Number(db.rows[0].bytes),
      },
      photos: photo,
      counts: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v)])),
    });
  }

  /**
   * Who has driven what. Drives give the miles and the time; driven_edges give the
   * streets, and those are credited to whoever swept each one first, so the numbers
   * add up across people rather than counting a shared street twice.
   */
  if (route === "/api/admin/leaderboard" && req.method === "GET") {
    const days = Math.max(0, Math.min(3650, Number(url.searchParams.get("days")) || 0));
    const since = days ? Date.now() - days * 86400000 : 0;
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.active,
              COALESCE(d.drives, 0)        AS drives,
              COALESCE(d.meters, 0)        AS meters,
              COALESCE(d.moving_ms, 0)     AS moving_ms,
              COALESCE(d.last_drive, 0)    AS last_drive,
              COALESCE(e.streets, 0)       AS streets,
              COALESCE(e.street_meters, 0) AS street_meters
         FROM users u
         LEFT JOIN (
           SELECT user_id,
                  count(*)                                        AS drives,
                  sum(distance_m)                                 AS meters,
                  sum(GREATEST(COALESCE(ended_at, started_at) - started_at - paused_ms, 0)) AS moving_ms,
                  max(started_at)                                 AS last_drive
             FROM drives WHERE started_at >= $1 GROUP BY user_id
         ) d ON d.user_id = u.id
         LEFT JOIN (
           SELECT user_id, count(*) AS streets, sum(length_m) AS street_meters
             FROM driven_edges WHERE driven_at >= $1 AND user_id IS NOT NULL GROUP BY user_id
         ) e ON e.user_id = u.id
        ORDER BY COALESCE(e.street_meters, 0) DESC, COALESCE(d.meters, 0) DESC`,
      [since]);
    return sendJson(res, 200, {
      days,
      people: rows.map((r) => ({
        id: Number(r.id), name: r.name, email: r.email, role: r.role, active: r.active,
        drives: Number(r.drives), meters: Number(r.meters),
        movingMs: Number(r.moving_ms), lastDriveAt: Number(r.last_drive),
        streets: Number(r.streets), streetMeters: Number(r.street_meters),
      })),
    });
  }

  /**
   * The headline figures: today and this week, and who is ahead in each.
   *
   * The day boundary comes from the browser rather than being guessed here. A server in
   * UTC deciding when "today" started would be several hours out for anyone driving in
   * Texas, and "miles driven today" is exactly the number that has to agree with the
   * person looking at it.
   */
  if (route === "/api/admin/metrics" && req.method === "GET") {
    const now = Date.now();
    const dayStart = Number(url.searchParams.get("dayStart")) || (now - 86400000);
    const weekStart = Number(url.searchParams.get("weekStart")) || (now - 7 * 86400000);

    async function window_(since) {
      const [drives, edges, top] = await Promise.all([
        pool.query(
          `SELECT count(*)::int AS drives,
                  COALESCE(sum(distance_m), 0) AS meters,
                  COALESCE(sum(GREATEST(COALESCE(ended_at, started_at) - started_at - paused_ms, 0)), 0) AS moving_ms,
                  count(DISTINCT user_id)::int AS drivers
             FROM drives WHERE started_at >= $1`, [since]),
        pool.query(
          `SELECT count(*)::int AS streets, COALESCE(sum(length_m), 0) AS meters
             FROM driven_edges WHERE driven_at >= $1`, [since]),
        pool.query(
          `SELECT u.name, COALESCE(sum(d.distance_m), 0) AS meters, count(*)::int AS drives
             FROM drives d JOIN users u ON u.id = d.user_id
            WHERE d.started_at >= $1
            GROUP BY u.id, u.name
            ORDER BY sum(d.distance_m) DESC NULLS LAST
            LIMIT 1`, [since]),
      ]);
      const d = drives.rows[0], e = edges.rows[0], t = top.rows[0];
      return {
        drives: d.drives, meters: Number(d.meters), movingMs: Number(d.moving_ms),
        drivers: d.drivers,
        streets: e.streets, streetMeters: Number(e.meters),
        top: t ? { name: t.name, meters: Number(t.meters), drives: t.drives } : null,
      };
    }

    // How far through the areas everyone is, from the phones' own reports. Each area is
    // counted once, at its furthest-along report, so two phones reporting the same
    // neighbourhood do not double it.
    const coverage = await pool.query(
      `SELECT COALESCE(sum(done), 0)::int AS done, COALESCE(sum(total), 0)::int AS total
         FROM (SELECT name, max(streets_done) AS done, max(streets_total) AS total
                 FROM reported_areas GROUP BY name) a`);

    const [today, week] = await Promise.all([window_(dayStart), window_(weekStart)]);
    const c = coverage.rows[0];
    return sendJson(res, 200, {
      today, week,
      coverage: { done: Number(c.done), total: Number(c.total) },
    });
  }

  /**
   * Everything the dashboard shows, for a window, with the same window immediately
   * before it for comparison. The arrows are real: they are this period against the
   * last one of equal length, not a number anybody typed in.
   */
  if (route === "/api/admin/dashboard" && req.method === "GET") {
    const to = Number(url.searchParams.get("to")) || Date.now();
    const from = Number(url.searchParams.get("from")) || (to - 30 * 86400000);
    const span = Math.max(1, to - from);
    const prevFrom = from - span;

    async function tally(a, b) {
      const { rows } = await pool.query(
        `SELECT
           (SELECT count(DISTINCT user_id)::int FROM drives WHERE started_at >= $1 AND started_at < $2) AS active_users,
           (SELECT count(*)::int FROM driven_edges WHERE driven_at >= $1 AND driven_at < $2) AS streets,
           (SELECT COALESCE(sum(distance_m), 0) FROM drives WHERE started_at >= $1 AND started_at < $2) AS meters,
           (SELECT count(*)::int FROM drives WHERE started_at >= $1 AND started_at < $2) AS drives`,
        [a, b]);
      const r = rows[0];
      return {
        activeUsers: r.active_users, streets: r.streets,
        meters: Number(r.meters), drives: r.drives,
      };
    }

    // One row per area, at its furthest-along report, so two phones reporting the same
    // neighbourhood are not counted twice.
    const best = `SELECT name, max(streets_done) AS done, max(streets_total) AS total
                    FROM reported_areas GROUP BY name`;

    const [now_, prev, coverage, areasList, top, drivesFeed, doneFeed] = await Promise.all([
      tally(from, to),
      tally(prevFrom, from),
      pool.query(`SELECT COALESCE(sum(done),0)::int AS done, COALESCE(sum(total),0)::int AS total,
                         count(*)::int AS areas,
                         count(*) FILTER (WHERE total > 0 AND done >= total)::int AS finished
                    FROM (${best}) a`),
      pool.query(`SELECT name, done, total FROM (${best}) a
                   WHERE total > 0 AND done < total
                   ORDER BY (done::float / total) DESC LIMIT 6`),
      pool.query(
        `SELECT u.id, u.name, u.avatar_key IS NOT NULL AS has_avatar, u.updated_at,
                COALESCE(e.streets,0)::int AS streets, COALESCE(e.meters,0) AS street_meters,
                COALESCE(d.meters,0) AS meters
           FROM users u
           LEFT JOIN (SELECT user_id, count(*) AS streets, sum(length_m) AS meters
                        FROM driven_edges WHERE driven_at >= $1 AND driven_at < $2
                       GROUP BY user_id) e ON e.user_id = u.id
           LEFT JOIN (SELECT user_id, sum(distance_m) AS meters
                        FROM drives WHERE started_at >= $1 AND started_at < $2
                       GROUP BY user_id) d ON d.user_id = u.id
          WHERE COALESCE(e.streets,0) > 0 OR COALESCE(d.meters,0) > 0
          ORDER BY COALESCE(e.streets,0) DESC, COALESCE(d.meters,0) DESC
          LIMIT 5`, [from, to]),
      pool.query(
        `SELECT d.started_at, d.distance_m, d.new_segments, u.id AS user_id, u.name,
                u.avatar_key IS NOT NULL AS has_avatar, u.updated_at
           FROM drives d JOIN users u ON u.id = d.user_id
          ORDER BY d.started_at DESC LIMIT 8`),
      pool.query(
        `SELECT r.name, r.streets_done, r.streets_total, r.reported_at,
                u.id AS user_id, u.name AS user_name,
                u.avatar_key IS NOT NULL AS has_avatar, u.updated_at
           FROM reported_areas r JOIN users u ON u.id = r.user_id
          WHERE r.streets_total > 0 AND r.streets_done >= r.streets_total
          ORDER BY r.reported_at DESC LIMIT 5`),
    ]);

    const c = coverage.rows[0];
    function person(r) {
      return {
        id: Number(r.user_id != null ? r.user_id : r.id), name: r.name || r.user_name,
        hasAvatar: r.has_avatar,
        avatarVersion: r.updated_at ? new Date(r.updated_at).getTime() : 0,
      };
    }

    return sendJson(res, 200, {
      from, to,
      now: now_, previous: prev,
      coverage: {
        done: Number(c.done), total: Number(c.total),
        areas: c.areas, finished: c.finished,
      },
      topDrivers: top.rows.map((r) => Object.assign(person(r), {
        streets: r.streets, streetMeters: Number(r.street_meters), meters: Number(r.meters),
      })),
      areasNear: areasList.rows.map((r) => ({
        name: r.name, done: Number(r.done), total: Number(r.total),
      })),
      activity: [
        ...doneFeed.rows.map((r) => ({
          kind: "finished", at: new Date(r.reported_at).getTime(),
          who: person(r), area: r.name,
          detail: Number(r.streets_done).toLocaleString() + " streets",
        })),
        ...drivesFeed.rows.map((r) => ({
          kind: "drove", at: Number(r.started_at), who: person(r),
          meters: Number(r.distance_m), newStreets: r.new_segments,
        })),
      ].sort((x, y) => y.at - x.at).slice(0, 8),
    });
  }

  /**
   * How far through each area everyone is, by name. No polygons: the page already holds
   * those, and a county's outline is thousands of points nobody needs sent twice.
   */
  if (route === "/api/admin/area-progress" && req.method === "GET") {
    const { rows } = await pool.query(
      `SELECT name, max(streets_done)::int AS done, max(streets_total)::int AS total,
              max(reported_at) AS reported_at
         FROM reported_areas GROUP BY name`);
    return sendJson(res, 200, {
      areas: rows.map((r) => ({
        name: r.name, done: r.done, total: r.total,
        reportedAt: r.reported_at ? new Date(r.reported_at).getTime() : 0,
      })),
    });
  }

  /** Everything the user page shows about one person. */
  const summaryMatch = route.match(/^\/api\/admin\/users\/(\d+)\/summary$/);
  if (summaryMatch && req.method === "GET") {
    const id = Number(summaryMatch[1]);
    const { rows: who_ } = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
    if (!who_[0]) return sendJson(res, 404, { error: "No such person" });

    const [totals, areasRows, drivesRows, rankRow] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM drives WHERE user_id=$1) AS drives,
           (SELECT COALESCE(sum(distance_m),0) FROM drives WHERE user_id=$1) AS meters,
           (SELECT COALESCE(sum(GREATEST(COALESCE(ended_at,started_at)-started_at-paused_ms,0)),0)
              FROM drives WHERE user_id=$1) AS moving_ms,
           (SELECT max(started_at) FROM drives WHERE user_id=$1) AS last_drive,
           (SELECT count(*)::int FROM driven_edges WHERE user_id=$1) AS streets,
           (SELECT COALESCE(sum(length_m),0) FROM driven_edges WHERE user_id=$1) AS street_meters,
           (SELECT count(*)::int FROM reported_areas WHERE user_id=$1) AS areas`, [id]),
      pool.query(
        `SELECT name, streets_done::int AS done, streets_total::int AS total
           FROM reported_areas WHERE user_id=$1 AND streets_total > 0
          ORDER BY (streets_done::float / streets_total) DESC`, [id]),
      pool.query(
        `SELECT d.started_at, d.ended_at, d.distance_m, d.new_segments, d.new_meters,
                d.paused_ms, v.name AS vehicle
           FROM drives d LEFT JOIN vehicles v ON v.id = d.vehicle_id
          WHERE d.user_id=$1 ORDER BY d.started_at DESC LIMIT 10`, [id]),
      // Rank by streets swept, the same order the leaderboard uses.
      pool.query(
        `SELECT position FROM (
            SELECT user_id, row_number() OVER (ORDER BY count(*) DESC) AS position
              FROM driven_edges WHERE user_id IS NOT NULL GROUP BY user_id) r
          WHERE user_id=$1`, [id]),
    ]);

    const t = totals.rows[0];
    return sendJson(res, 200, {
      user: identity.publicUser(who_[0]),
      joinedAt: new Date(who_[0].created_at).getTime(),
      totals: {
        drives: t.drives, meters: Number(t.meters), movingMs: Number(t.moving_ms),
        lastDriveAt: Number(t.last_drive) || 0,
        streets: t.streets, streetMeters: Number(t.street_meters), areas: t.areas,
      },
      rank: rankRow.rows[0] ? Number(rankRow.rows[0].position) : null,
      areas: areasRows.rows.map((r) => ({ name: r.name, done: r.done, total: r.total })),
      drives: drivesRows.rows.map((r) => ({
        startedAt: Number(r.started_at), endedAt: Number(r.ended_at) || null,
        meters: Number(r.distance_m), newStreets: r.new_segments,
        newMeters: Number(r.new_meters), pausedMs: Number(r.paused_ms),
        vehicle: r.vehicle || null,
      })),
    });
  }

  /**
   * Week-by-week activity, for the charts on Analytics. Bucketed in SQL from the epoch
   * milliseconds the phone sends, so the weeks line up with everything else here.
   */
  if (route === "/api/admin/trends" && req.method === "GET") {
    const weeks = Math.max(4, Math.min(52, Number(url.searchParams.get("weeks")) || 12));
    const since = Date.now() - weeks * 7 * 86400000;

    const [edgeRows, driveRows, byArea, byDriver] = await Promise.all([
      pool.query(
        `SELECT (driven_at / 604800000)::bigint AS wk, count(*)::int AS streets,
                COALESCE(sum(length_m),0) AS meters
           FROM driven_edges WHERE driven_at >= $1 GROUP BY wk ORDER BY wk`, [since]),
      pool.query(
        `SELECT (started_at / 604800000)::bigint AS wk, count(*)::int AS drives,
                COALESCE(sum(distance_m),0) AS meters
           FROM drives WHERE started_at >= $1 GROUP BY wk ORDER BY wk`, [since]),
      pool.query(
        `SELECT name, max(streets_done)::int AS done, max(streets_total)::int AS total
           FROM reported_areas GROUP BY name
          ORDER BY max(streets_done) DESC LIMIT 10`),
      pool.query(
        `SELECT u.name, count(e.*)::int AS streets, COALESCE(sum(e.length_m),0) AS meters
           FROM driven_edges e JOIN users u ON u.id = e.user_id
          WHERE e.driven_at >= $1
          GROUP BY u.id, u.name ORDER BY count(e.*) DESC LIMIT 8`, [since]),
    ]);

    // Fill the gaps: a week with nothing in it is a real answer and the chart needs it.
    const thisWeek = Math.floor(Date.now() / 604800000);
    const edges = new Map(edgeRows.rows.map((r) => [String(r.wk), r]));
    const drivesBy = new Map(driveRows.rows.map((r) => [String(r.wk), r]));
    const series = [];
    for (let w = thisWeek - weeks + 1; w <= thisWeek; w++) {
      const e = edges.get(String(w)), d = drivesBy.get(String(w));
      series.push({
        weekStart: w * 604800000,
        streets: e ? e.streets : 0,
        streetMeters: e ? Number(e.meters) : 0,
        drives: d ? d.drives : 0,
        meters: d ? Number(d.meters) : 0,
      });
    }

    return sendJson(res, 200, {
      weeks, series,
      byArea: byArea.rows.map((r) => ({ name: r.name, done: r.done, total: r.total })),
      byDriver: byDriver.rows.map((r) => ({
        name: r.name, streets: r.streets, meters: Number(r.meters),
      })),
    });
  }

  /** The same, by vehicle rather than by person. */
  if (route === "/api/admin/vehicle-stats" && req.method === "GET") {
    const { rows } = await pool.query(
      `SELECT v.id, v.name, v.plate, v.active,
              count(d.*) AS drives, COALESCE(sum(d.distance_m), 0) AS meters,
              COALESCE(max(d.started_at), 0) AS last_drive
         FROM vehicles v LEFT JOIN drives d ON d.vehicle_id = v.id
        GROUP BY v.id ORDER BY COALESCE(sum(d.distance_m), 0) DESC, lower(v.name)`);
    return sendJson(res, 200, {
      vehicles: rows.map((r) => ({
        id: Number(r.id), name: r.name, plate: r.plate, active: r.active,
        drives: Number(r.drives), meters: Number(r.meters), lastDriveAt: Number(r.last_drive),
      })),
    });
  }

  if (route === "/api/health") {
    await pool.query("SELECT 1");
    return sendJson(res, 200, { ok: true });
  }

  if (route === "/api/areas" && req.method === "GET") {
    return sendJson(res, 200, { areas: await listAreas() });
  }

  if (route === "/api/areas" && req.method === "POST") {
    const area = await createArea(cleanArea(await readBody(req)));
    return sendJson(res, 201, { area });
  }

  if (route === "/api/areas.geojson" && req.method === "GET") {
    const body = JSON.stringify(toGeoJson(await listAreas()), null, 2);
    res.writeHead(200, {
      "Content-Type": "application/geo+json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="streetsweep-areas.geojson"',
      "Cache-Control": "no-store",
    });
    return res.end(body);
  }

  if (route === "/api/areas/import" && req.method === "POST") {
    const created = await importGeoJson(await readBody(req));
    return sendJson(res, 200, { areas: created });
  }

  if (route === "/api/sync" && req.method === "POST") {
    // Everything a phone pushes is stamped with whose phone it is, and which vehicle
    // that phone was issued for, so a drive can be told from anyone else's later.
    const result = await applySync(await readBody(req), {
      userId: who.user.id,
      vehicleId: who.vehicleId || null,
    });
    // The only moment the figures can have moved. Failing here must not fail the sync:
    // a badge is not worth losing a drive over.
    result.awarded = await achievements.evaluate(pool, who.user.id).catch((err) => {
      console.error("could not work out achievements", err.message);
      return 0;
    });
    return sendJson(res, 200, result);
  }

  /**
   * The driven streets inside one area, for colouring it on the map. Found by bounding
   * box against the index the table already has, then kept only where the segment's
   * middle falls inside the outline — the same test the phone uses to decide which area
   * a street belongs to, so the two agree about what "in Walden" means.
   */
  const areaStreets = route.match(/^\/api\/areas\/(\d+)\/streets$/);
  if (areaStreets && req.method === "GET") {
    const { rows: arows } = await pool.query(
      "SELECT polygon, min_lat, min_lng, max_lat, max_lng FROM areas WHERE id=$1",
      [Number(areaStreets[1])]);
    const area = arows[0];
    if (!area) return sendJson(res, 404, { error: "No such area" });

    const { rows } = await pool.query(
      `SELECT e.key, e.way_id, e.name, e.road_class, e.length_m, e.driven_at, e.shape,
              e.min_lat, e.min_lng, e.max_lat, e.max_lng, u.name AS driver
         FROM driven_edges e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.max_lat >= $1 AND e.min_lat <= $2 AND e.max_lng >= $3 AND e.min_lng <= $4`,
      [area.min_lat, area.max_lat, area.min_lng, area.max_lng]);

    // Same rule as the network and the phone: the centre of the segment's box, which the
    // table already stores, so there is nothing to compute.
    const inside = rows.filter((r) => {
      if (!(r.shape || []).length) return false;
      return contains(area, [(r.min_lat + r.max_lat) / 2, (r.min_lng + r.max_lng) / 2]);
    });
    return sendJson(res, 200, {
      bounds: [area.min_lat, area.min_lng, area.max_lat, area.max_lng],
      edges: inside.map((r) => ({
        key: r.key, wayId: r.way_id != null ? Number(r.way_id) : null,
        name: r.name, roadClass: r.road_class, lengthMeters: Number(r.length_m),
        drivenAt: Number(r.driven_at), driver: r.driver || null, shape: r.shape,
      })),
    });
  }

  /**
   * The streets in one map cell, in Overpass's own JSON, for a phone to store exactly as
   * if it had asked OpenStreetMap itself — which, with a server to ask, it no longer does.
   */
  const cellMatch = route.match(/^\/api\/streets\/cell\/(-?\d{1,4}_-?\d{1,4})$/);
  if (cellMatch && req.method === "GET") {
    try {
      const c = await streets.cell(pool, cellMatch[1]);
      return sendJson(res, 200, {
        key: c.key, fetchedAt: c.fetchedAt, cached: c.cached, stale: Boolean(c.stale),
        elements: c.elements,
      });
    } catch (err) {
      return sendJson(res, err.status || 502,
        { error: err.message || "OpenStreetMap could not be reached" });
    }
  }

  /**
   * Every street to sweep in an area, fetched from OpenStreetMap once and kept. The first
   * person to click an area waits for Overpass; everyone after that does not.
   */
  const areaNetwork = route.match(/^\/api\/areas\/(\d+)\/network$/);
  if (areaNetwork && req.method === "GET") {
    const { rows } = await pool.query(
      "SELECT id, polygon, min_lat, min_lng, max_lat, max_lng FROM areas WHERE id=$1",
      [Number(areaNetwork[1])]);
    if (!rows[0]) return sendJson(res, 404, { error: "No such area" });
    try {
      const got = await networks.forArea(pool, rows[0]);
      const wayIds = got.lines.map((l) => l.id);
      const marked = await completions.markedAmong(pool, wayIds);
      const excluded = await completions.excludedAmong(pool, wayIds);
      return sendJson(res, 200, {
        streets: got.lines.length, lines: got.lines.map((l) => l.shape),
        // Parallel to lines, so the page can say which street was clicked and match
        // driven segments to it.
        ids: got.lines.map((l) => l.id), names: got.lines.map((l) => l.name),
        completed: marked, excluded,
        fetchedAt: got.fetchedAt, cached: got.cached, stale: Boolean(got.stale),
      });
    } catch (err) {
      return sendJson(res, 502, { error: err.message || "OpenStreetMap could not be reached" });
    }
  }

  /**
   * Streets marked complete by hand. A phone reads the whole list, unmarks included, to
   * bring itself up to date; the web map marks and unmarks here.
   */
  if (route === "/api/street-completions" && req.method === "GET") {
    return sendJson(res, 200, { completions: await completions.list(pool) });
  }
  if (route === "/api/street-completions" && req.method === "POST") {
    const body = await readBody(req);
    const ids = (Array.isArray(body.wayIds) ? body.wayIds : [body.wayId]).map(Number)
      .filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 5000);
    if (!ids.length) return sendJson(res, 400, { error: "Which street?" });
    const at = Date.now();
    const taken = await completions.apply(pool,
      ids.map((wayId) => ({ wayId, marked: body.marked !== false, updatedAt: at })), who.user.id);
    return sendJson(res, 200, { marked: body.marked !== false, streets: taken });
  }

  /** Excluded streets, the same way: the phone reads all of them, the web map edits here. */
  if (route === "/api/street-exclusions" && req.method === "GET") {
    return sendJson(res, 200, { exclusions: await completions.listExclusions(pool) });
  }
  if (route === "/api/street-exclusions" && req.method === "POST") {
    const body = await readBody(req);
    const ids = (Array.isArray(body.wayIds) ? body.wayIds : [body.wayId]).map(Number)
      .filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 5000);
    if (!ids.length) return sendJson(res, 400, { error: "Which street?" });
    const excluded = body.excluded !== false;
    const at = Date.now();
    const taken = await completions.applyExclusions(pool, ids.map((wayId) => ({
      wayId, excluded, reason: body.reason, note: body.note, updatedAt: at,
    })), who.user.id);
    return sendJson(res, 200, { excluded, streets: taken });
  }

  if (route === "/api/coverage" && req.method === "GET") {
    return sendJson(res, 200, await coverage(Number(url.searchParams.get("edgeLimit")) || EDGE_LIMIT));
  }

  const poiMatch = route.match(/^\/api\/pois\/([^/]+)(\/photo)?$/);
  if (poiMatch) {
    const id = decodeURIComponent(poiMatch[1]);
    const isPhoto = Boolean(poiMatch[2]);

    if (!isPhoto && req.method === "PATCH") {
      const body = await readBody(req);
      const name = body.name != null ? String(body.name).trim().slice(0, 200) : null;
      const note = body.note != null ? String(body.note).trim().slice(0, 4000) : null;
      const { rows } = await pool.query(
        `UPDATE pois SET name=$1, note=$2, updated_at=$3
         WHERE id=$4 RETURNING id, lat, lng, note, name, photo_key, at, updated_at`,
        [name || null, note || null, Date.now(), id],
      );
      if (!rows.length) return sendJson(res, 404, { error: "No marked place with that id" });
      return sendJson(res, 200, { poi: rowToPoi(rows[0]) });
    }

    if (isPhoto && (req.method === "POST" || req.method === "PUT")) {
      if (!photos.on()) return sendJson(res, 503, { error: "Photo storage is not working on this server" });
      const type = String(req.headers["content-type"] || "").split(";")[0].trim();
      if (!PHOTO_TYPES.has(type)) {
        return sendJson(res, 400, { error: "Send a JPEG, PNG or WebP" });
      }
      const { rows } = await pool.query("SELECT id FROM pois WHERE id=$1", [id]);
      if (!rows.length) return sendJson(res, 404, { error: "No marked place with that id" });

      const bytes = await readBytes(req, PHOTO_MAX_BYTES);
      if (!bytes.length) return sendJson(res, 400, { error: "That upload was empty" });
      const key = "pois/" + crypto.createHash("sha1").update(id).digest("hex") + extensionFor(type);
      await photos.put(key, bytes);
      await pool.query("UPDATE pois SET photo_key=$1, updated_at=$2 WHERE id=$3", [key, Date.now(), id]);
      return sendJson(res, 200, { ok: true, bytes: bytes.length });
    }

    if (isPhoto && req.method === "GET") {
      if (!photos.on()) return sendJson(res, 503, { error: "Photo storage is not working on this server" });
      const { rows } = await pool.query("SELECT photo_key FROM pois WHERE id=$1", [id]);
      if (!rows.length || !rows[0].photo_key) return sendJson(res, 404, { error: "No photo for that place" });
      const key = rows[0].photo_key;
      const stat = await photos.stat(key);
      if (!stat) return sendJson(res, 404, { error: "That photo is no longer in storage" });
      const stream = photos.readStream(key);
      res.writeHead(200, {
        "Content-Type": stat.type,
        "Content-Length": stat.size,
        "Cache-Control": "private, max-age=86400",
      });
      stream.on("error", () => res.destroy());
      return stream.pipe(res);
    }

    if (isPhoto && req.method === "DELETE") {
      const { rows } = await pool.query("SELECT photo_key FROM pois WHERE id=$1", [id]);
      if (rows.length && rows[0].photo_key) {
        await photos.remove(rows[0].photo_key).catch(() => {});
      }
      await pool.query("UPDATE pois SET photo_key=NULL, updated_at=$1 WHERE id=$2", [Date.now(), id]);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (route === "/api/pois" && req.method === "GET") {
    const { rows } = await pool.query(
      "SELECT id, lat, lng, note, name, photo_key, at, updated_at FROM pois ORDER BY at DESC");
    return sendJson(res, 200, { pois: rows.map(rowToPoi) });
  }

  if (route === "/api/drives" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit")) || 50;
    const full = url.searchParams.get("shape") === "full";
    return sendJson(res, 200, { drives: await drives(limit, full) });
  }

  const match = route.match(/^\/api\/areas\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (req.method === "PUT") {
      const area = await updateArea(id, cleanArea(await readBody(req)));
      return area ? sendJson(res, 200, { area }) : sendJson(res, 404, { error: "No such area" });
    }
    if (req.method === "DELETE") {
      const gone = await deleteArea(id);
      return gone ? sendJson(res, 204, {}) : sendJson(res, 404, { error: "No such area" });
    }
  }

  sendJson(res, 404, { error: "No such endpoint" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof BadRequest) return sendJson(res, 400, { error: err.message });
    console.error("request failed", err);
    sendJson(res, 500, { error: "Something went wrong on the server" });
  });
});

waitForDatabase()
  .then(ensureSchema)
  .then(() => identity.ensureSchema(pool))
  .then(() => identity.ensureFirstAdmin(pool, (line) => console.log(line)))
  .then(ensureAttribution)
  .then(() => achievements.ensureSchema(pool))
  .then(() => networks.ensureSchema(pool))
  .then(() => streets.ensureSchema(pool))
  .then(() => completions.ensureSchema(pool))
  .then(readyPhotos)
  .then(() => {
    // Expired rows are dead weight; clear them at boot and once a day after.
    identity.sweepSessions(pool).catch(() => {});
    setInterval(() => identity.sweepSessions(pool).catch(() => {}), 24 * 60 * 60 * 1000).unref();
    server.listen(PORT, () => console.log(`area builder listening on ${PORT}`));
  })
  .catch((err) => { console.error("could not start", err); process.exit(1); });
