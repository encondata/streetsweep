// The areas list as a tree: state › county › city › neighbourhood › section, each area
// under the nearest bigger kind whose outline it sits inside (so a neighbourhood nests
// under the county when the team doesn't follow the city), kept to what's in view.
// The same rules as the iPad app (ios/StreetSweep/App/AreasStore.swift).
import type { Area, AreaLevel } from "./types";

/** Biggest first. A custom area sits with neighbourhoods. */
export const RANK: Record<AreaLevel, number> = { state: 0, county: 1, city: 2, neighborhood: 3, custom: 3, section: 4 };

type Pt = [number, number];
type Bounds = [number, number, number, number]; // west, south, east, north

function polygons(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): Pt[][][] {
  return (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as Pt[][][];
}

/** Inside the outline (holes count as outside): even–odd over each polygon's rings. */
function contains(g: GeoJSON.Polygon | GeoJSON.MultiPolygon, [x, y]: Pt): boolean {
  return polygons(g).some((poly) => {
    let inside = false;
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  });
}

/** Points well inside the biggest piece: the middle of its corners, and points pulled towards it. */
function samples(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): Pt[] {
  const ring = polygons(g).map((p) => p[0]).sort((a, b) => b.length - a.length)[0];
  if (!ring?.length) return [];
  const mx = ring.reduce((t, p) => t + p[0], 0) / ring.length, my = ring.reduce((t, p) => t + p[1], 0) / ring.length;
  const step = Math.max(1, Math.floor(ring.length / 7));
  const out: Pt[] = [[mx, my]];
  for (let i = 0; i < ring.length && out.length < 8; i += step) out.push([ring[i][0] + (mx - ring[i][0]) * 0.3, ring[i][1] + (my - ring[i][1]) * 0.3]);
  return out;
}

/** What each area sits inside, among these areas. */
export function nest(areas: Area[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const child of areas) {
    if (!child.geometry) continue;
    const pts = samples(child.geometry);
    if (!pts.length) continue;
    let best: Area | null = null;
    for (const p of areas) {
      if (p.id === child.id || !p.geometry || RANK[p.level] >= RANK[child.level]) continue;
      const [w, s, e, n] = p.bbox ?? [-180, -90, 180, 90];
      const [x, y] = pts[0];
      if (x < w || x > e || y < s || y > n) continue;
      if (pts.filter((q) => contains(p.geometry!, q)).length * 2 <= pts.length) continue;
      // The nearest bigger kind; between two of the same kind, the smaller.
      if (!best || RANK[p.level] > RANK[best.level] || (RANK[p.level] === RANK[best.level] && (p.km2 ?? 0) < (best.km2 ?? 0))) best = p;
    }
    if (best) out.set(child.id, best.id);
  }
  return out;
}

export interface Node { area: Area; children: Node[] }

const order = (a: Area, b: Area) => RANK[a.level] - RANK[b.level] || a.name.localeCompare(b.name, undefined, { numeric: true });
const overlaps = (b: Bounds | undefined, v: Bounds) => !b || (b[0] <= v[2] && b[2] >= v[0] && b[1] <= v[3] && b[3] >= v[1]);

/** The nested list, keeping only what's in `view` (and the areas holding it); and how many that leaves out. */
export function tree(areas: Area[], parentOf: Map<string, string>, view: Bounds | null): { roots: Node[]; hidden: number } {
  const kids = new Map<string, Area[]>();
  const roots: Area[] = [];
  for (const a of areas) {
    const p = parentOf.get(a.id);
    if (p) kids.set(p, [...(kids.get(p) ?? []), a]);
    else roots.push(a);
  }
  let shown = 0;
  const build = (a: Area): Node | null => {
    const children = (kids.get(a.id) ?? []).sort(order).map(build).filter((n): n is Node => !!n);
    if (view && !overlaps(a.bbox, view) && !children.length) return null;
    shown++;
    return { area: a, children };
  };
  const nodes = roots.sort(order).map(build).filter((n): n is Node => !!n);
  return { roots: nodes, hidden: areas.length - shown };
}
