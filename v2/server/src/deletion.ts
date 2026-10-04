// Deleting an account and everything that's theirs, as the privacy policy promises:
// their drives (and so their location history), places and photos, devices, loggers,
// their personal team and its vehicles. Shared teams keep going: a sole owner hands
// the team to its longest-serving admin (or member), and a team with nobody else in it
// is deleted. Field marks they made for a team stay with the team, unattributed.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { tx } from "./db.js";
import { audit } from "./audit.js";
import { COUNTS_FOR } from "./drives/coverage.js";
import { sendJob } from "./jobs.js";
import { conflict, notFound } from "./http.js";

export async function deleteAccount(userId: string, by: { userId: string | null; via: "self" | "admin" }) {
  const files: string[] = [];
  const recount = new Set<string>();

  await tx(async (db) => {
    const { rows: [u] } = await db.query<{ is_site_admin: boolean; avatar_path: string | null }>(
      `SELECT is_site_admin, avatar_path FROM users WHERE id = $1 FOR UPDATE`, [userId],
    );
    if (!u) throw notFound("That account doesn't exist.");
    if (u.is_site_admin) {
      const others = await db.query(
        `SELECT 1 FROM users WHERE is_site_admin AND disabled_at IS NULL AND id <> $1 LIMIT 1`, [userId],
      );
      if (!others.rows.length) throw conflict("This is the only site admin. Make someone else a site admin first.");
    }
    if (u.avatar_path) files.push(path.join(config.dataDir, "avatars", u.avatar_path));

    // Their drives, and drives from their loggers that nobody was attributed to.
    const drives = (await db.query<{ id: string }>(
      `SELECT id FROM drives WHERE user_id = $1
          OR (user_id IS NULL AND logger_id IN (SELECT id FROM loggers WHERE owner_user_id = $1))`, [userId],
    )).rows.map((r) => r.id);
    if (drives.length) {
      // Which teams they counted for has to be asked while the memberships still exist.
      const teams = await db.query<{ id: string }>(
        `SELECT DISTINCT t.id FROM drives d, teams t
          WHERE d.id = ANY($1) AND d.deleted_at IS NULL AND t.deleted_at IS NULL AND t.kind = 'shared'
            AND ${COUNTS_FOR("t.id")}`, [drives],
      );
      for (const t of teams.rows) recount.add(t.id);
      await db.query(`DELETE FROM drives WHERE id = ANY($1)`, [drives]);
    }

    const photos = await db.query<{ path: string }>(
      `SELECT ph.path FROM place_photos ph JOIN places p ON p.id = ph.place_id WHERE p.user_id = $1`, [userId],
    );
    for (const p of photos.rows) files.push(path.join(config.dataDir, "places", p.path));

    // Shared teams they own alone: hand them on, or close them if nobody else is in them.
    const owned = await db.query<{ id: string }>(
      `SELECT t.id FROM team_members m JOIN teams t ON t.id = m.team_id
        WHERE m.user_id = $1 AND m.left_at IS NULL AND m.role = 'owner' AND t.kind = 'shared' AND t.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM team_members o WHERE o.team_id = t.id AND o.left_at IS NULL
                           AND o.role = 'owner' AND o.user_id <> $1)
        FOR UPDATE OF t`, [userId],
    );
    for (const t of owned.rows) {
      const next = await db.query<{ user_id: string }>(
        `SELECT user_id FROM team_members WHERE team_id = $1 AND left_at IS NULL AND user_id <> $2
          ORDER BY role = 'admin' DESC, joined_at LIMIT 1`, [t.id, userId],
      );
      if (next.rows[0]) {
        await db.query(`UPDATE team_members SET role = 'owner' WHERE team_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [t.id, next.rows[0].user_id]);
        await audit(db, { userId: by.userId, teamId: t.id, action: "team.owner_inherited", entity: "user", entityId: next.rows[0].user_id });
      } else {
        await db.query(`UPDATE teams SET deleted_at = now() WHERE id = $1`, [t.id]);
        await db.query(`UPDATE vehicles SET archived_at = coalesce(archived_at, now()) WHERE managed_by_team_id = $1`, [t.id]);
        await db.query(`UPDATE team_join_requests SET status = 'declined', decided_at = now()
                         WHERE team_id = $1 AND status = 'pending'`, [t.id]);
        await audit(db, { userId: by.userId, teamId: t.id, action: "team.deleted", entity: "team", entityId: t.id });
        recount.delete(t.id);
      }
    }

    // The personal team goes entirely, with its vehicles, coverage and marks.
    const personal = await db.query<{ id: string }>(
      `SELECT t.id FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = $1 AND t.kind = 'personal'`, [userId],
    );
    const pids = personal.rows.map((r) => r.id);
    if (pids.length) {
      const cars = await db.query<{ photo_path: string }>(
        `SELECT photo_path FROM vehicles WHERE managed_by_team_id = ANY($1) AND photo_path IS NOT NULL`, [pids],
      );
      for (const c of cars.rows) files.push(path.join(config.dataDir, "vehicles", c.photo_path));
      await db.query(`DELETE FROM teams WHERE id = ANY($1)`, [pids]);
    }

    await db.query(
      `UPDATE deletion_requests SET status = 'done', decided_at = now(), decided_by = $2
        WHERE user_id = $1 AND status = 'pending'`, [userId, by.userId === userId ? null : by.userId],
    );
    // Everything else of theirs (sessions, devices, loggers, places, memberships, codes,
    // achievements, assignments) goes with the row; references elsewhere are cleared.
    await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await audit(db, {
      userId: by.userId === userId ? null : by.userId, action: "user.deleted", entity: "user", entityId: userId,
      data: { via: by.via, drives: drives.length },
    });
  });

  for (const f of files) await fs.rm(f, { force: true }).catch(() => {});
  for (const teamId of recount) await sendJob("coverage-rebuild", { teamId }, { singletonKey: teamId });
}
