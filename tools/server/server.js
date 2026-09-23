"use strict";

// Serves the area builder page and a small JSON API over Postgres.
// No framework: the surface is half a dozen routes and validation matters more than routing.

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 80);
// Set SYNC_TOKEN to require a shared secret on every /api call. Leave it empty only on a
// network you trust completely: the coverage data is a map of where you live and work.
const SYNC_TOKEN = (process.env.SYNC_TOKEN || "").trim();
const PUBLIC = path.join(__dirname, "public");
const PAGE = path.join(PUBLIC, "index.html");
// Everything the browser may fetch by name. An allow list rather than a path join,
// so a crafted route can never walk out of the folder.
const ASSET_TYPES = {
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};
const ASSETS = new Set(
  fs.existsSync(PUBLIC)
    ? fs.readdirSync(PUBLIC).filter((f) => f !== "index.html" && ASSET_TYPES[path.extname(f)])
    : []
);
const LEVELS = new Set(["NEIGHBORHOOD", "CITY", "METRO"]);

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

    CREATE TABLE IF NOT EXISTS pois (
      id   TEXT PRIMARY KEY,
      lat  DOUBLE PRECISION NOT NULL,
      lng  DOUBLE PRECISION NOT NULL,
      note TEXT,
      at   BIGINT NOT NULL
    );
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
  if (polygon.length > 5000) throw new BadRequest("That outline has too many corners");

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

  return {
    name,
    level,
    parentName: parent || null,
    polygon: points,
    minLat: Math.min(...lats),
    minLng: Math.min(...lngs),
    maxLat: Math.max(...lats),
    maxLng: Math.max(...lngs),
  };
}

function rowToArea(row) {
  return {
    id: Number(row.id),
    name: row.name,
    level: row.level,
    parentName: row.parent_name,
    polygon: row.polygon,
    updatedAt: row.updated_at,
  };
}

// ----------------------------------------------------------------- store

const COLUMNS = "id, name, level, parent_name, polygon, updated_at";

// level is text, so an alphabetical sort would put NEIGHBORHOOD above CITY. Rank it instead,
// largest place first, the way the phone lists them.
const LEVEL_RANK = "CASE level WHEN 'METRO' THEN 0 WHEN 'CITY' THEN 1 ELSE 2 END";

async function listAreas() {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM areas ORDER BY ${LEVEL_RANK}, name`);
  return rows.map(rowToArea);
}

async function createArea(area) {
  const { rows } = await pool.query(
    `INSERT INTO areas (name, level, parent_name, polygon, min_lat, min_lng, max_lat, max_lng)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLUMNS}`,
    [area.name, area.level, area.parentName, JSON.stringify(area.polygon),
     area.minLat, area.minLng, area.maxLat, area.maxLng],
  );
  return rowToArea(rows[0]);
}

async function updateArea(id, area) {
  const { rows } = await pool.query(
    `UPDATE areas SET name=$1, level=$2, parent_name=$3, polygon=$4,
                      min_lat=$5, min_lng=$6, max_lat=$7, max_lng=$8, updated_at=now()
     WHERE id=$9 RETURNING ${COLUMNS}`,
    [area.name, area.level, area.parentName, JSON.stringify(area.polygon),
     area.minLat, area.minLng, area.maxLat, area.maxLng, id],
  );
  return rows.length ? rowToArea(rows[0]) : null;
}

async function deleteArea(id) {
  const { rowCount } = await pool.query("DELETE FROM areas WHERE id=$1", [id]);
  return rowCount > 0;
}

/** The same shape tools/area-builder.html exports and the Android app imports. */
function toGeoJson(areas) {
  return {
    type: "FeatureCollection",
    features: areas.map((a) => {
      const ring = a.polygon.map(([lat, lng]) => [round(lng), round(lat)]);
      ring.push(ring[0]);
      const properties = { kind: "area", name: a.name, level: a.level };
      if (a.parentName) properties.parent = a.parentName;
      return { type: "Feature", properties, geometry: { type: "Polygon", coordinates: [ring] } };
    }),
  };
}

function round(v) { return Math.round(v * 1e6) / 1e6; }

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
  if (typeof level === "number") return ["NEIGHBORHOOD", "CITY", "METRO"][level] || "NEIGHBORHOOD";
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
async function applySync(body) {
  const result = { areas: 0, edges: 0, drives: 0, pois: 0, skipped: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (Array.isArray(body.areas)) {
      await client.query("DELETE FROM reported_areas");
      for (const a of body.areas) {
        const points = shapePoints(a.polygon);
        const name = String(a.name || "").trim();
        if (!points || points.length < 3 || !name) { result.skipped++; continue; }
        const st = a.stats || {};
        await client.query(
          `INSERT INTO reported_areas
             (name, level, parent_name, polygon, streets_total, streets_done, streets_partial,
              streets_excluded, meters_total, meters_driven, reported_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
           ON CONFLICT (name) DO UPDATE SET
             level=EXCLUDED.level, parent_name=EXCLUDED.parent_name, polygon=EXCLUDED.polygon,
             streets_total=EXCLUDED.streets_total, streets_done=EXCLUDED.streets_done,
             streets_partial=EXCLUDED.streets_partial, streets_excluded=EXCLUDED.streets_excluded,
             meters_total=EXCLUDED.meters_total, meters_driven=EXCLUDED.meters_driven,
             reported_at=now()`,
          [name, normaliseLevel(a.level), a.parent || null, JSON.stringify(points),
           num(st.total, 0), num(st.done, 0), num(st.partial, 0), num(st.excluded, 0),
           num(st.metersTotal, 0), num(st.metersDriven, 0)],
        );
        result.areas++;
      }
    }

    if (body.resetEdges) await client.query("DELETE FROM driven_edges");

    if (Array.isArray(body.edges)) {
      for (const e of body.edges) {
        const points = shapePoints(e.shape);
        const key = String(e.key || "").trim();
        if (!points || points.length < 2 || !key) { result.skipped++; continue; }
        const box = bbox(points);
        await client.query(
          `INSERT INTO driven_edges
             (key, way_id, name, road_class, length_m, driven_at, shape, min_lat, min_lng, max_lat, max_lng)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (key) DO UPDATE SET
             name=EXCLUDED.name, road_class=EXCLUDED.road_class, length_m=EXCLUDED.length_m,
             driven_at=LEAST(driven_edges.driven_at, EXCLUDED.driven_at), shape=EXCLUDED.shape`,
          [key, num(e.wayId, null), e.name || null, e.roadClass || null, num(e.lengthMeters, 0),
           num(e.drivenAt, 0), JSON.stringify(points), box[0], box[1], box[2], box[3]],
        );
        result.edges++;
      }
    }

    if (Array.isArray(body.drives)) {
      await client.query("DELETE FROM drives");
      for (const d of body.drives) {
        const startedAt = num(d.startedAt, 0);
        if (!startedAt) { result.skipped++; continue; }
        await client.query(
          `INSERT INTO drives (started_at, ended_at, trigger, point_count, distance_m, new_segments, new_meters)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (started_at) DO UPDATE SET
             ended_at=EXCLUDED.ended_at, trigger=EXCLUDED.trigger, point_count=EXCLUDED.point_count,
             distance_m=EXCLUDED.distance_m, new_segments=EXCLUDED.new_segments, new_meters=EXCLUDED.new_meters`,
          [startedAt, num(d.endedAt, null), d.trigger || null, num(d.pointCount, 0),
           num(d.distanceMeters, 0), num(d.newSegments, 0), num(d.newMeters, 0)],
        );
        result.drives++;
      }
    }

    if (Array.isArray(body.pois)) {
      await client.query("DELETE FROM pois");
      for (const p of body.pois) {
        const lat = Number(p.lat);
        const lng = Number(p.lng);
        const at = num(p.at, 0);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !at) { result.skipped++; continue; }
        await client.query(
          `INSERT INTO pois (id, lat, lng, note, at) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (id) DO UPDATE SET lat=EXCLUDED.lat, lng=EXCLUDED.lng, note=EXCLUDED.note`,
          [at + ":" + lat.toFixed(6) + ":" + lng.toFixed(6), lat, lng, p.note || null, at],
        );
        result.pois++;
      }
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
async function coverage(edgeLimit) {
  const cap = Math.max(1, Math.min(edgeLimit, EDGE_LIMIT));
  const [areas, edges, drives, pois, totals] = await Promise.all([
    pool.query(`SELECT name, level, parent_name, polygon, streets_total, streets_done,
                       streets_partial, streets_excluded, meters_total, meters_driven, reported_at
                FROM reported_areas ORDER BY ${LEVEL_RANK}, name`),
    pool.query("SELECT key, name, road_class, length_m, driven_at, shape FROM driven_edges ORDER BY driven_at DESC LIMIT $1", [cap]),
    pool.query("SELECT started_at, ended_at, trigger, point_count, distance_m, new_segments, new_meters FROM drives ORDER BY started_at DESC"),
    pool.query("SELECT lat, lng, note, at FROM pois ORDER BY at DESC"),
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
    })),
    pois: pois.rows.map((r) => ({ lat: Number(r.lat), lng: Number(r.lng), note: r.note, at: Number(r.at) })),
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

/** Constant-time compare so a wrong token cannot be guessed a character at a time. */
function tokenMatches(given) {
  const a = Buffer.from(given || "", "utf8");
  const b = Buffer.from(SYNC_TOKEN, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function authorised(req) {
  if (!SYNC_TOKEN) return true;
  const header = String(req.headers.authorization || "");
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return tokenMatches(bearer || String(req.headers["x-streetsweep-token"] || "").trim());
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const route = url.pathname;

  // The page itself stays open so a browser can load it and ask for the token; everything
  // that reads or writes data does not.
  if (route.startsWith("/api/") && route !== "/api/config" && !authorised(req)) {
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
    return res.end(JSON.stringify({ error: "A token is required", needsToken: true }));
  }

  if (route.length > 1 && ASSETS.has(route.slice(1))) {
    const file = route.slice(1);
    res.writeHead(200, {
      "Content-Type": ASSET_TYPES[path.extname(file)],
      "Cache-Control": "public, max-age=86400",
    });
    return res.end(fs.readFileSync(path.join(PUBLIC, file)));
  }

  if (route === "/" || route === "/index.html") {
    const html = fs.readFileSync(PAGE);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(html);
  }

  if (route === "/api/config") {
    return sendJson(res, 200, { needsToken: Boolean(SYNC_TOKEN) });
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
    return sendJson(res, 200, await applySync(await readBody(req)));
  }

  if (route === "/api/coverage" && req.method === "GET") {
    return sendJson(res, 200, await coverage(Number(url.searchParams.get("edgeLimit")) || EDGE_LIMIT));
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
  .then(() => server.listen(PORT, () => console.log(`area builder listening on ${PORT}`)))
  .catch((err) => { console.error("could not start", err); process.exit(1); });
