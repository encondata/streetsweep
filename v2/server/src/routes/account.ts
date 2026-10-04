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
import { confirmUser, createUser } from "../users.js";
import { CODE_MINUTES, issueCode, sendOrForget, useCode } from "../codes.js";
import { codeEmail, sendMail } from "../mail.js";
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
    `SELECT id, email, display_name, ${avatarUrl("users")} AS avatar_url, is_site_admin, created_at, preferences
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

/** A street colour someone chose: #rrggbb and how opaque, 0.1 to 1. */
type MapColors = { driven: { color: string; opacity: number }; undriven: { color: string; opacity: number } };
const COLOR_SPEC = {
  type: "object", additionalProperties: false, required: ["color", "opacity"],
  properties: { color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, opacity: { type: "number", minimum: 0.1, maximum: 1 } },
};

export default async function accountRoutes(app: FastifyInstance) {
  app.post<{ Body: { email: string; displayName: string; password: string; remember?: boolean } }>(
    "/api/auth/signup",
    { schema: { body: { type: "object", required: ["email", "displayName", "password"], additionalProperties: false,
        properties: { email, displayName, password, remember: { type: "boolean" } } } } },
    async (req, reply) => {
      const { email: addrIn, displayName: nameIn, password: pw } = req.body;
      const addr = addrIn.trim();
      const name = nameIn.trim();
      if (pw.length < MIN_PASSWORD) throw badRequest(`Use at least ${MIN_PASSWORD} characters for the password.`);
      // Nothing is usable until the emailed code comes back. An address that was never
      // confirmed can be signed up again (new name, password and code), so nobody can
      // squat on someone else's email by starting a sign-up with it.
      const { userId, code } = await tx(async (db) => {
        const { rows } = await db.query<{ id: string; verified: boolean }>(
          `SELECT id, email_verified_at IS NOT NULL AS verified FROM users WHERE email = $1 FOR UPDATE`, [addr],
        );
        let id = rows[0]?.id;
        if (rows[0]?.verified) throw conflict("There's already an account for that email. Sign in instead.");
        if (id) {
          await db.query(`UPDATE users SET display_name = $2, password_hash = $3, updated_at = now() WHERE id = $1`,
            [id, name, await hashPassword(pw)]);
        } else {
          id = await createUser(db, { email: addr, displayName: name, password: pw, verified: false });
        }
        return { userId: id, code: await issueCode(db, id, "verify") };
      });
      await sendOrForget(userId, "verify", () => sendVerifyCode(addr, name, code));
      return reply.code(202).send({ pending: true, email: addr, expires_in: CODE_MINUTES * 60 });
    },
  );

  async function sendVerifyCode(to: string, name: string, code: string) {
    const m = codeEmail({ name, code,
      lead: "Here's the code to confirm your email and finish setting up your StreetSweep account:",
      after: "Enter it on the StreetSweep page where you signed up." });
    await sendMail(to, `${code} is your StreetSweep confirmation code`, m.text, m.html);
  }

  // Confirm a new account with its emailed code; signs you in.
  app.post<{ Body: { email: string; code: string; remember?: boolean } }>(
    "/api/auth/verify",
    { schema: { body: { type: "object", required: ["email", "code"], properties: {
        email: { type: "string", maxLength: 254 }, code: { type: "string", maxLength: 20 }, remember: { type: "boolean" } } } } },
    async (req, reply) => {
      if (tooManyFailures(`ip:${req.ip}`)) throw new HttpError(429, "Too many tries. Wait fifteen minutes and try again.");
      const out = await tx(async (db) => {
        const { rows } = await db.query<{ id: string; verified: boolean }>(
          `SELECT id, email_verified_at IS NOT NULL AS verified FROM users WHERE email = $1 AND disabled_at IS NULL`,
          [req.body.email.trim()],
        );
        if (!rows[0]) throw new HttpError(400, "That code has expired. Send yourself a new one.", "expired");
        if (rows[0].verified) throw new HttpError(409, "That email is already confirmed. Sign in instead.", "verified");
        const check = await useCode(db, rows[0].id, "verify", req.body.code);
        if (!check.ok) return check; // commit the counted guess, then refuse
        await confirmUser(db, rows[0].id);
        return { ok: true as const, userId: rows[0].id };
      });
      if (!out.ok) {
        noteFailure(`ip:${req.ip}`);
        throw out.error;
      }
      const userId = out.userId;
      await startSession(req, reply, userId, req.body.remember ?? true);
      return meSummary(userId);
    },
  );

  // Send another confirmation code. Answers the same whether or not the address has
  // an account waiting, so it can't be used to find out who's signed up.
  app.post<{ Body: { email: string } }>(
    "/api/auth/resend",
    { schema: { body: { type: "object", required: ["email"], properties: { email: { type: "string", maxLength: 254 } } } } },
    async (req) => {
      const { rows } = await query<{ id: string; display_name: string; email: string }>(
        `SELECT id, display_name, email FROM users WHERE email = $1 AND email_verified_at IS NULL AND disabled_at IS NULL`,
        [req.body.email.trim()],
      );
      const u = rows[0];
      if (u) {
        const code = await issueCode(pool, u.id, "verify");
        await sendOrForget(u.id, "verify", () => sendVerifyCode(u.email, u.display_name, code));
      }
      return { ok: true, expires_in: CODE_MINUTES * 60 };
    },
  );

  // Forgotten password, step 1: email a one-time code. Same answer for unknown
  // addresses; throttling still applies to real ones.
  app.post<{ Body: { email: string } }>(
    "/api/auth/forgot",
    { schema: { body: { type: "object", required: ["email"], properties: { email: { type: "string", maxLength: 254 } } } } },
    async (req) => {
      const { rows } = await query<{ id: string; display_name: string; email: string }>(
        `SELECT id, display_name, email FROM users WHERE email = $1 AND disabled_at IS NULL`, [req.body.email.trim()],
      );
      const u = rows[0];
      if (u) {
        const code = await issueCode(pool, u.id, "reset");
        const m = codeEmail({ name: u.display_name, code,
          lead: "Someone (hopefully you) asked to reset your StreetSweep password. Here's your one-time code:",
          after: "Enter it on the StreetSweep sign-in page along with your new password." });
        await sendOrForget(u.id, "reset", () => sendMail(u.email, `${code} is your StreetSweep password reset code`, m.text, m.html));
        await audit(pool, { userId: u.id, action: "user.reset_requested", entity: "user", entityId: u.id });
      }
      return { ok: true, expires_in: CODE_MINUTES * 60 };
    },
  );

  // Forgotten password, step 2: code + new password. Signs you in and ends every other
  // browser session. (It also proves the address, so an unconfirmed account is confirmed.)
  app.post<{ Body: { email: string; code: string; password: string; remember?: boolean } }>(
    "/api/auth/reset",
    { schema: { body: { type: "object", required: ["email", "code", "password"], properties: {
        email: { type: "string", maxLength: 254 }, code: { type: "string", maxLength: 20 }, password,
        remember: { type: "boolean" } } } } },
    async (req, reply) => {
      if (req.body.password.length < MIN_PASSWORD) throw badRequest(`Use at least ${MIN_PASSWORD} characters for the password.`);
      if (tooManyFailures(`ip:${req.ip}`)) throw new HttpError(429, "Too many tries. Wait fifteen minutes and try again.");
      const out = await tx(async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `SELECT id FROM users WHERE email = $1 AND disabled_at IS NULL`, [req.body.email.trim()],
        );
        if (!rows[0]) throw new HttpError(400, "That code has expired. Send yourself a new one.", "expired");
        const check = await useCode(db, rows[0].id, "reset", req.body.code);
        if (!check.ok) return check; // commit the counted guess, then refuse
        await db.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`,
          [rows[0].id, await hashPassword(req.body.password)]);
        await db.query(`DELETE FROM sessions WHERE user_id = $1`, [rows[0].id]);
        await confirmUser(db, rows[0].id);
        await audit(db, { userId: rows[0].id, action: "user.password_reset_by_code", entity: "user", entityId: rows[0].id });
        return { ok: true as const, userId: rows[0].id };
      });
      if (!out.ok) {
        noteFailure(`ip:${req.ip}`);
        throw out.error;
      }
      const userId = out.userId;
      clearFailures(`email:${req.body.email.trim().toLowerCase()}`);
      await startSession(req, reply, userId, req.body.remember ?? true);
      return meSummary(userId);
    },
  );

  // Shared by browser sign-in and phone sign-in: throttled, timing-safe, one message for both misses.
  async function checkCredentials(ip: string, emailIn: string, pw: string) {
    const addr = emailIn.trim().toLowerCase();
    const keys = [`ip:${ip}`, `email:${addr}`];
    if (tooManyFailures(...keys)) throw new HttpError(429, "Too many tries. Wait fifteen minutes and try again.");
    const { rows } = await query<{ id: string; password_hash: string; disabled_at: Date | null; verified: boolean }>(
      `SELECT id, password_hash, disabled_at, email_verified_at IS NOT NULL AS verified FROM users WHERE email = $1`, [addr],
    );
    const user = rows[0];
    const ok = user ? await verifyPassword(pw, user.password_hash) : (await burnPasswordCheck(pw), false);
    if (!ok || !user) {
      noteFailure(...keys);
      throw new HttpError(401, "That email and password don't match.");
    }
    if (user.disabled_at) throw new HttpError(403, "This account has been switched off. Ask a site admin.");
    // Right password, but the email was never confirmed: the page offers to send a code.
    if (!user.verified) throw new HttpError(403, "Confirm your email first. We can send you a new code.", "unverified");
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

  // Your preferences, merged: send only what changes. Unknown keys are refused, so a
  // typo can't quietly store nothing useful.
  app.patch<{ Body: { map_colors?: MapColors; onboarded?: boolean } }>(
    "/api/me/preferences",
    { schema: { body: { type: "object", additionalProperties: false, properties: {
        map_colors: { type: "object", additionalProperties: false, required: ["driven", "undriven"], properties: {
          driven: COLOR_SPEC, undriven: COLOR_SPEC } },
        onboarded: { type: "boolean" } } } } },
    async (req) => {
      const me = requireUser(req);
      await query(`UPDATE users SET preferences = preferences || $2::jsonb, updated_at = now() WHERE id = $1`,
        [me.id, JSON.stringify(req.body)]);
      return meSummary(me.id);
    },
  );

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
