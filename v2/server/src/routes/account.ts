// Sign-up, sign-in, sign-out, and the signed-in person's own account.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { pool, query, tx } from "../db.js";
import {
  MIN_PASSWORD, burnPasswordCheck, clearFailures, endSession, hashPassword, newDeviceToken, noteFailure,
  requireUser, startSession, tooManyFailures, verifyPassword,
} from "../auth.js";
import { audit } from "../audit.js";
import { createUser } from "../users.js";
import { HttpError, badRequest, conflict, notFound } from "../http.js";

const email = { type: "string", format: "email", maxLength: 254 } as const;
const displayName = { type: "string", minLength: 1, maxLength: 80 } as const;
const password = { type: "string", minLength: 1, maxLength: 200 } as const;

export const AVATAR_DIR = () => path.join(config.dataDir, "avatars");
const AVATAR_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** SQL for a user's picture URL; the file name changes with each upload, so it busts caches. */
export const avatarUrl = (u: string) =>
  `CASE WHEN ${u}.avatar_path IS NOT NULL THEN '/api/users/' || ${u}.id || '/avatar?v=' || ${u}.avatar_path END`;

export async function meSummary(userId: string) {
  const user = await query(
    `SELECT id, email, display_name, ${avatarUrl("users")} AS avatar_url, is_site_admin, created_at
       FROM users WHERE id = $1`,
    [userId],
  );
  const teams = await query(
    `SELECT t.id, t.name, t.kind, m.role,
            CASE WHEN m.role IN ('owner','admin')
                 THEN (SELECT count(*)::int FROM team_join_requests r WHERE r.team_id = t.id AND r.status = 'pending')
                 ELSE 0 END AS pending_requests
       FROM team_members m JOIN teams t ON t.id = m.team_id
      WHERE m.user_id = $1 AND m.left_at IS NULL AND t.deleted_at IS NULL
      ORDER BY t.kind = 'personal' DESC, lower(t.name)`,
    [userId],
  );
  return { user: user.rows[0], teams: teams.rows };
}

export default async function accountRoutes(app: FastifyInstance) {
  app.post<{ Body: { email: string; displayName: string; password: string; remember?: boolean } }>(
    "/api/auth/signup",
    { schema: { body: { type: "object", required: ["email", "displayName", "password"], additionalProperties: false,
        properties: { email, displayName, password, remember: { type: "boolean" } } } } },
    async (req, reply) => {
      const { email: addr, displayName: name, password: pw, remember = true } = req.body;
      if (pw.length < MIN_PASSWORD) throw badRequest(`Use at least ${MIN_PASSWORD} characters for the password.`);
      const exists = await query(`SELECT 1 FROM users WHERE email = $1`, [addr.trim()]);
      if (exists.rows.length) throw conflict("There's already an account for that email. Sign in instead.");
      const userId = await tx((db) => createUser(db, { email: addr.trim(), displayName: name.trim(), password: pw }));
      await startSession(req, reply, userId, remember);
      return reply.code(201).send(await meSummary(userId));
    },
  );

  // Shared by browser sign-in and phone sign-in: throttled, timing-safe, one message for both misses.
  async function checkCredentials(ip: string, emailIn: string, pw: string) {
    const addr = emailIn.trim().toLowerCase();
    const keys = [`ip:${ip}`, `email:${addr}`];
    if (tooManyFailures(...keys)) throw new HttpError(429, "Too many tries. Wait fifteen minutes and try again.");
    const { rows } = await query<{ id: string; password_hash: string; disabled_at: Date | null }>(
      `SELECT id, password_hash, disabled_at FROM users WHERE email = $1`, [addr],
    );
    const user = rows[0];
    const ok = user ? await verifyPassword(pw, user.password_hash) : (await burnPasswordCheck(pw), false);
    if (!ok || !user) {
      noteFailure(...keys);
      throw new HttpError(401, "That email and password don't match.");
    }
    if (user.disabled_at) throw new HttpError(403, "This account has been switched off. Ask a site admin.");
    clearFailures(...keys);
    return user.id;
  }

  // The phone app signs in here and keeps the token until it's revoked on the web.
  app.post<{ Body: { email: string; password: string; deviceName: string; platform?: string; appVersion?: string } }>(
    "/api/auth/device",
    { schema: { body: { type: "object", required: ["email", "password", "deviceName"], properties: {
        email: { type: "string", maxLength: 254 }, password,
        deviceName: { type: "string", minLength: 1, maxLength: 60 },
        platform: { type: "string", enum: ["android", "ios", "other"] },
        appVersion: { type: "string", maxLength: 40 } } } } },
    async (req, reply) => {
      const userId = await checkCredentials(req.ip, req.body.email, req.body.password);
      const { token, hash } = newDeviceToken();
      const { rows } = await query<{ id: string }>(
        `INSERT INTO devices (user_id, name, platform, app_version, token_hash, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
        [userId, req.body.deviceName.trim(), req.body.platform ?? "android", req.body.appVersion ?? null, hash],
      );
      await audit(pool, { userId, action: "device.signed_in", entity: "device", entityId: rows[0].id });
      return reply.code(201).send({ token, device_id: rows[0].id, ...(await meSummary(userId)) });
    },
  );

  app.post<{ Body: { email: string; password: string; remember?: boolean } }>(
    "/api/auth/login",
    { schema: { body: { type: "object", required: ["email", "password"],
        properties: { email: { type: "string", maxLength: 254 }, password, remember: { type: "boolean" } } } } },
    async (req, reply) => {
      const userId = await checkCredentials(req.ip, req.body.email, req.body.password);
      await startSession(req, reply, userId, req.body.remember ?? true);
      return meSummary(userId);
    },
  );

  app.post("/api/auth/logout", async (req, reply) => {
    await endSession(req, reply);
    return { ok: true };
  });

  app.get("/api/me", async (req) => meSummary(requireUser(req).id));

  app.patch<{ Body: { displayName?: string; email?: string } }>(
    "/api/me",
    { schema: { body: { type: "object", additionalProperties: false, properties: { displayName, email } } } },
    async (req) => {
      const me = requireUser(req);
      if (req.body.email) {
        const taken = await query(`SELECT 1 FROM users WHERE email = $1 AND id <> $2`, [req.body.email.trim(), me.id]);
        if (taken.rows.length) throw conflict("Another account already uses that email.");
      }
      await query(
        `UPDATE users SET display_name = coalesce($2, display_name), email = coalesce($3, email), updated_at = now() WHERE id = $1`,
        [me.id, req.body.displayName?.trim() || null, req.body.email?.trim() || null],
      );
      return meSummary(me.id);
    },
  );

  app.post<{ Body: { current: string; next: string } }>(
    "/api/me/password",
    { schema: { body: { type: "object", required: ["current", "next"], properties: { current: password, next: password } } } },
    async (req) => {
      const me = requireUser(req);
      if (req.body.next.length < MIN_PASSWORD) throw badRequest(`Use at least ${MIN_PASSWORD} characters for the password.`);
      const { rows } = await query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [me.id]);
      if (!(await verifyPassword(req.body.current, rows[0].password_hash))) throw badRequest("Your current password isn't right.");
      await query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [me.id, await hashPassword(req.body.next)]);
      // Every other browser has to sign in again; this one stays.
      await query(`DELETE FROM sessions WHERE user_id = $1 AND id IS DISTINCT FROM $2`, [me.id, me.session_id]);
      await audit(pool, { userId: me.id, action: "user.password_changed", entity: "user", entityId: me.id });
      return { ok: true };
    },
  );

  // The browser crops and shrinks the picture first; this just stores what it is sent.
  app.put("/api/me/avatar", { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const me = requireUser(req);
    const ext = AVATAR_TYPES[String(req.headers["content-type"]).split(";")[0]];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) throw badRequest("Send a PNG, JPEG or WebP picture.");
    await fs.mkdir(AVATAR_DIR(), { recursive: true });
    const name = `${me.id}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
    await fs.writeFile(path.join(AVATAR_DIR(), name), req.body);
    const old = await query<{ avatar_path: string | null }>(`SELECT avatar_path FROM users WHERE id = $1`, [me.id]);
    await query(`UPDATE users SET avatar_path = $2, updated_at = now() WHERE id = $1`, [me.id, name]);
    if (old.rows[0]?.avatar_path) await fs.rm(path.join(AVATAR_DIR(), old.rows[0].avatar_path), { force: true });
    return meSummary(me.id);
  });

  app.delete("/api/me/avatar", async (req) => {
    const me = requireUser(req);
    const old = await query<{ avatar_path: string | null }>(`SELECT avatar_path FROM users WHERE id = $1`, [me.id]);
    await query(`UPDATE users SET avatar_path = NULL, updated_at = now() WHERE id = $1`, [me.id]);
    if (old.rows[0]?.avatar_path) await fs.rm(path.join(AVATAR_DIR(), old.rows[0].avatar_path), { force: true });
    return meSummary(me.id);
  });

  // Any signed-in person can see anyone's picture: teammates and requesters both need it.
  app.get<{ Params: { id: string } }>("/api/users/:id/avatar", async (req, reply) => {
    requireUser(req);
    const { rows } = await query<{ avatar_path: string | null }>(`SELECT avatar_path FROM users WHERE id = $1`, [req.params.id]);
    const file = rows[0]?.avatar_path;
    if (!file) throw notFound();
    reply.header("Cache-Control", "private, max-age=86400");
    return reply.sendFile(file, AVATAR_DIR());
  });
}
