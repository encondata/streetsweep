// Water, as a drawing aid for areas: cut the mapped water out of a rough outline, and
// the shorelines in view for corners to snap to. The water itself comes from the street
// extract (osm/water.ts).
import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { requireUser } from "../auth.js";
import { badRequest } from "../http.js";

const OUTLINE = `ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)), 3))`;
/** About 3 m: a shoreline keeps its shape without thousands of corners to drag. */
const SIMPLIFY = 0.00003;

export default async function waterRoutes(app: FastifyInstance) {
  /**
   * The outline with the water cut out. Draw boldly into the lake, then trim: the edge
   * follows the shore. Slivers left over (a strip of beach, the far shore just caught)
   * are dropped, and so are holes (a pond inside the area doesn't matter to its streets,
   * and the drawing tools work with outer edges only).
   */
  app.post<{ Body: { geometry: unknown } }>(
    "/api/water/trim",
    { schema: { body: { type: "object", required: ["geometry"], properties: { geometry: { type: "object" } } } } },
    async (req) => {
      requireUser(req);
      const { rows } = await query<{ geom: string | null; before: number; after: number; water: boolean; corners: number }>(
        `WITH g AS (SELECT ${OUTLINE} AS g),
         w AS (SELECT ST_Union(p.geom) AS w FROM water_parts p, g WHERE p.geom && g.g AND ST_Intersects(p.geom, g.g)),
         d AS (SELECT CASE WHEN w.w IS NULL THEN g.g
                           ELSE ST_CollectionExtract(ST_MakeValid(ST_Difference(g.g, w.w)), 3) END AS d
                 FROM g, w),
         pieces AS (SELECT ST_MakePolygon(ST_ExteriorRing(x.geom)) AS p FROM d, ST_Dump(d.d) x),
         kept AS (SELECT ST_SimplifyPreserveTopology(p, ${SIMPLIFY}) AS p FROM pieces
                   WHERE ST_Area(p::geography) >= greatest(1500, 0.02 * (SELECT max(ST_Area(p::geography)) FROM pieces)))
         SELECT (SELECT ST_AsGeoJSON(ST_Multi(ST_Collect(p)), 7) FROM kept) AS geom,
                (SELECT ST_Area(g::geography) FROM g)::float AS before,
                coalesce((SELECT ST_Area(ST_Collect(p)::geography) FROM kept), 0)::float AS after,
                (SELECT w IS NOT NULL FROM w) AS water,
                coalesce((SELECT sum(ST_NPoints(p)) FROM kept), 0)::int AS corners`,
        [JSON.stringify(req.body.geometry)],
      ).catch(() => {
        throw badRequest("That outline isn't a shape we can use. Try drawing it again.");
      });
      const r = rows[0];
      if (!r.water) return { geometry: null, removed_m2: 0, note: "No mapped water inside the outline." };
      if (!r.geom) throw badRequest("That outline is all water: nothing would be left.");
      return { geometry: JSON.parse(r.geom), removed_m2: Math.round(r.before - r.after), corners: r.corners };
    },
  );

  /** Shorelines in view, for snapping corners to while drawing. Only close in: a city's worth at most. */
  app.get<{ Querystring: { bbox?: string } }>("/api/water/shores", async (req, reply) => {
    requireUser(req);
    const b = (req.query.bbox ?? "").split(",").map(Number);
    if (b.length !== 4 || b.some((n) => !Number.isFinite(n)) || b[0] >= b[2] || b[1] >= b[3]) throw badRequest("bbox=w,s,e,n");
    if (b[2] - b[0] > 0.4 || b[3] - b[1] > 0.4) return { lines: [] };
    const { rows } = await query<{ c: string }>(
      `SELECT ST_AsGeoJSON(ST_SimplifyPreserveTopology(ST_Intersection(geom, e), 0.000005), 6) AS c
         FROM water_shores, ST_MakeEnvelope($1, $2, $3, $4, 4326) e
        WHERE geom && e LIMIT 4000`,
      b,
    );
    reply.header("Cache-Control", "private, max-age=3600");
    const lines: [number, number][][] = [];
    for (const r of rows) {
      const g = JSON.parse(r.c) as { type: string; coordinates: unknown };
      if (g.type === "LineString") lines.push(g.coordinates as [number, number][]);
      else if (g.type === "MultiLineString") lines.push(...(g.coordinates as [number, number][][]));
    }
    return { lines: lines.filter((l) => l.length >= 2) };
  });
}
