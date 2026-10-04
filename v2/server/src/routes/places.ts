// Places: spots someone marked, with a note and photos. Private to whoever marked them
// until they share one with any of their teams; then that team's members see it too.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { pool, query, tx } from "../db.js";
import { config } from "../config.js";
import { requireUser, type SessionUser } from "../auth.js";
import { audit } from "../audit.js";
import { badRequest, forbidden, notFound } from "../http.js";
import { avatarUrl } from "./account.js";

const PHOTO_DIR = () => path.join(config.dataDir, "places");
const PHOTO_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MAX_PHOTOS = 12;

// One shape for lists and details. $1 is the viewer: `mine`, and the teams it's shared
// with that the viewer is in (the owner sees all of them).
const PLACE = `
  SELECT p.id, p.name, p.note, ST_X(p.geom) AS lon, ST_Y(p.geom) AS lat, p.drive_id, p.created_at, p.updated_at,
         p.user_id, u.display_name AS user_name, ${avatarUrl("u")} AS user_avatar_url, (p.user_id = $1) AS mine,
         coalesce((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'kind', t.kind) ORDER BY t.name)
                     FROM place_shares s JOIN teams t ON t.id = s.team_id
                    WHERE s.place_id = p.id AND t.deleted_at IS NULL AND (p.user_id = $1 OR EXISTS (
                      SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = $1 AND m.left_at IS NULL))), '[]') AS shared_with,
         coalesce((SELECT json_agg(json_build_object('id', f.id, 'width', f.width, 'height', f.height) ORDER BY f.created_at)
                     FROM place_photos f WHERE f.place_id = p.id), '[]') AS photos
    FROM places p JOIN users u ON u.id = p.user_id`;

/** Places the viewer may see: their own, and ones shared with a team they're in. */
const VISIBLE = `p.deleted_at IS NULL AND (p.user_id = $1 OR EXISTS (
  SELECT 1 FROM place_shares s JOIN team_members m ON m.team_id = s.team_id
   WHERE s.place_id = p.id AND m.user_id = $1 AND m.left_at IS NULL))`;

async function loadPlace(id: string, me: SessionUser) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("That place doesn't exist.");
  const { rows } = await query(`${PLACE} WHERE p.id = $2 AND ${me.is_site_admin ? "p.deleted_at IS NULL" : VISIBLE}`, [me.id, id]);
  if (!rows[0]) throw notFound("That place doesn't exist.");
  return rows[0];
}

async function loadMine(id: string, me: SessionUser) {
  const p = await loadPlace(id, me);
  // Others see a shared place but can't change it: it stays its owner's.
  if (!p.mine) throw forbidden("Only the person who marked it can change it.");
  return p;
}

function point(lon: unknown, lat: unknown): [number, number] {
  const x = Number(lon), y = Number(lat);
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) throw badRequest("That isn't a spot on the map.");
  return [x, y];
}

/** Teams you can share to: ones you're in now (any role). */
async function checkTeams(ids: string[], me: SessionUser) {
  if (!ids.length) return;
  const { rows } = await query<{ n: number }>(
    `SELECT count(DISTINCT team_id)::int AS n FROM team_members WHERE user_id = $1 AND left_at IS NULL AND team_id = ANY($2::uuid[])`,
    [me.id, ids],
  );
  if (rows[0].n !== new Set(ids).size) throw badRequest("You can only share with teams you're in.");
}

type Body = { name?: string; note?: string | null; lon?: number; lat?: number; drive_id?: string | null; team_ids?: string[] };
const fields = {
  name: { type: "string", minLength: 1, maxLength: 120 },
  note: { type: ["string", "null"], maxLength: 2000 },
  lon: { type: "number" }, lat: { type: "number" },
  drive_id: { type: ["string", "null"], format: "uuid" },
  team_ids: { type: "array", maxItems: 50, items: { type: "string", format: "uuid" } },
};

export default async function placeRoutes(app: FastifyInstance) {
  // Everything you can see, newest first. ?team=<id> narrows to one team's shared places.
  app.get<{ Querystring: { team?: string } }>("/api/places", async (req) => {
    const me = requireUser(req);
    const team = req.query.team && /^[0-9a-f-]{36}$/i.test(req.query.team) ? req.query.team : null;
    const { rows } = await query(
      `${PLACE} WHERE ${VISIBLE} AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM place_shares s WHERE s.place_id = p.id AND s.team_id = $2))
        ORDER BY p.created_at DESC LIMIT 1000`,
      [me.id, team],
    );
    return { places: rows };
  });

  app.post<{ Body: Body }>("/api/places",
    { schema: { body: { type: "object", required: ["name", "lon", "lat"], additionalProperties: false, properties: fields } } },
    async (req, reply) => {
      const me = requireUser(req);
      const b = req.body;
      const [lon, lat] = point(b.lon, b.lat);
      const teams = [...new Set(b.team_ids ?? [])];
      await checkTeams(teams, me);
      if (b.drive_id) {
        const d = await query(`SELECT 1 FROM drives WHERE id = $1 AND deleted_at IS NULL AND (user_id = $2 OR uploaded_by = $2)`, [b.drive_id, me.id]);
        if (!d.rows.length) throw badRequest("That isn't one of your drives.");
      }
      const id = await tx(async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO places (user_id, name, note, geom, drive_id) VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), $6) RETURNING id`,
          [me.id, b.name!.trim(), b.note?.trim() || null, lon, lat, b.drive_id ?? null],
        );
        for (const t of teams) await db.query(`INSERT INTO place_shares (place_id, team_id) VALUES ($1, $2)`, [rows[0].id, t]);
        await audit(db, { userId: me.id, action: "place.created", entity: "place", entityId: rows[0].id });
        return rows[0].id;
      });
      return reply.code(201).send({ place: await loadPlace(id, me) });
    });

  app.get<{ Params: { id: string } }>("/api/places/:id", async (req) => ({ place: await loadPlace(req.params.id, requireUser(req)) }));

  app.patch<{ Params: { id: string }; Body: Body }>("/api/places/:id",
    { schema: { body: { type: "object", additionalProperties: false, properties: fields } } },
    async (req) => {
      const me = requireUser(req);
      const p = await loadMine(req.params.id, me);
      const b = req.body;
      const moved = b.lon !== undefined || b.lat !== undefined;
      const [lon, lat] = moved ? point(b.lon ?? p.lon, b.lat ?? p.lat) : [p.lon, p.lat];
      await tx(async (db) => {
        await db.query(
          `UPDATE places SET name = coalesce($2, name), note = CASE WHEN $3::boolean THEN $4 ELSE note END,
                  geom = ST_SetSRID(ST_MakePoint($5, $6), 4326), updated_at = now() WHERE id = $1`,
          [p.id, b.name?.trim() || null, "note" in b, b.note?.trim() || null, lon, lat],
        );
        // Sharing is replaced wholesale: the list given is the list it's shared with.
        if (b.team_ids) {
          const teams = [...new Set(b.team_ids)];
          await checkTeams(teams, me);
          await db.query(`DELETE FROM place_shares WHERE place_id = $1 AND NOT (team_id = ANY($2::uuid[]))`, [p.id, teams]);
          for (const t of teams) await db.query(`INSERT INTO place_shares (place_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [p.id, t]);
        }
      });
      return { place: await loadPlace(p.id, me) };
    });

  app.delete<{ Params: { id: string } }>("/api/places/:id", async (req) => {
    const me = requireUser(req);
    const p = await loadMine(req.params.id, me);
    const photos = await query<{ path: string }>(`SELECT path FROM place_photos WHERE place_id = $1`, [p.id]);
    await tx(async (db) => {
      await db.query(`UPDATE places SET deleted_at = now() WHERE id = $1`, [p.id]);
      await db.query(`DELETE FROM place_shares WHERE place_id = $1`, [p.id]);
      await db.query(`DELETE FROM place_photos WHERE place_id = $1`, [p.id]);
      await audit(db, { userId: me.id, action: "place.deleted", entity: "place", entityId: p.id });
    });
    for (const f of photos.rows) await fs.rm(path.join(PHOTO_DIR(), f.path), { force: true });
    return { ok: true };
  });

  // ---- photos (raw image body; ?w=&h= say its size, which the browser knows) ------

  app.post<{ Params: { id: string }; Querystring: { w?: string; h?: string } }>("/api/places/:id/photos", { bodyLimit: 6 * 1024 * 1024 }, async (req, reply) => {
    const me = requireUser(req);
    const p = await loadMine(req.params.id, me);
    if (p.photos.length >= MAX_PHOTOS) throw badRequest(`A place can have up to ${MAX_PHOTOS} photos.`);
    const ext = PHOTO_TYPES[String(req.headers["content-type"]).split(";")[0]];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) throw badRequest("Send a PNG, JPEG or WebP picture.");
    await fs.mkdir(PHOTO_DIR(), { recursive: true });
    const name = `${p.id}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
    await fs.writeFile(path.join(PHOTO_DIR(), name), req.body);
    const size = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 20000 ? Number(v) : null);
    await query(`INSERT INTO place_photos (place_id, path, width, height) VALUES ($1, $2, $3, $4)`, [p.id, name, size(req.query.w), size(req.query.h)]);
    await query(`UPDATE places SET updated_at = now() WHERE id = $1`, [p.id]);
    return reply.code(201).send({ place: await loadPlace(p.id, me) });
  });

  app.get<{ Params: { id: string; photoId: string } }>("/api/places/:id/photos/:photoId", async (req, reply) => {
    const p = await loadPlace(req.params.id, requireUser(req));
    if (!p.photos.some((f: { id: string }) => f.id === req.params.photoId)) throw notFound("No such photo.");
    const { rows } = await query<{ path: string }>(`SELECT path FROM place_photos WHERE id = $1`, [req.params.photoId]);
    reply.header("Cache-Control", "private, max-age=86400");
    return reply.sendFile(rows[0].path, PHOTO_DIR());
  });

  app.delete<{ Params: { id: string; photoId: string } }>("/api/places/:id/photos/:photoId", async (req) => {
    const me = requireUser(req);
    const p = await loadMine(req.params.id, me);
    if (!p.photos.some((f: { id: string }) => f.id === req.params.photoId)) throw notFound("No such photo.");
    const { rows } = await query<{ path: string }>(`DELETE FROM place_photos WHERE id = $1 AND place_id = $2 RETURNING path`, [req.params.photoId, p.id]);
    if (!rows[0]) throw notFound("No such photo.");
    await fs.rm(path.join(PHOTO_DIR(), rows[0].path), { force: true });
    return { place: await loadPlace(p.id, me) };
  });
}
