// Stage 3 API smoke test: map info, street vector tiles, basemap tiles, import controls,
// boundaries, following areas, drawing areas and their street lists.
// Needs a finished street import (the worker runs one on first start). Doesn't start one.
import { execFileSync } from "node:child_process";
import { BASE, check, client, expect, finish, signUp } from "./smoke-lib.mjs";

const amy = client("amy"), ben = client("ben"), cal = client("cal"), anon = client("anon");
for (const c of [amy, ben, cal]) await signUp(c);

console.log("map info");
const info = await expect("map info", amy.call("GET", "/api/map/info"), 200);
check("region is texas", info.region === "texas");
check("a finished import", !!info.last_import?.id);
check("bbox around Texas", Array.isArray(info.bbox) && info.bbox[0] < -100 && info.bbox[2] > -95 && info.bbox[1] < 27 && info.bbox[3] > 35, info.bbox);
await expect("signed out", anon.call("GET", "/api/map/info"), 401);

console.log("street tiles");
// Downtown Austin, zoom 15 and 12.
const t15 = await amy.call("GET", "/api/tiles/streets/15/7487/13491");
check("z15 tile is a vector tile", t15.status === 200 && t15.data.byteLength > 1000, { status: t15.status, bytes: t15.data.byteLength });
const raw = await fetch(`${BASE}/api/tiles/streets/15/7487/13491`, { headers: { cookie: "" } });
check("signed out → 401", raw.status === 401);
await expect("zoomed out → empty", amy.call("GET", "/api/tiles/streets/10/234/423"), 204);
await expect("off the grid", amy.call("GET", "/api/tiles/streets/15/99999/1"), 400);
await expect("not a number", amy.call("GET", "/api/tiles/streets/15/abc/1"), 400);
const sea = await amy.call("GET", "/api/tiles/streets/15/0/0");
check("a tile with no streets is empty but fine", sea.status === 200 && sea.data.byteLength === 0, { status: sea.status });

console.log("basemap tiles");
await expect("unknown basemap", amy.call("GET", "/api/tiles/nope/1/0/0"), 404);
await expect("basemap needs sign-in", anon.call("GET", "/api/tiles/osm/1/0/0"), 401);
await expect("too deep", amy.call("GET", "/api/tiles/osm/25/0/0"), 400);

console.log("import controls");
await expect("not for non-admins", amy.call("GET", "/api/admin/osm-imports"), 403);
await expect("nor starting one", amy.call("POST", "/api/admin/osm-imports", {}), 403);
execFileSync("node", ["dist/cli.js", "make-admin", amy.email]);
const admin = await expect("admin sees imports", amy.call("GET", "/api/admin/osm-imports"), 200);
check("totals counted", admin.totals.segments > 1_000_000 && admin.totals.ways > 500_000, admin.totals);
check("runs listed", admin.runs.length >= 1 && admin.runs.some((r) => r.status === "done"));

console.log("boundaries and following");
const found = await expect("search Travis", amy.call("GET", "/api/areas/search?q=travis"), 200);
const travis = found.areas.find((x) => x.name === "Travis County");
check("Travis County is a county in Texas", travis?.level === "county" && travis.parent_name === "Texas", found.areas.map((x) => x.name));
check("one letter finds nothing", (await amy.call("GET", "/api/areas/search?q=t")).data.areas.length === 0);
const nuevo = (await amy.call("GET", "/api/areas/search?q=nuevo%20laredo")).data.areas;
check("over-the-border boundaries left out", nuevo.length === 0, nuevo.map((x) => x.name));
let list = await expect("amy's personal areas", amy.call("GET", `/api/teams/${amy.personal}/areas`), 200);
check("none yet, and she can edit", list.areas.length === 0 && list.can_edit === true);
await expect("follow Travis", amy.call("POST", `/api/teams/${amy.personal}/follows`, { area_id: travis.id }), 201);
await expect("follow it twice", amy.call("POST", `/api/teams/${amy.personal}/follows`, { area_id: travis.id }), 409);

async function waitBuilt(c, id, label) {
  for (let i = 0; i < 120; i++) {
    const a = (await c.call("GET", `/api/areas/${id}`)).data.area;
    if (a?.build_status === "built" && a.built_version === a.version) return a;
    if (a?.build_status === "failed") break;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  check(`${label} built`, false);
  return null;
}
const tb = await waitBuilt(amy, travis.id, "Travis");
check("Travis has its streets", tb && tb.segment_count > 50000 && tb.street_m > 5_000_000, tb && { n: tb.segment_count, m: tb.street_m });
list = (await amy.call("GET", `/api/teams/${amy.personal}/areas`)).data;
check("Travis in her list with an outline", list.areas.some((x) => x.id === travis.id && x.followed && x.geometry?.type));

const crew = (await amy.call("POST", "/api/teams", { name: `Crew ${Date.now()}` })).data.team;
await ben.call("POST", `/api/teams/${crew.id}/join-requests`, {});
const rq = (await amy.call("GET", `/api/teams/${crew.id}`)).data.requests[0];
await amy.call("POST", `/api/join-requests/${rq.id}/approve`, { role: "driver" });
await expect("a driver can't follow for the team", ben.call("POST", `/api/teams/${crew.id}/follows`, { area_id: travis.id }), 403);
const benView = await expect("but can see the team's areas", ben.call("GET", `/api/teams/${crew.id}/areas`), 200);
check("…read-only", benView.can_edit === false);
await expect("an outsider can't", cal.call("GET", `/api/teams/${crew.id}/areas`), 404);

console.log("drawing areas");
// A few blocks of Hyde Park, Austin.
const hyde = { type: "Polygon", coordinates: [[[-97.7340, 30.3040], [-97.7250, 30.3040], [-97.7250, 30.3110], [-97.7340, 30.3110], [-97.7340, 30.3040]]] };
const made = await expect("draw an area for the crew", amy.call("POST", `/api/teams/${crew.id}/areas`, { name: "Hyde Park", color: "#1a6fd4", geometry: hyde }), 201);
await expect("a driver can't draw", ben.call("POST", `/api/teams/${crew.id}/areas`, { name: "Nope", geometry: hyde }), 403);
await expect("not a polygon", amy.call("POST", `/api/teams/${crew.id}/areas`, { name: "Bad", geometry: { type: "Point", coordinates: [0, 0] } }), 400);
await expect("a scribble", amy.call("POST", `/api/teams/${crew.id}/areas`, { name: "Bad", geometry: { type: "Polygon", coordinates: [[[-97.73, 30.30], [-97.73, 30.30], [-97.73, 30.30], [-97.73, 30.30]]] } }), 400);
const huge = { type: "Polygon", coordinates: [[[-100, 29], [-95, 29], [-95, 33], [-100, 33], [-100, 29]]] };
const big = await amy.call("POST", `/api/teams/${crew.id}/areas`, { name: "Most of Texas", geometry: huge });
check("too big → 400 with a reason", big.status === 400 && /follow the county or city/.test(big.data.error), big);
const hp = await waitBuilt(amy, made.id, "Hyde Park");
check("Hyde Park has streets", hp && hp.segment_count > 20 && hp.segment_count < 2000, hp && hp.segment_count);
check("its parent is the smallest boundary around it", hp?.parent_name === "Austin", hp?.parent_name);
await expect("crew driver can see it", ben.call("GET", `/api/areas/${made.id}`), 200);
await expect("outsider can't", cal.call("GET", `/api/areas/${made.id}`), 404);
await expect("rename", amy.call("PATCH", `/api/areas/${made.id}`, { name: "Hyde Park North", notes: "Start at the school" }), 200);
const bigger = { type: "Polygon", coordinates: [[[-97.7340, 30.3040], [-97.7200, 30.3040], [-97.7200, 30.3150], [-97.7340, 30.3150], [-97.7340, 30.3040]]] };
await expect("redraw it bigger", amy.call("PATCH", `/api/areas/${made.id}`, { geometry: bigger }), 200);
const hp2 = await waitBuilt(amy, made.id, "Hyde Park (redrawn)");
check("new version, more streets", hp2 && hp2.version === 2 && hp2.segment_count > hp.segment_count && hp2.name === "Hyde Park North" && hp2.notes === "Start at the school", hp2 && { v: hp2.version, n: hp2.segment_count });
await expect("public boundaries can't be edited", amy.call("PATCH", `/api/areas/${travis.id}`, { name: "Mine" }), 403);
await expect("nor deleted", amy.call("DELETE", `/api/areas/${travis.id}`), 403);
await expect("driver can't delete", ben.call("DELETE", `/api/areas/${made.id}`), 403);
await expect("admin deletes", amy.call("DELETE", `/api/areas/${made.id}`), 200);
await expect("gone", amy.call("GET", `/api/areas/${made.id}`), 404);
await expect("unfollow Travis", amy.call("DELETE", `/api/teams/${amy.personal}/follows/${travis.id}`), 200);
await expect("unfollow again", amy.call("DELETE", `/api/teams/${amy.personal}/follows/${travis.id}`), 404);

console.log("boundary tiles");
const bt = await amy.call("GET", "/api/tiles/areas/9/117/211");
check("county lines near Austin", bt.status === 200 && bt.data.byteLength > 500, { status: bt.status, bytes: bt.data.byteLength });
await expect("boundary tiles need sign-in", anon.call("GET", "/api/tiles/areas/9/117/211"), 401);

await finish();
