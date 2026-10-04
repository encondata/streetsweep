// Water from the extract: lakes, ponds, reservoirs and river banks, for drawing areas
// (trimming water out of an outline, snapping corners to a shoreline). Streamed straight
// into Postgres: Texas alone has a few hundred thousand ponds.
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { config } from "../config.js";
import { pool } from "../db.js";
import { from as copyFrom } from "pg-copy-streams";
import { copyField } from "./opl.js";

/** Smaller than this is a garden pond: nothing anyone draws an area around. */
const MIN_M2 = 800;

export async function importWater(region: string, progress: (step: string) => Promise<void> = async () => {}): Promise<number> {
  const dir = path.join(config.dataDir, "osm");
  const pbf = path.join(dir, `${region}.osm.pbf`);
  const out = path.join(dir, `${region}-water.osm.pbf`);

  await progress("Picking out water");
  await run("osmium", ["tags-filter", pbf, "nwr/natural=water", "nwr/waterway=riverbank", "nwr/landuse=reservoir,basin",
    "-o", out, "--overwrite"]);

  await progress("Loading water");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE import_water_tx (geojson text) ON COMMIT DROP`);
    const copy = client.query(copyFrom("COPY import_water_tx (geojson) FROM STDIN"));
    const copied = new Promise<void>((resolve, reject) => { copy.on("finish", () => resolve()); copy.on("error", reject); });
    await new Promise<void>((resolve, reject) => {
      const child = spawn("osmium", ["export", out, "-f", "geojsonseq", "-x", "print_record_separator=false",
        "--geometry-types=polygon", "-o", "-"], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => {
        let f: { geometry?: unknown };
        try { f = JSON.parse(line); } catch { return; }
        if (!f.geometry) return;
        // Keep up with Postgres: pause reading while the COPY buffer drains.
        if (!copy.write(copyField(JSON.stringify(f.geometry)) + "\n")) {
          lines.pause();
          copy.once("drain", () => lines.resume());
        }
      });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`osmium exited ${code}: ${stderr.trim()}`))));
    });
    copy.end();
    await copied;

    await progress("Shaping water");
    await client.query("SET LOCAL work_mem = '256MB'");
    await client.query(`CREATE TEMP TABLE water_tx ON COMMIT DROP AS
      SELECT g FROM (SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(geojson), 4326)), 3)) AS g
                       FROM import_water_tx) w
       WHERE NOT ST_IsEmpty(g) AND ST_Area(g::geography) >= ${MIN_M2}`);
    await client.query("TRUNCATE water_parts, water_shores");
    await client.query(`INSERT INTO water_parts (geom)
      SELECT (ST_Dump(ST_Subdivide(g, 256))).geom FROM water_tx`);
    await client.query(`INSERT INTO water_shores (geom)
      SELECT (ST_Dump(ST_Subdivide(ST_Boundary(g), 256))).geom FROM water_tx`);
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM water_tx`);
    await client.query("COMMIT");
    return rows[0].n;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`))));
  });
}
