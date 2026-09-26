"use strict";

/**
 * An area's totals worked out on the server from every street in it — for the areas too
 * big for the web page to load whole. A county is tens of thousands of streets and
 * hundreds of map cells; the page loads it a screenful at a time, so it can never add
 * the whole thing up itself. This does, in the background.
 *
 * The rules are the page's and the phone's: a street is in the area when the centre of
 * its bounding box is inside the outline; its driven length counts each stretch once
 * (overlapping segments from different drives merged); it is done at 80%, partly driven
 * above 2%; marked complete means all of it; excluded (gated and the rest) leaves every
 * total.
 *
 * One area is worked on at a time. Cells the server has already stored are read from the
 * database; the rest come from OpenStreetMap through streets.js's single queue, so a first
 * county is slow — minutes, the first time — and every run after that takes seconds.
 */

const streets = require("./streets");
const networks = require("./networks");
// Loaded when first needed: achievements reads the counts this module writes.
let achievements = null;
// People whose counts changed in this run, whose achievements are looked at once it ends.
const recounted = new Set();

const DONE_FRACTION = 0.8;
const PARTIAL_FRACTION = 0.02;
const ON_STREET_METERS = 30;
const TIE_METERS = 2;
// How long after the last change (a sync batch, a marked street) the totals are redone.
// Recounts are a database read now, so there is little reason to wait long.
const CHANGE_SETTLE_MS = Number(process.env.PROGRESS_SETTLE_MS) || 4000;

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS area_progress (
      area_id         BIGINT PRIMARY KEY REFERENCES areas(id) ON DELETE CASCADE,
      status          TEXT NOT NULL DEFAULT 'queued',   -- queued | working | done | failed
      dirty           BOOLEAN NOT NULL DEFAULT false,   -- something changed since it was worked out
      cells_total     INT NOT NULL DEFAULT 0,
      cells_done      INT NOT NULL DEFAULT 0,
      total           INT, done INT, partial INT, excluded INT, marked INT,
      meters_total    DOUBLE PRECISION, meters_driven DOUBLE PRECISION,
      computed_at     TIMESTAMPTZ,
      area_updated_at TIMESTAMPTZ,
      error           TEXT
    );
    -- When the area first reached 100%, and who had driven most of it by then.
    ALTER TABLE area_progress ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
    ALTER TABLE area_progress ADD COLUMN IF NOT EXISTS top_user_id BIGINT;
    -- Each person's own share of each area: what they drove themselves, overlap once.
    -- Marks by hand are left out on purpose — they are shared, not anyone's driving.
    -- Which streets are in which area (see rebuildMembership), and when that needs redoing.
    CREATE TABLE IF NOT EXISTS area_street (
      area_id  BIGINT NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
      way_id   BIGINT NOT NULL,
      length_m DOUBLE PRECISION NOT NULL,
      cell     TEXT NOT NULL,
      PRIMARY KEY (area_id, way_id)
    );
    CREATE INDEX IF NOT EXISTS area_street_way ON area_street (way_id);
    ALTER TABLE area_progress ADD COLUMN IF NOT EXISTS needs_full BOOLEAN NOT NULL DEFAULT true;
    CREATE TABLE IF NOT EXISTS area_user_progress (
      area_id       BIGINT NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
      user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      done          INT NOT NULL,
      partial       INT NOT NULL,
      meters_driven DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (area_id, user_id)
    );
  `);
  // Anything left half done by a restart is simply started again.
  await pool.query(`UPDATE area_progress SET status = 'queued' WHERE status = 'working'`);
}

// ---- geometry, as the page and the phone do it -----------------------------------------

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
function dist(a, b) {
  const dl = rad(b[0] - a[0]), dg = rad(b[1] - a[1]);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function lineLength(line) {
  let m = 0;
  for (let i = 1; i < line.length; i++) m += dist(line[i - 1], line[i]);
  return m;
}

/** Where p falls along line (meters from its start) and how far off it it is. */
function alongLine(line, p, near) {
  const k = Math.cos(rad(p[0]));
  const cands = [];
  let run = 0, bestOff = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const seg = dist(a, b);
    const ax = a[1] * k, ay = a[0], dx = b[1] * k - ax, dy = b[0] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((p[1] * k - ax) * dx + (p[0] - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const off = dist([ay + dy * t, (ax + dx * t) / k], p);
    cands.push({ off, at: run + seg * t });
    if (off < bestOff) bestOff = off;
    run += seg;
  }
  let pick = null;
  for (const c of cands) {
    if (c.off > bestOff + TIE_METERS) continue;
    if (!pick || (Number.isNaN(near) ? c.off < pick.off : Math.abs(c.at - near) < Math.abs(pick.at - near))) pick = c;
  }
  return pick;
}

/** Union of the stretches of `line` that `shapes` lie along, point by point. */
function coveredLength(line, shapes) {
  const runs = [];
  for (const shape of shapes) {
    let prev = null, prevAt = NaN;
    for (const p of shape) {
      const hit = alongLine(line, p, prevAt);
      if (!hit || hit.off > ON_STREET_METERS) { prev = null; prevAt = NaN; continue; }
      if (prev && !Number.isNaN(prevAt) && Math.abs(hit.at - prevAt) <= dist(prev, p) * 2 + 15) {
        runs.push([Math.min(hit.at, prevAt), Math.max(hit.at, prevAt)]);
      }
      prev = p; prevAt = hit.at;
    }
  }
  runs.sort((a, b) => a[0] - b[0]);
  let total = 0, cur = null;
  for (const r of runs) {
    if (!cur || r[0] > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [r[0], r[1]]; }
    else if (r[1] > cur[1]) cur[1] = r[1];
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

// ---- the work ------------------------------------------------------------------------

// ---- which streets are in which area -------------------------------------------------
//
// Worked out once per area — when it is new, redrawn, or a cell's streets are refreshed —
// and kept in area_street, so an ordinary recount (after a sync or a marked street) is a
// database read rather than a walk through hundreds of cells. It also says which areas a
// changed street belongs to, so only those are recounted.

/** Parsed cells kept in memory: key -> Map(way id -> [[lat, lng], ...]). */
const shapeCache = new Map();
const SHAPE_CACHE_CELLS = Number(process.env.SHAPE_CACHE_CELLS) || 400;

async function cellShapes(pool, key) {
  if (shapeCache.has(key)) {
    const hit = shapeCache.get(key);
    shapeCache.delete(key); shapeCache.set(key, hit);        // most recently used last
    return hit;
  }
  const c = await streets.cell(pool, key);
  const shapes = new Map();
  for (const way of c.elements) shapes.set(Number(way.id), way.geometry.map((g) => [g.lat, g.lon]));
  shapeCache.set(key, shapes);
  while (shapeCache.size > SHAPE_CACHE_CELLS) shapeCache.delete(shapeCache.keys().next().value);
  return shapes;
}

/** A street's cell, for finding its shape again: the cell holding its first point. */
function cellOf(shape) {
  return `${Math.floor(shape[0][0] / 0.1)}_${Math.floor(shape[0][1] / 0.1)}`;
}

async function rebuildMembership(pool, area, keys) {
  const areaId = Number(area.id);
  const ids = [], lengths = [], cells = [];
  const seen = new Set();
  let failed = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const shapes = await cellShapes(pool, keys[i]);
      for (const [id, shape] of shapes) {
        if (seen.has(id)) continue;
        seen.add(id);
        const [cLat, cLng] = networks.boxCentre(shape);
        if (!networks.inside(area.polygon, cLat, cLng)) continue;
        ids.push(id); lengths.push(lineLength(shape)); cells.push(cellOf(shape));
      }
    } catch (err) {
      failed = failed || err.message || "OpenStreetMap could not be reached";
    }
    // Every cell: one that has to come from OpenStreetMap can take a minute, and the page
    // should see each one land rather than sit at the same number.
    await pool.query("UPDATE area_progress SET cells_done = $2 WHERE area_id = $1", [areaId, i + 1]);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM area_street WHERE area_id = $1", [areaId]);
    for (let i = 0; i < ids.length; i += 20000) {
      await client.query(
        `INSERT INTO area_street (area_id, way_id, length_m, cell)
         SELECT $1, * FROM unnest($2::bigint[], $3::float8[], $4::text[])`,
        [areaId, ids.slice(i, i + 20000), lengths.slice(i, i + 20000), cells.slice(i, i + 20000)]);
    }
    // A failed cell leaves the list short, so it is built again next time.
    await client.query("UPDATE area_progress SET needs_full = $2 WHERE area_id = $1", [areaId, Boolean(failed)]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return failed;
}

// ---- the work ------------------------------------------------------------------------

async function compute(pool, areaId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.polygon, a.min_lat, a.min_lng, a.max_lat, a.max_lng, a.updated_at,
            p.needs_full, p.area_updated_at
       FROM areas a LEFT JOIN area_progress p ON p.area_id = a.id WHERE a.id = $1`, [areaId]);
  const area = rows[0];
  if (!area) return;
  const keys = streets.cellsFor(area.min_lat, area.min_lng, area.max_lat, area.max_lng);
  const full = area.needs_full !== false || !area.area_updated_at ||
    new Date(area.updated_at) > new Date(area.area_updated_at);
  await pool.query(
    `UPDATE area_progress SET status = 'working', dirty = false, cells_total = $2,
            cells_done = CASE WHEN $3 THEN 0 ELSE $2 END, error = NULL
      WHERE area_id = $1`, [areaId, keys.length, full]);

  const failed = full ? await rebuildMembership(pool, area, keys) : null;

  // Every street in the area, with what was said about it by hand.
  const { rows: members } = await pool.query(
    `SELECT s.way_id, s.length_m, s.cell, x.way_id IS NOT NULL AS excluded, c.way_id IS NOT NULL AS marked
       FROM area_street s
       LEFT JOIN street_exclusions x ON x.way_id = s.way_id AND x.excluded
       LEFT JOIN street_completions c ON c.way_id = s.way_id AND c.marked
      WHERE s.area_id = $1`, [areaId]);
  const found = new Map();
  for (const r of members) {
    found.set(Number(r.way_id), { length: Number(r.length_m), cell: r.cell, excluded: r.excluded, marked: r.marked });
  }

  // What was driven on them — everyone's, and person by person.
  const shapesByWay = new Map(), summed = new Map();
  const byUser = new Map();
  const { rows: edges } = await pool.query(
    `SELECT e.way_id, e.user_id, e.length_m, e.shape FROM driven_edges e
       JOIN area_street s ON s.way_id = e.way_id AND s.area_id = $1`, [areaId]);
  for (const e of edges) {
    const id = Number(e.way_id);
    if (!shapesByWay.has(id)) shapesByWay.set(id, []);
    shapesByWay.get(id).push(e.shape);
    summed.set(id, (summed.get(id) || 0) + Number(e.length_m));
    if (e.user_id == null) continue;
    const u = Number(e.user_id);
    if (!byUser.has(u)) byUser.set(u, new Map());
    const mine = byUser.get(u);
    if (!mine.has(id)) mine.set(id, { shapes: [], summed: 0 });
    mine.get(id).shapes.push(e.shape);
    mine.get(id).summed += Number(e.length_m);
  }

  // Shapes are only needed for the streets someone drove: their cells, from memory.
  const neededCells = new Set();
  for (const id of shapesByWay.keys()) { const w = found.get(id); if (w) neededCells.add(w.cell); }
  const shapeOf = new Map();
  for (const key of neededCells) {
    try {
      const shapes = await cellShapes(pool, key);
      for (const id of shapesByWay.keys()) if (shapes.has(id)) shapeOf.set(id, shapes.get(id));
    } catch (err) { /* its streets count as their summed length, below */ }
  }
  function drivenOn(id, shapes, sum, length) {
    const shape = shapeOf.get(id);
    return Math.min(shape ? coveredLength(shape, shapes) : sum, sum, length);
  }

  let total = 0, done = 0, partial = 0, nExcluded = 0, nMarked = 0, metersTotal = 0, metersDriven = 0;
  for (const [id, w] of found) {
    if (w.excluded) { nExcluded++; continue; }
    total++;
    metersTotal += w.length;
    if (w.marked) { nMarked++; done++; metersDriven += w.length; continue; }
    const shapes = shapesByWay.get(id);
    const driven = shapes ? drivenOn(id, shapes, summed.get(id) || 0, w.length) : 0;
    metersDriven += driven;
    const f = w.length > 0 ? driven / w.length : 0;
    if (f >= DONE_FRACTION) done++;
    else if (f > PARTIAL_FRACTION) partial++;
  }

  // Each person's own driving in the area.
  const people = [];
  for (const [userId, ways] of byUser) {
    let uDone = 0, uPartial = 0, uMeters = 0;
    for (const [id, w] of ways) {
      const street = found.get(id);
      if (!street || street.excluded) continue;
      const driven = drivenOn(id, w.shapes, w.summed, street.length);
      uMeters += driven;
      const f = street.length > 0 ? driven / street.length : 0;
      if (f >= DONE_FRACTION) uDone++;
      else if (f > PARTIAL_FRACTION) uPartial++;
    }
    if (uMeters > 0) people.push([userId, uDone, uPartial, uMeters]);
    recounted.add(userId);
  }
  const top = people.slice().sort((a, b) => b[3] - a[3])[0];
  const complete = total > 0 && done >= total;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM area_user_progress WHERE area_id = $1", [areaId]);
    for (const [userId, d, p, m] of people) {
      await client.query(
        `INSERT INTO area_user_progress (area_id, user_id, done, partial, meters_driven)
         VALUES ($1, $2, $3, $4, $5)`, [areaId, userId, d, p, m]);
    }
    await client.query(
      `UPDATE area_progress SET status = $2, total = $3, done = $4, partial = $5, excluded = $6, marked = $7,
              meters_total = $8, meters_driven = $9, computed_at = now(), error = $11,
              -- Straight from the table: through JavaScript it loses its microseconds and
              -- every area then looks redrawn since it was counted.
              area_updated_at = (SELECT updated_at FROM areas WHERE id = $1 AND $10::timestamptz IS NOT NULL),
              -- Kept from the first time it was complete; cleared if it stops being (a redraw).
              completed_at = CASE WHEN $12 THEN COALESCE(completed_at, now()) ELSE NULL END,
              top_user_id = $13
        WHERE area_id = $1`,
      [areaId, failed ? "failed" : "done", total, done, partial, nExcluded, nMarked,
       metersTotal, metersDriven, area.updated_at, failed, complete, top ? top[0] : null]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- one at a time, in the background -------------------------------------------------

const waiting = [];
let running = null;          // the area being worked on, or null
let looping = false;

function enqueue(pool, areaId) {
  if (!waiting.includes(areaId)) waiting.push(areaId);
  if (!looping) run(pool);
}

async function run(pool) {
  looping = true;
  while (waiting.length) {
    const id = waiting.shift();
    running = id;
    try {
      await compute(pool, id);
    } catch (err) {
      console.error("could not work out progress for area", id, err.message);
      await pool.query("UPDATE area_progress SET status = 'failed', error = $2 WHERE area_id = $1",
        [id, err.message]).catch(() => {});
    }
    running = null;
  }
  looping = false;
  // A badge for taking an area to 100% is only decidable once it has been counted.
  achievements = achievements || require("./achievements");
  for (const userId of [...recounted]) {
    recounted.delete(userId);
    await achievements.evaluate(pool, userId).catch((err) =>
      console.error("could not work out achievements for", userId, err.message));
  }
}

/**
 * What the page asks for. Starts the work if there is none, or if something has changed
 * since — a drive synced, a street marked, the outline redrawn — and says how far it is.
 */
async function forArea(pool, areaId) {
  const exists = await pool.query("SELECT 1 FROM areas WHERE id = $1", [areaId]);
  if (!exists.rowCount) return null;
  await pool.query(
    "INSERT INTO area_progress (area_id) VALUES ($1) ON CONFLICT (area_id) DO NOTHING", [areaId]);
  const { rows } = await pool.query(
    `SELECT p.*, a.updated_at AS outline_at FROM area_progress p JOIN areas a ON a.id = p.area_id
      WHERE p.area_id = $1`, [areaId]);
  const p = rows[0];
  if (!p) return null;
  const outlineMoved = Boolean(p.area_updated_at) && new Date(p.outline_at) > new Date(p.area_updated_at);
  // A failure (OpenStreetMap down, usually) is retried, but not on every poll of the page.
  const retry = p.status === "failed" &&
    (!p.computed_at || Date.now() - new Date(p.computed_at).getTime() > 2 * 60 * 1000);
  const stale = p.status === "queued" || retry || p.dirty || outlineMoved;
  if (stale && p.status !== "working") enqueue(pool, Number(areaId));
  const busy = p.status === "working" || waiting.includes(Number(areaId)) || running === Number(areaId);
  return {
    status: p.status === "working" ? "working" : busy ? "queued" : p.status,
    cellsTotal: p.cells_total, cellsDone: p.cells_done,
    // The last figures stay readable while newer ones are worked out.
    computedAt: p.computed_at ? new Date(p.computed_at).getTime() : null,
    total: p.total, done: p.done, partial: p.partial, excluded: p.excluded, marked: p.marked,
    metersTotal: p.meters_total, metersDriven: p.meters_driven,
    error: p.error,
  };
}

/**
 * Something that changes the totals happened: a phone synced, or a street was marked or
 * excluded. Every area already worked out is redone, in the background.
 */
let changeTimer = null;
let changedWays = new Set();
let changedAll = false;
/**
 * Streets changed — driven in a sync, marked or excluded by hand. Only the areas holding
 * them are recounted; `wayIds` null means anything may have changed (a full resend).
 */
function changed(pool, wayIds, settleMs) {
  if (wayIds == null) changedAll = true;
  else for (const id of wayIds) { const n = Number(id); if (Number.isSafeInteger(n)) changedWays.add(n); }
  // A phone's push arrives as several requests; recount once, after the last.
  clearTimeout(changeTimer);
  changeTimer = setTimeout(async () => {
    const ids = [...changedWays], all = changedAll;
    changedWays = new Set(); changedAll = false;
    try {
      const { rows } = all
        ? await pool.query("UPDATE area_progress SET dirty = true RETURNING area_id")
        : await pool.query(
            `UPDATE area_progress SET dirty = true WHERE area_id IN
               (SELECT DISTINCT area_id FROM area_street WHERE way_id = ANY($1::bigint[]))
             RETURNING area_id`, [ids]);
      rows.forEach((r) => enqueue(pool, Number(r.area_id)));
      await catchUp(pool);
    } catch (err) {
      console.error("could not queue progress updates", err.message);
    }
  }, settleMs != null ? settleMs : CHANGE_SETTLE_MS);
}

/**
 * A cell's streets were fetched afresh (the monthly refresh): every area over it has its
 * street list rebuilt, since streets may have been added, removed or reshaped.
 */
async function cellRefreshed(pool, key) {
  shapeCache.delete(key);
  const b = streets.cellBounds(key);
  if (!b) return;
  const { rows } = await pool.query(
    `UPDATE area_progress p SET needs_full = true, dirty = true FROM areas a
      WHERE a.id = p.area_id AND a.max_lat >= $1 AND a.min_lat <= $3 AND a.max_lng >= $2 AND a.min_lng <= $4
      RETURNING p.area_id`, b);
  rows.forEach((r) => enqueue(pool, Number(r.area_id)));
}

/**
 * Every area gets counted, not just the ones someone opens: the Areas list, the dashboard
 * and the achievements all read these. Areas never counted, or changed since, go on the
 * queue at start-up and whenever an area is added or redrawn.
 */
async function catchUp(pool) {
  const { rows } = await pool.query(
    `SELECT a.id FROM areas a LEFT JOIN area_progress p ON p.area_id = a.id
      WHERE p.area_id IS NULL OR p.status <> 'done' OR p.dirty OR p.needs_full
         OR p.area_updated_at IS NULL OR a.updated_at > p.area_updated_at
      ORDER BY (a.max_lat - a.min_lat) * (a.max_lng - a.min_lng)`);   // small ones first
  for (const r of rows) {
    await pool.query("INSERT INTO area_progress (area_id) VALUES ($1) ON CONFLICT (area_id) DO NOTHING", [r.id]);
    enqueue(pool, Number(r.id));
  }
  return rows.length;
}

/** An area was added, redrawn or renamed: count it again, soon. */
function touched(pool, areaId) {
  pool.query(`INSERT INTO area_progress (area_id) VALUES ($1)
              ON CONFLICT (area_id) DO UPDATE SET dirty = true, needs_full = true`,
    [areaId]).then(() => enqueue(pool, Number(areaId))).catch(() => {});
}

module.exports = { ensureSchema, forArea, changed, cellRefreshed, catchUp, touched, coveredLength };
