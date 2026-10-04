// Account deletion smoke test: deleting your own account (password, what goes, what
// teams keep, owner hand-on), the signed-out request by emailed code, and the admin queue.
import crypto from "node:crypto";
import { PW, check, client, expect, finish, latestCode, mailCount, run, signUp, sql } from "./smoke-lib.mjs";

const ann = client("ann"), bob = client("bob"), cat = client("cat"), dan = client("dan"), eve = client("eve");
for (const c of [ann, bob, cat, dan, eve]) await signUp(c);
const teamId = (d) => d.team?.id ?? d.id;

console.log("deleting your own account");
// Ann owns Crew (with Bob as admin, Cat as driver, Cat joined first) and Solo (just her).
const crew = teamId(await expect("ann makes Crew", ann.call("POST", "/api/teams", { name: `Crew ${run}` }), 201));
const solo = teamId(await expect("ann makes Solo", ann.call("POST", "/api/teams", { name: `Solo ${run}` }), 201));
await sql(`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'driver', now() - interval '2 days'),
                                                                        ($1, $3, 'admin', now() - interval '1 day')`,
  [crew, cat.id, bob.id]);
const car = (await ann.call("POST", "/api/vehicles", { team_id: ann.personal, name: "Ann's car" })).data.vehicle;
check("ann has a personal car", !!car?.id);
const place = await expect("ann adds a place", ann.call("POST", "/api/places", { name: "Bakery", lon: -97.73, lat: 30.30 }), 201);
const placeId = place.place?.id ?? place.id;
const phone = client("annphone");
const signed = await expect("ann's phone signs in", phone.call("POST", "/api/auth/device", { email: ann.email, password: PW, deviceName: "Test phone" }), 201);
phone.useToken(signed.token);
const t0 = Math.floor(Date.now() / 1000) - 3600;
const points = Array.from({ length: 60 }, (_, i) => [t0 + i, 30.300 + i * 0.0001, -97.730, 5, 9]);
const driveId = crypto.randomUUID();
await expect("ann uploads a drive", phone.call("POST", "/api/drives", { id: driveId, drive_type: "personal", points }), 201);

await expect("signed out can't delete", client("nobody").call("POST", "/api/me/delete", { password: PW }), 401);
await expect("wrong password", ann.call("POST", "/api/me/delete", { password: "nope nope nope" }), 400);
await expect("ann deletes her account", ann.call("POST", "/api/me/delete", { password: PW }), 200);
await expect("and is signed out", ann.call("GET", "/api/me"), 401);
await expect("her phone is signed out too", phone.call("GET", "/api/me"), 401);
check("her account is gone", (await sql(`SELECT 1 FROM users WHERE id = $1`, [ann.id])).length === 0);
check("her drive is gone", (await sql(`SELECT 1 FROM drives WHERE id = $1`, [driveId])).length === 0);
check("her place is gone", (await sql(`SELECT 1 FROM places WHERE id = $1`, [placeId])).length === 0);
check("her personal team and car are gone",
  (await sql(`SELECT 1 FROM teams WHERE id = $1 UNION ALL SELECT 1 FROM vehicles WHERE id = $2`, [ann.personal, car.id])).length === 0);
const roles = await sql(`SELECT user_id, role FROM team_members WHERE team_id = $1 AND left_at IS NULL`, [crew]);
check("Crew passed to its admin, not its longest member", roles.find((r) => r.user_id === bob.id)?.role === "owner"
  && roles.find((r) => r.user_id === cat.id)?.role === "driver", roles);
check("Solo was closed", (await sql(`SELECT deleted_at FROM teams WHERE id = $1`, [solo]))[0]?.deleted_at != null);
check("a goodbye email went out", !!(await (async () => {
  for (let i = 0; i < 20; i++) { if (await mailCount(ann.email) >= 2) return true; await new Promise((ok) => setTimeout(ok, 150)); }
})()));
check("the audit log says so, without her email",
  (await sql(`SELECT data FROM audit_log WHERE action = 'user.deleted' AND entity_id = $1`, [ann.id]))[0]?.data?.via === "self");

console.log("asking by email");
const anon = client("anon");
await expect("an unknown address gets the same answer", anon.call("POST", "/api/deletion-requests", { email: `ghost-${run}@test.local` }), 200);
const asked = Date.now() - 1000;
await expect("dan asks", anon.call("POST", "/api/deletion-requests", { email: dan.email }), 200);
const mail = await latestCode(dan.email, { after: asked });
check("dan's code arrived", !!mail && /deletion code/.test(mail.subject), mail);
const wrong = mail?.code === "000000" ? "111111" : "000000";
await expect("a wrong code", anon.call("POST", "/api/deletion-requests/confirm", { email: dan.email, code: wrong }), 400);
await expect("a code for an unknown address", anon.call("POST", "/api/deletion-requests/confirm", { email: `ghost-${run}@test.local`, code: "123456" }), 400);
await expect("dan confirms", anon.call("POST", "/api/deletion-requests/confirm", { email: dan.email, code: mail?.code, reason: "Moving away" }), 200);
check("dan still exists until an admin acts", (await sql(`SELECT 1 FROM users WHERE id = $1`, [dan.id])).length === 1);

// Eve asks too, and gets declined.
const asked2 = Date.now() - 1000;
await expect("eve asks", anon.call("POST", "/api/deletion-requests", { email: eve.email }), 200);
const mail2 = await latestCode(eve.email, { after: asked2 });
await expect("eve confirms", anon.call("POST", "/api/deletion-requests/confirm", { email: eve.email, code: mail2?.code }), 200);

console.log("the admin queue");
await expect("a non-admin can't see the queue", bob.call("GET", "/api/admin/deletion-requests"), 403);
await sql(`UPDATE users SET is_site_admin = true WHERE id = $1`, [cat.id]);
const { requests } = await expect("cat (site admin) sees the queue", cat.call("GET", "/api/admin/deletion-requests"), 200);
const danReq = requests.find((r) => r.email === dan.email), eveReq = requests.find((r) => r.email === eve.email);
check("dan's request is waiting, with his reason", danReq?.status === "pending" && danReq.reason === "Moving away", danReq);
await expect("cat carries it out", cat.call("POST", `/api/admin/deletion-requests/${danReq?.id}/complete`, {}), 200);
check("dan is gone", (await sql(`SELECT 1 FROM users WHERE id = $1`, [dan.id])).length === 0);
await expect("can't do it twice", cat.call("POST", `/api/admin/deletion-requests/${danReq?.id}/complete`, {}), 409);
await expect("cat declines eve's", cat.call("POST", `/api/admin/deletion-requests/${eveReq?.id}/decline`, { note: "Please write in first." }), 200);
check("eve is still here", (await sql(`SELECT 1 FROM users WHERE id = $1`, [eve.id])).length === 1);
const after = (await cat.call("GET", "/api/admin/deletion-requests")).data.requests;
check("the queue records both outcomes", after.find((r) => r.id === danReq?.id)?.status === "done"
  && after.find((r) => r.id === eveReq?.id)?.status === "declined");

await expect("an admin can't delete themselves from the list", cat.call("DELETE", `/api/admin/users/${cat.id}`), 409);
await expect("an admin deletes eve from the list", cat.call("DELETE", `/api/admin/users/${eve.id}`), 200);
check("eve is gone", (await sql(`SELECT 1 FROM users WHERE id = $1`, [eve.id])).length === 0);

await finish([
  [`DELETE FROM teams WHERE name LIKE $1`, [`% ${run}`]],
  [`DELETE FROM deletion_requests WHERE email LIKE $1`, [`%-${run}@test.local`]],
]);
