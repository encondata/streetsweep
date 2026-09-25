"use strict";

/**
 * Streets someone has said are finished although the trace does not cover enough of them:
 * a cul-de-sac turned in at the mouth, a road the matcher kept losing, a stretch driven with
 * the phone off. Every phone and the web map count a marked street as fully driven.
 *
 * One row per street (OpenStreetMap way), shared by everyone, like the coverage itself.
 * Unmarking keeps the row with marked=false, so the unmark reaches phones that still have
 * the mark instead of their next sync putting it back. Whichever edit is newer wins,
 * wherever it was made.
 *
 * A mark says the street is done; it does not invent miles. Drive totals, leaderboards and
 * achievements still count only what was actually driven.
 */

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS street_completions (
      way_id     BIGINT PRIMARY KEY,
      marked     BOOLEAN NOT NULL,
      updated_at BIGINT NOT NULL,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
  `);
}

/**
 * Stores edits, keeping the newer of two for the same street. `db` is the pool or a client
 * inside a transaction. Returns how many rows were taken.
 */
async function apply(db, rows, userId) {
  let taken = 0;
  for (const r of rows || []) {
    const wayId = Number(r.wayId);
    const at = Number(r.updatedAt);
    if (!Number.isSafeInteger(wayId) || wayId <= 0 || !Number.isFinite(at) || at <= 0) continue;
    const res = await db.query(
      `INSERT INTO street_completions (way_id, marked, updated_at, user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (way_id) DO UPDATE SET
         marked = EXCLUDED.marked, updated_at = EXCLUDED.updated_at, user_id = EXCLUDED.user_id
       WHERE EXCLUDED.updated_at > street_completions.updated_at`,
      [wayId, Boolean(r.marked), Math.round(at), userId || null]);
    taken += res.rowCount;
  }
  return taken;
}

/** Every row, unmarks included, for a phone to bring itself up to date. */
async function list(pool) {
  const { rows } = await pool.query(
    `SELECT c.way_id, c.marked, c.updated_at, u.name AS by
       FROM street_completions c LEFT JOIN users u ON u.id = c.user_id
      ORDER BY c.way_id`);
  return rows.map((r) => ({
    wayId: Number(r.way_id), marked: r.marked, updatedAt: Number(r.updated_at), by: r.by || null,
  }));
}

/** The streets among `wayIds` that are marked complete now, with who marked them. */
async function markedAmong(pool, wayIds) {
  if (!wayIds.length) return [];
  const { rows } = await pool.query(
    `SELECT c.way_id, c.updated_at, u.name AS by
       FROM street_completions c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.marked AND c.way_id = ANY($1::bigint[])`, [wayIds]);
  return rows.map((r) => ({ wayId: Number(r.way_id), updatedAt: Number(r.updated_at), by: r.by || null }));
}

module.exports = { ensureSchema, apply, list, markedAmong };
