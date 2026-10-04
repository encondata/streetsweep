// The worker: the only process that talks to OSM, Overpass, Valhalla and tile sources.
// Jobs come through pg-boss (its own `pgboss` schema in the same database).
import { PgBoss } from "pg-boss";
import { config } from "./config.js";
import { pool } from "./db.js";
import { regionOf, runImport } from "./osm/import.js";
import { areasInUse, buildArea, importBoundaries } from "./osm/areas.js";
import { matchDrive, ValhallaDown } from "./drives/match.js";
import { assembleLogger, loggersWithOpenPoints } from "./drives/assemble.js";
import { rebuildTeam } from "./drives/coverage.js";

const boss = new PgBoss({ connectionString: config.databaseUrl });
boss.on("error", (err) => console.error("pg-boss:", err));

export const QUEUES = {
  ping: "ping", osmImport: "osm-import", areaBuild: "area-build",
  driveMatch: "drive-match", loggerAssemble: "logger-assemble", loggerSweep: "logger-sweep", coverageRebuild: "coverage-rebuild",
} as const;
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
    const result = await runImport({ importId, url, force: !!data.force });
    if (result === "imported") {
      await finishWithBoundaries(importId, regionOf(url));
      await rebuildAreasInUse();
    }
    console.log(`osm-import #${importId}: ${result} in ${Math.round((Date.now() - t0) / 1000)} s`);
  } catch (err) {
    console.error(`osm-import #${importId} failed:`, err);
    await pool.query(
      `UPDATE osm_imports SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [importId, String((err as Error).message ?? err).slice(0, 2000)],
    );
    throw err;
  }
}

/** Boundaries come from the same extract; the run is done once they're in. */
async function finishWithBoundaries(importId: number, region: string) {
  const step = (s: string) => pool.query(`UPDATE osm_imports SET step = $2 WHERE id = $1`, [importId, s]).then(() => {});
  const n = await importBoundaries(region, step);
  await pool.query(`UPDATE osm_imports SET status = 'done', step = 'Done', boundaries = $2, finished_at = now() WHERE id = $1`, [importId, n]);
}

/** New streets mean every area someone uses needs its street list redone. */
async function rebuildAreasInUse() {
  for (const id of await areasInUse()) await queueBuild(id);
}

async function queueBuild(areaId: string) {
  await pool.query(`UPDATE areas SET build_status = 'queued' WHERE id = $1 AND build_status <> 'building'`, [areaId]);
  await boss.send(QUEUES.areaBuild, { areaId }, { singletonKey: areaId });
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
  // Street lists for areas: a few at a time, a repeat for the same area while one waits is dropped.
  await boss.createQueue(QUEUES.areaBuild, { expireInSeconds: 3600, retryLimit: 2, retryDelay: 60 });
  await boss.work<{ areaId: string }>(QUEUES.areaBuild, { localConcurrency: 2 }, async ([job]) => {
    const t0 = Date.now();
    await buildArea(job.data.areaId);
    console.log(`area-build ${job.data.areaId}: ${Date.now() - t0} ms`);
  });
  // Matching drives. While Valhalla is down (or still building its tiles) drives wait and
  // retry with backoff; anything else is a real failure and is recorded on the drive.
  await boss.createQueue(QUEUES.driveMatch, { expireInSeconds: 1800, retryLimit: 60, retryDelay: 60, retryBackoff: true, retryDelayMax: 1800 });
  await boss.work<{ driveId: string }>(QUEUES.driveMatch, { localConcurrency: 2 }, async ([job]) => {
    const { driveId } = job.data;
    try {
      const r = await matchDrive(driveId);
      console.log(`drive-match ${driveId}: ${r.segments} segments (${r.method})`);
    } catch (err) {
      if (err instanceof ValhallaDown) {
        await pool.query(`UPDATE drives SET status = 'received', match_error = $2 WHERE id = $1`, [driveId, `Waiting: ${err.message}`]);
        throw err;
      }
      console.error(`drive-match ${driveId} failed:`, err);
      await pool.query(`UPDATE drives SET status = 'failed', match_error = $2 WHERE id = $1`, [driveId, String((err as Error).message).slice(0, 500)]);
    }
  });

  // Loggers: cut their points into drives after each batch, and sweep for quiet ones.
  await boss.createQueue(QUEUES.loggerAssemble, { expireInSeconds: 600, retryLimit: 3, retryDelay: 30 });
  await boss.work<{ loggerId: string }>(QUEUES.loggerAssemble, async ([job]) => {
    const made = await assembleLogger(job.data.loggerId);
    for (const driveId of made) await boss.send(QUEUES.driveMatch, { driveId });
    if (made.length) console.log(`logger-assemble ${job.data.loggerId}: ${made.length} drive(s)`);
  });
  await boss.createQueue(QUEUES.loggerSweep, { policy: "singleton", expireInSeconds: 300 });
  await boss.work(QUEUES.loggerSweep, async () => {
    for (const loggerId of await loggersWithOpenPoints()) await boss.send(QUEUES.loggerAssemble, { loggerId }, { singletonKey: loggerId });
  });
  await boss.schedule(QUEUES.loggerSweep, "*/5 * * * *", {});

  // Recounting a team (drive edited or deleted, a drive-type toggle changed).
  await boss.createQueue(QUEUES.coverageRebuild, { expireInSeconds: 1800, retryLimit: 2 });
  await boss.work<{ teamId: string }>(QUEUES.coverageRebuild, async ([job]) => {
    const t0 = Date.now();
    await rebuildTeam(job.data.teamId);
    console.log(`coverage-rebuild ${job.data.teamId}: ${Date.now() - t0} ms`);
  });

  // Geofabrik refreshes daily; monthly is plenty for streets (3rd of the month, 04:00).
  await boss.schedule(QUEUES.osmImport, "0 4 3 * *", {}, { tz: config.timezone });

  // A run that was going when the worker stopped didn't finish.
  await pool.query(`UPDATE osm_imports SET status = 'failed', error = 'Interrupted (the worker restarted)', finished_at = now()
                     WHERE status = 'running'`);
  // First start: no streets yet, so fetch them now rather than waiting for the 3rd.
  const any = await pool.query(`SELECT 1 FROM osm_imports WHERE status = 'done' LIMIT 1`);
  if (!any.rows.length) await boss.send(QUEUES.osmImport, { force: true });
  else {
    // Streets but no boundaries yet (an install from before areas existed): add them now.
    const b = await pool.query(`SELECT 1 FROM areas WHERE source = 'osm_boundary' LIMIT 1`);
    const last = await pool.query<{ id: number; region: string }>(
      `SELECT id, region FROM osm_imports WHERE status = 'done' ORDER BY id DESC LIMIT 1`);
    if (!b.rows.length && last.rows[0]) {
      const { id, region } = last.rows[0];
      console.log("boundaries: none yet, importing from the current extract");
      finishWithBoundaries(id, region).catch((err) => console.error("boundaries failed:", err));
    }
  }

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
