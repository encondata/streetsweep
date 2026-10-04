// Stage 5 API smoke test: Home figures, achievements (people and teams), leaderboards,
// and places (private until shared, photos). Needs streets and Valhalla, like stage 4.
import crypto from "node:crypto";
import { check, client, expect, finish, signUp, sql } from "./smoke-lib.mjs";

const ann = client("ann"), bob = client("bob"), cat = client("cat"), dan = client("dan");
for (const c of [ann, bob, cat, dan]) await signUp(c);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Acme: Ann runs it, Bob and Cat drive for it.
const acme = (await ann.call("POST", "/api/teams", { name: `Acme ${Date.now()}` })).data.team;
for (const c of [bob, cat]) {
  await c.call("POST", `/api/teams/${acme.id}/join-requests`, {});
  const rq = (await ann.call("GET", `/api/teams/${acme.id}`)).data.requests.find((r) => r.user_id === c.id);
  await ann.call("POST", `/api/join-requests/${rq.id}/approve`, { role: "driver" });
}
// The drives below are an hour or two old: the memberships have to be older.
await sql(`UPDATE team_members SET joined_at = joined_at - interval '1 day' WHERE user_id = ANY($1::uuid[])`, [[ann.id, bob.id, cat.id, dan.id]]);

async function routeAlong(name) {
  const [r] = await sql(
    `WITH w AS (
       SELECT ST_LineMerge(ST_Union(s.geom)) AS g FROM street_segments s JOIN street_ways w ON w.way_id = s.way_id
        WHERE w.name = $1 AND s.retired_at IS NULL AND s.geom && ST_MakeEnvelope(-97.735, 30.300, -97.720, 30.316, 4326))
     SELECT ST_AsGeoJSON(ST_Segmentize(d.geom::geography, 10)::geometry) AS line
       FROM w, ST_Dump(w.g) d ORDER BY ST_Length(d.geom) DESC LIMIT 1`, [name]);
  return JSON.parse(r.line).coordinates;
}
// Same start for all three, so they share a day and a week whatever the clock says.
const t0 = Math.floor(Date.now() / 1000) - 3 * 3600;
const drives = {};
for (const [c, street] of [[ann, "Avenue F"], [bob, "Duval Street"], [cat, "Avenue H"]]) {
  const coords = await routeAlong(street);
  const id = crypto.randomUUID();
  await expect(`${c.name} uploads a drive on ${street}`, c.call("POST", "/api/drives", { id, points: coords.map(([lon, lat], i) => [t0 + i, lat, lon, 5, 9]) }), 201);
  drives[c.name] = id;
}
for (const [name, id] of Object.entries(drives)) {
  const c = { ann, bob, cat }[name];
  let status;
  for (let i = 0; i < 240 && status !== "matched" && status !== "failed"; i++) {
    status = (await c.call("GET", `/api/drives/${id}`)).data.drive?.status;
    if (status !== "matched") await sleep(500);
  }
  check(`${name}'s drive matched`, status === "matched", status);
}

console.log("home figures");
const mine = await expect("Ann's figures", ann.call("GET", "/api/stats"), 200);
check("one drive, some new streets", mine.total.drives === 1 && mine.total.streets >= 5 && mine.total.street_m > 300, mine.total);
check("twelve weeks, this one has it", mine.weeks.length === 12 && mine.weeks[11].street_m > 300, mine.weeks.slice(-2));
const team = await expect("Acme's figures", bob.call("GET", `/api/teams/${acme.id}/stats`), 200);
check("three drives, three members, three drivers this month", team.total.drives === 3 && team.members === 3 && team.month_drivers === 3, team);
check("team streets add up", team.total.streets >= mine.total.streets * 2, team.total);
const personalStats = await expect("a personal team's figures are its person's", ann.call("GET", `/api/teams/${ann.personal}/stats`), 200);
check("same as hers", personalStats.total.streets === mine.total.streets);
await expect("an outsider can't see Acme's", dan.call("GET", `/api/teams/${acme.id}/stats`), 404);

console.log("achievements");
const ach = await expect("Ann's achievements", ann.call("GET", "/api/achievements"), 200);
check("v1's set: 3 ladders, 21 badges", ach.ladders.length === 3 && ach.badges.length === 21, { l: ach.ladders.length, b: ach.badges.length });
const streets = ach.ladders.find((l) => l.code === "streets");
check("First Sweep earned", streets.level >= 1 && streets.steps[0].earned && streets.steps[0].earned_at, streets);
check("progress toward the next level", streets.next === 50 && streets.progress > 0 && streets.progress < 100, streets);
check("unearned badges say how far along", ach.badges.find((b) => b.code === "rain_or_shine").progress?.need === 30);
check("counted", ach.earned_count >= 1 && ach.total > 40, { earned: ach.earned_count, total: ach.total });
const teamAch = await expect("Acme's achievements", cat.call("GET", `/api/teams/${acme.id}/achievements`), 200);
const got = (code) => teamAch.badges.find((b) => b.code === code)?.earned;
check("team set: 3 ladders, 8 badges", teamAch.ladders.length === 3 && teamAch.badges.length === 8);
check("Relay: three drivers on one day", got("team_relay"));
check("Full Crew: three drivers with new streets in a week", got("team_full_crew"));
check("All Hands: every driver has added streets", got("team_all_hands"));
check("not Big Week yet", !got("team_big_week"));
await expect("no team achievements for a personal team", ann.call("GET", `/api/teams/${ann.personal}/achievements`), 400);
await expect("an outsider can't see them", dan.call("GET", `/api/teams/${acme.id}/achievements`), 404);

console.log("leaderboards");
const nb = await expect("new streets this week", bob.call("GET", `/api/teams/${acme.id}/leaderboard?board=new&period=week`), 200);
check("all three, best first", nb.rows.length === 3 && nb.rows[0].value >= nb.rows[1].value && nb.rows[1].value >= nb.rows[2].value && nb.rows[0].rank === 1, nb.rows);
check("each has some", nb.rows.every((r) => r.value > 0 && r.extra > 0));
const db_ = await expect("drives this month", bob.call("GET", `/api/teams/${acme.id}/leaderboard?board=drives&period=month`), 200);
check("one each, so all share first", db_.rows.every((r) => r.value === 1 && r.rank === 1), db_.rows);
const mb = await expect("miles, all time", bob.call("GET", `/api/teams/${acme.id}/leaderboard?board=miles&period=all`), 200);
check("miles are metres driven", mb.rows.every((r) => r.value > 300));
await expect("an unknown board", bob.call("GET", `/api/teams/${acme.id}/leaderboard?board=fastest`), 400);
await expect("nothing to rank in a personal team", ann.call("GET", `/api/teams/${ann.personal}/leaderboard`), 400);
await expect("outsiders can't see it", dan.call("GET", `/api/teams/${acme.id}/leaderboard`), 404);

console.log("places");
const made = await expect("Ann marks a spot", ann.call("POST", "/api/places", { name: "Pothole on F", note: "Deep one", lon: -97.7275, lat: 30.308 }), 201);
const place = made.place;
check("hers, shared with nobody", place.mine && place.shared_with.length === 0 && Math.abs(place.lat - 30.308) < 1e-6);
await expect("private: Bob can't see it", bob.call("GET", `/api/places/${place.id}`), 404);
check("…nor in his list", !(await bob.call("GET", "/api/places")).data.places.some((p) => p.id === place.id));
await expect("can't share with a team she isn't in", ann.call("PATCH", `/api/places/${place.id}`, { team_ids: [bob.personal] }), 400);
const shared = await expect("share it with Acme", ann.call("PATCH", `/api/places/${place.id}`, { team_ids: [acme.id] }), 200);
check("shared with Acme", shared.place.shared_with.length === 1 && shared.place.shared_with[0].id === acme.id);
const seen = await expect("now Bob sees it", bob.call("GET", `/api/places/${place.id}`), 200);
check("not his", seen.place.mine === false && seen.place.user_name === "Ann");
check("in Acme's list", (await cat.call("GET", `/api/places?team=${acme.id}`)).data.places.some((p) => p.id === place.id));
await expect("Bob can't change it", bob.call("PATCH", `/api/places/${place.id}`, { name: "Mine now" }), 403);
await expect("Dan (not in Acme) still can't see it", dan.call("GET", `/api/places/${place.id}`), 404);
await expect("not off the map", ann.call("POST", "/api/places", { name: "Nowhere", lon: 500, lat: 0 }), 400);

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const withPhoto = await expect("add a photo", ann.call("POST", `/api/places/${place.id}/photos?w=1&h=1`, new Uint8Array(png), { "content-type": "image/png" }), 201);
const photo = withPhoto.place.photos[0];
check("one photo, size kept", withPhoto.place.photos.length === 1 && photo.width === 1);
const pic = await bob.call("GET", `/api/places/${place.id}/photos/${photo.id}`);
check("Bob can see the photo", pic.status === 200);
await expect("Bob can't add one", bob.call("POST", `/api/places/${place.id}/photos`, new Uint8Array(png), { "content-type": "image/png" }), 403);
await expect("unshare", ann.call("PATCH", `/api/places/${place.id}`, { team_ids: [] }), 200);
await expect("Bob loses it", bob.call("GET", `/api/places/${place.id}/photos/${photo.id}`), 404);
await expect("remove the photo", ann.call("DELETE", `/api/places/${place.id}/photos/${photo.id}`), 200);
await expect("delete the place", ann.call("DELETE", `/api/places/${place.id}`), 200);
await expect("gone", ann.call("GET", `/api/places/${place.id}`), 404);

await finish();
