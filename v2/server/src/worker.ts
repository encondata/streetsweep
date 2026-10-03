// The worker: the only process that talks to OSM, Overpass, Valhalla and tile sources.
// Jobs come through pg-boss (its own `pgboss` schema in the same database).
import { PgBoss } from "pg-boss";
import { config } from "./config.js";

const boss = new PgBoss({ connectionString: config.databaseUrl });
boss.on("error", (err) => console.error("pg-boss:", err));

async function main() {
  await boss.start();
  // Stage 0: a ping queue proves the round trip. Real queues (osm-import, area-build,
  // drive-match, coverage-rollup, package-build) arrive with their stages.
  await boss.createQueue("ping");
  await boss.work("ping", async ([job]) => {
    console.log("ping", job.id, job.data);
    return { pong: new Date().toISOString() };
  });
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
