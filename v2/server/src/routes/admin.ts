// Site-wide administration, plus the drive-type list everyone reads.
import type { FastifyInstance } from "fastify";
import { pool, query } from "../db.js";
import { hashPassword, randomPassword, requireSiteAdmin, requireUser } from "../auth.js";
import { audit } from "../audit.js";
import { badRequest, conflict, notFound } from "../http.js";
import { avatarUrl } from "./account.js";

export default async function adminRoutes(app: FastifyInstance) {
  app.get("/api/drive-types", async (req) => {
    requireUser(req);
    const { rows } = await query(
      `SELECT key, label, icon, sort, archived_at FROM drive_types ORDER BY archived_at IS NOT NULL, sort, label`,
    );
    return { drive_types: rows };
  });

  app.post<{ Body: { key: string; label: string; icon?: string; sort?: number } }>(
    "/api/admin/drive-types",
    { schema: { body: { type: "object", required: ["key", "label"], additionalProperties: false, properties: {
        key: { type: "string", pattern: "^[a-z][a-z0-9_]{1,31}$" },
        label: { type: "string", minLength: 1, maxLength: 40 },
        icon: { type: "string", maxLength: 80 },
        sort: { type: "integer" } } } } },
    async (req, reply) => {
      const me = requireSiteAdmin(req);
      const exists = await query(`SELECT 1 FROM drive_types WHERE key = $1`, [req.body.key]);
      if (exists.rows.length) throw conflict("A drive type with that key already exists.");
      await query(`INSERT INTO drive_types (key, label, icon, sort) VALUES ($1, $2, $3, $4)`,
        [req.body.key, req.body.label.trim(), req.body.icon || `drive-${req.body.key}.png`, req.body.sort ?? 100]);
      await audit(pool, { userId: me.id, action: "drive_type.created", entity: "drive_type", entityId: req.body.key });
      return reply.code(201).send({ ok: true });
    },
  );

  // Archived, never deleted: old drives keep their type.
  app.patch<{ Params: { key: string }; Body: { label?: string; icon?: string; sort?: number; archived?: boolean } }>(
    "/api/admin/drive-types/:key",
    { schema: { body: { type: "object", additionalProperties: false, properties: {
        label: { type: "string", minLength: 1, maxLength: 40 }, icon: { type: "string", maxLength: 80 },
        sort: { type: "integer" }, archived: { type: "boolean" } } } } },
    async (req) => {
      const me = requireSiteAdmin(req);
      const { rowCount } = await query(
        `UPDATE drive_types SET label = coalesce($2, label), icon = coalesce($3, icon), sort = coalesce($4, sort),
                archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN coalesce(archived_at, now()) ELSE NULL END
          WHERE key = $1`,
        [req.params.key, req.body.label?.trim() || null, req.body.icon || null, req.body.sort ?? null, req.body.archived ?? null],
      );
      if (!rowCount) throw notFound("No such drive type.");
      await audit(pool, { userId: me.id, action: "drive_type.updated", entity: "drive_type", entityId: req.params.key, data: req.body });
      return { ok: true };
    },
  );

  app.get<{ Querystring: { q?: string } }>("/api/admin/users", async (req) => {
    requireSiteAdmin(req);
    const q = (req.query.q ?? "").trim().replace(/[\\%_]/g, (c) => "\\" + c);
    const { rows } = await query(
      `SELECT u.id, u.email, u.display_name, ${avatarUrl("u")} AS avatar_url, u.is_site_admin, u.created_at, u.disabled_at,
              (SELECT max(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at,
              (SELECT count(*)::int FROM team_members m JOIN teams t ON t.id = m.team_id
                WHERE m.user_id = u.id AND m.left_at IS NULL AND t.kind = 'shared') AS team_count
         FROM users u
        WHERE $1 = '' OR u.email ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%'
        ORDER BY u.created_at DESC LIMIT 200`,
      [q],
    );
    return { users: rows };
  });

  app.patch<{ Params: { id: string }; Body: { is_site_admin?: boolean; disabled?: boolean } }>(
    "/api/admin/users/:id",
    { schema: { body: { type: "object", additionalProperties: false, properties: {
        is_site_admin: { type: "boolean" }, disabled: { type: "boolean" } } } } },
    async (req) => {
      const me = requireSiteAdmin(req);
      if (req.params.id === me.id) throw badRequest("You can't change your own admin rights or switch yourself off.");
      const { rowCount } = await query(
        `UPDATE users SET is_site_admin = coalesce($2, is_site_admin),
                disabled_at = CASE WHEN $3::boolean IS NULL THEN disabled_at WHEN $3 THEN coalesce(disabled_at, now()) ELSE NULL END,
                updated_at = now()
          WHERE id = $1`,
        [req.params.id, req.body.is_site_admin ?? null, req.body.disabled ?? null],
      );
      if (!rowCount) throw notFound("No such user.");
      if (req.body.disabled) await query(`DELETE FROM sessions WHERE user_id = $1`, [req.params.id]);
      await audit(pool, { userId: me.id, action: "user.admin_updated", entity: "user", entityId: req.params.id, data: req.body });
      return { ok: true };
    },
  );

  // No email yet, so "forgot password" means a site admin hands out a new one.
  app.post<{ Params: { id: string } }>("/api/admin/users/:id/reset-password", async (req) => {
    const me = requireSiteAdmin(req);
    const password = randomPassword();
    const { rowCount } = await query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`,
      [req.params.id, await hashPassword(password)]);
    if (!rowCount) throw notFound("No such user.");
    await query(`DELETE FROM sessions WHERE user_id = $1`, [req.params.id]);
    await audit(pool, { userId: me.id, action: "user.password_reset", entity: "user", entityId: req.params.id });
    return { password };
  });

  app.get("/api/admin/teams", async (req) => {
    requireSiteAdmin(req);
    const { rows } = await query(
      `SELECT t.id, t.name, t.listed, t.created_at,
              (SELECT count(*)::int FROM team_members m WHERE m.team_id = t.id AND m.left_at IS NULL) AS member_count,
              (SELECT count(*)::int FROM team_join_requests r WHERE r.team_id = t.id AND r.status = 'pending') AS pending_requests
         FROM teams t WHERE t.kind = 'shared' AND t.deleted_at IS NULL ORDER BY lower(t.name)`,
    );
    return { teams: rows };
  });
}
