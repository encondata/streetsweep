"use strict";

/**
 * Every street a car is meant to sweep inside one area, for colouring it on the web map.
 *
 * Built from the same cached map cells the phones download (see streets.js), so the web
 * and every phone share one copy of each cell and OpenStreetMap is asked for it once. An
 * earlier version fetched each area separately and kept its own cache, which meant the
 * same streets were downloaded once for the web and again for each phone.
 *
 * The rule for which area a street is in is the phone's: the centre of the street's
 * bounding box, inside the outline. Not its middle vertex — on the curving lakeside roads
 * of April Sound the two land on opposite sides of the line often enough to matter.
 */

const streets = require("./streets");

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

async function ensureSchema() { /* nothing of its own now; the cells live in streets.js */ }

/**
 * The area's streets as lines. Each cell comes from the store if it has it; the first
 * request for a cell nobody has asked for yet waits for OpenStreetMap, on the server's
 * one queue.
 */
async function forArea(pool, area) {
  const keys = streets.cellsFor(area.min_lat, area.min_lng, area.max_lat, area.max_lng);
  const seen = new Set();
  const lines = [];
  let fetchedAt = Date.now(), cached = true, stale = false;

  for (const key of keys) {
    const c = await streets.cell(pool, key);
    fetchedAt = Math.min(fetchedAt, c.fetchedAt);
    cached = cached && c.cached;
    stale = stale || Boolean(c.stale);
    for (const way of c.elements) {
      // A way crossing a cell edge comes back from both cells.
      if (seen.has(way.id)) continue;
      seen.add(way.id);
      const shape = way.geometry.map((p) => [p.lat, p.lon]);
      const [cLat, cLng] = boxCentre(shape);
      if (!inside(area.polygon, cLat, cLng)) continue;
      lines.push({ id: way.id, name: (way.tags && way.tags.name) || null, shape });
    }
  }
  return { lines, fetchedAt, cached, stale, cells: keys.length };
}

module.exports = { ensureSchema, forArea, boxCentre, inside };
