// One-time email codes: confirming a new account, resetting a password, asking for deletion.
import crypto from "node:crypto";
import type pg from "pg";
import { pool } from "./db.js";
import { HttpError, badRequest } from "./http.js";

export type Purpose = "verify" | "reset" | "delete";
export const CODE_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const PER_HOUR = 5;

const hash = (userId: string, purpose: Purpose, code: string) =>
  crypto.createHash("sha256").update(`${purpose}:${userId}:${code}`).digest();

/**
 * Retire any open code and make a new one. Throttled: one a minute, five an hour,
 * per account and purpose, so the form can't be used to flood someone's inbox.
 */
export async function issueCode(db: pg.Pool | pg.PoolClient, userId: string, purpose: Purpose): Promise<string> {
  const { rows } = await db.query<{ last: number | null; hour: number }>(
    `SELECT extract(epoch FROM now() - max(created_at))::float AS last,
            count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour
       FROM email_codes WHERE user_id = $1 AND purpose = $2`,
    [userId, purpose],
  );
  const { last, hour } = rows[0];
  if (last !== null && last < RESEND_SECONDS) {
    throw new HttpError(429, `We just sent a code. Wait ${Math.ceil(RESEND_SECONDS - last)} seconds before asking for another.`, "too_soon");
  }
  if (hour >= PER_HOUR) throw new HttpError(429, "That's a lot of codes. Wait an hour, then try again.", "too_many");
  await db.query(`UPDATE email_codes SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await db.query(
    `INSERT INTO email_codes (user_id, purpose, code_hash, expires_at) VALUES ($1, $2, $3, now() + $4 * interval '1 minute')`,
    [userId, purpose, hash(userId, purpose, code), CODE_MINUTES],
  );
  return code;
}

/** The email never went out: drop its code so asking again isn't throttled. */
export async function forgetLatestCode(userId: string, purpose: Purpose) {
  await pool.query(
    `DELETE FROM email_codes WHERE id = (SELECT id FROM email_codes WHERE user_id = $1 AND purpose = $2
                                          ORDER BY created_at DESC LIMIT 1)`,
    [userId, purpose],
  );
}

/** Send the email for a fresh code, forgetting the code if sending fails. */
export async function sendOrForget(userId: string, purpose: Purpose, send: () => Promise<void>) {
  try {
    await send();
  } catch (err) {
    await forgetLatestCode(userId, purpose);
    throw err;
  }
}

/**
 * Check a code and spend it. A miss is returned rather than thrown: the wrong guess is
 * counted on the caller's transaction, which must commit before the error is raised,
 * or a rollback would hand the guess back.
 */
export async function useCode(
  db: pg.PoolClient, userId: string, purpose: Purpose, codeIn: string,
): Promise<{ ok: true } | { ok: false; error: HttpError }> {
  const code = codeIn.replace(/\s+/g, "");
  const { rows } = await db.query<{ id: string; code_hash: Buffer; attempts: number; expired: boolean }>(
    `SELECT id, code_hash, attempts, expires_at <= now() AS expired
       FROM email_codes WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [userId, purpose],
  );
  const row = rows[0];
  if (!row || row.expired) return { ok: false, error: new HttpError(400, "That code has expired. Send yourself a new one.", "expired") };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: new HttpError(400, "Too many wrong tries. Send yourself a new code.", "locked") };
  if (!/^\d{6}$/.test(code) || !crypto.timingSafeEqual(row.code_hash, hash(userId, purpose, code))) {
    await db.query(`UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    const left = MAX_ATTEMPTS - row.attempts - 1;
    return { ok: false, error: badRequest(left > 0
      ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.`
      : "That code isn't right, and that was the last try. Send yourself a new code.") };
  }
  await db.query(`UPDATE email_codes SET used_at = now() WHERE id = $1`, [row.id]);
  return { ok: true };
}
