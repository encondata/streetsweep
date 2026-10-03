// Stage 3 API smoke test: map info, street vector tiles, basemap tiles, import controls.
// Needs a finished street import (the worker runs one on first start). Doesn't start one.
import { execFileSync } from "node:child_process";
import { BASE, check, client, expect, finish, signUp } from "./smoke-lib.mjs";

const amy = client("amy"), anon = client("anon");
await signUp(amy);

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

await finish();
