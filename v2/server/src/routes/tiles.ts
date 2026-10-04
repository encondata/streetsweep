// Map tiles. Basemaps (OpenStreetMap, Esri imagery) are fetched once per tile and kept
// on disk for every browser and phone; street tiles are cut from PostGIS on request.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { query } from "../db.js";
import { requireUser } from "../auth.js";
import { badRequest, notFound } from "../http.js";
import { roleIn } from "../teams.js";

// Membership checks for coloured street tiles, remembered briefly (a map view asks for dozens).
const memberCache = new Map<string, number>();
async function isMember(teamId: string, userId: string): Promise<boolean> {
  const key = `${teamId}:${userId}`;
  const at = memberCache.get(key);
  if (at && Date.now() - at < 60_000) return true;
  const ok = !!(await roleIn(teamId, userId).catch(() => null));
  if (ok) memberCache.set(key, Date.now());
  return ok;
}

interface Source {
  url: (z: number, x: number, y: number) => string;
  ext: "png" | "jpg";
  type: string;
  maxZoom: number;
  /** Upstream requests in flight at once. OpenStreetMap asks for no more than two. */
  limit: number;
}

const fill = (tpl: string, z: number, x: number, y: number) =>
  tpl.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));

const SOURCES: Record<string, Source> = {
  osm: { url: (z, x, y) => fill(config.tileUrlOsm, z, x, y), ext: "png", type: "image/png", maxZoom: 19, limit: 2 },
  sat: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    ext: "jpg", type: "image/jpeg", maxZoom: 19, limit: 4,
  },
  ref: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`,
    ext: "png", type: "image/png", maxZoom: 19, limit: 4,
  },
};

const UA = () => `StreetSweep/2 (self-hosted street coverage; ${config.contactEmail || "no contact set"})`;
const TILE_DIR = () => path.join(config.dataDir, "tiles");

// A small per-source gate, so a fast pan doesn't open fifty connections to one host.
const active: Record<string, number> = {};
const waiting: Record<string, (() => void)[]> = {};
async function gate<T>(name: string, limit: number, fn: () => Promise<T>): Promise<T> {
  if ((active[name] ?? 0) >= limit) await new Promise<void>((ok) => (waiting[name] ??= []).push(ok));
  active[name] = (active[name] ?? 0) + 1;
  try {
    return await fn();
  } finally {
    active[name]--;
    waiting[name]?.shift()?.();
  }
}

// Two browsers asking for the same missing tile share one fetch.
const inflight = new Map<string, Promise<Buffer | null>>();

async function fetchTile(name: string, src: Source, z: number, x: number, y: number, file: string): Promise<Buffer | null> {
  const key = `${name}/${z}/${x}/${y}`;
  let p = inflight.get(key);
  if (!p) {
    p = gate(name, src.limit, async () => {
      const res = await fetch(src.url(z, x, y), { headers: { "User-Agent": UA() }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, file);
      return buf;
    }).catch(() => null).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

function tileArgs(p: { z: string; x: string; y: string }, maxZoom: number) {
  const z = Number(p.z), x = Number(p.x), y = Number(String(p.y).replace(/\.\w+$/, ""));
  const n = 2 ** z;
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > maxZoom || x < 0 || y < 0 || x >= n || y >= n) {
    throw badRequest("No such tile.");
  }
  return { z, x, y };
}

export default async function tileRoutes(app: FastifyInstance) {
  app.get<{ Params: { z: string; x: string; y: string }; Querystring: { team?: string } }>("/api/tiles/streets/:z/:x/:y", async (req, reply) => {
    const me = requireUser(req);
    const team = req.query.team && /^[0-9a-f-]{36}$/i.test(req.query.team) ? req.query.team : null;
    if (team && !me.is_site_admin && !(await isMember(team, me.id))) throw notFound("That team doesn't exist.");
    const { z, x, y } = tileArgs(req.params, 22);
    // Below zoom 12 a tile would hold most of a city: the map asks to zoom in instead.
    if (z < 12) return reply.code(204).send();
    const { rows } = await query<{ mvt: Buffer }>(
      `WITH b AS (SELECT ST_TileEnvelope($1, $2, $3) AS env)
       SELECT ST_AsMVT(t, 'streets', 4096, 'geom', 'id') AS mvt FROM (
         SELECT s.id, w.highway, w.name, s.length_m,
                -- For a team: done (driven), complete (marked by hand), excluded, or nothing.
                CASE WHEN mk.kind = 'excluded' THEN 'excluded' WHEN mk.kind = 'complete' THEN 'complete'
                     WHEN c.segment_id IS NOT NULL THEN 'done'
                     -- A highway this team doesn't count: drawn faint, still there to mark.
                     WHEN w.highway IN ('trunk', 'motorway') AND NOT coalesce((SELECT count_highways FROM teams WHERE id = $4), false) THEN 'nc'
                     END AS state,
                ST_AsMVTGeom(ST_Transform(s.geom, 3857), b.env, 4096, 64, true) AS geom
           FROM b, street_segments s JOIN street_ways w ON w.way_id = s.way_id
           LEFT JOIN team_coverage c ON c.team_id = $4 AND c.segment_id = s.id
           LEFT JOIN segment_marks mk ON mk.team_id = $4 AND mk.segment_id = s.id
          WHERE s.retired_at IS NULL AND s.geom && ST_Transform(b.env, 4326)
       ) t`,
      [z, x, y, team],
    );
    reply.header("Content-Type", "application/vnd.mapbox-vector-tile");
    // Coverage changes as drives land; plain street tiles hardly ever do.
    reply.header("Cache-Control", team ? "private, no-cache" : "private, max-age=300");
    return reply.send(rows[0]?.mvt ?? Buffer.alloc(0));
  });

  app.get<{ Params: { layer: string; z: string; x: string; y: string } }>("/api/tiles/:layer/:z/:x/:y", async (req, reply) => {
    requireUser(req);
    const src = SOURCES[req.params.layer];
    if (!src) throw notFound("No such map.");
    const { z, x, y } = tileArgs(req.params, src.maxZoom);
    const file = path.join(TILE_DIR(), req.params.layer, String(z), String(x), `${y}.${src.ext}`);
    const stat = await fsp.stat(file).catch(() => null);
    const fresh = stat && Date.now() - stat.mtimeMs < config.tileTtlDays * 86_400_000;
    reply.header("Content-Type", src.type);
    reply.header("Cache-Control", "private, max-age=86400");
    if (fresh) return reply.send(fs.createReadStream(file));
    const buf = await fetchTile(req.params.layer, src, z, x, y, file);
    if (buf) return reply.send(buf);
    // Upstream is down or refused: an old copy beats a hole in the map.
    if (stat) return reply.send(fs.createReadStream(file));
    return reply.code(502).send();
  });
}
