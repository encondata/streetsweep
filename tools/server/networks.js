"use strict";

/**
 * Every street a car is meant to sweep inside an area, fetched from OpenStreetMap once
 * and kept.
 *
 * Browsers used to ask Overpass for this themselves on every click. That was fragile —
 * the main public server answers one request in 1.3 seconds and the identical one three
 * seconds later with a 504 — and it put every viewer's clicks onto a free service that
 * rate-limits. Asked for here instead, it is fetched once per area with a proper
 * User-Agent and patient retries, stored, and handed to everyone after that instantly.
 *
 * The filter is the phone's, word for word, and so is the rule for which area a street
 * is in: the centre of the street's bounding box, inside the outline. Not its middle
 * vertex — an early version used that, and on the curving lakeside roads of April Sound
 * the two land on opposite sides of the line often enough to count 127 streets where
 * the phone counts 165.
 */

const crypto = require("crypto");

const SWEEPABLE = "primary|secondary|tertiary|unclassified|residential|living_street";

const SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// Overpass refuses a request with no User-Agent (406), and asks that one identify itself.
const USER_AGENT = "StreetSweep/1.0 (self-hosted street coverage portal)";

// Streets change slowly. A month is fresh enough to count against and rare enough not to
// bother a free service.
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS area_networks (
      area_id     BIGINT PRIMARY KEY REFERENCES areas(id) ON DELETE CASCADE,
      -- The outline this was fetched for. Redrawing the area makes it a different set of
      -- streets, and comparing a hash is how that is noticed.
      outline     TEXT   NOT NULL,
      fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      lines       JSONB  NOT NULL
    );
  `);
}

// Bump when the rule for which streets are in an area changes, so copies made under the
// old rule are fetched again rather than served with the wrong count.
const RULE = "bbox-centre-v2";

function outlineHash(polygon) {
  return crypto.createHash("sha1").update(RULE + JSON.stringify(polygon)).digest("hex");
}

/** Centre of a line's bounding box — what the phone calls a street's centroid. */
function boxCentre(points) {
  let s = 90, n = -90, w = 180, e = -180;
  for (const [lat, lng] of points) {
    if (lat < s) s = lat; if (lat > n) n = lat;
    if (lng < w) w = lng; if (lng > e) e = lng;
  }
  return [(s + n) / 2, (w + e) / 2];
}

/** Ray casting on [lat, lng] pairs, the test the phone and the drive matcher use. */
function inside(polygon, lat, lng) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ai, aj] = [polygon[i], polygon[j]];
    if ((ai[0] > lat) !== (aj[0] > lat) &&
        lng < ((aj[1] - ai[1]) * (lat - ai[0])) / (aj[0] - ai[0]) + ai[1]) hit = !hit;
  }
  return hit;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Asks each server in turn, and the main one more than once: it fails intermittently
 * rather than being down, so a second try a moment later usually works where moving
 * straight on to a mirror that is itself unreachable does not.
 */
async function askOverpass(query) {
  const attempts = [
    [SERVERS[0], 0], [SERVERS[0], 2000], [SERVERS[1], 0], [SERVERS[2], 0], [SERVERS[0], 5000],
  ];
  let last = null;
  for (const [url, wait] of attempts) {
    if (wait) await pause(wait);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45000);
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
    } catch (err) {
      last = err.name === "AbortError" ? new Error("OpenStreetMap took too long to answer") : err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last || new Error("OpenStreetMap could not be reached");
}

/** In-flight fetches, so two people clicking the same area at once ask Overpass once. */
const pending = new Map();

/**
 * The streets for an area: from the store if they are fresh and for this outline,
 * otherwise fetched, stored and returned.
 */
async function forArea(pool, area) {
  const hash = outlineHash(area.polygon);
  const { rows } = await pool.query(
    "SELECT outline, fetched_at, lines FROM area_networks WHERE area_id=$1", [area.id]);
  const held = rows[0];
  const fresh = held && held.outline === hash &&
    Date.now() - new Date(held.fetched_at).getTime() < STALE_MS;
  if (fresh) return { lines: held.lines, fetchedAt: new Date(held.fetched_at).getTime(), cached: true };

  if (pending.has(area.id)) return pending.get(area.id);

  const job = (async () => {
    const q = `[out:json][timeout:60];way["highway"~"^(${SWEEPABLE})(_link)?$"]` +
      `(${area.min_lat},${area.min_lng},${area.max_lat},${area.max_lng});out geom;`;
    let json;
    try {
      json = await askOverpass(q);
    } catch (err) {
      // An old copy is better than nothing when the service is down; say it is old.
      if (held) {
        return { lines: held.lines, fetchedAt: new Date(held.fetched_at).getTime(), cached: true, stale: true };
      }
      throw err;
    }

    const lines = [];
    for (const el of json.elements || []) {
      const g = el.geometry || [];
      if (g.length < 2) continue;
      const shape = g.map((p) => [p.lat, p.lon]);
      const [cLat, cLng] = boxCentre(shape);
      if (!inside(area.polygon, cLat, cLng)) continue;
      lines.push({ id: el.id, name: (el.tags && el.tags.name) || null, shape });
    }
    await pool.query(
      `INSERT INTO area_networks (area_id, outline, fetched_at, lines) VALUES ($1,$2,now(),$3)
       ON CONFLICT (area_id) DO UPDATE SET outline=EXCLUDED.outline, fetched_at=now(), lines=EXCLUDED.lines`,
      [area.id, hash, JSON.stringify(lines)]);
    return { lines, fetchedAt: Date.now(), cached: false };
  })();

  pending.set(area.id, job);
  try { return await job; } finally { pending.delete(area.id); }
}

module.exports = { ensureSchema, forArea, boxCentre, SWEEPABLE, STALE_MS };
