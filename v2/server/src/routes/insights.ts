// Home's figures, achievements (yours and a team's) and team leaderboards.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireUser, type SessionUser } from "../auth.js";
import { badRequest, notFound } from "../http.js";
import { loadTeam, roleIn } from "../teams.js";
import { forPerson, forTeam } from "../insights/achievements.js";
import { leaderboard, personStats, teamStats, type Board, type Period } from "../insights/stats.js";

const PERIODS: Period[] = ["week", "month", "all"];
const BOARDS: Board[] = ["new", "miles", "drives"];

/** Members (any role) see a team's figures; outsiders don't learn it exists. */
async function memberTeam(id: string, me: SessionUser) {
  const team = await loadTeam(id).catch(() => null);
  if (!team || (!(await roleIn(team.id, me.id)) && !me.is_site_admin)) throw notFound("That team doesn't exist.");
  return team;
}

export default async function insightRoutes(app: FastifyInstance) {
  app.get("/api/stats", async (req) => personStats(pool, requireUser(req).id));

  app.get<{ Params: { id: string } }>("/api/teams/:id/stats", async (req) => {
    const team = await memberTeam(req.params.id, requireUser(req));
    // A personal team's figures are its person's.
    if (team.kind === "shared") return teamStats(pool, team.id);
    const { rows } = await pool.query(`SELECT user_id FROM team_members WHERE team_id = $1 AND role = 'owner' LIMIT 1`, [team.id]);
    return personStats(pool, rows[0].user_id);
  });

  app.get("/api/achievements", async (req) => forPerson(pool, requireUser(req).id));

  // Where a team has swept, summed into cells about a kilometre across: the map's
  // zoomed-out dots. Streets, not drives, so it shows ground covered without showing
  // anyone's trips (team drive lists are for admins).
  app.get<{ Params: { id: string } }>("/api/teams/:id/coverage-cells", async (req, reply) => {
    const team = await memberTeam(req.params.id, requireUser(req));
    const { rows } = await pool.query<{ lon: number; lat: number; m: number; n: number }>(
      `SELECT (floor(ST_X(c) / 0.01) + 0.5) * 0.01 AS lon, (floor(ST_Y(c) / 0.01) + 0.5) * 0.01 AS lat,
              sum(len)::float AS m, count(*)::int AS n
         FROM (SELECT ST_Centroid(s.geom) AS c, s.length_m AS len
                 FROM team_coverage tc JOIN street_segments s ON s.id = tc.segment_id JOIN street_ways w ON w.way_id = s.way_id
                WHERE tc.team_id = $1 AND (w.highway NOT IN ('trunk', 'motorway')
                      OR coalesce((SELECT count_highways FROM teams WHERE id = $1), false))) x
        GROUP BY 1, 2`,
      [team.id],
    );
    reply.header("Cache-Control", "private, no-cache");
    return { cells: rows.map((r) => [Math.round(r.lon * 1e4) / 1e4, Math.round(r.lat * 1e4) / 1e4, Math.round(r.m), r.n]) };
  });

  app.get<{ Params: { id: string } }>("/api/teams/:id/achievements", async (req) => {
    const team = await memberTeam(req.params.id, requireUser(req));
    if (team.kind === "personal") throw badRequest("Team achievements are for shared teams; yours are under Achievements.");
    return forTeam(pool, team.id);
  });

  app.get<{ Params: { id: string }; Querystring: { board?: string; period?: string } }>("/api/teams/:id/leaderboard", async (req) => {
    const team = await memberTeam(req.params.id, requireUser(req));
    if (team.kind === "personal") throw badRequest("A personal team has nobody to rank against.");
    const board = (req.query.board ?? "new") as Board;
    const period = (req.query.period ?? "week") as Period;
    if (!BOARDS.includes(board) || !PERIODS.includes(period)) throw badRequest("Pick a board (new, miles, drives) and a period (week, month, all).");
    return { board, period, rows: await leaderboard(pool, team.id, board, period) };
  });
}
