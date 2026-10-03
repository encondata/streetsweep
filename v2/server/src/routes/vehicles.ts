// Vehicles: the list, details, permanent drivers, check-out and return, photos.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { pool, query, tx } from "../db.js";
import { requireUser, type SessionUser } from "../auth.js";
import { audit } from "../audit.js";
import { badRequest, conflict, forbidden, notFound } from "../http.js";
import { isAdminRole, loadTeam, requireTeamAdmin } from "../teams.js";
import {
  canDrive, endAssignments, endRange, loadVehicle, requireActive, requireDriverInTeam,
  requireVehicleAdmin, requireVehicleView, uninstallLoggersFrom,
} from "../fleet.js";
import { avatarUrl } from "./account.js";

const PHOTO_DIR = () => path.join(config.dataDir, "vehicles");
const PHOTO_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

const fields = {
  name: { type: "string", minLength: 1, maxLength: 60 },
  kind: { type: "string", enum: ["car", "suv", "van", "truck", "motorcycle", "other"] },
  make: { type: ["string", "null"], maxLength: 40 },
  model: { type: ["string", "null"], maxLength: 40 },
  year: { type: ["integer", "null"], minimum: 1900, maximum: 2100 },
  color: { type: ["string", "null"], maxLength: 30 },
  plate: { type: ["string", "null"], maxLength: 20 },
  checkout_policy: { type: "string", enum: ["open", "admin_only"] },
} as const;

type VehicleFields = {
  name?: string; kind?: string; make?: string | null; model?: string | null; year?: number | null;
  color?: string | null; plate?: string | null; checkout_policy?: string;
};

const person = (alias: string) =>
  `json_build_object('user_id', ${alias}.id, 'display_name', ${alias}.display_name, 'avatar_url', ${avatarUrl(alias)})`;

// One shape for the list and the detail page. $1 is the viewer.
const SUMMARY = `
  SELECT v.id, v.name, v.kind, v.make, v.model, v.year, v.color, v.plate, v.checkout_policy,
         v.managed_by_team_id AS team_id, t.name AS team_name, t.kind AS team_kind, m.role AS my_role,
         CASE WHEN v.photo_path IS NOT NULL THEN '/api/vehicles/' || v.id || '/photo?v=' || v.photo_path END AS photo_url,
         v.archived_at, v.created_at,
         (SELECT ${person("u")}::jsonb || jsonb_build_object('id', a.id, 'since', lower(a.during), 'note', a.note)
            FROM vehicle_assignments a JOIN users u ON u.id = a.user_id
           WHERE a.vehicle_id = v.id AND a.kind = 'checkout' AND upper_inf(a.during)) AS checkout,
         coalesce((SELECT jsonb_agg(${person("u")}::jsonb || jsonb_build_object('id', a.id, 'since', lower(a.during)) ORDER BY lower(a.during))
            FROM vehicle_assignments a JOIN users u ON u.id = a.user_id
           WHERE a.vehicle_id = v.id AND a.kind = 'permanent' AND upper_inf(a.during)), '[]') AS assigned,
         (SELECT count(*)::int FROM logger_installs li WHERE li.vehicle_id = v.id AND upper_inf(li.during)) AS logger_count
    FROM vehicles v
    JOIN teams t ON t.id = v.managed_by_team_id
    LEFT JOIN team_members m ON m.team_id = v.managed_by_team_id AND m.user_id = $1 AND m.left_at IS NULL`;

async function detail(id: string, user: SessionUser) {
  const { rows } = await query(`${SUMMARY} WHERE v.id = $2`, [user.id, id]);
  const v = rows[0];
  if (!v) throw notFound("That vehicle doesn't exist.");
  if (!v.my_role && user.is_site_admin) v.my_role = "admin";
  const history = await query(
    `SELECT a.id, a.kind, lower(a.during) AS started_at, upper(a.during) AS ended_at, a.note,
            u.id AS user_id, u.display_name, ${avatarUrl("u")} AS avatar_url,
            ab.display_name AS assigned_by_name, eb.display_name AS ended_by_name
       FROM vehicle_assignments a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN users ab ON ab.id = a.assigned_by
       LEFT JOIN users eb ON eb.id = a.ended_by
      WHERE a.vehicle_id = $1 ORDER BY lower(a.during) DESC LIMIT 50`,
    [id],
  );
  const loggers = await query(
    `SELECT l.id, l.name, l.last_seen_at, l.firmware_version, lower(i.during) AS installed_at,
            o.display_name AS owner_name, l.owner_user_id = $2 AS mine
       FROM logger_installs i JOIN loggers l ON l.id = i.logger_id JOIN users o ON o.id = l.owner_user_id
      WHERE i.vehicle_id = $1 AND upper_inf(i.during) ORDER BY l.name`,
    [id, user.id],
  );
  // People the car can go to: the managing team's owners, admins and drivers.
  const drivers = await query(
    `SELECT u.id AS user_id, u.display_name, ${avatarUrl("u")} AS avatar_url, m.role
       FROM team_members m JOIN users u ON u.id = m.user_id
      WHERE m.team_id = $1 AND m.left_at IS NULL AND m.role IN ('owner','admin','driver') AND u.disabled_at IS NULL
      ORDER BY lower(u.display_name)`,
    [v.team_id],
  );
  return {
    vehicle: v,
    can_admin: isAdminRole(v.my_role),
    can_drive: canDrive(v.my_role),
    history: history.rows,
    loggers: loggers.rows,
    drivers: drivers.rows,
  };
}

function cleanFields(b: VehicleFields) {
  const t = (s: string | null | undefined) => (s == null ? s : s.trim() || null);
  const plate = t(b.plate);
  return { ...b, name: b.name?.trim(), make: t(b.make), model: t(b.model), color: t(b.color), plate: plate ? plate.toUpperCase() : plate };
}

export default async function vehicleRoutes(app: FastifyInstance) {
  // Vehicles in every team you're in. ?archived=1 shows archived ones instead.
  app.get<{ Querystring: { archived?: string } }>("/api/vehicles", async (req) => {
    const me = requireUser(req);
    const archived = req.query.archived === "1";
    const { rows } = await query(
      `${SUMMARY}
        WHERE m.user_id IS NOT NULL AND t.deleted_at IS NULL AND (v.archived_at IS NOT NULL) = $2
        ORDER BY t.kind = 'personal' DESC, lower(t.name), lower(v.name)`,
      [me.id, archived],
    );
    return { vehicles: rows };
  });

  app.post<{ Body: VehicleFields & { team_id: string } }>(
    "/api/vehicles",
    { schema: { body: { type: "object", required: ["team_id", "name"], additionalProperties: false,
        properties: { team_id: { type: "string", format: "uuid" }, ...fields } } } },
    async (req, reply) => {
      const me = requireUser(req);
      const team = await loadTeam(req.body.team_id);
      await requireTeamAdmin(team.id, me);
      const b = cleanFields(req.body);
      const id = await tx(async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO vehicles (managed_by_team_id, name, kind, make, model, year, color, plate, checkout_policy, created_by)
           VALUES ($1, $2, coalesce($3, 'car'), $4, $5, $6, $7, $8, coalesce($9, 'open'), $10) RETURNING id`,
          [team.id, b.name, b.kind ?? null, b.make ?? null, b.model ?? null, b.year ?? null, b.color ?? null,
           b.plate ?? null, b.checkout_policy ?? null, me.id],
        );
        // A car in your personal team is simply yours: you're its permanent driver from the start.
        if (team.kind === "personal") {
          await db.query(`INSERT INTO vehicle_assignments (vehicle_id, user_id, kind, assigned_by) VALUES ($1, $2, 'permanent', $2)`,
            [rows[0].id, me.id]);
        }
        await audit(db, { userId: me.id, teamId: team.id, action: "vehicle.created", entity: "vehicle", entityId: rows[0].id });
        return rows[0].id;
      });
      return reply.code(201).send(await detail(id, me));
    },
  );

  app.get<{ Params: { id: string } }>("/api/vehicles/:id", async (req) => {
    const me = requireUser(req);
    await requireVehicleView(pool, await loadVehicle(pool, req.params.id), me);
    return detail(req.params.id, me);
  });

  app.patch<{ Params: { id: string }; Body: VehicleFields & { archived?: boolean } }>(
    "/api/vehicles/:id",
    { schema: { body: { type: "object", additionalProperties: false, properties: { ...fields, archived: { type: "boolean" } } } } },
    async (req) => {
      const me = requireUser(req);
      await tx(async (db) => {
        const v = await loadVehicle(db, req.params.id, true);
        await requireVehicleAdmin(db, v, me);
        const { archived, ...rest } = req.body;
        const b = cleanFields(rest);
        const sets: string[] = [];
        const vals: unknown[] = [v.id];
        for (const [k, val] of Object.entries(b)) {
          if (val === undefined) continue;
          vals.push(val);
          sets.push(`${k} = $${vals.length}`);
        }
        if (archived === true && !v.archived_at) {
          // Archiving hands the car back from everyone and takes its loggers out.
          await endAssignments(db, v.id, me.id);
          await uninstallLoggersFrom(db, v.id);
          sets.push("archived_at = now()");
        } else if (archived === false && v.archived_at) {
          sets.push("archived_at = NULL");
        }
        if (!sets.length) return;
        await db.query(`UPDATE vehicles SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
        await audit(db, { userId: me.id, teamId: v.managed_by_team_id, action: "vehicle.updated", entity: "vehicle", entityId: v.id, data: req.body });
      });
      return detail(req.params.id, me);
    },
  );

  // Hand the car to another team you also run (e.g. from your personal team to the household).
  app.post<{ Params: { id: string }; Body: { team_id: string } }>(
    "/api/vehicles/:id/move",
    { schema: { body: { type: "object", required: ["team_id"], properties: { team_id: { type: "string", format: "uuid" } } } } },
    async (req) => {
      const me = requireUser(req);
      await tx(async (db) => {
        const v = await loadVehicle(db, req.params.id, true);
        await requireVehicleAdmin(db, v, me);
        const team = await loadTeam(req.body.team_id, db);
        if (team.id === v.managed_by_team_id) return;
        await requireTeamAdmin(team.id, me, db);
        // Anyone holding the car who isn't a driver in the new team lets go of it.
        const { rows } = await db.query<{ id: string }>(
          `SELECT a.id FROM vehicle_assignments a
            WHERE a.vehicle_id = $1 AND upper_inf(a.during)
              AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = $2 AND m.user_id = a.user_id
                               AND m.left_at IS NULL AND m.role IN ('owner','admin','driver'))`,
          [v.id, team.id],
        );
        for (const r of rows) await endRange(db, "vehicle_assignments", r.id, me.id);
        await db.query(`UPDATE vehicles SET managed_by_team_id = $2, updated_at = now() WHERE id = $1`, [v.id, team.id]);
        await audit(db, { userId: me.id, teamId: team.id, action: "vehicle.moved", entity: "vehicle", entityId: v.id,
          data: { from: v.managed_by_team_id, to: team.id } });
      });
      return detail(req.params.id, me);
    },
  );

  // ---- permanent drivers ---------------------------------------------------------

  app.post<{ Params: { id: string }; Body: { user_id: string } }>(
    "/api/vehicles/:id/assignments",
    { schema: { body: { type: "object", required: ["user_id"], properties: { user_id: { type: "string", format: "uuid" } } } } },
    async (req, reply) => {
      const me = requireUser(req);
      await tx(async (db) => {
        const v = await loadVehicle(db, req.params.id, true);
        await requireVehicleAdmin(db, v, me);
        requireActive(v);
        await requireDriverInTeam(db, v.managed_by_team_id, req.body.user_id);
        const open = await db.query(
          `SELECT 1 FROM vehicle_assignments WHERE vehicle_id = $1 AND user_id = $2 AND kind = 'permanent' AND upper_inf(during)`,
          [v.id, req.body.user_id],
        );
        if (open.rows.length) throw conflict("They're already a permanent driver of this vehicle.");
        await db.query(
          `INSERT INTO vehicle_assignments (vehicle_id, user_id, kind, assigned_by) VALUES ($1, $2, 'permanent', $3)`,
          [v.id, req.body.user_id, me.id],
        );
        await audit(db, { userId: me.id, teamId: v.managed_by_team_id, action: "vehicle.assigned", entity: "vehicle",
          entityId: v.id, data: { user_id: req.body.user_id } });
      });
      return reply.code(201).send(await detail(req.params.id, me));
    },
  );

  // Ending a permanent assignment: the team's admins, or the driver stepping back.
  app.delete<{ Params: { id: string; assignmentId: string } }>("/api/vehicles/:id/assignments/:assignmentId", async (req) => {
    const me = requireUser(req);
    await tx(async (db) => {
      const v = await loadVehicle(db, req.params.id, true);
      const { rows } = await db.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM vehicle_assignments
          WHERE id = $1 AND vehicle_id = $2 AND kind = 'permanent' AND upper_inf(during)`,
        [req.params.assignmentId, v.id],
      );
      const a = rows[0];
      if (!a) throw notFound("That assignment has already ended.");
      if (a.user_id !== me.id) await requireVehicleAdmin(db, v, me);
      await endRange(db, "vehicle_assignments", a.id, me.id);
      await audit(db, { userId: me.id, teamId: v.managed_by_team_id, action: "vehicle.unassigned", entity: "vehicle",
        entityId: v.id, data: { user_id: a.user_id } });
    });
    return detail(req.params.id, me);
  });

  // ---- check-out and return --------------------------------------------------------

  app.post<{ Params: { id: string }; Body: { user_id?: string; note?: string } }>(
    "/api/vehicles/:id/checkout",
    { schema: { body: { type: ["object", "null"], additionalProperties: false, properties: {
        user_id: { type: "string", format: "uuid" }, note: { type: "string", maxLength: 200 } } } } },
    async (req) => {
      const me = requireUser(req);
      await tx(async (db) => {
        const v = await loadVehicle(db, req.params.id, true);
        const role = await requireVehicleView(db, v, me);
        requireActive(v);
        const target = req.body?.user_id ?? me.id;
        if (target !== me.id) {
          if (!isAdminRole(role)) throw forbidden("Only the team's admins can check a vehicle out to someone else.");
        } else {
          if (!canDrive(role)) throw forbidden("Viewers can't check vehicles out.");
          if (v.checkout_policy === "admin_only" && !isAdminRole(role)) {
            throw forbidden("A team admin hands this vehicle out. Ask one of them.");
          }
        }
        await requireDriverInTeam(db, v.managed_by_team_id, target);
        const out = await db.query<{ user_id: string; display_name: string }>(
          `SELECT a.user_id, u.display_name FROM vehicle_assignments a JOIN users u ON u.id = a.user_id
            WHERE a.vehicle_id = $1 AND a.kind = 'checkout' AND upper_inf(a.during)`,
          [v.id],
        );
        if (out.rows[0]) {
          throw conflict(out.rows[0].user_id === target
            ? "It's already checked out to them."
            : `${out.rows[0].display_name} has it checked out. It has to be returned first.`);
        }
        await db.query(
          `INSERT INTO vehicle_assignments (vehicle_id, user_id, kind, assigned_by, note) VALUES ($1, $2, 'checkout', $3, $4)`,
          [v.id, target, me.id, req.body?.note?.trim() || null],
        );
        await audit(db, { userId: me.id, teamId: v.managed_by_team_id, action: "vehicle.checked_out", entity: "vehicle",
          entityId: v.id, data: { user_id: target } });
      });
      return detail(req.params.id, me);
    },
  );

  app.post<{ Params: { id: string } }>("/api/vehicles/:id/return", async (req) => {
    const me = requireUser(req);
    await tx(async (db) => {
      const v = await loadVehicle(db, req.params.id, true);
      const role = await requireVehicleView(db, v, me);
      const { rows } = await db.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM vehicle_assignments WHERE vehicle_id = $1 AND kind = 'checkout' AND upper_inf(during)`, [v.id],
      );
      const a = rows[0];
      if (!a) throw conflict("It isn't checked out.");
      if (a.user_id !== me.id && !isAdminRole(role)) throw forbidden("Only the person who has it, or a team admin, can return it.");
      await endRange(db, "vehicle_assignments", a.id, me.id);
      await audit(db, { userId: me.id, teamId: v.managed_by_team_id, action: "vehicle.returned", entity: "vehicle",
        entityId: v.id, data: { user_id: a.user_id } });
    });
    return detail(req.params.id, me);
  });

  // ---- photo -----------------------------------------------------------------------

  app.put<{ Params: { id: string } }>("/api/vehicles/:id/photo", { bodyLimit: 3 * 1024 * 1024 }, async (req) => {
    const me = requireUser(req);
    const v = await loadVehicle(pool, req.params.id);
    await requireVehicleAdmin(pool, v, me);
    const ext = PHOTO_TYPES[String(req.headers["content-type"]).split(";")[0]];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) throw badRequest("Send a PNG, JPEG or WebP picture.");
    await fs.mkdir(PHOTO_DIR(), { recursive: true });
    const name = `${v.id}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
    await fs.writeFile(path.join(PHOTO_DIR(), name), req.body);
    const old = await query<{ photo_path: string | null }>(`SELECT photo_path FROM vehicles WHERE id = $1`, [v.id]);
    await query(`UPDATE vehicles SET photo_path = $2, updated_at = now() WHERE id = $1`, [v.id, name]);
    if (old.rows[0]?.photo_path) await fs.rm(path.join(PHOTO_DIR(), old.rows[0].photo_path), { force: true });
    return detail(v.id, me);
  });

  app.delete<{ Params: { id: string } }>("/api/vehicles/:id/photo", async (req) => {
    const me = requireUser(req);
    const v = await loadVehicle(pool, req.params.id);
    await requireVehicleAdmin(pool, v, me);
    const old = await query<{ photo_path: string | null }>(`SELECT photo_path FROM vehicles WHERE id = $1`, [v.id]);
    await query(`UPDATE vehicles SET photo_path = NULL, updated_at = now() WHERE id = $1`, [v.id]);
    if (old.rows[0]?.photo_path) await fs.rm(path.join(PHOTO_DIR(), old.rows[0].photo_path), { force: true });
    return detail(v.id, me);
  });

  app.get<{ Params: { id: string } }>("/api/vehicles/:id/photo", async (req, reply) => {
    const me = requireUser(req);
    const v = await loadVehicle(pool, req.params.id);
    await requireVehicleView(pool, v, me);
    const { rows } = await query<{ photo_path: string | null }>(`SELECT photo_path FROM vehicles WHERE id = $1`, [v.id]);
    if (!rows[0]?.photo_path) throw notFound();
    reply.header("Cache-Control", "private, max-age=86400");
    return reply.sendFile(rows[0].photo_path, PHOTO_DIR());
  });
}
