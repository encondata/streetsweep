// Area colours, chosen automatically: no area shares a colour with one it touches or
// overlaps. Which colour any one area gets doesn't matter, only that neighbours differ,
// so this is plain greedy graph colouring over the server's list of who touches whom.
import { AREA_COLORS } from "./types";

interface Colorable { id: string; neighbors?: string[] }

/**
 * Colours for a set of areas. Most-connected first (they're the hardest to fit), ties by
 * id, so the same areas always come out the same colours rather than shuffling on every
 * load. Eight colours is plenty: a map can always be done in four.
 */
export function assignAreaColors(areas: Colorable[]): Map<string, string> {
  const present = new Set(areas.map((a) => a.id));
  const near = (a: Colorable) => (a.neighbors ?? []).filter((id) => present.has(id));
  const order = [...areas].sort((x, y) => near(y).length - near(x).length || x.id.localeCompare(y.id));
  const out = new Map<string, string>();
  for (const a of order) {
    const taken = new Set(near(a).map((id) => out.get(id)).filter(Boolean));
    // The first free colour, starting at a place that depends on the id, so lone areas
    // (no neighbours) aren't all the first colour.
    const start = hash(a.id) % AREA_COLORS.length;
    let pick = AREA_COLORS[start];
    for (let i = 0; i < AREA_COLORS.length; i++) {
      const c = AREA_COLORS[(start + i) % AREA_COLORS.length];
      if (!taken.has(c)) { pick = c; break; }
    }
    out.set(a.id, pick);
  }
  return out;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
