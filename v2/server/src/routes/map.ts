// What the map needs to know about the street data, and the admin's import controls.
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { query } from "../db.js";
import { requireSiteAdmin, requireUser } from "../auth.js";
import { sendJob } from "../jobs.js";
import { regionOf } from "../osm/import.js";

export default async function mapRoutes(app: FastifyInstance) {
  // Where the streets are and how fresh they are; the map opens on them.
  app.get("/api/map/info", async (req) => {
    requireUser(req);
    const { rows } = await query(
      `SELECT (SELECT row_to_json(i) FROM (SELECT id, region, osm_timestamp, finished_at FROM osm_imports
                WHERE status = 'done' ORDER BY id DESC LIMIT 1) i) AS last_import,
              (SELECT row_to_json(i) FROM (SELECT id, step, started_at FROM osm_imports
                WHERE status = 'running' ORDER BY id DESC LIMIT 1) i) AS running,
              (SELECT ST_AsGeoJSON(ST_EstimatedExtent('public', 'street_segments', 'geom'))::json) AS extent`,
    ).catch(() => ({ rows: [{ last_import: null, running: null, extent: null }] }));
    const ext = rows[0].extent as { coordinates: number[][][] } | null;
    let bbox: number[] | null = null;
    if (ext?.coordinates) {
      const pts = ext.coordinates[0];
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    return { region: regionOf(config.osmExtractUrl), last_import: rows[0].last_import, running: rows[0].running, bbox };
  });

  app.get("/api/admin/osm-imports", async (req) => {
    requireSiteAdmin(req);
    const runs = await query(
      `SELECT i.id, i.region, i.status, i.step, i.osm_timestamp, i.file_bytes, i.ways, i.segments, i.added, i.changed,
              i.retired, i.error, i.started_at, i.finished_at, u.display_name AS requested_by_name
         FROM osm_imports i LEFT JOIN users u ON u.id = i.requested_by ORDER BY i.id DESC LIMIT 20`,
    );
    const totals = await query(
      `SELECT count(*)::int AS segments, coalesce(sum(length_m), 0)::float AS meters,
              (SELECT count(*)::int FROM street_ways WHERE retired_at IS NULL) AS ways
         FROM street_segments WHERE retired_at IS NULL`,
    );
    return { source_url: config.osmExtractUrl, region: regionOf(config.osmExtractUrl), runs: runs.rows, totals: totals.rows[0] };
  });

  app.post<{ Body: { force?: boolean } }>(
    "/api/admin/osm-imports",
    { schema: { body: { type: ["object", "null"], properties: { force: { type: "boolean" } } } } },
    async (req, reply) => {
      const me = requireSiteAdmin(req);
      const id = await sendJob("osm-import", { force: req.body?.force ?? true, requestedBy: me.id });
      // null: the singleton queue already holds one waiting or running.
      return reply.code(202).send({ queued: !!id });
    },
  );
}
