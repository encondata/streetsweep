// Phones signed in to the app, as seen (and revoked) from the web.
import type { FastifyInstance } from "fastify";
import { pool, query } from "../db.js";
import { requireUser } from "../auth.js";
import { audit } from "../audit.js";
import { notFound } from "../http.js";

export default async function deviceRoutes(app: FastifyInstance) {
  app.get("/api/devices", async (req) => {
    const me = requireUser(req);
    const { rows } = await query(
      `SELECT id, name, platform, app_version, created_at, last_seen_at, revoked_at, id = $2 AS this_device
         FROM devices WHERE user_id = $1 ORDER BY revoked_at IS NOT NULL, last_seen_at DESC NULLS LAST`,
      [me.id, me.device_id],
    );
    return { devices: rows };
  });

  // Signs that phone out for good; it has to sign in again to get a new token.
  app.delete<{ Params: { id: string } }>("/api/devices/:id", async (req) => {
    const me = requireUser(req);
    const { rowCount } = await query(
      `UPDATE devices SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND user_id = $2`, [req.params.id, me.id],
    );
    if (!rowCount) throw notFound("That phone isn't signed in to your account.");
    await audit(pool, { userId: me.id, action: "device.revoked", entity: "device", entityId: req.params.id });
    return { ok: true };
  });
}
