"use strict";

/**
 * Sets a new password for one account, from the host.
 *
 *   docker compose exec web node reset-password.js someone@example.com
 *   docker compose exec web node reset-password.js someone@example.com --make-admin
 *
 * Without a password argument one is invented and printed. This is the way back in when
 * the only administrator has forgotten theirs: passwords are scrypt hashes, so psql on
 * its own cannot set one.
 *
 * Every open browser session for that account is ended, on the assumption that a
 * password is being reset because somebody should no longer be signed in.
 */

const crypto = require("crypto");
const { Pool } = require("pg");
const identity = require("./identity");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const rest = args.filter((a) => !a.startsWith("--"));
const email = String(rest[0] || "").trim().toLowerCase();
const given = rest[1];

if (!email) {
  console.error("Usage: node reset-password.js <email> [new-password] [--make-admin]");
  process.exit(2);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    "postgres://streetsweep:streetsweep@db:5432/streetsweep",
});

(async () => {
  const { rows } = await pool.query("SELECT id, name, role, active FROM users WHERE email=$1", [email]);
  const user = rows[0];
  if (!user) {
    console.error(`\nThere is no account for ${email}.`);
    const { rows: all } = await pool.query("SELECT email, role FROM users ORDER BY id");
    if (all.length) {
      console.error("\nAccounts on this server:");
      for (const a of all) console.error(`  ${a.email}  (${a.role})`);
    } else {
      console.error("\nThere are no accounts at all. Restart the server and it will make one.");
    }
    process.exit(1);
  }

  const password = given || crypto.randomBytes(9).toString("base64url");
  if (password.length < 10) {
    console.error("\nUse at least 10 characters.");
    process.exit(2);
  }

  const makeAdmin = flags.has("--make-admin");
  await pool.query(
    `UPDATE users SET password_hash=$1, active=TRUE,
            role = CASE WHEN $2 THEN 'admin' ELSE role END, updated_at=now()
      WHERE id=$3`,
    [await identity.hashPassword(password), makeAdmin, user.id]);
  await identity.endAllSessions(pool, user.id);

  console.log("");
  console.log("  ┌───────────────────────────────────────────────────────────");
  console.log(`  │ Password set for ${user.name} <${email}>`);
  console.log(`  │   password: ${password}`);
  if (makeAdmin && user.role !== "admin") console.log("  │   role:     admin (raised)");
  if (!user.active) console.log("  │   the account was switched off and is now on again");
  console.log("  │ Any browser signed in as them has been signed out.");
  console.log("  └───────────────────────────────────────────────────────────");
  console.log("");
  await pool.end();
})().catch((err) => {
  console.error("\nCould not set the password:", err.message);
  process.exit(1);
});
