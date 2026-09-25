"use strict";

/**
 * The street network, fetched from OpenStreetMap once — by this server, and only this
 * server — and kept for every phone and the web map to share.
 *
 * Streets are cached per map cell: the same 0.1° grid the phone downloads by, with the
 * same keys ("303_-955" is 30.3–30.4°N, 95.5–95.4°W). Cells rather than areas because
 * neighbouring areas share cells, so each cell is asked for once no matter how many areas
 * or phones need it.
 *
 * What is stored and served is Overpass's own answer, trimmed to the fields that matter,
 * so the phone reads it with the very parser it has always used. There is no second
 * interpretation of what a street is, what it is called, or how long it is.
 *
 * Requests to OpenStreetMap go out one at a time, with a pause between them, from a single
 * queue. Phones used to ask OpenStreetMap themselves; one Pixel downloading 108 areas at
 * once got its whole network banned. The server must not be able to do the same thing
 * when two phones sync together.
 */

const SWEEPABLE = "primary|secondary|tertiary|unclassified|residential|living_street";
const SIZE_DEG = 0.1;

// OVERPASS_URL points this at a private instance, or at several separated by commas.
const SERVERS = (process.env.OVERPASS_URL ||
  "https://overpass-api.de/api/interpreter," +
  "https://overpass.kumi.systems/api/interpreter," +
  "https://overpass.private.coffee/api/interpreter")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Overpass refuses a request with no User-Agent (406).
const USER_AGENT = "StreetSweep/1.0 (self-hosted street coverage server)";

// Streets change slowly; the phone has always treated a cell as fresh for a month.
const STALE_MS = 30 * 24 * 60 * 60 * 1000;
const PAUSE_MS = 1200;          // between requests, even successful ones
const RATE_LIMIT_MS = 65000;    // a 429 asks for a minute's quiet

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS street_cells (
      key        TEXT PRIMARY KEY,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      elements   JSONB NOT NULL
    );
  `);
}

const KEY_RE = /^(-?\d{1,4})_(-?\d{1,4})$/;

function parseKey(key) {
  const m = KEY_RE.exec(String(key || ""));
  if (!m) return null;
  const la = Number(m[1]), lo = Number(m[2]);
  if (la < -900 || la > 899 || lo < -1800 || lo > 1799) return null;
  return { la, lo };
}

/** South, west, north, east — idx/10 rather than idx*0.1, which is exact for these. */
function cellBounds(key) {
  const c = parseKey(key);
  if (!c) return null;
  return [c.la / 10, c.lo / 10, (c.la + 1) / 10, (c.lo + 1) / 10];
}

/** Every cell a bounding box touches, as the phone's ChunkGrid.cellsFor works it out. */
function cellsFor(s, w, n, e) {
  const keys = [];
  for (let la = Math.floor(s / SIZE_DEG); la <= Math.floor(n / SIZE_DEG); la++) {
    for (let lo = Math.floor(w / SIZE_DEG); lo <= Math.floor(e / SIZE_DEG); lo++) {
      keys.push(`${la}_${lo}`);
    }
  }
  return keys;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- one request at a time -------------------------------------------------------

let tail = Promise.resolve();
let lastAt = 0;
let quietUntil = 0;

/** Runs `job` after every job queued before it, never two at once. */
function queued(job) {
  const run = tail.then(async () => {
    const wait = Math.max(quietUntil, lastAt + PAUSE_MS) - Date.now();
    if (wait > 0) await pause(wait);
    try { return await job(); } finally { lastAt = Date.now(); }
  });
  tail = run.catch(() => {});      // one failure must not stall everything after it
  return run;
}

async function askOverpass(query) {
  let last = null;
  // The main server fails intermittently rather than being down, so it gets a second go
  // before the mirrors, and a third after them.
  const order = [SERVERS[0], SERVERS[0], ...SERVERS.slice(1), SERVERS[0]].filter(Boolean);
  for (const url of order) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "data=" + encodeURIComponent(query),
        signal: ctl.signal,
      });
      if (r.ok) return await r.json();
      last = new Error(`OpenStreetMap answered ${r.status}`);
      if (r.status === 429) {
        quietUntil = Date.now() + RATE_LIMIT_MS;
        await pause(RATE_LIMIT_MS);
      }
    } catch (err) {
      last = err.name === "AbortError" ? new Error("OpenStreetMap took too long to answer") : err;
    } finally {
      clearTimeout(timer);
    }
    await pause(PAUSE_MS);
  }
  throw last || new Error("OpenStreetMap could not be reached");
}

/** Just the fields the phone's parser reads; nodes and bounds are most of the bytes. */
function trim(elements) {
  const out = [];
  for (const e of elements || []) {
    if (e.type !== "way" || !Array.isArray(e.geometry) || e.geometry.length < 2) continue;
    const tags = {};
    if (e.tags && e.tags.name) tags.name = e.tags.name;
    if (e.tags && e.tags.highway) tags.highway = e.tags.highway;
    out.push({ type: "way", id: e.id, tags,
               geometry: e.geometry.map((g) => ({ lat: g.lat, lon: g.lon })) });
  }
  return out;
}

const inFlight = new Map();

/**
 * The streets in one cell: from the store when fresh, otherwise fetched on the queue and
 * stored. A stale copy is served, and said to be stale, if OpenStreetMap cannot be reached.
 */
async function cell(pool, key) {
  const b = cellBounds(key);
  if (!b) throw Object.assign(new Error("That is not a map cell"), { status: 400 });

  const { rows } = await pool.query("SELECT fetched_at, elements FROM street_cells WHERE key=$1", [key]);
  const held = rows[0];
  if (held && Date.now() - new Date(held.fetched_at).getTime() < STALE_MS) {
    return { key, elements: held.elements, fetchedAt: new Date(held.fetched_at).getTime(), cached: true };
  }
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    const q = `[out:json][timeout:90];way["highway"~"^(${SWEEPABLE})(_link)?$"]` +
      `(${b[0]},${b[1]},${b[2]},${b[3]});out geom;`;
    let json;
    try {
      json = await queued(() => askOverpass(q));
    } catch (err) {
      if (held) {
        return { key, elements: held.elements, fetchedAt: new Date(held.fetched_at).getTime(),
                 cached: true, stale: true };
      }
      throw Object.assign(err, { status: 502 });
    }
    const elements = trim(json.elements);
    await pool.query(
      `INSERT INTO street_cells (key, fetched_at, elements) VALUES ($1, now(), $2)
       ON CONFLICT (key) DO UPDATE SET fetched_at = now(), elements = EXCLUDED.elements`,
      [key, JSON.stringify(elements)]);
    return { key, elements, fetchedAt: Date.now(), cached: false };
  })();

  inFlight.set(key, job);
  try { return await job; } finally { inFlight.delete(key); }
}

module.exports = { ensureSchema, cell, cellsFor, cellBounds, parseKey, SERVERS };
