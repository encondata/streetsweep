// Team coverage: which streets each team has swept. A drive counts for a team when the
// driver was a member at the time and the team counts that drive type. A drive with no
// known driver counts for the team that manages the vehicle (if that team counts it).
import type pg from "pg";
import { pool } from "../db.js";

type Db = pg.Pool | pg.PoolClient;

// The rule above, as SQL over a drive row `d`, for team `$team`.
export const COUNTS_FOR = (team: string) => `
  coalesce((SELECT counts FROM team_drive_types tdt WHERE tdt.team_id = ${team} AND tdt.drive_type_key = d.drive_type_key), true)
  AND (
    (d.user_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM team_members m WHERE m.team_id = ${team} AND m.user_id = d.user_id
          AND m.joined_at <= d.started_at AND (m.left_at IS NULL OR m.left_at > d.started_at)))
    OR (d.user_id IS NULL AND EXISTS (
       SELECT 1 FROM vehicles v WHERE v.id = d.vehicle_id AND v.managed_by_team_id = ${team})))`;

/** The teams a drive counts for. */
export async function teamsForDrive(db: Db, driveId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT t.id FROM drives d, teams t
      WHERE d.id = $1 AND d.deleted_at IS NULL AND t.deleted_at IS NULL AND ${COUNTS_FOR("t.id")}`,
    [driveId],
  );
  return rows.map((r) => r.id);
}

/** Add one newly matched drive to the teams it counts for. */
export async function addDrive(db: Db, driveId: string): Promise<string[]> {
  const teams = await teamsForDrive(db, driveId);
  for (const team of teams) {
    await db.query(
      `INSERT INTO team_coverage AS c (team_id, segment_id, first_driven_at, first_drive_id, passes)
       SELECT $1, segment_id, driven_at, drive_id, 1 FROM segment_passes WHERE drive_id = $2
       ON CONFLICT (team_id, segment_id) DO UPDATE
         SET passes = c.passes + 1,
             first_drive_id = CASE WHEN EXCLUDED.first_driven_at < c.first_driven_at THEN EXCLUDED.first_drive_id ELSE c.first_drive_id END,
             first_driven_at = least(c.first_driven_at, EXCLUDED.first_driven_at)`,
      [team, driveId],
    );
  }
  return teams;
}

/** Recount a team from scratch: after a drive is edited, re-matched or deleted, or a toggle changes. */
export async function rebuildTeam(teamId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM team_coverage WHERE team_id = $1`, [teamId]);
    await client.query(
      `INSERT INTO team_coverage (team_id, segment_id, first_driven_at, first_drive_id, passes)
       SELECT $1, p.segment_id, min(p.driven_at), (array_agg(p.drive_id ORDER BY p.driven_at))[1], count(*)
         FROM segment_passes p JOIN drives d ON d.id = p.drive_id
        WHERE d.deleted_at IS NULL AND d.status = 'matched' AND ${COUNTS_FOR("$1::uuid")}
        GROUP BY p.segment_id`,
      [teamId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
