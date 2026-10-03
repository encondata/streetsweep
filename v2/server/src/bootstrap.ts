// First boot: make sure a site admin exists when ADMIN_EMAIL is set.
import { config } from "./config.js";
import { query, tx } from "./db.js";
import { MIN_PASSWORD, randomPassword } from "./auth.js";
import { createUser } from "./users.js";

export async function ensureSiteAdmin(log: (m: string) => void) {
  const { rows } = await query(`SELECT 1 FROM users WHERE is_site_admin LIMIT 1`);
  if (rows.length) return;
  if (!config.adminEmail) {
    log("No site admin yet. Set ADMIN_EMAIL (and ADMIN_PASSWORD) and restart, or run: " +
        "docker compose exec api node dist/cli.js make-admin you@example.com");
    return;
  }
  const existing = await query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [config.adminEmail]);
  if (existing.rows[0]) {
    await query(`UPDATE users SET is_site_admin = true WHERE id = $1`, [existing.rows[0].id]);
    log(`${config.adminEmail} is now a site admin.`);
    return;
  }
  const given = config.adminPassword;
  const password = given && given.length >= MIN_PASSWORD ? given : randomPassword();
  await tx((db) => createUser(db, { email: config.adminEmail, displayName: "Admin", password, siteAdmin: true }));
  log(given === password
    ? `Created site admin ${config.adminEmail} with ADMIN_PASSWORD.`
    : `Created site admin ${config.adminEmail}. Password (shown once): ${password}`);
}
