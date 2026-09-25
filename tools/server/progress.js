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

const DONE_FRACTION = 0.8;
const PARTIAL_FRACTION = 0.02;
const ON_STREET_METERS = 30;
const TIE_METERS = 2;
// How long after the last change (a sync batch, a marked street) the totals are redone.
const CHANGE_SETTLE_MS = Number(process.env.PROGRESS_SETTLE_MS) || 15000;

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

async function compute(pool, areaId) {
  const { rows } = await pool.query(
    "SELECT id, polygon, min_lat, min_lng, max_lat, max_lng, updated_at FROM areas WHERE id = $1", [areaId]);
  const area = rows[0];
  if (!area) return;
  const keys = streets.cellsFor(area.min_lat, area.min_lng, area.max_lat, area.max_lng);
  await pool.query(
    `UPDATE area_progress SET status = 'working', dirty = false, cells_total = $2, cells_done = 0, error = NULL
      WHERE area_id = $1`, [areaId, keys.length]);

  // Every street in the outline, once.
  const found = new Map();
  let failed = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const c = await streets.cell(pool, keys[i]);
      for (const way of c.elements) {
        if (found.has(way.id)) continue;
        const shape = way.geometry.map((g) => [g.lat, g.lon]);
        const [cLat, cLng] = networks.boxCentre(shape);
        if (!networks.inside(area.polygon, cLat, cLng)) { found.set(way.id, null); continue; }
        found.set(way.id, { shape, length: lineLength(shape) });
      }
    } catch (err) {
      failed = failed || err.message || "OpenStreetMap could not be reached";
    }
    // Every cell: one that has to come from OpenStreetMap can take a minute, and the page
    // should see each one land rather than sit at the same number.
    await pool.query("UPDATE area_progress SET cells_done = $2 WHERE area_id = $1", [areaId, i + 1]);
  }
  const ids = [...found].filter(([, w]) => w).map(([id]) => id);

  // What was driven on them, and what was said about them by hand.
  const shapesByWay = new Map(), summed = new Map();
  for (let i = 0; i < ids.length; i += 5000) {
    const batch = ids.slice(i, i + 5000);
    const { rows: edges } = await pool.query(
      "SELECT way_id, length_m, shape FROM driven_edges WHERE way_id = ANY($1::bigint[])", [batch]);
    for (const e of edges) {
      const id = Number(e.way_id);
      if (!shapesByWay.has(id)) shapesByWay.set(id, []);
      shapesByWay.get(id).push(e.shape);
      summed.set(id, (summed.get(id) || 0) + Number(e.length_m));
    }
  }
  const marked = new Set(), excluded = new Set();
  for (let i = 0; i < ids.length; i += 5000) {
    const batch = ids.slice(i, i + 5000);
    const [m, x] = await Promise.all([
      pool.query("SELECT way_id FROM street_completions WHERE marked AND way_id = ANY($1::bigint[])", [batch]),
      pool.query("SELECT way_id FROM street_exclusions WHERE excluded AND way_id = ANY($1::bigint[])", [batch]),
    ]);
    m.rows.forEach((r) => marked.add(Number(r.way_id)));
    x.rows.forEach((r) => excluded.add(Number(r.way_id)));
  }

  let total = 0, done = 0, partial = 0, nExcluded = 0, nMarked = 0, metersTotal = 0, metersDriven = 0;
  for (const id of ids) {
    const w = found.get(id);
    if (excluded.has(id)) { nExcluded++; continue; }
    total++;
    metersTotal += w.length;
    if (marked.has(id)) { nMarked++; done++; metersDriven += w.length; continue; }
    const shapes = shapesByWay.get(id);
    const driven = shapes
      ? Math.min(coveredLength(w.shape, shapes), summed.get(id) || 0, w.length) : 0;
    metersDriven += driven;
    const f = w.length > 0 ? driven / w.length : 0;
    if (f >= DONE_FRACTION) done++;
    else if (f > PARTIAL_FRACTION) partial++;
  }

  await pool.query(
    `UPDATE area_progress SET status = $2, total = $3, done = $4, partial = $5, excluded = $6, marked = $7,
            meters_total = $8, meters_driven = $9, computed_at = now(), area_updated_at = $10, error = $11
      WHERE area_id = $1`,
    [areaId, failed ? "failed" : "done", total, done, partial, nExcluded, nMarked,
     metersTotal, metersDriven, area.updated_at, failed]);
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
function changed(pool, settleMs) {
  // A phone's push arrives as several requests; redo everything once, after the last.
  clearTimeout(changeTimer);
  changeTimer = setTimeout(async () => {
    try {
      const { rows } = await pool.query(
        "UPDATE area_progress SET dirty = true WHERE status IN ('done', 'failed') RETURNING area_id");
      rows.forEach((r) => enqueue(pool, Number(r.area_id)));
    } catch (err) {
      console.error("could not queue progress updates", err.message);
    }
  }, settleMs != null ? settleMs : CHANGE_SETTLE_MS);
}

module.exports = { ensureSchema, forArea, changed, coveredLength };
