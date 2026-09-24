"use strict";

/**
 * Copies photos out of the old MinIO bucket and onto the volume.
 *
 *   docker compose exec web node migrate-photos.js
 *
 * Run this once, while the old minio container is still running, before taking it away.
 * It is safe to run twice: a photo already on the volume is left alone.
 *
 * If you never attached a photo to a marked place there is nothing to do here, and this
 * will say so. Once it has run, minio and the S3_* settings can go for good.
 */

const { Pool } = require("pg");
const photos = require("./photos");

const BUCKET = process.env.S3_BUCKET || "streetsweep-photos";

let Minio;
try {
  Minio = require("minio");
} catch {
  console.error("\nThe minio client is no longer installed, so there is nothing to copy from.");
  process.exit(1);
}

// The old service was called "minio" on the compose network with these credentials, so
// the documented command works with no flags even though compose no longer sets them.
// Anything unusual can still be passed in with `docker compose exec -e S3_KEY=... `.
const client = new Minio.Client({
  endPoint: process.env.S3_ENDPOINT || "minio",
  port: Number(process.env.S3_PORT || 9000),
  useSSL: String(process.env.S3_SSL || "") === "true",
  accessKey: process.env.S3_KEY || "streetsweep",
  secretKey: process.env.S3_SECRET || "streetsweep-photos",
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    "postgres://streetsweep:streetsweep@db:5432/streetsweep",
});

function collect(stream) {
  return new Promise((resolve, reject) => {
    const parts = [];
    stream.on("data", (c) => parts.push(c));
    stream.on("end", () => resolve(Buffer.concat(parts)));
    stream.on("error", reject);
  });
}

(async () => {
  await photos.ready();
  if (!photos.on()) process.exit(1);

  // Drive it from the database rather than by listing the bucket: the rows are what the
  // app actually reads, and a stray object nobody points at is not worth carrying over.
  const { rows } = await pool.query(
    "SELECT id, photo_key FROM pois WHERE photo_key IS NOT NULL ORDER BY at");
  if (!rows.length) {
    console.log("\nNo marked place has a photo. Nothing to migrate.\n");
    await pool.end();
    return;
  }

  console.log(`\n${rows.length} photo(s) to check.\n`);
  let copied = 0, already = 0, missing = 0;
  for (const row of rows) {
    const key = row.photo_key;
    if (await photos.stat(key)) { already++; continue; }
    try {
      const bytes = await collect(await client.getObject(BUCKET, key));
      await photos.put(key, bytes);
      copied++;
      console.log(`  copied  ${key}  (${(bytes.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      missing++;
      console.log(`  MISSING ${key}  — ${err.message}`);
    }
  }

  console.log("");
  console.log(`  copied           ${copied}`);
  console.log(`  already on disk  ${already}`);
  if (missing) {
    console.log(`  could not read   ${missing}   (their places keep pointing at nothing)`);
  }
  console.log("");
  if (!missing) console.log("All accounted for. The minio container can go now.\n");
  await pool.end();
})().catch((err) => {
  console.error("\nMigration failed:", err.message);
  process.exit(1);
});
