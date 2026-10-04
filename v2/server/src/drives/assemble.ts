// Cutting a logger's stream of fixes into drives (worker job "logger-assemble").
// A logger records whenever it moves; a quiet spell longer than GAP_S ends a drive.
import crypto from "node:crypto";
import { pool } from "../db.js";
import { forLogger } from "./attribution.js";
import { insertDrive, MIN_DISTANCE_M, MIN_POINTS } from "./ingest.js";
import { distanceOf, splitAtGaps, type Fix } from "./track.js";

export const GAP_S = 5 * 60;

/** Returns the ids of drives made, for matching. */
export async function assembleLogger(loggerId: string): Promise<string[]> {
  const client = await pool.connect();
  const made: string[] = [];
  try {
    await client.query("BEGIN");
    // One assembler per logger at a time.
    await client.query(`SELECT 1 FROM loggers WHERE id = $1 FOR UPDATE`, [loggerId]);
    const { rows: lg } = await client.query<{ owner_user_id: string; default_drive_type_key: string }>(
      `SELECT owner_user_id, default_drive_type_key FROM loggers WHERE id = $1`, [loggerId],
    );
    if (!lg[0]) {
      await client.query("ROLLBACK");
      return [];
    }
    const { rows } = await client.query<{ t: number; lat: number; lon: number; speed: number | null; accuracy: number | null }>(
      `SELECT extract(epoch FROM t)::float AS t, lat, lon, speed, accuracy FROM logger_points
        WHERE logger_id = $1 AND drive_id IS NULL AND NOT discarded ORDER BY t`,
      [loggerId],
    );
    const fixes: Fix[] = rows.map((r) => ({ t: r.t, lat: r.lat, lon: r.lon, acc: r.accuracy, speed: r.speed }));
    const groups = splitAtGaps(fixes, GAP_S);
    const now = Date.now() / 1000;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const last = g[g.length - 1];
      // The newest stretch may still be going: leave it until the logger has gone quiet.
      if (i === groups.length - 1 && now - last.t < GAP_S) break;
      const from = new Date(g[0].t * 1000), to = new Date(last.t * 1000);
      if (g.length < MIN_POINTS || distanceOf(g) < MIN_DISTANCE_M) {
        await client.query(`UPDATE logger_points SET discarded = true WHERE logger_id = $1 AND t BETWEEN $2 AND $3`, [loggerId, from, to]);
        continue;
      }
      const id = crypto.randomUUID();
      await insertDrive(client, {
        id, source: "logger", uploadedBy: null, deviceId: null, loggerId,
        driveType: lg[0].default_drive_type_key,
        who: await forLogger(client, loggerId, from),
        fixes: g,
      });
      await client.query(`UPDATE logger_points SET drive_id = $4 WHERE logger_id = $1 AND t BETWEEN $2 AND $3`, [loggerId, from, to, id]);
      made.push(id);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return made;
}

/** Loggers with points not yet in a drive (for the periodic sweep). */
export async function loggersWithOpenPoints(): Promise<string[]> {
  const { rows } = await pool.query<{ logger_id: string }>(
    `SELECT DISTINCT logger_id FROM logger_points WHERE drive_id IS NULL AND NOT discarded`,
  );
  return rows.map((r) => r.logger_id);
}
