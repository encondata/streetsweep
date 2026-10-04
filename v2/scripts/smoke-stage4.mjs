// Stage 4 API smoke test: phone uploads, matching, attribution, team coverage, drive-type
// toggles, logger batches and assembly, editing and deleting drives, marks, privacy.
// Needs the Texas streets and a running Valhalla (drives wait for it otherwise).
import crypto from "node:crypto";
import { BASE, PW, check, client, expect, finish, signUp, sql } from "./smoke-lib.mjs";

const ann = client("ann"), bob = client("bob"), cat = client("cat");
for (const c of [ann, bob, cat]) await signUp(c);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Drives below are timestamped in the past, and credit comes from history at the time of
// the drive. So push the setup made just now (memberships, car assignments, logger
// installs) back a day, as if it had always been that way.
async function backdateSetup() {
  const users = [ann.id, bob.id, cat.id];
  await sql(`UPDATE team_members SET joined_at = joined_at - interval '1 day' WHERE user_id = ANY($1::uuid[])`, [users]);
  await sql(`UPDATE vehicle_assignments SET during = tstzrange(lower(during) - interval '1 day', upper(during), '[)')
              WHERE user_id = ANY($1::uuid[]) AND lower(during) > now() - interval '1 hour'`, [users]);
  await sql(`UPDATE logger_installs i SET during = tstzrange(lower(i.during) - interval '1 day', upper(i.during), '[)')
               FROM loggers l WHERE l.id = i.logger_id AND l.owner_user_id = ANY($1::uuid[]) AND lower(i.during) > now() - interval '1 hour'`, [users]);
}

// A real route: Avenue F through Hyde Park, Austin, as fixes every ~10 m, 1 s apart.
const [route] = await sql(
  `WITH w AS (
     SELECT ST_LineMerge(ST_Union(s.geom)) AS g FROM street_segments s JOIN street_ways w ON w.way_id = s.way_id
      WHERE w.name = 'Avenue F' AND s.retired_at IS NULL
        AND s.geom && ST_MakeEnvelope(-97.735, 30.300, -97.720, 30.316, 4326))
   SELECT ST_AsGeoJSON(ST_Segmentize((ST_Dump(g)).geom::geography, 10)::geometry) AS line FROM w LIMIT 1`,
);
const coords = JSON.parse(route.line).coordinates;
check("a test route along Avenue F", coords.length > 50, coords.length);
const t0 = Math.floor(Date.now() / 1000) - 7200;
const points = coords.map(([lon, lat], i) => [t0 + i, lat, lon, 5, 9]);

console.log("phone upload");
const phone = client("annphone");
const signed = await expect("ann's phone signs in", phone.call("POST", "/api/auth/device", { email: ann.email, password: PW, deviceName: "Test phone" }), 201);
phone.useToken(signed.token);
const car = (await ann.call("POST", "/api/vehicles", { team_id: ann.personal, name: "Ann's car" })).data.vehicle;
const area = await expect("ann draws Hyde Park", ann.call("POST", `/api/teams/${ann.personal}/areas`, {
  name: "Hyde Park", geometry: { type: "Polygon", coordinates: [[[-97.735, 30.300], [-97.720, 30.300], [-97.720, 30.316], [-97.735, 30.316], [-97.735, 30.300]]] },
}), 201);
await backdateSetup();
const driveId = crypto.randomUUID();
const up = await expect("upload the drive", phone.call("POST", "/api/drives", { id: driveId, drive_type: "personal", points }), 201);
check("credited to ann in her car (inferred)", up.drive.user_id === ann.id && up.drive.vehicle_id === car.id && up.drive.attribution === "inferred", up.drive);
const again = await expect("upload it again", phone.call("POST", "/api/drives", { id: driveId, drive_type: "personal", points }), 200);
check("same drive, flagged duplicate", again.duplicate === true);
await expect("someone else can't reuse the id", bob.call("POST", "/api/drives", { id: driveId, points }), 409);
await expect("too short", phone.call("POST", "/api/drives", { id: crypto.randomUUID(), points: points.slice(0, 3) }), 422);
await expect("a car she can't drive", phone.call("POST", "/api/drives", { id: crypto.randomUUID(), vehicle_id: crypto.randomUUID(), points }), 400);
await expect("an unknown drive type", phone.call("POST", "/api/drives", { id: crypto.randomUUID(), drive_type: "nope", points }), 400);

async function waitMatched(c, id) {
  for (let i = 0; i < 240; i++) {
    const r = await c.call("GET", `/api/drives/${id}`);
    if (r.data.drive?.status === "matched" || r.data.drive?.status === "failed") return r.data;
    await sleep(500);
  }
  return (await c.call("GET", `/api/drives/${id}`)).data;
}
async function waitBuilt(id) {
  for (let i = 0; i < 120; i++) {
    const a = (await ann.call("GET", `/api/areas/${id}`)).data.area;
    if (a?.build_status === "built") return a;
    await sleep(500);
  }
}
async function progress() {
  return (await ann.call("GET", `/api/teams/${ann.personal}/areas`)).data.areas.find((a) => a.id === area.id);
}
async function until(fn, label) {
  for (let i = 0; i < 60; i++) {
    if (await fn()) return true;
    await sleep(500);
  }
  check(label, false);
  return false;
}

console.log("matching and coverage");
await waitBuilt(area.id);
const m = await waitMatched(ann, driveId);
check("matched with Valhalla", m.drive.status === "matched" && m.drive.match_method === "valhalla", { status: m.drive.status, method: m.drive.match_method, err: m.drive.match_error });
check("several Avenue F segments", m.drive.segment_count >= 5, m.drive.segment_count);
check("counts for her personal team", m.counts_for.some((t) => t.id === ann.personal));
check("drive detail has the track and streets", m.track?.type === "LineString" && m.streets?.coordinates?.length >= 5);
let p = await progress();
check("Hyde Park progress went up", p.driven_m > 300 && p.driven_m < p.total_m, { driven: p.driven_m, total: p.total_m });
const streetTile = await ann.call("GET", `/api/tiles/streets/16/${Math.floor((-97.7275 + 180) / 360 * 65536)}/${Math.floor((1 - Math.log(Math.tan(30.308 * Math.PI / 180) + 1 / Math.cos(30.308 * Math.PI / 180)) / Math.PI) / 2 * 65536)}?team=${ann.personal}`);
check("coloured street tile for her team", streetTile.status === 200);
await expect("a stranger can't ask for her team's colours", cat.call("GET", `/api/tiles/streets/16/1/1?team=${ann.personal}`), 404);

console.log("drive-type toggles");
await expect("personal drives stop counting", ann.call("PUT", `/api/teams/${ann.personal}/drive-types/personal`, { counts: false }), 200);
await until(async () => (await progress()).driven_m === 0, "coverage recounted to zero");
await expect("…and count again", ann.call("PUT", `/api/teams/${ann.personal}/drive-types/personal`, { counts: true }), 200);
await until(async () => (await progress()).driven_m > 300, "coverage back");

console.log("privacy");
await expect("a stranger can't see her drive", cat.call("GET", `/api/drives/${driveId}`), 404);
const mine = await expect("her drives", ann.call("GET", "/api/drives"), 200);
check("listed", mine.drives.some((d) => d.id === driveId));
check("not in anyone else's", !(await cat.call("GET", "/api/drives")).data.drives.some((d) => d.id === driveId));

console.log("loggers");
// Acme with a van Bob checks out; Ann's logger rides in the van.
const acme = (await ann.call("POST", "/api/teams", { name: `Acme ${Date.now()}` })).data.team;
await bob.call("POST", `/api/teams/${acme.id}/join-requests`, {});
const rq = (await ann.call("GET", `/api/teams/${acme.id}`)).data.requests[0];
await ann.call("POST", `/api/join-requests/${rq.id}/approve`, { role: "driver" });
const van = (await ann.call("POST", "/api/vehicles", { team_id: acme.id, name: "Van 9", kind: "van" })).data.vehicle;
const made = (await ann.call("POST", "/api/loggers", { name: "Van 9 board", default_drive_type_key: "delivery" })).data;
await ann.call("POST", `/api/loggers/${made.logger.id}/install`, { vehicle_id: van.id });
await bob.call("POST", `/api/vehicles/${van.id}/checkout`, {});
await backdateSetup();
// Shift the route into the past: logger drives are cut at quiet spells, and this one is over.
const lt0 = Math.floor(Date.now() / 1000) - 1800;
const lpoints = coords.map(([lon, lat], i) => [lt0 + i, lat, lon, 4, 9]);
function sendBatch(seq, pts, extra = {}) {
  const body = JSON.stringify({ seq, points: pts });
  const canonical = `POST\n/api/logger/batches\n${crypto.createHash("sha256").update(body).digest("hex")}`;
  const sig = crypto.createHmac("sha256", Buffer.from(made.setup.secret, "hex")).update(canonical).digest("hex");
  return fetch(`${BASE}/api/logger/batches`, {
    method: "POST", body,
    headers: { "content-type": "application/json", "x-logger-id": made.logger.id, "x-logger-signature": sig, ...extra },
  }).then(async (r) => ({ status: r.status, data: await r.json() }));
}
const half = Math.floor(lpoints.length / 2);
const b1 = await expect("first batch", sendBatch(1, lpoints.slice(0, half)), 201);
check("all fixes taken", b1.accepted === half, b1);
await expect("same batch again", sendBatch(1, lpoints.slice(0, half)), 200);
await expect("second batch (relayed by a phone)", sendBatch(2, lpoints.slice(half), { "x-logger-via": "ble" }), 201);
const forged = await fetch(`${BASE}/api/logger/batches`, { method: "POST", body: JSON.stringify({ seq: 3, points: [] }),
  headers: { "content-type": "application/json", "x-logger-id": made.logger.id, "x-logger-signature": "0".repeat(64) } });
check("bad signature refused", forged.status === 401);
let ld = null;
await until(async () => {
  const r = (await sql(`SELECT id FROM drives WHERE logger_id = $1`, [made.logger.id]));
  ld = r[0]?.id;
  return !!ld;
}, "the logger's points became a drive");
if (ld) {
  const lm = await waitMatched(ann, ld);
  check("credited to Bob (he had the van) in the van, as a delivery", lm.drive.user_id === bob.id && lm.drive.vehicle_id === van.id && lm.drive.drive_type_key === "delivery", lm.drive);
  check("logger drive matched", lm.drive.status === "matched" && lm.drive.segment_count >= 5);
  check("counts for Acme (Bob's team) and Bob's own", lm.counts_for.some((t) => t.id === acme.id) && lm.counts_for.some((t) => t.id === bob.personal), lm.counts_for);
  const team = await expect("Acme's admin sees the team's drives", ann.call("GET", `/api/teams/${acme.id}/drives`), 200);
  check("…including the van's", team.drives.some((d) => d.id === ld));
  await expect("a driver can't list them", bob.call("GET", `/api/teams/${acme.id}/drives`), 403);
  await expect("Bob can see his own", bob.call("GET", `/api/drives/${ld}`), 200);
  await expect("…but can't say someone else drove", bob.call("PATCH", `/api/drives/${ld}`, { user_id: ann.id }), 403);
}

console.log("editing and deleting");
await expect("make ann's drive a delivery", ann.call("PATCH", `/api/drives/${driveId}`, { drive_type: "delivery" }), 200);
await expect("her car, but Bob can't drive it", ann.call("PATCH", `/api/drives/${driveId}`, { user_id: bob.id }), 400);
await expect("a stranger can't edit", cat.call("PATCH", `/api/drives/${driveId}`, { drive_type: "work" }), 404);
await expect("delete it", ann.call("DELETE", `/api/drives/${driveId}`), 200);
await until(async () => (await progress()).driven_m === 0, "deleting took it out of coverage");
await expect("gone", ann.call("GET", `/api/drives/${driveId}`), 404);

console.log("marks");
const segs = await sql(`SELECT segment_id FROM area_segments WHERE area_id = $1 ORDER BY inside_m DESC LIMIT 2`, [area.id]);
const before = await progress();
await expect("mark a street complete", ann.call("PUT", `/api/teams/${ann.personal}/marks/${segs[0].segment_id}`, { kind: "complete", note: "Walked it" }), 200);
await expect("exclude another", ann.call("PUT", `/api/teams/${ann.personal}/marks/${segs[1].segment_id}`, { kind: "excluded" }), 200);
const after = await progress();
check("complete counts as driven, excluded leaves the total", after.driven_m > 0 && after.total_m < before.total_m, { before, after });
const seg = await expect("street detail for the popup", ann.call("GET", `/api/segments/${segs[0].segment_id}?team=${ann.personal}`), 200);
check("shows the mark", seg.segment.mark === "complete" && seg.segment.mark_note === "Walked it" && seg.can_mark);
await expect("unmark", ann.call("DELETE", `/api/teams/${ann.personal}/marks/${segs[0].segment_id}`), 200);
await expect("outsiders can't mark", cat.call("PUT", `/api/teams/${ann.personal}/marks/${segs[0].segment_id}`, { kind: "complete" }), 403);

await finish();
