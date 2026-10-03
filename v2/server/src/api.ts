// The api: REST for web, phones and loggers, plus the built web app and login page.
// It never calls an outside service — anything slow or external is a job for the worker.
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { pool, query } from "./db.js";
import { migrate } from "./migrate.js";

const app = Fastify({ logger: { level: "info" }, trustProxy: true });

app.get("/api/health", async (_req, reply) => {
  try {
    const { rows } = await query<{ postgis: string; migrations: string }>(
      `SELECT postgis_lib_version() AS postgis,
              (SELECT count(*) FROM schema_migrations)::text AS migrations`,
    );
    return { ok: true, postgis: rows[0].postgis, migrations: Number(rows[0].migrations) };
  } catch (err) {
    return reply.code(503).send({ ok: false, error: (err as Error).message });
  }
});

// Sign-in lands in stage 1. Until then the login page gets a clear answer, not a 404.
app.post("/api/auth/login", async (_req, reply) =>
  reply.code(501).send({ error: "Sign-in arrives in stage 1 of v2." }),
);

app.all("/api/*", async (_req, reply) => reply.code(404).send({ error: "Not found" }));

// Login page and brand assets (public/), then the web app (web/) with SPA fallback.
// wildcard: false registers one route per file at start-up, so "/" and client routes
// fall through to the web app instead of hitting a directory listing (403).
app.register(fastifyStatic, { root: config.publicDir, prefix: "/", index: false, wildcard: false });
app.get("/login", (_req, reply) => reply.sendFile("login.html", config.publicDir));

const webIndex = path.join(config.webDir, "index.html");
if (fs.existsSync(webIndex)) {
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== "GET") return reply.code(404).send({ error: "Not found" });
    // Built asset paths (/assets/*) come from web/; everything else is a client route.
    const rel = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(config.webDir, rel);
    if (rel.startsWith("/assets/") && file.startsWith(config.webDir) && fs.existsSync(file)) {
      return reply.sendFile(rel.slice(1), config.webDir);
    }
    return reply.type("text/html").send(fs.createReadStream(webIndex));
  });
}

async function main() {
  await migrate((m) => app.log.info(m));
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
