// Creating accounts: every user gets a personal team on the way in.
import crypto from "node:crypto";
import type pg from "pg";
import { hashPassword } from "./auth.js";
import { audit } from "./audit.js";

export function newJoinCode(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(8), (b) => abc[b % abc.length]).join("");
}

export async function createUser(
  db: pg.PoolClient,
  u: { email: string; displayName: string; password: string; siteAdmin?: boolean },
): Promise<string> {
  const hash = await hashPassword(u.password);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, display_name, password_hash, is_site_admin) VALUES ($1, $2, $3, $4) RETURNING id`,
    [u.email, u.displayName, hash, !!u.siteAdmin],
  );
  const userId = rows[0].id;
  const team = await db.query<{ id: string }>(
    `INSERT INTO teams (name, kind, listed, join_code, created_by) VALUES ($1, 'personal', false, $2, $3) RETURNING id`,
    [`${u.displayName}'s drives`, newJoinCode(), userId],
  );
  await db.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`, [team.rows[0].id, userId]);
  await audit(db, { userId, teamId: team.rows[0].id, action: "user.created", entity: "user", entityId: userId });
  return userId;
}
