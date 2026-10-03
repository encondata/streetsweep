// Vehicles, assignments and logger installs: permission checks and history ranges.
import type pg from "pg";
import type { SessionUser } from "./auth.js";
import { badRequest, forbidden, notFound } from "./http.js";
import { isAdminRole, roleIn, type Role } from "./teams.js";

type Db = pg.Pool | pg.PoolClient;

export interface VehicleRow {
  id: string;
  managed_by_team_id: string;
  name: string;
  checkout_policy: "open" | "admin_only";
  archived_at: Date | null;
}

export async function loadVehicle(db: Db, id: string, lock = false): Promise<VehicleRow> {
  const { rows } = await db.query<VehicleRow>(
    `SELECT id, managed_by_team_id, name, checkout_policy, archived_at FROM vehicles WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  if (!rows[0]) throw notFound("That vehicle doesn't exist.");
  return rows[0];
}

/** Your role in the managing team; site admins count as admins everywhere. */
export async function vehicleRole(db: Db, v: VehicleRow, user: SessionUser): Promise<Role | null> {
  const role = await roleIn(v.managed_by_team_id, user.id, db);
  if (!role && user.is_site_admin) return "admin";
  return role;
}

export async function requireVehicleView(db: Db, v: VehicleRow, user: SessionUser) {
  const role = await vehicleRole(db, v, user);
  if (!role) throw notFound("That vehicle doesn't exist.");
  return role;
}

export async function requireVehicleAdmin(db: Db, v: VehicleRow, user: SessionUser) {
  const role = await vehicleRole(db, v, user);
  if (!role) throw notFound("That vehicle doesn't exist.");
  if (!isAdminRole(role)) throw forbidden("Only the managing team's admins can do that.");
  return role;
}

export const canDrive = (role: Role | null) => role === "owner" || role === "admin" || role === "driver";

/** Someone a car may be given to: a current owner, admin or driver of its team. */
export async function requireDriverInTeam(db: Db, teamId: string, userId: string) {
  const role = await roleIn(teamId, userId, db);
  if (!canDrive(role)) throw badRequest("They need to be a driver (or admin) in the vehicle's team first.");
}

export function requireActive(v: VehicleRow) {
  if (v.archived_at) throw badRequest("This vehicle is archived. Bring it back first.");
}

/**
 * End an open range now. A row that only began this instant never really took
 * effect, and closing it would leave an empty range, so it's removed instead.
 */
export async function endRange(db: Db, table: "vehicle_assignments" | "logger_installs", id: string, endedBy?: string) {
  await db.query(`DELETE FROM ${table} WHERE id = $1 AND lower(during) >= now()`, [id]);
  const extra = table === "vehicle_assignments" ? ", ended_by = $2" : "";
  await db.query(
    `UPDATE ${table} SET during = tstzrange(lower(during), now(), '[)')${extra} WHERE id = $1 AND upper_inf(during)`,
    table === "vehicle_assignments" ? [id, endedBy ?? null] : [id],
  );
}

/** End every open assignment on a vehicle (archiving, moving), or only one user's. */
export async function endAssignments(db: Db, vehicleId: string, endedBy: string, userId?: string) {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM vehicle_assignments WHERE vehicle_id = $1 AND upper_inf(during) ${userId ? "AND user_id = $2" : ""}`,
    userId ? [vehicleId, userId] : [vehicleId],
  );
  for (const r of rows) await endRange(db, "vehicle_assignments", r.id, endedBy);
}

/** When someone leaves a team, their hold on its vehicles ends with it. */
export async function endAssignmentsInTeam(db: Db, teamId: string, userId: string, endedBy: string) {
  const { rows } = await db.query<{ id: string }>(
    `SELECT a.id FROM vehicle_assignments a JOIN vehicles v ON v.id = a.vehicle_id
      WHERE v.managed_by_team_id = $1 AND a.user_id = $2 AND upper_inf(a.during)`,
    [teamId, userId],
  );
  for (const r of rows) await endRange(db, "vehicle_assignments", r.id, endedBy);
}

export async function uninstallLoggersFrom(db: Db, vehicleId: string) {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM logger_installs WHERE vehicle_id = $1 AND upper_inf(during)`, [vehicleId],
  );
  for (const r of rows) await endRange(db, "logger_installs", r.id);
}
