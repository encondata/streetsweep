// Drives: phone uploads, lists, details, fixing who/what/type, deleting; street marks.
import type { FastifyInstance } from "fastify";
import { pool, query, tx } from "../db.js";
import { requireUser, type SessionUser } from "../auth.js";
import { audit } from "../audit.js";
import { sendJob } from "../jobs.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../http.js";
import { isAdminRole, loadTeam, roleIn } from "../teams.js";
import { canDrive, loadVehicle, vehicleRole } from "../fleet.js";
import { forPhone } from "../drives/attribution.js";
import { insertDrive, MIN_DISTANCE_M, MIN_POINTS, prepare } from "../drives/ingest.js";
import { teamsForDrive } from "../drives/coverage.js";
import type { RawPoint } from "../drives/track.js";
import { avatarUrl } from "./account.js";

const MAX_POINTS = 50_000;

// One shape for lists and details. $1 is the viewer.
const DRIVE = `
  SELECT d.id, d.source, d.status, d.match_method, d.match_error, d.started_at, d.ended_at, d.distance_m,
         d.point_count, d.segment_count, d.drive_type_key,
         (SELECT count(DISTINCT coalesce(lower(w.name), 'way ' || s.way_id))::int FROM segment_passes p JOIN street_segments s ON s.id = p.segment_id
            LEFT JOIN street_ways w ON w.way_id = s.way_id WHERE p.drive_id = d.id) AS street_count, dt.label AS drive_type_label, d.attribution,
         d.user_id, u.display_name AS user_name, ${avatarUrl("u")} AS user_avatar_url,
         d.vehicle_id, v.name AS vehicle_name, v.kind AS vehicle_kind, v.managed_by_team_id AS vehicle_team_id,
         d.logger_id, l.name AS logger_name, l.owner_user_id AS logger_owner_id, d.uploaded_by, d.created_at
    FROM drives d
    JOIN drive_types dt ON dt.key = d.drive_type_key
    LEFT JOIN users u ON u.id = d.user_id
    LEFT JOIN vehicles v ON v.id = d.vehicle_id
    LEFT JOIN loggers l ON l.id = d.logger_id`;

type DriveRow = {
  id: string; user_id: string | null; uploaded_by: string | null; vehicle_id: string | null;
  vehicle_team_id: string | null; logger_owner_id: string | null; deleted_at?: Date | null;
};

async function loadDrive(id: string): Promise<DriveRow & Record<string, unknown>> {
  const { rows } = await query(`${DRIVE} WHERE d.id = $1 AND d.deleted_at IS NULL`, [id]);
  if (!rows[0]) throw notFound("That drive doesn't exist.");
  return rows[0];
}

/**
 * Your own drives, drives from your loggers, and (for a team's admins) drives in the
 * team's vehicles. Everyone else's location history stays theirs.
 */
async function access(d: DriveRow, me: SessionUser): Promise<{ view: boolean; edit: boolean; admin: boolean }> {
  if (me.is_site_admin) return { view: true, edit: true, admin: true };
  const mine = d.user_id === me.id || d.uploaded_by === me.id || d.logger_owner_id === me.id;
  const admin = d.vehicle_team_id ? isAdminRole(await roleIn(d.vehicle_team_id, me.id)) : false;
  return { view: mine || admin, edit: mine || admin, admin: admin || d.logger_owner_id === me.id };
}

async function rebuild(teams: Iterable<string>) {
  for (const teamId of new Set(teams)) await sendJob("coverage-rebuild", { teamId }, { singletonKey: teamId });
}

async function checkDriveType(key: string) {
  const { rows } = await query(`SELECT 1 FROM drive_types WHERE key = $1`, [key]);
  if (!rows.length) throw badRequest("That isn't one of the drive types.");
}

export default async function driveRoutes(app: FastifyInstance) {
  // Upload a finished drive from the phone. Retrying with the same id is safe.
  app.post<{ Body: { id: string; drive_type?: string; vehicle_id?: string | null; points: RawPoint[] } }>(
    "/api/drives",
    { bodyLimit: 16 * 1024 * 1024, schema: { body: { type: "object", required: ["id", "points"], properties: {
        id: { type: "string", format: "uuid" },
        drive_type: { type: "string", maxLength: 32 },
        vehicle_id: { type: ["string", "null"], format: "uuid" },
        points: { type: "array", maxItems: MAX_POINTS, items: { type: "array", minItems: 3, maxItems: 5 } } } } } },
    async (req, reply) => {
      const me = requireUser(req);
      const b = req.body;
      const existing = await query<{ uploaded_by: string | null }>(`SELECT uploaded_by FROM drives WHERE id = $1`, [b.id]);
      if (existing.rows[0]) {
        if (existing.rows[0].uploaded_by !== me.id) throw conflict("A different drive already has that id.");
        return reply.code(200).send({ drive: (await query(`${DRIVE} WHERE d.id = $1`, [b.id])).rows[0], duplicate: true });
      }
      const type = b.drive_type ?? "personal";
      await checkDriveType(type);
      if (b.vehicle_id) {
        const v = await loadVehicle(pool, b.vehicle_id).catch(() => null);
        if (!v || !canDrive(await vehicleRole(pool, v, me))) throw badRequest("You can't log drives in that vehicle.");
      }
      const { fixes, distance } = prepare(b.points);
      if (fixes.length < MIN_POINTS || distance < MIN_DISTANCE_M) {
        throw new HttpError(422, "Too short to be a drive (or the GPS fixes weren't usable).", "too_short");
      }
      const at = new Date(fixes[0].t * 1000);
      await tx(async (db) => {
        await insertDrive(db, {
          id: b.id, source: "phone", uploadedBy: me.id, deviceId: me.device_id, loggerId: null, driveType: type,
          who: await forPhone(db, me.id, b.vehicle_id ?? null, at), fixes,
        });
      });
      await sendJob("drive-match", { driveId: b.id });
      return reply.code(201).send({ drive: (await query(`${DRIVE} WHERE d.id = $1`, [b.id])).rows[0] });
    },
  );

  // Yours, newest first. ?before=<iso> pages back.
  app.get<{ Querystring: { before?: string; limit?: string } }>("/api/drives", async (req) => {
    const me = requireUser(req);
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const { rows } = await query(
      `${DRIVE} WHERE d.deleted_at IS NULL
          AND (d.user_id = $1 OR d.uploaded_by = $1 OR l.owner_user_id = $1)
          AND ($2::timestamptz IS NULL OR d.started_at < $2)
        ORDER BY d.started_at DESC LIMIT $3`,
      [me.id, req.query.before ?? null, limit],
    );
    return { drives: rows };
  });

  // A team's drives, for its owners and admins: the ones that count for it.
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>("/api/teams/:id/drives", async (req) => {
    const me = requireUser(req);
    const team = await loadTeam(req.params.id);
    const role = await roleIn(team.id, me.id);
    if (!isAdminRole(role) && !me.is_site_admin) throw forbidden("Only the team's admins can see everyone's drives.");
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const { rows } = await query(
      `${DRIVE} WHERE d.deleted_at IS NULL AND ($2::timestamptz IS NULL OR d.started_at < $2)
          AND (
            (d.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = $1 AND m.user_id = d.user_id
               AND m.joined_at <= d.started_at AND (m.left_at IS NULL OR m.left_at > d.started_at)))
            OR v.managed_by_team_id = $1)
        ORDER BY d.started_at DESC LIMIT $3`,
      [team.id, req.query.before ?? null, limit],
    );
    return { drives: rows };
  });

  app.get<{ Params: { id: string } }>("/api/drives/:id", async (req) => {
    const me = requireUser(req);
    const d = await loadDrive(req.params.id);
    const a = await access(d, me);
    if (!a.view) throw notFound("That drive doesn't exist.");
    const geo = await query(
      `SELECT ST_AsGeoJSON(ST_Force2D(track), 6)::json AS track,
              (SELECT ST_AsGeoJSON(ST_Collect(s.geom), 6)::json FROM segment_passes p JOIN street_segments s ON s.id = p.segment_id
                WHERE p.drive_id = d.id) AS streets
         FROM drives d WHERE d.id = $1`,
      [d.id],
    );
    const teams = await query(
      `SELECT t.id, t.name, t.kind FROM teams t WHERE t.id = ANY($1::uuid[]) ORDER BY t.kind = 'personal' DESC, t.name`,
      [await teamsForDrive(pool, d.id)],
    );
    return { drive: d, track: geo.rows[0].track, streets: geo.rows[0].streets, counts_for: teams.rows, can_edit: a.edit, can_set_driver: a.admin };
  });

  // Fix a drive: its type, its vehicle, or (vehicle admins, logger owners) who drove it.
  app.patch<{ Params: { id: string }; Body: { drive_type?: string; vehicle_id?: string | null; user_id?: string | null } }>(
    "/api/drives/:id",
    { schema: { body: { type: "object", additionalProperties: false, properties: {
        drive_type: { type: "string", maxLength: 32 },
        vehicle_id: { type: ["string", "null"], format: "uuid" },
        user_id: { type: ["string", "null"], format: "uuid" } } } } },
    async (req) => {
      const me = requireUser(req);
      const d = await loadDrive(req.params.id);
      const a = await access(d, me);
      if (!a.edit) throw notFound("That drive doesn't exist.");
      const b = req.body;
      if (b.drive_type) await checkDriveType(b.drive_type);
      if ("user_id" in b && b.user_id !== d.user_id) {
        if (!a.admin) throw forbidden("Only the vehicle's team admins (or the logger's owner) can change who drove.");
        const teamId = (b.vehicle_id ?? d.vehicle_id) ? (await loadVehicle(pool, (b.vehicle_id ?? d.vehicle_id)!)).managed_by_team_id : null;
        if (b.user_id && teamId && !canDrive(await roleIn(teamId, b.user_id))) throw badRequest("They aren't a driver in that vehicle's team.");
      }
      if (b.vehicle_id && b.vehicle_id !== d.vehicle_id) {
        const v = await loadVehicle(pool, b.vehicle_id).catch(() => null);
        if (!v || !canDrive(await vehicleRole(pool, v, me))) throw badRequest("You can't put drives on that vehicle.");
      }
      const before = await teamsForDrive(pool, d.id);
      await query(
        `UPDATE drives SET drive_type_key = coalesce($2, drive_type_key),
                vehicle_id = CASE WHEN $3::boolean THEN $4 ELSE vehicle_id END,
                user_id = CASE WHEN $5::boolean THEN $6 ELSE user_id END,
                attribution = CASE WHEN $3::boolean OR $5::boolean THEN 'edited' ELSE attribution END,
                updated_at = now()
          WHERE id = $1`,
        [d.id, b.drive_type ?? null, "vehicle_id" in b, b.vehicle_id ?? null, "user_id" in b, b.user_id ?? null],
      );
      await audit(pool, { userId: me.id, action: "drive.edited", entity: "drive", entityId: d.id, data: b });
      await rebuild([...before, ...(await teamsForDrive(pool, d.id))]);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/drives/:id", async (req) => {
    const me = requireUser(req);
    const d = await loadDrive(req.params.id);
    if (!(await access(d, me)).edit) throw notFound("That drive doesn't exist.");
    const teams = await teamsForDrive(pool, d.id);
    await query(`UPDATE drives SET deleted_at = now(), updated_at = now() WHERE id = $1`, [d.id]);
    await audit(pool, { userId: me.id, action: "drive.deleted", entity: "drive", entityId: d.id });
    await rebuild(teams);
    return { ok: true };
  });

  // Match again (after a street import, or if it failed).
  app.post<{ Params: { id: string } }>("/api/drives/:id/rematch", async (req, reply) => {
    const me = requireUser(req);
    const d = await loadDrive(req.params.id);
    if (!(await access(d, me)).edit) throw notFound("That drive doesn't exist.");
    await query(`UPDATE drives SET status = 'received', match_error = NULL, updated_at = now() WHERE id = $1`, [d.id]);
    await sendJob("drive-match", { driveId: d.id });
    return reply.code(202).send({ ok: true });
  });

  // ---- a street, as the map's popup shows it for one team -------------------------

  /**
   * The whole street a piece belongs to, as someone looking at the map means it: the
   * pieces with its name that run on from it, gaps of up to ~150 m bridged (a park, a jog
   * at a junction), so another town's street of the same name stays separate. For an
   * unnamed piece, the OpenStreetMap way it's part of.
   */
  const STREET_RUN = (seg: string) => `
    WITH me AS (
      SELECT s.id, s.way_id, s.geom, lower(w.name) AS nm
        FROM street_segments s JOIN street_ways w ON w.way_id = s.way_id WHERE s.id = ${seg}),
    cand AS (
      SELECT s.id, s.geom FROM me, street_segments s JOIN street_ways w ON w.way_id = s.way_id
       WHERE me.nm IS NOT NULL AND s.retired_at IS NULL AND s.geom && ST_Expand(me.geom, 0.1) AND lower(w.name) = me.nm
      UNION ALL
      SELECT s.id, s.geom FROM me, street_segments s WHERE me.nm IS NULL AND s.way_id = me.way_id AND s.retired_at IS NULL),
    cl AS (SELECT id, ST_ClusterDBSCAN(geom, eps := 0.0015, minpoints := 1) OVER () AS k FROM cand)
    SELECT id FROM cl WHERE k = (SELECT k FROM cl WHERE id = (SELECT id FROM me))`;

  app.get<{ Params: { id: string }; Querystring: { team?: string } }>("/api/segments/:id", async (req) => {
    const me = requireUser(req);
    const teamId = req.query.team ?? null;
    if (teamId && !(await roleIn(teamId, me.id)) && !me.is_site_admin) throw notFound("That team doesn't exist.");
    const { rows } = await query(
      `SELECT s.id, w.name, w.highway, s.length_m,
              c.first_driven_at, c.passes, fu.display_name AS first_driver,
              mk.kind AS mark, mk.note AS mark_note, mu.display_name AS marked_by, mk.created_at AS marked_at
         FROM street_segments s JOIN street_ways w ON w.way_id = s.way_id
         LEFT JOIN team_coverage c ON c.team_id = $2 AND c.segment_id = s.id
         LEFT JOIN drives fd ON fd.id = c.first_drive_id
         LEFT JOIN users fu ON fu.id = fd.user_id
         LEFT JOIN segment_marks mk ON mk.team_id = $2 AND mk.segment_id = s.id
         LEFT JOIN users mu ON mu.id = mk.user_id
        WHERE s.id = $1`,
      [req.params.id, teamId],
    );
    if (!rows[0]) throw notFound("No such street segment.");
    const role = teamId ? await roleIn(teamId, me.id) : null;
    // The whole street, for "mark all of it": how long, and how much still to sweep.
    let street = null;
    if (teamId) {
      const st = await query<{ n: number; m: number; left_m: number; done_n: number; out_n: number }>(
        `SELECT count(*)::int AS n, coalesce(sum(s.length_m), 0)::float AS m,
                coalesce(sum(s.length_m) FILTER (WHERE c.segment_id IS NULL AND mk.kind IS NULL), 0)::float AS left_m,
                count(*) FILTER (WHERE mk.kind = 'complete')::int AS done_n,
                count(*) FILTER (WHERE mk.kind = 'excluded')::int AS out_n
           FROM (${STREET_RUN("$1")}) r JOIN street_segments s ON s.id = r.id
           LEFT JOIN team_coverage c ON c.team_id = $2 AND c.segment_id = s.id
           LEFT JOIN segment_marks mk ON mk.team_id = $2 AND mk.segment_id = s.id`,
        [req.params.id, teamId]);
      const r = st.rows[0];
      street = { pieces: r.n, meters: Math.round(r.m), left_m: Math.round(r.left_m), marked_done: r.done_n, left_out: r.out_n };
    }
    return { segment: rows[0], street, can_mark: canDrive(role) || me.is_site_admin };
  });

  // Mark a street for a team: done by hand ("complete"), or left out ("excluded").
  app.put<{ Params: { id: string; segmentId: string }; Body: { kind: "complete" | "excluded"; note?: string | null } }>(
    "/api/teams/:id/marks/:segmentId",
    { schema: { body: { type: "object", required: ["kind"], properties: {
        kind: { type: "string", enum: ["complete", "excluded"] }, note: { type: ["string", "null"], maxLength: 500 } } } } },
    async (req) => {
      const me = requireUser(req);
      const team = await loadTeam(req.params.id);
      if (!canDrive(await roleIn(team.id, me.id)) && !me.is_site_admin) throw forbidden("Viewers can't mark streets.");
      const seg = await query(`SELECT 1 FROM street_segments WHERE id = $1`, [req.params.segmentId]).catch(() => ({ rows: [] }));
      if (!seg.rows.length) throw notFound("No such street segment.");
      await query(
        `INSERT INTO segment_marks (team_id, segment_id, kind, user_id, note) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (team_id, segment_id) DO UPDATE SET kind = $3, user_id = $4, note = $5, created_at = now()`,
        [team.id, req.params.segmentId, req.body.kind, me.id, req.body.note?.trim() || null],
      );
      await audit(pool, { userId: me.id, teamId: team.id, action: `street.${req.body.kind}`, entity: "segment", entityId: req.params.segmentId });
      await sendJob("achievements", { teamId: team.id }, { singletonKey: team.id });
      return { ok: true };
    },
  );

  // The whole street at once (see STREET_RUN): "complete" marks what isn't driven or
  // marked yet; "excluded" leaves out what isn't marked; "clear" takes off marks of the
  // kind named in `clear`. Never overrides a mark of the other kind.
  app.post<{ Params: { id: string }; Body: { segment_id: number; kind: "complete" | "excluded" | "clear"; clear?: "complete" | "excluded"; note?: string | null } }>(
    "/api/teams/:id/marks/street",
    { schema: { body: { type: "object", required: ["segment_id", "kind"], properties: {
        segment_id: { type: "integer" }, kind: { type: "string", enum: ["complete", "excluded", "clear"] },
        clear: { type: "string", enum: ["complete", "excluded"] }, note: { type: ["string", "null"], maxLength: 500 } } } } },
    async (req) => {
      const me = requireUser(req);
      const team = await loadTeam(req.params.id);
      if (!canDrive(await roleIn(team.id, me.id)) && !me.is_site_admin) throw forbidden("Viewers can't mark streets.");
      const b = req.body;
      if (b.kind === "clear" && !b.clear) throw badRequest("Say which marks to clear.");
      const changed = await tx(async (c) => {
        if (b.kind === "clear") {
          const { rows } = await c.query<{ segment_id: string; length_m: number }>(
            `DELETE FROM segment_marks mk USING street_segments s
              WHERE mk.team_id = $2 AND mk.kind = $3 AND mk.segment_id IN (${STREET_RUN("$1")}) AND s.id = mk.segment_id
              RETURNING mk.segment_id, s.length_m`,
            [b.segment_id, team.id, b.clear]);
          if (rows.length) {
            await c.query(`INSERT INTO deletions (kind, team_id, key) SELECT 'mark', $1, unnest($2::text[])`,
              [team.id, rows.map((r) => String(r.segment_id))]);
          }
          return rows;
        }
        const { rows } = await c.query<{ segment_id: string; length_m: number }>(
          `INSERT INTO segment_marks (team_id, segment_id, kind, user_id, note)
           SELECT $2, s.id, $3, $4, $5 FROM (${STREET_RUN("$1")}) r JOIN street_segments s ON s.id = r.id
            WHERE NOT EXISTS (SELECT 1 FROM segment_marks mk WHERE mk.team_id = $2 AND mk.segment_id = s.id)
              AND ($3 <> 'complete' OR NOT EXISTS (SELECT 1 FROM team_coverage tc WHERE tc.team_id = $2 AND tc.segment_id = s.id))
           ON CONFLICT DO NOTHING
           RETURNING segment_id, (SELECT length_m FROM street_segments WHERE id = segment_id)`,
          [b.segment_id, team.id, b.kind, me.id, b.note?.trim() || null]);
        return rows;
      });
      await audit(pool, { userId: me.id, teamId: team.id, action: b.kind === "clear" ? `street.unmark_${b.clear}` : `street.${b.kind}`,
        entity: "segment", entityId: String(b.segment_id), data: { whole_street: true, pieces: changed.length } });
      if (changed.length) await sendJob("achievements", { teamId: team.id }, { singletonKey: team.id });
      return { pieces: changed.length, meters: Math.round(changed.reduce((t, r) => t + Number(r.length_m), 0)) };
    },
  );

  app.delete<{ Params: { id: string; segmentId: string } }>("/api/teams/:id/marks/:segmentId", async (req) => {
    const me = requireUser(req);
    const team = await loadTeam(req.params.id);
    if (!canDrive(await roleIn(team.id, me.id)) && !me.is_site_admin) throw forbidden("Viewers can't mark streets.");
    const { rowCount } = await query(`DELETE FROM segment_marks WHERE team_id = $1 AND segment_id = $2`, [team.id, req.params.segmentId]);
    if (!rowCount) throw notFound("That street isn't marked.");
    await query(`INSERT INTO deletions (kind, team_id, key) VALUES ('mark', $1, $2)`, [team.id, req.params.segmentId]);
    return { ok: true };
  });
}
