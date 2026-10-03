// GPS loggers: registering, installing in a vehicle, keys, and the logger's own
// signed endpoint. Protocol: docs/LOGGER-PROTOCOL.md.
import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { pool, query, tx } from "../db.js";
import { requireUser, type SessionUser } from "../auth.js";
import { audit } from "../audit.js";
import { HttpError, badRequest, forbidden, notFound } from "../http.js";
import { isAdminRole } from "../teams.js";
import { canDrive, endRange, loadVehicle, requireActive, vehicleRole } from "../fleet.js";

const name = { type: "string", minLength: 1, maxLength: 60 } as const;
const driveType = { type: "string", maxLength: 32 } as const;

interface LoggerRow {
  id: string;
  owner_user_id: string;
  name: string;
  secret: Buffer;
  revoked_at: Date | null;
}

async function loadLogger(db: pg.Pool | pg.PoolClient, id: string, lock = false): Promise<LoggerRow> {
  const { rows } = await db.query<LoggerRow>(
    `SELECT id, owner_user_id, name, secret, revoked_at FROM loggers WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id],
  );
  if (!rows[0]) throw notFound("That logger doesn't exist.");
  return rows[0];
}

/** The builder manages their logger; site admins can step in. */
function requireOwner(l: LoggerRow, user: SessionUser) {
  if (l.owner_user_id !== user.id && !user.is_site_admin) throw notFound("That logger doesn't exist.");
}

function requireLive(l: LoggerRow) {
  if (l.revoked_at) throw badRequest("This logger has been retired.");
}

async function checkDriveType(db: pg.Pool | pg.PoolClient, key: string) {
  const { rows } = await db.query(`SELECT 1 FROM drive_types WHERE key = $1 AND archived_at IS NULL`, [key]);
  if (!rows.length) throw badRequest("Pick one of the drive types in use.");
}

const newSecret = () => crypto.randomBytes(32);

/** Everything a person needs to flash onto the board. Shown once, at creation or rotation. */
function setup(req: FastifyRequest, l: { id: string }, secret: Buffer) {
  const server = `${req.protocol}://${req.headers.host}`;
  return { logger_id: l.id, secret: secret.toString("hex"), server, config_url: `${server}/api/logger/config` };
}

async function detail(id: string) {
  const { rows } = await query(
    `SELECT l.id, l.name, l.owner_user_id, o.display_name AS owner_name, l.default_drive_type_key,
            d.label AS default_drive_type_label, l.hardware_id, l.firmware_version, l.last_battery_mv,
            l.last_seen_at, l.created_at, l.revoked_at,
            (SELECT jsonb_build_object('install_id', i.id, 'vehicle_id', v.id, 'vehicle_name', v.name,
                                       'team_name', t.name, 'since', lower(i.during))
               FROM logger_installs i JOIN vehicles v ON v.id = i.vehicle_id JOIN teams t ON t.id = v.managed_by_team_id
              WHERE i.logger_id = l.id AND upper_inf(i.during)) AS installed
       FROM loggers l JOIN users o ON o.id = l.owner_user_id JOIN drive_types d ON d.key = l.default_drive_type_key
      WHERE l.id = $1`,
    [id],
  );
  const history = await query(
    `SELECT i.id, v.id AS vehicle_id, v.name AS vehicle_name, lower(i.during) AS started_at, upper(i.during) AS ended_at
       FROM logger_installs i JOIN vehicles v ON v.id = i.vehicle_id
      WHERE i.logger_id = $1 ORDER BY lower(i.during) DESC LIMIT 50`,
    [id],
  );
  return { logger: rows[0], history: history.rows };
}

async function endInstall(db: pg.PoolClient, loggerId: string) {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM logger_installs WHERE logger_id = $1 AND upper_inf(during)`, [loggerId],
  );
  for (const r of rows) await endRange(db, "logger_installs", r.id);
}

// ---- signed requests from the logger itself -------------------------------------

/**
 * X-Logger-Id: <uuid>
 * X-Logger-Signature: hex(HMAC-SHA256(secret, METHOD "\n" PATH "\n" hex(SHA-256(body))))
 * PATH is the request path with its query string, exactly as sent.
 */
export async function verifyLogger(req: FastifyRequest, body: Buffer = Buffer.alloc(0)): Promise<LoggerRow> {
  const id = String(req.headers["x-logger-id"] ?? "");
  const sig = String(req.headers["x-logger-signature"] ?? "").toLowerCase();
  const refuse = () => new HttpError(401, "Logger signature not accepted.");
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f]{64}$/.test(sig)) throw refuse();
  const { rows } = await query<LoggerRow>(`SELECT id, owner_user_id, name, secret, revoked_at FROM loggers WHERE id = $1`, [id]);
  const l = rows[0];
  if (!l) throw refuse();
  const canonical = `${req.method}\n${req.url}\n${crypto.createHash("sha256").update(body).digest("hex")}`;
  const want = crypto.createHmac("sha256", l.secret).update(canonical).digest();
  if (!crypto.timingSafeEqual(want, Buffer.from(sig, "hex"))) throw refuse();
  if (l.revoked_at) throw new HttpError(401, "This logger has been retired.");
  return l;
}

/** Unsigned status headers: informational only, so a forged one can't do harm. */
async function noteStatus(req: FastifyRequest, loggerId: string) {
  const h = (k: string) => {
    const v = req.headers[k];
    return typeof v === "string" && v.trim() ? v.trim().slice(0, 64) : null;
  };
  const mv = Number(h("x-logger-battery"));
  await query(
    `UPDATE loggers SET last_seen_at = now(), firmware_version = coalesce($2, firmware_version),
            hardware_id = coalesce($3, hardware_id), last_battery_mv = coalesce($4, last_battery_mv)
      WHERE id = $1`,
    [loggerId, h("x-logger-firmware")?.slice(0, 40) ?? null, h("x-logger-hardware"),
     Number.isFinite(mv) && mv > 0 && mv < 100_000 ? Math.round(mv) : null],
  );
}

export default async function loggerRoutes(app: FastifyInstance) {
  app.get("/api/loggers", async (req) => {
    const me = requireUser(req);
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM loggers WHERE owner_user_id = $1 ORDER BY revoked_at IS NOT NULL, lower(name)`, [me.id],
    );
    return { loggers: await Promise.all(rows.map(async (r) => (await detail(r.id)).logger)) };
  });

  app.post<{ Body: { name: string; default_drive_type_key?: string } }>(
    "/api/loggers",
    { schema: { body: { type: "object", required: ["name"], additionalProperties: false,
        properties: { name, default_drive_type_key: driveType } } } },
    async (req, reply) => {
      const me = requireUser(req);
      const type = req.body.default_drive_type_key ?? "personal";
      await checkDriveType(pool, type);
      const secret = newSecret();
      const { rows } = await query<{ id: string }>(
        `INSERT INTO loggers (owner_user_id, name, secret, default_drive_type_key) VALUES ($1, $2, $3, $4) RETURNING id`,
        [me.id, req.body.name.trim(), secret, type],
      );
      await audit(pool, { userId: me.id, action: "logger.created", entity: "logger", entityId: rows[0].id });
      return reply.code(201).send({ ...(await detail(rows[0].id)), setup: setup(req, rows[0], secret) });
    },
  );

  app.get<{ Params: { id: string } }>("/api/loggers/:id", async (req) => {
    const me = requireUser(req);
    requireOwner(await loadLogger(pool, req.params.id), me);
    return detail(req.params.id);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; default_drive_type_key?: string } }>(
    "/api/loggers/:id",
    { schema: { body: { type: "object", additionalProperties: false, properties: { name, default_drive_type_key: driveType } } } },
    async (req) => {
      const me = requireUser(req);
      const l = await loadLogger(pool, req.params.id);
      requireOwner(l, me);
      if (req.body.default_drive_type_key) await checkDriveType(pool, req.body.default_drive_type_key);
      await query(
        `UPDATE loggers SET name = coalesce($2, name), default_drive_type_key = coalesce($3, default_drive_type_key) WHERE id = $1`,
        [l.id, req.body.name?.trim() || null, req.body.default_drive_type_key ?? null],
      );
      return detail(l.id);
    },
  );

  // Put it in a vehicle (moving it out of any other). The builder needs to be able to
  // drive that vehicle: a driver, admin or owner in its team.
  app.post<{ Params: { id: string }; Body: { vehicle_id: string } }>(
    "/api/loggers/:id/install",
    { schema: { body: { type: "object", required: ["vehicle_id"], properties: { vehicle_id: { type: "string", format: "uuid" } } } } },
    async (req) => {
      const me = requireUser(req);
      await tx(async (db) => {
        const l = await loadLogger(db, req.params.id, true);
        requireOwner(l, me);
        requireLive(l);
        const v = await loadVehicle(db, req.body.vehicle_id);
        requireActive(v);
        if (!canDrive(await vehicleRole(db, v, me))) throw forbidden("You can only install loggers in vehicles your teams let you drive.");
        const cur = await db.query<{ vehicle_id: string }>(
          `SELECT vehicle_id FROM logger_installs WHERE logger_id = $1 AND upper_inf(during)`, [l.id],
        );
        if (cur.rows[0]?.vehicle_id === v.id) return;
        await endInstall(db, l.id);
        await db.query(`INSERT INTO logger_installs (logger_id, vehicle_id, installed_by) VALUES ($1, $2, $3)`, [l.id, v.id, me.id]);
        await audit(db, { userId: me.id, teamId: v.managed_by_team_id, action: "logger.installed", entity: "logger",
          entityId: l.id, data: { vehicle_id: v.id } });
      });
      return detail(req.params.id);
    },
  );

  // Taking it out: its builder, or an admin of the vehicle it's in.
  app.post<{ Params: { id: string } }>("/api/loggers/:id/uninstall", async (req) => {
    const me = requireUser(req);
    await tx(async (db) => {
      const l = await loadLogger(db, req.params.id, true);
      const cur = await db.query<{ vehicle_id: string }>(
        `SELECT vehicle_id FROM logger_installs WHERE logger_id = $1 AND upper_inf(during)`, [l.id],
      );
      if (!cur.rows[0]) return;
      if (l.owner_user_id !== me.id && !me.is_site_admin) {
        const v = await loadVehicle(db, cur.rows[0].vehicle_id);
        if (!isAdminRole(await vehicleRole(db, v, me))) throw notFound("That logger doesn't exist.");
      }
      await endInstall(db, l.id);
      await audit(db, { userId: me.id, action: "logger.uninstalled", entity: "logger", entityId: l.id,
        data: { vehicle_id: cur.rows[0].vehicle_id } });
    });
    return afterUninstall(req.params.id, me);
  });

  // New key: the old one stops working at once; reflash the board.
  app.post<{ Params: { id: string } }>("/api/loggers/:id/rotate-key", async (req) => {
    const me = requireUser(req);
    const l = await loadLogger(pool, req.params.id);
    requireOwner(l, me);
    requireLive(l);
    const secret = newSecret();
    await query(`UPDATE loggers SET secret = $2 WHERE id = $1`, [l.id, secret]);
    await audit(pool, { userId: me.id, action: "logger.key_rotated", entity: "logger", entityId: l.id });
    return { ...(await detail(l.id)), setup: setup(req, l, secret) };
  });

  // Retire: kept for history (its past drives still point at it), but it can't sign in again.
  app.delete<{ Params: { id: string } }>("/api/loggers/:id", async (req) => {
    const me = requireUser(req);
    await tx(async (db) => {
      const l = await loadLogger(db, req.params.id, true);
      requireOwner(l, me);
      if (l.revoked_at) return;
      await endInstall(db, l.id);
      await db.query(`UPDATE loggers SET revoked_at = now() WHERE id = $1`, [l.id]);
      await audit(db, { userId: me.id, action: "logger.retired", entity: "logger", entityId: l.id });
    });
    return detail(req.params.id);
  });

  // ---- the logger's side ---------------------------------------------------------

  // A logger calls this on boot and then now and again: it proves the key works,
  // gives it the time, and tells it which vehicle it's in.
  app.get("/api/logger/config", async (req) => {
    const l = await verifyLogger(req);
    await noteStatus(req, l.id);
    const d = (await detail(l.id)).logger;
    return {
      logger_id: l.id,
      name: d.name,
      server_time: new Date().toISOString(),
      server_epoch: Math.floor(Date.now() / 1000),
      default_drive_type: d.default_drive_type_key,
      vehicle: d.installed ? { id: d.installed.vehicle_id, name: d.installed.vehicle_name } : null,
      check_in_seconds: 3600,
      // Drive uploads arrive in stage 4; until then the logger keeps its points.
      upload: null,
    };
  });
}

// Uninstall can be done by a vehicle admin who isn't the owner: they get a short answer,
// not the logger's details.
async function afterUninstall(id: string, me: SessionUser) {
  const { rows } = await query<{ owner_user_id: string }>(`SELECT owner_user_id FROM loggers WHERE id = $1`, [id]);
  return rows[0]?.owner_user_id === me.id || me.is_site_admin ? detail(id) : { ok: true };
}
