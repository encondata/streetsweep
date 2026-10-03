// Passwords, sessions and the cookie that carries them.
import crypto from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { query } from "./db.js";
import { forbidden, unauthorized } from "./http.js";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const COOKIE = "ss_session";
const DAY = 86_400_000;
const PERSISTENT_MS = 30 * DAY; // "Remember me"
const BROWSER_MS = 1 * DAY;     // otherwise: a browser-session cookie, and a day at most

export const MIN_PASSWORD = 8;

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(key, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), want.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(got, want);
}

// Spent on unknown emails too, so response time doesn't reveal which addresses exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex"));
export async function burnPasswordCheck(pw: string) {
  await verifyPassword(pw, await DUMMY_HASH);
}

export function randomPassword(): string {
  // 12 chars from an alphabet without look-alikes; read out or typed by an admin.
  const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(12), (b) => abc[b % abc.length]).join("");
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest();

export interface SessionUser {
  id: string;
  email: string;
  display_name: string;
  avatar_path: string | null;
  is_site_admin: boolean;
  /** Browser session, or null when signed in with a phone's device token. */
  session_id: string | null;
  device_id: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
}

function setCookie(req: FastifyRequest, reply: FastifyReply, value: string, maxAgeMs: number | null) {
  const bits = [`${COOKIE}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (req.protocol === "https") bits.push("Secure");
  if (maxAgeMs !== null) bits.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  reply.header("Set-Cookie", bits.join("; "));
}

export async function startSession(req: FastifyRequest, reply: FastifyReply, userId: string, persistent: boolean) {
  const token = crypto.randomBytes(32).toString("base64url");
  const life = persistent ? PERSISTENT_MS : BROWSER_MS;
  await query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, persistent, expires_at)
     VALUES ($1, $2, $3, $4, now() + $5 * interval '1 millisecond')`,
    [userId, sha256(token), (req.headers["user-agent"] ?? "").slice(0, 300), persistent, life],
  );
  setCookie(req, reply, token, persistent ? life : null);
}

export async function endSession(req: FastifyRequest, reply: FastifyReply) {
  const token = readCookie(req, COOKIE);
  if (token) await query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  setCookie(req, reply, "", 0);
}

/** Mint a token for a phone. Returned once; only its hash is stored. */
export function newDeviceToken() {
  const token = "ssd_" + crypto.randomBytes(32).toString("base64url");
  return { token, hash: sha256(token) };
}

/** onRequest hook: attaches req.user for a live browser session or phone token. */
export async function loadUser(req: FastifyRequest) {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return loadDevice(req, auth.slice(7).trim());
  const token = readCookie(req, COOKIE);
  if (!token) return;
  const { rows } = await query<SessionUser & { last_seen_at: Date; persistent: boolean }>(
    `SELECT u.id, u.email, u.display_name, u.avatar_path, u.is_site_admin,
            s.id AS session_id, s.last_seen_at, s.persistent
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return;
  // Sliding expiry, written at most every five minutes.
  if (Date.now() - row.last_seen_at.getTime() > 5 * 60_000) {
    await query(
      `UPDATE sessions SET last_seen_at = now(),
              expires_at = CASE WHEN persistent THEN now() + interval '30 days' ELSE expires_at END
        WHERE id = $1`,
      [row.session_id],
    );
  }
  const { last_seen_at: _l, persistent: _p, ...user } = row;
  req.user = { ...user, device_id: null };
}

async function loadDevice(req: FastifyRequest, token: string) {
  const { rows } = await query<Omit<SessionUser, "session_id"> & { last_seen_at: Date | null }>(
    `SELECT u.id, u.email, u.display_name, u.avatar_path, u.is_site_admin, d.id AS device_id, d.last_seen_at
       FROM devices d JOIN users u ON u.id = d.user_id
      WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND u.disabled_at IS NULL`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return;
  if (!row.last_seen_at || Date.now() - row.last_seen_at.getTime() > 5 * 60_000) {
    await query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [row.device_id]);
  }
  const { last_seen_at: _l, ...user } = row;
  req.user = { ...user, session_id: null };
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireSiteAdmin(req: FastifyRequest): SessionUser {
  const user = requireUser(req);
  if (!user.is_site_admin) throw forbidden("Only a site admin can do that.");
  return user;
}

// Failed sign-ins per address and per IP, kept in memory: ten in fifteen minutes, then wait.
const failures = new Map<string, number[]>();
const WINDOW = 15 * 60_000;
const LIMIT = 10;

export function tooManyFailures(...keys: string[]): boolean {
  const now = Date.now();
  return keys.some((k) => (failures.get(k) ?? []).filter((t) => now - t < WINDOW).length >= LIMIT);
}

export function noteFailure(...keys: string[]) {
  const now = Date.now();
  for (const k of keys) failures.set(k, [...(failures.get(k) ?? []).filter((t) => now - t < WINDOW), now]);
}

export function clearFailures(...keys: string[]) {
  for (const k of keys) failures.delete(k);
}
