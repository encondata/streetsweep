// What a phone pulls: everything it needs to work offline, changed since its last sync.
//
//   GET /api/sync?since=<cursor>   (no cursor = everything)
//
// Small things come whole every time (you, your teams, drive types, vehicles, areas'
// metadata, which places you can see), so a phone just replaces its copy. Area outlines
// come only on a full sync; later, a changed `version` tells the phone to fetch one.
// Bigger things come as changes since the cursor: area outlines that changed, marks
// (with tombstones), places that changed, your drives' status, and each team's coverage
// ([segment id, first driven]; a team recounted since the cursor comes whole, flagged `reset`).
//
// The cursor is the server's clock at the start of the read, minus a little, so nothing
// written during the read is missed (a phone may get a few rows twice; that's harmless).
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { pool } from "../db.js";
import { requireUser } from "../auth.js";
import { badRequest } from "../http.js";
import { avatarUrl } from "./account.js";

const SKEW = "interval '5 seconds'";

export default async function syncRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { since?: string } }>("/api/sync", async (req) => {
    const me = requireUser(req);
    let since: Date | null = null;
    if (req.query.since) {
      since = new Date(req.query.since);
      if (Number.isNaN(since.getTime())) throw badRequest("That isn't a sync cursor.");
    }
    const sinceIso = since?.toISOString() ?? null;
    const client = await pool.connect();
    try {
      // One snapshot for the whole read, so the parts agree with each other.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const q = <T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) => client.query<T>(text, params).then((r) => r.rows);
      const [{ cursor }] = await q<{ cursor: Date }>(`SELECT now() - ${SKEW} AS cursor`);

      const teams = await q(
        `SELECT t.id, t.name, t.kind, m.role, t.coverage_reset_at, m.joined_at
           FROM team_members m JOIN teams t ON t.id = m.team_id
          WHERE m.user_id = $1 AND m.left_at IS NULL AND t.deleted_at IS NULL
          ORDER BY t.kind = 'personal' DESC, t.name`, [me.id]);
      const teamIds = teams.map((t) => t.id);

      const driveTypes = await q(
        `SELECT dt.key, dt.label, dt.icon, dt.sort,
                coalesce((SELECT json_object_agg(tdt.team_id, tdt.counts) FROM team_drive_types tdt
                           WHERE tdt.drive_type_key = dt.key AND tdt.team_id = ANY($1::uuid[])), '{}') AS team_counts
           FROM drive_types dt WHERE dt.archived_at IS NULL ORDER BY dt.sort, dt.label`, [teamIds]);

      // Vehicles you may drive, and what you hold right now.
      const vehicles = await q(
        `SELECT v.id, v.name, v.kind, v.make, v.model, v.year, v.color, v.plate, v.checkout_policy,
                v.managed_by_team_id AS team_id, t.name AS team_name, t.kind AS team_kind, m.role,
                EXISTS (SELECT 1 FROM vehicle_assignments a WHERE a.vehicle_id = v.id AND a.user_id = $1
                         AND a.kind = 'permanent' AND upper_inf(a.during)) AS permanent,
                (SELECT json_build_object('user_id', a.user_id, 'since', lower(a.during))
                   FROM vehicle_assignments a WHERE a.vehicle_id = v.id AND a.kind = 'checkout' AND upper_inf(a.during)) AS checkout
           FROM vehicles v JOIN teams t ON t.id = v.managed_by_team_id
           JOIN team_members m ON m.team_id = v.managed_by_team_id AND m.user_id = $1 AND m.left_at IS NULL
          WHERE v.archived_at IS NULL AND m.role <> 'viewer'
          ORDER BY t.kind = 'personal' DESC, v.name`, [me.id]);

      // Areas your teams track: metadata always; outlines only on a full sync. After that
      // the phone compares `version` (the outline's) and fetches GET /api/areas/:id itself.
      const areas = await q(
        `SELECT a.id, a.name, a.level, a.source, a.color, a.team_id AS drawn_by, a.parent_id, a.version,
                a.build_status, a.built_version, a.segment_count, a.street_m,
                ARRAY[ST_XMin(a.geom), ST_YMin(a.geom), ST_XMax(a.geom), ST_YMax(a.geom)] AS bbox,
                (SELECT array_agg(x.team_id) FROM (
                   SELECT a.team_id AS team_id WHERE a.team_id = ANY($1::uuid[])
                   UNION SELECT ta.team_id FROM team_areas ta WHERE ta.area_id = a.id AND ta.team_id = ANY($1::uuid[])) x) AS team_ids,
                CASE WHEN $2::timestamptz IS NULL THEN ST_AsGeoJSON(a.geom, 6)::json END AS geometry
           FROM areas a
          WHERE a.deleted_at IS NULL AND (a.team_id = ANY($1::uuid[])
             OR a.id IN (SELECT area_id FROM team_areas WHERE team_id = ANY($1::uuid[])))
          ORDER BY a.name`, [teamIds, sinceIso]);

      const marks = await q(
        `SELECT mk.team_id, mk.segment_id, mk.kind, mk.note, mk.created_at, u.display_name AS marked_by
           FROM segment_marks mk LEFT JOIN users u ON u.id = mk.user_id
          WHERE mk.team_id = ANY($1::uuid[]) AND ($2::timestamptz IS NULL OR mk.created_at > $2)`, [teamIds, sinceIso]);
      const unmarked = sinceIso
        ? await q(`SELECT team_id, key::bigint AS segment_id FROM deletions
                    WHERE kind = 'mark' AND team_id = ANY($1::uuid[]) AND deleted_at > $2`, [teamIds, sinceIso])
        : [];

      // Places: which ones you can see (ids, so the phone drops the rest), and the
      // changed ones in full.
      const visible = `p.deleted_at IS NULL AND (p.user_id = $1 OR EXISTS (
        SELECT 1 FROM place_shares s JOIN team_members m ON m.team_id = s.team_id
         WHERE s.place_id = p.id AND m.user_id = $1 AND m.left_at IS NULL))`;
      const placeIds = (await q<{ id: string }>(`SELECT p.id FROM places p WHERE ${visible}`, [me.id])).map((r) => r.id);
      const places = await q(
        `SELECT p.id, p.name, p.note, ST_X(p.geom) AS lon, ST_Y(p.geom) AS lat, p.drive_id, p.created_at, p.updated_at,
                p.user_id, u.display_name AS user_name, ${avatarUrl("u")} AS user_avatar_url, (p.user_id = $1) AS mine,
                coalesce((SELECT array_agg(s.team_id) FROM place_shares s WHERE s.place_id = p.id), '{}') AS team_ids,
                coalesce((SELECT json_agg(json_build_object('id', f.id, 'width', f.width, 'height', f.height) ORDER BY f.created_at)
                            FROM place_photos f WHERE f.place_id = p.id), '[]') AS photos
           FROM places p JOIN users u ON u.id = p.user_id
          WHERE ${visible} AND ($2::timestamptz IS NULL OR p.updated_at > $2)`, [me.id, sinceIso]);

      // Your drives (driven or uploaded by you) whose status changed: the phone swaps its
      // provisional preview for the server's match once a drive is matched.
      // With its streets counted the way people count them (one name, one street): all it
      // drove, and the ones it was first to sweep for the driver's own (personal) coverage.
      const drives = await q(
        `SELECT d.id, d.status, d.match_error, d.segment_count, d.drive_type_key, d.vehicle_id, d.user_id,
                d.started_at, d.ended_at, d.distance_m, (d.deleted_at IS NOT NULL) AS deleted,
                st.streets AS street_count, st.new_streets, st.new_m
           FROM drives d
           LEFT JOIN LATERAL (
             SELECT count(DISTINCT coalesce(lower(w.name), 'way ' || s.way_id))::int AS streets,
                    count(DISTINCT coalesce(lower(w.name), 'way ' || s.way_id)) FILTER (WHERE c.first_drive_id = d.id)::int AS new_streets,
                    coalesce(sum(s.length_m) FILTER (WHERE c.first_drive_id = d.id), 0)::float AS new_m
               FROM segment_passes p
               JOIN street_segments s ON s.id = p.segment_id
               LEFT JOIN street_ways w ON w.way_id = s.way_id
               LEFT JOIN team_coverage c ON c.segment_id = p.segment_id AND c.team_id = (
                 SELECT t.id FROM teams t JOIN team_members m ON m.team_id = t.id
                  WHERE t.kind = 'personal' AND m.user_id = d.user_id LIMIT 1)
              WHERE p.drive_id = d.id AND d.status = 'matched') st ON true
          WHERE (d.uploaded_by = $1 OR d.user_id = $1) AND ($2::timestamptz IS NULL OR d.updated_at > $2)
            AND (d.deleted_at IS NULL OR $2::timestamptz IS NOT NULL)
          ORDER BY d.started_at DESC LIMIT 5000`, [me.id, sinceIso]);

      // Coverage per team: segment ids. Whole when first syncing or after a recount.
      // Each as [segment id, first driven (unix seconds)], for the phone's recency colours.
      const coverage: Record<string, { reset: boolean; segments: [number, number][] }> = {};
      for (const t of teams) {
        // Whole on a first sync, after a recount, or for a team joined since the cursor.
        const reset = !sinceIso || (t.coverage_reset_at && new Date(t.coverage_reset_at) > since!) || new Date(t.joined_at) > since!;
        const rows = await q<{ segment_id: string; t: number }>(
          `SELECT segment_id, extract(epoch FROM first_driven_at)::bigint AS t FROM team_coverage
            WHERE team_id = $1 ${reset ? "" : "AND updated_at > $2"}`,
          reset ? [t.id] : [t.id, sinceIso]);
        coverage[t.id] = { reset: !!reset, segments: rows.map((r) => [Number(r.segment_id), Number(r.t)]) };
      }

      // The map colours chosen in Preferences, so the phone and car screen draw streets and
      // finished areas the same way the web does. Sent every time: changing them moves no cursor.
      const [{ preferences: p = {} } = {}] = await q<{ preferences: Record<string, unknown> }>(
        `SELECT preferences FROM users WHERE id = $1`, [me.id]);
      const prefs = { map_colors: p.map_colors ?? null, shade_complete: p.shade_complete !== false, complete_fill: p.complete_fill ?? null };

      await client.query("COMMIT");
      return {
        cursor, full: !sinceIso,
        user: { id: me.id, display_name: me.display_name, email: me.email, preferences: prefs },
        teams: teams.map(({ coverage_reset_at, joined_at, ...t }) => t),
        drive_types: driveTypes, vehicles, areas,
        marks, unmarked,
        place_ids: placeIds, places,
        drives, coverage,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}
