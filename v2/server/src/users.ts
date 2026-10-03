// Creating accounts. An account gets its personal team once its email is confirmed.
import crypto from "node:crypto";
import type pg from "pg";
import { hashPassword } from "./auth.js";
import { audit } from "./audit.js";

export function newJoinCode(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(8), (b) => abc[b % abc.length]).join("");
}

/**
 * A new account. Sign-up makes it unconfirmed (verified: false) and emails a code;
 * the first site admin and the CLI make it confirmed straight away.
 */
export async function createUser(
  db: pg.PoolClient,
  u: { email: string; displayName: string; password: string; siteAdmin?: boolean; verified: boolean },
): Promise<string> {
  const hash = await hashPassword(u.password);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, display_name, password_hash, is_site_admin) VALUES ($1, $2, $3, $4) RETURNING id`,
    [u.email, u.displayName, hash, !!u.siteAdmin],
  );
  const userId = rows[0].id;
  await audit(db, { userId, action: "user.created", entity: "user", entityId: userId });
  if (u.verified) await confirmUser(db, userId);
  return userId;
}

/** Mark the email confirmed and give the account its personal team (once). */
export async function confirmUser(db: pg.PoolClient, userId: string) {
  const { rows } = await db.query<{ display_name: string }>(
    `UPDATE users SET email_verified_at = coalesce(email_verified_at, now()), updated_at = now()
      WHERE id = $1 RETURNING display_name`,
    [userId],
  );
  const has = await db.query(
    `SELECT 1 FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = $1 AND t.kind = 'personal'`, [userId],
  );
  if (has.rows.length) return;
  const team = await db.query<{ id: string }>(
    `INSERT INTO teams (name, kind, listed, join_code, created_by) VALUES ($1, 'personal', false, $2, $3) RETURNING id`,
    [`${rows[0].display_name}'s drives`, newJoinCode(), userId],
  );
  await db.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`, [team.rows[0].id, userId]);
  await audit(db, { userId, teamId: team.rows[0].id, action: "user.confirmed", entity: "user", entityId: userId });
}
