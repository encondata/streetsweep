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
// Remembered once found. Not found isn't remembered: before the first street import has
// brought the boundaries in there's no outline yet, and searches shouldn't stay unbounded.
let region: [number, number, number, number] | null = null;
async function regionBox() {
  if (region) return region;
  const { rows } = await pool.query(
    `SELECT ST_XMin(e) w, ST_YMin(e) s, ST_XMax(e) e, ST_YMax(e) n FROM (
       SELECT ST_Extent(geom) e FROM areas WHERE level = 'state' AND source = 'osm_boundary' AND deleted_at IS NULL) x`);
  const r = rows[0];
  if (r?.w != null) region = [r.w, r.s, r.e, r.n];
  return region;
}

type Box = [number, number, number, number];
type Result = { label: string; lon: number; lat: number; bbox: Box | null; kind: string | null };

/** One Nominatim search, inside a box when there is one. */
async function search(q: string, box: Box | null): Promise<Result[]> {
  const url = new URL("/search", config.geocoderUrl);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "6");
  url.searchParams.set("addressdetails", "0");
  // Streets come from a US state extract, so nothing outside the country is any use.
  url.searchParams.set("countrycodes", "us");
  if (box) {
    url.searchParams.set("viewbox", box.join(","));
    url.searchParams.set("bounded", "1");
  }
  const res = await paced(() => fetch(url, { headers: { "User-Agent": UA(), "Accept-Language": "en" }, signal: AbortSignal.timeout(10_000) }))
    .catch(() => { throw new HttpError(502, "The address search didn't answer. Try again in a moment."); });
  if (!res.ok) throw new HttpError(502, res.status === 429 ? "The address search is busy. Try again in a minute." : "The address search didn't answer.");
  const rows = (await res.json()) as { display_name: string; lat: string; lon: string; boundingbox?: string[]; type?: string; class?: string }[];
  return rows.map((r) => ({
    label: r.display_name,
    lon: Number(r.lon),
    lat: Number(r.lat),
    // Nominatim gives [south, north, west, east].
    bbox: r.boundingbox ? [Number(r.boundingbox[2]), Number(r.boundingbox[0]), Number(r.boundingbox[3]), Number(r.boundingbox[1])] : null,
    kind: r.type ?? r.class ?? null,
  }));
}

/** "w,s,e,n" from the web (the map view, widened), rounded so nearby views share a cache entry. */
function parseNear(near: string | undefined): Box | null {
  const n = (near ?? "").split(",").map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return null;
  const [w, s, e, nn] = n;
  if (w >= e || s >= nn || w < -180 || e > 180 || s < -90 || nn > 90 || e - w > 20) return null;
  const r = (x: number, up: boolean) => (up ? Math.ceil(x * 10) : Math.floor(x * 10)) / 10;
  return [r(w, false), r(s, false), r(e, true), r(nn, true)];
}

export default async function geocodeRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string; near?: string } }>("/api/geocode", async (req) => {
    requireUser(req);
    const q = (req.query.q ?? "").trim().replace(/\s+/g, " ");
    if (q.length < 3 || q.length > 200) throw badRequest("Type at least a few letters of an address.");
    const box = await regionBox();
    const near = parseNear(req.query.near);
    // Keyed by the region and the view too, so answers from elsewhere aren't reused.
    const key = `${box?.join(",") ?? "us"}|${near?.join(",") ?? ""}|${q.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return { results: hit.results };

    // Where you're looking first ("Main St" means the one here); then the whole region.
    let results = near ? await search(q, near) : [];
    if (!results.length) results = await search(q, box);
    if (cache.size > 1000) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), results });
    return { results };
  });
}
