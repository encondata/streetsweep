// Fixes from a logger: POST /api/logger/batches, signed like every logger request.
// Its own plugin so the body arrives as the exact bytes signed, not re-serialised JSON.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { sendJob } from "../jobs.js";
import { badRequest } from "../http.js";
import { cleanPoints, type RawPoint } from "../drives/track.js";
import { verifyLogger } from "./loggers.js";

const MAX_POINTS = 20_000;

export default async function loggerBatchRoutes(app: FastifyInstance) {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  /**
   * Body: {"seq": 17, "points": [[epoch_s, lat, lon, accuracy_m?, speed_ms?], ...]}
   * `seq` counts up per logger; a batch sent twice (Wi-Fi retry, BLE relay and Wi-Fi
   * both) is taken once. Header X-Logger-Via: ble when a phone relays it.
   */
  app.post("/api/logger/batches", { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const logger = await verifyLogger(req, raw);
    let body: { seq?: unknown; points?: unknown };
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      throw badRequest("The batch isn't valid JSON.");
    }
    const seq = Number(body.seq);
    if (!Number.isSafeInteger(seq) || seq < 0) throw badRequest("seq must be a whole number counting up.");
    if (!Array.isArray(body.points) || body.points.length > MAX_POINTS) throw badRequest(`points must be an array of at most ${MAX_POINTS}.`);
    // Loggers keep every fix; cleaning (accuracy, jumps) happens per drive. Here only
    // drop what can't be a fix at all.
    const fixes = cleanPoints(body.points as RawPoint[]);
    const via = String(req.headers["x-logger-via"] ?? "").toLowerCase() === "ble" ? "ble" : "wifi";

    const client = await pool.connect();
    let fresh = false;
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO logger_batches (logger_id, seq, via, relayed_by, point_count) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [logger.id, seq, via, via === "ble" ? (req.user?.device_id ?? null) : null, fixes.length],
      );
      fresh = !!ins.rowCount;
      if (fresh && fixes.length) {
        await client.query(
          `INSERT INTO logger_points (logger_id, t, lat, lon, accuracy, speed)
           SELECT $1, to_timestamp(t), lat, lon, acc, speed
             FROM unnest($2::float8[], $3::float8[], $4::float8[], $5::float4[], $6::float4[]) AS x(t, lat, lon, acc, speed)
           ON CONFLICT DO NOTHING`,
          [logger.id, fixes.map((f) => f.t), fixes.map((f) => f.lat), fixes.map((f) => f.lon), fixes.map((f) => f.acc), fixes.map((f) => f.speed)],
        );
      }
      await client.query(`UPDATE loggers SET last_seen_at = now() WHERE id = $1`, [logger.id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (fresh && fixes.length) await sendJob("logger-assemble", { loggerId: logger.id }, { singletonKey: logger.id });
    return reply.code(fresh ? 201 : 200).send({ ok: true, duplicate: !fresh, accepted: fresh ? fixes.length : 0 });
  });
}
