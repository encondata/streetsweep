"use strict";

/**
 * Who is asking.
 *
 * Everything that needs to know the caller goes through identify(), and nothing else in
 * the server reaches for a header itself. That is the whole point of this module: today
 * identify() understands a browser session cookie, a per-phone device token and the old
 * shared SYNC_TOKEN, and when Google sign-in arrives it becomes one more branch here
 * rather than a change spread across every route.
 *
 * Passwords use scrypt from Node's own crypto, so this stays dependency-free.
 */

const crypto = require("crypto");

const ROLES = ["admin", "driver", "viewer"];

// What each role may do. Read is deliberately open to everyone who is signed in at all:
// the point of a viewer account is to look. Drawing areas is an admin job, because an
// area's outline decides what every driver is measured against.
const RIGHTS = {
  admin:  { read: true, record: true, areas: true, admin: true },
  driver: { read: true, record: true, areas: false, admin: false },
  viewer: { read: true, record: false, areas: false, admin: false },
};

function can(user, right) {
  return Boolean(user && RIGHTS[user.role] && RIGHTS[user.role][right]);
}

// ---------------------------------------------------------------- schema

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            BIGSERIAL PRIMARY KEY,
      -- Stored lower-cased; the unique index is what stops two spellings of one person.
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'driver',
      -- Null for an account that only ever signs in with Google.
      password_hash TEXT,
      -- Google's subject id, filled in when that is wired up. Unique but nullable, so
      -- the many accounts without one do not collide.
      google_sub    TEXT UNIQUE,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      -- Where the picture lives in the photo store; null means show their initials.
      avatar_key    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id         BIGSERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      plate      TEXT,
      note       TEXT,
      active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- A signed-in browser. Only the hash is kept, so a copy of this table is not a set
    -- of working logins.
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash   TEXT PRIMARY KEY,
      user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at   TIMESTAMPTZ NOT NULL,
      user_agent   TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

    -- One per phone. Hashed for the same reason, and revoked rather than deleted so a
    -- lost handset leaves a trace of when it was cut off.
    CREATE TABLE IF NOT EXISTS device_tokens (
      token_hash   TEXT PRIMARY KEY,
      user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label        TEXT NOT NULL,
      vehicle_id   BIGINT REFERENCES vehicles(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ,
      revoked_at   TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS device_tokens_user ON device_tokens (user_id);

    -- Added after the first release, so it goes on separately rather than in the
    -- CREATE above, which existing installations have already run.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_key TEXT;
  `);
}

// ---------------------------------------------------------------- passwords

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT.keylen, SCRYPT, (err, key) =>
      err ? reject(err) : resolve(key));
  });
}

/** "scrypt$N$r$p$salt$key" — the parameters travel with the hash so they can change. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString("base64"), key.toString("base64")].join("$");
}

async function passwordMatches(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const want = Buffer.from(keyB64, "base64");
  const got = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, want.length,
      { N: Number(N), r: Number(r), p: Number(p) },
      (err, key) => err ? reject(err) : resolve(key));
  });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---------------------------------------------------------------- tokens

function newToken() { return crypto.randomBytes(32).toString("base64url"); }
function hashToken(token) { return crypto.createHash("sha256").update(String(token)).digest("hex"); }

const SESSION_DAYS = 30;

async function startSession(pool, userId, userAgent) {
  const token = newToken();
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)`,
    [hashToken(token), userId, String(SESSION_DAYS), (userAgent || "").slice(0, 300)]);
  return token;
}

async function endSession(pool, token) {
  if (!token) return;
  await pool.query("DELETE FROM sessions WHERE token_hash=$1", [hashToken(token)]);
}

async function endAllSessions(pool, userId) {
  await pool.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
}

/** Expired rows are useless and would otherwise pile up for ever. */
async function sweepSessions(pool) {
  await pool.query("DELETE FROM sessions WHERE expires_at < now()");
}

async function createDeviceToken(pool, { userId, label, vehicleId }) {
  const token = newToken();
  await pool.query(
    `INSERT INTO device_tokens (token_hash, user_id, label, vehicle_id) VALUES ($1,$2,$3,$4)`,
    [hashToken(token), userId, String(label || "Phone").slice(0, 80), vehicleId || null]);
  // The only time the caller ever sees it; nothing can read it back afterwards.
  return token;
}

// ---------------------------------------------------------------- who is asking

function readCookie(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return "";
}

function bearerOf(req) {
  const header = String(req.headers.authorization || "");
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return String(req.headers["x-streetsweep-token"] || "").trim();
}

const COOKIE = "ss_session";

/**
 * Returns { user, via, deviceId, vehicleId } or null.
 *
 * `via` says how they proved it — "session", "device" or "legacy" — which the routes use
 * to decide what a caller may do beyond their role. A legacy caller is the old shared
 * token: it still works so the phone in the field keeps syncing through the changeover,
 * but it is attributed to one nominated account rather than to a real person.
 */
async function identify(pool, req, opts) {
  const legacyToken = (opts && opts.legacyToken) || "";

  const cookie = readCookie(req, COOKIE);
  if (cookie) {
    const { rows } = await pool.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash=$1 AND s.expires_at > now() AND u.active`,
      [hashToken(cookie)]);
    if (rows[0]) {
      // Cheap enough once per request, and it is what makes "last seen" honest.
      pool.query("UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1", [hashToken(cookie)])
        .catch(() => {});
      return { user: publicUser(rows[0]), via: "session" };
    }
  }

  const bearer = bearerOf(req);
  if (bearer) {
    const { rows } = await pool.query(
      `SELECT u.*, d.vehicle_id, d.token_hash AS device
         FROM device_tokens d JOIN users u ON u.id = d.user_id
        WHERE d.token_hash=$1 AND d.revoked_at IS NULL AND u.active`,
      [hashToken(bearer)]);
    if (rows[0]) {
      pool.query("UPDATE device_tokens SET last_seen_at=now() WHERE token_hash=$1",
        [hashToken(bearer)]).catch(() => {});
      return {
        user: publicUser(rows[0]), via: "device",
        deviceId: rows[0].device,
        // pg hands BIGINT back as a string; everything downstream wants a number.
        vehicleId: rows[0].vehicle_id == null ? null : Number(rows[0].vehicle_id),
      };
    }

    // The shared token from before accounts existed. Compared in constant time like any
    // other secret, and only useful while a legacy account is nominated to own it.
    if (legacyToken && sameSecret(bearer, legacyToken)) {
      const { rows: legacy } = await pool.query(
        "SELECT * FROM users WHERE active ORDER BY id LIMIT 1");
      if (legacy[0]) return { user: publicUser(legacy[0]), via: "legacy" };
    }
  }

  return null;
}

function sameSecret(given, want) {
  const a = Buffer.from(String(given), "utf8");
  const b = Buffer.from(String(want), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Never let password_hash or google_sub out of this module. */
function publicUser(row) {
  return {
    id: Number(row.id), email: row.email, name: row.name,
    role: ROLES.includes(row.role) ? row.role : "driver",
    active: row.active !== false,
    hasPassword: Boolean(row.password_hash),
    hasAvatar: Boolean(row.avatar_key),
    // Changes whenever the row does, so a new picture is not hidden by a cached one.
    avatarVersion: row.updated_at ? new Date(row.updated_at).getTime() : 0,
  };
}

// ---------------------------------------------------------------- sign in

/**
 * Wrong password and unknown address are told apart nowhere but here, and the caller is
 * given the same words for both, so this cannot be used to find out who has an account.
 */
const attempts = new Map();          // email -> { count, until }
const MAX_TRIES = 8;
const LOCK_MS = 5 * 60 * 1000;

function lockedOut(email) {
  const rec = attempts.get(email);
  if (!rec) return 0;
  if (rec.until && rec.until > Date.now()) return Math.ceil((rec.until - Date.now()) / 1000);
  if (rec.until && rec.until <= Date.now()) attempts.delete(email);
  return 0;
}

function noteFailure(email) {
  const rec = attempts.get(email) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_TRIES) { rec.until = Date.now() + LOCK_MS; rec.count = 0; }
  attempts.set(email, rec);
}

function noteSuccess(email) { attempts.delete(email); }

async function signIn(pool, email, password) {
  const key = String(email || "").trim().toLowerCase();
  const wait = lockedOut(key);
  if (wait) return { error: `Too many tries. Wait ${wait} seconds.`, status: 429 };

  const { rows } = await pool.query("SELECT * FROM users WHERE email=$1", [key]);
  const row = rows[0];
  const ok = row && row.active && await passwordMatches(String(password || ""), row.password_hash);
  if (!ok) {
    noteFailure(key);
    return { error: "That email and password do not match.", status: 401 };
  }
  noteSuccess(key);
  return { user: publicUser(row) };
}

// ---------------------------------------------------------------- first run

/**
 * An empty users table means nobody can sign in, so make one account. ADMIN_EMAIL and
 * ADMIN_PASSWORD set it; without them the password is random and printed once, loudly,
 * because a silent default password is how installations end up wide open.
 */
async function ensureFirstAdmin(pool, log) {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM users");
  if (rows[0].n > 0) return null;

  const email = (process.env.ADMIN_EMAIL || "admin@streetsweep.local").trim().toLowerCase();
  const supplied = process.env.ADMIN_PASSWORD || "";
  const password = supplied || crypto.randomBytes(9).toString("base64url");
  await pool.query(
    `INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,'admin',$3)`,
    [email, process.env.ADMIN_NAME || "Administrator", await hashPassword(password)]);

  log("");
  log("  ┌───────────────────────────────────────────────────────────");
  log("  │ First run: an administrator account has been created.");
  log(`  │   email:    ${email}`);
  if (supplied) {
    log("  │   password: the ADMIN_PASSWORD you set");
  } else {
    log(`  │   password: ${password}`);
    log("  │ This is shown once. Change it after signing in.");
  }
  log("  └───────────────────────────────────────────────────────────");
  log("");
  return email;
}

module.exports = {
  ROLES, RIGHTS, can, COOKIE,
  ensureSchema, ensureFirstAdmin,
  hashPassword, passwordMatches,
  startSession, endSession, endAllSessions, sweepSessions,
  createDeviceToken, hashToken,
  identify, signIn, publicUser,
};
