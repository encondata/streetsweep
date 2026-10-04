// Maintenance from the shell:
//   docker compose exec api node dist/cli.js make-admin you@example.com
//   docker compose exec api node dist/cli.js reset-password you@example.com
//   docker compose exec api node dist/cli.js create-user reviewer@example.com "Play Reviewer"
import { pool, query, tx } from "./db.js";
import { hashPassword, randomPassword } from "./auth.js";
import { confirmUser, createUser } from "./users.js";

async function main() {
  const [cmd, email, name] = process.argv.slice(2);
  if (!cmd || !email) throw new Error("usage: cli.js make-admin|reset-password|create-user <email> [display name]");
  if (cmd === "create-user") {
    // A confirmed account with no emailed code, e.g. for app store review.
    const pw = randomPassword();
    await tx((db) => createUser(db, { email, displayName: name || email.split("@")[0], password: pw, verified: true }));
    console.log(`Created ${email}. Password (shown once): ${pw}`);
    return;
  }
  const { rows } = await query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
  if (!rows[0]) throw new Error(`No account for ${email}. Sign up first, then run this.`);
  if (cmd === "make-admin") {
    await query(`UPDATE users SET is_site_admin = true WHERE id = $1`, [rows[0].id]);
    // Promoting from the shell vouches for the address too.
    await tx((db) => confirmUser(db, rows[0].id));
    console.log(`${email} is now a site admin.`);
  } else if (cmd === "reset-password") {
    const pw = randomPassword();
    await query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [rows[0].id, await hashPassword(pw)]);
    await query(`DELETE FROM sessions WHERE user_id = $1`, [rows[0].id]);
    console.log(`New password for ${email}: ${pw}`);
  } else {
    throw new Error(`unknown command ${cmd}`);
  }
}

main().then(() => pool.end(), (err) => { console.error(err.message); process.exit(1); });
