// Who may do what in a team.
import type pg from "pg";
import { query } from "./db.js";
import { forbidden, notFound } from "./http.js";
import type { SessionUser } from "./auth.js";

export type Role = "owner" | "admin" | "driver" | "viewer";
export const ROLES: Role[] = ["owner", "admin", "driver", "viewer"];
export const isAdminRole = (r: Role | null | undefined) => r === "owner" || r === "admin";

export interface TeamRow {
  id: string;
  name: string;
  kind: "personal" | "shared";
  listed: boolean;
  join_code: string;
}

export async function loadTeam(id: string, db: pg.Pool | pg.PoolClient | null = null): Promise<TeamRow> {
  const sql = `SELECT id, name, kind, listed, join_code FROM teams WHERE id = $1 AND deleted_at IS NULL`;
  const { rows } = db ? await db.query<TeamRow>(sql, [id]) : await query<TeamRow>(sql, [id]);
  if (!rows[0]) throw notFound("That team doesn't exist.");
  return rows[0];
}

export async function roleIn(teamId: string, userId: string, db: pg.Pool | pg.PoolClient | null = null): Promise<Role | null> {
  const sql = `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND left_at IS NULL`;
  const { rows } = db ? await db.query<{ role: Role }>(sql, [teamId, userId]) : await query<{ role: Role }>(sql, [teamId, userId]);
  return rows[0]?.role ?? null;
}

/** Team admins and owners manage the team; site admins may step in on any team. */
export async function requireTeamAdmin(teamId: string, user: SessionUser, db: pg.Pool | pg.PoolClient | null = null) {
  const role = await roleIn(teamId, user.id, db);
  if (isAdminRole(role) || user.is_site_admin) return role;
  throw forbidden("Only this team's admins can do that.");
}

export async function ownerCount(teamId: string, db: pg.PoolClient): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM team_members WHERE team_id = $1 AND role = 'owner' AND left_at IS NULL`, [teamId],
  );
  return rows[0].n;
}
