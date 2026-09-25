"use strict";

/**
 * What people have said about individual streets, as opposed to what was driven. Two kinds,
 * shared by every phone and the web map:
 *
 *  - completions: a street marked finished although the trace does not cover enough of it
 *    (a cul-de-sac turned in at the mouth, a road the matcher kept losing, a stretch driven
 *    with the phone off). It counts as fully driven.
 *  - exclusions: a street that does not count at all — behind a gate, private, not drivable,
 *    or not worth sweeping. It leaves every total.
 *
 * One row per street (OpenStreetMap way). Undoing either keeps the row with its flag false,
 * so the undo reaches phones that still have the old state instead of their next sync
 * putting it back. Whichever edit is newer wins, wherever it was made.
 *
 * Neither invents miles. Drive totals, leaderboards and achievements still count only what
 * was actually driven.
 */

const REASONS = new Set(["GATED", "NOT_DRIVABLE", "NOT_NEEDED", "OTHER"]);

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS street_completions (
      way_id     BIGINT PRIMARY KEY,
      marked     BOOLEAN NOT NULL,
      updated_at BIGINT NOT NULL,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS street_exclusions (
      way_id     BIGINT PRIMARY KEY,
      excluded   BOOLEAN NOT NULL,
      reason     TEXT NOT NULL DEFAULT 'OTHER',
      note       TEXT,
      updated_at BIGINT NOT NULL,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
  `);
}

function validRow(r) {
  const wayId = Number(r.wayId);
  const at = Number(r.updatedAt);
  if (!Number.isSafeInteger(wayId) || wayId <= 0 || !Number.isFinite(at) || at <= 0) return null;
  return { wayId, at: Math.round(at) };
}

/**
 * Stores completion edits, keeping the newer of two for the same street. `db` is the pool
 * or a client inside a transaction. Returns how many rows were taken.
 */
async function apply(db, rows, userId) {
  let taken = 0;
  for (const r of rows || []) {
    const v = validRow(r);
    if (!v) continue;
    const res = await db.query(
      `INSERT INTO street_completions (way_id, marked, updated_at, user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (way_id) DO UPDATE SET
         marked = EXCLUDED.marked, updated_at = EXCLUDED.updated_at, user_id = EXCLUDED.user_id
       WHERE EXCLUDED.updated_at > street_completions.updated_at`,
      [v.wayId, Boolean(r.marked), v.at, userId || null]);
    taken += res.rowCount;
  }
  return taken;
}

/** The same for exclusions. */
async function applyExclusions(db, rows, userId) {
  let taken = 0;
  for (const r of rows || []) {
    const v = validRow(r);
    if (!v) continue;
    const reason = REASONS.has(r.reason) ? r.reason : "OTHER";
    const note = r.note ? String(r.note).trim().slice(0, 500) || null : null;
    const res = await db.query(
      `INSERT INTO street_exclusions (way_id, excluded, reason, note, updated_at, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (way_id) DO UPDATE SET
         excluded = EXCLUDED.excluded, reason = EXCLUDED.reason, note = EXCLUDED.note,
         updated_at = EXCLUDED.updated_at, user_id = EXCLUDED.user_id
       WHERE EXCLUDED.updated_at > street_exclusions.updated_at`,
      [v.wayId, r.excluded !== false, reason, note, v.at, userId || null]);
    taken += res.rowCount;
  }
  return taken;
}

/** Every completion row, undos included, for a phone to bring itself up to date. */
async function list(pool) {
  const { rows } = await pool.query(
    `SELECT c.way_id, c.marked, c.updated_at, u.name AS by
       FROM street_completions c LEFT JOIN users u ON u.id = c.user_id
      ORDER BY c.way_id`);
  return rows.map((r) => ({
    wayId: Number(r.way_id), marked: r.marked, updatedAt: Number(r.updated_at), by: r.by || null,
  }));
}

async function listExclusions(pool) {
  const { rows } = await pool.query(
    `SELECT x.way_id, x.excluded, x.reason, x.note, x.updated_at, u.name AS by
       FROM street_exclusions x LEFT JOIN users u ON u.id = x.user_id
      ORDER BY x.way_id`);
  return rows.map((r) => ({
    wayId: Number(r.way_id), excluded: r.excluded, reason: r.reason, note: r.note || null,
    updatedAt: Number(r.updated_at), by: r.by || null,
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

/** The streets among `wayIds` that are excluded now, with why and by whom. */
async function excludedAmong(pool, wayIds) {
  if (!wayIds.length) return [];
  const { rows } = await pool.query(
    `SELECT x.way_id, x.reason, x.note, x.updated_at, u.name AS by
       FROM street_exclusions x LEFT JOIN users u ON u.id = x.user_id
      WHERE x.excluded AND x.way_id = ANY($1::bigint[])`, [wayIds]);
  return rows.map((r) => ({
    wayId: Number(r.way_id), reason: r.reason, note: r.note || null,
    updatedAt: Number(r.updated_at), by: r.by || null,
  }));
}

module.exports = {
  ensureSchema, apply, applyExclusions, list, listExclusions, markedAmong, excludedAmong, REASONS,
};
