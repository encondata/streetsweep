// Who drove which car: worked out from history at the time of the drive, never from
// how things stand now, because a logger's drive may arrive hours later.
import type pg from "pg";

type Db = pg.Pool | pg.PoolClient;

export interface Attribution {
  user_id: string | null;
  vehicle_id: string | null;
  attribution: "explicit" | "inferred" | "unknown";
}

/** The person holding a car at a moment: an open check-out, else its only permanent driver. */
export async function driverOf(db: Db, vehicleId: string, at: Date): Promise<string | null> {
  const { rows } = await db.query<{ user_id: string; kind: string }>(
    `SELECT user_id, kind FROM vehicle_assignments WHERE vehicle_id = $1 AND during @> $2::timestamptz`,
    [vehicleId, at],
  );
  const out = rows.find((r) => r.kind === "checkout");
  if (out) return out.user_id;
  const perm = rows.filter((r) => r.kind === "permanent");
  return perm.length === 1 ? perm[0].user_id : null;
}

/** The car a person had at a moment: their check-out, else their only permanent car. */
export async function vehicleOf(db: Db, userId: string, at: Date): Promise<string | null> {
  const { rows } = await db.query<{ vehicle_id: string; kind: string }>(
    `SELECT a.vehicle_id, a.kind FROM vehicle_assignments a JOIN vehicles v ON v.id = a.vehicle_id
      WHERE a.user_id = $1 AND a.during @> $2::timestamptz`,
    [userId, at],
  );
  const out = rows.find((r) => r.kind === "checkout");
  if (out) return out.vehicle_id;
  const perm = rows.filter((r) => r.kind === "permanent");
  return perm.length === 1 ? perm[0].vehicle_id : null;
}

/** Phone drive: the signed-in person, and the car they picked or the one they had. */
export async function forPhone(db: Db, userId: string, pickedVehicle: string | null, at: Date): Promise<Attribution> {
  if (pickedVehicle) return { user_id: userId, vehicle_id: pickedVehicle, attribution: "explicit" };
  const v = await vehicleOf(db, userId, at);
  return { user_id: userId, vehicle_id: v, attribution: "inferred" };
}

/** Logger drive: the car it was in at the time, and whoever had that car. */
export async function forLogger(db: Db, loggerId: string, at: Date): Promise<Attribution> {
  const { rows } = await db.query<{ vehicle_id: string }>(
    `SELECT vehicle_id FROM logger_installs WHERE logger_id = $1 AND during @> $2::timestamptz`, [loggerId, at],
  );
  const vehicle = rows[0]?.vehicle_id ?? null;
  if (!vehicle) return { user_id: null, vehicle_id: null, attribution: "unknown" };
  const user = await driverOf(db, vehicle, at);
  return { user_id: user, vehicle_id: vehicle, attribution: user ? "inferred" : "unknown" };
}
