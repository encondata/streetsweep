// Sending jobs to the worker from the api. Send-only: no maintenance, no schedules here.
import { PgBoss } from "pg-boss";
import { config } from "./config.js";

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

async function client(): Promise<PgBoss> {
  if (boss) return boss;
  starting ??= (async () => {
    const b = new PgBoss({ connectionString: config.databaseUrl, supervise: false, schedule: false, migrate: false });
    b.on("error", (err) => console.error("pg-boss (api):", err));
    await b.start();
    boss = b;
    return b;
  })();
  return starting;
}

export async function sendJob(queue: string, data: object, options: object = {}) {
  return (await client()).send(queue, data, options);
}

export async function stopJobs() {
  if (boss) await boss.stop({ graceful: false });
}
