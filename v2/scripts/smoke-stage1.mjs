// Stage 1 API smoke test: accounts, teams, join requests, roles, drive types, site admin.
// Runs inside the api container (see scripts/smoke.sh), with fresh addresses each time.
import { execFileSync } from "node:child_process";
import { PW, check, client, expect, finish, latestCode, mailCount, run, signUp, sql } from "./smoke-lib.mjs";

const alice = client("alice"), bob = client("bob"), carol = client("carol"), anon = client("anon");

console.log("accounts");
for (const c of [alice, bob, carol]) {
  const me = await signUp(c);
  check(`${c.name} has a personal team`, me.teams?.length === 1 && me.teams[0].kind === "personal" && me.teams[0].role === "owner");
}
await expect("duplicate email", anon.call("POST", "/api/auth/signup", { email: alice.email.toUpperCase(), displayName: "X", password: PW }), 409);
await expect("short password", anon.call("POST", "/api/auth/signup", { email: `x-${run}@test.local`, displayName: "X", password: "short" }), 400);
await expect("bad email", anon.call("POST", "/api/auth/signup", { email: "nope", displayName: "X", password: PW }), 400);
await expect("signed out /me", anon.call("GET", "/api/me"), 401);
await expect("wrong password", anon.call("POST", "/api/auth/login", { email: alice.email, password: "wrong wrong" }), 401);
await expect("unknown email", anon.call("POST", "/api/auth/login", { email: `ghost-${run}@test.local`, password: PW }), 401);
await expect("sign out", carol.call("POST", "/api/auth/logout", {}), 200);
await expect("after sign out", carol.call("GET", "/api/me"), 401);
await expect("sign in (email in caps)", carol.call("POST", "/api/auth/login", { email: carol.email.toUpperCase(), password: PW }), 200);
await expect("form post refused", alice.call("POST", "/api/teams", "name=x", { "content-type": "application/x-www-form-urlencoded" }), 415);
await expect("bad id is 404", alice.call("GET", "/api/teams/not-a-uuid"), 404);

console.log("teams and join requests");
const acme = (await expect("alice creates Acme", alice.call("POST", "/api/teams", { name: `Acme ${run}` }), 201)).team;
check("join code present for owner", /^[A-Z2-9]{8}$/.test(acme.join_code ?? ""));
const found = await expect("bob searches", bob.call("GET", `/api/teams?q=${encodeURIComponent("acme " + run)}`), 200);
check("search finds Acme", found.teams.some((t) => t.id === acme.id));
const outside = await expect("bob previews Acme", bob.call("GET", `/api/teams/${acme.id}`), 200);
check("preview has no members or code", !outside.members && !outside.team.join_code);
await expect("bob asks to join", bob.call("POST", `/api/teams/${acme.id}/join-requests`, { message: "Hi, Bob here" }), 201);
await expect("bob asks again", bob.call("POST", `/api/teams/${acme.id}/join-requests`, {}), 409);
await expect("carol asks to join", carol.call("POST", `/api/teams/${acme.id}/join-requests`, {}), 201);
let d = await expect("alice sees requests", alice.call("GET", `/api/teams/${acme.id}`), 200);
check("two pending requests", d.requests.length === 2, d.requests);
const bobReq = d.requests.find((r) => r.display_name === "Bob");
const carolReq = d.requests.find((r) => r.display_name === "Carol");
check("request carries the note", bobReq?.message === "Hi, Bob here");
await expect("bob can't approve carol", bob.call("POST", `/api/join-requests/${carolReq.id}/approve`, {}), 403);
d = await expect("alice approves bob", alice.call("POST", `/api/join-requests/${bobReq.id}/approve`, { role: "driver" }), 200);
check("bob is a driver", d.members.some((m) => m.display_name === "Bob" && m.role === "driver"));
await expect("alice declines carol", alice.call("POST", `/api/join-requests/${carolReq.id}/decline`, {}), 200);
await expect("approving a decided request", alice.call("POST", `/api/join-requests/${carolReq.id}/approve`, {}), 404);
const carolReqs = await expect("carol's requests", carol.call("GET", "/api/me/join-requests"), 200);
check("carol sees declined", carolReqs.requests.some((r) => r.team_id === acme.id && r.status === "declined"));
const bobMe = await expect("bob /me", bob.call("GET", "/api/me"), 200);
check("bob's teams include Acme", bobMe.teams.some((t) => t.id === acme.id && t.role === "driver"));
const bobView = await expect("bob opens Acme", bob.call("GET", `/api/teams/${acme.id}`), 200);
check("driver sees no emails, code or requests", bobView.members.every((m) => !m.email) && !bobView.team.join_code && bobView.requests.length === 0);

console.log("roles and owners");
const aliceId = d.members.find((m) => m.display_name === "Alice").user_id;
const bobId = d.members.find((m) => m.display_name === "Bob").user_id;
await expect("driver can't change roles", bob.call("PATCH", `/api/teams/${acme.id}/members/${bobId}`, { role: "admin" }), 403);
await expect("alice makes bob admin", alice.call("PATCH", `/api/teams/${acme.id}/members/${bobId}`, { role: "admin" }), 200);
await expect("admin can't make himself owner", bob.call("PATCH", `/api/teams/${acme.id}/members/${bobId}`, { role: "owner" }), 403);
await expect("admin can't remove the owner", bob.call("DELETE", `/api/teams/${acme.id}/members/${aliceId}`), 403);
await expect("only owner can't leave", alice.call("DELETE", `/api/teams/${acme.id}/members/${aliceId}`), 409);
await expect("only owner can't step down", alice.call("PATCH", `/api/teams/${acme.id}/members/${aliceId}`, { role: "admin" }), 409);
await expect("alice makes bob owner", alice.call("PATCH", `/api/teams/${acme.id}/members/${bobId}`, { role: "owner" }), 200);
await expect("now alice can step down", alice.call("PATCH", `/api/teams/${acme.id}/members/${aliceId}`, { role: "admin" }), 200);
await expect("admin alice can't delete", alice.call("DELETE", `/api/teams/${acme.id}`), 403);

console.log("unlisted teams and join codes");
const hidden = (await expect("alice creates unlisted", alice.call("POST", "/api/teams", { name: `Hidden ${run}`, listed: false }), 201)).team;
const s2 = await expect("carol searches", carol.call("GET", `/api/teams?q=${encodeURIComponent("hidden " + run)}`), 200);
check("unlisted not in search", !s2.teams.some((t) => t.id === hidden.id));
await expect("carol can't open it by id", carol.call("GET", `/api/teams/${hidden.id}`), 404);
await expect("carol can't request without code", carol.call("POST", `/api/teams/${hidden.id}/join-requests`, {}), 404);
const pv = await expect("join link preview", carol.call("GET", `/api/join/${hidden.join_code.toLowerCase()}`), 200);
check("preview is the hidden team", pv.team.id === hidden.id);
await expect("carol requests with code", carol.call("POST", `/api/teams/${hidden.id}/join-requests`, { code: hidden.join_code }), 201);
const reset = await expect("alice makes a new link", alice.call("POST", `/api/teams/${hidden.id}/join-code`, {}), 200);
check("code changed", reset.team.join_code !== hidden.join_code);
await expect("old link dead", carol.call("GET", `/api/join/${hidden.join_code}`), 404);
const carolPending = (await carol.call("GET", "/api/me/join-requests")).data.requests.find((r) => r.team_id === hidden.id);
await expect("carol withdraws", carol.call("POST", `/api/join-requests/${carolPending.id}/withdraw`, {}), 200);

console.log("personal teams");
const bobPersonal = bobMe.teams.find((t) => t.kind === "personal");
await expect("can't join someone's personal team", alice.call("POST", `/api/teams/${bobPersonal.id}/join-requests`, {}), 404);
await expect("can't leave your personal team", bob.call("DELETE", `/api/teams/${bobPersonal.id}/members/${bobId}`), 403);
await expect("can't list a personal team", bob.call("PATCH", `/api/teams/${bobPersonal.id}`, { listed: true }), 400);

console.log("drive types");
const types = await expect("list drive types", bob.call("GET", "/api/drive-types"), 200);
check("five starter types", ["personal", "commute", "delivery", "work", "exploring"].every((k) => types.drive_types.some((t) => t.key === k)));
await expect("alice (admin) turns off Personal", alice.call("PUT", `/api/teams/${acme.id}/drive-types/personal`, { counts: false }), 200);
const after = await expect("bob reads toggles", bob.call("GET", `/api/teams/${acme.id}`), 200);
check("personal off, delivery on", !after.drive_types.find((t) => t.key === "personal").counts && after.drive_types.find((t) => t.key === "delivery").counts);
await expect("unknown type", alice.call("PUT", `/api/teams/${acme.id}/drive-types/nope`, { counts: false }), 404);

console.log("site admin");
await expect("not admin yet", alice.call("GET", "/api/admin/users"), 403);
execFileSync("node", ["dist/cli.js", "make-admin", alice.email]);
await expect("admin users", alice.call("GET", `/api/admin/users?q=${run}`), 200);
await expect("bob not admin", bob.call("GET", "/api/admin/users"), 403);
await expect("admin can't demote self", alice.call("PATCH", `/api/admin/users/${aliceId}`, { is_site_admin: false }), 400);
await expect("add drive type", alice.call("POST", "/api/admin/drive-types", { key: `t${run}`.slice(0, 30), label: "Test type" }), 201);
await expect("retire it", alice.call("PATCH", `/api/admin/drive-types/t${run}`.slice(0, 50), { archived: true }), 200);
const pw = await expect("reset bob's password", alice.call("POST", `/api/admin/users/${bobId}/reset-password`, {}), 200);
await expect("bob's session ended", bob.call("GET", "/api/me"), 401);
await expect("bob signs in with new password", bob.call("POST", "/api/auth/login", { email: bob.email, password: pw.password }), 200);
await expect("bob changes it back", bob.call("POST", "/api/me/password", { current: pw.password, next: PW }), 200);
await expect("switch carol off", alice.call("PATCH", `/api/admin/users/${(await carol.call("GET", "/api/me")).data.user.id}`, { disabled: true }), 200);
await expect("carol signed out", carol.call("GET", "/api/me"), 401);
await expect("carol can't sign in", carol.call("POST", "/api/auth/login", { email: carol.email, password: PW }), 403);

console.log("account");
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQBDqW1dAAAAAElFTkSuQmCC", "base64"));
const withPic = await expect("upload picture", bob.call("PUT", "/api/me/avatar", png, { "content-type": "image/png" }), 200);
check("avatar url set", typeof withPic.user.avatar_url === "string");
await expect("fetch picture", alice.call("GET", withPic.user.avatar_url), 200);
await expect("rename", bob.call("PATCH", "/api/me", { displayName: "Robert" }), 200);

console.log("deleting a team");
await expect("owner bob deletes Acme", bob.call("DELETE", `/api/teams/${acme.id}`), 200);
const aliceMe = await expect("alice /me", alice.call("GET", "/api/me"), 200);
check("Acme gone from alice's teams", !aliceMe.teams.some((t) => t.id === acme.id));

console.log("email confirmation");
const dave = client("dave");
let t0 = Date.now() - 1000;
await expect("dave signs up", dave.call("POST", "/api/auth/signup", { email: dave.email, displayName: "Dave", password: PW }), 202);
await expect("no session before confirming", dave.call("GET", "/api/me"), 401);
let mail = await latestCode(dave.email, { after: t0 });
check("confirmation email with a 6-digit code", !!mail && /confirmation code/.test(mail.subject));
let r = await dave.call("POST", "/api/auth/login", { email: dave.email, password: PW });
check("unconfirmed sign-in refused with code 'unverified'", r.status === 403 && r.data.code === "unverified", r);
r = await dave.call("POST", "/api/auth/device", { email: dave.email, password: PW, deviceName: "Phone" });
check("unconfirmed phone sign-in refused too", r.status === 403 && r.data.code === "unverified", r);
const wrong = mail.code === "000000" ? "111111" : "000000";
r = await dave.call("POST", "/api/auth/verify", { email: dave.email, code: wrong });
check("wrong code → 400, counts down", r.status === 400 && /4 tries left/.test(r.data.error), r);
r = await dave.call("POST", "/api/auth/resend", { email: dave.email });
check("resend inside a minute → 429", r.status === 429 && r.data.code === "too_soon", r);
await expect("signing up again inside a minute", dave.call("POST", "/api/auth/signup", { email: dave.email, displayName: "Dave", password: PW }), 429);
await sql(`UPDATE email_codes SET expires_at = now() - interval '1 second'
            WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [dave.email]);
r = await dave.call("POST", "/api/auth/verify", { email: dave.email, code: mail.code });
check("right code after 15 minutes → expired", r.status === 400 && r.data.code === "expired", r);
await sql(`UPDATE email_codes SET created_at = created_at - interval '2 minutes'
            WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [dave.email]);
t0 = Date.now() - 1000;
await expect("send a new code", dave.call("POST", "/api/auth/resend", { email: dave.email }), 200);
const fresh = await latestCode(dave.email, { after: t0 });
check("a new code arrived", !!fresh && fresh.id !== mail.id);
const confirmed = await expect("confirm with the new code", dave.call("POST", "/api/auth/verify", { email: dave.email, code: fresh.code }), 200);
check("confirmed: personal team made", confirmed.teams.length === 1 && confirmed.teams[0].kind === "personal");
await expect("code can't be used twice", dave.call("POST", "/api/auth/verify", { email: dave.email, code: fresh.code }), 409);
await expect("already confirmed email can't sign up", anon.call("POST", "/api/auth/signup", { email: dave.email, displayName: "X", password: PW }), 409);

console.log("re-signing up an unconfirmed address");
const erin = client("erin");
await expect("erin starts signing up", erin.call("POST", "/api/auth/signup", { email: erin.email, displayName: "Wrong Name", password: PW }), 202);
await sql(`UPDATE email_codes SET created_at = created_at - interval '2 minutes'
            WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [erin.email]);
const me2 = await signUp(erin, "Erin Right");
check("second sign-up replaced the name", me2.user.display_name === "Erin Right");

console.log("password reset by code");
const before = await mailCount(`ghost-${run}@test.local`);
await expect("unknown address gets the same answer", anon.call("POST", "/api/auth/forgot", { email: `ghost-${run}@test.local` }), 200);
check("…and no email", (await mailCount(`ghost-${run}@test.local`)) === before);
t0 = Date.now() - 1000;
await expect("dave forgot his password", anon.call("POST", "/api/auth/forgot", { email: dave.email }), 200);
mail = await latestCode(dave.email, { after: t0 });
check("reset code emailed", !!mail && /password reset code/.test(mail.subject));
for (let i = 0; i < 5; i++) await anon.call("POST", "/api/auth/reset", { email: dave.email, code: mail.code === "000000" ? "111111" : "000000", password: "new password 1" });
r = await anon.call("POST", "/api/auth/reset", { email: dave.email, code: mail.code, password: "new password 1" });
check("after 5 wrong tries the code is locked", r.status === 400 && r.data.code === "locked", r);
await sql(`UPDATE email_codes SET created_at = created_at - interval '2 minutes'
            WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [dave.email]);
t0 = Date.now() - 1000;
await expect("ask again", anon.call("POST", "/api/auth/forgot", { email: dave.email }), 200);
mail = await latestCode(dave.email, { after: t0 });
await expect("too-short new password", anon.call("POST", "/api/auth/reset", { email: dave.email, code: mail.code, password: "short" }), 400);
const phone = client("davephone");
await expect("reset with the code", phone.call("POST", "/api/auth/reset", { email: dave.email, code: mail.code, password: "new password 1" }), 200);
await expect("reset signed the resetting browser in", phone.call("GET", "/api/me"), 200);
await expect("dave's old session ended", dave.call("GET", "/api/me"), 401);
await expect("old password no longer works", dave.call("POST", "/api/auth/login", { email: dave.email, password: PW }), 401);
await expect("new password works", dave.call("POST", "/api/auth/login", { email: dave.email, password: "new password 1" }), 200);
await sql(`UPDATE email_codes SET expires_at = now() - interval '1 second' WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [dave.email]);

await finish([[`DELETE FROM drive_types WHERE key = $1`, [`t${run}`.slice(0, 30)]]]);
