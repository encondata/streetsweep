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

export async function signUp(c) {
  const me = await expect(`sign up ${c.name}`, c.call("POST", "/api/auth/signup",
    { email: c.email, displayName: c.name[0].toUpperCase() + c.name.slice(1), password: PW }), 201);
  c.id = me.user.id;
  c.personal = me.teams[0].id;
  return me;
}

/** Remove this run's accounts and everything hanging off them, then report. */
export async function finish(extraSql = []) {
  const { default: pg } = await import("pg");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const like = `%-${run}@test.local`;
  await db.query(`DELETE FROM teams WHERE created_by IN (SELECT id FROM users WHERE email LIKE $1)`, [like]);
  await db.query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [like]);
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [like]);
  for (const [sql, params] of extraSql) await db.query(sql, params);
  await db.end();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}
