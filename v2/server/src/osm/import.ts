// The street import: Geofabrik extract → osmium → segments in PostGIS. Runs in the
// worker as the "osm-import" job (one at a time); progress is written to osm_imports
// so the admin page can show it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { config } from "../config.js";
import { pool } from "../db.js";
import { NodeCounter, copyField, lineEwkt, parseWayLine, splitWay } from "./opl.js";

/** The kinds of road that count as streets to sweep (and their ramps). Same as v1. */
export const SWEEPABLE = ["primary", "secondary", "tertiary", "unclassified", "residential", "living_street"];
/**
 * Highways: imported and drawn so they can be marked, but counted only by teams that
 * choose to (teams.count_highways). No ramps: a freeway's are a tangle of short pieces.
 */
export const MAJOR = ["trunk", "motorway"];
const HIGHWAYS = [...SWEEPABLE.flatMap((h) => [h, `${h}_link`]), ...MAJOR];
/** Tags worth keeping on a street; the rest of OpenStreetMap's are dropped. */
const KEEP_TAGS = ["name", "ref", "oneway", "junction", "access", "surface", "lanes", "maxspeed", "service"];

const OSM_DIR = () => path.join(config.dataDir, "osm");
export const regionOf = (url: string) => path.basename(new URL(url).pathname).replace(/-latest\.osm\.pbf$|\.osm\.pbf$/, "");

type Progress = (step: string, extra?: Record<string, unknown>) => Promise<void>;

/** Run a command, streaming its stdout lines to `onLine`. Rejects on a non-zero exit. */
function runLines(cmd: string, args: string[], onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", onLine ? "pipe" : "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    if (onLine && child.stdout) {
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on("line", onLine);
    }
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`))));
  });
}

/** Lines of a command's output, as an async iterator (for the long passes). */
async function* commandLines(cmd: string, args: string[]): AsyncGenerator<string> {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
  const done = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of rl) yield line;
  const code = await done;
  if (code !== 0) throw new Error(`${cmd} exited ${code}: ${stderr.trim()}`);
}

/**
 * Fetch the extract unless the copy on disk is already the current one. Geofabrik's
 * Last-Modified decides; returns whether a new file arrived.
 */
async function download(url: string, dest: string, progress: Progress): Promise<{ fresh: boolean; bytes: number }> {
  const metaFile = dest + ".json";
  const meta = await fsp.readFile(metaFile, "utf8").then(JSON.parse).catch(() => null);
  const ua = `StreetSweep/2 (street coverage; ${config.contactEmail || "self-hosted"})`;
  const head = await fetch(url, { method: "HEAD", headers: { "User-Agent": ua } });
  if (!head.ok) throw new Error(`Couldn't reach ${url}: HTTP ${head.status}`);
  const lastModified = head.headers.get("last-modified");
  const total = Number(head.headers.get("content-length") ?? 0);
  if (meta?.lastModified && meta.lastModified === lastModified && fs.existsSync(dest)) {
    return { fresh: false, bytes: (await fsp.stat(dest)).size };
  }
  const res = await fetch(url, { headers: { "User-Agent": ua } });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const tmp = dest + ".part";
  let got = 0;
  let lastReport = 0;
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => {
    got += chunk.length;
    if (Date.now() - lastReport > 3000) {
      lastReport = Date.now();
      const mb = (n: number) => Math.round(n / 1e6);
      void progress(`Downloading ${mb(got)}${total ? ` of ${mb(total)}` : ""} MB`);
    }
  });
  await pipeline(body, fs.createWriteStream(tmp));
  await fsp.rename(tmp, dest);
  await fsp.writeFile(metaFile, JSON.stringify({ url, lastModified, bytes: got, at: new Date().toISOString() }));
  return { fresh: true, bytes: got };
}

/** A COPY into a staging table that respects backpressure. */
class CopyWriter {
  private stream: NodeJS.WritableStream;
  private finished: Promise<void>;

  constructor(private client: pg.PoolClient, sql: string) {
    this.stream = client.query(copyFrom(sql));
    this.finished = new Promise((resolve, reject) => {
      this.stream.on("finish", () => resolve());
      this.stream.on("error", reject);
    });
  }

  async write(line: string) {
    if (!this.stream.write(line)) await new Promise<void>((ok) => this.stream.once("drain", () => ok()));
  }

  async end() {
    this.stream.end();
    await this.finished;
  }
}

function oneway(tags: Record<string, string>): boolean {
  const v = tags.oneway;
  return v === "yes" || v === "1" || v === "true" || v === "-1" || tags.junction === "roundabout";
}

/** Streets only; the caller finishes the run (boundaries, then status 'done'). */
export async function runImport(opts: { importId: number; url: string; force: boolean }): Promise<"imported" | "skipped"> {
  const { importId, url } = opts;
  const progress: Progress = async (step, extra = {}) => {
    const sets = ["step = $2", ...Object.keys(extra).map((k, i) => `${k} = $${i + 3}`)];
    await pool.query(`UPDATE osm_imports SET ${sets.join(", ")} WHERE id = $1`, [importId, step, ...Object.values(extra)]);
  };

  await fsp.mkdir(OSM_DIR(), { recursive: true });
  const region = regionOf(url);
  const pbf = path.join(OSM_DIR(), `${region}.osm.pbf`);
  const roads = path.join(OSM_DIR(), `${region}-streets.osm.pbf`);

  await progress("Checking for a new extract");
  const dl = await download(url, pbf, progress);
  let osmTime: string | null = null;
  await runLines("osmium", ["fileinfo", "-g", "header.option.osmosis_replication_timestamp", pbf], (l) => {
    if (l.trim()) osmTime = l.trim();
  }).catch(() => {});
  await progress(dl.fresh ? "Downloaded" : "Extract unchanged", { file_bytes: dl.bytes, osm_timestamp: osmTime });

  if (!dl.fresh && !opts.force) {
    const prev = await pool.query(
      `SELECT 1 FROM osm_imports WHERE id <> $1 AND region = $2 AND status = 'done' AND osm_timestamp IS NOT DISTINCT FROM $3 LIMIT 1`,
      [importId, region, osmTime],
    );
    if (prev.rows.length) {
      await pool.query(`UPDATE osm_imports SET status = 'skipped', step = 'Already up to date', finished_at = now() WHERE id = $1`, [importId]);
      return "skipped";
    }
  }

  await progress("Picking out the streets");
  await runLines("osmium", ["tags-filter", pbf, `w/highway=${HIGHWAYS.join(",")}`, "-o", roads, "--overwrite"]);

  // Pass 1: every node every street uses, to find where streets meet.
  await progress("Finding intersections");
  const counter = new NodeCounter();
  let ways = 0;
  for await (const line of commandLines("osmium", ["cat", roads, "-t", "way", "-f", "opl,add_metadata=false"])) {
    const w = parseWayLine(line);
    if (!w || w.refs.length < 2) continue;
    counter.add(w.refs);
    if (++ways % 200_000 === 0) await progress(`Finding intersections (${ways.toLocaleString()} streets)`);
  }
  const shared = counter.shared();
  await progress(`Splitting ${ways.toLocaleString()} streets at ${shared.length.toLocaleString()} intersections`, { ways });

  // Pass 2: the same ways with their node locations, cut and streamed into staging.
  const wayClient = await pool.connect();
  const segClient = await pool.connect();
  let segments = 0;
  try {
    await wayClient.query("TRUNCATE import_ways");
    await segClient.query("TRUNCATE import_segments");
    const wayCopy = new CopyWriter(wayClient, "COPY import_ways (way_id, name, highway, oneway, tags) FROM STDIN");
    const segCopy = new CopyWriter(segClient, "COPY import_segments (way_id, from_node, to_node, dup, geom) FROM STDIN");
    let done = 0;
    for await (const line of commandLines("osmium", ["add-locations-to-ways", roads, "-f", "opl,add_metadata=false"])) {
      const w = parseWayLine(line);
      if (!w || !w.coords || w.refs.length < 2 || !w.tags.highway) continue;
      const kept: Record<string, string> = {};
      for (const k of KEEP_TAGS) if (w.tags[k] !== undefined) kept[k] = w.tags[k];
      await wayCopy.write([w.id, copyField(w.tags.name ?? null), copyField(w.tags.highway), oneway(w.tags), copyField(JSON.stringify(kept))].join("\t") + "\n");
      for (const s of splitWay(w.refs, w.coords, shared)) {
        await segCopy.write(`${w.id}\t${s.from}\t${s.to}\t${s.dup}\t${lineEwkt(s.coords)}\n`);
        segments++;
      }
      if (++done % 100_000 === 0) await progress(`Splitting streets (${done.toLocaleString()} of ${ways.toLocaleString()})`, { segments });
    }
    await wayCopy.end();
    await segCopy.end();
  } finally {
    wayClient.release();
    segClient.release();
  }

  // Merge. Unchanged pieces aren't rewritten; pieces missing from this extract retire.
  await progress(`Saving ${segments.toLocaleString()} street segments`, { segments });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL work_mem = '256MB'");
    await client.query(`CREATE INDEX ON import_segments (way_id, from_node, to_node, dup)`);
    await client.query(`CREATE INDEX ON import_ways (way_id)`);
    await client.query("ANALYZE import_ways");
    await client.query("ANALYZE import_segments");

    await client.query(
      `INSERT INTO street_ways AS w (way_id, name, highway, oneway, tags, import_id)
       SELECT DISTINCT ON (way_id) way_id, name, highway, oneway, tags, $1 FROM import_ways
       ON CONFLICT (way_id) DO UPDATE
         SET name = EXCLUDED.name, highway = EXCLUDED.highway, oneway = EXCLUDED.oneway, tags = EXCLUDED.tags,
             import_id = EXCLUDED.import_id, retired_at = NULL, updated_at = now()
         WHERE (w.name, w.highway, w.oneway, w.tags) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.highway, EXCLUDED.oneway, EXCLUDED.tags)
            OR w.retired_at IS NOT NULL`,
      [importId],
    );
    await client.query(
      `UPDATE street_ways w SET retired_at = now()
        WHERE retired_at IS NULL AND NOT EXISTS (SELECT 1 FROM import_ways i WHERE i.way_id = w.way_id)`,
    );

    const merged = await client.query<{ added: number; changed: number }>(
      `WITH up AS (
         INSERT INTO street_segments AS s (way_id, from_node, to_node, dup, geom, length_m, import_id)
         SELECT way_id, from_node, to_node, dup, geom, ST_Length(geom::geography), $1 FROM import_segments
         ON CONFLICT (way_id, from_node, to_node, dup) DO UPDATE
           SET geom = EXCLUDED.geom, length_m = EXCLUDED.length_m, import_id = EXCLUDED.import_id,
               retired_at = NULL, updated_at = now()
           WHERE NOT ST_OrderingEquals(s.geom, EXCLUDED.geom) OR s.retired_at IS NOT NULL
         RETURNING (xmax = 0) AS inserted
       )
       SELECT count(*) FILTER (WHERE inserted)::int AS added, count(*) FILTER (WHERE NOT inserted)::int AS changed FROM up`,
      [importId],
    );
    const retired = await client.query(
      `UPDATE street_segments s SET retired_at = now()
        WHERE retired_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM import_segments i
           WHERE (i.way_id, i.from_node, i.to_node, i.dup) = (s.way_id, s.from_node, s.to_node, s.dup))`,
    );
    await client.query("TRUNCATE import_ways, import_segments");
    // The staging indexes go with a TRUNCATE's new storage only partly; drop them so the
    // next run's COPY isn't slowed by maintaining them.
    await client.query(`DROP INDEX IF EXISTS import_segments_way_id_from_node_to_node_dup_idx`);
    await client.query(`DROP INDEX IF EXISTS import_ways_way_id_idx`);
    await client.query(
      `UPDATE osm_imports SET step = 'Streets saved', ways = $2, segments = $3,
              added = $4, changed = $5, retired = $6 WHERE id = $1`,
      [importId, ways, segments, merged.rows[0].added, merged.rows[0].changed, retired.rowCount ?? 0],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await pool.query("ANALYZE street_segments");
  await pool.query("ANALYZE street_ways");
  return "imported";
}
