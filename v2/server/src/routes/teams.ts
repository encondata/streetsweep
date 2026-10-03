// Teams: search, create, join requests, members and roles, drive-type toggles.
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { pool, query, tx } from "../db.js";
import { requireUser, type SessionUser } from "../auth.js";
import { audit } from "../audit.js";
import { newJoinCode } from "../users.js";
import { badRequest, conflict, forbidden, notFound } from "../http.js";
import { isAdminRole, loadTeam, ownerCount, requireTeamAdmin, roleIn, type Role } from "../teams.js";
import { avatarUrl } from "./account.js";
import { endAssignmentsInTeam } from "../fleet.js";

const teamName = { type: "string", minLength: 1, maxLength: 80 } as const;
const message = { type: "string", maxLength: 500 } as const;
const grantable = { type: "string", enum: ["admin", "driver", "viewer"] } as const;
const anyRole = { type: "string", enum: ["owner", "admin", "driver", "viewer"] } as const;

/** Lock the team row so owner counts and membership checks can't race. */
async function lockTeam(db: pg.PoolClient, id: string) {
  const t = await loadTeam(id, db);
  await db.query(`SELECT 1 FROM teams WHERE id = $1 FOR UPDATE`, [id]);
  return t;
}

async function preview(teamId: string, user: SessionUser) {
  const { rows } = await query(
    `SELECT t.id, t.name, t.kind, t.listed,
            (SELECT count(*)::int FROM team_members m WHERE m.team_id = t.id AND m.left_at IS NULL) AS member_count
       FROM teams t WHERE t.id = $1`,
    [teamId],
  );
  const req = await query(
    `SELECT id, status, requested_at FROM team_join_requests
      WHERE team_id = $1 AND user_id = $2 AND status = 'pending'`,
    [teamId, user.id],
  );
  return { team: rows[0], my_role: await roleIn(teamId, user.id), my_request: req.rows[0] ?? null };
}

async function detail(teamId: string, user: SessionUser) {
  const team = await loadTeam(teamId);
  const myRole = await roleIn(teamId, user.id);
  const admin = isAdminRole(myRole) || user.is_site_admin;
  const members = await query(
    `SELECT u.id AS user_id, u.display_name, u.email, ${avatarUrl("u")} AS avatar_url, m.role, m.joined_at
       FROM team_members m JOIN users u ON u.id = m.user_id
      WHERE m.team_id = $1 AND m.left_at IS NULL
      ORDER BY array_position(ARRAY['owner','admin','driver','viewer'], m.role), lower(u.display_name)`,
    [teamId],
  );
  const driveTypes = await query(
    `SELECT d.key, d.label, d.icon, coalesce(t.counts, true) AS counts
       FROM drive_types d LEFT JOIN team_drive_types t ON t.drive_type_key = d.key AND t.team_id = $1
      WHERE d.archived_at IS NULL ORDER BY d.sort, d.label`,
    [teamId],
  );
  const requests = admin
    ? (await query(
        `SELECT r.id, r.message, r.requested_at, u.id AS user_id, u.display_name, u.email, ${avatarUrl("u")} AS avatar_url
           FROM team_join_requests r JOIN users u ON u.id = r.user_id
          WHERE r.team_id = $1 AND r.status = 'pending' ORDER BY r.requested_at`,
        [teamId],
      )).rows
    : [];
  return {
    team: { id: team.id, name: team.name, kind: team.kind, listed: team.listed, join_code: admin ? team.join_code : undefined },
    my_role: myRole,
    can_admin: admin,
    // Emails are for the people running the team; everyone else sees names.
    members: members.rows.map((m) => (admin ? m : { ...m, email: undefined })),
    drive_types: driveTypes.rows,
    requests,
  };
}

async function createRequest(user: SessionUser, teamId: string, msg: string | undefined) {
  return tx(async (db) => {
    const team = await lockTeam(db, teamId);
    if (team.kind === "personal") throw forbidden("Personal teams can't take new members.");
    if (await roleIn(teamId, user.id, db)) throw conflict("You're already in this team.");
    const pending = await db.query(
      `SELECT id FROM team_join_requests WHERE team_id = $1 AND user_id = $2 AND status = 'pending'`, [teamId, user.id],
    );
    if (pending.rows.length) throw conflict("You've already asked to join. A team admin will look at it.");
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO team_join_requests (team_id, user_id, message) VALUES ($1, $2, $3) RETURNING id`,
      [teamId, user.id, msg?.trim() || null],
    );
    await audit(db, { userId: user.id, teamId, action: "team.join_requested", entity: "join_request", entityId: rows[0].id });
    return rows[0].id;
  });
}

export default async function teamRoutes(app: FastifyInstance) {
  // Search listed teams. Unlisted ones are only reached through their join code.
  app.get<{ Querystring: { q?: string } }>("/api/teams", async (req) => {
    const me = requireUser(req);
    const q = (req.query.q ?? "").trim();
    const { rows } = await query(
      `SELECT t.id, t.name,
              (SELECT count(*)::int FROM team_members m WHERE m.team_id = t.id AND m.left_at IS NULL) AS member_count,
              (SELECT role FROM team_members m WHERE m.team_id = t.id AND m.user_id = $1 AND m.left_at IS NULL) AS my_role,
              EXISTS (SELECT 1 FROM team_join_requests r WHERE r.team_id = t.id AND r.user_id = $1 AND r.status = 'pending') AS requested
         FROM teams t
        WHERE t.deleted_at IS NULL AND t.kind = 'shared' AND t.listed
          AND ($2 = '' OR t.name ILIKE '%' || $2 || '%')
        ORDER BY lower(t.name) LIMIT 50`,
      [me.id, q.replace(/[\\%_]/g, (c) => "\\" + c)],
    );
    return { teams: rows };
  });

  app.post<{ Body: { name: string; listed?: boolean } }>(
    "/api/teams",
    { schema: { body: { type: "object", required: ["name"], additionalProperties: false,
        properties: { name: teamName, listed: { type: "boolean" } } } } },
    async (req, reply) => {
      const me = requireUser(req);
      const id = await tx(async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO teams (name, kind, listed, join_code, created_by) VALUES ($1, 'shared', $2, $3, $4) RETURNING id`,
          [req.body.name.trim(), req.body.listed ?? true, newJoinCode(), me.id],
        );
        await db.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`, [rows[0].id, me.id]);
        await audit(db, { userId: me.id, teamId: rows[0].id, action: "team.created", entity: "team", entityId: rows[0].id });
        return rows[0].id;
      });
      return reply.code(201).send(await detail(id, me));
    },
  );

  app.get<{ Params: { id: string } }>("/api/teams/:id", async (req) => {
    const me = requireUser(req);
    const team = await loadTeam(req.params.id);
    if ((await roleIn(team.id, me.id)) || me.is_site_admin) return detail(team.id, me);
    // Outsiders see a listed team's name and size so they can ask to join; unlisted stays hidden.
    if (team.kind === "shared" && team.listed) return preview(team.id, me);
    throw notFound("That team doesn't exist.");
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; listed?: boolean } }>(
    "/api/teams/:id",
    { schema: { body: { type: "object", additionalProperties: false, properties: { name: teamName, listed: { type: "boolean" } } } } },
    async (req) => {
      const me = requireUser(req);
      const team = await loadTeam(req.params.id);
      await requireTeamAdmin(team.id, me);
      if (team.kind === "personal" && req.body.listed) throw badRequest("A personal team can't be listed.");
      await query(
        `UPDATE teams SET name = coalesce($2, name), listed = coalesce($3, listed), updated_at = now() WHERE id = $1`,
        [team.id, req.body.name?.trim() || null, req.body.listed ?? null],
      );
      await audit(pool, { userId: me.id, teamId: team.id, action: "team.updated", entity: "team", entityId: team.id, data: req.body });
      return detail(team.id, me);
    },
  );

  app.post<{ Params: { id: string } }>("/api/teams/:id/join-code", async (req) => {
    const me = requireUser(req);
    const team = await loadTeam(req.params.id);
    await requireTeamAdmin(team.id, me);
    await query(`UPDATE teams SET join_code = $2, updated_at = now() WHERE id = $1`, [team.id, newJoinCode()]);
    await audit(pool, { userId: me.id, teamId: team.id, action: "team.join_code_reset", entity: "team", entityId: team.id });
    return detail(team.id, me);
  });

  app.delete<{ Params: { id: string } }>("/api/teams/:id", async (req) => {
    const me = requireUser(req);
    await tx(async (db) => {
      const team = await lockTeam(db, req.params.id);
      if (team.kind === "personal") throw forbidden("Your personal team can't be deleted.");
      if ((await roleIn(team.id, me.id, db)) !== "owner" && !me.is_site_admin) throw forbidden("Only an owner can delete the team.");
      const cars = await db.query(`SELECT 1 FROM vehicles WHERE managed_by_team_id = $1 AND archived_at IS NULL LIMIT 1`, [team.id]);
      if (cars.rows.length) throw conflict("This team still manages vehicles. Move them to another team or archive them first.");
      await db.query(`UPDATE teams SET deleted_at = now() WHERE id = $1`, [team.id]);
      await db.query(`UPDATE team_members SET left_at = now() WHERE team_id = $1 AND left_at IS NULL`, [team.id]);
      await db.query(`UPDATE team_join_requests SET status = 'declined', decided_at = now(), decided_by = $2
                       WHERE team_id = $1 AND status = 'pending'`, [team.id, me.id]);
      await audit(db, { userId: me.id, teamId: team.id, action: "team.deleted", entity: "team", entityId: team.id });
    });
    return { ok: true };
  });

  // ---- joining ---------------------------------------------------------------

  app.get<{ Params: { code: string } }>("/api/join/:code", async (req) => {
    const me = requireUser(req);
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM teams WHERE join_code = $1 AND kind = 'shared' AND deleted_at IS NULL`, [req.params.code.toUpperCase()],
    );
    if (!rows[0]) throw notFound("That join link doesn't work any more. Ask the team for a new one.");
    return preview(rows[0].id, me);
  });

  app.post<{ Params: { id: string }; Body: { message?: string; code?: string } }>(
    "/api/teams/:id/join-requests",
    { schema: { body: { type: "object", additionalProperties: false, properties: { message, code: { type: "string", maxLength: 20 } } } } },
    async (req, reply) => {
      const me = requireUser(req);
      const team = await loadTeam(req.params.id);
      if (!team.listed && (req.body.code ?? "").toUpperCase() !== team.join_code) throw notFound("That team doesn't exist.");
      const id = await createRequest(me, team.id, req.body.message);
      return reply.code(201).send({ id, ...(await preview(team.id, me)) });
    },
  );

  app.get("/api/me/join-requests", async (req) => {
    const me = requireUser(req);
    const { rows } = await query(
      `SELECT r.id, r.status, r.message, r.requested_at, r.decided_at, t.id AS team_id, t.name AS team_name
         FROM team_join_requests r JOIN teams t ON t.id = r.team_id
        WHERE r.user_id = $1 AND t.deleted_at IS NULL
          AND (r.status = 'pending' OR r.decided_at > now() - interval '30 days')
        ORDER BY r.requested_at DESC LIMIT 20`,
      [me.id],
    );
    return { requests: rows };
  });

  app.post<{ Params: { id: string }; Body: { role?: Role } }>(
    "/api/join-requests/:id/approve",
    { schema: { body: { type: ["object", "null"], additionalProperties: false, properties: { role: grantable } } } },
    async (req) => {
      const me = requireUser(req);
      const role = req.body?.role ?? "driver";
      const teamId = await tx(async (db) => {
        const r = await pendingRequest(db, req.params.id);
        await lockTeam(db, r.team_id);
        await requireTeamAdmin(r.team_id, me, db);
        await db.query(`UPDATE team_join_requests SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [r.id, me.id]);
        if (!(await roleIn(r.team_id, r.user_id, db))) {
          await db.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [r.team_id, r.user_id, role]);
        }
        await audit(db, { userId: me.id, teamId: r.team_id, action: "team.join_approved", entity: "user", entityId: r.user_id, data: { role } });
        return r.team_id;
      });
      return detail(teamId, me);
    },
  );

  app.post<{ Params: { id: string } }>("/api/join-requests/:id/decline", async (req) => {
    const me = requireUser(req);
    const teamId = await tx(async (db) => {
      const r = await pendingRequest(db, req.params.id);
      await requireTeamAdmin(r.team_id, me, db);
      await db.query(`UPDATE team_join_requests SET status = 'declined', decided_by = $2, decided_at = now() WHERE id = $1`, [r.id, me.id]);
      await audit(db, { userId: me.id, teamId: r.team_id, action: "team.join_declined", entity: "user", entityId: r.user_id });
      return r.team_id;
    });
    return detail(teamId, me);
  });

  app.post<{ Params: { id: string } }>("/api/join-requests/:id/withdraw", async (req) => {
    const me = requireUser(req);
    await tx(async (db) => {
      const r = await pendingRequest(db, req.params.id);
      if (r.user_id !== me.id) throw notFound();
      await db.query(`UPDATE team_join_requests SET status = 'withdrawn', decided_at = now() WHERE id = $1`, [r.id]);
    });
    return { ok: true };
  });

  // ---- members -----------------------------------------------------------------

  app.patch<{ Params: { id: string; userId: string }; Body: { role: Role } }>(
    "/api/teams/:id/members/:userId",
    { schema: { body: { type: "object", required: ["role"], additionalProperties: false, properties: { role: anyRole } } } },
    async (req) => {
      const me = requireUser(req);
      const next = req.body.role;
      await tx(async (db) => {
        const team = await lockTeam(db, req.params.id);
        if (team.kind === "personal") throw forbidden("Roles in a personal team can't change.");
        const myRole = await requireTeamAdmin(team.id, me, db);
        const current = await roleIn(team.id, req.params.userId, db);
        if (!current) throw notFound("They aren't in this team.");
        if (current === next) return;
        const actingOwner = myRole === "owner" || me.is_site_admin;
        if ((current === "owner" || next === "owner") && !actingOwner) throw forbidden("Only an owner can make or unmake owners.");
        if (current === "owner" && (await ownerCount(team.id, db)) === 1) {
          throw conflict("A team needs at least one owner. Make someone else an owner first.");
        }
        await db.query(`UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [team.id, req.params.userId, next]);
        // Viewers don't drive, so a viewer lets go of the team's vehicles.
        if (next === "viewer") await endAssignmentsInTeam(db, team.id, req.params.userId, me.id);
        await audit(db, { userId: me.id, teamId: team.id, action: "team.role_changed", entity: "user",
          entityId: req.params.userId, data: { from: current, to: next } });
      });
      return detail(req.params.id, me);
    },
  );

  // Removing someone, or leaving yourself.
  app.delete<{ Params: { id: string; userId: string } }>("/api/teams/:id/members/:userId", async (req) => {
    const me = requireUser(req);
    const self = req.params.userId === me.id;
    await tx(async (db) => {
      const team = await lockTeam(db, req.params.id);
      if (team.kind === "personal") throw forbidden("You can't leave your personal team.");
      const current = await roleIn(team.id, req.params.userId, db);
      if (!current) throw notFound("They aren't in this team.");
      if (!self) {
        const myRole = await requireTeamAdmin(team.id, me, db);
        if (current === "owner" && myRole !== "owner" && !me.is_site_admin) throw forbidden("Only an owner can remove an owner.");
      }
      if (current === "owner" && (await ownerCount(team.id, db)) === 1) {
        throw conflict(self
          ? "You're the only owner. Make someone else an owner first, or delete the team."
          : "A team needs at least one owner.");
      }
      await db.query(`UPDATE team_members SET left_at = now() WHERE team_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [team.id, req.params.userId]);
      // Leaving the team hands back its vehicles.
      await endAssignmentsInTeam(db, team.id, req.params.userId, me.id);
      await audit(db, { userId: me.id, teamId: team.id, action: self ? "team.left" : "team.member_removed",
        entity: "user", entityId: req.params.userId });
    });
    return self ? { ok: true } : detail(req.params.id, me);
  });

  // ---- drive types -------------------------------------------------------------

  app.put<{ Params: { id: string; key: string }; Body: { counts: boolean } }>(
    "/api/teams/:id/drive-types/:key",
    { schema: { body: { type: "object", required: ["counts"], additionalProperties: false, properties: { counts: { type: "boolean" } } } } },
    async (req) => {
      const me = requireUser(req);
      const team = await loadTeam(req.params.id);
      await requireTeamAdmin(team.id, me);
      const known = await query(`SELECT 1 FROM drive_types WHERE key = $1`, [req.params.key]);
      if (!known.rows.length) throw notFound("No such drive type.");
      await query(
        `INSERT INTO team_drive_types (team_id, drive_type_key, counts, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id, drive_type_key) DO UPDATE SET counts = $3, updated_by = $4, updated_at = now()`,
        [team.id, req.params.key, req.body.counts, me.id],
      );
      await audit(pool, { userId: me.id, teamId: team.id, action: "team.drive_type_toggled", entity: "drive_type",
        entityId: req.params.key, data: { counts: req.body.counts } });
      return detail(team.id, me);
    },
  );
}

async function pendingRequest(db: pg.PoolClient, id: string) {
  const { rows } = await db.query<{ id: string; team_id: string; user_id: string }>(
    `SELECT id, team_id, user_id FROM team_join_requests WHERE id = $1 AND status = 'pending' FOR UPDATE`, [id],
  );
  if (!rows[0]) throw notFound("That request has already been dealt with.");
  return rows[0];
}
