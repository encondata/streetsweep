// Figures for Home: totals, this month, and the last twelve weeks, for a person or a
// team; and team leaderboards. Weeks and months are local (config.timezone).
import type pg from "pg";
import { config } from "../config.js";
import { COUNTS_FOR } from "../drives/coverage.js";
import { avatarUrl } from "../routes/account.js";

type Db = pg.Pool | pg.PoolClient;
export type Period = "week" | "month" | "all";
export type Board = "new" | "miles" | "drives";
const WEEKS = 12;

/** Start of this week/month in local time, as a timestamptz ($2 is the timezone). */
const since = (period: Period) =>
  period === "all" ? "'-infinity'::timestamptz" : `(date_trunc('${period}', now() AT TIME ZONE $2) AT TIME ZONE $2)`;

/** Mondays of the last twelve weeks, local. */
const WEEK_SERIES = `
  SELECT generate_series(date_trunc('week', now() AT TIME ZONE $2) - interval '${WEEKS - 1} weeks',
                         date_trunc('week', now() AT TIME ZONE $2), interval '1 week')::date AS week`;

export async function personStats(db: Db, userId: string) {
  const tz = config.timezone;
  const firsts = `
    SELECT DISTINCT ON (p.segment_id) p.segment_id, p.driven_at, s.length_m
      FROM segment_passes p JOIN drives d ON d.id = p.drive_id JOIN street_segments s ON s.id = p.segment_id
     WHERE d.user_id = $1 AND d.deleted_at IS NULL AND d.status = 'matched'
     ORDER BY p.segment_id, p.driven_at`;
  const mine = `SELECT * FROM drives WHERE user_id = $1 AND deleted_at IS NULL AND status = 'matched'`;
  const { rows } = await db.query(
    `WITH f AS (${firsts}), d AS (${mine}), w AS (${WEEK_SERIES})
     SELECT
       (SELECT count(*)::int FROM d) AS drives,
       (SELECT coalesce(sum(distance_m), 0)::float FROM d) AS drive_m,
       (SELECT count(*)::int FROM f) AS streets,
       (SELECT coalesce(sum(length_m), 0)::float FROM f) AS street_m,
       (SELECT count(*)::int FROM d WHERE started_at >= ${since("month")}) AS month_drives,
       (SELECT coalesce(sum(distance_m), 0)::float FROM d WHERE started_at >= ${since("month")}) AS month_drive_m,
       (SELECT count(*)::int FROM f WHERE driven_at >= ${since("month")}) AS month_streets,
       (SELECT coalesce(sum(length_m), 0)::float FROM f WHERE driven_at >= ${since("month")}) AS month_street_m,
       (SELECT json_agg(json_build_object('week', w.week,
          'street_m', (SELECT coalesce(sum(length_m), 0) FROM f WHERE date_trunc('week', driven_at AT TIME ZONE $2)::date = w.week),
          'drive_m', (SELECT coalesce(sum(distance_m), 0) FROM d WHERE date_trunc('week', started_at AT TIME ZONE $2)::date = w.week))
          ORDER BY w.week) FROM w) AS weeks`,
    [userId, tz],
  );
  return shape(rows[0]);
}

export async function teamStats(db: Db, teamId: string) {
  const tz = config.timezone;
  const counting = `SELECT d.* FROM drives d WHERE d.deleted_at IS NULL AND d.status = 'matched' AND ${COUNTS_FOR("$1::uuid")}`;
  const cov = `SELECT c.first_driven_at AS driven_at, s.length_m FROM team_coverage c JOIN street_segments s ON s.id = c.segment_id WHERE c.team_id = $1`;
  const { rows } = await db.query(
    `WITH f AS (${cov}), d AS (${counting}), w AS (${WEEK_SERIES})
     SELECT
       (SELECT count(*)::int FROM d) AS drives,
       (SELECT coalesce(sum(distance_m), 0)::float FROM d) AS drive_m,
       (SELECT count(*)::int FROM f) AS streets,
       (SELECT coalesce(sum(length_m), 0)::float FROM f) AS street_m,
       (SELECT count(*)::int FROM d WHERE started_at >= ${since("month")}) AS month_drives,
       (SELECT coalesce(sum(distance_m), 0)::float FROM d WHERE started_at >= ${since("month")}) AS month_drive_m,
       (SELECT count(*)::int FROM f WHERE driven_at >= ${since("month")}) AS month_streets,
       (SELECT coalesce(sum(length_m), 0)::float FROM f WHERE driven_at >= ${since("month")}) AS month_street_m,
       (SELECT count(DISTINCT user_id)::int FROM d WHERE started_at >= ${since("month")}) AS month_drivers,
       (SELECT count(*)::int FROM team_members WHERE team_id = $1 AND left_at IS NULL) AS members,
       (SELECT json_agg(json_build_object('week', w.week,
          'street_m', (SELECT coalesce(sum(length_m), 0) FROM f WHERE date_trunc('week', driven_at AT TIME ZONE $2)::date = w.week),
          'drive_m', (SELECT coalesce(sum(distance_m), 0) FROM d WHERE date_trunc('week', started_at AT TIME ZONE $2)::date = w.week))
          ORDER BY w.week) FROM w) AS weeks`,
    [teamId, tz],
  );
  return { ...shape(rows[0]), month_drivers: rows[0].month_drivers, members: rows[0].members };
}

function shape(r: Record<string, any>) {
  return {
    total: { drives: r.drives, drive_m: r.drive_m, streets: r.streets, street_m: r.street_m },
    month: { drives: r.month_drives, drive_m: r.month_drive_m, streets: r.month_streets, street_m: r.month_street_m },
    weeks: (r.weeks ?? []).map((w: any) => ({ week: w.week, street_m: Number(w.street_m), drive_m: Number(w.drive_m) })),
  };
}

/**
 * A team's members ranked for a period: by new streets (segments they swept first for
 * the team), by miles driven for it, or by drives. Everyone who can drive is listed,
 * at zero if they haven't yet.
 */
export async function leaderboard(db: Db, teamId: string, board: Board, period: Period) {
  const tz = config.timezone;
  const scores =
    board === "new"
      ? `SELECT d.user_id, sum(s.length_m)::float AS value, count(*)::int AS extra
           FROM team_coverage c JOIN drives d ON d.id = c.first_drive_id JOIN street_segments s ON s.id = c.segment_id
          WHERE c.team_id = $1 AND c.first_driven_at >= ${since(period)} AND d.user_id IS NOT NULL
          GROUP BY d.user_id`
      : `SELECT d.user_id, ${board === "miles" ? "sum(d.distance_m)::float" : "count(*)::float"} AS value,
                ${board === "miles" ? "count(*)" : "round(sum(d.distance_m))"}::int AS extra
           FROM drives d
          WHERE d.deleted_at IS NULL AND d.status = 'matched' AND d.user_id IS NOT NULL
            AND d.started_at >= ${since(period)} AND ${COUNTS_FOR("$1::uuid")}
          GROUP BY d.user_id`;
  const { rows } = await db.query(
    `WITH sc AS (${scores})
     SELECT u.id AS user_id, u.display_name, ${avatarUrl("u")} AS avatar_url,
            coalesce(sc.value, 0)::float AS value, coalesce(sc.extra, 0)::int AS extra
       FROM team_members m JOIN users u ON u.id = m.user_id
       LEFT JOIN sc ON sc.user_id = m.user_id
      WHERE m.team_id = $1 AND m.left_at IS NULL AND (m.role <> 'viewer' OR sc.value > 0)
      ORDER BY value DESC, u.display_name`,
    // "All time" never mentions the timezone, and Postgres won't take a parameter it can't type.
    period === "all" ? [teamId] : [teamId, tz],
  );
  // Equal scores share a rank.
  let rank = 0, prev: number | null = null;
  return rows.map((r, i) => {
    if (r.value !== prev) rank = i + 1;
    prev = r.value;
    return { ...r, rank };
  });
}
