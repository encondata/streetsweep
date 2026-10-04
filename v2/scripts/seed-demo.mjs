// A demo account on a local stack, to click around the web app with: a car, Hyde Park
// drawn as an area, and a few real drives through it. Safe to run again (it tops up).
//   docker compose cp scripts/smoke-lib.mjs api:/app/smoke/ && docker compose cp scripts/seed-demo.mjs api:/app/smoke/
//   docker compose exec -T -w /app api node smoke/seed-demo.mjs
// Local test account only. Sign in at http://localhost:8430 with these:
import crypto from "node:crypto";
import { BASE, latestCode, sql } from "./smoke-lib.mjs";

export const DEMO_EMAIL = "demo@streetsweep.test";
export const DEMO_PASSWORD = "sweep-demo-7f3k2q";

let cookie = "";
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// Sign in, or sign up the first time.
let me = await call("POST", "/api/auth/login", { email: DEMO_EMAIL, password: DEMO_PASSWORD });
if (me.status !== 200) {
  const started = Date.now() - 1000;
  const up = await call("POST", "/api/auth/signup", { email: DEMO_EMAIL, displayName: "Demo Driver", password: DEMO_PASSWORD });
  if (up.status !== 202) throw new Error(`sign-up failed: ${JSON.stringify(up)}`);
  const mail = await latestCode(DEMO_EMAIL, { after: started });
  me = await call("POST", "/api/auth/verify", { email: DEMO_EMAIL, code: mail?.code });
  if (me.status !== 200) throw new Error(`confirming failed: ${JSON.stringify(me)}`);
  console.log("made the demo account");
}
const userId = me.data.user.id;
const personal = me.data.teams.find((t) => t.kind === "personal").id;

// A car and Hyde Park, once.
let vehicles = (await call("GET", "/api/vehicles")).data.vehicles;
if (!vehicles.some((v) => v.team_id === personal)) {
  await call("POST", "/api/vehicles", { team_id: personal, name: "Demo hatchback", make: "Honda", model: "Fit", year: 2019, color: "Blue" });
}
const areas = (await call("GET", `/api/teams/${personal}/areas`)).data.areas;
if (!areas.some((a) => a.name === "Hyde Park")) {
  await call("POST", `/api/teams/${personal}/areas`, {
    name: "Hyde Park", level: "neighborhood", color: "#1a6fd4",
    geometry: { type: "Polygon", coordinates: [[[-97.735, 30.300], [-97.720, 30.300], [-97.720, 30.316], [-97.735, 30.316], [-97.735, 30.300]]] },
  });
}

// The drives below happen in the past; the account and car have to be older than them.
await sql(`UPDATE team_members SET joined_at = least(joined_at, now() - interval '30 days') WHERE user_id = $1`, [userId]);
await sql(`UPDATE vehicle_assignments SET during = tstzrange(least(lower(during), now() - interval '30 days'), upper(during), '[)') WHERE user_id = $1`, [userId]);

// Drive along a few Hyde Park streets, as fixes every ~10 m, one a second.
async function routeAlong(name) {
  const [r] = await sql(
    `WITH w AS (
       SELECT ST_LineMerge(ST_Union(s.geom)) AS g FROM street_segments s JOIN street_ways w ON w.way_id = s.way_id
        WHERE w.name = $1 AND s.retired_at IS NULL AND s.geom && ST_MakeEnvelope(-97.735, 30.300, -97.720, 30.316, 4326))
     SELECT ST_AsGeoJSON(ST_Segmentize(d.geom::geography, 10)::geometry) AS line
       FROM w, ST_Dump(w.g) d ORDER BY ST_Length(d.geom) DESC LIMIT 1`,
    [name],
  );
  return r ? JSON.parse(r.line).coordinates : null;
}

const plan = [
  { street: "Avenue F", daysAgo: 3, type: "personal" },
  { street: "Duval Street", daysAgo: 1, type: "personal" },
  { street: "Speedway", daysAgo: 0, type: "work" },
];
for (const p of plan) {
  const coords = await routeAlong(p.street);
  if (!coords) { console.log(`no ${p.street} in the imported streets, skipped`); continue; }
  const t0 = Math.floor(Date.now() / 1000) - p.daysAgo * 86400 - 3600 - coords.length;
  // The same street on the same day is the same drive: a stable id makes reruns harmless.
  const id = crypto.createHash("sha1").update(`${userId}:${p.street}:${p.daysAgo}:${new Date(t0 * 1000).toDateString()}`).digest("hex");
  const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`;
  const r = await call("POST", "/api/drives", { id: uuid, drive_type: p.type, points: coords.map(([lon, lat], i) => [t0 + i, lat, lon, 5, 9]) });
  console.log(`${p.street}: ${r.status}${r.data.duplicate ? " (already there)" : ""}`);
}
console.log(`sign in as ${DEMO_EMAIL}`);
