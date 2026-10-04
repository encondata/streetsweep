// Address lookup for the map's search box: GET /api/geocode?q=…
//
// Through the server, like every other call to an outside service, so the web and apps
// never talk to OpenStreetMap's servers themselves. Nominatim's usage policy asks for an
// identifying User-Agent, at most one request a second, results kept rather than asked
// for again, and no search-as-you-type: so requests are paced and cached here, and the
// web only asks when someone presses Enter.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { config } from "../config.js";
import { requireUser } from "../auth.js";
import { HttpError, badRequest } from "../http.js";

const UA = () => `StreetSweep/2 (self-hosted street coverage; ${config.contactEmail || "no contact set"})`;
const CACHE_MS = 7 * 24 * 3600 * 1000;
const cache = new Map<string, { at: number; results: unknown[] }>();
let lastCall = 0;
let queue: Promise<unknown> = Promise.resolve();

/** One request at a time, a second and a bit apart, server-wide. */
function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

/** Where to look: the imported region (its state outline), so "Main St" finds yours. */
let region: [number, number, number, number] | null | undefined;
async function regionBox() {
  if (region !== undefined) return region;
  const { rows } = await pool.query(
    `SELECT ST_XMin(e) w, ST_YMin(e) s, ST_XMax(e) e, ST_YMax(e) n FROM (
       SELECT ST_Extent(geom) e FROM areas WHERE level = 'state' AND source = 'osm_boundary' AND deleted_at IS NULL) x`);
  const r = rows[0];
  region = r?.w != null ? [r.w, r.s, r.e, r.n] : null;
  return region;
}

export default async function geocodeRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>("/api/geocode", async (req) => {
    requireUser(req);
    const q = (req.query.q ?? "").trim().replace(/\s+/g, " ");
    if (q.length < 3 || q.length > 200) throw badRequest("Type at least a few letters of an address.");
    const key = q.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return { results: hit.results };

    const box = await regionBox();
    const url = new URL("/search", config.geocoderUrl);
    url.searchParams.set("q", q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "6");
    url.searchParams.set("addressdetails", "0");
    if (box) {
      url.searchParams.set("viewbox", box.join(","));
      url.searchParams.set("bounded", "1");
    }
    const res = await paced(() => fetch(url, { headers: { "User-Agent": UA(), "Accept-Language": "en" }, signal: AbortSignal.timeout(10_000) }))
      .catch(() => { throw new HttpError(502, "The address search didn't answer. Try again in a moment."); });
    if (!res.ok) throw new HttpError(502, res.status === 429 ? "The address search is busy. Try again in a minute." : "The address search didn't answer.");
    const rows = (await res.json()) as { display_name: string; lat: string; lon: string; boundingbox?: string[]; type?: string; class?: string }[];
    const results = rows.map((r) => ({
      label: r.display_name,
      lon: Number(r.lon),
      lat: Number(r.lat),
      // Nominatim gives [south, north, west, east].
      bbox: r.boundingbox ? [Number(r.boundingbox[2]), Number(r.boundingbox[0]), Number(r.boundingbox[3]), Number(r.boundingbox[1])] : null,
      kind: r.type ?? r.class ?? null,
    }));
    if (cache.size > 1000) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), results });
    return { results };
  });
}
