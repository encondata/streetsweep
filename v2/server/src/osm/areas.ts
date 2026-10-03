// Areas: public boundaries from the extract, and building any area's street list.
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { config } from "../config.js";
import { pool } from "../db.js";
import { from as copyFrom } from "pg-copy-streams";
import { copyField } from "./opl.js";

/** OpenStreetMap admin levels in the US, and what we call them. */
export const ADMIN_LEVELS: Record<number, "state" | "county" | "city"> = { 4: "state", 6: "county", 8: "city" };

/**
 * Import the region's state, county and city boundaries from the extract the street
 * import just used. Returns how many boundaries are now known.
 */
export async function importBoundaries(region: string, progress: (step: string) => Promise<void>): Promise<number> {
  const dir = path.join(config.dataDir, "osm");
  const pbf = path.join(dir, `${region}.osm.pbf`);
  const out = path.join(dir, `${region}-boundaries.osm.pbf`);

  await progress("Picking out boundaries");
  await run("osmium", ["tags-filter", pbf, "r/boundary=administrative", "-o", out, "--overwrite"]);

  await progress("Loading boundaries");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE import_boundaries_tx (relation_id bigint, name text, admin_level smallint, geojson text) ON COMMIT DROP`);
    const rows: string[] = [];
    // Relations become (multi)polygons; ones the extract cuts off at its edge can't be
    // assembled and are left out, which is what we want.
    await run("osmium", ["export", out, "-f", "geojsonseq", "-x", "print_record_separator=false",
      "--geometry-types=polygon", "-a", "type,id", "-o", "-"], (line) => {
      if (!line) return;
      let f: { properties?: Record<string, string>; geometry?: unknown };
      try { f = JSON.parse(line); } catch { return; }
      const p = f.properties ?? {};
      const level = Number(p.admin_level);
      if (p["@type"] !== "relation" || !ADMIN_LEVELS[level] || !p.name || !f.geometry) return;
      rows.push([Number(p["@id"]), copyField(p.name), level, copyField(JSON.stringify(f.geometry))].join("\t"));
    });
    await new Promise<void>((resolve, reject) => {
      const stream = client.query(copyFrom("COPY import_boundaries_tx (relation_id, name, admin_level, geojson) FROM STDIN"));
      stream.on("finish", () => resolve());
      stream.on("error", reject);
      for (const r of rows) stream.write(r + "\n");
      stream.end();
    });

    // Valid multipolygons only. An outline that changes bumps its version, so whatever
    // follows it is rebuilt.
    await client.query(
      `INSERT INTO areas AS a (source, osm_relation_id, admin_level, name, level, geom)
       SELECT 'osm_boundary', relation_id, admin_level, name,
              CASE admin_level WHEN 4 THEN 'state' WHEN 6 THEN 'county' ELSE 'city' END,
              g
         FROM (SELECT DISTINCT ON (relation_id) relation_id, admin_level, name,
                      ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(geojson), 4326)), 3)) AS g
                 FROM import_boundaries_tx) b
        WHERE NOT ST_IsEmpty(g)
       ON CONFLICT (osm_relation_id) WHERE source = 'osm_boundary' DO UPDATE
         SET name = EXCLUDED.name, admin_level = EXCLUDED.admin_level, level = EXCLUDED.level,
             geom = EXCLUDED.geom, deleted_at = NULL, updated_at = now(),
             version = a.version + CASE WHEN ST_Equals(a.geom, EXCLUDED.geom) THEN 0 ELSE 1 END
         WHERE a.name IS DISTINCT FROM EXCLUDED.name OR NOT ST_Equals(a.geom, EXCLUDED.geom) OR a.deleted_at IS NOT NULL`,
    );
    // Each boundary sits in the smallest wider one containing a point inside it.
    await client.query(
      `UPDATE areas c SET parent_id = (
         SELECT p.id FROM areas p
          WHERE p.source = 'osm_boundary' AND p.deleted_at IS NULL AND p.admin_level < c.admin_level
            AND p.geom && c.geom AND ST_Contains(p.geom, ST_PointOnSurface(c.geom))
          ORDER BY p.admin_level DESC LIMIT 1)
        WHERE c.source = 'osm_boundary' AND c.deleted_at IS NULL`,
    );
    // An extract's edges catch a few boundaries from over the border (Mexican
    // municipios came in as "counties" for Texas): keep only what lies in the state.
    await client.query(
      `UPDATE areas c SET deleted_at = now()
        WHERE c.source = 'osm_boundary' AND c.deleted_at IS NULL AND c.admin_level > 4
          AND NOT EXISTS (SELECT 1 FROM areas s WHERE s.source = 'osm_boundary' AND s.admin_level = 4
                            AND s.deleted_at IS NULL AND ST_Contains(s.geom, ST_PointOnSurface(c.geom)))`,
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM areas WHERE source = 'osm_boundary' AND deleted_at IS NULL`);
  return rows[0].n;
}

/**
 * Work out which streets are inside an area and how much of each. The outline is cut
 * into small pieces first so the spatial index does the work, even for a whole state.
 */
export async function buildArea(areaId: string): Promise<void> {
  const { rows } = await pool.query<{ version: number }>(
    `UPDATE areas SET build_status = 'building', build_error = NULL WHERE id = $1 AND deleted_at IS NULL RETURNING version`,
    [areaId],
  );
  if (!rows[0]) return; // deleted meanwhile
  const version = rows[0].version;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL work_mem = '128MB'");
    await client.query(`DELETE FROM area_segments WHERE area_id = $1`, [areaId]);
    await client.query(
      `INSERT INTO area_segments (area_id, segment_id, inside_m)
       SELECT $1, id, inside FROM (
         SELECT s.id, sum(CASE WHEN ST_CoveredBy(s.geom, p.g) THEN s.length_m
                               ELSE ST_Length(ST_Intersection(s.geom, p.g)::geography) END) AS inside
           FROM (SELECT ST_Subdivide(geom, 256) AS g FROM areas WHERE id = $1) p
           JOIN street_segments s ON s.geom && p.g AND ST_Intersects(s.geom, p.g)
          WHERE s.retired_at IS NULL
          GROUP BY s.id) x
        WHERE inside >= 1`,
      [areaId],
    );
    // Only record the result if the outline didn't change while we worked.
    await client.query(
      `UPDATE areas a SET build_status = 'built', built_version = $2, built_at = now(),
              segment_count = t.n, street_m = t.m
         FROM (SELECT count(*)::int AS n, coalesce(sum(inside_m), 0) AS m FROM area_segments WHERE area_id = $1) t
        WHERE a.id = $1 AND a.version = $2`,
      [areaId, version],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    await pool.query(`UPDATE areas SET build_status = 'failed', build_error = $2 WHERE id = $1`,
      [areaId, String((err as Error).message).slice(0, 500)]);
    throw err;
  } finally {
    client.release();
  }
}

/** Areas someone uses: every drawn one, and public ones a team follows. */
export async function areasInUse(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM areas WHERE deleted_at IS NULL AND (source = 'drawn' OR id IN (SELECT area_id FROM team_areas))`,
  );
  return rows.map((r) => r.id);
}

function run(cmd: string, args: string[], onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", onLine ? "pipe" : "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    if (onLine && child.stdout) readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", onLine);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`))));
  });
}
