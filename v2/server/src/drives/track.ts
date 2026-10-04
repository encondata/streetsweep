// Turning raw GPS fixes into a clean track. Pure functions.

/** One fix as phones and loggers send it: [epoch seconds, lat, lon, accuracy m?, speed m/s?]. */
export type RawPoint = [number, number, number, (number | null)?, (number | null)?];

export interface Fix { t: number; lat: number; lon: number; acc: number | null; speed: number | null }

/** Fixes worse than this are dropped; a phone indoors reports hundreds of metres. */
export const MAX_ACCURACY_M = 50;
/** Faster than this between two fixes is a GPS jump, not driving (~250 km/h). */
const MAX_SPEED_MS = 70;

export function haversine(a: Fix, b: Fix): number {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Sorted by time, one fix per second, inaccurate fixes and impossible jumps dropped.
 * Epoch milliseconds are accepted too (anything after the year 2286 in seconds is ms).
 */
export function cleanPoints(raw: RawPoint[]): Fix[] {
  const fixes: Fix[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 3) continue;
    let [t, lat, lon] = p;
    const acc = p[3] ?? null, speed = p[4] ?? null;
    if (![t, lat, lon].every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    if (t > 1e10) t = t / 1000;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
    if (acc !== null && (typeof acc !== "number" || acc > MAX_ACCURACY_M)) continue;
    fixes.push({ t, lat, lon, acc: typeof acc === "number" ? acc : null, speed: typeof speed === "number" ? speed : null });
  }
  fixes.sort((a, b) => a.t - b.t);
  const out: Fix[] = [];
  for (const f of fixes) {
    const prev = out[out.length - 1];
    if (prev && f.t - prev.t < 1) continue;
    if (prev && haversine(prev, f) / (f.t - prev.t) > MAX_SPEED_MS) continue;
    out.push(f);
  }
  return out;
}

export function distanceOf(fixes: Fix[]): number {
  let d = 0;
  for (let i = 1; i < fixes.length; i++) d += haversine(fixes[i - 1], fixes[i]);
  return d;
}

/** EWKT LineStringM, M = epoch seconds. */
export function trackEwkt(fixes: Fix[]): string {
  return "SRID=4326;LINESTRINGM(" + fixes.map((f) => `${f.lon} ${f.lat} ${f.t}`).join(",") + ")";
}

/** Split a stream of fixes where the logger sat still or was off for longer than `gapS`. */
export function splitAtGaps(fixes: Fix[], gapS: number): Fix[][] {
  const groups: Fix[][] = [];
  let cur: Fix[] = [];
  for (const f of fixes) {
    if (cur.length && f.t - cur[cur.length - 1].t > gapS) {
      groups.push(cur);
      cur = [];
    }
    cur.push(f);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** Fewer points for matching: one at least every `minM` metres (ends always kept). */
export function thin(fixes: Fix[], minM: number): Fix[] {
  if (fixes.length <= 2) return fixes;
  const out = [fixes[0]];
  for (let i = 1; i < fixes.length - 1; i++) if (haversine(out[out.length - 1], fixes[i]) >= minM) out.push(fixes[i]);
  out.push(fixes[fixes.length - 1]);
  return out;
}
