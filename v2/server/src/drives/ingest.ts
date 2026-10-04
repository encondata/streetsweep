// Storing a drive (phone upload or a logger's assembled stretch).
import type pg from "pg";
import { cleanPoints, distanceOf, trackEwkt, type Fix, type RawPoint } from "./track.js";
import type { Attribution } from "./attribution.js";

export const MIN_POINTS = 5;
export const MIN_DISTANCE_M = 100;

export interface NewDrive {
  id: string;
  source: "phone" | "logger";
  uploadedBy: string | null;
  deviceId: string | null;
  loggerId: string | null;
  driveType: string;
  who: Attribution;
  fixes: Fix[];
}

export function prepare(raw: RawPoint[]): { fixes: Fix[]; distance: number } {
  const fixes = cleanPoints(raw);
  return { fixes, distance: distanceOf(fixes) };
}

export async function insertDrive(db: pg.PoolClient | pg.Pool, d: NewDrive): Promise<void> {
  const first = d.fixes[0], last = d.fixes[d.fixes.length - 1];
  await db.query(
    `INSERT INTO drives (id, source, uploaded_by, device_id, logger_id, user_id, vehicle_id, attribution, drive_type_key,
                         started_at, ended_at, point_count, distance_m, track)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10), to_timestamp($11), $12, $13, $14)`,
    [d.id, d.source, d.uploadedBy, d.deviceId, d.loggerId, d.who.user_id, d.who.vehicle_id, d.who.attribution, d.driveType,
     first.t, last.t, d.fixes.length, distanceOf(d.fixes), trackEwkt(d.fixes)],
  );
}
