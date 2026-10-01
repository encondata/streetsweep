import { squareMiles } from "./geo";
import { ORGANIZATIONAL } from "./levels";
import type { Level, Ring } from "./types";

/** More corners than this and an outline is thinned before it is offered. */
const MAX_CORNERS = 20000;
/** A state or country only groups areas: recognisable on the map is enough. */
const ORG_CORNERS = 2000;

export interface Boundary {
  name: string;
  full: string;
  kind: string;
  level: Level;
  city: string | null;
  rings: Ring[];
  corners: number;
  original: number;
  tolerance: number;
  dropped: number;
}

export function levelFor(kind: string): Level {
  if (/county|parish/.test(kind)) return "COUNTY";
  if (/country|nation/.test(kind)) return "COUNTRY";
  if (/state/.test(kind)) return "STATE";
  if (/region|province|district/.test(kind)) return "REGION";
  if (/metropol/.test(kind)) return "METRO";
  if (/city|town|village|municipality|borough/.test(kind)) return "CITY";
  return "NEIGHBORHOOD";
}

/** Every outer ring as [lat, lng], biggest first: an island county keeps all its pieces. */
function outerRings(geometry: { type: string; coordinates: any } | undefined): Ring[] {
  if (!geometry) return [];
  const rings: number[][][] = geometry.type === "Polygon" ? [geometry.coordinates[0]]
    : geometry.type === "MultiPolygon" ? geometry.coordinates.map((p: number[][][]) => p[0]) : [];
  return rings.filter((r) => r && r.length >= 4).map((r) => {
    const ring: Ring = r.map((c) => [c[1], c[0]]);
    const a = ring[0], z = ring[ring.length - 1];
    if (ring.length > 1 && Math.abs(a[0] - z[0]) < 1e-9 && Math.abs(a[1] - z[1]) < 1e-9) ring.pop();
    return ring;
  }).sort((a, b) => squareMiles([b]) - squareMiles([a]));
}

/** Douglas–Peucker: drops corners within [tolerance] metres of the line their neighbours draw. */
function thin(ring: Ring, tolerance: number): Ring {
  if (ring.length < 3) return ring;
  const k = Math.cos((ring[0][0] * Math.PI) / 180);
  const off = (p: number[], a: number[], b: number[]) => {
    const px = p[1] * k, py = p[0], ax = a[1] * k, ay = a[0], bx = b[1] * k, by = b[0];
    const dx = bx - ax, dy = by - ay, span = dx * dx + dy * dy;
    const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / span));
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t)) * 111320;
  };
  const keep = new Array(ring.length).fill(false);
  keep[0] = keep[ring.length - 1] = true;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi <= lo + 1) continue;
    let worst = 0, at = -1;
    for (let i = lo + 1; i < hi; i++) { const d = off(ring[i], ring[lo], ring[hi]); if (d > worst) { worst = d; at = i; } }
    if (worst <= tolerance || at < 0) continue;
    keep[at] = true;
    stack.push([lo, at], [at, hi]);
  }
  return ring.filter((_, i) => keep[i]);
}

/** Thins every piece together to one budget of corners; a piece thinned to nothing goes. */
function fit(rings: Ring[], cap: number): { rings: Ring[]; tolerance: number } {
  const total = (rs: Ring[]) => rs.reduce((t, r) => t + r.length, 0);
  if (total(rings) <= cap) return { rings, tolerance: 0 };
  let tolerance = 2, out = rings;
  for (let i = 0; i < 16 && total(out) > cap; i++) {
    out = rings.map((r) => thin(r, tolerance)).filter((r) => r.length >= 3);
    tolerance *= 2;
  }
  return { rings: out.length ? out : [rings[0]], tolerance: tolerance / 2 };
}

/** OpenStreetMap's outlines for a place name, through Nominatim (one request per search). */
export async function findBoundaries(q: string): Promise<Boundary[]> {
  const r = await fetch(
    "https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&addressdetails=1&limit=8&q=" +
      encodeURIComponent(q),
    { headers: { Accept: "application/json" } },
  );
  if (!r.ok) throw new Error("OpenStreetMap's search did not answer");
  const rows: any[] = await r.json();
  const out: Boundary[] = [];
  for (const row of rows) {
    const picked = outerRings(row.geojson);
    if (!picked.length) continue;
    const kind = row.addresstype || row.type || "place";
    const level = levelFor(kind);
    const fitted = fit(picked, ORGANIZATIONAL.has(level) ? ORG_CORNERS : MAX_CORNERS);
    const addr = row.address || {};
    out.push({
      name: (row.name || String(row.display_name).split(",")[0]).trim(),
      full: row.display_name,
      kind, level,
      city: addr.city || addr.town || addr.village || addr.county || null,
      rings: fitted.rings,
      corners: fitted.rings.reduce((t, x) => t + x.length, 0),
      original: picked.reduce((t, x) => t + x.length, 0),
      tolerance: fitted.tolerance,
      dropped: picked.length - fitted.rings.length,
    });
  }
  return out;
}
