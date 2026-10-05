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
/** Marking inside an outline: big enough for a whole neighbourhood or two, not a county. */
const MARK_WITHIN_MAX_KM2 = 50;
const MARK_WITHIN_MAX_PIECES = 5000;

// One shape for lists and details. $1 is the viewer.
const DRIVE = `
  SELECT d.id, d.source, d.status, d.match_method, d.match_error, d.started_at, d.ended_at, d.distance_m,
         d.point_count, d.segment_count, d.drive_type_key,
         (SELECT count(DISTINCT coalesce(lower(w.name), 'way ' || s.way_id))::int FROM segment_passes p JOIN street_segments s ON s.id = p.segment_id
            LEFT JOIN street_ways w ON w.way_id = s.way_id WHERE p.drive_id = d.id) AS street_count, dt.label AS drive_type_label, d.attribution,
         d.user_id, u.display_name AS user_name, ${avatarUrl("u")} AS user_avatar_url,
         d.vehicle_id, v.name AS vehicle_name, v.kind AS vehicle_kind, v.managed_by_team_id AS vehicle_team_id,
         CASE WHEN v.photo_path IS NOT NULL THEN '/api/vehicles/' || v.id || '/photo?v=' || v.photo_path END AS vehicle_photo_url,
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

  /** A way's route numbers ("TX 6;FM 646" → {TX 6, FM 646}), empty if it has none. */
  const REFS = (w: string) => `coalesce(string_to_array(regexp_replace(${w}.tags->>'ref', '\\s*;\\s*', ';', 'g'), ';'), '{}')`;

  /**
   * The whole street a piece belongs to, as someone looking at the map means it: the
   * pieces with its name that run on from it, gaps of up to ~150 m bridged (a park, a jog
   * at a junction), so another town's street of the same name stays separate. For an
   * unnamed piece, the OpenStreetMap way it's part of.
   *
   * Plus the bits that only exist because of it: short pieces with both ends on the
   * street, such as the crossovers between a divided road's two sides and slip lanes that
   * leave and rejoin it (unnamed, a ramp, or its own name: up to 200 m), and where another
   * street crosses the median, its few metres between the two sides (up to 30 m, so a
   * real block of a side street never counts).
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
    cl AS (SELECT id, ST_ClusterDBSCAN(geom, eps := 0.0015, minpoints := 1) OVER () AS k FROM cand),
    base AS (SELECT id FROM cl WHERE k = (SELECT k FROM cl WHERE id = (SELECT id FROM me))),
    segs AS (SELECT s.from_node, s.to_node, s.geom FROM street_segments s WHERE s.id IN (SELECT id FROM base)),
    nodes AS (SELECT from_node AS n FROM segs UNION SELECT to_node FROM segs),
    box AS (SELECT ST_Expand(ST_Extent(geom), 0.001) AS b FROM segs)
    SELECT id FROM base
    UNION
    SELECT s.id FROM box, me, street_segments s JOIN street_ways w ON w.way_id = s.way_id
     WHERE s.retired_at IS NULL AND s.geom && box.b AND s.length_m <= 200
       AND s.from_node IN (SELECT n FROM nodes) AND s.to_node IN (SELECT n FROM nodes)
       AND (w.name IS NULL OR w.highway LIKE '%\\_link' OR lower(w.name) = me.nm OR s.length_m <= 30)`;

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

  /**
   * A stretch of a street between two of its pieces (click one, then another): the way
   * along it from the first to the second, small gaps in the map bridged, plus on a
   * divided road the other side alongside, and the crossovers between. For marking part
   * of a long road ("Highway 6, but only through town"). A highway is followed by its
   * route number as well as its name, since TX 6 is "Highway 6" in one town, "Alvin
   * Sugarland Road" in the next and unnamed between. Named by the cross streets at its ends.
   */
  app.get<{ Params: { a: string; b: string } }>("/api/segments/:a/between/:b", async (req) => {
    requireUser(req);
    const [a, b] = [Number(req.params.a), Number(req.params.b)];
    if (!Number.isInteger(a) || !Number.isInteger(b)) throw badRequest("Two street pieces, by id.");
    const ends = await query<{ id: string; nm: string | null; name: string | null; refs: string[] | null; x: number; y: number }>(
      `SELECT s.id, lower(w.name) AS nm, w.name, ${REFS("w")} AS refs, ST_X(ST_Centroid(s.geom)) AS x, ST_Y(ST_Centroid(s.geom)) AS y
         FROM street_segments s JOIN street_ways w ON w.way_id = s.way_id WHERE s.id = ANY($1::bigint[])`, [[a, b]]);
    const A = ends.rows.find((r) => Number(r.id) === a), B = ends.rows.find((r) => Number(r.id) === b);
    if (!A || !B) throw notFound("No such street piece.");
    // The same road: a route number in common, or failing that the same name.
    const refs = (A.refs ?? []).filter((r) => (B.refs ?? []).includes(r));
    const nm = refs.length ? null : A.nm && A.nm === B.nm ? A.nm : null;
    if (!refs.length && !nm) throw badRequest(`Pick two points on the same road${A.name ? ` (${A.name})` : ""}.`);
    const SAME = (w: string, nmP: string, refP: string) =>
      `(coalesce(lower(${w}.name) = ${nmP}, false) OR (${refP}::text[] <> '{}' AND ${REFS(w)} && ${refP}::text[]))`;

    // Same-name pieces in a box around the two, with room for the road to wander.
    const pad = Math.max(0.02, 0.3 * Math.max(Math.abs(A.x - B.x), Math.abs(A.y - B.y)));
    const box = [Math.min(A.x, B.x) - pad, Math.min(A.y, B.y) - pad, Math.max(A.x, B.x) + pad, Math.max(A.y, B.y) + pad];
    const { rows: cand } = await query<{ id: string; f: string; t: string; m: number; x0: number; y0: number; x1: number; y1: number }>(
      `SELECT s.id, s.from_node AS f, s.to_node AS t, s.length_m AS m,
              ST_X(ST_StartPoint(s.geom)) AS x0, ST_Y(ST_StartPoint(s.geom)) AS y0,
              ST_X(ST_EndPoint(s.geom)) AS x1, ST_Y(ST_EndPoint(s.geom)) AS y1
         FROM street_segments s JOIN street_ways w ON w.way_id = s.way_id
        WHERE s.retired_at IS NULL AND s.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326) AND ${SAME("w", "$5", "$6")}
        LIMIT 40000`, [...box, nm, refs]);

    // A graph of its pieces: shared nodes join them, and ends within ~150 m of each other
    // are bridged (dearer, so real road wins), where the mapped road has a gap.
    type Edge = { to: string; cost: number; seg: string | null };
    const adj = new Map<string, Edge[]>();
    const link = (u: string, v: string, cost: number, seg: string | null) => {
      if (!adj.has(u)) adj.set(u, []);
      if (!adj.has(v)) adj.set(v, []);
      adj.get(u)!.push({ to: v, cost, seg });
      adj.get(v)!.push({ to: u, cost, seg });
    };
    const at = new Map<string, [number, number]>();
    for (const c of cand) {
      link(c.f, c.t, c.m, c.id);
      at.set(c.f, [c.x0, c.y0]);
      at.set(c.t, [c.x1, c.y1]);
    }
    const metres = ([x0, y0]: [number, number], [x1, y1]: [number, number]) => Math.hypot((x1 - x0) * 96_000, (y1 - y0) * 111_000);
    const cells = new Map<string, string[]>();
    const CELL = 0.0015;
    for (const [n, p] of at) {
      const k = `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k)!.push(n);
    }
    for (const [n, p] of at) {
      if ((adj.get(n)?.length ?? 0) > 1) continue; // only loose ends need bridging
      const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const o of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (o === n) continue;
          const d = metres(p, at.get(o)!);
          if (d <= 150) link(n, o, d * 3 + 20, null);
        }
      }
    }

    // Shortest way from either end of the first piece to either end of the second.
    const byId = new Map(cand.map((c) => [c.id, c]));
    const ca = byId.get(String(a)), cb = byId.get(String(b));
    if (!ca || !cb) throw badRequest("Those two points are too far apart along the street to join up.");
    const dist = new Map<string, number>([[ca.f, 0], [ca.t, 0]]);
    const prev = new Map<string, Edge & { from: string }>();
    const heap: [number, string][] = [[0, ca.f], [0, ca.t]];
    const push = (e: [number, string]) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0]; const last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const goal = new Set([cb.f, cb.t]);
    let reached: string | null = null;
    while (heap.length) {
      const [d, u] = pop();
      if (d > (dist.get(u) ?? Infinity)) continue;
      if (goal.has(u)) { reached = u; break; }
      for (const e of adj.get(u) ?? []) {
        const nd = d + e.cost;
        if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { ...e, from: u }); push([nd, e.to]); }
      }
    }
    if (!reached) throw badRequest("Couldn't follow the street between those two points. Try points closer together.");
    const path = new Set<string>([String(a), String(b)]);
    for (let n = reached; prev.has(n); n = prev.get(n)!.from) { const e = prev.get(n)!; if (e.seg) path.add(e.seg); }

    // The other side of a divided road alongside, then crossovers and the median crossings.
    const { rows } = await query<{ id: string; m: number }>(
      `WITH p AS (SELECT s.* FROM street_segments s WHERE s.id = ANY($1::bigint[])),
       line AS (SELECT ST_Collect(geom) AS g FROM p),
       side AS (
         SELECT s.id FROM street_segments s JOIN street_ways w ON w.way_id = s.way_id, line
          WHERE s.retired_at IS NULL AND s.geom && ST_Expand(line.g, 0.001) AND ${SAME("w", "$2", "$3")}
            AND ST_DWithin(ST_StartPoint(s.geom)::geography, line.g::geography, 60)
            AND ST_DWithin(ST_EndPoint(s.geom)::geography, line.g::geography, 60)),
       run AS (SELECT id FROM p UNION SELECT id FROM side),
       segs AS (SELECT s.* FROM street_segments s WHERE s.id IN (SELECT id FROM run)),
       nodes AS (SELECT from_node AS n FROM segs UNION SELECT to_node FROM segs),
       box AS (SELECT ST_Expand(ST_Extent(geom), 0.001) AS b FROM segs),
       allsegs AS (
         SELECT id FROM run
         UNION
         SELECT s.id FROM box, street_segments s JOIN street_ways w ON w.way_id = s.way_id
          WHERE s.retired_at IS NULL AND s.geom && box.b AND s.length_m <= 200
            AND s.from_node IN (SELECT n FROM nodes) AND s.to_node IN (SELECT n FROM nodes)
            AND (w.name IS NULL OR w.highway LIKE '%\\_link' OR ${SAME("w", "$2", "$3")} OR s.length_m <= 30))
       SELECT s.id, s.length_m AS m FROM allsegs JOIN street_segments s USING (id)`,
      [[...path], nm, refs]);

    // What crosses the road at each end, to name the stretch by.
    const cross = async (segId: number) => (await query<{ name: string }>(
      `SELECT w.name FROM street_segments me, street_segments s JOIN street_ways w ON w.way_id = s.way_id
        WHERE me.id = $1 AND s.retired_at IS NULL AND s.geom && ST_Expand(me.geom, 0.003) AND w.name IS NOT NULL
          AND NOT ${SAME("w", "$2", "$3")}
        ORDER BY ST_Distance(s.geom, ST_Centroid(me.geom)) LIMIT 1`, [segId, nm, refs])).rows[0]?.name ?? null;
    return {
      name: refs.length ? (A.name ?? refs[0]) : A.name,
      ref: refs[0] ?? null,
      from: await cross(a), to: await cross(b),
      segments: rows.map((r) => [Number(r.id), Math.round(r.m)]),
      meters: Math.round(rows.reduce((t, r) => t + r.m, 0)),
    };
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

  // Several streets at once (shift-click on the map): the same rules as a whole street.
  app.post<{ Params: { id: string }; Body: { segment_ids: number[]; kind: "complete" | "excluded" | "clear"; note?: string | null } }>(
    "/api/teams/:id/marks/bulk",
    { schema: { body: { type: "object", required: ["segment_ids", "kind"], properties: {
        segment_ids: { type: "array", minItems: 1, maxItems: 5000, items: { type: "integer" } },
        kind: { type: "string", enum: ["complete", "excluded", "clear"] }, note: { type: ["string", "null"], maxLength: 500 } } } } },
    async (req) => {
      const me = requireUser(req);
      const team = await loadTeam(req.params.id);
      if (!canDrive(await roleIn(team.id, me.id)) && !me.is_site_admin) throw forbidden("Viewers can't mark streets.");
      const b = req.body;
      const changed = await tx(async (c) => {
        if (b.kind === "clear") {
          const { rows } = await c.query<{ segment_id: string; length_m: number }>(
            `DELETE FROM segment_marks mk USING street_segments s
              WHERE mk.team_id = $2 AND mk.segment_id = ANY($1::bigint[]) AND s.id = mk.segment_id
              RETURNING mk.segment_id, s.length_m`,
            [b.segment_ids, team.id]);
          if (rows.length) {
            await c.query(`INSERT INTO deletions (kind, team_id, key) SELECT 'mark', $1, unnest($2::text[])`,
              [team.id, rows.map((r) => String(r.segment_id))]);
          }
          return rows;
        }
        const { rows } = await c.query<{ segment_id: string; length_m: number }>(
          `INSERT INTO segment_marks (team_id, segment_id, kind, user_id, note)
           SELECT $2, s.id, $3, $4, $5 FROM street_segments s
            WHERE s.id = ANY($1::bigint[])
              AND NOT EXISTS (SELECT 1 FROM segment_marks mk WHERE mk.team_id = $2 AND mk.segment_id = s.id)
              AND ($3 <> 'complete' OR NOT EXISTS (SELECT 1 FROM team_coverage tc WHERE tc.team_id = $2 AND tc.segment_id = s.id))
           ON CONFLICT DO NOTHING
           RETURNING segment_id, (SELECT length_m FROM street_segments WHERE id = segment_id)`,
          [b.segment_ids, team.id, b.kind, me.id, b.note?.trim() || null]);
        return rows;
      });
      await audit(pool, { userId: me.id, teamId: team.id, action: b.kind === "clear" ? "street.unmark" : `street.${b.kind}`,
        entity: "segment", data: { bulk: true, asked: b.segment_ids.length, changed: changed.length } });
      if (changed.length) await sendJob("achievements", { teamId: team.id }, { singletonKey: team.id });
      return { pieces: changed.length, meters: Math.round(changed.reduce((t, r) => t + Number(r.length_m), 0)) };
    },
  );

  // Everything inside an outline drawn on the map (the iPad's outline tool): the pieces
  // whose middle is inside, by the same rules as several streets at once (never what's
  // driven or already marked either way). With `preview`, nothing changes: it says what
  // would be marked and sends those pieces' lines, for the map to highlight first.
  //
  // Scribbled instead (`along_m`): `geometry` is the strokes (LineString/MultiLineString),
  // widened by along_m metres each side, and a piece counts when that covers at least half
  // its length: scribbling along or back and forth over a street picks it, crossing it doesn't.
  app.post<{ Params: { id: string }; Body: { geometry: unknown; kind: "complete" | "excluded"; preview?: boolean; note?: string | null; along_m?: number } }>(
    "/api/teams/:id/marks/within",
    { schema: { body: { type: "object", required: ["geometry", "kind"], properties: {
        geometry: { type: "object" }, kind: { type: "string", enum: ["complete", "excluded"] },
        preview: { type: "boolean" }, note: { type: ["string", "null"], maxLength: 500 },
        along_m: { type: "number", minimum: 1, maximum: 200 } } } } },
    async (req) => {
      const me = requireUser(req);
      const team = await loadTeam(req.params.id);
      if (!canDrive(await roleIn(team.id, me.id)) && !me.is_site_admin) throw forbidden("Viewers can't mark streets.");
      const b = req.body;
      // The ground picked: the outline as drawn, or the scribbles widened.
      const SHAPE = b.along_m
        ? `ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Buffer(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, ${Number(b.along_m)}, 'quad_segs=2')::geometry), 3))`
        : `ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)), 3))`;
      const outline = await query<{ ok: boolean; km2: number }>(
        `WITH g AS (SELECT ${SHAPE} AS g)
         SELECT NOT ST_IsEmpty(g) AS ok, coalesce(ST_Area(g::geography) / 1e6, 0) AS km2 FROM g`,
        [JSON.stringify(b.geometry)],
      ).catch(() => { throw badRequest("That outline isn't a shape we can use. Try drawing it again."); });
      if (!outline.rows[0]?.ok) throw badRequest("That outline isn't a shape we can use. Try drawing it again.");
      if (outline.rows[0].km2 > MARK_WITHIN_MAX_KM2) {
        throw badRequest(`That outline covers ${Math.round(outline.rows[0].km2).toLocaleString()} km². Mark at most ${MARK_WITHIN_MAX_KM2} km² at a time.`);
      }
      // The pieces to mark: middle inside, not driven, not marked either way.
      const covers = b.along_m
        ? `ST_Length(ST_Intersection(s.geom, g.g)::geography) >= 0.5 * s.length_m`
        : `ST_Intersects(g.g, ST_LineInterpolatePoint(s.geom, 0.5))`;
      const pick = `WITH g AS (SELECT ${SHAPE} AS g)
        SELECT s.id, s.length_m, s.geom, s.way_id FROM g, street_segments s
         WHERE s.retired_at IS NULL AND s.geom && g.g AND ${covers}
           AND NOT EXISTS (SELECT 1 FROM segment_marks mk WHERE mk.team_id = $2 AND mk.segment_id = s.id)
           AND ($3 <> 'complete' OR NOT EXISTS (SELECT 1 FROM team_coverage tc WHERE tc.team_id = $2 AND tc.segment_id = s.id))`;
      // Streets, not pieces: one name is one street (an unnamed way counts on its own).
      const streets = `count(DISTINCT coalesce(w.name, p.way_id::text))::int`;

      if (b.preview) {
        const { rows } = await query<{ ids: string[] | null; streets: number; meters: number; lines: string | null }>(
          `WITH p AS (${pick})
           SELECT array_agg(p.id) AS ids, ${streets} AS streets, coalesce(sum(p.length_m), 0) AS meters,
                  ST_AsGeoJSON(ST_Multi(ST_Collect(p.geom)), 6) AS lines
             FROM p JOIN street_ways w ON w.way_id = p.way_id`,
          [JSON.stringify(b.geometry), team.id, b.kind]);
        const r = rows[0];
        const pieces = r.ids?.length ?? 0;
        if (pieces > MARK_WITHIN_MAX_PIECES) {
          throw badRequest(`That's more than ${MARK_WITHIN_MAX_PIECES.toLocaleString()} street pieces at once. Draw a smaller outline.`);
        }
        return { streets: r.streets, pieces, meters: Math.round(Number(r.meters)), lines: r.lines ? JSON.parse(r.lines) : null };
      }

      const changed = await tx(async (c) => {
        const { rows } = await c.query<{ segment_id: string; length_m: number; street: string }>(
          `WITH p AS (${pick}),
                ins AS (INSERT INTO segment_marks (team_id, segment_id, kind, user_id, note)
                        SELECT $2, p.id, $3, $4, $5 FROM p
                        ON CONFLICT DO NOTHING RETURNING segment_id)
           SELECT ins.segment_id, p.length_m, coalesce(w.name, p.way_id::text) AS street
             FROM ins JOIN p ON p.id = ins.segment_id JOIN street_ways w ON w.way_id = p.way_id`,
          [JSON.stringify(b.geometry), team.id, b.kind, me.id, b.note?.trim() || null]);
        if (rows.length > MARK_WITHIN_MAX_PIECES) {
          throw badRequest(`That's more than ${MARK_WITHIN_MAX_PIECES.toLocaleString()} street pieces at once. Draw a smaller outline.`);
        }
        return rows;
      });
      await audit(pool, { userId: me.id, teamId: team.id, action: `street.${b.kind}`, entity: "segment",
        data: { within: true, km2: Math.round(outline.rows[0].km2 * 100) / 100, changed: changed.length } });
      if (changed.length) await sendJob("achievements", { teamId: team.id }, { singletonKey: team.id });
      return {
        streets: new Set(changed.map((r) => r.street)).size,
        pieces: changed.length,
        meters: Math.round(changed.reduce((t, r) => t + Number(r.length_m), 0)),
        // So the app can undo exactly this (marks/bulk with "clear").
        segment_ids: changed.map((r) => Number(r.segment_id)),
      };
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
