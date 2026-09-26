"use strict";

/**
 * Map tiles, fetched once by this server and kept, for the web map, the phones and the
 * car screen alike. Every pan and zoom on every device used to go to OpenStreetMap's (and
 * Esri's) tile servers directly; now each tile is asked for once, here, and served from
 * disk after that.
 *
 * OpenStreetMap's tile usage policy asks for exactly this shape of client: an honest
 * User-Agent, no more than two connections at a time, and tiles cached rather than asked
 * for again. Kept for TILE_TTL_DAYS (30 by default), well past the seven the policy asks;
 * a tile past that is still served at once and quietly refreshed behind it.
 *
 * Only for someone signed in: an open tile relay would let anyone point their maps at this
 * server and, through it, at OpenStreetMap.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const DIR = path.resolve(process.env.TILE_DIR || "/data/tiles");
const TTL_MS = (Number(process.env.TILE_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000;
const USER_AGENT = "StreetSweep/1.0 (self-hosted street coverage server; tile cache)";

/**
 * The layers the maps draw. `url` builds the upstream address; Esri's services order the
 * path z/y/x, OpenStreetMap's z/x/y. TILE_URL_OSM points the standard map at your own
 * tile server instead, with {z}, {x} and {y} in it.
 */
const LAYERS = {
  osm: {
    url: (z, x, y) => (process.env.TILE_URL_OSM || "https://tile.openstreetmap.org/{z}/{x}/{y}.png")
      .replace("{z}", z).replace("{x}", x).replace("{y}", y),
    type: "image/png", ext: "png", maxZoom: 19, parallel: 2,
  },
  sat: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    type: "image/jpeg", ext: "jpg", maxZoom: 19, parallel: 4,
  },
  ref: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`,
    type: "image/png", ext: "png", maxZoom: 19, parallel: 4,
  },
};

const stats = { served: 0, fetched: 0, failed: 0, since: Date.now() };

// ---- a few upstream requests at a time, per layer -------------------------------------

const running = {};
const waiting = {};
function limited(layer, job) {
  const cap = LAYERS[layer].parallel;
  running[layer] = running[layer] || 0;
  waiting[layer] = waiting[layer] || [];
  return new Promise((resolve, reject) => {
    const go = () => {
      running[layer]++;
      job().then(resolve, reject).finally(() => {
        running[layer]--;
        const next = waiting[layer].shift();
        if (next) next();
      });
    };
    if (running[layer] < cap) go(); else waiting[layer].push(go);
  });
}

const inFlight = new Map();

async function fetchUpstream(layer, z, x, y, file) {
  const key = `${layer}/${z}/${x}/${y}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const job = limited(layer, async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(LAYERS[layer].url(z, x, y), {
        headers: { "User-Agent": USER_AGENT }, signal: ctl.signal,
      });
      if (!r.ok) throw Object.assign(new Error(`tile server answered ${r.status}`), { status: r.status });
      const bytes = Buffer.from(await r.arrayBuffer());
      await fsp.mkdir(path.dirname(file), { recursive: true });
      // Written beside it and renamed, so a reader never sees half a tile.
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, bytes);
      await fsp.rename(tmp, file);
      stats.fetched++;
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  });
  inFlight.set(key, job);
  try { return await job; } finally { inFlight.delete(key); }
}

/** GET /tiles/{layer}/{z}/{x}/{y}(.png|.jpg) */
async function serve(req, res, layer, z, x, y) {
  const L = LAYERS[layer];
  const max = 2 ** z;
  if (!L || z < 0 || z > L.maxZoom || x < 0 || y < 0 || x >= max || y >= max) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("No such tile");
  }
  const file = path.join(DIR, layer, String(z), String(x), `${y}.${L.ext}`);
  const send = (bytes) => {
    stats.served++;
    res.writeHead(200, {
      "Content-Type": L.type, "Content-Length": bytes.length,
      // A day in the browser's own cache; the server holds it much longer.
      "Cache-Control": "private, max-age=86400",
    });
    res.end(bytes);
  };
  let held = null;
  try {
    const st = await fsp.stat(file);
    held = { age: Date.now() - st.mtimeMs };
  } catch (err) { /* not held */ }
  if (held) {
    const bytes = await fsp.readFile(file);
    send(bytes);
    if (held.age > TTL_MS) fetchUpstream(layer, z, x, y, file).catch(() => { stats.failed++; });
    return;
  }
  try {
    send(await fetchUpstream(layer, z, x, y, file));
  } catch (err) {
    stats.failed++;
    res.writeHead(err.status === 404 ? 404 : 502, { "Content-Type": "text/plain" });
    res.end("The tile could not be fetched");
  }
}

/** How big the cache is, for the admin dashboard. Walks the directory: cheap enough. */
async function cacheStatus() {
  let files = 0, bytes = 0;
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else { files++; try { bytes += (await fsp.stat(p)).size; } catch (err) { /* gone */ } }
    }
  }
  await walk(DIR);
  return { files, bytes, ...stats, ttlDays: TTL_MS / 86400000 };
}

const ROUTE = /^\/tiles\/(osm|sat|ref)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})(?:\.(?:png|jpg))?$/;

module.exports = { serve, cacheStatus, ROUTE, LAYERS };
