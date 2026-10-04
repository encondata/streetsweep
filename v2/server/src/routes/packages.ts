// Streets for phones, so they can draw, guide and preview coverage offline.
//
//   GET /api/areas/:id/package      an area's street segments (gzip JSON, cached per build)
//   GET /api/segments?bbox=w,s,e,n  the segments in a small box (for areas too big to package)
//
// Compact on purpose: names and road types are listed once and referred to by index, and
// each segment's line is a Google encoded polyline at precision 6.
//   { names: [...], highways: [...],
//     segments: [[id, way_id, name_index|-1, highway_index, length_m, inside_m?, polyline]] }
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { config } from "../config.js";
import { requireUser, type SessionUser } from "../auth.js";
import { badRequest, notFound } from "../http.js";

const gzip = promisify(zlib.gzip);
const PACKAGE_DIR = () => path.join(config.dataDir, "packages");
/** Past this an area is a county-plus: the phone loads its streets by box instead. */
export const MAX_PACKAGE_SEGMENTS = 250_000;
/** A box request covers at most this many degrees each way (about 14 miles). */
const MAX_BOX_DEG = 0.2;

type Row = { id: string; way_id: string; name: string | null; highway: string; length_m: number; inside_m?: number; line: string };

function pack(rows: Row[], withInside: boolean) {
  const names: string[] = [], highways: string[] = [];
  const nameAt = new Map<string, number>(), hwAt = new Map<string, number>();
  const idx = (m: Map<string, number>, list: string[], v: string) => {
    let i = m.get(v);
    if (i === undefined) m.set(v, (i = list.push(v) - 1));
    return i;
  };
  const segments = rows.map((r) => {
    const out: (string | number)[] = [
      Number(r.id), Number(r.way_id), r.name ? idx(nameAt, names, r.name) : -1, idx(hwAt, highways, r.highway),
      Math.round(r.length_m * 10) / 10,
    ];
    if (withInside) out.push(Math.round((r.inside_m ?? 0) * 10) / 10);
    out.push(r.line);
    return out;
  });
  return { names, highways, segments };
}

/** You may download an area your teams draw or follow. */
async function trackedArea(id: string, me: SessionUser) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("That area doesn't exist.");
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.build_status, a.built_version, a.segment_count FROM areas a
      WHERE a.id = $1 AND a.deleted_at IS NULL AND ($3 OR a.team_id IN (SELECT team_id FROM team_members WHERE user_id = $2 AND left_at IS NULL)
         OR a.id IN (SELECT ta.area_id FROM team_areas ta JOIN team_members m ON m.team_id = ta.team_id WHERE m.user_id = $2 AND m.left_at IS NULL))`,
    [id, me.id, me.is_site_admin],
  );
  if (!rows[0]) throw notFound("That area doesn't exist.");
  return rows[0];
}

export default async function packageRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/areas/:id/package", async (req, reply) => {
    const me = requireUser(req);
    const a = await trackedArea(req.params.id, me);
    if (a.build_status !== "built") return reply.code(409).send({ error: "This area's streets are still being listed. Try again shortly.", code: "not_built" });
    if (a.segment_count > MAX_PACKAGE_SEGMENTS) {
      return reply.code(413).send({ error: "This area is too big to download whole; its streets load as you go.", code: "too_big" });
    }
    const etag = `"${a.id}-${a.built_version}"`;
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    const file = path.join(PACKAGE_DIR(), `${a.id}-v${a.built_version}.json.gz`);
    let body: Buffer;
    try {
      body = await fs.readFile(file);
    } catch {
      const { rows } = await pool.query<Row>(
        `SELECT s.id, s.way_id, w.name, w.highway, s.length_m, x.inside_m, ST_AsEncodedPolyline(s.geom, 6) AS line
           FROM area_segments x JOIN street_segments s ON s.id = x.segment_id JOIN street_ways w ON w.way_id = s.way_id
          WHERE x.area_id = $1 AND s.retired_at IS NULL AND NOT x.major ORDER BY s.id`, [a.id]);
      body = await gzip(JSON.stringify({ area_id: a.id, version: a.built_version, ...pack(rows, true) }));
      await fs.mkdir(PACKAGE_DIR(), { recursive: true });
      // Older builds of this area are no use to anyone now.
      for (const f of await fs.readdir(PACKAGE_DIR())) if (f.startsWith(`${a.id}-v`) && f !== path.basename(file)) await fs.rm(path.join(PACKAGE_DIR(), f), { force: true });
      await fs.writeFile(file, body);
    }
    reply.header("Content-Type", "application/json").header("Content-Encoding", "gzip").header("ETag", etag)
      .header("Cache-Control", "private, no-cache");
    return reply.send(body);
  });

  app.get<{ Querystring: { bbox?: string } }>("/api/segments", async (req, reply) => {
    requireUser(req);
    const b = (req.query.bbox ?? "").split(",").map(Number);
    if (b.length !== 4 || b.some((n) => !Number.isFinite(n)) || b[0] >= b[2] || b[1] >= b[3]) throw badRequest("Give bbox=west,south,east,north.");
    if (b[2] - b[0] > MAX_BOX_DEG || b[3] - b[1] > MAX_BOX_DEG) throw badRequest(`A box can be at most ${MAX_BOX_DEG}° each way.`);
    const { rows } = await pool.query<Row>(
      `SELECT s.id, s.way_id, w.name, w.highway, s.length_m, ST_AsEncodedPolyline(s.geom, 6) AS line
         FROM street_segments s JOIN street_ways w ON w.way_id = s.way_id
        WHERE s.retired_at IS NULL AND s.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
          -- The phone doesn't show highways yet (they count only by choice; see migration 0015).
          AND w.highway NOT IN ('trunk', 'motorway') ORDER BY s.id`, b);
    const body = await gzip(JSON.stringify({ bbox: b, ...pack(rows, false) }));
    reply.header("Content-Type", "application/json").header("Content-Encoding", "gzip").header("Cache-Control", "private, max-age=3600");
    return reply.send(body);
  });
}
