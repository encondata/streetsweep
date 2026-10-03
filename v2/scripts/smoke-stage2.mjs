// Stage 2 API smoke test: vehicles, permanent drivers, check-out and return, team
// changes ending a hold, loggers (keys, signed requests, installs) and phone tokens.
import crypto from "node:crypto";
import { BASE, PW, check, client, expect, finish, signUp } from "./smoke-lib.mjs";

const alice = client("alice"), bob = client("bob"), carol = client("carol"), dave = client("dave");
for (const c of [alice, bob, carol, dave]) await signUp(c);

console.log("setting up a team");
const acme = (await alice.call("POST", "/api/teams", { name: `Acme ${Date.now()}` })).data.team;
for (const c of [bob, carol]) await c.call("POST", `/api/teams/${acme.id}/join-requests`, {});
let reqs = (await alice.call("GET", `/api/teams/${acme.id}`)).data.requests;
await expect("approve bob as driver", alice.call("POST", `/api/join-requests/${reqs.find((r) => r.display_name === "Bob").id}/approve`, { role: "driver" }), 200);
await expect("approve carol as viewer", alice.call("POST", `/api/join-requests/${reqs.find((r) => r.display_name === "Carol").id}/approve`, { role: "viewer" }), 200);

console.log("vehicles");
const van = (await expect("alice adds a van to Acme", alice.call("POST", "/api/vehicles",
  { team_id: acme.id, name: "Van 1", kind: "van", make: "Ford", model: "Transit", year: 2022, plate: "abc 123" }), 201)).vehicle;
check("plate stored upper-case", van.plate === "ABC 123");
check("van is open to drivers", van.checkout_policy === "open");
await expect("driver can't add to Acme", bob.call("POST", "/api/vehicles", { team_id: acme.id, name: "Nope" }), 403);
const bobCar = (await expect("bob adds his own car", bob.call("POST", "/api/vehicles", { team_id: bob.personal, name: "Bob's Civic" }), 201)).vehicle;
check("his own car starts with him as its driver", bobCar.assigned.length === 1 && bobCar.assigned[0].user_id === bob.id);
check("a team van starts with nobody", van.assigned.length === 0);
await expect("outsider can't see the van", dave.call("GET", `/api/vehicles/${van.id}`), 404);
await expect("viewer can see the van", carol.call("GET", `/api/vehicles/${van.id}`), 200);
const bobList = await expect("bob's vehicles", bob.call("GET", "/api/vehicles"), 200);
check("bob sees the van and his car", [van.id, bobCar.id].every((id) => bobList.vehicles.some((v) => v.id === id)));
await expect("bad year", alice.call("PATCH", `/api/vehicles/${van.id}`, { year: 1800 }), 400);
let d = await expect("clear the plate", alice.call("PATCH", `/api/vehicles/${van.id}`, { plate: null, color: "White" }), 200);
check("plate cleared, colour set", d.vehicle.plate === null && d.vehicle.color === "White");

console.log("check-out and return");
d = await expect("bob checks out the van", bob.call("POST", `/api/vehicles/${van.id}/checkout`, { note: "North route" }), 200);
check("checked out to bob", d.vehicle.checkout?.user_id === bob.id && d.vehicle.checkout.note === "North route");
await expect("viewer can't check out", carol.call("POST", `/api/vehicles/${van.id}/checkout`, {}), 403);
await expect("alice can't take it while bob has it", alice.call("POST", `/api/vehicles/${van.id}/checkout`, {}), 409);
await expect("viewer can't return it", carol.call("POST", `/api/vehicles/${van.id}/return`), 403);
d = await expect("bob returns it", bob.call("POST", `/api/vehicles/${van.id}/return`), 200);
check("available again", d.vehicle.checkout === null);
await expect("returning twice", bob.call("POST", `/api/vehicles/${van.id}/return`), 409);
await expect("can't hand it to a viewer", alice.call("POST", `/api/vehicles/${van.id}/checkout`, { user_id: carol.id }), 400);
await expect("can't hand it to an outsider", alice.call("POST", `/api/vehicles/${van.id}/checkout`, { user_id: dave.id }), 400);
await expect("driver can't hand it to someone else", bob.call("POST", `/api/vehicles/${van.id}/checkout`, { user_id: alice.id }), 403);
d = await expect("admin hands it to bob", alice.call("POST", `/api/vehicles/${van.id}/checkout`, { user_id: bob.id }), 200);
check("bob has it, alice handed it over", d.history[0].user_id === bob.id && d.history[0].assigned_by_name === "Alice");
await expect("admin takes it back", alice.call("POST", `/api/vehicles/${van.id}/return`), 200);

const race = await Promise.all([
  bob.call("POST", `/api/vehicles/${van.id}/checkout`, {}),
  alice.call("POST", `/api/vehicles/${van.id}/checkout`, {}),
]);
check("two at once: exactly one wins", race.map((r) => r.status).sort().join() === "200,409", race.map((r) => r.status));
const winner = race[0].status === 200 ? bob : alice;
await winner.call("POST", `/api/vehicles/${van.id}/return`);

await expect("admins-only hand-out", alice.call("PATCH", `/api/vehicles/${van.id}`, { checkout_policy: "admin_only" }), 200);
await expect("driver can't take it himself now", bob.call("POST", `/api/vehicles/${van.id}/checkout`, {}), 403);
await expect("admin can still hand it out", alice.call("POST", `/api/vehicles/${van.id}/checkout`, { user_id: bob.id }), 200);
await expect("bob can return what he was given", bob.call("POST", `/api/vehicles/${van.id}/return`), 200);

console.log("permanent drivers");
d = await expect("alice makes bob a permanent driver", alice.call("POST", `/api/vehicles/${van.id}/assignments`, { user_id: bob.id }), 201);
const bobPerm = d.vehicle.assigned.find((a) => a.user_id === bob.id);
check("bob listed as assigned", !!bobPerm);
await expect("twice", alice.call("POST", `/api/vehicles/${van.id}/assignments`, { user_id: bob.id }), 409);
await expect("not a viewer", alice.call("POST", `/api/vehicles/${van.id}/assignments`, { user_id: carol.id }), 400);
await expect("alice adds herself too", alice.call("POST", `/api/vehicles/${van.id}/assignments`, { user_id: alice.id }), 201);
await expect("driver can't assign", bob.call("POST", `/api/vehicles/${van.id}/assignments`, { user_id: bob.id }), 403);
d = await expect("bob steps back himself", bob.call("DELETE", `/api/vehicles/${van.id}/assignments/${bobPerm.id}`), 200);
check("only alice left", d.vehicle.assigned.length === 1 && d.vehicle.assigned[0].user_id === alice.id);
check("history keeps bob's spell, ended", d.history.some((h) => h.id === bobPerm.id && h.ended_at && h.ended_by_name === "Bob"));

console.log("team changes end holds");
await expect("re-assign bob", alice.call("POST", `/api/vehicles/${van.id}/assignments`, { user_id: bob.id }), 201);
await alice.call("PATCH", `/api/vehicles/${van.id}`, { checkout_policy: "open" });
await expect("bob checks out", bob.call("POST", `/api/vehicles/${van.id}/checkout`, {}), 200);
await expect("bob made a viewer", alice.call("PATCH", `/api/teams/${acme.id}/members/${bob.id}`, { role: "viewer" }), 200);
d = (await alice.call("GET", `/api/vehicles/${van.id}`)).data;
check("viewer bob let go: no checkout, not assigned", d.vehicle.checkout === null && !d.vehicle.assigned.some((a) => a.user_id === bob.id));
await alice.call("PATCH", `/api/teams/${acme.id}/members/${bob.id}`, { role: "driver" });
await bob.call("POST", `/api/vehicles/${van.id}/checkout`, {});
await expect("bob leaves Acme", bob.call("DELETE", `/api/teams/${acme.id}/members/${bob.id}`), 200);
d = (await alice.call("GET", `/api/vehicles/${van.id}`)).data;
check("leaving handed the van back", d.vehicle.checkout === null);
await expect("bob can't see the van now", bob.call("GET", `/api/vehicles/${van.id}`), 404);
await expect("can't delete a team that runs vehicles", alice.call("DELETE", `/api/teams/${acme.id}`), 409);

console.log("loggers");
const created = await expect("alice registers a logger", alice.call("POST", "/api/loggers", { name: "Board A", default_drive_type_key: "delivery" }), 201);
const logger = created.logger;
let secret = created.setup.secret;
check("secret is 32 bytes of hex", /^[0-9a-f]{64}$/.test(secret));
check("setup names the config url", created.setup.config_url.endsWith("/api/logger/config"));
check("default type stored", logger.default_drive_type_key === "delivery");
await expect("unknown drive type", alice.call("POST", "/api/loggers", { name: "X", default_drive_type_key: "nope" }), 400);

function signed(path, key, id = logger.id, body = "", method = "GET", extra = {}) {
  const canonical = `${method}\n${path}\n${crypto.createHash("sha256").update(body).digest("hex")}`;
  const sig = crypto.createHmac("sha256", Buffer.from(key, "hex")).update(canonical).digest("hex");
  return fetch(BASE + path, { method, headers: { "x-logger-id": id, "x-logger-signature": sig, ...extra } })
    .then(async (r) => ({ status: r.status, data: await r.json() }));
}
let cfg = await expect("logger fetches its config", signed("/api/logger/config", secret, logger.id, "", "GET",
  { "x-logger-firmware": "0.1.0", "x-logger-battery": "3980", "x-logger-hardware": "24:6F:28:AA:BB:CC" }), 200);
check("config: not in a vehicle, delivery type", cfg.vehicle === null && cfg.default_drive_type === "delivery" && cfg.server_epoch > 0);
await expect("wrong key", signed("/api/logger/config", crypto.randomBytes(32).toString("hex")), 401);
await expect("unknown logger", signed("/api/logger/config", secret, crypto.randomUUID()), 401);
await expect("no headers", alice.call("GET", "/api/logger/config"), 401);
await expect("signature for a different path", fetch(BASE + "/api/logger/config?x=1", { headers: {
  "x-logger-id": logger.id,
  "x-logger-signature": crypto.createHmac("sha256", Buffer.from(secret, "hex")).update(`GET\n/api/logger/config\n${crypto.createHash("sha256").update("").digest("hex")}`).digest("hex"),
} }).then((r) => ({ status: r.status })), 401);
let ld = await expect("alice reads it back", alice.call("GET", `/api/loggers/${logger.id}`), 200);
check("status headers recorded", ld.logger.firmware_version === "0.1.0" && ld.logger.last_battery_mv === 3980 && ld.logger.hardware_id === "24:6F:28:AA:BB:CC" && ld.logger.last_seen_at);
await expect("someone else's logger is hidden", bob.call("GET", `/api/loggers/${logger.id}`), 404);

const aliceCar = (await alice.call("POST", "/api/vehicles", { team_id: alice.personal, name: "Alice's Outback", kind: "suv" })).data.vehicle;
ld = await expect("install in her car", alice.call("POST", `/api/loggers/${logger.id}/install`, { vehicle_id: aliceCar.id }), 200);
check("installed in the Outback", ld.logger.installed?.vehicle_id === aliceCar.id);
cfg = (await signed("/api/logger/config", secret)).data;
check("config now names the vehicle", cfg.vehicle?.id === aliceCar.id);
ld = await expect("move it to the van", alice.call("POST", `/api/loggers/${logger.id}/install`, { vehicle_id: van.id }), 200);
check("history has both, first one ended", ld.history.length === 2 && ld.history.some((h) => h.vehicle_id === aliceCar.id && h.ended_at));
const vanDetail = (await alice.call("GET", `/api/vehicles/${van.id}`)).data;
check("van page lists the logger", vanDetail.loggers.some((l) => l.id === logger.id) && vanDetail.vehicle.logger_count === 1);
const daveLogger = (await dave.call("POST", "/api/loggers", { name: "Dave's" })).data.logger;
await expect("can't install in a stranger's vehicle", dave.call("POST", `/api/loggers/${daveLogger.id}/install`, { vehicle_id: aliceCar.id }), 403);

const rotated = await expect("new key", alice.call("POST", `/api/loggers/${logger.id}/rotate-key`, {}), 200);
await expect("old key refused", signed("/api/logger/config", secret), 401);
secret = rotated.setup.secret;
await expect("new key works", signed("/api/logger/config", secret), 200);

d = await expect("archive the Outback", alice.call("PATCH", `/api/vehicles/${aliceCar.id}`, { archived: true }), 200);
check("archived", !!d.vehicle.archived_at);
await expect("can't check out an archived car", alice.call("POST", `/api/vehicles/${aliceCar.id}/checkout`, {}), 400);
await expect("can't install in it", alice.call("POST", `/api/loggers/${logger.id}/install`, { vehicle_id: aliceCar.id }), 400);
const archivedList = (await alice.call("GET", "/api/vehicles?archived=1")).data.vehicles;
check("archived list has it", archivedList.some((v) => v.id === aliceCar.id));
await expect("archive the van", alice.call("PATCH", `/api/vehicles/${van.id}`, { archived: true }), 200);
ld = (await alice.call("GET", `/api/loggers/${logger.id}`)).data;
check("archiving the van took the logger out", ld.logger.installed === null);

ld = await expect("retire the logger", alice.call("DELETE", `/api/loggers/${logger.id}`), 200);
check("retired", !!ld.logger.revoked_at);
await expect("retired logger refused", signed("/api/logger/config", secret), 401);
await expect("can't install a retired logger", alice.call("POST", `/api/loggers/${logger.id}/install`, { vehicle_id: bobCar.id }), 400);

console.log("moving a vehicle between teams");
const fam = (await bob.call("POST", "/api/teams", { name: `Household ${Date.now()}` })).data.team;
d = await expect("bob moves his car to the household", bob.call("POST", `/api/vehicles/${bobCar.id}/move`, { team_id: fam.id }), 200);
check("now under the household", d.vehicle.team_id === fam.id);
await expect("can't move into a team you don't run", bob.call("POST", `/api/vehicles/${bobCar.id}/move`, { team_id: acme.id }), 403);

console.log("phones");
const phone = client("bob");
phone.email = bob.email;
const signedIn = await expect("phone signs in", phone.call("POST", "/api/auth/device", { email: bob.email, password: PW, deviceName: "Pixel 9", appVersion: "2.0.0" }), 201);
check("token issued", /^ssd_/.test(signedIn.token));
phone.useToken(signedIn.token);
const pm = await expect("phone reads /me with its token", phone.call("GET", "/api/me"), 200);
check("phone is bob", pm.user.id === bob.id);
await expect("phone lists bob's vehicles", phone.call("GET", "/api/vehicles"), 200);
const devs = await expect("web lists phones", bob.call("GET", "/api/devices"), 200);
check("Pixel 9 listed", devs.devices.some((x) => x.name === "Pixel 9" && x.app_version === "2.0.0"));
await expect("wrong password", phone.call("POST", "/api/auth/device", { email: bob.email, password: "nope nope", deviceName: "X" }), 401);
await expect("alice can't revoke bob's phone", alice.call("DELETE", `/api/devices/${signedIn.device_id}`), 404);
await expect("bob revokes it", bob.call("DELETE", `/api/devices/${signedIn.device_id}`), 200);
await expect("revoked token refused", phone.call("GET", "/api/me"), 401);

await finish();
