// The worker: the only process that talks to OSM, Overpass, Valhalla and tile sources.
// Jobs come through pg-boss (its own `pgboss` schema in the same database).
import { PgBoss } from "pg-boss";
import { config } from "./config.js";
import { pool } from "./db.js";
import { regionOf, runImport } from "./osm/import.js";

const boss = new PgBoss({ connectionString: config.databaseUrl });
boss.on("error", (err) => console.error("pg-boss:", err));

export const QUEUES = { ping: "ping", osmImport: "osm-import" } as const;
type ImportJob = { force?: boolean; requestedBy?: string | null };

async function osmImport(data: ImportJob) {
  const url = config.osmExtractUrl;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO osm_imports (source_url, region, requested_by, step) VALUES ($1, $2, $3, 'Starting') RETURNING id`,
    [url, regionOf(url), data.requestedBy ?? null],
  );
  const importId = rows[0].id;
  const t0 = Date.now();
  console.log(`osm-import #${importId}: ${url}${data.force ? " (forced)" : ""}`);
  try {
    await runImport({ importId, url, force: !!data.force });
    console.log(`osm-import #${importId}: finished in ${Math.round((Date.now() - t0) / 1000)} s`);
  } catch (err) {
    console.error(`osm-import #${importId} failed:`, err);
    await pool.query(
      `UPDATE osm_imports SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [importId, String((err as Error).message ?? err).slice(0, 2000)],
    );
    throw err;
  }
}

async function main() {
  await boss.start();

  await boss.createQueue(QUEUES.ping);
  await boss.work(QUEUES.ping, async ([job]) => {
    console.log("ping", job.id, job.data);
    return { pong: new Date().toISOString() };
  });

  // One import at a time; Texas takes a while, so a generous expiry and one retry.
  await boss.createQueue(QUEUES.osmImport, { policy: "singleton", expireInSeconds: 4 * 3600, retryLimit: 1, retryDelay: 900 });
  await boss.work<ImportJob>(QUEUES.osmImport, async ([job]) => osmImport(job.data ?? {}));
  // Geofabrik refreshes daily; monthly is plenty for streets (3rd of the month, 04:00).
  await boss.schedule(QUEUES.osmImport, "0 4 3 * *", {}, { tz: config.timezone });

  // A run that was going when the worker stopped didn't finish.
  await pool.query(`UPDATE osm_imports SET status = 'failed', error = 'Interrupted (the worker restarted)', finished_at = now()
                     WHERE status = 'running'`);
  // First start: no streets yet, so fetch them now rather than waiting for the 3rd.
  const any = await pool.query(`SELECT 1 FROM osm_imports WHERE status = 'done' LIMIT 1`);
  if (!any.rows.length) await boss.send(QUEUES.osmImport, { force: true });

  console.log("worker ready");
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    await boss.stop({ graceful: true, timeout: 10_000 });
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
