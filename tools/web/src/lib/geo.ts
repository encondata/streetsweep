import type { LatLng, Ring } from "./types";

/** The server's street-store cells are 0.1° squares, keyed "latIdx_lngIdx". */
export const CELL_DEG = 0.1;

export interface Box { s: number; w: number; n: number; e: number }

export function boxOf(rings: Ring[]): Box {
  let s = 90, n = -90, w = 180, e = -180;
  for (const r of rings) for (const [lat, lng] of r) {
    if (lat < s) s = lat; if (lat > n) n = lat;
    if (lng < w) w = lng; if (lng > e) e = lng;
  }
  return { s, w, n, e };
}

/** Each piece's own cells, as the server works them out: not the sea between islands. */
export function cellsOf(rings: Ring[]): string[] {
  const keys = new Set<string>();
  for (const r of rings) {
    const b = boxOf([r]);
    for (let la = Math.floor(b.s / CELL_DEG); la <= Math.floor(b.n / CELL_DEG); la++)
      for (let lo = Math.floor(b.w / CELL_DEG); lo <= Math.floor(b.e / CELL_DEG); lo++) keys.add(`${la}_${lo}`);
  }
  return [...keys];
}

/** The cells of [keys] that the box overlaps. */
export function cellsInBox(keys: string[], b: Box): string[] {
  return keys.filter((k) => {
    const [la, lo] = k.split("_").map(Number);
    const s = la * CELL_DEG, w = lo * CELL_DEG;
    return s <= b.n && s + CELL_DEG >= b.s && w <= b.e && w + CELL_DEG >= b.w;
  });
}

const SQ_M_PER_SQ_MI = 2589988.11;

export function squareMiles(rings: Ring[]): number {
  let total = 0;
  for (const r of rings) {
    if (r.length < 3) continue;
    const lat0 = r.reduce((a, p) => a + p[0], 0) / r.length;
    const mx = 111320 * Math.cos((lat0 * Math.PI) / 180), my = 111132;
    let sum = 0;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      sum += a[1] * mx * (b[0] * my) - b[1] * mx * (a[0] * my);
    }
    total += Math.abs(sum) / 2 / SQ_M_PER_SQ_MI;
  }
  return total;
}

export function inside(ring: Ring, lat: number, lng: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[0] > lat) !== (b[0] > lat) && lng < ((b[1] - a[1]) * (lat - a[0])) / (b[0] - a[0]) + a[1]) hit = !hit;
  }
  return hit;
}

/** GeoJSON wants [lng, lat] and a closed ring. */
export const toLngLat = (r: Ring): [number, number][] => {
  const out = r.map(([lat, lng]) => [lng, lat] as [number, number]);
  if (out.length) out.push(out[0]);
  return out;
};

export const fromLngLat = (r: number[][]): Ring => {
  const out = r.map(([lng, lat]) => [lat, lng] as LatLng);
  const a = out[0], z = out[out.length - 1];
  if (out.length > 1 && a[0] === z[0] && a[1] === z[1]) out.pop();
  return out;
};

const M_PER_MI = 1609.344;
const FT_PER_M = 3.280839895;

/** US units throughout: feet under a tenth of a mile, miles above. */
export function distance(meters: number): string {
  const mi = meters / M_PER_MI;
  if (mi < 0.1) return Math.round(meters * FT_PER_M).toLocaleString() + " ft";
  return mi.toFixed(mi < 10 ? 2 : 1) + " mi";
}

export function areaSize(sqMi: number): string {
  if (sqMi < 0.25) return Math.round(sqMi * 640).toLocaleString() + " acres";
  return sqMi.toFixed(sqMi < 10 ? 2 : 1) + " sq mi";
}

export const pct = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0);
