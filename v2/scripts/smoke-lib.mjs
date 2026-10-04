// Shared by the smoke tests: a cookie-keeping client per pretend person, checks, cleanup.
export const BASE = process.env.BASE ?? "http://localhost";
export const run = Date.now().toString(36);
let failures = 0;

export function client(name) {
  let cookie = "";
  let bearer = "";
  return {
    name,
    email: `${name}-${run}@test.local`,
    useToken(t) { bearer = t; },
    async call(method, path, body, headers = {}) {
      const init = { method, headers: { ...headers } };
      if (cookie && !bearer) init.headers.cookie = cookie;
      if (bearer) init.headers.authorization = `Bearer ${bearer}`;
      if (body !== undefined && !(body instanceof Uint8Array)) {
        init.headers["content-type"] ??= "application/json";
        init.body = typeof body === "string" ? body : JSON.stringify(body);
      } else if (body) init.body = body;
      const res = await fetch(BASE + path, init);
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
      const type = res.headers.get("content-type") ?? "";
      const data = type.includes("json") ? await res.json() : await res.arrayBuffer();
      return { status: res.status, data };
    },
  };
}

export function check(label, cond, extra) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}`, extra === undefined ? "" : JSON.stringify(extra).slice(0, 400));
  }
}

export async function expect(label, promise, status) {
  const r = await promise;
  check(`${label} → ${status}`, r.status === status, { got: r.status, data: r.data });
  return r.data;
}

export const PW = "correct horse 1";

export const MAILPIT = process.env.MAILPIT_URL ?? "http://mailpit:8025";

/** The newest code emailed to `to` (from the subject line), waiting briefly for it to land. */
export async function latestCode(to, { after = 0 } = {}) {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`).then((x) => x.json());
    const m = (r.messages ?? []).find((x) => new Date(x.Created).getTime() > after);
    const code = m?.Subject?.match(/^(\d{6}) /)?.[1];
    if (code) return { code, subject: m.Subject, id: m.ID };
    await new Promise((ok) => setTimeout(ok, 150));
  }
  return null;
}

export async function mailCount(to) {
  const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`).then((x) => x.json());
  return r.messages_count ?? (r.messages ?? []).length;
}

/** Sign up and confirm with the emailed code, as a person would. */
export async function signUp(c, displayName = c.name[0].toUpperCase() + c.name.slice(1)) {
  const started = Date.now() - 1000;
  await expect(`sign up ${c.name}`, c.call("POST", "/api/auth/signup", { email: c.email, displayName, password: PW }), 202);
  const mail = await latestCode(c.email, { after: started });
  check(`${c.name}'s code arrived by email`, !!mail);
  const me = await expect(`${c.name} confirms`, c.call("POST", "/api/auth/verify", { email: c.email, code: mail?.code }), 200);
  c.id = me.user.id;
  c.personal = me.teams[0].id;
  return me;
}

/** Run SQL against the app database (to wind clocks back in tests). */
export async function sql(text, params) {
  const { default: pg } = await import("pg");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try { return (await db.query(text, params)).rows; } finally { await db.end(); }
}

/** Remove this run's accounts and everything hanging off them, then report. */
export async function finish(extraSql = []) {
  const { default: pg } = await import("pg");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const like = `%-${run}@test.local`;
  // Drives first: they outlive their uploader (user ids go NULL), so they'd be left behind.
  await db.query(
    `DELETE FROM drives WHERE uploaded_by IN (SELECT id FROM users WHERE email LIKE $1)
        OR user_id IN (SELECT id FROM users WHERE email LIKE $1)
        OR logger_id IN (SELECT l.id FROM loggers l JOIN users u ON u.id = l.owner_user_id WHERE u.email LIKE $1)`,
    [like],
  ).catch(() => {});
  await db.query(`DELETE FROM teams WHERE created_by IN (SELECT id FROM users WHERE email LIKE $1)`, [like]);
  await db.query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [like]);
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [like]);
  for (const [q, params] of extraSql) await db.query(q, params);
  await db.end();
  // And this run's emails from Mailpit.
  // (No leading "-": in Mailpit's search syntax that means NOT.)
  await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${run}@test.local"`)}`, { method: "DELETE" }).catch(() => {});
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}
