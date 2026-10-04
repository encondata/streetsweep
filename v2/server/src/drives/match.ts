// Matching a drive to street segments (worker job "drive-match").
//
// Valhalla's map matching says which OpenStreetMap ways the car was on and where along
// them. A segment of one of those ways counts as driven when at least half of it lies
// within a few metres of the matched path. Only the ways driven count: crossing a side
// street at an intersection doesn't sweep it.
import { config } from "../config.js";
import { pool } from "../db.js";
import { thin, type Fix } from "./track.js";
import { addDrive, rebuildTeam, teamsForDrive } from "./coverage.js";

const CHUNK = 1500;
const OVERLAP = 10;
/** Of a segment, the share that has to be driven for it to count. */
export const MIN_FRACTION = 0.5;
/** How far from the matched path still counts as on it. */
const BUFFER_M = 8;
/** Without Valhalla (or where it can't match): the raw track, a little wider. */
const RAW_BUFFER_M = 12;
const RAW_MIN_FRACTION = 0.6;

/** Thrown when Valhalla can't be reached: the job retries later rather than failing the drive. */
export class ValhallaDown extends Error {}

type MatchedPiece = { w: number; g: { type: "LineString"; coordinates: number[][] } };

function decodePolyline6(str: string): number[][] {
  const coords: number[][] = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b: number;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d;
      else lon += d;
    }
    coords.push([lon / 1e6, lat / 1e6]);
  }
  return coords;
}

/** One request to Valhalla. null = it couldn't match this stretch (parking lot, off-road). */
async function trace(fixes: Fix[]): Promise<MatchedPiece[] | null> {
  let res: Response;
  try {
    res = await fetch(`${config.valhallaUrl.replace(/\/$/, "")}/trace_attributes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        shape: fixes.map((f) => ({ lat: f.lat, lon: f.lon, time: Math.round(f.t) })),
        costing: "auto",
        shape_match: "map_snap",
        trace_options: { search_radius: 35, gps_accuracy: 10, breakage_distance: 2000 },
        filters: { attributes: ["edge.way_id", "edge.begin_shape_index", "edge.end_shape_index", "shape"], action: "include" },
      }),
    });
  } catch (err) {
    throw new ValhallaDown(`Valhalla isn't answering (${(err as Error).message})`);
  }
  if (res.status >= 500 || res.status === 404) throw new ValhallaDown(`Valhalla answered HTTP ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as {
    edges?: { way_id?: number; begin_shape_index?: number; end_shape_index?: number }[];
    shape?: string;
    error?: string;
  };
  if (!res.ok || !body.shape || !body.edges) return null;
  const shape = decodePolyline6(body.shape);
  const out: MatchedPiece[] = [];
  for (const e of body.edges) {
    if (e.way_id === undefined || e.begin_shape_index === undefined || e.end_shape_index === undefined) continue;
    const coords = shape.slice(e.begin_shape_index, e.end_shape_index + 1);
    if (coords.length >= 2) out.push({ w: e.way_id, g: { type: "LineString", coordinates: coords } });
  }
  return out;
}

async function trackOf(driveId: string): Promise<Fix[]> {
  const { rows } = await pool.query<{ lon: number; lat: number; t: number }>(
    `SELECT ST_X(p.geom) AS lon, ST_Y(p.geom) AS lat, ST_M(p.geom) AS t
       FROM drives d, ST_DumpPoints(d.track) p WHERE d.id = $1 ORDER BY p.path`,
    [driveId],
  );
  return rows.map((r) => ({ lon: r.lon, lat: r.lat, t: r.t, acc: null, speed: null }));
}

export async function matchDrive(driveId: string): Promise<{ segments: number; method: string }> {
  const { rows } = await pool.query<{ deleted: boolean }>(
    `UPDATE drives SET status = 'matching' WHERE id = $1 RETURNING deleted_at IS NOT NULL AS deleted`, [driveId],
  );
  if (!rows[0] || rows[0].deleted) return { segments: 0, method: "none" };
  const wasMatched = (await pool.query(`SELECT 1 FROM segment_passes WHERE drive_id = $1 LIMIT 1`, [driveId])).rows.length > 0;

  const fixes = thin(await trackOf(driveId), 5);
  const useValhalla = config.valhallaUrl && config.valhallaUrl !== "none";
  const pieces: MatchedPiece[] = [];
  const unmatched: Fix[][] = [];
  if (useValhalla) {
    for (let start = 0; start < fixes.length - 1; start += CHUNK - OVERLAP) {
      const chunk = fixes.slice(start, start + CHUNK);
      if (chunk.length < 2) break;
      const got = await trace(chunk);
      if (got) pieces.push(...got);
      else unmatched.push(chunk);
    }
  } else {
    unmatched.push(fixes);
  }

  const teamsBefore = wasMatched ? await teamsForDrive(pool, driveId) : [];
  const client = await pool.connect();
  let segments = 0;
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM segment_passes WHERE drive_id = $1`, [driveId]);
    if (pieces.length) {
      await client.query(
        `WITH e AS (
           SELECT (x->>'w')::bigint AS way_id, ST_SetSRID(ST_GeomFromGeoJSON(x->>'g'), 4326) AS g
             FROM jsonb_array_elements($2::jsonb) x
         ), b AS (
           SELECT way_id, ST_Union(ST_Buffer(g::geography, $3)::geometry) AS buf FROM e GROUP BY way_id
         ), hit AS (
           SELECT s.id, s.geom, s.length_m, ST_Length(ST_Intersection(s.geom, b.buf)::geography) AS inside
             FROM b JOIN street_segments s ON s.way_id = b.way_id AND s.retired_at IS NULL AND s.geom && b.buf
         )
         INSERT INTO segment_passes (drive_id, segment_id, driven_at, fraction)
         SELECT $1, h.id, to_timestamp(ST_InterpolatePoint(d.track, ST_LineInterpolatePoint(h.geom, 0.5))),
                least(1, h.inside / nullif(h.length_m, 0))
           FROM hit h, drives d
          WHERE d.id = $1 AND h.inside / nullif(h.length_m, 0) >= $4
         ON CONFLICT DO NOTHING`,
        [driveId, JSON.stringify(pieces), BUFFER_M, MIN_FRACTION],
      );
    }
    for (const part of unmatched) {
      if (part.length < 2) continue;
      const line = { type: "LineString", coordinates: part.map((f) => [f.lon, f.lat]) };
      await client.query(
        `WITH b AS (SELECT ST_Buffer(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)::geography, $3)::geometry AS buf),
         hit AS (
           SELECT s.id, s.geom, s.length_m, ST_Length(ST_Intersection(s.geom, b.buf)::geography) AS inside
             FROM b JOIN street_segments s ON s.retired_at IS NULL AND s.geom && b.buf
         )
         INSERT INTO segment_passes (drive_id, segment_id, driven_at, fraction)
         SELECT $1, h.id, to_timestamp(ST_InterpolatePoint(d.track, ST_LineInterpolatePoint(h.geom, 0.5))),
                least(1, h.inside / nullif(h.length_m, 0))
           FROM hit h, drives d
          WHERE d.id = $1 AND h.inside / nullif(h.length_m, 0) >= $4
         ON CONFLICT DO NOTHING`,
        [driveId, JSON.stringify(line), RAW_BUFFER_M, RAW_MIN_FRACTION],
      );
    }
    const { rows: c } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM segment_passes WHERE drive_id = $1`, [driveId]);
    segments = c[0].n;
    const method = useValhalla && pieces.length ? "valhalla" : "geometric";
    await client.query(
      `UPDATE drives SET status = 'matched', match_method = $2, match_error = NULL, matched_at = now(), segment_count = $3, updated_at = now()
        WHERE id = $1`,
      [driveId, method, segments],
    );
    // A first match adds to coverage; a re-match recounts the teams involved.
    if (!wasMatched) await addDrive(client, driveId);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (wasMatched) {
    const after = await teamsForDrive(pool, driveId);
    for (const t of new Set([...teamsBefore, ...after])) await rebuildTeam(t);
  }
  return { segments, method: useValhalla && pieces.length ? "valhalla" : "geometric" };
}
