// Areas: public boundaries to follow, and the areas teams draw themselves.
import type { FastifyInstance } from "fastify";
import { pool, query, tx } from "../db.js";
import { requireUser, type SessionUser } from "../auth.js";
import { audit } from "../audit.js";
import { sendJob } from "../jobs.js";
import { badRequest, conflict, forbidden, notFound } from "../http.js";
import { isAdminRole, loadTeam, roleIn } from "../teams.js";

// Drawn outlines larger than this are refused: they'd be a county or more, and those
// exist as boundaries to follow (whose builds are worth sharing between teams).
const MAX_DRAWN_KM2 = 5000;

const color = { type: ["string", "null"], pattern: "^#[0-9a-fA-F]{6}$" } as const;
const name = { type: "string", minLength: 1, maxLength: 120 } as const;
const notes = { type: ["string", "null"], maxLength: 2000 } as const;
const drawnLevel = { type: "string", enum: ["neighborhood", "section", "custom"] } as const;
const geometry = {
  type: "object", required: ["type", "coordinates"],
  properties: { type: { type: "string", enum: ["Polygon", "MultiPolygon"] }, coordinates: { type: "array" } },
} as const;

// One row shape for lists and details. Outline simplified to ~10 m for drawing.
const AREA_FIELDS = `
  a.id, a.name, a.level, a.source, a.team_id, a.parent_id, a.color, a.notes, a.version,
  a.build_status, a.built_version, a.built_at, a.segment_count, a.street_m, a.created_at, a.updated_at,
  (SELECT name FROM areas p WHERE p.id = a.parent_id) AS parent_name,
  round((ST_Area(a.geom::geography) / 1e6)::numeric, 3)::float AS km2,
  ARRAY[ST_XMin(a.geom), ST_YMin(a.geom), ST_XMax(a.geom), ST_YMax(a.geom)] AS bbox`;
const AREA_GEOM = `ST_AsGeoJSON(ST_SimplifyPreserveTopology(a.geom, 0.0001), 6)::json AS geometry`;

/**
 * How much of an area a team has swept: length driven or marked complete, out of the
 * length not marked excluded. Computed live from the area's street list.
 *
 * Streets are counted as people know them: every piece sharing a name is one street
 * (unnamed ones count by their OpenStreetMap way), done once every piece of it is.
 * The segment counts stay for older callers; nobody should be shown them.
 */
const PROGRESS = (area: string, team: string) => `
  SELECT coalesce(sum(m), 0)::float AS total_m, coalesce(sum(dm), 0)::float AS driven_m,
         coalesce(sum(n), 0)::int AS total_segments, coalesce(sum(dn), 0)::int AS driven_segments,
         count(*)::int AS total_streets, count(*) FILTER (WHERE dn = n)::int AS driven_streets,
         count(*) FILTER (WHERE dn > 0 AND dn < n)::int AS started_streets
    FROM (
      SELECT sum(s.inside_m) AS m, sum(s.inside_m) FILTER (WHERE c.segment_id IS NOT NULL OR mk.kind = 'complete') AS dm,
             count(*) AS n, count(*) FILTER (WHERE c.segment_id IS NOT NULL OR mk.kind = 'complete') AS dn
        FROM area_segments s
        LEFT JOIN team_coverage c ON c.team_id = ${team} AND c.segment_id = s.segment_id
        LEFT JOIN segment_marks mk ON mk.team_id = ${team} AND mk.segment_id = s.segment_id
       WHERE s.area_id = ${area}.id AND ${area}.build_status = 'built' AND mk.kind IS DISTINCT FROM 'excluded'
       GROUP BY s.street_key) st`;

async function queueBuild(areaId: string) {
  await query(`UPDATE areas SET build_status = 'queued', build_error = NULL WHERE id = $1 AND build_status <> 'building'`, [areaId]);
  await sendJob("area-build", { areaId }, { singletonKey: areaId });
}

async function requireTeamMember(teamId: string, user: SessionUser) {
  const role = await roleIn(teamId, user.id);
  if (!role && !user.is_site_admin) throw notFound("That team doesn't exist.");
  return user.is_site_admin && !role ? "admin" : role;
}

async function requireTeamAreaAdmin(teamId: string, user: SessionUser) {
  const role = await requireTeamMember(teamId, user);
  if (!isAdminRole(role)) throw forbidden("Only the team's admins can change its areas.");
}

/** Load an area you may see: any public one, or one drawn by a team you're in. */
async function loadVisible(id: string, user: SessionUser) {
  const { rows } = await query(`SELECT a.id, a.team_id, a.source, a.deleted_at FROM areas a WHERE a.id = $1`, [id]);
  const a = rows[0];
  if (!a || a.deleted_at) throw notFound("That area doesn't exist.");
  if (a.team_id) await requireTeamMember(a.team_id, user);
  return a as { id: string; team_id: string | null; source: "drawn" | "osm_boundary" };
}

/** GeoJSON in, valid 4326 multipolygon out (as SQL), refusing empties and giants. */
async function checkOutline(geom: unknown): Promise<string> {
  const json = JSON.stringify(geom);
  const { rows } = await query<{ ok: boolean; km2: number; empty: boolean }>(
    `WITH g AS (SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)), 3)) AS g)
     SELECT NOT ST_IsEmpty(g) AS ok, ST_IsEmpty(g) AS empty, coalesce(ST_Area(g::geography) / 1e6, 0) AS km2 FROM g`,
    [json],
  ).catch(() => {
    throw badRequest("That outline isn't a shape we can use. Try drawing it again.");
  });
  const r = rows[0];
  if (!r.ok || r.empty || r.km2 < 0.0005) throw badRequest("That outline is too small. Draw around at least a block.");
  if (r.km2 > MAX_DRAWN_KM2) {
    throw badRequest(`That outline covers ${Math.round(r.km2).toLocaleString()} km². Drawn areas are limited to ${MAX_DRAWN_KM2.toLocaleString()} km²; follow the county or city instead.`);
  }
  return json;
}

const NEW_GEOM = `ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($GEOM), 4326)), 3))`;

/**
 * A drawing's parent: for a section, the team's own drawn neighborhood it sits in;
 * otherwise (or if there's none) the smallest public boundary containing a point inside it.
 */
const PARENT_FOR = (geomSql: string, teamSql: string, levelSql: string) => `coalesce(
  (SELECT n.id FROM areas n
    WHERE ${levelSql} = 'section' AND n.team_id = ${teamSql} AND n.level = 'neighborhood' AND n.deleted_at IS NULL
      AND ST_Contains(n.geom, ST_PointOnSurface(${geomSql}))
    ORDER BY ST_Area(n.geom) LIMIT 1),
  (SELECT p.id FROM areas p
    WHERE p.source = 'osm_boundary' AND p.deleted_at IS NULL AND ST_Contains(p.geom, ST_PointOnSurface(${geomSql}))
    ORDER BY p.admin_level DESC NULLS LAST LIMIT 1))`;

export default async function areaRoutes(app: FastifyInstance) {
  // Public boundaries by name: "Travis", "Round Rock".
  app.get<{ Querystring: { q?: string } }>("/api/areas/search", async (req) => {
    const me = requireUser(req);
    const q = (req.query.q ?? "").trim();
    if (q.length < 2) return { areas: [] };
    const like = q.replace(/[\\%_]/g, (c) => "\\" + c);
    const { rows } = await query(
      `SELECT ${AREA_FIELDS},
              ARRAY(SELECT t.team_id FROM team_areas t JOIN team_members m ON m.team_id = t.team_id
                     WHERE t.area_id = a.id AND m.user_id = $2 AND m.left_at IS NULL) AS followed_by
         FROM areas a
        WHERE a.source = 'osm_boundary' AND a.deleted_at IS NULL AND a.name ILIKE $1 || '%'
        ORDER BY lower(a.name) = lower($3) DESC, a.admin_level, a.name LIMIT 25`,
      [like, me.id, q],
    );
    return { areas: rows };
  });

  // A team's areas: what it drew and what it follows, with outlines for the map.
  app.get<{ Params: { id: string } }>("/api/teams/:id/areas", async (req) => {
    const me = requireUser(req);
    const team = await loadTeam(req.params.id);
    const role = await requireTeamMember(team.id, me);
    const { rows } = await query(
      `SELECT ${AREA_FIELDS}, ${AREA_GEOM}, (a.team_id IS NULL) AS followed, p.*
         FROM areas a
         LEFT JOIN LATERAL (${PROGRESS("a", "$1")}) p ON true
        WHERE a.deleted_at IS NULL
          AND (a.team_id = $1 OR a.id IN (SELECT area_id FROM team_areas WHERE team_id = $1))
        ORDER BY a.source = 'drawn' DESC, lower(a.name)`,
      [team.id],
    );
    // Which of these areas touch or overlap (within about 100 m), so the map can colour
    // neighbours differently. A whole state's outline is too big to be worth testing.
    const ids = rows.filter((r) => r.level !== "state").map((r) => r.id);
    const pairs = ids.length > 1 ? (await query<{ a: string; b: string }>(
      `SELECT x.id AS a, y.id AS b FROM areas x JOIN areas y ON x.id < y.id
        WHERE x.id = ANY($1::uuid[]) AND y.id = ANY($1::uuid[]) AND ST_DWithin(x.geom, y.geom, 0.001)`,
      [ids],
    )).rows : [];
    const neighbors = new Map<string, string[]>();
    for (const { a, b } of pairs) {
      neighbors.set(a, [...(neighbors.get(a) ?? []), b]);
      neighbors.set(b, [...(neighbors.get(b) ?? []), a]);
    }
    for (const r of rows) r.neighbors = neighbors.get(r.id) ?? [];
    return { team: { id: team.id, name: team.name, kind: team.kind }, can_edit: isAdminRole(role), areas: rows };
  });

  app.get<{ Params: { id: string } }>("/api/areas/:id", async (req) => {
    const me = requireUser(req);
    await loadVisible(req.params.id, me);
    const { rows } = await query(
      `SELECT ${AREA_FIELDS}, ${AREA_GEOM}, a.build_error,
              (SELECT name FROM teams WHERE id = a.team_id) AS team_name,
              ARRAY(SELECT t.team_id FROM team_areas t JOIN team_members m ON m.team_id = t.team_id
                     WHERE t.area_id = a.id AND m.user_id = $2 AND m.left_at IS NULL) AS followed_by
         FROM areas a WHERE a.id = $1`,
      [req.params.id, me.id],
    );
    const a = rows[0];
    const canEdit = a.team_id ? isAdminRole(await requireTeamMember(a.team_id, me)) : false;
    return { area: a, can_edit: canEdit };
  });

  // Draw one: an outline in GeoJSON (lng, lat).
  app.post<{ Params: { id: string }; Body: { name: string; level?: string; color?: string | null; notes?: string | null; geometry: unknown } }>(
    "/api/teams/:id/areas",
    { schema: { body: { type: "object", required: ["name", "geometry"], additionalProperties: false,
        properties: { name, level: drawnLevel, color, notes, geometry } } } },
    async (req, reply) => {
      const me = requireUser(req);
      const team = await loadTeam(req.params.id);
      await requireTeamAreaAdmin(team.id, me);
      const json = await checkOutline(req.body.geometry);
      const geomSql = NEW_GEOM.replace("$GEOM", "$1");
      const { rows } = await query<{ id: string }>(
        `INSERT INTO areas (team_id, source, name, level, color, notes, geom, parent_id, created_by)
         VALUES ($2, 'drawn', $3, $4, $5, $6, ${geomSql}, ${PARENT_FOR(geomSql, "$2::uuid", "$4::text")}, $7) RETURNING id`,
        [json, team.id, req.body.name.trim(), req.body.level ?? "neighborhood", req.body.color ?? null,
         req.body.notes?.trim() || null, me.id],
      );
      await audit(pool, { userId: me.id, teamId: team.id, action: "area.created", entity: "area", entityId: rows[0].id });
      await queueBuild(rows[0].id);
      return reply.code(201).send({ id: rows[0].id });
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; level?: string; color?: string | null; notes?: string | null; geometry?: unknown } }>(
    "/api/areas/:id",
    { schema: { body: { type: "object", additionalProperties: false, properties: { name, level: drawnLevel, color, notes, geometry } } } },
    async (req) => {
      const me = requireUser(req);
      const a = await loadVisible(req.params.id, me);
      if (a.source !== "drawn" || !a.team_id) throw forbidden("Public boundaries come from OpenStreetMap and can't be edited here.");
      await requireTeamAreaAdmin(a.team_id, me);
      const b = req.body;
      const json = b.geometry ? await checkOutline(b.geometry) : null;
      const geomSql = NEW_GEOM.replace("$GEOM", "$6");
      await query(
        `UPDATE areas SET name = coalesce($2, name), level = coalesce($3, level),
                color = CASE WHEN $4::boolean THEN $5 ELSE color END,
                notes = CASE WHEN $7::boolean THEN $8 ELSE notes END,
                geom = CASE WHEN $6::text IS NULL THEN geom ELSE ${geomSql} END,
                -- Re-parented when the outline or the level changes (a neighborhood made a section).
                parent_id = CASE WHEN $6::text IS NULL AND $3::text IS NULL THEN parent_id
                  ELSE ${PARENT_FOR(`CASE WHEN $6::text IS NULL THEN areas.geom ELSE ${geomSql} END`, "areas.team_id", "coalesce($3::text, areas.level)")} END,
                version = version + CASE WHEN $6::text IS NULL THEN 0 ELSE 1 END,
                updated_at = now()
          WHERE id = $1`,
        [a.id, b.name?.trim() || null, b.level ?? null, "color" in b, b.color ?? null, json, "notes" in b, b.notes?.trim() || null],
      );
      await audit(pool, { userId: me.id, teamId: a.team_id, action: "area.updated", entity: "area", entityId: a.id,
        data: { ...b, geometry: json ? "changed" : undefined } });
      if (json) await queueBuild(a.id);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/areas/:id", async (req) => {
    const me = requireUser(req);
    const a = await loadVisible(req.params.id, me);
    if (a.source !== "drawn" || !a.team_id) throw forbidden("Public boundaries can't be deleted. Unfollow it instead.");
    await requireTeamAreaAdmin(a.team_id, me);
    await query(`UPDATE areas SET deleted_at = now() WHERE id = $1`, [a.id]);
    await audit(pool, { userId: me.id, teamId: a.team_id, action: "area.deleted", entity: "area", entityId: a.id });
    return { ok: true };
  });

  // Follow a public boundary: it joins the team's areas and gets its street list built.
  app.post<{ Params: { id: string }; Body: { area_id: string } }>(
    "/api/teams/:id/follows",
    { schema: { body: { type: "object", required: ["area_id"], properties: { area_id: { type: "string", format: "uuid" } } } } },
    async (req, reply) => {
      const me = requireUser(req);
      const team = await loadTeam(req.params.id);
      await requireTeamAreaAdmin(team.id, me);
      const build = await tx(async (db) => {
        const { rows } = await db.query<{ source: string; build_status: string; version: number; built_version: number | null }>(
          `SELECT source, build_status, version, built_version FROM areas WHERE id = $1 AND deleted_at IS NULL`, [req.body.area_id],
        );
        const a = rows[0];
        if (!a || a.source !== "osm_boundary") throw notFound("No such public area.");
        const ins = await db.query(
          `INSERT INTO team_areas (team_id, area_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [team.id, req.body.area_id, me.id],
        );
        if (!ins.rowCount) throw conflict("The team already follows it.");
        await audit(db, { userId: me.id, teamId: team.id, action: "area.followed", entity: "area", entityId: req.body.area_id });
        // Built already for another team (and still current)? Shared, nothing to do.
        return !(a.build_status === "built" && a.built_version === a.version) && a.build_status !== "queued" && a.build_status !== "building";
      });
      if (build) await queueBuild(req.body.area_id);
      return reply.code(201).send({ ok: true });
    },
  );

  app.delete<{ Params: { id: string; areaId: string } }>("/api/teams/:id/follows/:areaId", async (req) => {
    const me = requireUser(req);
    const team = await loadTeam(req.params.id);
    await requireTeamAreaAdmin(team.id, me);
    const { rowCount } = await query(`DELETE FROM team_areas WHERE team_id = $1 AND area_id = $2`, [team.id, req.params.areaId]);
    if (!rowCount) throw notFound("The team doesn't follow that area.");
    await audit(pool, { userId: me.id, teamId: team.id, action: "area.unfollowed", entity: "area", entityId: req.params.areaId });
    return { ok: true };
  });

  // Public boundary lines for the map: the state always, counties from zoom 6, cities from 9.
  app.get<{ Params: { z: string; x: string; y: string } }>("/api/tiles/areas/:z/:x/:y", async (req, reply) => {
    requireUser(req);
    const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw badRequest("No such tile.");
    const maxLevel = z >= 9 ? 8 : z >= 6 ? 6 : 4;
    const { rows } = await query<{ mvt: Buffer }>(
      `WITH b AS (SELECT ST_TileEnvelope($1, $2, $3) AS env)
       -- Area ids are uuids, and MVT feature ids must be integers: the id rides as a property.
       SELECT ST_AsMVT(t, 'areas', 4096, 'geom') AS mvt FROM (
         SELECT a.id, a.name, a.level,
                ST_AsMVTGeom(ST_Boundary(ST_Transform(ST_SimplifyPreserveTopology(a.geom, $5), 3857)), b.env, 4096, 64, true) AS geom
           FROM b, areas a
          WHERE a.source = 'osm_boundary' AND a.deleted_at IS NULL AND a.admin_level <= $4
            AND a.geom && ST_Transform(b.env, 4326)
       ) t WHERE geom IS NOT NULL`,
      [z, x, y, maxLevel, 0.5 / 2 ** z],
    );
    reply.header("Content-Type", "application/vnd.mapbox-vector-tile");
    reply.header("Cache-Control", "private, max-age=3600");
    return reply.send(rows[0]?.mvt ?? Buffer.alloc(0));
  });
}
