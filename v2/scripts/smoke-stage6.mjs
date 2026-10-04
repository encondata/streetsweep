// Stage 6 API smoke test: what the phone app uses. Sign-in with a device token, the
// sync feed (full, then incremental), area packages and box downloads, gzip drive
// upload, drives from before the account existed counting for the personal team only,
// marks with tombstones, places with phone-made ids, and team recounts.
import crypto from "node:crypto";
import zlib from "node:zlib";
import { PW, check, client, expect, finish, signUp, sql } from "./smoke-lib.mjs";

const ann = client("ann"), bob = client("bob");
for (const c of [ann, bob]) await signUp(c);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

const phone = client("annphone");
const signed = await expect("Ann's phone signs in", phone.call("POST", "/api/auth/device", { email: ann.email, password: PW, deviceName: "Pixel" }), 201);
phone.useToken(signed.token);

console.log("first sync");
const car = (await ann.call("POST", "/api/vehicles", { team_id: ann.personal, name: "Ann's car" })).data.vehicle;
const area = (await ann.call("POST", `/api/teams/${ann.personal}/areas`, {
  name: "Hyde Park", geometry: { type: "Polygon", coordinates: [[[-97.735, 30.300], [-97.720, 30.300], [-97.720, 30.316], [-97.735, 30.316], [-97.735, 30.300]]] },
})).data;
// The cursor sits a few seconds back; sync once that's past the sign-up, as a phone would.
await sleep(5500);
const full = await expect("full sync", phone.call("GET", "/api/sync"), 200);
check("cursor and full flag", full.full === true && !!full.cursor);
check("her personal team", full.teams.length === 1 && full.teams[0].id === ann.personal && full.teams[0].role === "owner");
check("drive types with per-team toggles", full.drive_types.some((t) => t.key === "personal" && typeof t.team_counts === "object"));
check("her car, held permanently", full.vehicles.some((v) => v.id === car.id && v.permanent === true));
const fa = full.areas.find((a) => a.id === area.id);
check("Hyde Park with its outline", fa && fa.geometry?.type && fa.team_ids.includes(ann.personal), fa);
check("no coverage yet", full.coverage[ann.personal]?.reset === true && full.coverage[ann.personal].segments.length === 0);

console.log("streets");
for (let i = 0; i < 120; i++) {
  if ((await ann.call("GET", `/api/areas/${area.id}`)).data.area?.build_status === "built") break;
  await sleep(500);
}
const pkgRes = await fetch(`${process.env.BASE ?? "http://localhost"}/api/areas/${area.id}/package`, { headers: { authorization: `Bearer ${signed.token}` } });
check("package → 200, gzipped", pkgRes.status === 200 && pkgRes.headers.get("content-encoding") === "gzip");
const pkg = await pkgRes.json(); // fetch unpacks it
const built = (await ann.call("GET", `/api/areas/${area.id}`)).data.area;
check("every segment in the area", pkg.segments.length === built.segment_count && pkg.segments.length > 100, { got: pkg.segments.length, want: built.segment_count });
const s0 = pkg.segments[0];
check("compact rows: id, way, name, type, length, inside, line", s0.length === 7 && Number.isInteger(s0[0]) && typeof s0[6] === "string" && pkg.highways[s0[3]]);
check("names listed once", pkg.names.length < pkg.segments.length && pkg.names.includes("Avenue F"));
const again = await fetch(`${process.env.BASE ?? "http://localhost"}/api/areas/${area.id}/package`, { headers: { authorization: `Bearer ${signed.token}`, "if-none-match": pkgRes.headers.get("etag") } });
check("unchanged → 304", again.status === 304);
await expect("someone else's area isn't theirs to download", bob.call("GET", `/api/areas/${area.id}/package`), 404);
const box = await expect("streets in a box", phone.call("GET", "/api/segments?bbox=-97.73,30.30,-97.72,30.31"), 200);
check("box has segments", box.segments.length > 20 && box.segments[0].length === 6);
await expect("too big a box", phone.call("GET", "/api/segments?bbox=-98,30,-97,31"), 400);

console.log("a drive from before the account existed");
const [route] = await sql(
  `WITH w AS (SELECT ST_LineMerge(ST_Union(s.geom)) AS g FROM street_segments s JOIN street_ways w ON w.way_id = s.way_id
               WHERE w.name = 'Avenue F' AND s.retired_at IS NULL AND s.geom && ST_MakeEnvelope(-97.735, 30.300, -97.720, 30.316, 4326))
   SELECT ST_AsGeoJSON(ST_Segmentize(d.geom::geography, 10)::geometry) AS line FROM w, ST_Dump(w.g) d ORDER BY ST_Length(d.geom) DESC LIMIT 1`);
const coords = JSON.parse(route.line).coordinates;
const t0 = Math.floor(Date.now() / 1000) - 12 * 86400; // twelve days ago
const driveId = crypto.randomUUID();
const body = zlib.gzipSync(JSON.stringify({ id: driveId, drive_type: "personal", vehicle_id: car.id, points: coords.map(([lon, lat], i) => [t0 + i, lat, lon, 5, 9]) }));
const up = await expect("gzip upload", phone.call("POST", "/api/drives", new Uint8Array(body), { "content-type": "application/json", "content-encoding": "gzip" }), 201);
check("in her car, as picked", up.drive.vehicle_id === car.id && up.drive.attribution === "explicit");
let status;
for (let i = 0; i < 240 && status !== "matched"; i++) {
  status = (await phone.call("GET", `/api/drives/${driveId}`)).data.drive?.status;
  if (status !== "matched") await sleep(500);
}
check("matched", status === "matched");
const d = (await phone.call("GET", `/api/drives/${driveId}`)).data;
check("counts for her personal team though it predates her account", d.counts_for.some((t) => t.id === ann.personal), d.counts_for);

console.log("incremental sync");
await sleep(5500); // past the cursor's skew
const inc = await expect("sync since the cursor", phone.call("GET", `/api/sync?since=${encodeURIComponent(full.cursor)}`), 200);
check("not full", inc.full === false);
check("the drive, matched", inc.drives.some((x) => x.id === driveId && x.status === "matched" && x.segment_count > 0));
check("coverage arrives as new segments, not a reset", inc.coverage[ann.personal].reset === false && inc.coverage[ann.personal].segments.length >= 5, inc.coverage[ann.personal]);
const ia = inc.areas.find((a) => a.id === area.id);
check("areas still listed, outline not resent, version to compare", ia?.geometry === null && ia.version === fa.version && ia.build_status === "built");

const seg = String(pkg.segments.find((x) => !inc.coverage[ann.personal].segments.includes(String(x[0])))[0]);
await expect("phone marks a street done", phone.call("PUT", `/api/teams/${ann.personal}/marks/${seg}`, { kind: "complete", note: "Walked" }), 200);
const placeId = crypto.randomUUID();
await expect("phone adds a place with its own id", phone.call("POST", "/api/places", { id: placeId, name: "Gate", lon: -97.7262, lat: 30.3061 }), 201);
const retry = await expect("a retry is the same place", phone.call("POST", "/api/places", { id: placeId, name: "Gate", lon: -97.7262, lat: 30.3061 }), 200);
check("flagged duplicate", retry.duplicate === true);
await expect("Bob can't take that id", bob.call("POST", "/api/places", { id: placeId, name: "Mine", lon: 0, lat: 0 }), 409);
const inc2 = await expect("sync again", phone.call("GET", `/api/sync?since=${encodeURIComponent(inc.cursor)}`), 200);
check("the mark", inc2.marks.some((m) => String(m.segment_id) === seg && m.kind === "complete" && m.note === "Walked"));
check("the place, and it's visible", inc2.places.some((p) => p.id === placeId && p.mine) && inc2.place_ids.includes(placeId));

await sleep(5500);
await expect("unmark", phone.call("DELETE", `/api/teams/${ann.personal}/marks/${seg}`), 200);
await expect("delete the place", phone.call("DELETE", `/api/places/${placeId}`), 200);
const inc3 = await expect("sync after removals", phone.call("GET", `/api/sync?since=${encodeURIComponent(inc2.cursor)}`), 200);
check("unmark comes as a tombstone", inc3.unmarked.some((m) => String(m.segment_id) === seg));
check("deleted place is gone from the visible list", !inc3.place_ids.includes(placeId));

console.log("recount and teams");
await expect("personal drives off", ann.call("PUT", `/api/teams/${ann.personal}/drive-types/personal`, { counts: false }), 200);
await expect("…and on", ann.call("PUT", `/api/teams/${ann.personal}/drive-types/personal`, { counts: true }), 200);
await sleep(3000);
const inc4 = await expect("sync after a recount", phone.call("GET", `/api/sync?since=${encodeURIComponent(inc3.cursor)}`), 200);
check("coverage comes whole, flagged reset", inc4.coverage[ann.personal].reset === true && inc4.coverage[ann.personal].segments.length >= 5, inc4.coverage[ann.personal]);

// A shared team still only counts drives from while you were in it.
const acme = (await bob.call("POST", "/api/teams", { name: `Acme ${Date.now()}` })).data.team;
await ann.call("POST", `/api/teams/${acme.id}/join-requests`, {});
const rq = (await bob.call("GET", `/api/teams/${acme.id}`)).data.requests[0];
await bob.call("POST", `/api/join-requests/${rq.id}/approve`, { role: "driver" });
const d2 = (await phone.call("GET", `/api/drives/${driveId}`)).data;
check("the old drive doesn't count for a team she joined later", !d2.counts_for.some((t) => t.id === acme.id), d2.counts_for);
const inc5 = await expect("sync sees the new team", phone.call("GET", `/api/sync?since=${encodeURIComponent(inc4.cursor)}`), 200);
check("two teams now", inc5.teams.length === 2 && inc5.coverage[acme.id]?.reset === true);

await expect("bad cursor", phone.call("GET", "/api/sync?since=yesterday-ish"), 400);
await finish();
