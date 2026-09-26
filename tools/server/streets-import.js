"use strict";

/**
 * Filling the street store from one map file instead of thousands of Overpass queries.
 *
 * With OSM_EXTRACT_URL set (a Geofabrik extract such as Texas), the server downloads that
 * one file once a month, keeps only the roads the app sweeps (osmium), and writes every
 * cell the file covers into street_cells — in exactly the shape Overpass answers are
 * stored in, so nothing downstream can tell the difference. Four Texas metros would
 * otherwise be about 1,350 separate Overpass requests; this is one download from a
 * service built for bulk downloads. A cell outside the file still comes from Overpass.
 *
 * Runs in the background: at start-up when the store is older than the file allows, once
 * a day to check that, and when an administrator asks.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const URL_ = process.env.OSM_EXTRACT_URL || "";
// The file's exact boundary. Geofabrik and BBBike publish one beside each extract (texas.poly
// for texas-latest.osm.pbf, Dallas.poly for Dallas.osm.pbf); OSM_EXTRACT_POLY names another.
const POLY_URL = process.env.OSM_EXTRACT_POLY ||
  URL_.replace(/-latest\.osm\.pbf$/, ".poly").replace(/\.osm\.pbf$/, ".poly");
const DIR = path.resolve(process.env.OSM_EXTRACT_DIR || "/data/osm");
const MAX_AGE_MS = (Number(process.env.OSM_EXTRACT_DAYS) || 30) * 24 * 60 * 60 * 1000;
const USER_AGENT = "StreetSweep/1.0 (self-hosted street coverage server; monthly extract)";
const SWEEPABLE = ["primary", "secondary", "tertiary", "unclassified", "residential", "living_street"];
const HIGHWAYS = SWEEPABLE.flatMap((h) => [h, `${h}_link`]);

const state = { enabled: Boolean(URL_), url: URL_, poly: POLY_URL, running: false, step: "idle", startedAt: null,
                finishedAt: null, ways: 0, cells: 0, error: null };

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed: ${err.trim() || code}`))));
  });
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS street_import (cell TEXT NOT NULL, way JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS street_import_runs (
      finished_at TIMESTAMPTZ NOT NULL DEFAULT now(), url TEXT, ways INT, cells INT
    );
  `);
}

async function lastRun(pool) {
  const { rows } = await pool.query(
    "SELECT finished_at, ways, cells FROM street_import_runs WHERE url = $1 ORDER BY finished_at DESC LIMIT 1", [URL_]);
  return rows[0] || null;
}

/** The .poly boundary format: rings of "lon lat" lines. Holes (rings named !...) are ignored. */
function parsePoly(text) {
  const rings = [];
  let ring = null;
  for (const raw of text.split(/\r?\n/).slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "END") { if (ring) { if (!ring.hole) rings.push(ring.points); ring = null; } continue; }
    if (!ring) { ring = { hole: line.startsWith("!"), points: [] }; continue; }
    const [lon, lat] = line.split(/\s+/).map(Number);
    if (Number.isFinite(lon) && Number.isFinite(lat)) ring.points.push([lat, lon]);
  }
  return rings;
}

function insideRings(rings, lat, lng) {
  return rings.some((poly) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ai, aj] = [poly[i], poly[j]];
      if ((ai[0] > lat) !== (aj[0] > lat) &&
          lng < ((aj[1] - ai[1]) * (lat - ai[0])) / (aj[0] - ai[0]) + ai[1]) hit = !hit;
    }
    return hit;
  });
}

/**
 * Whether a cell lies wholly inside the file. One on its edge holds only the file's side of
 * the border, and writing it would replace a complete Overpass copy with half of one.
 */
function cellInside(rings, key) {
  const [la, lo] = key.split("_").map(Number);
  const s = la / 10, w = lo / 10, n = (la + 1) / 10, e = (lo + 1) / 10;
  return [[s, w], [s, e], [n, w], [n, e], [(s + n) / 2, (w + e) / 2]].every(([a, b]) => insideRings(rings, a, b));
}

/** Downloads the extract when there is none or it is older than the refresh period. */
async function download(file) {
  try {
    const st = await fsp.stat(file);
    if (Date.now() - st.mtimeMs < MAX_AGE_MS) return false;
  } catch (err) { /* none yet */ }
  state.step = "downloading the map file";
  const r = await fetch(URL_, { headers: { "User-Agent": USER_AGENT } });
  if (!r.ok) throw new Error(`the map file download answered ${r.status}`);
  const tmp = `${file}.part`;
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
  await fsp.rename(tmp, file);
  return true;
}

/** The whole job. `cellsChanged` is told every cell rewritten, so what depends on it is redone. */
async function importNow(pool, cellsChanged) {
  if (!URL_) throw new Error("OSM_EXTRACT_URL is not set");
  if (state.running) return state;
  Object.assign(state, { running: true, startedAt: Date.now(), finishedAt: null, error: null, ways: 0, cells: 0 });
  try {
    await fsp.mkdir(DIR, { recursive: true });
    const pbf = path.join(DIR, "extract.osm.pbf");
    const roads = path.join(DIR, "roads.osm.pbf");
    const lines = path.join(DIR, "roads.geojsonseq");
    await download(pbf);
    state.step = "reading the map file's boundary";
    const pr = await fetch(POLY_URL, { headers: { "User-Agent": USER_AGENT } });
    if (!pr.ok) throw new Error(`the boundary file (${POLY_URL}) answered ${pr.status}; set OSM_EXTRACT_POLY`);
    const rings = parsePoly(await pr.text());
    if (!rings.length) throw new Error("the boundary file has no outline in it");

    state.step = "keeping only the roads that are swept";
    await run("osmium", ["tags-filter", pbf, `w/highway=${HIGHWAYS.join(",")}`, "-o", roads, "--overwrite"]);
    state.step = "turning the roads into lines";
    await run("osmium", ["export", roads, "-f", "geojsonseq", "--geometry-types=linestring", "-a", "id",
      "--format-option=print_record_separator=false", "-o", lines, "--overwrite"]);

    // What the file covers, so an empty cell inside it (a lake) is stored as empty rather
    // than sent to Overpass, and a cell outside it is left alone.
    state.step = "reading the roads";
    await pool.query("TRUNCATE street_import");
    let s = 90, n = -90, w = 180, e = -180;
    const batch = { cells: [], ways: [] };
    const flush = async () => {
      if (!batch.cells.length) return;
      await pool.query("INSERT INTO street_import (cell, way) SELECT * FROM unnest($1::text[], $2::jsonb[])",
        [batch.cells, batch.ways]);
      batch.cells = []; batch.ways = [];
    };
    const rl = readline.createInterface({ input: fs.createReadStream(lines), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let f;
      try { f = JSON.parse(line); } catch (err) { continue; }
      const coords = f.geometry && f.geometry.coordinates;
      const p = f.properties || {};
      const id = Number(String(p["@id"] || f.id || "").replace(/^w/, ""));
      if (!Array.isArray(coords) || coords.length < 2 || !Number.isSafeInteger(id) || !p.highway) continue;
      // The shape Overpass answers are stored in (streets.js trim()).
      const tags = { highway: p.highway };
      if (p.name) tags.name = p.name;
      const way = JSON.stringify({ type: "way", id, tags, geometry: coords.map(([lon, lat]) => ({ lat, lon })) });
      // Every cell with a point of it in: what an Overpass bbox query for that cell returns.
      const cells = new Set();
      for (const [lon, lat] of coords) {
        cells.add(`${Math.floor(lat / 0.1)}_${Math.floor(lon / 0.1)}`);
        if (lat < s) s = lat; if (lat > n) n = lat; if (lon < w) w = lon; if (lon > e) e = lon;
      }
      for (const c of cells) { batch.cells.push(c); batch.ways.push(way); }
      state.ways++;
      if (batch.cells.length >= 5000) await flush();
    }
    await flush();

    state.step = "storing the streets";
    // Only cells wholly inside the file: its edge cells are left to Overpass.
    const { rows: present } = await pool.query("SELECT DISTINCT cell FROM street_import");
    const whole = present.map((r) => r.cell).filter((k) => cellInside(rings, k));
    const { rows: written } = await pool.query(
      `INSERT INTO street_cells (key, fetched_at, elements)
       SELECT cell, now(), jsonb_agg(way) FROM street_import WHERE cell = ANY($1::text[]) GROUP BY cell
       ON CONFLICT (key) DO UPDATE SET fetched_at = now(), elements = EXCLUDED.elements
       RETURNING key`, [whole]);
    const keys = new Set(written.map((r) => r.key));
    // Cells inside the file with no roads at all (a lake): stored empty, so no one asks.
    if (state.ways) {
      const empties = [];
      for (let la = Math.floor(s / 0.1); la <= Math.floor(n / 0.1); la++) {
        for (let lo = Math.floor(w / 0.1); lo <= Math.floor(e / 0.1); lo++) {
          const k = `${la}_${lo}`;
          if (!keys.has(k) && cellInside(rings, k)) empties.push(k);
        }
      }
      // Only cells some area needs: the file's box is mostly desert and gulf otherwise.
      const { rows: areas } = await pool.query("SELECT min_lat, min_lng, max_lat, max_lng FROM areas");
      const needed = new Set();
      for (const a of areas) {
        for (let la = Math.floor(a.min_lat / 0.1); la <= Math.floor(a.max_lat / 0.1); la++) {
          for (let lo = Math.floor(a.min_lng / 0.1); lo <= Math.floor(a.max_lng / 0.1); lo++) needed.add(`${la}_${lo}`);
        }
      }
      const emptyNeeded = empties.filter((k) => needed.has(k));
      if (emptyNeeded.length) {
        await pool.query(
          `INSERT INTO street_cells (key, fetched_at, elements) SELECT k, now(), '[]'::jsonb FROM unnest($1::text[]) k
           ON CONFLICT (key) DO UPDATE SET fetched_at = now(), elements = EXCLUDED.elements`, [emptyNeeded]);
        emptyNeeded.forEach((k) => keys.add(k));
      }
    }
    await pool.query("TRUNCATE street_import");
    state.cells = keys.size;
    await pool.query("INSERT INTO street_import_runs (url, ways, cells) VALUES ($1, $2, $3)", [URL_, state.ways, state.cells]);
    await fsp.rm(lines, { force: true });
    await fsp.rm(roads, { force: true });
    state.step = "done";
    if (cellsChanged) await cellsChanged([...keys]);
  } catch (err) {
    state.error = err.message;
    state.step = "failed";
    throw err;
  } finally {
    state.running = false;
    state.finishedAt = Date.now();
  }
  return state;
}

/** At start-up and once a day: import when there is no import, or the last one is too old. */
async function importIfDue(pool, cellsChanged) {
  if (!URL_ || state.running) return false;
  const last = await lastRun(pool);
  if (last && Date.now() - new Date(last.finished_at).getTime() < MAX_AGE_MS) return false;
  await importNow(pool, cellsChanged);
  return true;
}

async function status(pool) {
  const last = URL_ ? await lastRun(pool) : null;
  return { ...state, lastImportAt: last ? new Date(last.finished_at).getTime() : null,
           lastWays: last ? last.ways : null, lastCells: last ? last.cells : null };
}

module.exports = { ensureSchema, importNow, importIfDue, status, enabled: () => Boolean(URL_) };
