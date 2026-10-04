// Fills the demo account (seed-demo.mjs first) with two weeks of believable driving
// through Hyde Park, for store screenshots and demos: routes from Valhalla through a
// run of streets each time, uploaded as drives and matched like any other. About two
// thirds of the neighbourhood ends up swept, so the map shows both colours.
//   docker compose cp scripts/smoke-lib.mjs api:/app/smoke/ && docker compose cp scripts/seed-showcase.mjs api:/app/smoke/
//   docker compose exec -T -e DEMO_SEED=1 -w /app api node smoke/seed-showcase.mjs
// Local stacks only, like seed-demo: it refuses without DEMO_SEED=1.
import crypto from "node:crypto";
import { BASE, sql } from "./smoke-lib.mjs";
// The demo account from seed-demo.mjs (importing it would run it).
const DEMO_EMAIL = "demo@streetsweep.test";
const DEMO_PASSWORD = "sweep-demo-7f3k2q";

if (process.env.DEMO_SEED !== "1") {
  console.error("Refusing: set DEMO_SEED=1 (local stacks only).");
  process.exit(1);
}
const VALHALLA = process.env.VALHALLA_URL ?? "http://valhalla:8002";

let cookie = "";
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const me = await call("POST", "/api/auth/login", { email: DEMO_EMAIL, password: DEMO_PASSWORD });
if (me.status !== 200) throw new Error("Run seed-demo.mjs first.");
const userId = me.data.user.id;

// Named streets in the neighbourhood, each as its longest stretch: start and end.
const streets = await sql(
  `WITH w AS (
     SELECT w.name, ST_LineMerge(ST_Union(s.geom)) AS g FROM street_segments s JOIN street_ways w ON w.way_id = s.way_id
      WHERE w.name IS NOT NULL AND w.highway IN ('residential','tertiary','secondary','unclassified','living_street')
        AND s.retired_at IS NULL AND s.geom && ST_MakeEnvelope(-97.735, 30.300, -97.720, 30.316, 4326)
      GROUP BY w.name)
   SELECT name, ST_X(ST_StartPoint(d.geom)) AS x0, ST_Y(ST_StartPoint(d.geom)) AS y0,
          ST_X(ST_EndPoint(d.geom)) AS x1, ST_Y(ST_EndPoint(d.geom)) AS y1
     FROM w, LATERAL (SELECT geom FROM ST_Dump(w.g) ORDER BY ST_Length(geom) DESC LIMIT 1) d
    ORDER BY name`);

// The same shuffle every run, so reruns make the same drives (and are deduplicated).
const rand = (() => { let s = 42; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
const order = streets.map((s) => [rand(), s]).sort((a, b) => a[0] - b[0]).map(([, s]) => s);
const chosen = order.slice(0, Math.round(order.length * 0.68));
console.log(`${streets.length} streets in Hyde Park, driving ${chosen.length}`);

function decode6(s) {
  const out = []; let i = 0, lat = 0, lon = 0;
  while (i < s.length) {
    for (const k of [0, 1]) {
      let b, shift = 0, r = 0;
      do { b = s.charCodeAt(i++) - 63; r |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = r & 1 ? ~(r >> 1) : r >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}
const metres = ([a, b], [c, d]) => Math.hypot((c - a) * 96_000, (d - b) * 111_000);
function resample(line, step = 12) {
  const out = [line[0]];
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const seg = metres(line[i - 1], line[i]);
    let at = step - carry;
    while (at <= seg) {
      const f = at / seg;
      out.push([line[i - 1][0] + (line[i][0] - line[i - 1][0]) * f, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * f]);
      at += step;
    }
    carry = (carry + seg) % step;
  }
  return out;
}

// Eleven drives over the last two weeks, five or six streets each, mostly personal.
const per = Math.ceil(chosen.length / 11);
for (let d = 0; d < 11; d++) {
  const run = chosen.slice(d * per, (d + 1) * per);
  if (!run.length) break;
  const locations = run.flatMap((s) => [{ lon: s.x0, lat: s.y0, type: "break_through" }, { lon: s.x1, lat: s.y1, type: "break_through" }]);
  locations[0].type = "break"; locations[locations.length - 1].type = "break";
  const res = await fetch(`${VALHALLA}/route`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ locations, costing: "auto", directions_type: "none" }),
  }).then((r) => r.json());
  const shape = (res.trip?.legs ?? []).flatMap((l) => decode6(l.shape));
  if (shape.length < 2) { console.log(`drive ${d + 1}: no route (${res.error ?? "?"})`); continue; }
  const pts = resample(shape);
  const daysAgo = 13 - Math.round(d * 1.25);
  const t0 = Math.floor(Date.now() / 1000) - daysAgo * 86400 - 3600 * (2 + (d % 5)) - pts.length * 2;
  const h = crypto.createHash("sha1").update(`${userId}:showcase:${d}`).digest("hex");
  const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const r = await call("POST", "/api/drives", {
    id: uuid, drive_type: d % 4 === 3 ? "work" : "personal",
    points: pts.map(([lon, lat], i) => [t0 + i * 2, lat, lon, 6, 5]),
  });
  console.log(`drive ${d + 1}: ${run.map((s) => s.name).join(", ")} — ${pts.length} fixes, ${r.status}${r.data.duplicate ? " (already there)" : ""}`);
}
