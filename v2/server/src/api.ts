import zlib from "node:zlib";
// The api: REST for web, phones and loggers, plus the built web app and login page.
// It never calls an outside service — anything slow or external is a job for the worker.
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { pool, query } from "./db.js";
import { migrate } from "./migrate.js";
import { loadUser } from "./auth.js";
import { ensureSiteAdmin } from "./bootstrap.js";
import { HttpError } from "./http.js";
import accountRoutes from "./routes/account.js";
import teamRoutes from "./routes/teams.js";
import adminRoutes from "./routes/admin.js";
import vehicleRoutes from "./routes/vehicles.js";
import loggerRoutes from "./routes/loggers.js";
import deviceRoutes from "./routes/devices.js";
import tileRoutes from "./routes/tiles.js";
import mapRoutes from "./routes/map.js";
import areaRoutes from "./routes/areas.js";
import driveRoutes from "./routes/drives.js";
import loggerBatchRoutes from "./routes/loggerBatches.js";
import insightRoutes from "./routes/insights.js";
import placeRoutes from "./routes/places.js";
import syncRoutes from "./routes/sync.js";
import packageRoutes from "./routes/packages.js";
import geocodeRoutes from "./routes/geocode.js";
import waterRoutes from "./routes/water.js";
import deletionRoutes from "./routes/deletion.js";
import { stopJobs } from "./jobs.js";

const app = Fastify({ logger: { level: "info" }, trustProxy: true });

// Pictures arrive as raw bytes (the browser has already cropped them).
app.addContentTypeParser(["image/png", "image/jpeg", "image/webp"], { parseAs: "buffer" }, (_req, body, done) => done(null, body));
// Phones gzip big uploads (drives): unpack before parsing. Body limits count unpacked bytes.
app.addHook("preParsing", async (req, _reply, payload) => {
  if (String(req.headers["content-encoding"] ?? "").toLowerCase() !== "gzip") return payload;
  // Fastify checks Content-Length against the bytes that arrived (still packed).
  const gunzip = Object.assign(zlib.createGunzip(), { receivedEncodedLength: 0 });
  payload.on("data", (chunk: Buffer) => (gunzip.receivedEncodedLength += chunk.length));
  payload.pipe(gunzip);
  return gunzip;
});

// Cookies are SameSite=Lax; on top of that, writes must not be something a plain HTML
// form on another site could send, which rules out cross-site form posts entirely.
const FORM_TYPES = /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)/i;
app.addHook("onRequest", async (req, reply) => {
  if (req.method !== "GET" && req.method !== "HEAD" && FORM_TYPES.test(req.headers["content-type"] ?? "")) {
    return reply.code(415).send({ error: "Send JSON." });
  }
  if (req.url.startsWith("/api/")) await loadUser(req);
});

app.setErrorHandler((err: any, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, code: err.code });
  if (err.validation) return reply.code(400).send({ error: friendlyValidation(err) });
  if (err.code === "22P02") return reply.code(404).send({ error: "Not found." }); // malformed uuid in the URL
  if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
  req.log.error(err);
  return reply.code(500).send({ error: "Something went wrong on the server." });
});

function friendlyValidation(err: { validation: { instancePath: string; message?: string; keyword: string }[] }) {
  const v = err.validation[0];
  const field = v.instancePath.replace(/^\//, "");
  if (v.keyword === "format" && field === "email") return "That doesn't look like an email address.";
  if (v.keyword === "minLength") return `${field || "A field"} can't be empty.`;
  return `${field || "Request"} ${v.message ?? "is not valid"}.`;
}

app.register(accountRoutes);
app.register(teamRoutes);
app.register(adminRoutes);
app.register(vehicleRoutes);
app.register(loggerRoutes);
app.register(deviceRoutes);
app.register(tileRoutes);
app.register(mapRoutes);
app.register(areaRoutes);
app.register(driveRoutes);
app.register(loggerBatchRoutes);
app.register(insightRoutes);
app.register(placeRoutes);
app.register(syncRoutes);
app.register(packageRoutes);
app.register(geocodeRoutes);
app.register(waterRoutes);
app.register(deletionRoutes);

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

app.all("/api/*", async (_req, reply) => reply.code(404).send({ error: "Not found" }));

// Login page and brand assets (public/), then the web app (web/) with SPA fallback.
// wildcard: false registers one route per file at start-up, so "/" and client routes
// fall through to the web app instead of hitting a directory listing (403).
app.register(fastifyStatic, { root: config.publicDir, prefix: "/", index: false, wildcard: false });
// One page for both: it shows the sign-up form at /signup.
app.get("/login", (_req, reply) => reply.sendFile("login.html", config.publicDir));
app.get("/signup", (_req, reply) => reply.sendFile("login.html", config.publicDir));
// Privacy policy, linked from the Play listing. /policies and /privacy are friendlier spellings.
for (const p of ["/policys", "/policies", "/privacy"]) {
  app.get(p, (_req, reply) => reply.sendFile("policys.html", config.publicDir));
}
// Deleting your account, signed in or not (the Play listing's deletion link).
app.get("/delete-me", (_req, reply) => reply.sendFile("delete-me.html", config.publicDir));

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
  await ensureSiteAdmin((m) => app.log.warn(m));
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    await app.close();
    await stopJobs();
    await pool.end();
    process.exit(0);
  });
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
